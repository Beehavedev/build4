// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid integration — first-pass service module.
//
// Mirrors the shape of services/aster.ts so the agent loop, miniapp Trade
// page, and admin tooling can target Hyperliquid using the same patterns:
//   - resolveHyperliquidCreds(user, walletAddress)
//   - getMarkPrice(coin)                   ← public
//   - getAccountState(creds)               ← signed (perp clearinghouse)
//   - placeOrder(creds, args)              ← signed via agent wallet
//   - approveAgent(userPrivateKey, agent)  ← one-time on-chain auth
//
// Hyperliquid wallets are EVM addresses on its own L1. Because addresses are
// derived from secp256k1 in the same way as Ethereum/BSC, the user's existing
// BUILD4 wallet (BSC) is also a valid Hyperliquid wallet — same address, same
// signing key. Deposits flow via the bridge contract on Arbitrum:
//   0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7   (USDC, min $5)
// We don't implement the deposit bridge here yet — UX phase 2.
//
// Env vars (all optional for MVP read-only/public flows):
//   HYPERLIQUID_API_URL          default https://api.hyperliquid.xyz
//   HYPERLIQUID_AGENT_NAME       default 'build4-agent' (shown to user on approve)
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from 'ethers'
import * as hl from '@nktkas/hyperliquid'

const HL_API_URL  = process.env.HYPERLIQUID_API_URL ?? 'https://api.hyperliquid.xyz'
const AGENT_NAME  = process.env.HYPERLIQUID_AGENT_NAME ?? 'build4-agent'

// ─────────────────────────────────────────────────────────────────────────────
// Tiny dedupe-cache for HL info reads.
//
// Production was hammered with 429s because:
//   • the mini-app polls 6 mark prices every second (one per coin in the
//     header strip), and each `getMarkPrice` calls `infoClient.allMids()` —
//     so we burned 6 full mids requests/sec/user instead of 1.
//   • multiple components asking for the same `getAccountState(address)` at
//     the same tick each issued their own clearinghouseState call.
//
// We dedupe with a 1.5-second TTL: any concurrent caller during that window
// shares a single in-flight Promise. That's still "live" by HL UX standards
// (the venue's own websocket pushes mids ~every 200-400ms; 1.5s on a
// fall-back HTTP poll is well within tolerance) but cuts upstream calls by
// 6× per user for mids and ~Nx for repeated account reads. Cache stores the
// resolved value too so a fresh caller right after settlement skips the
// network entirely.
// ─────────────────────────────────────────────────────────────────────────────
const HL_INFO_TTL_MS = 1_500
const _infoCache: Map<string, { at: number; value: any }> = new Map()
const _infoInflight: Map<string, Promise<any>> = new Map()
async function dedupedInfo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const cached = _infoCache.get(key)
  if (cached && now - cached.at < ttlMs) return cached.value as T
  const inflight = _infoInflight.get(key)
  if (inflight) return inflight as Promise<T>
  const p = (async () => {
    try {
      const v = await fn()
      _infoCache.set(key, { at: Date.now(), value: v })
      return v
    } finally {
      _infoInflight.delete(key)
    }
  })()
  _infoInflight.set(key, p)
  return p
}
// Drop the cached account-state entries for `userAddress` so the very
// next read goes to the wire. Called after any successful write that
// could shift balance/positions (placeOrder, transferSpotPerp). Without
// this, the user could click "Place Order" → see success → and still
// see their pre-trade balance for up to 1.5 seconds because the cache
// hadn't expired. Belt-and-braces: also clear `allMids` so any
// just-placed price-sensitive UI rerenders against fresh mids.
function invalidateHlAccountCache(userAddress: string): void {
  _infoCache.delete(`clearinghouseState:${userAddress}`)
  _infoCache.delete(`spotClearinghouseState:${userAddress}`)
}

// ── HL price/size formatting ────────────────────────────────────────────────
// Exported because the order endpoint preview also needs the same rounding.
export function formatHlPrice(px: number, szDecimals: number, isSpot = false): string {
  if (!Number.isFinite(px) || px <= 0) return '0'
  // Integer prices bypass the 5-sig-fig rule entirely.
  if (Number.isInteger(px)) return px.toString()
  const maxDecimals = Math.max(0, (isSpot ? 8 : 6) - szDecimals)
  // Step 1: clamp to 5 sig figs.
  const sig = Number(px.toPrecision(5))
  // Step 2: clamp decimals.
  const dec = Number(sig.toFixed(maxDecimals))
  // Step 3: render without trailing zeros (HL accepts either, but cleaner logs).
  return dec.toString()
}
export function formatHlSize(sz: number, szDecimals: number): string {
  if (!Number.isFinite(sz) || sz <= 0) return '0'
  return sz.toFixed(szDecimals)
}

// Builder-fee config — how BUILD4 actually monetises HL trades.
//
// Hyperliquid lets a "builder" capture a kickback on every order they route,
// once the user signs ApproveBuilderFee authorising up to a maximum rate.
// The cut is paid by the user on top of HL's protocol fee and lands in
// the builder address every fill (paid in USDC on HL L1 — withdrawable to
// Arbitrum and bridge from there to BSC if you want it back on chain).
//
// We default the treasury to the same address Aster routes its builder fees
// to (ASTER_BUILDER_ADDRESS) so all venue revenue accrues to one wallet.
// The address is just a public key — both venues credit it independently
// using the relevant chain's accounting. Override with HYPERLIQUID_BUILDER_ADDRESS
// if you ever want HL revenue to land in a separate treasury.
//
//   HYPERLIQUID_BUILDER_ADDRESS    optional override; defaults to ASTER_BUILDER_ADDRESS
//                                  Set to "" (empty string) or "disabled" to
//                                  EXPLICITLY disable HL builder fees without
//                                  touching ASTER. Useful when HL rejects the
//                                  builder address (e.g. "Builder has insufficient
//                                  balance to be approved") and you need users
//                                  to be able to trade while you sort out the
//                                  builder wallet's HL eligibility.
//   HYPERLIQUID_BUILDER_MAX_RATE   ceiling user signs, e.g. '0.1%' (HL max allowed)
//   HYPERLIQUID_BUILDER_FEE_TENTHS per-order fee in tenths of a basis point
//                                  (10 bps = 100, which is HL's hard cap)
//
// If neither builder address is set we skip the builder approval and place
// orders without a builder field — zero revenue but no breakage.
//
// Resolution rule (intentional, do NOT regress to `??`):
//   - empty string "" or literal "disabled" on HYPERLIQUID_BUILDER_ADDRESS
//     wins → HL builder fully disabled (no fallback to ASTER_BUILDER).
//   - undefined HYPERLIQUID_BUILDER_ADDRESS → falls back to ASTER_BUILDER.
//   - any non-empty string → used verbatim.
// `??` would silently fall through on "" which is the opposite of what an
// operator means when they clear the var to disable the feature.
const _hlBuilderRaw = (process.env.HYPERLIQUID_BUILDER_ADDRESS ?? '').trim().toLowerCase()
const BUILDER_ADDRESS = (() => {
  if (process.env.HYPERLIQUID_BUILDER_ADDRESS !== undefined) {
    if (_hlBuilderRaw === '' || _hlBuilderRaw === 'disabled' || _hlBuilderRaw === 'none' || _hlBuilderRaw === 'off') {
      return ''
    }
    return _hlBuilderRaw
  }
  return (process.env.ASTER_BUILDER_ADDRESS ?? '').trim().toLowerCase()
})()
const BUILDER_MAX_RATE   = process.env.HYPERLIQUID_BUILDER_MAX_RATE ?? '0.1%'
const BUILDER_FEE_TENTHS = Number(process.env.HYPERLIQUID_BUILDER_FEE_TENTHS ?? '100')

// Loud startup banner so a misconfigured builder address is visible from the
// FIRST log line of every deploy. Without this, the only way to know what
// builder Render has loaded is to wait for a user to attempt a trade and
// trigger the per-call log. Cheap, prints once per process.
console.log(
  `[HL config] builder=${BUILDER_ADDRESS || '<DISABLED>'} ` +
  `(HYPERLIQUID_BUILDER_ADDRESS=${process.env.HYPERLIQUID_BUILDER_ADDRESS ?? '<unset>'}, ` +
  `ASTER_BUILDER_ADDRESS=${process.env.ASTER_BUILDER_ADDRESS ?? '<unset>'}) ` +
  `rate=${BUILDER_MAX_RATE} feeTenths=${BUILDER_FEE_TENTHS}`,
)

// Single shared transport — re-used across calls for connection pooling.
const transport = new hl.HttpTransport(HL_API_URL !== 'https://api.hyperliquid.xyz' ? ({ url: HL_API_URL } as any) : {})
const infoClient = new hl.InfoClient({ transport })

// ─────────────────────────────────────────────────────────────────────────────
// Public market data
// ─────────────────────────────────────────────────────────────────────────────

// Public candle fetch for the mini-app's native chart.
//
// HL exposes OHLC via POST /info {type:'candleSnapshot', req:{coin, interval,
// startTime, endTime}}. Coin is the bare symbol ("BTC", not "BTCUSDT"). The
// payload comes back as { t, T, o, c, h, l, v } with prices as strings.
//
// We accept the same interval strings Aster uses (1m/5m/15m/1h/4h/1d) so the
// chart component can hand the same value to either venue. HL accepts
// 1m/3m/5m/15m/30m/1h/2h/4h/8h/12h/1d/3d/1w/1M — a strict superset of what
// the chart UI exposes, so passthrough is safe.
//
// Cached only briefly: candles do roll, and the mini-app polls. Returns
// shape that lightweight-charts consumes directly (time in seconds, OHLC
// as numbers).
const HL_VALID_INTERVALS = new Set([
  '1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d','3d','1w','1M'
])
const HL_INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000,
  '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
  '1M': 2_592_000_000,
}

export interface HlCandle {
  time:   number  // unix seconds (lightweight-charts expects seconds, not ms)
  open:   number
  high:   number
  low:    number
  close:  number
  volume: number
}

export async function getCandles(
  coin: string,
  interval: string = '15m',
  limit: number = 200,
): Promise<HlCandle[]> {
  const sym = (coin || '').toUpperCase().replace(/USDT?$/, '').replace(/-USD$/, '').replace(/[^A-Z0-9]/g, '')
  if (!sym) return []
  const intv = HL_VALID_INTERVALS.has(interval) ? interval : '15m'
  const safeLimit = Math.max(1, Math.min(1500, Math.floor(limit)))
  const stepMs = HL_INTERVAL_MS[intv] ?? 900_000
  const endTime = Date.now()
  const startTime = endTime - stepMs * safeLimit

  try {
    const res: any = await (transport as any).request('info', {
      type: 'candleSnapshot',
      req: { coin: sym, interval: intv, startTime, endTime },
    })
    if (!Array.isArray(res)) return []
    return res.map((c: any) => ({
      time:   Math.floor(Number(c.t) / 1000),
      open:   parseFloat(c.o),
      high:   parseFloat(c.h),
      low:    parseFloat(c.l),
      close:  parseFloat(c.c),
      volume: parseFloat(c.v),
    })).filter(c => Number.isFinite(c.open) && Number.isFinite(c.close))
  } catch (err: any) {
    console.error('[HL] getCandles failed:', sym, intv, err?.message)
    return []
  }
}

/**
 * Get the current mark price for a perp coin (e.g. 'BTC', 'ETH', 'SOL').
 * Hyperliquid returns "mids" — mid prices keyed by the coin symbol.
 * Returns 0 if the coin isn't listed or the call fails (caller decides
 * whether to surface that as an error).
 */
export async function getMarkPrice(coin: string): Promise<{ markPrice: number }> {
  const sym = coin.toUpperCase().replace(/USDT?$/, '').replace(/-USD$/, '')
  try {
    // Share one allMids() per second across every concurrent caller —
    // header strip polls 6 coins/sec/user; without dedupe that was 6
    // upstream calls/sec/user and triggered HL 429s in production.
    const mids = await dedupedInfo('allMids', HL_INFO_TTL_MS, () => infoClient.allMids())
    const px = parseFloat((mids as any)[sym] ?? '0')
    return { markPrice: Number.isFinite(px) ? px : 0 }
  } catch (err: any) {
    console.error('[HL] getMarkPrice failed:', sym, err?.message)
    return { markPrice: 0 }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-asset minimum order size lookup (cached)
// ─────────────────────────────────────────────────────────────────────────────
// HL enforces TWO minimum-order constraints that we need to clear before
// submitting:
//
//   1. Global minimum order value: 10 USDC notional. Anything smaller is
//      rejected with "Order has zero size" or "MinTradeNtl" depending on
//      which gate it tripped first.
//   2. Per-asset minimum size: each asset has a `szDecimals` field in
//      meta.universe. The smallest representable size is 10^(-szDecimals)
//      coin units. For low-decimal assets (BTC = 5 → 0.00001 BTC, around
//      ~$1 today; HYPE = 2 → 0.01 HYPE, around ~$0.20) constraint #1 is
//      the binding one. For high-decimal cheap coins (some shitcoins
//      with szDecimals=0 or 1) the per-asset min size can DOMINATE the
//      $10 floor — a coin worth $0.001 with szDecimals=0 has a min size
//      of 1 coin = $0.001, but you still need to cross the $10 notional.
//
// We cache HL's universe meta for 5 minutes so this lookup is essentially
// free per tick. Cache miss falls through gracefully — caller assumes the
// global $10 floor and lets the venue reject if the per-asset constraint
// wasn't actually known.
//
// Returned values are USDT-denominated (HL margin asset is USDC, but the
// agent thinks in USDT — they are 1:1 for our purposes).

export interface HlAssetMinimums {
  /** USDT notional floor — 10 by HL spec, plus a small safety buffer. */
  minNotionalUsdt: number
  /** Smallest tradeable size in coin units, derived from szDecimals. */
  minSizeUnits:    number
  /** szDecimals from the meta — useful for downstream rounding. */
  szDecimals:      number
}

let _hlMetaCache: { at: number; universe: any[] } | null = null
const HL_META_TTL_MS = 5 * 60_000

async function loadHlMeta(): Promise<any[]> {
  const now = Date.now()
  if (_hlMetaCache && now - _hlMetaCache.at < HL_META_TTL_MS) {
    return _hlMetaCache.universe
  }
  const meta = await infoClient.meta()
  const universe = Array.isArray((meta as any)?.universe) ? (meta as any).universe : []
  _hlMetaCache = { at: now, universe }
  return universe
}

/**
 * Look up the minimum order constraints for an HL asset. Coin can be either
 * the bare symbol ('BTC') or anything we'd hand to executeOpenHl ('BTCUSDT',
 * 'BTC-PERP', etc.) — we strip suffixes the same way getCandles/getMarkPrice
 * do so callers don't have to remember which form to use.
 *
 * Returns null if HL meta can't be fetched or the asset isn't listed; callers
 * should fall back to the conservative defaults (10 USDT notional, no
 * per-asset constraint) so a meta outage never blocks all HL trading.
 */
export async function getMinNotional(coin: string): Promise<HlAssetMinimums | null> {
  const sym = (coin || '').toUpperCase().replace(/USDT?$/, '').replace(/-USD$/, '').replace(/[^A-Z0-9]/g, '')
  if (!sym) return null
  try {
    const universe = await loadHlMeta()
    const asset = universe.find((u: any) => u?.name === sym)
    if (!asset) return null
    const szDecimals = Number.isFinite(asset.szDecimals) ? Number(asset.szDecimals) : 4
    const minSizeUnits = Math.pow(10, -szDecimals)
    // 10.5 USDT: HL's spec is $10 flat; the extra $0.50 absorbs the rounding
    // loss inside formatHlSize (sz.toFixed(szDecimals)) which can shave the
    // submitted notional just under the line on borderline orders.
    return { minNotionalUsdt: 10.5, minSizeUnits, szDecimals }
  } catch (err: any) {
    console.warn('[HL] getMinNotional meta fetch failed:', sym, err?.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Credentials
// ─────────────────────────────────────────────────────────────────────────────

export interface HyperliquidCredentials {
  /** The user's master HL wallet address (= their BSC wallet address). */
  userAddress:    string
  /** The agent wallet that will actually sign orders on the user's behalf. */
  agentAddress:   string | null
  /** The agent wallet's private key (held server-side, encrypted at rest). */
  agentPrivKey:   string | null
}

export function buildCreds(
  userAddress:   string,
  agentAddress?: string | null,
  agentPrivKey?: string | null,
): HyperliquidCredentials {
  return {
    userAddress,
    agentAddress: agentAddress ?? null,
    agentPrivKey: agentPrivKey ?? null,
  }
}

/**
 * Resolve creds for a given user — pulls the encrypted agent PK out of the DB,
 * decrypts it, and constructs an HL ExchangeClient-ready credentials object.
 * Returns null if the user hasn't onboarded to HL yet.
 *
 * Mirrors aster.ts#resolveAgentCreds so callers can swap venues.
 */
export async function resolveAgentCreds(
  user:        { id: string; hyperliquidAgentAddress?: string | null; hyperliquidAgentEncryptedPK?: string | null },
  userAddress: string,
): Promise<HyperliquidCredentials | null> {
  if (!user.hyperliquidAgentAddress || !user.hyperliquidAgentEncryptedPK) return null
  const { decryptPrivateKey } = await import('./wallet')
  let agentPK: string | null = null
  for (const candidate of [user.id]) {
    try {
      const out = decryptPrivateKey(user.hyperliquidAgentEncryptedPK, candidate)
      if (out && out.startsWith('0x')) { agentPK = out; break }
    } catch { /* try next candidate */ }
  }
  if (!agentPK) {
    console.error('[HL] resolveAgentCreds: failed to decrypt agent PK for user', user.id)
    return null
  }
  return buildCreds(userAddress, user.hyperliquidAgentAddress, agentPK)
}

// ─────────────────────────────────────────────────────────────────────────────
// Signed reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query HL's user-abstraction state — i.e. which "account mode" the address
 * is in. Documented only in the official Python SDK
 * (hyperliquid-dex/hyperliquid-python-sdk → info.py L633): a POST to /info
 * with { type: "userAbstraction", user } returns a string literal:
 *   - "unifiedAccount"   → spot + perps share margin; usdClassTransfer is
 *                          DISABLED (HL rejects with "Action disabled when
 *                          unified account is active").
 *   - "portfolioMargin"  → cross-asset risk-based margining; spot↔perps
 *                          transfers behave normally.
 *   - "default"          → classic mode (the docs/Python type call this
 *                          "disabled" but the live HTTP endpoint returns
 *                          the string "default" — verified against
 *                          api.hyperliquid.xyz on a fresh address).
 *                          We accept either spelling for forward-compat.
 *
 * We use this to PROACTIVELY hide the spot↔perps move CTAs in the mini-app
 * for unified accounts, instead of waiting for the user to tap and hit a
 * 502. The @nktkas/hyperliquid SDK doesn't expose a typed method for this
 * endpoint, so we drop down to the raw transport.
 *
 * Returns null on transport/parse errors so callers can fall back to
 * whatever flag they have cached (typically the persisted DB flag).
 */
export type HlAbstraction = 'unifiedAccount' | 'portfolioMargin' | 'default' | 'disabled'

export async function getUserAbstraction(
  userAddress: string,
): Promise<HlAbstraction | null> {
  try {
    const res: any = await (transport as any).request('info', {
      type: 'userAbstraction',
      user: userAddress as `0x${string}`,
    })
    if (
      res === 'unifiedAccount' ||
      res === 'portfolioMargin' ||
      res === 'default' ||
      res === 'disabled'
    ) {
      return res
    }
    // HL has historically tweaked these endpoint shapes — log unexpected
    // payloads so we notice rather than silently treating as classic.
    console.warn('[HL] getUserAbstraction unexpected payload:', userAddress, JSON.stringify(res).slice(0, 200))
    return null
  } catch (err: any) {
    // Don't spam logs for transient HL 5xx — just return null so caller
    // falls back to the cached DB flag. /api/hyperliquid/account is on
    // the page-load critical path; one HL hiccup shouldn't break it.
    if (process.env.HL_DEBUG_ABSTRACTION) {
      console.warn('[HL] getUserAbstraction failed:', userAddress, err?.message)
    }
    return null
  }
}

/**
 * Returns the user's perp account state on Hyperliquid:
 *   - withdrawable USDC (free margin)
 *   - account value (margin + unrealised PnL)
 *   - open positions
 *   - account abstraction mode (proactive unified-account detection)
 * Read endpoint, no signing required — but takes the user's master address,
 * not the agent address. Public clearinghouse query.
 */
export async function getAccountState(userAddress: string): Promise<{
  withdrawableUsdc: number
  accountValue:     number
  onboarded:        boolean
  positions:        Array<{
    coin:          string
    szi:           number
    entryPx:       number
    unrealizedPnl: number
    // Extra fields surfaced so the mini-app can render rich position
    // cards (entry / mark / leverage / liq) instead of just side+pnl.
    // All come straight from HL's clearinghouseState response.
    positionValue: number   // signed USDC notional ; markPx = positionValue/szi
    leverage:      number   // user-set leverage (1..maxLeverage)
    leverageType:  'cross' | 'isolated'
    maxLeverage:   number   // venue cap for the asset
    liquidationPx: number   // 0 when unavailable (e.g. cross at full equity)
    marginUsed:    number   // initial margin currently locked by this position
    returnOnEquity: number  // unrealizedPnl / marginUsed (HL-computed)
  }>
  abstraction:      'unifiedAccount' | 'portfolioMargin' | 'disabled' | null
}> {
  try {
    // Fan out the two reads in parallel — abstraction is on the same HL
    // host so latency overlaps perfectly. We don't fail the whole call if
    // abstraction errors; null is a valid "unknown" answer.
    // Both reads are deduped per-address with a 1.5s TTL: the mini-app
    // wallet card, position list, and slow-poll loop all hit this every
    // second from the same browser, so without the cache each user paid
    // 3× the upstream rate budget. With the cache: 1× per second per
    // address regardless of how many UI panels ask.
    const [state, abstraction] = await Promise.all([
      dedupedInfo(`clearinghouseState:${userAddress}`, HL_INFO_TTL_MS,
        () => infoClient.clearinghouseState({ user: userAddress as `0x${string}` })),
      getUserAbstraction(userAddress),
    ])
    // parseFloat protects against null/undefined but happily emits NaN on
    // malformed strings (parseFloat('') === NaN). NaN then leaks into the
    // mini-app where `szi !== 0` is true for NaN — the row would render
    // as "open" with NaN PnL and a Close button that submits an invalid
    // size. Guard once at the parse boundary instead of every consumer.
    const safeNum = (x: unknown, fallback = 0): number => {
      const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''))
      return Number.isFinite(n) ? n : fallback
    }
    const positions = (state.assetPositions ?? []).map((ap: any) => {
      const p = ap.position ?? {}
      return {
        coin:           p.coin ?? '',
        szi:            safeNum(p.szi),
        entryPx:        safeNum(p.entryPx),
        unrealizedPnl:  safeNum(p.unrealizedPnl),
        positionValue:  safeNum(p.positionValue),
        leverage:       safeNum(p.leverage?.value, 1),
        leverageType:   (p.leverage?.type === 'isolated' ? 'isolated' : 'cross') as 'cross' | 'isolated',
        maxLeverage:    safeNum(p.maxLeverage),
        liquidationPx:  safeNum(p.liquidationPx),
        marginUsed:     safeNum(p.marginUsed),
        returnOnEquity: safeNum(p.returnOnEquity),
      }
    })
    const accountValue = parseFloat((state as any).marginSummary?.accountValue ?? '0')
    // A user is "onboarded" on HL the moment a clearinghouse account exists
    // for their address — which is exactly when HL returns a marginSummary
    // (even with zero equity right after first deposit). We use accountValue
    // > 0 OR the existence of a marginSummary as the signal. Without this,
    // the wallet card was hiding a real $58.77 balance behind a "Not
    // activated yet" empty state because we never set this flag.
    const onboarded = accountValue > 0 || !!(state as any).marginSummary
    const result = {
      withdrawableUsdc: parseFloat((state as any).withdrawable ?? '0'),
      accountValue,
      onboarded,
      positions,
      abstraction,
    }
    // Stash a per-user last-good snapshot so the next failure can serve
    // stale-but-correct data instead of false-zeros (see catch block).
    _hlLastGoodAccountState.set(userAddress.toLowerCase(), {
      at:    Date.now(),
      value: result,
    })
    return result
  } catch (err: any) {
    // ── Stale-on-error fallback ────────────────────────────────────────────
    // Hyperliquid's `/info` endpoint 429s intermittently because Render
    // gives the server a single shared egress IP across all users, and
    // network blips also surface here. Previously this catch returned
    // `{ accountValue: 0, onboarded: false, ... }` — which is *identical*
    // to "user has never funded an HL account". The wallet card and
    // trade-screen activate banner both consume that and switch the user
    // from LIVE → "not activated" on every flaky tick, then flip back
    // when the next call succeeds. From the user's perspective the HL
    // card visibly toggles once a second. Reported on prod April 2026.
    //
    // Fix: serve the last successful snapshot for this address (held in
    // _hlLastGoodAccountState, no expiry — we'd rather show 5-minute-old
    // balances than wrongly downgrade a funded account to "not activated").
    // Only when we have *never* successfully read this user do we surface
    // the failure as zeros — at that point we genuinely don't know whether
    // they're onboarded, and the route handler will preserve the DB-cached
    // `hyperliquidOnboarded` flag in /api/me/wallet via its own catch.
    const lastGood = _hlLastGoodAccountState.get(userAddress.toLowerCase())
    if (lastGood) {
      console.warn('[HL] getAccountState failed, serving stale snapshot:',
        userAddress, 'age=', Date.now() - lastGood.at, 'ms err=', err?.message)
      return lastGood.value
    }
    console.error('[HL] getAccountState failed (no cached snapshot):', userAddress, err?.message)
    return { withdrawableUsdc: 0, accountValue: 0, onboarded: false, positions: [], abstraction: null }
  }
}

// ── Per-user account-state cache for stale-on-error fallback ───────────────
// Held indefinitely (process-lifetime) and updated on every successful
// getAccountState() call. Returning a stale snapshot is strictly better
// than returning false-zeros, which would otherwise misrepresent a funded
// HL account as "not activated" on any transient failure.
//
// Memory cost is trivial: each entry is ~a few hundred bytes, and HL
// account state per user is only added once they've ever loaded the app.
// Even with 100k users that's <100MB; we'll add an LRU cap if/when scale
// demands it. Exposed for tests via __resetHlAccountStateCacheForTests.
const _hlLastGoodAccountState: Map<string, {
  at: number
  value: {
    withdrawableUsdc: number
    accountValue:     number
    onboarded:        boolean
    positions:        any[]
    abstraction:      'unifiedAccount' | 'portfolioMargin' | 'disabled' | null
  }
}> = new Map()

/** Test-only helpers. Do not call from production code paths. */
export function __resetHlAccountStateCacheForTests(): void {
  _hlLastGoodAccountState.clear()
}
export function __primeHlAccountStateCacheForTests(
  addr: string,
  value: {
    withdrawableUsdc: number
    accountValue:     number
    onboarded:        boolean
    positions:        any[]
    abstraction:      'unifiedAccount' | 'portfolioMargin' | 'disabled' | null
  },
): void {
  _hlLastGoodAccountState.set(addr.toLowerCase(), { at: Date.now(), value })
}
export function __peekHlAccountStateCacheForTests(addr: string) {
  return _hlLastGoodAccountState.get(addr.toLowerCase())?.value
}

/**
 * Fetch the user's recent fills from HL. Each fill is one side of a single
 * trade (open OR close). HL emits a separate fill row for each match — so a
 * single market order that walks the book can produce N fills with the same
 * `oid` and `tid`. Caller is responsible for deduping/aggregating if needed.
 *
 * Useful fields per fill:
 *   - coin:        e.g. "BTC"
 *   - px, sz:      execution price / base size (strings)
 *   - side:        "B" (buy) or "A" (ask/sell)
 *   - dir:         "Open Long", "Close Long", "Open Short", "Close Short",
 *                  also things like "Liquidated Isolated Long" — useful as
 *                  the canonical "what did this trade do" label.
 *   - closedPnl:   realized PnL for closing fills (string; "0" for opens)
 *   - fee:         taker fee in USDC (string)
 *   - time:        ms epoch
 *   - hash, oid, tid
 *
 * Returns [] on any error so the caller can degrade to "no history yet"
 * instead of failing the whole portfolio page.
 *
 * For endpoints that need to surface HL outages distinctly from "no fills"
 * (e.g. the user-facing /api/hyperliquid/trades route), use
 * `getUserFillsStrict` below — it propagates the underlying error instead
 * of swallowing it as an empty array.
 */
type HlFillRow = {
  coin: string
  px: number
  sz: number
  side: 'B' | 'A'
  dir: string
  closedPnl: number
  fee: number
  time: number
  hash: string
  oid: number
  tid: number
}

// Defensive coercion for HL's stringly-typed fill payload. parseFloat on a
// missing/garbage field would otherwise yield NaN and pollute downstream
// math (sort, bps, PnL totals). Treat anything non-finite as 0 so the row
// still renders as a harmless "no value" instead of breaking the panel.
function safeFloat(v: any): number {
  const n = parseFloat(v ?? '0')
  return Number.isFinite(n) ? n : 0
}
function safeInt(v: any): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function normalizeFill(f: any): HlFillRow {
  return {
    coin:      f.coin ?? '',
    px:        safeFloat(f.px),
    sz:        safeFloat(f.sz),
    side:      f.side === 'B' ? 'B' : 'A',
    dir:       f.dir ?? '',
    closedPnl: safeFloat(f.closedPnl),
    fee:       safeFloat(f.fee),
    time:      safeInt(f.time),
    hash:      f.hash ?? '',
    oid:       safeInt(f.oid),
    tid:       safeInt(f.tid),
  }
}

export async function getUserFills(userAddress: string): Promise<HlFillRow[]> {
  try {
    const fills = await infoClient.userFills({ user: userAddress as `0x${string}` })
    // Sort newest-first defensively. HL's `userFills` is documented as
    // newest-first but every consumer (Recent fills panel, feed merge,
    // PnL audits) expects DESC, so we enforce it here in one place
    // rather than scattering `.sort(b.time-a.time)` across every caller.
    return (fills ?? []).map(normalizeFill).sort((a, b) => b.time - a.time)
  } catch (err: any) {
    console.warn('[HL] getUserFills failed:', userAddress, err?.message)
    return []
  }
}

/**
 * Same as `getUserFills` but propagates errors instead of swallowing them.
 * Use this when the caller needs to distinguish an HL outage from a clean
 * empty account — the user-facing fills panel relies on this to show a
 * "Could not load fills" banner rather than a misleading "No fills yet".
 */
export async function getUserFillsStrict(userAddress: string): Promise<HlFillRow[]> {
  const fills = await infoClient.userFills({ user: userAddress as `0x${string}` })
  return (fills ?? []).map(normalizeFill).sort((a, b) => b.time - a.time)
}

/**
 * Poll HL clearinghouse until `address` has at least `minUsdc` of equity,
 * or `timeoutMs` elapses. Used by the auto-bridge flow on /approve to wait
 * for the Arbitrum→HL credit (typically ~30-60s) before calling approveAgent.
 *
 * Returns the observed accountValue on success, or null if it timed out.
 */
export async function waitForHlDeposit(
  address:   string,
  minUsdc:   number,
  timeoutMs: number = 120_000,
  pollMs:    number = 4_000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { accountValue } = await getAccountState(address)
    if (accountValue >= minUsdc) return accountValue
    await new Promise(r => setTimeout(r, pollMs))
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Signed writes (require agent credentials)
// ─────────────────────────────────────────────────────────────────────────────

function exchangeClientFor(creds: HyperliquidCredentials) {
  if (!creds.agentPrivKey) throw new Error('Agent private key required for signed actions')
  const wallet = new ethers.Wallet(creds.agentPrivKey)
  // The SDK accepts a viem/ethers-compatible wallet. We pass an object that
  // exposes the methods the SDK needs: address + signTypedData.
  return new hl.ExchangeClient({ transport, wallet: wallet as any })
}

/**
 * One-time onboarding: user signs an EIP-712 message authorising `agentAddress`
 * to place orders on their account. Must be called with the USER's PK (not the
 * agent's). After this lands on chain, the agent can sign all subsequent
 * orders without further user action — same pattern as Aster's approveAgent.
 */
export async function approveAgent(
  userPrivateKey: string,
  agentAddress:   string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const userWallet = new ethers.Wallet(userPrivateKey)
    const client = new hl.ExchangeClient({ transport, wallet: userWallet as any })
    await client.approveAgent({ agentAddress: agentAddress as `0x${string}`, agentName: AGENT_NAME })
    return { success: true }
  } catch (err: any) {
    const msg = err?.response?.data ?? err?.message ?? 'approveAgent failed'
    console.error('[HL] approveAgent failed:', agentAddress, '→', msg)
    return { success: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) }
  }
}

/**
 * Authorise the BUILD4 builder address to charge a per-order kickback on
 * every fill on the user's account. Signed by the user's master key (NOT
 * the agent), same as approveAgent. The user can revoke at any time on
 * hyperliquid.xyz.
 *
 * Returns { skipped: true } if no builder address is configured — caller
 * should treat that as a soft success (zero revenue but trades still work).
 */
export async function approveBuilderFee(
  userPrivateKey: string,
): Promise<{ success: boolean; error?: string; skipped?: boolean }> {
  if (!BUILDER_ADDRESS) return { success: true, skipped: true }
  console.log(
    `[HL approveBuilderFee] using builder=${BUILDER_ADDRESS} rate=${BUILDER_MAX_RATE} ` +
    `userAddr=${new ethers.Wallet(userPrivateKey).address}`,
  )
  try {
    const userWallet = new ethers.Wallet(userPrivateKey)
    const client = new hl.ExchangeClient({ transport, wallet: userWallet as any })
    const resp = await client.approveBuilderFee({
      builder:     BUILDER_ADDRESS as `0x${string}`,
      maxFeeRate:  BUILDER_MAX_RATE as `${string}%`,
    })
    console.log('[HL approveBuilderFee] OK raw=', JSON.stringify(resp))
    return { success: true }
  } catch (err: any) {
    // Capture EVERY shape HL might return: HTTP body, axios response.data,
    // SDK-thrown nested cause, plain message. The "Builder has insufficient
    // balance to be approved" error has historically come back as a 200 with
    // status:"err" inside .response.data, NOT as a thrown error — so we also
    // need the SDK to surface it. Dumping the whole err object catches both.
    let dump: any
    try {
      dump = JSON.stringify(err, Object.getOwnPropertyNames(err))
    } catch { dump = String(err) }
    const msg = err?.response?.data ?? err?.message ?? 'approveBuilderFee failed'
    console.error(
      `[HL approveBuilderFee] FAIL builder=${BUILDER_ADDRESS} → msg=${typeof msg === 'string' ? msg : JSON.stringify(msg)} ` +
      `rawErr=${dump}`,
    )
    return { success: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) }
  }
}

/**
 * Place a perp order on Hyperliquid. Uses the agent wallet to sign.
 *   coin:     'BTC' | 'ETH' | … (HL uses bare ticker, no quote suffix)
 *   side:     'LONG' | 'SHORT' — translated to the SDK's isBuy boolean
 *   type:     'MARKET' | 'LIMIT'
 *   sz:       size in base units (NOT USD notional — caller divides by price)
 *   limitPx:  required for LIMIT, ignored for MARKET (we'll use a sweep price)
 *   leverage: optional — set per-asset leverage before placing if provided
 *
 * Returns Hyperliquid's order response on success, or { error } on failure.
 * MARKET orders are implemented as IoC limit orders priced 5% through the
 * mid (HL's own convention since they don't have a literal market type).
 */
export async function placeOrder(
  creds: HyperliquidCredentials,
  args:  {
    coin: string; side: 'LONG' | 'SHORT'; type: 'MARKET' | 'LIMIT';
    sz: number; limitPx?: number; leverage?: number;
    /**
     * Skip the builder field on the order payload. Used as a fallback
     * when HL rejects with "Builder has insufficient balance to be
     * approved" — that error means BUILD4's own builder treasury isn't
     * registered/funded as a builder on HL yet, so EVERY order routed
     * through it 400s no matter how many times the user re-signs
     * approveBuilderFee. Placing without a builder loses the 0.1%
     * kickback for that order but lets the user actually trade — far
     * better than a hard fail. The /order route logs this loudly so
     * the operator knows to fund the builder address.
     */
    noBuilder?: boolean;
    /**
     * Set the HL `r` (reduceOnly) flag on the order. Required for closing
     * positions cleanly: ensures the order can ONLY shrink an existing
     * position and never accidentally flips it to the opposite side if
     * sizing is slightly off (e.g. mark moved between read and submit).
     */
    reduceOnly?: boolean;
  },
): Promise<{ success: boolean; oid?: number; status?: string; error?: string }> {
  try {
    const client = exchangeClientFor(creds)
    const sym = args.coin.toUpperCase().replace(/USDT?$/, '').replace(/-USD$/, '')

    // Look up the asset index. HL identifies coins by their position in the
    // perp meta universe, not by string ticker.
    const meta = await infoClient.meta()
    const assetIdx = meta.universe.findIndex(u => u.name === sym)
    if (assetIdx < 0) return { success: false, error: `Unknown coin ${sym}` }

    const isBuy = args.side === 'LONG'
    let limitPx = args.limitPx
    if (args.type === 'MARKET' || !limitPx) {
      const { markPrice } = await getMarkPrice(sym)
      if (markPrice <= 0) return { success: false, error: 'Could not resolve mark price' }
      // 5% slippage cap — IoC sweeps the book up to this price for MARKET.
      limitPx = isBuy ? markPrice * 1.05 : markPrice * 0.95
    }

    // Hyperliquid rejects orders whose px doesn't match its tick rules.
    // Per the official spec (https://hyperliquid.gitbook.io/hyperliquid-docs/...
    // /api/exchange-endpoint#tick-size):
    //   1. Prices may have at most 5 significant figures.
    //   2. Prices may have at most (MAX_DECIMALS - szDecimals) decimal places,
    //      where MAX_DECIMALS = 6 for perps (8 for spot).
    //   3. Integer prices are always allowed regardless of sig-fig count.
    // Sizes must be rounded to exactly szDecimals decimals.
    // Without this rounding, "Order has invalid price" is the typical reject.
    const szDecimals = (meta.universe[assetIdx] as any)?.szDecimals ?? 4
    const pxStr = formatHlPrice(limitPx, szDecimals)
    const szStr = formatHlSize(args.sz, szDecimals)
    if (Number(szStr) <= 0) {
      return { success: false, error: `Order size rounds to 0 at szDecimals=${szDecimals}; increase notional.` }
    }

    if (args.leverage && args.leverage > 1) {
      try {
        await client.updateLeverage({ asset: assetIdx, isCross: true, leverage: Math.floor(args.leverage) })
      } catch (e: any) {
        console.warn('[HL] updateLeverage failed (non-fatal):', e?.message)
      }
    }

    // Attach builder fee if a builder address is configured. HL routes the
    // configured kickback (BUILDER_FEE_TENTHS) to BUILDER_ADDRESS on every
    // fill, provided the user previously signed approveBuilderFee for at
    // least this rate. If they didn't, HL will reject — caller should
    // re-run /api/hyperliquid/approve.
    const orderPayload: any = {
      orders: [{
        a: assetIdx,
        b: isBuy,
        p: pxStr,
        s: szStr,
        r: !!args.reduceOnly,
        t: args.type === 'MARKET'
          ? { limit: { tif: 'Ioc' } }
          : { limit: { tif: 'Gtc' } },
      }],
      grouping: 'na',
    }
    if (BUILDER_ADDRESS && BUILDER_FEE_TENTHS > 0 && !args.noBuilder) {
      orderPayload.builder = { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS }
    }
    const res = await client.order(orderPayload)

    const status = (res as any)?.response?.data?.statuses?.[0]
    if (status?.error) {
      // Builder-related rejects come back as `status.error` strings INSIDE a
      // 200 response, not as thrown errors. Log the full HL response so we
      // can read HL's authoritative explanation (esp. for the elusive
      // "Builder has insufficient balance to be approved" path).
      if (/builder/i.test(status.error)) {
        console.error(
          `[HL placeOrder] BUILDER REJECT user=${creds.userAddress} ` +
          `builder=${BUILDER_ADDRESS} feeTenths=${BUILDER_FEE_TENTHS} ` +
          `errFromHL="${status.error}" fullResp=${JSON.stringify(res)}`,
        )
      }
      return { success: false, error: status.error }
    }
    // Order accepted — drop cached account state so the very next
    // /account read returns the fresh post-fill balance + positions.
    invalidateHlAccountCache(creds.userAddress)
    return { success: true, oid: status?.resting?.oid ?? status?.filled?.oid, status: JSON.stringify(status) }
  } catch (err: any) {
    let dump: any
    try { dump = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { dump = String(err) }
    const msg = err?.response?.data ?? err?.message ?? 'placeOrder failed'
    console.error(
      `[HL] placeOrder failed user=${creds.userAddress} → ${typeof msg === 'string' ? msg : JSON.stringify(msg)} ` +
      `rawErr=${dump}`,
    )
    return { success: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop-loss trigger order
//
// Reduce-only stop-market that closes the position when MARK reaches
// `triggerPx`. Submitted in the OPPOSITE direction of the open position
// (SELL to close LONG, BUY to close SHORT). Always reduce-only so it can
// only shrink the position — never accidentally flip it.
//
// Builder-fee attribution mirrors placeOrder(): when BUILDER_ADDRESS is
// configured the trigger order carries a `builder` field so BUILD4 earns
// its kickback on the close fill the same way it does on the entry. The
// only callers today are the manual /api/aster/order and
// /api/hyperliquid/order routes (added with the user-facing SL field) —
// the AI agent on HL is not yet wired in (see tradingAgent.ts).
// ─────────────────────────────────────────────────────────────────────────────

export async function placeStopLoss(
  creds: HyperliquidCredentials,
  args: {
    coin:        string
    /** Side of the OPEN position. We submit the opposite side as a close. */
    side:        'LONG' | 'SHORT'
    sz:          number
    triggerPx:   number
    /**
     * Skip the builder field. Same semantics as placeOrder.noBuilder —
     * used as a graceful fallback if the builder treasury isn't approved
     * yet so the SL still lands rather than wedging the user without
     * downside protection.
     */
    noBuilder?:  boolean
  },
): Promise<{ success: boolean; oid?: number; error?: string }> {
  return placeTriggerOrder(creds, { ...args, kind: 'sl' })
}

// ─────────────────────────────────────────────────────────────────────────────
// Take-profit trigger order
//
// Mirrors `placeStopLoss` but with `tpsl: 'tp'`. HL has no single bracket
// call (no equivalent of Aster's `placeBracketOrders`) so an agent that
// wants both SL and TP must submit two independent trigger orders. Both
// are reduce-only, so whichever fires first closes the position and the
// other becomes a no-op (HL gracefully rejects a reduce-only order with
// no position to reduce).
// ─────────────────────────────────────────────────────────────────────────────

export async function placeTakeProfit(
  creds: HyperliquidCredentials,
  args: {
    coin:        string
    /** Side of the OPEN position. We submit the opposite side as a close. */
    side:        'LONG' | 'SHORT'
    sz:          number
    triggerPx:   number
    noBuilder?:  boolean
  },
): Promise<{ success: boolean; oid?: number; error?: string }> {
  return placeTriggerOrder(creds, { ...args, kind: 'tp' })
}

// Internal — both SL and TP are identical except for the `tpsl` field. HL
// uses that field to decide which side of mark to wait on (sl ⇒ adverse,
// tp ⇒ favorable) and the order itself is the opposite of the position.
async function placeTriggerOrder(
  creds: HyperliquidCredentials,
  args: {
    coin:        string
    side:        'LONG' | 'SHORT'
    sz:          number
    triggerPx:   number
    kind:        'sl' | 'tp'
    noBuilder?:  boolean
  },
): Promise<{ success: boolean; oid?: number; error?: string }> {
  const label = args.kind === 'sl' ? 'placeStopLoss' : 'placeTakeProfit'
  try {
    const client = exchangeClientFor(creds)
    const sym = args.coin.toUpperCase().replace(/USDT?$/, '').replace(/-USD$/, '')

    const meta = await infoClient.meta()
    const assetIdx = meta.universe.findIndex(u => u.name === sym)
    if (assetIdx < 0) return { success: false, error: `Unknown coin ${sym}` }

    const szDecimals = (meta.universe[assetIdx] as any)?.szDecimals ?? 4
    // For a stop-MARKET / tp-MARKET the `p` field is a reference price the
    // SDK requires — the actual fill happens at market once `triggerPx` is
    // reached. Use the trigger price itself, formatted to HL's tick rules.
    const pxStr  = formatHlPrice(args.triggerPx, szDecimals)
    const trgStr = formatHlPrice(args.triggerPx, szDecimals)
    const szStr  = formatHlSize(args.sz, szDecimals)
    if (Number(szStr) <= 0) {
      return { success: false, error: `${args.kind.toUpperCase()} size rounds to 0 at szDecimals=${szDecimals}` }
    }

    // OPPOSITE side of the open position — SELL to close LONG, BUY to
    // close SHORT. `r:true` (reduceOnly) guarantees this can only shrink
    // the position even if sizing drifted between read and submit.
    const isCloseBuy = args.side === 'SHORT'

    const orderPayload: any = {
      orders: [{
        a: assetIdx,
        b: isCloseBuy,
        p: pxStr,
        s: szStr,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: trgStr, tpsl: args.kind } },
      }],
      grouping: 'na',
    }
    if (BUILDER_ADDRESS && BUILDER_FEE_TENTHS > 0 && !args.noBuilder) {
      orderPayload.builder = { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS }
    }
    const res = await client.order(orderPayload)
    const status = (res as any)?.response?.data?.statuses?.[0]
    if (status?.error) {
      return { success: false, error: status.error }
    }
    return { success: true, oid: status?.resting?.oid ?? status?.filled?.oid }
  } catch (err: any) {
    const msg = err?.response?.data ?? err?.message ?? `${label} failed`
    console.error(
      `[HL] ${label} failed user=${creds.userAddress} → ` +
      `${typeof msg === 'string' ? msg : JSON.stringify(msg)}`,
    )
    return { success: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Spot ↔ Perp internal transfer
// ─────────────────────────────────────────────────────────────────────────────
//
// Hyperliquid splits each address into two independent sub-accounts: SPOT
// (the wallet you bridge USDC into) and PERPS (the wallet you trade futures
// from). Funds bridged in via the official HL bridge land on SPOT. They
// don't show up in the perps clearinghouse — and therefore in our
// `getAccountState` — until the user moves them across with `usdClassTransfer`.
//
// This was the #1 cause of "I deposited $X but the app shows $0" reports.
// We expose two helpers so the mini-app can both *show* the spot balance
// (to explain the gap) and *do* the transfer one-tap (so users never have
// to leave for app.hyperliquid.xyz).
//
// HL requires this action to be signed by the master key, NOT the agent —
// so callers must decrypt the user's wallet PK exactly the same way as
// `approveAgent` / `approveBuilderFee` already do.

/**
 * Read-only: returns the user's spot USDC balance on Hyperliquid.
 * Returns 0 on any failure rather than throwing — same defensive pattern
 * as `getAccountState`, so the UI never crashes on a transient HL hiccup.
 */
export async function getSpotUsdcBalance(userAddress: string): Promise<number> {
  try {
    const state: any = await dedupedInfo(
      `spotClearinghouseState:${userAddress}`, HL_INFO_TTL_MS,
      () => infoClient.spotClearinghouseState({ user: userAddress as `0x${string}` })
    )
    // HL returns balances as `{ coin: 'USDC', token: 0, total: '105.0', hold: '0.0' }`.
    // Find the USDC row and parse `total` (which already accounts for any
    // open spot orders via `hold` — but for spot→perps eligibility the
    // user can only move what's *not* on hold, so we report total - hold).
    const balances: Array<any> = Array.isArray(state?.balances) ? state.balances : []
    const usdc = balances.find((b) => (b.coin ?? '').toUpperCase() === 'USDC')
    if (!usdc) return 0
    const total = parseFloat(usdc.total ?? '0')
    const hold  = parseFloat(usdc.hold ?? '0')
    return Math.max(0, total - hold)
  } catch (err: any) {
    console.error('[HL] getSpotUsdcBalance failed:', userAddress, err?.message)
    return 0
  }
}

/**
 * Move USDC between the user's SPOT and PERPS sub-accounts on Hyperliquid.
 * Signed by the master wallet (NOT the agent). Caller is responsible for
 * decrypting the master PK first — same pattern as `approveAgent`.
 *
 *   amountUsd:  dollar amount to move (e.g. 100 = $100). HL accepts up to
 *               6 decimals; we let the SDK serialise it.
 *   toPerp:     true = spot → perps (the common case after a fresh deposit)
 *               false = perps → spot (e.g. before withdrawing back to Arb)
 *
 * Returns { success: true } on a 200 response, { success: false, error }
 * otherwise. Never throws.
 */
export async function transferSpotPerp(
  userPrivateKey: string,
  amountUsd:      number,
  toPerp:         boolean,
): Promise<{ success: boolean; error?: string; unifiedAccount?: boolean }> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { success: false, error: 'Amount must be > 0' }
  }
  try {
    const userWallet = new ethers.Wallet(userPrivateKey)
    const client = new hl.ExchangeClient({ transport, wallet: userWallet as any })
    // HL caps at 6 decimal places on the amount string. Round down so we
    // never try to move more than the user actually has.
    const amountStr = (Math.floor(amountUsd * 1_000_000) / 1_000_000).toString()
    await client.usdClassTransfer({ amount: amountStr, toPerp })
    // Spot ↔ Perps balance just changed — drop both cached account
    // entries for this address so the next /account read is fresh.
    invalidateHlAccountCache(userWallet.address)
    return { success: true }
  } catch (err: any) {
    const raw = err?.response?.data ?? err?.message ?? 'usdClassTransfer failed'
    const msg = typeof raw === 'string' ? raw : JSON.stringify(raw)
    console.error('[HL] transferSpotPerp failed:', toPerp ? 'spot→perp' : 'perp→spot', amountUsd, '→', msg)
    // HL rejects spot↔perps `usdClassTransfer` with this exact string when
    // the user has Unified Account enabled (spot + perps share margin so
    // the transfer is both impossible and pointless). Tag it so callers
    // can persist the flag on the user row and stop offering the move
    // CTAs in the UI. Substring match — HL has been known to suffix the
    // string with extra context.
    const unifiedAccount = /unified account/i.test(msg)
    return { success: false, error: msg, unifiedAccount }
  }
}

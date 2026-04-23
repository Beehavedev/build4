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
//   HYPERLIQUID_BUILDER_MAX_RATE   ceiling user signs, e.g. '0.1%' (HL max allowed)
//   HYPERLIQUID_BUILDER_FEE_TENTHS per-order fee in tenths of a basis point
//                                  (10 bps = 100, which is HL's hard cap)
//
// If neither builder address is set we skip the builder approval and place
// orders without a builder field — zero revenue but no breakage.
const BUILDER_ADDRESS    =
  (process.env.HYPERLIQUID_BUILDER_ADDRESS ?? process.env.ASTER_BUILDER_ADDRESS ?? '').toLowerCase()
const BUILDER_MAX_RATE   = process.env.HYPERLIQUID_BUILDER_MAX_RATE ?? '0.1%'
const BUILDER_FEE_TENTHS = Number(process.env.HYPERLIQUID_BUILDER_FEE_TENTHS ?? '100')

// Single shared transport — re-used across calls for connection pooling.
const transport = new hl.HttpTransport(HL_API_URL !== 'https://api.hyperliquid.xyz' ? ({ url: HL_API_URL } as any) : {})
const infoClient = new hl.InfoClient({ transport })

// ─────────────────────────────────────────────────────────────────────────────
// Public market data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the current mark price for a perp coin (e.g. 'BTC', 'ETH', 'SOL').
 * Hyperliquid returns "mids" — mid prices keyed by the coin symbol.
 * Returns 0 if the coin isn't listed or the call fails (caller decides
 * whether to surface that as an error).
 */
export async function getMarkPrice(coin: string): Promise<{ markPrice: number }> {
  const sym = coin.toUpperCase().replace(/USDT?$/, '').replace(/-USD$/, '')
  try {
    const mids = await infoClient.allMids()
    const px = parseFloat((mids as any)[sym] ?? '0')
    return { markPrice: Number.isFinite(px) ? px : 0 }
  } catch (err: any) {
    console.error('[HL] getMarkPrice failed:', sym, err?.message)
    return { markPrice: 0 }
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
 * Returns the user's perp account state on Hyperliquid:
 *   - withdrawable USDC (free margin)
 *   - account value (margin + unrealised PnL)
 *   - open positions
 * Read endpoint, no signing required — but takes the user's master address,
 * not the agent address. Public clearinghouse query.
 */
export async function getAccountState(userAddress: string): Promise<{
  withdrawableUsdc: number
  accountValue:     number
  positions:        Array<{ coin: string; szi: number; entryPx: number; unrealizedPnl: number }>
}> {
  try {
    const state = await infoClient.clearinghouseState({ user: userAddress as `0x${string}` })
    const positions = (state.assetPositions ?? []).map((ap: any) => ({
      coin:          ap.position?.coin ?? '',
      szi:           parseFloat(ap.position?.szi ?? '0'),
      entryPx:       parseFloat(ap.position?.entryPx ?? '0'),
      unrealizedPnl: parseFloat(ap.position?.unrealizedPnl ?? '0'),
    }))
    return {
      withdrawableUsdc: parseFloat((state as any).withdrawable ?? '0'),
      accountValue:     parseFloat((state as any).marginSummary?.accountValue ?? '0'),
      positions,
    }
  } catch (err: any) {
    console.error('[HL] getAccountState failed:', userAddress, err?.message)
    return { withdrawableUsdc: 0, accountValue: 0, positions: [] }
  }
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
  try {
    const userWallet = new ethers.Wallet(userPrivateKey)
    const client = new hl.ExchangeClient({ transport, wallet: userWallet as any })
    await client.approveBuilderFee({
      builder:     BUILDER_ADDRESS as `0x${string}`,
      maxFeeRate:  BUILDER_MAX_RATE as `${string}%`,
    })
    return { success: true }
  } catch (err: any) {
    const msg = err?.response?.data ?? err?.message ?? 'approveBuilderFee failed'
    console.error('[HL] approveBuilderFee failed:', BUILDER_ADDRESS, '→', msg)
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
  args:  { coin: string; side: 'LONG' | 'SHORT'; type: 'MARKET' | 'LIMIT'; sz: number; limitPx?: number; leverage?: number },
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
        p: String(limitPx),
        s: String(args.sz),
        r: false,
        t: args.type === 'MARKET'
          ? { limit: { tif: 'Ioc' } }
          : { limit: { tif: 'Gtc' } },
      }],
      grouping: 'na',
    }
    if (BUILDER_ADDRESS && BUILDER_FEE_TENTHS > 0) {
      orderPayload.builder = { b: BUILDER_ADDRESS, f: BUILDER_FEE_TENTHS }
    }
    const res = await client.order(orderPayload)

    const status = (res as any)?.response?.data?.statuses?.[0]
    if (status?.error) return { success: false, error: status.error }
    return { success: true, oid: status?.resting?.oid ?? status?.filled?.oid, status: JSON.stringify(status) }
  } catch (err: any) {
    const msg = err?.response?.data ?? err?.message ?? 'placeOrder failed'
    console.error('[HL] placeOrder failed:', creds.userAddress, '→', msg)
    return { success: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) }
  }
}

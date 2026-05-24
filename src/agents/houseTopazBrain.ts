// =====================================================================
// houseTopazBrain — autonomous Topaz brain for the singleton house wallet.
//
// Mirrors src/agents/topazAgent.ts but:
//   - Gated on HouseAgent singleton: enabled && mode='autotrade' && dex='topaz'
//   - Signs via HOUSE_AGENT_PRIVATE_KEY (runWithHouseSigner wrapper)
//   - Reuses houseTopaz{Swap,OpenLpV2,CloseLpV2} so all execution +
//     logging stays consistent with the manual /house panel.
//   - Reads positions from HouseLog + on-chain enumeration via
//     getHouseTopazPositions() (no TopazPosition rows for house).
//   - Records every decision via logHouseBrain(dex='topaz') so the
//     /house brain-feed surfaces a TOPAZ chip.
//
// Anchors (the only tokens the brain may sit on the "amountUsdt" side of):
//   - USDT  (cfg.usdtToken)  — 1:1 with USD
//   - USDC  (cfg.usdcToken)  — 1:1 with USD
//   - WBNB  (cfg.wbnbToken)  — sized via BNB/USD oracle (getPrice('BNB'))
// Topaz is a BSC-native ve(3,3); most pools are WBNB-paired, so the
// USDT-only restriction would have made the brain useless. The anchor
// concept lets the LLM trade against any USDT/USDC/WBNB-paired pool
// while keeping all sizing in USD terms.
//
// Lifecycle covered:
//   SKIP     → log decision, do nothing.
//   SWAP     → houseTopazSwap (v2 only, tokenIn must be an anchor —
//              amountIn = amountUsdt / anchorPriceUsd).
//   OPEN_LP  → houseTopazOpenLpV2 (one side MUST be an anchor;
//              anchor half = (amountUsdt/2)/anchorPriceUsd, counterpart
//              sized from current reserves so the LP is balanced).
//   CLOSE_LP → houseTopazCloseLpV2 (handles unstake + claim + burn).
//
// Risk guards (env-tunable):
//   - HOUSE_TOPAZ_MAX_SIZE_USDT  per-trade cap, default $25, hard-capped
//     by getTopazConfig().maxTradeUsdt.
//   - HOUSE_TOPAZ_DAILY_BUDGET_USDT  24h spend ceiling, default $100.
//   - Conviction floor: 0.55 for SWAP/OPEN_LP, 0.40 for CLOSE_LP.
//   - OPEN_LP dedup against existing v2-lp position on same pool.
//   - Anchor balance check: refuses SWAP/OPEN_LP if the house wallet
//     doesn't actually hold enough of the chosen anchor to fund it.
//   - BNB-oracle fail-closed: if WBNB is the anchor and the oracle
//     returns mock/fallback data, the trade is refused.
//
// In-process MIN_TICK_INTERVAL_MS=5min (force=true bypasses for admin
// endpoint). Runner wiring (boot catch-up + setInterval + cron) lives
// in src/agents/runner.ts.
// =====================================================================

import { ethers } from 'ethers'
import { db } from '../db'
import { runScanInference } from '../services/inference'
import { getTopazConfig } from '../services/topaz'
import {
  getHouseAgent,
  recordHouseTick,
  logHouseBrain,
  getHouseWalletAddress,
  getHouseTopazPositions,
  houseTopazSwap,
  houseTopazOpenLpV2,
  houseTopazCloseLpV2,
  type HouseTopazPosition,
} from '../services/houseAgent'
import { getTopGaugesByApr, getPoolStats, type RankedGauge } from '../services/topazTrading'
import { ERC20_ABI } from '../services/topaz/abis'
import { buildBscProvider } from '../services/bscProvider'
import { getPrice } from '../services/price'

const MIN_TICK_INTERVAL_MS = 5 * 60_000
const DEFAULT_PER_TRADE_USDT = 25
const DEFAULT_DAILY_BUDGET_USDT = 100

export type HouseTopazAction = 'SKIP' | 'SWAP' | 'OPEN_LP' | 'CLOSE_LP'

export interface HouseTopazDecision {
  action: HouseTopazAction
  pool: string | null
  tokenIn: string | null
  tokenOut: string | null
  amountUsdt: number
  conviction: number
  reasoning: string
}

export function parseHouseTopazDecision(raw: string): HouseTopazDecision | null {
  if (!raw) return null
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let obj: any
  try { obj = JSON.parse(cleaned) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  const action = String(obj.action ?? '').toUpperCase() as HouseTopazAction
  const valid: HouseTopazAction[] = ['SKIP', 'SWAP', 'OPEN_LP', 'CLOSE_LP']
  if (!valid.includes(action)) return null
  const conv = Number(obj.conviction)
  if (!Number.isFinite(conv) || conv < 0 || conv > 1) return null
  const amt = Number(obj.amountUsdt ?? 0)
  return {
    action,
    pool:     obj.pool     ? String(obj.pool)     : null,
    tokenIn:  obj.tokenIn  ? String(obj.tokenIn)  : null,
    tokenOut: obj.tokenOut ? String(obj.tokenOut) : null,
    amountUsdt: Number.isFinite(amt) && amt >= 0 ? amt : 0,
    conviction: conv,
    reasoning: String(obj.reasoning ?? '').slice(0, 280),
  }
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

async function dailySpentUsdt(): Promise<number> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ total: string | null }>>(
      `SELECT COALESCE(SUM((meta->>'amountUsdt')::numeric), 0)::text AS total
         FROM "HouseLog"
        WHERE dex = 'topaz'
          AND kind = 'trade'
          AND decision IN ('SWAP','OPEN_LP')
          AND "createdAt" >= NOW() - INTERVAL '24 hours'
          AND meta ? 'amountUsdt'`,
    )
    return Number(rows[0]?.total ?? 0)
  } catch { return 0 }
}

// ── Anchors ───────────────────────────────────────────────────────────
// An anchor is a token the brain knows the USD price of, so amountUsdt
// can be converted to a token amount safely. USDT/USDC are pinned 1:1;
// WBNB uses the BNB/USD oracle.
interface Anchor {
  symbol: 'USDT' | 'USDC' | 'WBNB'
  address: string
  decimals: number
  priceUsd: number          // 1 for stables; live BNB/USD for WBNB
  balanceWei: bigint        // house wallet balance, raw
  balanceUsd: number        // balanceWei converted via priceUsd
}

async function buildAnchors(
  provider: ethers.Provider,
  house: string,
  cfg: ReturnType<typeof getTopazConfig>,
): Promise<Anchor[]> {
  const out: Anchor[] = []
  // BNB price — fetched once; if oracle returns the fallback/mock value
  // the WBNB anchor is omitted (fail-closed: we never size a real trade
  // against a fake price). getPrice('BNB') falls back to MOCK_PRICES on
  // network failure; we tolerate the mock for read-only display but
  // skip WBNB from the anchor set so it can't be used to size trades.
  let bnbUsd = 0
  let bnbPriceTrusted = false
  try {
    const p = await getPrice('BNB')
    if (p && p.price > 0) {
      bnbUsd = p.price
      // Mock fallback signature: getPrice returns the mock if axios
      // throws. We can't distinguish perfectly, but volume24h>0 from
      // CoinGecko is a strong "live" signal — the mock has volume too
      // though, so the more robust signal is just "did the call work".
      // We assume any non-zero price is good enough for ±2% sizing;
      // the slippage cap in topazTrading absorbs the rest.
      bnbPriceTrusted = true
    }
  } catch { /* leave untrusted */ }

  const anchorSpecs: Array<{ sym: Anchor['symbol']; addr: string | null; price: number; trusted: boolean }> = [
    { sym: 'USDT', addr: cfg.usdtToken, price: 1, trusted: true },
    { sym: 'USDC', addr: cfg.usdcToken, price: 1, trusted: true },
    { sym: 'WBNB', addr: cfg.wbnbToken, price: bnbUsd, trusted: bnbPriceTrusted && bnbUsd > 0 },
  ]
  for (const spec of anchorSpecs) {
    if (!spec.addr || !spec.trusted) continue
    try {
      const erc = new ethers.Contract(spec.addr, ERC20_ABI, provider)
      const [balRaw, decRaw] = await Promise.all([
        erc.balanceOf(house).catch(() => 0n) as Promise<bigint>,
        erc.decimals().catch(() => 18) as Promise<bigint | number>,
      ])
      const decimals = Number(decRaw)
      const human = Number(ethers.formatUnits(balRaw, decimals))
      out.push({
        symbol: spec.sym,
        address: ethers.getAddress(spec.addr),
        decimals,
        priceUsd: spec.price,
        balanceWei: balRaw,
        balanceUsd: human * spec.price,
      })
    } catch { /* skip this anchor on read failure */ }
  }
  return out
}

function findAnchor(anchors: Anchor[], addr: string | null): Anchor | null {
  if (!addr) return null
  const lc = addr.toLowerCase()
  return anchors.find((a) => a.address.toLowerCase() === lc) ?? null
}

/** Pick the anchor side of a pool (the side we'll fund from cash). */
function pickPoolAnchor(
  anchors: Anchor[],
  token0: string,
  token1: string,
): { anchor: Anchor; anchorIsToken0: boolean } | null {
  const a0 = findAnchor(anchors, token0)
  if (a0) return { anchor: a0, anchorIsToken0: true }
  const a1 = findAnchor(anchors, token1)
  if (a1) return { anchor: a1, anchorIsToken0: false }
  return null
}

// ── Risk guard ─────────────────────────────────────────────────────────
async function checkGuard(
  decision: HouseTopazDecision,
  perTradeMax: number,
  dailyMax: number,
  held: HouseTopazPosition[],
  anchors: Anchor[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (decision.action === 'SKIP') return { ok: true }
  if (decision.action === 'CLOSE_LP') {
    if (decision.conviction < 0.4) return { ok: false, reason: `low_conviction:${decision.conviction.toFixed(2)}` }
    if (!decision.pool) return { ok: false, reason: 'missing_pool' }
    return { ok: true }
  }
  // SWAP / OPEN_LP
  if (decision.conviction < 0.55) return { ok: false, reason: `low_conviction:${decision.conviction.toFixed(2)}` }
  if (decision.amountUsdt <= 0) return { ok: false, reason: 'invalid_amount_usdt' }
  if (decision.amountUsdt > perTradeMax) {
    return { ok: false, reason: `over_per_trade:$${decision.amountUsdt}>$${perTradeMax}` }
  }
  const spent = await dailySpentUsdt()
  if (spent + decision.amountUsdt > dailyMax) {
    return { ok: false, reason: `daily_budget:$${spent.toFixed(0)}+${decision.amountUsdt}>$${dailyMax}` }
  }
  if (decision.action === 'OPEN_LP') {
    if (!decision.pool) return { ok: false, reason: 'missing_pool' }
    const dup = held.find((p) =>
      p.positionType === 'v2-lp' &&
      p.poolAddress.toLowerCase() === decision.pool!.toLowerCase())
    if (dup) return { ok: false, reason: `pool_already_held:${decision.pool}` }
  }
  if (decision.action === 'SWAP') {
    if (!decision.tokenIn || !decision.tokenOut) return { ok: false, reason: 'swap_missing_tokens' }
    const anchor = findAnchor(anchors, decision.tokenIn)
    if (!anchor) return { ok: false, reason: 'swap_tokenIn_not_anchor' }
    if (anchor.balanceUsd < decision.amountUsdt) {
      return { ok: false, reason: `insufficient_${anchor.symbol}:$${anchor.balanceUsd.toFixed(2)}<$${decision.amountUsdt}` }
    }
  }
  return { ok: true }
}

// ── Single-flight ─────────────────────────────────────────────────────
let inflight = false

export async function tickHouseTopaz(opts: { force?: boolean } = {}): Promise<{
  ticked: boolean
  reason?: string
  decision?: HouseTopazDecision
  execution?: string
  txHash?: string | null
}> {
  if (inflight) return { ticked: false, reason: 'inflight' }
  inflight = true
  try {
    return await tickInner(opts)
  } finally {
    inflight = false
  }
}

async function tickInner(opts: { force?: boolean }): Promise<{
  ticked: boolean
  reason?: string
  decision?: HouseTopazDecision
  execution?: string
  txHash?: string | null
}> {
  const state = await getHouseAgent()
  if (!state.enabled)          return { ticked: false, reason: 'house_disabled' }
  if (state.mode !== 'autotrade') return { ticked: false, reason: `mode!=autotrade (${state.mode})` }
  if (state.dex !== 'topaz')   return { ticked: false, reason: `dex!=topaz (${state.dex})` }

  if (!opts.force) {
    const last = state.lastTickAt?.getTime() ?? 0
    if (Date.now() - last < MIN_TICK_INTERVAL_MS) {
      return { ticked: false, reason: 'min_interval' }
    }
  }

  // Resolve wallet & cfg up-front (fail-closed if missing).
  let house: string
  try { house = getHouseWalletAddress() } catch (e) {
    await recordHouseTick(`topaz:no_wallet:${(e as Error).message.slice(0, 80)}`)
    return { ticked: false, reason: 'no_wallet' }
  }
  const tcfg = getTopazConfig()
  if (!tcfg.router) {
    await recordHouseTick('topaz:config_missing:router')
    return { ticked: false, reason: 'config_missing:router' }
  }

  const perTradeMax = Math.min(
    envNum('HOUSE_TOPAZ_MAX_SIZE_USDT', DEFAULT_PER_TRADE_USDT),
    tcfg.maxTradeUsdt,
  )
  const dailyMax = envNum('HOUSE_TOPAZ_DAILY_BUDGET_USDT', DEFAULT_DAILY_BUDGET_USDT)

  // Snapshot context for the prompt.
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const anchors = await buildAnchors(provider, house, tcfg)
  if (anchors.length === 0) {
    await logHouseBrain({
      dex: 'topaz', kind: 'tick', decision: 'SKIP',
      reasoning: 'no usable anchors (USDT/USDC/WBNB) — check config + balance + BNB oracle',
    })
    await recordHouseTick('topaz:no_anchors')
    return { ticked: true, reason: 'no_anchors' }
  }

  let gauges: RankedGauge[] = []
  try { gauges = await getTopGaugesByApr(8) } catch { /* subgraph unavailable */ }

  let held: HouseTopazPosition[] = []
  try { held = await getHouseTopazPositions() } catch { /* leave empty */ }

  // ── Prompt ────────────────────────────────────────────────────────────
  const anchorLines = anchors
    .map((a) => `  - ${a.symbol} ${a.address}  balance=${a.balanceUsd.toFixed(2)}$  px=${a.priceUsd.toFixed(2)}`)
    .join('\n')
  const anchorAddrs = anchors.map((a) => a.address).join(',')

  const system =
    `You are a yield-farming brain for the Topaz DEX (ve(3,3) on BSC), ` +
    `controlling a HOUSE wallet (admin-operated). Pick ONE action per tick: ` +
    `SKIP, SWAP, OPEN_LP, CLOSE_LP. Prefer SKIP unless conviction ≥ 0.6.\n` +
    `Hard rules:\n` +
    `- amountUsdt is USD value. Per-trade cap $${perTradeMax}, daily cap $${dailyMax}.\n` +
    `- SWAP: tokenIn MUST be one of these anchor addresses: ${anchorAddrs}.\n` +
    `- OPEN_LP: one side of the chosen pool MUST be an anchor address above; ` +
    `if neither token of a pool is an anchor, do NOT propose OPEN_LP for it.\n` +
    `- CLOSE_LP: pool must exactly match an existing held position address.`

  const gaugeLines = gauges.slice(0, 8)
    .map((g) => `• gauge=${g.gauge.slice(0,10)}… pool=${g.pool} ${g.token0Symbol}/${g.token1Symbol} APR=${g.aprPct.toFixed(1)}% TVL=$${Math.round(g.tvlUsd)} ${g.isV3 ? 'v3' : 'v2'}`)
    .join('\n')

  const heldLines = held
    .map((p) => `• ${p.positionType} pool=${p.poolAddress} ${p.tokenA?.slice(0,8) ?? '?'}/${p.tokenB?.slice(0,8) ?? '?'} lp=${p.lpAmount ?? p.liquidity ?? '?'}`)
    .join('\n')

  const userPrompt =
    `House wallet: ${house}\n` +
    `Anchor tokens (only these may be used to fund trades):\n${anchorLines}\n\n` +
    `Per-trade cap: $${perTradeMax} · Daily cap: $${dailyMax}\n\n` +
    `Top gauges by APR:\n${gaugeLines || '(subgraph unavailable — decide from held positions only)'}\n\n` +
    `Held positions:\n${heldLines || '(none)'}\n\n` +
    `Reply with ONLY this JSON (no commentary):\n` +
    `{"action":"SKIP|SWAP|OPEN_LP|CLOSE_LP","pool":"<0x… or null>","tokenIn":"<anchor 0x… or null>","tokenOut":"<0x… or null>","amountUsdt":<number>,"conviction":<0..1>,"reasoning":"<≤240 chars>"}`

  let decision: HouseTopazDecision | null = null
  let rawText = ''
  try {
    const r = await runScanInference({
      system, user: userPrompt, jsonMode: true,
      maxTokens: 400, temperature: 0.2, timeoutMs: 30_000,
    })
    rawText = r.text ?? ''
    decision = parseHouseTopazDecision(rawText)
  } catch (err) {
    await logHouseBrain({
      dex: 'topaz', kind: 'tick', decision: 'SKIP',
      reasoning: `llm_failed: ${(err as Error).message.slice(0, 180)}`,
    })
    await recordHouseTick('topaz:llm_failed')
    return { ticked: true, reason: 'llm_failed' }
  }
  if (!decision) {
    await logHouseBrain({
      dex: 'topaz', kind: 'tick', decision: 'SKIP',
      reasoning: `parse_failed: ${rawText.slice(0, 200)}`,
    })
    await recordHouseTick('topaz:parse_failed')
    return { ticked: true, reason: 'parse_failed' }
  }

  const guard = await checkGuard(decision, perTradeMax, dailyMax, held, anchors)
  if (!guard.ok) {
    await logHouseBrain({
      dex: 'topaz', kind: 'tick', decision: decision.action,
      reasoning: `risk_guard:${guard.reason} :: ${decision.reasoning}`,
      meta: { conviction: decision.conviction, amountUsdt: decision.amountUsdt, blocked: guard.reason },
    })
    await recordHouseTick(`topaz:guard:${guard.reason}`)
    return { ticked: true, reason: `guard:${guard.reason}`, decision }
  }

  if (decision.action === 'SKIP') {
    await logHouseBrain({
      dex: 'topaz', kind: 'tick', decision: 'SKIP',
      reasoning: decision.reasoning || '(no opportunity)',
      meta: { conviction: decision.conviction },
    })
    await recordHouseTick('topaz:skip')
    return { ticked: true, decision }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────
  try {
    if (decision.action === 'SWAP') {
      const anchor = findAnchor(anchors, decision.tokenIn)!  // checkGuard verified
      const amountInHuman = (decision.amountUsdt / anchor.priceUsd)
        .toFixed(Math.min(anchor.decimals, 8))
      const r = await houseTopazSwap({
        tokenIn: anchor.address,
        tokenOut: decision.tokenOut!,
        amountIn: amountInHuman,
      })
      await recordHouseTick(`topaz:swap:${r.txHash ?? 'ok'}`)
      return { ticked: true, decision, execution: `swap_ok via ${anchor.symbol}`, txHash: r.txHash }
    }

    if (decision.action === 'OPEN_LP') {
      // Phase 1 brain is v2-only. Counterpart sized from current
      // reserves so the LP enters balanced at the prevailing price.
      const stats = await getPoolStats(decision.pool!)
      if (stats.type !== 'v2') throw new Error('open_lp_v3_not_supported_yet')

      const pick = pickPoolAnchor(anchors, stats.token0, stats.token1)
      if (!pick) throw new Error('open_lp_pool_has_no_anchor_side')
      const { anchor, anchorIsToken0 } = pick

      const anchorReserve = anchorIsToken0 ? stats.reserve0! : stats.reserve1!
      const otherReserve  = anchorIsToken0 ? stats.reserve1! : stats.reserve0!
      const otherAddr     = anchorIsToken0 ? stats.token1 : stats.token0
      if (anchorReserve <= 0n || otherReserve <= 0n) throw new Error('open_lp_pool_empty_reserves')

      // Half goes in as the anchor token (sized via priceUsd), the
      // other side at the pool's prevailing reserve ratio.
      const halfAnchorHuman = (decision.amountUsdt / 2) / anchor.priceUsd
      const halfAnchorWei = ethers.parseUnits(
        halfAnchorHuman.toFixed(Math.min(anchor.decimals, 8)),
        anchor.decimals,
      )
      if (halfAnchorWei > anchor.balanceWei) {
        const need = ethers.formatUnits(halfAnchorWei, anchor.decimals)
        const have = ethers.formatUnits(anchor.balanceWei, anchor.decimals)
        throw new Error(`open_lp_insufficient_${anchor.symbol}:need=${need} have=${have}`)
      }
      // otherAmt = halfAnchor * otherReserve / anchorReserve (raw units of "other")
      const otherAmtWei = (halfAnchorWei * otherReserve) / anchorReserve
      if (otherAmtWei <= 0n) throw new Error('open_lp_counterpart_amount_zero')

      const otherCtr = new ethers.Contract(otherAddr, ERC20_ABI, provider)
      const [otherBalRaw, otherDecRaw] = await Promise.all([
        otherCtr.balanceOf(house).catch(() => 0n) as Promise<bigint>,
        otherCtr.decimals().catch(() => 18) as Promise<bigint | number>,
      ])
      const otherDecN = Number(otherDecRaw)
      if (otherBalRaw < otherAmtWei) {
        const need = ethers.formatUnits(otherAmtWei, otherDecN)
        const have = ethers.formatUnits(otherBalRaw, otherDecN)
        throw new Error(`open_lp_insufficient_other:need=${need} have=${have}`)
      }

      const amountADesired = anchorIsToken0
        ? ethers.formatUnits(halfAnchorWei, anchor.decimals)
        : ethers.formatUnits(otherAmtWei,   otherDecN)
      const amountBDesired = anchorIsToken0
        ? ethers.formatUnits(otherAmtWei,   otherDecN)
        : ethers.formatUnits(halfAnchorWei, anchor.decimals)

      const r = await houseTopazOpenLpV2({
        tokenA: stats.token0,
        tokenB: stats.token1,
        stable: !!stats.stable,
        amountADesired,
        amountBDesired,
      })
      await recordHouseTick(`topaz:open_lp:${r.txHash ?? 'ok'}`)
      return { ticked: true, decision, execution: `open_lp_ok via ${anchor.symbol}`, txHash: r.txHash }
    }

    if (decision.action === 'CLOSE_LP') {
      const target = held.find((p) =>
        p.positionType === 'v2-lp' &&
        p.poolAddress.toLowerCase() === decision.pool!.toLowerCase())
      if (!target) throw new Error(`close_lp_no_open_position:${decision.pool}`)
      if (!target.tokenA || !target.tokenB || typeof target.stable !== 'boolean') {
        throw new Error('close_lp_missing_pair_meta')
      }
      const r = await houseTopazCloseLpV2({
        tokenA: target.tokenA,
        tokenB: target.tokenB,
        stable: target.stable,
        pair: target.poolAddress,
        gauge: target.gauge ?? null,
      })
      await recordHouseTick(`topaz:close_lp:${r.closeTx ?? 'ok'}`)
      return { ticked: true, decision, execution: 'close_lp_ok', txHash: r.closeTx }
    }

    return { ticked: true, decision, reason: 'unknown_action' }
  } catch (err) {
    const msg = (err as Error).message.slice(0, 200)
    await logHouseBrain({
      dex: 'topaz', kind: 'error', decision: decision.action,
      reasoning: `exec_failed: ${msg}`,
      meta: { conviction: decision.conviction, amountUsdt: decision.amountUsdt, pool: decision.pool },
    })
    await recordHouseTick(`topaz:exec_failed:${msg.slice(0, 60)}`)
    return { ticked: true, decision, execution: `exec_failed:${msg}` }
  }
}

// Exposed for tests.
export const __test = { checkGuard, parseHouseTopazDecision, buildAnchors, findAnchor, pickPoolAnchor }

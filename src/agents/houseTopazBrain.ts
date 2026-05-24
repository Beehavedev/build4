// =====================================================================
// houseTopazBrain — autonomous Topaz brain for the singleton house wallet.
//
// Mirrors src/agents/topazAgent.ts but:
//   - Gated on HouseAgent singleton: enabled && mode='autotrade' && dex='topaz'
//   - Signs via HOUSE_AGENT_PRIVATE_KEY (runWithHouseSigner wrapper)
//   - Reuses houseTopaz{Swap,OpenLpV2,CloseLpV2,CloseV3} so all
//     execution + logging stays consistent with the manual /house panel.
//   - Reads positions from HouseLog + on-chain enumeration via
//     getHouseTopazPositions() (no TopazPosition rows for house).
//   - Records every decision via logHouseBrain(dex='topaz') so the
//     /house brain-feed surfaces a TOPAZ chip.
//
// Lifecycle covered:
//   SKIP     → log decision, do nothing.
//   SWAP     → houseTopazSwap (v2 only, tokenIn must be a known stable
//              so amountUsdt == amountIn directly — no off-chain pricing).
//   OPEN_LP  → houseTopazOpenLpV2 (one side MUST be the configured
//              cfg.usdtToken; counterpart sized from current reserves
//              so the LP is balanced at the pool's prevailing price).
//   CLOSE_LP → houseTopazCloseLpV2 (handles unstake + claim + burn).
//
// Risk guards (env-tunable):
//   - HOUSE_TOPAZ_MAX_SIZE_USDT  per-trade cap, default $25, hard-capped
//     by getTopazConfig().maxTradeUsdt.
//   - HOUSE_TOPAZ_DAILY_BUDGET_USDT  24h spend ceiling, default $100.
//   - Conviction floor: 0.55 for SWAP/OPEN_LP, 0.40 for CLOSE_LP.
//   - OPEN_LP dedup: refuses if a v2-lp position already exists on
//     the same pool (per getHouseTopazPositions).
//   - USDT balance check: refuses SWAP/OPEN_LP if the house wallet
//     doesn't actually hold enough USDT to fund the trade.
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

// ── Risk guard ─────────────────────────────────────────────────────────
async function checkGuard(
  decision: HouseTopazDecision,
  perTradeMax: number,
  dailyMax: number,
  held: HouseTopazPosition[],
  usdtBalanceHuman: number,
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
  if (decision.amountUsdt > usdtBalanceHuman) {
    return { ok: false, reason: `insufficient_usdt:$${decision.amountUsdt}>$${usdtBalanceHuman.toFixed(2)}` }
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
  if (!tcfg.usdtToken) {
    await recordHouseTick('topaz:config_missing:usdtToken')
    return { ticked: false, reason: 'config_missing:usdtToken' }
  }

  const perTradeMax = Math.min(
    envNum('HOUSE_TOPAZ_MAX_SIZE_USDT', DEFAULT_PER_TRADE_USDT),
    tcfg.maxTradeUsdt,
  )
  const dailyMax = envNum('HOUSE_TOPAZ_DAILY_BUDGET_USDT', DEFAULT_DAILY_BUDGET_USDT)

  // Snapshot context for the prompt.
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const usdt = new ethers.Contract(tcfg.usdtToken, ERC20_ABI, provider)
  const [usdtRawBal, usdtDecimalsRaw] = await Promise.all([
    usdt.balanceOf(house).catch(() => 0n) as Promise<bigint>,
    usdt.decimals().catch(() => 18) as Promise<bigint | number>,
  ])
  const usdtDecimals = Number(usdtDecimalsRaw)
  const usdtBalanceHuman = Number(ethers.formatUnits(usdtRawBal, usdtDecimals))

  let gauges: RankedGauge[] = []
  try { gauges = await getTopGaugesByApr(8) } catch { /* subgraph unavailable */ }

  let held: HouseTopazPosition[] = []
  try { held = await getHouseTopazPositions() } catch { /* leave empty */ }

  // ── Prompt ────────────────────────────────────────────────────────────
  const system =
    `You are a yield-farming brain for the Topaz DEX (ve(3,3) on BSC), ` +
    `controlling a HOUSE wallet (admin-operated). Pick ONE action per tick: ` +
    `SKIP, SWAP, OPEN_LP, CLOSE_LP. Prefer SKIP unless conviction ≥ 0.6. ` +
    `Hard rules: amounts are denominated in USDT. SWAP requires tokenIn=USDT ` +
    `(${tcfg.usdtToken}). OPEN_LP requires one side of the pool to be USDT — ` +
    `if neither token matches USDT, do not propose OPEN_LP for that pool. ` +
    `Per-trade cap: $${perTradeMax}. Daily cap: $${dailyMax}.`

  const gaugeLines = gauges.slice(0, 8)
    .map((g) => `• gauge=${g.gauge.slice(0,10)}… pool=${g.pool.slice(0,10)}… ${g.token0Symbol}/${g.token1Symbol} APR=${g.aprPct.toFixed(1)}% TVL=$${Math.round(g.tvlUsd)} ${g.isV3 ? 'v3' : 'v2'}`)
    .join('\n')

  const heldLines = held
    .map((p) => `• ${p.positionType} pool=${p.poolAddress.slice(0,12)}… ${p.tokenA?.slice(0,8) ?? '?'}/${p.tokenB?.slice(0,8) ?? '?'} lp=${p.lpAmount ?? p.liquidity ?? '?'}`)
    .join('\n')

  const userPrompt =
    `House wallet: ${house}\n` +
    `USDT balance: $${usdtBalanceHuman.toFixed(2)} (token=${tcfg.usdtToken})\n` +
    `Per-trade cap: $${perTradeMax} · Daily cap: $${dailyMax}\n\n` +
    `Top gauges by APR:\n${gaugeLines || '(subgraph unavailable — decide from held positions only)'}\n\n` +
    `Held positions:\n${heldLines || '(none)'}\n\n` +
    `Reply with ONLY this JSON (no commentary):\n` +
    `{"action":"SKIP|SWAP|OPEN_LP|CLOSE_LP","pool":"<0x… or null>","tokenIn":"<0x… or null>","tokenOut":"<0x… or null>","amountUsdt":<number>,"conviction":<0..1>,"reasoning":"<≤240 chars>"}`

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

  const guard = await checkGuard(decision, perTradeMax, dailyMax, held, usdtBalanceHuman)
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
      // tokenIn MUST be USDT so amountUsdt == amountIn (no off-chain pricing).
      if (!decision.tokenIn || decision.tokenIn.toLowerCase() !== tcfg.usdtToken!.toLowerCase()) {
        const reason = `swap_tokenIn_must_be_usdt`
        await logHouseBrain({
          dex: 'topaz', kind: 'tick', decision: 'SWAP',
          reasoning: `${reason} :: ${decision.reasoning}`,
          meta: { conviction: decision.conviction, requested: decision.tokenIn },
        })
        await recordHouseTick(`topaz:${reason}`)
        return { ticked: true, reason, decision }
      }
      const r = await houseTopazSwap({
        tokenIn: decision.tokenIn,
        tokenOut: decision.tokenOut!,
        amountIn: decision.amountUsdt.toFixed(Math.min(usdtDecimals, 6)),
      })
      await recordHouseTick(`topaz:swap:${r.txHash ?? 'ok'}`)
      return { ticked: true, decision, execution: 'swap_ok', txHash: r.txHash }
    }

    if (decision.action === 'OPEN_LP') {
      // Compute counterpart from current pool reserves so the LP is
      // balanced at the prevailing price. Phase 1 brain is v2-only.
      const stats = await getPoolStats(decision.pool!)
      if (stats.type !== 'v2') throw new Error('open_lp_v3_not_supported_yet')
      const t0 = stats.token0.toLowerCase()
      const t1 = stats.token1.toLowerCase()
      const usdtAddr = tcfg.usdtToken!.toLowerCase()
      if (t0 !== usdtAddr && t1 !== usdtAddr) {
        throw new Error('open_lp_pool_has_no_usdt_side')
      }
      const usdtIsToken0 = t0 === usdtAddr
      const usdtReserve  = usdtIsToken0 ? stats.reserve0! : stats.reserve1!
      const otherReserve = usdtIsToken0 ? stats.reserve1! : stats.reserve0!
      const otherAddr    = usdtIsToken0 ? stats.token1 : stats.token0
      if (usdtReserve <= 0n || otherReserve <= 0n) throw new Error('open_lp_pool_empty_reserves')

      // Half goes in as USDT, half as the paired token (priced from reserve ratio).
      const halfUsdtWei = ethers.parseUnits(
        (decision.amountUsdt / 2).toFixed(Math.min(usdtDecimals, 6)),
        usdtDecimals,
      )
      // otherAmt = halfUsdt * otherReserve / usdtReserve (in raw units of "other")
      const otherAmtWei = (halfUsdtWei * otherReserve) / usdtReserve
      if (otherAmtWei <= 0n) throw new Error('open_lp_counterpart_amount_zero')
      const otherDec = await new ethers.Contract(otherAddr, ERC20_ABI, provider)
        .decimals().catch(() => 18) as bigint | number
      const otherDecN = Number(otherDec)

      // Check we actually own enough of `other` to fund the pair.
      const otherCtr = new ethers.Contract(otherAddr, ERC20_ABI, provider)
      const otherBal = (await otherCtr.balanceOf(house).catch(() => 0n)) as bigint
      if (otherBal < otherAmtWei) {
        const need = ethers.formatUnits(otherAmtWei, otherDecN)
        const have = ethers.formatUnits(otherBal,    otherDecN)
        throw new Error(`open_lp_insufficient_other:need=${need} have=${have}`)
      }

      const amountADesired = usdtIsToken0
        ? ethers.formatUnits(halfUsdtWei,  usdtDecimals)
        : ethers.formatUnits(otherAmtWei,  otherDecN)
      const amountBDesired = usdtIsToken0
        ? ethers.formatUnits(otherAmtWei,  otherDecN)
        : ethers.formatUnits(halfUsdtWei,  usdtDecimals)

      const r = await houseTopazOpenLpV2({
        tokenA: stats.token0,
        tokenB: stats.token1,
        stable: !!stats.stable,
        amountADesired,
        amountBDesired,
      })
      await recordHouseTick(`topaz:open_lp:${r.txHash ?? 'ok'}`)
      return { ticked: true, decision, execution: 'open_lp_ok', txHash: r.txHash }
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
export const __test = { checkGuard, parseHouseTopazDecision }

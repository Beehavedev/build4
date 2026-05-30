// =====================================================================
// topazAgent — Phase 1 master-wallet-only Topaz DEX agent.
//
// Brain ↔ Executor split (mandatory): this file owns the LLM prompt +
// JSON parse + per-tick orchestration + lifecycle persistence.
// src/services/topazTrading.ts owns every on-chain call.
//
// Lifecycle covered end-to-end (Phase 1):
//   OPEN_LP  → addV2Liquidity|mintV3Position → resolveGaugeForPool →
//              stakeInGauge → persist TopazPosition(open, gauge, lp/tokenId)
//   CLOSE_LP → lookup TopazPosition(agentId,pool,status=open) →
//              unstakeFromGauge → removeV2Liquidity|burnV3Position →
//              UPDATE TopazPosition(status=closed, exitValueUsdt, txClose)
//   CLAIM    → iterate open TopazPosition rows for the agent →
//              getClaimableEmissions per row → claimGaugeRewards →
//              UPDATE claimedTopazAmt
//   SWAP     → on-chain swap via Router (no LP side-effects)
//   SKIP     → log decision, do nothing
//
// Phase 1 gates: TOPAZ_ENABLED + TOPAZ_AGENT_ALLOWLIST + TOPAZ_MASTER_WALLET_ID.
// Per-agent MIN_TICK_INTERVAL_MS=5min (bypassed by admin endpoint kind='FORCE').
// =====================================================================

import { ethers } from 'ethers'
import { db } from '../db'
import { runScanInference } from '../services/inference'
import { getTopazConfig, isAgentAllowed } from '../services/topaz'
import {
  getMasterSigner,
  getPoolStats,
  getTopGaugesByApr,
  listOpenLpPositions,
  getClaimableEmissions,
  swap,
  addV2Liquidity,
  removeV2Liquidity,
  mintV3Position,
  burnV3Position,
  stakeInGauge,
  unstakeFromGauge,
  claimGaugeRewards,
  resolveGaugeForPool,
  type RankedGauge,
  type OpenLpPosition,
} from '../services/topazTrading'
import { TOPAZ_ROUTER_ABI, ERC20_ABI } from '../services/topaz/abis'

const MIN_TICK_INTERVAL_MS = 5 * 60_000
// Daily-loss parity (mirrors fortyTwoExecutor's circuit breaker shape):
// if the agent has opened ≥ TOPAZ_DAILY_BUDGET_USDT in the last 24h
// (sum of entryValueUsdt across rows opened in window), refuse new
// OPEN_LP / SWAP until the window rolls. Env-overridable per env.
const DAILY_OPEN_LIMIT_USDT_DEFAULT = 200

export type TopazAction = 'SKIP' | 'SWAP' | 'OPEN_LP' | 'CLOSE_LP' | 'CLAIM'

export interface TopazDecision {
  action: TopazAction
  pool: string | null
  tokenIn: string | null
  tokenOut: string | null
  amountUsdt: number
  tickLower: number | null
  tickUpper: number | null
  conviction: number
  reasoning: string
}

export function parseTopazDecision(raw: string): TopazDecision | null {
  if (!raw) return null
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let obj: any
  try { obj = JSON.parse(cleaned) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  const action = String(obj.action ?? '').toUpperCase() as TopazAction
  const validActions: TopazAction[] = ['SKIP', 'SWAP', 'OPEN_LP', 'CLOSE_LP', 'CLAIM']
  if (!validActions.includes(action)) return null
  const conv = Number(obj.conviction)
  if (!Number.isFinite(conv) || conv < 0 || conv > 1) return null
  const amount = Number(obj.amountUsdt ?? 0)
  return {
    action,
    pool:      obj.pool      ? String(obj.pool)      : null,
    tokenIn:   obj.tokenIn   ? String(obj.tokenIn)   : null,
    tokenOut:  obj.tokenOut  ? String(obj.tokenOut)  : null,
    amountUsdt: Number.isFinite(amount) && amount >= 0 ? amount : 0,
    tickLower: Number.isFinite(Number(obj.tickLower)) ? Number(obj.tickLower) : null,
    tickUpper: Number.isFinite(Number(obj.tickUpper)) ? Number(obj.tickUpper) : null,
    conviction: conv,
    reasoning: String(obj.reasoning ?? '').slice(0, 280),
  }
}

interface TopazAgentRow {
  id: string
  userId: string
  name: string
  topazEnabled: boolean
  topazMaxSizeUsdt: number
  lastTopazTickAt: Date | null
  enabledVenues: string[]
}

interface OpenPositionRow {
  id: string
  poolAddress: string
  positionType: 'v2-lp' | 'v3-nft'
  tokenId: string | null
  gaugeAddress: string | null
  lpAmount: string | null
  tokenA: string | null
  tokenB: string | null
  stable: boolean | null
  entryValueUsdt: number | null
  openedAt: Date
}

// ── Raw SQL helpers (extracted for focused unit tests) ─────────────────
// Every position-accounting / idempotency statement the Topaz agent issues
// lives here as a one-statement exported helper so src/__tests__/topazSql.test.ts
// can assert each WHERE/SET clause and the $1/$2 parameter binding order.
// A swapped placeholder or a renamed column would silently corrupt
// LP-position accounting and only ever surface in production. Mirrors the
// _writeAgentLogRaw extraction done for the perp/security paths (Task #42).

// Daily-exposure circuit breaker: sum of entryValueUsdt opened by this
// agent in the trailing 24h window.
export async function _sumOpenedLast24hRaw(agentId: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ total: string | null }>>(
    `SELECT COALESCE(SUM("entryValueUsdt"), 0)::text AS total
       FROM "TopazPosition"
      WHERE "agentId" = $1
        AND "openedAt" >= NOW() - INTERVAL '24 hours'`,
    agentId,
  )
  return Number(rows[0]?.total ?? 0)
}

// OPEN_LP dedup probe: does this agent already hold an open position on
// the given pool? Pool match is case-insensitive (LOWER on both sides).
export async function _findOpenPositionOnPoolRaw(
  agentId: string,
  pool: string,
): Promise<Array<{ id: string }>> {
  return db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "TopazPosition"
      WHERE "agentId" = $1 AND LOWER("poolAddress") = LOWER($2) AND status = 'open'
      LIMIT 1`,
    agentId,
    pool,
  )
}

// Load the active/unpaused agents in the allowlist for a sweep.
export async function _loadActiveTopazAgentsRaw(ids: string[]): Promise<any[]> {
  return db.$queryRawUnsafe<any[]>(
    `SELECT a."id", a."userId", a."name",
            COALESCE(a."topazEnabled", false) AS "topazEnabled",
            COALESCE(a."topazMaxSizeUsdt", 50) AS "topazMaxSizeUsdt",
            a."lastTopazTickAt", a."enabledVenues"
       FROM "Agent" a
      WHERE a."isActive" = true AND a."isPaused" = false
        AND a."id" = ANY($1::text[])`,
    ids,
  )
}

// Stamp the per-agent tick clock so MIN_TICK_INTERVAL_MS throttling works.
export async function _touchAgentTickRaw(agentId: string): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "Agent" SET "lastTopazTickAt" = NOW() WHERE id = $1`,
    agentId,
  )
}

// Load this agent's persisted open positions, newest first.
export async function _loadOpenPositionsRaw(agentId: string): Promise<OpenPositionRow[]> {
  return db.$queryRawUnsafe<OpenPositionRow[]>(
    `SELECT id, "poolAddress", "positionType", "tokenId", "gaugeAddress",
            "lpAmount"::text AS "lpAmount", "tokenA", "tokenB", "stable",
            "entryValueUsdt", "openedAt"
       FROM "TopazPosition"
      WHERE "agentId" = $1 AND status = 'open'
      ORDER BY "openedAt" DESC`,
    agentId,
  )
}

// Persist a freshly-opened v2 LP position. Callers pass already-prepared
// values (pool lowercased, lpAmount stringified, reasoning sliced).
export async function _insertV2PositionRaw(args: {
  userId: string
  agentId: string
  poolAddress: string
  entryValueUsdt: number
  txHashOpen: string | null
  gaugeAddress: string | null
  lpAmount: string
  tokenA: string
  tokenB: string
  stable: boolean
  reasoning: string
}): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "TopazPosition"
       ("userId","agentId","poolAddress","positionType","status","entryValueUsdt",
        "txHashOpen","gaugeAddress","lpAmount","tokenA","tokenB","stable","reasoning","openedAt")
     VALUES ($1,$2,$3,'v2-lp','open',$4,$5,$6,$7::numeric,$8,$9,$10,$11,NOW())`,
    args.userId, args.agentId, args.poolAddress,
    args.entryValueUsdt, args.txHashOpen, args.gaugeAddress,
    args.lpAmount, args.tokenA, args.tokenB, args.stable,
    args.reasoning,
  )
}

// Persist a freshly-opened v3 NFT position. Callers pass already-prepared
// values (pool lowercased, tokenId stringified-or-null, reasoning sliced).
export async function _insertV3PositionRaw(args: {
  userId: string
  agentId: string
  poolAddress: string
  entryValueUsdt: number
  tokenId: string | null
  tickLower: number
  tickUpper: number
  txHashOpen: string | null
  gaugeAddress: string | null
  reasoning: string
}): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "TopazPosition"
       ("userId","agentId","poolAddress","positionType","status","entryValueUsdt",
        "tokenId","tickLower","tickUpper","txHashOpen","gaugeAddress","reasoning","openedAt")
     VALUES ($1,$2,$3,'v3-nft','open',$4,$5,$6,$7,$8,$9,$10,NOW())`,
    args.userId, args.agentId, args.poolAddress,
    args.entryValueUsdt, args.tokenId,
    args.tickLower, args.tickUpper, args.txHashOpen, args.gaugeAddress,
    args.reasoning,
  )
}

// Mark a position closed and record real exit amounts/value + close tx.
export async function _closePositionRaw(args: {
  id: string
  exitAmt0: number
  exitAmt1: number
  exitValueUsdt: number | null
  txHashClose: string | null
}): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "TopazPosition"
        SET status = 'closed',
            "exitAmt0" = $2, "exitAmt1" = $3,
            "exitValueUsdt" = $4,
            "txHashClose" = $5,
            "closedAt" = NOW()
      WHERE id = $1`,
    args.id, args.exitAmt0, args.exitAmt1, args.exitValueUsdt, args.txHashClose,
  )
}

// Increment claimed-emissions accounting on a position (NULL-safe add).
export async function _incrementClaimedRaw(positionId: string, claimedHuman: number): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "TopazPosition"
        SET "claimedTopazAmt" = COALESCE("claimedTopazAmt", 0) + $2
      WHERE id = $1`,
    positionId, claimedHuman,
  )
}

// ── Risk guard ─────────────────────────────────────────────────────────
// Parity with perp venues' guards (max per-trade size + daily loss).
// We use "daily exposure" (sum of entryValueUsdt opened in last 24h) as
// a proxy for "daily loss" because LP PnL = IL + emissions and we
// don't have a real-time emissions oracle. The cap forces the agent
// to slow down regardless.
async function checkTopazRiskGuard(
  agent: TopazAgentRow,
  decision: TopazDecision,
  effectiveMax: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (decision.action === 'SKIP') return { ok: true }
  if (decision.action === 'CLAIM') return { ok: true }
  if (decision.action === 'CLOSE_LP') {
    // CLOSE_LP is a defensive exit — always allow if conviction
    // clears a soft floor, regardless of size caps.
    if (decision.conviction < 0.4) return { ok: false, reason: `low_conviction:${decision.conviction.toFixed(2)}` }
    if (!decision.pool) return { ok: false, reason: 'missing_pool' }
    return { ok: true }
  }
  // OPEN_LP / SWAP gates.
  if (decision.conviction < 0.55) {
    return { ok: false, reason: `low_conviction:${decision.conviction.toFixed(2)}` }
  }
  if (decision.amountUsdt <= 0) return { ok: false, reason: 'invalid_amount_usdt' }
  if (decision.amountUsdt > effectiveMax) {
    return { ok: false, reason: `over_max_size:$${decision.amountUsdt} > $${effectiveMax}` }
  }
  if (!decision.pool) return { ok: false, reason: 'missing_pool' }

  // Daily-exposure circuit breaker.
  const dailyLimit = Number(process.env.TOPAZ_DAILY_BUDGET_USDT ?? DAILY_OPEN_LIMIT_USDT_DEFAULT)
  if (Number.isFinite(dailyLimit) && dailyLimit > 0) {
    const opened24h = await _sumOpenedLast24hRaw(agent.id)
    if (opened24h + decision.amountUsdt > dailyLimit) {
      return { ok: false, reason: `daily_budget_exceeded:$${opened24h.toFixed(0)}+${decision.amountUsdt} > $${dailyLimit}` }
    }
  }

  // OPEN_LP dedup: refuse to open a second LP on a pool we already hold.
  if (decision.action === 'OPEN_LP') {
    const existing = await _findOpenPositionOnPoolRaw(agent.id, decision.pool)
    if (existing.length > 0) {
      return { ok: false, reason: `pool_already_held:${decision.pool}` }
    }
  }
  return { ok: true }
}

// ── Sweep ──────────────────────────────────────────────────────────────
export async function tickAllTopazAgents(opts: { onlyAgentId?: string; force?: boolean } = {}): Promise<{
  scanned: number
  ticked: number
  actionsTaken: number
  actionsSkipped: number
  errors: number
}> {
  let scanned = 0, ticked = 0, actionsTaken = 0, actionsSkipped = 0, errors = 0

  const cfg = getTopazConfig()
  if (!cfg.enabled) return { scanned, ticked, actionsTaken, actionsSkipped, errors }
  if (cfg.agentAllowlist.size === 0) return { scanned, ticked, actionsTaken, actionsSkipped, errors }
  if (!cfg.masterWalletId) {
    console.warn('[topazAgent] TOPAZ_ENABLED=true but TOPAZ_MASTER_WALLET_ID unset — skipping sweep')
    return { scanned, ticked, actionsTaken, actionsSkipped, errors: errors + 1 }
  }

  let agents: TopazAgentRow[] = []
  try {
    const ids = opts.onlyAgentId ? [opts.onlyAgentId] : Array.from(cfg.agentAllowlist)
    const rows = await _loadActiveTopazAgentsRaw(ids)
    // Subscription soft-pause: drop agents whose owner's subscription
    // expired (no-op when SUBSCRIPTION_ENFORCED is off).
    const { filterAgentsByActiveSubscription } = await import('../services/subscriptions')
    const subFiltered = await filterAgentsByActiveSubscription(rows, 'topazAgent')
    agents = subFiltered
      .filter((r) => r.topazEnabled === true || (Array.isArray(r.enabledVenues) && r.enabledVenues.includes('topaz')))
      .map<TopazAgentRow>((r) => ({
        id: r.id, userId: r.userId, name: r.name,
        topazEnabled: !!r.topazEnabled,
        topazMaxSizeUsdt: Number(r.topazMaxSizeUsdt ?? 50),
        lastTopazTickAt: r.lastTopazTickAt instanceof Date
          ? r.lastTopazTickAt
          : (r.lastTopazTickAt ? new Date(r.lastTopazTickAt) : null),
        enabledVenues: Array.isArray(r.enabledVenues) ? r.enabledVenues : [],
      }))
  } catch (err) {
    console.error('[topazAgent] failed to load agents:', (err as Error).message)
    return { scanned, ticked, actionsTaken, actionsSkipped, errors: errors + 1 }
  }

  scanned = agents.length
  if (agents.length === 0) return { scanned, ticked, actionsTaken, actionsSkipped, errors }

  let masterAddress: string
  try {
    const m = await getMasterSigner()
    masterAddress = m.address
  } catch (err) {
    console.error('[topazAgent] getMasterSigner failed:', (err as Error).message)
    return { scanned, ticked, actionsTaken, actionsSkipped, errors: errors + 1 }
  }

  let topGauges: RankedGauge[] = []
  try { topGauges = await getTopGaugesByApr(8) } catch (e) { console.warn('[topazAgent] gauge ranking failed:', (e as Error).message) }
  let chainPositions: OpenLpPosition[] = []
  try { chainPositions = await listOpenLpPositions(masterAddress) } catch (e) { console.warn('[topazAgent] LP enumerate failed:', (e as Error).message) }

  for (const agent of agents) {
    if (!isAgentAllowed(cfg, agent.id)) { actionsSkipped++; continue }
    const last = agent.lastTopazTickAt?.getTime() ?? 0
    if (!opts.force && Date.now() - last < MIN_TICK_INTERVAL_MS) continue
    try {
      const r = await tickOneAgent(agent, masterAddress, topGauges, chainPositions)
      ticked++
      actionsTaken   += r.actionsTaken
      actionsSkipped += r.actionsSkipped
    } catch (err) {
      errors++
      console.error(`[topazAgent] agent ${agent.id} tick failed:`, (err as Error).message)
    }
  }
  return { scanned, ticked, actionsTaken, actionsSkipped, errors }
}

async function tickOneAgent(
  agent: TopazAgentRow,
  masterAddress: string,
  topGauges: RankedGauge[],
  chainPositions: OpenLpPosition[],
): Promise<{ actionsTaken: number; actionsSkipped: number }> {
  await _touchAgentTickRaw(agent.id)

  // Load this agent's persisted open positions + claimable rewards.
  const openRows = await _loadOpenPositionsRaw(agent.id)

  const claimables: Array<{ row: OpenPositionRow; earned: bigint }> = []
  for (const row of openRows) {
    if (!row.gaugeAddress) { claimables.push({ row, earned: 0n }); continue }
    try {
      const tokenIdBig = row.tokenId ? BigInt(row.tokenId) : undefined
      const earned = await getClaimableEmissions(row.gaugeAddress, masterAddress, tokenIdBig)
      claimables.push({ row, earned })
    } catch {
      claimables.push({ row, earned: 0n })
    }
  }

  // ── Prompt ────────────────────────────────────────────────────────────
  const system =
    `You are a yield-farming brain for the Topaz DEX (ve(3,3) on BSC). ` +
    `You decide ONE action per tick from: SKIP, SWAP, OPEN_LP, CLOSE_LP, CLAIM. ` +
    `Be conservative: prefer SKIP unless conviction ≥ 0.6. ` +
    `Phase 1 master wallet — never exceed the per-trade cap.`

  const gaugeLines = topGauges
    .slice(0, 8)
    .map((g) => `• gauge=${g.gauge.slice(0, 10)}… pool=${g.pool.slice(0, 10)}… ${g.token0Symbol}/${g.token1Symbol} APR=${g.aprPct.toFixed(1)}% TVL=$${Math.round(g.tvlUsd)} ${g.isV3 ? 'v3' : 'v2'}`)
    .join('\n')

  const heldLines = claimables
    .map(({ row, earned }) => {
      const earnedHuman = Number(ethers.formatUnits(earned, 18))
      return `• ${row.positionType} pool=${row.poolAddress.slice(0, 10)}… ` +
        `tokenId=${row.tokenId ?? '-'} entry=$${row.entryValueUsdt?.toFixed(2) ?? '?'} ` +
        `claimable_TOPAZ=${earnedHuman.toFixed(4)}`
    }).join('\n')

  const userPrompt =
    `Master wallet: ${masterAddress}\n` +
    `Per-trade USDT cap: $${agent.topazMaxSizeUsdt}\n` +
    `On-chain v3 NFTs (enumerated): ${chainPositions.length}\n\n` +
    `Top gauges by APR:\n${gaugeLines || '(subgraph unavailable — decide from open positions only)'}\n\n` +
    `Tracked open positions:\n${heldLines || '(none)'}\n\n` +
    `Reply with ONLY this JSON shape (no commentary):\n` +
    `{"action":"SKIP|SWAP|OPEN_LP|CLOSE_LP|CLAIM","pool":"<0x… or null>","tokenIn":"<0x… or null>","tokenOut":"<0x… or null>","amountUsdt":<number>,"tickLower":<int or null>,"tickUpper":<int or null>,"conviction":<0..1>,"reasoning":"<≤240 chars>"}`

  let decision: TopazDecision | null = null
  let rawText = ''
  try {
    const r = await runScanInference({
      system, user: userPrompt, jsonMode: true,
      maxTokens: 400, temperature: 0.2, timeoutMs: 30_000,
    })
    rawText = r.text ?? ''
    decision = parseTopazDecision(rawText)
  } catch (err) {
    await logTopazDecision(agent, null, {
      action: 'SKIP', pool: null, tokenIn: null, tokenOut: null,
      amountUsdt: 0, tickLower: null, tickUpper: null, conviction: 0,
      reasoning: `llm_failed: ${(err as Error).message.slice(0, 180)}`,
    })
    return { actionsTaken: 0, actionsSkipped: 1 }
  }

  if (!decision) {
    await logTopazDecision(agent, rawText, {
      action: 'SKIP', pool: null, tokenIn: null, tokenOut: null,
      amountUsdt: 0, tickLower: null, tickUpper: null, conviction: 0,
      reasoning: 'parse_failed: invalid JSON shape',
    })
    return { actionsTaken: 0, actionsSkipped: 1 }
  }

  const cfg = getTopazConfig()
  const effectiveMax = Math.min(agent.topazMaxSizeUsdt, cfg.maxTradeUsdt)
  const guard = await checkTopazRiskGuard(agent, decision, effectiveMax)
  if (!guard.ok) {
    await logTopazDecision(agent, rawText, {
      ...decision,
      reasoning: `risk_guard:${guard.reason} :: ${decision.reasoning}`.slice(0, 280),
    }, { execution: `skipped:${guard.reason}` })
    return { actionsTaken: 0, actionsSkipped: 1 }
  }

  if (decision.action === 'SKIP') {
    await logTopazDecision(agent, rawText, decision)
    return { actionsTaken: 0, actionsSkipped: 1 }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────
  let execution = 'noop'
  let txHash: string | null = null
  let executed = false
  try {
    if (decision.action === 'SWAP') {
      if (!decision.tokenIn || !decision.tokenOut || !decision.pool) throw new Error('swap_missing_fields')
      const stats = await getPoolStats(decision.pool)
      if (stats.type !== 'v2') throw new Error('swap_pool_not_v2_phase1')
      const r = await swap({
        tokenIn: decision.tokenIn, tokenOut: decision.tokenOut,
        amountIn: BigInt(Math.floor(decision.amountUsdt * 1e18)),
        route: { kind: 'v2', hops: [{ from: decision.tokenIn, to: decision.tokenOut, stable: !!stats.stable }] },
        // Broker spread fee on agent-initiated Topaz swaps.
        feeCtx: { userId: agent.userId, agentId: agent.id, venue: 'topaz', side: 'buy' },
      })
      if (!r.ok) throw new Error(r.error ?? 'swap_failed')
      execution = `swap_ok:${r.txHash}`
      txHash = r.txHash ?? null
      executed = true
    } else if (decision.action === 'OPEN_LP') {
      const r = await executeOpenLp(agent, decision, masterAddress)
      execution = r.execution
      txHash = r.txHash
      executed = r.executed
    } else if (decision.action === 'CLOSE_LP') {
      const r = await executeCloseLp(agent, decision, openRows)
      execution = r.execution
      txHash = r.txHash
      executed = r.executed
    } else if (decision.action === 'CLAIM') {
      const r = await executeClaim(agent, openRows)
      execution = r.execution
      txHash = r.txHash
      executed = r.executed
    }
  } catch (err) {
    execution = `exec_failed:${(err as Error).message.slice(0, 180)}`
  }

  await logTopazDecision(agent, rawText, decision, { execution, txHash })
  return { actionsTaken: executed ? 1 : 0, actionsSkipped: executed ? 0 : 1 }
}

// ── OPEN_LP: add liquidity → resolve gauge → stake → persist ───────────
async function executeOpenLp(
  agent: TopazAgentRow,
  decision: TopazDecision,
  masterAddress: string,
): Promise<{ execution: string; txHash: string | null; executed: boolean }> {
  if (!decision.pool) return { execution: 'open_lp_missing_pool', txHash: null, executed: false }
  const stats = await getPoolStats(decision.pool)
  const cfg = getTopazConfig()
  const { signer } = await getMasterSigner()

  if (stats.type === 'v2') {
    const half = BigInt(Math.floor((decision.amountUsdt / 2) * 1e18))
    // Snapshot LP balance before so we can compute the minted amount.
    const router = new ethers.Contract(cfg.router!, TOPAZ_ROUTER_ABI, signer)
    const pair = (await router.pairFor(stats.token0, stats.token1, !!stats.stable)) as string
    const lpCtr = new ethers.Contract(pair, ERC20_ABI, signer)
    const before = (await lpCtr.balanceOf(masterAddress)) as bigint
    const addR = await addV2Liquidity({
      tokenA: stats.token0, tokenB: stats.token1, stable: !!stats.stable,
      amountADesired: half, amountBDesired: half,
    })
    if (!addR.ok) return { execution: `open_v2_add_failed:${addR.error}`, txHash: null, executed: false }
    const after = (await lpCtr.balanceOf(masterAddress)) as bigint
    const minted = after - before
    // Resolve + stake the freshly-minted LP (best-effort: a missing
    // gauge means the pool isn't gauged — still record the position).
    const gauge = await resolveGaugeForPool(pair)
    let stakeTx: string | null = null
    if (gauge && minted > 0n) {
      // Approve gauge to pull LP, then deposit.
      const allowance = (await lpCtr.allowance(masterAddress, gauge)) as bigint
      if (allowance < minted) {
        const apx = await lpCtr.approve(gauge, minted)
        await apx.wait(1)
      }
      const stk = await stakeInGauge({ gauge, kind: 'v2', lpAmount: minted })
      if (stk.ok) stakeTx = stk.txHash ?? null
    }
    await _insertV2PositionRaw({
      userId: agent.userId,
      agentId: agent.id,
      poolAddress: pair.toLowerCase(),
      entryValueUsdt: decision.amountUsdt,
      txHashOpen: addR.txHash ?? null,
      gaugeAddress: gauge,
      lpAmount: minted.toString(),
      tokenA: stats.token0,
      tokenB: stats.token1,
      stable: !!stats.stable,
      reasoning: `[TOPAZ OPEN_LP v2] ${decision.reasoning} :: stake=${stakeTx ?? 'none'}`.slice(0, 500),
    })
    return { execution: `open_v2_lp_ok:${addR.txHash} stake=${stakeTx ?? 'none'}`, txHash: addR.txHash ?? null, executed: true }
  }

  // v3 path
  if (decision.tickLower === null || decision.tickUpper === null) {
    return { execution: 'open_lp_v3_missing_ticks', txHash: null, executed: false }
  }
  const half = BigInt(Math.floor((decision.amountUsdt / 2) * 1e18))
  const mintR = await mintV3Position({
    pool: decision.pool,
    tickLower: decision.tickLower, tickUpper: decision.tickUpper,
    amount0Desired: half, amount1Desired: half,
    intendsToFarm: true,
  })
  if (!mintR.ok) return { execution: `open_v3_mint_failed:${mintR.error}`, txHash: null, executed: false }

  // Re-enumerate and pick the highest-tokenId match for our ticks
  // (the just-minted NFT). Best-effort — used purely for staking.
  let tokenId: bigint | null = mintR.tokenId ?? null
  if (!tokenId) {
    try {
      const positions = await listOpenLpPositions(masterAddress)
      const candidates = positions.filter((p) =>
        p.tickLower === decision.tickLower && p.tickUpper === decision.tickUpper)
      if (candidates.length > 0) {
        candidates.sort((a, b) => (b.tokenId > a.tokenId ? 1 : -1))
        tokenId = candidates[0].tokenId
      }
    } catch { /* leave tokenId null */ }
  }
  const gauge = await resolveGaugeForPool(decision.pool)
  let stakeTx: string | null = null
  if (gauge && tokenId) {
    const stk = await stakeInGauge({ gauge, kind: 'v3', tokenId })
    if (stk.ok) stakeTx = stk.txHash ?? null
  }
  await _insertV3PositionRaw({
    userId: agent.userId,
    agentId: agent.id,
    poolAddress: decision.pool.toLowerCase(),
    entryValueUsdt: decision.amountUsdt,
    tokenId: tokenId?.toString() ?? null,
    tickLower: decision.tickLower,
    tickUpper: decision.tickUpper,
    txHashOpen: mintR.txHash ?? null,
    gaugeAddress: gauge,
    reasoning: `[TOPAZ OPEN_LP v3] ${decision.reasoning} :: stake=${stakeTx ?? 'none'}`.slice(0, 500),
  })
  return { execution: `open_v3_lp_ok:${mintR.txHash} stake=${stakeTx ?? 'none'}`, txHash: mintR.txHash ?? null, executed: true }
}

// ── CLOSE_LP: unstake → remove/burn → update row ───────────────────────
async function executeCloseLp(
  agent: TopazAgentRow,
  decision: TopazDecision,
  openRows: OpenPositionRow[],
): Promise<{ execution: string; txHash: string | null; executed: boolean }> {
  if (!decision.pool) return { execution: 'close_lp_missing_pool', txHash: null, executed: false }
  const target = openRows.find((r) => r.poolAddress.toLowerCase() === decision.pool!.toLowerCase())
  if (!target) return { execution: `close_lp_no_open_position:${decision.pool}`, txHash: null, executed: false }

  // 1) Unstake from gauge if we staked at open.
  let unstakeTx: string | null = null
  if (target.gaugeAddress) {
    if (target.positionType === 'v2-lp') {
      const amt = target.lpAmount ? BigInt(target.lpAmount) : 0n
      if (amt > 0n) {
        const u = await unstakeFromGauge({ gauge: target.gaugeAddress, kind: 'v2', lpAmount: amt })
        if (u.ok) unstakeTx = u.txHash ?? null
      }
    } else {
      const tid = target.tokenId ? BigInt(target.tokenId) : 0n
      if (tid > 0n) {
        const u = await unstakeFromGauge({ gauge: target.gaugeAddress, kind: 'v3', tokenId: tid })
        if (u.ok) unstakeTx = u.txHash ?? null
      }
    }
  }
  // Best-effort: claim any earned rewards on the way out.
  if (target.gaugeAddress) {
    try {
      await claimGaugeRewards({
        gauge: target.gaugeAddress,
        kind: target.positionType === 'v2-lp' ? 'v2' : 'v3',
        tokenId: target.tokenId ? BigInt(target.tokenId) : undefined,
      })
    } catch { /* ignore */ }
  }

  // 2) Remove or burn — real accounting via balance-delta snapshots.
  // Read token0/token1 balanceOf BEFORE and AFTER the close so we can
  // record true exit amounts (no placeholder = entryValueUsdt). If
  // either side matches a configured stable (TOPAZ_USDT_TOKEN /
  // TOPAZ_USDC_TOKEN), the stable leg's amount becomes the
  // exitValueUsdt anchor — multiplied by 2 for a balanced LP exit.
  const cfg = getTopazConfig()
  const { signer, address: master } = await getMasterSigner()
  const isStable = (addr: string): boolean => {
    const a = addr.toLowerCase()
    return (cfg.usdtToken?.toLowerCase() === a) || (cfg.usdcToken?.toLowerCase() === a)
  }
  let closeTx: string | null = null
  let exitAmt0: bigint = 0n, exitAmt1: bigint = 0n
  let token0Addr = target.tokenA ?? ''
  let token1Addr = target.tokenB ?? ''
  if (target.positionType === 'v2-lp') {
    const amt = target.lpAmount ? BigInt(target.lpAmount) : 0n
    if (amt <= 0n || !target.tokenA || !target.tokenB || target.stable === null) {
      return { execution: 'close_v2_missing_pair_info', txHash: unstakeTx, executed: false }
    }
    const tA = new ethers.Contract(target.tokenA, ERC20_ABI, signer)
    const tB = new ethers.Contract(target.tokenB, ERC20_ABI, signer)
    const bA = (await tA.balanceOf(master)) as bigint
    const bB = (await tB.balanceOf(master)) as bigint
    const rm = await removeV2Liquidity({
      tokenA: target.tokenA, tokenB: target.tokenB, stable: target.stable,
      liquidity: amt, amountAMin: 1n, amountBMin: 1n,
    })
    if (!rm.ok) return { execution: `close_v2_remove_failed:${rm.error}`, txHash: unstakeTx, executed: false }
    const aA = (await tA.balanceOf(master)) as bigint
    const aB = (await tB.balanceOf(master)) as bigint
    exitAmt0 = aA > bA ? aA - bA : 0n
    exitAmt1 = aB > bB ? aB - bB : 0n
    closeTx = rm.txHash ?? null
  } else {
    if (!target.tokenId) return { execution: 'close_v3_missing_token_id', txHash: unstakeTx, executed: false }
    // For v3 we need token0/token1 — resolve from the pool if missing.
    if (!token0Addr || !token1Addr) {
      try {
        const stats = await getPoolStats(target.poolAddress)
        token0Addr = stats.token0; token1Addr = stats.token1
      } catch { /* leave empty; balance reads below will skip */ }
    }
    let tA: ethers.Contract | null = null, tB: ethers.Contract | null = null
    let bA: bigint = 0n, bB: bigint = 0n
    if (token0Addr && token1Addr) {
      tA = new ethers.Contract(token0Addr, ERC20_ABI, signer)
      tB = new ethers.Contract(token1Addr, ERC20_ABI, signer)
      bA = (await tA.balanceOf(master)) as bigint
      bB = (await tB.balanceOf(master)) as bigint
    }
    const bn = await burnV3Position(BigInt(target.tokenId))
    if (!bn.ok) return { execution: `close_v3_burn_failed:${bn.error}`, txHash: unstakeTx, executed: false }
    if (tA && tB) {
      const aA = (await tA.balanceOf(master)) as bigint
      const aB = (await tB.balanceOf(master)) as bigint
      exitAmt0 = aA > bA ? aA - bA : 0n
      exitAmt1 = aB > bB ? aB - bB : 0n
    }
    closeTx = bn.txHash ?? null
  }

  // Compute exitValueUsdt: if one side is a known stable, that side's
  // amount (in human units, assuming 18 decimals) doubled approximates
  // total exit value for a balanced 50/50 LP. Otherwise NULL (no
  // fake pricing — reviewer flagged placeholder writes as blocking).
  let exitValueUsdt: number | null = null
  if (token0Addr && isStable(token0Addr) && exitAmt0 > 0n) {
    exitValueUsdt = Number(ethers.formatUnits(exitAmt0, 18)) * 2
  } else if (token1Addr && isStable(token1Addr) && exitAmt1 > 0n) {
    exitValueUsdt = Number(ethers.formatUnits(exitAmt1, 18)) * 2
  }

  await _closePositionRaw({
    id: target.id,
    exitAmt0: Number(ethers.formatUnits(exitAmt0, 18)),
    exitAmt1: Number(ethers.formatUnits(exitAmt1, 18)),
    exitValueUsdt,
    txHashClose: closeTx,
  })
  return { execution: `close_lp_ok:${closeTx} unstake=${unstakeTx ?? 'none'} exit0=${exitAmt0} exit1=${exitAmt1}`, txHash: closeTx, executed: true }
}

// ── CLAIM: iterate open positions, claim emissions per gauge ───────────
// Real accounting: read TOPAZ token balance BEFORE/AFTER each claim
// (delta is the actually-claimed emissions amount). No hardcoded
// placeholder writes — if cfg.topazToken is unset we record amt=0 but
// still mark the claim as executed (the claim tx itself succeeded;
// we just can't measure it without the token address).
async function executeClaim(
  agent: TopazAgentRow,
  openRows: OpenPositionRow[],
): Promise<{ execution: string; txHash: string | null; executed: boolean }> {
  if (openRows.length === 0) return { execution: 'claim_no_open_positions', txHash: null, executed: false }
  const cfg = getTopazConfig()
  const { signer, address } = await getMasterSigner()
  const topazCtr = cfg.topazToken ? new ethers.Contract(cfg.topazToken, ERC20_ABI, signer) : null

  const claimed: string[] = []
  let lastTx: string | null = null
  let any = false
  for (const row of openRows) {
    if (!row.gaugeAddress) continue
    try {
      const before = topazCtr ? (await topazCtr.balanceOf(address)) as bigint : 0n
      const r = await claimGaugeRewards({
        gauge: row.gaugeAddress,
        kind: row.positionType === 'v2-lp' ? 'v2' : 'v3',
        tokenId: row.tokenId ? BigInt(row.tokenId) : undefined,
      })
      if (r.ok) {
        any = true
        lastTx = r.txHash ?? lastTx
        const after = topazCtr ? (await topazCtr.balanceOf(address)) as bigint : 0n
        const delta = after > before ? after - before : 0n
        // Store actual delta as human-units (assume 18 decimals — matches
        // most ve(3,3) emission tokens). USD value left NULL (no oracle).
        const claimedHuman = Number(ethers.formatUnits(delta, 18))
        claimed.push(`${row.poolAddress.slice(0, 10)}…=${claimedHuman.toFixed(4)}`)
        await _incrementClaimedRaw(row.id, claimedHuman)
      }
    } catch { /* skip this one */ }
  }
  if (!any) return { execution: 'claim_nothing_to_claim', txHash: null, executed: false }
  return { execution: `claim_ok:${claimed.join(',')}`, txHash: lastTx, executed: true }
}

async function logTopazDecision(
  agent: TopazAgentRow,
  rawResponse: string | null,
  decision: TopazDecision,
  extras: { execution?: string; txHash?: string | null } = {},
) {
  try {
    const reasonParts: string[] = []
    if (extras.execution) reasonParts.push(extras.execution)
    reasonParts.push(`${decision.action} (conv ${decision.conviction.toFixed(2)})`)
    if (decision.pool) reasonParts.push(`pool=${decision.pool.slice(0, 10)}…`)
    reasonParts.push(decision.reasoning)
    await db.agentLog.create({
      data: {
        agentId:        agent.id,
        userId:         agent.userId,
        action:         `topaz_${decision.action.toLowerCase()}`,
        rawResponse:    rawResponse ? rawResponse.slice(0, 1000) : null,
        parsedAction:   decision.action,
        executionResult: extras.execution ?? null,
        error:          null,
        pair:           decision.pool ? decision.pool.slice(0, 80) : null,
        price:          null,
        reason:         reasonParts.join(' · ').slice(0, 500),
        adx:            null,
        rsi:            null,
        score:          Math.round(decision.conviction * 100),
        regime:         null,
        exchange:       'topaz',
      },
    })
  } catch (err) {
    console.warn('[topazAgent] logTopazDecision failed:', (err as Error).message)
  }
}

// Exposed for tests.
export const __test = { checkTopazRiskGuard }

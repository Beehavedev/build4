/**
 * Community Trading Fleet — service layer.
 *
 * The fleet is 50 community-owned autonomous four.meme trading agents,
 * organised into 5 strategy groups of 10. Unlike the singleton "house"
 * agent (one env-held wallet) or Telegram-user Agents (tied to a User row),
 * fleet agents are standalone: each has its own BSC wallet whose key is
 * encrypted with the agent's own id as the namespace, and they're operated
 * from a dedicated admin panel at /fleet.
 *
 * This module owns: the strategy catalog (params + names + candidate
 * filters), all `fleet_*` table access, and the gating/scoring helpers the
 * engine (src/agents/fleetAgent.ts) and seed script (scripts/seedFleet.ts)
 * share. It NEVER touches prisma/ — every table is raw-SQL (see
 * src/ensureTables.ts).
 */

import { db } from '../db'
import { encryptPrivateKey, decryptPrivateKey, generateEVMWallet } from './wallet'

export type FleetStrategy =
  | 'momentum'
  | 'dip'
  | 'trend'
  | 'snipe'
  | 'conservative'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface FleetAgent {
  id: string
  name: string
  strategy: FleetStrategy
  walletAddress: string
  encryptedPk: string
  riskLevel: RiskLevel
  maxTradeSizeBnb: number
  dailyTradeLimit: number
  cooldownSec: number
  jitterSec: number
  maxPositions: number
  minTrust: number
  takeProfitPct: number
  stopLossPct: number
  exitFillPct: number
  maxDailyLossBnb: number
  slippageBps: number
  watchlist: string[] | null
  status: 'active' | 'paused'
  assignedTo: string | null
  lastTickAt: Date | null
  createdAt: Date
}

export interface FleetSettings {
  liveTrading: boolean
  globalPaused: boolean
  updatedAt: Date
}

/** A scanner candidate row (subset of four_meme_launches_seen). */
export interface FleetCandidate {
  tokenAddress: string
  version: number | null
  fillPct: number
  fundsBnb: number
  buyerCount: number
  buyCount: number
  sellCount: number
  volumeBnb: number
  devHoldsPct: number
  trustScore: number
  graduated: boolean
  firstSeenAt: Date | null
}

// ── Strategy catalog ─────────────────────────────────────────────────────
// Each profile carries: human label, default risk level, and randomization
// ranges for the per-agent knobs (so 10 agents in a group are diversified,
// not identical), plus a candidate `filter` (hard gate) and `score`
// (higher = preferred). Ranges are [min, max] inclusive.

interface Range { min: number; max: number }

export interface StrategyProfile {
  key: FleetStrategy
  label: string
  description: string
  risk: RiskLevel
  names: string[]
  maxTradeSizeBnb: Range
  dailyTradeLimit: Range
  cooldownSec: Range
  jitterSec: Range
  maxPositions: Range
  minTrust: Range
  takeProfitPct: Range
  stopLossPct: Range
  exitFillPct: Range
  maxDailyLossBnb: number
  slippageBps: number
  filter: (c: FleetCandidate, a: FleetAgent) => boolean
  score: (c: FleetCandidate) => number
}

const num = (v: any): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const ageMinutes = (c: FleetCandidate): number => {
  if (!c.firstSeenAt) return 9_999
  return (Date.now() - c.firstSeenAt.getTime()) / 60_000
}

export const FLEET_STRATEGIES: Record<FleetStrategy, StrategyProfile> = {
  momentum: {
    key: 'momentum',
    label: 'Momentum',
    description: 'Buys curves with accelerating buy-pressure and rising volume.',
    risk: 'medium',
    names: ['Momentum Mako', 'Velocity Viper', 'Surge Sable', 'Thrust Tiger', 'Rally Raven', 'Kinetic Koi', 'Impulse Ibex', 'Breakout Bison', 'Uptrend Urchin', 'Charge Cheetah'],
    maxTradeSizeBnb: { min: 8, max: 15 },   // /1000 → 0.008..0.015
    dailyTradeLimit: { min: 8, max: 14 },
    cooldownSec: { min: 180, max: 420 },
    jitterSec: { min: 60, max: 120 },
    maxPositions: { min: 3, max: 5 },
    minTrust: { min: 60, max: 70 },
    takeProfitPct: { min: 60, max: 90 },
    stopLossPct: { min: 35, max: 45 },
    exitFillPct: { min: 88, max: 92 },
    maxDailyLossBnb: 0.04,
    slippageBps: 600,
    filter: (c) => !c.graduated && c.buyCount > c.sellCount && c.volumeBnb >= 0.1 && c.fillPct >= 0.1 && c.fillPct <= 0.8,
    score: (c) => c.volumeBnb * (1 + (c.buyCount - c.sellCount)) + c.trustScore / 100,
  },
  dip: {
    key: 'dip',
    label: 'Dip Buyer',
    description: 'Contrarian — buys quality curves showing temporary selling pressure.',
    risk: 'medium',
    names: ['Dip Dolphin', 'Rebound Raccoon', 'Bargain Badger', 'Valley Vulture', 'Bounce Bear', 'Discount Dingo', 'Pullback Puma', 'Trough Toad', 'Reversal Ram', 'Bedrock Bat'],
    maxTradeSizeBnb: { min: 8, max: 15 },
    dailyTradeLimit: { min: 6, max: 10 },
    cooldownSec: { min: 300, max: 600 },
    jitterSec: { min: 90, max: 180 },
    maxPositions: { min: 2, max: 4 },
    minTrust: { min: 55, max: 65 },
    takeProfitPct: { min: 40, max: 60 },
    stopLossPct: { min: 30, max: 40 },
    exitFillPct: { min: 85, max: 92 },
    maxDailyLossBnb: 0.03,
    slippageBps: 600,
    filter: (c) => !c.graduated && c.sellCount >= c.buyCount * 0.6 && c.fundsBnb > 0 && c.fillPct >= 0.05 && c.fillPct <= 0.7,
    score: (c) => c.trustScore + c.fundsBnb,
  },
  trend: {
    key: 'trend',
    label: 'Trend Scanner',
    description: 'Broad scanner — spreads many small bets across trending curves.',
    risk: 'low',
    names: ['Trend Tortoise', 'Drift Dragon', 'Current Crane', 'Vector Vole', 'Flow Falcon', 'Slope Stag', 'Compass Crab', 'Radar Rhino', 'Sweep Swan', 'Scout Skunk'],
    maxTradeSizeBnb: { min: 5, max: 10 },
    dailyTradeLimit: { min: 10, max: 18 },
    cooldownSec: { min: 120, max: 300 },
    jitterSec: { min: 45, max: 90 },
    maxPositions: { min: 4, max: 6 },
    minTrust: { min: 58, max: 66 },
    takeProfitPct: { min: 45, max: 70 },
    stopLossPct: { min: 35, max: 45 },
    exitFillPct: { min: 86, max: 92 },
    maxDailyLossBnb: 0.04,
    slippageBps: 500,
    filter: (c) => !c.graduated && c.volumeBnb >= 0.05 && c.buyerCount >= 3 && c.fillPct <= 0.85,
    score: (c) => c.volumeBnb + c.buyerCount / 10,
  },
  snipe: {
    key: 'snipe',
    label: 'New-Launch Sniper',
    description: 'Enters the youngest, highest-trust curves at low fill.',
    risk: 'high',
    names: ['Snipe Sparrow', 'Launch Lynx', 'Fresh Falcon', 'Genesis Gecko', 'Dawn Dingo', 'Primer Panther', 'Ignition Iguana', 'Liftoff Lemur', 'Zero Zebra', 'Origin Owl'],
    maxTradeSizeBnb: { min: 10, max: 20 },
    dailyTradeLimit: { min: 8, max: 14 },
    cooldownSec: { min: 90, max: 240 },
    jitterSec: { min: 30, max: 75 },
    maxPositions: { min: 3, max: 5 },
    minTrust: { min: 68, max: 80 },
    takeProfitPct: { min: 70, max: 120 },
    stopLossPct: { min: 40, max: 50 },
    exitFillPct: { min: 80, max: 90 },
    maxDailyLossBnb: 0.05,
    slippageBps: 800,
    filter: (c) => !c.graduated && c.fillPct < 0.35 && ageMinutes(c) <= 60,
    score: (c) => c.trustScore - c.fillPct * 100,
  },
  conservative: {
    key: 'conservative',
    label: 'Conservative Volume',
    description: 'Small sizes, highest-trust only, low dev concentration.',
    risk: 'low',
    names: ['Steady Stork', 'Guardian Gull', 'Prudent Pangolin', 'Anchor Antelope', 'Ballast Boar', 'Caution Crow', 'Bastion Buffalo', 'Sentinel Seal', 'Warden Walrus', 'Keeper Kestrel'],
    maxTradeSizeBnb: { min: 3, max: 7 },
    dailyTradeLimit: { min: 4, max: 8 },
    cooldownSec: { min: 600, max: 1200 },
    jitterSec: { min: 120, max: 240 },
    maxPositions: { min: 1, max: 3 },
    minTrust: { min: 72, max: 85 },
    takeProfitPct: { min: 35, max: 50 },
    stopLossPct: { min: 25, max: 35 },
    exitFillPct: { min: 90, max: 95 },
    maxDailyLossBnb: 0.02,
    slippageBps: 400,
    filter: (c) => !c.graduated && c.fillPct >= 0.05 && c.fillPct <= 0.6 && c.devHoldsPct <= 5,
    score: (c) => c.trustScore,
  },
}

export const FLEET_STRATEGY_KEYS = Object.keys(FLEET_STRATEGIES) as FleetStrategy[]

// ── Row mapping ──────────────────────────────────────────────────────────

function rowToAgent(r: any): FleetAgent {
  let watchlist: string[] | null = null
  if (r.watchlist) {
    try {
      const parsed = JSON.parse(r.watchlist)
      if (Array.isArray(parsed) && parsed.length > 0) watchlist = parsed.map(String)
    } catch { /* malformed → treat as no watchlist */ }
  }
  return {
    id: r.id,
    name: r.name,
    strategy: r.strategy as FleetStrategy,
    walletAddress: r.wallet_address,
    encryptedPk: r.encrypted_pk,
    riskLevel: (r.risk_level ?? 'medium') as RiskLevel,
    maxTradeSizeBnb: num(r.max_trade_size_bnb),
    dailyTradeLimit: num(r.daily_trade_limit),
    cooldownSec: num(r.cooldown_sec),
    jitterSec: num(r.jitter_sec),
    maxPositions: num(r.max_positions),
    minTrust: num(r.min_trust),
    takeProfitPct: num(r.take_profit_pct),
    stopLossPct: num(r.stop_loss_pct),
    exitFillPct: num(r.exit_fill_pct),
    maxDailyLossBnb: num(r.max_daily_loss_bnb),
    slippageBps: num(r.slippage_bps),
    watchlist,
    status: (r.status === 'active' ? 'active' : 'paused'),
    assignedTo: r.assigned_to ?? null,
    lastTickAt: r.last_tick_at ? new Date(r.last_tick_at) : null,
    createdAt: new Date(r.created_at),
  }
}

// ── Settings ─────────────────────────────────────────────────────────────

/**
 * Environment-level kill switch for live fleet trading.
 *
 * Defense in depth alongside the DB `fleet_settings.live_trading` flag and
 * `FOUR_MEME_ENABLED`. Real BNB only moves when ALL THREE are on:
 *   • FLEET_LIVE_TRADING=true   (this env gate — set in prod only)
 *   • FOUR_MEME_ENABLED=true    (four.meme master switch)
 *   • fleet_settings.live_trading = true (per-deployment DB toggle via /fleet)
 *
 * The env gate is deliberately absent in dev (no MASTER_ENCRYPTION_KEY there
 * either), so flipping the DB toggle in a non-prod environment can never send
 * a transaction — the OPEN sweep silently falls back to mock mode.
 */
export function isFleetLiveTradingEnabled(): boolean {
  return process.env.FLEET_LIVE_TRADING === 'true'
}

export async function getFleetSettings(): Promise<FleetSettings> {
  const rows = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_settings" WHERE id = 'singleton'`)
  if (rows.length === 0) {
    await db.$executeRawUnsafe(`INSERT INTO "fleet_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING`)
    return { liveTrading: false, globalPaused: true, updatedAt: new Date() }
  }
  const r = rows[0]
  return {
    liveTrading: !!r.live_trading,
    globalPaused: !!r.global_paused,
    updatedAt: new Date(r.updated_at),
  }
}

export async function setFleetSettings(patch: { liveTrading?: boolean; globalPaused?: boolean }): Promise<FleetSettings> {
  const cur = await getFleetSettings()
  const next = {
    liveTrading: typeof patch.liveTrading === 'boolean' ? patch.liveTrading : cur.liveTrading,
    globalPaused: typeof patch.globalPaused === 'boolean' ? patch.globalPaused : cur.globalPaused,
  }
  await db.$executeRawUnsafe(
    `UPDATE "fleet_settings" SET "live_trading" = $1, "global_paused" = $2, "updated_at" = NOW() WHERE id = 'singleton'`,
    next.liveTrading, next.globalPaused,
  )
  return getFleetSettings()
}

// ── Low-balance alert acks ───────────────────────────────────────────────
// The low-BNB watcher dedupes alerts in-memory, but that state is wiped on
// every redeploy so a chronically-low wallet re-alerts after each restart.
// A persisted ack row silences a known-low agent until its wallet refills
// above threshold; the watcher deletes the row on recovery (auto-clear) so a
// later re-drain alerts again.

/** Agent IDs an admin has acked as known-low (alerts suppressed). */
export async function getLowBalanceAckedIds(): Promise<Set<string>> {
  const rows = await db.$queryRawUnsafe<any[]>(`SELECT "agent_id" FROM "fleet_low_balance_acks"`)
  return new Set(rows.map((r) => String(r.agent_id)))
}

/** Persist an ack so this agent stops re-alerting across restarts. Idempotent. */
export async function ackFleetLowBalance(agentId: string, ackedBy?: string | null): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "fleet_low_balance_acks" ("agent_id", "acked_by") VALUES ($1, $2)
       ON CONFLICT ("agent_id") DO UPDATE SET "acked_by" = EXCLUDED."acked_by", "acked_at" = NOW()`,
    agentId, ackedBy ?? null,
  )
}

/** Clear an ack (on recovery or manual un-ack). Idempotent. */
export async function clearFleetLowBalanceAck(agentId: string): Promise<void> {
  await db.$executeRawUnsafe(`DELETE FROM "fleet_low_balance_acks" WHERE "agent_id" = $1`, agentId)
}

// ── Agents CRUD ──────────────────────────────────────────────────────────

export async function listFleetAgents(): Promise<FleetAgent[]> {
  const rows = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_agents" ORDER BY "strategy", "name"`)
  return rows.map(rowToAgent)
}

export async function getFleetAgent(id: string): Promise<FleetAgent | null> {
  const rows = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_agents" WHERE id = $1`, id)
  return rows.length ? rowToAgent(rows[0]) : null
}

export async function countFleetAgents(): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "fleet_agents"`)
  return Number(rows[0]?.n ?? 0)
}

export interface CreateFleetAgentInput {
  name: string
  strategy: FleetStrategy
  riskLevel: RiskLevel
  maxTradeSizeBnb: number
  dailyTradeLimit: number
  cooldownSec: number
  jitterSec: number
  maxPositions: number
  minTrust: number
  takeProfitPct: number
  stopLossPct: number
  exitFillPct: number
  maxDailyLossBnb: number
  slippageBps: number
  watchlist?: string[] | null
  assignedTo?: string | null
}

/**
 * Generate a fresh BSC wallet, encrypt the key under the new agent's id,
 * and insert a paused fleet agent. Returns the created agent (incl. the
 * fundable wallet address). Idempotent on `name` via ON CONFLICT DO NOTHING
 * — re-running the seed won't create duplicates or burn fresh wallets.
 */
export async function createFleetAgent(input: CreateFleetAgentInput): Promise<{ created: boolean; agent: FleetAgent | null }> {
  const id = `fleet_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  const wallet = generateEVMWallet()
  const encrypted = encryptPrivateKey(wallet.privateKey, id)
  const watchlistJson = input.watchlist && input.watchlist.length > 0 ? JSON.stringify(input.watchlist) : null

  const res = await db.$executeRawUnsafe(
    `INSERT INTO "fleet_agents" (
       "id","name","strategy","wallet_address","encrypted_pk","risk_level",
       "max_trade_size_bnb","daily_trade_limit","cooldown_sec","jitter_sec",
       "max_positions","min_trust","take_profit_pct","stop_loss_pct","exit_fill_pct",
       "max_daily_loss_bnb","slippage_bps","watchlist","status","assigned_to"
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'paused',$19
     ) ON CONFLICT ("name") DO NOTHING`,
    id, input.name, input.strategy, wallet.address, encrypted, input.riskLevel,
    input.maxTradeSizeBnb, input.dailyTradeLimit, input.cooldownSec, input.jitterSec,
    input.maxPositions, input.minTrust, input.takeProfitPct, input.stopLossPct, input.exitFillPct,
    input.maxDailyLossBnb, input.slippageBps, watchlistJson, input.assignedTo ?? null,
  )
  if (Number(res) === 0) {
    // Name already existed — return existing row, do NOT leak the fresh wallet.
    const rows = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_agents" WHERE name = $1`, input.name)
    return { created: false, agent: rows.length ? rowToAgent(rows[0]) : null }
  }
  return { created: true, agent: await getFleetAgent(id) }
}

/** Decrypt a fleet agent's private key (key namespace = agent id). */
export function decryptFleetAgentKey(agent: FleetAgent): string {
  return decryptPrivateKey(agent.encryptedPk, agent.id)
}

export async function setFleetAgentStatus(id: string, status: 'active' | 'paused'): Promise<void> {
  await db.$executeRawUnsafe(`UPDATE "fleet_agents" SET "status" = $1 WHERE id = $2`, status, id)
}

export async function setAllFleetStatus(status: 'active' | 'paused'): Promise<number> {
  const res = await db.$executeRawUnsafe(`UPDATE "fleet_agents" SET "status" = $1`, status)
  return Number(res)
}

/** Allow-listed per-agent config updates from the panel. */
const AGENT_PATCH_VALIDATORS: Record<string, (v: any) => any | undefined> = {
  maxTradeSizeBnb: (v) => (typeof v === 'number' && v > 0 && v <= 0.5) ? v : undefined,
  dailyTradeLimit: (v) => (Number.isInteger(v) && v >= 0 && v <= 200) ? v : undefined,
  cooldownSec: (v) => (Number.isInteger(v) && v >= 30 && v <= 86400) ? v : undefined,
  jitterSec: (v) => (Number.isInteger(v) && v >= 0 && v <= 3600) ? v : undefined,
  maxPositions: (v) => (Number.isInteger(v) && v >= 0 && v <= 20) ? v : undefined,
  minTrust: (v) => (Number.isInteger(v) && v >= 0 && v <= 100) ? v : undefined,
  takeProfitPct: (v) => (Number.isInteger(v) && v >= 1 && v <= 1000) ? v : undefined,
  stopLossPct: (v) => (Number.isInteger(v) && v >= 1 && v <= 99) ? v : undefined,
  exitFillPct: (v) => (Number.isInteger(v) && v >= 1 && v <= 99) ? v : undefined,
  maxDailyLossBnb: (v) => (typeof v === 'number' && v > 0 && v <= 5) ? v : undefined,
  slippageBps: (v) => (Number.isInteger(v) && v >= 1 && v <= 2000) ? v : undefined,
  assignedTo: (v) => (v === null || (typeof v === 'string' && v.length <= 100)) ? v : undefined,
  riskLevel: (v) => (['low', 'medium', 'high'].includes(v)) ? v : undefined,
}

const PATCH_COLUMN: Record<string, string> = {
  maxTradeSizeBnb: 'max_trade_size_bnb',
  dailyTradeLimit: 'daily_trade_limit',
  cooldownSec: 'cooldown_sec',
  jitterSec: 'jitter_sec',
  maxPositions: 'max_positions',
  minTrust: 'min_trust',
  takeProfitPct: 'take_profit_pct',
  stopLossPct: 'stop_loss_pct',
  exitFillPct: 'exit_fill_pct',
  maxDailyLossBnb: 'max_daily_loss_bnb',
  slippageBps: 'slippage_bps',
  assignedTo: 'assigned_to',
  riskLevel: 'risk_level',
}

export async function updateFleetAgent(id: string, patch: Record<string, any>): Promise<FleetAgent | null> {
  const sets: string[] = []
  const vals: any[] = []
  let i = 1
  for (const [k, validate] of Object.entries(AGENT_PATCH_VALIDATORS)) {
    if (k in patch) {
      const cleaned = validate(patch[k])
      if (cleaned !== undefined) {
        sets.push(`"${PATCH_COLUMN[k]}" = $${i++}`)
        vals.push(cleaned)
      }
    }
  }
  if (sets.length === 0) return getFleetAgent(id)
  vals.push(id)
  await db.$executeRawUnsafe(`UPDATE "fleet_agents" SET ${sets.join(', ')} WHERE id = $${i}`, ...vals)
  return getFleetAgent(id)
}

export async function markFleetTick(id: string): Promise<void> {
  await db.$executeRawUnsafe(`UPDATE "fleet_agents" SET "last_tick_at" = NOW() WHERE id = $1`, id)
}

// ── Logs ─────────────────────────────────────────────────────────────────

export async function logFleet(agentId: string | null, level: 'info' | 'trade' | 'error', message: string, meta?: Record<string, any>): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "fleet_logs" ("agent_id","level","message","meta") VALUES ($1,$2,$3,$4)`,
      agentId, level, message.slice(0, 1000), meta ? JSON.stringify(meta) : null,
    )
  } catch (err) {
    console.warn('[fleet] log write failed:', (err as Error).message)
  }
}

// ── Engine helpers (daily stats, open counts, candidates) ────────────────

/** Per-agent today's buy count + realized PnL (from filled trades). */
export async function getTodayStats(): Promise<Map<string, { buys: number; pnl: number }>> {
  const rows = await db.$queryRawUnsafe<Array<{ agent_id: string; buys: bigint; pnl: number | null }>>(
    `SELECT "agent_id",
            COUNT(*) FILTER (WHERE "side" = 'buy' AND "status" = 'filled')::bigint AS buys,
            COALESCE(SUM("pnl_bnb"), 0) AS pnl
       FROM "fleet_trades"
      WHERE "created_at" >= date_trunc('day', NOW())
      GROUP BY "agent_id"`,
  )
  const m = new Map<string, { buys: number; pnl: number }>()
  for (const r of rows) m.set(r.agent_id, { buys: Number(r.buys), pnl: num(r.pnl) })
  return m
}

/** Per-agent count of open positions. */
export async function getOpenPositionCounts(): Promise<Map<string, number>> {
  const rows = await db.$queryRawUnsafe<Array<{ agent_id: string; n: bigint }>>(
    `SELECT "agent_id", COUNT(*)::bigint AS n FROM "fleet_positions" WHERE "status" = 'open' GROUP BY "agent_id"`,
  )
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.agent_id, Number(r.n))
  return m
}

/** Tokens an agent already holds an open position in (lowercased). */
export async function getOpenTokensByAgent(): Promise<Map<string, Set<string>>> {
  const rows = await db.$queryRawUnsafe<Array<{ agent_id: string; token_address: string }>>(
    `SELECT "agent_id", "token_address" FROM "fleet_positions" WHERE "status" = 'open'`,
  )
  const m = new Map<string, Set<string>>()
  for (const r of rows) {
    const set = m.get(r.agent_id) ?? new Set<string>()
    set.add(r.token_address.toLowerCase())
    m.set(r.agent_id, set)
  }
  return m
}

/** Read buyable scanner candidates (verdict='buy'), newest-trust first. */
export async function getFleetCandidates(limit = 80): Promise<FleetCandidate[]> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT "token_address","version","fill_pct","funds_bnb","buyer_count",
            "buy_count","sell_count","volume_bnb","dev_holds_pct","trust_score",
            "graduated","first_seen_at"
       FROM "four_meme_launches_seen"
      WHERE "verdict" = 'buy'
        AND COALESCE("graduated", false) = false
        AND "trust_score" IS NOT NULL
      ORDER BY "trust_score" DESC, "first_seen_at" DESC
      LIMIT $1`,
    limit,
  )
  return rows.map((r) => ({
    tokenAddress: r.token_address,
    version: r.version != null ? Number(r.version) : null,
    fillPct: num(r.fill_pct),
    fundsBnb: num(r.funds_bnb),
    buyerCount: num(r.buyer_count),
    buyCount: num(r.buy_count),
    sellCount: num(r.sell_count),
    volumeBnb: num(r.volume_bnb),
    devHoldsPct: num(r.dev_holds_pct),
    trustScore: num(r.trust_score),
    graduated: !!r.graduated,
    firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at) : null,
  }))
}

/**
 * Is this agent eligible to OPEN a new position this tick? Pure gate — does
 * not consult candidates. Returns a skip reason string, or null if clear.
 */
export function agentOpenGate(
  agent: FleetAgent,
  stats: { buys: number; pnl: number } | undefined,
  openCount: number,
): string | null {
  if (agent.status !== 'active') return 'paused'
  // Cooldown (with deterministic per-agent jitter folded in).
  if (agent.lastTickAt) {
    const jitter = agent.jitterSec > 0 ? Math.floor(Math.random() * agent.jitterSec) : 0
    const elapsed = (Date.now() - agent.lastTickAt.getTime()) / 1000
    if (elapsed < agent.cooldownSec + jitter) return 'cooldown'
  }
  if (openCount >= agent.maxPositions) return 'max_positions'
  if (stats && stats.buys >= agent.dailyTradeLimit) return 'daily_limit'
  if (stats && stats.pnl <= -agent.maxDailyLossBnb) return 'daily_loss_breaker'
  return null
}

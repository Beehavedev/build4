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
  swarmEnabled: boolean
  lastTickAt: Date | null
  createdAt: Date
}

export interface FleetSettings {
  liveTrading: boolean
  globalPaused: boolean
  /** Single-LLM the /fleet panel selected for the brain (overrides the
   *  FLEET_SWARM_PROVIDERS env allowlist). null = use the env default. */
  swarmProvider: string | null
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
    swarmEnabled: !!r.swarm_enabled,
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
    return { liveTrading: false, globalPaused: true, swarmProvider: null, updatedAt: new Date() }
  }
  const r = rows[0]
  return {
    liveTrading: !!r.live_trading,
    globalPaused: !!r.global_paused,
    swarmProvider: r.swarm_provider ?? null,
    updatedAt: new Date(r.updated_at),
  }
}

export async function setFleetSettings(patch: { liveTrading?: boolean; globalPaused?: boolean; swarmProvider?: string | null }): Promise<FleetSettings> {
  const cur = await getFleetSettings()
  const next = {
    liveTrading: typeof patch.liveTrading === 'boolean' ? patch.liveTrading : cur.liveTrading,
    globalPaused: typeof patch.globalPaused === 'boolean' ? patch.globalPaused : cur.globalPaused,
    swarmProvider: patch.swarmProvider !== undefined ? patch.swarmProvider : cur.swarmProvider,
  }
  await db.$executeRawUnsafe(
    `UPDATE "fleet_settings" SET "live_trading" = $1, "global_paused" = $2, "swarm_provider" = $3, "updated_at" = NOW() WHERE id = 'singleton'`,
    next.liveTrading, next.globalPaused, next.swarmProvider,
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

// ── Bulk seed / single-create / delete (shared by panel + seed script) ────

function fleetRandInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Build a randomized CreateFleetAgentInput for one agent of `strategy` with a
 * given themed `name`. Knobs are randomized within the strategy's ranges so the
 * agents in a group are diversified, not clones. (maxTradeSizeBnb ranges are
 * stored ×1000 as integers in the profile, so divide back to BNB.)
 */
function buildFleetAgentInput(strategy: FleetStrategy, name: string): CreateFleetAgentInput {
  const profile = FLEET_STRATEGIES[strategy]
  return {
    name,
    strategy,
    riskLevel: profile.risk,
    maxTradeSizeBnb: fleetRandInt(profile.maxTradeSizeBnb.min, profile.maxTradeSizeBnb.max) / 1000,
    dailyTradeLimit: fleetRandInt(profile.dailyTradeLimit.min, profile.dailyTradeLimit.max),
    cooldownSec: fleetRandInt(profile.cooldownSec.min, profile.cooldownSec.max),
    jitterSec: fleetRandInt(profile.jitterSec.min, profile.jitterSec.max),
    maxPositions: fleetRandInt(profile.maxPositions.min, profile.maxPositions.max),
    minTrust: fleetRandInt(profile.minTrust.min, profile.minTrust.max),
    takeProfitPct: fleetRandInt(profile.takeProfitPct.min, profile.takeProfitPct.max),
    stopLossPct: fleetRandInt(profile.stopLossPct.min, profile.stopLossPct.max),
    exitFillPct: fleetRandInt(profile.exitFillPct.min, profile.exitFillPct.max),
    maxDailyLossBnb: profile.maxDailyLossBnb,
    slippageBps: profile.slippageBps,
    watchlist: null,
    assignedTo: null,
  }
}

/**
 * Seed the whole fleet — up to 50 agents (5 strategies × 10 themed names).
 * Idempotent: createFleetAgent() does ON CONFLICT (name) DO NOTHING, so
 * re-running never duplicates or burns a fresh wallet for an already-seeded
 * name. Shared by scripts/seedFleet.ts and the /fleet panel "Seed" button.
 * Requires MASTER_ENCRYPTION_KEY (wallet encryption is fail-closed).
 */
export async function seedFleetAgents(): Promise<{ created: number; skipped: number }> {
  // Pre-fetch existing names so reruns skip already-seeded agents WITHOUT
  // generating/encrypting a throwaway wallet for each (createFleetAgent mints a
  // fresh wallet in memory before its ON CONFLICT insert would discard it). The
  // ON CONFLICT (name) DO NOTHING inside createFleetAgent remains the race
  // safety-net; this set just avoids the wasted keygen on the common rerun path.
  const existingRows = await db.$queryRawUnsafe<Array<{ name: string }>>(`SELECT "name" FROM "fleet_agents"`)
  const taken = new Set(existingRows.map((r) => r.name))
  let created = 0
  let skipped = 0
  for (const key of FLEET_STRATEGY_KEYS) {
    const profile = FLEET_STRATEGIES[key]
    if (profile.names.length !== 10) {
      throw new Error(`Strategy ${key} must define exactly 10 names (has ${profile.names.length})`)
    }
    for (const name of profile.names) {
      if (taken.has(name)) {
        skipped += 1
        continue
      }
      const res = await createFleetAgent(buildFleetAgentInput(key, name))
      if (res.created) {
        created += 1
        taken.add(name)
      } else {
        skipped += 1
      }
    }
  }
  return { created, skipped }
}

/**
 * Create ONE agent in `strategy`, auto-assigning the next unused themed name
 * from that strategy's pool. reason='pool_exhausted' when all 10 names in the
 * group are already taken.
 */
export async function createNextFleetAgent(
  strategy: FleetStrategy,
): Promise<{ created: boolean; agent: FleetAgent | null; reason?: string }> {
  const profile = FLEET_STRATEGIES[strategy]
  if (!profile) return { created: false, agent: null, reason: 'unknown_strategy' }
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT "name" FROM "fleet_agents" WHERE "strategy" = $1`,
    strategy,
  )
  const taken = new Set(rows.map((r) => r.name))
  const free = profile.names.find((n) => !taken.has(n))
  if (!free) return { created: false, agent: null, reason: 'pool_exhausted' }
  const res = await createFleetAgent(buildFleetAgentInput(strategy, free))
  if (!res.created) return { created: false, agent: res.agent, reason: 'name_conflict' }
  return { created: true, agent: res.agent }
}

/**
 * Hard-delete a fleet agent (its encrypted wallet key goes with it). Returns
 * true if a row was removed. The caller MUST enforce funds/position safety —
 * this is unconditional. The fleet_* child tables carry no FK to fleet_agents,
 * so child rows are cleaned up explicitly to avoid orphaned trades/positions/logs.
 */
export async function deleteFleetAgent(id: string): Promise<boolean> {
  await db.$executeRawUnsafe(`DELETE FROM "fleet_low_balance_acks" WHERE "agent_id" = $1`, id)
  await db.$executeRawUnsafe(`DELETE FROM "fleet_logs" WHERE "agent_id" = $1`, id)
  await db.$executeRawUnsafe(`DELETE FROM "fleet_trades" WHERE "agent_id" = $1`, id)
  await db.$executeRawUnsafe(`DELETE FROM "fleet_positions" WHERE "agent_id" = $1`, id)
  const res = await db.$executeRawUnsafe(`DELETE FROM "fleet_agents" WHERE id = $1`, id)
  return Number(res) > 0
}

/** Decrypt a fleet agent's private key (key namespace = agent id). */
export function decryptFleetAgentKey(agent: FleetAgent): string {
  return decryptPrivateKey(agent.encryptedPk, agent.id)
}

// ── Bulk key export + balance sweep (admin recovery tools) ───────────────
// These operate on REAL wallets regardless of the live/mock trading gate:
// they don't trade, they recover funds/keys. Both need MASTER_ENCRYPTION_KEY
// (decrypt is fail-closed) and are only ever reachable via requireAdmin routes.

export interface FleetKeyExportRow {
  id: string
  name: string
  strategy: FleetStrategy
  walletAddress: string
  privateKey: string
  error?: string
}

/**
 * Decrypt every fleet agent's private key for a one-file export. Per-agent
 * try/catch so a single un-decryptable row (e.g. a key written under a
 * different MASTER_ENCRYPTION_KEY) doesn't abort the whole export — that row
 * carries an `error` and an empty privateKey instead.
 */
export async function exportFleetKeys(): Promise<FleetKeyExportRow[]> {
  const agents = await listFleetAgents()
  return agents.map((a) => {
    try {
      return { id: a.id, name: a.name, strategy: a.strategy, walletAddress: a.walletAddress, privateKey: decryptFleetAgentKey(a) }
    } catch (e) {
      return { id: a.id, name: a.name, strategy: a.strategy, walletAddress: a.walletAddress, privateKey: '', error: (e as Error).message }
    }
  })
}

// ── Full-fidelity backup / restore ───────────────────────────────────────
// exportFleetBackup round-trips EVERY column needed to recreate an agent
// byte-identically — crucially the agent `id` (the key namespace) and the
// decrypted private_key. importFleetBackup re-inserts those rows, re-encrypting
// each key under its original id with THIS environment's master key. That means
// a backup is portable only back into the SAME bot (same WALLET_ENCRYPTION_KEY);
// importing elsewhere would store keys the trading bot can't decrypt → stranded
// funds. A backup is a point-in-time SNAPSHOT: it captures agents + wallets +
// config, NOT positions/trades/PnL accrued after the export.

export interface FleetBackupRow {
  id: string
  name: string
  strategy: FleetStrategy
  walletAddress: string
  privateKey: string
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
  watchlist: string
  status: 'active' | 'paused'
  assignedTo: string
  swarmEnabled: boolean
  error?: string
}

/** Column order for the backup CSV — also the accepted import header. */
export const FLEET_BACKUP_COLUMNS: Array<keyof FleetBackupRow> = [
  'id', 'name', 'strategy', 'walletAddress', 'privateKey', 'riskLevel',
  'maxTradeSizeBnb', 'dailyTradeLimit', 'cooldownSec', 'jitterSec',
  'maxPositions', 'minTrust', 'takeProfitPct', 'stopLossPct', 'exitFillPct',
  'maxDailyLossBnb', 'slippageBps', 'watchlist', 'status', 'assignedTo',
  'swarmEnabled', 'error',
]

/**
 * Snapshot every fleet agent into a restorable backup. Per-agent try/catch so a
 * single un-decryptable row (key written under a different master key) carries
 * an `error` + empty privateKey instead of aborting the whole backup.
 */
export async function exportFleetBackup(): Promise<FleetBackupRow[]> {
  const agents = await listFleetAgents()
  return agents.map((a) => {
    const base = {
      id: a.id,
      name: a.name,
      strategy: a.strategy,
      walletAddress: a.walletAddress,
      riskLevel: a.riskLevel,
      maxTradeSizeBnb: a.maxTradeSizeBnb,
      dailyTradeLimit: a.dailyTradeLimit,
      cooldownSec: a.cooldownSec,
      jitterSec: a.jitterSec,
      maxPositions: a.maxPositions,
      minTrust: a.minTrust,
      takeProfitPct: a.takeProfitPct,
      stopLossPct: a.stopLossPct,
      exitFillPct: a.exitFillPct,
      maxDailyLossBnb: a.maxDailyLossBnb,
      slippageBps: a.slippageBps,
      watchlist: a.watchlist && a.watchlist.length > 0 ? JSON.stringify(a.watchlist) : '',
      status: a.status,
      assignedTo: a.assignedTo ?? '',
      swarmEnabled: a.swarmEnabled,
    }
    try {
      return { ...base, privateKey: decryptFleetAgentKey(a) }
    } catch (e) {
      return { ...base, privateKey: '', error: (e as Error).message }
    }
  })
}

/**
 * Serialize backup rows into the canonical CSV (header + formula-injection-
 * escaped body + trailing newline). Single source of truth shared by the
 * /api/admin/fleet/backup endpoint and the scheduled auto-snapshot so both
 * files are byte-identical and round-trip through importFleetBackup unchanged.
 */
export function serializeFleetBackupCsv(rows: FleetBackupRow[]): string {
  const csvEsc = (s: string) => {
    let v = s
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
  }
  const cols = FLEET_BACKUP_COLUMNS
  const header = cols.join(',')
  const body = rows
    .map((r) => cols.map((c) => csvEsc(String((r as any)[c] ?? ''))).join(','))
    .join('\n')
  return header + '\n' + body + '\n'
}

/**
 * Parse a backup CSV (as produced by serializeFleetBackupCsv) into header→value
 * maps for importFleetBackup. Quote-aware (RFC-4180 doubled quotes), strips a
 * UTF-8 BOM off the first header cell (Excel adds one), skips blank trailing
 * lines, and reverses the spreadsheet formula-injection guard (a leading
 * apostrophe) ONLY when it actually guards a formula-trigger char (=,+,-,@,tab,
 * CR) — so a legitimate value beginning with ' is left intact. Returns [] when
 * the CSV has no data rows. Lives here (not inline in the route) so the parse is
 * the single source of truth and unit-testable alongside the serializer.
 */
export function parseFleetBackupCsv(csv: string): Array<Record<string, string>> {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else { field += c }
      continue
    }
    if (c === '"') { inQuotes = true; continue }
    if (c === ',') { record.push(field); field = ''; continue }
    if (c === '\r') { continue }
    if (c === '\n') { record.push(field); records.push(record); field = ''; record = []; continue }
    field += c
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record) }
  if (records.length < 2) return []
  // Strip a UTF-8 BOM off the first header cell so "id" matches (not "\uFEFFid").
  if (records[0].length > 0) records[0][0] = records[0][0].replace(/^\uFEFF/, '')
  const header = records[0].map((h) => h.trim())
  const rows: Array<Record<string, string>> = []
  for (let r = 1; r < records.length; r++) {
    const rec = records[r]
    if (rec.length === 1 && rec[0].trim() === '') continue
    const obj: Record<string, string> = {}
    header.forEach((h, idx) => {
      let v = rec[idx] ?? ''
      if (v.length > 1 && v[0] === "'" && /^[=+\-@\t\r]/.test(v[1])) v = v.slice(1)
      obj[h] = v
    })
    rows.push(obj)
  }
  return rows
}

/**
 * Timestamp of the most recent successful auto-snapshot (parsed from fleet_logs),
 * or null if none has run. Used by the runner's boot catch-up to decide whether a
 * daily snapshot was missed across a redeploy. Best-effort: returns null on error.
 */
export async function lastAutoSnapshotAt(): Promise<Date | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ created_at: Date }>>(
      `SELECT "created_at" FROM "fleet_logs" WHERE "agent_id" IS NULL AND "message" LIKE 'auto-snapshot sent%' ORDER BY "created_at" DESC LIMIT 1`,
    )
    return rows.length > 0 ? new Date(rows[0].created_at) : null
  } catch {
    return null
  }
}

export interface FleetImportResult {
  total: number
  restored: number
  skippedExisting: number
  failed: number
  errors: Array<{ name: string; error: string }>
}

// Table defaults — fall-backs for any numeric column missing/garbled in a
// hand-edited backup (our own export always populates them).
const FLEET_DEFAULTS = {
  maxTradeSizeBnb: 0.01, dailyTradeLimit: 10, cooldownSec: 300, jitterSec: 60,
  maxPositions: 3, minTrust: 60, takeProfitPct: 50, stopLossPct: 35,
  exitFillPct: 90, maxDailyLossBnb: 0.05, slippageBps: 500,
}

/**
 * Restore agents from a parsed backup (array of header→value maps). Each row is
 * validated (known strategy + the private_key must DERIVE the recorded
 * wallet_address — funds-safety against a corrupted file), re-encrypted under
 * its original id, and INSERTed ON CONFLICT(id) DO NOTHING. Rows whose id OR
 * name already exists are skipped (restore is additive — it never clobbers a
 * live agent). Requires the master key (encrypt is fail-closed).
 */
export async function importFleetBackup(rows: Array<Record<string, string>>): Promise<FleetImportResult> {
  const { ethers } = await import('ethers')
  const existing = await db.$queryRawUnsafe<Array<{ id: string; name: string }>>(`SELECT "id","name" FROM "fleet_agents"`)
  const takenIds = new Set(existing.map((r) => r.id))
  const takenNames = new Set(existing.map((r) => r.name))
  const result: FleetImportResult = { total: rows.length, restored: 0, skippedExisting: 0, failed: 0, errors: [] }

  const pick = (row: Record<string, string>, ...keys: string[]): string => {
    for (const k of keys) {
      const v = row[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
    return ''
  }
  const numOr = (row: Record<string, string>, key: string, fallback: number): number => {
    const raw = pick(row, key)
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }

  for (const row of rows) {
    const name = pick(row, 'name')
    try {
      const id = pick(row, 'id', 'agent_id')
      const pk = pick(row, 'privateKey', 'private_key')
      const walletAddress = pick(row, 'walletAddress', 'wallet_address')
      const strategy = pick(row, 'strategy') as FleetStrategy
      if (!id || !name) throw new Error('missing id or name')
      if (!FLEET_STRATEGY_KEYS.includes(strategy)) throw new Error(`unknown strategy "${strategy}"`)
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('missing or malformed private_key')
      // Funds-safety: the key MUST control the recorded wallet. A mismatch means
      // the row is corrupt — refuse it rather than restore an unspendable agent.
      let derived: string
      try {
        derived = new ethers.Wallet(pk).address
      } catch {
        throw new Error('private_key is not a valid key')
      }
      if (walletAddress && derived.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error(`private_key does not match wallet_address (key controls ${derived})`)
      }
      if (takenIds.has(id) || takenNames.has(name)) {
        result.skippedExisting += 1
        continue
      }

      const prof = FLEET_STRATEGIES[strategy]
      const riskRaw = pick(row, 'riskLevel', 'risk_level')
      const riskLevel: RiskLevel = riskRaw === 'low' || riskRaw === 'high' || riskRaw === 'medium' ? riskRaw : prof.risk
      // Funds-safety: restored agents always come back PAUSED regardless of the
      // backup's recorded status — an admin must consciously re-activate them so
      // a restore never silently resumes live on-chain trading.
      const status = 'paused'
      const swarmRaw = pick(row, 'swarmEnabled', 'swarm_enabled').toLowerCase()
      const swarmEnabled = swarmRaw === 'true' || swarmRaw === 't' || swarmRaw === '1'
      const wlRaw = pick(row, 'watchlist')
      let watchlistJson: string | null = null
      if (wlRaw) {
        try {
          const parsed = JSON.parse(wlRaw)
          if (Array.isArray(parsed) && parsed.length > 0) watchlistJson = JSON.stringify(parsed.map(String))
        } catch { /* malformed watchlist → none */ }
      }
      const assignedTo = pick(row, 'assignedTo', 'assigned_to') || null
      const encrypted = encryptPrivateKey(pk, id)

      const ins = await db.$executeRawUnsafe(
        `INSERT INTO "fleet_agents" (
           "id","name","strategy","wallet_address","encrypted_pk","risk_level",
           "max_trade_size_bnb","daily_trade_limit","cooldown_sec","jitter_sec",
           "max_positions","min_trust","take_profit_pct","stop_loss_pct","exit_fill_pct",
           "max_daily_loss_bnb","slippage_bps","watchlist","status","assigned_to","swarm_enabled"
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
         ) ON CONFLICT ("id") DO NOTHING`,
        id, name, strategy, derived, encrypted, riskLevel,
        numOr(row, 'maxTradeSizeBnb', FLEET_DEFAULTS.maxTradeSizeBnb),
        numOr(row, 'dailyTradeLimit', FLEET_DEFAULTS.dailyTradeLimit),
        numOr(row, 'cooldownSec', FLEET_DEFAULTS.cooldownSec),
        numOr(row, 'jitterSec', FLEET_DEFAULTS.jitterSec),
        numOr(row, 'maxPositions', FLEET_DEFAULTS.maxPositions),
        numOr(row, 'minTrust', FLEET_DEFAULTS.minTrust),
        numOr(row, 'takeProfitPct', FLEET_DEFAULTS.takeProfitPct),
        numOr(row, 'stopLossPct', FLEET_DEFAULTS.stopLossPct),
        numOr(row, 'exitFillPct', FLEET_DEFAULTS.exitFillPct),
        numOr(row, 'maxDailyLossBnb', FLEET_DEFAULTS.maxDailyLossBnb),
        numOr(row, 'slippageBps', FLEET_DEFAULTS.slippageBps),
        watchlistJson, status, assignedTo, swarmEnabled,
      )
      if (Number(ins) > 0) {
        result.restored += 1
        takenIds.add(id)
        takenNames.add(name)
      } else {
        // Lost a race to another insert on the same id.
        result.skippedExisting += 1
      }
    } catch (e) {
      result.failed += 1
      result.errors.push({ name: name || '(unknown)', error: (e as Error).message })
    }
  }
  return result
}

export interface FleetSweepRow {
  id: string
  name: string
  walletAddress: string
  balanceBnb: number
  sentBnb: number
  txHash: string | null
  status: 'swept' | 'skipped' | 'error'
  reason?: string
}

export interface FleetSweepSummary {
  destination: string
  results: FleetSweepRow[]
  totalSentBnb: number
  swept: number
  skipped: number
  errored: number
}

/**
 * Send every fleet wallet's BNB balance (minus a gas reserve) to `destination`.
 * A plain-EOA transfer costs 21000 gas; we reserve gasPrice×21000 with a 20%
 * buffer against price drift and skip wallets that can't cover it. All agents
 * are processed in parallel (each wallet is an independent signer with its own
 * nonce) and failures are isolated per-agent — a bad RPC or a revert on one
 * wallet never blocks the others. Fail-closed on an invalid destination.
 */
export async function sweepAllFleetBalances(destination: string): Promise<FleetSweepSummary> {
  const { ethers } = await import('ethers')
  if (!ethers.isAddress(destination)) {
    throw new Error(`destination is not a valid address: ${destination}`)
  }
  const dest = ethers.getAddress(destination)
  const { buildBscProvider } = await import('./bscProvider')
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const agents = await listFleetAgents()

  const feeData = await provider.getFeeData()
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei')
  const gasLimit = 21_000n
  const gasReserve = (gasPrice * gasLimit * 12n) / 10n // 20% buffer

  const sweepOne = async (agent: FleetAgent): Promise<FleetSweepRow> => {
    const base = { id: agent.id, name: agent.name, walletAddress: agent.walletAddress }
    let balWei: bigint
    try {
      balWei = await provider.getBalance(agent.walletAddress)
    } catch (e) {
      return { ...base, balanceBnb: 0, sentBnb: 0, txHash: null, status: 'error', reason: `balance read failed: ${(e as Error).message}` }
    }
    const balanceBnb = Number(ethers.formatEther(balWei))
    if (balWei <= gasReserve) {
      return { ...base, balanceBnb, sentBnb: 0, txHash: null, status: 'skipped', reason: 'balance below gas reserve' }
    }
    let pk: string
    try {
      pk = decryptFleetAgentKey(agent)
    } catch (e) {
      return { ...base, balanceBnb, sentBnb: 0, txHash: null, status: 'error', reason: `key decrypt failed: ${(e as Error).message}` }
    }
    const value = balWei - gasReserve
    try {
      const signer = new ethers.Wallet(pk, provider)
      const tx = await signer.sendTransaction({ to: dest, value, gasLimit, gasPrice })
      await tx.wait(1)
      return { ...base, balanceBnb, sentBnb: Number(ethers.formatEther(value)), txHash: tx.hash, status: 'swept' }
    } catch (e: any) {
      return { ...base, balanceBnb, sentBnb: 0, txHash: null, status: 'error', reason: e?.shortMessage ?? e?.message ?? String(e) }
    }
  }

  const results = await Promise.all(agents.map(sweepOne))
  const totalSentBnb = results.reduce((s, r) => s + r.sentBnb, 0)
  const swept = results.filter((r) => r.status === 'swept').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const errored = results.filter((r) => r.status === 'error').length
  return { destination: dest, results, totalSentBnb, swept, skipped, errored }
}

export async function setFleetAgentStatus(id: string, status: 'active' | 'paused'): Promise<void> {
  await db.$executeRawUnsafe(`UPDATE "fleet_agents" SET "status" = $1 WHERE id = $2`, status, id)
}

export async function setAllFleetStatus(status: 'active' | 'paused'): Promise<number> {
  const res = await db.$executeRawUnsafe(`UPDATE "fleet_agents" SET "status" = $1`, status)
  return Number(res)
}

/**
 * Bulk-toggle the per-agent swarm "brain" opt-in across the whole fleet. The
 * FLEET_SWARM_ENABLED env gate still has the final say at tick time — this only
 * flips the per-agent flag so an operator can light up (or dark out) all 50
 * agents from the panel in one click rather than editing each. Returns the
 * number of rows updated.
 */
export async function setAllFleetSwarm(enabled: boolean): Promise<number> {
  const res = await db.$executeRawUnsafe(`UPDATE "fleet_agents" SET "swarm_enabled" = $1`, enabled)
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
  swarmEnabled: (v) => (typeof v === 'boolean') ? v : undefined,
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
  swarmEnabled: 'swarm_enabled',
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

export async function logFleet(agentId: string | null, level: 'info' | 'trade' | 'error' | 'decision', message: string, meta?: Record<string, any>): Promise<void> {
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

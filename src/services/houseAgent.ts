/**
 * BUILD4 House Agent — standalone singleton, decoupled from Telegram users.
 *
 * The house agent runs alongside community agents in competitions and
 * always-on autotrade between campaigns. It's a single wallet whose private
 * key lives in process.env.HOUSE_AGENT_PRIVATE_KEY (NEVER persisted to DB).
 *
 * Config is stored in the HouseAgent table (id='singleton'). Trade logs are
 * written to AgentLog with reasoning tagged `[HOUSE]` so the existing brain
 * feed surfaces them next to user agents.
 */

import { ethers } from 'ethers'
import { db } from '../db'
import { pancakeBuyTokenWithBnb, pancakeSellTokenForBnb } from './pancakeSwapTrading'

export type HouseMode = 'idle' | 'autotrade' | 'campaign'
export type HouseDex = 'pancake' | 'aster' | 'hyperliquid' | '42'

export interface HouseConfig {
  persona?: string
  sizeBnb?: number
  slippageBps?: number
  drawdownCapPct?: number
  maxOpenPositions?: number
  maxTradesPerHour?: number
  notes?: string
}

export interface HouseState {
  id: string
  enabled: boolean
  mode: HouseMode
  dex: HouseDex
  walletAddress: string | null
  campaignId: string | null
  lastTickAt: Date | null
  lastTickStatus: string | null
  config: HouseConfig
  createdAt: Date
  updatedAt: Date
}

const HOUSE_ID = 'singleton'

/** Resolve house wallet address from the env-private-key, fail-closed. */
export function getHouseWalletAddress(): string {
  const pk = process.env.HOUSE_AGENT_PRIVATE_KEY
  if (!pk) throw new Error('HOUSE_AGENT_PRIVATE_KEY not set')
  return new ethers.Wallet(pk).address
}

/** Returns the house wallet signer. Throws if PK missing. */
export function getHouseSignerPk(): string {
  const pk = process.env.HOUSE_AGENT_PRIVATE_KEY
  if (!pk) throw new Error('HOUSE_AGENT_PRIVATE_KEY not set')
  return pk
}

function rowToState(row: any): HouseState {
  return {
    id: row.id,
    enabled: !!row.enabled,
    mode: (row.mode ?? 'idle') as HouseMode,
    dex: (row.dex ?? 'pancake') as HouseDex,
    walletAddress: row.walletAddress ?? null,
    campaignId: row.campaignId ?? null,
    lastTickAt: row.lastTickAt ? new Date(row.lastTickAt) : null,
    lastTickStatus: row.lastTickStatus ?? null,
    config: (row.config ?? {}) as HouseConfig,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }
}

export async function getHouseAgent(): Promise<HouseState> {
  const rows = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "HouseAgent" WHERE id = $1`, HOUSE_ID)
  if (rows.length === 0) {
    await db.$executeRawUnsafe(`INSERT INTO "HouseAgent" (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, HOUSE_ID)
    const rows2 = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "HouseAgent" WHERE id = $1`, HOUSE_ID)
    return rowToState(rows2[0])
  }
  // Backfill walletAddress from env on first read if missing.
  if (!rows[0].walletAddress) {
    try {
      const addr = getHouseWalletAddress()
      await db.$executeRawUnsafe(
        `UPDATE "HouseAgent" SET "walletAddress" = $1, "updatedAt" = NOW() WHERE id = $2`,
        addr, HOUSE_ID,
      )
      rows[0].walletAddress = addr
    } catch { /* PK missing — leave null, surface in UI */ }
  }
  return rowToState(rows[0])
}

// Allow-listed config keys + per-key validators. Anything not listed here is
// silently dropped before being merged into JSONB so the panel can never
// poison the persisted config blob with arbitrary keys/types.
const CONFIG_VALIDATORS: Record<string, (v: any) => any | undefined> = {
  persona:          (v) => (typeof v === 'string' && v.length <= 200) ? v : undefined,
  sizeBnb:          (v) => (typeof v === 'number' && isFinite(v) && v > 0    && v <= 10)      ? v : undefined,
  slippageBps:      (v) => (typeof v === 'number' && isFinite(v) && v >= 1   && v <= 2000)    ? Math.floor(v) : undefined,
  drawdownCapPct:   (v) => (typeof v === 'number' && isFinite(v) && v >= 0   && v <= 100)     ? v : undefined,
  maxOpenPositions: (v) => (typeof v === 'number' && isFinite(v) && v >= 0   && v <= 50)      ? Math.floor(v) : undefined,
  maxTradesPerHour: (v) => (typeof v === 'number' && isFinite(v) && v >= 0   && v <= 1000)    ? Math.floor(v) : undefined,
  notes:            (v) => (typeof v === 'string' && v.length <= 2000) ? v : undefined,
}

function sanitizeConfigPatch(input: any): Partial<HouseConfig> {
  if (!input || typeof input !== 'object') return {}
  const out: Record<string, any> = {}
  for (const [k, validate] of Object.entries(CONFIG_VALIDATORS)) {
    if (k in input) {
      const cleaned = validate(input[k])
      if (cleaned !== undefined) out[k] = cleaned
    }
  }
  return out as Partial<HouseConfig>
}

export async function setHouseConfig(patch: {
  enabled?: boolean
  mode?: HouseMode
  dex?: HouseDex
  campaignId?: string | null
  config?: Partial<HouseConfig>
}): Promise<HouseState> {
  const cur = await getHouseAgent()
  const sanitizedCfg = patch.config ? sanitizeConfigPatch(patch.config) : null
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    mode: patch.mode ?? cur.mode,
    dex: patch.dex ?? cur.dex,
    campaignId: patch.campaignId === undefined ? cur.campaignId : patch.campaignId,
    config: sanitizedCfg ? { ...cur.config, ...sanitizedCfg } : cur.config,
  }
  await db.$executeRawUnsafe(
    `UPDATE "HouseAgent"
       SET enabled = $1, mode = $2, dex = $3, "campaignId" = $4, config = $5::jsonb, "updatedAt" = NOW()
     WHERE id = $6`,
    next.enabled, next.mode, next.dex, next.campaignId, JSON.stringify(next.config), HOUSE_ID,
  )
  return getHouseAgent()
}

export async function recordHouseTick(status: string): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "HouseAgent" SET "lastTickAt" = NOW(), "lastTickStatus" = $1, "updatedAt" = NOW() WHERE id = $2`,
    status.slice(0, 500), HOUSE_ID,
  )
}

/** Append a brain-feed log to the dedicated HouseLog table. */
export async function logHouseBrain(opts: {
  dex?: string
  kind?: 'info' | 'trade' | 'error' | 'tick'
  reasoning: string
  decision?: string | null
  txHash?: string | null
  meta?: Record<string, any>
}): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "HouseLog" ("dex","kind","decision","reasoning","txHash","meta")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      opts.dex ?? null,
      opts.kind ?? 'info',
      opts.decision ?? null,
      opts.reasoning,
      opts.txHash ?? null,
      opts.meta ? JSON.stringify(opts.meta) : null,
    )
  } catch (err) {
    console.warn('[HouseAgent] HouseLog write failed:', (err as any)?.message)
  }
}

export interface HouseManualTradeInput {
  dex: 'pancake'
  side: 'buy' | 'sell'
  tokenAddress: string
  amount: string // BNB for buy, token-wei for sell (decimal string)
  slippageBps?: number
}

export async function houseManualTrade(input: HouseManualTradeInput): Promise<{
  ok: true
  txHash: string
  details: any
}> {
  const pk = getHouseSignerPk()
  // Server-side invariants — fail closed if anything looks off. These are the
  // last line of defence even if route-level validation regresses.
  const slippageBps = input.slippageBps ?? 100
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 2000) {
    throw new Error(`slippageBps must be 1..2000 (got ${slippageBps})`)
  }
  if (typeof input.amount !== 'string' || !/^\d+(\.\d+)?$/.test(input.amount)) {
    throw new Error(`amount must be a positive decimal string`)
  }
  const tokenAddress = ethers.getAddress(input.tokenAddress)

  if (input.dex !== 'pancake') {
    throw new Error(`Manual trade dex '${input.dex}' not wired yet`)
  }

  if (input.side === 'buy') {
    const bnbWei = ethers.parseEther(input.amount)
    // Hard cap on a single manual trade — 1 BNB. House panel is for ops not
    // moving the float; bigger trades must come from a deliberate code path.
    if (bnbWei <= 0n || bnbWei > ethers.parseEther('1')) {
      throw new Error(`BUY amount must be 0 < amount <= 1 BNB`)
    }
    await logHouseBrain({
      dex: 'pancake', kind: 'trade',
      reasoning: `manual BUY ${input.amount} BNB → ${tokenAddress.slice(0, 10)}…`,
      decision: 'BUY',
    })
    const r = await pancakeBuyTokenWithBnb(pk, tokenAddress, bnbWei, { slippageBps })
    await logHouseBrain({
      dex: 'pancake', kind: 'trade',
      reasoning: `BUY filled · slippage ${slippageBps}bps · est ${r.estimatedTokensWei} wei`,
      decision: 'FILLED',
      txHash: r.txHash,
    })
    return { ok: true, txHash: r.txHash, details: { ...r, bnbSpentWei: r.bnbSpentWei.toString(), estimatedTokensWei: r.estimatedTokensWei.toString(), minTokensWei: r.minTokensWei.toString(), gasUsedWei: r.gasUsedWei?.toString() } }
  }

  const tokensWei = BigInt(input.amount)
  if (tokensWei <= 0n) {
    throw new Error(`SELL amount must be > 0 (got ${input.amount})`)
  }
  await logHouseBrain({
    dex: 'pancake', kind: 'trade',
    reasoning: `manual SELL ${tokensWei} wei of ${tokenAddress.slice(0, 10)}…`,
    decision: 'SELL',
  })
  const r = await pancakeSellTokenForBnb(pk, tokenAddress, tokensWei, { slippageBps })
  await logHouseBrain({
    dex: 'pancake', kind: 'trade',
    reasoning: `SELL filled · slippage ${slippageBps}bps · est ${r.estimatedBnbWei} wei BNB`,
    decision: 'FILLED',
    txHash: r.txHash,
  })
  return { ok: true, txHash: r.txHash, details: { ...r, tokensSoldWei: r.tokensSoldWei.toString(), estimatedBnbWei: r.estimatedBnbWei.toString(), minBnbWei: r.minBnbWei.toString(), gasUsedWei: r.gasUsedWei?.toString() } }
}

/** Last N rows from the dedicated HouseLog feed. */
export async function getHouseBrainFeed(limit = 50): Promise<any[]> {
  const lim = Math.min(Math.max(1, limit), 200)
  try {
    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT id, "createdAt", dex, kind, decision, reasoning, "txHash", meta
         FROM "HouseLog"
        ORDER BY "createdAt" DESC
        LIMIT $1`,
      lim,
    )
    return rows
  } catch (err) {
    console.warn('[HouseAgent] brain-feed query failed:', (err as any)?.message)
    return []
  }
}

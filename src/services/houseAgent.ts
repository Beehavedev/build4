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
import {
  pancakeBuyTokenWithBnb,
  pancakeSellTokenForBnb,
  pancakeQuoteSell,
} from './pancakeSwapTrading'
import { buildBscProvider } from './bscProvider'

const ERC20_MINI_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const

export type HouseMode = 'idle' | 'autotrade' | 'campaign'
export type HouseDex = 'pancake' | 'aster' | 'hyperliquid' | '42'

export interface HouseConfig {
  sizeBnb?: number
  slippageBps?: number
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
  sizeBnb:          (v) => (typeof v === 'number' && isFinite(v) && v > 0    && v <= 10)      ? v : undefined,
  slippageBps:      (v) => (typeof v === 'number' && isFinite(v) && v >= 1   && v <= 2000)    ? Math.floor(v) : undefined,
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
  /** BUY: BNB amount (decimal, e.g. "0.05"). SELL: token amount in whole units (e.g. "1234.5") or omit when sellAll=true. */
  amount?: string
  /** SELL only: liquidate entire on-chain balance of this token. */
  sellAll?: boolean
  /** Slippage in percent (0.01..20). Preferred over slippageBps. */
  slippagePct?: number
  /** Back-compat: slippage in basis points (1..2000). */
  slippageBps?: number
}

function resolveSlippageBps(input: { slippagePct?: number; slippageBps?: number }): number {
  if (typeof input.slippagePct === 'number' && isFinite(input.slippagePct)) {
    const bps = Math.round(input.slippagePct * 100)
    if (bps < 1 || bps > 2000) throw new Error(`slippage must be 0.01%..20% (got ${input.slippagePct}%)`)
    return bps
  }
  const bps = input.slippageBps ?? 100
  if (!Number.isInteger(bps) || bps < 1 || bps > 2000) {
    throw new Error(`slippage must be 1..2000 bps (got ${bps})`)
  }
  return bps
}

async function fetchTokenMeta(tokenAddress: string): Promise<{
  symbol: string; decimals: number; balanceWei: bigint
}> {
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const erc = new ethers.Contract(tokenAddress, ERC20_MINI_ABI, provider)
  let symbol = tokenAddress.slice(0, 6)
  let decimals = 18
  try { symbol = String(await erc.symbol()) } catch {}
  try { decimals = Number(await erc.decimals()) } catch {}
  const house = getHouseWalletAddress()
  const balanceWei: bigint = await erc.balanceOf(house)
  return { symbol, decimals, balanceWei }
}

export async function houseManualTrade(input: HouseManualTradeInput): Promise<{
  ok: true
  txHash: string
  details: any
}> {
  const pk = getHouseSignerPk()
  const slippageBps = resolveSlippageBps(input)
  const tokenAddress = ethers.getAddress(input.tokenAddress)
  if (input.dex !== 'pancake') throw new Error(`Manual trade dex '${input.dex}' not wired yet`)

  if (input.side === 'buy') {
    if (typeof input.amount !== 'string' || !/^\d+(\.\d+)?$/.test(input.amount)) {
      throw new Error('BUY amount must be a positive decimal BNB string')
    }
    const bnbWei = ethers.parseEther(input.amount)
    if (bnbWei <= 0n || bnbWei > ethers.parseEther('1')) {
      throw new Error('BUY amount must be 0 < amount <= 1 BNB')
    }
    await logHouseBrain({
      dex: 'pancake', kind: 'trade',
      reasoning: `manual BUY ${input.amount} BNB → ${tokenAddress.slice(0, 10)}…`,
      decision: 'BUY',
      meta: { tokenAddress, side: 'buy', bnbIn: input.amount },
    })
    const r = await pancakeBuyTokenWithBnb(pk, tokenAddress, bnbWei, { slippageBps })
    const tokensOut = ethers.formatUnits(r.estimatedTokensWei, 18) // best-effort; real decimals unknown here
    await logHouseBrain({
      dex: 'pancake', kind: 'trade',
      reasoning: `BUY filled · spent ${input.amount} BNB · slippage ${(slippageBps / 100).toFixed(2)}%`,
      decision: 'FILLED', txHash: r.txHash,
      meta: { tokenAddress, side: 'buy', bnbIn: input.amount, estTokensOut: tokensOut },
    })
    return { ok: true, txHash: r.txHash, details: {
      tokenAddress, bnbSpent: input.amount, slippagePct: slippageBps / 100,
    } }
  }

  // SELL
  const { symbol, decimals, balanceWei } = await fetchTokenMeta(tokenAddress)
  let tokensWei: bigint
  if (input.sellAll) {
    if (balanceWei <= 0n) throw new Error(`No ${symbol} balance to sell`)
    tokensWei = balanceWei
  } else {
    if (typeof input.amount !== 'string' || !/^\d+(\.\d+)?$/.test(input.amount)) {
      throw new Error('SELL amount must be a positive decimal token amount (e.g. "1234.5") or pass sellAll=true')
    }
    tokensWei = ethers.parseUnits(input.amount, decimals)
    if (tokensWei <= 0n) throw new Error('SELL amount must be > 0')
    if (tokensWei > balanceWei) throw new Error(`Insufficient ${symbol} balance (have ${ethers.formatUnits(balanceWei, decimals)}, want ${input.amount})`)
  }
  const human = ethers.formatUnits(tokensWei, decimals)
  await logHouseBrain({
    dex: 'pancake', kind: 'trade',
    reasoning: `manual SELL ${human} ${symbol} → BNB`,
    decision: 'SELL',
    meta: { tokenAddress, side: 'sell', tokensIn: human, symbol },
  })
  const r = await pancakeSellTokenForBnb(pk, tokenAddress, tokensWei, { slippageBps })
  const bnbOut = ethers.formatEther(r.estimatedBnbWei)
  await logHouseBrain({
    dex: 'pancake', kind: 'trade',
    reasoning: `SELL filled · sold ${human} ${symbol} · est ${bnbOut} BNB · slippage ${(slippageBps / 100).toFixed(2)}%`,
    decision: 'FILLED', txHash: r.txHash,
    meta: { tokenAddress, side: 'sell', tokensIn: human, symbol, estBnbOut: bnbOut },
  })
  return { ok: true, txHash: r.txHash, details: {
    tokenAddress, symbol, tokensSold: human, estBnbReceived: bnbOut, slippagePct: slippageBps / 100,
  } }
}

/**
 * Register an existing token address so the positions scanner picks it up.
 * Idempotent — writes a single 'info' log row tagged with meta.tokenAddress.
 */
export async function trackHouseToken(tokenAddress: string): Promise<void> {
  const addr = ethers.getAddress(tokenAddress)
  await logHouseBrain({
    dex: 'pancake', kind: 'info',
    reasoning: `track existing token ${addr.slice(0, 10)}… for positions scan`,
    meta: { tokenAddress: addr, tracked: true },
  })
}

/**
 * Returns open Pancake positions for the house wallet.
 * Scans HouseLog for every token the house has ever bought/sold (via meta.tokenAddress),
 * then reads each token's current on-chain balance. Only tokens with balance > 0 are returned.
 */
export interface HousePosition {
  venue: 'pancake'
  tokenAddress: string
  symbol: string
  decimals: number
  balance: string         // human units
  estBnbValue: string     // best-effort sell quote in BNB
  quoteError?: string
}

export async function getHousePositions(): Promise<HousePosition[]> {
  let house: string
  try { house = getHouseWalletAddress() } catch { return [] }
  const rows = await db.$queryRawUnsafe<Array<{ token: string }>>(
    `SELECT DISTINCT (meta->>'tokenAddress') AS token
       FROM "HouseLog"
      WHERE dex = 'pancake'
        AND meta ? 'tokenAddress'
        AND "createdAt" > NOW() - INTERVAL '90 days'`,
  )
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const out: HousePosition[] = []
  for (const { token } of rows) {
    if (!token || !/^0x[a-fA-F0-9]{40}$/.test(token)) continue
    try {
      const addr = ethers.getAddress(token)
      const erc = new ethers.Contract(addr, ERC20_MINI_ABI, provider)
      let symbol = addr.slice(0, 6)
      let decimals = 18
      try { symbol = String(await erc.symbol()) } catch {}
      try { decimals = Number(await erc.decimals()) } catch {}
      const balanceWei: bigint = await erc.balanceOf(house)
      if (balanceWei <= 0n) continue
      let estBnbValue = '0'
      let quoteError: string | undefined
      try {
        const q = await pancakeQuoteSell(addr, balanceWei)
        estBnbValue = ethers.formatEther(q.estimatedBnbWei)
      } catch (e: any) {
        quoteError = e?.message?.slice(0, 100) ?? 'no_quote'
      }
      out.push({
        venue: 'pancake', tokenAddress: addr, symbol, decimals,
        balance: ethers.formatUnits(balanceWei, decimals),
        estBnbValue, quoteError,
      })
    } catch (e) {
      console.warn('[HouseAgent] position scan failed for', token, (e as any)?.message)
    }
  }
  return out
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

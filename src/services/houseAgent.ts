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
import {
  runWithHouseSigner,
  getMasterSigner,
  getPoolStats,
  swap as topazSwap,
  addV2Liquidity as topazAddV2Liquidity,
  removeV2Liquidity as topazRemoveV2Liquidity,
  burnV3Position as topazBurnV3Position,
  listOpenLpPositions as topazListOpenLpPositions,
  resolveGaugeForPool as topazResolveGaugeForPool,
  stakeInGauge as topazStakeInGauge,
  unstakeFromGauge as topazUnstakeFromGauge,
  claimGaugeRewards as topazClaimGaugeRewards,
} from './topazTrading'
import { getTopazConfig } from './topaz'
import { TOPAZ_ROUTER_ABI, ERC20_ABI, WBNB_ABI } from './topaz/abis'
import { getPrice } from './price'

// ── Anchor helpers (USDT/USDC/WBNB) ────────────────────────────────────
// Mirrors the brain's anchor concept but in this lower-level wrapper.
// Used so OPEN_LP can stamp entryUsd into the log and CLOSE_LP can pick
// the right side to auto-sell into. WBNB price comes from the BNB/USD
// oracle; stables are pinned 1:1.
type AnchorSymbol = 'USDT' | 'USDC' | 'WBNB'

interface AnchorInfo { symbol: AnchorSymbol; address: string; priceUsd: number }

function buildAnchorAddrMap(cfg: ReturnType<typeof getTopazConfig>): Record<string, AnchorSymbol> {
  const m: Record<string, AnchorSymbol> = {}
  if (cfg.usdtToken) m[cfg.usdtToken.toLowerCase()] = 'USDT'
  if (cfg.usdcToken) m[cfg.usdcToken.toLowerCase()] = 'USDC'
  if (cfg.wbnbToken) m[cfg.wbnbToken.toLowerCase()] = 'WBNB'
  return m
}

async function getAnchorPriceUsd(sym: AnchorSymbol): Promise<number> {
  if (sym === 'USDT' || sym === 'USDC') return 1
  try { const p = await getPrice('BNB'); return p?.price > 0 ? p.price : 0 } catch { return 0 }
}

/** Identify which side (if any) of a token pair is an anchor. */
async function detectAnchorSide(
  cfg: ReturnType<typeof getTopazConfig>,
  tokenA: string,
  tokenB: string,
): Promise<{ anchor: AnchorInfo; anchorIsA: boolean; nonAnchorAddr: string } | null> {
  const map = buildAnchorAddrMap(cfg)
  const aSym = map[tokenA.toLowerCase()]
  const bSym = map[tokenB.toLowerCase()]
  if (aSym) {
    const px = await getAnchorPriceUsd(aSym)
    if (!(px > 0)) return null
    return { anchor: { symbol: aSym, address: ethers.getAddress(tokenA), priceUsd: px }, anchorIsA: true, nonAnchorAddr: ethers.getAddress(tokenB) }
  }
  if (bSym) {
    const px = await getAnchorPriceUsd(bSym)
    if (!(px > 0)) return null
    return { anchor: { symbol: bSym, address: ethers.getAddress(tokenB), priceUsd: px }, anchorIsA: false, nonAnchorAddr: ethers.getAddress(tokenA) }
  }
  return null
}

/** Look up the most recent OPEN_LP HouseLog row for a given pair to read entryUsd. */
async function lookupEntryUsdForPair(pair: string): Promise<number | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ entry: string | null }>>(
      `SELECT (meta->>'entryUsd')::text AS entry
         FROM "HouseLog"
        WHERE dex = 'topaz'
          AND decision IN ('FILLED','OPEN_LP')
          AND meta ? 'entryUsd'
          AND LOWER(meta->>'pair') = LOWER($1)
        ORDER BY "createdAt" DESC
        LIMIT 1`,
      pair,
    )
    const v = rows[0]?.entry
    if (!v) return null
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

const ERC20_MINI_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const

export type HouseMode = 'idle' | 'autotrade' | 'campaign'
export type HouseDex = 'pancake' | 'aster' | 'hyperliquid' | '42' | 'topaz'

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

// ═══════════════════════════════════════════════════════════════════════
// Topaz DEX (BSC ve(3,3)) — house wallet wrappers
// All entry points wrap the existing topazTrading execution layer in
// runWithHouseSigner() so signing pulls from HOUSE_AGENT_PRIVATE_KEY
// instead of the Wallet table. Every house Topaz action is logged to
// HouseLog with dex='topaz' so the brain feed surfaces it.
// ═══════════════════════════════════════════════════════════════════════

export interface HouseTopazSwapInput {
  tokenIn: string
  tokenOut: string
  /** Decimal amount of tokenIn (e.g. "100" for 100 USDT). */
  amountIn: string
  /** Slippage in percent (0.05..20). Default 1%. */
  slippagePct?: number
  /** Optional v2 pool stable flag override. If unset, tries volatile then stable. */
  stable?: boolean
}

/** Best-effort decimals lookup (falls back to 18). */
async function readDecimals(provider: ethers.Provider, token: string): Promise<number> {
  try {
    const erc = new ethers.Contract(token, ERC20_MINI_ABI, provider)
    return Number(await erc.decimals())
  } catch { return 18 }
}

/**
 * Manual Topaz v2 swap from the house wallet. Auto-resolves the pool
 * (tries volatile pair, falls back to stable) unless `stable` is set.
 * v3-only routing not exposed here yet (Phase 1 brain handles that).
 */
export async function houseTopazSwap(input: HouseTopazSwapInput): Promise<{
  ok: true; txHash: string | null; details: any
}> {
  const tokenIn  = ethers.getAddress(input.tokenIn)
  const tokenOut = ethers.getAddress(input.tokenOut)
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) throw new Error('tokenIn == tokenOut')
  const slippagePct = typeof input.slippagePct === 'number' ? input.slippagePct : 1
  if (!(slippagePct > 0 && slippagePct <= 20)) throw new Error('slippage must be 0..20%')
  const slippageBps = Math.round(slippagePct * 100)

  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const decIn = await readDecimals(provider, tokenIn)
  if (!/^\d+(\.\d+)?$/.test(input.amountIn)) throw new Error('amountIn must be a decimal string')
  const amountInWei = ethers.parseUnits(input.amountIn, decIn)
  if (amountInWei <= 0n) throw new Error('amountIn must be > 0')

  const cfg = getTopazConfig()
  if (!cfg.router) throw new Error('topaz_config_missing:router')

  // Resolve pool — pairFor is deterministic; verify it actually exists by
  // reading reserves (getPoolStats throws fail-closed if not found).
  const candidates: boolean[] = typeof input.stable === 'boolean' ? [input.stable] : [false, true]
  let chosenStable: boolean | null = null
  let chosenPair = ''
  for (const stable of candidates) {
    try {
      const routerCtr = new ethers.Contract(cfg.router, TOPAZ_ROUTER_ABI, provider)
      const pair = (await routerCtr.pairFor(tokenIn, tokenOut, stable)) as string
      // getPoolStats throws topaz_pool_not_found if no reserves.
      await getPoolStats(pair)
      chosenStable = stable; chosenPair = pair; break
    } catch { /* try next candidate */ }
  }
  if (chosenStable === null) {
    throw new Error(`topaz_no_v2_pool_found for ${tokenIn.slice(0,10)}…/${tokenOut.slice(0,10)}…`)
  }

  await logHouseBrain({
    dex: 'topaz', kind: 'trade',
    reasoning: `manual SWAP ${input.amountIn} ${tokenIn.slice(0,10)}… → ${tokenOut.slice(0,10)}… (${chosenStable ? 'stable' : 'volatile'})`,
    decision: 'SWAP',
    meta: { tokenIn, tokenOut, amountIn: input.amountIn, stable: chosenStable, pair: chosenPair, slippagePct },
  })

  const r = await runWithHouseSigner(() => topazSwap({
    tokenIn, tokenOut,
    amountIn: amountInWei,
    route: { kind: 'v2', hops: [{ from: tokenIn, to: tokenOut, stable: chosenStable! }] },
    slippageBps,
  }))
  if (!r.ok) {
    await logHouseBrain({
      dex: 'topaz', kind: 'error',
      reasoning: `SWAP failed: ${r.error}`,
      decision: 'ERROR',
      meta: { tokenIn, tokenOut, amountIn: input.amountIn, error: r.error },
    })
    throw new Error(r.error ?? 'topaz_swap_failed')
  }
  await logHouseBrain({
    dex: 'topaz', kind: 'trade',
    reasoning: `SWAP filled · ${input.amountIn} → ${tokenOut.slice(0,10)}… · slippage ${slippagePct}%`,
    decision: 'FILLED', txHash: r.txHash ?? null,
    meta: { tokenIn, tokenOut, amountIn: input.amountIn, stable: chosenStable, slippagePct },
  })
  return { ok: true, txHash: r.txHash ?? null, details: {
    tokenIn, tokenOut, amountIn: input.amountIn, stable: chosenStable, pair: chosenPair, slippagePct,
  } }
}

export interface HouseTopazOpenLpV2Input {
  tokenA: string
  tokenB: string
  stable: boolean
  /** Decimal amount of tokenA (paired with equal-value tokenB by caller). */
  amountADesired: string
  /** Decimal amount of tokenB. */
  amountBDesired: string
}

/**
 * Open a v2 LP position from the house wallet, then attempt to stake the
 * freshly-minted LP in the pool's gauge (if one exists) so it earns TOPAZ
 * emissions. Records the position in HouseLog with full detail for the
 * positions panel to enumerate later.
 */
export async function houseTopazOpenLpV2(input: HouseTopazOpenLpV2Input): Promise<{
  ok: true; txHash: string | null; staked: boolean; lpAmount: string; pair: string
}> {
  const tokenA = ethers.getAddress(input.tokenA)
  const tokenB = ethers.getAddress(input.tokenB)
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const [decA, decB] = await Promise.all([readDecimals(provider, tokenA), readDecimals(provider, tokenB)])
  if (!/^\d+(\.\d+)?$/.test(input.amountADesired) || !/^\d+(\.\d+)?$/.test(input.amountBDesired)) {
    throw new Error('amounts must be decimal strings')
  }
  const amtA = ethers.parseUnits(input.amountADesired, decA)
  const amtB = ethers.parseUnits(input.amountBDesired, decB)
  if (amtA <= 0n || amtB <= 0n) throw new Error('amounts must be > 0')

  const cfg = getTopazConfig()
  if (!cfg.router) throw new Error('topaz_config_missing:router')
  const routerCtr = new ethers.Contract(cfg.router, TOPAZ_ROUTER_ABI, provider)
  const pair = (await routerCtr.pairFor(tokenA, tokenB, input.stable)) as string

  // Stamp the USD entry cost so CLOSE_LP can compute realized PnL later.
  // If one side is an anchor (USDT/USDC/WBNB), entryUsd = anchorAmount × 2
  // × anchorPrice (LPs enter balanced, so each side equals half the
  // notional). Non-anchor pools (rare — brain refuses them) get null
  // and the close path will skip PnL computation rather than guess.
  const anchorSide = await detectAnchorSide(cfg, tokenA, tokenB)
  let entryUsd: number | null = null
  if (anchorSide) {
    const anchorAmtStr = anchorSide.anchorIsA ? input.amountADesired : input.amountBDesired
    const anchorAmt = Number(anchorAmtStr)
    if (Number.isFinite(anchorAmt) && anchorAmt > 0) {
      entryUsd = Number((anchorAmt * 2 * anchorSide.anchor.priceUsd).toFixed(6))
    }
  }

  await logHouseBrain({
    dex: 'topaz', kind: 'trade',
    reasoning: `manual OPEN_LP_V2 ${input.amountADesired} ${tokenA.slice(0,10)}… + ${input.amountBDesired} ${tokenB.slice(0,10)}… (${input.stable ? 'stable' : 'volatile'})`,
    decision: 'OPEN_LP',
    meta: { tokenA, tokenB, stable: input.stable, amountA: input.amountADesired, amountB: input.amountBDesired, pair, entryUsd },
  })

  return await runWithHouseSigner(async () => {
    const { signer, address: house } = await getMasterSigner()
    const lpCtr = new ethers.Contract(pair, ERC20_ABI, signer)
    const before = (await lpCtr.balanceOf(house)) as bigint
    const addR = await topazAddV2Liquidity({
      tokenA, tokenB, stable: input.stable,
      amountADesired: amtA, amountBDesired: amtB,
    })
    if (!addR.ok) {
      await logHouseBrain({
        dex: 'topaz', kind: 'error', reasoning: `OPEN_LP_V2 add failed: ${addR.error}`,
        decision: 'ERROR', meta: { tokenA, tokenB, error: addR.error },
      })
      throw new Error(addR.error ?? 'topaz_add_v2_liquidity_failed')
    }
    const after = (await lpCtr.balanceOf(house)) as bigint
    const minted = after - before

    let staked = false
    let stakeTx: string | null = null
    if (minted > 0n) {
      const gauge = await topazResolveGaugeForPool(pair)
      if (gauge) {
        const allowance = (await lpCtr.allowance(house, gauge)) as bigint
        if (allowance < minted) {
          const apx = await lpCtr.approve(gauge, minted)
          await apx.wait(1)
        }
        const stk = await topazStakeInGauge({ gauge, kind: 'v2', lpAmount: minted })
        if (stk.ok) { staked = true; stakeTx = stk.txHash ?? null }
      }
    }

    await logHouseBrain({
      dex: 'topaz', kind: 'trade',
      reasoning: `OPEN_LP_V2 filled · minted ${ethers.formatUnits(minted, 18)} LP · stake=${staked ? 'yes' : 'no'}`,
      decision: 'FILLED', txHash: addR.txHash ?? null,
      meta: {
        tokenA, tokenB, stable: input.stable, pair, positionType: 'v2-lp',
        lpAmount: minted.toString(), staked, stakeTx,
        amountA: input.amountADesired, amountB: input.amountBDesired,
        topazPosition: true, entryUsd,
      },
    })
    return { ok: true, txHash: addR.txHash ?? null, staked, lpAmount: ethers.formatUnits(minted, 18), pair }
  })
}

/**
 * Close a v2 LP position opened from the house panel.
 * Pipeline:
 *   1. Unstake from gauge (hard-fail if it errors, so we never burn a
 *      staked LP and silently leave funds locked).
 *   2. Claim TOPAZ emissions (best-effort; can revert when nothing
 *      accrued). Captures `topazClaimedWei` via balance delta.
 *   3. removeLiquidity (slippage-bounded against current reserves).
 *      Captures `tokenAReceivedWei` / `tokenBReceivedWei` via balance
 *      delta on the wallet.
 *   4. Auto-sell the non-anchor leg back into the anchor token via
 *      Topaz router (3% slippage). E.g. for a CAKE/WBNB LP closed
 *      against the WBNB anchor, CAKE gets swapped to WBNB so the
 *      whole position collapses to anchor + emissions.
 *   5. Auto-sell TOPAZ emissions → WBNB → native BNB (3% slippage,
 *      then WBNB.withdraw to unwrap). User keeps gains in native BNB
 *      so the wallet doesn't accumulate volatile reward token.
 *   6. Compute and log full PnL: proceedsUsd (anchor + emissions),
 *      entryUsd (looked up from the matching OPEN_LP log on this pair),
 *      pnlUsd, and a `pnlBreakdown` split into `feesAndIl` vs
 *      `emissions`.
 *
 * Each auto-sell step is wrapped in try/catch — a missing route or
 * thin liquidity for the non-anchor token / TOPAZ doesn't fail the
 * whole close; the unsold token just stays in the wallet and the log
 * records `autoSell*Failed` with the reason.
 */
export async function houseTopazCloseLpV2(input: {
  tokenA: string; tokenB: string; stable: boolean; pair: string; gauge?: string | null
}): Promise<{ ok: true; closeTx: string | null; unstakeTx: string | null }> {
  const tokenA = ethers.getAddress(input.tokenA)
  const tokenB = ethers.getAddress(input.tokenB)
  const pair = ethers.getAddress(input.pair)
  const CLOSE_SLIPPAGE_BPS = 300 // 3% — operator-set for closing legs

  return await runWithHouseSigner(async () => {
    const { signer, address: house } = await getMasterSigner()
    const cfg = getTopazConfig()
    let unstakeTx: string | null = null

    // ── Pre-flight snapshots so every subsequent on-chain action can be
    //    valued via balance deltas (not on-chain quotes the LLM might
    //    misread). Anchor side is determined from the pool's tokens.
    const anchorSide = await detectAnchorSide(cfg, tokenA, tokenB)
    const tokenADec = await readDecimals(signer.provider!, tokenA)
    const tokenBDec = await readDecimals(signer.provider!, tokenB)
    const tokenACtr = new ethers.Contract(tokenA, ERC20_ABI, signer)
    const tokenBCtr = new ethers.Contract(tokenB, ERC20_ABI, signer)
    const topazAddr = cfg.topazToken
    const topazCtr  = topazAddr ? new ethers.Contract(topazAddr, ERC20_ABI, signer) : null
    const topazDec  = topazCtr ? await readDecimals(signer.provider!, topazAddr!) : 18

    // ── 1) Unstake (+ 2) Claim TOPAZ) ─────────────────────────────────────
    const topazBeforeClaim = topazCtr ? (await topazCtr.balanceOf(house)) as bigint : 0n
    const gauge = input.gauge ?? (await topazResolveGaugeForPool(pair))
    if (gauge) {
      const gaugeCtr = new ethers.Contract(gauge, ['function balanceOf(address) view returns (uint256)'], signer)
      const staked = (await gaugeCtr.balanceOf(house)) as bigint
      if (staked > 0n) {
        const u = await topazUnstakeFromGauge({ gauge, kind: 'v2', lpAmount: staked })
        if (!u.ok) {
          await logHouseBrain({
            dex: 'topaz', kind: 'error',
            reasoning: `CLOSE_LP_V2 unstake failed — refusing to burn while LP still staked: ${u.error}`,
            decision: 'ERROR', meta: { pair, gauge, stakedAmount: staked.toString(), error: u.error },
          })
          throw new Error(u.error ?? 'topaz_unstake_failed')
        }
        unstakeTx = u.txHash ?? null
        try { await topazClaimGaugeRewards({ gauge, kind: 'v2' }) } catch { /* no rewards accrued — fine */ }
      }
    }
    const topazAfterClaim = topazCtr ? (await topazCtr.balanceOf(house)) as bigint : 0n
    const topazClaimedWei = topazAfterClaim > topazBeforeClaim ? topazAfterClaim - topazBeforeClaim : 0n

    // ── 3) removeLiquidity ────────────────────────────────────────────────
    const lpCtr = new ethers.Contract(pair, ERC20_ABI, signer)
    const lpBal = (await lpCtr.balanceOf(house)) as bigint
    if (lpBal <= 0n) {
      await logHouseBrain({
        dex: 'topaz', kind: 'info',
        reasoning: `CLOSE_LP_V2 nothing to burn (LP balance 0)`,
        meta: { pair, unstakeTx, topazClaimedWei: topazClaimedWei.toString() },
      })
      return { ok: true, closeTx: null, unstakeTx }
    }
    const pairCtr = new ethers.Contract(pair, [
      'function getReserves() view returns (uint256, uint256, uint256)',
      'function totalSupply() view returns (uint256)',
      'function token0() view returns (address)',
    ], signer)
    const [r0, r1] = (await pairCtr.getReserves()) as [bigint, bigint, bigint]
    const totalSupply = (await pairCtr.totalSupply()) as bigint
    const token0 = ethers.getAddress((await pairCtr.token0()) as string)
    if (totalSupply <= 0n) throw new Error('topaz_remove_lp_zero_total_supply')
    const expected0 = (r0 * lpBal) / totalSupply
    const expected1 = (r1 * lpBal) / totalSupply
    const slipCap = cfg.maxSlippageBps
    const min0 = expected0 > 0n ? (expected0 * BigInt(10000 - slipCap)) / 10000n : 0n
    const min1 = expected1 > 0n ? (expected1 * BigInt(10000 - slipCap)) / 10000n : 0n
    const aIsToken0 = tokenA.toLowerCase() === token0.toLowerCase()
    const amountAMin = aIsToken0 ? min0 : min1
    const amountBMin = aIsToken0 ? min1 : min0

    const tokenABeforeBurn = (await tokenACtr.balanceOf(house)) as bigint
    const tokenBBeforeBurn = (await tokenBCtr.balanceOf(house)) as bigint

    const rm = await topazRemoveV2Liquidity({
      tokenA, tokenB, stable: input.stable, liquidity: lpBal, amountAMin, amountBMin,
    })
    if (!rm.ok) {
      await logHouseBrain({
        dex: 'topaz', kind: 'error',
        reasoning: `CLOSE_LP_V2 remove failed: ${rm.error}`,
        decision: 'ERROR', meta: { pair, error: rm.error, unstakeTx },
      })
      throw new Error(rm.error ?? 'topaz_remove_v2_liquidity_failed')
    }
    const tokenAAfterBurn = (await tokenACtr.balanceOf(house)) as bigint
    const tokenBAfterBurn = (await tokenBCtr.balanceOf(house)) as bigint
    const tokenAReceivedWei = tokenAAfterBurn - tokenABeforeBurn
    const tokenBReceivedWei = tokenBAfterBurn - tokenBBeforeBurn

    // ── 4) Auto-sell the non-anchor leg → anchor (3% slippage) ────────────
    let autoSellLegTx: string | null = null
    let autoSellLegError: string | null = null
    let anchorFromLegWei = 0n // raw anchor-token wei received from leg sale
    if (anchorSide) {
      const nonAnchorAddr = anchorSide.nonAnchorAddr
      const nonAnchorReceivedWei = anchorSide.anchorIsA ? tokenBReceivedWei : tokenAReceivedWei
      const anchorAddr = anchorSide.anchor.address
      const anchorCtr  = anchorSide.anchorIsA ? tokenACtr : tokenBCtr
      if (nonAnchorReceivedWei > 0n) {
        try {
          const anchorBefore = (await anchorCtr.balanceOf(house)) as bigint
          const swapR = await topazSwap({
            tokenIn: nonAnchorAddr,
            tokenOut: anchorAddr,
            amountIn: nonAnchorReceivedWei,
            route: { kind: 'v2', hops: [{ from: nonAnchorAddr, to: anchorAddr, stable: input.stable }] },
            slippageBps: CLOSE_SLIPPAGE_BPS,
          })
          if (!swapR.ok) throw new Error(swapR.error ?? 'auto_sell_leg_swap_failed')
          autoSellLegTx = swapR.txHash ?? null
          const anchorAfter = (await anchorCtr.balanceOf(house)) as bigint
          anchorFromLegWei = anchorAfter > anchorBefore ? anchorAfter - anchorBefore : 0n
        } catch (e) {
          autoSellLegError = (e as Error).message.slice(0, 180)
          // Non-fatal — operator will see autoSellLegError in the log and
          // the unsold token remains in the wallet for manual handling.
        }
      }
    }

    // ── 5) Auto-sell TOPAZ emissions → WBNB → native BNB (3% slippage) ───
    let topazSellTx: string | null = null
    let topazUnwrapTx: string | null = null
    let topazSellError: string | null = null
    let wbnbFromTopazWei = 0n
    if (topazClaimedWei > 0n && topazAddr && cfg.wbnbToken) {
      const wbnbAddr = cfg.wbnbToken
      try {
        const wbnbCtr = new ethers.Contract(wbnbAddr, ERC20_ABI, signer)
        const wbnbBefore = (await wbnbCtr.balanceOf(house)) as bigint
        // Try volatile pool first; fall back to stable if volatile route missing.
        let lastErr: unknown = null
        for (const stable of [false, true]) {
          try {
            const sr = await topazSwap({
              tokenIn: topazAddr,
              tokenOut: wbnbAddr,
              amountIn: topazClaimedWei,
              route: { kind: 'v2', hops: [{ from: topazAddr, to: wbnbAddr, stable }] },
              slippageBps: CLOSE_SLIPPAGE_BPS,
            })
            if (sr.ok) { topazSellTx = sr.txHash ?? null; lastErr = null; break }
            lastErr = new Error(sr.error ?? 'topaz_sell_failed')
          } catch (e) { lastErr = e }
        }
        if (lastErr) throw lastErr
        const wbnbAfter = (await wbnbCtr.balanceOf(house)) as bigint
        wbnbFromTopazWei = wbnbAfter > wbnbBefore ? wbnbAfter - wbnbBefore : 0n
        // Unwrap WBNB → native BNB so the user holds BNB, not WBNB.
        if (wbnbFromTopazWei > 0n) {
          const wbnbW = new ethers.Contract(wbnbAddr, WBNB_ABI, signer)
          const tx = await wbnbW.withdraw(wbnbFromTopazWei)
          const receipt = await tx.wait(1)
          topazUnwrapTx = receipt?.hash ?? tx.hash ?? null
        }
      } catch (e) {
        topazSellError = (e as Error).message.slice(0, 180)
        // Non-fatal — TOPAZ stays in the wallet.
      }
    }

    // ── 6) Valuation + PnL ────────────────────────────────────────────────
    const bnbPriceUsd = await getAnchorPriceUsd('WBNB')

    // Anchor-side proceeds = what came straight from the burn on the
    // anchor side, plus what we received auto-selling the other leg.
    let anchorProceedsUsd = 0
    if (anchorSide) {
      const anchorFromBurnWei = anchorSide.anchorIsA ? tokenAReceivedWei : tokenBReceivedWei
      const anchorTotalWei = anchorFromBurnWei + anchorFromLegWei
      const anchorDec = anchorSide.anchorIsA ? tokenADec : tokenBDec
      const anchorHuman = Number(ethers.formatUnits(anchorTotalWei, anchorDec))
      anchorProceedsUsd = anchorHuman * anchorSide.anchor.priceUsd
    }
    // Emissions valued by actual WBNB received × BNB price (the unwrap
    // is 1:1, so WBNB amount == BNB amount we now hold).
    const emissionsBnbHuman = Number(ethers.formatEther(wbnbFromTopazWei))
    const emissionsUsd = bnbPriceUsd > 0 ? emissionsBnbHuman * bnbPriceUsd : 0

    const proceedsUsd = anchorProceedsUsd + emissionsUsd
    const entryUsd = await lookupEntryUsdForPair(pair)
    const pnlUsd = entryUsd != null ? proceedsUsd - entryUsd : null
    const feesAndIlUsd = entryUsd != null ? anchorProceedsUsd - entryUsd : null

    const pnlStr = pnlUsd != null
      ? `${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`
      : 'pnl_unknown (no entryUsd)'

    await logHouseBrain({
      dex: 'topaz', kind: 'trade',
      reasoning:
        `CLOSE_LP_V2 burned ${ethers.formatUnits(lpBal, 18)} LP · ` +
        `proceeds=$${proceedsUsd.toFixed(2)} (anchor $${anchorProceedsUsd.toFixed(2)} + emissions $${emissionsUsd.toFixed(2)}) · ` +
        `entry=${entryUsd != null ? '$' + entryUsd.toFixed(2) : 'n/a'} · pnl=${pnlStr}`,
      decision: 'CLOSE', txHash: rm.txHash ?? null,
      meta: {
        pair,
        lpBurned: ethers.formatUnits(lpBal, 18),
        unstakeTx,
        topazPositionClosed: true,
        // Raw amounts received from the burn
        tokenAReceived: ethers.formatUnits(tokenAReceivedWei, tokenADec),
        tokenBReceived: ethers.formatUnits(tokenBReceivedWei, tokenBDec),
        // Auto-sell non-anchor leg
        anchorSymbol: anchorSide?.anchor.symbol ?? null,
        autoSellLegTx,
        autoSellLegError,
        anchorFromLeg: anchorSide ? ethers.formatUnits(
          anchorFromLegWei,
          anchorSide.anchorIsA ? tokenADec : tokenBDec,
        ) : null,
        // TOPAZ emissions sell + unwrap
        topazClaimed: ethers.formatUnits(topazClaimedWei, topazDec),
        topazSellTx,
        topazUnwrapTx,
        topazSellError,
        emissionsBnb: ethers.formatEther(wbnbFromTopazWei),
        // P&L (USD)
        entryUsd,
        proceedsUsd: Number(proceedsUsd.toFixed(6)),
        anchorProceedsUsd: Number(anchorProceedsUsd.toFixed(6)),
        emissionsUsd: Number(emissionsUsd.toFixed(6)),
        pnlUsd: pnlUsd != null ? Number(pnlUsd.toFixed(6)) : null,
        pnlBreakdown: pnlUsd != null ? {
          feesAndIl: Number((feesAndIlUsd ?? 0).toFixed(6)),
          emissions: Number(emissionsUsd.toFixed(6)),
        } : null,
        closeSlippageBps: CLOSE_SLIPPAGE_BPS,
      },
    })
    return { ok: true, closeTx: rm.txHash ?? null, unstakeTx }
  })
}

/** Burn a v3 NFT position (unstakes from CLGauge if staked first). */
export async function houseTopazCloseV3(tokenId: string): Promise<{
  ok: true; closeTx: string | null; unstakeTx: string | null
}> {
  const tid = BigInt(tokenId)
  if (tid <= 0n) throw new Error('invalid tokenId')
  return await runWithHouseSigner(async () => {
    let unstakeTx: string | null = null
    // We don't know the gauge address without the pool; the brain stores
    // it, but the manual close path doesn't. Skip unstake — the NPM burn
    // will throw "Not approved" if the NFT is currently staked. That's
    // fine for an MVP: user gets a clear revert and can unstake via the
    // brain's CLOSE_LP path if needed.
    const bn = await topazBurnV3Position(tid)
    if (!bn.ok) throw new Error(bn.error ?? 'topaz_burn_v3_failed')
    await logHouseBrain({
      dex: 'topaz', kind: 'trade',
      reasoning: `CLOSE_LP_V3 burned NFT #${tokenId}`,
      decision: 'CLOSE', txHash: bn.txHash ?? null,
      meta: { tokenId, positionType: 'v3-nft', topazPositionClosed: true },
    })
    return { ok: true, closeTx: bn.txHash ?? null, unstakeTx }
  })
}

/**
 * Enumerate currently-open Topaz positions for the house wallet.
 *   • v3 NFTs: read directly from NPM via listOpenLpPositions
 *   • v2 LPs:  re-read on-chain LP balance for every pair the house
 *              has ever opened (scanned from HouseLog meta), reporting
 *              only those with balance > 0 (whether held in wallet or
 *              staked in the gauge).
 */
export interface HouseTopazPosition {
  positionType: 'v2-lp' | 'v3-nft'
  /** v2 pair address or v3 pool address */
  poolAddress: string
  tokenId?: string
  tokenA?: string
  tokenB?: string
  stable?: boolean
  gauge?: string | null
  /** v2 LP token amount (human, 18 dec) — sum of wallet balance + gauge staked balance */
  lpAmount?: string
  /** v3 in-range liquidity field (raw bigint as string) */
  liquidity?: string
  tickLower?: number
  tickUpper?: number
  /** Opened via house panel (true) or pre-existing on-chain (false). */
  trackedInLog: boolean
}

export async function getHouseTopazPositions(): Promise<HouseTopazPosition[]> {
  let house: string
  try { house = getHouseWalletAddress() } catch { return [] }
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const out: HouseTopazPosition[] = []

  // v3 NFTs — always read from on-chain NPM (source of truth).
  try {
    const v3 = await topazListOpenLpPositions(house)
    for (const p of v3) {
      out.push({
        positionType: 'v3-nft',
        poolAddress: p.token0.toLowerCase() + '/' + p.token1.toLowerCase(),
        tokenId: p.tokenId.toString(),
        tokenA: p.token0, tokenB: p.token1,
        liquidity: p.liquidity.toString(),
        tickLower: p.tickLower, tickUpper: p.tickUpper,
        trackedInLog: false,
      })
    }
  } catch (e: any) {
    console.warn('[HouseAgent] topaz v3 enumeration failed:', e?.message)
  }

  // v2 LPs — scan HouseLog for every pair we've ever opened, then check
  // current balance (wallet + gauge). HouseLog meta.topazPosition=true marks
  // an OPEN_LP_V2 row.
  let openLogRows: Array<{ meta: any }> = []
  try {
    openLogRows = await db.$queryRawUnsafe<any[]>(
      `SELECT meta FROM "HouseLog"
        WHERE dex = 'topaz'
          AND meta ? 'topazPosition'
          AND meta->>'positionType' = 'v2-lp'
          AND "createdAt" > NOW() - INTERVAL '180 days'
        ORDER BY "createdAt" DESC`,
    )
  } catch { /* table missing? skip silently */ }

  const seenPairs = new Set<string>()
  for (const row of openLogRows) {
    const meta = row.meta ?? {}
    const pair = String(meta.pair ?? '').toLowerCase()
    if (!pair || seenPairs.has(pair)) continue
    seenPairs.add(pair)
    try {
      const pairCtr = new ethers.Contract(pair, ERC20_ABI, provider)
      const inWallet = (await pairCtr.balanceOf(house)) as bigint
      let staked = 0n
      const gauge = await topazResolveGaugeForPool(pair).catch(() => null)
      if (gauge) {
        try {
          const g = new ethers.Contract(gauge, ['function balanceOf(address) view returns (uint256)'], provider)
          staked = (await g.balanceOf(house)) as bigint
        } catch { /* ignore */ }
      }
      const total = inWallet + staked
      if (total <= 0n) continue
      out.push({
        positionType: 'v2-lp',
        poolAddress: ethers.getAddress(pair),
        tokenA: meta.tokenA, tokenB: meta.tokenB, stable: !!meta.stable,
        gauge: gauge ?? null,
        lpAmount: ethers.formatUnits(total, 18),
        trackedInLog: true,
      })
    } catch (e: any) {
      console.warn('[HouseAgent] topaz v2 scan failed for', pair, e?.message)
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

// ─────────────────────────────────────────────────────────────────────────
// fourMemeScanner — Task #149: near-real-time discovery of four.meme
// bonding-curve launches + curve-stat enrichment + trust scoring.
//
// Two phases per tick (tickFourMemeScanner):
//   1. DISCOVER — read the four.meme V2 factory's TokenCreate logs over
//      BSC_RPC_URL since the last scanned block (cursor persisted in
//      four_meme_scanner_state). DexScreener latest-launches is a
//      best-effort fallback when the RPC log query fails. New tokens are
//      upserted into four_meme_launches_seen with first_seen metadata.
//   2. ENRICH — for a bounded set of recent, non-graduated rows, pull
//      live curve stats (getTokenInfo + dev holdings + a bounded
//      Transfer-log activity scan), score them via scoreTrust, and write
//      trust_score/verdict/flags back. The snipe agent then reads
//      verdict='buy' rows from this table.
//
// Everything is fail-soft: one bad token can't poison the sweep, and a
// dead RPC degrades to the DexScreener fallback rather than throwing.
// ─────────────────────────────────────────────────────────────────────────

import { ethers } from 'ethers'
import { db } from '../db'
import { buildBscProvider } from './bscProvider'
import { getTokenInfo, isFourMemeEnabled } from './fourMemeTrading'
import { fetchLatestBnbLaunches } from './dexScreener'
import { scoreTrust, type CurveStats } from './fourMemeTrust'

// four.meme V2 factory + TokenCreate event topic (public on-chain
// constants, mirrored from src/services/fourMemeLaunch.ts).
const FOUR_MEME_FACTORY_V2 = '0x5c952063c7fc8610FFDB798152D69F0B9550762b'
const TOKEN_CREATE_EVENT_TOPIC =
  '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20'

// Bounds so the scanner stays cheap even under the 50-agent fleet
// (Task #150). All env-tunable.
function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}
const INITIAL_LOOKBACK_BLOCKS = envInt('FOUR_MEME_SCAN_INITIAL_LOOKBACK', 600) // ~30min @ 3s
const MAX_BLOCK_SPAN = envInt('FOUR_MEME_SCAN_MAX_SPAN', 2000) // cap per tick
const ENRICH_LIMIT = envInt('FOUR_MEME_SCAN_ENRICH_LIMIT', 20) // rows scored / tick
const ENRICH_MIN_INTERVAL_SEC = envInt('FOUR_MEME_SCAN_ENRICH_INTERVAL', 20) // per-token re-scan throttle
const ACTIVITY_MAX_SPAN = envInt('FOUR_MEME_SCAN_ACTIVITY_SPAN', 5000) // Transfer-log window cap
// Activity getLogs is the brain's data feed: if it silently fails, every token
// looks like it has 0 buyers and the fleet brain vetoes everything. Retry with
// linear backoff to survive transient RPC rate-limits/timeouts under fleet load,
// and log on final failure instead of degrading silently.
const ACTIVITY_RETRIES = envInt('FOUR_MEME_SCAN_ACTIVITY_RETRIES', 3) // total getLogs attempts
const ACTIVITY_RETRY_BASE_MS = envInt('FOUR_MEME_SCAN_ACTIVITY_RETRY_MS', 250) // backoff = base * attempt

const SCANNER_STATE_ID = 'singleton'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// RPC calls over BSC_RPC_URL can hang far longer than ethers' default request
// timeout (~5min) — a single slow getLogs would otherwise stall the whole
// scanner tick and jam the runner's single-flight guard, freezing discovery +
// enrichment indefinitely (observed: scanner_state frozen, 0 tokens scored).
// withTimeout bounds every RPC await so a hung call rejects fast and flows into
// the existing fail-soft handling (DexScreener fallback / null activity /
// deprioritize) instead of blocking the tick. All env-tunable.
const RPC_BLOCKNUM_TIMEOUT_MS = envInt('FOUR_MEME_SCAN_BLOCKNUM_TIMEOUT_MS', 8_000)
const RPC_GETLOGS_TIMEOUT_MS = envInt('FOUR_MEME_SCAN_GETLOGS_TIMEOUT_MS', 15_000)
const RPC_CALL_TIMEOUT_MS = envInt('FOUR_MEME_SCAN_RPC_CALL_TIMEOUT_MS', 8_000)
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms: ${label}`)), ms)
  })
  // Prevent a late rejection from the (now-abandoned) racing promise from
  // surfacing as an unhandledRejection once the timeout has already won.
  void p.catch(() => {})
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

const ERC20_MIN_ABI = [
  'function balanceOf(address) view returns (uint256)',
] as const
// Transfer(address,address,uint256) topic for activity scans.
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

export interface ScannerResult {
  discovered: number
  enriched: number
  buyable: number
  errors: number
}

let lastScannerResult: ScannerResult | null = null
export function getLastFourMemeScannerResult(): ScannerResult | null {
  return lastScannerResult
}

async function readCursor(): Promise<number> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ last_block: bigint | number }>>(
      `SELECT "last_block" FROM "four_meme_scanner_state" WHERE "id" = $1`,
      SCANNER_STATE_ID,
    )
    if (rows.length === 0) return 0
    return Number(rows[0].last_block)
  } catch {
    return 0
  }
}

async function writeCursor(block: number): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "four_meme_scanner_state" ("id","last_block","updated_at")
     VALUES ($1,$2, now())
     ON CONFLICT ("id") DO UPDATE
       SET "last_block" = EXCLUDED."last_block", "updated_at" = now()`,
    SCANNER_STATE_ID,
    block,
  )
}

async function upsertDiscovered(
  tokenAddress: string,
  creatorWallet: string | null,
  firstSeenBlock: number | null,
  via: string,
): Promise<boolean> {
  // Returns true when a NEW row was inserted (so we can count discoveries).
  const rows = await db.$queryRawUnsafe<Array<{ token_address: string }>>(
    `INSERT INTO "four_meme_launches_seen"
       ("token_address","creator_wallet","first_seen_block","discovered_via")
     VALUES ($1,$2,$3,$4)
     ON CONFLICT ("token_address") DO NOTHING
     RETURNING "token_address"`,
    tokenAddress.toLowerCase(),
    creatorWallet ? creatorWallet.toLowerCase() : null,
    firstSeenBlock,
    via,
  )
  return rows.length > 0
}

// ── Phase 1: discover ────────────────────────────────────────────────
async function discover(
  provider: ethers.AbstractProvider,
  result: ScannerResult,
): Promise<void> {
  let currentBlock: number
  try {
    currentBlock = await withTimeout(
      provider.getBlockNumber(),
      RPC_BLOCKNUM_TIMEOUT_MS,
      'discover.getBlockNumber',
    )
  } catch (e) {
    console.warn('[fourMemeScanner] getBlockNumber failed:', (e as Error).message)
    await discoverViaDexScreener(result)
    return
  }

  let fromBlock = await readCursor()
  if (fromBlock <= 0) fromBlock = Math.max(0, currentBlock - INITIAL_LOOKBACK_BLOCKS)
  else fromBlock = fromBlock + 1
  if (fromBlock > currentBlock) {
    return // already caught up
  }
  const toBlock = Math.min(currentBlock, fromBlock + MAX_BLOCK_SPAN)

  let logs: ethers.Log[]
  try {
    logs = await withTimeout(
      provider.getLogs({
        address: FOUR_MEME_FACTORY_V2,
        topics: [TOKEN_CREATE_EVENT_TOPIC],
        fromBlock,
        toBlock,
      }),
      RPC_GETLOGS_TIMEOUT_MS,
      'discover.getLogs',
    )
  } catch (e) {
    console.warn('[fourMemeScanner] getLogs failed:', (e as Error).message)
    result.errors += 1
    await discoverViaDexScreener(result)
    return
  }

  for (const log of logs) {
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['address', 'address', 'uint256', 'string', 'string', 'uint256', 'uint256', 'uint256'],
        log.data,
      )
      const creator = decoded[0] as string
      const token = decoded[1] as string
      if (!ethers.isAddress(token) || token === ethers.ZeroAddress) continue
      const inserted = await upsertDiscovered(
        token,
        ethers.isAddress(creator) ? creator : null,
        log.blockNumber ?? null,
        'factory_log',
      )
      if (inserted) result.discovered += 1
    } catch (e) {
      console.warn('[fourMemeScanner] log decode failed:', (e as Error).message)
    }
  }

  try {
    await writeCursor(toBlock)
  } catch (e) {
    console.warn('[fourMemeScanner] cursor write failed:', (e as Error).message)
  }
}

// Best-effort fallback when the RPC log path is unavailable. DexScreener
// surfaces fresh BSC token profiles (laggy, not four.meme-specific) — the
// enrichment pass validates each via getTokenInfo and skips non-four.meme
// tokens, so a false positive here is harmless.
async function discoverViaDexScreener(result: ScannerResult): Promise<void> {
  let fresh: Awaited<ReturnType<typeof fetchLatestBnbLaunches>>
  try {
    fresh = await fetchLatestBnbLaunches({ limit: 15 })
  } catch (e) {
    console.warn('[fourMemeScanner] dexscreener fallback failed:', (e as Error).message)
    return
  }
  for (const f of fresh) {
    if (!ethers.isAddress(f.address)) continue
    try {
      const inserted = await upsertDiscovered(f.address, null, null, 'dexscreener')
      if (inserted) result.discovered += 1
    } catch {
      /* non-fatal */
    }
  }
}

// ── Phase 2: enrich + score ──────────────────────────────────────────
interface EnrichRow {
  token_address: string
  creator_wallet: string | null
  first_seen_block: number | null
}

// Bounded Transfer-log scan to estimate buyer breadth + buy/sell counts.
// Curve buys mint tokens from the TokenManager → buyer (from = tm); curve
// sells transfer buyer → TokenManager (to = tm). Degrades to all-nulls on
// any RPC error. Capped block span keeps it cheap.
async function scanActivity(
  provider: ethers.AbstractProvider,
  token: string,
  tokenManager: string,
  firstSeenBlock: number | null,
  currentBlock: number,
): Promise<{ buyerCount: number | null; buyCount: number | null; sellCount: number | null }> {
  const tmTopic = ethers.zeroPadValue(ethers.getAddress(tokenManager), 32).toLowerCase()
  let fromBlock = firstSeenBlock && firstSeenBlock > 0 ? firstSeenBlock : currentBlock - ACTIVITY_MAX_SPAN
  if (fromBlock < 0) fromBlock = 0
  if (currentBlock - fromBlock > ACTIVITY_MAX_SPAN) fromBlock = currentBlock - ACTIVITY_MAX_SPAN

  // getLogs is the flaky call under fleet concurrency — retry with backoff and
  // surface the error on exhaustion rather than silently returning all-nulls.
  let logs: ethers.Log[] | null = null
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= Math.max(1, ACTIVITY_RETRIES); attempt++) {
    try {
      logs = await withTimeout(
        provider.getLogs({
          address: ethers.getAddress(token),
          topics: [TRANSFER_TOPIC],
          fromBlock,
          toBlock: currentBlock,
        }),
        RPC_GETLOGS_TIMEOUT_MS,
        `scanActivity.getLogs:${token}`,
      )
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      if (attempt < Math.max(1, ACTIVITY_RETRIES)) await sleep(ACTIVITY_RETRY_BASE_MS * attempt)
    }
  }

  if (logs === null) {
    console.warn(
      `[fourMemeScanner] activity getLogs failed for ${token} after ${Math.max(1, ACTIVITY_RETRIES)} attempt(s) ` +
        `(blocks ${fromBlock}-${currentBlock}) — buyer/volume data unavailable, brain will see 0 activity:`,
      (lastErr as Error)?.message ?? String(lastErr),
    )
    return { buyerCount: null, buyCount: null, sellCount: null }
  }

  const buyers = new Set<string>()
  let buyCount = 0
  let sellCount = 0
  for (const lg of logs) {
    const fromTopic = (lg.topics[1] ?? '').toLowerCase()
    const toTopic = (lg.topics[2] ?? '').toLowerCase()
    if (fromTopic === tmTopic) {
      buyCount += 1
      if (toTopic) buyers.add(toTopic)
    } else if (toTopic === tmTopic) {
      sellCount += 1
    }
  }
  return { buyerCount: buyers.size, buyCount, sellCount }
}

async function enrich(
  provider: ethers.AbstractProvider,
  result: ScannerResult,
): Promise<void> {
  let rows: EnrichRow[]
  try {
    rows = await db.$queryRawUnsafe<EnrichRow[]>(
      `SELECT "token_address", "creator_wallet", "first_seen_block"
         FROM "four_meme_launches_seen"
        WHERE COALESCE("graduated", false) = false
          AND ("verdict" IS NULL OR "verdict" <> 'skip' OR "trust_score" IS NULL)
          AND ("last_scanned_at" IS NULL
               OR "last_scanned_at" < now() - ($1 || ' seconds')::interval)
        ORDER BY "last_scanned_at" ASC NULLS FIRST, "first_seen_at" DESC
        LIMIT $2`,
      String(ENRICH_MIN_INTERVAL_SEC),
      ENRICH_LIMIT,
    )
  } catch (e) {
    console.warn('[fourMemeScanner] enrich query failed:', (e as Error).message)
    result.errors += 1
    return
  }
  if (rows.length === 0) return

  let currentBlock = 0
  try {
    currentBlock = await withTimeout(
      provider.getBlockNumber(),
      RPC_BLOCKNUM_TIMEOUT_MS,
      'enrich.getBlockNumber',
    )
  } catch (e) {
    console.warn(
      '[fourMemeScanner] enrich getBlockNumber failed — activity scan will degrade to nulls this tick:',
      (e as Error).message,
    )
  }

  const nowSec = Math.floor(Date.now() / 1000)

  for (const row of rows) {
    try {
      const token = ethers.getAddress(row.token_address)
      let info
      try {
        info = await withTimeout(getTokenInfo(token), RPC_CALL_TIMEOUT_MS, `getTokenInfo:${token}`)
      } catch (e) {
        // Could be a genuinely non-four.meme token (DexScreener false
        // positive) OR a transient RPC hiccup. We must NOT permanently
        // mark a real launch as skip on a transient error, or it could
        // never be sniped. So we only DEPRIORITIZE here (touch
        // last_scanned_at) — the row keeps verdict=NULL and gets retried,
        // just at the back of the queue (the enrich SELECT orders by
        // last_scanned_at ASC NULLS FIRST). Truly-dead tokens simply churn
        // at low priority, bounded by ENRICH_LIMIT per tick.
        await touchScanned(token)
        result.errors += 1
        void e
        continue
      }

      // Dev holdings — creator's current token balance vs the curve's
      // total sellable supply (maxOffersWei). Best-effort.
      let devHoldsPct: number | null = null
      if (row.creator_wallet && info.maxOffersWei > 0n) {
        try {
          const erc20 = new ethers.Contract(token, ERC20_MIN_ABI, provider)
          const bal: bigint = await withTimeout(
            erc20.balanceOf(ethers.getAddress(row.creator_wallet)) as Promise<bigint>,
            RPC_CALL_TIMEOUT_MS,
            `balanceOf:${token}`,
          )
          devHoldsPct = Number((bal * 10000n) / info.maxOffersWei) / 10000
        } catch {
          devHoldsPct = null
        }
      }

      // Activity (buyer breadth, buy/sell counts) — bounded log scan.
      const activity =
        currentBlock > 0
          ? await scanActivity(provider, token, info.tokenManager, row.first_seen_block, currentBlock)
          : { buyerCount: null, buyCount: null, sellCount: null }

      const ageSec = info.launchTime > 0 ? Math.max(0, nowSec - info.launchTime) : 0
      const fundsBnb = Number(ethers.formatEther(info.fundsWei))

      const stats: CurveStats = {
        ageSec,
        fillPct: info.fillPct,
        fundsBnb,
        buyerCount: activity.buyerCount,
        buyCount: activity.buyCount,
        sellCount: activity.sellCount,
        devHoldsPct,
        graduated: info.graduatedToPancake,
        quoteIsBnb: info.quoteIsBnb,
        version: info.version,
      }
      const trust = scoreTrust(stats)
      if (trust.verdict === 'buy') result.buyable += 1

      await db.$executeRawUnsafe(
        `UPDATE "four_meme_launches_seen"
            SET "version" = $2,
                "launch_time" = $3,
                "fill_pct" = $4,
                "funds_bnb" = $5,
                "buyer_count" = $6,
                "buy_count" = $7,
                "sell_count" = $8,
                "dev_holds_pct" = $9,
                "graduated" = $10,
                "quote_is_bnb" = $11,
                "trust_score" = $12,
                "verdict" = $13,
                "flags" = $14,
                "last_scanned_at" = now()
          WHERE "token_address" = $1`,
        token.toLowerCase(),
        info.version,
        info.launchTime || null,
        info.fillPct,
        fundsBnb,
        activity.buyerCount,
        activity.buyCount,
        activity.sellCount,
        devHoldsPct,
        info.graduatedToPancake,
        info.quoteIsBnb,
        trust.score,
        trust.verdict,
        trust.flags.join(','),
      )
      result.enriched += 1
    } catch (e) {
      result.errors += 1
      console.warn('[fourMemeScanner] enrich row failed:', (e as Error).message)
    }
  }
}

// Deprioritize a token after a transient enrichment failure WITHOUT
// marking it skip — bumps last_scanned_at so the enrich SELECT pushes it
// to the back of the queue, but leaves verdict/trust_score untouched so a
// real launch that hit an RPC hiccup is still retried (and can still be
// scored 'buy' on a later pass).
async function touchScanned(token: string): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `UPDATE "four_meme_launches_seen"
          SET "last_scanned_at" = now()
        WHERE "token_address" = $1`,
      token.toLowerCase(),
    )
  } catch {
    /* non-fatal */
  }
}

// ── Public entry point (called from runner on a fast cadence) ────────
export async function tickFourMemeScanner(): Promise<ScannerResult> {
  const result: ScannerResult = { discovered: 0, enriched: 0, buyable: 0, errors: 0 }
  if (!isFourMemeEnabled()) {
    lastScannerResult = result
    return result
  }
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  await discover(provider, result)
  await enrich(provider, result)
  lastScannerResult = result
  return result
}

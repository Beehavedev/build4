// Listing / delisting detector — polls Aster's exchangeInfo every 60s and
// emits events the runner uses to (a) broadcast Telegram alerts to active
// users and (b) feed the agent watchlist. New listings on Aster typically
// move 50-200% in the first hour, so detecting them within 60s gives our
// agents a real edge over manual traders reading the @Aster_DEX tweet.
//
// Cost: one HTTP call/min to a public, uncached endpoint. No LLM. No DB.

import axios from 'axios'

export type ListingEventType = 'NEW_LISTING' | 'DELISTING' | 'REDUCE_ONLY'

export interface ListingEvent {
  type: ListingEventType
  symbol: string
  detectedAt: number
  onboardDate?: number
  deliveryDate?: number
}

interface SymbolInfo {
  symbol: string
  status: string
  quoteAsset: string
  onboardDate?: number
  deliveryDate?: number
}

// In-process state. Survives until the worker restarts.
let knownPairs = new Set<string>()
let firstScanDone = false
// Dedup REDUCE_ONLY alerts — a pair stays in SETTLING/BREAK for the entire
// reduce-only window (often days), so without dedup we'd spam the same
// "delisting soon" alert every minute until it's actually removed.
const alertedReduceOnly = new Set<string>()
// Track when each currently-tradable USDT pair was first listed (epoch ms).
// Used by isNewlyListed() so the TA scorer can skip pairs without enough
// kline history. Built from exchangeInfo.onboardDate.
const onboardDates = new Map<string, number>()

const NEW_LISTING_WINDOW_MS = 48 * 60 * 60 * 1000 // 48h
const NEWLY_LISTED_GRACE_MS = 2 * 60 * 60 * 1000 // 2h — too fresh for TA

// Base watchlist scanned every tick by the AUTO-mode pair scorer.
const BASE_WATCHLIST = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ASTERUSDT', 'AVAXUSDT',
  'LINKUSDT', 'ARBUSDT'
]

async function fetchExchangeInfo(): Promise<SymbolInfo[]> {
  const res = await axios.get('https://fapi.asterdex.com/fapi/v1/exchangeInfo', {
    timeout: 8000
  })
  return (res.data?.symbols ?? []) as SymbolInfo[]
}

// Compares the current Aster pair set against what we saw last tick and
// returns events for anything that changed. The first call after process
// start ALWAYS returns an empty list — we just snapshot the baseline,
// otherwise every existing pair would look "new" on cold start.
export async function checkForListingChanges(): Promise<ListingEvent[]> {
  let symbols: SymbolInfo[]
  try {
    symbols = await fetchExchangeInfo()
  } catch (err: any) {
    console.error('[Listing] exchangeInfo fetch failed:', err?.message ?? err)
    return []
  }

  const events: ListingEvent[] = []
  const currentPairs = new Set<string>()

  for (const s of symbols) {
    if (s.quoteAsset !== 'USDT') continue
    currentPairs.add(s.symbol)
    if (s.onboardDate) onboardDates.set(s.symbol, s.onboardDate)

    if (firstScanDone && !knownPairs.has(s.symbol)) {
      events.push({
        type: 'NEW_LISTING',
        symbol: s.symbol,
        detectedAt: Date.now(),
        onboardDate: s.onboardDate
      })
      console.log(`[Listing] 🚀 NEW LISTING: ${s.symbol}`)
    }

    if ((s.status === 'SETTLING' || s.status === 'PENDING_TRADING' || s.status === 'BREAK')
        && !alertedReduceOnly.has(s.symbol)) {
      alertedReduceOnly.add(s.symbol)
      // On the very first scan, seed the dedup set silently — every
      // already-reducing pair is "old news" and shouldn't fire an alert.
      if (firstScanDone) {
        events.push({
          type: 'REDUCE_ONLY',
          symbol: s.symbol,
          detectedAt: Date.now(),
          deliveryDate: s.deliveryDate
        })
        console.log(`[Listing] ⚠️ REDUCE_ONLY: ${s.symbol}`)
      }
    }
  }

  if (firstScanDone) {
    for (const known of knownPairs) {
      if (!currentPairs.has(known)) {
        events.push({ type: 'DELISTING', symbol: known, detectedAt: Date.now() })
        console.log(`[Listing] 🔴 DELISTED: ${known}`)
      }
    }
  }

  knownPairs = currentPairs
  firstScanDone = true
  return events
}

// Pairs onboarded within the last 48h that are currently TRADING. These
// are prime targets — fresh listings see explosive volume and the agents
// should always be looking at them.
export async function getRecentNewListings(): Promise<string[]> {
  try {
    const symbols = await fetchExchangeInfo()
    const cutoff = Date.now() - NEW_LISTING_WINDOW_MS
    const out: string[] = []
    for (const s of symbols) {
      if (s.quoteAsset !== 'USDT') continue
      if (s.status !== 'TRADING') continue
      if (!s.onboardDate || s.onboardDate <= cutoff) continue
      out.push(s.symbol)
      onboardDates.set(s.symbol, s.onboardDate)
    }
    return out
  } catch {
    return []
  }
}

// Single source of truth for the AUTO-mode scanner: base watchlist plus
// any recent new listings, deduped. Called once per agent tick.
export async function getActiveWatchlist(): Promise<string[]> {
  const recent = await getRecentNewListings()
  return Array.from(new Set([...BASE_WATCHLIST, ...recent]))
}

// True if the symbol was first listed less than NEWLY_LISTED_GRACE_MS ago.
// The TA scorer needs ~100 candles of history; pairs younger than this
// don't have enough data, so the scanner should treat them as "always
// scan" momentum candidates instead of trying to score them.
export function isNewlyListed(symbol: string): boolean {
  const onboard = onboardDates.get(symbol)
  if (!onboard) return false
  return Date.now() - onboard < NEWLY_LISTED_GRACE_MS
}

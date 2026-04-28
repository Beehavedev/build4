// Hyperliquid-native watchlist scanner.
//
// The original AUTO-mode scanner (pickTopWatchlistPairs in tradingAgent.ts)
// pulls candles from Aster's REST API and scores setups against THAT
// orderbook. For agents trading on HL, that's the wrong source — same
// ticker, different liquidity, different price action, sometimes the
// asset doesn't even exist on the other venue (HYPE, KAITO, etc).
//
// This module mirrors the same scoring shape (deterministic TA, no LLM)
// but feeds it HL candles via getCandles(). The scoring function is
// imported back from tradingAgent so we stay in lockstep — if we tune
// the score thresholds there, HL inherits them automatically.
//
// Phase 1 uses a curated focus list of high-liquidity HL perps. The
// natural follow-up (Phase 1.5) is to discover the universe dynamically
// from HL's meta + 24h volume; the curated list keeps the surface area
// small for the first ship and avoids hammering HL for candle data on
// 200+ low-volume listings every minute.

import { getCandles } from './hyperliquid'
import type { OHLCV } from '../agents/indicators'

// Curated list of HL perps with meaningful liquidity as of late April 2026.
// Order isn't significant — every entry is fetched in parallel and ranked
// by setup score. HL-exclusive symbols (HYPE, KAITO, FARTCOIN) are the
// real reason we have a separate scanner — they don't exist on Aster so
// the cross-venue Aster scan can never pick them up.
//
// Symbols are bare (HL convention) — getCandles strips USDT suffixes
// internally so passing 'BTC' or 'BTCUSDT' both work, but bare is the
// canonical HL form.
const HL_FOCUS_PAIRS: string[] = [
  'BTC', 'ETH', 'SOL',
  'HYPE', 'KAITO', 'FARTCOIN',
  'XRP', 'DOGE', 'AVAX', 'SUI',
  'TIA', 'WIF', 'LINK', 'ARB',
]

// Cheap in-memory cache so concurrent agents scanning the same minute
// share one HL fetch per symbol per timeframe. 60s TTL matches the
// existing Aster kline cache shape.
interface CacheEntry { at: number; ohlcv: OHLCV }
const _hlKlineCache = new Map<string, CacheEntry>()
const HL_CACHE_TTL_MS = 60_000

async function getCachedHlOhlcv(symbol: string, interval: string): Promise<OHLCV> {
  const key = `${symbol}|${interval}`
  const hit = _hlKlineCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < HL_CACHE_TTL_MS) return hit.ohlcv
  const candles = await getCandles(symbol, interval, 100)
  // Convert HL candle shape → OHLCV shape used by indicator helpers.
  // Indicator helpers consume parallel arrays; HL returns row objects.
  const ohlcv: OHLCV = {
    open:   candles.map(c => c.open),
    high:   candles.map(c => c.high),
    low:    candles.map(c => c.low),
    close:  candles.map(c => c.close),
    volume: candles.map(c => c.volume),
  }
  _hlKlineCache.set(key, { at: now, ohlcv })
  return ohlcv
}

// Scan the curated HL focus list, score each pair using the SAME setup
// scorer as the Aster scanner (imported from tradingAgent), and return
// the top-N pairs that clear the minimum quality bar.
//
// Returned symbols are bare HL form ('BTC', 'HYPE'). The caller is
// expected to feed these straight back into HL helpers (getCandles,
// getMarkPrice, executeOpenHl) which all accept either form.
//
// Uses the project's existing scoreSetup() so any change to the trading
// quality bar applies symmetrically across venues.
export async function pickTopHlPairs(
  n: number,
): Promise<Array<{ symbol: string; score: number }>> {
  // Lazy import avoids a circular dependency with tradingAgent (which
  // imports this module from inside its AUTO scan branch).
  const { scoreSetup, WATCHLIST_MIN_SCORE } = await import('../agents/tradingAgent')
  const results = await Promise.all(
    HL_FOCUS_PAIRS.map(async (symbol) => {
      try {
        const [m15, h1] = await Promise.all([
          getCachedHlOhlcv(symbol, '15m'),
          getCachedHlOhlcv(symbol, '1h'),
        ])
        // Need enough candles for the scorer to compute ADX(14)+RSI(14).
        // HL occasionally returns short series for newly-listed perps.
        if (m15.close.length < 30 || h1.close.length < 20) return null
        const score = scoreSetup(m15, h1)
        return { symbol, score }
      } catch {
        return null
      }
    })
  )
  return results
    .filter((r): r is { symbol: string; score: number } => !!r)
    .filter((r) => r.score >= WATCHLIST_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, n))
}

// Test-only seam: lets unit tests pre-populate the cache so they don't
// have to hit the live HL API. Not exported to production callers.
export function _resetHlKlineCache(): void {
  _hlKlineCache.clear()
}

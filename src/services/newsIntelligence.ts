import axios from 'axios'
import Parser from 'rss-parser'
import { runNewsInference } from './inference'

const parser = new Parser({ timeout: 8000 })

// News sentiment routing lives in inference.runNewsInference: Akash
// llama-3-70b primary, Sonnet fallback only on 401/402/403 or
// circuit-open. Cheap by ~50× vs Sonnet for an equivalent classification.

const processedItems = new Set<string>()
let latestSignal: NewsSignal | null = null
let newsLastUpdated = 0

const RSS_FEEDS = [
  'https://cointelegraph.com/rss',
  'https://coindesk.com/arc/outboundfeeds/rss/',
  'https://decrypt.co/feed'
]

export interface NewsSignal {
  sentiment: 'STRONGLY_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONGLY_BEARISH'
  score: number
  topHeadline: string
  affectedCoins: string[]
  isBreaking: boolean
  shouldOverride: boolean
  action: 'BUY' | 'SELL' | 'HOLD' | 'EMERGENCY_CLOSE'
  reason: string
}

const NEUTRAL: NewsSignal = {
  sentiment: 'NEUTRAL',
  score: 0,
  topHeadline: '',
  affectedCoins: [],
  isBreaking: false,
  shouldOverride: false,
  action: 'HOLD',
  reason: ''
}

export function getNewsLastUpdated(): number {
  return newsLastUpdated
}

// ─────────────────────────────────────────────────────────────────────
// Meme-narrative news lane (additive — does not affect fetchNewsSignal)
//
// fetchNewsSignal above is BTC/ETH macro-heavy because the RSS feeds
// (CoinDesk / CoinTelegraph / Decrypt) cover the whole crypto market
// and are dominated by big-cap headlines like "Strategy buys $43M BTC"
// or "ETF inflows hit record". The four.meme launch agent doesn't care
// about that — it cares about meme-coin narratives, new launches,
// degen platform momentum, and altseason chatter.
//
// This function pulls the SAME RSS pool but keyword-filters for meme/
// launch/narrative terms, then ranks by keyword-hit count. Returns the
// top N filtered headlines. No LLM call (the agent's main brain LLM
// already digests these alongside its other sources, no need to spend
// extra Claude tokens classifying sentiment here).
//
// Cost: zero — RSS only, no API key, no LLM. Uses the same parser
// timeout (8s). Failures degrade silently.
// ─────────────────────────────────────────────────────────────────────

const MEME_KEYWORDS = [
  // direct
  'meme', 'memecoin', 'memecoins', 'shitcoin', 'degen',
  // platforms
  'four.meme', 'fourmeme', 'pump.fun', 'pumpfun',
  // chains the meme economy lives on
  'bsc', 'bnb chain', 'binance smart chain', 'solana memes',
  // narrative tags the meme market reacts to
  'launch', 'new token', 'altseason', 'community token', 'fair launch',
  // bellwether tickers — when these are in headlines, the meme tape moves
  'pepe', 'wif', 'bonk', 'doge', 'shib', 'floki', 'brett', 'popcat',
]

export interface MemeNewsHeadline {
  title: string
  source: string             // RSS feed hostname (e.g. "cointelegraph.com")
  matchedKeywords: string[]  // which MEME_KEYWORDS hit (lowercased)
  publishedAt: string | null // ISO when parseable
}

export interface MemeNewsSignal {
  headlines: MemeNewsHeadline[]   // top-ranked, max `limit`
  totalScanned: number            // total RSS items considered
  totalMatched: number            // how many matched at least one keyword
  sources: string[]               // distinct RSS hostnames that contributed
}

const memeNewsCache: { signal: MemeNewsSignal | null; at: number } = { signal: null, at: 0 }
const MEME_NEWS_CACHE_MS = 60_000

export async function fetchMemeNarrativeNews(opts: { limit?: number } = {}): Promise<MemeNewsSignal> {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 5))
  if (memeNewsCache.signal && Date.now() - memeNewsCache.at < MEME_NEWS_CACHE_MS) {
    return { ...memeNewsCache.signal, headlines: memeNewsCache.signal.headlines.slice(0, limit) }
  }

  const collected: MemeNewsHeadline[] = []
  const sourcesSeen = new Set<string>()
  let totalScanned = 0

  await Promise.allSettled(
    RSS_FEEDS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url)
        const host = new URL(url).hostname.replace(/^www\./, '')
        for (const item of feed.items.slice(0, 25)) {
          const title = (item.title ?? '').trim()
          if (!title) continue
          totalScanned++
          const lower = title.toLowerCase()
          const hits = MEME_KEYWORDS.filter((k) => lower.includes(k))
          if (hits.length === 0) continue
          sourcesSeen.add(host)
          collected.push({
            title,
            source: host,
            matchedKeywords: hits,
            publishedAt: typeof item.isoDate === 'string' ? item.isoDate
                       : typeof item.pubDate === 'string' ? item.pubDate
                       : null,
          })
        }
      } catch {
        // RSS feed down — silently skip, same pattern as fetchNewsSignal.
      }
    })
  )

  // Rank: more keyword hits first, then more recent (when both have a date).
  collected.sort((a, b) => {
    const k = b.matchedKeywords.length - a.matchedKeywords.length
    if (k !== 0) return k
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0
    return tb - ta
  })

  // Cache the FULL collected list so a later caller with a larger
  // `limit` gets the headlines it asked for (not the slice the first
  // caller happened to use). Today every caller uses limit:5, but
  // this keeps the helper safe to share across future call sites.
  const cachedSignal: MemeNewsSignal = {
    headlines: collected,
    totalScanned,
    totalMatched: collected.length,
    sources: Array.from(sourcesSeen),
  }
  memeNewsCache.signal = cachedSignal
  memeNewsCache.at = Date.now()
  return { ...cachedSignal, headlines: collected.slice(0, limit) }
}

export async function fetchNewsSignal(): Promise<NewsSignal> {
  // 60s cache: one Claude call per minute shared across ALL agents.
  if (latestSignal && Date.now() - newsLastUpdated < 60_000) {
    return latestSignal
  }

  const headlines: string[] = []

  await Promise.allSettled(
    RSS_FEEDS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url)
        for (const item of feed.items.slice(0, 5)) {
          if (item.title && !processedItems.has(item.title)) {
            processedItems.add(item.title)
            headlines.push(item.title)
          }
        }
      } catch {
        // RSS feed down — silently skip
      }
    })
  )

  // CryptoPanic is optional; missing token still lets the call attempt
  // their public free tier, but don't block the analysis if it 401s.
  try {
    const cp = await axios.get('https://cryptopanic.com/api/v1/posts/', {
      params: {
        auth_token: process.env.CRYPTOPANIC_TOKEN || 'free',
        filter: 'hot',
        kind: 'news',
        limit: 10
      },
      timeout: 5000
    })
    const items = cp.data?.results
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item?.title && !processedItems.has(item.title)) {
          processedItems.add(item.title)
          headlines.push(item.title)
        }
      }
    }
  } catch {
    // CryptoPanic free-tier rate limits aggressively — silently skip
  }

  // Bound the dedupe set so it doesn't grow unbounded across many days.
  if (processedItems.size > 1000) {
    const arr = Array.from(processedItems)
    processedItems.clear()
    arr.slice(-500).forEach((t) => processedItems.add(t))
  }

  if (headlines.length === 0) {
    latestSignal = { ...NEUTRAL, reason: 'No news' }
    newsLastUpdated = Date.now()
    return latestSignal
  }

  const prompt =
    `You are a crypto market news analyst. Analyze these headlines and determine market impact.\n\n` +
    `Headlines:\n${headlines.slice(0, 15).map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\n` +
    `Respond ONLY with JSON:\n` +
    `{\n` +
    `  "sentiment": "STRONGLY_BULLISH|BULLISH|NEUTRAL|BEARISH|STRONGLY_BEARISH",\n` +
    `  "score": <number -10 to 10>,\n` +
    `  "topHeadline": "<most impactful headline>",\n` +
    `  "affectedCoins": ["BTC", "ETH", ...],\n` +
    `  "isBreaking": <true if major breaking news>,\n` +
    `  "shouldOverride": <true if news so significant it overrides technicals>,\n` +
    `  "action": "BUY|SELL|HOLD|EMERGENCY_CLOSE",\n` +
    `  "reason": "<one sentence explanation>"\n` +
    `}`

  try {
    const r = await runNewsInference({
      user: prompt,
      jsonMode: true,
      maxTokens: 400,
      temperature: 0.3,
      timeoutMs: 20_000,
    })
    const parsed = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as NewsSignal
    if (!parsed.sentiment || typeof parsed.score !== 'number') {
      throw new Error('Bad LLM JSON shape')
    }
    latestSignal = {
      sentiment: parsed.sentiment,
      score: parsed.score,
      topHeadline: parsed.topHeadline ?? '',
      affectedCoins: parsed.affectedCoins ?? [],
      isBreaking: !!parsed.isBreaking,
      shouldOverride: !!parsed.shouldOverride,
      action: parsed.action ?? 'HOLD',
      reason: parsed.reason ?? ''
    }
    newsLastUpdated = Date.now()
    return latestSignal
  } catch (err: any) {
    console.error('[News] Analysis failed:', err?.message ?? err)
    latestSignal = { ...NEUTRAL, reason: 'News analysis failed' }
    newsLastUpdated = Date.now()
    return latestSignal
  }
}

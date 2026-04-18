import axios from 'axios'
import Parser from 'rss-parser'
import Anthropic from '@anthropic-ai/sdk'

const parser = new Parser({ timeout: 8000 })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as NewsSignal
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

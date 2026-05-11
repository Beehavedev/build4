// twexApi — thin client for twexapi.io (https://docs.twitterxapi.com)
//
// We use this as the X/Twitter narrative source for the four.meme
// launch agent. It is an unofficial scraper-backed API ($0.14 / 1000
// tweets) — explicitly chosen over the official paid X API.
//
// Auth: Bearer <TWEXAPI_KEY>. Base: https://api.twexapi.io.
// Endpoint we use: POST /twitter/advanced_search
//   body: { searchTerms: string[], maxItems: number, sortBy: 'Latest'|'Top' }
//   resp: { code, msg, data: TweetModel[] }
//
// Failure modes degrade to null so the agent's allSettled gather
// keeps the other narrative sources alive. Never throws.

const TWEXAPI_BASE = 'https://api.twexapi.io'
const FETCH_TIMEOUT_MS = 8_000

export interface XTweetLite {
  text: string
  author: string             // screen_name without @
  followers: number          // 0 when unknown
  likes: number
  retweets: number
  replies: number
  views: number              // 0 when unknown
  createdAt: string | null   // ISO when parseable, else raw string, else null
  url: string | null
}

export interface XSignal {
  // Compact snapshot of the chatter the agent will see this tick.
  query: string              // joined searchTerms (for logging)
  totalReturned: number      // number of tweets the API returned
  topTweets: XTweetLite[]    // up to N tweets, sorted by engagement desc
  totalEngagement: number    // sum(likes+retweets+replies) across topTweets
}

// Pull up to `maxItems` recent X posts matching ANY of `searchTerms`.
// Returns null on auth/network failure (so the agent can degrade
// to its other sources via Promise.allSettled).
//
// IMPORTANT: pricing is $0.14 / 1000 items, so we keep maxItems small
// (default 30). The agent only needs a "what's chattering" snapshot,
// not exhaustive coverage.
export async function fetchXSignal(
  searchTerms: string[],
  opts: {
    maxItems?: number
    sortBy?: 'Latest' | 'Top'
    apiKey?: string
    fetchImpl?: typeof fetch
    topN?: number
  } = {},
): Promise<XSignal | null> {
  const apiKey = opts.apiKey ?? process.env.TWEXAPI_KEY
  if (!apiKey) {
    console.warn('[twexApi] TWEXAPI_KEY missing — X signal disabled')
    return null
  }
  const terms = (searchTerms ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
  if (terms.length === 0) return null
  const maxItems = Math.max(1, Math.min(100, opts.maxItems ?? 30))
  const sortBy = opts.sortBy ?? 'Top'
  const topN = Math.max(1, Math.min(10, opts.topN ?? 5))
  const fetchImpl = opts.fetchImpl ?? fetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetchImpl(`${TWEXAPI_BASE}/twitter/advanced_search`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify({ searchTerms: terms, maxItems, sortBy }),
      signal: controller.signal,
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      console.warn(`[twexApi] HTTP ${r.status} on advanced_search: ${txt.slice(0, 200)}`)
      return null
    }
    const j: any = await r.json().catch(() => null)
    if (!j || j.code && j.code !== 200) {
      console.warn(`[twexApi] non-200 envelope: code=${j?.code} msg=${j?.msg}`)
      return null
    }
    const raw: any[] = Array.isArray(j.data) ? j.data : []
    const lite: XTweetLite[] = raw.map(normalizeTweet).filter((t): t is XTweetLite => t !== null)

    // Rank by engagement so the prompt only sees the loudest signals,
    // not noise/bots. Engagement = likes + retweets + replies (views
    // is unreliable on the unofficial API).
    lite.sort((a, b) => engagementScore(b) - engagementScore(a))
    const topTweets = lite.slice(0, topN)
    const totalEngagement = topTweets.reduce((s, t) => s + engagementScore(t), 0)

    return {
      query: terms.join(' | ').slice(0, 200),
      totalReturned: lite.length,
      topTweets,
      totalEngagement,
    }
  } catch (err) {
    console.warn('[twexApi] fetch failed:', (err as Error).message)
    return null
  } finally {
    clearTimeout(timer)
  }
}

function engagementScore(t: XTweetLite): number {
  return (t.likes ?? 0) + (t.retweets ?? 0) + (t.replies ?? 0)
}

// twexapi.io's TweetModel shape varies a bit between endpoint versions,
// so we extract defensively across known field names. Returns null when
// we can't even pull a text body — those rows are useless to the LLM.
function normalizeTweet(raw: any): XTweetLite | null {
  if (!raw || typeof raw !== 'object') return null
  const text = String(
    raw.text ?? raw.full_text ?? raw.fullText ?? raw.content ?? '',
  ).trim()
  if (!text) return null
  const author = String(
    raw.author?.userName ?? raw.author?.screen_name ?? raw.user?.screen_name ??
    raw.username ?? raw.screenName ?? '',
  ).replace(/^@/, '').trim()
  const followers = Number(
    raw.author?.followers ?? raw.author?.followers_count ?? raw.user?.followers_count ?? 0,
  ) || 0
  const likes = Number(raw.likeCount ?? raw.favorite_count ?? raw.likes ?? 0) || 0
  const retweets = Number(raw.retweetCount ?? raw.retweet_count ?? raw.retweets ?? 0) || 0
  const replies = Number(raw.replyCount ?? raw.reply_count ?? raw.replies ?? 0) || 0
  const views = Number(raw.viewCount ?? raw.view_count ?? raw.views ?? 0) || 0
  const createdRaw = raw.createdAt ?? raw.created_at ?? null
  let createdAt: string | null = null
  if (typeof createdRaw === 'string' && createdRaw.length > 0) {
    const d = new Date(createdRaw)
    createdAt = isNaN(d.getTime()) ? createdRaw : d.toISOString()
  }
  const id = raw.id ?? raw.id_str ?? null
  const url = author && id ? `https://x.com/${author}/status/${id}` : (raw.url ?? null)
  return { text, author, followers, likes, retweets, replies, views, createdAt, url }
}

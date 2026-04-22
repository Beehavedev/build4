/**
 * News fetcher for the market-creator agent. Uses GNews (free tier:
 * 100 req/day) when GNEWS_API_KEY is set.
 *
 * Quietly returns [] when the key is missing — news is one of several
 * candidate sources, not a hard requirement, so the agent should still
 * run on token signals alone.
 */

const GNEWS_BASE = 'https://gnews.io/api/v4/search'
const FETCH_TIMEOUT_MS = 8_000

// Source authority weights, used by the scorer to discount blogspam vs
// newsroom output. Anything not in this map gets the default of 5 (low).
const SOURCE_AUTHORITY: Record<string, number> = {
  'reuters.com': 25,
  'bloomberg.com': 25,
  'apnews.com': 25,
  'wsj.com': 22,
  'ft.com': 22,
  'nytimes.com': 22,
  'cnbc.com': 18,
  'theguardian.com': 18,
  'bbc.com': 18,
  'bbc.co.uk': 18,
  'theblock.co': 16,
  'coindesk.com': 16,
  'cointelegraph.com': 14,
  'decrypt.co': 14,
  'techcrunch.com': 14,
  'theverge.com': 12,
  'wired.com': 12,
  'arstechnica.com': 12,
}

export interface NewsSignal {
  title: string
  description: string
  url: string
  source: string                // domain
  authority: number             // 0-25 — used by scorer
  publishedAt: string           // ISO
  imageUrl: string | null
}

interface GNewsArticle {
  title?: string
  description?: string
  url?: string
  image?: string | null
  publishedAt?: string
  source?: { name?: string; url?: string }
}

/**
 * Search trending news in the last `lookbackHours`. Returns the top N by
 * source authority, deduplicated by title. Returns [] when GNEWS_API_KEY
 * is not configured.
 */
export async function fetchTrendingNews(
  opts: {
    lookbackHours?: number
    limit?: number
    fetchImpl?: typeof fetch
  } = {},
): Promise<NewsSignal[]> {
  const apiKey = process.env.GNEWS_API_KEY
  if (!apiKey) {
    console.log('[newsService] GNEWS_API_KEY not set — skipping news signal')
    return []
  }
  const lookbackHours = opts.lookbackHours ?? 6
  const limit = opts.limit ?? 10
  const fetchImpl = opts.fetchImpl ?? fetch

  // Topic query — bias toward what 42.space markets are good at: AI, crypto,
  // geopolitics, finance milestones, big-tech announcements.
  const query = '(AI OR crypto OR bitcoin OR ethereum OR geopolitics OR election OR Fed OR OpenAI OR Anthropic)'
  const fromIso = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString()
  const url = `${GNEWS_BASE}?q=${encodeURIComponent(query)}&lang=en&max=25&from=${fromIso}&sortby=publishedAt&apikey=${apiKey}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetchImpl(url, { signal: controller.signal })
    if (!r.ok) {
      console.warn(`[newsService] HTTP ${r.status}`)
      return []
    }
    const json = (await r.json()) as { articles?: GNewsArticle[] }
    const articles = json.articles ?? []

    // De-dup by lowercased title (some outlets republish wire copy).
    const seen = new Set<string>()
    const signals: NewsSignal[] = []
    for (const a of articles) {
      if (!a.title || !a.url) continue
      const key = a.title.toLowerCase().trim()
      if (seen.has(key)) continue
      seen.add(key)
      const domain = extractDomain(a.source?.url ?? a.url)
      signals.push({
        title: a.title,
        description: a.description ?? '',
        url: a.url,
        source: domain,
        authority: SOURCE_AUTHORITY[domain] ?? 5,
        publishedAt: a.publishedAt ?? new Date().toISOString(),
        imageUrl: a.image ?? null,
      })
    }
    signals.sort((x, y) => y.authority - x.authority)
    return signals.slice(0, limit)
  } catch (err) {
    console.warn('[newsService] fetch failed:', (err as Error).message)
    return []
  } finally {
    clearTimeout(timer)
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'unknown'
  }
}

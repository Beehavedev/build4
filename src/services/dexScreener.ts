/**
 * DexScreener client — surfaces high-volume BNB Chain tokens that the
 * market-creator agent uses as candidate signals for prediction markets.
 *
 * Free public API, no key required. Docs: https://docs.dexscreener.com/api/reference
 *
 * We hit the boost/trending endpoint then filter by volume/liquidity to
 * weed out fresh-launch rugs. Quietly returns [] if the API is unreachable
 * — research loop must degrade gracefully when one source is offline.
 */

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const FETCH_TIMEOUT_MS = 8_000

export interface DexToken {
  address: string
  symbol: string
  name: string
  priceUsd: number
  priceChange24h: number
  volume24hUsd: number
  liquidityUsd: number
  fdvUsd: number | null
  pairCreatedAt: number | null  // ms epoch — null when DexScreener doesn't return one
  pairUrl: string
}

interface RawPair {
  baseToken?: { address?: string; symbol?: string; name?: string }
  priceUsd?: string
  priceChange?: { h24?: number }
  volume?: { h24?: number }
  liquidity?: { usd?: number }
  fdv?: number
  pairCreatedAt?: number
  url?: string
  chainId?: string
}

/**
 * Fetch trending BSC tokens, filter to tokens with real volume + liquidity
 * + at least 24h of trading history (rough rug filter).
 *
 * Defaults match the market-creator spec:
 *   - volume24h > $500k
 *   - liquidity > $100k
 *   - pair age > 24h (where DexScreener exposes pairCreatedAt)
 *
 * Returns top N by 24h volume.
 */
export async function fetchTrendingBNBTokens(
  opts: {
    minVolume24h?: number
    minLiquidity?: number
    minAgeMs?: number
    limit?: number
    fetchImpl?: typeof fetch
  } = {},
): Promise<DexToken[]> {
  const minVolume24h = opts.minVolume24h ?? 500_000
  const minLiquidity = opts.minLiquidity ?? 100_000
  const minAgeMs = opts.minAgeMs ?? 24 * 60 * 60 * 1000
  const limit = opts.limit ?? 15
  const fetchImpl = opts.fetchImpl ?? fetch

  // Boosted/trending endpoint — returns curated lists. We then enrich each
  // result via the per-pair endpoint to get full volume/liquidity figures.
  const url = `${DEXSCREENER_BASE}/token-boosts/top/v1`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let boosted: Array<{ tokenAddress?: string; chainId?: string }> = []
  try {
    const r = await fetchImpl(url, { signal: controller.signal })
    if (!r.ok) {
      console.warn(`[dexScreener] boosts endpoint HTTP ${r.status}`)
      return []
    }
    boosted = (await r.json()) as typeof boosted
  } catch (err) {
    console.warn('[dexScreener] boosts fetch failed:', (err as Error).message)
    return []
  } finally {
    clearTimeout(timer)
  }

  // Filter to BSC chain only.
  const bscTokens = boosted.filter((b) => b.chainId === 'bsc' && b.tokenAddress)

  // Enrich each token with full pair stats via /tokens/v1/bsc/{address}.
  // Bound concurrency by chunking — DexScreener throttles aggressive callers.
  const enriched: DexToken[] = []
  const chunkSize = 5
  for (let i = 0; i < bscTokens.length; i += chunkSize) {
    const chunk = bscTokens.slice(i, i + chunkSize)
    const results = await Promise.all(
      chunk.map((b) => fetchTokenPair(b.tokenAddress!, fetchImpl).catch(() => null)),
    )
    for (const t of results) if (t) enriched.push(t)
  }

  const now = Date.now()
  const filtered = enriched.filter(
    (t) =>
      t.volume24hUsd >= minVolume24h &&
      t.liquidityUsd >= minLiquidity &&
      // Only enforce age when we have a creation timestamp; not all pairs do.
      (t.pairCreatedAt === null || now - t.pairCreatedAt >= minAgeMs),
  )
  filtered.sort((a, b) => b.volume24hUsd - a.volume24hUsd)
  return filtered.slice(0, limit)
}

/** Fetch the best pair for a single token address on BSC. */
async function fetchTokenPair(
  tokenAddress: string,
  fetchImpl: typeof fetch,
): Promise<DexToken | null> {
  const url = `${DEXSCREENER_BASE}/tokens/v1/bsc/${tokenAddress}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetchImpl(url, { signal: controller.signal })
    if (!r.ok) return null
    const pairs = (await r.json()) as RawPair[]
    if (!Array.isArray(pairs) || pairs.length === 0) return null
    // Highest-liquidity pair is our representative price/volume source.
    const best = pairs.reduce((a, b) =>
      (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a,
    )
    if (!best.baseToken?.address || !best.baseToken.symbol) return null
    return {
      address: best.baseToken.address,
      symbol: best.baseToken.symbol,
      name: best.baseToken.name ?? best.baseToken.symbol,
      priceUsd: parseFloat(best.priceUsd ?? '0') || 0,
      priceChange24h: best.priceChange?.h24 ?? 0,
      volume24hUsd: best.volume?.h24 ?? 0,
      liquidityUsd: best.liquidity?.usd ?? 0,
      fdvUsd: best.fdv ?? null,
      pairCreatedAt: best.pairCreatedAt ?? null,
      pairUrl: best.url ?? '',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

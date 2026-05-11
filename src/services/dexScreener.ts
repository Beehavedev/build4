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

// ── Fresh BNB launches (Demo Day — four.meme launch agent input) ────
//
// "What new BSC tokens just appeared on DexScreener?" The agent uses
// this as a trend-shift signal — when 5+ fresh tokens appear with the
// same theme in the same hour, the meme is already cooking and the
// agent should think about whether to ride or fade.
//
// We use DexScreener's /token-profiles/latest/v1 endpoint (public,
// no auth) which returns the most recently profiled tokens across
// every chain, then filter to BSC. Quietly returns [] on failure.
export interface FreshBnbLaunch {
  address: string
  symbol: string         // empty when DexScreener hasn't indexed the pair yet
  description: string    // free-text from the token profile (often empty)
  links: Array<{ label: string; url: string }>  // socials + website if profiled
  iconUrl: string | null
  url: string            // dexscreener.com link
}

export async function fetchLatestBnbLaunches(
  opts: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<FreshBnbLaunch[]> {
  const limit = opts.limit ?? 10
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${DEXSCREENER_BASE}/token-profiles/latest/v1`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetchImpl(url, { signal: controller.signal })
    if (!r.ok) {
      console.warn(`[dexScreener] latest profiles HTTP ${r.status}`)
      return []
    }
    const raw = (await r.json()) as any[]
    if (!Array.isArray(raw)) return []
    const out: FreshBnbLaunch[] = []
    for (const p of raw) {
      if (p?.chainId !== 'bsc' || !p?.tokenAddress) continue
      out.push({
        address: String(p.tokenAddress),
        symbol: String(p.symbol ?? p.header ?? '').slice(0, 20),
        description: String(p.description ?? '').slice(0, 240),
        links: Array.isArray(p.links)
          ? p.links.slice(0, 4).map((l: any) => ({
              label: String(l?.label ?? l?.type ?? 'link').slice(0, 20),
              url: String(l?.url ?? '').slice(0, 200),
            })).filter((l: any) => l.url)
          : [],
        iconUrl: typeof p.icon === 'string' ? p.icon : null,
        url: typeof p.url === 'string' ? p.url : `https://dexscreener.com/bsc/${p.tokenAddress}`,
      })
      if (out.length >= limit) break
    }
    return out
  } catch (err) {
    console.warn('[dexScreener] latest launches fetch failed:', (err as Error).message)
    return []
  } finally {
    clearTimeout(timer)
  }
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

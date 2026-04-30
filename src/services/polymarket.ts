// ─────────────────────────────────────────────────────────────────────────────
// Polymarket integration — Builder Program citizen.
//
// BUILD4 routes prediction-market orders through Polymarket's CLOB v2 with
// our `builderCode` attached, so every matched trade accrues to our profile
// for the Builder Leaderboard, Verified-tier review, weekly USDC rewards
// and grant eligibility:
//   https://docs.polymarket.com/builders/overview
//   https://docs.polymarket.com/builders/tiers
//
// PHASE 1 (this file): read-only market data via the public Gamma API
// (events / markets) and CLOB API (orderbook / midpoint / price). No SDK,
// no signing, no env-var requirements — Phase 1 surfaces are a public
// /predict tab so the 42.space team and Polymarket reviewers can preview
// our integration before any real orders flow.
//
// PHASE 2 onwards: switch to `@polymarket/clob-client-v2` +
// `@polymarket/builder-relayer-client` for Safe-wallet (signature type 2)
// gasless trading with `builderCode` attached on every order. The config
// module below already reads POLY_BUILDER_CODE from env so Phase 2 can
// thread it through createAndPostOrder() without touching this file.
// ─────────────────────────────────────────────────────────────────────────────

const GAMMA_BASE = 'https://gamma-api.polymarket.com'
const CLOB_BASE  = 'https://clob.polymarket.com'

// ─── Builder Program config (populated by env). Optional in Phase 1. ───
//
// POLY_BUILDER_CODE is the bytes32 identifier from
// polymarket.com/settings?tab=builder. Attached to every order we submit
// in Phase 2+ via the `builderCode` field on createAndPostOrder().
//
// Read once at module load so the rest of the codebase can import a
// constant rather than re-reading env on every call.
export const polymarketConfig = Object.freeze({
  builderCode: (process.env.POLY_BUILDER_CODE ?? '').trim() || null,
  builderAddress: (process.env.POLY_BUILDER_ADDRESS ?? '').trim() || null,
  // Phase 2: relayer key for gasless Safe wallet ops
  relayerApiKey: (process.env.POLY_RELAYER_API_KEY ?? '').trim() || null,
})

// ─── Gamma API types — only the fields we actually use downstream. ───
//
// Note: outcomes / outcomePrices / clobTokenIds are JSON-stringified
// arrays in the wire response. We parse them once in `normaliseMarket`
// so consumers always get real arrays/numbers.

export interface PolymarketMarket {
  id: string
  conditionId: string
  question: string
  slug: string
  description: string | null
  endDate: string | null
  image: string | null
  icon: string | null
  active: boolean
  closed: boolean
  archived: boolean
  enableOrderBook: boolean
  negRisk: boolean
  outcomes: string[]               // e.g. ["Yes", "No"]
  outcomePrices: number[]          // last-known prices, same indexing as outcomes
  clobTokenIds: string[]           // ERC1155 token IDs, same indexing as outcomes
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
  lastTradePrice: number | null
  volume: number
  liquidity: number
  orderPriceMinTickSize: number | null
  orderMinSize: number | null
}

export interface PolymarketEvent {
  id: string
  slug: string
  title: string
  description: string | null
  endDate: string | null
  startDate: string | null
  image: string | null
  icon: string | null
  active: boolean
  closed: boolean
  archived: boolean
  restricted: boolean
  liquidity: number
  volume: number
  volume24hr: number
  openInterest: number
  enableOrderBook: boolean
  negRisk: boolean
  markets: PolymarketMarket[]
}

// ─── Internal helpers ───

function toNumber(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function nullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return Number.isFinite(n) ? n : null
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function normaliseMarket(raw: any): PolymarketMarket {
  const outcomes = parseJsonArray<string>(raw.outcomes)
  const outcomePricesRaw = parseJsonArray<string | number>(raw.outcomePrices)
  const outcomePrices = outcomePricesRaw.map((p) => toNumber(p, 0))
  const clobTokenIds = parseJsonArray<string>(raw.clobTokenIds)
  return {
    id: String(raw.id ?? ''),
    conditionId: String(raw.conditionId ?? ''),
    question: String(raw.question ?? ''),
    slug: String(raw.slug ?? ''),
    description: raw.description ?? null,
    endDate: raw.endDate ?? null,
    image: raw.image ?? null,
    icon: raw.icon ?? null,
    active: !!raw.active,
    closed: !!raw.closed,
    archived: !!raw.archived,
    enableOrderBook: !!raw.enableOrderBook,
    negRisk: !!raw.negRisk,
    outcomes,
    outcomePrices,
    clobTokenIds,
    bestBid: nullableNumber(raw.bestBid),
    bestAsk: nullableNumber(raw.bestAsk),
    spread: nullableNumber(raw.spread),
    lastTradePrice: nullableNumber(raw.lastTradePrice),
    volume: toNumber(raw.volumeNum ?? raw.volume, 0),
    liquidity: toNumber(raw.liquidityNum ?? raw.liquidity, 0),
    orderPriceMinTickSize: nullableNumber(raw.orderPriceMinTickSize),
    orderMinSize: nullableNumber(raw.orderMinSize),
  }
}

function normaliseEvent(raw: any): PolymarketEvent {
  return {
    id: String(raw.id ?? ''),
    slug: String(raw.slug ?? ''),
    title: String(raw.title ?? ''),
    description: raw.description ?? null,
    endDate: raw.endDate ?? null,
    startDate: raw.startDate ?? null,
    image: raw.image ?? null,
    icon: raw.icon ?? null,
    active: !!raw.active,
    closed: !!raw.closed,
    archived: !!raw.archived,
    restricted: !!raw.restricted,
    liquidity: toNumber(raw.liquidity, 0),
    volume: toNumber(raw.volume, 0),
    volume24hr: toNumber(raw.volume24hr, 0),
    openInterest: toNumber(raw.openInterest, 0),
    enableOrderBook: !!raw.enableOrderBook,
    negRisk: !!raw.negRisk,
    markets: Array.isArray(raw.markets) ? raw.markets.map(normaliseMarket) : [],
  }
}

async function gammaGet<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const qs = new URLSearchParams()
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue
      qs.set(k, String(v))
    }
  }
  const url = `${GAMMA_BASE}${path}${qs.toString() ? `?${qs.toString()}` : ''}`
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    // Polymarket Gamma can be slow on the first request after a deploy;
    // a 12s timeout matches what we use for HL info calls.
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gamma ${res.status}: ${body.slice(0, 160)}`)
  }
  return res.json() as Promise<T>
}

async function clobGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams()
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue
      qs.set(k, String(v))
    }
  }
  const url = `${CLOB_BASE}${path}${qs.toString() ? `?${qs.toString()}` : ''}`
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`CLOB ${res.status}: ${body.slice(0, 160)}`)
  }
  return res.json() as Promise<T>
}

// ─── Public read-only API (Phase 1) ───

export interface ListEventsOpts {
  limit?: number          // default 20, max 100
  tagId?: number          // filter by Gamma tag id (e.g. crypto, sports)
  order?: 'volume24hr' | 'volume' | 'liquidity' | 'endDate' | 'startDate'
  ascending?: boolean
  closed?: boolean        // default false
  active?: boolean        // default true
}

/**
 * List Polymarket events with their child markets, sorted by 24h volume by
 * default. Each market includes bestBid / bestAsk / spread / lastTradePrice
 * straight from Gamma — no extra CLOB calls needed for the list view.
 */
export async function listEvents(opts: ListEventsOpts = {}): Promise<PolymarketEvent[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20))
  const raw = await gammaGet<any[]>('/events', {
    limit,
    active: opts.active ?? true,
    closed: opts.closed ?? false,
    order: opts.order ?? 'volume24hr',
    ascending: opts.ascending ?? false,
    tag_id: opts.tagId,
  })
  if (!Array.isArray(raw)) return []
  return raw.map(normaliseEvent)
}

/** Fetch a single event by its slug. Returns null if not found / closed. */
export async function getEventBySlug(slug: string): Promise<PolymarketEvent | null> {
  const raw = await gammaGet<any[]>('/events', { slug })
  if (!Array.isArray(raw) || raw.length === 0) return null
  return normaliseEvent(raw[0])
}

export interface OrderbookLevel {
  price: number
  size: number
}

export interface PolymarketOrderbook {
  tokenId: string
  market: string                  // condition id
  // Sorted high → low (best bid first)
  bids: OrderbookLevel[]
  // Sorted low → high (best ask first)
  asks: OrderbookLevel[]
  midPrice: number | null
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
  lastTradePrice: number | null
  tickSize: number | null
  minOrderSize: number | null
  negRisk: boolean
  timestamp: number               // server timestamp (ms)
  hash: string                    // Polymarket book hash for change detection
}

/**
 * Fetch a single token's orderbook. Used when the user expands a market
 * to see depth. Polymarket returns bids ascending (worst → best) and asks
 * ascending (best → worst); we re-sort so the BEST is always at index 0
 * of each array, which matches every other venue surface in BUILD4.
 */
export async function getOrderbook(tokenId: string): Promise<PolymarketOrderbook> {
  const raw = await clobGet<any>('/book', { token_id: tokenId })
  const rawBids = Array.isArray(raw.bids) ? raw.bids : []
  const rawAsks = Array.isArray(raw.asks) ? raw.asks : []
  const bids: OrderbookLevel[] = rawBids
    .map((b: any) => ({ price: toNumber(b.price), size: toNumber(b.size) }))
    .filter((l: OrderbookLevel) => l.size > 0)
    .sort((a: OrderbookLevel, b: OrderbookLevel) => b.price - a.price)
  const asks: OrderbookLevel[] = rawAsks
    .map((a: any) => ({ price: toNumber(a.price), size: toNumber(a.size) }))
    .filter((l: OrderbookLevel) => l.size > 0)
    .sort((a: OrderbookLevel, b: OrderbookLevel) => a.price - b.price)
  const bestBid = bids.length > 0 ? bids[0].price : null
  const bestAsk = asks.length > 0 ? asks[0].price : null
  const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null
  const tsMs = (() => {
    const t = toNumber(raw.timestamp, 0)
    if (t === 0) return Date.now()
    // Polymarket returns seconds, not milliseconds.
    return t < 1e12 ? Math.round(t * 1000) : t
  })()
  return {
    tokenId,
    market: String(raw.market ?? ''),
    bids,
    asks,
    midPrice,
    bestBid,
    bestAsk,
    spread,
    lastTradePrice: nullableNumber(raw.last_trade_price),
    tickSize: nullableNumber(raw.tick_size),
    minOrderSize: nullableNumber(raw.min_order_size),
    negRisk: !!raw.neg_risk,
    timestamp: tsMs,
    hash: String(raw.hash ?? ''),
  }
}

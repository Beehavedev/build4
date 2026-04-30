import { useEffect, useRef, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────
// PredictionsPolymarket — Phase 1 read-only surface for the Polymarket
// venue, mounted inside Predictions.tsx alongside the existing 42.space
// section. Two server endpoints back this view:
//   GET /api/polymarket/events             → trending events (15s server cache)
//   GET /api/polymarket/orderbook/:tokenId → CLOB book on expand (1s cache)
//
// No auth required — all data shown here is already public on
// polymarket.com. Phase 2 will add manual buy/sell + Safe-relayer onboarding;
// Phase 3 the autonomous "polymarket" agent. Builder-code attribution will
// thread through both.
// ─────────────────────────────────────────────────────────────────────────

interface PolyMarket {
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
  outcomes: string[]
  outcomePrices: number[]
  clobTokenIds: string[]
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
  lastTradePrice: number | null
  volume: number
  liquidity: number
  orderPriceMinTickSize: number | null
  orderMinSize: number | null
}

interface PolyEvent {
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
  liquidity: number
  volume: number
  volume24hr: number
  openInterest: number
  enableOrderBook: boolean
  negRisk: boolean
  markets: PolyMarket[]
}

interface EventsResponse {
  events: PolyEvent[]
  cached: boolean
  stale?: boolean
  fetchedAt: number
  builderCode: string | null
}

interface OrderbookLevel { price: number; size: number }
interface OrderbookResponse {
  book: {
    tokenId: string
    market: string
    bids: OrderbookLevel[]
    asks: OrderbookLevel[]
    midPrice: number | null
    bestBid: number | null
    bestAsk: number | null
    spread: number | null
    lastTradePrice: number | null
    tickSize: number | null
    minOrderSize: number | null
    negRisk: boolean
    timestamp: number
    hash: string
  }
  cached: boolean
  stale?: boolean
}

// ─── Formatters ───

function fmtUsdShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function fmtPriceCents(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '—'
  return `${(p * 100).toFixed(1)}¢`
}

function fmtPercent(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '—'
  return `${(p * 100).toFixed(0)}%`
}

function endDateCountdown(iso: string | null): { label: string; color: string } {
  if (!iso) return { label: '—', color: '#64748b' }
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return { label: 'ENDED', color: '#ef4444' }
  const days = Math.floor(ms / (24 * 3600_000))
  const hrs = Math.floor((ms % (24 * 3600_000)) / 3600_000)
  if (days >= 7) return { label: `${days}d`, color: '#94a3b8' }
  if (days >= 1) return { label: `${days}d ${hrs}h`, color: '#f59e0b' }
  const mins = Math.floor((ms % 3600_000) / 60_000)
  return { label: `${hrs}h ${mins}m`, color: '#ef4444' }
}

function relativeTime(ms: number): string {
  if (!ms) return 'Never'
  const diff = Math.max(0, Date.now() - ms)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

// ─── Subcomponents ───

function VenueBadge() {
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: 0.5,
      padding: '2px 6px',
      borderRadius: 4,
      background: '#3b82f622',
      color: '#60a5fa',
      border: '1px solid #3b82f644',
    }} data-testid="badge-venue-poly">POLY</span>
  )
}

function OrderbookPanel({ tokenId, label }: { tokenId: string; label: string }) {
  const [book, setBook] = useState<OrderbookResponse['book'] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function tick() {
      try {
        const r = await fetch(`/api/polymarket/orderbook/${tokenId}`)
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j?.error || `HTTP ${r.status}`)
        }
        const j: OrderbookResponse = await r.json()
        if (cancelled) return
        setBook(j.book)
        setStale(!!j.stale)
        setErr(null)
      } catch (e) {
        if (cancelled) return
        setErr((e as Error).message)
      }
    }
    tick()
    // 1s polling matches HL/Aster cadence — server cache enforces 1s TTL
    // anyway, so client polling at this rate adds no upstream load.
    const id = setInterval(tick, 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [tokenId])

  if (err && !book) {
    return <div style={{ fontSize: 11, color: '#ef4444', padding: 8 }}>Orderbook unavailable: {err}</div>
  }
  if (!book) {
    return <div style={{ fontSize: 11, color: '#64748b', padding: 8 }}>Loading {label} book…</div>
  }

  const topBids = book.bids.slice(0, 5)
  const topAsks = book.asks.slice(0, 5)
  const mid = book.midPrice
  const spreadPct = (book.bestBid && book.bestAsk && book.bestAsk > 0)
    ? ((book.bestAsk - book.bestBid) / book.bestAsk) * 100
    : null

  return (
    <div style={{ marginTop: 6, padding: 8, background: '#0a0a13', borderRadius: 6, border: '1px solid #1e1e2e' }}
         data-testid={`book-${tokenId}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>
          {label} BOOK {stale && <span style={{ color: '#f59e0b' }}>(stale)</span>}
        </span>
        <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'ui-monospace, monospace' }}>
          mid {fmtPriceCents(mid)} · spread {spreadPct !== null ? `${spreadPct.toFixed(2)}%` : '—'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <div style={{ fontSize: 9, color: '#10b981', fontWeight: 600, marginBottom: 3 }}>BIDS</div>
          {topBids.length === 0 && <div style={{ fontSize: 10, color: '#64748b' }}>—</div>}
          {topBids.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontFamily: 'ui-monospace, monospace', color: '#10b981' }}>
              <span>{fmtPriceCents(l.price)}</span>
              <span style={{ color: '#94a3b8' }}>{l.size.toFixed(0)}</span>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontSize: 9, color: '#ef4444', fontWeight: 600, marginBottom: 3 }}>ASKS</div>
          {topAsks.length === 0 && <div style={{ fontSize: 10, color: '#64748b' }}>—</div>}
          {topAsks.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontFamily: 'ui-monospace, monospace', color: '#ef4444' }}>
              <span>{fmtPriceCents(l.price)}</span>
              <span style={{ color: '#94a3b8' }}>{l.size.toFixed(0)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function MarketRow({ market }: { market: PolyMarket }) {
  const [expanded, setExpanded] = useState(false)
  // For 2-outcome markets the YES token is at index 0, NO at index 1.
  // For multi-outcome events each "market" is itself one binary YES/NO.
  const yesPrice = market.bestAsk ?? market.outcomePrices[0] ?? null
  const noPrice  = market.outcomes[1]
    ? (market.bestBid !== null ? 1 - market.bestBid : market.outcomePrices[1] ?? null)
    : null
  const tradeable = market.enableOrderBook && !market.closed && !market.archived
  const yesTokenId = market.clobTokenIds[0] ?? null

  return (
    <div
      style={{
        padding: '8px 10px',
        borderTop: '1px solid #1e1e2e',
      }}
      data-testid={`row-poly-market-${market.id}`}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {market.question}
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 2, display: 'flex', gap: 8 }}>
            <span>vol {fmtUsdShort(market.volume)}</span>
            <span>liq {fmtUsdShort(market.liquidity)}</span>
            {!tradeable && <span style={{ color: '#f59e0b' }}>book closed</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <div
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              background: '#10b98122',
              border: '1px solid #10b98144',
              minWidth: 52,
              textAlign: 'center',
            }}
            data-testid={`price-yes-${market.id}`}
          >
            <div style={{ fontSize: 9, color: '#10b981', fontWeight: 700 }}>YES</div>
            <div style={{ fontSize: 12, color: '#10b981', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>
              {fmtPriceCents(yesPrice)}
            </div>
          </div>
          {noPrice !== null && (
            <div
              style={{
                padding: '4px 8px',
                borderRadius: 4,
                background: '#ef444422',
                border: '1px solid #ef444444',
                minWidth: 52,
                textAlign: 'center',
              }}
              data-testid={`price-no-${market.id}`}
            >
              <div style={{ fontSize: 9, color: '#ef4444', fontWeight: 700 }}>NO</div>
              <div style={{ fontSize: 12, color: '#ef4444', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>
                {fmtPriceCents(noPrice)}
              </div>
            </div>
          )}
          {tradeable && yesTokenId && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              data-testid={`button-expand-poly-${market.id}`}
              style={{
                padding: '4px 8px',
                borderRadius: 4,
                background: expanded ? '#1e1e2e' : '#0f0f17',
                border: '1px solid #1e1e2e',
                color: '#94a3b8',
                fontSize: 10,
                cursor: 'pointer',
              }}
            >
              {expanded ? '×' : 'depth'}
            </button>
          )}
        </div>
      </div>
      {expanded && yesTokenId && <OrderbookPanel tokenId={yesTokenId} label="YES" />}
    </div>
  )
}

function EventCard({ event }: { event: PolyEvent }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? event.markets : event.markets.slice(0, 3)
  const countdown = endDateCountdown(event.endDate)

  return (
    <div
      style={{
        marginBottom: 12,
        background: '#0f0f17',
        border: '1px solid #1e1e2e',
        borderRadius: 8,
        overflow: 'hidden',
      }}
      data-testid={`card-poly-event-${event.id}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10 }}>
        {event.icon && (
          <img
            src={event.icon}
            alt=""
            style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <VenueBadge />
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#e2e8f0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              data-testid={`title-poly-event-${event.id}`}
            >
              {event.title}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: 10, color: '#64748b', marginTop: 4 }}>
            <span>vol24h {fmtUsdShort(event.volume24hr)}</span>
            <span>liq {fmtUsdShort(event.liquidity)}</span>
            <span style={{ color: countdown.color }}>{countdown.label}</span>
          </div>
        </div>
        <a
          href={`https://polymarket.com/event/${event.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`link-poly-event-${event.id}`}
          style={{
            fontSize: 10,
            color: '#94a3b8',
            textDecoration: 'none',
            border: '1px solid #1e1e2e',
            padding: '4px 6px',
            borderRadius: 4,
          }}
        >
          ↗
        </a>
      </div>
      {visible.map((m) => <MarketRow key={m.id} market={m} />)}
      {event.markets.length > 3 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          data-testid={`button-toggle-markets-${event.id}`}
          style={{
            width: '100%',
            padding: '6px 10px',
            background: '#0a0a13',
            border: 'none',
            borderTop: '1px solid #1e1e2e',
            color: '#94a3b8',
            fontSize: 10,
            cursor: 'pointer',
          }}
        >
          {showAll ? `Show fewer · ${event.markets.length - 3} hidden` : `Show all ${event.markets.length} markets`}
        </button>
      )}
    </div>
  )
}

function Skeleton() {
  return (
    <div style={{ marginBottom: 12, background: '#0f0f17', border: '1px solid #1e1e2e', borderRadius: 8, padding: 12 }}>
      <div style={{ height: 14, width: '70%', background: '#1e1e2e', borderRadius: 4, marginBottom: 8 }} />
      <div style={{ height: 10, width: '40%', background: '#1e1e2e', borderRadius: 4 }} />
    </div>
  )
}

// ─── Main component ───

export default function PredictionsPolymarket() {
  const [data, setData] = useState<EventsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inflight = useRef(false)

  async function load(silent = false) {
    if (inflight.current) return
    inflight.current = true
    if (!silent) setRefreshing(true)
    try {
      const r = await fetch('/api/polymarket/events?limit=20')
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j?.error || `HTTP ${r.status}`)
      }
      const j: EventsResponse = await r.json()
      setData(j)
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      inflight.current = false
      setRefreshing(false)
      setLoading(false)
    }
  }

  useEffect(() => {
    load(true)
    // 10s auto-refresh — server caches Gamma at 15s so this just reads
    // local cache most of the time.
    const id = setInterval(() => load(true), 10_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div style={{ paddingTop: 4, paddingBottom: 8 }}>
      {/* Header bar with refresh + builder attribution. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          padding: '10px 12px',
          borderRadius: 8,
          background: '#0f0f17',
          border: '1px solid #1e1e2e',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.3 }}>Polymarket</span>
          <VenueBadge />
          <span
            style={{ fontSize: 10, color: data?.stale ? '#f59e0b' : (err ? '#ef4444' : '#10b981') }}
            data-testid="text-poly-status"
          >
            {err ? 'API DOWN' : data?.stale ? 'STALE' : 'LIVE'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'ui-monospace, monospace' }}>
            {data ? `Updated ${relativeTime(data.fetchedAt)}` : 'Never'}
          </span>
          <button
            type="button"
            onClick={() => load(false)}
            disabled={refreshing}
            data-testid="button-poly-refresh"
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              fontSize: 11,
              background: refreshing ? '#1e1e2e' : '#7c3aed',
              border: '1px solid #7c3aed',
              color: 'white',
              cursor: refreshing ? 'wait' : 'pointer',
            }}
          >
            {refreshing ? '…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Phase-1 banner — sets expectations and surfaces our Builder Program
          attribution. The visible builder code is what reviewers look for
          when validating our integration. */}
      <div
        style={{
          marginBottom: 12,
          padding: '8px 10px',
          borderRadius: 6,
          background: '#3b82f608',
          border: '1px solid #3b82f622',
          fontSize: 10,
          color: '#94a3b8',
          lineHeight: 1.5,
        }}
        data-testid="banner-poly-builder"
      >
        <strong style={{ color: '#60a5fa' }}>Read-only preview.</strong>{' '}
        Trading and AI agents land in Phase 2/3 — every order will route through Polymarket's
        CLOB v2 with our builder code attached for{' '}
        <a
          href="https://docs.polymarket.com/builders/overview"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#60a5fa' }}
        >Builder Program attribution</a>.
        {data?.builderCode && (
          <div style={{ marginTop: 4, fontFamily: 'ui-monospace, monospace', color: '#64748b' }}>
            builder: <span data-testid="text-builder-code">{data.builderCode.slice(0, 10)}…{data.builderCode.slice(-6)}</span>
          </div>
        )}
      </div>

      {err && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 10px',
            borderRadius: 6,
            background: '#ef444411',
            border: '1px solid #ef444433',
            fontSize: 11,
            color: '#fca5a5',
          }}
          data-testid="error-poly"
        >
          Couldn't reach Polymarket: {err}
        </div>
      )}

      {loading && !data && (
        <>
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </>
      )}

      {data && data.events.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
          No active Polymarket events right now.
        </div>
      )}

      {data && data.events.map((e) => <EventCard key={e.id} event={e} />)}
    </div>
  )
}

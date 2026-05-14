import { useEffect, useRef, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────
// PredictionsPolymarket — full Polymarket venue surface. Mounted inside
// Predictions.tsx alongside the 42.space section. Backed by:
//   GET  /api/polymarket/events             → trending events (15s cache)
//   GET  /api/polymarket/orderbook/:tokenId → CLOB book on expand (1s cache)
//   GET  /api/polymarket/wallet             → user's Polygon wallet + creds
//   GET  /api/polymarket/positions          → open + closed positions
//   POST /api/polymarket/setup              → enroll creds + USDC allowance
//   POST /api/polymarket/order              → manual buy/sell (builder-tagged)
//
// Public endpoints (events / orderbook) need no auth. Trading endpoints
// require Telegram auth and route through the user's custodial Polygon
// EOA with our Builder Program code attached to every order.
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

// ─── Phase 2.1 trading types (gasless via Polymarket relayer) ───
// walletAddress = EOA, signs orders. safeAddress = Gnosis Safe proxy that
// holds USDC.e and outcome shares — this is the address the user funds.
interface PolyWalletStatus {
  ok: boolean
  walletAddress: string | null
  safeAddress: string | null
  hasCreds: boolean
  safeDeployed: boolean
  allowanceVerified: boolean
  ready: boolean
  balances: {
    usdc: number
    allowanceCtf: number
    allowanceNeg: number
    allowanceNegAdapter: number
    ctfApprovedCtfExchange: boolean
    ctfApprovedNegExchange: boolean
    ctfApprovedNegAdapter:  boolean
  } | null
  // Custodial EOA balances on Polygon — surfaced so the user can see what
  // we'd sweep with /api/polymarket/fund and whether they hold enough
  // MATIC for the EOA→Safe transfer gas.
  eoaBalances?: { usdcE: number; matic: number } | null
  builderCode: string | null
}

interface PolyPosition {
  id: string
  conditionId: string
  tokenId: string
  marketTitle: string
  outcomeLabel: string
  side: string
  sizeUsdc: number
  entryPrice: number
  fillSize: number | null
  status: string
  errorMessage: string | null
  builderCode: string | null
  openedAt: string
}

// Open trade dialog payload
interface TradeIntent {
  market:       PolyMarket
  outcomeLabel: string  // 'Yes' | 'No' | other
  outcomeIdx:   number
  conditionId:  string
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

function MarketRow({
  market,
  conditionId,
  walletReady,
  onTrade,
}: {
  market: PolyMarket
  conditionId: string
  walletReady: boolean
  onTrade: (intent: TradeIntent) => void
}) {
  const [expanded, setExpanded] = useState(false)
  // For 2-outcome markets the YES token is at index 0, NO at index 1.
  // For multi-outcome events each "market" is itself one binary YES/NO.
  const yesPrice = market.bestAsk ?? market.outcomePrices[0] ?? null
  const noPrice  = market.outcomes[1]
    ? (market.bestBid !== null ? 1 - market.bestBid : market.outcomePrices[1] ?? null)
    : null
  const tradeable = market.enableOrderBook && !market.closed && !market.archived
  const yesTokenId = market.clobTokenIds[0] ?? null
  const noTokenId  = market.clobTokenIds[1] ?? null
  const yesLabel   = market.outcomes[0] ?? 'Yes'
  const noLabel    = market.outcomes[1] ?? 'No'

  return (
    <div
      style={{
        padding: '8px 10px',
        borderTop: '1px solid #1e1e2e',
      }}
      data-testid={`row-poly-market-${market.id}`}
    >
      {/* alignItems flex-start so the BUY YES / BUY NO / depth buttons
          stay top-aligned when the question wraps to 2 lines, instead of
          drifting to the vertical centre and looking misaligned with
          siblings whose questions fit on 1 line. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Polymarket questions average ~60 chars and frequently exceed
              the row's text column, so the previous nowrap+ellipsis
              clipped meaningful content (e.g. "Will the Fed increase
              inte..." → users couldn't tell whether it was rates / by
              how much / by when). Allow up to 2 lines via -webkit-line
              -clamp (Telegram WebView is Chromium/WebKit on both iOS
              and Android), then ellipsis the rest if even 2 lines
              isn't enough. word-break:break-word handles the rare URL
              or unbroken token in a question that would otherwise
              overflow horizontally. */}
          <div
            style={{
              fontSize: 12,
              color: '#e2e8f0',
              lineHeight: 1.3,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
            title={market.question}
          >
            {market.question}
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 2, display: 'flex', gap: 8 }}>
            <span>vol {fmtUsdShort(market.volume)}</span>
            <span>liq {fmtUsdShort(market.liquidity)}</span>
            {!tradeable && <span style={{ color: '#f59e0b' }}>book closed</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            disabled={!tradeable || !walletReady || !yesTokenId}
            onClick={() => yesTokenId && onTrade({ market, outcomeLabel: yesLabel, outcomeIdx: 0, conditionId })}
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              background: '#10b98122',
              border: '1px solid #10b98144',
              minWidth: 52,
              textAlign: 'center',
              cursor: (tradeable && walletReady && yesTokenId) ? 'pointer' : 'not-allowed',
              opacity: (tradeable && walletReady && yesTokenId) ? 1 : 0.55,
              color: 'inherit',
            }}
            data-testid={`button-buy-yes-${market.id}`}
          >
            <div style={{ fontSize: 9, color: '#10b981', fontWeight: 700 }}>BUY YES</div>
            <div style={{ fontSize: 12, color: '#10b981', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>
              {fmtPriceCents(yesPrice)}
            </div>
          </button>
          {noPrice !== null && (
            <button
              type="button"
              disabled={!tradeable || !walletReady || !noTokenId}
              onClick={() => noTokenId && onTrade({ market, outcomeLabel: noLabel, outcomeIdx: 1, conditionId })}
              style={{
                padding: '4px 8px',
                borderRadius: 4,
                background: '#ef444422',
                border: '1px solid #ef444444',
                minWidth: 52,
                textAlign: 'center',
                cursor: (tradeable && walletReady && noTokenId) ? 'pointer' : 'not-allowed',
                opacity: (tradeable && walletReady && noTokenId) ? 1 : 0.55,
                color: 'inherit',
              }}
              data-testid={`button-buy-no-${market.id}`}
            >
              <div style={{ fontSize: 9, color: '#ef4444', fontWeight: 700 }}>BUY NO</div>
              <div style={{ fontSize: 12, color: '#ef4444', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>
                {fmtPriceCents(noPrice)}
              </div>
            </button>
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

function EventCard({
  event,
  walletReady,
  onTrade,
}: {
  event: PolyEvent
  walletReady: boolean
  onTrade: (intent: TradeIntent) => void
}) {
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
          {/* alignItems flex-start so the POLY badge stays aligned to
              the first line of the title when the title wraps. */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <VenueBadge />
            {/* Same rationale as MarketRow's title: Polymarket event
                titles often run 60–80 chars (e.g. "US x Iran ceasefire
                extended by April 21, 2026") and the previous nowrap+
                ellipsis hid the resolution date / amount, leaving users
                staring at "US x Iran ceasefire extended by…" with no
                way to know what they were actually betting on. Allow up
                to 2 lines via -webkit-line-clamp, then ellipsis. */}
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#e2e8f0',
                lineHeight: 1.3,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
              title={event.title}
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
      {visible.map((m) => (
        <MarketRow
          key={m.id}
          market={m}
          conditionId={m.conditionId}
          walletReady={walletReady}
          onTrade={onTrade}
        />
      ))}
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

// ─── Auth helper for protected POST /api/polymarket/* endpoints. The
// requireTgUser middleware verifies a HMAC of Telegram.WebApp.initData,
// so we must pass it on every privileged call. Read-only events/orderbook
// endpoints don't need this.
function tgAuthHeaders(): Record<string, string> {
  const initData = (typeof window !== 'undefined' && (window as any).Telegram?.WebApp?.initData) || ''
  return initData ? { 'x-telegram-init-data': initData } : {}
}

export default function PredictionsPolymarket() {
  const [data, setData] = useState<EventsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inflight = useRef(false)

  // Phase 2 state
  const [wallet, setWallet] = useState<PolyWalletStatus | null>(null)
  const [walletErr, setWalletErr] = useState<string | null>(null)
  const [setupBusy, setSetupBusy] = useState(false)
  const [fundBusy, setFundBusy] = useState(false)
  const [eoaCopied, setEoaCopied] = useState(false)
  const [positions, setPositions] = useState<PolyPosition[]>([])
  const [tradeIntent, setTradeIntent] = useState<TradeIntent | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  function flash(kind: 'ok' | 'err', msg: string) {
    setToast({ kind, msg })
    window.setTimeout(() => setToast(null), 4500)
  }

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

  async function loadWallet() {
    try {
      const r = await fetch('/api/polymarket/wallet', { headers: tgAuthHeaders() })
      if (r.status === 401) {
        // Not in Telegram context — leave wallet null, tradeable buttons stay disabled.
        setWallet(null)
        setWalletErr(null)
        return
      }
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setWallet(j as PolyWalletStatus)
      setWalletErr(null)
    } catch (e) {
      setWalletErr((e as Error).message)
    }
  }

  async function loadPositions() {
    try {
      const r = await fetch('/api/polymarket/positions', { headers: tgAuthHeaders() })
      if (!r.ok) return
      const j = await r.json()
      if (j.ok && Array.isArray(j.positions)) setPositions(j.positions as PolyPosition[])
    } catch { /* silent — positions panel just stays empty */ }
  }

  async function setupWallet() {
    setSetupBusy(true)
    try {
      const r = await fetch('/api/polymarket/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...tgAuthHeaders() },
        body: JSON.stringify({}),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) {
        // Server returns { error: 'safe_deploy_failed' | 'allowance_failed'
        // | 'setup_failed', details?: '<underlying message>' }. Show the
        // human-readable details when present so the user can act on it
        // (e.g. "Polygon RPC 401" → wait + retry, "no relayer credit" →
        // contact support) instead of a useless code.
        const detail =
          (j?.details && String(j.details).trim()) ||
          (j?.error   && String(j.error).trim())   ||
          `HTTP ${r.status}`
        // Bumped from 180→500 because the server-side humanizer for
        // Polymarket SDK errors (humanizeRelayerError in server.ts)
        // produces actionable messages up to ~320 chars (e.g. the 401
        // "POLY_BUILDER_* secrets don't match — verify and redeploy"
        // case). Truncating earlier silently hides the operator
        // instruction, which defeats the purpose of the humanizer.
        throw new Error(detail.slice(0, 500))
      }
      flash('ok', 'Wallet ready — USDC allowance set')
      await loadWallet()
    } catch (e) {
      flash('err', `Setup failed: ${(e as Error).message}`)
    } finally {
      setSetupBusy(false)
    }
  }

  // One-tap sweep: custodial EOA USDC.e → user's Polymarket Safe.
  // Server returns 400 + code:'NEED_MATIC' when the EOA holds USDC.e but
  // can't pay gas; we surface that as an inline prompt with the EOA
  // address rather than a vague toast.
  async function fundPolymarket() {
    setFundBusy(true)
    try {
      const r = await fetch('/api/polymarket/fund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...tgAuthHeaders() },
        body: JSON.stringify({}),
      })
      const j = await r.json()
      if (!r.ok || !j.ok) {
        if (j?.code === 'NEED_MATIC') {
          flash('err', 'Need a tiny amount of POL (formerly MATIC) for gas — see prompt below')
        } else {
          flash('err', `Fund failed: ${j?.details ?? j?.error ?? `HTTP ${r.status}`}`)
        }
        await loadWallet()
        return
      }
      flash('ok', `Funded $${Number(j.amountUsdc ?? 0).toFixed(2)} to Safe`)
      await loadWallet()
    } catch (e) {
      flash('err', `Fund failed: ${(e as Error).message}`)
    } finally {
      setFundBusy(false)
    }
  }

  async function copyEoa(addr: string) {
    try {
      await navigator.clipboard.writeText(addr)
      setEoaCopied(true)
      window.setTimeout(() => setEoaCopied(false), 1500)
    } catch {
      const tg = (window as any).Telegram?.WebApp
      if (tg?.showAlert) tg.showAlert(addr)
    }
  }

  async function submitOrder(opts: { tokenId: string; side: 'BUY' | 'SELL'; sizeUsdc: number; price: number; conditionId: string; marketTitle: string; outcomeLabel: string }) {
    const r = await fetch('/api/polymarket/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tgAuthHeaders() },
      body: JSON.stringify(opts),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) throw new Error(j?.error || `HTTP ${r.status}`)
    return j
  }

  useEffect(() => {
    load(true)
    loadWallet()
    loadPositions()
    // 10s auto-refresh — server caches Gamma at 15s so this just reads
    // local cache most of the time.
    const id = setInterval(() => {
      load(true)
      loadPositions()
    }, 10_000)
    return () => clearInterval(id)
  }, [])

  const walletReady = !!(wallet?.ready)

  return (
    <div style={{ paddingTop: 4, paddingBottom: 8 }}>
      {/* Header bar with refresh control. */}
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

      {/* Wallet panel — Phase 2.1 (gasless via Polymarket relayer).
            States:
            (a) wallet=null              → no Telegram init data; nothing to do.
            (b) wallet.hasCreds=false    → "Activate trading" CTA. Runs the
                                          full 3-step setup (creds → deploy
                                          Safe → 6× allowance approvals).
                                          All three on-chain txs are paid by
                                          the Polymarket relayer — user pays
                                          ZERO gas, ever. No POL required.
            (c) wallet.ready=true        → shows the SAFE address (the deposit
                                          target). USDC.e sent to the Safe is
                                          tradable immediately. */}
      {wallet && (
        <div
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 8,
            background: '#0f0f17',
            border: `1px solid ${wallet.ready ? '#10b98144' : '#f59e0b44'}`,
          }}
          data-testid="panel-poly-wallet"
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: wallet.ready ? '#10b981' : '#f59e0b', letterSpacing: 0.4 }}>
                {wallet.ready ? 'POLYMARKET SAFE · LIVE' : 'POLYMARKET SAFE · ACTION NEEDED'}
              </div>
              {/* Show the SAFE address when deployed (that's the deposit target).
                  Fall back to the EOA address pre-setup so the user knows
                  something is there. */}
              {(wallet.safeAddress || wallet.walletAddress) && (
                <div
                  style={{ fontSize: 10, color: '#64748b', fontFamily: 'ui-monospace, monospace', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  data-testid="text-poly-wallet-address"
                  title={wallet.safeAddress ? 'Polymarket Safe (deposit address)' : 'Signer EOA (Safe not deployed yet)'}
                >
                  {wallet.safeAddress
                    ? `Safe: ${wallet.safeAddress}`
                    : `EOA: ${wallet.walletAddress}`}
                </div>
              )}
            </div>
            {/* Show "Activating…" only while a setup call is actually in
                flight. Whenever the wallet is not ready (whether the user
                is brand new OR is a Phase-2 EOA-mode user from before the
                gasless migration whose Safe was never deployed), we show
                the setup CTA — the /setup endpoint is fully idempotent
                and will only do the steps that are still missing. */}
            {!wallet.ready && setupBusy && (
              <span style={{ fontSize: 10, color: '#f59e0b' }}>
                {wallet.safeDeployed ? 'Setting allowances (gasless)…' : 'Deploying Safe (gasless)…'}
              </span>
            )}
            {!wallet.ready && !setupBusy && (
              <button
                type="button"
                onClick={setupWallet}
                disabled={setupBusy}
                data-testid="button-poly-setup"
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  background: setupBusy ? '#1e1e2e' : '#7c3aed',
                  border: '1px solid #7c3aed',
                  color: 'white',
                  cursor: setupBusy ? 'wait' : 'pointer',
                }}
              >
                {wallet.hasCreds && !wallet.safeDeployed
                  ? 'Deploy Safe'
                  : wallet.safeDeployed
                    ? 'Finish setup'
                    : 'Activate trading'}
              </button>
            )}
          </div>

          {wallet.balances && (
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <div style={{ fontSize: 10, color: '#94a3b8' }}>
                <span style={{ color: '#64748b' }}>USDC.e in Safe: </span>
                <span data-testid="text-poly-usdc" style={{ fontFamily: 'ui-monospace, monospace', color: wallet.balances.usdc > 0 ? '#10b981' : '#ef4444' }}>
                  ${wallet.balances.usdc.toFixed(2)}
                </span>
              </div>
              {wallet.eoaBalances && (
                <div style={{ fontSize: 10, color: '#94a3b8', textAlign: 'right' }}>
                  <span style={{ color: '#64748b' }}>EOA: </span>
                  <span data-testid="text-poly-eoa-usdce" style={{ fontFamily: 'ui-monospace, monospace' }}>
                    ${wallet.eoaBalances.usdcE.toFixed(2)} USDC.e
                  </span>
                  <span style={{ color: '#475569' }}> · </span>
                  <span data-testid="text-poly-eoa-matic" style={{ fontFamily: 'ui-monospace, monospace' }} title="POL is the new ticker for MATIC on Polygon (renamed Sept 2024)">
                    {wallet.eoaBalances.matic.toFixed(4)} POL
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Funding CTA tree — only shown when Safe is live. Three states:
              (1) EOA has USDC.e + MATIC → big green Fund button (one-tap sweep)
              (2) EOA has USDC.e but no MATIC → "send MATIC for gas" prompt with copyable EOA address
              (3) EOA empty → keep the existing "send USDC.e directly to Safe" instruction as a fallback for users who already hold USDC.e elsewhere */}
          {wallet.ready && wallet.safeAddress && wallet.eoaBalances && wallet.eoaBalances.usdcE > 0.01 && wallet.eoaBalances.matic >= 0.005 && (
            <button
              type="button"
              onClick={fundPolymarket}
              disabled={fundBusy}
              data-testid="button-poly-fund"
              style={{
                marginTop: 10, width: '100%',
                padding: '10px 12px', borderRadius: 6,
                fontSize: 12, fontWeight: 700,
                background: fundBusy ? '#1e1e2e' : '#10b981',
                border: '1px solid #10b981',
                color: 'white',
                cursor: fundBusy ? 'wait' : 'pointer',
              }}
            >
              {fundBusy
                ? 'Sending to Safe…'
                : `Fund Polymarket ($${wallet.eoaBalances.usdcE.toFixed(2)})`}
            </button>
          )}
          {wallet.ready && wallet.safeAddress && wallet.eoaBalances && wallet.eoaBalances.usdcE > 0.01 && wallet.eoaBalances.matic < 0.005 && wallet.walletAddress && (
            <div style={{ marginTop: 10, padding: 8, borderRadius: 6, background: '#f59e0b11', border: '1px solid #f59e0b33', fontSize: 10, color: '#fcd34d', lineHeight: 1.5 }} data-testid="prompt-poly-need-matic">
              <div style={{ marginBottom: 6 }}>
                <strong style={{ color: '#f59e0b' }}>Need a tiny amount of POL for gas (~$0.01).</strong> Send any small amount of <strong>POL</strong> (the new name for MATIC on Polygon — renamed Sept 2024) to:
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <code style={{ flex: 1, fontSize: 10, wordBreak: 'break-all', background: '#0a0a12', padding: '4px 6px', borderRadius: 4, color: '#e2e8f0' }} data-testid="text-poly-eoa-addr">
                  {wallet.walletAddress}
                </code>
                <button
                  type="button"
                  onClick={() => copyEoa(wallet.walletAddress!)}
                  data-testid="button-copy-poly-eoa-addr"
                  style={{
                    padding: '4px 8px', borderRadius: 4, border: '1px solid #f59e0b66',
                    background: 'transparent', color: '#fcd34d', fontSize: 10, cursor: 'pointer',
                  }}
                >
                  {eoaCopied ? '✓' : 'Copy'}
                </button>
              </div>
              <div style={{ marginTop: 6, color: '#94a3b8' }}>
                Once POL arrives, the Fund button appears here.
              </div>
            </div>
          )}
          {wallet.ready && wallet.balances && wallet.balances.usdc < 1 && wallet.safeAddress && (!wallet.eoaBalances || wallet.eoaBalances.usdcE <= 0.01) && (
            <div style={{ marginTop: 8, padding: 6, borderRadius: 4, background: '#10b98111', fontSize: 10, color: '#34d399', lineHeight: 1.4 }}>
              <strong style={{ color: '#10b981' }}>Gasless trading is active.</strong> Send USDC.e (Polygon) to your Safe above — or to your custodial EOA + a tiny POL (formerly MATIC) for one-tap funding. No POL needed for trading itself; Polymarket pays gas there.
            </div>
          )}

        </div>
      )}

      {walletErr && (
        <div
          style={{
            marginBottom: 12, padding: '6px 10px', borderRadius: 6,
            background: '#ef444411', border: '1px solid #ef444433',
            fontSize: 10, color: '#fca5a5',
          }}
          data-testid="error-poly-wallet"
        >
          Wallet check: {walletErr}
        </div>
      )}

      {/* Open Polymarket positions — only renders when there's at least one. */}
      {positions.length > 0 && (
        <div style={{ marginBottom: 12, background: '#0f0f17', border: '1px solid #1e1e2e', borderRadius: 8, overflow: 'hidden' }}
             data-testid="panel-poly-positions">
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #1e1e2e', fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.3 }}>
            POLY POSITIONS · {positions.length}
          </div>
          {positions.slice(0, 8).map((p) => {
            const colorOk = p.status === 'filled' || p.status === 'matched'
            const colorBad = p.status === 'failed' || p.status === 'cancelled'
            const isResolvedWin  = p.status === 'resolved_win'
            const isResolvedLoss = p.status === 'resolved_loss'
            const accent = isResolvedWin ? '#22d3ee'
                         : isResolvedLoss ? '#64748b'
                         : colorOk ? '#10b981'
                         : colorBad ? '#ef4444'
                         : '#f59e0b'
            // SELL = exit a live (still-open) position back to the order book.
            // Allow it for any non-failed BUY whose tokens are (or might be) at
            // the Safe. We previously gated on status === 'filled'|'matched'
            // only — but Polymarket's SDK frequently returns the order in
            // 'placed' state even after the book matches it (the fill comes
            // through asynchronously and we don't always see the update),
            // so positions stayed un-sellable forever. We now also allow
            // SELL on 'placed' positions: the worst case is the SELL itself
            // fails server-side ("no tokens at Safe") and the user gets the
            // standard error toast, instead of being permanently stuck with
            // no way to exit.
            const sellableStatus = p.status === 'filled' || p.status === 'matched' || p.status === 'placed'
            // Token quantity for the SELL: prefer the recorded fill, fall back
            // to (sizeUsdc / entryPrice) when the SDK didn't report a fill
            // size — an order placed at $5 @ 32¢ implies ~15.625 outcome
            // tokens, which is the right size to dump back to the book.
            const sellQty = (p.fillSize && p.fillSize > 0)
              ? p.fillSize
              : (p.entryPrice > 0 ? p.sizeUsdc / p.entryPrice : 0)
            const canSell = sellableStatus && !!p.tokenId && p.side === 'BUY' && sellQty > 0
            // REDEEM = claim USDC from a resolved market via the CTF
            // (or NegRiskAdapter). Gasless — the relayer pays. Shown for
            // any winning resolution; losing resolutions have nothing to
            // claim so we hide the button.
            const canRedeem = isResolvedWin && !!p.conditionId
            return (
              <div
                key={p.id}
                style={{ padding: '8px 10px', borderTop: '1px solid #1e1e2e', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}
                data-testid={`row-poly-position-${p.id}`}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  {/* Allow position market title to wrap to 2 lines for the same
                      reason the market list rows do (Polymarket question text
                      regularly exceeds the row width — see MarketRow comment). */}
                  <div
                    style={{
                      fontSize: 11,
                      color: '#e2e8f0',
                      lineHeight: 1.3,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      wordBreak: 'break-word',
                    }}
                    title={p.marketTitle}
                  >
                    {p.marketTitle}
                  </div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 2, display: 'flex', gap: 8 }}>
                    <span style={{ color: accent, fontWeight: 600 }}>{p.side} {p.outcomeLabel}</span>
                    <span>${p.sizeUsdc.toFixed(2)}</span>
                    <span>@ {fmtPriceCents(p.entryPrice)}</span>
                    <span style={{ color: accent, textTransform: 'uppercase' }}>{p.status}</span>
                  </div>
                  {p.errorMessage && (
                    <div style={{ fontSize: 9, color: '#ef4444', marginTop: 2 }}>{p.errorMessage}</div>
                  )}
                </div>
                {canRedeem && (
                  <button
                    type="button"
                    data-testid={`button-poly-redeem-${p.id}`}
                    onClick={async () => {
                      try {
                        const r = await fetch('/api/polymarket/redeem', {
                          method:  'POST',
                          headers: { 'content-type': 'application/json', ...tgAuthHeaders() },
                          // We don't yet persist isNegRisk on the position
                          // row; the server defaults to vanilla CTF redeem
                          // and the relayer reverts cleanly if the market
                          // is in fact NegRisk — at which point the user
                          // can retry against the negRisk path. Future
                          // work: persist isNegRisk on PolymarketPosition.
                          body: JSON.stringify({ conditionId: p.conditionId }),
                        })
                        const j = await r.json().catch(() => ({}))
                        if (!r.ok || !j.ok) {
                          throw new Error(j.details ?? j.error ?? `HTTP ${r.status}`)
                        }
                        flash('ok', `Redeemed: ${p.outcomeLabel} (gasless)`)
                        await Promise.all([loadWallet(), loadPositions()])
                      } catch (err: any) {
                        flash('err', `Redeem failed: ${String(err?.message ?? err).slice(0, 80)}`)
                      }
                    }}
                    style={{
                      padding: '4px 10px', fontSize: 10, fontWeight: 700,
                      background: '#22d3ee', color: '#0b1220', border: 'none',
                      borderRadius: 4, cursor: 'pointer', flexShrink: 0,
                    }}
                  >REDEEM</button>
                )}
                {canSell && (
                  <button
                    type="button"
                    data-testid={`button-poly-sell-${p.id}`}
                    onClick={async () => {
                      // Sell the entire fill at market. We don't pop a
                      // modal for this — exits are intentionally one-tap
                      // so a user can dump on news without friction.
                      // SELL amount is the outcome-token quantity, not USDC.
                      // Use the same sellQty resolved above so 'placed'
                      // positions (which often have fillSize=0 even after
                      // matching) still get a sensible quantity derived
                      // from sizeUsdc/entryPrice.
                      const qty = sellQty
                      if (qty <= 0) return
                      try {
                        await submitOrder({
                          tokenId: p.tokenId,
                          side:    'SELL',
                          // SELL amount field is reused as token quantity;
                          // the server validator caps it at 10000 which
                          // is well above any realistic outcome-token size
                          // for our small initial book.
                          sizeUsdc: qty,
                          // IMPORTANT: do NOT pass entryPrice here. The
                          // server uses `price` as the slippage-anchor:
                          // a position whose mark moved >5% from entry
                          // is exactly the case where you most want to
                          // exit, not be blocked. Sending 0 disables the
                          // slippage gate (server treats !Number.isFinite
                          // || 0 as "no anchor") and lets the SDK price
                          // the SELL at the best executable bid.
                          price:    0,
                          conditionId:  p.conditionId,
                          marketTitle:  p.marketTitle,
                          outcomeLabel: p.outcomeLabel,
                        })
                        flash('ok', `Sell submitted: ${p.outcomeLabel}`)
                        await Promise.all([loadWallet(), loadPositions()])
                      } catch (err: any) {
                        flash('err', `Sell failed: ${String(err?.message ?? err).slice(0, 80)}`)
                      }
                    }}
                    style={{
                      padding: '4px 10px', fontSize: 10, fontWeight: 700,
                      background: '#ef4444', color: '#fff', border: 'none',
                      borderRadius: 4, cursor: 'pointer', flexShrink: 0,
                    }}
                  >SELL</button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {data && data.events.map((e) => (
        <EventCard
          key={e.id}
          event={e}
          walletReady={walletReady}
          onTrade={(intent) => {
            if (!walletReady) {
              flash('err', 'Activate the Polygon wallet first')
              return
            }
            setTradeIntent(intent)
          }}
        />
      ))}

      {/* Trade modal */}
      {tradeIntent && (
        <TradeModal
          intent={tradeIntent}
          wallet={wallet}
          onCancel={() => setTradeIntent(null)}
          onSubmit={async ({ sizeUsdc, price }) => {
            const tokenId = tradeIntent.market.clobTokenIds[tradeIntent.outcomeIdx]
            if (!tokenId) throw new Error('missing_token_id')
            await submitOrder({
              tokenId,
              side: 'BUY',
              sizeUsdc,
              price,
              conditionId: tradeIntent.conditionId,
              marketTitle: tradeIntent.market.question,
              outcomeLabel: tradeIntent.outcomeLabel,
            })
            setTradeIntent(null)
            flash('ok', `Order submitted: ${tradeIntent.outcomeLabel} $${sizeUsdc.toFixed(2)}`)
            await Promise.all([loadWallet(), loadPositions()])
          }}
          onError={(msg) => flash('err', msg)}
        />
      )}

      {/* Toast — auto-dismisses */}
      {toast && (
        <div
          style={{
            position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)',
            padding: '10px 14px', borderRadius: 8,
            background: toast.kind === 'ok' ? '#10b981ee' : '#ef4444ee',
            color: 'white', fontSize: 12, fontWeight: 600, zIndex: 1000,
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}
          data-testid={`toast-poly-${toast.kind}`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}

// ─── Trade modal ───
// Simple BUY-side market order at the current best ask. We send both
// sizeUsdc (server-side sanity bound) and the price snapshot so the
// server can refuse if the book moved beyond a safety band.
function TradeModal({
  intent,
  wallet,
  onCancel,
  onSubmit,
  onError,
}: {
  intent: TradeIntent
  wallet: PolyWalletStatus | null
  onCancel: () => void
  onSubmit: (opts: { sizeUsdc: number; price: number }) => Promise<void>
  onError: (msg: string) => void
}) {
  const [size, setSize] = useState('5')
  const [busy, setBusy] = useState(false)
  const ask = intent.outcomeIdx === 0
    ? (intent.market.bestAsk ?? intent.market.outcomePrices[0] ?? null)
    : (intent.market.bestBid !== null ? 1 - intent.market.bestBid : intent.market.outcomePrices[1] ?? null)

  const sizeNum = Number(size)
  const valid = Number.isFinite(sizeNum) && sizeNum > 0 && ask !== null && ask > 0 && ask < 1
  const usdcAvail = wallet?.balances?.usdc ?? 0
  const enough = sizeNum <= usdcAvail
  const shares = (valid && ask) ? sizeNum / ask : 0

  async function handleConfirm() {
    if (!valid || !ask) return
    if (!enough) {
      onError(`Need $${sizeNum.toFixed(2)} USDC (have $${usdcAvail.toFixed(2)})`)
      return
    }
    setBusy(true)
    try {
      await onSubmit({ sizeUsdc: sizeNum, price: ask })
    } catch (e) {
      onError(`Order rejected: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onClick={busy ? undefined : onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 999,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 12,
      }}
      data-testid="modal-poly-trade"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0f0f17', border: '1px solid #1e1e2e',
          borderRadius: 10, padding: 16, maxWidth: 380, width: '100%',
        }}
      >
        <div style={{ fontSize: 11, color: '#64748b', letterSpacing: 0.4, marginBottom: 4 }}>BUY · POLYMARKET</div>
        <div style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600, marginBottom: 12, lineHeight: 1.3 }}
             data-testid="text-trade-question">
          {intent.market.question}
        </div>

        <div style={{
          display: 'inline-block', padding: '4px 10px', borderRadius: 4,
          background: intent.outcomeIdx === 0 ? '#10b98122' : '#ef444422',
          border: `1px solid ${intent.outcomeIdx === 0 ? '#10b98144' : '#ef444444'}`,
          color: intent.outcomeIdx === 0 ? '#10b981' : '#ef4444',
          fontSize: 11, fontWeight: 700, marginBottom: 12,
        }} data-testid="text-trade-outcome">
          {intent.outcomeLabel.toUpperCase()} @ {fmtPriceCents(ask)}
        </div>

        <label style={{ display: 'block', fontSize: 10, color: '#94a3b8', marginBottom: 4 }}>
          Size (USDC)
        </label>
        <input
          type="number"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          min={1}
          step={1}
          disabled={busy}
          data-testid="input-trade-size"
          style={{
            width: '100%', padding: '8px 10px', fontSize: 14,
            background: '#0a0a13', color: '#e2e8f0',
            border: '1px solid #1e1e2e', borderRadius: 6,
            fontFamily: 'ui-monospace, monospace',
          }}
        />

        <div style={{ marginTop: 10, padding: 8, background: '#0a0a13', borderRadius: 6, fontSize: 10, color: '#94a3b8', lineHeight: 1.6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Est. shares</span>
            <span style={{ fontFamily: 'ui-monospace, monospace', color: '#e2e8f0' }} data-testid="text-trade-shares">
              {valid ? shares.toFixed(2) : '—'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Max payout</span>
            <span style={{ fontFamily: 'ui-monospace, monospace', color: '#10b981' }}>
              {valid ? `$${shares.toFixed(2)}` : '—'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Available</span>
            <span style={{ fontFamily: 'ui-monospace, monospace', color: enough ? '#10b981' : '#ef4444' }}>
              ${usdcAvail.toFixed(2)}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid="button-trade-cancel"
            style={{
              flex: 1, padding: '8px 0', borderRadius: 6,
              background: '#1e1e2e', border: '1px solid #1e1e2e',
              color: '#94a3b8', fontSize: 12, cursor: busy ? 'wait' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!valid || busy || !enough}
            data-testid="button-trade-confirm"
            style={{
              flex: 2, padding: '8px 0', borderRadius: 6,
              background: (!valid || !enough) ? '#1e1e2e' : (busy ? '#7c3aed88' : '#7c3aed'),
              border: '1px solid #7c3aed',
              color: 'white', fontSize: 12, fontWeight: 600,
              cursor: (busy || !valid || !enough) ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Submitting…' : `Buy ${intent.outcomeLabel}`}
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 9, color: '#64748b', lineHeight: 1.4 }}>
          Order signed with your custodial Polygon key and routed directly to Polymarket.
        </div>
      </div>
    </div>
  )
}

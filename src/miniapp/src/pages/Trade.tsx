import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api'
import { NativeChart } from '../components/NativeChart'
import { MarketTicker, fmtUsdRaw } from '../components/MarketTicker'

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'ASTERUSDT']

// Format a USD price with decimal precision that scales with magnitude.
// Delegates to the shared MarketTicker tier so Aster, HL, and the chart
// header all show the same number of digits for the same asset (HYPE
// $41.3651 here = HYPE $41.3651 on the HL screen). Single source of
// truth lives in MarketTicker.tsx.
function fmtPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '0'
  return fmtUsdRaw(p)
}

// Inline styles bypass any cached CSS rules and any iOS native chrome
// that might be applied to <button>/<select>/<input> in the Telegram
// WebApp. The previous CSS-class approach was being defeated by aggressive
// CSS-chunk caching on iOS Telegram, so we use inline styles directly
// for the form controls that were rendering as iOS native pills/inputs.
const inputLabelStyle: React.CSSProperties = {
  fontSize: 12, color: '#9ca3af', fontWeight: 500,
}
const inputFieldStyle: React.CSSProperties = {
  background: '#12121a', border: '1px solid #2a2a3e', borderRadius: 10,
  padding: 12, color: '#ffffff', fontSize: 16, outline: 'none',
  fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
  WebkitAppearance: 'none', appearance: 'none',
}
const selectFieldStyle: React.CSSProperties = {
  ...inputFieldStyle, paddingRight: 36,
  backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%239ca3af' d='M6 8L0 0h12z'/></svg>\")",
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 14px center',
}
const toggleRowStyle: React.CSSProperties = {
  display: 'flex', borderRadius: 10, overflow: 'hidden',
  border: '1px solid #2a2a3e', gap: 1, background: '#2a2a3e',
}
const toggleBtnStyle = (active: boolean, accent: string): React.CSSProperties => ({
  flex: 1, padding: 12, textAlign: 'center', fontSize: 14, fontWeight: 600,
  cursor: 'pointer', border: 'none', fontFamily: 'inherit',
  WebkitAppearance: 'none', appearance: 'none',
  background: active ? accent : '#12121a',
  color: active ? '#ffffff' : '#9ca3af',
  transition: 'all 0.2s',
})

interface MarkPrice { markPrice: number; indexPrice: number; lastFundingRate: number }
interface AsterPosition {
  symbol: string; side: 'LONG' | 'SHORT'; size: number;
  entryPrice: number; markPrice: number; unrealizedPnl: number;
  leverage: number; liquidationPrice: number; marginType: string
}
interface WalletInfo {
  aster: { usdt: number; availableMargin: number; onboarded: boolean; error: string | null }
}
interface OrderResponse {
  success: boolean; qty: number; refPrice: number; leverage: number;
  order: { orderId: string | number; status: string; avgPrice: number }
  // Server returns the SL leg outcome alongside the entry. `placed` →
  // STOP_MARKET landed; `failed` → entry succeeded but the SL didn't,
  // surfaced as a non-fatal note in the toast; `skipped` → no SL was
  // requested (most common, e.g. the user left the field blank).
  stopLoss?: { status: 'placed' | 'skipped' | 'failed'; price?: number; error?: string }
}
interface AsterTrade {
  symbol: string; side: 'BUY' | 'SELL'; positionSide: string;
  price: number; qty: number; quoteQty: number;
  realizedPnl: number; commission: number; commissionAsset: string;
  time: number; orderId: number;
}
// Resting orders surfaced from /api/aster/orders. Distinct from positions
// (which are filled, on-book exposure) and trades (which are completed
// fills) — these are working orders waiting to match.
interface AsterOrder {
  orderId: number; symbol: string; side: 'BUY' | 'SELL'; positionSide: string;
  type: string; price: number; stopPrice: number;
  origQty: number; executedQty: number; status: string;
  reduceOnly: boolean; timeInForce: string; time: number;
}

export function Trade() {
  const [wallet, setWallet]       = useState<WalletInfo | null>(null)
  const [walletErr, setWalletErr] = useState<string | null>(null)
  const [pair, setPair]           = useState('BTCUSDT')
  const [side, setSide]           = useState<'LONG' | 'SHORT'>('LONG')
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET')
  const [size, setSize]           = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  // Optional stop-loss attached to the user's manual entry. Stored as a
  // string so empty input means "no SL" rather than NaN. Validated and
  // submitted alongside the entry — server places a STOP_MARKET reduce-
  // only order with builder fee attribution after the entry fills.
  const [stopLoss, setStopLoss]   = useState('')
  const [leverage, setLeverage]   = useState(5)
  const [mark, setMark]           = useState<MarkPrice | null>(null)
  const [positions, setPositions] = useState<AsterPosition[]>([])
  const [trades, setTrades]       = useState<AsterTrade[]>([])
  const [tradesErr, setTradesErr] = useState<string | null>(null)
  // Resting orders (LIMIT / stop variants that haven't matched yet). Lives in
  // its own panel between Positions and Recent fills so a placed limit is
  // visible immediately, instead of appearing to vanish until it fills.
  const [orders, setOrders]       = useState<AsterOrder[]>([])
  const [ordersErr, setOrdersErr] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<number | null>(null)
  // Live mark prices for OPEN POSITIONS, polled separately from the
  // selected-pair mark above. Keyed by symbol so closing a position
  // automatically drops it from the polling set on the next tick.
  const [livePrices, setLivePrices] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [activating, setActivating] = useState(false)
  const [msg, setMsg]             = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const loadWallet = async () => {
    try {
      const w = await apiFetch<WalletInfo>('/api/me/wallet')
      setWallet(w); setWalletErr(null)
    } catch (e: any) {
      setWalletErr(e?.message ?? 'Could not load wallet')
    }
  }
  const loadPositions = async () => {
    try {
      const r = await apiFetch<{ positions: AsterPosition[] }>('/api/aster/positions')
      setPositions(r.positions)
    } catch { /* not onboarded yet, ignore */ }
  }
  const loadTrades = async () => {
    try {
      const r = await apiFetch<{ trades: AsterTrade[] }>('/api/aster/trades?limit=10')
      setTrades(r.trades); setTradesErr(null)
    } catch (e: any) {
      // Distinguish "couldn't reach Aster" from "no fills yet" — the previous
      // behavior silently swallowed both, making outages indistinguishable
      // from a clean account.
      setTradesErr(e?.message ?? 'Could not load fills')
    }
  }
  const loadOrders = async () => {
    try {
      const r = await apiFetch<{ orders: AsterOrder[] }>('/api/aster/orders')
      // Newest first — Aster usually returns ascending by time so we sort
      // defensively here, same as we do for fills.
      setOrders([...r.orders].sort((a, b) => b.time - a.time))
      setOrdersErr(null)
    } catch (e: any) {
      // Same distinction as fills: an outage must show a banner, not a
      // misleading "no resting orders" empty state.
      setOrdersErr(e?.message ?? 'Could not load open orders')
    }
  }
  const loadMark = async (p: string) => {
    try {
      const m = await apiFetch<MarkPrice>(`/api/aster/markprice/${p}`)
      setMark(m)
    } catch { setMark(null) }
  }

  useEffect(() => { loadWallet(); loadPositions(); loadTrades(); loadOrders() }, [])
  // Refresh mark price every second so the limit-price input has a live
  // reference to anchor against. Aster's markprice endpoint is cheap and
  // we're only polling one symbol at a time — well within rate limits.
  useEffect(() => {
    loadMark(pair)
    const id = setInterval(() => loadMark(pair), 1000)
    return () => clearInterval(id)
  }, [pair])

  // Live mark-price polling for OPEN POSITIONS so PnL ticks every second
  // instead of only on user-triggered refresh. Without this the user sees
  // stale PnL/mark for as long as the page is open and has to manually
  // close+reopen the tab to know if a position moved against them. We
  // also re-pull the full positions snapshot every 8s to catch margin/
  // liquidation changes the markprice endpoint doesn't surface.
  useEffect(() => {
    if (positions.length === 0) return
    const symbols = Array.from(new Set(positions.map(p => p.symbol)))
    let cancelled = false
    const tick = async () => {
      const updates = await Promise.all(symbols.map(async (s) => {
        try {
          const m = await apiFetch<MarkPrice>(`/api/aster/markprice/${s}`)
          return [s, m.markPrice] as const
        } catch { return null }
      }))
      if (cancelled) return
      setLivePrices(prev => {
        const next = { ...prev }
        for (const u of updates) if (u) next[u[0]] = u[1]
        return next
      })
    }
    tick()
    const id = setInterval(tick, 1000)
    // 1s position + order refresh — user wants every live perp surface
    // to feel realtime. positionRisk + openOrders are cheap endpoints
    // and one user = one client, so polling load is bounded.
    const refreshId = setInterval(loadPositions, 1000)
    const ordersId  = setInterval(loadOrders,    1000)
    return () => { cancelled = true; clearInterval(id); clearInterval(refreshId); clearInterval(ordersId) }
  }, [positions.map(p => p.symbol).join(',')])

  // Prefill the limit input with the live mark the moment the user toggles
  // into LIMIT mode — but ONLY once per toggle. After the first prefill we
  // consider the field "user-owned" so they can clear it, edit it, or wait
  // for a target price without us re-filling on every mark tick.
  // Reset on toggling back to MARKET so the next LIMIT switch re-prefills.
  const [limitPrefilled, setLimitPrefilled] = useState(false)
  useEffect(() => {
    if (orderType !== 'LIMIT') {
      if (limitPrefilled) setLimitPrefilled(false)
      return
    }
    if (!limitPrefilled && !limitPrice && mark?.markPrice && mark.markPrice > 0) {
      setLimitPrice(String(mark.markPrice))
      setLimitPrefilled(true)
    }
  }, [orderType, mark?.markPrice, limitPrice, limitPrefilled])

  const onboarded = wallet?.aster.onboarded === true
  const availableMargin = wallet?.aster.availableMargin ?? 0
  const sizeNum = Number(size) || 0
  const requiredMargin = leverage > 0 ? sizeNum / leverage : sizeNum
  const refPrice = orderType === 'LIMIT' ? Number(limitPrice) || 0 : (mark?.markPrice ?? 0)
  const estQty = refPrice > 0 ? sizeNum / refPrice : 0
  const insufficientMargin = sizeNum > 0 && requiredMargin > availableMargin + 0.01

  // Distance of the LIMIT price from the live mark, plus a heuristic for
  // whether the order will rest as a maker (good — earns rebates, won't pay
  // taker fee) or cross immediately as a taker (less good — was probably
  // meant as a market order). Without bid/ask depth we approximate with mark:
  //   LONG  limit > mark → likely crossable (asks sit at/above mark)
  //   SHORT limit < mark → likely crossable (bids sit at/below mark)
  // This is an estimate, not a guarantee — but it catches the common
  // mistake of typing the price in the wrong direction.
  const limitMeta = useMemo(() => {
    if (orderType !== 'LIMIT') return null
    const px = Number(limitPrice)
    const m  = mark?.markPrice ?? 0
    if (!Number.isFinite(px) || px <= 0 || m <= 0) return null
    const pct      = ((px - m) / m) * 100
    const above    = pct > 0
    const crossable = (side === 'LONG' && pct > 0) || (side === 'SHORT' && pct < 0)
    return { pct, above, crossable }
  }, [orderType, limitPrice, mark?.markPrice, side])

  const canSubmit = useMemo(() => {
    if (!onboarded || submitting) return false
    if (sizeNum <= 0) return false
    if (orderType === 'LIMIT' && (!limitPrice || Number(limitPrice) <= 0)) return false
    if (insufficientMargin) return false
    return true
  }, [onboarded, submitting, sizeNum, orderType, limitPrice, insufficientMargin])

  const activate = async () => {
    setActivating(true); setMsg(null)
    try {
      const r = await apiFetch<{ success: boolean; error?: string }>(
        '/api/aster/approve',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      )
      if (r.success) {
        setMsg({ kind: 'ok', text: 'Trading account activated.' })
        await loadWallet()
      } else {
        setMsg({ kind: 'err', text: r.error ?? 'Activation failed' })
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Activation failed' })
    } finally { setActivating(false) }
  }

  const submit = async () => {
    setSubmitting(true); setMsg(null)
    try {
      const slNum = Number(stopLoss)
      const body = {
        pair, side, type: orderType,
        notionalUsdt: sizeNum, leverage,
        limitPrice: orderType === 'LIMIT' ? Number(limitPrice) : undefined,
        // Only send stopLoss if the user actually typed one — server
        // treats undefined / 0 as "no SL", anything > 0 as a request to
        // attach a STOP_MARKET reduce-only after the entry fills.
        stopLoss: Number.isFinite(slNum) && slNum > 0 ? slNum : undefined,
      }
      const r = await apiFetch<OrderResponse>('/api/aster/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      // Aster returns one of FILLED / PARTIALLY_FILLED / NEW / EXPIRED for
      // the immediate placement response. A LIMIT placed away from market
      // comes back NEW (working) — previously the toast said "(NEW)" which
      // looked like a status code dump, leaving users unsure if the order
      // actually went through. Translate to plain English here so the user
      // knows exactly what state the order is in.
      const status = r.order.status
      const filled = status === 'FILLED'
      const partial = status === 'PARTIALLY_FILLED'
      const resting = status === 'NEW'
      const verb = filled
        ? 'filled'
        : partial
          ? 'partially filled — rest resting on book'
          : resting
            ? `resting on book at $${r.refPrice.toFixed(2)} — will fill when reached`
            : `placed (${status.toLowerCase()})`
      // Surface SL leg outcome alongside the entry. The entry is what
      // counts (the user's capital is committed), but if they asked for
      // an SL and it didn't land they need to know — silent failure
      // would leave them thinking they're protected when they aren't.
      const slBit =
        r.stopLoss?.status === 'placed'
          ? ` · stop loss set at $${r.stopLoss.price?.toFixed(2)}`
          : r.stopLoss?.status === 'failed'
            ? ` · stop loss didn't land — ${r.stopLoss.error ?? 'please add it manually'}`
            : ''
      setMsg({
        kind: r.stopLoss?.status === 'failed' ? 'err' : 'ok',
        text: `${side} ${pair} ${orderType} ${verb} — ${r.qty} ${pair.replace('USDT', '')}${slBit}`,
      })
      setSize(''); setLimitPrice(''); setStopLoss('')
      // Refresh all four panels so the user sees the order land in the
      // right place (positions if filled, open orders if resting).
      await Promise.all([loadPositions(), loadWallet(), loadTrades(), loadOrders()])
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Order failed' })
    } finally { setSubmitting(false) }
  }

  const close = async (p: AsterPosition) => {
    setMsg(null)
    try {
      await apiFetch('/api/aster/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair: p.symbol, side: p.side, size: p.size })
      })
      setMsg({ kind: 'ok', text: `Closed ${p.symbol} ${p.side}` })
      await Promise.all([loadPositions(), loadWallet(), loadTrades(), loadOrders()])
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Close failed' })
    }
  }

  const cancelOrder = async (o: AsterOrder) => {
    setMsg(null); setCancellingId(o.orderId)
    try {
      await apiFetch('/api/aster/orders/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: o.symbol, orderId: o.orderId }),
      })
      setMsg({ kind: 'ok', text: `Canceled ${o.symbol} ${o.side} @ $${o.price.toFixed(2)}` })
      await Promise.all([loadOrders(), loadWallet()])
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Cancel failed' })
    } finally {
      setCancellingId(null)
    }
  }

  // Compact relative-time formatter for the fills feed. Recent fills are the
  // most useful so we show "12s/3m/2h ago" instead of full timestamps.
  const ago = (ms: number): string => {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
    if (s < 60)    return `${s}s ago`
    if (s < 3600)  return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  }

  return (
    <div className="page">
      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>⚡ Trade on Aster DEX</span>
        <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500 }}>BSC · USDT</span>
      </div>

      {/* Venue switcher — Aster (BSC/USDT) is the default, but Hyperliquid
          (Arbitrum-bridged USDC) is now live with builder fees. Surface it
          here so users coming to /trade discover the alternative venue. */}
      <div className="card" style={{ padding: 10, marginBottom: 10 }} data-testid="card-venue-switcher">
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>VENUE</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <div
            data-testid="venue-aster-active"
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: '#7c3aed', color: '#fff', textAlign: 'center',
            }}
          >Aster · BSC</div>
          <a
            href="#hyperliquid"
            data-testid="link-venue-hyperliquid"
            onClick={(e) => {
              e.preventDefault()
              window.dispatchEvent(new CustomEvent('b4-nav', { detail: 'hyperliquid' }))
            }}
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: '#1f2937', color: '#cbd5e1', textAlign: 'center',
              textDecoration: 'none', boxSizing: 'border-box',
            }}
          >Hyperliquid · USDC →</a>
        </div>
      </div>

      {/* Terminal block — 24h ticker + live TradingView chart for the
          selected pair. Lives at the very top so users see the market
          context before any wallet/order UI, which is what serious perp
          terminals do. Both react to the `pair` selector below. */}
      <MarketTicker symbol={pair} testIdPrefix="aster-ticker" />
      <NativeChart venue="aster" symbol={pair} defaultInterval="15m" height={300} testIdPrefix="aster-chart" />

      {walletErr && (
        <div className="card" style={{ borderLeft: '3px solid #ef4444' }} data-testid="text-wallet-error">
          Could not load wallet: {walletErr}
        </div>
      )}

      {wallet && !onboarded && (
        <div className="card" style={{ borderLeft: '3px solid #f59e0b' }}>
          <div className="card-title">Activate trading account</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '8px 0 12px' }}>
            One-time signature on BSC, fully gasless. Approves a per-user trading agent so the platform can route your orders.
          </div>
          <button
            className="btn btn-purple"
            onClick={activate}
            disabled={activating}
            data-testid="btn-activate-aster"
          >
            {activating ? 'Activating…' : 'Activate Aster'}
          </button>
        </div>
      )}

      {/* Place-order card — visually mirrors the Hyperliquid order ticket
          (LIVE mark in header, coin chip row, large LONG/SHORT buttons,
          numeric leverage input next to size) so a user moving between
          venues sees the same UI vocabulary on both. */}
      <div
        style={{
          background: 'var(--bg-card, #12121a)',
          border: '1px solid var(--border, #2a2a3e)',
          borderRadius: 12,
          padding: 14,
          marginBottom: 12,
        }}
        data-testid="card-aster-order"
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Place order</div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#9ca3af', letterSpacing: 0.4 }}>{pair} MARK · LIVE</div>
            <div
              data-testid="text-mark-price"
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: mark?.markPrice && mark.markPrice > 0 ? '#a7f3d0' : '#6b7280',
                fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              }}
            >
              {mark?.markPrice ? `$${fmtPrice(mark.markPrice)}` : '—'}
            </div>
            {mark?.lastFundingRate ? (
              <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                funding {(mark.lastFundingRate * 100).toFixed(4)}%
              </div>
            ) : null}
          </div>
        </div>

        {/* Pair chip row */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {PAIRS.map(p => (
            <button
              key={p}
              onClick={() => setPair(p)}
              data-testid={`button-aster-pair-${p}`}
              style={{
                padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: pair === p ? '#7c3aed' : '#1f2937',
                color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              {p.replace('USDT', '')}
            </button>
          ))}
        </div>

        {/* LONG / SHORT */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }} data-testid="side-toggle">
          <button
            onClick={() => setSide('LONG')}
            data-testid="btn-long"
            style={{
              flex: 1, padding: '10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: side === 'LONG' ? '#22c55e' : '#1f2937',
              color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            LONG
          </button>
          <button
            onClick={() => setSide('SHORT')}
            data-testid="btn-short"
            style={{
              flex: 1, padding: '10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: side === 'SHORT' ? '#ef4444' : '#1f2937',
              color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            SHORT
          </button>
        </div>

        {/* MARKET / LIMIT */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button
            onClick={() => setOrderType('MARKET')}
            data-testid="btn-market"
            style={{
              flex: 1, padding: '8px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: orderType === 'MARKET' ? '#8b5cf6' : '#1f2937',
              color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            MARKET
          </button>
          <button
            onClick={() => setOrderType('LIMIT')}
            data-testid="btn-limit"
            style={{
              flex: 1, padding: '8px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: orderType === 'LIMIT' ? '#8b5cf6' : '#1f2937',
              color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            LIMIT
          </button>
        </div>

        {/* Limit price — only when LIMIT, lives above size so the user sees
            the target price before sizing into it. Mirrors HL. */}
        {orderType === 'LIMIT' && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
              <span>Limit price (USDT)</span>
              {mark?.markPrice && mark.markPrice > 0 && (
                <button
                  type="button"
                  onClick={() => setLimitPrice(String(mark.markPrice))}
                  data-testid="btn-use-mark"
                  style={{
                    padding: '0 6px', fontSize: 10, color: '#a78bfa',
                    background: 'transparent', border: 'none', cursor: 'pointer',
                  }}
                >
                  use mark ${fmtPrice(mark.markPrice)}
                </button>
              )}
            </div>
            <input
              type="number"
              inputMode="decimal"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder={mark?.markPrice ? String(mark.markPrice) : '0.00'}
              data-testid="input-limit-price"
              style={{
                width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
                background: '#0f172a', border: '1px solid #334155', color: '#fff',
                boxSizing: 'border-box',
              }}
            />
            {limitMeta && (
              <div
                style={{
                  fontSize: 11,
                  color: limitMeta.crossable ? '#f59e0b' : '#9ca3af',
                  marginTop: 4,
                  lineHeight: 1.4,
                }}
                data-testid="text-limit-distance"
              >
                {Math.abs(limitMeta.pct).toFixed(2)}% {limitMeta.above ? 'above' : 'below'} mark
                {limitMeta.crossable
                  ? ' · this side of the book — your order will likely fill immediately as a taker'
                  : ' · should rest as a maker until price reaches it'}
              </div>
            )}
          </div>
        )}

        {/* Stop loss (optional). Placed as a STOP_MARKET reduce-only on the
            opposite side after the entry fills. Distance vs mark shown so
            users see what they're risking before submitting. */}
        <div style={{ marginBottom: 10 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: 11, color: '#9ca3af', marginBottom: 4,
          }}>
            <span>Stop loss <span style={{ color: '#6b7280' }}>· optional</span></span>
            {mark?.markPrice && Number(stopLoss) > 0 && (() => {
              const pct = ((Number(stopLoss) - mark.markPrice) / mark.markPrice) * 100
              const wrongSide =
                (side === 'LONG'  && Number(stopLoss) >= mark.markPrice) ||
                (side === 'SHORT' && Number(stopLoss) <= mark.markPrice)
              return (
                <span
                  style={{ color: wrongSide ? '#ef4444' : '#9ca3af', fontWeight: 500 }}
                  data-testid="text-sl-distance"
                >
                  {wrongSide
                    ? (side === 'LONG' ? 'must be below mark' : 'must be above mark')
                    : `${Math.abs(pct).toFixed(2)}% ${pct > 0 ? 'above' : 'below'} mark`}
                </span>
              )
            })()}
          </div>
          <input
            type="number"
            inputMode="decimal"
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            placeholder={
              mark?.markPrice
                ? (side === 'LONG'
                    ? `< ${mark.markPrice.toFixed(2)} (closes if price falls)`
                    : `> ${mark.markPrice.toFixed(2)} (closes if price rises)`)
                : 'Trigger price'
            }
            data-testid="input-stop-loss"
            style={{
              width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
              background: '#0f172a', border: '1px solid #334155', color: '#fff',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Available margin — moved inside this card so the user sees how
            much they can deploy directly above the Size input, instead of
            having to scroll back up to a separate balance card. The Aster
            wallet number underneath shows free USDT in the trading wallet
            (i.e. capital not currently locked in an open position). */}
        {wallet && onboarded && (
          <div
            style={{
              background: 'rgba(15, 23, 42, 0.6)',
              borderRadius: 8,
              padding: '8px 10px',
              marginBottom: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
              <span>Available margin</span>
              <span data-testid="text-available-margin" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                {availableMargin.toFixed(2)} USDT
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              <span>Aster wallet</span>
              <span style={{ color: 'var(--text-secondary)' }}>{(wallet.aster.usdt ?? 0).toFixed(2)} USDT</span>
            </div>
          </div>
        )}

        {/* Size + Leverage side-by-side, both numeric — no slider. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 2 }}>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Size (USDT)</div>
            <input
              type="number"
              inputMode="decimal"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder="100"
              data-testid="input-size"
              style={{
                width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
                background: '#0f172a', border: '1px solid #334155', color: '#fff',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Leverage</div>
            <input
              type="number"
              inputMode="numeric"
              value={leverage}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                if (Number.isFinite(n)) setLeverage(Math.min(50, Math.max(1, n)))
                else setLeverage(1)
              }}
              min={1}
              max={50}
              data-testid="input-leverage"
              style={{
                width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
                background: '#0f172a', border: '1px solid #334155', color: '#fff',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* Quick size buttons */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {['10', '25', '100', '500'].map(amt => (
            <button
              key={amt}
              type="button"
              onClick={() => setSize(amt)}
              data-testid={`btn-quick-size-${amt}`}
              style={{
                flex: 1, padding: '6px', borderRadius: 6, fontSize: 11,
                background: '#1f2937', color: '#9ca3af', border: 'none',
                cursor: 'pointer', fontWeight: 600,
              }}
            >
              ${amt}
            </button>
          ))}
        </div>

        {sizeNum > 0 && refPrice > 0 && (
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }} data-testid="text-est-qty">
            ≈ {estQty.toFixed(6)} {pair.replace('USDT', '')} · margin {requiredMargin.toFixed(2)} USDT
          </div>
        )}

        {insufficientMargin && (
          <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 8 }} data-testid="text-margin-warning">
            Need {requiredMargin.toFixed(2)} USDT margin, have {availableMargin.toFixed(2)} available.
          </div>
        )}

        <button
          onClick={submit}
          disabled={!canSubmit}
          data-testid="btn-place-order"
          style={{
            width: '100%', padding: '12px', borderRadius: 8, fontSize: 14, fontWeight: 700,
            color: '#fff', border: 'none', cursor: canSubmit ? 'pointer' : 'not-allowed',
            background: !canSubmit
              ? '#374151'
              : side === 'LONG' ? '#22c55e' : '#ef4444',
            opacity: canSubmit ? 1 : 0.7,
          }}
        >
          {submitting
            ? 'Placing…'
            : `${side} ${pair} — ${leverage}x`}
        </button>
      </div>

      {msg && (
        <div
          className="card"
          style={{ borderLeft: `3px solid ${msg.kind === 'ok' ? '#10b981' : '#ef4444'}`, fontSize: 13 }}
          data-testid="text-order-msg"
        >
          {msg.text}
        </div>
      )}

      <div className="card">
        <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Open positions</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
            {positions.length} open
          </span>
        </div>
        {positions.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }} data-testid="text-no-positions">
            No open Aster positions.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {positions.map((p) => {
              // Use the live-polled mark when available, otherwise fall back
              // to the snapshot value from the last /positions call. PnL is
              // recomputed on the fly so the number ticks every second along
              // with the mark, instead of staying stuck at whatever value the
              // backend returned at the last full positions refresh.
              const liveMark = livePrices[p.symbol] ?? p.markPrice
              const dir = p.side === 'LONG' ? 1 : -1
              const livePnl = (liveMark - p.entryPrice) * p.size * dir
              const pnlColor = livePnl >= 0 ? '#10b981' : '#ef4444'
              return (
                <div
                  key={`${p.symbol}-${p.side}`}
                  data-testid={`row-position-${p.symbol}-${p.side}`}
                  style={{
                    padding: 10, borderRadius: 8, background: 'var(--bg-elev)',
                    display: 'flex', flexDirection: 'column', gap: 4
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 600 }}>{p.symbol}</span>
                    <span style={{ color: p.side === 'LONG' ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                      {p.side} · {p.leverage}x
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span>{p.size} @ ${fmtPrice(p.entryPrice)}</span>
                    <span>mark ${fmtPrice(liveMark)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                    <span style={{ color: pnlColor, fontWeight: 600 }} data-testid={`text-pnl-${p.symbol}`}>
                      {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(4)} USDT
                    </span>
                    <button
                      className="btn btn-red"
                      style={{ padding: '6px 14px', fontSize: 13 }}
                      onClick={() => close(p)}
                      data-testid={`btn-close-${p.symbol}-${p.side}`}
                    >Close</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Open orders — resting LIMIT/STOP orders that haven't filled yet.
          Lives between Positions (filled exposure) and Recent fills (history)
          so a placed limit is immediately visible. Without this panel a
          resting order looked like it had vanished — see April 26 incident
          where a $100 BTCUSDT limit at 5x was placed but appeared nowhere
          on the page until it filled. Each row shows side, type, price,
          progress (executed / requested), age, and a one-tap Cancel. */}
      {onboarded && (
        <div className="card">
          <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Open orders</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
              {orders.length} working
            </span>
          </div>
          {ordersErr ? (() => {
            // The /aster/openOrders endpoint returns "agent not found" when
            // the user activated their wallet but no on-chain agent has been
            // assigned to it yet. That is the expected state for a brand-new
            // account, not a real failure — show it as a calm empty-state
            // hint with a one-tap shortcut to the Agents tab instead of a
            // red ERR string. Anything else is treated as a genuine error.
            const benign = /agent\s*not\s*found|no\s*agent/i.test(ordersErr)
            if (benign) {
              return (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }} data-testid="text-orders-err">
                  No agent assigned to this account yet.{' '}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      window.dispatchEvent(new CustomEvent('b4-nav', { detail: 'agents' }))
                    }}
                    data-testid="link-orders-go-agents"
                    style={{ color: '#a78bfa', textDecoration: 'none' }}
                  >
                    Let an agent trade for you →
                  </a>
                </div>
              )
            }
            return (
              <div style={{ fontSize: 13, color: '#ef4444', marginTop: 8 }} data-testid="text-orders-err">
                {ordersErr}
              </div>
            )
          })() : orders.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }} data-testid="text-no-orders">
              No working orders. Limit orders will show here until filled.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {orders.map((o) => {
                // Prefer the trigger price for stop variants where the
                // 'price' field is 0 — that's how Aster surfaces these.
                const px = o.price > 0 ? o.price : o.stopPrice
                const sideColor = o.side === 'BUY' ? '#22c55e' : '#ef4444'
                const filledPct = o.origQty > 0 ? (o.executedQty / o.origQty) * 100 : 0
                const isCanceling = cancellingId === o.orderId
                return (
                  <div
                    key={o.orderId}
                    data-testid={`row-order-${o.orderId}`}
                    style={{ padding: 10, borderRadius: 8, background: 'var(--bg-elev)' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>
                        <span style={{ color: sideColor }}>{o.side}</span>{' '}
                        {o.symbol}
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                          {o.type.replace('_', ' ')}{o.reduceOnly ? ' · close' : ''}
                        </span>
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }} data-testid={`text-order-age-${o.orderId}`}>
                        {ago(o.time)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                      <span data-testid={`text-order-px-${o.orderId}`}>
                        {o.origQty} @ ${fmtPrice(px)}
                      </span>
                      <span style={{ color: filledPct > 0 ? '#22c55e' : 'var(--text-muted)' }}>
                        {filledPct > 0 ? `${filledPct.toFixed(0)}% filled` : o.status === 'NEW' ? 'Working' : o.status}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                      <button
                        className="btn btn-red"
                        style={{ padding: '6px 14px', fontSize: 13 }}
                        onClick={() => cancelOrder(o)}
                        disabled={isCanceling}
                        data-testid={`btn-cancel-order-${o.orderId}`}
                      >
                        {isCanceling ? 'Canceling…' : 'Cancel'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Recent fills — pulled from Aster's userTrades endpoint. Each row
          shows the actual commission Aster charged on the fill, which is the
          ground truth for fee accounting. Helps users audit their trading
          costs and surfaces builder-fee attribution transparently. */}
      {onboarded && (
        <div className="card">
          <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Recent fills</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
              last {trades.length}
            </span>
          </div>
          {tradesErr ? (
            <div style={{ fontSize: 13, color: '#ef4444', marginTop: 8 }} data-testid="text-trades-error">
              Could not load fills: {tradesErr}
            </div>
          ) : trades.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }} data-testid="text-no-trades">
              No fills yet on this account.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {trades.map((t) => {
                const notional = t.qty * t.price
                // bps math is only meaningful when commission is paid in USDT
                // (the same denomination as notional). If Aster ever charges in
                // BNB or another asset, suppress the bps annotation rather
                // than display a number that mixes denominations.
                const sameDenom = (t.commissionAsset || '').toUpperCase() === 'USDT'
                const feeBps = sameDenom && notional > 0 ? (t.commission / notional) * 10000 : 0
                const sideColor = t.side === 'BUY' ? '#10b981' : '#ef4444'
                return (
                  <div
                    key={`${t.orderId}-${t.time}`}
                    data-testid={`row-trade-${t.orderId}`}
                    style={{
                      padding: 10, borderRadius: 8, background: 'var(--bg-elev)',
                      display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 600 }}>
                        <span style={{ color: sideColor }}>{t.side}</span> {t.symbol}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>{ago(t.time)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>{t.qty} @ ${fmtPrice(t.price)}</span>
                      <span>${notional.toFixed(2)} notional</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>
                        fee {t.commission.toFixed(6)} {t.commissionAsset}
                        {feeBps > 0 && (
                          <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                            ({feeBps.toFixed(2)} bps)
                          </span>
                        )}
                      </span>
                      {t.realizedPnl !== 0 && (
                        <span style={{ color: t.realizedPnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                          {t.realizedPnl >= 0 ? '+' : ''}{t.realizedPnl.toFixed(4)} PnL
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

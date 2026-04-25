import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api'
import { TradingChart } from '../components/TradingChart'
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
}

export function Trade() {
  const [wallet, setWallet]       = useState<WalletInfo | null>(null)
  const [walletErr, setWalletErr] = useState<string | null>(null)
  const [pair, setPair]           = useState('BTCUSDT')
  const [side, setSide]           = useState<'LONG' | 'SHORT'>('LONG')
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET')
  const [size, setSize]           = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [leverage, setLeverage]   = useState(5)
  const [mark, setMark]           = useState<MarkPrice | null>(null)
  const [positions, setPositions] = useState<AsterPosition[]>([])
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
  const loadMark = async (p: string) => {
    try {
      const m = await apiFetch<MarkPrice>(`/api/aster/markprice/${p}`)
      setMark(m)
    } catch { setMark(null) }
  }

  useEffect(() => { loadWallet(); loadPositions() }, [])
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
    const refreshId = setInterval(loadPositions, 8000)
    return () => { cancelled = true; clearInterval(id); clearInterval(refreshId) }
  }, [positions.map(p => p.symbol).join(',')])

  const onboarded = wallet?.aster.onboarded === true
  const availableMargin = wallet?.aster.availableMargin ?? 0
  const sizeNum = Number(size) || 0
  const requiredMargin = leverage > 0 ? sizeNum / leverage : sizeNum
  const refPrice = orderType === 'LIMIT' ? Number(limitPrice) || 0 : (mark?.markPrice ?? 0)
  const estQty = refPrice > 0 ? sizeNum / refPrice : 0
  const insufficientMargin = sizeNum > 0 && requiredMargin > availableMargin + 0.01

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
      const body = {
        pair, side, type: orderType,
        notionalUsdt: sizeNum, leverage,
        limitPrice: orderType === 'LIMIT' ? Number(limitPrice) : undefined
      }
      const r = await apiFetch<OrderResponse>('/api/aster/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      setMsg({
        kind: 'ok',
        text: `${side} ${pair} ${orderType} placed — ${r.qty} @ ${r.refPrice.toFixed(2)} (${r.order.status})`
      })
      setSize(''); setLimitPrice('')
      await Promise.all([loadPositions(), loadWallet()])
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
      await Promise.all([loadPositions(), loadWallet()])
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Close failed' })
    }
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
      <TradingChart symbol={pair} defaultInterval="15" height={300} testIdPrefix="aster-chart" />

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

      {wallet && onboarded && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
            <span>Available margin</span>
            <span data-testid="text-available-margin" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
              {availableMargin.toFixed(2)} USDT
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            <span>Aster wallet</span>
            <span style={{ color: 'var(--text-primary)' }}>{(wallet.aster.usdt ?? 0).toFixed(2)} USDT</span>
          </div>
        </div>
      )}

      <div className="card">
        <div style={toggleRowStyle} data-testid="side-toggle">
          <button
            onClick={() => setSide('LONG')}
            style={toggleBtnStyle(side === 'LONG', '#22c55e')}
            data-testid="btn-long"
          >Long</button>
          <button
            onClick={() => setSide('SHORT')}
            style={toggleBtnStyle(side === 'SHORT', '#ef4444')}
            data-testid="btn-short"
          >Short</button>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={inputLabelStyle}>Pair</label>
            <select
              style={selectFieldStyle}
              value={pair}
              onChange={(e) => setPair(e.target.value)}
              data-testid="select-pair"
            >
              {PAIRS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {mark && (
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }} data-testid="text-mark-price">
                Mark ${fmtPrice(mark.markPrice)}
                {mark.lastFundingRate ? ` · funding ${(mark.lastFundingRate * 100).toFixed(4)}%` : ''}
              </div>
            )}
          </div>

          <div style={toggleRowStyle}>
            <button
              onClick={() => setOrderType('MARKET')}
              style={toggleBtnStyle(orderType === 'MARKET', '#8b5cf6')}
              data-testid="btn-market"
            >Market</button>
            <button
              onClick={() => setOrderType('LIMIT')}
              style={toggleBtnStyle(orderType === 'LIMIT', '#8b5cf6')}
              data-testid="btn-limit"
            >Limit</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={inputLabelStyle}>Size (USDT notional)</label>
            <input
              style={inputFieldStyle}
              type="number"
              inputMode="decimal"
              placeholder="100"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              data-testid="input-size"
            />
            {sizeNum > 0 && refPrice > 0 && (
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }} data-testid="text-est-qty">
                ≈ {estQty.toFixed(6)} {pair.replace('USDT', '')} · margin {requiredMargin.toFixed(2)} USDT
              </div>
            )}
          </div>

          {orderType === 'LIMIT' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={inputLabelStyle}>Limit Price</label>
              <input
                style={inputFieldStyle}
                type="number"
                inputMode="decimal"
                placeholder="0.00"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                data-testid="input-limit-price"
              />
            </div>
          )}

          <div className="input-group">
            <label className="input-label">Leverage: {leverage}x</label>
            <input
              className="leverage-slider"
              type="range" min="1" max="50"
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              data-testid="slider-leverage"
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
              <span>1x</span><span>10x</span><span>25x</span><span>50x</span>
            </div>
          </div>

          {insufficientMargin && (
            <div style={{ fontSize: 12, color: '#ef4444' }} data-testid="text-margin-warning">
              Need {requiredMargin.toFixed(2)} USDT margin, have {availableMargin.toFixed(2)} available.
            </div>
          )}

          <button
            className={`btn ${side === 'LONG' ? 'btn-green' : 'btn-red'}`}
            onClick={submit}
            disabled={!canSubmit}
            data-testid="btn-place-order"
          >
            {submitting
              ? 'Placing…'
              : `${side === 'LONG' ? '🟢' : '🔴'} ${side} ${pair} — ${leverage}x`}
          </button>
        </div>
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
    </div>
  )
}

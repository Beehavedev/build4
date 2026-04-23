import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api'

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'ASTERUSDT']

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
  useEffect(() => {
    loadMark(pair)
    const id = setInterval(() => loadMark(pair), 5000)
    return () => clearInterval(id)
  }, [pair])

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
      <div className="section-title">⚡ Trade on Aster DEX</div>

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
        <div className="toggle-row" data-testid="side-toggle">
          <button
            className={`toggle-btn ${side === 'LONG' ? 'active-long' : ''}`}
            onClick={() => setSide('LONG')}
            data-testid="btn-long"
          >Long</button>
          <button
            className={`toggle-btn ${side === 'SHORT' ? 'active-short' : ''}`}
            onClick={() => setSide('SHORT')}
            data-testid="btn-short"
          >Short</button>
        </div>
      </div>

      <div className="card">
        <div className="trade-form">
          <div className="input-group">
            <label className="input-label">Pair</label>
            <select
              className="input-field"
              value={pair}
              onChange={(e) => setPair(e.target.value)}
              data-testid="select-pair"
            >
              {PAIRS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {mark && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }} data-testid="text-mark-price">
                Mark ${mark.markPrice.toFixed(mark.markPrice < 1 ? 5 : 2)}
                {mark.lastFundingRate ? ` · funding ${(mark.lastFundingRate * 100).toFixed(4)}%` : ''}
              </div>
            )}
          </div>

          <div className="toggle-row">
            <button
              className={`toggle-btn ${orderType === 'MARKET' ? 'active-long' : ''}`}
              onClick={() => setOrderType('MARKET')}
              style={orderType === 'MARKET' ? { background: 'var(--accent)' } : {}}
              data-testid="btn-market"
            >Market</button>
            <button
              className={`toggle-btn ${orderType === 'LIMIT' ? 'active-long' : ''}`}
              onClick={() => setOrderType('LIMIT')}
              style={orderType === 'LIMIT' ? { background: 'var(--accent)' } : {}}
              data-testid="btn-limit"
            >Limit</button>
          </div>

          <div className="input-group">
            <label className="input-label">Size (USDT notional)</label>
            <input
              className="input-field"
              type="number"
              placeholder="100"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              data-testid="input-size"
            />
            {sizeNum > 0 && refPrice > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }} data-testid="text-est-qty">
                ≈ {estQty.toFixed(6)} {pair.replace('USDT', '')} · margin {requiredMargin.toFixed(2)} USDT
              </div>
            )}
          </div>

          {orderType === 'LIMIT' && (
            <div className="input-group">
              <label className="input-label">Limit Price</label>
              <input
                className="input-field"
                type="number"
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
              const pnlColor = p.unrealizedPnl >= 0 ? '#10b981' : '#ef4444'
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
                    <span>{p.size} @ ${p.entryPrice.toFixed(2)}</span>
                    <span>mark ${p.markPrice.toFixed(2)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                    <span style={{ color: pnlColor, fontWeight: 600 }} data-testid={`text-pnl-${p.symbol}`}>
                      {p.unrealizedPnl >= 0 ? '+' : ''}{p.unrealizedPnl.toFixed(2)} USDT
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

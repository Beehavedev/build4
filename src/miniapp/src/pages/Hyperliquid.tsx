// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid page — first-pass landing.
//
// Shows the user's HL clearinghouse state (USDC withdrawable, account value,
// open positions) plus live mids for the major perp pairs. If the user
// hasn't approved an agent yet, a "Coming soon" CTA is shown for the
// onboarding flow (handled in a follow-up — needs approveAgent on-chain
// signature with the user's BSC PK).
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react'
import { apiFetch } from '../api'

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'HYPE', 'DOGE']

interface AccountState {
  walletAddress:    string
  onboarded:        boolean
  withdrawableUsdc: number
  accountValue:     number
  positions:        Array<{ coin: string; szi: number; entryPx: number; unrealizedPnl: number }>
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card, #12121a)', border: '1px solid var(--border, #2a2a3e)',
  borderRadius: 12, padding: 14, marginBottom: 12,
}

export default function Hyperliquid() {
  const [account, setAccount] = useState<AccountState | null>(null)
  const [mids, setMids] = useState<Record<string, number>>({})
  const [arb, setArb] = useState<{ usdc: number; eth: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activating, setActivating] = useState(false)
  const [activateMsg, setActivateMsg] = useState<string | null>(null)

  // Order ticket state
  const [orderCoin, setOrderCoin]         = useState('BTC')
  const [orderSide, setOrderSide]         = useState<'LONG' | 'SHORT'>('LONG')
  const [orderNotional, setOrderNotional] = useState('25')
  const [orderLeverage, setOrderLeverage] = useState('5')
  const [placing, setPlacing]             = useState(false)
  const [orderMsg, setOrderMsg]           = useState<string | null>(null)

  const placeOrder = async () => {
    setPlacing(true)
    setOrderMsg(null)
    try {
      const r = await apiFetch<{ success: boolean; error?: string; sz?: number; markPrice?: number }>(
        '/api/hyperliquid/order',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            coin:         orderCoin,
            side:         orderSide,
            type:         'MARKET',
            notionalUsdc: Number(orderNotional),
            leverage:     Number(orderLeverage),
          }),
        },
      )
      if (r.success) {
        setOrderMsg(
          `${orderSide} ${r.sz?.toFixed(4) ?? '?'} ${orderCoin} @ ~$${r.markPrice?.toFixed(2) ?? '?'} placed.`,
        )
        await load()
      } else {
        setOrderMsg(r.error ?? 'Order failed')
      }
    } catch (e: any) {
      setOrderMsg(e?.message ?? 'Order failed')
    } finally {
      setPlacing(false)
    }
  }

  const activate = async () => {
    setActivating(true)
    setActivateMsg(null)
    try {
      const r = await apiFetch<{ success: boolean; agentAddress?: string; error?: string }>(
        '/api/hyperliquid/approve',
        { method: 'POST' },
      )
      if (r.success) {
        setActivateMsg('Activated! You can now trade Hyperliquid from BUILD4.')
        await load()
      } else {
        setActivateMsg(r.error ?? 'Activation failed')
      }
    } catch (e: any) {
      setActivateMsg(e?.message ?? 'Activation failed')
    } finally {
      setActivating(false)
    }
  }

  const load = async () => {
    setError(null)
    try {
      const acc = await apiFetch<AccountState>('/api/hyperliquid/account')
      setAccount(acc)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load account')
    }
    // Pull arbitrum balance from the wallet endpoint so we can detect when
    // the user has USDC parked on Arbitrum and prompt them to bridge it
    // into Hyperliquid (the most common confusion: depositing USDC to the
    // wallet on Arbitrum does NOT credit HL — it must go to the bridge).
    try {
      const w = await apiFetch<{ arbitrum?: { eth: number; usdc: number } }>('/api/me/wallet')
      if (w.arbitrum) setArb({ usdc: w.arbitrum.usdc, eth: w.arbitrum.eth })
    } catch { /* ignore — bridge card just won't render */ }
    const next: Record<string, number> = {}
    await Promise.all(COINS.map(async c => {
      try {
        const r = await apiFetch<{ markPrice: number }>(`/api/hyperliquid/markprice/${c}`)
        next[c] = r.markPrice
      } catch { next[c] = 0 }
    }))
    setMids(next)
    setLoading(false)
  }

  // Two-tier polling so users see a "live" mark price without us hammering
  // the public allMids endpoint with full account-state fetches every second.
  //   - load() (account + all mids + arbitrum): every 8s
  //   - selected-coin mid only: every 1s, so the headline price next to the
  //     order ticket actually feels alive while you're sizing your trade.
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t) }, [])
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const r = await apiFetch<{ markPrice: number }>(`/api/hyperliquid/markprice/${orderCoin}`)
        if (!cancelled) setMids(prev => ({ ...prev, [orderCoin]: r.markPrice }))
      } catch { /* keep last value */ }
    }
    poll()
    const t = setInterval(poll, 1000)
    return () => { cancelled = true; clearInterval(t) }
  }, [orderCoin])

  return (
    <div style={{ paddingTop: 20 }} data-testid="page-hyperliquid">
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Hyperliquid</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #9ca3af)', marginTop: 2 }}>
          Perps · USDC · L1 DEX
        </div>
      </div>

      {error && (
        <div style={{ ...cardStyle, borderColor: '#ef4444', color: '#ef4444' }} data-testid="text-hl-error">
          {error}
        </div>
      )}

      {/* Account state */}
      <div style={cardStyle} data-testid="card-hl-account">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Your account</div>
        {loading && !account ? (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div>
        ) : account ? (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>Withdrawable USDC</span>
              <span style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-hl-withdrawable">
                ${account.withdrawableUsdc.toFixed(2)}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>Account value</span>
              <span style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-hl-account-value">
                ${account.accountValue.toFixed(2)}
              </span>
            </div>
            {!account.onboarded && (
              <div style={{ marginTop: 12 }} data-testid="card-hl-onboard">
                <button
                  onClick={activate}
                  disabled={activating}
                  data-testid="button-hl-activate"
                  style={{
                    width: '100%', padding: '12px 16px', borderRadius: 10,
                    background: activating ? '#4c1d95' : 'linear-gradient(90deg,#7c3aed,#a78bfa)',
                    color: '#fff', border: 'none', fontSize: 14, fontWeight: 600,
                    cursor: activating ? 'wait' : 'pointer',
                  }}
                >
                  {activating ? 'Activating…' : 'Activate Hyperliquid Trading'}
                </button>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8, lineHeight: 1.4 }}>
                  One tap. We bridge your Arbitrum USDC into Hyperliquid automatically
                  (~1 minute) and authorise a BUILD4 agent wallet to place orders for
                  you. You stay in custody — your master key never leaves the server.
                  {(arb?.usdc ?? 0) >= 5 && (
                    <>
                      {' '}<b style={{ color: '#a7f3d0' }}>
                        ${arb!.usdc.toFixed(2)} USDC on Arbitrum will be bridged.
                      </b>
                    </>
                  )}
                  {(arb?.usdc ?? 0) > 0 && (arb?.usdc ?? 0) < 5 && (
                    <>
                      {' '}<b style={{ color: '#fecaca' }}>
                        You have ${arb!.usdc.toFixed(2)} USDC — Hyperliquid needs at least $5 to start.
                      </b>
                    </>
                  )}
                  {(arb?.usdc ?? 0) === 0 && (
                    <>
                      {' '}<b style={{ color: '#fecaca' }}>
                        Send native USDC on Arbitrum to your wallet first, then tap Activate.
                      </b>
                    </>
                  )}
                </div>
                {activateMsg && (
                  <div
                    style={{
                      marginTop: 8, padding: 8, borderRadius: 6, fontSize: 11,
                      background: activateMsg.startsWith('Activated') ? '#064e3b' : '#7f1d1d',
                      color: activateMsg.startsWith('Activated') ? '#a7f3d0' : '#fecaca',
                    }}
                    data-testid="text-hl-activate-msg"
                  >
                    {activateMsg}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>No account yet.</div>
        )}
      </div>

      {/* Positions */}
      {account && account.positions.length > 0 && (
        <div style={cardStyle} data-testid="card-hl-positions">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Open positions</div>
          {account.positions.map((p) => (
            <div key={p.coin}
                 style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid #1f2937' }}
                 data-testid={`row-hl-position-${p.coin}`}>
              <span style={{ fontSize: 13 }}>
                <b>{p.coin}</b>{' '}
                <span style={{ color: p.szi > 0 ? '#22c55e' : '#ef4444' }}>
                  {p.szi > 0 ? 'LONG' : 'SHORT'}
                </span>
              </span>
              <span style={{ fontSize: 12, color: p.unrealizedPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                {p.unrealizedPnl >= 0 ? '+' : ''}${p.unrealizedPnl.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Order ticket — only when onboarded */}
      {account?.onboarded && (
        <div style={cardStyle} data-testid="card-hl-order">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Place order</div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, color: '#9ca3af', letterSpacing: 0.4 }}>{orderCoin} MARK · LIVE</div>
              <div
                data-testid="text-hl-selected-mark"
                style={{ fontSize: 18, fontWeight: 700, color: mids[orderCoin] > 0 ? '#a7f3d0' : '#6b7280', fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}
              >
                {mids[orderCoin] > 0
                  ? `$${mids[orderCoin].toLocaleString(undefined, { maximumFractionDigits: mids[orderCoin] < 1 ? 5 : 2 })}`
                  : '—'}
              </div>
            </div>
          </div>

          {/* Coin selector */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {COINS.map(c => (
              <button
                key={c}
                onClick={() => setOrderCoin(c)}
                data-testid={`button-hl-coin-${c}`}
                style={{
                  padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  background: orderCoin === c ? '#7c3aed' : '#1f2937',
                  color: '#fff', border: 'none', cursor: 'pointer',
                }}
              >
                {c}
              </button>
            ))}
          </div>

          {/* LONG / SHORT */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button
              onClick={() => setOrderSide('LONG')}
              data-testid="button-hl-side-long"
              style={{
                flex: 1, padding: '10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: orderSide === 'LONG' ? '#22c55e' : '#1f2937',
                color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              LONG
            </button>
            <button
              onClick={() => setOrderSide('SHORT')}
              data-testid="button-hl-side-short"
              style={{
                flex: 1, padding: '10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: orderSide === 'SHORT' ? '#ef4444' : '#1f2937',
                color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              SHORT
            </button>
          </div>

          {/* Notional + leverage */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 2 }}>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Size (USDC)</div>
              <input
                type="number"
                value={orderNotional}
                onChange={(e) => setOrderNotional(e.target.value)}
                data-testid="input-hl-notional"
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
                value={orderLeverage}
                onChange={(e) => setOrderLeverage(e.target.value)}
                min="1"
                max="50"
                data-testid="input-hl-leverage"
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
                onClick={() => setOrderNotional(amt)}
                data-testid={`button-hl-quick-${amt}`}
                style={{
                  flex: 1, padding: '6px', borderRadius: 6, fontSize: 11,
                  background: '#1f2937', color: '#9ca3af', border: 'none', cursor: 'pointer',
                }}
              >
                ${amt}
              </button>
            ))}
          </div>

          <button
            onClick={placeOrder}
            disabled={placing || !orderNotional || Number(orderNotional) <= 0}
            data-testid="button-hl-place-order"
            style={{
              width: '100%', padding: '12px', borderRadius: 10, fontSize: 14, fontWeight: 600,
              background: placing ? '#4c1d95'
                : orderSide === 'LONG' ? 'linear-gradient(90deg,#16a34a,#22c55e)'
                : 'linear-gradient(90deg,#dc2626,#ef4444)',
              color: '#fff', border: 'none', cursor: placing ? 'wait' : 'pointer',
            }}
          >
            {placing
              ? 'Placing…'
              : `${orderSide} $${orderNotional || '0'} ${orderCoin} @ ${orderLeverage}x`}
          </button>

          {orderMsg && (
            <div
              style={{
                marginTop: 8, padding: 8, borderRadius: 6, fontSize: 11,
                background: /placed|filled/i.test(orderMsg) ? '#064e3b' : '#7f1d1d',
                color: /placed|filled/i.test(orderMsg) ? '#a7f3d0' : '#fecaca',
              }}
              data-testid="text-hl-order-msg"
            >
              {orderMsg}
            </div>
          )}

          <div style={{ fontSize: 10, color: '#64748b', marginTop: 10, lineHeight: 1.4 }}>
            Market orders execute immediately at best available price (5% slippage cap). BUILD4 takes a 0.1% builder fee on every fill.
          </div>
        </div>
      )}

      {/* Live mids */}
      <div style={cardStyle} data-testid="card-hl-mids">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Live prices</div>
        {COINS.map(c => (
          <div key={c}
               style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid #1f2937' }}
               data-testid={`row-hl-mid-${c}`}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{c}</span>
            <span style={{ fontSize: 13, color: mids[c] > 0 ? '#fff' : '#6b7280' }}>
              {mids[c] > 0 ? `$${mids[c].toLocaleString(undefined, { maximumFractionDigits: mids[c] < 1 ? 5 : 2 })}` : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activating, setActivating] = useState(false)
  const [activateMsg, setActivateMsg] = useState<string | null>(null)

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

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [])

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
                  One tap authorises a BUILD4 agent wallet to place orders for you on
                  Hyperliquid. Your master key never leaves the server, never signs an
                  order. Deposit USDC anytime via{' '}
                  <a href="https://app.hyperliquid.xyz/trade" target="_blank" rel="noreferrer"
                     style={{ color: '#a78bfa', textDecoration: 'underline' }}>
                    hyperliquid.xyz
                  </a>{' '}using wallet <code>{account.walletAddress.slice(0, 6)}…{account.walletAddress.slice(-4)}</code>.
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

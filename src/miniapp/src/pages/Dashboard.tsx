import { useState, useEffect } from 'react'
import { apiFetch } from '../api'

interface DashboardProps {
  userId: string | null
  onNavigate?: (page: 'dashboard' | 'agents' | 'wallet' | 'copy' | 'portfolio' | 'predictions' | 'admin') => void
}

interface WalletInfo {
  address: string
  balances: { usdt: number; bnb: number; error: string | null }
  aster: { usdt: number; availableMargin: number; onboarded: boolean; error: string | null }
}

interface RecentTrade {
  id: string
  pair?: string
  side?: string
  pnl?: number
  status?: string
  closedAt?: string
  openedAt?: string
}

function timeAgo(iso?: string): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function tradeIcon(t: RecentTrade): string {
  if (t.status === 'open') return '⏳'
  if ((t.pnl ?? 0) > 0) return '✅'
  if ((t.pnl ?? 0) < 0) return '❌'
  return '·'
}

export default function Dashboard({ userId, onNavigate }: DashboardProps) {
  const [portfolio, setPortfolio] = useState<any>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [trades, setTrades] = useState<RecentTrade[]>([])
  const [wallet, setWallet] = useState<WalletInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!userId) { setLoading(false); return }
    Promise.all([
      fetch(`/api/user/${userId}`).then(r => r.json()).catch(() => null),
      fetch(`/api/agents/${userId}`).then(r => r.json()).catch(() => []),
      apiFetch<WalletInfo>('/api/me/wallet').catch(() => null),
    ]).then(([user, agentData, walletData]) => {
      if (user?.portfolio) setPortfolio(user.portfolio)
      if (Array.isArray(agentData)) setAgents(agentData)
      if (Array.isArray(user?.recentTrades)) setTrades(user.recentTrades)
      if (walletData) setWallet(walletData)
      setLoading(false)
    })
  }, [userId])

  if (loading) {
    return (
      <div style={{ paddingTop: 60, textAlign: 'center', color: 'var(--text-secondary)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
        Loading BUILD4…
      </div>
    )
  }

  const asterUsdt = wallet?.aster?.usdt ?? 0
  const asterOnboarded = !!wallet?.aster?.onboarded
  const bscUsdt = wallet?.balances?.usdt ?? 0
  // 42.space "value" — for now we surface BSC USDT here since 42.space
  // positions live on BSC and the mini-app's open-position MTM lives in
  // the Predictions tab. This card is the user's BSC pocket / dry powder
  // available for prediction trades.
  const predValue = bscUsdt
  const totalValue = asterUsdt + bscUsdt
  const todayPnl = portfolio?.dayPnl ?? 0
  const todayPct = totalValue > 0 ? (todayPnl / totalValue) * 100 : 0

  const activeAgents = agents.filter(a => a.isActive).length
  const fmtUsd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
  const fmtPnl = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`

  const quickActions: Array<{ label: string; sub: string; testId: string; onClick: () => void; disabled?: boolean }> = [
    {
      label: 'Aster',
      sub: 'Perps',
      testId: 'button-venue-aster',
      onClick: () => onNavigate?.('agents'),
    },
    {
      label: '42.space',
      sub: 'Predict',
      testId: 'button-venue-42',
      onClick: () => onNavigate?.('predictions'),
    },
    {
      label: 'Hyperliquid',
      sub: 'soon',
      testId: 'button-venue-hyperliquid',
      onClick: () => {},
      disabled: true,
    },
  ]

  return (
    <div style={{ paddingTop: 20 }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
          ⚡ BUILD4
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
          AI Trading & Predictions
        </div>
      </div>

      {/* Hero — Total Portfolio Value */}
      <div className="card" style={{ marginBottom: 16 }} data-testid="card-total-portfolio">
        <div style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--text-secondary)',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          fontWeight: 600,
          marginBottom: 8
        }}>
          Total Portfolio Value
        </div>
        <div style={{
          fontSize: 'var(--text-2xl)',
          fontWeight: 800,
          letterSpacing: '-1px',
          lineHeight: 1.05,
          color: 'var(--text-primary)'
        }} data-testid="text-total-value">
          {fmtUsd(totalValue)}
        </div>
        <div style={{
          marginTop: 6,
          fontSize: 'var(--text-sm)',
          color: todayPnl > 0 ? 'var(--green)' : todayPnl < 0 ? 'var(--red)' : 'var(--text-secondary)',
        }} data-testid="text-today-pnl">
          {fmtPnl(todayPnl)} today ({todayPct >= 0 ? '+' : ''}{todayPct.toFixed(1)}%)
        </div>
      </div>

      {/* System split — Aster + 42.space */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
        <div className="card" data-testid="card-aster" style={{ padding: 14 }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: 0.4 }}>
            ASTER
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Futures</div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }} data-testid="text-aster-balance">
            {fmtUsd(asterUsdt)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
            {agents.length} agent{agents.length === 1 ? '' : 's'}
          </div>
          <div style={{ marginTop: 8 }}>
            <span className={`pill ${activeAgents > 0 ? 'pill-live' : asterOnboarded ? 'pill-muted' : 'pill-amber'}`}>
              <span className={activeAgents > 0 ? 'dot-live' : 'dot-muted'} />
              {activeAgents > 0 ? 'LIVE' : asterOnboarded ? 'idle' : 'not funded'}
            </span>
          </div>
        </div>

        <div className="card" data-testid="card-predictions" style={{ padding: 14 }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: 0.4 }}>
            42.SPACE
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Predictions</div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }} data-testid="text-predictions-balance">
            {fmtUsd(predValue)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
            on BSC, ready to trade
          </div>
          <div style={{ marginTop: 8 }}>
            <span className={`pill ${predValue > 0 ? 'pill-live' : 'pill-muted'}`}>
              <span className={predValue > 0 ? 'dot-live' : 'dot-muted'} />
              {predValue > 0 ? 'watching' : 'fund to start'}
            </span>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="section-label">Quick Actions</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
        {quickActions.map(a => (
          <button
            key={a.label + a.sub}
            onClick={a.onClick}
            disabled={a.disabled}
            data-testid={a.testId}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 14,
              padding: '14px 8px',
              color: a.disabled ? 'var(--text-muted)' : 'var(--text-primary)',
              cursor: a.disabled ? 'not-allowed' : 'pointer',
              opacity: a.disabled ? 0.55 : 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              textAlign: 'center'
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{a.label}</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{a.sub}</span>
          </button>
        ))}
      </div>

      {/* Recent Activity */}
      <div className="section-label">Recent Activity</div>
      <div className="card" style={{ padding: 0 }} data-testid="card-recent-activity">
        {trades.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
            No activity yet. Fund Aster or browse 42.space markets to get started.
          </div>
        ) : (
          trades.slice(0, 5).map((t, i) => {
            const pnl = t.pnl ?? 0
            const isOpen = t.status === 'open'
            return (
              <div
                key={t.id ?? i}
                data-testid={`row-activity-${t.id ?? i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  borderBottom: i < trades.slice(0, 5).length - 1 ? '1px solid var(--border)' : 'none',
                  fontSize: 13,
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: 14 }}>{tradeIcon(t)}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.side ?? ''} {t.pair ?? ''}
                  </span>
                </div>
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: isOpen ? 'var(--text-secondary)' : pnl >= 0 ? 'var(--green)' : 'var(--red)'
                }}>
                  {isOpen ? 'Open' : fmtPnl(pnl)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 28, textAlign: 'right' }}>
                  {timeAgo(t.closedAt ?? t.openedAt)}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { apiFetch } from '../api'

interface PortfolioProps {
  userId: string | null
}

type Range = '7d' | '30d' | 'all'

interface WalletInfo {
  address: string
  balances: { usdt: number; bnb: number; error: string | null }
  aster:    { usdt: number; availableMargin: number; onboarded: boolean; error: string | null }
}

export default function Portfolio({ userId }: PortfolioProps) {
  const [data, setData] = useState<any>(null)
  const [range, setRange] = useState<Range>('30d')
  const [loading, setLoading] = useState(true)
  const [wallet, setWallet] = useState<WalletInfo | null>(null)

  useEffect(() => {
    if (!userId) { setLoading(false); return }
    fetch(`/api/portfolio/${userId}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [userId])

  useEffect(() => {
    apiFetch<WalletInfo>('/api/me/wallet')
      .then(setWallet)
      .catch(() => { /* silent — balance strip just hides */ })
  }, [])

  const trades: any[] = data?.trades ?? []
  const totalPnl = trades.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0)
  const wins = trades.filter((t: any) => (t.pnl ?? 0) > 0).length
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0

  // Build cumulative PnL chart data
  const now = Date.now()
  const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : 365
  const cutoff = now - rangeDays * 86400000

  const closedTrades = trades
    .filter((t: any) => t.closedAt && new Date(t.closedAt).getTime() > cutoff)
    .sort((a: any, b: any) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime())

  let cumulative = 0
  const chartData = closedTrades.map((t: any) => {
    cumulative += t.pnl ?? 0
    return {
      date: new Date(t.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      pnl: parseFloat(cumulative.toFixed(2))
    }
  })

  if (chartData.length === 0) {
    chartData.push({ date: 'Start', pnl: 0 })
  }

  const chartColor = totalPnl >= 0 ? '#10b981' : '#ef4444'

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>📊 Portfolio</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
          Your trading performance
        </div>
      </div>

      {/* Negative balance banner — agents are paused when balance ≤ 0 */}
      {wallet?.aster.onboarded && wallet.aster.usdt <= 0 && (
        <div
          data-testid="banner-negative-balance"
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'linear-gradient(135deg, #ef444422, #ef444408)',
            border: '1px solid #ef444466',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8
          }}>
          <div style={{ fontSize: 16, lineHeight: 1 }}>⚠️</div>
          <div style={{ fontSize: 12, color: '#fca5a5', lineHeight: 1.4 }}>
            <div style={{ fontWeight: 600, color: '#ef4444' }}>Negative balance — agents paused</div>
            <div style={{ marginTop: 2 }}>
              Deposit USDT to your Aster account to resume trading. Realized losses, funding fees, or commissions exceed your deposit.
            </div>
          </div>
        </div>
      )}

      {/* Balances — same data as the Wallet tab, condensed for a glance */}
      {wallet && (
        <div className="card" style={{ marginBottom: 16 }} data-testid="card-portfolio-balances">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: '#64748b', letterSpacing: 0.4 }}>BALANCES</div>
            <div style={{ fontSize: 10, color: wallet.aster.onboarded ? '#10b981' : '#64748b' }}>
              {wallet.aster.onboarded ? '● Trading active' : '○ Not activated'}
            </div>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10
          }}>
            {/* Aster card — primary if onboarded; red if negative */}
            {(() => {
              const isNegative = wallet.aster.onboarded && wallet.aster.usdt <= 0
              const accentColor = isNegative
                ? '#ef4444'
                : (wallet.aster.onboarded ? '#10b981' : '#e2e8f0')
              const cardBg = isNegative
                ? 'linear-gradient(135deg, #ef444422, #ef444408)'
                : (wallet.aster.onboarded
                    ? 'linear-gradient(135deg, #10b98122, #10b98108)'
                    : '#0f0f17')
              const cardBorder = isNegative
                ? '#ef444466'
                : (wallet.aster.onboarded ? '#10b98144' : '#1e1e2e')
              return (
                <div style={{
                  padding: 10,
                  borderRadius: 8,
                  background: cardBg,
                  border: `1px solid ${cardBorder}`
                }}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {isNegative && <span>⚠️</span>}
                    <span>ASTER · USDT</span>
                  </div>
                  <div style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: accentColor
                  }} data-testid="text-portfolio-aster-usdt">
                    {wallet.aster.usdt < 0 ? '-' : ''}${Math.abs(wallet.aster.usdt).toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                    Avail {wallet.aster.availableMargin < 0 ? '-' : ''}${Math.abs(wallet.aster.availableMargin).toFixed(2)}
                  </div>
                </div>
              )
            })()}

            {/* BSC card */}
            <div style={{
              padding: 10,
              borderRadius: 8,
              background: '#0f0f17',
              border: '1px solid #1e1e2e'
            }}>
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4 }}>BSC · USDT</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}
                   data-testid="text-portfolio-bsc-usdt">
                ${wallet.balances.usdt.toFixed(2)}
              </div>
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                BNB {wallet.balances.bnb.toFixed(5)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'Total PnL', value: `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`, color: totalPnl >= 0 ? '#10b981' : '#ef4444' },
          { label: 'Win Rate', value: `${winRate.toFixed(1)}%`, color: '#e2e8f0' },
          { label: 'Total Trades', value: trades.length, color: '#e2e8f0' },
          { label: 'Best Trade', value: `+$${Math.max(0, ...trades.map((t: any) => t.pnl ?? 0)).toFixed(2)}`, color: '#10b981' }
        ].map(stat => (
          <div key={stat.label} className="card">
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{stat.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Cumulative PnL</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['7d', '30d', 'all'] as Range[]).map(r => (
              <button key={r} onClick={() => setRange(r)} style={{
                padding: '3px 10px', borderRadius: 6, fontSize: 11,
                background: range === r ? '#7c3aed' : 'transparent',
                border: `1px solid ${range === r ? '#7c3aed' : '#1e1e2e'}`,
                color: range === r ? 'white' : '#64748b',
                cursor: 'pointer'
              }}>{r}</button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={chartData}>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} width={50} tickFormatter={v => `$${v}`} />
            <Tooltip
              contentStyle={{ background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 8, fontSize: 12 }}
              formatter={(v: any) => [`$${v}`, 'PnL']}
            />
            <Line type="monotone" dataKey="pnl" stroke={chartColor} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Trade history */}
      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Trade History</div>
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>Loading...</div>
        ) : trades.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>No trades yet.</div>
        ) : (
          trades.slice(0, 10).map((t: any) => (
            <div key={t.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 0', borderBottom: '1px solid #1e1e2e'
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{t.pair}</span>
                  <span style={{
                    fontSize: 10, padding: '1px 6px', borderRadius: 4,
                    background: t.side === 'LONG' ? '#10b98115' : '#ef444415',
                    color: t.side === 'LONG' ? '#10b981' : '#ef4444'
                  }}>{t.side}</span>
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
                  {t.closedAt ? new Date(t.closedAt).toLocaleDateString() : 'Open'}
                  {t.aiReasoning && (
                    <span style={{ marginLeft: 6, color: '#7c3aed' }}>· AI</span>
                  )}
                </div>
              </div>
              <div style={{
                fontSize: 14, fontWeight: 600,
                color: (t.pnl ?? 0) >= 0 ? '#10b981' : '#ef4444'
              }}>
                {t.status === 'open' ? (
                  <span style={{ color: '#64748b', fontSize: 12 }}>Open</span>
                ) : (
                  `${(t.pnl ?? 0) >= 0 ? '+' : ''}$${(t.pnl ?? 0).toFixed(2)}`
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

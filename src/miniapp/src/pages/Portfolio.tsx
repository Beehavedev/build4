import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

interface PortfolioProps {
  userId: string | null
}

type Range = '7d' | '30d' | 'all'

export default function Portfolio({ userId }: PortfolioProps) {
  const [data, setData] = useState<any>(null)
  const [range, setRange] = useState<Range>('30d')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!userId) { setLoading(false); return }
    fetch(`/api/portfolio/${userId}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [userId])

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
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>📊 Portfolio</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
          Your trading performance
        </div>
      </div>

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

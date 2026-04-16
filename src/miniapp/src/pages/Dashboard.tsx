import { useState, useEffect } from 'react'

interface DashboardProps {
  userId: string | null
}

export default function Dashboard({ userId }: DashboardProps) {
  const [portfolio, setPortfolio] = useState<any>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [trades, setTrades] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!userId) { setLoading(false); return }
    Promise.all([
      fetch(`/api/user/${userId}`).then(r => r.json()).catch(() => null),
      fetch(`/api/agents/placeholder`).then(r => r.json()).catch(() => []),
    ]).then(([user, agentData]) => {
      if (user?.portfolio) setPortfolio(user.portfolio)
      if (Array.isArray(agentData)) setAgents(agentData)
      setLoading(false)
    })
  }, [userId])

  const todayPnl = portfolio?.dayPnl ?? 0
  const totalPnl = portfolio?.totalPnl ?? 0
  const activeAgents = agents.filter(a => a.isActive).length

  if (loading) {
    return (
      <div style={{ paddingTop: 60, textAlign: 'center', color: '#64748b' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
        Loading BUILD4...
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 20 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
          ⚡ BUILD4
        </div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
          AI Crypto Trading
        </div>
      </div>

      {/* PnL Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>TODAY'S PnL</div>
          <div style={{
            fontSize: 22,
            fontWeight: 700,
            color: todayPnl >= 0 ? '#10b981' : '#ef4444'
          }}>
            {todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>ALL-TIME PnL</div>
          <div style={{
            fontSize: 22,
            fontWeight: 700,
            color: totalPnl >= 0 ? '#10b981' : '#ef4444'
          }}>
            {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Agent status */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, color: '#64748b' }}>Active Agents</div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>
              {activeAgents} <span style={{ fontSize: 13, color: '#64748b' }}>/ {agents.length}</span>
            </div>
          </div>
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            background: activeAgents > 0 ? '#10b98120' : '#1e1e2e',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22
          }}>
            🤖
          </div>
        </div>
        {agents.slice(0, 2).map(agent => (
          <div key={agent.id} style={{
            marginTop: 12, paddingTop: 12,
            borderTop: '1px solid #1e1e2e',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center'
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{agent.name}</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>
                {agent.pairs?.join(', ')} · {agent.exchange}
              </div>
            </div>
            <div style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 20,
              background: agent.isActive ? '#10b98120' : '#1e1e2e',
              color: agent.isActive ? '#10b981' : '#64748b'
            }}>
              {agent.isActive ? '● LIVE' : '○ OFF'}
            </div>
          </div>
        ))}
        {agents.length === 0 && (
          <div style={{ marginTop: 12, fontSize: 13, color: '#64748b' }}>
            No agents yet. Use /newagent in the bot.
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
        {[
          { icon: '📊', label: 'Signals' },
          { icon: '🔍', label: 'Scan' },
          { icon: '🏆', label: 'Quests' }
        ].map(item => (
          <button key={item.label} style={{
            background: '#12121a',
            border: '1px solid #1e1e2e',
            borderRadius: 10,
            padding: '12px 8px',
            color: '#e2e8f0',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4
          }}>
            <span style={{ fontSize: 22 }}>{item.icon}</span>
            <span style={{ fontSize: 11 }}>{item.label}</span>
          </button>
        ))}
      </div>

      {/* Recent activity */}
      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Recent Activity</div>
        {trades.length === 0 ? (
          <div style={{ fontSize: 13, color: '#64748b' }}>
            No trades yet. Start an agent to begin.
          </div>
        ) : (
          trades.slice(0, 5).map((t: any) => (
            <div key={t.id} style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '8px 0', borderBottom: '1px solid #1e1e2e'
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{t.pair} {t.side}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  {new Date(t.openedAt).toLocaleDateString()}
                </div>
              </div>
              <div style={{
                fontSize: 13, fontWeight: 600,
                color: (t.pnl ?? 0) >= 0 ? '#10b981' : '#ef4444'
              }}>
                {(t.pnl ?? 0) >= 0 ? '+' : ''}${(t.pnl ?? 0).toFixed(2)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

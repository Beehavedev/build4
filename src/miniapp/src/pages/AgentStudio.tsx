import { useState, useEffect } from 'react'
import { apiFetch } from '../api'

interface AgentStudioProps {
  userId: string | null
}

export default function AgentStudio(_props: AgentStudioProps) {
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const fetchAgents = () => {
    apiFetch<any[]>('/api/me/agents')
      .then(data => { setAgents(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { fetchAgents() }, [])

  const toggleAgent = async (agentId: string) => {
    await apiFetch(`/api/agents/${agentId}/toggle`, { method: 'POST' })
    fetchAgents()
  }

  if (loading) {
    return <div style={{ paddingTop: 60, textAlign: 'center', color: '#64748b' }}>Loading agents...</div>
  }

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>🤖 Agent Studio</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
          Manage your AI trading agents
        </div>
      </div>

      {debug && (
        <div style={{ fontSize: 10, color: '#64748b', padding: 8, marginBottom: 12, background: '#0a0a14', borderRadius: 6, wordBreak: 'break-all' }}>
          {debug}
        </div>
      )}

      {agents.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>No Agents Yet</div>
          <div style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
            Create your first AI trading agent using /newagent in the bot.
          </div>
        </div>
      ) : (
        agents.map(agent => (
          <div key={agent.id} className="card" style={{ marginBottom: 12 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{agent.name}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  {agent.exchange} · {agent.pairs?.join(', ')}
                </div>
              </div>
              {/* Toggle */}
              <button
                onClick={() => toggleAgent(agent.id)}
                style={{
                  width: 48, height: 26, borderRadius: 13,
                  background: agent.isActive ? '#7c3aed' : '#1e1e2e',
                  border: 'none', cursor: 'pointer', position: 'relative',
                  transition: 'background 0.2s'
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: '50%', background: 'white',
                  position: 'absolute', top: 3,
                  left: agent.isActive ? 25 : 3,
                  transition: 'left 0.2s'
                }} />
              </button>
            </div>

            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
              {[
                { label: 'Total PnL', value: `${agent.totalPnl >= 0 ? '+' : ''}$${agent.totalPnl?.toFixed(2) ?? '0.00'}`, color: agent.totalPnl >= 0 ? '#10b981' : '#ef4444' },
                { label: 'Win Rate', value: `${agent.winRate?.toFixed(0) ?? 0}%`, color: '#e2e8f0' },
                { label: 'Trades', value: agent.totalTrades ?? 0, color: '#e2e8f0' }
              ].map(stat => (
                <div key={stat.label} style={{ background: '#0a0a0f', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 2 }}>{stat.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: stat.color }}>{stat.value}</div>
                </div>
              ))}
            </div>

            {/* Risk settings */}
            <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.8 }}>
              Max position: <span style={{ color: '#e2e8f0' }}>${agent.maxPositionSize}</span>
              {' · '}
              Max loss/day: <span style={{ color: '#e2e8f0' }}>${agent.maxDailyLoss}</span>
              {' · '}
              Max leverage: <span style={{ color: '#e2e8f0' }}>{agent.maxLeverage}x</span>
            </div>

            {/* Status badge */}
            <div style={{
              marginTop: 10,
              display: 'inline-block',
              fontSize: 11, padding: '3px 10px', borderRadius: 20,
              background: agent.isActive ? '#10b98115' : '#1e1e2e',
              color: agent.isActive ? '#10b981' : '#64748b'
            }}>
              {agent.isActive ? '● Active — next tick in ~60s' : '○ Inactive'}
            </div>
          </div>
        ))
      )}

      <div style={{ marginTop: 8, fontSize: 12, color: '#64748b', textAlign: 'center' }}>
        Use /newagent in the bot to create more agents
      </div>
    </div>
  )
}

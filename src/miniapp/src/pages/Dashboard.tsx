import { useState, useEffect } from 'react'
import SwarmStatsPanel from '../components/SwarmStatsPanel'

interface DashboardProps {
  userId: string | null
}

export default function Dashboard({ userId }: DashboardProps) {
  const [portfolio, setPortfolio] = useState<any>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [trades, setTrades] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [signalsOpen, setSignalsOpen] = useState(false)
  const [signals, setSignals] = useState<any[]>([])
  const [signalsLoading, setSignalsLoading] = useState(false)
  const [swarm, setSwarm] = useState<any>(null)
  const [swarmError, setSwarmError] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) { setLoading(false); return }
    Promise.all([
      fetch(`/api/user/${userId}`).then(r => r.json()).catch(() => null),
      fetch(`/api/agents/${userId}`).then(r => r.json()).catch(() => []),
    ]).then(([user, agentData]) => {
      if (user?.portfolio) setPortfolio(user.portfolio)
      if (Array.isArray(agentData)) setAgents(agentData)
      if (Array.isArray(user?.recentTrades)) setTrades(user.recentTrades)
      setLoading(false)
    })
  }, [userId])

  useEffect(() => {
    fetch('/api/admin/swarm-divergence?days=7')
      .then(async (r) => {
        if (r.status === 401) { setSwarmError('locked'); return null }
        if (r.status === 503) { setSwarmError('unavailable'); return null }
        if (!r.ok) { setSwarmError('error'); return null }
        return r.json()
      })
      .then((data) => { if (data) setSwarm(data) })
      .catch(() => setSwarmError('error'))
  }, [])

  const tg = (typeof window !== 'undefined' ? window.Telegram?.WebApp : null) as any

  const openSignals = async () => {
    setSignalsOpen(true)
    if (signals.length > 0) return
    setSignalsLoading(true)
    try {
      const data = await fetch('/api/signals').then(r => r.json())
      setSignals(Array.isArray(data) ? data : (data?.signals ?? []))
    } catch {
      setSignals([])
    } finally {
      setSignalsLoading(false)
    }
  }

  const showComingSoon = (label: string) => {
    const msg = `${label} is coming soon. Stay tuned!`
    if (tg?.showAlert) tg.showAlert(msg)
    else alert(msg)
  }

  const quickActions = [
    { icon: '📊', label: 'Signals', onClick: openSignals },
    { icon: '🔍', label: 'Scan', onClick: () => showComingSoon('Market Scan') },
    { icon: '🏆', label: 'Quests', onClick: () => showComingSoon('Quests') },
  ]

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

      {/* Swarm cost & speed roll-up (mirrors /swarmstats Telegram command) */}
      <SwarmStatsPanel />

      {/* Swarm agreement panel */}
      {(swarm || swarmError) && (
        <div className="card" style={{ marginBottom: 16 }} data-testid="card-swarm-divergence">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>🐝 Swarm Agreement (7d)</div>
            {swarm && (
              <div style={{ fontSize: 11, color: '#64748b' }} data-testid="text-swarm-total">
                {swarm.overall.total} ticks
              </div>
            )}
          </div>
          {swarmError === 'unavailable' && (
            <div style={{ fontSize: 12, color: '#64748b' }}>Swarm telemetry not enabled on this database.</div>
          )}
          {swarmError === 'locked' && (
            <div style={{ fontSize: 12, color: '#64748b' }}>Restricted — admin token required.</div>
          )}
          {swarmError === 'error' && (
            <div style={{ fontSize: 12, color: '#64748b' }}>Couldn't load swarm stats.</div>
          )}
          {swarm && swarm.overall.total === 0 && (
            <div style={{ fontSize: 12, color: '#64748b' }}>No swarm activity in the last 7 days.</div>
          )}
          {swarm && swarm.overall.total > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
                <div
                  data-testid="text-swarm-fallback-pct"
                  style={{
                    fontSize: 22, fontWeight: 700,
                    color: swarm.overall.fallbackPct >= 50 ? '#ef4444'
                      : swarm.overall.fallbackPct >= 25 ? '#f59e0b' : '#10b981',
                  }}
                >
                  {swarm.overall.fallbackPct}%
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  fell back to single-provider ({swarm.overall.fallback}/{swarm.overall.total})
                </div>
              </div>

              {swarm.byPair.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>TOP DIVERGENT PAIRS</div>
                  {[...swarm.byPair]
                    .filter((p: any) => p.total >= 3)
                    .sort((a: any, b: any) => b.fallbackPct - a.fallbackPct)
                    .slice(0, 3)
                    .map((p: any) => (
                      <div
                        key={p.pair}
                        data-testid={`row-swarm-pair-${p.pair}`}
                        style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}
                      >
                        <span>{p.pair}</span>
                        <span style={{ color: '#64748b' }}>
                          {p.fallbackPct}% · {p.fallback}/{p.total}
                        </span>
                      </div>
                    ))}
                  {swarm.byPair.filter((p: any) => p.total >= 3).length === 0 && (
                    <div style={{ fontSize: 12, color: '#64748b' }}>Not enough samples per pair yet.</div>
                  )}
                </div>
              )}

              {swarm.byProvider.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>PER-PROVIDER PARTICIPATION</div>
                  {swarm.byProvider.slice(0, 5).map((p: any) => (
                    <div
                      key={p.provider}
                      data-testid={`row-swarm-provider-${p.provider}`}
                      style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}
                    >
                      <span>{p.provider}</span>
                      <span style={{ color: '#64748b' }}>
                        {p.total} ticks · {p.fallbackPct}% no-quorum
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
        {quickActions.map(item => (
          <button
            key={item.label}
            onClick={item.onClick}
            data-testid={`button-${item.label.toLowerCase()}`}
            style={{
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
            }}
          >
            <span style={{ fontSize: 22 }}>{item.icon}</span>
            <span style={{ fontSize: 11 }}>{item.label}</span>
          </button>
        ))}
      </div>

      {/* Signals modal */}
      {signalsOpen && (
        <div
          onClick={() => setSignalsOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            zIndex: 200, display: 'flex', alignItems: 'flex-end',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#12121a', borderTop: '1px solid #1e1e2e',
              borderRadius: '16px 16px 0 0', padding: 16, width: '100%',
              maxHeight: '70vh', overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>📊 Live Signals</div>
              <button
                onClick={() => setSignalsOpen(false)}
                data-testid="button-close-signals"
                style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 22, cursor: 'pointer' }}
              >
                ×
              </button>
            </div>
            {signalsLoading && (
              <div style={{ color: '#64748b', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                Loading signals...
              </div>
            )}
            {!signalsLoading && signals.length === 0 && (
              <div style={{ color: '#64748b', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                No signals available right now.
              </div>
            )}
            {!signalsLoading && signals.map((s: any, i: number) => (
              <div
                key={s.id ?? s.symbol ?? i}
                data-testid={`row-signal-${i}`}
                style={{
                  padding: '10px 0', borderBottom: '1px solid #1e1e2e',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {s.symbol ?? s.pair ?? s.coin ?? '—'}
                  </div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>
                    {s.reason ?? s.note ?? s.summary ?? ''}
                  </div>
                </div>
                <div style={{
                  fontSize: 11, padding: '3px 8px', borderRadius: 20,
                  background: (s.action ?? s.side) === 'LONG' || (s.action ?? s.side) === 'BUY'
                    ? '#10b98120'
                    : (s.action ?? s.side) === 'SHORT' || (s.action ?? s.side) === 'SELL'
                    ? '#ef444420'
                    : '#1e1e2e',
                  color: (s.action ?? s.side) === 'LONG' || (s.action ?? s.side) === 'BUY'
                    ? '#10b981'
                    : (s.action ?? s.side) === 'SHORT' || (s.action ?? s.side) === 'SELL'
                    ? '#ef4444'
                    : '#64748b',
                }}>
                  {s.action ?? s.side ?? 'INFO'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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

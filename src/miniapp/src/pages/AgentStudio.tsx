import { useState, useEffect } from 'react'
import { apiFetch, getMyFeed, type FeedEntry } from '../api'
import { TradingChart } from '../components/TradingChart'
import { MarketTicker } from '../components/MarketTicker'

interface AgentStudioProps {
  userId: string | null
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function actionMeta(a: string): { emoji: string; label: string; color: string } {
  if (a === 'OPEN_LONG') return { emoji: '🚀', label: 'LONG', color: '#10b981' }
  if (a === 'OPEN_SHORT') return { emoji: '🔻', label: 'SHORT', color: '#ef4444' }
  if (a === 'CLOSE') return { emoji: '✋', label: 'CLOSE', color: '#f59e0b' }
  return { emoji: '🤔', label: 'HOLD', color: '#64748b' }
}

export default function AgentStudio(_props: AgentStudioProps) {
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [feed, setFeed] = useState<FeedEntry[]>([])
  const [feedError, setFeedError] = useState(false)
  // Per-agent expand state: which agent's full chart is currently shown.
  // Only one chart visible at a time so we don't mount many TradingView
  // iframes for users with lots of agents (memory + scroll cost).
  const [openChartAgentId, setOpenChartAgentId] = useState<string | null>(null)
  // Per-agent currently-selected pair for the in-card ticker/chart. Defaults
  // to the first pair the agent watches; user can flip between the agent's
  // watched pairs via chips.
  const [agentPairSel, setAgentPairSel] = useState<Record<string, string>>({})

  const fetchAgents = () => {
    apiFetch<any[]>('/api/me/agents')
      .then(data => { setAgents(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  const fetchFeed = () => {
    getMyFeed(20)
      .then(f => { setFeed(Array.isArray(f) ? f : []); setFeedError(false) })
      .catch(() => setFeedError(true))
  }

  useEffect(() => {
    fetchAgents()
    fetchFeed()
    // Poll the brain feed every 30s so users see new decisions stream in
    // without leaving and re-entering the mini app.
    const t = setInterval(fetchFeed, 30_000)
    return () => clearInterval(t)
  }, [])

  const toggleAgent = async (agentId: string) => {
    await apiFetch(`/api/agents/${agentId}/toggle`, { method: 'POST' })
    fetchAgents()
  }

  const hasActive = agents.some(a => a.isActive)

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

      {agents.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>No Agents Yet</div>
          <div style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
            Create your first AI trading agent using /newagent in the bot.
          </div>
        </div>
      ) : (
        agents.map(agent => {
          // AUTO-mode agents don't watch a single ticker — they pick the
          // hottest pair from a multi-coin scan each tick. So a literal
          // "AUTOUSDT" symbol must never reach MarketTicker (it 404s on
          // Binance and surfaces a "ticker unavailable" amber banner —
          // an internal failure leaking into the user's UI). We branch
          // here and render a calmer subtitle + skip the per-pair widgets
          // entirely.
          const isAuto = Array.isArray(agent.pairs) && agent.pairs.includes('AUTO')
          const watched: string[] = Array.isArray(agent.pairs) ? agent.pairs.filter((p: string) => p !== 'AUTO') : []
          // Total PnL colour: green when positive, red when negative,
          // muted neutral when exactly zero (most new agents). Previously
          // a freshly-created agent with $0.00 lifetime PnL still rendered
          // in green which confused users into thinking they had won the
          // coin toss before placing a single trade.
          const pnlValue = agent.totalPnl ?? 0
          const pnlColor = pnlValue > 0 ? '#10b981' : pnlValue < 0 ? '#ef4444' : 'var(--text-secondary)'
          return (
          <div key={agent.id} className="card" style={{ marginBottom: 12 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }} data-testid={`text-agent-name-${agent.id}`}>{agent.name}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  {isAuto
                    ? `${agent.exchange} · AUTO — scanning the market`
                    : `${agent.exchange} · ${agent.pairs?.join(', ')}`}
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
                { label: 'Total PnL', value: `${pnlValue > 0 ? '+' : pnlValue < 0 ? '-' : ''}$${Math.abs(pnlValue).toFixed(2)}`, color: pnlColor },
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

            {/* Live market block — only renders for single-ticker agents.
                AUTO-mode agents scan many pairs each tick, so there is no
                single chart to embed and no single 24h row that means
                anything; rendering the ticker for them produced the
                "ticker unavailable for AUTOUSDT" amber banner the user
                reported. We hide the whole block in that case. */}
            {!isAuto && watched.length > 0 && (() => {
              const selected = agentPairSel[agent.id] ?? watched[0]
              const isOpen = openChartAgentId === agent.id
              return (
                <div style={{ marginTop: 12 }}>
                  {watched.length > 1 && (
                    <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                      {watched.map(p => (
                        <button
                          key={p}
                          onClick={() => setAgentPairSel(s => ({ ...s, [agent.id]: p }))}
                          data-testid={`button-agent-${agent.id}-pair-${p}`}
                          style={{
                            padding: '4px 8px', fontSize: 11, fontWeight: 600,
                            borderRadius: 6, border: 'none', cursor: 'pointer',
                            background: selected === p ? '#7c3aed' : '#1f2937',
                            color: selected === p ? '#fff' : '#9ca3af',
                          }}
                        >{p}</button>
                      ))}
                    </div>
                  )}
                  <MarketTicker
                    symbol={selected}
                    testIdPrefix={`agent-${agent.id}-ticker`}
                    pollMs={8000}
                  />
                  <button
                    onClick={() => setOpenChartAgentId(isOpen ? null : agent.id)}
                    data-testid={`button-agent-${agent.id}-toggle-chart`}
                    style={{
                      width: '100%', padding: '8px 10px', borderRadius: 8,
                      background: isOpen ? '#1f2937' : '#0f1117',
                      border: '1px solid #2a2a3e', color: '#a78bfa',
                      fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    {isOpen ? '▴ Hide chart' : `▾ Open chart · ${selected}`}
                  </button>
                  {isOpen && (
                    <div style={{ marginTop: 8 }}>
                      <TradingChart
                        symbol={selected}
                        defaultInterval="15"
                        height={280}
                        testIdPrefix={`agent-${agent.id}-chart`}
                      />
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
          )
        })
      )}

      <div style={{ marginTop: 8, fontSize: 12, color: '#64748b', textAlign: 'center' }}>
        Use /newagent in the bot to create more agents
      </div>

      {/* Live Brain Feed — shows what the agents are actually doing */}
      <div style={{ marginTop: 24, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-brain-feed-title">
          🧠 Live Agent Brain
        </div>
        {hasActive && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: '#10b981',
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', background: '#10b981',
              animation: 'pulse 1.6s ease-in-out infinite',
            }} />
            Scanning markets every ~60s
          </div>
        )}
      </div>

      {feedError && (
        <div className="card" style={{ padding: 14, fontSize: 12, color: '#ef4444' }}>
          Couldn't load the brain feed. The agent is still running in the background.
        </div>
      )}

      {!feedError && feed.length === 0 && (
        <div className="card" style={{ padding: 14, fontSize: 12, color: '#64748b' }}>
          {hasActive
            ? 'No decisions logged yet. The next analysis cycle will appear here within ~60s.'
            : 'Activate an agent above and its trade decisions will stream in here.'}
        </div>
      )}

      {!feedError && feed.map((e) => {
        const meta = actionMeta(e.action)
        return (
          <div
            key={e.id}
            className="card"
            data-testid={`feed-${e.id}`}
            style={{ marginBottom: 8, borderLeft: `3px solid ${meta.color}`, padding: 12 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>🤖 {e.agentName}</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>{timeAgo(e.createdAt)}</div>
            </div>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              {meta.emoji}{' '}
              <span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span>
              {e.pair ? ` — ${e.pair}` : ''}
              {e.price != null ? ` @ $${e.price.toFixed(e.price > 100 ? 2 : 4)}` : ''}
            </div>
            {(e.regime || e.adx != null || e.rsi != null || e.score != null) && (
              <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8' }}>
                {e.regime ? `${e.regime}` : ''}
                {e.adx != null ? ` · ADX ${e.adx.toFixed(1)}` : ''}
                {e.rsi != null ? ` · RSI ${e.rsi.toFixed(0)}` : ''}
                {e.score != null ? ` · Score ${e.score}/10` : ''}
              </div>
            )}
            {e.reason && (
              <div
                style={{ marginTop: 6, fontSize: 12, color: '#cbd5e1', fontStyle: 'italic' }}
                data-testid={`feed-reason-${e.id}`}
              >
                "{e.reason}"
              </div>
            )}
          </div>
        )
      })}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.85); }
        }
      `}</style>
    </div>
  )
}

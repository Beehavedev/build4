import { useState, useEffect } from 'react'
import { apiFetch, getMyFeed, type FeedEntry } from '../api'
import { TradingChart } from '../components/TradingChart'
import { MarketTicker } from '../components/MarketTicker'

interface AgentStudioProps {
  userId: string | null
}

// Three first-class venues, displayed as fixed sections in this order so a
// user with zero agents on a given venue still sees a clear "you can trade
// here too" affordance instead of the venue silently disappearing.
type VenueId = 'aster' | 'hyperliquid' | 'fortytwo'
interface VenueConfig {
  id: VenueId
  label: string
  sub: string
  accent: string
}
const VENUES: VenueConfig[] = [
  { id: 'aster',       label: 'Aster',      sub: 'Perp DEX · BSC',         accent: '#f97316' },
  { id: 'hyperliquid', label: 'Hyperliquid', sub: 'L1 perps',               accent: '#22d3ee' },
  { id: 'fortytwo',    label: '42.space',    sub: 'Prediction markets',     accent: '#a78bfa' },
]

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

// Map an agent's `exchange` value to a venue bucket. Anything that doesn't
// match a known venue (legacy "mock" agents, future venues) falls through to
// `other` and renders below the three first-class sections. Lowercased
// defensively so a stray "Aster" / "HyperLiquid" doesn't end up in "other".
function venueOf(exchange: string | undefined): VenueId | 'other' {
  const x = (exchange ?? '').toLowerCase()
  if (x === 'aster' || x === 'hyperliquid' || x === 'fortytwo') return x as VenueId
  return 'other'
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
  // 42.space live-mode opt-in. `null` while the initial fetch is in flight
  // so the master toggle stays disabled until we know the real state (avoids
  // a flash of "OFF" that the user might accidentally tap into ON).
  const [predictionsLive, setPredictionsLive] = useState<boolean | null>(null)
  // Per-venue busy flag for the master toggle. We disable the button while
  // the underlying fan-out of per-agent toggles is in flight to prevent the
  // user double-tapping and ending up with a half-paused venue.
  const [busyVenue, setBusyVenue] = useState<VenueId | null>(null)

  // Fetchers return the underlying promise so the venue master toggles can
  // `await` the refresh before clearing their busy flag — otherwise a fast
  // second tap could fire against stale `agents` / `predictionsLive` state
  // and produce off-by-one counts or the wrong "enable vs pause" decision.
  const fetchAgents = () => {
    return apiFetch<any[]>('/api/me/agents')
      .then(data => { setAgents(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => { setLoading(false) })
  }

  const fetchFeed = () => {
    return getMyFeed(20)
      .then(f => { setFeed(Array.isArray(f) ? f : []); setFeedError(false) })
      .catch(() => setFeedError(true))
  }

  const fetchPredictionsMode = () => {
    return apiFetch<{ ok: boolean; liveOptIn: boolean }>('/api/me/predictions-mode')
      .then(r => setPredictionsLive(!!r?.liveOptIn))
      // If the lookup fails we default to OFF — never silently flip a user
      // into LIVE mode just because the read failed.
      .catch(() => setPredictionsLive(false))
  }

  useEffect(() => {
    fetchAgents()
    fetchFeed()
    fetchPredictionsMode()
    // Poll the brain feed every 30s so users see new decisions stream in
    // without leaving and re-entering the mini app.
    const t = setInterval(fetchFeed, 30_000)
    return () => clearInterval(t)
  }, [])

  const toggleAgent = async (agentId: string) => {
    await apiFetch(`/api/agents/${agentId}/toggle`, { method: 'POST' })
    fetchAgents()
  }

  // Master toggle for an Aster/HL section — flips every agent on that
  // venue to a single target state. We only call /toggle on agents that
  // are currently in the *opposite* state so a partially-active section
  // (e.g. 2 of 3 active) coalesces to "all on" with one tap rather than
  // accidentally pausing the two that were already running.
  const setVenueActive = async (venue: VenueId, active: boolean) => {
    if (busyVenue) return
    setBusyVenue(venue)
    try {
      const targets = agents.filter(a => venueOf(a.exchange) === venue && !!a.isActive !== active)
      await Promise.all(
        targets.map(a =>
          apiFetch(`/api/agents/${a.id}/toggle`, { method: 'POST' }).catch(() => null)
        )
      )
      // Await the refetch — clearing busy before the new agent list lands in
      // state would let a fast double-tap operate on stale `activeCount`.
      await fetchAgents()
    } finally {
      setBusyVenue(null)
    }
  }

  // 42.space master toggle — flips User.fortyTwoLiveTrade. This is the
  // single switch that gates *all* prediction-trading on 42.space (both
  // autonomous-agent trades and the manual "Place trade" path on the
  // Predict tab), so it functions as the venue-level enable/disable even
  // though there are usually no Agent rows targeting "fortytwo".
  const setPredictionsLiveMode = async (enabled: boolean) => {
    if (busyVenue) return
    setBusyVenue('fortytwo')
    const previous = predictionsLive
    setPredictionsLive(enabled) // optimistic
    try {
      const res = await apiFetch<{ ok: boolean; liveOptIn: boolean }>(
        '/api/me/predictions-mode',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }
      )
      setPredictionsLive(!!res?.liveOptIn)
    } catch {
      // Revert on error so the UI never lies about the server state.
      setPredictionsLive(previous)
    } finally {
      setBusyVenue(null)
    }
  }

  // Pulse the brain feed only when the user has at least one active per-user
  // agent — the 42.space live-mode opt-in alone doesn't drive the
  // "scanning markets every 60s" indicator (manual taps + the swarm do).
  const hasActive = agents.some(a => a.isActive)

  if (loading) {
    return <div style={{ paddingTop: 60, textAlign: 'center', color: '#64748b' }}>Loading agents...</div>
  }

  // Bucket agents into the three known venues plus an "other" catch-all.
  const buckets: Record<VenueId | 'other', any[]> = {
    aster: [], hyperliquid: [], fortytwo: [], other: [],
  }
  for (const a of agents) buckets[venueOf(a.exchange)].push(a)

  const renderAgentCard = (agent: any) => {
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
    // muted neutral when exactly zero (most new agents).
    const pnlValue = agent.totalPnl ?? 0
    const pnlColor = pnlValue > 0 ? '#10b981' : pnlValue < 0 ? '#ef4444' : 'var(--text-secondary)'
    return (
      <div key={agent.id} className="card" style={{ marginBottom: 10 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }} data-testid={`text-agent-name-${agent.id}`}>{agent.name}</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>
              {isAuto
                ? `${agent.exchange} · AUTO — scanning the market`
                : `${agent.exchange} · ${agent.pairs?.join(', ')}`}
            </div>
          </div>
          {/* Per-agent toggle */}
          <button
            onClick={() => toggleAgent(agent.id)}
            data-testid={`button-agent-toggle-${agent.id}`}
            aria-label={agent.isActive ? 'Pause agent' : 'Enable agent'}
            style={{
              width: 48, height: 26, borderRadius: 13,
              background: agent.isActive ? '#7c3aed' : '#1e1e2e',
              border: 'none', cursor: 'pointer', position: 'relative',
              transition: 'background 0.2s',
              flexShrink: 0,
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
            single chart to embed. */}
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
  }

  const renderVenueSection = (v: VenueConfig) => {
    const list = buckets[v.id]
    const activeCount = list.filter(a => a.isActive).length
    const isFortyTwo = v.id === 'fortytwo'

    // For Aster/HL the "venue is on" question is "any agent active?".
    // For 42.space the prediction-mode opt-in is the single source of truth
    // since agents on that venue are rare (predictions are usually driven
    // by manual taps + the swarm, both gated by the same flag).
    const masterOn = isFortyTwo
      ? predictionsLive === true
      : activeCount > 0

    // 42.space master toggle is disabled until we've fetched the real
    // predictions-mode state, otherwise tapping it would flip a user from
    // an unknown server state to "ON" optimistically and possibly fight
    // the backend's true state on the next refresh.
    const masterDisabled =
      busyVenue === v.id ||
      (isFortyTwo && predictionsLive === null) ||
      (!isFortyTwo && list.length === 0)

    const onMasterTap = () => {
      if (masterDisabled) return
      if (isFortyTwo) {
        if (predictionsLive === null) return
        setPredictionsLiveMode(!predictionsLive)
      } else {
        // If any agent on this venue is currently active, we're in
        // "pause all" mode; else we're in "enable all" mode.
        setVenueActive(v.id, activeCount === 0)
      }
    }

    const masterLabel = isFortyTwo
      ? (masterOn ? 'LIVE' : 'OFF')
      : (list.length === 0 ? '—' : (masterOn ? `${activeCount}/${list.length} on` : 'All paused'))

    return (
      <section key={v.id} style={{ marginBottom: 18 }} data-testid={`section-venue-${v.id}`}>
        {/* Section header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', marginBottom: 8,
          background: '#0a0a0f', border: '1px solid #1f1f2e', borderLeft: `3px solid ${v.accent}`,
          borderRadius: 8,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }} data-testid={`text-venue-label-${v.id}`}>
                {v.label}
              </div>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
                background: masterOn ? `${v.accent}22` : '#1e1e2e',
                color: masterOn ? v.accent : '#64748b',
                letterSpacing: 0.4,
              }} data-testid={`text-venue-status-${v.id}`}>
                {masterLabel}
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{v.sub}</div>
          </div>

          {/* Master toggle — same shape as the per-agent switch but tinted
              to the venue accent so users can tell at a glance "this flips
              an entire venue, not a single agent". */}
          <button
            onClick={onMasterTap}
            disabled={masterDisabled}
            data-testid={`button-venue-toggle-${v.id}`}
            aria-label={masterOn ? `Pause all ${v.label}` : `Enable all ${v.label}`}
            style={{
              width: 52, height: 28, borderRadius: 14,
              background: masterOn ? v.accent : '#1e1e2e',
              border: 'none',
              cursor: masterDisabled ? 'not-allowed' : 'pointer',
              opacity: masterDisabled ? 0.5 : 1,
              position: 'relative',
              transition: 'background 0.2s, opacity 0.2s',
              flexShrink: 0,
            }}
          >
            <div style={{
              width: 22, height: 22, borderRadius: '50%', background: 'white',
              position: 'absolute', top: 3,
              left: masterOn ? 27 : 3,
              transition: 'left 0.2s',
            }} />
          </button>
        </div>

        {/* Section body */}
        {isFortyTwo && (
          <div className="card" style={{ marginBottom: 10, padding: 14 }}>
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>
              {predictionsLive === null
                ? 'Checking your prediction-trading setting…'
                : predictionsLive
                  ? 'Prediction trading on 42.space is LIVE. Both your agents and any manual market taps will spend real USDT.'
                  : 'Prediction trading on 42.space is paused. The Predict tab still shows live markets, but trades are simulated and no funds are spent.'}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#64748b' }}>
              Manage individual markets in the <span style={{ color: '#a78bfa', fontWeight: 600 }}>Predict</span> tab.
            </div>
          </div>
        )}

        {list.length === 0 && !isFortyTwo ? (
          <div className="card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>
              No agents on {v.label} yet.
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Use <span style={{ color: '#a78bfa', fontWeight: 600 }}>/newagent</span> in the bot to add one.
            </div>
          </div>
        ) : (
          list.map(renderAgentCard)
        )}
      </section>
    )
  }

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>🤖 Agent Studio</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
          Choose which platforms your agents trade on
        </div>
      </div>

      {/* Three first-class venue sections, each with a master enable/disable. */}
      {VENUES.map(renderVenueSection)}

      {/* "Other" bucket — only shown if the user has legacy or unknown-venue
          agents (e.g. exchange="mock"). Hidden entirely otherwise so the
          page stays focused on the three real venues. */}
      {buckets.other.length > 0 && (
        <section style={{ marginBottom: 18 }} data-testid="section-venue-other">
          <div style={{
            padding: '10px 12px', marginBottom: 8,
            background: '#0a0a0f', border: '1px solid #1f1f2e', borderLeft: '3px solid #64748b',
            borderRadius: 8,
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>Other</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Legacy or test agents</div>
          </div>
          {buckets.other.map(renderAgentCard)}
        </section>
      )}

      <div style={{ marginTop: 4, fontSize: 12, color: '#64748b', textAlign: 'center' }}>
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
            : 'Activate a venue above and your agent\u2019s trade decisions will stream in here.'}
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

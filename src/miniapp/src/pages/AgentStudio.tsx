import { useState, useEffect } from 'react'
import { apiFetch, getMyFeed, type FeedEntry } from '../api'
import { TradingChart } from '../components/TradingChart'
import { MarketTicker } from '../components/MarketTicker'

interface AgentStudioProps {
  userId: string | null
}

// Three first-class venues. Their toggles act as a per-user allow-list:
// every agent the user owns is gated on whether the user has enabled the
// venue. Same agent can therefore trade on Aster today and (once the user
// flips Hyperliquid on + finishes onboarding) Hyperliquid tomorrow without
// having to be re-created.
type VenueId = 'aster' | 'hyperliquid' | 'fortytwo'
interface VenueConfig {
  id: VenueId
  label: string
  sub: string
  accent: string
}
const VENUES: VenueConfig[] = [
  { id: 'aster',       label: 'Aster',       sub: 'Perp DEX · BSC',     accent: '#f97316' },
  { id: 'hyperliquid', label: 'Hyperliquid', sub: 'L1 perps',           accent: '#22d3ee' },
  { id: 'fortytwo',    label: '42.space',    sub: 'Prediction markets', accent: '#a78bfa' },
]

interface VenuePermissions { aster: boolean; hyperliquid: boolean; fortytwo: boolean }
interface VenueOnboarded   { aster: boolean; hyperliquid: boolean; fortytwo: boolean }

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

// Map an agent's `exchange` value to a known venue. Lowercased defensively
// so a stray "Aster"/"HyperLiquid" doesn't fall through to "other".
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
  // Per-agent currently-selected pair for the in-card ticker/chart.
  const [agentPairSel, setAgentPairSel] = useState<Record<string, string>>({})
  // Per-user venue allow-list. `null` while in flight so toggles stay
  // disabled until we know the real server state — never silently flip
  // a user into LIVE mode (especially for 42.space) on a first paint.
  const [perms, setPerms] = useState<VenuePermissions | null>(null)
  const [onboarded, setOnboarded] = useState<VenueOnboarded | null>(null)
  // Per-venue busy flag for the platform toggle so a fast double-tap can't
  // race the optimistic update against the server.
  const [busyVenue, setBusyVenue] = useState<VenueId | null>(null)

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

  const fetchPermissions = () => {
    return apiFetch<{
      ok: boolean
      permissions: VenuePermissions
      onboarded: VenueOnboarded
    }>('/api/me/venue-permissions')
      .then(r => {
        setPerms(r?.permissions ?? { aster: false, hyperliquid: false, fortytwo: false })
        setOnboarded(r?.onboarded ?? { aster: false, hyperliquid: false, fortytwo: true })
      })
      // On lookup failure default conservatively: assume Aster is allowed
      // (matches the schema default and what existing users have today)
      // but 42.space LIVE stays OFF so we never auto-enable real-money
      // prediction trading because of a transient network error.
      .catch(() => {
        setPerms({ aster: true, hyperliquid: true, fortytwo: false })
        setOnboarded({ aster: false, hyperliquid: false, fortytwo: true })
      })
  }

  useEffect(() => {
    fetchAgents()
    fetchFeed()
    fetchPermissions()
    // Poll the brain feed every 30s so users see new decisions stream in
    // without leaving and re-entering the mini app.
    const t = setInterval(fetchFeed, 30_000)
    return () => clearInterval(t)
  }, [])

  const toggleAgent = async (agentId: string) => {
    await apiFetch(`/api/agents/${agentId}/toggle`, { method: 'POST' })
    fetchAgents()
  }

  // Flip a single platform allow-flag. Optimistic UI + revert on error so
  // the toggle never lies about the server state.
  const setVenuePermission = async (venue: VenueId, enabled: boolean) => {
    if (busyVenue) return
    setBusyVenue(venue)
    const previous = perms
    setPerms(p => p ? { ...p, [venue]: enabled } : p)
    try {
      const res = await apiFetch<{ ok: boolean; venue: VenueId; enabled: boolean }>(
        '/api/me/venue-permissions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ venue, enabled }),
        }
      )
      // Trust the server's echo so we converge to truth even if it
      // refused or normalised the input somehow.
      setPerms(p => p ? { ...p, [venue]: !!res?.enabled } : p)
    } catch {
      setPerms(previous)
    } finally {
      setBusyVenue(null)
    }
  }

  const hasActive = agents.some(a => a.isActive)

  if (loading) {
    return <div style={{ paddingTop: 60, textAlign: 'center', color: '#64748b' }}>Loading agents...</div>
  }

  // Render a single platform allow-list row. Toggling a venue enables /
  // disables agent trading on it for THIS user, regardless of how many
  // agents the user has — toggles are permissions, not per-agent groups.
  const renderVenueRow = (v: VenueConfig) => {
    const enabled = perms ? perms[v.id] : false
    const isOnboarded = onboarded ? onboarded[v.id] : false
    const busy = busyVenue === v.id
    // Always interactive once permissions have loaded — even if not yet
    // onboarded. Flipping ON without onboarding is harmless (the runner
    // will still skip dispatch until creds are present); the user sees a
    // hint below the row telling them to finish setup.
    const disabled = perms === null || busy

    // Show "LIVE" for 42.space (matches the rest of the product's
    // paper-vs-live language) and "ON"/"OFF" for the perps venues.
    const stateLabel = v.id === 'fortytwo'
      ? (enabled ? 'LIVE' : 'PAPER')
      : (enabled ? 'ON'   : 'OFF')

    return (
      <div
        key={v.id}
        data-testid={`venue-row-${v.id}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 14px', marginBottom: 8,
          background: '#0a0a0f', border: '1px solid #1f1f2e',
          borderLeft: `3px solid ${v.accent}`, borderRadius: 8,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }} data-testid={`text-venue-label-${v.id}`}>
              {v.label}
            </div>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
              background: enabled ? `${v.accent}22` : '#1e1e2e',
              color: enabled ? v.accent : '#64748b',
              letterSpacing: 0.4,
            }} data-testid={`text-venue-state-${v.id}`}>
              {stateLabel}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {v.sub}
            {!isOnboarded && v.id !== 'fortytwo' && (
              <span style={{ color: '#f59e0b' }}>
                {' · '}finish setup in <span style={{ fontWeight: 600 }}>Wallet</span> to start
              </span>
            )}
          </div>
        </div>

        <button
          onClick={() => { if (!disabled) setVenuePermission(v.id, !enabled) }}
          disabled={disabled}
          data-testid={`button-venue-toggle-${v.id}`}
          aria-label={`${enabled ? 'Disable' : 'Enable'} ${v.label} agent trading`}
          style={{
            width: 52, height: 28, borderRadius: 14,
            background: enabled ? v.accent : '#1e1e2e',
            border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            position: 'relative',
            transition: 'background 0.2s, opacity 0.2s',
            flexShrink: 0,
          }}
        >
          <div style={{
            width: 22, height: 22, borderRadius: '50%', background: 'white',
            position: 'absolute', top: 3,
            left: enabled ? 27 : 3,
            transition: 'left 0.2s',
          }} />
        </button>
      </div>
    )
  }

  // Render a single agent card. Each agent has one primary venue (its
  // `exchange` field) but the per-user platform allow-list above governs
  // whether the runner actually dispatches its decisions to that venue.
  const renderAgentCard = (agent: any) => {
    const isAuto = Array.isArray(agent.pairs) && agent.pairs.includes('AUTO')
    const watched: string[] = Array.isArray(agent.pairs) ? agent.pairs.filter((p: string) => p !== 'AUTO') : []
    const pnlValue = agent.totalPnl ?? 0
    const pnlColor = pnlValue > 0 ? '#10b981' : pnlValue < 0 ? '#ef4444' : 'var(--text-secondary)'

    // The agent's primary venue & whether the user has currently enabled
    // it. If they've turned off the platform, surface a clear "Platform
    // paused" badge so the user understands why the agent isn't ticking
    // even though its own toggle reads ON.
    const v = venueOf(agent.exchange)
    const venueAccent =
      v === 'aster' ? '#f97316' :
      v === 'hyperliquid' ? '#22d3ee' :
      v === 'fortytwo' ? '#a78bfa' : '#64748b'
    const venueLabel =
      v === 'aster' ? 'Aster' :
      v === 'hyperliquid' ? 'Hyperliquid' :
      v === 'fortytwo' ? '42.space' :
      (agent.exchange ?? 'unknown')
    const platformAllowed = perms == null
      ? true
      : (v === 'other' ? true : perms[v])

    return (
      <div key={agent.id} className="card" style={{ marginBottom: 10 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }} data-testid={`text-agent-name-${agent.id}`}>
                {agent.name}
              </div>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
                background: `${venueAccent}22`, color: venueAccent, letterSpacing: 0.3,
              }} data-testid={`text-agent-venue-${agent.id}`}>
                {venueLabel}
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
              {isAuto
                ? 'AUTO — scanning the market'
                : (agent.pairs?.join(', ') ?? '')}
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

        {/* Status badge — combines the per-agent isActive flag with the
            platform allow-list so users always see the *real* reason their
            agent isn't ticking. Order matters: an off agent reads "Inactive"
            even if its platform is also off (fix the agent first). An on
            agent whose platform is off reads "Platform paused" with the
            venue named, so the user knows exactly which switch to flip. */}
        <div style={{
          marginTop: 10,
          display: 'inline-block',
          fontSize: 11, padding: '3px 10px', borderRadius: 20,
          background:
            !agent.isActive   ? '#1e1e2e' :
            !platformAllowed  ? '#f59e0b15' :
                                '#10b98115',
          color:
            !agent.isActive   ? '#64748b' :
            !platformAllowed  ? '#f59e0b' :
                                '#10b981',
        }} data-testid={`text-agent-status-${agent.id}`}>
          {!agent.isActive
            ? '○ Inactive'
            : !platformAllowed
              ? `⏸ ${venueLabel} paused — enable above`
              : '● Active — next tick in ~60s'}
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

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>🤖 Agent Studio</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
          Choose where your agents are allowed to trade — same agent, any platform.
        </div>
      </div>

      {/* Per-user platform allow-list. Sits above the agents list so the
          relationship is unmistakable: "these toggles control whether my
          agents below can place trades on each platform." */}
      <div style={{ marginBottom: 18 }} data-testid="section-platform-allowlist">
        <div style={{
          fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.5,
          textTransform: 'uppercase', marginBottom: 8, paddingLeft: 2,
        }}>
          Allowed Trading Platforms
        </div>
        {VENUES.map(renderVenueRow)}
      </div>

      {/* Flat list of every agent the user owns. No per-venue grouping —
          each card just badges the agent's primary venue and the per-user
          platform toggle above governs whether it can act. */}
      <div style={{
        fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.5,
        textTransform: 'uppercase', marginBottom: 8, paddingLeft: 2,
      }}>
        Your Agents
      </div>
      {agents.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🤖</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No agents yet</div>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            Create your first agent with <span style={{ color: '#a78bfa', fontWeight: 600 }}>/newagent</span> in the bot.
            It will trade on every platform you allow above.
          </div>
        </div>
      ) : (
        agents.map(renderAgentCard)
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

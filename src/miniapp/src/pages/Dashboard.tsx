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
  const [drillOpen, setDrillOpen] = useState<null | { kind: 'pair' | 'provider', value: string }>(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError] = useState<string | null>(null)
  const [drillData, setDrillData] = useState<any>(null)
  const [drillDays, setDrillDays] = useState(7)
  const [drillLimit, setDrillLimit] = useState(25)
  const [drillOnlyFallback, setDrillOnlyFallback] = useState(false)
  const [drillCopyState, setDrillCopyState] = useState<'idle' | 'copied' | 'error'>('idle')

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

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const pair = params.get('swarmPair')
    const provider = params.get('swarmProvider')
    if (!pair && !provider) return
    const parseInt10 = (v: string | null, fallback: number, min: number, max: number) => {
      const n = parseInt(v ?? '', 10)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    }
    const days = parseInt10(params.get('swarmDays'), 7, 1, 365)
    const limit = parseInt10(params.get('swarmLimit'), 25, 1, 200)
    const onlyFallback = params.get('swarmFallback') === '1'
    const target = pair
      ? { kind: 'pair' as const, value: pair }
      : { kind: 'provider' as const, value: provider as string }
    setDrillOpen(target)
    setDrillDays(days)
    setDrillLimit(limit)
    setDrillOnlyFallback(onlyFallback)
    fetchDrill(target, days, limit, onlyFallback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const fetchDrill = (
    target: { kind: 'pair' | 'provider', value: string },
    days: number,
    limit: number,
    onlyFallback: boolean,
  ) => {
    setDrillData(null)
    setDrillError(null)
    setDrillLoading(true)
    const params = new URLSearchParams({ days: String(days), limit: String(limit) })
    if (target.kind === 'pair') params.set('pair', target.value)
    if (target.kind === 'provider') params.set('provider', target.value)
    if (onlyFallback) params.set('onlyFallback', '1')
    fetch(`/api/admin/swarm-divergence/samples?${params.toString()}`)
      .then(async (r) => {
        if (r.status === 401) { setDrillError('locked'); return null }
        if (r.status === 503) { setDrillError('unavailable'); return null }
        if (!r.ok) { setDrillError('error'); return null }
        return r.json()
      })
      .then((data) => { if (data) setDrillData(data) })
      .catch(() => setDrillError('error'))
      .finally(() => setDrillLoading(false))
  }

  const openDrill = (kind: 'pair' | 'provider', value: string) => {
    const target = { kind, value }
    setDrillOpen(target)
    setDrillDays(7)
    setDrillLimit(25)
    setDrillOnlyFallback(false)
    fetchDrill(target, 7, 25, false)
  }

  const applyDrillFilters = (next: { days?: number, limit?: number, onlyFallback?: boolean }) => {
    if (!drillOpen) return
    const days = next.days ?? drillDays
    const limit = next.limit ?? drillLimit
    const onlyFallback = next.onlyFallback ?? drillOnlyFallback
    if (next.days !== undefined) setDrillDays(days)
    if (next.limit !== undefined) setDrillLimit(limit)
    if (next.onlyFallback !== undefined) setDrillOnlyFallback(onlyFallback)
    fetchDrill(drillOpen, days, limit, onlyFallback)
  }

  const escapeCsv = (val: any): string => {
    if (val === null || val === undefined) return ''
    let s = String(val)
    if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) s = "'" + s
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }

  const downloadDrillCsv = () => {
    if (!drillOpen || !drillData || !Array.isArray(drillData.samples)) return
    const header = [
      'sample_id', 'created_at', 'pair', 'agent', 'final_action', 'fallback',
      'provider', 'model', 'action', 'confidence',
    ]
    const lines: string[] = [header.join(',')]
    for (const s of drillData.samples) {
      if (!Array.isArray(s.providers) || s.providers.length === 0) {
        lines.push([
          s.id, s.createdAt, s.pair ?? '', s.agent ?? '', s.finalAction ?? '',
          s.fallback ? 'true' : 'false', '', '', '', '',
        ].map(escapeCsv).join(','))
        continue
      }
      for (const p of s.providers) {
        lines.push([
          s.id, s.createdAt, s.pair ?? '', s.agent ?? '', s.finalAction ?? '',
          s.fallback ? 'true' : 'false',
          p.provider ?? '', p.model ?? '', p.action ?? '',
          typeof p.confidence === 'number' ? p.confidence : '',
        ].map(escapeCsv).join(','))
      }
    }
    const csv = lines.join('\n') + '\n'
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const safeValue = String(drillOpen.value).replace(/[^A-Za-z0-9._-]+/g, '_')
    const filename = `swarm-drill-${drillOpen.kind}-${safeValue}-${drillDays}d${drillOnlyFallback ? '-noquorum' : ''}.csv`
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const closeDrill = () => {
    setDrillOpen(null)
    setDrillData(null)
    setDrillError(null)
    setDrillCopyState('idle')
  }

  const buildDrillShareUrl = (): string => {
    if (!drillOpen || typeof window === 'undefined') return ''
    const params = new URLSearchParams()
    if (drillOpen.kind === 'pair') params.set('swarmPair', drillOpen.value)
    else params.set('swarmProvider', drillOpen.value)
    params.set('swarmDays', String(drillDays))
    params.set('swarmLimit', String(drillLimit))
    if (drillOnlyFallback) params.set('swarmFallback', '1')
    const { origin, pathname } = window.location
    return `${origin}${pathname}?${params.toString()}`
  }

  const copyDrillLink = async () => {
    const url = buildDrillShareUrl()
    if (!url) return
    let ok = false
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url)
        ok = true
      } else {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { ok = document.execCommand('copy') } catch { ok = false }
        document.body.removeChild(ta)
      }
    } catch {
      ok = false
    }
    setDrillCopyState(ok ? 'copied' : 'error')
    setTimeout(() => setDrillCopyState('idle'), 1500)
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
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '3px 0' }}
                      >
                        <span>{p.pair}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#64748b' }}>
                            {p.fallbackPct}% · {p.fallback}/{p.total}
                          </span>
                          <button
                            onClick={() => openDrill('pair', p.pair)}
                            data-testid={`button-drill-pair-${p.pair}`}
                            style={{
                              background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#94a3b8',
                              borderRadius: 6, fontSize: 10, padding: '2px 6px', cursor: 'pointer',
                            }}
                          >
                            Details
                          </button>
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
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '3px 0' }}
                    >
                      <span>{p.provider}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: '#64748b' }}>
                          {p.total} ticks · {p.fallbackPct}% no-quorum
                        </span>
                        <button
                          onClick={() => openDrill('provider', p.provider)}
                          data-testid={`button-drill-provider-${p.provider}`}
                          style={{
                            background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#94a3b8',
                            borderRadius: 6, fontSize: 10, padding: '2px 6px', cursor: 'pointer',
                          }}
                        >
                          Details
                        </button>
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

      {/* Swarm drill-down modal */}
      {drillOpen && (
        <div
          onClick={closeDrill}
          data-testid="modal-swarm-drill"
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
              maxHeight: '80vh', overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }} data-testid="text-drill-title">
                🐝 {drillOpen.kind === 'pair' ? 'Pair' : 'Provider'}: {drillOpen.value}
              </div>
              <button
                onClick={closeDrill}
                data-testid="button-close-drill"
                style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 22, cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            {/* Filter controls */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: '#64748b' }}>Range:</span>
                {[1, 7, 30, 90].map((d) => (
                  <button
                    key={d}
                    onClick={() => applyDrillFilters({ days: d })}
                    data-testid={`button-drill-days-${d}`}
                    disabled={drillLoading}
                    style={{
                      background: drillDays === d ? '#2a2a3a' : '#1e1e2e',
                      border: '1px solid ' + (drillDays === d ? '#475569' : '#2a2a3a'),
                      color: drillDays === d ? '#e2e8f0' : '#94a3b8',
                      borderRadius: 6, fontSize: 10, padding: '3px 7px',
                      cursor: drillLoading ? 'default' : 'pointer',
                    }}
                  >
                    {d}d
                  </button>
                ))}
              </div>
              <label
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 11, color: '#94a3b8', cursor: 'pointer',
                }}
                data-testid="label-drill-only-fallback"
              >
                <input
                  type="checkbox"
                  checked={drillOnlyFallback}
                  onChange={(e) => applyDrillFilters({ onlyFallback: e.target.checked })}
                  data-testid="checkbox-drill-only-fallback"
                  disabled={drillLoading}
                />
                Only no-quorum
              </label>
              <button
                onClick={copyDrillLink}
                data-testid="button-drill-copy-link"
                disabled={drillLoading}
                title="Copy a shareable link to this exact view"
                style={{
                  marginLeft: 'auto',
                  background: drillCopyState === 'copied' ? '#10b98120' : '#1e1e2e',
                  border: '1px solid ' + (drillCopyState === 'copied' ? '#10b981' : '#2a2a3a'),
                  color: drillCopyState === 'copied' ? '#10b981'
                    : drillCopyState === 'error' ? '#ef4444'
                    : drillLoading ? '#475569' : '#94a3b8',
                  borderRadius: 6, fontSize: 11, padding: '3px 9px',
                  cursor: drillLoading ? 'default' : 'pointer',
                }}
              >
                {drillCopyState === 'copied' ? '✓ Copied'
                  : drillCopyState === 'error' ? '⚠ Copy failed'
                  : '🔗 Copy link'}
              </button>
              <button
                onClick={downloadDrillCsv}
                data-testid="button-drill-download-csv"
                disabled={drillLoading || !drillData || !drillData.samples || drillData.samples.length === 0}
                title="Download the current filter's samples as CSV"
                style={{
                  background: '#1e1e2e',
                  border: '1px solid #2a2a3a',
                  color: (drillLoading || !drillData || !drillData.samples || drillData.samples.length === 0) ? '#475569' : '#94a3b8',
                  borderRadius: 6, fontSize: 11, padding: '3px 9px',
                  cursor: (drillLoading || !drillData || !drillData.samples || drillData.samples.length === 0) ? 'default' : 'pointer',
                }}
              >
                ⬇ CSV
              </button>
            </div>

            {drillLoading && (
              <div style={{ color: '#64748b', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                Loading recent ticks...
              </div>
            )}
            {!drillLoading && drillError === 'unavailable' && (
              <div style={{ fontSize: 12, color: '#64748b' }}>Swarm telemetry not enabled on this database.</div>
            )}
            {!drillLoading && drillError === 'locked' && (
              <div style={{ fontSize: 12, color: '#64748b' }}>Restricted — admin token required.</div>
            )}
            {!drillLoading && drillError === 'error' && (
              <div style={{ fontSize: 12, color: '#64748b' }}>Couldn't load samples.</div>
            )}
            {!drillLoading && !drillError && drillData && drillData.samples.length === 0 && (
              <div style={{ fontSize: 12, color: '#64748b' }}>
                No matching ticks in the last {drillData.days} days{drillOnlyFallback ? ' (no-quorum only)' : ''}.
              </div>
            )}
            {!drillLoading && !drillError && drillData && drillData.samples.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }} data-testid="text-drill-summary">
                  Showing {drillData.samples.length} most-recent tick{drillData.samples.length === 1 ? '' : 's'} (last {drillData.days}d{drillOnlyFallback ? ', no-quorum only' : ''})
                </div>
                {drillData.samples.map((s: any) => (
                  <div
                    key={s.id}
                    data-testid={`row-drill-sample-${s.id}`}
                    style={{
                      padding: '10px 0', borderBottom: '1px solid #1e1e2e',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>
                        {s.pair ?? '—'} · {s.agent}
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {s.fallback && (
                          <span style={{
                            fontSize: 10, padding: '2px 6px', borderRadius: 10,
                            background: '#f59e0b20', color: '#f59e0b',
                          }}>
                            no quorum
                          </span>
                        )}
                        <span style={{ fontSize: 10, color: '#64748b' }}>
                          {new Date(s.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    {s.finalAction && (
                      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
                        Final: <strong>{s.finalAction}</strong>
                      </div>
                    )}
                    {s.providers.length === 0 && (
                      <div style={{ fontSize: 11, color: '#64748b' }}>No provider breakdown recorded.</div>
                    )}
                    {s.providers.map((p: any, i: number) => (
                      <div
                        key={`${s.id}-${p.provider}-${i}`}
                        data-testid={`row-drill-provider-${s.id}-${p.provider}`}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                          fontSize: 11, padding: '2px 0', color: '#cbd5e1',
                        }}
                      >
                        <span>
                          <span style={{ color: '#94a3b8' }}>{p.provider}</span>
                          {p.model && <span style={{ color: '#475569', marginLeft: 4 }}>({p.model})</span>}
                        </span>
                        <span style={{ display: 'flex', gap: 8 }}>
                          <span style={{
                            color: p.action === 'LONG' || p.action === 'BUY' ? '#10b981'
                              : p.action === 'SHORT' || p.action === 'SELL' ? '#ef4444'
                              : '#64748b',
                          }}>
                            {p.action ?? '—'}
                          </span>
                          {typeof p.confidence === 'number' && (
                            <span style={{ color: '#64748b' }}>conf {Math.round(p.confidence * 100)}%</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
                {drillData.samples.length >= drillLimit && drillLimit < 200 && (
                  <div style={{ textAlign: 'center', marginTop: 12 }}>
                    <button
                      onClick={() => applyDrillFilters({ limit: Math.min(200, drillLimit + 50) })}
                      data-testid="button-drill-load-more"
                      disabled={drillLoading}
                      style={{
                        background: '#1e1e2e', border: '1px solid #2a2a3a',
                        color: '#94a3b8', borderRadius: 6, fontSize: 11,
                        padding: '6px 12px', cursor: drillLoading ? 'default' : 'pointer',
                      }}
                    >
                      Load more (showing {drillLimit}, max 200)
                    </button>
                  </div>
                )}
                {drillLimit >= 200 && drillData.samples.length >= 200 && (
                  <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: '#64748b' }}>
                    Showing maximum of 200 ticks. Narrow the date range to see older activity.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

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

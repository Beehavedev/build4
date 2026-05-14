import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api'

type Window = 'today' | 'mtd' | 'ytd' | '24h' | '7d' | '30d'

interface ProviderRow {
  provider: string
  callCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  medianLatencyMs: number
  estimatedUsd: number
  costRate: { input: number; output: number }
}

interface DailyBucket {
  date: string
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedUsd: number
}

interface QuorumStats {
  swarmTicks: number
  noQuorumTicks: number
  quorumTicks: number
  noQuorumRate: number
}

interface UsageResponse {
  window: Window
  since: string
  now: string
  totals: {
    calls: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    estimatedUsd: number
  }
  rows: ProviderRow[]
  daily: DailyBucket[]
  quorum?: QuorumStats
}

interface ProviderCredit {
  provider: string
  configured: boolean
  envVar: string
  defaultModel: string
  circuitTripped: boolean
  circuitParkedUntil: string | null
  balanceUsd: number | null
  balanceError: string | null
  dashboardUrl: string | null
}

interface CreditsResponse {
  providers: ProviderCredit[]
  fetchedAt: string
}

const WINDOW_OPTIONS: { id: Window; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'mtd', label: 'Month' },
  { id: 'ytd', label: 'Year' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
]

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#d97757',
  xai: '#9b87f5',
  hyperbolic: '#22d3ee',
  akash: '#f59e0b',
  unknown: '#6b7280',
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function fmtDate(d: string): string {
  const dt = new Date(d + 'T00:00:00Z')
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export default function AiUsage() {
  const [window, setWindow] = useState<Window>('today')
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now())

  const load = async (w: Window) => {
    setLoading(true)
    setErr(null)
    try {
      const [u, c] = await Promise.all([
        apiFetch<UsageResponse>(`/api/admin/ai-usage?window=${w}`),
        apiFetch<CreditsResponse>(`/api/admin/ai-credits`),
      ])
      setUsage(u)
      setCredits(c)
      setLastRefresh(Date.now())
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load(window) }, [window])

  // Realtime: poll every 30s when auto-refresh is on. Cheap query, no
  // side effects. Pauses when the tab loses focus to be polite to the DB.
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load(window)
    }, 30_000)
    return () => clearInterval(id)
  }, [autoRefresh, window])

  const maxDaily = useMemo(() => {
    if (!usage?.daily?.length) return 0
    return Math.max(...usage.daily.map(d => d.estimatedUsd))
  }, [usage])

  return (
    <div data-testid="page-ai-usage" style={{ padding: '16px 0', color: 'var(--text-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>AI Usage</h1>
        <button
          onClick={() => setAutoRefresh(a => !a)}
          data-testid="button-toggle-autorefresh"
          style={{
            padding: '6px 10px', borderRadius: 8, fontSize: 11,
            background: autoRefresh ? 'var(--purple)' : 'var(--bg-elevated)',
            color: autoRefresh ? '#fff' : 'var(--text-secondary)',
            border: '1px solid var(--border)', cursor: 'pointer',
          }}
        >
          {autoRefresh ? '● LIVE' : '○ Paused'}
        </button>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 16 }}>
        Last update: {new Date(lastRefresh).toLocaleTimeString()} · {usage?.since ? `since ${new Date(usage.since).toLocaleString()}` : ''}
      </div>

      {/* Window picker */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {WINDOW_OPTIONS.map(opt => {
          const active = window === opt.id
          return (
            <button
              key={opt.id}
              onClick={() => setWindow(opt.id)}
              data-testid={`button-window-${opt.id}`}
              style={{
                padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: active ? 'var(--purple)' : 'var(--bg-card)',
                color: active ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border)', cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          )
        })}
      </div>

      {err && (
        <div data-testid="error-ai-usage" style={{
          padding: 12, marginBottom: 16, borderRadius: 8,
          background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)',
          color: '#fca5a5', fontSize: 13,
        }}>
          {err}
        </div>
      )}

      {/* Headline KPI cards */}
      {usage && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 16,
        }}>
          <Kpi label="Total spend" value={fmtUsd(usage.totals.estimatedUsd)} testid="kpi-spend" highlight />
          <Kpi label="Total calls" value={usage.totals.calls.toLocaleString()} testid="kpi-calls" />
          <Kpi label="Input tokens" value={fmtTokens(usage.totals.inputTokens)} testid="kpi-input" />
          <Kpi label="Output tokens" value={fmtTokens(usage.totals.outputTokens)} testid="kpi-output" />
        </div>
      )}

      {/* Daily chart */}
      {usage && usage.daily.length > 0 && (
        <Section title="Daily spend">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120, padding: '8px 0' }}>
            {usage.daily.map(d => {
              const h = maxDaily > 0 ? Math.max(2, (d.estimatedUsd / maxDaily) * 100) : 2
              return (
                <div
                  key={d.date}
                  data-testid={`bar-day-${d.date}`}
                  title={`${d.date}: ${fmtUsd(d.estimatedUsd)} · ${d.calls} calls · ${fmtTokens(d.totalTokens)} tok`}
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
                >
                  <div style={{
                    width: '100%', height: `${h}%`, minHeight: 2,
                    background: 'var(--purple)', borderRadius: '2px 2px 0 0',
                  }} />
                </div>
              )
            })}
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 9, color: 'var(--text-secondary)', marginTop: 4,
          }}>
            <span>{fmtDate(usage.daily[0].date)}</span>
            {usage.daily.length > 2 && <span>{fmtDate(usage.daily[Math.floor(usage.daily.length / 2)].date)}</span>}
            <span>{fmtDate(usage.daily[usage.daily.length - 1].date)}</span>
          </div>
        </Section>
      )}

      {/* Per-provider breakdown */}
      <Section title="Per-provider breakdown">
        {!usage?.rows.length ? (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '12px 0' }}>
            {loading ? 'Loading…' : 'No usage in this window.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {usage.rows.map(r => {
              const pct = usage.totals.estimatedUsd > 0
                ? (r.estimatedUsd / usage.totals.estimatedUsd) * 100 : 0
              const color = PROVIDER_COLORS[r.provider] ?? PROVIDER_COLORS.unknown
              return (
                <div key={r.provider} data-testid={`row-provider-${r.provider}`} style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: 12,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                      <span style={{ fontWeight: 600, fontSize: 14, textTransform: 'capitalize' }}>
                        {r.provider}
                      </span>
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{fmtUsd(r.estimatedUsd)}</span>
                  </div>
                  <div style={{
                    height: 4, background: 'var(--bg-elevated)', borderRadius: 2, marginBottom: 8, overflow: 'hidden',
                  }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                    <span>{r.callCount.toLocaleString()} calls</span>
                    <span>{fmtTokens(r.inputTokens)} in</span>
                    <span>{fmtTokens(r.outputTokens)} out</span>
                    <span>p50 {r.medianLatencyMs}ms</span>
                    <span>${r.costRate.input}/${r.costRate.output} per Mtok</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {/* Provider credits / health */}
      <Section title="Provider accounts">
        {!credits?.providers.length ? (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {credits.providers.map(p => {
              const color = PROVIDER_COLORS[p.provider] ?? PROVIDER_COLORS.unknown
              const status = !p.configured ? 'Not configured'
                : p.circuitTripped ? 'Circuit tripped'
                : 'Healthy'
              const statusColor = !p.configured ? '#6b7280'
                : p.circuitTripped ? '#f59e0b' : '#22c55e'
              return (
                <div key={p.provider} data-testid={`row-credit-${p.provider}`} style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: 12,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                      <span style={{ fontWeight: 600, fontSize: 14, textTransform: 'capitalize' }}>
                        {p.provider}
                      </span>
                    </div>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                      background: `${statusColor}22`, color: statusColor,
                    }}>
                      {status}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    Default model: <code style={{ color: 'var(--text-primary)' }}>{p.defaultModel}</code>
                  </div>
                  {p.balanceUsd !== null && (
                    <div data-testid={`balance-${p.provider}`} style={{
                      fontSize: 13, fontWeight: 600, marginBottom: 4,
                    }}>
                      Balance: {fmtUsd(p.balanceUsd)}
                    </div>
                  )}
                  {p.circuitTripped && p.circuitParkedUntil && (
                    <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 4 }}>
                      Parked until {new Date(p.circuitParkedUntil).toLocaleTimeString()} —
                      provider returned a fatal error recently.
                    </div>
                  )}
                  {p.balanceUsd === null && p.configured && (
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontStyle: 'italic', marginBottom: 4 }}>
                      Balance not exposed by this provider's API. {p.balanceError ? `(${p.balanceError})` : ''}
                    </div>
                  )}
                  {p.dashboardUrl && (
                    <a
                      href={p.dashboardUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`link-dashboard-${p.provider}`}
                      style={{ fontSize: 11, color: 'var(--purple)', textDecoration: 'none' }}
                    >
                      Open billing dashboard →
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {/* Swarm quorum health */}
      {usage?.quorum && usage.quorum.swarmTicks > 0 && (
        <Section title="Swarm consensus">
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 12 }}>
            <div data-testid="text-quorum">
              <strong>{usage.quorum.quorumTicks}</strong>/{usage.quorum.swarmTicks} swarm ticks reached quorum
              {' · '}
              <strong>{(usage.quorum.noQuorumRate * 100).toFixed(1)}%</strong> fell back to single-provider
              {usage.quorum.noQuorumRate >= 0.25 && <span style={{ color: '#f59e0b' }}> ⚠</span>}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
              No-quorum rate above 25% means providers chronically disagree — check model versions
              or prompt drift.
            </div>
          </div>
        </Section>
      )}
    </div>
  )
}

function Kpi({ label, value, testid, highlight = false }: { label: string; value: string; testid: string; highlight?: boolean }) {
  return (
    <div
      data-testid={testid}
      style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{
        fontSize: highlight ? 22 : 18,
        fontWeight: 700, color: highlight ? 'var(--purple)' : 'var(--text-primary)', marginTop: 2,
      }}>
        {value}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        {title}
      </h2>
      {children}
    </div>
  )
}

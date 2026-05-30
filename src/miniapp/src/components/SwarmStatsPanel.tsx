import { useCallback, useEffect, useRef, useState } from 'react'

type Window = '24h' | '7d'

// How often we silently re-pull the stats while the dashboard is visible.
// 30s keeps the cost/latency view current during high-traffic periods
// without hammering the endpoint. Polling pauses while the tab is hidden
// and fires an immediate catch-up refresh when it becomes visible again.
const REFRESH_MS = 30_000

interface CostRate {
  input: number
  output: number
}

interface ProviderRow {
  provider: string
  callCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  medianLatencyMs: number
  estimatedUsd: number
  costRate: CostRate
  legacyCallCount?: number
  legacyEstimatedUsd?: number
}

interface SwarmStatsResponse {
  window: Window
  since: string
  rows: ProviderRow[]
}

const fmtUsd = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`)
const fmtNum = (v: number) => v.toLocaleString()
const fmtRate = (r: CostRate) =>
  r.input === r.output ? `$${r.input}/Mtok` : `$${r.input}in/$${r.output}out per Mtok`

const fmtAgo = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

export default function SwarmStatsPanel() {
  const [window, setWindow] = useState<Window>('24h')
  const [data, setData] = useState<SwarmStatsResponse | null>(null)
  // `loading` only gates the very first paint (and a window switch). A
  // background poll must NOT flip this back to true or the panel would
  // flash its skeleton every 30s — we keep showing the last good numbers
  // while the new ones load underneath.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Wall-clock time of the last successful fetch, plus a 1s ticker so the
  // "updated Xs ago" label counts up live between polls.
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Keep the latest window in a ref so the polling/visibility handlers
  // always fetch the currently-selected window without us having to tear
  // the interval down and rebuild it on every toggle.
  const windowRef = useRef<Window>(window)
  windowRef.current = window

  const load = useCallback((w: Window, opts?: { background?: boolean }) => {
    if (!opts?.background) {
      setLoading(true)
      setError(null)
    }
    return fetch(`/api/swarm/stats?window=${w}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<SwarmStatsResponse>
      })
      .then((d) => {
        // A late background response for a window the user has since
        // switched away from must not overwrite the current view.
        if (windowRef.current !== w) return
        setData(d)
        setUpdatedAt(Date.now())
        setNow(Date.now())
        setError(null)
        setLoading(false)
      })
      .catch((e) => {
        if (windowRef.current !== w) return
        // On a background poll we keep the last good data on screen and
        // only surface the error if we have nothing to show yet.
        if (opts?.background) {
          setData((prev) => {
            if (!prev) setError(String(e?.message ?? 'Failed to load'))
            return prev
          })
        } else {
          setError(String(e?.message ?? 'Failed to load'))
        }
        setLoading(false)
      })
  }, [])

  // Foreground load whenever the selected window changes.
  useEffect(() => {
    load(window)
  }, [window, load])

  // Background polling + tab-visibility handling. Re-pulls every REFRESH_MS
  // while visible, pauses while hidden, and fires an immediate catch-up
  // refresh the moment the tab becomes visible again.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        load(windowRef.current, { background: true })
      }
    }, REFRESH_MS)

    const onVis = () => {
      if (document.visibilityState === 'visible') {
        load(windowRef.current, { background: true })
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [load])

  // 1s ticker so the "updated Xs ago" label stays live between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const totals = (data?.rows ?? []).reduce(
    (acc, r) => ({
      calls: acc.calls + r.callCount,
      inputTokens: acc.inputTokens + (r.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (r.outputTokens ?? 0),
      tokens: acc.tokens + r.totalTokens,
      usd: acc.usd + r.estimatedUsd,
      legacyUsd: acc.legacyUsd + (r.legacyEstimatedUsd ?? 0),
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0, legacyUsd: 0 },
  )
  const legacyPct = totals.usd > 0 ? (totals.legacyUsd / totals.usd) * 100 : 0

  return (
    <div className="card" style={{ marginBottom: 16 }} data-testid="panel-swarm-stats">
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: 12
      }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>🧠 Swarm Cost & Speed</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['24h', '7d'] as Window[]).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              data-testid={`button-swarm-window-${w}`}
              style={{
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 14,
                border: '1px solid #1e1e2e',
                background: window === w ? '#7c3aed20' : 'transparent',
                color: window === w ? '#a78bfa' : '#64748b',
                cursor: 'pointer',
                fontWeight: window === w ? 600 : 400,
              }}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div style={{ fontSize: 13, color: '#64748b', padding: '8px 0' }}>
          Loading swarm stats…
        </div>
      )}

      {!loading && error && (
        <div
          style={{ fontSize: 13, color: '#ef4444', padding: '8px 0' }}
          data-testid="text-swarm-error"
        >
          Could not load swarm stats ({error}).
        </div>
      )}

      {!loading && !error && data && data.rows.length === 0 && (
        <div
          style={{ fontSize: 13, color: '#64748b', padding: '8px 0' }}
          data-testid="text-swarm-empty"
        >
          No swarm telemetry recorded in this window yet.
        </div>
      )}

      {!loading && !error && data && data.rows.length > 0 && (
        <>
          {data.rows.map((r) => (
            <div
              key={r.provider}
              data-testid={`row-swarm-provider-${r.provider}`}
              style={{
                padding: '10px 0',
                borderBottom: '1px solid #1e1e2e',
              }}
            >
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: 4,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>
                  {r.provider}
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {r.callCount} calls
                </div>
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 11, color: '#94a3b8', gap: 8, flexWrap: 'wrap',
              }}>
                <span data-testid={`text-swarm-latency-${r.provider}`}>
                  median {r.medianLatencyMs}ms
                </span>
                <span data-testid={`text-swarm-tokens-${r.provider}`}>
                  <span style={{ color: '#7dd3fc' }}>{fmtNum(r.inputTokens ?? 0)} in</span>
                  {' / '}
                  <span style={{ color: '#fda4af' }}>{fmtNum(r.outputTokens ?? 0)} out</span>
                  {' tok'}
                </span>
                <span data-testid={`text-swarm-usd-${r.provider}`}>
                  ~{fmtUsd(r.estimatedUsd)}
                  <span style={{ color: '#64748b' }}> @{fmtRate(r.costRate)}</span>
                </span>
              </div>
              {(r.legacyCallCount ?? 0) > 0 && (
                <div
                  data-testid={`text-swarm-legacy-${r.provider}`}
                  style={{ fontSize: 10, color: '#f59e0b', marginTop: 4 }}
                >
                  {r.legacyCallCount} legacy est ·{' '}
                  {r.estimatedUsd > 0
                    ? `${(((r.legacyEstimatedUsd ?? 0) / r.estimatedUsd) * 100).toFixed(0)}%`
                    : '0%'}{' '}
                  of $ inferred
                </div>
              )}
            </div>
          ))}
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            paddingTop: 10, fontSize: 11, color: '#64748b',
          }}>
            <span>Total</span>
            <span data-testid="text-swarm-totals">
              {totals.calls} calls · {fmtNum(totals.inputTokens)} in / {fmtNum(totals.outputTokens)} out tok · ~{fmtUsd(totals.usd)}
            </span>
          </div>
          {totals.legacyUsd > 0 && (
            <div
              data-testid="text-swarm-legacy-total"
              style={{ fontSize: 10, color: '#f59e0b', textAlign: 'right', marginTop: 2 }}
            >
              of which ~{fmtUsd(totals.legacyUsd)} ({legacyPct.toFixed(1)}%) estimated from legacy rows
            </div>
          )}
        </>
      )}

      {updatedAt !== null && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10,
            color: '#475569',
            textAlign: 'right',
          }}
          data-testid="text-swarm-updated"
        >
          updated {fmtAgo(now - updatedAt)}
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'

type Window = '24h' | '7d'

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

export default function SwarmStatsPanel() {
  const [window, setWindow] = useState<Window>('24h')
  const [data, setData] = useState<SwarmStatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/swarm/stats?window=${window}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<SwarmStatsResponse>
      })
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e?.message ?? 'Failed to load'))
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [window])

  const totals = (data?.rows ?? []).reduce(
    (acc, r) => ({
      calls: acc.calls + r.callCount,
      inputTokens: acc.inputTokens + (r.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (r.outputTokens ?? 0),
      tokens: acc.tokens + r.totalTokens,
      usd: acc.usd + r.estimatedUsd,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0 },
  )

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
        </>
      )}
    </div>
  )
}

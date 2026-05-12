import { useEffect, useState, useCallback } from 'react'

type Provider = {
  provider?: string
  verdict?: string
  bucket?: string | number
  conviction?: number | string
  error?: string
  ok?: boolean
  [k: string]: any
}

type Entry = {
  id: string
  action: string
  parsedAction: any
  reason: string | null
  providers: Provider[] | Record<string, any> | null
  exchange: string | null
  pair: string | null
  price: number | null
  createdAt: string
}

type AgentSummary = {
  id: string
  name: string
  openPositions: number
  resolved: number
  wins: number
  totalVolume: number
  realisedPnl: number
  winRate: number | null
} | null

type FeedResponse = {
  agent: AgentSummary
  entries: Entry[]
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

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 8,
        padding: '8px 6px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: color ?? '#fff', lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: '#999', marginTop: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
    </div>
  )
}

function actionColor(action: string): { bg: string; fg: string; label: string } {
  const a = (action || '').toUpperCase()
  if (a.includes('ENTER')) return { bg: '#0f5132', fg: '#a3e9c0', label: 'ENTER' }
  if (a.includes('DOUBLE_DOWN')) return { bg: '#553311', fg: '#ffcc88', label: 'DOUBLE DOWN' }
  if (a.includes('SPREAD')) return { bg: '#1a3a5c', fg: '#9ec5fe', label: 'SPREAD' }
  if (a.includes('HOLD')) return { bg: '#3b3b3b', fg: '#cccccc', label: 'HOLD' }
  if (a.includes('SKIP')) return { bg: '#3b3b3b', fg: '#888', label: 'SKIP' }
  if (a.includes('OPEN_PREDICTION') || a.includes('OPEN')) return { bg: '#0f5132', fg: '#a3e9c0', label: 'OPEN' }
  if (a.includes('CLOSE')) return { bg: '#5c1a2a', fg: '#fda4af', label: 'CLOSE' }
  return { bg: '#2a2a2a', fg: '#bbb', label: a || 'EVENT' }
}

function normalizeProviders(p: Entry['providers']): Provider[] {
  if (!p) return []
  if (Array.isArray(p)) return p as Provider[]
  // Object form { anthropic: {...}, xai: {...} }
  return Object.entries(p as Record<string, any>).map(([provider, value]) => {
    if (value && typeof value === 'object') return { provider, ...(value as object) }
    return { provider, verdict: String(value) }
  })
}

function providerSummary(pr: Provider): string {
  if (pr.error) return 'err'
  if (pr.bucket !== undefined && pr.bucket !== null && pr.bucket !== '') return `bucket ${pr.bucket}`
  if (pr.verdict) return String(pr.verdict).toLowerCase()
  if (pr.parsedAction) return String(pr.parsedAction).toLowerCase()
  return 'ok'
}

export default function CampaignBrain() {
  const [data, setData] = useState<FeedResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/public/campaign/brain?limit=40')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as FeedResponse
      setData(j)
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 20_000)
    return () => clearInterval(id)
  }, [load])

  const entries = data?.entries ?? []
  const agent = data?.agent

  return (
    <div style={{ paddingTop: 12, paddingBottom: 24 }}>
      {/* Hero */}
      <div
        style={{
          background: 'linear-gradient(135deg, #1a0a3a 0%, #0a0a2a 100%)',
          border: '1px solid #2d1a5a',
          borderRadius: 12,
          padding: '14px 16px',
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span
            style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: 4,
              background: '#22c55e', boxShadow: '0 0 6px #22c55e',
            }}
          />
          <span style={{ fontSize: 11, color: '#a3e9c0', fontWeight: 600, letterSpacing: 0.5 }}>
            LIVE · CAMPAIGN AGENT
          </span>
        </div>
        <h1 style={{ margin: 0, fontSize: 18, color: '#fff', fontWeight: 700 }}>
          {agent?.name ?? 'Build4'} — 42.space Agent vs Community
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#bbb', lineHeight: 1.5 }}>
          48-hour sprint · 12 rounds of BTC 8h price markets · live AI swarm reasoning,
          fully transparent. Updates every 20 seconds.
        </p>
        {agent && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 8,
              marginTop: 12,
            }}
          >
            <Stat label="Open" value={String(agent.openPositions)} />
            <Stat label="Resolved" value={`${agent.wins}/${agent.resolved}`} />
            <Stat
              label="PnL"
              value={`${agent.realisedPnl >= 0 ? '+' : ''}${agent.realisedPnl.toFixed(2)}`}
              color={agent.realisedPnl >= 0 ? '#a3e9c0' : '#fda4af'}
            />
            <Stat label="Volume" value={`$${agent.totalVolume.toFixed(0)}`} />
          </div>
        )}
      </div>

      {/* CTA strip */}
      <div
        style={{
          background: '#1a1a2a',
          border: '1px solid #333',
          borderRadius: 10,
          padding: '10px 12px',
          marginBottom: 14,
          fontSize: 12,
          color: '#ddd',
          lineHeight: 1.5,
        }}
      >
        Want your own AI trading agent on Aster, Hyperliquid &amp; predictions?
        <button
          onClick={() => {
            window.dispatchEvent(new CustomEvent('b4-nav', { detail: 'onboard' }))
          }}
          style={{
            display: 'block', marginTop: 8,
            background: 'linear-gradient(135deg, #6d28d9, #4c1d95)',
            color: '#fff', border: 'none', borderRadius: 8,
            padding: '8px 14px', fontWeight: 600, fontSize: 12,
            cursor: 'pointer', width: '100%',
          }}
          data-testid="button-deploy-from-brain"
        >
          ⚡ Deploy your own agent
        </button>
      </div>

      {loading && !data && (
        <div style={{ color: '#888', fontSize: 13, padding: 12, textAlign: 'center' }}>
          Loading brain feed…
        </div>
      )}
      {error && (
        <div
          style={{
            background: '#3a1a1a', border: '1px solid #5c2a2a', borderRadius: 8,
            padding: 10, color: '#fda4af', fontSize: 12, marginBottom: 10,
          }}
        >
          {error}
        </div>
      )}
      {!loading && entries.length === 0 && !error && (
        <div style={{ color: '#888', fontSize: 13, padding: 16, textAlign: 'center' }}>
          No reasoning logged yet — check back at the next round boundary
          (every 4h on the UTC clock: 00, 04, 08, 12, 16, 20).
        </div>
      )}

      {/* Feed */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {entries.map((e) => {
          const tag = actionColor(e.action)
          const provs = normalizeProviders(e.providers)
          return (
            <div
              key={e.id}
              data-testid={`brain-entry-${e.id}`}
              style={{
                background: '#15151f',
                border: '1px solid #2a2a3a',
                borderRadius: 10,
                padding: '12px 14px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span
                  style={{
                    background: tag.bg, color: tag.fg,
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                    padding: '3px 8px', borderRadius: 4,
                  }}
                >
                  {tag.label}
                </span>
                <span style={{ fontSize: 11, color: '#888' }}>{timeAgo(e.createdAt)}</span>
              </div>

              {(e.pair || e.price) && (
                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>
                  {e.pair && <span><b style={{ color: '#ddd' }}>{e.pair}</b></span>}
                  {e.price != null && <span> · ${Number(e.price).toLocaleString()}</span>}
                </div>
              )}

              {e.reason && (
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#e6e6e6', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                  {e.reason}
                </p>
              )}

              {provs.length > 0 && (
                <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #2a2a3a' }}>
                  <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                    🧠 Swarm verdict ({provs.length} model{provs.length === 1 ? '' : 's'})
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {provs.map((p, i) => {
                      const isErr = !!p.error
                      return (
                        <span
                          key={`${e.id}-${i}`}
                          style={{
                            fontSize: 10, fontWeight: 600,
                            background: isErr ? '#3a1a1a' : '#1a2a3a',
                            color: isErr ? '#fda4af' : '#9ec5fe',
                            border: `1px solid ${isErr ? '#5c2a2a' : '#2a4a6a'}`,
                            padding: '2px 6px', borderRadius: 4,
                          }}
                        >
                          {(p.provider || 'model').toLowerCase()}={providerSummary(p)}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p style={{ fontSize: 10, color: '#666', textAlign: 'center', marginTop: 18 }}>
        Build4 · Live brain feed · Powered by a 4-model AI swarm (Anthropic · xAI · Hyperbolic · Akash)
      </p>
    </div>
  )
}

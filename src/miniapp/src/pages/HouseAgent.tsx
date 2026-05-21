import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '../api'

type HouseMode = 'idle' | 'autotrade' | 'campaign'
type HouseDex = 'pancake' | 'aster' | 'hyperliquid' | '42'

interface HouseConfig {
  persona?: string
  sizeBnb?: number
  slippageBps?: number
  drawdownCapPct?: number
  maxOpenPositions?: number
  maxTradesPerHour?: number
  notes?: string
}

interface HouseState {
  id: string
  enabled: boolean
  mode: HouseMode
  dex: HouseDex
  walletAddress: string | null
  campaignId: string | null
  lastTickAt: string | null
  lastTickStatus: string | null
  config: HouseConfig
}

interface FeedRow {
  id: string
  createdAt: string
  dex: string | null
  kind: string
  decision: string | null
  reasoning: string
  txHash: string | null
}

interface StateResponse {
  ok: true
  state: HouseState
  walletReady: boolean
  feed: FeedRow[]
}

const MODES: { id: HouseMode; label: string; desc: string }[] = [
  { id: 'idle',      label: 'Idle',      desc: 'No trades fire. Safe parked state.' },
  { id: 'autotrade', label: 'Autotrade', desc: 'Continuous AI trading between campaigns.' },
  { id: 'campaign',  label: 'Campaign',  desc: 'Hand control to a scheduled campaign brain.' },
]

const DEXES: { id: HouseDex; label: string; ready: boolean }[] = [
  { id: 'pancake',     label: 'PancakeSwap (BSC)', ready: true },
  { id: '42',          label: '42.space',          ready: true },
  { id: 'aster',       label: 'Aster DEX',         ready: false },
  { id: 'hyperliquid', label: 'Hyperliquid L1',    ready: false },
]

export default function HouseAgent() {
  const [state, setState]   = useState<HouseState | null>(null)
  const [feed, setFeed]     = useState<FeedRow[]>([])
  const [walletReady, setWalletReady] = useState(true)
  const [err, setErr]       = useState<string | null>(null)
  const [busy, setBusy]     = useState(false)
  const [tradeBusy, setTradeBusy] = useState(false)

  const [configDraft, setConfigDraft] = useState<HouseConfig>({})

  // Manual trade form
  const [tradeSide, setTradeSide] = useState<'buy' | 'sell'>('buy')
  const [tradeToken, setTradeToken] = useState('')
  const [tradeAmount, setTradeAmount] = useState('0.01')
  const [tradeSlippage, setTradeSlippage] = useState('100')
  const [tradeResult, setTradeResult] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch<StateResponse>('/api/admin/house/state')
      setState(r.state)
      setFeed(r.feed || [])
      setWalletReady(r.walletReady)
      setConfigDraft(r.state.config || {})
      setErr(null)
    } catch (e: any) {
      setErr(e?.message || String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  const patch = useCallback(async (body: any) => {
    setBusy(true)
    try {
      await apiFetch('/api/admin/house/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      await refresh()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const sendTrade = useCallback(async () => {
    setTradeBusy(true); setTradeResult(null); setErr(null)
    try {
      const r = await apiFetch<{ ok: true; txHash: string }>('/api/admin/house/trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dex: 'pancake',
          side: tradeSide,
          tokenAddress: tradeToken.trim(),
          amount: tradeAmount.trim(),
          slippageBps: parseInt(tradeSlippage, 10) || 100,
        }),
      })
      setTradeResult(`✓ ${tradeSide.toUpperCase()} sent · tx ${r.txHash}`)
      await refresh()
    } catch (e: any) {
      setTradeResult(`✗ ${e?.message || String(e)}`)
    } finally {
      setTradeBusy(false)
    }
  }, [tradeSide, tradeToken, tradeAmount, tradeSlippage, refresh])

  if (!state) {
    return (
      <div style={{ padding: 16, color: 'var(--text-secondary)' }}>
        {err ? `Load failed: ${err}` : 'Loading house agent…'}
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 0 24px', color: 'var(--text-primary)' }} data-testid="page-house-agent">
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '4px 0 14px' }}>
        🏛 House Agent
      </h1>

      {err && (
        <div style={{
          padding: 10, borderRadius: 8, background: 'rgba(220,50,50,0.12)',
          border: '1px solid rgba(220,50,50,0.4)', color: '#ffb4b4',
          fontSize: 12, marginBottom: 12,
        }} data-testid="house-error">
          {err}
        </div>
      )}

      {/* Header card — wallet + on/off + status */}
      <section style={cardStyle} data-testid="house-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1 }}>
              Wallet
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: 13, marginTop: 2, wordBreak: 'break-all' }}
                 data-testid="house-wallet">
              {state.walletAddress ?? '—'}
            </div>
            {!walletReady && (
              <div style={{ fontSize: 11, color: '#ffb4b4', marginTop: 4 }}>
                ⚠ HOUSE_AGENT_PRIVATE_KEY not set on server
              </div>
            )}
          </div>
          <button
            onClick={() => patch({ enabled: !state.enabled })}
            disabled={busy || !walletReady}
            data-testid="button-house-toggle"
            style={{
              padding: '10px 18px', borderRadius: 8, border: 'none',
              fontWeight: 700, fontSize: 13, cursor: busy ? 'wait' : 'pointer',
              background: state.enabled ? '#1cb46a' : '#5a5a5a',
              color: '#fff', opacity: !walletReady ? 0.5 : 1,
            }}
          >
            {state.enabled ? 'ENABLED' : 'DISABLED'}
          </button>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)' }}>
          Last tick: {state.lastTickAt ? new Date(state.lastTickAt).toLocaleString() : 'never'}
          {state.lastTickStatus && ` · ${state.lastTickStatus}`}
        </div>
      </section>

      {/* Mode selector */}
      <section style={cardStyle}>
        <SectionTitle>Mode</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => patch({ mode: m.id })}
              disabled={busy}
              data-testid={`button-mode-${m.id}`}
              style={{
                textAlign: 'left', padding: '10px 12px', borderRadius: 8,
                border: state.mode === m.id ? '1px solid var(--purple)' : '1px solid var(--border)',
                background: state.mode === m.id ? 'rgba(118,69,217,0.12)' : 'transparent',
                color: 'var(--text-primary)', cursor: busy ? 'wait' : 'pointer',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{m.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{m.desc}</div>
            </button>
          ))}
        </div>
      </section>

      {/* DEX selector */}
      <section style={cardStyle}>
        <SectionTitle>DEX</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
          {DEXES.map(d => (
            <button
              key={d.id}
              onClick={() => d.ready && patch({ dex: d.id })}
              disabled={busy || !d.ready}
              data-testid={`button-dex-${d.id}`}
              style={{
                padding: '10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                border: state.dex === d.id ? '1px solid var(--purple)' : '1px solid var(--border)',
                background: state.dex === d.id ? 'rgba(118,69,217,0.12)' : 'transparent',
                color: d.ready ? 'var(--text-primary)' : 'var(--text-secondary)',
                cursor: d.ready ? (busy ? 'wait' : 'pointer') : 'not-allowed',
                opacity: d.ready ? 1 : 0.5,
              }}
            >
              {d.label}{!d.ready && ' (soon)'}
            </button>
          ))}
        </div>
      </section>

      {/* Config */}
      <section style={cardStyle}>
        <SectionTitle>Trading config</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
          <NumField label="Size (BNB)" value={configDraft.sizeBnb}
                    onChange={v => setConfigDraft(c => ({ ...c, sizeBnb: v }))} step="0.001" />
          <NumField label="Slippage (bps)" value={configDraft.slippageBps}
                    onChange={v => setConfigDraft(c => ({ ...c, slippageBps: v }))} step="10" />
          <NumField label="Drawdown cap (%)" value={configDraft.drawdownCapPct}
                    onChange={v => setConfigDraft(c => ({ ...c, drawdownCapPct: v }))} step="1" />
          <NumField label="Max open positions" value={configDraft.maxOpenPositions}
                    onChange={v => setConfigDraft(c => ({ ...c, maxOpenPositions: v }))} step="1" />
          <NumField label="Max trades / hour" value={configDraft.maxTradesPerHour}
                    onChange={v => setConfigDraft(c => ({ ...c, maxTradesPerHour: v }))} step="1" />
          <TextField label="Persona" value={configDraft.persona ?? ''}
                     onChange={v => setConfigDraft(c => ({ ...c, persona: v }))} />
        </div>
        <button
          onClick={() => patch({ config: configDraft })}
          disabled={busy}
          data-testid="button-save-config"
          style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 8, border: 'none',
            background: 'var(--purple)', color: '#fff', fontWeight: 700, fontSize: 13,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          Save config
        </button>
      </section>

      {/* Manual trade — PancakeSwap only for now */}
      <section style={cardStyle}>
        <SectionTitle>Manual trade · PancakeSwap</SectionTitle>
        <div style={{ display: 'flex', gap: 6, margin: '10px 0' }}>
          {(['buy', 'sell'] as const).map(s => (
            <button
              key={s}
              onClick={() => setTradeSide(s)}
              data-testid={`button-trade-side-${s}`}
              style={{
                flex: 1, padding: '8px', borderRadius: 8, fontWeight: 700, fontSize: 12,
                background: tradeSide === s
                  ? (s === 'buy' ? '#1cb46a' : '#d04e4e')
                  : 'transparent',
                color: tradeSide === s ? '#fff' : 'var(--text-secondary)',
                border: tradeSide === s ? 'none' : '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
        <TextField label="Token address (0x…)" value={tradeToken} onChange={setTradeToken} mono />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
          <TextField
            label={tradeSide === 'buy' ? 'BNB amount' : 'Token wei amount'}
            value={tradeAmount} onChange={setTradeAmount} mono
          />
          <TextField label="Slippage (bps)" value={tradeSlippage} onChange={setTradeSlippage} mono />
        </div>
        <button
          onClick={sendTrade}
          disabled={tradeBusy || !tradeToken || !tradeAmount}
          data-testid="button-send-trade"
          style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 8, border: 'none',
            background: tradeSide === 'buy' ? '#1cb46a' : '#d04e4e',
            color: '#fff', fontWeight: 700, fontSize: 13, width: '100%',
            cursor: tradeBusy ? 'wait' : 'pointer',
            opacity: (tradeBusy || !tradeToken || !tradeAmount) ? 0.5 : 1,
          }}
        >
          {tradeBusy ? 'Sending…' : `Send ${tradeSide.toUpperCase()}`}
        </button>
        {tradeResult && (
          <div style={{
            marginTop: 10, fontFamily: 'monospace', fontSize: 11,
            color: tradeResult.startsWith('✓') ? '#1cb46a' : '#ffb4b4',
            wordBreak: 'break-all',
          }} data-testid="text-trade-result">
            {tradeResult}
          </div>
        )}
      </section>

      {/* Brain feed */}
      <section style={cardStyle}>
        <SectionTitle>Brain feed · last {feed.length}</SectionTitle>
        {feed.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
            No activity yet. Enable + send a trade to populate.
          </div>
        ) : (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {feed.map(row => (
              <div key={row.id} style={{
                padding: 8, borderRadius: 6, background: 'var(--bg-elevated)',
                border: '1px solid var(--border)', fontSize: 11,
              }} data-testid={`feed-row-${row.id}`}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                    {new Date(row.createdAt).toLocaleTimeString()}
                  </span>
                  {row.dex && <Tag>{row.dex}</Tag>}
                  <Tag>{row.kind}</Tag>
                  {row.decision && <Tag tone="purple">{row.decision}</Tag>}
                </div>
                <div style={{ color: 'var(--text-primary)' }}>{row.reasoning}</div>
                {row.txHash && (
                  <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-secondary)', marginTop: 4, wordBreak: 'break-all' }}>
                    tx {row.txHash}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 14,
  marginBottom: 12,
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--text-secondary)',
      textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600,
    }}>
      {children}
    </div>
  )
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'purple' }) {
  return (
    <span style={{
      fontSize: 10, padding: '2px 6px', borderRadius: 4,
      background: tone === 'purple' ? 'rgba(118,69,217,0.18)' : 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      color: tone === 'purple' ? '#c2a3ff' : 'var(--text-secondary)',
      textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600,
    }}>
      {children}
    </span>
  )
}

function NumField({ label, value, onChange, step }: {
  label: string; value: number | undefined; onChange: (v: number | undefined) => void; step?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 11, color: 'var(--text-secondary)' }}>
      {label}
      <input
        type="number" step={step}
        value={value ?? ''}
        onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        data-testid={`input-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
        style={{
          marginTop: 4, padding: '8px 10px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-primary)', fontSize: 13, fontFamily: 'monospace',
        }}
      />
    </label>
  )
}

function TextField({ label, value, onChange, mono }: {
  label: string; value: string; onChange: (v: string) => void; mono?: boolean
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 11, color: 'var(--text-secondary)' }}>
      {label}
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        data-testid={`input-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
        style={{
          marginTop: 4, padding: '8px 10px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-primary)', fontSize: 13,
          fontFamily: mono ? 'monospace' : undefined,
        }}
      />
    </label>
  )
}

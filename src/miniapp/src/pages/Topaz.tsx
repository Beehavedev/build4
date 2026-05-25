import { useEffect, useState } from 'react'
import { apiFetch } from '../api'

interface TopazState {
  ok: boolean
  enabled: boolean
  phase: number
  writesGated: string
  userWallet: { address: string | null; error: string | null }
  config: {
    router: string | null
    npm: string | null
    voter: string | null
    topazToken: string | null
    maxTradeUsdt: number
    defaultSlippageBps: number
  }
}
interface Gauge {
  gauge: string
  pool: string
  token0Symbol: string
  token1Symbol: string
  aprPct: number
  tvlUsd: number
  isV3: boolean
}
interface V3Position {
  kind: 'v3-nft'
  tokenId: string
  token0: string
  token1: string
  tickLower: number
  tickUpper: number
  liquidity: string
  tickSpacing: number
}

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 12, padding: 16, marginBottom: 12,
}
const input: React.CSSProperties = {
  background: '#12121a', border: '1px solid #2a2a3e', borderRadius: 10,
  padding: 12, color: '#fff', fontSize: 14, width: '100%', boxSizing: 'border-box',
  fontFamily: 'inherit', outline: 'none',
}
const label: React.CSSProperties = { fontSize: 12, color: '#9ca3af', fontWeight: 500, marginBottom: 6, display: 'block' }
const btn = (primary: boolean): React.CSSProperties => ({
  padding: '12px 16px', borderRadius: 10, border: 'none',
  background: primary ? 'var(--purple)' : '#2a2a3e',
  color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  width: '100%', fontFamily: 'inherit',
})
const tabBtn = (active: boolean): React.CSSProperties => ({
  flex: 1, padding: '10px 0', background: active ? 'var(--purple)' : '#12121a',
  color: active ? '#fff' : '#9ca3af', border: 'none', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
})

const short = (a: string | null | undefined) =>
  a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'

export default function Topaz() {
  const [tab, setTab] = useState<'swap' | 'lp'>('swap')
  const [state, setState] = useState<TopazState | null>(null)
  const [stateErr, setStateErr] = useState<string | null>(null)
  const [gauges, setGauges] = useState<Gauge[]>([])
  const [positions, setPositions] = useState<V3Position[]>([])
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // Swap state
  const [tokenIn, setTokenIn] = useState('')
  const [tokenOut, setTokenOut] = useState('')
  const [amountIn, setAmountIn] = useState('')
  const [stable, setStable] = useState(false)
  const [slippageBps, setSlippageBps] = useState('50')
  const [quote, setQuote] = useState<string | null>(null)

  // LP add state
  const [lpA, setLpA] = useState('')
  const [lpB, setLpB] = useState('')
  const [lpAmtA, setLpAmtA] = useState('')
  const [lpAmtB, setLpAmtB] = useState('')
  const [lpStable, setLpStable] = useState(false)

  const loadAll = async () => {
    try {
      const s = await apiFetch<TopazState>('/api/topaz/state')
      setState(s)
      setStateErr(null)
    } catch (e: any) {
      setStateErr(e?.message ?? 'failed to load topaz state')
    }
    try {
      const g = await apiFetch<{ gauges: Gauge[] }>('/api/topaz/gauges?limit=10')
      setGauges(g.gauges ?? [])
    } catch { /* subgraph optional */ }
    try {
      const p = await apiFetch<{ positions: V3Position[] }>('/api/topaz/positions')
      setPositions(p.positions ?? [])
    } catch { /* not enabled, leave empty */ }
  }

  useEffect(() => { void loadAll() }, [])

  const doQuote = async () => {
    setMsg(null); setQuote(null)
    if (!tokenIn || !tokenOut || !amountIn) {
      setMsg({ kind: 'err', text: 'Fill tokenIn / tokenOut / amount' })
      return
    }
    setBusy(true)
    try {
      const r = await apiFetch<{ amountOut: string }>('/api/topaz/quote', {
        method: 'POST',
        body: JSON.stringify({ tokenIn, tokenOut, amountIn, stable }),
      })
      setQuote(r.amountOut)
      setMsg({ kind: 'ok', text: `Quote: ${r.amountOut} (raw units)` })
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'quote failed' })
    } finally { setBusy(false) }
  }

  const doSwap = async () => {
    setMsg(null)
    if (!tokenIn || !tokenOut || !amountIn) return
    setBusy(true)
    try {
      const r = await apiFetch<{ ok: boolean; txHash?: string; error?: string }>(
        '/api/topaz/swap',
        {
          method: 'POST',
          body: JSON.stringify({
            tokenIn, tokenOut, amountIn, stable,
            slippageBps: Number(slippageBps) || undefined,
          }),
        },
      )
      if (r.ok) setMsg({ kind: 'ok', text: `Swap tx: ${short(r.txHash ?? '')}` })
      else setMsg({ kind: 'err', text: r.error ?? 'swap failed' })
      await loadAll()
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'swap failed' })
    } finally { setBusy(false) }
  }

  const doLpAdd = async () => {
    setMsg(null)
    if (!lpA || !lpB || !lpAmtA || !lpAmtB) return
    setBusy(true)
    try {
      const r = await apiFetch<{ ok: boolean; txHash?: string; error?: string }>(
        '/api/topaz/lp/add',
        {
          method: 'POST',
          body: JSON.stringify({
            tokenA: lpA, tokenB: lpB, stable: lpStable,
            amountADesired: lpAmtA, amountBDesired: lpAmtB,
          }),
        },
      )
      if (r.ok) setMsg({ kind: 'ok', text: `LP add tx: ${short(r.txHash ?? '')}` })
      else setMsg({ kind: 'err', text: r.error ?? 'lp add failed' })
      await loadAll()
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'lp add failed' })
    } finally { setBusy(false) }
  }

  const doBurn = async (tokenId: string) => {
    if (!confirm(`Burn v3 position #${tokenId}? This decreases liquidity, collects fees, and burns the NFT.`)) return
    setBusy(true); setMsg(null)
    try {
      const r = await apiFetch<{ ok: boolean; txHash?: string; error?: string }>(
        '/api/topaz/v3/burn',
        { method: 'POST', body: JSON.stringify({ tokenId }) },
      )
      if (r.ok) setMsg({ kind: 'ok', text: `Burn tx: ${short(r.txHash ?? '')}` })
      else setMsg({ kind: 'err', text: r.error ?? 'burn failed' })
      await loadAll()
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'burn failed' })
    } finally { setBusy(false) }
  }

  return (
    <div data-testid="page-topaz" style={{ paddingTop: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 12px' }}>TOPAZ</h1>
      <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>
        BSC ve(3,3) — spot swaps + LP farming from your own wallet.
      </div>

      {/* User wallet card */}
      <div style={card} data-testid="card-topaz-wallet">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase' }}>Your Wallet</div>
            <div style={{ fontSize: 13, fontFamily: 'monospace', marginTop: 4 }} data-testid="text-topaz-user-wallet">
              {state?.userWallet.address ? short(state.userWallet.address) : '—'}
            </div>
          </div>
          <div style={{
            fontSize: 11, padding: '4px 8px', borderRadius: 6,
            background: state?.enabled ? '#10b981' : '#6b7280', color: '#fff',
          }}>
            {state?.enabled ? 'ENABLED' : 'DISABLED'}
          </div>
        </div>
        {state?.userWallet.error && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#ef4444' }} data-testid="text-topaz-error">
            {state.userWallet.error === 'no_bsc_wallet'
              ? 'No active BSC wallet — set one up from the Wallet tab to trade on Topaz.'
              : state.userWallet.error}
          </div>
        )}
        {stateErr && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#ef4444' }}>
            {stateErr}
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280' }}>
          Cap: ${state?.config.maxTradeUsdt ?? '?'}/trade · slippage {state?.config.defaultSlippageBps ?? '?'} bps
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderRadius: 10, overflow: 'hidden', marginBottom: 12, border: '1px solid #2a2a3e' }}>
        <button onClick={() => setTab('swap')} data-testid="tab-topaz-swap" style={tabBtn(tab === 'swap')}>Swap</button>
        <button onClick={() => setTab('lp')} data-testid="tab-topaz-lp" style={tabBtn(tab === 'lp')}>LP / Farms</button>
      </div>

      {msg && (
        <div data-testid="text-topaz-msg" style={{
          ...card,
          background: msg.kind === 'ok' ? '#064e3b' : '#7f1d1d',
          color: '#fff', fontSize: 13,
        }}>{msg.text}</div>
      )}

      {tab === 'swap' && (
        <div style={card}>
          <label style={label}>Token IN (address)</label>
          <input data-testid="input-topaz-token-in" style={input} value={tokenIn} onChange={e => setTokenIn(e.target.value.trim())} placeholder="0x..." />
          <div style={{ height: 8 }} />
          <label style={label}>Token OUT (address)</label>
          <input data-testid="input-topaz-token-out" style={input} value={tokenOut} onChange={e => setTokenOut(e.target.value.trim())} placeholder="0x..." />
          <div style={{ height: 8 }} />
          <label style={label}>Amount IN (raw units, e.g. wei for 18-decimal tokens)</label>
          <input data-testid="input-topaz-amount-in" style={input} value={amountIn} onChange={e => setAmountIn(e.target.value.trim())} placeholder="1000000000000000000" />
          <div style={{ height: 8 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>Slippage (bps, 50 = 0.5%)</label>
              <input data-testid="input-topaz-slippage" style={input} value={slippageBps} onChange={e => setSlippageBps(e.target.value.trim())} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>Pool kind</label>
              <select
                data-testid="select-topaz-stable"
                style={{ ...input, paddingRight: 28 }}
                value={stable ? 'stable' : 'volatile'}
                onChange={e => setStable(e.target.value === 'stable')}
              >
                <option value="volatile">Volatile</option>
                <option value="stable">Stable</option>
              </select>
            </div>
          </div>
          {quote && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#10b981' }}>
              Quote: {quote} (raw out)
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button data-testid="button-topaz-quote" onClick={doQuote} disabled={busy} style={btn(false)}>Quote</button>
            <button data-testid="button-topaz-swap" onClick={doSwap} disabled={busy} style={btn(true)}>Swap</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
            Swap executes from your active BSC wallet.
          </div>
        </div>
      )}

      {tab === 'lp' && (
        <>
          {/* Add LP */}
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Add v2 Liquidity</div>
            <label style={label}>Token A</label>
            <input data-testid="input-topaz-lp-a" style={input} value={lpA} onChange={e => setLpA(e.target.value.trim())} placeholder="0x..." />
            <div style={{ height: 8 }} />
            <label style={label}>Token B</label>
            <input data-testid="input-topaz-lp-b" style={input} value={lpB} onChange={e => setLpB(e.target.value.trim())} placeholder="0x..." />
            <div style={{ height: 8 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>Amount A</label>
                <input data-testid="input-topaz-lp-amt-a" style={input} value={lpAmtA} onChange={e => setLpAmtA(e.target.value.trim())} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>Amount B</label>
                <input data-testid="input-topaz-lp-amt-b" style={input} value={lpAmtB} onChange={e => setLpAmtB(e.target.value.trim())} />
              </div>
            </div>
            <div style={{ height: 8 }} />
            <label style={label}>Pool kind</label>
            <select
              data-testid="select-topaz-lp-stable"
              style={{ ...input, paddingRight: 28 }}
              value={lpStable ? 'stable' : 'volatile'}
              onChange={e => setLpStable(e.target.value === 'stable')}
            >
              <option value="volatile">Volatile</option>
              <option value="stable">Stable</option>
            </select>
            <div style={{ marginTop: 12 }}>
              <button data-testid="button-topaz-lp-add" onClick={doLpAdd} disabled={busy} style={btn(true)}>Add liquidity</button>
            </div>
          </div>

          {/* Top gauges */}
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Top gauges by APR</div>
            {gauges.length === 0 && (
              <div style={{ fontSize: 12, color: '#6b7280' }}>No gauges (subgraph not configured).</div>
            )}
            {gauges.map(g => (
              <div key={g.gauge} data-testid={`row-gauge-${g.gauge}`} style={{
                display: 'flex', justifyContent: 'space-between', padding: '8px 0',
                borderBottom: '1px solid #2a2a3e',
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {g.token0Symbol}/{g.token1Symbol} {g.isV3 ? '(v3)' : '(v2)'}
                  </div>
                  <div style={{ fontSize: 10, color: '#6b7280', fontFamily: 'monospace' }}>
                    {short(g.pool)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#10b981' }}>{g.aprPct.toFixed(2)}% APR</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>${g.tvlUsd.toLocaleString()} TVL</div>
                </div>
              </div>
            ))}
          </div>

          {/* Open positions */}
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Open v3 positions ({positions.length})</div>
            {positions.length === 0 && (
              <div style={{ fontSize: 12, color: '#6b7280' }}>No open v3 positions on your wallet.</div>
            )}
            {positions.map(p => (
              <div key={p.tokenId} data-testid={`row-position-${p.tokenId}`} style={{
                padding: 10, marginBottom: 8, borderRadius: 8, background: '#12121a',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>#{p.tokenId}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>
                      {short(p.token0)} / {short(p.token1)}
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>
                      Range [{p.tickLower}, {p.tickUpper}] · spacing {p.tickSpacing}
                    </div>
                  </div>
                  <button
                    data-testid={`button-burn-${p.tokenId}`}
                    onClick={() => doBurn(p.tokenId)}
                    disabled={busy}
                    style={{ ...btn(false), width: 'auto', padding: '8px 12px', fontSize: 12 }}
                  >
                    Burn
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

import { useRef, useState } from 'react'
import { apiFetch } from '../api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'

// How often the open Topaz page silently re-pulls balances / positions /
// prices so a left-open tab doesn't drift stale. Paused while a write action
// is in flight and while the tab is hidden (see the auto-refresh effect).
const AUTO_REFRESH_MS = 30000

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
  gauge?: string
  pool?: string
  claimable?: string | null
  usdValue?: number | null
  claimableUsd?: number | null
}
interface WalletBalance {
  symbol: string
  address: string | null
  decimals: number
  raw: string
  formatted: string
  priceUsd?: number | null
  usdValue?: number | null
}
interface V2LpPosition {
  kind: 'v2-lp'
  pool: string
  gauge: string | null
  token0: string
  token1: string
  token0Symbol: string
  token1Symbol: string
  stable: boolean
  walletBalance: string
  stakedBalance: string
  claimable: string
  usdValue?: number | null
  claimableUsd?: number | null
}
interface ClaimAllResultItem {
  gauge: string
  kind: 'v2' | 'v3'
  tokenId?: string
  label: string
  ok: boolean
  txHash?: string
  error?: string
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

// Convert a raw 18-decimal bigint-string to a decimal string. LP tokens
// and TOPAZ emissions are both 18-decimal on BSC, so a single helper
// covers them without pulling ethers into the mini-app bundle.
const formatUnits18 = (raw: string | null | undefined): string => {
  if (!raw) return '0'
  let neg = false
  let s = raw
  if (s.startsWith('-')) { neg = true; s = s.slice(1) }
  if (!/^\d+$/.test(s)) return raw
  s = s.padStart(19, '0')
  const intPart = s.slice(0, s.length - 18)
  const fracPart = s.slice(s.length - 18).replace(/0+$/, '')
  const out = fracPart ? `${intPart}.${fracPart}` : intPart
  return neg ? `-${out}` : out
}

// Trim a decimal-string balance to a readable length without rounding the
// integer part away. Shows up to 6 significant fractional digits.
const fmtBal = (v: string | null | undefined): string => {
  if (!v) return '0'
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  if (n === 0) return '0'
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

// Format an approximate USD value. Returns null when the value is missing
// (unpriceable token / pool read failed) so the caller can render "—"
// instead of a fabricated $0.
const fmtUsd = (v: number | null | undefined): string | null => {
  if (v == null || !Number.isFinite(v)) return null
  if (v === 0) return '$0.00'
  if (v > 0 && v < 0.01) return '<$0.01'
  return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function Topaz() {
  const [tab, setTab] = useState<'swap' | 'lp'>('swap')
  const [state, setState] = useState<TopazState | null>(null)
  const [stateErr, setStateErr] = useState<string | null>(null)
  const [gauges, setGauges] = useState<Gauge[]>([])
  const [positions, setPositions] = useState<V3Position[]>([])
  const [balances, setBalances] = useState<WalletBalance[]>([])
  const [lpPositions, setLpPositions] = useState<V2LpPosition[]>([])
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [claimResults, setClaimResults] = useState<ClaimAllResultItem[] | null>(null)
  const [retryingKey, setRetryingKey] = useState<string | null>(null)
  const [retryingAll, setRetryingAll] = useState(false)
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

  // `loadingRef` makes loadAll single-flight so a write-action's direct
  // loadAll() can't overlap an in-progress fetch. The shared useAutoRefresh
  // hook below adds the interval, visibility-pause, and write-action skip
  // (paused while a swap/LP/claim/retry is mid-flight) so that logic isn't
  // copy-pasted per page.
  const loadingRef = useRef(false)

  const loadAll = async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
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
      try {
        const b = await apiFetch<{ balances: WalletBalance[]; lpPositions: V2LpPosition[] }>('/api/topaz/balances')
        setBalances(b.balances ?? [])
        setLpPositions(b.lpPositions ?? [])
      } catch { /* not enabled, leave empty */ }
    } finally {
      loadingRef.current = false
    }
  }

  // Keep an open page live: loads on mount, then silently re-pulls on an
  // interval. Skips ticks while a write action is in flight (swap/LP/claim/
  // retry) and while the tab is hidden, and fires an immediate refresh when
  // the tab becomes visible again. loadAll's catch blocks leave last-good
  // values in place on a transient failure, so there's no flicker.
  useAutoRefresh(loadAll, {
    intervalMs: AUTO_REFRESH_MS,
    paused: busy || retryingAll || retryingKey !== null,
  })

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

  const doClaim = async (gauge: string, kind: 'v2' | 'v3', tokenId?: string) => {
    setBusy(true); setMsg(null)
    try {
      const r = await apiFetch<{ ok: boolean; txHash?: string; error?: string }>(
        '/api/topaz/claim',
        { method: 'POST', body: JSON.stringify({ gauge, kind, tokenId }) },
      )
      if (r.ok) setMsg({ kind: 'ok', text: `Claim tx: ${short(r.txHash ?? '')}` })
      else setMsg({ kind: 'err', text: r.error ?? 'claim failed' })
      await loadAll()
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'claim failed' })
    } finally { setBusy(false) }
  }

  // Retry a single position that failed during "Claim all", straight from the
  // per-position results breakdown. On success we drop it from the list (and
  // clear the list entirely once nothing is left failing) so the user can see
  // their remaining work shrink without re-running the whole batch.
  const doRetry = async (item: ClaimAllResultItem) => {
    const key = `${item.kind}:${item.gauge}:${item.tokenId ?? ''}`
    setRetryingKey(key); setMsg(null)
    try {
      const r = await apiFetch<{ ok: boolean; txHash?: string; error?: string }>(
        '/api/topaz/claim',
        {
          method: 'POST',
          body: JSON.stringify({ gauge: item.gauge, kind: item.kind, tokenId: item.tokenId }),
        },
      )
      if (r.ok) {
        setMsg({ kind: 'ok', text: `Claimed ${item.label}: ${short(r.txHash ?? '')}` })
        setClaimResults(prev => {
          if (!prev) return prev
          const next = prev.map(it =>
            it === item ? { ...it, ok: true, txHash: r.txHash, error: undefined } : it,
          )
          return next.some(it => !it.ok) ? next : null
        })
      } else {
        setMsg({ kind: 'err', text: `${item.label}: ${r.error ?? 'claim failed'}` })
        setClaimResults(prev =>
          prev ? prev.map(it => (it === item ? { ...it, error: r.error ?? 'claim failed' } : it)) : prev,
        )
      }
      await loadAll()
    } catch (e: any) {
      setMsg({ kind: 'err', text: `${item.label}: ${e?.message ?? 'claim failed'}` })
    } finally { setRetryingKey(null) }
  }

  // Retry every position still marked failed in the "Claim all" breakdown, in
  // one tap AND one round-trip. We post just the failing rows as the claim-all
  // route's optional `targets` subset; the server claims them sequentially with
  // the same per-gauge fail-isolation and returns a per-position breakdown.
  // We then apply those results onto the card by key (not object identity) and
  // clear the card once nothing is left failing.
  const doRetryAll = async () => {
    if (!claimResults || retryingAll || retryingKey !== null) return
    const failed = claimResults.filter(it => !it.ok)
    if (failed.length === 0) return
    setRetryingAll(true); setMsg(null)
    const targets = failed.map(it => ({ gauge: it.gauge, kind: it.kind, tokenId: it.tokenId }))
    try {
      const r = await apiFetch<{
        ok: boolean; claimedCount: number; failedCount: number
        results?: ClaimAllResultItem[]; error?: string
      }>('/api/topaz/claim-all', { method: 'POST', body: JSON.stringify({ targets }) })
      if (r.error) {
        setMsg({ kind: 'err', text: r.error })
      } else {
        // Merge the returned per-position results back onto the card by key so
        // successes flip green and remaining failures keep their fresh error.
        const byKey = new Map(
          (r.results ?? []).map(it => [`${it.kind}:${it.gauge}:${it.tokenId ?? ''}`, it]),
        )
        setClaimResults(prev =>
          prev
            ? prev.map(it => {
                const upd = byKey.get(`${it.kind}:${it.gauge}:${it.tokenId ?? ''}`)
                return upd
                  ? { ...it, ok: upd.ok, txHash: upd.txHash, error: upd.ok ? undefined : (upd.error ?? 'claim failed') }
                  : it
              })
            : prev,
        )
        const claimed = r.claimedCount
        const stillFailed = r.failedCount
        if (stillFailed === 0) {
          setMsg({ kind: 'ok', text: `Retried ${claimed} position(s) successfully.` })
        } else {
          setMsg({
            kind: claimed > 0 ? 'ok' : 'err',
            text: `Retried: ${claimed} ok, ${stillFailed} still failing.`,
          })
        }
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'retry all failed' })
    } finally {
      setRetryingAll(false)
    }
    // Drop the card entirely if every position now succeeds, otherwise keep it
    // so the user can see what's still failing.
    setClaimResults(prev => (prev && prev.some(it => !it.ok) ? prev : null))
    await loadAll()
  }

  const doClaimAll = async () => {
    setBusy(true); setMsg(null); setClaimResults(null)
    try {
      const r = await apiFetch<{
        ok: boolean; claimedCount: number; failedCount: number
        results?: ClaimAllResultItem[]; error?: string
      }>('/api/topaz/claim-all', { method: 'POST', body: JSON.stringify({}) })
      if (r.error) {
        setMsg({ kind: 'err', text: r.error })
      } else if (r.claimedCount === 0 && r.failedCount === 0) {
        setMsg({ kind: 'ok', text: 'Nothing to claim.' })
      } else if (r.failedCount === 0) {
        setMsg({ kind: 'ok', text: `Claimed all ${r.claimedCount} position(s).` })
      } else {
        setMsg({
          kind: r.claimedCount > 0 ? 'ok' : 'err',
          text: `Claimed ${r.claimedCount}, ${r.failedCount} failed.`,
        })
        // Keep the full breakdown (successes + failures) so the user can see
        // exactly which positions still need claiming and why.
        if (r.results && r.results.length > 0) setClaimResults(r.results)
      }
      await loadAll()
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'claim all failed' })
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

  const claimablePositions = [
    ...positions.filter(p => p.gauge && p.claimable != null && p.claimable !== '0'),
    ...lpPositions.filter(p => p.gauge && p.claimable !== '0'),
  ]
  const claimableCount = claimablePositions.length

  // Aggregate claimable TOPAZ across every eligible v2 + v3 position so the
  // "Claim all" card can show the total payout before the user taps. Summed
  // client-side from already-loaded raw (18-decimal) claimable values via
  // BigInt to avoid float drift; USD is summed only over priceable positions.
  let claimableTotalRaw = 0n
  let claimableUsdTotal = 0
  let anyUsd = false
  for (const p of claimablePositions) {
    const raw = p.claimable
    if (raw && /^\d+$/.test(raw)) claimableTotalRaw += BigInt(raw)
    if (p.claimableUsd != null && Number.isFinite(p.claimableUsd)) {
      claimableUsdTotal += p.claimableUsd
      anyUsd = true
    }
  }
  const claimableTotalTopaz = fmtBal(formatUnits18(claimableTotalRaw.toString()))
  const claimableUsdLabel = anyUsd ? fmtUsd(claimableUsdTotal) : null

  // How many positions in the "Claim all" breakdown are still failing — drives
  // the one-tap "Retry all failed" button, only worth showing for >1 failure.
  const failedClaimCount = claimResults ? claimResults.filter(it => !it.ok).length : 0

  // Total Topaz portfolio value: sum the approximate USD of every priced
  // wallet balance, v2 LP position, and v3 NFT position. Items we couldn't
  // price (no feed / pool read failed) are skipped and flagged so the header
  // can mark the total as approximate rather than silently undercounting.
  let portfolioUsdTotal = 0
  let anyPortfolioUsd = false
  let anyUnpriced = false
  for (const item of [...balances, ...lpPositions, ...positions]) {
    if (item.usdValue != null && Number.isFinite(item.usdValue)) {
      portfolioUsdTotal += item.usdValue
      anyPortfolioUsd = true
    } else {
      anyUnpriced = true
    }
  }
  const portfolioUsdLabel = anyPortfolioUsd ? fmtUsd(portfolioUsdTotal) : null

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
        {(portfolioUsdLabel || claimableUsdLabel) && (
          <div style={{ marginTop: 12 }} data-testid="row-topaz-total-value">
            <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase' }}>Total Value</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }} data-testid="text-topaz-total-value">
              ≈ {portfolioUsdLabel ?? fmtUsd(0)}
            </div>
            {claimableUsdLabel && (
              <div style={{ fontSize: 12, color: '#10b981', marginTop: 4 }} data-testid="text-topaz-total-rewards">
                + ≈ {claimableUsdLabel} unclaimed rewards
              </div>
            )}
            {claimableUsdLabel && portfolioUsdLabel && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }} data-testid="text-topaz-total-incl-rewards">
                ≈ {fmtUsd(portfolioUsdTotal + claimableUsdTotal)} incl. rewards
              </div>
            )}
            {anyUnpriced && (
              <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }} data-testid="text-topaz-total-approx">
                Approximate — excludes items we couldn't price.
              </div>
            )}
          </div>
        )}
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
        {balances.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }} data-testid="row-topaz-balances">
            {balances.map(b => (
              <div
                key={b.address ?? 'native'}
                data-testid={`balance-${b.symbol}`}
                style={{
                  flex: '1 1 30%', minWidth: 90, background: '#12121a',
                  borderRadius: 8, padding: '8px 10px',
                }}
              >
                <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase' }}>{b.symbol}</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{fmtBal(b.formatted)}</div>
                {fmtUsd(b.usdValue) && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }} data-testid={`usd-${b.symbol}`}>
                    ≈ {fmtUsd(b.usdValue)}
                  </div>
                )}
              </div>
            ))}
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
          {/* Claim all — shown when >1 position has claimable emissions */}
          {claimableCount > 1 && (
            <div style={card} data-testid="card-topaz-claim-all">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-claim-all-total">
                    ~{claimableTotalTopaz} TOPAZ
                    {claimableUsdLabel && (
                      <span style={{ fontSize: 12, fontWeight: 400, color: '#9ca3af' }}>
                        {' '}(≈ {claimableUsdLabel})
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                    Across {claimableCount} positions — claim every gauge in one tap.
                  </div>
                </div>
                <button
                  data-testid="button-topaz-claim-all"
                  onClick={doClaimAll}
                  disabled={busy}
                  style={{ ...btn(true), width: 'auto', padding: '10px 16px', fontSize: 13, whiteSpace: 'nowrap' }}
                >
                  Claim all
                </button>
              </div>
            </div>
          )}

          {/* Per-position "Claim all" breakdown — shown after a partial
              failure so the user can see which gauges succeeded, which
              failed and why, and retry the failures individually. */}
          {claimResults && claimResults.length > 0 && (
            <div style={card} data-testid="card-topaz-claim-results">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Claim all results</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {failedClaimCount > 1 && (
                    <button
                      data-testid="button-topaz-retry-all-failed"
                      onClick={doRetryAll}
                      disabled={retryingAll || retryingKey !== null || busy}
                      style={{ ...btn(true), width: 'auto', padding: '8px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
                    >
                      {retryingAll ? 'Retrying…' : `Retry all failed (${failedClaimCount})`}
                    </button>
                  )}
                  <button
                    data-testid="button-topaz-claim-results-dismiss"
                    onClick={() => setClaimResults(null)}
                    disabled={retryingAll || retryingKey !== null}
                    style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              {claimResults.map(item => {
                const key = `${item.kind}:${item.gauge}:${item.tokenId ?? ''}`
                return (
                  <div
                    key={key}
                    data-testid={`row-claim-result-${item.kind}-${item.tokenId ?? item.gauge}`}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                      padding: '8px 0', borderBottom: '1px solid #2a2a3e',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        <span style={{ color: item.ok ? '#10b981' : '#ef4444' }}>
                          {item.ok ? '✓' : '✕'}
                        </span>{' '}
                        {item.label}{' '}
                        <span style={{ fontSize: 10, color: '#6b7280' }}>({item.kind})</span>
                      </div>
                      {item.ok ? (
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, fontFamily: 'monospace' }}>
                          {item.txHash ? `tx: ${short(item.txHash)}` : 'claimed'}
                        </div>
                      ) : (
                        <div
                          data-testid={`text-claim-result-error-${item.kind}-${item.tokenId ?? item.gauge}`}
                          style={{ fontSize: 11, color: '#fca5a5', marginTop: 2, wordBreak: 'break-word' }}
                        >
                          {item.error ?? 'claim failed'}
                        </div>
                      )}
                    </div>
                    {!item.ok && (
                      <button
                        data-testid={`button-claim-result-retry-${item.kind}-${item.tokenId ?? item.gauge}`}
                        onClick={() => doRetry(item)}
                        disabled={busy || retryingKey !== null}
                        style={{ ...btn(true), width: 'auto', padding: '8px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
                      >
                        {retryingKey === key ? 'Retrying…' : 'Retry'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

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
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }} data-testid={`usd-position-${p.tokenId}`}>
                      Value: {fmtUsd(p.usdValue) ? `≈ ${fmtUsd(p.usdValue)}` : '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 2 }} data-testid={`text-claimable-${p.tokenId}`}>
                      Claimable: {p.claimable != null ? `${fmtBal(formatUnits18(p.claimable))} TOPAZ` : '—'}
                      {fmtUsd(p.claimableUsd) && ` (≈ ${fmtUsd(p.claimableUsd)})`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {p.gauge && p.claimable != null && p.claimable !== '0' && (
                      <button
                        data-testid={`button-claim-${p.tokenId}`}
                        onClick={() => doClaim(p.gauge as string, 'v3', p.tokenId)}
                        disabled={busy}
                        style={{ ...btn(true), width: 'auto', padding: '8px 12px', fontSize: 12 }}
                      >
                        Claim
                      </button>
                    )}
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
              </div>
            ))}
          </div>

          {/* v2 LP holdings */}
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Your v2 LP positions ({lpPositions.length})</div>
            {lpPositions.length === 0 && (
              <div style={{ fontSize: 12, color: '#6b7280' }}>No v2 LP positions on your wallet.</div>
            )}
            {lpPositions.map(p => (
              <div key={p.pool} data-testid={`row-v2lp-${p.pool}`} style={{
                padding: 10, marginBottom: 8, borderRadius: 8, background: '#12121a',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {p.token0Symbol}/{p.token1Symbol} {p.stable ? '(stable)' : '(volatile)'}
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280', fontFamily: 'monospace' }}>
                      {short(p.pool)}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }} data-testid={`text-v2lp-bal-${p.pool}`}>
                      Wallet: {fmtBal(formatUnits18(p.walletBalance))} · Staked: {fmtBal(formatUnits18(p.stakedBalance))}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }} data-testid={`usd-v2lp-${p.pool}`}>
                      Value: {fmtUsd(p.usdValue) ? `≈ ${fmtUsd(p.usdValue)}` : '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 2 }} data-testid={`text-v2lp-claimable-${p.pool}`}>
                      Claimable: {fmtBal(formatUnits18(p.claimable))} TOPAZ
                      {fmtUsd(p.claimableUsd) && ` (≈ ${fmtUsd(p.claimableUsd)})`}
                    </div>
                  </div>
                  {p.gauge && p.claimable !== '0' && (
                    <button
                      data-testid={`button-claim-v2-${p.pool}`}
                      onClick={() => doClaim(p.gauge as string, 'v2')}
                      disabled={busy}
                      style={{ ...btn(true), width: 'auto', padding: '8px 12px', fontSize: 12 }}
                    >
                      Claim
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

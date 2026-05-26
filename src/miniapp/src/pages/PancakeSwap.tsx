import { useEffect, useState } from 'react'
import { apiFetch } from '../api'

interface PcsState {
  ok: boolean
  userWallet: { address: string | null; error: string | null }
  balances: { bnb: number; usdt: number; error: string | null }
  tokens: { BNB: string; WBNB: string; USDT: string; CAKE: string }
}
interface QuoteResp {
  ok: boolean
  direction: 'buy' | 'sell'
  amountIn: string
  amountOut: string
  priceImpactPct: number | null
}
interface SwapResp {
  ok: boolean
  txHash?: string
  amountOut?: string
  minAmountOut?: string
  slippageBps?: number
  approvalTxHash?: string
  error?: string
}
interface PcsPosition {
  tokenAddress: string
  symbol?: string
  amount?: string
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

const short = (a: string | null | undefined) =>
  a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'

// All three supported tokenIn options are 18-decimal on BSC (BNB native,
// USDT-BSC is 18-dec — not 6 like Ethereum — and CAKE is 18). So we can
// hard-code the multiplier instead of probing decimals from-chain. If the
// user picks a non-listed token in the future we'll need a probe.
const DEC = 18
function toWei(amountStr: string): bigint | null {
  if (!amountStr) return null
  if (!/^\d*\.?\d*$/.test(amountStr)) return null
  const [whole = '0', frac = ''] = amountStr.split('.')
  const padded = (frac + '0'.repeat(DEC)).slice(0, DEC)
  try { return BigInt(whole) * 10n ** BigInt(DEC) + BigInt(padded || '0') } catch { return null }
}
function fromWei(weiStr: string): string {
  try {
    const w = BigInt(weiStr)
    const whole = w / 10n ** BigInt(DEC)
    const frac  = w % 10n ** BigInt(DEC)
    const fracStr = frac.toString().padStart(DEC, '0').replace(/0+$/, '')
    return fracStr ? `${whole}.${fracStr}` : `${whole}`
  } catch { return weiStr }
}

type TokenInKey = 'BNB' | 'USDT' | 'CAKE'

export default function PancakeSwap() {
  const [state, setState]   = useState<PcsState | null>(null)
  const [stateErr, setStateErr] = useState<string | null>(null)
  const [positions, setPositions] = useState<PcsPosition[]>([])
  const [msg, setMsg]       = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy]     = useState(false)

  const [tokenInKey, setTokenInKey] = useState<TokenInKey>('BNB')
  const [tokenOut,   setTokenOut]   = useState('')
  const [amount,     setAmount]     = useState('')
  const [slippagePct, setSlippagePct] = useState('0.50')
  const [quote, setQuote]   = useState<QuoteResp | null>(null)
  const [lastTx, setLastTx] = useState<string | null>(null)

  const tokenInAddr = (): string => {
    if (!state) return ''
    if (tokenInKey === 'BNB')  return 'BNB'
    if (tokenInKey === 'USDT') return state.tokens.USDT
    return state.tokens.CAKE
  }

  const loadAll = async () => {
    try {
      const s = await apiFetch<PcsState>('/api/pancakeswap/state')
      setState(s); setStateErr(null)
    } catch (e: any) {
      setStateErr(e?.message ?? 'failed to load pancakeswap state')
    }
    try {
      const p = await apiFetch<{ positions: PcsPosition[] }>('/api/pancakeswap/positions')
      setPositions(p.positions ?? [])
    } catch { /* leave empty */ }
  }

  useEffect(() => { void loadAll() }, [])

  const doQuote = async () => {
    setMsg(null); setQuote(null)
    if (!tokenOut || !amount) { setMsg({ kind: 'err', text: 'Fill tokenOut and amount' }); return }
    const wei = toWei(amount)
    if (!wei || wei <= 0n) { setMsg({ kind: 'err', text: 'Invalid amount' }); return }
    setBusy(true)
    try {
      const q = new URLSearchParams({
        tokenIn:  tokenInAddr(),
        tokenOut: tokenOut.trim(),
        amount:   wei.toString(),
      })
      const r = await apiFetch<QuoteResp>(`/api/pancakeswap/quote?${q.toString()}`)
      setQuote(r)
      setMsg({ kind: 'ok', text: `Expected out: ${fromWei(r.amountOut)}` })
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'quote failed' })
    } finally { setBusy(false) }
  }

  const doSwap = async () => {
    setMsg(null); setLastTx(null)
    if (!tokenOut || !amount) { setMsg({ kind: 'err', text: 'Fill tokenOut and amount' }); return }
    const wei = toWei(amount)
    if (!wei || wei <= 0n) { setMsg({ kind: 'err', text: 'Invalid amount' }); return }
    // Slippage UI is %, backend wants bps. Cap at 5% (=500 bps) client-side
    // to match the server's hard cap so the user gets immediate feedback
    // instead of a 400 round-trip.
    const slipPct = Math.min(5, Math.max(0, Number(slippagePct) || 0.5))
    const slipBps = Math.round(slipPct * 100)
    setBusy(true)
    try {
      const r = await apiFetch<SwapResp>('/api/pancakeswap/swap', {
        method: 'POST',
        body: JSON.stringify({
          tokenIn:  tokenInAddr(),
          tokenOut: tokenOut.trim(),
          amountIn: wei.toString(),
          slippageBps: slipBps,
        }),
      })
      if (r.ok && r.txHash) {
        setLastTx(r.txHash)
        setMsg({ kind: 'ok', text: `Swap sent · out ≈ ${fromWei(r.amountOut ?? '0')}` })
        await loadAll()
      } else {
        setMsg({ kind: 'err', text: r.error ?? 'swap failed' })
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'swap failed' })
    } finally { setBusy(false) }
  }

  const fmt = (n: number, d = 4) => Number.isFinite(n) ? n.toFixed(d) : '—'

  return (
    <div data-testid="page-pancakeswap" style={{ paddingTop: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 12px' }}>PANCAKESWAP</h1>
      <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>
        BSC V2 AMM — swap BNB ↔ any BEP-20 token from your own wallet.
      </div>

      {/* Wallet card */}
      <div style={card} data-testid="card-pcs-wallet">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase' }}>Your BSC Wallet</div>
            <div
              style={{ fontSize: 13, fontFamily: 'monospace', marginTop: 4 }}
              data-testid="text-pcs-user-wallet"
            >
              {state?.userWallet.address ? short(state.userWallet.address) : '—'}
            </div>
          </div>
          <button
            data-testid="button-pcs-refresh"
            onClick={loadAll}
            disabled={busy}
            style={{ ...btn(false), width: 'auto', padding: '8px 12px', fontSize: 12 }}
          >
            Refresh
          </button>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <div style={{ flex: 1, padding: 10, borderRadius: 8, background: '#12121a' }}>
            <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase' }}>BNB</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }} data-testid="text-pcs-bnb">
              {state ? fmt(state.balances.bnb, 6) : '—'}
            </div>
          </div>
          <div style={{ flex: 1, padding: 10, borderRadius: 8, background: '#12121a' }}>
            <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase' }}>USDT</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }} data-testid="text-pcs-usdt">
              {state ? fmt(state.balances.usdt, 2) : '—'}
            </div>
          </div>
        </div>
        {state?.userWallet.error && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#ef4444' }} data-testid="text-pcs-wallet-error">
            {state.userWallet.error === 'no_bsc_wallet'
              ? 'No active BSC wallet — set one up from the Wallet tab to trade on PancakeSwap.'
              : state.userWallet.error}
          </div>
        )}
        {stateErr && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#ef4444' }}>{stateErr}</div>
        )}
      </div>

      {msg && (
        <div data-testid="text-pcs-msg" style={{
          ...card,
          background: msg.kind === 'ok' ? '#064e3b' : '#7f1d1d',
          color: '#fff', fontSize: 13,
        }}>{msg.text}</div>
      )}

      {/* Swap form */}
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Swap</div>
        <label style={label}>Token IN</label>
        <select
          data-testid="select-pcs-token-in"
          style={{ ...input, paddingRight: 28 }}
          value={tokenInKey}
          onChange={e => setTokenInKey(e.target.value as TokenInKey)}
        >
          <option value="BNB">BNB</option>
          <option value="USDT">USDT</option>
          <option value="CAKE">CAKE</option>
        </select>
        <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280' }}>
          One side of the swap must be BNB. Pick BNB here to buy a token, or
          set tokenOut to BNB / WBNB to sell USDT or CAKE.
        </div>
        <div style={{ height: 10 }} />

        <label style={label}>Token OUT (BSC address, or "BNB")</label>
        <input
          data-testid="input-pcs-token-out"
          style={input}
          value={tokenOut}
          onChange={e => setTokenOut(e.target.value)}
          placeholder="0x... or BNB"
        />
        <div style={{ height: 10 }} />

        <label style={label}>Amount IN (whole tokens, e.g. 0.05)</label>
        <input
          data-testid="input-pcs-amount"
          style={input}
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="0.05"
          inputMode="decimal"
        />
        <div style={{ height: 10 }} />

        <label style={label}>Slippage (%, max 5)</label>
        <input
          data-testid="input-pcs-slippage"
          style={input}
          value={slippagePct}
          onChange={e => setSlippagePct(e.target.value)}
          placeholder="0.50"
          inputMode="decimal"
        />

        {quote && (
          <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#12121a', fontSize: 12 }}>
            <div data-testid="text-pcs-quote-out">
              Expected out: <strong>{fromWei(quote.amountOut)}</strong>
            </div>
            <div style={{ color: '#9ca3af', marginTop: 4 }} data-testid="text-pcs-quote-impact">
              Direction: {quote.direction}
              {quote.priceImpactPct !== null && (
                <> · price impact: {quote.priceImpactPct.toFixed(3)}%</>
              )}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button data-testid="button-pcs-quote" onClick={doQuote} disabled={busy} style={btn(false)}>
            {busy ? 'Working…' : 'Quote'}
          </button>
          <button data-testid="button-pcs-swap" onClick={doSwap} disabled={busy} style={btn(true)}>
            {busy ? 'Working…' : 'Swap'}
          </button>
        </div>

        {lastTx && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#10b981' }} data-testid="text-pcs-last-tx">
            tx:{' '}
            <a
              href={`https://bscscan.com/tx/${lastTx}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#10b981', textDecoration: 'underline', fontFamily: 'monospace' }}
              data-testid="link-pcs-tx"
            >
              {short(lastTx)}
            </a>
          </div>
        )}

        <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
          Swap executes from your active BSC wallet (Phase 2 — no master wallet).
        </div>
      </div>

      {/* Open positions */}
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
          Open positions ({positions.length})
        </div>
        {positions.length === 0 && (
          <div style={{ fontSize: 12, color: '#6b7280' }} data-testid="text-pcs-positions-empty">
            No tracked positions yet — server-side position tracking lands in a follow-up.
          </div>
        )}
        {positions.map(p => (
          <div
            key={p.tokenAddress}
            data-testid={`row-pcs-position-${p.tokenAddress}`}
            style={{
              padding: 10, marginBottom: 8, borderRadius: 8, background: '#12121a',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>{p.symbol ?? short(p.tokenAddress)}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>
              {short(p.tokenAddress)}
            </div>
            {p.amount && (
              <div style={{ fontSize: 11, color: '#6b7280' }}>amount: {p.amount}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

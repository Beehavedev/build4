import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api'

// Dedicated four.meme + DEX trading surface. Lets the user paste ANY
// BSC token address and trade it — auto-routes to the four.meme
// bonding curve pre-graduation and to PancakeSwap V2 post-graduation.
// Reuses GET /api/fourmeme/token/:addr (info + quote), POST
// /api/fourmeme/buy + /sell, and GET /api/fourmeme/wallet-balance/:addr
// for the Max button. The same endpoints power the inline trade modal
// in the launches history; this page is the standalone discovery
// surface so users don't have to dig through the launch list.

interface TokenInfo {
  graduatedToPancake: boolean
  lastPriceWei: string
  fundsWei: string
  maxFundsWei: string
  fillPct?: number
  // four.meme + PCS-fallback fields. Falls back to the contract if
  // missing in the response.
  symbol?: string
  name?: string
  source?: 'pancakeV2' | 'fourMeme'
}

interface TokenResponse {
  ok: boolean
  info?: TokenInfo
  venue?: 'pancakeV2' | 'fourMemeCurve'
  buyQuote?: { estimatedAmountWei: string }
  sellQuote?: { fundsWei: string }
  error?: string
  code?: string
}

interface RecentLaunch {
  id: string
  tokenName: string
  tokenSymbol: string
  tokenAddress: string | null
  status: string
}

interface Balance { bnbBalance: string; tokenBalance: string }

const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim())

export default function TokenTrade() {
  const [address, setAddress] = useState('')
  const [info, setInfo] = useState<TokenResponse | null>(null)
  const [infoErr, setInfoErr] = useState<string | null>(null)
  const [loadingInfo, setLoadingInfo] = useState(false)

  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [slippagePct, setSlippagePct] = useState('1')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [balance, setBalance] = useState<Balance | null>(null)
  const [quote, setQuote] = useState<{ outWei: string } | null>(null)
  const [quoteErr, setQuoteErr] = useState<string | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ txHash: string; venue: string } | null>(null)

  const [recent, setRecent] = useState<RecentLaunch[]>([])

  // Load recent launches once for the quick-pick chips. Best-effort —
  // failure just hides the chips row, no error toast.
  useEffect(() => {
    apiFetch<{ ok: boolean; launches: RecentLaunch[] }>('/api/fourmeme/launches')
      .then((j) => {
        if (!j?.ok) return
        const launched = (j.launches || [])
          .filter((r) => r.status === 'launched' && r.tokenAddress)
          .slice(0, 8)
        setRecent(launched)
      })
      .catch(() => { /* silent */ })
  }, [])

  // Fetch token info whenever the address becomes valid. Resets the
  // dependent UI (quote, balance, success) so a paste of a new address
  // doesn't surface stale data from the previous one.
  useEffect(() => {
    if (!isAddr(address)) {
      setInfo(null); setInfoErr(null); setBalance(null)
      setQuote(null); setSuccess(null); return
    }
    let cancelled = false
    setLoadingInfo(true); setInfoErr(null)
    apiFetch<TokenResponse>(`/api/fourmeme/token/${address.trim()}`)
      .then((j) => {
        if (cancelled) return
        if (j?.ok) { setInfo(j); setSuccess(null) }
        else { setInfo(null); setInfoErr(j?.error ?? 'Could not load token') }
      })
      .catch((e) => { if (!cancelled) { setInfo(null); setInfoErr(e?.message ?? 'Could not load token') } })
      .finally(() => { if (!cancelled) setLoadingInfo(false) })
    apiFetch<{ ok: boolean; bnbBalance: string; tokenBalance: string }>(`/api/fourmeme/wallet-balance/${address.trim()}`)
      .then((j) => { if (!cancelled && j?.ok) setBalance({ bnbBalance: j.bnbBalance, tokenBalance: j.tokenBalance }) })
      .catch(() => { /* balance is optional — Max just won't appear */ })
    return () => { cancelled = true }
  }, [address])

  // Debounced quote fetch when amount changes.
  useEffect(() => {
    const v = Number(amount)
    if (!isAddr(address) || !info || !Number.isFinite(v) || v <= 0) {
      setQuote(null); setQuoteErr(null); return
    }
    let cancelled = false
    const t = setTimeout(() => {
      const params = new URLSearchParams()
      if (side === 'buy') params.set('bnb', amount)
      else params.set('sell', amount)
      apiFetch<TokenResponse>(`/api/fourmeme/token/${address.trim()}?${params}`)
        .then((j) => {
          if (cancelled) return
          if (side === 'buy' && j.buyQuote) setQuote({ outWei: j.buyQuote.estimatedAmountWei })
          else if (side === 'sell' && j.sellQuote) setQuote({ outWei: j.sellQuote.fundsWei })
          else { setQuote(null); setQuoteErr(j?.error ?? 'no quote') }
        })
        .catch((e) => { if (!cancelled) { setQuote(null); setQuoteErr(e?.message ?? 'quote failed') } })
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [amount, side, address, info])

  const venueLabel = info?.venue === 'pancakeV2' ? 'PancakeSwap V2' : 'four.meme bonding curve'
  const symbol = info?.info?.symbol || 'TOKEN'

  const GAS_RESERVE_BNB = 0.002
  function handleMax() {
    if (!balance) return
    if (side === 'buy') {
      const max = Math.max(0, Number(balance.bnbBalance) - GAS_RESERVE_BNB)
      setAmount(max > 0 ? max.toFixed(6) : '0')
    } else {
      setAmount(balance.tokenBalance)
    }
  }

  const estOut = useMemo(() => {
    if (!quote) return null
    try {
      const wei = BigInt(quote.outWei)
      // Both buy (token wei, 18 dec) and sell (BNB wei, 18 dec) use 18 decimals.
      const n = Number(wei) / 1e18
      return n
    } catch { return null }
  }, [quote])

  function validatedSlippageBps(): number | null {
    const pct = Number(slippagePct)
    if (!Number.isFinite(pct) || pct <= 0 || pct > 20) return null
    return Math.round(pct * 100)
  }

  async function submit() {
    if (!isAddr(address)) { setSubmitErr('Enter a valid token address'); return }
    const v = Number(amount)
    if (!Number.isFinite(v) || v <= 0) { setSubmitErr('Enter an amount'); return }
    const bps = validatedSlippageBps()
    if (bps == null) { setSubmitErr('Slippage must be 0.1–20%'); return }
    setSubmitting(true); setSubmitErr(null)
    try {
      const path = side === 'buy' ? '/api/fourmeme/buy' : '/api/fourmeme/sell'
      const body = side === 'buy'
        ? { tokenAddress: address.trim(), bnbAmount: amount, slippageBps: bps }
        : { tokenAddress: address.trim(), tokenAmount: amount, slippageBps: bps }
      const j = await apiFetch<{ ok: boolean; txHash?: string; venue?: string; error?: string }>(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (j?.ok && j.txHash) {
        setSuccess({ txHash: j.txHash, venue: j.venue ?? venueLabel })
        setAmount('')
        // Refresh balance after a successful trade.
        apiFetch<{ ok: boolean; bnbBalance: string; tokenBalance: string }>(`/api/fourmeme/wallet-balance/${address.trim()}`)
          .then((r) => { if (r?.ok) setBalance({ bnbBalance: r.bnbBalance, tokenBalance: r.tokenBalance }) })
          .catch(() => {})
      } else {
        setSubmitErr(j?.error ?? 'Trade failed')
      }
    } catch (e: any) {
      setSubmitErr(e?.message ?? 'Trade failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ paddingTop: 20, paddingBottom: 80 }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
          🪙 Trade Tokens
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
          Buy & sell any BSC token — bonding curve or PancakeSwap, gasless routing
        </div>
      </div>

      {/* Address input */}
      <div className="card" style={{ marginBottom: 12 }} data-testid="card-token-address">
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
          Token contract address
        </label>
        <input
          type="text"
          placeholder="0x… (paste any BSC token)"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          data-testid="input-token-address"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          style={{
            width: '100%', padding: '12px 14px', fontSize: 13,
            borderRadius: 10, border: '1px solid var(--border)',
            background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            boxSizing: 'border-box', fontFamily: 'monospace',
          }}
        />
        {recent.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, marginBottom: 6 }}>
              Recent launches
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {recent.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => { if (r.tokenAddress) setAddress(r.tokenAddress) }}
                  data-testid={`chip-recent-${r.id}`}
                  style={{
                    padding: '5px 10px', fontSize: 11, fontWeight: 600,
                    borderRadius: 999, border: '1px solid var(--border)',
                    background: 'var(--bg-elevated)', color: 'var(--text-primary)',
                    cursor: 'pointer',
                  }}
                >${r.tokenSymbol}</button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Token info card */}
      {loadingInfo && (
        <div className="card" style={{ marginBottom: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
          Loading token…
        </div>
      )}
      {infoErr && !loadingInfo && (
        <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--red)' }} data-testid="text-info-error">
          <div style={{ fontSize: 13, color: 'var(--red)' }}>{infoErr}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            Make sure the address is a four.meme or BSC token. PancakeSwap-only tokens with no liquidity won't quote.
          </div>
        </div>
      )}
      {info?.info && !loadingInfo && (
        <div className="card" style={{ marginBottom: 12 }} data-testid="card-token-info">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }} data-testid="text-token-symbol">${symbol}</div>
              {info.info.name && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{info.info.name}</div>
              )}
            </div>
            <div style={{
              padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
              background: info.venue === 'pancakeV2' ? 'rgba(247,147,30,0.15)' : 'rgba(124,58,237,0.15)',
              color: info.venue === 'pancakeV2' ? '#f7931e' : 'var(--purple)',
            }} data-testid="badge-venue">
              {info.venue === 'pancakeV2' ? '🥞 PancakeSwap' : '🚀 four.meme'}
            </div>
          </div>

          {/* Stats row — price + (curve fill OR liquidity badge) */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
            marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)',
          }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Price
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}
                   data-testid="text-token-price">
                {(() => {
                  try {
                    const wei = BigInt(info.info.lastPriceWei || '0')
                    if (wei <= 0n) return '—'
                    const bnb = Number(wei) / 1e18
                    if (bnb >= 0.001) return `${bnb.toFixed(6)} BNB`
                    if (bnb >= 1e-9) return `${bnb.toExponential(3)} BNB`
                    return '< 1e-9 BNB'
                  } catch { return '—' }
                })()}
              </div>
            </div>
            {info.venue === 'fourMemeCurve' ? (
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Curve fill
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}
                     data-testid="text-fill-pct">
                  {typeof info.info.fillPct === 'number'
                    ? `${(info.info.fillPct * 100).toFixed(1)}%`
                    : '—'}
                </div>
                {typeof info.info.fillPct === 'number' && (
                  <div style={{
                    height: 4, marginTop: 4, borderRadius: 2, overflow: 'hidden',
                    background: 'var(--bg-elevated)',
                  }}>
                    <div style={{
                      width: `${Math.min(100, info.info.fillPct * 100)}%`,
                      height: '100%', background: 'var(--purple)',
                    }} />
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Venue
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#f7931e', marginTop: 2 }}>
                  PancakeSwap V2
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Trade panel — only shown after a token loads. */}
      {info?.info && !loadingInfo && (
        <div className="card" data-testid="card-trade-panel">
          {/* Buy/Sell toggle */}
          <div style={{
            display: 'flex', borderRadius: 10, overflow: 'hidden',
            border: '1px solid var(--border)', marginBottom: 12,
          }}>
            <button
              type="button"
              onClick={() => { setSide('buy'); setAmount(''); setSuccess(null); setSubmitErr(null) }}
              data-testid="button-side-buy"
              style={{
                flex: 1, padding: '10px 0', fontSize: 14, fontWeight: 700,
                border: 'none', cursor: 'pointer',
                background: side === 'buy' ? 'var(--green)' : 'transparent',
                color: side === 'buy' ? '#fff' : 'var(--text-secondary)',
              }}
            >Buy</button>
            <button
              type="button"
              onClick={() => { setSide('sell'); setAmount(''); setSuccess(null); setSubmitErr(null) }}
              data-testid="button-side-sell"
              style={{
                flex: 1, padding: '10px 0', fontSize: 14, fontWeight: 700,
                border: 'none', cursor: 'pointer',
                background: side === 'sell' ? 'var(--red)' : 'transparent',
                color: side === 'sell' ? '#fff' : 'var(--text-secondary)',
              }}
            >Sell</button>
          </div>

          {/* Amount + Max */}
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'baseline', marginBottom: 6,
          }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {side === 'buy' ? 'Amount (BNB)' : `Amount (${symbol})`}
            </label>
            {balance && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }} data-testid="text-balance">
                Bal: {side === 'buy'
                  ? `${Number(balance.bnbBalance).toFixed(4)} BNB`
                  : `${Number(balance.tokenBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol}`}
              </span>
            )}
          </div>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="input-amount"
              style={{
                width: '100%', padding: '12px 60px 12px 14px', fontSize: 18,
                borderRadius: 10, border: '1px solid var(--border)',
                background: 'var(--bg-elevated)', color: 'var(--text-primary)',
                boxSizing: 'border-box',
              }}
            />
            {balance && (
              <button
                type="button"
                onClick={handleMax}
                data-testid="button-max"
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  padding: '5px 10px', fontSize: 11, fontWeight: 700,
                  borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--bg-card)', color: 'var(--purple)',
                  cursor: 'pointer',
                }}
              >MAX</button>
            )}
          </div>

          {/* Quote summary */}
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            background: 'var(--bg-elevated)', marginBottom: 12,
            fontSize: 12, color: 'var(--text-secondary)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span>{side === 'buy' ? `Est. ${symbol}` : 'Est. BNB out'}</span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }} data-testid="text-est-out">
                {estOut !== null ? estOut.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'} {side === 'buy' ? symbol : 'BNB'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span>Slippage</span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }} data-testid="text-slippage">{slippagePct}%</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              Routed via {venueLabel}.
              {info.venue === 'pancakeV2' && side === 'sell' ? ' One-time approval may be required.' : ''}
            </div>
            {quoteErr && (
              <div style={{ color: 'var(--red)', marginTop: 6 }} data-testid="text-quote-error">
                {quoteErr.slice(0, 100)}
              </div>
            )}
          </div>

          {/* Advanced (slippage) */}
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            data-testid="button-advanced"
            style={{
              width: '100%', padding: '8px 12px',
              background: 'transparent', border: 'none',
              color: 'var(--text-secondary)', fontSize: 11,
              cursor: 'pointer', textAlign: 'left',
              marginBottom: showAdvanced ? 8 : 12,
            }}
          >{showAdvanced ? '▼' : '▶'} Advanced settings</button>
          {showAdvanced && (
            <div style={{
              padding: '12px 14px', borderRadius: 10,
              background: 'var(--bg-elevated)', marginBottom: 12,
            }}>
              <label style={{
                fontSize: 12, color: 'var(--text-secondary)',
                display: 'block', marginBottom: 6,
              }}>Slippage tolerance</label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {['0.5', '1', '3', '5'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setSlippagePct(p)}
                    data-testid={`button-slippage-${p}`}
                    style={{
                      flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 600,
                      borderRadius: 6,
                      border: slippagePct === p ? '1px solid var(--purple)' : '1px solid var(--border)',
                      background: slippagePct === p ? 'rgba(124,58,237,0.12)' : 'var(--bg-card)',
                      color: slippagePct === p ? 'var(--purple)' : 'var(--text-primary)',
                      cursor: 'pointer',
                    }}
                  >{p}%</button>
                ))}
              </div>
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min="0.1"
                max="20"
                placeholder="Custom %"
                value={slippagePct}
                onChange={(e) => setSlippagePct(e.target.value)}
                data-testid="input-slippage"
                style={{
                  width: '100%', padding: '10px 12px', fontSize: 13,
                  borderRadius: 8, border: '1px solid var(--border)',
                  background: 'var(--bg-card)', color: 'var(--text-primary)',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                Higher = more likely to fill on volatile tokens. Range 0.1–20%.
              </div>
            </div>
          )}

          {/* Action */}
          {success ? (
            <div style={{
              padding: 12, borderRadius: 10,
              background: 'rgba(16,185,129,0.12)',
              border: '1px solid var(--green)',
            }} data-testid="card-trade-success">
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>
                ✅ Trade confirmed
              </div>
              <a
                href={`https://bscscan.com/tx/${success.txHash}`}
                target="_blank"
                rel="noreferrer"
                data-testid="link-tx"
                style={{
                  display: 'block', marginTop: 6, fontSize: 11,
                  color: 'var(--text-secondary)', wordBreak: 'break-all',
                }}
              >View on BscScan ↗</a>
            </div>
          ) : (
            <>
              {submitErr && (
                <div style={{
                  padding: 10, borderRadius: 8, marginBottom: 10,
                  background: 'rgba(239,68,68,0.1)', color: 'var(--red)',
                  fontSize: 12,
                }} data-testid="text-submit-error">{submitErr}</div>
              )}
              <button
                type="button"
                onClick={() => void submit()}
                disabled={submitting || !amount}
                data-testid="button-submit"
                style={{
                  width: '100%', padding: '14px 0', fontSize: 15, fontWeight: 700,
                  borderRadius: 10, border: 'none',
                  background: side === 'buy' ? 'var(--green)' : 'var(--red)',
                  color: '#fff', cursor: submitting || !amount ? 'not-allowed' : 'pointer',
                  opacity: submitting || !amount ? 0.6 : 1,
                }}
              >{submitting ? 'Submitting…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`}</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

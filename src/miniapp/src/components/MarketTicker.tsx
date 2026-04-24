import { useEffect, useState } from 'react'
import { toBinanceSymbol } from './TradingChart'

interface Stats {
  lastPrice: number
  priceChangePercent: number
  highPrice: number
  lowPrice: number
  volume: number
  quoteVolume: number
}

interface Props {
  symbol: string         // venue-native (Aster "BTCUSDT" or HL "BTC")
  testIdPrefix?: string
  pollMs?: number
}

// ─── Shared poll cache ───────────────────────────────────────────────────
// All MarketTicker instances watching the same Binance symbol share a
// single poll loop. Without this, an AgentStudio with N agents would do
// N × (1/pollMs) requests/sec to Binance even when many agents watch the
// same coin. With the cache: 1 poll per unique symbol, regardless of how
// many tickers are mounted.
//
// Each entry runs at the FASTEST pollMs requested by any of its listeners.
// When the last listener for a symbol unmounts the timer is cleared.

interface Entry {
  symbol: string
  data: Stats | null
  err: boolean
  intervalMs: number
  timer: ReturnType<typeof setInterval> | null
  listeners: Set<(data: Stats | null, err: boolean) => void>
}

const REGISTRY = new Map<string, Entry>()

function notify(e: Entry) {
  for (const fn of e.listeners) fn(e.data, e.err)
}

async function fetchOnce(e: Entry) {
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${e.symbol}`)
    if (!r.ok) throw new Error(String(r.status))
    const j = await r.json()
    e.data = {
      lastPrice:          Number(j.lastPrice),
      priceChangePercent: Number(j.priceChangePercent),
      highPrice:          Number(j.highPrice),
      lowPrice:           Number(j.lowPrice),
      volume:             Number(j.volume),
      quoteVolume:        Number(j.quoteVolume),
    }
    e.err = false
  } catch {
    e.err = true
  }
  notify(e)
}

function ensureTimer(e: Entry) {
  // (Re)start timer at the current intervalMs. Called after subscribe/
  // unsubscribe in case the fastest-requested interval changed.
  if (e.timer) clearInterval(e.timer)
  e.timer = setInterval(() => fetchOnce(e), e.intervalMs)
}

function recomputeInterval(e: Entry, requestedMs: number) {
  // Pick the smallest interval requested by any listener so we honour the
  // most "live" request without making slow listeners pay extra overhead.
  if (requestedMs < e.intervalMs) {
    e.intervalMs = requestedMs
    ensureTimer(e)
  }
}

function subscribe(symbol: string, pollMs: number, cb: (d: Stats | null, err: boolean) => void) {
  let e = REGISTRY.get(symbol)
  if (!e) {
    e = { symbol, data: null, err: false, intervalMs: pollMs, timer: null, listeners: new Set() }
    REGISTRY.set(symbol, e)
    fetchOnce(e)            // immediate first hit
    ensureTimer(e)
  } else {
    recomputeInterval(e, pollMs)
    // serve cached data right away to the new listener
    cb(e.data, e.err)
  }
  e.listeners.add(cb)
  return () => {
    const ent = REGISTRY.get(symbol)
    if (!ent) return
    ent.listeners.delete(cb)
    if (ent.listeners.size === 0) {
      if (ent.timer) clearInterval(ent.timer)
      REGISTRY.delete(symbol)
    }
  }
}

// ─── Formatters ──────────────────────────────────────────────────────────
function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  const max = n < 1 ? 5 : n < 100 ? 4 : 2
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: max })}`
}

function fmtVol(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(0)}`
}

// ─── Component ───────────────────────────────────────────────────────────
// 24h ticker pulled from Binance's public futures API. CORS-open, no auth.
// Aster mirrors Binance perp pairs 1:1; HL major coins track Binance
// within a few bps. For HL coins not listed on Binance perps (e.g. HYPE)
// the fetch returns 4xx and we surface a small "ticker offline" banner —
// not a hard failure.
export function MarketTicker({ symbol, testIdPrefix = 'ticker', pollMs = 5000 }: Props) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [err, setErr] = useState(false)
  const binSymbol = toBinanceSymbol(symbol)

  useEffect(() => {
    setStats(null)
    setErr(false)
    const unsub = subscribe(binSymbol, pollMs, (d, e) => {
      setStats(d)
      setErr(e)
    })
    return unsub
  }, [binSymbol, pollMs])

  const chgPositive = (stats?.priceChangePercent ?? 0) >= 0
  const chgColor = chgPositive ? '#10b981' : '#ef4444'

  return (
    <div
      data-testid={`${testIdPrefix}-container`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 1,
        background: '#2a2a3e',
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid #2a2a3e',
        marginBottom: 10,
      }}
    >
      <Cell label="Last" value={fmtPrice(stats?.lastPrice ?? 0)} color="#e2e8f0" testId={`${testIdPrefix}-last`} mono />
      <Cell
        label="24h %"
        value={stats ? `${chgPositive ? '+' : ''}${stats.priceChangePercent.toFixed(2)}%` : '—'}
        color={chgColor}
        testId={`${testIdPrefix}-change`}
        mono
      />
      <Cell label="24h H" value={fmtPrice(stats?.highPrice ?? 0)} color="#cbd5e1" testId={`${testIdPrefix}-high`} mono />
      <Cell label="24h L" value={fmtPrice(stats?.lowPrice ?? 0)} color="#cbd5e1" testId={`${testIdPrefix}-low`} mono />
      <Cell label="24h Vol" value={fmtVol(stats?.quoteVolume ?? 0)} color="#cbd5e1" testId={`${testIdPrefix}-vol`} mono />
      {err && (
        <div style={{
          gridColumn: '1 / -1', padding: '4px 8px', background: '#1f2937',
          fontSize: 10, color: '#fbbf24', textAlign: 'center',
        }}>
          ticker unavailable for {binSymbol}
        </div>
      )}
    </div>
  )
}

function Cell({ label, value, color, testId, mono }: {
  label: string; value: string; color: string; testId: string; mono?: boolean
}) {
  return (
    <div style={{ background: '#0f1117', padding: '8px 6px', textAlign: 'center', minWidth: 0 }}>
      <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 0.4, textTransform: 'uppercase', fontWeight: 600 }}>
        {label}
      </div>
      <div
        data-testid={testId}
        style={{
          fontSize: 12,
          fontWeight: 700,
          color,
          fontFamily: mono ? 'ui-monospace, "SF Mono", Menlo, monospace' : 'inherit',
          marginTop: 2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
    </div>
  )
}

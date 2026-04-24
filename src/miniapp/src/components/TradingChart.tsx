import { useState } from 'react'

// Convert a venue-native symbol into the canonical Binance perp symbol
// that drives both the TradingView chart embed and the 24h ticker fetch.
//
//   "BTCUSDT"      → "BTCUSDT"      (Aster, already correct)
//   "BTC"          → "BTCUSDT"      (Hyperliquid coin code)
//   "BTC-USD"      → "BTCUSDT"      (defensive, in case of HL spot-style codes)
//   "1000PEPEUSDT" → "1000PEPEUSDT" (digits preserved — Binance uses 1000-prefixed
//                                    symbols for low-priced memecoins)
//   "1INCH"        → "1INCHUSDT"
//
// We use Binance perp data because (a) it's free + CORS-open, and
// (b) Aster and HL both track Binance closely on the majors, so chart
// shape + 24h stats are an honest reflection of what the user is trading.
//
// Note: digits MUST be preserved — stripping them would break common
// numeric-prefixed perp symbols (1000PEPE, 1000SHIB, 1INCH, …).
export function toBinanceSymbol(input: string): string {
  const s = (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!s) return 'BTCUSDT'
  if (s.endsWith('USDT')) return s
  if (s.endsWith('USDC')) return s.replace(/USDC$/, 'USDT')
  if (s.endsWith('USD')) return s + 'T'
  return s + 'USDT'
}

export function toTvSymbol(input: string): string {
  return `BINANCE:${toBinanceSymbol(input)}`
}

const INTERVALS: Array<{ label: string; value: string }> = [
  { label: '1m',  value: '1' },
  { label: '5m',  value: '5' },
  { label: '15m', value: '15' },
  { label: '1h',  value: '60' },
  { label: '4h',  value: '240' },
  { label: '1D',  value: 'D' },
]

interface Props {
  symbol: string          // venue-native (e.g. "BTCUSDT" or "BTC")
  defaultInterval?: string
  height?: number
  testIdPrefix?: string
}

// TradingView Advanced Chart, embedded as an iframe. Chosen over the
// JS widget for two reasons: (a) zero runtime script-load (works inside
// Telegram WebView even with strict caches) and (b) we don't pay React
// re-render cost when the symbol changes — the iframe just navigates.
export function TradingChart({
  symbol,
  defaultInterval = '15',
  height = 320,
  testIdPrefix = 'chart',
}: Props) {
  const [interval, setInterval] = useState(defaultInterval)
  const tv = toTvSymbol(symbol)
  const src =
    `https://s.tradingview.com/widgetembed/` +
    `?symbol=${encodeURIComponent(tv)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&theme=dark&style=1&locale=en` +
    `&toolbarbg=131722` +
    `&hidesidetoolbar=1&hidelegend=0&saveimage=0&hideideas=1` +
    `&withdateranges=0&studies=`

  return (
    <div
      data-testid={`${testIdPrefix}-container`}
      style={{
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid #2a2a3e',
        background: '#131722',
        marginBottom: 10,
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 10px',
        background: '#0f1117',
        borderBottom: '1px solid #2a2a3e',
        gap: 6,
        overflowX: 'auto',
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', whiteSpace: 'nowrap' }}>
          {tv.replace('BINANCE:', '')}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {INTERVALS.map(iv => (
            <button
              key={iv.value}
              onClick={() => setInterval(iv.value)}
              data-testid={`${testIdPrefix}-interval-${iv.value}`}
              style={{
                padding: '4px 8px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                background: interval === iv.value ? '#7c3aed' : 'transparent',
                color: interval === iv.value ? '#fff' : '#9ca3af',
              }}
            >
              {iv.label}
            </button>
          ))}
        </div>
      </div>
      <iframe
        key={`${tv}-${interval}`}
        src={src}
        title={`Chart ${tv}`}
        data-testid={`${testIdPrefix}-iframe`}
        style={{ width: '100%', height, border: 'none', display: 'block' }}
        allowFullScreen
      />
    </div>
  )
}

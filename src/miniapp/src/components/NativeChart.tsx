import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import { apiFetch } from '../api'

// Native candle chart that pulls OHLC straight from the venue the user is
// trading on (Aster /fapi/v1/klines or Hyperliquid candleSnapshot via the
// backend proxy at /api/{aster,hl}/candles).
//
// We replaced the previous TradingView/Binance iframe because the chart
// candles disagreed with the mark price shown in the order entry — Aster
// can drift from Binance on majors during fast moves and disagrees
// significantly on Aster-only or HL-only listings. This component sources
// candles from the same venue the trade lands on, so what you see is what
// you trade against.

type Venue = 'aster' | 'hl'

interface Candle {
  time:   number   // unix seconds
  open:   number
  high:   number
  low:    number
  close:  number
  volume: number
}

interface Props {
  venue:           Venue
  symbol:          string                // venue-native: "BTCUSDT" for Aster, "BTC" for HL
  defaultInterval?: '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
  height?:         number
  testIdPrefix?:   string
}

const INTERVALS: Array<{ label: string; value: Props['defaultInterval'] }> = [
  { label: '1m',  value: '1m' },
  { label: '5m',  value: '5m' },
  { label: '15m', value: '15m' },
  { label: '1h',  value: '1h' },
  { label: '4h',  value: '4h' },
  { label: '1D',  value: '1d' },
]

// How often we re-poll the venue for fresh candles. We poll every 1.5s on
// every timeframe so the live (right-most) candle visibly ticks as price
// moves, matching what serious perp terminals do. The cost is a re-fetch
// of ~200 candles per second, which both venues can serve cheaply (Aster
// has a server-side cache, HL's candleSnapshot is light).
function pollMsForInterval(_intv: string): number {
  return 1_500
}

function buildCandlesUrl(venue: Venue, symbol: string, interval: string, limit = 200): string {
  if (venue === 'aster') {
    const sym = (symbol || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '')
    return `/api/aster/candles?symbol=${sym}&interval=${interval}&limit=${limit}`
  }
  const coin = (symbol || 'BTC').toUpperCase().replace(/USDT?$/, '').replace(/[^A-Z0-9]/g, '')
  return `/api/hl/candles?coin=${coin}&interval=${interval}&limit=${limit}`
}

export function NativeChart({
  venue,
  symbol,
  defaultInterval = '15m',
  height = 320,
  testIdPrefix = 'chart',
}: Props) {
  const [interval, setIntervalState] = useState<NonNullable<Props['defaultInterval']>>(defaultInterval)
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')

  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef     = useRef<IChartApi | null>(null)
  const candleRef    = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef    = useRef<ISeriesApi<'Histogram'> | null>(null)

  // ── Build the chart once, keep refs, tear down on unmount ────────────
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor:  '#9ca3af',
        fontSize:   11,
      },
      grid: {
        vertLines: { color: '#1f2937' },
        horzLines: { color: '#1f2937' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2a3e' },
      timeScale: {
        borderColor: '#2a2a3e',
        timeVisible: true,
        secondsVisible: false,
      },
    })
    const candleSeries = chart.addCandlestickSeries({
      upColor:        '#22c55e',
      downColor:      '#ef4444',
      borderUpColor:  '#22c55e',
      borderDownColor:'#ef4444',
      wickUpColor:    '#22c55e',
      wickDownColor:  '#ef4444',
    })
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',  // overlay
      color: '#374151',
    })
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    })

    chartRef.current  = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries

    return () => {
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
  // We deliberately do NOT depend on `height` — the chart auto-sizes off
  // its container, so re-rendering with a new height just re-styles the
  // wrapper div without disposing the chart.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Fetch + poll candles whenever symbol/interval/venue change ───────
  useEffect(() => {
    let cancelled = false
    let pollHandle: ReturnType<typeof setTimeout> | null = null

    async function load(initial: boolean) {
      if (cancelled) return
      try {
        if (initial) setStatus('loading')
        const url = buildCandlesUrl(venue, symbol, interval, 200)
        const rows = await apiFetch<Candle[]>(url)
        if (cancelled) return

        if (!rows || rows.length === 0) {
          // Wipe stale series so a switch to an empty symbol doesn't keep
          // showing the previous coin's candles.
          candleRef.current?.setData([])
          volumeRef.current?.setData([])
          setStatus('empty')
        } else {
          candleRef.current?.setData(rows.map(r => ({
            time:  r.time as Time,
            open:  r.open,
            high:  r.high,
            low:   r.low,
            close: r.close,
          })))
          volumeRef.current?.setData(rows.map(r => ({
            time:  r.time as Time,
            value: r.volume,
            color: r.close >= r.open ? '#16a34a55' : '#dc262655',
          })))
          if (initial) chartRef.current?.timeScale().fitContent()
          setStatus('ready')
        }
      } catch (err) {
        if (!cancelled) setStatus('error')
      } finally {
        if (!cancelled) {
          pollHandle = setTimeout(() => load(false), pollMsForInterval(interval))
        }
      }
    }

    load(true)
    return () => {
      cancelled = true
      if (pollHandle) clearTimeout(pollHandle)
    }
  }, [venue, symbol, interval])

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
        padding: '6px 10px',
        background: '#0f172a',
        borderBottom: '1px solid #1f2937',
      }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#9ca3af', marginRight: 6 }} data-testid={`${testIdPrefix}-source`}>
            {venue === 'aster' ? 'Aster' : 'Hyperliquid'} · {symbol}
          </span>
          {INTERVALS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setIntervalState(opt.value!)}
              data-testid={`${testIdPrefix}-interval-${opt.value}`}
              style={{
                padding: '3px 8px',
                fontSize: 10,
                fontWeight: 600,
                borderRadius: 5,
                border: 'none',
                cursor: 'pointer',
                background: interval === opt.value ? '#8b5cf6' : 'transparent',
                color: interval === opt.value ? '#fff' : '#9ca3af',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 10, color: '#475569' }} data-testid={`${testIdPrefix}-status`}>
          {status === 'loading' ? 'Loading…'
            : status === 'error' ? 'Could not load candles'
            : status === 'empty' ? 'No candles'
            : 'Live'}
        </span>
      </div>
      <div
        ref={containerRef}
        style={{ width: '100%', height }}
        data-testid={`${testIdPrefix}-canvas`}
      />
    </div>
  )
}

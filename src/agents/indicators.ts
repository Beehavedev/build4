export interface OHLCV {
  open: number[]
  high: number[]
  low: number[]
  close: number[]
  volume: number[]
  timestamps: number[]
}

export function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0
  const k = 2 / (period + 1)
  let ema = prices[0]
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k)
  }
  return ema
}

export function calculateSMA(prices: number[], period: number): number {
  const slice = prices.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50
  let gains = 0
  let losses = 0
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1]
    if (change > 0) gains += change
    else losses += Math.abs(change)
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

export interface MACDResult {
  macdLine: number
  signalLine: number
  histogram: number
  recentCross: string | null
}

export function calculateMACD(
  prices: number[],
  fast: number = 12,
  slow: number = 26,
  signal: number = 9
): MACDResult {
  if (prices.length < slow + signal) {
    return { macdLine: 0, signalLine: 0, histogram: 0, recentCross: null }
  }

  const recentMacd: number[] = []
  for (let i = slow; i <= prices.length; i++) {
    const slice = prices.slice(0, i)
    const m = calculateEMA(slice, fast) - calculateEMA(slice, slow)
    recentMacd.push(m)
  }

  const macdLine = recentMacd[recentMacd.length - 1]
  const signalLine = calculateEMA(recentMacd, signal)
  const histogram = macdLine - signalLine

  const prevSlice = prices.slice(0, prices.length - 1)
  const prevMacd = calculateEMA(prevSlice, fast) - calculateEMA(prevSlice, slow)
  const prevHistogram = prevMacd - signalLine

  let recentCross: string | null = null
  if (prevHistogram <= 0 && histogram > 0) recentCross = 'BULLISH CROSS'
  if (prevHistogram >= 0 && histogram < 0) recentCross = 'BEARISH CROSS'

  return { macdLine, signalLine, histogram, recentCross }
}

export interface BollingerBands {
  upper: number
  mid: number
  lower: number
}

export function calculateBollingerBands(
  prices: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): BollingerBands {
  const slice = prices.slice(-period)
  const mid = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((a, b) => a + Math.pow(b - mid, 2), 0) / period
  const std = Math.sqrt(variance)
  return {
    upper: mid + stdDevMultiplier * std,
    mid,
    lower: mid - stdDevMultiplier * std
  }
}

export function calculateATR(ohlcv: OHLCV, period: number = 14): number {
  const trs: number[] = []
  for (let i = 1; i < ohlcv.high.length; i++) {
    const tr = Math.max(
      ohlcv.high[i] - ohlcv.low[i],
      Math.abs(ohlcv.high[i] - ohlcv.close[i - 1]),
      Math.abs(ohlcv.low[i] - ohlcv.close[i - 1])
    )
    trs.push(tr)
  }
  if (trs.length === 0) return 0
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length)
}

export function calculateADX(ohlcv: OHLCV, period: number = 14): number {
  if (ohlcv.high.length < period + 1) return 15
  const atrs: number[] = []
  const plusDMs: number[] = []
  const minusDMs: number[] = []

  for (let i = 1; i < ohlcv.high.length; i++) {
    const upMove = ohlcv.high[i] - ohlcv.high[i - 1]
    const downMove = ohlcv.low[i - 1] - ohlcv.low[i]
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0)
    atrs.push(
      Math.max(
        ohlcv.high[i] - ohlcv.low[i],
        Math.abs(ohlcv.high[i] - ohlcv.close[i - 1]),
        Math.abs(ohlcv.low[i] - ohlcv.close[i - 1])
      )
    )
  }

  const avg = (arr: number[]) =>
    arr.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, arr.length)

  const atr = avg(atrs)
  if (atr === 0) return 15
  const plusDI = (avg(plusDMs) / atr) * 100
  const minusDI = (avg(minusDMs) / atr) * 100
  if (plusDI + minusDI === 0) return 15
  return (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100
}

export function findRecentSwingHigh(ohlcv: OHLCV, lookback: number = 20): number {
  return Math.max(...ohlcv.high.slice(-lookback))
}

export function findRecentSwingLow(ohlcv: OHLCV, lookback: number = 20): number {
  return Math.min(...ohlcv.low.slice(-lookback))
}

export function calculateTrendAlignment(
  ema9: number,
  ema21: number,
  ema50: number,
  ema200: number,
  price: number
): number {
  let score = 0
  if (ema9 > ema21) score++
  if (price > ema50) score++
  if (price > ema200) score++
  if (ema21 > ema50) score++
  if (ema50 > ema200) score++
  return score
}

export function formatRecentCandles(ohlcv: OHLCV, count: number = 5): string {
  const len = ohlcv.close.length
  const lines: string[] = []
  for (let i = Math.max(0, len - count); i < len; i++) {
    const bullish = ohlcv.close[i] > ohlcv.open[i]
    const change = (((ohlcv.close[i] - ohlcv.open[i]) / ohlcv.open[i]) * 100).toFixed(2)
    lines.push(
      `  ${bullish ? '🟢' : '🔴'} O:${ohlcv.open[i].toFixed(2)} H:${ohlcv.high[i].toFixed(2)} L:${ohlcv.low[i].toFixed(2)} C:${ohlcv.close[i].toFixed(2)} (${change}%) Vol:${(ohlcv.volume[i] / 1000).toFixed(0)}k`
    )
  }
  return lines.join('\n')
}

export function buildAlignmentBar(alignment: {
  '4h': string
  '1h': string
  '15m': string
  volume: string
}): string {
  const icon = (v: string) =>
    v === 'BULLISH' ? '🟢' : v === 'BEARISH' ? '🔴' : '⚪'
  const volIcon =
    alignment.volume === 'CONFIRMING'
      ? '✅'
      : alignment.volume === 'DIVERGING'
      ? '⚠️'
      : '⚪'
  return `4h ${icon(alignment['4h'])} │ 1h ${icon(alignment['1h'])} │ 15m ${icon(alignment['15m'])} │ Vol ${volIcon}`
}

// Generate realistic mock OHLCV data for testing without exchange API
export function generateMockOHLCV(
  basePrice: number,
  candles: number = 200,
  volatility: number = 0.002
): OHLCV {
  const result: OHLCV = {
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
    timestamps: []
  }

  let price = basePrice
  const now = Date.now()

  for (let i = candles; i >= 0; i--) {
    const drift = (Math.random() - 0.48) * volatility
    const open = price
    const change = price * drift
    const close = price + change
    const high = Math.max(open, close) * (1 + Math.random() * volatility)
    const low = Math.min(open, close) * (1 - Math.random() * volatility)
    const volume = basePrice * 100 + Math.random() * basePrice * 50

    result.open.push(open)
    result.high.push(high)
    result.low.push(low)
    result.close.push(close)
    result.volume.push(volume)
    result.timestamps.push(now - i * 15 * 60 * 1000)

    price = close
  }

  return result
}

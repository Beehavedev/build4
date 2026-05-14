export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp?: number;
}

function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (period + 1);
  let prev = data[0];
  result.push(prev);
  for (let i = 1; i < data.length; i++) {
    const val = (data[i] - prev) * multiplier + prev;
    result.push(val);
    prev = val;
  }
  return result;
}

function rsi(closes: number[], period: number = 14): number[] {
  const result: number[] = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) result[period] = 100;
  else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) result[i] = 100;
    else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }
  return result;
}

function macd(closes: number[]): { macdLine: number; signalLine: number; histogram: number } {
  if (closes.length < 26) return { macdLine: 0, signalLine: 0, histogram: 0 };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdArr: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdArr.push(ema12[i] - ema26[i]);
  }
  const signal = ema(macdArr, 9);
  const lastIdx = closes.length - 1;
  return {
    macdLine: macdArr[lastIdx],
    signalLine: signal[lastIdx],
    histogram: macdArr[lastIdx] - signal[lastIdx],
  };
}

function bollingerBands(closes: number[], period: number = 20, mult: number = 2): { upper: number; middle: number; lower: number; width: number; percentB: number } {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, width: 0, percentB: 0.5 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = mean + mult * stdDev;
  const lower = mean - mult * stdDev;
  const lastClose = closes[closes.length - 1];
  const width = upper - lower;
  const percentB = width > 0 ? (lastClose - lower) / width : 0.5;
  return { upper, middle: mean, lower, width, percentB };
}

function atr(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let avg = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    avg = (avg * (period - 1) + trueRanges[i]) / period;
  }
  return avg;
}

function volumeSpike(candles: Candle[], lookback: number = 20): number {
  if (candles.length < lookback + 1) return 1;
  const vols = candles.slice(-lookback - 1, -1).map(c => c.volume);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  if (avgVol <= 0) return 1;
  return candles[candles.length - 1].volume / avgVol;
}

function adx(candles: Candle[], period: number = 14): { adxValue: number; plusDI: number; minusDI: number } {
  if (candles.length < period * 2 + 1) return { adxValue: 0, plusDI: 50, minusDI: 50 };

  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let smoothPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothTR = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues: number[] = [];

  for (let i = period; i < plusDMs.length; i++) {
    if (i > period) {
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[i];
      smoothTR = smoothTR - smoothTR / period + trueRanges[i];
    }

    const pdi = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const mdi = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = pdi + mdi;
    const dx = diSum > 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return { adxValue: 0, plusDI: 50, minusDI: 50 };

  let adxVal = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adxVal = (adxVal * (period - 1) + dxValues[i]) / period;
  }

  const lastPDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 50;
  const lastMDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 50;

  return { adxValue: adxVal, plusDI: lastPDI, minusDI: lastMDI };
}

function detectChoppiness(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 50;
  const slice = candles.slice(-period - 1);
  const trueRanges: number[] = [];
  let highestHigh = -Infinity;
  let lowestLow = Infinity;
  for (let i = 1; i < slice.length; i++) {
    const h = slice[i].high;
    const l = slice[i].low;
    const pc = slice[i - 1].close;
    trueRanges.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    if (h > highestHigh) highestHigh = h;
    if (l < lowestLow) lowestLow = l;
  }
  const atrSum = trueRanges.reduce((a, b) => a + b, 0);
  const range = highestHigh - lowestLow;
  if (range <= 0) return 100;
  return (Math.log10(atrSum / range) / Math.log10(period)) * 100;
}

export type MarketRegime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "VOLATILE";

export interface RegimeInfo {
  regime: MarketRegime;
  adxValue: number;
  plusDI: number;
  minusDI: number;
  choppiness: number;
  trendStrength: number;
  atrPct: number;
}

export function detectMarketRegime(candles: Candle[]): RegimeInfo {
  const adxResult = adx(candles);
  const chop = detectChoppiness(candles);
  const atrVal = atr(candles);
  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 1;
  const atrPct = (atrVal / lastClose) * 100;

  let regime: MarketRegime;
  let trendStrength = 0;

  if (adxResult.adxValue >= 25 && chop < 50) {
    if (adxResult.plusDI > adxResult.minusDI) {
      regime = "TRENDING_UP";
      trendStrength = Math.min(100, adxResult.adxValue * 1.5);
    } else {
      regime = "TRENDING_DOWN";
      trendStrength = Math.min(100, adxResult.adxValue * 1.5);
    }
  } else if (atrPct > 3.0 || (adxResult.adxValue < 20 && chop > 60 && atrPct > 1.5)) {
    regime = "VOLATILE";
    trendStrength = 0;
  } else {
    regime = "RANGING";
    trendStrength = 0;
  }

  return {
    regime,
    adxValue: adxResult.adxValue,
    plusDI: adxResult.plusDI,
    minusDI: adxResult.minusDI,
    choppiness: chop,
    trendStrength,
    atrPct,
  };
}

export type Signal = "BUY" | "SELL" | "HOLD";

export interface StrategyResult {
  signal: Signal;
  reason: string;
  ema8: number;
  ema21: number;
  rsiValue: number;
  lastClose: number;
  strength: number;
  macdHistogram: number;
  bollingerPercentB: number;
  atrValue: number;
  volumeRatio: number;
  alignedIndicators: number;
  regime: RegimeInfo;
  dynamicSL: number;
  dynamicTP: number;
}

export interface KeyLevel {
  price: number;
  type: "support" | "resistance";
  strength: number;
  touches: number;
}

export function findKeyLevels(candles: Candle[], proximity: number = 0.003): KeyLevel[] {
  if (candles.length < 20) return [];

  const pivots: { price: number; type: "high" | "low" }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high) {
      pivots.push({ price: c.high, type: "high" });
    }
    if (c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low) {
      pivots.push({ price: c.low, type: "low" });
    }
  }

  const clusters: KeyLevel[] = [];
  for (const p of pivots) {
    let merged = false;
    for (const cl of clusters) {
      if (Math.abs(p.price - cl.price) / cl.price < proximity) {
        cl.price = (cl.price * cl.touches + p.price) / (cl.touches + 1);
        cl.touches++;
        cl.strength = Math.min(10, cl.touches * 2);
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({
        price: p.price,
        type: p.type === "high" ? "resistance" : "support",
        strength: 2,
        touches: 1,
      });
    }
  }

  return clusters.filter(c => c.touches >= 2).sort((a, b) => b.strength - a.strength).slice(0, 8);
}

export interface TimeframeAnalysis {
  timeframe: string;
  ema8: number;
  ema21: number;
  ema50: number;
  rsi: number;
  macdHistogram: number;
  bbPercentB: number;
  atrValue: number;
  atrPct: number;
  volumeRatio: number;
  lastClose: number;
  regime: RegimeInfo;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  keyLevels: KeyLevel[];
}

export function analyzeTimeframe(candles: Candle[], tfLabel: string): TimeframeAnalysis {
  const closes = candles.map(c => c.close);
  const lastClose = closes.length > 0 ? closes[closes.length - 1] : 0;
  const regime = detectMarketRegime(candles);

  if (candles.length < 26) {
    return {
      timeframe: tfLabel, ema8: lastClose, ema21: lastClose, ema50: lastClose,
      rsi: 50, macdHistogram: 0, bbPercentB: 0.5, atrValue: 0, atrPct: 0,
      volumeRatio: 1, lastClose, regime, trend: "NEUTRAL", keyLevels: [],
    };
  }

  const ema8Arr = ema(closes, 8);
  const ema21Arr = ema(closes, 21);
  const ema50Arr = closes.length >= 50 ? ema(closes, 50) : ema(closes, 21);
  const rsiValues = rsi(closes, 14);
  const macdResult = macd(closes);
  const bbResult = bollingerBands(closes);
  const atrVal = atr(candles);
  const volRatio = volumeSpike(candles);
  const keyLevels = findKeyLevels(candles);

  const lastIdx = closes.length - 1;
  const e8 = ema8Arr[lastIdx];
  const e21 = ema21Arr[lastIdx];
  const e50 = ema50Arr[lastIdx];
  const r = rsiValues[lastIdx];

  let trend: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (e8 > e21 && e21 > e50 && r > 45) trend = "BULLISH";
  else if (e8 < e21 && e21 < e50 && r < 55) trend = "BEARISH";

  return {
    timeframe: tfLabel,
    ema8: e8,
    ema21: e21,
    ema50: e50,
    rsi: r,
    macdHistogram: macdResult.histogram,
    bbPercentB: bbResult.percentB,
    atrValue: atrVal,
    atrPct: lastClose > 0 ? (atrVal / lastClose) * 100 : 0,
    volumeRatio: volRatio,
    lastClose,
    regime,
    trend,
    keyLevels,
  };
}

export interface MarketSnapshot {
  symbol: string;
  price: number;
  tf5m: TimeframeAnalysis;
  tf15m: TimeframeAnalysis;
  tf1h: TimeframeAnalysis;
  overallTrend: "BULLISH" | "BEARISH" | "MIXED" | "NEUTRAL";
  overallRegime: MarketRegime;
  nearestSupport: number | null;
  nearestResistance: number | null;
  distToSupportPct: number | null;
  distToResistancePct: number | null;
}

export function buildMarketSnapshot(
  symbol: string,
  candles5m: Candle[],
  candles15m: Candle[],
  candles1h: Candle[],
): MarketSnapshot {
  const tf5m = analyzeTimeframe(candles5m, "5m");
  const tf15m = analyzeTimeframe(candles15m, "15m");
  const tf1h = analyzeTimeframe(candles1h, "1h");
  const price = tf5m.lastClose;

  const trends = [tf5m.trend, tf15m.trend, tf1h.trend];
  const bullCount = trends.filter(t => t === "BULLISH").length;
  const bearCount = trends.filter(t => t === "BEARISH").length;
  let overallTrend: "BULLISH" | "BEARISH" | "MIXED" | "NEUTRAL" = "NEUTRAL";
  if (bullCount >= 2 && bearCount === 0) overallTrend = "BULLISH";
  else if (bearCount >= 2 && bullCount === 0) overallTrend = "BEARISH";
  else if (bullCount > 0 && bearCount > 0) overallTrend = "MIXED";

  const allLevels = [...tf15m.keyLevels, ...tf1h.keyLevels];
  const supports = allLevels.filter(l => l.type === "support" && l.price < price).sort((a, b) => b.price - a.price);
  const resistances = allLevels.filter(l => l.type === "resistance" && l.price > price).sort((a, b) => a.price - b.price);

  const nearestSupport = supports.length > 0 ? supports[0].price : null;
  const nearestResistance = resistances.length > 0 ? resistances[0].price : null;

  return {
    symbol,
    price,
    tf5m,
    tf15m,
    tf1h,
    overallTrend,
    overallRegime: tf15m.regime.regime,
    nearestSupport,
    nearestResistance,
    distToSupportPct: nearestSupport ? ((price - nearestSupport) / price) * 100 : null,
    distToResistancePct: nearestResistance ? ((nearestResistance - price) / price) * 100 : null,
  };
}

export function emaCrossRsiStrategy(candles: Candle[]): StrategyResult {
  const regime = detectMarketRegime(candles);
  const empty: StrategyResult = { signal: "HOLD", reason: "Not enough data", ema8: 0, ema21: 0, rsiValue: 50, lastClose: 0, strength: 0, macdHistogram: 0, bollingerPercentB: 0.5, atrValue: 0, volumeRatio: 1, alignedIndicators: 0, regime, dynamicSL: 3, dynamicTP: 5 };
  if (candles.length < 26) return empty;

  const closes = candles.map(c => c.close);
  const ema8Arr = ema(closes, 8);
  const ema21Arr = ema(closes, 21);
  const rsiValues = rsi(closes, 14);
  const macdResult = macd(closes);
  const bbResult = bollingerBands(closes);
  const atrVal = atr(candles);
  const volRatio = volumeSpike(candles);

  const lastIdx = closes.length - 1;
  const e8 = ema8Arr[lastIdx];
  const e21 = ema21Arr[lastIdx];
  const r = rsiValues[lastIdx];
  const lastClose = closes[lastIdx];

  const atrPct = lastClose > 0 ? (atrVal / lastClose) * 100 : 1;
  const dynamicSL = Math.max(1.0, Math.min(8.0, atrPct * 2.0));
  const dynamicTP = Math.max(2.0, Math.min(15.0, atrPct * 3.0));

  if (regime.regime === "RANGING") {
    return {
      signal: "HOLD",
      reason: `RANGING market (ADX ${regime.adxValue.toFixed(1)}, Chop ${regime.choppiness.toFixed(0)}) — avoiding false signals`,
      ema8: e8, ema21: e21, rsiValue: r, lastClose,
      strength: 0, macdHistogram: macdResult.histogram,
      bollingerPercentB: bbResult.percentB, atrValue: atrVal,
      volumeRatio: volRatio, alignedIndicators: 0,
      regime, dynamicSL, dynamicTP,
    };
  }

  let signal: Signal = "HOLD";
  let reason = "";
  let strength = 0;
  let aligned = 0;

  const emaDiff = Math.abs(e8 - e21) / e21 * 100;
  const prevE8 = ema8Arr[lastIdx - 1];
  const prevE21 = ema21Arr[lastIdx - 1];
  const justCrossed = (e8 > e21 && prevE8 <= prevE21) || (e8 < e21 && prevE8 >= prevE21);

  const bullishEma = e8 > e21;
  const bullishMacd = macdResult.histogram > 0;
  const bullishBb = bbResult.percentB < 0.3;
  const bullishRsi = r < 45;
  const bullishVol = volRatio > 1.3;
  const bullishRegime = regime.regime === "TRENDING_UP";

  const bearishEma = e8 < e21;
  const bearishMacd = macdResult.histogram < 0;
  const bearishBb = bbResult.percentB > 0.7;
  const bearishRsi = r > 55;
  const bearishVol = volRatio > 1.3;
  const bearishRegime = regime.regime === "TRENDING_DOWN";

  if (bullishEma && r < 70) {
    signal = "BUY";
    strength = emaDiff * 10 + (70 - r) / 4;
    if (justCrossed) strength += 20;
    if (r < 40) strength += 15;
    aligned = 1;
    if (bullishMacd) { strength += 8; aligned++; }
    if (bullishBb) { strength += 6; aligned++; }
    if (bullishRsi) { strength += 4; aligned++; }
    if (bullishVol) { strength += 5; aligned++; }
    if (bullishRegime) { strength += 12; aligned++; }
    if (regime.regime === "VOLATILE") strength *= 0.6;
    if (bearishRegime) strength *= 0.3;
    const parts = [`EMA↑`, `RSI ${r.toFixed(0)}`];
    if (bullishMacd) parts.push(`MACD↑`);
    if (bullishBb) parts.push(`BB low`);
    if (bullishVol) parts.push(`Vol ${volRatio.toFixed(1)}x`);
    parts.push(`${regime.regime} ADX${regime.adxValue.toFixed(0)}`);
    reason = parts.join(" | ");
  } else if (bearishEma && r > 30) {
    signal = "SELL";
    strength = emaDiff * 10 + (r - 30) / 4;
    if (justCrossed) strength += 20;
    if (r > 60) strength += 15;
    aligned = 1;
    if (bearishMacd) { strength += 8; aligned++; }
    if (bearishBb) { strength += 6; aligned++; }
    if (bearishRsi) { strength += 4; aligned++; }
    if (bearishVol) { strength += 5; aligned++; }
    if (bearishRegime) { strength += 12; aligned++; }
    if (regime.regime === "VOLATILE") strength *= 0.6;
    if (bullishRegime) strength *= 0.3;
    const parts = [`EMA↓`, `RSI ${r.toFixed(0)}`];
    if (bearishMacd) parts.push(`MACD↓`);
    if (bearishBb) parts.push(`BB high`);
    if (bearishVol) parts.push(`Vol ${volRatio.toFixed(1)}x`);
    parts.push(`${regime.regime} ADX${regime.adxValue.toFixed(0)}`);
    reason = parts.join(" | ");
  } else {
    reason = `EMA8=${e8.toFixed(2)} EMA21=${e21.toFixed(2)} RSI=${r.toFixed(1)} ${regime.regime} — no clear signal`;
  }

  return {
    signal, reason,
    ema8: e8, ema21: e21, rsiValue: r, lastClose,
    strength: Math.round(strength * 10) / 10,
    macdHistogram: macdResult.histogram,
    bollingerPercentB: bbResult.percentB,
    atrValue: atrVal,
    volumeRatio: volRatio,
    alignedIndicators: aligned,
    regime, dynamicSL, dynamicTP,
  };
}

export function parseKlinesToCandles(klines: any[]): Candle[] {
  return klines.map(k => {
    if (Array.isArray(k)) {
      return {
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        timestamp: parseInt(k[0]),
      };
    }
    return {
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
      volume: parseFloat(k.volume),
      timestamp: k.openTime || k.timestamp || 0,
    };
  }).filter(c => !isNaN(c.close) && c.close > 0);
}

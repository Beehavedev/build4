interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

export type Signal = "BUY" | "SELL" | "HOLD";

export interface StrategyResult {
  signal: Signal;
  reason: string;
  ema8: number;
  ema21: number;
  rsiValue: number;
  lastClose: number;
  strength: number;
}

export function emaCrossRsiStrategy(candles: Candle[]): StrategyResult {
  if (candles.length < 22) {
    return { signal: "HOLD", reason: "Not enough data", ema8: 0, ema21: 0, rsiValue: 50, lastClose: 0, strength: 0 };
  }

  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const rsiValues = rsi(closes, 14);

  const lastIdx = closes.length - 1;
  const e8 = ema8[lastIdx];
  const e21 = ema21[lastIdx];
  const r = rsiValues[lastIdx];
  const lastClose = closes[lastIdx];

  let signal: Signal = "HOLD";
  let reason = "";
  let strength = 0;

  const emaDiff = Math.abs(e8 - e21) / e21 * 100;
  const prevE8 = ema8[lastIdx - 1];
  const prevE21 = ema21[lastIdx - 1];
  const justCrossed = (e8 > e21 && prevE8 <= prevE21) || (e8 < e21 && prevE8 >= prevE21);

  if (e8 > e21 && r < 70) {
    signal = "BUY";
    strength = emaDiff * 10 + (70 - r) / 4;
    if (justCrossed) strength += 20;
    if (r < 40) strength += 15;
    reason = `EMA8 (${e8.toFixed(2)}) > EMA21 (${e21.toFixed(2)}), RSI ${r.toFixed(1)} < 70`;
  } else if (e8 < e21 && r > 30) {
    signal = "SELL";
    strength = emaDiff * 10 + (r - 30) / 4;
    if (justCrossed) strength += 20;
    if (r > 60) strength += 15;
    reason = `EMA8 (${e8.toFixed(2)}) < EMA21 (${e21.toFixed(2)}), RSI ${r.toFixed(1)} > 30`;
  } else {
    reason = `EMA8=${e8.toFixed(2)} EMA21=${e21.toFixed(2)} RSI=${r.toFixed(1)} — no clear signal`;
  }

  return { signal, reason, ema8: e8, ema21: e21, rsiValue: r, lastClose, strength: Math.round(strength * 10) / 10 };
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
      };
    }
    return {
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
      volume: parseFloat(k.volume),
    };
  }).filter(c => !isNaN(c.close) && c.close > 0);
}

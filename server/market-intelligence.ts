import { storage } from "./storage";
import type { StrategyResult } from "./trading-strategy";

export interface MarketIntel {
  fundingRate: number;
  orderbookImbalance: number;
  fundingFavorable: boolean;
  orderbookFavorable: boolean;
  confidence: number;
  rejectReason: string;
}

export interface IntelConfig {
  fundingRateFilter: boolean;
  maxFundingRateLong: number;
  minFundingRateShort: number;
  orderbookImbalanceThreshold: number;
  useConfidenceFilter: boolean;
  minConfidence: number;
}

const DEFAULT_INTEL: IntelConfig = {
  fundingRateFilter: true,
  maxFundingRateLong: 0.001,
  minFundingRateShort: -0.001,
  orderbookImbalanceThreshold: 0.6,
  useConfidenceFilter: true,
  minConfidence: 0.65,
};

const fundingCache = new Map<string, { rate: number; ts: number }>();
const FUNDING_TTL = 120_000;

export async function getFundingRate(futuresClient: any, symbol: string): Promise<number> {
  const cached = fundingCache.get(symbol);
  if (cached && Date.now() - cached.ts < FUNDING_TTL) return cached.rate;

  try {
    const data = await futuresClient.premiumIndex(symbol);
    const result = Array.isArray(data) ? data[0] : data;
    const rate = parseFloat(result?.lastFundingRate || result?.fundingRate || "0");
    fundingCache.set(symbol, { rate, ts: Date.now() });
    return rate;
  } catch (e: any) {
    console.log(`[Intel] Funding rate fetch failed for ${symbol}: ${e.message?.substring(0, 60)}`);
    return 0;
  }
}

export async function getOrderbookImbalance(futuresClient: any, symbol: string, depth: number = 20): Promise<number> {
  try {
    const ob = await futuresClient.orderBook(symbol, depth);
    const bids = ob.bids || [];
    const asks = ob.asks || [];
    let bidVol = 0;
    let askVol = 0;
    for (const b of bids) bidVol += parseFloat(b.quantity || b[1] || "0");
    for (const a of asks) askVol += parseFloat(a.quantity || a[1] || "0");
    const total = bidVol + askVol;
    return total > 0 ? bidVol / total : 0.5;
  } catch (e: any) {
    console.log(`[Intel] Orderbook fetch failed for ${symbol}: ${e.message?.substring(0, 60)}`);
    return 0.5;
  }
}

export async function evaluateEntry(
  futuresClient: any,
  symbol: string,
  side: "BUY" | "SELL",
  result: StrategyResult,
  config: IntelConfig = DEFAULT_INTEL,
): Promise<MarketIntel> {
  const intel: MarketIntel = {
    fundingRate: 0,
    orderbookImbalance: 0.5,
    fundingFavorable: true,
    orderbookFavorable: true,
    confidence: 0,
    rejectReason: "",
  };

  const [funding, imbalance] = await Promise.all([
    getFundingRate(futuresClient, symbol),
    getOrderbookImbalance(futuresClient, symbol),
  ]);

  intel.fundingRate = funding;
  intel.orderbookImbalance = imbalance;

  if (config.fundingRateFilter) {
    if (side === "BUY") {
      intel.fundingFavorable = funding <= config.maxFundingRateLong;
      if (!intel.fundingFavorable) {
        intel.rejectReason = `Funding rate ${(funding * 100).toFixed(4)}% too high for LONG (max ${(config.maxFundingRateLong * 100).toFixed(4)}%)`;
      }
    } else {
      intel.fundingFavorable = funding >= config.minFundingRateShort;
      if (!intel.fundingFavorable) {
        intel.rejectReason = `Funding rate ${(funding * 100).toFixed(4)}% too negative for SHORT (min ${(config.minFundingRateShort * 100).toFixed(4)}%)`;
      }
    }
  }

  if (side === "BUY") {
    intel.orderbookFavorable = imbalance >= config.orderbookImbalanceThreshold;
    if (!intel.orderbookFavorable && !intel.rejectReason) {
      intel.rejectReason = `Orderbook imbalance ${(imbalance * 100).toFixed(1)}% too weak for BUY (need ${(config.orderbookImbalanceThreshold * 100).toFixed(0)}%+)`;
    }
  } else {
    intel.orderbookFavorable = imbalance <= (1 - config.orderbookImbalanceThreshold);
    if (!intel.orderbookFavorable && !intel.rejectReason) {
      intel.rejectReason = `Orderbook imbalance ${(imbalance * 100).toFixed(1)}% too strong for SELL (need <${((1 - config.orderbookImbalanceThreshold) * 100).toFixed(0)}%)`;
    }
  }

  intel.confidence = computeConfidence(side, result, funding, imbalance);

  if (config.useConfidenceFilter && intel.confidence < config.minConfidence && !intel.rejectReason) {
    intel.rejectReason = `Confidence ${(intel.confidence * 100).toFixed(0)}% below minimum ${(config.minConfidence * 100).toFixed(0)}%`;
  }

  return intel;
}

interface TradeFeatures {
  rsi: number;
  macdHist: number;
  bbPercentB: number;
  atr: number;
  volumeRatio: number;
  strength: number;
  fundingRate: number;
  imbalance: number;
  aligned: number;
}

const tradeHistory: { features: TradeFeatures; won: boolean }[] = [];
let featureWeights = {
  rsi: 0.12,
  macd: 0.15,
  bb: 0.10,
  atr: 0.05,
  volume: 0.10,
  strength: 0.18,
  funding: 0.10,
  imbalance: 0.12,
  aligned: 0.08,
};

function computeConfidence(
  side: "BUY" | "SELL",
  result: StrategyResult,
  funding: number,
  imbalance: number,
): number {
  let score = 0;

  const rsiScore = side === "BUY"
    ? Math.max(0, Math.min(1, (60 - result.rsiValue) / 40))
    : Math.max(0, Math.min(1, (result.rsiValue - 40) / 40));
  score += rsiScore * featureWeights.rsi;

  const macdScore = side === "BUY"
    ? (result.macdHistogram > 0 ? Math.min(1, result.macdHistogram / (Math.abs(result.lastClose) * 0.002 + 0.001)) : 0)
    : (result.macdHistogram < 0 ? Math.min(1, Math.abs(result.macdHistogram) / (Math.abs(result.lastClose) * 0.002 + 0.001)) : 0);
  score += macdScore * featureWeights.macd;

  const bbScore = side === "BUY"
    ? Math.max(0, Math.min(1, 1 - result.bollingerPercentB))
    : Math.max(0, Math.min(1, result.bollingerPercentB));
  score += bbScore * featureWeights.bb;

  const atrPct = result.atrValue / (result.lastClose || 1);
  const atrScore = Math.max(0, Math.min(1, atrPct * 50));
  score += atrScore * featureWeights.atr;

  const volScore = Math.max(0, Math.min(1, (result.volumeRatio - 0.8) / 2));
  score += volScore * featureWeights.volume;

  const strengthScore = Math.max(0, Math.min(1, result.strength / 40));
  score += strengthScore * featureWeights.strength;

  const fundingScore = side === "BUY"
    ? (funding <= 0 ? 1 : Math.max(0, 1 - funding * 500))
    : (funding >= 0 ? 1 : Math.max(0, 1 + funding * 500));
  score += fundingScore * featureWeights.funding;

  const imbScore = side === "BUY"
    ? Math.max(0, Math.min(1, (imbalance - 0.3) / 0.4))
    : Math.max(0, Math.min(1, (0.7 - imbalance) / 0.4));
  score += imbScore * featureWeights.imbalance;

  const alignedScore = Math.max(0, Math.min(1, (result.alignedIndicators - 1) / 4));
  score += alignedScore * featureWeights.aligned;

  return Math.max(0, Math.min(1, score));
}

export function logTradeResult(features: TradeFeatures, won: boolean): void {
  tradeHistory.push({ features, won });
  if (tradeHistory.length > 500) tradeHistory.splice(0, tradeHistory.length - 500);

  if (tradeHistory.length >= 20 && tradeHistory.length % 20 === 0) {
    retrainWeights();
  }
}

function retrainWeights(): void {
  if (tradeHistory.length < 20) return;

  const recent = tradeHistory.slice(-200);
  const wins = recent.filter(t => t.won);
  const losses = recent.filter(t => !t.won);
  if (wins.length === 0 || losses.length === 0) return;

  const avgWin = averageFeatures(wins.map(t => t.features));
  const avgLoss = averageFeatures(losses.map(t => t.features));

  const keys: (keyof typeof featureWeights)[] = ["rsi", "macd", "bb", "atr", "volume", "strength", "funding", "imbalance", "aligned"];
  const featureMap: Record<string, keyof TradeFeatures> = {
    rsi: "rsi", macd: "macdHist", bb: "bbPercentB", atr: "atr",
    volume: "volumeRatio", strength: "strength", funding: "fundingRate",
    imbalance: "imbalance", aligned: "aligned",
  };

  const newWeights = { ...featureWeights };
  for (const key of keys) {
    const fKey = featureMap[key];
    const winVal = avgWin[fKey];
    const lossVal = avgLoss[fKey];
    const diff = Math.abs(winVal - lossVal);
    const combined = (Math.abs(winVal) + Math.abs(lossVal)) / 2 || 1;
    const discriminationPower = diff / combined;
    newWeights[key] = featureWeights[key] * (1 + discriminationPower * 0.3);
  }

  const total = Object.values(newWeights).reduce((a, b) => a + b, 0);
  for (const key of keys) {
    newWeights[key] = newWeights[key] / total;
  }

  featureWeights = newWeights;
  console.log(`[Intel] Weights retrained on ${recent.length} trades. Win rate: ${(wins.length / recent.length * 100).toFixed(1)}%`);
}

function averageFeatures(features: TradeFeatures[]): TradeFeatures {
  const sum: TradeFeatures = { rsi: 0, macdHist: 0, bbPercentB: 0, atr: 0, volumeRatio: 0, strength: 0, fundingRate: 0, imbalance: 0, aligned: 0 };
  for (const f of features) {
    sum.rsi += f.rsi;
    sum.macdHist += f.macdHist;
    sum.bbPercentB += f.bbPercentB;
    sum.atr += f.atr;
    sum.volumeRatio += f.volumeRatio;
    sum.strength += f.strength;
    sum.fundingRate += f.fundingRate;
    sum.imbalance += f.imbalance;
    sum.aligned += f.aligned;
  }
  const n = features.length || 1;
  return {
    rsi: sum.rsi / n,
    macdHist: sum.macdHist / n,
    bbPercentB: sum.bbPercentB / n,
    atr: sum.atr / n,
    volumeRatio: sum.volumeRatio / n,
    strength: sum.strength / n,
    fundingRate: sum.fundingRate / n,
    imbalance: sum.imbalance / n,
    aligned: sum.aligned / n,
  };
}

export function getIntelStatus(): { tradeCount: number; winRate: number; weights: typeof featureWeights } {
  const wins = tradeHistory.filter(t => t.won).length;
  return {
    tradeCount: tradeHistory.length,
    winRate: tradeHistory.length > 0 ? wins / tradeHistory.length : 0,
    weights: { ...featureWeights },
  };
}

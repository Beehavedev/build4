import { storage } from "./storage";
import type { StrategyResult } from "./trading-strategy";
import type { MarketRegime, RegimeInfo } from "./trading-strategy";

export interface MarketIntel {
  fundingRate: number;
  orderbookImbalance: number;
  fundingFavorable: boolean;
  orderbookFavorable: boolean;
  confidence: number;
  rejectReason: string;
  regimeLabel: MarketRegime;
  aiVerdict?: string;
  aiReasoning?: string;
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
    regimeLabel: result.regime?.regime || "RANGING",
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

  const symbolWinRate = getSymbolWinRate(symbol);
  if (symbolWinRate !== null && symbolWinRate < 0.25 && symbolStats[symbol]?.total >= 5) {
    intel.confidence *= 0.5;
    if (!intel.rejectReason) {
      intel.rejectReason = `${symbol} has only ${(symbolWinRate * 100).toFixed(0)}% win rate (${symbolStats[symbol].total} trades)`;
    }
  }

  const regimeWR = getRegimeWinRate(result.regime?.regime || "RANGING");
  if (regimeWR !== null && regimeWR < 0.3) {
    intel.confidence *= 0.6;
  }

  if (config.useConfidenceFilter && intel.confidence < config.minConfidence && !intel.rejectReason) {
    intel.rejectReason = `Confidence ${(intel.confidence * 100).toFixed(0)}% below minimum ${(config.minConfidence * 100).toFixed(0)}%`;
  }

  if (!intel.rejectReason && intel.fundingFavorable && intel.orderbookFavorable && intel.confidence >= config.minConfidence) {
    try {
      const aiResult = await aiSignalFilter(symbol, side, result, funding, imbalance);
      intel.aiVerdict = aiResult.verdict;
      intel.aiReasoning = aiResult.reasoning;
      if (aiResult.verdict === "REJECT") {
        intel.rejectReason = `AI filter: ${aiResult.reasoning}`;
      } else if (aiResult.verdict === "WEAK") {
        intel.confidence *= 0.7;
        if (intel.confidence < config.minConfidence) {
          intel.rejectReason = `AI reduced confidence to ${(intel.confidence * 100).toFixed(0)}% (${aiResult.reasoning})`;
        }
      }
    } catch (e: any) {
      console.log(`[Intel] AI filter error (proceeding without): ${e.message?.substring(0, 80)}`);
    }
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
  regime?: MarketRegime;
  symbol?: string;
}

let tradeHistory: { features: TradeFeatures; won: boolean }[] = [];
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

let symbolStats: Record<string, { wins: number; losses: number; total: number }> = {};
let regimeStats: Record<string, { wins: number; losses: number; total: number }> = {};
let _learningLoaded = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadLearningFromDb(chatId?: string): Promise<void> {
  if (_learningLoaded) return;
  try {
    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const rows = (await db.execute(sql`SELECT * FROM aster_agent_learning ORDER BY updated_at DESC LIMIT 1`)).rows;
    if (rows && rows.length > 0) {
      const row = rows[0] as any;
      try { featureWeights = { ...featureWeights, ...JSON.parse(row.weights_json || "{}") }; } catch {}
      try {
        const hist = JSON.parse(row.trade_history_json || "[]");
        if (Array.isArray(hist)) tradeHistory = hist.slice(-500);
      } catch {}
      try { symbolStats = JSON.parse(row.symbol_stats_json || "{}"); } catch {}
      try { regimeStats = JSON.parse(row.regime_stats_json || "{}"); } catch {}
      _learningLoaded = true;
      const wins = tradeHistory.filter(t => t.won).length;
      console.log(`[Intel] Loaded learning from DB: ${tradeHistory.length} trades, ${(tradeHistory.length > 0 ? wins / tradeHistory.length * 100 : 0).toFixed(1)}% win rate, ${Object.keys(symbolStats).length} symbols tracked`);
    } else {
      _learningLoaded = true;
      console.log(`[Intel] No learning data found in DB, starting fresh`);
    }
  } catch (e: any) {
    _learningLoaded = true;
    console.log(`[Intel] Failed to load learning from DB: ${e.message?.substring(0, 80)}`);
  }
}

async function persistLearningToDb(): Promise<void> {
  try {
    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const wins = tradeHistory.filter(t => t.won).length;
    await db.execute(sql`
      INSERT INTO aster_agent_learning (id, chat_id, weights_json, trade_history_json, symbol_stats_json, regime_stats_json, total_trades, total_wins, updated_at)
      VALUES ('global', 'global', ${JSON.stringify(featureWeights)}, ${JSON.stringify(tradeHistory.slice(-500))}, ${JSON.stringify(symbolStats)}, ${JSON.stringify(regimeStats)}, ${tradeHistory.length}, ${wins}, NOW())
      ON CONFLICT (id) DO UPDATE SET
        weights_json = EXCLUDED.weights_json,
        trade_history_json = EXCLUDED.trade_history_json,
        symbol_stats_json = EXCLUDED.symbol_stats_json,
        regime_stats_json = EXCLUDED.regime_stats_json,
        total_trades = EXCLUDED.total_trades,
        total_wins = EXCLUDED.total_wins,
        updated_at = NOW()
    `);
    console.log(`[Intel] Persisted learning to DB: ${tradeHistory.length} trades, ${wins} wins`);
  } catch (e: any) {
    console.log(`[Intel] Failed to persist learning: ${e.message?.substring(0, 80)}`);
  }
}

function schedulePersist(): void {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    persistLearningToDb();
    _persistTimer = null;
  }, 5000);
}

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

  const regime = result.regime;
  if (regime) {
    if ((side === "BUY" && regime.regime === "TRENDING_UP") || (side === "SELL" && regime.regime === "TRENDING_DOWN")) {
      score *= 1.2;
    } else if (regime.regime === "RANGING") {
      score *= 0.5;
    } else if (regime.regime === "VOLATILE") {
      score *= 0.7;
    }
  }

  return Math.max(0, Math.min(1, score));
}

export function logTradeResult(features: TradeFeatures, won: boolean): void {
  tradeHistory.push({ features, won });
  if (tradeHistory.length > 500) tradeHistory.splice(0, tradeHistory.length - 500);

  const sym = features.symbol || "UNKNOWN";
  if (!symbolStats[sym]) symbolStats[sym] = { wins: 0, losses: 0, total: 0 };
  symbolStats[sym].total++;
  if (won) symbolStats[sym].wins++;
  else symbolStats[sym].losses++;

  const reg = features.regime || "UNKNOWN";
  if (!regimeStats[reg]) regimeStats[reg] = { wins: 0, losses: 0, total: 0 };
  regimeStats[reg].total++;
  if (won) regimeStats[reg].wins++;
  else regimeStats[reg].losses++;

  if (tradeHistory.length >= 10 && tradeHistory.length % 10 === 0) {
    retrainWeights();
  }

  schedulePersist();
}

function getSymbolWinRate(symbol: string): number | null {
  const s = symbolStats[symbol];
  if (!s || s.total < 3) return null;
  return s.wins / s.total;
}

function getRegimeWinRate(regime: string): number | null {
  const r = regimeStats[regime];
  if (!r || r.total < 3) return null;
  return r.wins / r.total;
}

function retrainWeights(): void {
  if (tradeHistory.length < 10) return;

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
    const winVal = avgWin[fKey] as number;
    const lossVal = avgLoss[fKey] as number;
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
  const winRate = wins.length / recent.length * 100;
  console.log(`[Intel] Weights retrained on ${recent.length} trades. Win rate: ${winRate.toFixed(1)}%`);

  const symbolSummary = Object.entries(symbolStats)
    .filter(([, s]) => s.total >= 3)
    .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))
    .map(([sym, s]) => `${sym}: ${(s.wins / s.total * 100).toFixed(0)}% (${s.total})`)
    .join(", ");
  if (symbolSummary) {
    console.log(`[Intel] Symbol performance: ${symbolSummary}`);
  }
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

export function getIntelStatus(): { tradeCount: number; winRate: number; weights: typeof featureWeights; symbolStats: typeof symbolStats; regimeStats: typeof regimeStats } {
  const wins = tradeHistory.filter(t => t.won).length;
  return {
    tradeCount: tradeHistory.length,
    winRate: tradeHistory.length > 0 ? wins / tradeHistory.length : 0,
    weights: { ...featureWeights },
    symbolStats: { ...symbolStats },
    regimeStats: { ...regimeStats },
  };
}

const aiCache = new Map<string, { verdict: string; reasoning: string; models: string; ts: number }>();
const AI_CACHE_TTL = 300_000;

interface AIFilterResult {
  verdict: "GO" | "WEAK" | "REJECT";
  reasoning: string;
  models?: string;
}

interface SingleModelResult {
  verdict: "GO" | "WEAK" | "REJECT";
  reasoning: string;
  model: string;
}

function buildAnalysisPrompt(
  symbol: string,
  side: "BUY" | "SELL",
  result: StrategyResult,
  funding: number,
  imbalance: number,
): string {
  const regime = result.regime;
  const symWR = symbolStats[symbol];
  const regWR = regimeStats[regime?.regime || "RANGING"];
  const recentTrades = tradeHistory.slice(-20);
  const recentWins = recentTrades.filter(t => t.won).length;
  const recentLosses = recentTrades.length - recentWins;

  return `You are a crypto perpetual futures trading risk analyst. Evaluate this trade signal and respond with ONLY a JSON object.

SIGNAL: ${side} ${symbol}
PRICE: $${result.lastClose.toFixed(2)}
INDICATORS:
- EMA8: ${result.ema8.toFixed(2)}, EMA21: ${result.ema21.toFixed(2)} (diff: ${((result.ema8 - result.ema21) / result.ema21 * 100).toFixed(3)}%)
- RSI(14): ${result.rsiValue.toFixed(1)}
- MACD Histogram: ${result.macdHistogram.toFixed(6)}
- Bollinger %B: ${result.bollingerPercentB.toFixed(3)}
- ATR: ${result.atrValue.toFixed(4)} (${(result.atrValue / result.lastClose * 100).toFixed(2)}% of price)
- Volume Ratio: ${result.volumeRatio.toFixed(2)}x avg
- Signal Strength: ${result.strength}
- Aligned Indicators: ${result.alignedIndicators}/6

MARKET REGIME: ${regime?.regime || "UNKNOWN"}
- ADX: ${regime?.adxValue?.toFixed(1) || "N/A"} (>25 = trending)
- +DI: ${regime?.plusDI?.toFixed(1) || "N/A"}, -DI: ${regime?.minusDI?.toFixed(1) || "N/A"}
- Choppiness: ${regime?.choppiness?.toFixed(1) || "N/A"} (<50 = trending)

MARKET CONTEXT:
- Funding Rate: ${(funding * 100).toFixed(4)}%
- Orderbook Imbalance: ${(imbalance * 100).toFixed(1)}% bids
${symWR ? `- ${symbol} historical: ${symWR.wins}W/${symWR.losses}L (${(symWR.wins / symWR.total * 100).toFixed(0)}% win rate)` : "- No history for this symbol"}
${regWR ? `- ${regime?.regime} regime: ${regWR.wins}W/${regWR.losses}L (${(regWR.wins / regWR.total * 100).toFixed(0)}% win rate)` : ""}
- Recent 20 trades: ${recentWins}W/${recentLosses}L

Respond with ONLY this JSON (no markdown, no explanation):
{"verdict":"GO|WEAK|REJECT","reasoning":"one sentence max 80 chars"}

Rules:
- REJECT if signal contradicts regime (e.g., BUY in TRENDING_DOWN)
- REJECT if RSI is in extreme zone for the direction (BUY with RSI>65, SELL with RSI<35)
- WEAK if only 2 or fewer indicators align
- WEAK if recent win rate is below 30%
- GO if strong trend alignment with 3+ indicators`;
}

function parseAIResponse(content: string): { verdict: string; reasoning: string } {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    const verdict = (parsed.verdict || "GO").toUpperCase();
    const reasoning = parsed.reasoning || "No reasoning";
    const validVerdicts = ["GO", "WEAK", "REJECT"];
    return { verdict: validVerdicts.includes(verdict) ? verdict : "GO", reasoning };
  } catch {
    return { verdict: "GO", reasoning: "Parse error" };
  }
}

async function callGrok(prompt: string): Promise<SingleModelResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { verdict: "GO", reasoning: "No Grok key", model: "grok" };

  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "grok-3-mini-fast",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.1,
    }),
  });

  if (!response.ok) throw new Error(`Grok API ${response.status}`);
  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content?.trim() || "";
  const { verdict, reasoning } = parseAIResponse(content);
  return { verdict: verdict as any, reasoning, model: "grok" };
}

async function callClaude(prompt: string): Promise<SingleModelResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { verdict: "GO", reasoning: "No Claude key", model: "claude" };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    }),
  });

  if (!response.ok) throw new Error(`Claude API ${response.status}`);
  const data = await response.json() as any;
  const content = data.content?.[0]?.text?.trim() || "";
  const { verdict, reasoning } = parseAIResponse(content);
  return { verdict: verdict as any, reasoning, model: "claude" };
}

const VERDICT_RANK: Record<string, number> = { REJECT: 0, WEAK: 1, GO: 2 };

function consensusVerdict(results: SingleModelResult[]): AIFilterResult {
  if (results.length === 0) return { verdict: "GO", reasoning: "No AI models available", models: "none" };
  if (results.length === 1) return { verdict: results[0].verdict, reasoning: `[${results[0].model}] ${results[0].reasoning}`, models: results[0].model };

  const anyReject = results.find(r => r.verdict === "REJECT");
  if (anyReject) {
    return {
      verdict: "REJECT",
      reasoning: `[${anyReject.model}] ${anyReject.reasoning}`,
      models: results.map(r => `${r.model}:${r.verdict}`).join(", "),
    };
  }

  const sorted = [...results].sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);
  const strictest = sorted[0];

  return {
    verdict: strictest.verdict,
    reasoning: results.map(r => `[${r.model}] ${r.reasoning}`).join(" | "),
    models: results.map(r => `${r.model}:${r.verdict}`).join(", "),
  };
}

async function aiSignalFilter(
  symbol: string,
  side: "BUY" | "SELL",
  result: StrategyResult,
  funding: number,
  imbalance: number,
): Promise<AIFilterResult> {
  const hasGrok = !!process.env.XAI_API_KEY;
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;
  if (!hasGrok && !hasClaude) {
    return { verdict: "GO", reasoning: "No AI keys configured" };
  }

  const cacheKey = `${symbol}-${side}-${Math.floor(Date.now() / AI_CACHE_TTL)}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AI_CACHE_TTL) {
    return { verdict: cached.verdict as any, reasoning: cached.reasoning, models: cached.models };
  }

  const prompt = buildAnalysisPrompt(symbol, side, result, funding, imbalance);

  const calls: Promise<SingleModelResult>[] = [];
  if (hasClaude) calls.push(callClaude(prompt).catch(e => ({ verdict: "GO" as const, reasoning: `Claude error: ${e.message?.substring(0, 40)}`, model: "claude" })));
  if (hasGrok) calls.push(callGrok(prompt).catch(e => ({ verdict: "GO" as const, reasoning: `Grok error: ${e.message?.substring(0, 40)}`, model: "grok" })));

  const results = await Promise.all(calls);
  const final = consensusVerdict(results);

  aiCache.set(cacheKey, { verdict: final.verdict, reasoning: final.reasoning, models: final.models || "", ts: Date.now() });

  if (aiCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of aiCache) {
      if (now - v.ts > AI_CACHE_TTL) aiCache.delete(k);
    }
  }

  console.log(`[Intel] AI consensus for ${side} ${symbol}: ${final.verdict} (${final.models}) — ${final.reasoning.substring(0, 120)}`);
  return final;
}

import { storage } from "./storage";
import type { StrategyResult, MarketSnapshot, TimeframeAnalysis, KeyLevel } from "./trading-strategy";
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

export interface TradeMemory {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  reasoning: string;
  closedAt: number;
  regime?: string;
  hour?: number;
  durationMin?: number;
  leverage?: number;
}

export interface ClaudeDecision {
  action: "OPEN_LONG" | "OPEN_SHORT" | "HOLD" | "CLOSE";
  confidence: number;
  reasoning: string;
  riskAssessment: string;
  suggestedStopLoss: number;
  suggestedTakeProfit: number;
  suggestedLeverage: number;
  keyFactors: string[];
}

let tradeMemory: TradeMemory[] = [];
let symbolStats: Record<string, { wins: number; losses: number; total: number }> = {};
let regimeStats: Record<string, { wins: number; losses: number; total: number }> = {};
let hourStats: Record<number, { wins: number; losses: number; total: number }> = {};
let symbolRegimeStats: Record<string, { wins: number; losses: number; total: number }> = {};
let _learningLoaded = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

const CORRELATION_GROUPS: string[][] = [
  ["BTCUSDT", "ETHUSDT"],
  ["SOLUSDT", "SUIUSDT"],
  ["DOGEUSDT", "XRPUSDT"],
  ["ADAUSDT", "AVAXUSDT", "LINKUSDT"],
  ["BNBUSDT"],
];

export async function loadLearningFromDb(chatId?: string): Promise<void> {
  if (_learningLoaded) return;
  try {
    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const rows = (await db.execute(sql`SELECT * FROM aster_agent_learning ORDER BY updated_at DESC LIMIT 1`)).rows;
    if (rows && rows.length > 0) {
      const row = rows[0] as any;
      try {
        const hist = JSON.parse(row.trade_history_json || "[]");
        if (Array.isArray(hist)) tradeMemory = hist.slice(-100);
      } catch {}
      try { symbolStats = JSON.parse(row.symbol_stats_json || "{}"); } catch {}
      try { regimeStats = JSON.parse(row.regime_stats_json || "{}"); } catch {}
      try {
        const extra = JSON.parse(row.weights_json || "{}");
        if (extra.hourStats) hourStats = extra.hourStats;
        if (extra.symbolRegimeStats) symbolRegimeStats = extra.symbolRegimeStats;
      } catch {}
      _learningLoaded = true;
      const wins = tradeMemory.filter(t => t.pnl > 0).length;
      console.log(`[Intel] Loaded memory from DB: ${tradeMemory.length} trades, ${(tradeMemory.length > 0 ? wins / tradeMemory.length * 100 : 0).toFixed(1)}% win rate`);
    } else {
      _learningLoaded = true;
      console.log(`[Intel] No memory found in DB, starting fresh`);
    }
  } catch (e: any) {
    _learningLoaded = true;
    console.log(`[Intel] Failed to load memory from DB: ${e.message?.substring(0, 80)}`);
  }
}

async function persistLearningToDb(): Promise<void> {
  try {
    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const wins = tradeMemory.filter(t => t.pnl > 0).length;
    const extraJson = JSON.stringify({ hourStats, symbolRegimeStats });
    await db.execute(sql`
      INSERT INTO aster_agent_learning (id, chat_id, weights_json, trade_history_json, symbol_stats_json, regime_stats_json, total_trades, total_wins, updated_at)
      VALUES ('global', 'global', ${extraJson}, ${JSON.stringify(tradeMemory.slice(-100))}, ${JSON.stringify(symbolStats)}, ${JSON.stringify(regimeStats)}, ${tradeMemory.length}, ${wins}, NOW())
      ON CONFLICT (id) DO UPDATE SET
        weights_json = EXCLUDED.weights_json,
        trade_history_json = EXCLUDED.trade_history_json,
        symbol_stats_json = EXCLUDED.symbol_stats_json,
        regime_stats_json = EXCLUDED.regime_stats_json,
        total_trades = EXCLUDED.total_trades,
        total_wins = EXCLUDED.total_wins,
        updated_at = NOW()
    `);
    console.log(`[Intel] Persisted memory: ${tradeMemory.length} trades, ${wins} wins`);
  } catch (e: any) {
    console.log(`[Intel] Failed to persist memory: ${e.message?.substring(0, 80)}`);
  }
}

function schedulePersist(): void {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    persistLearningToDb();
    _persistTimer = null;
  }, 5000);
}

export function recordTradeResult(trade: TradeMemory): void {
  tradeMemory.push(trade);
  if (tradeMemory.length > 100) tradeMemory.splice(0, tradeMemory.length - 100);

  const sym = trade.symbol || "UNKNOWN";
  const won = trade.pnl > 0;

  if (!symbolStats[sym]) symbolStats[sym] = { wins: 0, losses: 0, total: 0 };
  symbolStats[sym].total++;
  if (won) symbolStats[sym].wins++;
  else symbolStats[sym].losses++;

  if (trade.regime) {
    const reg = trade.regime;
    if (!regimeStats[reg]) regimeStats[reg] = { wins: 0, losses: 0, total: 0 };
    regimeStats[reg].total++;
    if (won) regimeStats[reg].wins++;
    else regimeStats[reg].losses++;

    const symReg = `${sym}_${reg}`;
    if (!symbolRegimeStats[symReg]) symbolRegimeStats[symReg] = { wins: 0, losses: 0, total: 0 };
    symbolRegimeStats[symReg].total++;
    if (won) symbolRegimeStats[symReg].wins++;
    else symbolRegimeStats[symReg].losses++;
  }

  if (trade.hour !== undefined) {
    const h = trade.hour;
    if (!hourStats[h]) hourStats[h] = { wins: 0, losses: 0, total: 0 };
    hourStats[h].total++;
    if (won) hourStats[h].wins++;
    else hourStats[h].losses++;
  }

  schedulePersist();
}

export function logTradeResult(features: any, won: boolean): void {
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

  schedulePersist();
}

export function getSymbolConfidenceThreshold(symbol: string): number {
  const BASE_THRESHOLD = 70;
  const stat = symbolStats[symbol];
  if (!stat || stat.total < 10) return BASE_THRESHOLD;
  const wr = stat.wins / stat.total;
  if (wr < 0.40) return Math.min(90, BASE_THRESHOLD + 10);
  if (wr < 0.45) return Math.min(85, BASE_THRESHOLD + 5);
  if (wr > 0.65) return Math.max(65, BASE_THRESHOLD - 5);
  return BASE_THRESHOLD;
}

export function isHourBlocked(hour: number): boolean {
  const stat = hourStats[hour];
  if (!stat || stat.total < 10) return false;
  const wr = stat.wins / stat.total;
  return wr < 0.30;
}

export function getBestTradingHours(): { best: number[]; worst: number[]; stats: typeof hourStats } {
  const best: number[] = [];
  const worst: number[] = [];
  for (const [h, stat] of Object.entries(hourStats)) {
    if (stat.total < 5) continue;
    const wr = stat.wins / stat.total;
    if (wr >= 0.60) best.push(Number(h));
    if (wr < 0.35) worst.push(Number(h));
  }
  return { best, worst, stats: { ...hourStats } };
}

export function getCorrelatedOpenPositions(symbol: string, openPositions: Map<string, { side: string }>): string[] {
  const group = CORRELATION_GROUPS.find(g => g.includes(symbol));
  if (!group) return [];
  const conflicts: string[] = [];
  for (const [openSym, info] of openPositions) {
    if (openSym === symbol) continue;
    if (group.includes(openSym)) {
      conflicts.push(`${info.side} ${openSym}`);
    }
  }
  return conflicts;
}

export function isCorrelationBlocked(symbol: string, side: "LONG" | "SHORT", openPositions: Map<string, { side: string }>): boolean {
  const group = CORRELATION_GROUPS.find(g => g.includes(symbol));
  if (!group) return false;
  for (const [openSym, info] of openPositions) {
    if (openSym === symbol) continue;
    if (group.includes(openSym) && info.side === side) {
      return true;
    }
  }
  return false;
}

export function getRegimeWinRate(regime: string): { winRate: number; total: number } | null {
  const stat = regimeStats[regime];
  if (!stat || stat.total < 5) return null;
  return { winRate: stat.wins / stat.total, total: stat.total };
}

export function getSymbolRegimeWinRate(symbol: string, regime: string): { winRate: number; total: number } | null {
  const key = `${symbol}_${regime}`;
  const stat = symbolRegimeStats[key];
  if (!stat || stat.total < 3) return null;
  return { winRate: stat.wins / stat.total, total: stat.total };
}

export function getLearningInsights(): {
  symbolThresholds: Record<string, number>;
  blockedHours: number[];
  bestHours: number[];
  regimePerformance: Record<string, { winRate: number; total: number }>;
  correlationGroups: string[][];
  totalTrades: number;
  overallWinRate: number;
} {
  const symbolThresholds: Record<string, number> = {};
  for (const sym of Object.keys(symbolStats)) {
    symbolThresholds[sym] = getSymbolConfidenceThreshold(sym);
  }
  const { best, worst } = getBestTradingHours();
  const regPerf: Record<string, { winRate: number; total: number }> = {};
  for (const [reg, stat] of Object.entries(regimeStats)) {
    if (stat.total >= 3) regPerf[reg] = { winRate: stat.wins / stat.total, total: stat.total };
  }
  const wins = tradeMemory.filter(t => t.pnl > 0).length;
  return {
    symbolThresholds,
    blockedHours: worst.filter(h => isHourBlocked(h)),
    bestHours: best,
    regimePerformance: regPerf,
    correlationGroups: CORRELATION_GROUPS,
    totalTrades: tradeMemory.length,
    overallWinRate: tradeMemory.length > 0 ? wins / tradeMemory.length : 0,
  };
}

export function getIntelStatus(): { tradeCount: number; winRate: number; weights: any; symbolStats: typeof symbolStats; regimeStats: typeof regimeStats; hourStats: typeof hourStats; learning: ReturnType<typeof getLearningInsights> } {
  const wins = tradeMemory.filter(t => t.pnl > 0).length;
  return {
    tradeCount: tradeMemory.length,
    winRate: tradeMemory.length > 0 ? wins / tradeMemory.length : 0,
    weights: {},
    symbolStats: { ...symbolStats },
    regimeStats: { ...regimeStats },
    hourStats: { ...hourStats },
    learning: getLearningInsights(),
  };
}

export function getTradeMemory(): TradeMemory[] {
  return [...tradeMemory];
}

function buildTFSummary(tf: TimeframeAnalysis): string {
  return `[${tf.timeframe}] Price: $${tf.lastClose.toFixed(2)} | EMA8: ${tf.ema8.toFixed(2)}, EMA21: ${tf.ema21.toFixed(2)}, EMA50: ${tf.ema50.toFixed(2)} | RSI: ${tf.rsi.toFixed(1)} | MACD hist: ${tf.macdHistogram.toFixed(6)} | BB%B: ${tf.bbPercentB.toFixed(3)} | ATR: ${tf.atrPct.toFixed(2)}% | Vol: ${tf.volumeRatio.toFixed(2)}x | Trend: ${tf.trend} | Regime: ${tf.regime.regime} (ADX ${tf.regime.adxValue.toFixed(1)}, Chop ${tf.regime.choppiness.toFixed(0)})`;
}

function buildClaudePrompt(
  snapshot: MarketSnapshot,
  funding: number,
  imbalance: number,
  balance: number,
  riskPct: number,
  maxLeverage: number,
  currentPositions: string[],
  dailyPnl: number,
  dailyLossLimit: number,
  consecutiveLosses: number,
  memory: TradeMemory[],
): string {
  const recentMemory = memory.slice(-15);
  const recentWins = recentMemory.filter(t => t.pnl > 0).length;
  const recentLosses = recentMemory.length - recentWins;
  const recentWR = recentMemory.length > 0 ? (recentWins / recentMemory.length * 100).toFixed(0) : "N/A";

  const symStat = symbolStats[snapshot.symbol];
  const symWR = symStat ? `${(symStat.wins / symStat.total * 100).toFixed(0)}% (${symStat.total} trades)` : "No history";

  const currentHour = new Date().getUTCHours();
  const hourStat = hourStats[currentHour];
  const hourWR = hourStat && hourStat.total >= 5 ? `${(hourStat.wins / hourStat.total * 100).toFixed(0)}% (${hourStat.total} trades)` : "Insufficient data";

  const regStat = regimeStats[snapshot.overallRegime];
  const regWR = regStat && regStat.total >= 5 ? `${(regStat.wins / regStat.total * 100).toFixed(0)}% (${regStat.total} trades)` : "Insufficient data";

  const symRegStat = symbolRegimeStats[`${snapshot.symbol}_${snapshot.overallRegime}`];
  const symRegWR = symRegStat && symRegStat.total >= 3 ? `${(symRegStat.wins / symRegStat.total * 100).toFixed(0)}% (${symRegStat.total})` : "N/A";

  const confThreshold = getSymbolConfidenceThreshold(snapshot.symbol);
  const { best: bestHours, worst: worstHours } = getBestTradingHours();

  const levelsStr = snapshot.nearestSupport
    ? `Nearest Support: $${snapshot.nearestSupport.toFixed(2)} (${snapshot.distToSupportPct?.toFixed(2)}% away)\n`
    : "";
  const resStr = snapshot.nearestResistance
    ? `Nearest Resistance: $${snapshot.nearestResistance.toFixed(2)} (${snapshot.distToResistancePct?.toFixed(2)}% away)\n`
    : "";

  const memoryStr = recentMemory.length > 0
    ? recentMemory.slice(-5).map(t =>
        `  ${t.side} ${t.symbol}: ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} USDT (${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%) — ${t.reason}`
      ).join("\n")
    : "  No recent trades";

  return `You are a professional crypto perpetual futures trader managing a real money account. Your goal is CONSISTENT PROFITABILITY with strict risk management. You must be VERY selective — only trade high-probability setups.

CURRENT STATE:
Account Balance: $${balance.toFixed(2)} USDT
Risk Per Trade: ${riskPct}% ($${(balance * riskPct / 100).toFixed(2)} max risk)
Max Leverage: ${maxLeverage}x
Daily PnL: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)} (limit: -$${(balance * dailyLossLimit / 100).toFixed(2)})
Consecutive Losses: ${consecutiveLosses}
Current Open Positions: ${currentPositions.length > 0 ? currentPositions.join(", ") : "None"}

SYMBOL: ${snapshot.symbol}
Current Price: $${snapshot.price.toFixed(2)}

MULTI-TIMEFRAME ANALYSIS:
${buildTFSummary(snapshot.tf5m)}
${buildTFSummary(snapshot.tf15m)}
${buildTFSummary(snapshot.tf1h)}

Overall Trend Alignment: ${snapshot.overallTrend}
Overall Regime: ${snapshot.overallRegime}

KEY LEVELS:
${levelsStr}${resStr}${!levelsStr && !resStr ? "No significant levels detected\n" : ""}

MARKET CONTEXT:
Funding Rate: ${(funding * 100).toFixed(4)}%
Orderbook Imbalance: ${(imbalance * 100).toFixed(1)}% (>50% = more buyers)
${snapshot.symbol} Win Rate: ${symWR}

LEARNING INSIGHTS (from historical trades):
Current Hour (${currentHour} UTC) Win Rate: ${hourWR}${worstHours.includes(currentHour) ? " ⚠️ HISTORICALLY POOR HOUR" : ""}${bestHours.includes(currentHour) ? " ✅ HISTORICALLY STRONG HOUR" : ""}
${snapshot.overallRegime} Regime Win Rate: ${regWR}
${snapshot.symbol} in ${snapshot.overallRegime}: ${symRegWR}
Dynamic Confidence Threshold for ${snapshot.symbol}: ${confThreshold}%${confThreshold > 70 ? " (RAISED due to poor history)" : confThreshold < 70 ? " (lowered due to strong history)" : ""}
${bestHours.length > 0 ? `Best Trading Hours (UTC): ${bestHours.sort((a,b)=>a-b).join(", ")}` : ""}
${worstHours.length > 0 ? `Avoid Trading Hours (UTC): ${worstHours.sort((a,b)=>a-b).join(", ")}` : ""}

RECENT TRADE HISTORY (last 5):
${memoryStr}
Recent Performance: ${recentWR}% win rate (${recentWins}W/${recentLosses}L from last ${recentMemory.length} trades)

YOUR TRADING RULES (MANDATORY):
1. ONLY trade when 2+ timeframes agree on direction
2. NEVER trade in RANGING regime on any timeframe
3. NEVER trade against the 1h trend
4. Require RSI confirmation (not overbought for longs, not oversold for shorts)
5. After 3 consecutive losses, be EXTRA cautious — need 3/3 timeframe alignment
6. Funding rate should favor your direction
7. Price should not be within 0.3% of a strong resistance (for longs) or support (for shorts)
8. NEVER chase — if you missed the move, wait for pullback
9. Minimum 1.5:1 reward-to-risk ratio
10. If daily loss exceeds ${dailyLossLimit}% of balance, HOLD everything

Respond with ONLY this JSON (no markdown, no explanation):
{
  "action": "OPEN_LONG" | "OPEN_SHORT" | "HOLD",
  "confidence": 0-100,
  "reasoning": "2-3 sentences explaining your complete analysis",
  "riskAssessment": "1 sentence on the main risk",
  "suggestedStopLoss": <percentage below/above entry, e.g. 1.5>,
  "suggestedTakeProfit": <percentage target, e.g. 3.0>,
  "suggestedLeverage": <number between 2 and ${maxLeverage}>,
  "keyFactors": ["factor1", "factor2", "factor3"]
}

IMPORTANT: Default to HOLD. Only recommend OPEN_LONG or OPEN_SHORT when you see a genuinely high-probability setup with clear edge. Confidence below 70 = HOLD.`;
}

function buildExitPrompt(
  symbol: string,
  side: "LONG" | "SHORT",
  entryPrice: number,
  currentPrice: number,
  pnlPct: number,
  holdDurationMin: number,
  snapshot: MarketSnapshot,
  funding: number,
  stopLoss: number,
  takeProfit: number,
): string {
  return `You are managing an open ${side} position on ${symbol}.

POSITION:
Side: ${side}
Entry: $${entryPrice.toFixed(2)}
Current: $${currentPrice.toFixed(2)}
PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%
Hold Time: ${holdDurationMin.toFixed(0)} minutes
Stop Loss: -${stopLoss.toFixed(1)}% | Take Profit: +${takeProfit.toFixed(1)}%

CURRENT MARKET:
${buildTFSummary(snapshot.tf5m)}
${buildTFSummary(snapshot.tf15m)}
Funding: ${(funding * 100).toFixed(4)}%
Overall Trend: ${snapshot.overallTrend}

Should this position be closed early, or held?

Rules:
- Close if trend has reversed on 2+ timeframes
- Close if RSI is extreme (>75 for LONG, <25 for SHORT) and profit > 0.5%
- Close if you detect a clear momentum shift
- Keep if the original thesis is intact and trend is favorable

Respond with ONLY JSON:
{
  "action": "HOLD" | "CLOSE",
  "reasoning": "1-2 sentences",
  "urgency": "low" | "medium" | "high"
}`;
}

const aiCache = new Map<string, { decision: ClaudeDecision; ts: number }>();
const AI_CACHE_TTL = 180_000;

function parseClaudeDecision(content: string): ClaudeDecision {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    const validActions = ["OPEN_LONG", "OPEN_SHORT", "HOLD", "CLOSE"];
    const action = validActions.includes(parsed.action) ? parsed.action : "HOLD";
    return {
      action,
      confidence: Math.min(100, Math.max(0, parsed.confidence || 0)),
      reasoning: parsed.reasoning || "No reasoning provided",
      riskAssessment: parsed.riskAssessment || "Unknown risk",
      suggestedStopLoss: Math.max(0.5, Math.min(10, parsed.suggestedStopLoss || 2)),
      suggestedTakeProfit: Math.max(1, Math.min(20, parsed.suggestedTakeProfit || 4)),
      suggestedLeverage: Math.max(2, Math.min(50, parsed.suggestedLeverage || 5)),
      keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors.slice(0, 5) : [],
    };
  } catch {
    return {
      action: "HOLD",
      confidence: 0,
      reasoning: "Failed to parse analysis — defaulting to HOLD for safety",
      riskAssessment: "Parse error",
      suggestedStopLoss: 2,
      suggestedTakeProfit: 4,
      suggestedLeverage: 3,
      keyFactors: ["parse_error"],
    };
  }
}

function parseExitDecision(content: string): { action: "HOLD" | "CLOSE"; reasoning: string; urgency: string } {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    return {
      action: parsed.action === "CLOSE" ? "CLOSE" : "HOLD",
      reasoning: parsed.reasoning || "No reasoning",
      urgency: parsed.urgency || "low",
    };
  } catch {
    return { action: "HOLD", reasoning: "Parse error — holding position", urgency: "low" };
  }
}

async function callClaude(prompt: string, maxTokens: number = 300): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("No analysis key configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.15,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Analysis API ${response.status}: ${errText.substring(0, 100)}`);
  }
  const data = await response.json() as any;
  return data.content?.[0]?.text?.trim() || "";
}

export async function getClaudeTradeDecision(
  snapshot: MarketSnapshot,
  futuresClient: any,
  balance: number,
  riskPct: number,
  maxLeverage: number,
  currentPositions: string[],
  dailyPnl: number,
  dailyLossLimit: number,
  consecutiveLosses: number,
): Promise<ClaudeDecision> {
  const cacheKey = `${snapshot.symbol}-${Math.floor(Date.now() / AI_CACHE_TTL)}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AI_CACHE_TTL) {
    return cached.decision;
  }

  const [funding, imbalance] = await Promise.all([
    getFundingRate(futuresClient, snapshot.symbol),
    getOrderbookImbalance(futuresClient, snapshot.symbol),
  ]);

  const prompt = buildClaudePrompt(
    snapshot, funding, imbalance, balance, riskPct, maxLeverage,
    currentPositions, dailyPnl, dailyLossLimit, consecutiveLosses, tradeMemory,
  );

  const content = await callClaude(prompt, 400);
  const decision = parseClaudeDecision(content);

  decision.suggestedLeverage = Math.min(decision.suggestedLeverage, maxLeverage);

  if (decision.action === "LONG" && decision.suggestedStopLoss <= 0) {
    decision.suggestedStopLoss = 1.5;
  } else if (decision.action === "SHORT" && decision.suggestedStopLoss <= 0) {
    decision.suggestedStopLoss = 1.5;
  }

  if (decision.confidence < 70 && decision.action !== "HOLD") {
    decision.action = "HOLD";
    decision.reasoning = `Confidence ${decision.confidence}% below 70% threshold — ${decision.reasoning}`;
  }

  aiCache.set(cacheKey, { decision, ts: Date.now() });

  if (aiCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of aiCache) {
      if (now - v.ts > AI_CACHE_TTL) aiCache.delete(k);
    }
  }

  console.log(`[Intel] Decision for ${snapshot.symbol}: ${decision.action} (${decision.confidence}%) — ${decision.reasoning.substring(0, 120)}`);
  return decision;
}

export async function getClaudeExitDecision(
  symbol: string,
  side: "LONG" | "SHORT",
  entryPrice: number,
  currentPrice: number,
  pnlPct: number,
  holdDurationMin: number,
  snapshot: MarketSnapshot,
  futuresClient: any,
  stopLoss: number,
  takeProfit: number,
): Promise<{ action: "HOLD" | "CLOSE"; reasoning: string; urgency: string }> {
  const funding = await getFundingRate(futuresClient, symbol);

  const prompt = buildExitPrompt(symbol, side, entryPrice, currentPrice, pnlPct, holdDurationMin, snapshot, funding, stopLoss, takeProfit);
  const content = await callClaude(prompt, 200);
  const decision = parseExitDecision(content);

  console.log(`[Intel] Exit check ${side} ${symbol}: ${decision.action} (${decision.urgency}) — ${decision.reasoning.substring(0, 100)}`);
  return decision;
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
    confidence: 0.5,
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
        intel.rejectReason = `Funding rate ${(funding * 100).toFixed(4)}% too high for LONG`;
      }
    } else {
      intel.fundingFavorable = funding >= config.minFundingRateShort;
      if (!intel.fundingFavorable) {
        intel.rejectReason = `Funding rate ${(funding * 100).toFixed(4)}% too negative for SHORT`;
      }
    }
  }

  if (side === "BUY") {
    intel.orderbookFavorable = imbalance >= config.orderbookImbalanceThreshold;
    if (!intel.orderbookFavorable && !intel.rejectReason) {
      intel.rejectReason = `Orderbook imbalance ${(imbalance * 100).toFixed(1)}% too weak for BUY`;
    }
  } else {
    intel.orderbookFavorable = imbalance <= (1 - config.orderbookImbalanceThreshold);
    if (!intel.orderbookFavorable && !intel.rejectReason) {
      intel.rejectReason = `Orderbook imbalance ${(imbalance * 100).toFixed(1)}% too strong for SELL`;
    }
  }

  return intel;
}

import { ethers } from "ethers";
import { storage } from "./storage";
import { log } from "./index";
import { runInferenceWithFallback } from "./inference";
import {
  fourMemeGetTokenInfo,
  fourMemeBuyToken,
  fourMemeSellToken,
  fourMemeGetTokenBalance,
  type FourMemeTokenInfo,
} from "./token-launcher";

const FOUR_MEME_API = "https://four.meme";
const AI_NETWORKS = ["hyperbolic", "akash", "ritual"];
const AI_MODEL = "deepseek-ai/DeepSeek-V3";

const COPY_TRADE_WALLETS = [
  { address: "0xd59b6a5dc9126ea0ebacd2d8560584b3ce48f62f", label: "GMGN Whale" },
  { address: "0x52e09b0ce502e8e1e7b4d46b10c67b1b2adc3a3a", label: "Smart Money 1" },
  { address: "0x3a0b5541e20cb8789307b8012b1e0e9e5bcd6072", label: "Smart Money 2" },
];
const COPY_TRADE_SCAN_INTERVAL_MS = 20_000;

const SCAN_INTERVAL_MS = 30_000;
const POSITION_CHECK_INTERVAL_MS = 15_000;
const MAX_POSITIONS_PER_USER = 5;
const DEFAULT_BUY_AMOUNT_BNB = "0.1";
const DEFAULT_TAKE_PROFIT = 2.0;
const DEFAULT_STOP_LOSS = 0.7;
const DEFAULT_SLIPPAGE = 15;
const MIN_PROGRESS_FOR_ENTRY = 5;
const MAX_PROGRESS_FOR_ENTRY = 60;
const MIN_WALLET_BALANCE_BNB = 0.15;
const MAX_TOKEN_AGE_SECONDS = 3600;
const TRAILING_STOP_ACTIVATION = 1.3;
const TRAILING_STOP_DISTANCE = 0.15;

interface TradingPosition {
  id: string;
  chatId: number;
  agentId: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  entryPriceBnb: string;
  tokenAmount: string;
  buyTxHash: string;
  entryTime: number;
  takeProfitMultiple: number;
  stopLossMultiple: number;
  status: "open" | "closed_profit" | "closed_loss" | "closed_manual";
  sellTxHash?: string;
  pnlBnb?: string;
  closedAt?: number;
  peakMultiple: number;
  trailingStopActive: boolean;
  confidenceScore: number;
  source: "ai_scan" | "whale_copy" | "consensus" | "manual";
}

interface PriceSnapshot {
  multiple: number;
  timestamp: number;
  progressPercent: number;
}

const priceHistory = new Map<string, PriceSnapshot[]>();
const creatorRugScores = new Map<string, number>();
const whaleConsensus = new Map<string, Set<string>>();

function sanitizeMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

interface TradingConfig {
  enabled: boolean;
  buyAmountBnb: string;
  takeProfitMultiple: number;
  stopLossMultiple: number;
  maxPositions: number;
}

const activePositions = new Map<string, TradingPosition>();
const userTradingConfig = new Map<number, TradingConfig>();
const recentlyScannedTokens = new Set<string>();
const tradeHistory: TradingPosition[] = [];

let scanTimer: ReturnType<typeof setInterval> | null = null;
let positionTimer: ReturnType<typeof setInterval> | null = null;
let copyTradeTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

const lastSeenWhaleTxs = new Map<string, Set<string>>();
const whaleTokensCopied = new Set<string>();
const whaleTokensFailed = new Map<string, number>();
let copyTradeRunning = false;

function getUserConfig(chatId: number): TradingConfig {
  return userTradingConfig.get(chatId) || {
    enabled: false,
    buyAmountBnb: DEFAULT_BUY_AMOUNT_BNB,
    takeProfitMultiple: DEFAULT_TAKE_PROFIT,
    stopLossMultiple: DEFAULT_STOP_LOSS,
    maxPositions: MAX_POSITIONS_PER_USER,
  };
}

export function setUserTradingConfig(chatId: number, config: Partial<TradingConfig>): TradingConfig {
  const current = getUserConfig(chatId);
  const updated = { ...current, ...config };
  userTradingConfig.set(chatId, updated);
  storage.saveTradingPreference(chatId.toString(), updated).catch(e => {
    log(`[TradingAgent] Failed to persist config for ${chatId}: ${e.message}`, "trading");
  });
  return updated;
}

export async function restoreTradingPreferences(): Promise<number> {
  try {
    const prefs = await storage.getEnabledTradingPreferences();
    for (const pref of prefs) {
      const chatId = parseInt(pref.chatId, 10);
      if (isNaN(chatId)) continue;
      userTradingConfig.set(chatId, {
        enabled: true,
        buyAmountBnb: pref.buyAmountBnb,
        takeProfitMultiple: pref.takeProfitMultiple,
        stopLossMultiple: pref.stopLossMultiple,
        maxPositions: pref.maxPositions,
      });
    }
    return prefs.length;
  } catch (e: any) {
    log(`[TradingAgent] Failed to restore preferences: ${e.message}`, "trading");
    return 0;
  }
}

export function getUserTradingStatus(chatId: number): { config: TradingConfig; positions: TradingPosition[]; history: TradingPosition[] } {
  const config = getUserConfig(chatId);
  const positions = Array.from(activePositions.values()).filter(p => p.chatId === chatId && p.status === "open");
  const history = tradeHistory.filter(p => p.chatId === chatId).slice(-20);
  return { config, positions, history };
}

async function fetchNewTokens(): Promise<Array<{ address: string; name: string; symbol: string; launchTime: number }>> {
  try {
    const res = await Promise.race([
      fetch(`${FOUR_MEME_API}/meme-api/v1/public/token/list?pageNum=1&pageSize=20&orderBy=launchTime&direction=desc`, {
        headers: { "Accept": "application/json", "User-Agent": "BUILD4/1.0" },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Four.meme API timeout")), 15000)),
    ]);
    if (!res.ok) {
      const searchRes = await fetch(`${FOUR_MEME_API}/meme-api/v1/public/token/search?keyword=&pageNum=1&pageSize=20`, {
        headers: { "Accept": "application/json", "User-Agent": "BUILD4/1.0" },
      });
      if (!searchRes.ok) return [];
      const searchData = await searchRes.json();
      if (searchData.code !== 0 || !Array.isArray(searchData.data?.records)) return [];
      return searchData.data.records.map((t: any) => ({
        address: t.address || t.tokenAddress,
        name: t.name || t.tokenName,
        symbol: t.symbol || t.tokenSymbol,
        launchTime: t.launchTime || 0,
      })).filter((t: any) => t.address);
    }
    const data = await res.json();
    if (data.code !== 0 || !Array.isArray(data.data?.records)) return [];
    return data.data.records.map((t: any) => ({
      address: t.address || t.tokenAddress,
      name: t.name || t.tokenName,
      symbol: t.symbol || t.tokenSymbol,
      launchTime: t.launchTime || 0,
    })).filter((t: any) => t.address);
  } catch (e: any) {
    log(`[TradingAgent] Token fetch error: ${e.message?.substring(0, 100)}`, "trading");
    return [];
  }
}

interface TokenSignal {
  address: string;
  name: string;
  symbol: string;
  score: number;
  reasons: string[];
  info: FourMemeTokenInfo;
  aiAnalysis?: string;
  aiDecision?: "BUY" | "SKIP";
}

const tradeMemory: Array<{ symbol: string; result: string; pnl: number; reasoning: string }> = [];

function buildTradeMemoryContext(): string {
  if (tradeMemory.length === 0) return "No previous trades yet.";
  const recent = tradeMemory.slice(-10);
  const wins = recent.filter(t => t.pnl > 0).length;
  const losses = recent.filter(t => t.pnl <= 0).length;
  let ctx = `Recent trade history (${wins}W/${losses}L):\n`;
  for (const t of recent) {
    ctx += `  ${t.symbol}: ${t.result} (${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(4)} BNB) — ${t.reasoning}\n`;
  }
  return ctx;
}

async function checkCreatorHistory(tokenAddress: string): Promise<{ rugRisk: number; reasons: string[] }> {
  try {
    const apiKey = process.env.BSCSCAN_API_KEY || "";
    const cachedScore = creatorRugScores.get(tokenAddress);
    if (cachedScore !== undefined) return { rugRisk: cachedScore, reasons: [] };

    const url = `https://api.etherscan.io/v2/api?chainid=56&module=account&action=tokentx&address=${tokenAddress}&page=1&offset=5&sort=desc&apikey=${apiKey}`;
    const res = await Promise.race([
      fetch(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
    ]);
    const data = await res.json();

    let rugRisk = 0;
    const reasons: string[] = [];

    if (data.status === "1" && Array.isArray(data.result)) {
      const txCount = data.result.length;
      if (txCount === 0) {
        rugRisk += 20;
        reasons.push("No creator TX history");
      }
    }

    creatorRugScores.set(tokenAddress, rugRisk);
    if (creatorRugScores.size > 200) {
      const keys = Array.from(creatorRugScores.keys());
      for (let i = 0; i < keys.length - 100; i++) creatorRugScores.delete(keys[i]);
    }

    return { rugRisk, reasons };
  } catch {
    return { rugRisk: 0, reasons: [] };
  }
}

function analyzeMomentum(positionId: string, currentMultiple: number, progressPercent: number): { trend: "accelerating" | "stable" | "decelerating" | "unknown"; velocityChange: number; description: string } {
  const snapshots = priceHistory.get(positionId) || [];
  snapshots.push({ multiple: currentMultiple, timestamp: Date.now(), progressPercent });
  if (snapshots.length > 30) snapshots.splice(0, snapshots.length - 30);
  priceHistory.set(positionId, snapshots);

  if (snapshots.length < 3) return { trend: "unknown", velocityChange: 0, description: "Not enough data" };

  const recent = snapshots.slice(-5);
  const older = snapshots.slice(-10, -5);

  if (older.length < 2) return { trend: "unknown", velocityChange: 0, description: "Warming up" };

  const recentVelocity = (recent[recent.length - 1].multiple - recent[0].multiple) / ((recent[recent.length - 1].timestamp - recent[0].timestamp) / 60000 || 1);
  const olderVelocity = (older[older.length - 1].multiple - older[0].multiple) / ((older[older.length - 1].timestamp - older[0].timestamp) / 60000 || 1);

  const velocityChange = recentVelocity - olderVelocity;

  if (velocityChange > 0.01) return { trend: "accelerating", velocityChange, description: `Momentum rising: ${recentVelocity.toFixed(4)}x/min vs ${olderVelocity.toFixed(4)}x/min` };
  if (velocityChange < -0.01) return { trend: "decelerating", velocityChange, description: `Momentum fading: ${recentVelocity.toFixed(4)}x/min vs ${olderVelocity.toFixed(4)}x/min` };
  return { trend: "stable", velocityChange, description: `Steady: ${recentVelocity.toFixed(4)}x/min` };
}

function calculateDynamicBuyAmount(baseBnb: string, confidenceScore: number, source: string): string {
  const base = parseFloat(baseBnb);
  let multiplier = 1.0;

  if (source === "consensus") {
    multiplier = 1.5;
  } else if (source === "whale_copy") {
    multiplier = 1.3;
  } else if (confidenceScore >= 85) {
    multiplier = 1.4;
  } else if (confidenceScore >= 70) {
    multiplier = 1.0;
  } else if (confidenceScore >= 50) {
    multiplier = 0.7;
  } else {
    multiplier = 0.5;
  }

  const amount = Math.max(0.01, Math.min(base * multiplier, base * 2));
  return amount.toFixed(4);
}

function getWinRate(): { rate: number; total: number } {
  if (tradeMemory.length === 0) return { rate: 0, total: 0 };
  const wins = tradeMemory.filter(t => t.pnl > 0).length;
  return { rate: (wins / tradeMemory.length) * 100, total: tradeMemory.length };
}

async function aiEvaluateBuy(tokens: Array<{ address: string; name: string; symbol: string; launchTime: number; info: FourMemeTokenInfo }>): Promise<TokenSignal | null> {
  if (tokens.length === 0) return null;

  const rugChecks = await Promise.all(tokens.slice(0, 5).map(t => checkCreatorHistory(t.address).catch(() => ({ rugRisk: 0, reasons: [] }))));

  const tokenDataLines = tokens.map((t, i) => {
    const age = Math.floor(Date.now() / 1000) - (t.launchTime || t.info.launchTime);
    const ageMin = Math.floor(age / 60);
    const velocity = age > 0 ? (t.info.progressPercent / (age / 60)).toFixed(2) : "0";
    const rug = i < rugChecks.length ? rugChecks[i] : null;
    const rugLabel = rug && rug.rugRisk > 0 ? ` ⚠️ RUG RISK: ${rug.rugRisk}%` : "";
    const whaleInterest = whaleConsensus.has(t.address.toLowerCase()) ? ` 🐋 WHALE INTEREST (${whaleConsensus.get(t.address.toLowerCase())!.size} wallets)` : "";
    return `${i + 1}. $${t.symbol} (${t.name}) — Curve: ${t.info.progressPercent.toFixed(1)}%, Age: ${ageMin}m, Raised: ${parseFloat(t.info.funds).toFixed(3)} BNB / ${parseFloat(t.info.maxFunds).toFixed(1)} BNB, Velocity: ${velocity}%/min, Price: ${t.info.lastPrice}${rugLabel}${whaleInterest}`;
  }).join("\n");

  const memoryCtx = buildTradeMemoryContext();
  const winRate = getWinRate();

  const prompt = `You are an expert meme token trader on Four.meme (BNB Chain bonding curve platform). Analyze these new tokens and decide which ONE to buy, or NONE if none look good.

TOKENS:
${tokenDataLines}

YOUR PERFORMANCE: ${winRate.total > 0 ? `${winRate.rate.toFixed(0)}% win rate over ${winRate.total} trades` : "No history yet"}

YOUR TRADE MEMORY:
${memoryCtx}

SCORING GUIDE:
- Curve progress: 10-30% is early momentum (best entry), 30-50% is mid (riskier), >50% is late
- Age: Under 10 min = very fresh (higher risk/reward), 10-30 min = ideal, >30 min with low progress = dying
- Velocity (%/min): >1.0 = parabolic, 0.3-1.0 = healthy, <0.3 = sluggish
- Funds raised: More BNB = more real buyers, proves demand is real
- Token name/symbol: Memes with trending themes, clever names, or cultural references attract more buyers. Generic/low-effort names usually fail
- ⚠️ RUG RISK flags = avoid or reduce confidence
- 🐋 WHALE INTEREST = multiple tracked wallets bought this token, very strong signal

DECISION RULES:
1. Which token has the best momentum + lowest risk combination?
2. If your recent win rate is below 40%, be MORE selective (confidence threshold higher)
3. If multiple whales bought the same token, that's the strongest signal
4. Velocity >1%/min with a good name = high conviction play
5. Avoid tokens with RUG RISK flags unless momentum is exceptional
6. SKIP if nothing stands out — waiting for a better setup IS the smart play

RESPOND IN EXACTLY THIS FORMAT:
DECISION: BUY or SKIP
TOKEN: [number from list, or 0 if SKIP]
CONFIDENCE: [1-100]
REASONING: [1-2 sentences explaining your thinking]`;

  try {
    const result = await Promise.race([
      runInferenceWithFallback(AI_NETWORKS, AI_MODEL, prompt, {
        systemPrompt: "You are a sharp, data-driven meme token trader. You analyze on-chain metrics to find profitable entries. Be selective — only buy tokens with strong signals. Respond concisely.",
        temperature: 0.3,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI timeout")), 20000)),
    ]);

    const output = result.text.trim();
    log(`[TradingAgent] AI buy analysis: ${output.substring(0, 200)}`, "trading");

    if (!output || output.includes("[NO_PROVIDER]") || output.length < 10) {
      log(`[TradingAgent] AI response empty/unavailable, falling back to rules`, "trading");
      return fallbackEvaluateTokens(tokens);
    }

    const decisionMatch = output.match(/DECISION:\s*(BUY|SKIP)/i);
    const tokenMatch = output.match(/TOKEN:\s*(\d+)/i);
    const confidenceMatch = output.match(/CONFIDENCE:\s*(\d+)/i);
    const reasoningMatch = output.match(/REASONING:\s*(.+)/i);

    if (!decisionMatch) {
      log(`[TradingAgent] AI response malformed (no DECISION found), falling back to rules`, "trading");
      return fallbackEvaluateTokens(tokens);
    }

    const decision = decisionMatch[1].toUpperCase();
    const tokenIdx = parseInt(tokenMatch?.[1] || "0") - 1;
    const confidence = parseInt(confidenceMatch?.[1] || "0");
    const reasoning = reasoningMatch?.[1]?.trim() || "AI analysis";

    if (decision !== "BUY" || tokenIdx < 0 || tokenIdx >= tokens.length || confidence < 50) {
      log(`[TradingAgent] AI says SKIP (decision=${decision}, confidence=${confidence})`, "trading");
      return null;
    }

    const chosen = tokens[tokenIdx];
    const age = Math.floor(Date.now() / 1000) - (chosen.launchTime || chosen.info.launchTime);
    const velocity = age > 0 ? chosen.info.progressPercent / (age / 60) : 0;

    const reasons: string[] = [
      `AI confidence: ${confidence}%`,
      `Curve: ${chosen.info.progressPercent.toFixed(1)}%`,
      `Age: ${Math.floor(age / 60)}m`,
      `Velocity: ${velocity.toFixed(1)}%/min`,
      `Raised: ${parseFloat(chosen.info.funds).toFixed(3)} BNB`,
    ];

    return {
      address: chosen.address,
      name: chosen.name,
      symbol: chosen.symbol,
      score: confidence,
      reasons,
      info: chosen.info,
      aiAnalysis: reasoning,
      aiDecision: "BUY",
    };
  } catch (e: any) {
    log(`[TradingAgent] AI buy analysis failed, falling back to rules: ${e.message?.substring(0, 100)}`, "trading");
    return fallbackEvaluateTokens(tokens);
  }
}

function fallbackEvaluateTokens(tokens: Array<{ address: string; name: string; symbol: string; launchTime: number; info: FourMemeTokenInfo }>): TokenSignal | null {
  let best: TokenSignal | null = null;

  for (const token of tokens) {
    const info = token.info;
    if (info.liquidityAdded) continue;
    const progress = info.progressPercent;
    if (progress < MIN_PROGRESS_FOR_ENTRY || progress > MAX_PROGRESS_FOR_ENTRY) continue;

    let tokenScore = 0;
    const reasons: string[] = [];

    if (progress >= 10 && progress <= 30) { tokenScore += 40; reasons.push(`Curve: ${progress.toFixed(1)}%`); }
    else if (progress > 30 && progress <= 50) { tokenScore += 25; reasons.push(`Curve: ${progress.toFixed(1)}%`); }
    else { tokenScore += 10; reasons.push(`Curve: ${progress.toFixed(1)}%`); }

    const age = Math.floor(Date.now() / 1000) - (token.launchTime || info.launchTime);
    if (age > MAX_TOKEN_AGE_SECONDS) continue;
    if (age < 600) { tokenScore += 30; reasons.push(`${Math.floor(age / 60)}m old`); }
    else if (age < 1800) { tokenScore += 20; reasons.push(`${Math.floor(age / 60)}m old`); }
    else { tokenScore += 10; reasons.push(`${Math.floor(age / 60)}m old`); }

    const fundsNum = parseFloat(info.funds);
    if (fundsNum >= 1.0) { tokenScore += 20; reasons.push(`${fundsNum.toFixed(2)} BNB raised`); }
    else if (fundsNum >= 0.3) { tokenScore += 10; reasons.push(`${fundsNum.toFixed(2)} BNB raised`); }

    if (progress > 0 && age > 0) {
      const v = progress / (age / 60);
      if (v > 1.0) { tokenScore += 20; reasons.push(`${v.toFixed(1)}%/min velocity`); }
      else if (v > 0.3) { tokenScore += 10; reasons.push(`${v.toFixed(1)}%/min velocity`); }
    }

    const normalizedScore = Math.min(100, Math.round((tokenScore / 110) * 100));

    if (tokenScore >= 40 && (!best || tokenScore > best.score)) {
      best = { address: token.address, name: token.name, symbol: token.symbol, score: normalizedScore, reasons, info };
    }
  }

  return best;
}

async function aiEvaluateSell(position: TradingPosition, info: FourMemeTokenInfo, multiple: number, ageMinutes: number, momentum?: { trend: string; velocityChange: number; description: string }): Promise<{ decision: "HOLD" | "SELL"; reasoning: string }> {
  const memoryCtx = buildTradeMemoryContext();
  const velocity = info.progressPercent > 0 && ageMinutes > 0 ? (info.progressPercent / ageMinutes).toFixed(2) : "unknown";
  const fundsRaised = parseFloat(info.funds).toFixed(3);
  const maxFunds = parseFloat(info.maxFunds).toFixed(1);
  const pnlPct = ((multiple - 1) * 100).toFixed(1);
  const winRate = getWinRate();

  const prompt = `You are managing an open meme token position. Decide whether to HOLD or SELL.

POSITION:
- Token: $${position.tokenSymbol}
- Entry: ${position.entryPriceBnb} BNB
- Current multiple: ${multiple.toFixed(3)}x (${pnlPct}% PnL)
- Peak multiple: ${position.peakMultiple.toFixed(3)}x
- Drawdown from peak: ${position.peakMultiple > 0 ? ((1 - multiple / position.peakMultiple) * 100).toFixed(1) : "0.0"}%
- Hold time: ${ageMinutes.toFixed(0)} minutes
- Source: ${position.source} (confidence: ${position.confidenceScore}%)
- Trailing stop: ${position.trailingStopActive ? `ACTIVE (triggers at ${(position.peakMultiple * (1 - TRAILING_STOP_DISTANCE)).toFixed(2)}x)` : "inactive"}

CURRENT TOKEN STATE:
- Curve progress: ${info.progressPercent.toFixed(1)}% (of ${maxFunds} BNB)
- Current velocity: ${velocity}%/min
- Funds raised: ${fundsRaised} BNB
- Liquidity added (graduated to DEX): ${info.liquidityAdded}

MOMENTUM ANALYSIS:
- Trend: ${momentum?.trend || "unknown"}
- Detail: ${momentum?.description || "No data yet"}

RISK TARGETS:
- Take-profit target: ${position.takeProfitMultiple}x
- Stop-loss target: ${((1 - position.stopLossMultiple) * 100).toFixed(0)}% loss

OVERALL PERFORMANCE: ${winRate.total > 0 ? `${winRate.rate.toFixed(0)}% win rate over ${winRate.total} trades` : "No history yet"}

YOUR TRADE MEMORY:
${memoryCtx}

DECISION FRAMEWORK:
1. Momentum ACCELERATING + profitable = HOLD (let winners run)
2. Momentum DECELERATING + profitable = consider SELL (lock in gains before reversal)
3. Momentum DECELERATING + losing = SELL (cut losses fast)
4. Near TP target + accelerating = HOLD (could go higher)
5. Significant drawdown from peak (>15%) + decelerating = SELL
6. Whale/consensus trades: give more patience, these have stronger conviction
7. If overall win rate is low, be more aggressive about taking profits early

RESPOND IN EXACTLY THIS FORMAT:
DECISION: HOLD or SELL
REASONING: [1-2 sentences]`;

  try {
    const result = await Promise.race([
      runInferenceWithFallback(AI_NETWORKS, AI_MODEL, prompt, {
        systemPrompt: "You are a disciplined crypto trader managing live positions. Protect capital, take profits when momentum fades, let winners run when momentum is strong. Be decisive.",
        temperature: 0.2,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI timeout")), 15000)),
    ]);

    const output = result.text.trim();
    log(`[TradingAgent] AI sell analysis for ${position.tokenSymbol}: ${output.substring(0, 200)}`, "trading");

    if (!output || output.includes("[NO_PROVIDER]") || output.length < 10) {
      log(`[TradingAgent] AI sell response unavailable, using rules`, "trading");
      if (multiple >= position.takeProfitMultiple) return { decision: "SELL", reasoning: "Hit take-profit target (fallback)" };
      if (multiple <= position.stopLossMultiple) return { decision: "SELL", reasoning: "Hit stop-loss target (fallback)" };
      return { decision: "HOLD", reasoning: "Within TP/SL range (fallback)" };
    }

    const decisionMatch = output.match(/DECISION:\s*(HOLD|SELL)/i);
    const reasoningMatch = output.match(/REASONING:\s*(.+)/i);

    if (!decisionMatch) {
      if (multiple >= position.takeProfitMultiple) return { decision: "SELL", reasoning: "Hit take-profit target (AI malformed)" };
      if (multiple <= position.stopLossMultiple) return { decision: "SELL", reasoning: "Hit stop-loss target (AI malformed)" };
      return { decision: "HOLD", reasoning: "AI response malformed, holding" };
    }

    return {
      decision: decisionMatch[1].toUpperCase() === "SELL" ? "SELL" : "HOLD",
      reasoning: reasoningMatch?.[1]?.trim() || "AI decision",
    };
  } catch (e: any) {
    log(`[TradingAgent] AI sell analysis failed, using rules: ${e.message?.substring(0, 80)}`, "trading");
    if (multiple >= position.takeProfitMultiple) return { decision: "SELL", reasoning: "Hit take-profit target" };
    if (multiple <= position.stopLossMultiple) return { decision: "SELL", reasoning: "Hit stop-loss target" };
    return { decision: "HOLD", reasoning: "Rules: within TP/SL range" };
  }
}

async function executeBuy(chatId: number, agentId: string, signal: TokenSignal, privateKey: string, walletAddress: string, source: "ai_scan" | "whale_copy" | "consensus" = "ai_scan"): Promise<TradingPosition | null> {
  const config = getUserConfig(chatId);
  const positionId = `trade_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const dynamicAmount = calculateDynamicBuyAmount(config.buyAmountBnb, signal.score, source);

  try {
    log(`[TradingAgent] Buying ${signal.symbol} for ${dynamicAmount} BNB (confidence: ${signal.score}, source: ${source})`, "trading");

    const result = await fourMemeBuyToken(signal.address, dynamicAmount, DEFAULT_SLIPPAGE, privateKey);

    if (!result.success) {
      log(`[TradingAgent] Buy failed for ${signal.symbol}: ${result.error}`, "trading");
      return null;
    }

    let tokenBalance = "0";
    try {
      await new Promise(r => setTimeout(r, 3000));
      const bal = await fourMemeGetTokenBalance(signal.address, walletAddress);
      tokenBalance = bal.balance;
    } catch {}

    const position: TradingPosition = {
      id: positionId,
      chatId,
      agentId,
      walletAddress,
      tokenAddress: signal.address,
      tokenSymbol: signal.symbol,
      entryPriceBnb: dynamicAmount,
      tokenAmount: tokenBalance,
      buyTxHash: result.txHash || "",
      entryTime: Date.now(),
      takeProfitMultiple: config.takeProfitMultiple,
      stopLossMultiple: config.stopLossMultiple,
      status: "open",
      peakMultiple: 1.0,
      trailingStopActive: false,
      confidenceScore: signal.score,
      source,
    };

    activePositions.set(positionId, position);

    log(`[TradingAgent] Position opened: ${signal.symbol} | ${tokenBalance} tokens for ${config.buyAmountBnb} BNB | TX: ${result.txHash}`, "trading");

    return position;
  } catch (e: any) {
    log(`[TradingAgent] Buy execution error: ${e.message?.substring(0, 200)}`, "trading");
    return null;
  }
}

async function checkAndClosePositions(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  for (const [posId, position] of activePositions.entries()) {
    if (position.status !== "open") continue;

    try {
      const info = await fourMemeGetTokenInfo(position.tokenAddress);
      const currentPrice = parseFloat(info.lastPrice);
      let tokenAmountNum = parseFloat(position.tokenAmount);

      if (tokenAmountNum <= 0) {
        try {
          const bal = await fourMemeGetTokenBalance(position.tokenAddress, position.walletAddress);
          position.tokenAmount = bal.balance;
          tokenAmountNum = parseFloat(bal.balance);
        } catch {}
        if (tokenAmountNum <= 0) continue;
      }

      const currentValueBnb = currentPrice * tokenAmountNum;
      const entryBnb = parseFloat(position.entryPriceBnb);
      const multiple = entryBnb > 0 ? currentValueBnb / entryBnb : 0;
      const ageMinutes = (Date.now() - position.entryTime) / 60000;

      if (multiple > position.peakMultiple) {
        position.peakMultiple = multiple;
      }

      if (!position.trailingStopActive && multiple >= TRAILING_STOP_ACTIVATION) {
        position.trailingStopActive = true;
        log(`[TradingAgent] ${position.tokenSymbol} trailing stop activated at ${multiple.toFixed(2)}x (peak: ${position.peakMultiple.toFixed(2)}x)`, "trading");
      }

      const momentum = analyzeMomentum(posId, multiple, info.progressPercent);

      if (info.liquidityAdded) {
        log(`[TradingAgent] ${position.tokenSymbol} graduated to DEX — selling at ${multiple.toFixed(2)}x`, "trading");
        await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb, "Token graduated to DEX — auto-sell");
        continue;
      }

      if (position.trailingStopActive) {
        const trailingStopLevel = position.peakMultiple * (1 - TRAILING_STOP_DISTANCE);
        if (multiple <= trailingStopLevel) {
          log(`[TradingAgent] ${position.tokenSymbol} trailing stop hit: ${multiple.toFixed(2)}x (peak: ${position.peakMultiple.toFixed(2)}x, trail: ${trailingStopLevel.toFixed(2)}x)`, "trading");
          await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb, `Trailing stop: dropped from ${position.peakMultiple.toFixed(2)}x peak to ${multiple.toFixed(2)}x`);
          continue;
        }
      }

      if (multiple >= position.takeProfitMultiple * 1.5) {
        log(`[TradingAgent] ${position.tokenSymbol} hard TP at ${multiple.toFixed(2)}x — selling`, "trading");
        await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb, "Exceeded 1.5x take-profit target");
        continue;
      }

      if (multiple <= position.stopLossMultiple * 0.8) {
        log(`[TradingAgent] ${position.tokenSymbol} hard SL at ${multiple.toFixed(2)}x — selling`, "trading");
        await closePosition(position, "closed_loss", notifyFn, multiple, currentValueBnb, "Exceeded stop-loss safety limit");
        continue;
      }

      if (ageMinutes > 120 && multiple < 1.1) {
        log(`[TradingAgent] ${position.tokenSymbol} stale (${ageMinutes.toFixed(0)}m, ${multiple.toFixed(2)}x) — closing`, "trading");
        await closePosition(position, multiple >= 1 ? "closed_profit" : "closed_loss", notifyFn, multiple, currentValueBnb, "Stale position — no momentum after 2h");
        continue;
      }

      const aiSell = await aiEvaluateSell(position, info, multiple, ageMinutes, momentum);
      log(`[TradingAgent] AI says ${aiSell.decision} for ${position.tokenSymbol}: ${aiSell.reasoning}`, "trading");

      if (aiSell.decision === "SELL") {
        const reason = multiple >= 1 ? "closed_profit" : "closed_loss";
        await closePosition(position, reason, notifyFn, multiple, currentValueBnb, aiSell.reasoning);
        continue;
      }
    } catch (e: any) {
      log(`[TradingAgent] Position check error for ${position.tokenSymbol}: ${e.message?.substring(0, 100)}`, "trading");
    }
  }
}

async function closePosition(
  position: TradingPosition,
  reason: "closed_profit" | "closed_loss" | "closed_manual",
  notifyFn: (chatId: number, message: string) => void,
  multiple: number,
  currentValueBnb: number,
  aiReasoning?: string,
): Promise<void> {
  try {
    const chatIdStr = position.chatId.toString();
    const pk = await storage.getTelegramWalletPrivateKey(chatIdStr, position.walletAddress);

    if (!pk) {
      log(`[TradingAgent] Cannot close ${position.tokenSymbol} — no wallet key for ${position.walletAddress}`, "trading");
      return;
    }

    let sellAmount = position.tokenAmount;
    if (parseFloat(sellAmount) <= 0) {
      try {
        const bal = await fourMemeGetTokenBalance(position.tokenAddress, position.walletAddress);
        sellAmount = bal.balance;
        position.tokenAmount = sellAmount;
      } catch {}
    }

    if (parseFloat(sellAmount) <= 0) {
      log(`[TradingAgent] Cannot close ${position.tokenSymbol} — zero balance`, "trading");
      activePositions.delete(position.id);
      return;
    }

    const sellResult = await fourMemeSellToken(position.tokenAddress, sellAmount, pk);

    position.status = reason;
    position.closedAt = Date.now();
    position.sellTxHash = sellResult.txHash;

    const entryBnb = parseFloat(position.entryPriceBnb);
    const pnl = currentValueBnb - entryBnb;
    position.pnlBnb = pnl.toFixed(6);

    activePositions.delete(position.id);
    priceHistory.delete(position.id);
    tradeHistory.push(position);

    tradeMemory.push({
      symbol: position.tokenSymbol,
      result: reason === "closed_profit" ? "WIN" : "LOSS",
      pnl,
      reasoning: aiReasoning || reason,
    });
    if (tradeMemory.length > 20) tradeMemory.splice(0, tradeMemory.length - 20);

    const emoji = reason === "closed_profit" ? "💰" : "📉";
    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4);
    const holdTime = Math.floor((Date.now() - position.entryTime) / 60000);

    let msg = `${emoji} TRADE CLOSED: $${position.tokenSymbol}\n\n`;
    msg += `Entry: ${position.entryPriceBnb} BNB\n`;
    msg += `Exit: ~${currentValueBnb.toFixed(4)} BNB\n`;
    msg += `PnL: ${pnlStr} BNB (${multiple.toFixed(2)}x)\n`;
    msg += `Peak: ${position.peakMultiple.toFixed(2)}x | Hold: ${holdTime}m\n`;
    msg += `Source: ${position.source} | Confidence: ${position.confidenceScore}%\n`;
    if (aiReasoning) msg += `🧠 AI: ${aiReasoning}\n`;
    if (sellResult.txHash) msg += `TX: https://bscscan.com/tx/${sellResult.txHash}`;

    if (!sellResult.success) {
      msg += `\n⚠️ Sell TX may have failed: ${sellResult.error?.substring(0, 100)}`;
    }

    notifyFn(position.chatId, msg);
  } catch (e: any) {
    log(`[TradingAgent] Close position error: ${e.message?.substring(0, 200)}`, "trading");
  }
}

export async function manualClosePosition(positionId: string, notifyFn: (chatId: number, message: string) => void): Promise<boolean> {
  const position = activePositions.get(positionId);
  if (!position || position.status !== "open") return false;

  try {
    const info = await fourMemeGetTokenInfo(position.tokenAddress);
    const currentPrice = parseFloat(info.lastPrice);
    const tokenAmountNum = parseFloat(position.tokenAmount);
    const currentValueBnb = currentPrice * tokenAmountNum;
    const entryBnb = parseFloat(position.entryPriceBnb);
    const multiple = entryBnb > 0 ? currentValueBnb / entryBnb : 0;
    await closePosition(position, "closed_manual", notifyFn, multiple, currentValueBnb);
    return true;
  } catch {
    return false;
  }
}

async function scanAndTrade(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  const enabledCount = Array.from(userTradingConfig.values()).filter(c => c.enabled).length;
  if (enabledCount === 0) return;

  log(`[TradingAgent] Scan cycle — ${enabledCount} users enabled`, "trading");

  const enabledUsers: Array<{ chatId: number; agentId: string; privateKey: string; walletAddress: string }> = [];

  for (const [chatId, config] of userTradingConfig.entries()) {
    if (!config.enabled) continue;

    const openCount = Array.from(activePositions.values()).filter(p => p.chatId === chatId && p.status === "open").length;
    if (openCount >= config.maxPositions) {
      log(`[TradingAgent] User ${chatId} at max positions (${openCount}/${config.maxPositions})`, "trading");
      continue;
    }

    try {
      const chatIdStr = chatId.toString();
      const wallets = await storage.getTelegramWallets(chatIdStr);
      if (wallets.length === 0) {
        log(`[TradingAgent] User ${chatId} has no wallets`, "trading");
        continue;
      }

      const activeWallet = wallets.find(w => w.isActive) || wallets[0];
      const pk = await storage.getTelegramWalletPrivateKey(chatIdStr, activeWallet.walletAddress);
      if (!pk) {
        log(`[TradingAgent] User ${chatId} wallet has no private key`, "trading");
        continue;
      }

      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const balance = await Promise.race([
        provider.getBalance(activeWallet.walletAddress),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 15000)),
      ]);
      const balBnb = parseFloat(ethers.formatEther(balance));
      if (balBnb < MIN_WALLET_BALANCE_BNB) {
        log(`[TradingAgent] User ${chatId} low balance: ${balBnb.toFixed(4)} BNB (need ${MIN_WALLET_BALANCE_BNB})`, "trading");
        continue;
      }

      const agents = await storage.getAgentsByOwner(chatIdStr);
      const agentId = agents.length > 0 ? agents[0].id : "auto-trader";

      enabledUsers.push({ chatId, agentId, privateKey: pk, walletAddress: activeWallet.walletAddress });
      log(`[TradingAgent] User ${chatId} ready to trade (${balBnb.toFixed(4)} BNB)`, "trading");
    } catch (e: any) {
      log(`[TradingAgent] User ${chatId} setup error: ${e.message?.substring(0, 100)}`, "trading");
    }
  }

  if (enabledUsers.length === 0) {
    log(`[TradingAgent] No users ready to trade this cycle`, "trading");
    return;
  }

  const tokens = await fetchNewTokens();
  if (tokens.length === 0) {
    log(`[TradingAgent] No tokens fetched from Four.meme`, "trading");
    return;
  }
  log(`[TradingAgent] Fetched ${tokens.length} tokens from Four.meme`, "trading");

  const newTokens = tokens.filter(t => !recentlyScannedTokens.has(t.address));
  for (const t of tokens) recentlyScannedTokens.add(t.address);

  if (recentlyScannedTokens.size > 500) {
    const arr = Array.from(recentlyScannedTokens);
    for (let i = 0; i < arr.length - 200; i++) recentlyScannedTokens.delete(arr[i]);
  }

  const candidatesWithInfo: Array<{ address: string; name: string; symbol: string; launchTime: number; info: FourMemeTokenInfo }> = [];
  for (const token of newTokens.slice(0, 10)) {
    try {
      const info = await fourMemeGetTokenInfo(token.address);
      if (info.liquidityAdded) continue;
      if (info.progressPercent < MIN_PROGRESS_FOR_ENTRY || info.progressPercent > MAX_PROGRESS_FOR_ENTRY) continue;
      const age = Math.floor(Date.now() / 1000) - (token.launchTime || info.launchTime);
      if (age > MAX_TOKEN_AGE_SECONDS) continue;
      candidatesWithInfo.push({ ...token, info });
    } catch {}
  }

  if (candidatesWithInfo.length === 0) {
    log(`[TradingAgent] No viable candidates after filtering (${newTokens.length} new tokens checked)`, "trading");
    return;
  }

  log(`[TradingAgent] ${candidatesWithInfo.length} candidates for AI evaluation`, "trading");

  const bestSignal = await aiEvaluateBuy(candidatesWithInfo);
  if (!bestSignal) return;

  log(`[TradingAgent] AI picked: ${bestSignal.symbol} (confidence: ${bestSignal.score}) — ${bestSignal.aiAnalysis || bestSignal.reasons.join(", ")}`, "trading");

  for (const user of enabledUsers) {
    const openCount = Array.from(activePositions.values()).filter(p => p.chatId === user.chatId && p.status === "open").length;
    const config = getUserConfig(user.chatId);
    if (openCount >= config.maxPositions) continue;

    const alreadyHolding = Array.from(activePositions.values()).some(
      p => p.chatId === user.chatId && p.tokenAddress === bestSignal.address && p.status === "open"
    );
    if (alreadyHolding) continue;

    const position = await executeBuy(user.chatId, user.agentId, bestSignal, user.privateKey, user.walletAddress, "ai_scan");
    if (position) {
      let msg = `🤖 AI TRADE: Bought $${bestSignal.symbol}\n\n`;
      msg += `Amount: ${position.entryPriceBnb} BNB (dynamic sizing)\n`;
      msg += `Confidence: ${bestSignal.score}%\n`;
      if (bestSignal.aiAnalysis) msg += `🧠 AI: ${bestSignal.aiAnalysis}\n\n`;
      msg += `Signals:\n`;
      bestSignal.reasons.forEach(r => msg += `  • ${r}\n`);
      msg += `\nTP: ${config.takeProfitMultiple}x | SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
      if (position.buyTxHash) msg += `TX: https://bscscan.com/tx/${position.buyTxHash}`;

      notifyFn(user.chatId, msg);
    }
  }
}

async function fetchWhaleTokenBuys(walletAddress: string): Promise<Array<{ tokenAddress: string; tokenSymbol: string; tokenName: string; txHash: string; value: string; timeStamp: number }>> {
  try {
    const apiKey = process.env.BSCSCAN_API_KEY || "";
    const walletLower = walletAddress.toLowerCase();
    const url = `https://api.etherscan.io/v2/api?chainid=56&module=account&action=tokentx&address=${walletAddress}&page=1&offset=50&sort=desc&apikey=${apiKey}`;

    const res = await Promise.race([
      fetch(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("BSCScan timeout")), 15000)),
    ]);

    const data = await res.json();
    if (data.status !== "1" || !Array.isArray(data.result)) return [];

    const incomingTokens = data.result.filter((tx: any) => tx.to?.toLowerCase() === walletLower);
    const outgoingTokens = data.result.filter((tx: any) => tx.from?.toLowerCase() === walletLower);
    const outgoingWBNB = new Set(
      outgoingTokens
        .filter((tx: any) => tx.tokenSymbol === "WBNB" || tx.contractAddress?.toLowerCase() === "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c")
        .map((tx: any) => tx.hash)
    );

    return incomingTokens
      .filter((tx: any) => {
        if (tx.from?.toLowerCase() === "0x0000000000000000000000000000000000000000") return false;
        if (tx.tokenSymbol === "WBNB") return false;
        const hasOutgoingBnbSameTx = outgoingWBNB.has(tx.hash);
        const fromRouter = tx.from?.toLowerCase() !== walletLower;
        return hasOutgoingBnbSameTx || fromRouter;
      })
      .map((tx: any) => ({
        tokenAddress: tx.contractAddress?.toLowerCase(),
        tokenSymbol: tx.tokenSymbol || "UNKNOWN",
        tokenName: tx.tokenName || "Unknown",
        txHash: tx.hash,
        value: tx.value || "0",
        timeStamp: parseInt(tx.timeStamp || "0"),
      }))
      .filter((tx: any) => tx.tokenAddress);
  } catch (e: any) {
    log(`[CopyTrade] BSCScan fetch error: ${e.message?.substring(0, 100)}`, "trading");
    return [];
  }
}

async function copyTradeFromWhales(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  if (copyTradeRunning) return;
  copyTradeRunning = true;

  try {
    await _copyTradeFromWhalesInner(notifyFn);
  } finally {
    copyTradeRunning = false;
  }
}

async function _copyTradeFromWhalesInner(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  const enabledUsers: Array<{ chatId: number; agentId: string; privateKey: string; walletAddress: string }> = [];

  for (const [chatId, config] of userTradingConfig.entries()) {
    if (!config.enabled) continue;
    const openCount = Array.from(activePositions.values()).filter(p => p.chatId === chatId && p.status === "open").length;
    if (openCount >= config.maxPositions) continue;

    try {
      const chatIdStr = chatId.toString();
      const wallets = await storage.getTelegramWallets(chatIdStr);
      if (wallets.length === 0) continue;
      const activeWallet = wallets.find(w => w.isActive) || wallets[0];
      const pk = await storage.getTelegramWalletPrivateKey(chatIdStr, activeWallet.walletAddress);
      if (!pk) continue;

      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const balance = await Promise.race([
        provider.getBalance(activeWallet.walletAddress),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 15000)),
      ]);
      const balBnb = parseFloat(ethers.formatEther(balance));
      if (balBnb < MIN_WALLET_BALANCE_BNB) continue;

      const agents = await storage.getAgentsByOwner(chatIdStr);
      const agentId = agents.length > 0 ? agents[0].id : "auto-trader";
      enabledUsers.push({ chatId, agentId, privateKey: pk, walletAddress: activeWallet.walletAddress });
    } catch {}
  }

  if (enabledUsers.length === 0) return;

  for (const whale of COPY_TRADE_WALLETS) {
    const whaleLower = whale.address.toLowerCase();
    if (!lastSeenWhaleTxs.has(whaleLower)) {
      const initialTxs = await fetchWhaleTokenBuys(whaleLower);
      const initialSet = new Set(initialTxs.map(tx => tx.txHash));
      lastSeenWhaleTxs.set(whaleLower, initialSet);
      log(`[CopyTrade] Initialized ${whale.label} tracker with ${initialSet.size} existing TXs`, "trading");
      continue;
    }

    const recentBuys = await fetchWhaleTokenBuys(whaleLower);
    if (recentBuys.length === 0) continue;

    const seenTxs = lastSeenWhaleTxs.get(whaleLower)!;
    const newBuys = recentBuys.filter(tx => !seenTxs.has(tx.txHash));

    for (const tx of recentBuys) seenTxs.add(tx.txHash);
    if (seenTxs.size > 500) {
      const arr = Array.from(seenTxs);
      for (let i = 0; i < arr.length - 300; i++) seenTxs.delete(arr[i]);
    }

    if (newBuys.length === 0) continue;

    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
    const freshBuys = newBuys.filter(tx => tx.timeStamp > fiveMinAgo);
    if (freshBuys.length === 0) continue;

    const uniqueTokens = new Map<string, typeof freshBuys[0]>();
    for (const buy of freshBuys) {
      if (!uniqueTokens.has(buy.tokenAddress) && !whaleTokensCopied.has(buy.tokenAddress)) {
        uniqueTokens.set(buy.tokenAddress, buy);
      }
    }

    for (const [tokenAddr, buy] of uniqueTokens) {
      log(`[CopyTrade] ${whale.label} bought $${buy.tokenSymbol} (${tokenAddr}) — copying!`, "trading");

      if (whaleTokensCopied.has(tokenAddr)) continue;

      let info: FourMemeTokenInfo;
      try {
        info = await fourMemeGetTokenInfo(tokenAddr);
      } catch {
        const failCount = (whaleTokensFailed.get(tokenAddr) || 0) + 1;
        whaleTokensFailed.set(tokenAddr, failCount);
        if (failCount >= 3) {
          log(`[CopyTrade] ${buy.tokenSymbol} failed 3x — not on Four.meme, skipping permanently`, "trading");
          whaleTokensCopied.add(tokenAddr);
          whaleTokensFailed.delete(tokenAddr);
        } else {
          log(`[CopyTrade] ${buy.tokenSymbol} info fetch failed (attempt ${failCount}/3) — will retry`, "trading");
        }
        continue;
      }

      whaleTokensFailed.delete(tokenAddr);

      if (info.liquidityAdded) {
        log(`[CopyTrade] ${buy.tokenSymbol} already graduated to DEX — skipping`, "trading");
        whaleTokensCopied.add(tokenAddr);
        continue;
      }

      if (!whaleConsensus.has(tokenAddr)) whaleConsensus.set(tokenAddr, new Set());
      whaleConsensus.get(tokenAddr)!.add(whale.label);
      const consensusCount = whaleConsensus.get(tokenAddr)!.size;
      const isConsensus = consensusCount >= 2;
      const tradeSource = isConsensus ? "consensus" as const : "whale_copy" as const;

      whaleTokensCopied.add(tokenAddr);

      const confidenceBase = isConsensus ? 95 : 85;
      const signal: TokenSignal = {
        address: tokenAddr,
        name: buy.tokenName,
        symbol: buy.tokenSymbol,
        score: confidenceBase,
        reasons: [
          isConsensus ? `🔥 CONSENSUS: ${consensusCount} whales bought` : `🐋 ${whale.label} copy trade`,
          `Curve: ${info.progressPercent.toFixed(1)}%`,
          `Raised: ${parseFloat(info.funds).toFixed(3)} BNB`,
        ],
        info,
        aiAnalysis: isConsensus
          ? `${consensusCount} tracked wallets bought the same token — high conviction consensus signal.`
          : `Copying ${whale.label} — this wallet's buys historically pump.`,
        aiDecision: "BUY",
      };

      for (const user of enabledUsers) {
        const openCount = Array.from(activePositions.values()).filter(p => p.chatId === user.chatId && p.status === "open").length;
        const config = getUserConfig(user.chatId);
        if (openCount >= config.maxPositions) continue;

        const alreadyHolding = Array.from(activePositions.values()).some(
          p => p.chatId === user.chatId && p.tokenAddress === tokenAddr && p.status === "open"
        );
        if (alreadyHolding) continue;

        const position = await executeBuy(user.chatId, user.agentId, signal, user.privateKey, user.walletAddress, tradeSource);
        if (position) {
          const emoji = isConsensus ? "🔥" : "🐋";
          const label = isConsensus ? `CONSENSUS TRADE (${consensusCount} whales)` : `COPY TRADE: ${whale.label}`;
          let msg = `${emoji} ${label}: $${buy.tokenSymbol}!\n\n`;
          msg += `Amount: ${position.entryPriceBnb} BNB (dynamic sizing)\n`;
          msg += `Whale TX: https://bscscan.com/tx/${buy.txHash}\n`;
          msg += `Curve: ${info.progressPercent.toFixed(1)}% | Raised: ${parseFloat(info.funds).toFixed(3)} BNB\n`;
          msg += `\nTP: ${config.takeProfitMultiple}x | SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
          if (position.buyTxHash) msg += `Your TX: https://bscscan.com/tx/${position.buyTxHash}`;
          notifyFn(user.chatId, msg);
        }
      }
    }
  }

  if (whaleTokensCopied.size > 200) {
    const arr = Array.from(whaleTokensCopied);
    for (let i = 0; i < arr.length - 100; i++) whaleTokensCopied.delete(arr[i]);
  }

  if (whaleConsensus.size > 200) {
    const keys = Array.from(whaleConsensus.keys());
    for (let i = 0; i < keys.length - 100; i++) whaleConsensus.delete(keys[i]);
  }
}

let notifyCallback: ((chatId: number, message: string) => void) | null = null;

export function startTradingAgent(notifyFn: (chatId: number, message: string) => void): void {
  if (running) return;
  running = true;
  notifyCallback = notifyFn;

  log("[TradingAgent] Starting autonomous trading agent", "trading");

  scanTimer = setInterval(() => {
    scanAndTrade(notifyFn).catch(e => log(`[TradingAgent] Scan error: ${e.message?.substring(0, 100)}`, "trading"));
  }, SCAN_INTERVAL_MS);

  positionTimer = setInterval(() => {
    checkAndClosePositions(notifyFn).catch(e => log(`[TradingAgent] Position check error: ${e.message?.substring(0, 100)}`, "trading"));
  }, POSITION_CHECK_INTERVAL_MS);

  copyTradeTimer = setInterval(() => {
    copyTradeFromWhales(notifyFn).catch(e => log(`[CopyTrade] Error: ${e.message?.substring(0, 100)}`, "trading"));
  }, COPY_TRADE_SCAN_INTERVAL_MS);

  log(`[CopyTrade] Whale copy-trading active — tracking ${COPY_TRADE_WALLETS.map(w => w.label).join(", ")}`, "trading");
}

export function stopTradingAgent(): void {
  if (scanTimer) clearInterval(scanTimer);
  if (positionTimer) clearInterval(positionTimer);
  if (copyTradeTimer) clearInterval(copyTradeTimer);
  scanTimer = null;
  positionTimer = null;
  copyTradeTimer = null;
  running = false;
  log("[TradingAgent] Stopped", "trading");
}

export function isTradingAgentRunning(): boolean {
  return running;
}

export function getActivePositionsForUser(chatId: number): TradingPosition[] {
  return Array.from(activePositions.values()).filter(p => p.chatId === chatId && p.status === "open");
}

export function getTradeHistoryForUser(chatId: number): TradingPosition[] {
  return tradeHistory.filter(p => p.chatId === chatId).slice(-20);
}

export function getAllActivePositions(): TradingPosition[] {
  return Array.from(activePositions.values()).filter(p => p.status === "open");
}

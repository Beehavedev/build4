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
import {
  createAsterFuturesClient,
  type AsterFuturesClient,
  type AsterTicker,
  type AsterFundingRate,
  type AsterPosition,
} from "./aster-client";

const FOUR_MEME_API = "https://four.meme";
const AI_NETWORKS = ["hyperbolic", "akash", "ritual"];
const AI_MODEL = "deepseek-ai/DeepSeek-V3";

const COPY_TRADE_WALLETS = [
  { address: "0xd59b6a5dc9126ea0ebacd2d8560584b3ce48f62f", label: "GMGN Whale" },
  { address: "0x52e09b0ce502e8e1e7b4d46b10c67b1b2adc3a3a", label: "Smart Money 1" },
  { address: "0x3a0b5541e20cb8789307b8012b1e0e9e5bcd6072", label: "Smart Money 2" },
];

const SCAN_INTERVAL_MS = 15_000;
const POSITION_CHECK_INTERVAL_MS = 10_000;
const COPY_TRADE_SCAN_INTERVAL_MS = 15_000;
const MAX_POSITIONS_PER_USER = 5;
const DEFAULT_BUY_AMOUNT_BNB = "0.1";
const DEFAULT_TAKE_PROFIT = 2.0;
const DEFAULT_STOP_LOSS = 0.7;
const DEFAULT_SLIPPAGE = 15;
const MIN_PROGRESS_FOR_ENTRY = 3;
const MAX_PROGRESS_FOR_ENTRY = 65;
const MIN_WALLET_BALANCE_BNB = 0.15;
const MAX_TOKEN_AGE_SECONDS = 3600;
const TRAILING_STOP_ACTIVATION = 1.25;
const TRAILING_STOP_DISTANCE = 0.12;

const ASTER_SCAN_INTERVAL_MS = 45_000;
const ASTER_POSITION_CHECK_INTERVAL_MS = 20_000;
const ASTER_DEFAULT_LEVERAGE = 5;
const ASTER_DEFAULT_MARGIN_TYPE = "CROSSED" as const;
const ASTER_MIN_VOLUME_USDT = 100_000;
const ASTER_MAX_POSITIONS_PER_USER = 3;
const ASTER_DEFAULT_POSITION_SIZE_USDT = "50";
const ASTER_TRAILING_STOP_PCT = 3.0;

const BSC_RPC_ENDPOINTS = [
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc-dataseed3.binance.org",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed1.ninicoin.io",
  "https://bsc-dataseed2.defibit.io",
  "https://bsc-dataseed3.defibit.io",
  "https://56.rpc.thirdweb.com",
];

const rpcProviders: ethers.JsonRpcProvider[] = BSC_RPC_ENDPOINTS.map(url => {
  const p = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true, batchMaxCount: 1 });
  return p;
});
let currentRpcIndex = 0;
function getProvider(): ethers.JsonRpcProvider {
  const p = rpcProviders[currentRpcIndex % rpcProviders.length];
  currentRpcIndex++;
  return p;
}

const balanceCache = new Map<string, { balance: number; ts: number }>();
const BALANCE_CACHE_TTL_MS = 90_000;

const tokenInfoCache = new Map<string, { info: FourMemeTokenInfo; ts: number }>();
const TOKEN_INFO_CACHE_TTL_MS = 20_000;

const walletCache = new Map<string, { pk: string; address: string; ts: number }>();
const WALLET_CACHE_TTL_MS = 300_000;

const failedTokenCooldown = new Map<string, number>();
const FAILED_COOLDOWN_MS = 300_000;

let scanRunning = false;
let copyTradeRunning = false;
let asterScanRunning = false;
let positionCheckRunning = false;

interface AsterFuturesPosition {
  id: string;
  chatId: number;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: string;
  quantity: string;
  leverage: number;
  stopOrderId?: number;
  entryTime: number;
  status: "open" | "closed_profit" | "closed_loss" | "closed_manual";
  pnlUsdt?: string;
  closedAt?: number;
  peakPnlPct: number;
  trailingStopActive: boolean;
  confidenceScore: number;
  reasoning: string;
}

interface AsterMarketSignal {
  symbol: string;
  side: "LONG" | "SHORT";
  confidence: number;
  reasoning: string;
  fundingRate: number;
  volume24h: number;
  priceChangePct: number;
  markPrice: string;
}

const activeAsterPositions = new Map<string, AsterFuturesPosition>();
const asterTradeHistory: AsterFuturesPosition[] = [];
const recentlyScannedAsterSymbols = new Set<string>();
const asterTradeMemory: Array<{ symbol: string; side: string; result: string; pnl: number; reasoning: string }> = [];

let asterScanTimer: ReturnType<typeof setInterval> | null = null;
let asterPositionTimer: ReturnType<typeof setInterval> | null = null;

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
let copyTradeRunning2 = false;

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

async function getCachedTokenInfo(address: string): Promise<FourMemeTokenInfo> {
  const cached = tokenInfoCache.get(address);
  if (cached && Date.now() - cached.ts < TOKEN_INFO_CACHE_TTL_MS) return cached.info;
  const info = await Promise.race([
    fourMemeGetTokenInfo(address),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Token info timeout")), 10000)),
  ]);
  tokenInfoCache.set(address, { info, ts: Date.now() });
  if (tokenInfoCache.size > 300) {
    const keys = Array.from(tokenInfoCache.keys());
    for (let i = 0; i < keys.length - 150; i++) tokenInfoCache.delete(keys[i]);
  }
  return info;
}

async function fetchNewTokens(): Promise<Array<{ address: string; name: string; symbol: string; launchTime: number }>> {
  const headers = { "Accept": "application/json", "Origin": "https://four.meme", "Referer": "https://four.meme/" };
  const results: Array<{ address: string; name: string; symbol: string; launchTime: number }> = [];
  const seen = new Set<string>();

  const addTokens = (tokens: any[]) => {
    for (const t of tokens) {
      const addr = t.address || t.tokenAddress || t.contractAddress;
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      results.push({
        address: addr,
        name: t.name || t.tokenName || t.shortName || "Unknown",
        symbol: t.symbol || t.tokenSymbol || t.shortName || "???",
        launchTime: t.launchTime || parseInt(t.createDate) || 0,
      });
    }
  };

  const fetches = [
    fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/query?orderBy=MarketCapDesc&pageIndex=1&pageSize=30`, { headers })
      .then(async r => { if (r.ok) { const d = await r.json(); if (d.code === 0 && Array.isArray(d.data?.records)) addTokens(d.data.records); } })
      .catch(() => {}),
    fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/ranking/exclusive`, { headers })
      .then(async r => { if (r.ok) { const d = await r.json(); if (d.code === 0 && Array.isArray(d.data)) addTokens(d.data); } })
      .catch(() => {}),
  ];

  await Promise.race([
    Promise.all(fetches),
    new Promise<void>(resolve => setTimeout(resolve, 12000)),
  ]);

  return results;
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

const tradeMemory: Array<{ symbol: string; result: string; pnl: number; reasoning: string; tokenAddress: string }> = [];

function buildTradeMemoryContext(): string {
  if (tradeMemory.length === 0) return "No previous trades yet.";
  const recent = tradeMemory.slice(-15);
  const wins = recent.filter(t => t.pnl > 0).length;
  const losses = recent.filter(t => t.pnl <= 0).length;
  const avgWinPnl = wins > 0 ? recent.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLossPnl = losses > 0 ? recent.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / losses : 0;
  let ctx = `Recent trade history (${wins}W/${losses}L, avg win: +${avgWinPnl.toFixed(4)} BNB, avg loss: ${avgLossPnl.toFixed(4)} BNB):\n`;
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

    const url = `https://api.etherscan.io/v2/api?chainid=56&module=account&action=tokentx&address=${tokenAddress}&page=1&offset=10&sort=desc&apikey=${apiKey}`;
    const res = await Promise.race([
      fetch(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
    ]);
    const data = await res.json();

    let rugRisk = 0;
    const reasons: string[] = [];

    if (data.status === "1" && Array.isArray(data.result)) {
      const txCount = data.result.length;
      if (txCount === 0) {
        rugRisk += 25;
        reasons.push("No creator TX history");
      }
      const uniqueReceivers = new Set(data.result.map((tx: any) => tx.to?.toLowerCase()));
      if (uniqueReceivers.size <= 2 && txCount > 3) {
        rugRisk += 20;
        reasons.push("Low receiver diversity — possible wash trading");
      }
    }

    creatorRugScores.set(tokenAddress, rugRisk);
    if (creatorRugScores.size > 300) {
      const keys = Array.from(creatorRugScores.keys());
      for (let i = 0; i < keys.length - 150; i++) creatorRugScores.delete(keys[i]);
    }

    return { rugRisk, reasons };
  } catch {
    return { rugRisk: 0, reasons: [] };
  }
}

function analyzeMomentum(positionId: string, currentMultiple: number, progressPercent: number): { trend: "accelerating" | "stable" | "decelerating" | "unknown"; velocityChange: number; description: string } {
  const snapshots = priceHistory.get(positionId) || [];
  snapshots.push({ multiple: currentMultiple, timestamp: Date.now(), progressPercent });
  if (snapshots.length > 50) snapshots.splice(0, snapshots.length - 50);
  priceHistory.set(positionId, snapshots);

  if (snapshots.length < 3) return { trend: "unknown", velocityChange: 0, description: "Not enough data" };

  const recent = snapshots.slice(-5);
  const older = snapshots.slice(-10, -5);

  if (older.length < 2) return { trend: "unknown", velocityChange: 0, description: "Warming up" };

  const recentVelocity = (recent[recent.length - 1].multiple - recent[0].multiple) / ((recent[recent.length - 1].timestamp - recent[0].timestamp) / 60000 || 1);
  const olderVelocity = (older[older.length - 1].multiple - older[0].multiple) / ((older[older.length - 1].timestamp - older[0].timestamp) / 60000 || 1);

  const velocityChange = recentVelocity - olderVelocity;

  if (velocityChange > 0.005) return { trend: "accelerating", velocityChange, description: `Rising: ${recentVelocity.toFixed(4)}x/min vs ${olderVelocity.toFixed(4)}x/min` };
  if (velocityChange < -0.005) return { trend: "decelerating", velocityChange, description: `Fading: ${recentVelocity.toFixed(4)}x/min vs ${olderVelocity.toFixed(4)}x/min` };
  return { trend: "stable", velocityChange, description: `Steady: ${recentVelocity.toFixed(4)}x/min` };
}

function calculateDynamicBuyAmount(baseBnb: string, confidenceScore: number, source: string): string {
  const base = parseFloat(baseBnb);
  let multiplier = 1.0;

  if (source === "consensus") {
    multiplier = 1.8;
  } else if (source === "whale_copy") {
    multiplier = 1.4;
  } else if (confidenceScore >= 90) {
    multiplier = 1.6;
  } else if (confidenceScore >= 80) {
    multiplier = 1.3;
  } else if (confidenceScore >= 70) {
    multiplier = 1.0;
  } else if (confidenceScore >= 60) {
    multiplier = 0.8;
  } else {
    multiplier = 0.5;
  }

  const { rate } = getWinRate();
  if (rate > 60) multiplier *= 1.15;
  else if (rate < 30 && tradeMemory.length >= 5) multiplier *= 0.7;

  const amount = Math.max(0.01, Math.min(base * multiplier, base * 2.5));
  return amount.toFixed(4);
}

function getWinRate(): { rate: number; total: number } {
  if (tradeMemory.length === 0) return { rate: 0, total: 0 };
  const wins = tradeMemory.filter(t => t.pnl > 0).length;
  return { rate: (wins / tradeMemory.length) * 100, total: tradeMemory.length };
}

function getAdaptiveConfidenceThreshold(): number {
  const { rate, total } = getWinRate();
  if (total < 3) return 50;
  if (rate >= 60) return 40;
  if (rate >= 45) return 50;
  if (rate >= 30) return 60;
  return 70;
}

function computeTokenScore(token: { address: string; name: string; symbol: string; launchTime: number }, info: FourMemeTokenInfo): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const progress = info.progressPercent;
  const age = Math.floor(Date.now() / 1000) - (token.launchTime || info.launchTime);
  const ageMin = Math.floor(age / 60);
  const fundsNum = parseFloat(info.funds);
  const maxFundsNum = parseFloat(info.maxFunds);
  const velocity = ageMin > 0 ? progress / ageMin : 0;
  const fundsVelocity = ageMin > 0 ? fundsNum / ageMin : 0;

  if (progress >= 8 && progress <= 25) { score += 30; reasons.push(`Sweet spot: ${progress.toFixed(1)}%`); }
  else if (progress > 25 && progress <= 40) { score += 22; reasons.push(`Mid-curve: ${progress.toFixed(1)}%`); }
  else if (progress > 40 && progress <= 55) { score += 12; reasons.push(`Late-curve: ${progress.toFixed(1)}%`); }
  else { score += 5; reasons.push(`Curve: ${progress.toFixed(1)}%`); }

  if (age < 300) { score += 28; reasons.push(`${ageMin}m old (ultra-fresh)`); }
  else if (age < 600) { score += 22; reasons.push(`${ageMin}m old (fresh)`); }
  else if (age < 1200) { score += 15; reasons.push(`${ageMin}m old`); }
  else if (age < 1800) { score += 8; reasons.push(`${ageMin}m old`); }
  else { score += 3; reasons.push(`${ageMin}m old (aging)`); }

  if (fundsNum >= 3.0) { score += 20; reasons.push(`${fundsNum.toFixed(2)} BNB raised (strong)`); }
  else if (fundsNum >= 1.5) { score += 16; reasons.push(`${fundsNum.toFixed(2)} BNB raised (good)`); }
  else if (fundsNum >= 0.5) { score += 10; reasons.push(`${fundsNum.toFixed(2)} BNB raised`); }
  else if (fundsNum >= 0.2) { score += 5; reasons.push(`${fundsNum.toFixed(2)} BNB raised (low)`); }

  if (velocity > 2.0) { score += 25; reasons.push(`${velocity.toFixed(1)}%/min (parabolic)`); }
  else if (velocity > 1.0) { score += 20; reasons.push(`${velocity.toFixed(1)}%/min (strong)`); }
  else if (velocity > 0.5) { score += 14; reasons.push(`${velocity.toFixed(1)}%/min (healthy)`); }
  else if (velocity > 0.2) { score += 7; reasons.push(`${velocity.toFixed(1)}%/min`); }
  else { score += 2; reasons.push(`${velocity.toFixed(1)}%/min (sluggish)`); }

  if (fundsVelocity > 0.1) { score += 10; reasons.push(`BNB inflow: ${fundsVelocity.toFixed(3)}/min`); }
  else if (fundsVelocity > 0.03) { score += 5; }

  const whaleInterest = whaleConsensus.get(token.address.toLowerCase());
  if (whaleInterest && whaleInterest.size >= 2) { score += 30; reasons.push(`🐋 ${whaleInterest.size} whale consensus`); }
  else if (whaleInterest && whaleInterest.size >= 1) { score += 15; reasons.push(`🐋 Whale interest`); }

  const recentFail = failedTokenCooldown.get(token.address);
  if (recentFail && Date.now() - recentFail < FAILED_COOLDOWN_MS) {
    score -= 50;
    reasons.push("⚠️ Recently failed trade — cooldown");
  }

  return { score: Math.min(100, Math.round((score / 140) * 100)), reasons };
}

async function aiEvaluateBuy(tokens: Array<{ address: string; name: string; symbol: string; launchTime: number; info: FourMemeTokenInfo }>): Promise<TokenSignal | null> {
  if (tokens.length === 0) return null;

  const rugChecks = await Promise.all(tokens.slice(0, 5).map(t => checkCreatorHistory(t.address).catch(() => ({ rugRisk: 0, reasons: [] }))));

  const tokenDataLines = tokens.map((t, i) => {
    const age = Math.floor(Date.now() / 1000) - (t.launchTime || t.info.launchTime);
    const ageMin = Math.floor(age / 60);
    const velocity = age > 0 ? (t.info.progressPercent / (age / 60)).toFixed(2) : "0";
    const fundsVelocity = age > 60 ? (parseFloat(t.info.funds) / (age / 60)).toFixed(4) : "N/A";
    const rug = i < rugChecks.length ? rugChecks[i] : null;
    const rugLabel = rug && rug.rugRisk > 0 ? ` ⚠️ RUG=${rug.rugRisk}%` : "";
    const whaleInterest = whaleConsensus.has(t.address.toLowerCase()) ? ` 🐋 WHALES=${whaleConsensus.get(t.address.toLowerCase())!.size}` : "";
    const { score: heuristicScore } = computeTokenScore(t, t.info);
    return `${i + 1}. $${t.symbol} (${t.name}) — Curve: ${t.info.progressPercent.toFixed(1)}%, Age: ${ageMin}m, Raised: ${parseFloat(t.info.funds).toFixed(3)}/${parseFloat(t.info.maxFunds).toFixed(1)} BNB, Vel: ${velocity}%/min, BNBflow: ${fundsVelocity}/min, Price: ${t.info.lastPrice}, Heuristic: ${heuristicScore}%${rugLabel}${whaleInterest}`;
  }).join("\n");

  const memoryCtx = buildTradeMemoryContext();
  const winRate = getWinRate();
  const threshold = getAdaptiveConfidenceThreshold();

  const prompt = `You are a PROFESSIONAL meme token sniper on Four.meme (BNB Chain bonding curve). You are FAST, DECISIVE, and AGGRESSIVE when the signals are right. Analyze and decide which ONE to buy, or NONE.

TOKENS:
${tokenDataLines}

PERFORMANCE: ${winRate.total > 0 ? `${winRate.rate.toFixed(0)}% win rate over ${winRate.total} trades (adaptive threshold: ${threshold}%)` : "No history — be moderately aggressive to build data"}

TRADE MEMORY:
${memoryCtx}

CRITICAL SIGNALS (ranked by importance):
1. 🐋 WHALE INTEREST = multiple smart money wallets bought this. HIGHEST PRIORITY — almost always buy
2. VELOCITY >1%/min + Age <15min = parabolic early entry, STRONG BUY signal
3. BNB INFLOW >0.05/min = real buyers are flooding in, not just paper momentum
4. Curve 8-25% + Velocity >0.5%/min = ideal entry zone with confirmed momentum  
5. Raised >1 BNB with <10min age = explosive demand, very bullish
6. Heuristic score >65% = multiple signals converging, high probability
7. Name/theme with trending meme relevance = better chance of viral pump

RED FLAGS:
- ⚠️ RUG RISK > 20% = skip unless whale consensus
- Age >30min + Velocity <0.3%/min = dying token
- Curve >50% = late entry, reduced upside
- Recently failed trade on same token = avoid

RESPOND EXACTLY:
DECISION: BUY or SKIP
TOKEN: [number]
CONFIDENCE: [1-100]
REASONING: [1 sentence, be specific about what signal drove the decision]`;

  try {
    const result = await Promise.race([
      runInferenceWithFallback(AI_NETWORKS, AI_MODEL, prompt, {
        systemPrompt: "You are an elite meme token sniper. You scan metrics and pull the trigger FAST when signals align. You prefer to trade rather than wait — the best opportunities vanish in seconds. Be aggressive but not reckless. Respond concisely.",
        temperature: 0.4,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI timeout")), 12000)),
    ]);

    const output = result.text.trim();
    log(`[TradingAgent] AI analysis: ${output.substring(0, 200)}`, "trading");

    if (!output || output.includes("[NO_PROVIDER]") || output.length < 10) {
      return fallbackEvaluateTokens(tokens);
    }

    const decisionMatch = output.match(/DECISION:\s*(BUY|SKIP)/i);
    const tokenMatch = output.match(/TOKEN:\s*(\d+)/i);
    const confidenceMatch = output.match(/CONFIDENCE:\s*(\d+)/i);
    const reasoningMatch = output.match(/REASONING:\s*(.+)/i);

    if (!decisionMatch) return fallbackEvaluateTokens(tokens);

    const decision = decisionMatch[1].toUpperCase();
    const tokenIdx = parseInt(tokenMatch?.[1] || "0") - 1;
    const confidence = parseInt(confidenceMatch?.[1] || "0");
    const reasoning = reasoningMatch?.[1]?.trim() || "AI analysis";

    if (decision !== "BUY" || tokenIdx < 0 || tokenIdx >= tokens.length || confidence < threshold) {
      log(`[TradingAgent] AI: SKIP (decision=${decision}, confidence=${confidence}, threshold=${threshold})`, "trading");
      return null;
    }

    const chosen = tokens[tokenIdx];
    const age = Math.floor(Date.now() / 1000) - (chosen.launchTime || chosen.info.launchTime);
    const velocity = age > 0 ? chosen.info.progressPercent / (age / 60) : 0;

    return {
      address: chosen.address,
      name: chosen.name,
      symbol: chosen.symbol,
      score: confidence,
      reasons: [
        `AI: ${confidence}%`,
        `Curve: ${chosen.info.progressPercent.toFixed(1)}%`,
        `Age: ${Math.floor(age / 60)}m`,
        `Vel: ${velocity.toFixed(1)}%/min`,
        `Raised: ${parseFloat(chosen.info.funds).toFixed(3)} BNB`,
      ],
      info: chosen.info,
      aiAnalysis: reasoning,
      aiDecision: "BUY",
    };
  } catch (e: any) {
    log(`[TradingAgent] AI failed, using rules: ${e.message?.substring(0, 80)}`, "trading");
    return fallbackEvaluateTokens(tokens);
  }
}

function fallbackEvaluateTokens(tokens: Array<{ address: string; name: string; symbol: string; launchTime: number; info: FourMemeTokenInfo }>): TokenSignal | null {
  let best: TokenSignal | null = null;
  let bestRawScore = 0;

  for (const token of tokens) {
    const info = token.info;
    if (info.liquidityAdded) continue;
    const progress = info.progressPercent;
    if (progress < MIN_PROGRESS_FOR_ENTRY || progress > MAX_PROGRESS_FOR_ENTRY) continue;

    const age = Math.floor(Date.now() / 1000) - (token.launchTime || info.launchTime);
    if (age > MAX_TOKEN_AGE_SECONDS) continue;

    const { score, reasons } = computeTokenScore(token, info);

    const threshold = getAdaptiveConfidenceThreshold();
    if (score >= threshold && score > bestRawScore) {
      bestRawScore = score;
      best = { address: token.address, name: token.name, symbol: token.symbol, score, reasons, info };
    }
  }

  if (best) log(`[TradingAgent] Fallback picked: $${best.symbol} (score: ${best.score})`, "trading");
  return best;
}

async function aiEvaluateSell(position: TradingPosition, info: FourMemeTokenInfo, multiple: number, ageMinutes: number, momentum?: { trend: string; velocityChange: number; description: string }): Promise<{ decision: "HOLD" | "SELL"; reasoning: string }> {
  const velocity = info.progressPercent > 0 && ageMinutes > 0 ? (info.progressPercent / ageMinutes).toFixed(2) : "unknown";
  const fundsRaised = parseFloat(info.funds).toFixed(3);
  const maxFunds = parseFloat(info.maxFunds).toFixed(1);
  const pnlPct = ((multiple - 1) * 100).toFixed(1);
  const winRate = getWinRate();
  const drawdown = position.peakMultiple > 0 ? ((1 - multiple / position.peakMultiple) * 100).toFixed(1) : "0.0";

  const prompt = `POSITION: $${position.tokenSymbol} | Entry: ${position.entryPriceBnb} BNB | Current: ${multiple.toFixed(3)}x (${pnlPct}% PnL) | Peak: ${position.peakMultiple.toFixed(3)}x | Drawdown: ${drawdown}% | Hold: ${ageMinutes.toFixed(0)}m | Source: ${position.source} (${position.confidenceScore}%)
STATE: Curve ${info.progressPercent.toFixed(1)}%/${maxFunds} BNB, Vel: ${velocity}%/min, Raised: ${fundsRaised} BNB, Liquidity: ${info.liquidityAdded}, Trailing: ${position.trailingStopActive ? "ACTIVE" : "off"}
MOMENTUM: ${momentum?.trend || "unknown"} — ${momentum?.description || "N/A"}
TARGETS: TP ${position.takeProfitMultiple}x | SL ${((1 - position.stopLossMultiple) * 100).toFixed(0)}%
WIN RATE: ${winRate.total > 0 ? `${winRate.rate.toFixed(0)}% over ${winRate.total}` : "N/A"}

Rules: Accelerating+profitable=HOLD. Decelerating+profitable=SELL. Drawdown>15%+decelerating=SELL. Near TP+accelerating=HOLD (let run). Low win rate=take profits earlier.

DECISION: HOLD or SELL
REASONING: [1 sentence]`;

  try {
    const result = await Promise.race([
      runInferenceWithFallback(AI_NETWORKS, AI_MODEL, prompt, {
        systemPrompt: "Crypto position manager. Protect capital. Lock profits when momentum fades. Let winners run when strong. Be decisive. Respond in 2 lines max.",
        temperature: 0.2,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI timeout")), 10000)),
    ]);

    const output = result.text.trim();
    log(`[TradingAgent] AI sell ${position.tokenSymbol}: ${output.substring(0, 150)}`, "trading");

    if (!output || output.includes("[NO_PROVIDER]") || output.length < 10) {
      if (multiple >= position.takeProfitMultiple) return { decision: "SELL", reasoning: "Hit TP (fallback)" };
      if (multiple <= position.stopLossMultiple) return { decision: "SELL", reasoning: "Hit SL (fallback)" };
      return { decision: "HOLD", reasoning: "Within range (fallback)" };
    }

    const decisionMatch = output.match(/DECISION:\s*(HOLD|SELL)/i);
    const reasoningMatch = output.match(/REASONING:\s*(.+)/i);

    if (!decisionMatch) {
      if (multiple >= position.takeProfitMultiple) return { decision: "SELL", reasoning: "Hit TP" };
      if (multiple <= position.stopLossMultiple) return { decision: "SELL", reasoning: "Hit SL" };
      return { decision: "HOLD", reasoning: "AI malformed, holding" };
    }

    return {
      decision: decisionMatch[1].toUpperCase() === "SELL" ? "SELL" : "HOLD",
      reasoning: reasoningMatch?.[1]?.trim() || "AI decision",
    };
  } catch (e: any) {
    log(`[TradingAgent] AI sell failed: ${e.message?.substring(0, 60)}`, "trading");
    if (multiple >= position.takeProfitMultiple) return { decision: "SELL", reasoning: "Hit TP" };
    if (multiple <= position.stopLossMultiple) return { decision: "SELL", reasoning: "Hit SL" };
    return { decision: "HOLD", reasoning: "Within range" };
  }
}

async function executeBuy(chatId: number, agentId: string, signal: TokenSignal, privateKey: string, walletAddress: string, source: "ai_scan" | "whale_copy" | "consensus" = "ai_scan"): Promise<TradingPosition | null> {
  const config = getUserConfig(chatId);
  const positionId = `trade_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const dynamicAmount = calculateDynamicBuyAmount(config.buyAmountBnb, signal.score, source);

  try {
    log(`[TradingAgent] BUYING ${signal.symbol} for ${dynamicAmount} BNB (conf: ${signal.score}, src: ${source})`, "trading");

    const result = await fourMemeBuyToken(signal.address, dynamicAmount, DEFAULT_SLIPPAGE, privateKey);

    if (!result.success) {
      log(`[TradingAgent] Buy FAILED ${signal.symbol}: ${result.error}`, "trading");
      failedTokenCooldown.set(signal.address, Date.now());
      return null;
    }

    let tokenBalance = "0";
    try {
      await new Promise(r => setTimeout(r, 2000));
      const bal = await fourMemeGetTokenBalance(signal.address, walletAddress);
      tokenBalance = bal.balance;
    } catch {}

    const position: TradingPosition = {
      id: positionId, chatId, agentId, walletAddress,
      tokenAddress: signal.address, tokenSymbol: signal.symbol,
      entryPriceBnb: dynamicAmount, tokenAmount: tokenBalance,
      buyTxHash: result.txHash || "", entryTime: Date.now(),
      takeProfitMultiple: config.takeProfitMultiple, stopLossMultiple: config.stopLossMultiple,
      status: "open", peakMultiple: 1.0, trailingStopActive: false,
      confidenceScore: signal.score, source,
    };

    activePositions.set(positionId, position);
    balanceCache.delete(walletAddress);
    log(`[TradingAgent] Position OPEN: ${signal.symbol} | ${tokenBalance} tokens for ${dynamicAmount} BNB | TX: ${result.txHash}`, "trading");
    return position;
  } catch (e: any) {
    log(`[TradingAgent] Buy error: ${e.message?.substring(0, 150)}`, "trading");
    failedTokenCooldown.set(signal.address, Date.now());
    return null;
  }
}

async function checkAndClosePositions(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  if (positionCheckRunning) return;
  positionCheckRunning = true;
  try {
    const openPositions = Array.from(activePositions.entries()).filter(([_, p]) => p.status === "open");
    if (openPositions.length === 0) { positionCheckRunning = false; return; }

    const checks = openPositions.map(async ([posId, position]) => {
      try {
        const info = await getCachedTokenInfo(position.tokenAddress);
        const currentPrice = parseFloat(info.lastPrice);
        let tokenAmountNum = parseFloat(position.tokenAmount);

        if (tokenAmountNum <= 0) {
          try {
            const bal = await fourMemeGetTokenBalance(position.tokenAddress, position.walletAddress);
            position.tokenAmount = bal.balance;
            tokenAmountNum = parseFloat(bal.balance);
          } catch {}
          if (tokenAmountNum <= 0) return;
        }

        const currentValueBnb = currentPrice * tokenAmountNum;
        const entryBnb = parseFloat(position.entryPriceBnb);
        const multiple = entryBnb > 0 ? currentValueBnb / entryBnb : 0;
        const ageMinutes = (Date.now() - position.entryTime) / 60000;

        if (multiple > position.peakMultiple) position.peakMultiple = multiple;

        if (!position.trailingStopActive && multiple >= TRAILING_STOP_ACTIVATION) {
          position.trailingStopActive = true;
          log(`[TradingAgent] ${position.tokenSymbol} trailing ACTIVE at ${multiple.toFixed(2)}x`, "trading");
        }

        const momentum = analyzeMomentum(posId, multiple, info.progressPercent);

        if (info.liquidityAdded) {
          await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb, "Token graduated to DEX");
          return;
        }

        if (position.trailingStopActive) {
          const trailingStopLevel = position.peakMultiple * (1 - TRAILING_STOP_DISTANCE);
          if (multiple <= trailingStopLevel) {
            await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb, `Trail stop: peak ${position.peakMultiple.toFixed(2)}x → ${multiple.toFixed(2)}x`);
            return;
          }
        }

        if (multiple >= position.takeProfitMultiple * 1.5) {
          await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb, "Hard TP exceeded");
          return;
        }

        if (multiple <= position.stopLossMultiple * 0.8) {
          await closePosition(position, "closed_loss", notifyFn, multiple, currentValueBnb, "Hard SL exceeded");
          return;
        }

        if (ageMinutes > 90 && multiple < 1.05) {
          await closePosition(position, multiple >= 1 ? "closed_profit" : "closed_loss", notifyFn, multiple, currentValueBnb, "Stale — no movement after 90m");
          return;
        }

        if (multiple >= 1.15 || multiple <= 0.85 || ageMinutes > 30) {
          const aiSell = await aiEvaluateSell(position, info, multiple, ageMinutes, momentum);
          if (aiSell.decision === "SELL") {
            await closePosition(position, multiple >= 1 ? "closed_profit" : "closed_loss", notifyFn, multiple, currentValueBnb, aiSell.reasoning);
          }
        }
      } catch (e: any) {
        log(`[TradingAgent] Check error ${position.tokenSymbol}: ${e.message?.substring(0, 80)}`, "trading");
      }
    });

    await Promise.allSettled(checks);
  } finally {
    positionCheckRunning = false;
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
      log(`[TradingAgent] Cannot close ${position.tokenSymbol} — no key`, "trading");
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
    balanceCache.delete(position.walletAddress);

    tradeMemory.push({ symbol: position.tokenSymbol, result: reason === "closed_profit" ? "WIN" : "LOSS", pnl, reasoning: aiReasoning || reason, tokenAddress: position.tokenAddress });
    if (tradeMemory.length > 30) tradeMemory.splice(0, tradeMemory.length - 30);

    if (pnl < 0) failedTokenCooldown.set(position.tokenAddress, Date.now());

    const emoji = reason === "closed_profit" ? "💰" : "📉";
    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4);
    const holdTime = Math.floor((Date.now() - position.entryTime) / 60000);

    let msg = `${emoji} CLOSED: $${position.tokenSymbol}\n`;
    msg += `Entry: ${position.entryPriceBnb} BNB → Exit: ~${currentValueBnb.toFixed(4)} BNB\n`;
    msg += `PnL: ${pnlStr} BNB (${multiple.toFixed(2)}x) | Peak: ${position.peakMultiple.toFixed(2)}x | ${holdTime}m\n`;
    if (aiReasoning) msg += `🧠 ${aiReasoning}\n`;
    if (sellResult.txHash) msg += `TX: https://bscscan.com/tx/${sellResult.txHash}`;
    if (!sellResult.success) msg += `\n⚠️ Sell may have failed: ${sellResult.error?.substring(0, 80)}`;

    notifyFn(position.chatId, msg);
  } catch (e: any) {
    log(`[TradingAgent] Close error: ${e.message?.substring(0, 150)}`, "trading");
  }
}

export async function manualClosePosition(positionId: string, notifyFn: (chatId: number, message: string) => void): Promise<boolean> {
  const position = activePositions.get(positionId);
  if (!position || position.status !== "open") return false;

  try {
    const info = await getCachedTokenInfo(position.tokenAddress);
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

async function resolveEnabledUsers(): Promise<Array<{ chatId: number; agentId: string; privateKey: string; walletAddress: string }>> {
  const users: Array<{ chatId: number; agentId: string; privateKey: string; walletAddress: string }> = [];

  const entries = Array.from(userTradingConfig.entries()).filter(([_, config]) => config.enabled);

  const checks = entries.map(async ([chatId, config]) => {
    const openCount = Array.from(activePositions.values()).filter(p => p.chatId === chatId && p.status === "open").length;
    if (openCount >= config.maxPositions) return;

    try {
      const chatIdStr = chatId.toString();

      const cached = walletCache.get(chatIdStr);
      let pk: string;
      let walletAddress: string;

      if (cached && Date.now() - cached.ts < WALLET_CACHE_TTL_MS) {
        pk = cached.pk;
        walletAddress = cached.address;
      } else {
        const wallets = await storage.getTelegramWallets(chatIdStr);
        if (wallets.length === 0) return;
        const activeWallet = wallets.find(w => w.isActive) || wallets[0];
        const fetchedPk = await storage.getTelegramWalletPrivateKey(chatIdStr, activeWallet.walletAddress);
        if (!fetchedPk) return;
        pk = fetchedPk;
        walletAddress = activeWallet.walletAddress;
        walletCache.set(chatIdStr, { pk, address: walletAddress, ts: Date.now() });
      }

      const balBnb = await getBalanceFast(walletAddress);
      if (balBnb < MIN_WALLET_BALANCE_BNB) return;

      users.push({ chatId, agentId: "auto-trader", privateKey: pk, walletAddress });
    } catch {}
  });

  await Promise.allSettled(checks);
  return users;
}

async function getBalanceFast(walletAddress: string): Promise<number> {
  const cached = balanceCache.get(walletAddress);
  if (cached && Date.now() - cached.ts < BALANCE_CACHE_TTL_MS) return cached.balance;

  const provider = getProvider();
  const balance = await Promise.race([
    provider.getBalance(walletAddress),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 6000)),
  ]);
  const balBnb = parseFloat(ethers.formatEther(balance));
  balanceCache.set(walletAddress, { balance: balBnb, ts: Date.now() });
  return balBnb;
}

async function scanAndTrade(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  if (scanRunning) return;
  scanRunning = true;
  try {
    await scanAndTradeInner(notifyFn);
  } finally {
    scanRunning = false;
  }
}

async function scanAndTradeInner(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  const enabledCount = Array.from(userTradingConfig.values()).filter(c => c.enabled).length;
  if (enabledCount === 0) return;

  log(`[TradingAgent] Scan — ${enabledCount} users`, "trading");

  const [tokens, enabledUsers] = await Promise.all([
    fetchNewTokens(),
    resolveEnabledUsers(),
  ]);

  if (enabledUsers.length === 0 || tokens.length === 0) {
    if (tokens.length === 0) log(`[TradingAgent] No tokens from Four.meme`, "trading");
    return;
  }

  const newTokens = tokens.filter(t => !recentlyScannedTokens.has(t.address));
  for (const t of tokens) recentlyScannedTokens.add(t.address);
  if (recentlyScannedTokens.size > 500) {
    const arr = Array.from(recentlyScannedTokens);
    for (let i = 0; i < arr.length - 200; i++) recentlyScannedTokens.delete(arr[i]);
  }

  if (newTokens.length === 0) return;

  const batch = newTokens.slice(0, 12);
  const infoResults = await Promise.allSettled(
    batch.map(t => getCachedTokenInfo(t.address).then(info => ({ token: t, info })))
  );

  const candidatesWithInfo: Array<{ address: string; name: string; symbol: string; launchTime: number; info: FourMemeTokenInfo }> = [];
  for (const r of infoResults) {
    if (r.status !== "fulfilled") continue;
    const { token, info } = r.value;
    if (info.liquidityAdded) continue;
    if (info.progressPercent < MIN_PROGRESS_FOR_ENTRY || info.progressPercent > MAX_PROGRESS_FOR_ENTRY) continue;
    const age = Math.floor(Date.now() / 1000) - (token.launchTime || info.launchTime);
    if (age > MAX_TOKEN_AGE_SECONDS) continue;
    if (failedTokenCooldown.has(token.address) && Date.now() - failedTokenCooldown.get(token.address)! < FAILED_COOLDOWN_MS) continue;
    candidatesWithInfo.push({ ...token, info });
  }

  if (candidatesWithInfo.length === 0) {
    if (newTokens.length > 0) log(`[TradingAgent] ${newTokens.length} new tokens — none pass filters`, "trading");
    return;
  }

  log(`[TradingAgent] ${candidatesWithInfo.length} candidates → AI`, "trading");

  const bestSignal = await aiEvaluateBuy(candidatesWithInfo);
  if (!bestSignal) return;

  log(`[TradingAgent] 🎯 SIGNAL: $${bestSignal.symbol} (${bestSignal.score}%) — ${bestSignal.aiAnalysis}`, "trading");

  const buyPromises = enabledUsers.map(async user => {
    const openCount = Array.from(activePositions.values()).filter(p => p.chatId === user.chatId && p.status === "open").length;
    const config = getUserConfig(user.chatId);
    if (openCount >= config.maxPositions) return;

    const alreadyHolding = Array.from(activePositions.values()).some(
      p => p.chatId === user.chatId && p.tokenAddress === bestSignal.address && p.status === "open"
    );
    if (alreadyHolding) return;

    const position = await executeBuy(user.chatId, user.agentId, bestSignal, user.privateKey, user.walletAddress, "ai_scan");
    if (position) {
      let msg = `🤖 AI TRADE: $${bestSignal.symbol}\n`;
      msg += `Amount: ${position.entryPriceBnb} BNB | Confidence: ${bestSignal.score}%\n`;
      if (bestSignal.aiAnalysis) msg += `🧠 ${bestSignal.aiAnalysis}\n`;
      bestSignal.reasons.forEach(r => msg += `• ${r}\n`);
      msg += `TP: ${config.takeProfitMultiple}x | SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
      if (position.buyTxHash) msg += `TX: https://bscscan.com/tx/${position.buyTxHash}`;
      notifyFn(user.chatId, msg);
    }
  });

  await Promise.allSettled(buyPromises);
}

async function fetchWhaleTokenBuys(walletAddress: string): Promise<Array<{ tokenAddress: string; tokenSymbol: string; tokenName: string; txHash: string; value: string; timeStamp: number }>> {
  try {
    const apiKey = process.env.BSCSCAN_API_KEY || "";
    const walletLower = walletAddress.toLowerCase();
    const url = `https://api.etherscan.io/v2/api?chainid=56&module=account&action=tokentx&address=${walletAddress}&page=1&offset=50&sort=desc&apikey=${apiKey}`;

    const res = await Promise.race([
      fetch(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("BSCScan timeout")), 10000)),
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
    log(`[CopyTrade] BSCScan error: ${e.message?.substring(0, 80)}`, "trading");
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
  const enabledUsers = await resolveEnabledUsers();
  if (enabledUsers.length === 0) return;

  const whaleChecks = COPY_TRADE_WALLETS.map(async whale => {
    const whaleLower = whale.address.toLowerCase();
    if (!lastSeenWhaleTxs.has(whaleLower)) {
      const initialTxs = await fetchWhaleTokenBuys(whaleLower);
      const initialSet = new Set(initialTxs.map(tx => tx.txHash));
      lastSeenWhaleTxs.set(whaleLower, initialSet);
      log(`[CopyTrade] Init ${whale.label}: ${initialSet.size} TXs`, "trading");
      return [];
    }

    const recentBuys = await fetchWhaleTokenBuys(whaleLower);
    if (recentBuys.length === 0) return [];

    const seenTxs = lastSeenWhaleTxs.get(whaleLower)!;
    const newBuys = recentBuys.filter(tx => !seenTxs.has(tx.txHash));
    for (const tx of recentBuys) seenTxs.add(tx.txHash);
    if (seenTxs.size > 500) {
      const arr = Array.from(seenTxs);
      for (let i = 0; i < arr.length - 300; i++) seenTxs.delete(arr[i]);
    }

    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
    return newBuys
      .filter(tx => tx.timeStamp > fiveMinAgo)
      .map(tx => ({ ...tx, whale }));
  });

  const whaleResults = await Promise.allSettled(whaleChecks);
  const allNewBuys: Array<{ tokenAddress: string; tokenSymbol: string; tokenName: string; txHash: string; value: string; timeStamp: number; whale: typeof COPY_TRADE_WALLETS[0] }> = [];
  for (const r of whaleResults) {
    if (r.status === "fulfilled") allNewBuys.push(...r.value);
  }

  if (allNewBuys.length === 0) return;

  const uniqueTokens = new Map<string, typeof allNewBuys[0]>();
  for (const buy of allNewBuys) {
    if (!uniqueTokens.has(buy.tokenAddress) && !whaleTokensCopied.has(buy.tokenAddress)) {
      uniqueTokens.set(buy.tokenAddress, buy);
    }
  }

  for (const [tokenAddr, buy] of uniqueTokens) {
    log(`[CopyTrade] ${buy.whale.label} bought $${buy.tokenSymbol} — COPYING!`, "trading");
    if (whaleTokensCopied.has(tokenAddr)) continue;

    let info: FourMemeTokenInfo;
    try {
      info = await getCachedTokenInfo(tokenAddr);
    } catch {
      const failCount = (whaleTokensFailed.get(tokenAddr) || 0) + 1;
      whaleTokensFailed.set(tokenAddr, failCount);
      if (failCount >= 3) {
        whaleTokensCopied.add(tokenAddr);
        whaleTokensFailed.delete(tokenAddr);
      }
      continue;
    }

    whaleTokensFailed.delete(tokenAddr);
    if (info.liquidityAdded) { whaleTokensCopied.add(tokenAddr); continue; }

    if (!whaleConsensus.has(tokenAddr)) whaleConsensus.set(tokenAddr, new Set());
    whaleConsensus.get(tokenAddr)!.add(buy.whale.label);
    const consensusCount = whaleConsensus.get(tokenAddr)!.size;
    const isConsensus = consensusCount >= 2;
    const tradeSource = isConsensus ? "consensus" as const : "whale_copy" as const;
    whaleTokensCopied.add(tokenAddr);

    const signal: TokenSignal = {
      address: tokenAddr,
      name: buy.tokenName,
      symbol: buy.tokenSymbol,
      score: isConsensus ? 95 : 85,
      reasons: [
        isConsensus ? `🔥 CONSENSUS: ${consensusCount} whales` : `🐋 ${buy.whale.label}`,
        `Curve: ${info.progressPercent.toFixed(1)}%`,
        `Raised: ${parseFloat(info.funds).toFixed(3)} BNB`,
      ],
      info,
      aiAnalysis: isConsensus ? `${consensusCount} whales bought — high conviction consensus.` : `Copying ${buy.whale.label}`,
      aiDecision: "BUY",
    };

    const buyPromises = enabledUsers.map(async user => {
      const openCount = Array.from(activePositions.values()).filter(p => p.chatId === user.chatId && p.status === "open").length;
      const config = getUserConfig(user.chatId);
      if (openCount >= config.maxPositions) return;
      if (Array.from(activePositions.values()).some(p => p.chatId === user.chatId && p.tokenAddress === tokenAddr && p.status === "open")) return;

      const position = await executeBuy(user.chatId, user.agentId, signal, user.privateKey, user.walletAddress, tradeSource);
      if (position) {
        const emoji = isConsensus ? "🔥" : "🐋";
        const label = isConsensus ? `CONSENSUS (${consensusCount} whales)` : `COPY: ${buy.whale.label}`;
        let msg = `${emoji} ${label}: $${buy.tokenSymbol}\n`;
        msg += `Amount: ${position.entryPriceBnb} BNB\n`;
        msg += `Whale TX: https://bscscan.com/tx/${buy.txHash}\n`;
        msg += `Curve: ${info.progressPercent.toFixed(1)}% | ${parseFloat(info.funds).toFixed(3)} BNB\n`;
        msg += `TP: ${config.takeProfitMultiple}x | SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
        if (position.buyTxHash) msg += `TX: https://bscscan.com/tx/${position.buyTxHash}`;
        notifyFn(user.chatId, msg);
      }
    });

    await Promise.allSettled(buyPromises);
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

async function getAsterUsersWithCredentials(): Promise<Array<{ chatId: number; client: AsterFuturesClient }>> {
  const result: Array<{ chatId: number; client: AsterFuturesClient }> = [];
  const checks = Array.from(userTradingConfig.entries())
    .filter(([_, c]) => c.enabled)
    .map(async ([chatId]) => {
      try {
        const creds = await storage.getAsterCredentials(chatId.toString());
        if (!creds) return;
        const client = createAsterFuturesClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
        result.push({ chatId, client });
      } catch {}
    });
  await Promise.allSettled(checks);
  return result;
}

async function fetchAsterMarketData(client: AsterFuturesClient): Promise<Array<{ ticker: AsterTicker; fundingRate: AsterFundingRate }>> {
  try {
    const [tickers, fundingRates] = await Promise.all([
      client.ticker().then(t => Array.isArray(t) ? t : [t]),
      client.fundingRate(undefined, 100).catch(() => [] as AsterFundingRate[]),
    ]);

    const fundingMap = new Map<string, AsterFundingRate>();
    for (const fr of fundingRates) fundingMap.set(fr.symbol, fr);

    const combined: Array<{ ticker: AsterTicker; fundingRate: AsterFundingRate }> = [];
    for (const t of tickers) {
      const vol = parseFloat(t.quoteVolume || "0");
      if (vol < ASTER_MIN_VOLUME_USDT) continue;
      const fr = fundingMap.get(t.symbol);
      if (!fr) continue;
      combined.push({ ticker: t, fundingRate: fr });
    }

    combined.sort((a, b) => parseFloat(b.ticker.quoteVolume) - parseFloat(a.ticker.quoteVolume));
    return combined.slice(0, 25);
  } catch (e: any) {
    log(`[AsterAgent] Market data error: ${e.message?.substring(0, 80)}`, "trading");
    return [];
  }
}

function buildAsterTradeMemoryContext(): string {
  if (asterTradeMemory.length === 0) return "No previous Aster futures trades yet.";
  const recent = asterTradeMemory.slice(-10);
  const wins = recent.filter(t => t.pnl > 0).length;
  const losses = recent.filter(t => t.pnl <= 0).length;
  let ctx = `Recent Aster futures (${wins}W/${losses}L):\n`;
  for (const t of recent) {
    ctx += `  ${t.symbol} ${t.side}: ${t.result} (${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} USDT) — ${t.reasoning}\n`;
  }
  return ctx;
}

async function aiEvaluateAsterMarkets(markets: Array<{ ticker: AsterTicker; fundingRate: AsterFundingRate }>): Promise<AsterMarketSignal | null> {
  if (markets.length === 0) return null;

  const memoryCtx = buildAsterTradeMemoryContext();
  const winCount = asterTradeMemory.filter(t => t.pnl > 0).length;
  const totalCount = asterTradeMemory.length;
  const winRate = totalCount > 0 ? ((winCount / totalCount) * 100).toFixed(0) : "N/A";

  const marketLines = markets.map((m, i) => {
    const fr = parseFloat(m.fundingRate.fundingRate);
    const frDir = fr > 0 ? "longs pay" : fr < 0 ? "shorts pay" : "neutral";
    const pctChange = parseFloat(m.ticker.priceChangePercent || "0");
    const vol = parseFloat(m.ticker.quoteVolume || "0");
    const range = parseFloat(m.ticker.high) - parseFloat(m.ticker.low);
    const rangePct = parseFloat(m.ticker.low) > 0 ? ((range / parseFloat(m.ticker.low)) * 100).toFixed(2) : "0";
    return `${i + 1}. ${m.ticker.symbol} — $${m.ticker.price}, 24h: ${pctChange.toFixed(2)}%, Vol: ${(vol / 1000).toFixed(0)}K, FR: ${(fr * 100).toFixed(4)}% (${frDir}), Range: ${rangePct}%, H/L: ${m.ticker.high}/${m.ticker.low}`;
  }).join("\n");

  const prompt = `Expert crypto futures trader. Pick the BEST trade or SKIP.

MARKETS:
${marketLines}

STATS: ${totalCount > 0 ? `${winRate}% win rate over ${totalCount}` : "New"}
MEMORY:
${memoryCtx}

EDGE SIGNALS:
1. FR >0.05% + overbought (big green 24h) = SHORT (funding arb + mean reversion)
2. FR <-0.03% + oversold (big red 24h) = LONG (funding arb + bounce)
3. Strong trend (>3% 24h) + high vol + moderate FR = ride momentum
4. Wide range% + high vol = volatile — trade breakout direction
5. SKIP if no clear edge

RESPOND:
DECISION: BUY or SELL or SKIP
SYMBOL: [exact symbol]
CONFIDENCE: [1-100]
REASONING: [1 sentence]`;

  try {
    const result = await Promise.race([
      runInferenceWithFallback(AI_NETWORKS, AI_MODEL, prompt, {
        systemPrompt: "Elite futures trader. Find high-probability setups from funding rates, volume, momentum. Be aggressive when edge is clear. Respond in 4 lines.",
        temperature: 0.35,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI timeout")), 12000)),
    ]);

    const output = result.text.trim();
    log(`[AsterAgent] AI: ${output.substring(0, 200)}`, "trading");

    if (!output || output.includes("[NO_PROVIDER]") || output.length < 10) return null;

    const decisionMatch = output.match(/DECISION:\s*(BUY|SELL|SKIP)/i);
    const symbolMatch = output.match(/SYMBOL:\s*(\S+)/i);
    const confidenceMatch = output.match(/CONFIDENCE:\s*(\d+)/i);
    const reasoningMatch = output.match(/REASONING:\s*(.+)/i);

    if (!decisionMatch) return null;
    const decision = decisionMatch[1].toUpperCase();
    if (decision === "SKIP") return null;

    const symbolStr = symbolMatch?.[1]?.toUpperCase() || "";
    const confidence = parseInt(confidenceMatch?.[1] || "0");
    const reasoning = reasoningMatch?.[1]?.trim() || "AI analysis";

    const adaptiveThreshold = totalCount >= 5 && parseInt(winRate) < 35 ? 65 : 50;
    if (confidence < adaptiveThreshold) return null;

    const market = markets.find(m => m.ticker.symbol === symbolStr);
    if (!market) return null;

    return {
      symbol: market.ticker.symbol,
      side: decision === "BUY" ? "LONG" : "SHORT",
      confidence, reasoning,
      fundingRate: parseFloat(market.fundingRate.fundingRate),
      volume24h: parseFloat(market.ticker.quoteVolume || "0"),
      priceChangePct: parseFloat(market.ticker.priceChangePercent || "0"),
      markPrice: market.fundingRate.markPrice || market.ticker.price,
    };
  } catch (e: any) {
    log(`[AsterAgent] AI error: ${e.message?.substring(0, 80)}`, "trading");
    return null;
  }
}

async function executeAsterFuturesTrade(
  chatId: number,
  client: AsterFuturesClient,
  signal: AsterMarketSignal,
  notifyFn: (chatId: number, message: string) => void,
): Promise<AsterFuturesPosition | null> {
  const positionId = `aster_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  try {
    await Promise.allSettled([
      client.setMarginType(signal.symbol, ASTER_DEFAULT_MARGIN_TYPE),
      client.setLeverage(signal.symbol, ASTER_DEFAULT_LEVERAGE),
    ]);

    const markPrice = parseFloat(signal.markPrice);
    if (markPrice <= 0) return null;

    const positionSizeUsdt = parseFloat(ASTER_DEFAULT_POSITION_SIZE_USDT) * ASTER_DEFAULT_LEVERAGE;
    const quantity = (positionSizeUsdt / markPrice).toFixed(6);
    const orderSide = signal.side === "LONG" ? "BUY" as const : "SELL" as const;

    log(`[AsterAgent] ${signal.side} ${signal.symbol} — qty: ${quantity}, ${ASTER_DEFAULT_LEVERAGE}x`, "trading");

    const order = await client.createOrder({
      symbol: signal.symbol, side: orderSide, type: "MARKET",
      quantity, positionSide: "BOTH",
    });

    const stopSide = signal.side === "LONG" ? "SELL" as const : "BUY" as const;
    const stopPrice = signal.side === "LONG"
      ? (markPrice * (1 - ASTER_TRAILING_STOP_PCT / 100)).toFixed(6)
      : (markPrice * (1 + ASTER_TRAILING_STOP_PCT / 100)).toFixed(6);

    let stopOrderId: number | undefined;
    try {
      const stopOrder = await client.createOrder({
        symbol: signal.symbol, side: stopSide, type: "STOP_MARKET",
        stopPrice, closePosition: true, positionSide: "BOTH",
      });
      stopOrderId = stopOrder.orderId;
    } catch {}

    const position: AsterFuturesPosition = {
      id: positionId, chatId, symbol: signal.symbol, side: signal.side,
      entryPrice: signal.markPrice, quantity, leverage: ASTER_DEFAULT_LEVERAGE,
      stopOrderId, entryTime: Date.now(), status: "open",
      peakPnlPct: 0, trailingStopActive: false,
      confidenceScore: signal.confidence, reasoning: signal.reasoning,
    };

    activeAsterPositions.set(positionId, position);
    log(`[AsterAgent] OPEN: ${signal.side} ${signal.symbol} @ ${signal.markPrice} | Order: ${order.orderId}`, "trading");
    return position;
  } catch (e: any) {
    log(`[AsterAgent] Trade error: ${e.message?.substring(0, 150)}`, "trading");
    return null;
  }
}

async function scanAsterAndTrade(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  if (asterScanRunning) return;
  asterScanRunning = true;
  try {
    await scanAsterInner(notifyFn);
  } finally {
    asterScanRunning = false;
  }
}

async function scanAsterInner(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  const asterUsers = await getAsterUsersWithCredentials();
  if (asterUsers.length === 0) return;

  const firstClient = asterUsers[0].client;
  const markets = await fetchAsterMarketData(firstClient);
  if (markets.length === 0) return;

  const signal = await aiEvaluateAsterMarkets(markets);
  if (!signal) return;

  log(`[AsterAgent] 🎯 ${signal.side} ${signal.symbol} (${signal.confidence}%) — ${signal.reasoning}`, "trading");

  const tradePromises = asterUsers.map(async user => {
    const userPos = Array.from(activeAsterPositions.values()).filter(p => p.chatId === user.chatId && p.status === "open");
    if (userPos.length >= ASTER_MAX_POSITIONS_PER_USER) return;
    if (userPos.some(p => p.symbol === signal.symbol)) return;

    const position = await executeAsterFuturesTrade(user.chatId, user.client, signal, notifyFn);
    if (position) {
      const frLabel = signal.fundingRate > 0 ? `+${(signal.fundingRate * 100).toFixed(4)}%` : `${(signal.fundingRate * 100).toFixed(4)}%`;
      let msg = `📊 ASTER: ${signal.side} ${signal.symbol}\n`;
      msg += `Entry: ~${signal.markPrice} | ${ASTER_DEFAULT_LEVERAGE}x | ${position.quantity}\n`;
      msg += `Confidence: ${signal.confidence}% | FR: ${frLabel} | 24h: ${signal.priceChangePct.toFixed(2)}%\n`;
      msg += `🧠 ${signal.reasoning}\n`;
      msg += `Trail stop: ${ASTER_TRAILING_STOP_PCT}%`;
      notifyFn(user.chatId, msg);
    }
  });

  await Promise.allSettled(tradePromises);
}

async function checkAsterPositions(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  const positionsByUser = new Map<number, AsterFuturesPosition[]>();
  for (const pos of Array.from(activeAsterPositions.values())) {
    if (pos.status !== "open") continue;
    if (!positionsByUser.has(pos.chatId)) positionsByUser.set(pos.chatId, []);
    positionsByUser.get(pos.chatId)!.push(pos);
  }

  const userChecks = Array.from(positionsByUser.entries()).map(async ([chatId, positions]) => {
    let client: AsterFuturesClient;
    try {
      const creds = await storage.getAsterCredentials(chatId.toString());
      if (!creds) {
        for (const pos of positions) {
          pos.status = "closed_manual"; pos.closedAt = Date.now();
          activeAsterPositions.delete(pos.id); asterTradeHistory.push(pos);
        }
        return;
      }
      client = createAsterFuturesClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
    } catch { return; }

    let livePositions: AsterPosition[];
    try {
      livePositions = await client.positions();
    } catch { return; }

    for (const pos of positions) {
      try {
        const livePos = livePositions.find(
          lp => lp.symbol === pos.symbol && (lp.positionSide === "BOTH" || lp.positionSide === pos.side)
        );

        if (!livePos || parseFloat(livePos.positionAmt) === 0) {
          const unrealized = livePos ? parseFloat(livePos.unRealizedProfit) : 0;
          pos.status = unrealized >= 0 ? "closed_profit" : "closed_loss";
          pos.pnlUsdt = unrealized.toFixed(4);
          pos.closedAt = Date.now();
          activeAsterPositions.delete(pos.id);
          asterTradeHistory.push(pos);
          asterTradeMemory.push({ symbol: pos.symbol, side: pos.side, result: pos.status === "closed_profit" ? "WIN" : "LOSS", pnl: unrealized, reasoning: "Closed on exchange" });
          if (asterTradeMemory.length > 20) asterTradeMemory.splice(0, asterTradeMemory.length - 20);

          const emoji = unrealized >= 0 ? "💰" : "📉";
          notifyFn(chatId, `${emoji} ASTER CLOSED: ${pos.side} ${pos.symbol}\nEntry: ${pos.entryPrice}\nPnL: ${unrealized >= 0 ? "+" : ""}${unrealized.toFixed(4)} USDT | ${Math.floor((Date.now() - pos.entryTime) / 60000)}m | ${pos.leverage}x`);
          continue;
        }

        const unrealizedPnl = parseFloat(livePos.unRealizedProfit);
        const notional = Math.abs(parseFloat(livePos.notional || "0"));
        const margin = notional > 0 ? notional / pos.leverage : parseFloat(ASTER_DEFAULT_POSITION_SIZE_USDT);
        const pnlPct = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;

        if (pnlPct > pos.peakPnlPct) pos.peakPnlPct = pnlPct;

        if (pnlPct > 2.0 && !pos.trailingStopActive) {
          pos.trailingStopActive = true;
          const markPrice = parseFloat(livePos.markPrice);
          const newStopPrice = pos.side === "LONG"
            ? (markPrice * (1 - ASTER_TRAILING_STOP_PCT / 100)).toFixed(6)
            : (markPrice * (1 + ASTER_TRAILING_STOP_PCT / 100)).toFixed(6);

          try {
            if (pos.stopOrderId) await client.cancelOrder(pos.symbol, pos.stopOrderId).catch(() => {});
            const stopSide = pos.side === "LONG" ? "SELL" as const : "BUY" as const;
            const newStop = await client.createOrder({
              symbol: pos.symbol, side: stopSide, type: "STOP_MARKET",
              stopPrice: newStopPrice, closePosition: true, positionSide: "BOTH",
            });
            pos.stopOrderId = newStop.orderId;
          } catch {}
        }

        if (pos.trailingStopActive && pos.peakPnlPct - pnlPct > ASTER_TRAILING_STOP_PCT) {
          try {
            const closeSide = pos.side === "LONG" ? "SELL" as const : "BUY" as const;
            await client.createOrder({
              symbol: pos.symbol, side: closeSide, type: "MARKET",
              quantity: pos.quantity, positionSide: "BOTH", reduceOnly: true,
            });
          } catch {}

          pos.status = unrealizedPnl >= 0 ? "closed_profit" : "closed_loss";
          pos.pnlUsdt = unrealizedPnl.toFixed(4);
          pos.closedAt = Date.now();
          activeAsterPositions.delete(pos.id);
          asterTradeHistory.push(pos);
          asterTradeMemory.push({ symbol: pos.symbol, side: pos.side, result: pos.status === "closed_profit" ? "WIN" : "LOSS", pnl: unrealizedPnl, reasoning: `Trail: ${pos.peakPnlPct.toFixed(2)}% → ${pnlPct.toFixed(2)}%` });
          if (asterTradeMemory.length > 20) asterTradeMemory.splice(0, asterTradeMemory.length - 20);

          notifyFn(chatId, `${unrealizedPnl >= 0 ? "💰" : "📉"} ASTER TRAIL STOP: ${pos.side} ${pos.symbol}\nEntry: ${pos.entryPrice} → ${livePos.markPrice}\nPnL: ${unrealizedPnl >= 0 ? "+" : ""}${unrealizedPnl.toFixed(4)} USDT (${pnlPct.toFixed(2)}%)\nPeak: ${pos.peakPnlPct.toFixed(2)}% | ${Math.floor((Date.now() - pos.entryTime) / 60000)}m | ${pos.leverage}x`);
        }

        if (pnlPct <= -10) {
          try {
            const closeSide = pos.side === "LONG" ? "SELL" as const : "BUY" as const;
            await client.createOrder({
              symbol: pos.symbol, side: closeSide, type: "MARKET",
              quantity: pos.quantity, positionSide: "BOTH", reduceOnly: true,
            });
          } catch {}

          pos.status = "closed_loss";
          pos.pnlUsdt = unrealizedPnl.toFixed(4);
          pos.closedAt = Date.now();
          activeAsterPositions.delete(pos.id);
          asterTradeHistory.push(pos);
          asterTradeMemory.push({ symbol: pos.symbol, side: pos.side, result: "LOSS", pnl: unrealizedPnl, reasoning: "Hard SL -10%" });
          if (asterTradeMemory.length > 20) asterTradeMemory.splice(0, asterTradeMemory.length - 20);

          notifyFn(chatId, `📉 ASTER STOP LOSS: ${pos.side} ${pos.symbol}\nEntry: ${pos.entryPrice}\nPnL: ${unrealizedPnl.toFixed(4)} USDT (${pnlPct.toFixed(2)}%)\n${Math.floor((Date.now() - pos.entryTime) / 60000)}m | ${pos.leverage}x`);
        }
      } catch {}
    }
  });

  await Promise.allSettled(userChecks);
}

export function getActiveAsterPositionsForUser(chatId: number): AsterFuturesPosition[] {
  return Array.from(activeAsterPositions.values()).filter(p => p.chatId === chatId && p.status === "open");
}

export function getAsterTradeHistoryForUser(chatId: number): AsterFuturesPosition[] {
  return asterTradeHistory.filter(p => p.chatId === chatId).slice(-20);
}

let notifyCallback: ((chatId: number, message: string) => void) | null = null;

export function startTradingAgent(notifyFn: (chatId: number, message: string) => void): void {
  if (running) return;
  running = true;
  notifyCallback = notifyFn;

  log("[TradingAgent] 🚀 Starting ULTRA trading agent", "trading");

  scanAndTrade(notifyFn).catch(() => {});
  copyTradeFromWhales(notifyFn).catch(() => {});

  scanTimer = setInterval(() => {
    scanAndTrade(notifyFn).catch(e => log(`[TradingAgent] Scan error: ${e.message?.substring(0, 80)}`, "trading"));
  }, SCAN_INTERVAL_MS);

  positionTimer = setInterval(() => {
    checkAndClosePositions(notifyFn).catch(e => log(`[TradingAgent] Check error: ${e.message?.substring(0, 80)}`, "trading"));
  }, POSITION_CHECK_INTERVAL_MS);

  copyTradeTimer = setInterval(() => {
    copyTradeFromWhales(notifyFn).catch(e => log(`[CopyTrade] Error: ${e.message?.substring(0, 80)}`, "trading"));
  }, COPY_TRADE_SCAN_INTERVAL_MS);

  asterScanTimer = setInterval(() => {
    scanAsterAndTrade(notifyFn).catch(e => log(`[AsterAgent] Scan error: ${e.message?.substring(0, 80)}`, "trading"));
  }, ASTER_SCAN_INTERVAL_MS);

  asterPositionTimer = setInterval(() => {
    checkAsterPositions(notifyFn).catch(e => log(`[AsterAgent] Check error: ${e.message?.substring(0, 80)}`, "trading"));
  }, ASTER_POSITION_CHECK_INTERVAL_MS);

  log(`[CopyTrade] Tracking ${COPY_TRADE_WALLETS.map(w => w.label).join(", ")}`, "trading");
  log(`[AsterAgent] Aster futures active`, "trading");
}

export function stopTradingAgent(): void {
  if (scanTimer) clearInterval(scanTimer);
  if (positionTimer) clearInterval(positionTimer);
  if (copyTradeTimer) clearInterval(copyTradeTimer);
  if (asterScanTimer) clearInterval(asterScanTimer);
  if (asterPositionTimer) clearInterval(asterPositionTimer);
  scanTimer = null; positionTimer = null; copyTradeTimer = null;
  asterScanTimer = null; asterPositionTimer = null;
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

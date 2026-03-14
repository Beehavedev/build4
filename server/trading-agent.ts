import { ethers } from "ethers";
import { storage } from "./storage";
import { log } from "./index";
import { runInferenceWithFallback } from "./inference";
import { recordTradingScan, recordTrade } from "./performance-monitor";
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
import {
  type UserSkillState,
  mergeSkillStates,
  evaluateStrategySkills,
  evaluateAnalysisSkills,
  getExecutionModifiers,
  buildSkillsPromptContext,
  getSkillById,
  SKILL_REGISTRY,
} from "./agent-skills";

const FOUR_MEME_API = "https://four.meme";
const AI_NETWORKS = ["hyperbolic", "akash", "ritual"];
const AI_MODEL = "deepseek-ai/DeepSeek-V3";

const COPY_TRADE_WALLETS = [
  { address: "0xd59b6a5dc9126ea0ebacd2d8560584b3ce48f62f", label: "GMGN Whale" },
  { address: "0x52e09b0ce502e8e1e7b4d46b10c67b1b2adc3a3a", label: "Smart Money 1" },
  { address: "0x3a0b5541e20cb8789307b8012b1e0e9e5bcd6072", label: "Smart Money 2" },
];

const SCAN_INTERVAL_MS = 15_000;
const SNIPER_SCAN_INTERVAL_MS = 5_000;
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
const TRAILING_STOP_ACTIVATION = 1.15;
const TRAILING_STOP_DISTANCE = 0.10;
const EMERGENCY_MAX_HOLD_MINUTES = 240;
const MAX_CONSECUTIVE_CHECK_FAILURES = 10;
const PROFIT_FEE_PERCENT = 20;

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
const FAILED_COOLDOWN_MS = 3_600_000;
const sessionBlacklist = new Set<string>();
const buyInProgress = new Set<string>();

let scanRunning = false;
let copyTradeRunning = false;
let asterScanRunning = false;
let positionCheckRunning = false;
let smartMoneyDiscoveryRunning = false;

interface SmartWallet {
  address: string;
  label: string;
  winCount: number;
  totalTrades: number;
  totalPnlBnb: number;
  avgEntryAge: number;
  discoveredAt: number;
  lastSeen: number;
  score: number;
}

const discoveredSmartWallets = new Map<string, SmartWallet>();
const SMART_MONEY_SCAN_INTERVAL_MS = 300_000;
const MIN_SMART_WALLET_TRADES = 3;
const MIN_SMART_WALLET_WIN_RATE = 50;
const MAX_TRACKED_SMART_WALLETS = 20;
let smartMoneyTimer: ReturnType<typeof setInterval> | null = null;

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
  source: "ai_scan" | "whale_copy" | "consensus" | "sniper" | "manual";
  entryProgressPercent?: number;
  entryAgeMinutes?: number;
  entryVelocity?: number;
  entryHolderCount?: number;
  entryRaisedBnb?: number;
  entryRugRisk?: number;
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
const userSkillsCache = new Map<number, { skills: UserSkillState[]; loadedAt: number }>();
const SKILL_CACHE_TTL_MS = 60_000;

async function getUserSkills(chatId: number): Promise<UserSkillState[]> {
  const cached = userSkillsCache.get(chatId);
  if (cached && Date.now() - cached.loadedAt < SKILL_CACHE_TTL_MS) return cached.skills;
  try {
    const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
    const skills = mergeSkillStates(dbConfigs);
    userSkillsCache.set(chatId, { skills, loadedAt: Date.now() });
    return skills;
  } catch {
    return mergeSkillStates([]);
  }
}

export function invalidateSkillsCache(chatId: number): void {
  userSkillsCache.delete(chatId);
}

export { SKILL_REGISTRY, getSkillById, mergeSkillStates };
export type { UserSkillState };

let scanTimer: ReturnType<typeof setInterval> | null = null;
let sniperTimer: ReturnType<typeof setInterval> | null = null;
let positionTimer: ReturnType<typeof setInterval> | null = null;
let copyTradeTimer: ReturnType<typeof setInterval> | null = null;
let instantSniperTimer: ReturnType<typeof setInterval> | null = null;
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

    restoreTradeMemoryFromDb().catch(() => {});
    buildLearnedPatterns().catch(() => {});

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
  try {
    const info = await Promise.race([
      fourMemeGetTokenInfo(address),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Token info timeout")), 12000)),
    ]);
    tokenInfoCache.set(address, { info, ts: Date.now() });
    if (tokenInfoCache.size > 300) {
      const keys = Array.from(tokenInfoCache.keys());
      for (let i = 0; i < keys.length - 150; i++) tokenInfoCache.delete(keys[i]);
    }
    return info;
  } catch (e: any) {
    if (cached) {
      log(`[TradingAgent] Token info fetch failed for ${address.substring(0, 10)}, using stale cache (${Math.round((Date.now() - cached.ts) / 1000)}s old)`, "trading");
      return cached.info;
    }
    throw e;
  }
}

interface FourMemeListingToken {
  address: string;
  name: string;
  symbol: string;
  launchTime: number;
  status: string;
  progressPercent: number;
  raisedAmount: number;
  maxFunds: number;
  lastPrice: string;
  holderCount: number;
  tradingVolume: number;
  marketCap: number;
  minuteIncrease: number;
  hourIncrease: number;
  dayIncrease: number;
  hasApiData: boolean;
}

function parseListingToken(t: any): FourMemeListingToken | null {
  const addr = t.address || t.tokenAddress || t.contractAddress;
  if (!addr) return null;

  const tp = t.tokenPrice || {};
  const progress = parseFloat(tp.progress || "0") * 100;
  const raised = parseFloat(tp.raisedAmount || t.raisedAmount || "0");
  const b0 = parseFloat(t.b0 || "0");
  const maxFunds = b0 > 0 ? b0 : parseFloat(tp.bamount || "0");
  const price = tp.price || "0";
  const holders = parseInt(tp.holderCount || "0");
  const trading = parseFloat(tp.trading || t.trading || "0");
  const mcap = parseFloat(tp.marketCap || t.marketCap || "0");
  const minuteInc = parseFloat(tp.minuteIncrease || tp.oneMinuteIncrease || "0");
  const hourInc = parseFloat(tp.hourIncrease || "0");
  const dayInc = parseFloat(tp.dayIncrease || "0");
  const launchTime = t.launchTime ? (typeof t.launchTime === "number" && t.launchTime > 1e12 ? Math.floor(t.launchTime / 1000) : t.launchTime) : (t.createDate ? Math.floor(parseInt(t.createDate) / 1000) : 0);

  return {
    address: addr,
    name: t.name || t.tokenName || t.shortName || "Unknown",
    symbol: t.shortName || t.symbol || "???",
    launchTime,
    status: t.status || "PUBLISH",
    progressPercent: progress,
    raisedAmount: raised,
    maxFunds,
    lastPrice: price,
    holderCount: holders,
    tradingVolume: trading,
    marketCap: mcap,
    minuteIncrease: minuteInc,
    hourIncrease: hourInc,
    dayIncrease: dayInc,
    hasApiData: !!tp.price,
  };
}

async function fetchNewTokens(): Promise<FourMemeListingToken[]> {
  const headers = { "Accept": "application/json", "Origin": "https://four.meme", "Referer": "https://four.meme/" };
  const results: FourMemeListingToken[] = [];
  const seen = new Set<string>();

  const addTokens = (tokens: any[]) => {
    for (const t of tokens) {
      const parsed = parseListingToken(t);
      if (!parsed || seen.has(parsed.address)) continue;
      seen.add(parsed.address);
      results.push(parsed);
    }
  };

  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const fullHeaders = { ...headers, "User-Agent": userAgent };

  const fetchEndpoint = async (url: string, label: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { headers: fullHeaders, signal: AbortSignal.timeout(15000) });
        if (!r.ok) {
          log(`[TradingAgent] ${label}: HTTP ${r.status} (attempt ${attempt + 1})`, "trading");
          if (attempt === 0) { await new Promise(r => setTimeout(r, 1000)); continue; }
          return;
        }
        const text = await r.text();
        let d: any;
        try { d = JSON.parse(text); } catch { log(`[TradingAgent] ${label}: invalid JSON (${text.substring(0, 100)})`, "trading"); return; }
        if (d.code === 0 && Array.isArray(d.data)) {
          addTokens(d.data);
          return;
        } else if (d.code === 0 && d.data?.list && Array.isArray(d.data.list)) {
          addTokens(d.data.list);
          return;
        } else {
          log(`[TradingAgent] ${label}: unexpected format code=${d.code} keys=${Object.keys(d).join(",")}`, "trading");
          return;
        }
      } catch (e: any) {
        log(`[TradingAgent] ${label}: ${e.message?.substring(0, 80)} (attempt ${attempt + 1})`, "trading");
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
  };

  const fetches = [
    fetchEndpoint(`${FOUR_MEME_API}/meme-api/v1/private/token/query?type=funding&pageIndex=1&pageSize=30`, "funding"),
    fetchEndpoint(`${FOUR_MEME_API}/meme-api/v1/private/token/query?type=new&pageIndex=1&pageSize=30`, "new"),
    fetchEndpoint(`${FOUR_MEME_API}/meme-api/v1/private/token/query?type=trending&pageIndex=1&pageSize=20`, "trending"),
    fetchEndpoint(`${FOUR_MEME_API}/meme-api/v1/private/token/ranking/exclusive`, "exclusive"),
  ];

  await Promise.race([
    Promise.all(fetches),
    new Promise<void>(resolve => setTimeout(resolve, 35000)),
  ]);

  log(`[TradingAgent] Fetched ${results.length} tokens (${results.filter(t => t.hasApiData).length} with price data)`, "trading");
  return results;
}

interface TokenSignal {
  address: string;
  name: string;
  symbol: string;
  score: number;
  reasons: string[];
  info: FourMemeTokenInfo;
  listing?: FourMemeListingToken;
  aiAnalysis?: string;
  aiDecision?: "BUY" | "SKIP";
  progressPercent?: number;
  ageMinutes?: number;
  velocity?: number;
  holderCount?: number;
  raisedBnb?: number;
  rugRisk?: number;
  whaleCount?: number;
  maxFunds?: number;
  tradingVolume?: number;
}

const tradeMemory: Array<{ symbol: string; result: string; pnl: number; reasoning: string; tokenAddress: string }> = [];

interface LearnedPatterns {
  bestProgressRange: { min: number; max: number; winRate: number };
  bestAgeRange: { min: number; max: number; winRate: number };
  bestVelocityRange: { min: number; max: number; winRate: number };
  bestHolderRange: { min: number; max: number; winRate: number };
  bestHours: number[];
  worstHours: number[];
  avgWinHoldMinutes: number;
  avgLossHoldMinutes: number;
  totalPnl: number;
  profitFactor: number;
  bestSource: string;
  avgWinPeak: number;
  avgLossPeak: number;
  lastAnalyzed: number;
  sampleSize: number;
}

let learnedPatterns: LearnedPatterns | null = null;
let patternsLastBuilt = 0;
const PATTERN_REBUILD_INTERVAL_MS = 300_000;

async function buildLearnedPatterns(): Promise<void> {
  if (Date.now() - patternsLastBuilt < PATTERN_REBUILD_INTERVAL_MS && learnedPatterns) return;

  try {
    const outcomes = await storage.getRecentTradeOutcomes(200);
    if (outcomes.length < 5) {
      learnedPatterns = null;
      return;
    }

    const wins = outcomes.filter((o: any) => o.pnlBnb > 0);
    const losses = outcomes.filter((o: any) => o.pnlBnb <= 0);

    const winProgressValues = wins.map((o: any) => o.entryProgressPercent).filter((v: number) => v > 0);
    const lossProgressValues = losses.map((o: any) => o.entryProgressPercent).filter((v: number) => v > 0);
    const winAgeValues = wins.map((o: any) => o.entryAgeMinutes).filter((v: number) => v > 0);
    const lossAgeValues = losses.map((o: any) => o.entryAgeMinutes).filter((v: number) => v > 0);
    const winVelocityValues = wins.map((o: any) => o.entryVelocity).filter((v: number) => v > 0);
    const winHolderValues = wins.map((o: any) => o.entryHolderCount).filter((v: number) => v > 0);

    function findBestRange(values: number[]): { min: number; max: number } {
      if (values.length === 0) return { min: 0, max: 100 };
      values.sort((a, b) => a - b);
      const p25 = values[Math.floor(values.length * 0.25)] || values[0];
      const p75 = values[Math.floor(values.length * 0.75)] || values[values.length - 1];
      return { min: p25, max: p75 };
    }

    const progressRange = findBestRange(winProgressValues);
    const progressWins = wins.filter((o: any) => o.entryProgressPercent >= progressRange.min && o.entryProgressPercent <= progressRange.max).length;
    const progressTotal = outcomes.filter((o: any) => o.entryProgressPercent >= progressRange.min && o.entryProgressPercent <= progressRange.max).length;

    const ageRange = findBestRange(winAgeValues);
    const ageWins = wins.filter((o: any) => o.entryAgeMinutes >= ageRange.min && o.entryAgeMinutes <= ageRange.max).length;
    const ageTotal = outcomes.filter((o: any) => o.entryAgeMinutes >= ageRange.min && o.entryAgeMinutes <= ageRange.max).length;

    const velRange = findBestRange(winVelocityValues);
    const holderRange = findBestRange(winHolderValues);

    const hourBuckets = new Map<number, { wins: number; total: number }>();
    for (const o of outcomes) {
      const h = (o as any).hourOfDay ?? 0;
      const bucket = hourBuckets.get(h) || { wins: 0, total: 0 };
      bucket.total++;
      if ((o as any).pnlBnb > 0) bucket.wins++;
      hourBuckets.set(h, bucket);
    }

    const hourRates = Array.from(hourBuckets.entries())
      .filter(([, b]) => b.total >= 2)
      .map(([h, b]) => ({ hour: h, rate: b.wins / b.total }))
      .sort((a, b) => b.rate - a.rate);

    const bestHours = hourRates.slice(0, 4).map(h => h.hour);
    const worstHours = hourRates.slice(-3).filter(h => h.rate < 0.3).map(h => h.hour);

    const sourcePerf = new Map<string, { wins: number; total: number }>();
    for (const o of outcomes) {
      const s = (o as any).source || "ai_scan";
      const sp = sourcePerf.get(s) || { wins: 0, total: 0 };
      sp.total++;
      if ((o as any).pnlBnb > 0) sp.wins++;
      sourcePerf.set(s, sp);
    }
    const bestSource = Array.from(sourcePerf.entries())
      .filter(([, v]) => v.total >= 2)
      .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))[0]?.[0] || "ai_scan";

    const totalWinPnl = wins.reduce((s: number, o: any) => s + o.pnlBnb, 0);
    const totalLossPnl = Math.abs(losses.reduce((s: number, o: any) => s + o.pnlBnb, 0));

    learnedPatterns = {
      bestProgressRange: { ...progressRange, winRate: progressTotal > 0 ? (progressWins / progressTotal) * 100 : 50 },
      bestAgeRange: { ...ageRange, winRate: ageTotal > 0 ? (ageWins / ageTotal) * 100 : 50 },
      bestVelocityRange: { ...velRange, winRate: 0 },
      bestHolderRange: { ...holderRange, winRate: 0 },
      bestHours,
      worstHours,
      avgWinHoldMinutes: wins.length > 0 ? wins.reduce((s: number, o: any) => s + (o.holdTimeMinutes || 0), 0) / wins.length : 5,
      avgLossHoldMinutes: losses.length > 0 ? losses.reduce((s: number, o: any) => s + (o.holdTimeMinutes || 0), 0) / losses.length : 3,
      totalPnl: outcomes.reduce((s: number, o: any) => s + o.pnlBnb, 0),
      profitFactor: totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? 99 : 0,
      bestSource,
      avgWinPeak: wins.length > 0 ? wins.reduce((s: number, o: any) => s + (o.peakMultiple || 1), 0) / wins.length : 1,
      avgLossPeak: losses.length > 0 ? losses.reduce((s: number, o: any) => s + (o.peakMultiple || 1), 0) / losses.length : 1,
      lastAnalyzed: Date.now(),
      sampleSize: outcomes.length,
    };

    patternsLastBuilt = Date.now();
    log(`[TradingAgent] Learned patterns from ${outcomes.length} trades: PF=${learnedPatterns.profitFactor.toFixed(2)}, best progress=${progressRange.min.toFixed(0)}-${progressRange.max.toFixed(0)}%, best age=${ageRange.min}-${ageRange.max}m`, "trading");
  } catch (e: any) {
    log(`[TradingAgent] Pattern analysis error: ${e.message?.substring(0, 100)}`, "trading");
  }
}

function buildLearnedInsights(): string {
  if (!learnedPatterns || learnedPatterns.sampleSize < 5) return "";

  const p = learnedPatterns;
  let insights = `\nLEARNED PATTERNS (from ${p.sampleSize} trades, PnL: ${p.totalPnl >= 0 ? "+" : ""}${p.totalPnl.toFixed(4)} BNB, PF: ${p.profitFactor.toFixed(2)}):\n`;
  insights += `• Best curve entry: ${p.bestProgressRange.min.toFixed(0)}-${p.bestProgressRange.max.toFixed(0)}% (${p.bestProgressRange.winRate.toFixed(0)}% win rate in this range)\n`;
  insights += `• Best token age: ${p.bestAgeRange.min}-${p.bestAgeRange.max}m (${p.bestAgeRange.winRate.toFixed(0)}% win rate)\n`;
  insights += `• Best velocity: ${p.bestVelocityRange.min.toFixed(1)}-${p.bestVelocityRange.max.toFixed(1)}%/min\n`;
  if (p.bestHolderRange.max > 0) insights += `• Best holder count: ${p.bestHolderRange.min}-${p.bestHolderRange.max}\n`;
  insights += `• Winning trades peak avg: ${p.avgWinPeak.toFixed(2)}x, losing trades peak avg: ${p.avgLossPeak.toFixed(2)}x\n`;
  insights += `• Best source: ${p.bestSource}\n`;
  if (p.bestHours.length > 0) insights += `• Best hours (UTC): ${p.bestHours.join(", ")}\n`;
  if (p.worstHours.length > 0) insights += `• Avoid hours (UTC): ${p.worstHours.join(", ")}\n`;
  insights += `• Winners hold avg ${p.avgWinHoldMinutes.toFixed(0)}m, losers hold avg ${p.avgLossHoldMinutes.toFixed(0)}m\n`;
  insights += `USE THESE PATTERNS: Favor tokens matching winning ranges. Be more selective outside these ranges. If current hour is in "avoid" list, raise confidence requirement.\n`;
  return insights;
}

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

async function restoreTradeMemoryFromDb(): Promise<void> {
  try {
    const outcomes = await storage.getRecentTradeOutcomes(30);
    if (outcomes.length === 0) return;

    tradeMemory.length = 0;
    for (const o of outcomes.reverse()) {
      tradeMemory.push({
        symbol: (o as any).tokenSymbol,
        result: (o as any).pnlBnb > 0 ? "WIN" : "LOSS",
        pnl: (o as any).pnlBnb,
        reasoning: (o as any).reasoning || (o as any).result,
        tokenAddress: (o as any).tokenAddress,
      });
    }
    for (const o of outcomes) {
      if ((o as any).pnlBnb < 0 && (o as any).tokenAddress) {
        sessionBlacklist.add((o as any).tokenAddress.toLowerCase());
        failedTokenCooldown.set((o as any).tokenAddress, Date.now());
      }
    }
    log(`[TradingAgent] Restored ${tradeMemory.length} trades from DB into memory, ${sessionBlacklist.size} blacklisted tokens`, "trading");
  } catch (e: any) {
    log(`[TradingAgent] Failed to restore trade memory: ${e.message?.substring(0, 100)}`, "trading");
  }
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
  } else if (source === "sniper") {
    multiplier = 1.5;
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
  let base: number;
  if (total < 3) base = 55;
  else if (rate >= 60) base = 45;
  else if (rate >= 45) base = 55;
  else if (rate >= 30) base = 65;
  else if (rate >= 20) base = 75;
  else base = 80;

  if (learnedPatterns && learnedPatterns.sampleSize >= 10) {
    const currentHour = new Date().getUTCHours();
    if (learnedPatterns.worstHours.includes(currentHour)) {
      base = Math.min(base + 10, 90);
    }
    if (learnedPatterns.profitFactor < 0.8 && learnedPatterns.sampleSize >= 15) {
      base = Math.min(base + 10, 90);
    }
  }

  return base;
}

function computeTokenScoreFromListing(token: FourMemeListingToken): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const progress = token.progressPercent;
  const age = Math.floor(Date.now() / 1000) - token.launchTime;
  const ageMin = Math.max(1, Math.floor(age / 60));
  const fundsNum = token.raisedAmount;
  const maxFundsNum = token.maxFunds;
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

  const smartBuyers = getSmartBuyersForToken(token.address);
  if (smartBuyers.length >= 2) { score += 25; reasons.push(`🧠 ${smartBuyers.length} smart wallets buying`); }
  else if (smartBuyers.length === 1) { score += 12; reasons.push(`🧠 Smart money: ${smartBuyers[0]}`); }

  const recentFail = failedTokenCooldown.get(token.address);
  if (recentFail && Date.now() - recentFail < FAILED_COOLDOWN_MS) {
    score -= 50;
    reasons.push("⚠️ Recently failed trade — cooldown");
  }

  if (learnedPatterns && learnedPatterns.sampleSize >= 15) {
    const lp = learnedPatterns;
    const inProgressRange = progress >= lp.bestProgressRange.min && progress <= lp.bestProgressRange.max;
    const inAgeRange = ageMin >= lp.bestAgeRange.min && ageMin <= lp.bestAgeRange.max;
    if (inProgressRange && inAgeRange) {
      score += 15;
      reasons.push("✅ In winning range");
    } else if (!inProgressRange && !inAgeRange) {
      score -= 20;
      reasons.push("⚠️ Outside winning ranges");
    }
  }

  return { score: Math.min(90, Math.round((score / 140) * 100)), reasons };
}

function listingToTokenInfo(t: FourMemeListingToken): FourMemeTokenInfo {
  return {
    version: 0,
    tokenManager: "",
    quote: "",
    lastPrice: t.lastPrice,
    tradingFeeRate: 0,
    minTradingFee: "0",
    launchTime: t.launchTime,
    offers: "0",
    maxOffers: "0",
    funds: t.raisedAmount.toString(),
    maxFunds: t.maxFunds.toString(),
    liquidityAdded: t.status === "TRADE",
    progressPercent: t.progressPercent,
  };
}

async function aiEvaluateBuy(tokens: FourMemeListingToken[]): Promise<TokenSignal | null> {
  if (tokens.length === 0) return null;

  const rugChecks = await Promise.all(tokens.slice(0, 5).map(t => checkCreatorHistory(t.address).catch(() => ({ rugRisk: 0, reasons: [] }))));

  const tokenDataLines = tokens.map((t, i) => {
    const age = Math.floor(Date.now() / 1000) - t.launchTime;
    const ageMin = Math.max(1, Math.floor(age / 60));
    const velocity = ageMin > 0 ? (t.progressPercent / ageMin).toFixed(2) : "0";
    const fundsVelocity = ageMin > 0 ? (t.raisedAmount / ageMin).toFixed(4) : "N/A";
    const rug = i < rugChecks.length ? rugChecks[i] : null;
    const rugLabel = rug && rug.rugRisk > 0 ? ` RUG=${rug.rugRisk}%` : "";
    const whaleInterest = whaleConsensus.has(t.address.toLowerCase()) ? ` WHALES=${whaleConsensus.get(t.address.toLowerCase())!.size}` : "";
    const { score: heuristicScore } = computeTokenScoreFromListing(t);
    const holdersLabel = t.holderCount > 0 ? `, Holders: ${t.holderCount}` : "";
    const minIncLabel = t.minuteIncrease > 0 ? `, 1mChg: +${(t.minuteIncrease * 100).toFixed(1)}%` : "";
    return `${i + 1}. $${t.symbol} (${t.name}) — Curve: ${t.progressPercent.toFixed(1)}%, Age: ${ageMin}m, Raised: ${t.raisedAmount.toFixed(3)}/${t.maxFunds.toFixed(1)} BNB, Vel: ${velocity}%/min, BNBflow: ${fundsVelocity}/min, Vol: ${t.tradingVolume.toFixed(2)} BNB${holdersLabel}${minIncLabel}, Heuristic: ${heuristicScore}%${rugLabel}${whaleInterest}`;
  }).join("\n");

  const memoryCtx = buildTradeMemoryContext();
  const winRate = getWinRate();
  const threshold = getAdaptiveConfidenceThreshold();
  await buildLearnedPatterns();
  const learnedInsights = buildLearnedInsights();

  const prompt = `You are a PROFESSIONAL meme token sniper on Four.meme (BNB Chain bonding curve). You are FAST, DECISIVE, and AGGRESSIVE when the signals are right. Analyze and decide which ONE to buy, or NONE.

TOKENS:
${tokenDataLines}

PERFORMANCE: ${winRate.total > 0 ? `${winRate.rate.toFixed(0)}% win rate over ${winRate.total} trades (adaptive threshold: ${threshold}%)` : "No history — be moderately aggressive to build data"}

TRADE MEMORY:
${memoryCtx}
${learnedInsights}
CRITICAL SIGNALS (ranked by importance):
1. WHALE INTEREST = multiple smart money wallets bought this. HIGHEST PRIORITY
2. VELOCITY >1%/min + Age <15min = parabolic early entry, STRONG BUY
3. BNB INFLOW >0.05/min = real buyers flooding in
4. Curve 8-25% + Velocity >0.5%/min = ideal entry with momentum
5. Raised >1 BNB with <10min age = explosive demand
6. Heuristic >65% = multiple signals converging
7. High holder count + fresh age = organic interest

RED FLAGS:
- RUG RISK > 20% = skip unless whale consensus
- Age >30min + Velocity <0.3%/min = dying
- Curve >50% = late entry
- 0 holders + 0 volume = dead token

RESPOND EXACTLY:
DECISION: BUY or SKIP
TOKEN: [number]
CONFIDENCE: [1-100]
REASONING: [1 sentence]`;

  try {
    const result = await Promise.race([
      runInferenceWithFallback(AI_NETWORKS, AI_MODEL, prompt, {
        systemPrompt: "Elite meme token sniper. Scan metrics, pull trigger FAST when signals align. Prefer trading over waiting. Be aggressive but not reckless. Respond concisely in 4 lines.",
        temperature: 0.4,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI timeout")), 12000)),
    ]);

    const output = result.text.trim();
    log(`[TradingAgent] AI: ${output.substring(0, 200)}`, "trading");

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
    const rawConfidence = parseInt(confidenceMatch?.[1] || "0");
    const confidence = Math.min(rawConfidence, 90);
    const reasoning = reasoningMatch?.[1]?.trim() || "AI analysis";

    if (decision !== "BUY" || tokenIdx < 0 || tokenIdx >= tokens.length || confidence < threshold) {
      log(`[TradingAgent] AI: SKIP (decision=${decision}, confidence=${confidence}, threshold=${threshold})`, "trading");
      return null;
    }

    const chosen = tokens[tokenIdx];
    const age = Math.floor(Date.now() / 1000) - chosen.launchTime;
    const velocity = age > 60 ? chosen.progressPercent / (age / 60) : 0;

    const ageMin = Math.max(1, Math.floor(age / 60));
    const rugCheck = rugChecks[tokenIdx] || { rugRisk: 0 };
    return {
      address: chosen.address,
      name: chosen.name,
      symbol: chosen.symbol,
      score: confidence,
      reasons: [
        `AI: ${confidence}%`,
        `Curve: ${chosen.progressPercent.toFixed(1)}%`,
        `Age: ${ageMin}m`,
        `Vel: ${velocity.toFixed(1)}%/min`,
        `Raised: ${chosen.raisedAmount.toFixed(3)} BNB`,
        chosen.holderCount > 0 ? `Holders: ${chosen.holderCount}` : "",
      ].filter(Boolean),
      info: listingToTokenInfo(chosen),
      listing: chosen,
      aiAnalysis: reasoning,
      aiDecision: "BUY",
      progressPercent: chosen.progressPercent,
      ageMinutes: ageMin,
      velocity,
      holderCount: chosen.holderCount,
      raisedBnb: chosen.raisedAmount,
      rugRisk: rugCheck.rugRisk,
      whaleCount: whaleConsensus.has(chosen.address.toLowerCase()) ? whaleConsensus.get(chosen.address.toLowerCase())!.size : 0,
      maxFunds: chosen.maxFunds,
      tradingVolume: chosen.tradingVolume,
    };
  } catch (e: any) {
    log(`[TradingAgent] AI failed, using rules: ${e.message?.substring(0, 80)}`, "trading");
    return fallbackEvaluateTokens(tokens);
  }
}

function fallbackEvaluateTokens(tokens: FourMemeListingToken[]): TokenSignal | null {
  let best: TokenSignal | null = null;
  let bestRawScore = 0;

  for (const token of tokens) {
    if (token.status === "TRADE") continue;
    const progress = token.progressPercent;
    if (progress < MIN_PROGRESS_FOR_ENTRY || progress > MAX_PROGRESS_FOR_ENTRY) continue;

    const age = Math.floor(Date.now() / 1000) - token.launchTime;
    if (age > MAX_TOKEN_AGE_SECONDS) continue;

    const { score, reasons } = computeTokenScoreFromListing(token);

    const threshold = getAdaptiveConfidenceThreshold();
    if (score >= threshold && score > bestRawScore) {
      bestRawScore = score;
      best = { address: token.address, name: token.name, symbol: token.symbol, score, reasons, info: listingToTokenInfo(token), listing: token };
    }
  }

  if (best) log(`[TradingAgent] Fallback picked: $${best.symbol} (score: ${best.score})`, "trading");
  return best;
}

const SNIPER_SCORE_THRESHOLD = 75;
const SNIPER_SLIPPAGE = 20;

function sniperEvaluate(token: FourMemeListingToken): { score: number; reasons: string[]; isSniper: boolean } {
  const progress = token.progressPercent;
  const age = Math.floor(Date.now() / 1000) - token.launchTime;
  const ageMin = Math.max(1, Math.floor(age / 60));
  const velocity = ageMin > 0 ? progress / ageMin : 0;
  const fundsVelocity = ageMin > 0 ? token.raisedAmount / ageMin : 0;

  let score = 0;
  const reasons: string[] = [];

  if (velocity > 2.0 && ageMin <= 10) {
    score += 40;
    reasons.push(`⚡ Parabolic ${velocity.toFixed(1)}%/min @ ${ageMin}m`);
  } else if (velocity > 1.0 && ageMin <= 15) {
    score += 30;
    reasons.push(`🔥 Strong ${velocity.toFixed(1)}%/min @ ${ageMin}m`);
  } else if (velocity > 0.5 && ageMin <= 10) {
    score += 20;
    reasons.push(`Fast ${velocity.toFixed(1)}%/min @ ${ageMin}m`);
  }

  if (progress >= 8 && progress <= 30) {
    score += 20;
    reasons.push(`Sweet curve ${progress.toFixed(1)}%`);
  } else if (progress > 30 && progress <= 50) {
    score += 10;
  }

  if (token.raisedAmount >= 2.0) {
    score += 15;
    reasons.push(`${token.raisedAmount.toFixed(2)} BNB raised`);
  } else if (token.raisedAmount >= 0.8) {
    score += 10;
  }

  if (fundsVelocity > 0.1) {
    score += 15;
    reasons.push(`BNB inflow ${fundsVelocity.toFixed(3)}/min`);
  } else if (fundsVelocity > 0.05) {
    score += 8;
  }

  const whaleInterest = whaleConsensus.get(token.address.toLowerCase());
  if (whaleInterest && whaleInterest.size >= 2) {
    score += 30;
    reasons.push(`🐋 ${whaleInterest.size} whale consensus`);
  } else if (whaleInterest && whaleInterest.size >= 1) {
    score += 15;
    reasons.push(`🐋 Whale spotted`);
  }

  if (token.holderCount >= 20) { score += 5; }
  if (token.minuteIncrease > 0.05) { score += 5; reasons.push(`+${(token.minuteIncrease * 100).toFixed(1)}% 1m`); }

  const finalScore = Math.min(100, score);
  return { score: finalScore, reasons, isSniper: finalScore >= SNIPER_SCORE_THRESHOLD };
}

const sniperScannedTokens = new Set<string>();
let sniperScanRunning = false;

async function sniperScan(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  if (sniperScanRunning) return;
  sniperScanRunning = true;
  try {
    await sniperScanInner(notifyFn);
  } finally {
    sniperScanRunning = false;
  }
}

async function sniperScanInner(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  const enabledUsers = await resolveEnabledUsers();
  if (enabledUsers.length === 0) return;

  const headers = { "Accept": "application/json", "Origin": "https://four.meme", "Referer": "https://four.meme/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };

  const sniperFetch = async (url: string): Promise<any[]> => {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return [];
      const d = await r.json();
      if (d.code === 0 && Array.isArray(d.data)) return d.data;
      if (d.code === 0 && d.data?.list && Array.isArray(d.data.list)) return d.data.list;
      return [];
    } catch { return []; }
  };

  const fetches = [
    sniperFetch(`${FOUR_MEME_API}/meme-api/v1/private/token/query?type=funding&pageIndex=1&pageSize=30`),
    sniperFetch(`${FOUR_MEME_API}/meme-api/v1/private/token/query?type=new&pageIndex=1&pageSize=20`),
  ];

  const rawResults = await Promise.race([
    Promise.all(fetches),
    new Promise<any[][]>(resolve => setTimeout(() => resolve([[], []]), 7000)),
  ]);

  const seen = new Set<string>();
  const tokens: FourMemeListingToken[] = [];
  for (const batch of rawResults) {
    for (const t of batch) {
      const parsed = parseListingToken(t);
      if (!parsed || seen.has(parsed.address)) continue;
      seen.add(parsed.address);
      tokens.push(parsed);
    }
  }

  if (tokens.length === 0) return;

  let sniperHit: { token: FourMemeListingToken; score: number; reasons: string[] } | null = null;

  for (const t of tokens) {
    if (sniperScannedTokens.has(t.address)) continue;
    if (sessionBlacklist.has(t.address.toLowerCase())) continue;
    if (t.status === "TRADE") continue;
    if (t.hasApiData && (t.progressPercent < MIN_PROGRESS_FOR_ENTRY || t.progressPercent > MAX_PROGRESS_FOR_ENTRY)) continue;
    const age = Math.floor(Date.now() / 1000) - t.launchTime;
    if (t.launchTime > 0 && age > MAX_TOKEN_AGE_SECONDS) continue;
    if (failedTokenCooldown.has(t.address) && Date.now() - failedTokenCooldown.get(t.address)! < FAILED_COOLDOWN_MS) continue;

    const result = sniperEvaluate(t);
    if (result.isSniper && (!sniperHit || result.score > sniperHit.score)) {
      sniperHit = { token: t, score: result.score, reasons: result.reasons };
    }
  }

  for (const t of tokens) sniperScannedTokens.add(t.address);
  if (sniperScannedTokens.size > 300) {
    const arr = Array.from(sniperScannedTokens);
    for (let i = 0; i < arr.length - 150; i++) sniperScannedTokens.delete(arr[i]);
  }

  if (!sniperHit) return;

  const signal: TokenSignal = {
    address: sniperHit.token.address,
    name: sniperHit.token.name,
    symbol: sniperHit.token.symbol,
    score: sniperHit.score,
    reasons: sniperHit.reasons,
    info: listingToTokenInfo(sniperHit.token),
    listing: sniperHit.token,
    aiAnalysis: "⚡ SNIPER MODE — instant entry",
    progressPercent: sniperHit.token.progressPercent,
    holderCount: sniperHit.token.holderCount,
    raisedBnb: sniperHit.token.raisedAmount,
    maxFunds: sniperHit.token.maxFunds,
  };

  log(`[SNIPER] ⚡ HIT: $${signal.symbol} (${signal.score}%) — ${sniperHit.reasons.join(" | ")}`, "trading");

  recentlyScannedTokens.add(signal.address);

  const buyPromises = enabledUsers.map(async user => {
    const openCount = Array.from(activePositions.values()).filter(p => p.chatId === user.chatId && p.status === "open").length;
    const config = getUserConfig(user.chatId);
    if (openCount >= config.maxPositions) return;

    const alreadyHolding = Array.from(activePositions.values()).some(
      p => p.chatId === user.chatId && p.tokenAddress === signal.address && p.status === "open"
    );
    if (alreadyHolding) return;

    const execMods = getExecutionModifiers(await getUserSkills(user.chatId));

    const position = await executeBuy(user.chatId, user.agentId, signal, user.privateKey, user.walletAddress, "sniper", execMods, true);
    if (position) {
      let msg = `⚡ SNIPER TRADE: $${signal.symbol}\n`;
      msg += `Amount: ${position.entryPriceBnb} BNB | Score: ${signal.score}%\n`;
      sniperHit!.reasons.forEach(r => { msg += `• ${r}\n`; });
      msg += `TP: ${config.takeProfitMultiple}x | SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
      if (position.buyTxHash) msg += `TX: https://bscscan.com/tx/${position.buyTxHash}`;
      notifyFn(user.chatId, msg);
    }
  });

  await Promise.allSettled(buyPromises);
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
${learnedPatterns ? `LEARNED: Winners hold avg ${learnedPatterns.avgWinHoldMinutes.toFixed(0)}m (peak ${learnedPatterns.avgWinPeak.toFixed(2)}x), losers hold avg ${learnedPatterns.avgLossHoldMinutes.toFixed(0)}m (peak ${learnedPatterns.avgLossPeak.toFixed(2)}x). PF: ${learnedPatterns.profitFactor.toFixed(2)}` : ""}
Rules: Accelerating+profitable=HOLD. Decelerating+profitable=SELL. Drawdown>15%+decelerating=SELL. Near TP+accelerating=HOLD (let run). Low win rate=take profits earlier. Use LEARNED data to optimize hold time.

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
      log(`[TradingAgent] AI sell empty/no-provider for ${position.tokenSymbol}, using fallback`, "trading");
      return aiTimeoutFallback(position, multiple, ageMinutes, momentum);
    }

    const decisionMatch = output.match(/DECISION:\s*(HOLD|SELL)/i) || output.match(/\b(SELL|HOLD)\b/i);
    const reasoningMatch = output.match(/REASONING:\s*(.+)/i);

    if (!decisionMatch) {
      log(`[TradingAgent] AI sell malformed for ${position.tokenSymbol}, using fallback`, "trading");
      return aiTimeoutFallback(position, multiple, ageMinutes, momentum);
    }

    return {
      decision: decisionMatch[1].toUpperCase() === "SELL" ? "SELL" : "HOLD",
      reasoning: reasoningMatch?.[1]?.trim() || "AI decision",
    };
  } catch (e: any) {
    log(`[TradingAgent] AI sell failed: ${e.message?.substring(0, 60)}`, "trading");
    return aiTimeoutFallback(position, multiple, ageMinutes, momentum);
  }
}

function aiTimeoutFallback(
  position: TradingPosition,
  multiple: number,
  ageMinutes: number,
  momentum?: { trend: string; velocityChange: number; description: string },
): { decision: "HOLD" | "SELL"; reasoning: string } {
  if (multiple >= position.takeProfitMultiple) return { decision: "SELL", reasoning: "Hit TP (fallback)" };
  if (multiple <= position.stopLossMultiple) return { decision: "SELL", reasoning: "Hit SL (fallback)" };

  const drawdownFromPeak = position.peakMultiple > 0 ? (1 - multiple / position.peakMultiple) : 0;

  if (drawdownFromPeak > 0.20) {
    return { decision: "SELL", reasoning: `Drawdown ${(drawdownFromPeak * 100).toFixed(0)}% from peak (fallback)` };
  }

  if (ageMinutes > 60 && multiple < 1.0) {
    return { decision: "SELL", reasoning: `Losing position held ${ageMinutes.toFixed(0)}m (fallback)` };
  }

  if (ageMinutes > 45 && multiple >= 1.05 && momentum?.trend === "decelerating") {
    return { decision: "SELL", reasoning: `Decelerating profit after ${ageMinutes.toFixed(0)}m (fallback)` };
  }

  if (ageMinutes > 90 && multiple < 1.10) {
    return { decision: "SELL", reasoning: `Stale position after ${ageMinutes.toFixed(0)}m (fallback)` };
  }

  if (multiple >= 1.3 && drawdownFromPeak > 0.12) {
    return { decision: "SELL", reasoning: `Profitable but trailing ${(drawdownFromPeak * 100).toFixed(0)}% (fallback)` };
  }

  return { decision: "HOLD", reasoning: "Within range (fallback)" };
}

function hasActivePositionForToken(tokenAddress: string, chatId?: number): boolean {
  const addr = tokenAddress.toLowerCase();
  for (const pos of activePositions.values()) {
    if (pos.tokenAddress.toLowerCase() === addr && pos.status === "open") {
      if (chatId === undefined || pos.chatId === chatId) return true;
    }
  }
  return false;
}

async function executeBuy(chatId: number, agentId: string, signal: TokenSignal, privateKey: string, walletAddress: string, source: "ai_scan" | "whale_copy" | "consensus" | "sniper" = "ai_scan", execMods?: import("./agent-skills").ExecutionModifier, priorityGas: boolean = false): Promise<TradingPosition | null> {
  const buyKey = `${chatId}_${signal.address.toLowerCase()}`;

  if (hasActivePositionForToken(signal.address, chatId)) {
    log(`[TradingAgent] SKIP BUY ${signal.symbol} — already have active position for this token (chat ${chatId})`, "trading");
    return null;
  }

  if (sessionBlacklist.has(signal.address.toLowerCase())) {
    log(`[TradingAgent] SKIP BUY ${signal.symbol} — token is blacklisted this session`, "trading");
    return null;
  }

  if (buyInProgress.has(buyKey)) {
    log(`[TradingAgent] SKIP BUY ${signal.symbol} — buy already in progress for this token (chat ${chatId})`, "trading");
    return null;
  }

  buyInProgress.add(buyKey);

  const config = getUserConfig(chatId);
  const positionId = `trade_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  let dynamicAmount = calculateDynamicBuyAmount(config.buyAmountBnb, signal.score, source);

  if (execMods?.sizeMultiplier && execMods.sizeMultiplier !== 1.0) {
    const adjusted = (parseFloat(dynamicAmount) * execMods.sizeMultiplier).toFixed(4);
    log(`[TradingAgent] Skill size modifier: ${dynamicAmount} → ${adjusted} BNB (${execMods.sizeMultiplier}x)`, "trading");
    dynamicAmount = adjusted;
  }

  try {
    log(`[TradingAgent] BUYING ${signal.symbol} for ${dynamicAmount} BNB (conf: ${signal.score}, src: ${source})`, "trading");

    const slippage = priorityGas ? SNIPER_SLIPPAGE : DEFAULT_SLIPPAGE;
    const result = await fourMemeBuyToken(signal.address, dynamicAmount, slippage, privateKey, priorityGas);

    if (!result.success) {
      log(`[TradingAgent] Buy FAILED ${signal.symbol}: ${result.error}`, "trading");
      failedTokenCooldown.set(signal.address, Date.now());
      return null;
    }

    let tokenBalance = "0";
    try {
      await new Promise(r => setTimeout(r, priorityGas ? 500 : 2000));
      const bal = await fourMemeGetTokenBalance(signal.address, walletAddress);
      tokenBalance = bal.balance;
    } catch {}

    const tp = execMods?.takeProfitOverride || config.takeProfitMultiple;
    const sl = execMods?.stopLossOverride || config.stopLossMultiple;

    const position: TradingPosition = {
      id: positionId, chatId, agentId, walletAddress,
      tokenAddress: signal.address, tokenSymbol: signal.symbol,
      entryPriceBnb: dynamicAmount, tokenAmount: tokenBalance,
      buyTxHash: result.txHash || "", entryTime: Date.now(),
      takeProfitMultiple: tp, stopLossMultiple: sl,
      status: "open", peakMultiple: 1.0, trailingStopActive: false,
      confidenceScore: signal.score, source,
      entryProgressPercent: signal.progressPercent,
      entryAgeMinutes: signal.ageMinutes,
      entryVelocity: signal.velocity,
      entryHolderCount: signal.holderCount,
      entryRaisedBnb: signal.raisedBnb,
      entryRugRisk: signal.rugRisk,
    };

    if (execMods?.scaledExitLevels) {
      (position as any)._scaledExitLevels = execMods.scaledExitLevels;
      (position as any)._scaledExitSold = [];
    }
    if (execMods?.maxHoldMinutes) {
      (position as any)._maxHoldMinutes = execMods.maxHoldMinutes;
      (position as any)._timeExitOnlyLosers = execMods.maxHoldOnlyLosers || false;
    }
    if (execMods?.trailingStopActivation) {
      (position as any)._trailingStopActivation = execMods.trailingStopActivation;
      (position as any)._trailingStopDistance = execMods.trailingStopDistance || 0.12;
    }

    activePositions.set(positionId, position);
    sessionBlacklist.add(signal.address.toLowerCase());
    buyInProgress.delete(buyKey);
    balanceCache.delete(walletAddress);
    recordTrade();
    log(`[TradingAgent] Position OPEN: ${signal.symbol} | ${tokenBalance} tokens for ${dynamicAmount} BNB | TX: ${result.txHash}`, "trading");
    return position;
  } catch (e: any) {
    log(`[TradingAgent] Buy error: ${e.message?.substring(0, 150)}`, "trading");
    failedTokenCooldown.set(signal.address, Date.now());
    buyInProgress.delete(buyKey);
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
        const ageMinutes = (Date.now() - position.entryTime) / 60000;
        const consecutiveFailures = (position as any)._checkFailures || 0;

        if (ageMinutes > EMERGENCY_MAX_HOLD_MINUTES || consecutiveFailures >= MAX_CONSECUTIVE_CHECK_FAILURES) {
          const reason = ageMinutes > EMERGENCY_MAX_HOLD_MINUTES
            ? `Emergency: held ${ageMinutes.toFixed(0)}m past ${EMERGENCY_MAX_HOLD_MINUTES}m max`
            : `Emergency: ${consecutiveFailures} consecutive check failures`;
          log(`[TradingAgent] EMERGENCY force-sell ${position.tokenSymbol}: ${reason}`, "trading");

          let emergencyMultiple = 0.5;
          let emergencyValue = parseFloat(position.entryPriceBnb) * 0.5;
          try {
            const info = await getCachedTokenInfo(position.tokenAddress);
            const tokenAmountNum = parseFloat(position.tokenAmount);
            if (tokenAmountNum > 0) {
              emergencyValue = parseFloat(info.lastPrice) * tokenAmountNum;
              emergencyMultiple = parseFloat(position.entryPriceBnb) > 0 ? emergencyValue / parseFloat(position.entryPriceBnb) : 0.5;
            }
          } catch {}

          await closePosition(position, "closed_loss", notifyFn, emergencyMultiple, emergencyValue, reason);
          return;
        }

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

        if (multiple > position.peakMultiple) position.peakMultiple = multiple;

        (position as any)._checkFailures = 0;

        const tsActivation = (position as any)._trailingStopActivation || TRAILING_STOP_ACTIVATION;
        const tsDistance = (position as any)._trailingStopDistance || TRAILING_STOP_DISTANCE;

        if (!position.trailingStopActive && multiple >= tsActivation) {
          position.trailingStopActive = true;
          log(`[TradingAgent] ${position.tokenSymbol} trailing ACTIVE at ${multiple.toFixed(2)}x`, "trading");
        }

        const momentum = analyzeMomentum(posId, multiple, info.progressPercent);

        if (info.liquidityAdded) {
          await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb, "Token graduated to DEX");
          return;
        }

        if (position.trailingStopActive) {
          const trailingStopLevel = position.peakMultiple * (1 - tsDistance);
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

        const maxHold = (position as any)._maxHoldMinutes;
        const onlyLosers = (position as any)._timeExitOnlyLosers;
        const staleLimit = maxHold || 90;
        const timeExitApplies = maxHold
          ? (onlyLosers ? multiple < 1.0 : true)
          : multiple < 1.05;
        if (ageMinutes > staleLimit && timeExitApplies) {
          const reason = maxHold ? `⏰ Time exit (${maxHold}m limit)` : "Stale — no movement after 90m";
          await closePosition(position, multiple >= 1 ? "closed_profit" : "closed_loss", notifyFn, multiple, currentValueBnb, reason);
          return;
        }

        if (multiple >= 1.15 || multiple <= 0.85 || ageMinutes > 30) {
          const aiSell = await aiEvaluateSell(position, info, multiple, ageMinutes, momentum);
          if (aiSell.decision === "SELL") {
            await closePosition(position, multiple >= 1 ? "closed_profit" : "closed_loss", notifyFn, multiple, currentValueBnb, aiSell.reasoning);
          }
        }
      } catch (e: any) {
        const failures = ((position as any)._checkFailures || 0) + 1;
        (position as any)._checkFailures = failures;
        log(`[TradingAgent] Check error ${position.tokenSymbol} (fail ${failures}/${MAX_CONSECUTIVE_CHECK_FAILURES}): ${e.message?.substring(0, 80)}`, "trading");
      }
    });

    await Promise.allSettled(checks);
  } finally {
    positionCheckRunning = false;
  }
}

function getTreasuryWallet(): string | null {
  const pk = process.env.BOUNTY_WALLET_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || process.env.CHAOS_AGENT_PRIVATE_KEY;
  if (!pk) return null;
  try {
    return new ethers.Wallet(pk).address;
  } catch {
    return null;
  }
}

async function collectProfitFee(
  userPrivateKey: string,
  profitBnb: number,
  tokenSymbol: string,
): Promise<{ success: boolean; feeBnb: number; txHash?: string; error?: string }> {
  const treasury = getTreasuryWallet();
  if (!treasury) {
    log(`[ProfitFee] No treasury wallet configured — skipping fee`, "trading");
    return { success: false, feeBnb: 0, error: "No treasury wallet" };
  }

  const feeBnb = profitBnb * (PROFIT_FEE_PERCENT / 100);
  if (feeBnb < 0.0001) {
    log(`[ProfitFee] Fee too small (${feeBnb.toFixed(6)} BNB) for $${tokenSymbol} — skipping`, "trading");
    return { success: true, feeBnb: 0 };
  }

  try {
    const provider = getProvider();
    const wallet = new ethers.Wallet(userPrivateKey, provider);

    if (wallet.address.toLowerCase() === treasury.toLowerCase()) {
      return { success: true, feeBnb: 0 };
    }

    const balance = await provider.getBalance(wallet.address);
    const feeWei = ethers.parseEther(feeBnb.toFixed(8));
    const gasBuffer = ethers.parseEther("0.0005");

    if (balance < feeWei + gasBuffer) {
      log(`[ProfitFee] Insufficient balance for fee (${ethers.formatEther(balance)} BNB vs ${feeBnb.toFixed(6)} fee)`, "trading");
      return { success: false, feeBnb, error: "Insufficient balance for fee" };
    }

    log(`[ProfitFee] Collecting ${PROFIT_FEE_PERCENT}% fee: ${feeBnb.toFixed(6)} BNB from $${tokenSymbol} profit → ${treasury.substring(0, 10)}...`, "trading");

    const tx = await wallet.sendTransaction({
      to: treasury,
      value: feeWei,
      gasLimit: 21000,
    });

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      return { success: false, feeBnb, error: "Fee transaction reverted" };
    }

    log(`[ProfitFee] Fee collected: ${feeBnb.toFixed(6)} BNB | TX: ${receipt.hash}`, "trading");
    return { success: true, feeBnb, txHash: receipt.hash };
  } catch (e: any) {
    log(`[ProfitFee] Fee collection failed: ${e.message?.substring(0, 150)}`, "trading");
    return { success: false, feeBnb, error: e.message?.substring(0, 100) };
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

    const ageMinutes = (Date.now() - position.entryTime) / 60000;
    const isUrgent = ageMinutes > 120 || aiReasoning?.includes("Emergency");
    const SELL_MAX_RETRIES = isUrgent ? 5 : 3;
    let sellResult: { success: boolean; txHash?: string; error?: string } = { success: false, error: "Not attempted" };

    for (let attempt = 1; attempt <= SELL_MAX_RETRIES; attempt++) {
      try {
        sellResult = await fourMemeSellToken(position.tokenAddress, sellAmount, pk);
        if (sellResult.success) break;

        log(`[TradingAgent] Sell attempt ${attempt}/${SELL_MAX_RETRIES} failed for ${position.tokenSymbol}: ${sellResult.error?.substring(0, 100)}`, "trading");

        if (attempt < SELL_MAX_RETRIES) {
          const backoffMs = (isUrgent ? 2000 : 3000) * attempt;
          log(`[TradingAgent] Retrying sell in ${backoffMs / 1000}s...`, "trading");
          await new Promise(r => setTimeout(r, backoffMs));

          try {
            const freshBal = await fourMemeGetTokenBalance(position.tokenAddress, position.walletAddress);
            if (parseFloat(freshBal.balance) > 0) {
              sellAmount = freshBal.balance;
              position.tokenAmount = sellAmount;
            }
          } catch {}
        }
      } catch (e: any) {
        sellResult = { success: false, error: e.message?.substring(0, 150) || "Unknown error" };
        log(`[TradingAgent] Sell attempt ${attempt}/${SELL_MAX_RETRIES} threw for ${position.tokenSymbol}: ${sellResult.error}`, "trading");

        if (attempt < SELL_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, (isUrgent ? 2000 : 3000) * attempt));
        }
      }
    }

    if (!sellResult.success) {
      const retryCount = ((position as any)._sellRetries || 0) + 1;
      (position as any)._sellRetries = retryCount;
      const maxCycles = isUrgent ? 8 : 5;

      if (retryCount < maxCycles) {
        log(`[TradingAgent] All ${SELL_MAX_RETRIES} sell attempts failed for ${position.tokenSymbol}, keeping position open for retry (cycle ${retryCount}/${maxCycles})`, "trading");
        notifyFn(position.chatId,
          `⚠️ Sell failed for $${position.tokenSymbol} — retrying automatically next cycle (attempt ${retryCount}/${maxCycles})\nError: ${sellResult.error?.substring(0, 80)}`
        );
        return;
      }

      log(`[TradingAgent] Exhausted all sell retries for ${position.tokenSymbol} after ${maxCycles} cycles, force-closing position`, "trading");
      notifyFn(position.chatId,
        `❌ Failed to sell $${position.tokenSymbol} after multiple retries.\nTokens may still be in your wallet — use manual sell to try again.\nLast error: ${sellResult.error?.substring(0, 80)}`
      );
    }

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

    const holdTimeMinutes = Math.floor((Date.now() - position.entryTime) / 60000);
    storage.saveTradeOutcome({
      chatId: position.chatId.toString(),
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      result: reason,
      pnlBnb: pnl,
      peakMultiple: position.peakMultiple,
      entryPriceBnb: entryBnb,
      holdTimeMinutes,
      confidenceScore: position.confidenceScore,
      source: position.source,
      entryProgressPercent: position.entryProgressPercent,
      entryAgeMinutes: position.entryAgeMinutes,
      entryVelocity: position.entryVelocity,
      entryHolderCount: position.entryHolderCount,
      entryRaisedBnb: position.entryRaisedBnb,
      entryRugRisk: position.entryRugRisk,
      reasoning: aiReasoning || reason,
      hourOfDay: new Date().getUTCHours(),
    }).catch(e => log(`[TradingAgent] Save outcome error: ${e.message}`, "trading"));

    if (pnl < 0) {
      failedTokenCooldown.set(position.tokenAddress, Date.now());
      sessionBlacklist.add(position.tokenAddress.toLowerCase());
    }

    let feeResult: { success: boolean; feeBnb: number; txHash?: string } = { success: false, feeBnb: 0 };
    if (sellResult.success && pnl > 0 && pk) {
      try {
        feeResult = await collectProfitFee(pk, pnl, position.tokenSymbol);
      } catch (e: any) {
        log(`[ProfitFee] Error collecting fee for ${position.tokenSymbol}: ${e.message?.substring(0, 100)}`, "trading");
      }
    }

    if (sellResult.success) {
      const emoji = reason === "closed_profit" ? "💰" : "📉";
      const netPnl = pnl > 0 && feeResult.feeBnb > 0 ? pnl - feeResult.feeBnb : pnl;
      const pnlStr = netPnl >= 0 ? `+${netPnl.toFixed(4)}` : netPnl.toFixed(4);
      const holdTime = Math.floor((Date.now() - position.entryTime) / 60000);

      let msg = `${emoji} CLOSED: $${position.tokenSymbol}\n`;
      msg += `Entry: ${position.entryPriceBnb} BNB → Exit: ~${currentValueBnb.toFixed(4)} BNB\n`;
      msg += `PnL: ${pnlStr} BNB (${multiple.toFixed(2)}x) | Peak: ${position.peakMultiple.toFixed(2)}x | ${holdTime}m\n`;
      if (feeResult.feeBnb > 0) msg += `📋 Platform fee: ${feeResult.feeBnb.toFixed(4)} BNB (${PROFIT_FEE_PERCENT}% of profit)\n`;
      if (aiReasoning) msg += `🧠 ${aiReasoning}\n`;
      if (sellResult.txHash) msg += `TX: https://bscscan.com/tx/${sellResult.txHash}`;
      notifyFn(position.chatId, msg);
    }
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
  const scanStart = Date.now();
  try {
    await scanAndTradeInner(notifyFn);
  } finally {
    scanRunning = false;
    recordTradingScan(Date.now() - scanStart);
  }
}

let lastPreferenceRetry = 0;
const PREFERENCE_RETRY_INTERVAL_MS = 60_000;

async function scanAndTradeInner(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  let enabledCount = Array.from(userTradingConfig.values()).filter(c => c.enabled).length;

  if (enabledCount === 0 && Date.now() - lastPreferenceRetry > PREFERENCE_RETRY_INTERVAL_MS) {
    lastPreferenceRetry = Date.now();
    try {
      const restored = await restoreTradingPreferences();
      if (restored > 0) {
        log(`[TradingAgent] Retry restored ${restored} users from DB`, "trading");
        enabledCount = restored;
      }
    } catch (e: any) {
      log(`[TradingAgent] Preference retry failed: ${e.message?.substring(0, 60)}`, "trading");
    }
  }

  if (enabledCount === 0) return;

  const [tokens, enabledUsers] = await Promise.all([
    fetchNewTokens(),
    resolveEnabledUsers(),
  ]);

  if (tokens.length === 0) {
    log(`[TradingAgent] No tokens from Four.meme API`, "trading");
    return;
  }

  if (enabledUsers.length === 0) {
    log(`[TradingAgent] ${enabledCount} enabled configs but 0 valid users (low balance or no wallet)`, "trading");
    return;
  }

  const candidates = tokens.filter(t => {
    if (recentlyScannedTokens.has(t.address)) return false;
    if (sessionBlacklist.has(t.address.toLowerCase())) return false;
    if (t.status === "TRADE") return false;
    if (t.hasApiData && (t.progressPercent < MIN_PROGRESS_FOR_ENTRY || t.progressPercent > MAX_PROGRESS_FOR_ENTRY)) return false;
    const age = Math.floor(Date.now() / 1000) - t.launchTime;
    if (t.launchTime > 0 && age > MAX_TOKEN_AGE_SECONDS) return false;
    if (failedTokenCooldown.has(t.address) && Date.now() - failedTokenCooldown.get(t.address)! < FAILED_COOLDOWN_MS) return false;
    return true;
  });

  for (const t of tokens) recentlyScannedTokens.add(t.address);
  if (recentlyScannedTokens.size > 500) {
    const arr = Array.from(recentlyScannedTokens);
    for (let i = 0; i < arr.length - 200; i++) recentlyScannedTokens.delete(arr[i]);
  }

  if (candidates.length === 0) {
    log(`[TradingAgent] Scan: ${tokens.length} tokens, ${candidates.length} candidates`, "trading");
    return;
  }

  log(`[TradingAgent] ${candidates.length} candidates from ${tokens.length} tokens → AI`, "trading");

  const firstUser = enabledUsers[0];
  const stratSkills = await getUserSkills(firstUser.chatId);
  const scoredCandidates = candidates.map(t => {
    const age = Math.floor(Date.now() / 1000) - t.launchTime;
    const ageMin = Math.max(1, Math.floor(age / 60));
    const velocity = ageMin > 0 ? t.progressPercent / ageMin : 0;
    const whaleCount = whaleConsensus.has(t.address.toLowerCase()) ? whaleConsensus.get(t.address.toLowerCase())!.size : 0;
    const stratResult = evaluateStrategySkills(stratSkills, {
      velocity,
      ageMinutes: ageMin,
      progressPercent: t.progressPercent,
      raisedBnb: t.raisedAmount,
      holderCount: t.holderCount,
      tradingVolume: t.tradingVolume,
      whaleCount,
    });
    return { token: t, stratBoost: stratResult.scoreModifier, stratReason: stratResult.reason };
  });

  scoredCandidates.sort((a, b) => b.stratBoost - a.stratBoost);
  const sortedTokens = scoredCandidates.map(c => c.token);

  const bestSignal = await aiEvaluateBuy(sortedTokens.slice(0, 15));
  if (!bestSignal) return;

  const matchedStrat = scoredCandidates.find(c => c.token.address === bestSignal.address);
  if (matchedStrat && matchedStrat.stratBoost > 0) {
    bestSignal.score = Math.min(100, bestSignal.score + matchedStrat.stratBoost);
    bestSignal.reasons.push(matchedStrat.stratReason);
  }

  log(`[TradingAgent] SIGNAL: $${bestSignal.symbol} (${bestSignal.score}%) — ${bestSignal.aiAnalysis}`, "trading");

  const buyPromises = enabledUsers.map(async user => {
    const openCount = Array.from(activePositions.values()).filter(p => p.chatId === user.chatId && p.status === "open").length;
    const config = getUserConfig(user.chatId);
    if (openCount >= config.maxPositions) return;

    const alreadyHolding = Array.from(activePositions.values()).some(
      p => p.chatId === user.chatId && p.tokenAddress === bestSignal.address && p.status === "open"
    );
    if (alreadyHolding) return;

    const userSkills = await getUserSkills(user.chatId);

    const analysisResult = evaluateAnalysisSkills(userSkills, {
      rugRisk: bestSignal.rugRisk || 0,
      holderCount: bestSignal.holderCount || 0,
      raisedBnb: bestSignal.raisedBnb || 0,
      progressPercent: bestSignal.progressPercent || 0,
      whaleCount: bestSignal.whaleCount || 0,
      maxFunds: bestSignal.maxFunds || 100,
    });

    if (!analysisResult.pass) {
      log(`[TradingAgent] Skills BLOCKED $${bestSignal.symbol} for user ${user.chatId}: ${analysisResult.reason}`, "trading");
      notifyFn(user.chatId, `🛡️ Skills blocked $${bestSignal.symbol}: ${analysisResult.reason}`);
      return;
    }

    const execMods = getExecutionModifiers(userSkills);

    const position = await executeBuy(user.chatId, user.agentId, bestSignal, user.privateKey, user.walletAddress, "ai_scan", execMods);
    if (position) {
      let msg = `AI TRADE: $${bestSignal.symbol}\n`;
      msg += `Amount: ${position.entryPriceBnb} BNB | Confidence: ${bestSignal.score}%\n`;
      if (bestSignal.aiAnalysis) msg += `${bestSignal.aiAnalysis}\n`;
      bestSignal.reasons.forEach(r => { if (r) msg += `• ${r}\n`; });
      if (analysisResult.reason) msg += `📊 ${analysisResult.reason}\n`;
      msg += `TP: ${config.takeProfitMultiple}x | SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
      if (position.buyTxHash) msg += `TX: https://bscscan.com/tx/${position.buyTxHash}`;
      notifyFn(user.chatId, msg);
    }
  });

  await Promise.allSettled(buyPromises);
}

async function discoverSmartWallets(): Promise<void> {
  if (smartMoneyDiscoveryRunning) return;
  smartMoneyDiscoveryRunning = true;
  try {
    await _discoverSmartWalletsInner();
  } finally {
    smartMoneyDiscoveryRunning = false;
  }
}

const KNOWN_ROUTERS = new Set([
  "0x10ed43c718714eb63d5aa57b78b54704e256024e",
  "0x13f4ea83d0bd40e75c8222255bc855a974568dd4",
  "0x1b81d678ffb9c0263b24a97847620c99d213eb14",
  "0x3a0b5541e20cb8789307b8012b1e0e9e5bcd6072",
]);

let lastBscScanCall = 0;
async function rateLimitedBscScan(url: string): Promise<any> {
  const now = Date.now();
  const wait = Math.max(0, 220 - (now - lastBscScanCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastBscScanCall = Date.now();

  const res = await Promise.race([
    fetch(url),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("BSCScan timeout")), 12000)),
  ]);
  const data = await res.json();
  if (data.message === "NOTOK" && data.result?.includes("rate limit")) {
    log(`[SmartMoney] BSCScan rate limited, backing off`, "trading");
    await new Promise(r => setTimeout(r, 2000));
    return null;
  }
  return data;
}

const discoveryTokenCache = new Map<string, { transfers: any[]; ts: number }>();
const DISCOVERY_CACHE_TTL = 600_000;

async function _discoverSmartWalletsInner(): Promise<void> {
  const apiKey = process.env.BSCSCAN_API_KEY || "";
  if (!apiKey) return;

  try {
    const res = await Promise.race([
      fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/query?type=trade&pageIndex=1&pageSize=20`, {
        headers: { "Origin": "https://four.meme", "Referer": "https://four.meme/", "User-Agent": "Mozilla/5.0" },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
    ]);
    const body = await res.json();
    const graduated = (body?.data?.list || []).slice(0, 10);
    if (graduated.length === 0) {
      log(`[SmartMoney] No graduated tokens found`, "trading");
      return;
    }

    log(`[SmartMoney] Analyzing ${graduated.length} graduated tokens for smart wallets...`, "trading");

    const walletStats = new Map<string, { wins: number; losses: number; tokens: string[]; earlyBuys: number }>();

    for (const token of graduated.slice(0, 4)) {
      const tokenAddr = token.address?.toLowerCase();
      if (!tokenAddr) continue;

      try {
        let transfers: any[];
        const cached = discoveryTokenCache.get(tokenAddr);
        if (cached && Date.now() - cached.ts < DISCOVERY_CACHE_TTL) {
          transfers = cached.transfers;
        } else {
          const txUrl = `https://api.etherscan.io/v2/api?chainid=56&module=account&action=tokentx&contractaddress=${tokenAddr}&page=1&offset=100&sort=asc&apikey=${apiKey}`;
          const txData = await rateLimitedBscScan(txUrl);
          if (!txData || txData.status !== "1" || !Array.isArray(txData.result)) continue;
          transfers = txData.result;
          discoveryTokenCache.set(tokenAddr, { transfers, ts: Date.now() });
        }

        const mintAddr = "0x0000000000000000000000000000000000000000";
        const buyWallets = new Map<string, number>();
        const sellWallets = new Map<string, number>();

        for (const tx of transfers) {
          const to = tx.to?.toLowerCase();
          const from = tx.from?.toLowerCase();
          const ts = parseInt(tx.timeStamp || "0");
          const isMint = from === mintAddr;
          const isFromRouter = KNOWN_ROUTERS.has(from || "");
          const isToRouter = KNOWN_ROUTERS.has(to || "");

          if (to && !isMint && (isFromRouter || from !== to) && !KNOWN_ROUTERS.has(to)) {
            if (!buyWallets.has(to)) buyWallets.set(to, ts);
          }

          if (from && from !== mintAddr && !KNOWN_ROUTERS.has(from) && (isToRouter || to !== from)) {
            if (!sellWallets.has(from)) sellWallets.set(from, ts);
            else sellWallets.set(from, Math.max(sellWallets.get(from)!, ts));
          }
        }

        const firstTransferTime = transfers[0] ? parseInt(transfers[0].timeStamp || "0") : 0;
        if (firstTransferTime === 0) continue;
        const tokenPumped = parseFloat(token.priceChange24h || "0") > 0 || token.status === "TRADE";

        for (const [wallet, buyTime] of buyWallets) {
          if (wallet.startsWith("0x000000")) continue;
          const entryAge = buyTime - firstTransferTime;
          if (entryAge < 0 || entryAge > 600) continue;

          const sellTime = sellWallets.get(wallet);
          const didSell = sellTime !== undefined && sellTime > buyTime;

          const stats = walletStats.get(wallet) || { wins: 0, losses: 0, tokens: [], earlyBuys: 0 };
          if (stats.tokens.includes(tokenAddr)) continue;
          stats.tokens.push(tokenAddr);
          stats.earlyBuys++;

          if (tokenPumped && didSell) {
            stats.wins++;
          } else if (!tokenPumped && didSell) {
            stats.losses++;
          } else if (!tokenPumped && !didSell) {
            stats.losses++;
          }
          walletStats.set(wallet, stats);
        }
      } catch (e: any) {
        log(`[SmartMoney] Token analysis error: ${e.message?.substring(0, 60)}`, "trading");
      }
    }

    let newDiscovered = 0;
    for (const [wallet, stats] of walletStats) {
      const totalTrades = stats.wins + stats.losses;
      if (totalTrades < MIN_SMART_WALLET_TRADES) continue;
      const winRate = (stats.wins / totalTrades) * 100;
      if (winRate < MIN_SMART_WALLET_WIN_RATE) continue;

      const existing = discoveredSmartWallets.get(wallet);
      const score = Math.round(winRate * (1 + Math.log2(totalTrades)));

      if (existing) {
        existing.winCount = Math.max(existing.winCount, stats.wins);
        existing.totalTrades = Math.max(existing.totalTrades, totalTrades);
        existing.score = Math.max(existing.score, score);
        existing.lastSeen = Date.now();
      } else {
        discoveredSmartWallets.set(wallet, {
          address: wallet,
          label: `Smart${discoveredSmartWallets.size + 1} (${winRate.toFixed(0)}%W/${totalTrades}T)`,
          winCount: stats.wins,
          totalTrades,
          totalPnlBnb: 0,
          avgEntryAge: 0,
          discoveredAt: Date.now(),
          lastSeen: Date.now(),
          score,
        });
        newDiscovered++;
      }
    }

    if (discoveredSmartWallets.size > MAX_TRACKED_SMART_WALLETS) {
      const sorted = Array.from(discoveredSmartWallets.entries())
        .sort((a, b) => b[1].score - a[1].score);
      discoveredSmartWallets.clear();
      for (const [k, v] of sorted.slice(0, MAX_TRACKED_SMART_WALLETS)) {
        discoveredSmartWallets.set(k, v);
      }
    }

    if (discoveryTokenCache.size > 30) {
      const keys = Array.from(discoveryTokenCache.keys());
      for (let i = 0; i < keys.length - 20; i++) discoveryTokenCache.delete(keys[i]);
    }

    log(`[SmartMoney] Discovery: ${newDiscovered} new, ${discoveredSmartWallets.size} total tracked wallets`, "trading");

  } catch (e: any) {
    log(`[SmartMoney] Discovery error: ${e.message?.substring(0, 100)}`, "trading");
  }
}

function getSmartWalletList(): Array<{ address: string; label: string }> {
  const hardcoded = COPY_TRADE_WALLETS.map(w => ({ address: w.address.toLowerCase(), label: w.label }));
  const discovered = Array.from(discoveredSmartWallets.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(w => ({ address: w.address, label: w.label }));
  const all = [...hardcoded];
  for (const d of discovered) {
    if (!all.some(a => a.address === d.address)) {
      all.push(d);
    }
  }
  return all;
}

const smartMoneyTokenBuys = new Map<string, Set<string>>();

function trackSmartBuy(tokenAddress: string, walletLabel: string): void {
  const key = tokenAddress.toLowerCase();
  if (!smartMoneyTokenBuys.has(key)) smartMoneyTokenBuys.set(key, new Set());
  smartMoneyTokenBuys.get(key)!.add(walletLabel);
  if (smartMoneyTokenBuys.size > 500) {
    const keys = Array.from(smartMoneyTokenBuys.keys());
    for (let i = 0; i < keys.length - 300; i++) smartMoneyTokenBuys.delete(keys[i]);
  }
}

function getSmartBuyersForToken(tokenAddress: string): string[] {
  const buyers = smartMoneyTokenBuys.get(tokenAddress.toLowerCase());
  return buyers ? Array.from(buyers) : [];
}

export function getDiscoveredSmartWallets(): Array<{ address: string; label: string; winCount: number; totalTrades: number; score: number }> {
  return Array.from(discoveredSmartWallets.values())
    .sort((a, b) => b.score - a.score)
    .map(w => ({ address: w.address, label: w.label, winCount: w.winCount, totalTrades: w.totalTrades, score: w.score }));
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

  const allWallets = getSmartWalletList();

  const whaleChecks = allWallets.map(async whale => {
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
  const allNewBuys: Array<{ tokenAddress: string; tokenSymbol: string; tokenName: string; txHash: string; value: string; timeStamp: number; whale: { address: string; label: string } }> = [];
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
    trackSmartBuy(tokenAddr, buy.whale.label);
    const consensusCount = whaleConsensus.get(tokenAddr)!.size;
    const isConsensus = consensusCount >= 2;
    const tradeSource = isConsensus ? "consensus" as const : "whale_copy" as const;
    whaleTokensCopied.add(tokenAddr);

    const whaleAge = Math.floor(Date.now() / 1000) - (info.launchTime || Math.floor(Date.now() / 1000));
    const whaleAgeMin = Math.max(1, Math.floor(whaleAge / 60));
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
      progressPercent: info.progressPercent,
      ageMinutes: whaleAgeMin,
      velocity: whaleAgeMin > 0 ? info.progressPercent / whaleAgeMin : 0,
      holderCount: 0,
      raisedBnb: parseFloat(info.funds) || 0,
      rugRisk: 0,
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

const INSTANT_SNIPER_INTERVAL_MS = 1_500;
const INSTANT_SNIPER_MAX_AGE_SECONDS = 60;
const INSTANT_SNIPER_BUY_AMOUNT_BNB = "0.05";
const INSTANT_SNIPER_SLIPPAGE = 25;
const instantSniperSeen = new Set<string>();
let instantSniperRunning = false;
let instantSniperEnabled = true;

export function setInstantSniperEnabled(enabled: boolean): void {
  instantSniperEnabled = enabled;
  log(`[INSTANT-SNIPER] ${enabled ? "ENABLED" : "DISABLED"}`, "trading");
}

export function isInstantSniperEnabled(): boolean {
  return instantSniperEnabled;
}

async function instantSniperScan(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  if (instantSniperRunning || !instantSniperEnabled) return;
  instantSniperRunning = true;
  try {
    await instantSniperScanInner(notifyFn);
  } catch (e: any) {
    log(`[INSTANT-SNIPER] Error: ${e.message?.substring(0, 100)}`, "trading");
  } finally {
    instantSniperRunning = false;
  }
}

async function instantSniperScanInner(notifyFn: (chatId: number, message: string) => void): Promise<void> {
  const enabledUsers = await resolveEnabledUsers();
  if (enabledUsers.length === 0) return;

  const headers = {
    "Accept": "application/json",
    "Origin": "https://four.meme",
    "Referer": "https://four.meme/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  let rawTokens: any[] = [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(
      `${FOUR_MEME_API}/meme-api/v1/private/token/query?type=new&pageIndex=1&pageSize=50`,
      { headers, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!resp.ok) return;
    const text = await resp.text();
    try {
      const d = JSON.parse(text);
      if (d.code === 0 && Array.isArray(d.data)) rawTokens = d.data;
      else if (d.code === 0 && d.data?.list) rawTokens = d.data.list;
    } catch {
      return;
    }
  } catch {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const freshTokens: FourMemeListingToken[] = [];

  for (const t of rawTokens) {
    const parsed = parseListingToken(t);
    if (!parsed) continue;
    if (instantSniperSeen.has(parsed.address)) continue;
    if (sessionBlacklist.has(parsed.address.toLowerCase())) continue;
    if (parsed.status === "TRADE") continue;

    const age = now - parsed.launchTime;
    if (parsed.launchTime <= 0 || age > INSTANT_SNIPER_MAX_AGE_SECONDS || age < 0) continue;

    freshTokens.push(parsed);
  }

  if (freshTokens.length === 0) return;

  freshTokens.sort((a, b) => b.launchTime - a.launchTime);

  for (const token of freshTokens) {
    instantSniperSeen.add(token.address);
    sniperScannedTokens.add(token.address);

    const age = now - token.launchTime;

    log(`[INSTANT-SNIPER] 🎯 NEW LAUNCH DETECTED: $${token.symbol} (${token.name}) — ${age}s old, ${token.raisedAmount.toFixed(3)} BNB raised, ${token.progressPercent.toFixed(1)}% curve`, "trading");

    const signal: TokenSignal = {
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      score: 95,
      reasons: [`🎯 Instant snipe — ${age}s after launch`, `Raised: ${token.raisedAmount.toFixed(3)} BNB`, `Curve: ${token.progressPercent.toFixed(1)}%`],
      info: listingToTokenInfo(token),
      listing: token,
      aiAnalysis: `🎯 INSTANT SNIPE — token launched ${age}s ago`,
      progressPercent: token.progressPercent,
      holderCount: token.holderCount,
      raisedBnb: token.raisedAmount,
      maxFunds: token.maxFunds,
    };

    recentlyScannedTokens.add(signal.address);

    const buyPromises = enabledUsers.map(async (user) => {
      const openCount = Array.from(activePositions.values()).filter(
        (p) => p.chatId === user.chatId && p.status === "open"
      ).length;
      const config = getUserConfig(user.chatId);
      if (openCount >= config.maxPositions) return;

      const alreadyHolding = Array.from(activePositions.values()).some(
        (p) => p.chatId === user.chatId && p.tokenAddress === signal.address && p.status === "open"
      );
      if (alreadyHolding) return;

      const buyAmount = INSTANT_SNIPER_BUY_AMOUNT_BNB;

      const overrideSignal = { ...signal, score: 95 };

      log(`[INSTANT-SNIPER] ⚡ EXECUTING BUY: $${token.symbol} for ${buyAmount} BNB — user ${user.chatId}`, "trading");

      const position = await executeBuy(
        user.chatId, user.agentId, overrideSignal,
        user.privateKey, user.walletAddress, "sniper",
        { sizeMultiplier: parseFloat(buyAmount) / parseFloat(config.buyAmountBnb || DEFAULT_BUY_AMOUNT_BNB) },
        true
      );

      if (position) {
        let msg = `🎯 INSTANT SNIPE: $${token.symbol}\n`;
        msg += `⚡ Bought ${age}s after launch!\n`;
        msg += `💰 Amount: ${position.entryPriceBnb} BNB\n`;
        msg += `📊 Curve: ${token.progressPercent.toFixed(1)}% | Raised: ${token.raisedAmount.toFixed(3)} BNB\n`;
        msg += `🎯 TP: ${config.takeProfitMultiple}x | SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
        if (position.buyTxHash) msg += `🔗 TX: https://bscscan.com/tx/${position.buyTxHash}`;
        notifyFn(user.chatId, msg);
      }
    });

    await Promise.allSettled(buyPromises);
  }

  if (instantSniperSeen.size > 500) {
    const arr = Array.from(instantSniperSeen);
    for (let i = 0; i < arr.length - 250; i++) instantSniperSeen.delete(arr[i]);
  }
}

export function startTradingAgent(notifyFn: (chatId: number, message: string) => void): void {
  if (running) return;
  running = true;
  notifyCallback = notifyFn;

  log("[TradingAgent] 🚀 Starting ULTRA trading agent", "trading");

  scanAndTrade(notifyFn).catch(() => {});
  copyTradeFromWhales(notifyFn).catch(() => {});
  sniperScan(notifyFn).catch(() => {});
  discoverSmartWallets().catch(() => {});

  sniperTimer = setInterval(() => {
    sniperScan(notifyFn).catch(e => log(`[SNIPER] Scan error: ${e.message?.substring(0, 80)}`, "trading"));
  }, SNIPER_SCAN_INTERVAL_MS);

  instantSniperScan(notifyFn).catch(() => {});
  instantSniperTimer = setInterval(() => {
    instantSniperScan(notifyFn).catch(e => log(`[INSTANT-SNIPER] Error: ${e.message?.substring(0, 80)}`, "trading"));
  }, INSTANT_SNIPER_INTERVAL_MS);

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

  smartMoneyTimer = setInterval(() => {
    discoverSmartWallets().catch(e => log(`[SmartMoney] Error: ${e.message?.substring(0, 80)}`, "trading"));
  }, SMART_MONEY_SCAN_INTERVAL_MS);

  log(`[SNIPER] ⚡ Sniper mode active — scanning every ${SNIPER_SCAN_INTERVAL_MS / 1000}s, threshold ${SNIPER_SCORE_THRESHOLD}%`, "trading");
  log(`[INSTANT-SNIPER] 🎯 Instant launch sniper active — scanning every ${INSTANT_SNIPER_INTERVAL_MS / 1000}s, buying tokens < ${INSTANT_SNIPER_MAX_AGE_SECONDS}s old`, "trading");
  log(`[CopyTrade] Tracking ${COPY_TRADE_WALLETS.map(w => w.label).join(", ")} + auto-discovered wallets`, "trading");
  log(`[SmartMoney] Discovery active — scanning every ${SMART_MONEY_SCAN_INTERVAL_MS / 1000}s for top traders`, "trading");
  log(`[AsterAgent] Aster futures active`, "trading");
}

export function stopTradingAgent(): void {
  if (scanTimer) clearInterval(scanTimer);
  if (sniperTimer) clearInterval(sniperTimer);
  if (positionTimer) clearInterval(positionTimer);
  if (copyTradeTimer) clearInterval(copyTradeTimer);
  if (instantSniperTimer) clearInterval(instantSniperTimer);
  if (asterScanTimer) clearInterval(asterScanTimer);
  if (asterPositionTimer) clearInterval(asterPositionTimer);
  if (smartMoneyTimer) clearInterval(smartMoneyTimer);
  scanTimer = null; sniperTimer = null; positionTimer = null; copyTradeTimer = null;
  instantSniperTimer = null; asterScanTimer = null; asterPositionTimer = null; smartMoneyTimer = null;
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

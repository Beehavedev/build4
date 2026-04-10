import { parseKlinesToCandles, buildMarketSnapshot, type MarketSnapshot } from "./trading-strategy";
import {
  getClaudeTradeDecision, getClaudeExitDecision,
  recordTradeResult, getIntelStatus, loadLearningFromDb,
  getTradeMemory, getFundingRate,
  getSymbolConfidenceThreshold, isHourBlocked, isCorrelationBlocked,
  getLearningInsights,
  type ClaudeDecision, type TradeMemory,
} from "./market-intelligence";
import { storage } from "./storage";

const SCAN_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT",
  "SUIUSDT","ADAUSDT","AVAXUSDT","LINKUSDT",
];

export interface AgentConfig {
  name: string;
  maxLeverage: number;
  riskPercent: number;
  intervalMs: number;
  enabled: boolean;
  maxOpenPositions: number;
  dailyLossLimitPct: number;
  fundingRateFilter: boolean;
  maxFundingRateLong: number;
  minFundingRateShort: number;
  orderbookImbalanceThreshold: number;
  useConfidenceFilter: boolean;
  minConfidence: number;
  symbol?: string;
  klineInterval?: string;
  takeProfitPct?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
}

interface PositionInfo {
  side: "LONG" | "SHORT";
  entryPrice: number;
  peakPnlPct: number;
  openedAt: number;
  stopLossPct: number;
  takeProfitPct: number;
  leverage: number;
  reasoning: string;
  quantity: number;
}

interface AgentState {
  config: AgentConfig;
  running: boolean;
  lastCheck: number;
  tradeCount: number;
  scanCount: number;
  errors: number;
  timer: ReturnType<typeof setTimeout> | null;
  openPositions: Map<string, PositionInfo>;
  lastAction: string;
  lastReason: string;
  lastReasoning: string;
  reasoningLog: { ts: number; symbol: string; action: string; reasoning: string; confidence: number }[];
  dailyPnl: number;
  dailyPnlResetDate: string;
  consecutiveLosses: number;
  lastTradeCloseTime: number;
  circuitBreakerUntil: number;
  lastRegime: string;
}

const agentStates = new Map<string, AgentState>();

const DEFAULT_CONFIG: AgentConfig = {
  name: "My Agent",
  maxLeverage: 10,
  riskPercent: 1.0,
  intervalMs: 90_000,
  enabled: false,
  maxOpenPositions: 2,
  dailyLossLimitPct: 3.0,
  fundingRateFilter: true,
  maxFundingRateLong: 0.001,
  minFundingRateShort: -0.001,
  orderbookImbalanceThreshold: 0.5,
  useConfidenceFilter: true,
  minConfidence: 0.65,
};

const COOLDOWN_AFTER_CLOSE_MS = 120_000;
const CIRCUIT_BREAKER_PAUSE_MS = 900_000;
const MAX_CONSECUTIVE_LOSSES_BEFORE_PAUSE = 4;
const MAX_RISK_PERCENT = 1.0;

export function getAgentState(chatId: string): AgentState | undefined {
  return agentStates.get(chatId);
}

export function getAgentConfig(chatId: string): AgentConfig {
  const state = agentStates.get(chatId);
  return state?.config || { ...DEFAULT_CONFIG };
}

export async function loadAgentConfigFromDb(chatId: string): Promise<AgentConfig> {
  try {
    const limits = await storage.getAsterTradingLimits(chatId);
    if (limits) {
      let saved: Partial<AgentConfig> = {};
      try {
        const raw = limits.agentConfigJson;
        if (raw && raw !== '{}') saved = JSON.parse(raw);
      } catch {}
      const config: AgentConfig = {
        name: saved.name ?? DEFAULT_CONFIG.name,
        maxLeverage: limits.maxLeverage ?? saved.maxLeverage ?? DEFAULT_CONFIG.maxLeverage,
        riskPercent: Math.min(MAX_RISK_PERCENT, saved.riskPercent ?? DEFAULT_CONFIG.riskPercent),
        intervalMs: saved.intervalMs ?? DEFAULT_CONFIG.intervalMs,
        enabled: limits.autoTradeEnabled ?? saved.enabled ?? false,
        maxOpenPositions: Math.min(saved.maxOpenPositions ?? DEFAULT_CONFIG.maxOpenPositions, 3),
        dailyLossLimitPct: saved.dailyLossLimitPct ?? DEFAULT_CONFIG.dailyLossLimitPct,
        fundingRateFilter: saved.fundingRateFilter ?? DEFAULT_CONFIG.fundingRateFilter,
        maxFundingRateLong: saved.maxFundingRateLong ?? DEFAULT_CONFIG.maxFundingRateLong,
        minFundingRateShort: saved.minFundingRateShort ?? DEFAULT_CONFIG.minFundingRateShort,
        orderbookImbalanceThreshold: saved.orderbookImbalanceThreshold ?? DEFAULT_CONFIG.orderbookImbalanceThreshold,
        useConfidenceFilter: saved.useConfidenceFilter ?? DEFAULT_CONFIG.useConfidenceFilter,
        minConfidence: saved.minConfidence ?? DEFAULT_CONFIG.minConfidence,
      };
      let state = agentStates.get(chatId);
      if (!state) {
        state = createDefaultState();
        agentStates.set(chatId, state);
      }
      state.config = config;
      console.log(`[Agent:${chatId}] Config loaded: name="${config.name}", maxLev=${config.maxLeverage}, risk=${config.riskPercent}%, maxPos=${config.maxOpenPositions}`);
      return config;
    }
  } catch (e: any) {
    console.warn(`[Agent:${chatId}] Config load failed: ${e.message?.substring(0, 100)}`);
  }
  return { ...DEFAULT_CONFIG };
}

async function saveAgentConfigToDb(chatId: string, config: AgentConfig): Promise<void> {
  try {
    const configJson = JSON.stringify({
      name: config.name,
      riskPercent: config.riskPercent,
      intervalMs: config.intervalMs,
      maxLeverage: config.maxLeverage,
      maxOpenPositions: config.maxOpenPositions,
      dailyLossLimitPct: config.dailyLossLimitPct,
      enabled: config.enabled,
      fundingRateFilter: config.fundingRateFilter,
      maxFundingRateLong: config.maxFundingRateLong,
      minFundingRateShort: config.minFundingRateShort,
      orderbookImbalanceThreshold: config.orderbookImbalanceThreshold,
      useConfidenceFilter: config.useConfidenceFilter,
      minConfidence: config.minConfidence,
    });
    const { db } = await import("./db");
    const { asterTradingLimits } = await import("../shared/schema");
    await db.insert(asterTradingLimits).values({
      chatId,
      maxLeverage: config.maxLeverage,
      maxOpenPositions: config.maxOpenPositions,
      autoTradeEnabled: config.enabled,
      agentConfigJson: configJson,
    }).onConflictDoUpdate({
      target: asterTradingLimits.chatId,
      set: {
        maxLeverage: config.maxLeverage,
        maxOpenPositions: config.maxOpenPositions,
        autoTradeEnabled: config.enabled,
        agentConfigJson: configJson,
        updatedAt: new Date(),
      },
    });
  } catch (e: any) {
    console.warn(`[Agent:${chatId}] Config save failed: ${e.message?.substring(0, 100)}`);
  }
}

export function setAgentConfig(chatId: string, partial: Partial<AgentConfig>): AgentConfig {
  let state = agentStates.get(chatId);
  if (!state) {
    state = createDefaultState();
    agentStates.set(chatId, state);
  }
  if (partial.riskPercent !== undefined) {
    partial.riskPercent = Math.min(MAX_RISK_PERCENT, Math.max(0.1, partial.riskPercent));
  }
  if (partial.maxOpenPositions !== undefined) {
    partial.maxOpenPositions = Math.min(3, Math.max(1, partial.maxOpenPositions));
  }
  Object.assign(state.config, partial);
  saveAgentConfigToDb(chatId, state.config);
  return state.config;
}

function createDefaultState(): AgentState {
  return {
    config: { ...DEFAULT_CONFIG },
    running: false,
    lastCheck: 0,
    tradeCount: 0,
    scanCount: 0,
    errors: 0,
    timer: null,
    openPositions: new Map(),
    lastAction: "",
    lastReason: "",
    lastReasoning: "",
    reasoningLog: [],
    dailyPnl: 0,
    dailyPnlResetDate: new Date().toISOString().split("T")[0],
    consecutiveLosses: 0,
    lastTradeCloseTime: 0,
    circuitBreakerUntil: 0,
    lastRegime: "UNKNOWN",
  };
}

function addReasoningLog(state: AgentState, symbol: string, action: string, reasoning: string, confidence: number) {
  state.reasoningLog.push({ ts: Date.now(), symbol, action, reasoning, confidence });
  if (state.reasoningLog.length > 30) state.reasoningLog.splice(0, state.reasoningLog.length - 30);
  state.lastReasoning = reasoning;
}

function checkDailyReset(state: AgentState) {
  const today = new Date().toISOString().split("T")[0];
  if (state.dailyPnlResetDate !== today) {
    console.log(`[Agent] Daily reset: PnL was ${state.dailyPnl.toFixed(2)}, resetting`);
    state.dailyPnl = 0;
    state.dailyPnlResetDate = today;
    state.consecutiveLosses = 0;
  }
}

export async function startAgent(
  chatId: string,
  getClient: () => any,
  sendMessage: (msg: string) => Promise<void>,
): Promise<boolean> {
  let state = agentStates.get(chatId);
  if (!state) {
    state = createDefaultState();
    agentStates.set(chatId, state);
  }

  if (!state.config.name || state.config.name === DEFAULT_CONFIG.name) {
    await loadAgentConfigFromDb(chatId);
  }

  if (state.running) return false;
  state.running = true;
  state.config.enabled = true;
  saveAgentConfigToDb(chatId, state.config);
  state.errors = 0;

  await loadLearningFromDb(chatId);

  state.openPositions.clear();
  const localPositions = await storage.getAsterLocalPositions(chatId);
  for (const p of localPositions) {
    if (p.quantity > 0) {
      state.openPositions.set(p.symbol, {
        side: p.side === "LONG" ? "LONG" : "SHORT",
        entryPrice: p.entryPrice || 0,
        peakPnlPct: 0,
        openedAt: Date.now(),
        stopLossPct: 3,
        takeProfitPct: 5,
        leverage: p.leverage || 5,
        reasoning: "Resumed from previous session",
        quantity: p.quantity,
      });
    }
  }

  try {
    const posCount = state.openPositions.size;
    const posList = posCount > 0
      ? Array.from(state.openPositions.entries()).map(([s, info]) => `${info.side} ${s}`).join(", ")
      : "None";
    await sendMessage(
      `🤖 *${state.config.name} Activated*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🧠 AI-Powered Analysis\n` +
      `📊 Scanning: *${SCAN_PAIRS.length} pairs* (multi-timeframe)\n` +
      `🛡 Risk: *${state.config.riskPercent}%* per trade (max 1%)\n` +
      `⚡ Max Leverage: *${state.config.maxLeverage}x*\n` +
      `📍 Max Positions: *${state.config.maxOpenPositions}*\n` +
      `🚫 Daily Loss Limit: *${state.config.dailyLossLimitPct}%*\n` +
      `🔒 Circuit Breaker: ${MAX_CONSECUTIVE_LOSSES_BEFORE_PAUSE} losses → 15min pause\n\n` +
      `Open: ${posList}\n` +
      `Scanning every ${Math.round(state.config.intervalMs / 1000)}s`
    );
  } catch {}

  runAgentLoop(chatId, getClient, sendMessage);
  return true;
}

export function stopAgent(chatId: string): boolean {
  const state = agentStates.get(chatId);
  if (!state || !state.running) return false;
  state.running = false;
  state.config.enabled = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  return true;
}

async function fetchMultiTFCandles(futuresClient: any, symbol: string): Promise<{ candles5m: any[]; candles15m: any[]; candles1h: any[] }> {
  const [klines5m, klines15m, klines1h] = await Promise.all([
    futuresClient.klines(symbol, "5m", 100).catch(() => []),
    futuresClient.klines(symbol, "15m", 100).catch(() => []),
    futuresClient.klines(symbol, "1h", 60).catch(() => []),
  ]);
  return {
    candles5m: parseKlinesToCandles(klines5m),
    candles15m: parseKlinesToCandles(klines15m),
    candles1h: parseKlinesToCandles(klines1h),
  };
}

async function runAgentLoop(
  chatId: string,
  getClient: () => any,
  sendMessage: (msg: string) => Promise<void>,
) {
  const state = agentStates.get(chatId);
  if (!state || !state.running) return;

  try {
    const client = getClient();
    const futuresClient = client.futures || client;

    checkDailyReset(state);
    state.lastCheck = Date.now();
    state.scanCount++;

    const now = Date.now();
    if (now < state.circuitBreakerUntil) {
      const remainMin = ((state.circuitBreakerUntil - now) / 60000).toFixed(0);
      state.lastAction = "⏸ Circuit breaker active";
      state.lastReason = `Paused for ${remainMin}min after ${state.consecutiveLosses} consecutive losses`;
      addReasoningLog(state, "ALL", "CIRCUIT_BREAKER", `Paused ${remainMin}min remaining`, 0);
      scheduleNext(chatId, getClient, sendMessage);
      return;
    }

    const balance = await getAvailableBalance(chatId, futuresClient);
    const dailyLossLimit = balance * (state.config.dailyLossLimitPct / 100);
    if (state.dailyPnl <= -dailyLossLimit) {
      state.lastAction = "🛑 Daily loss limit reached";
      state.lastReason = `Lost $${Math.abs(state.dailyPnl).toFixed(2)} today (limit: $${dailyLossLimit.toFixed(2)})`;
      addReasoningLog(state, "ALL", "DAILY_LIMIT", state.lastReason, 0);
      if (state.scanCount % 10 === 1) {
        try { await sendMessage(`🛑 Daily loss limit reached. PnL today: -$${Math.abs(state.dailyPnl).toFixed(2)} (limit: $${dailyLossLimit.toFixed(2)}). Agent paused until tomorrow.`); } catch {}
      }
      scheduleNext(chatId, getClient, sendMessage);
      return;
    }

    const localPositions = await storage.getAsterLocalPositions(chatId);
    const activeSymbols = new Set(localPositions.filter(p => p.quantity > 0).map(p => p.symbol));
    for (const [symbol] of state.openPositions.entries()) {
      if (!activeSymbols.has(symbol)) {
        state.openPositions.delete(symbol);
      }
    }
    for (const p of localPositions) {
      if (p.quantity > 0 && !state.openPositions.has(p.symbol)) {
        state.openPositions.set(p.symbol, {
          side: p.side === "LONG" ? "LONG" : "SHORT",
          entryPrice: p.entryPrice || 0,
          peakPnlPct: 0,
          openedAt: Date.now(),
          stopLossPct: 3,
          takeProfitPct: 5,
          leverage: p.leverage || 5,
          reasoning: "Detected existing position",
          quantity: p.quantity,
        });
      }
    }

    for (const [symbol, info] of Array.from(state.openPositions.entries())) {
      try {
        const { candles5m, candles15m, candles1h } = await fetchMultiTFCandles(futuresClient, symbol);
        if (candles5m.length < 26) continue;
        const snapshot = buildMarketSnapshot(symbol, candles5m, candles15m, candles1h);
        const markPrice = snapshot.price;
        if (markPrice <= 0 || info.entryPrice <= 0) continue;

        const pnlPct = info.side === "LONG"
          ? ((markPrice - info.entryPrice) / info.entryPrice) * 100
          : ((info.entryPrice - markPrice) / info.entryPrice) * 100;

        if (pnlPct > info.peakPnlPct) info.peakPnlPct = pnlPct;

        let closeReason = "";

        if (pnlPct <= -info.stopLossPct) {
          closeReason = `🛑 HARD STOP-LOSS: ${pnlPct.toFixed(2)}% (limit: -${info.stopLossPct.toFixed(1)}%)`;
        } else if (pnlPct >= info.takeProfitPct) {
          closeReason = `🎯 Take Profit: +${pnlPct.toFixed(2)}% (target: +${info.takeProfitPct.toFixed(1)}%)`;
        } else if (info.peakPnlPct > 1.5 && pnlPct < info.peakPnlPct * 0.5) {
          closeReason = `📉 Trailing: peak +${info.peakPnlPct.toFixed(2)}% → +${pnlPct.toFixed(2)}% (gave back >50%)`;
        }

        if (!closeReason) {
          const holdMin = (Date.now() - info.openedAt) / 60_000;
          if (holdMin > 10 && state.scanCount % 3 === 0) {
            try {
              const exitDecision = await getClaudeExitDecision(
                symbol, info.side, info.entryPrice, markPrice, pnlPct, holdMin,
                snapshot, futuresClient, info.stopLossPct, info.takeProfitPct,
              );
              if (exitDecision.action === "CLOSE") {
                closeReason = `🧠 Smart exit: ${exitDecision.reasoning}`;
              }
              addReasoningLog(state, symbol, `EXIT_CHECK_${exitDecision.action}`, exitDecision.reasoning, 0);
            } catch (e: any) {
              console.log(`[Agent:${chatId}] Exit analysis error for ${symbol}: ${e.message?.substring(0, 80)}`);
            }
          }
        }

        if (closeReason) {
          console.log(`[Agent:${chatId}] Closing ${info.side} ${symbol}: ${closeReason}`);
          await closePosition(chatId, futuresClient, state, symbol, sendMessage, closeReason);
        }
      } catch (e: any) {
        console.log(`[Agent:${chatId}] Position check failed for ${symbol}: ${e.message?.substring(0, 80)}`);
      }
    }

    const openCount = state.openPositions.size;
    if (openCount >= state.config.maxOpenPositions) {
      state.lastAction = `Managing ${openCount} positions`;
      scheduleNext(chatId, getClient, sendMessage);
      return;
    }

    if (now - state.lastTradeCloseTime < COOLDOWN_AFTER_CLOSE_MS) {
      const cooldownRemain = ((COOLDOWN_AFTER_CLOSE_MS - (now - state.lastTradeCloseTime)) / 1000).toFixed(0);
      state.lastAction = "⏳ Cooldown active";
      state.lastReason = `Waiting ${cooldownRemain}s after last close (no revenge trading)`;
      addReasoningLog(state, "ALL", "COOLDOWN", state.lastReason, 0);
      scheduleNext(chatId, getClient, sendMessage);
      return;
    }

    const currentPositionsList = Array.from(state.openPositions.entries()).map(([s, i]) => `${i.side} ${s}`);

    const currentHour = new Date().getUTCHours();
    if (isHourBlocked(currentHour)) {
      state.lastAction = `Scan #${state.scanCount} — Hour ${currentHour} UTC blocked`;
      state.lastReason = "Historically poor performance this hour — sitting out";
      addReasoningLog(state, "ALL", "HOUR_BLOCKED", `Hour ${currentHour} UTC has <30% win rate — skipping scan`, 0);
      scheduleNext(chatId, getClient, sendMessage);
      return;
    }

    let bestDecision: { decision: ClaudeDecision; snapshot: MarketSnapshot } | null = null;

    for (const symbol of SCAN_PAIRS) {
      if (state.openPositions.has(symbol)) continue;
      try {
        const { candles5m, candles15m, candles1h } = await fetchMultiTFCandles(futuresClient, symbol);
        if (candles5m.length < 26 || candles15m.length < 26) continue;

        const snapshot = buildMarketSnapshot(symbol, candles5m, candles15m, candles1h);

        if (snapshot.overallRegime === "RANGING") {
          continue;
        }

        const decision = await getClaudeTradeDecision(
          snapshot, futuresClient, balance,
          state.config.riskPercent, state.config.maxLeverage,
          currentPositionsList, state.dailyPnl,
          state.config.dailyLossLimitPct, state.consecutiveLosses,
        );

        addReasoningLog(state, symbol, decision.action, decision.reasoning, decision.confidence);

        if (decision.action === "HOLD") continue;

        const dynThreshold = getSymbolConfidenceThreshold(symbol);
        if (decision.confidence < dynThreshold) {
          addReasoningLog(state, symbol, "THRESHOLD_BLOCKED", `Confidence ${decision.confidence}% < dynamic threshold ${dynThreshold}% for ${symbol}`, decision.confidence);
          continue;
        }

        const tradeSide: "LONG" | "SHORT" = decision.action === "OPEN_LONG" ? "LONG" : "SHORT";
        if (isCorrelationBlocked(symbol, tradeSide, state.openPositions)) {
          addReasoningLog(state, symbol, "CORR_BLOCKED", `${tradeSide} ${symbol} blocked — correlated pair already open same direction`, decision.confidence);
          continue;
        }

        if (!bestDecision || decision.confidence > bestDecision.decision.confidence) {
          bestDecision = { decision, snapshot };
        }
      } catch (e: any) {
        console.log(`[Agent:${chatId}] Scan ${symbol} failed: ${e.message?.substring(0, 80)}`);
      }
    }

    if (bestDecision) {
      const { decision, snapshot } = bestDecision;
      const side: "BUY" | "SELL" = decision.action === "OPEN_LONG" ? "BUY" : "SELL";
      state.lastRegime = snapshot.overallRegime || "UNKNOWN";
      await openPosition(chatId, futuresClient, state, snapshot.symbol, side, decision, snapshot.price, balance, sendMessage);
    } else {
      state.lastAction = `Scan #${state.scanCount} — No setup found`;
      state.lastReason = "Waiting for high-probability opportunity";
    }

    if (state.scanCount % 10 === 1) {
      try {
        const openList = state.openPositions.size > 0
          ? Array.from(state.openPositions.entries()).map(([s, info]) => {
              const ticker = info.entryPrice; 
              return `${info.side === "LONG" ? "🟢" : "🔴"} ${info.side} ${s} @ $${info.entryPrice.toFixed(2)}`;
            }).join("\n")
          : "None";
        await sendMessage(
          `📡 *${state.config.name} — Scan #${state.scanCount}*\n` +
          `Balance: $${balance.toFixed(2)}\n` +
          `Daily PnL: ${state.dailyPnl >= 0 ? "+" : ""}$${state.dailyPnl.toFixed(2)}\n` +
          `Streak: ${state.consecutiveLosses > 0 ? `${state.consecutiveLosses} losses` : "Clean"}\n\n` +
          `*Open Positions:*\n${openList}\n\n` +
          `_${state.lastReason || "Scanning..."}_`
        );
      } catch {}
    }

    state.errors = 0;
  } catch (e: any) {
    state.errors++;
    console.error(`[Agent:${chatId}] Error #${state.errors}:`, e.message?.substring(0, 300));
    if (state.errors <= 3) {
      try { await sendMessage(`⚠️ Agent error (${state.errors}/3): ${e.message?.substring(0, 150)}`); } catch {}
    }
    if (state.errors >= 30) {
      state.running = false;
      state.config.enabled = false;
      saveAgentConfigToDb(chatId, state.config);
      try { await sendMessage(`🛑 Agent stopped after ${state.errors} consecutive errors.`); } catch {}
      return;
    }
  }

  scheduleNext(chatId, getClient, sendMessage);
}

function scheduleNext(
  chatId: string,
  getClient: () => any,
  sendMessage: (msg: string) => Promise<void>,
) {
  const state = agentStates.get(chatId);
  if (!state || !state.running) return;
  state.timer = setTimeout(() => {
    runAgentLoop(chatId, getClient, sendMessage);
  }, state.config.intervalMs);
}

let _exchangeInfoCache: Record<string, { quantityPrecision: number; stepSize: number; pricePrecision: number }> = {};
let _exchangeInfoLastFetch = 0;

async function loadExchangeInfo(futuresClient?: any): Promise<void> {
  const now = Date.now();
  if (now - _exchangeInfoLastFetch < 300_000 && Object.keys(_exchangeInfoCache).length > 0) return;
  try {
    const client = futuresClient || _agentFuturesClient;
    if (!client?.exchangeInfo) return;
    const info = await client.exchangeInfo();
    const symbols = info?.symbols || [];
    for (const s of symbols) {
      const sym = s.symbol || s.pair;
      if (!sym) continue;
      const qp = s.quantityPrecision ?? 3;
      const pp = s.pricePrecision ?? 2;
      const lotFilter = (s.filters || []).find((f: any) => f.filterType === "LOT_SIZE");
      const stepSize = lotFilter?.stepSize ? parseFloat(lotFilter.stepSize) : Math.pow(10, -qp);
      _exchangeInfoCache[sym] = { quantityPrecision: qp, stepSize, pricePrecision: pp };
    }
    _exchangeInfoLastFetch = now;
    console.log(`[ExchangeInfo] Cached ${Object.keys(_exchangeInfoCache).length} symbols`);
  } catch (e: any) {
    console.log(`[ExchangeInfo] Failed to fetch: ${e.message}`);
  }
}

function computeQuantity(symbol: string, balance: number, riskPct: number, leverage: number, lastPrice: number, stopLossPct: number): number {
  if (lastPrice <= 0 || balance <= 0) return 0;

  const riskAmount = balance * (riskPct / 100);
  const positionSize = (riskAmount / (stopLossPct / 100)) * Math.min(leverage, 10);
  const maxPositionSize = balance * leverage * 0.3;
  const effectiveSize = Math.min(positionSize, maxPositionSize);

  const MIN_NOTIONAL = 6.0;
  let notional = Math.max(effectiveSize, MIN_NOTIONAL);
  if (notional > balance * leverage) notional = balance * leverage * 0.25;

  let qty = notional / lastPrice;
  const info = _exchangeInfoCache[symbol];
  let step: number;
  let precision: number;
  if (info) {
    step = info.stepSize;
    precision = info.quantityPrecision;
  } else {
    step = lastPrice > 1000 ? 0.001 : lastPrice > 100 ? 0.01 : lastPrice > 1 ? 0.1 : 1;
    precision = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  }
  qty = Math.floor(qty / step) * step;
  return parseFloat(qty.toFixed(precision));
}

let _agentFuturesClient: any = null;
export function setAgentFuturesClient(client: any) { _agentFuturesClient = client; }

async function getAvailableBalance(chatId: string, futuresClient?: any): Promise<number> {
  const client = futuresClient || _agentFuturesClient;
  if (client) {
    try {
      const balances = await client.balance();
      const usdtEntry = Array.isArray(balances)
        ? balances.find((b: any) => b.asset === "USDT" || b.asset === "usdt")
        : null;
      if (usdtEntry) {
        const apiBal = parseFloat(usdtEntry.availableBalance || usdtEntry.crossWalletBalance || usdtEntry.balance || "0");
        if (apiBal > 0) return apiBal;
      }
    } catch (e: any) {
      console.log(`[Agent:${chatId}] Balance check failed: ${e.message?.substring(0, 100)}`);
    }
  }

  const allTrades = await storage.getAsterLocalTrades(chatId);
  const deposits = allTrades.filter((t: any) => t.type === "DEPOSIT");
  const totalDeposited = deposits.reduce((sum: number, t: any) => sum + (t.price || 0), 0);

  const localPositions = await storage.getAsterLocalPositions(chatId);
  let marginUsed = 0;
  for (const p of localPositions) {
    marginUsed += (p.quantity * p.entryPrice) / p.leverage;
  }

  return Math.max(totalDeposited - marginUsed, 0);
}

async function openPosition(
  chatId: string,
  futuresClient: any,
  state: AgentState,
  symbol: string,
  side: "BUY" | "SELL",
  decision: ClaudeDecision,
  price: number,
  balance: number,
  sendMessage: (msg: string) => Promise<void>,
) {
  const leverage = Math.min(decision.suggestedLeverage, state.config.maxLeverage);

  try {
    await futuresClient.setLeverage(symbol, leverage);
  } catch (e: any) {
    if (!e.message?.includes("No need to change")) {
      console.warn(`[Agent:${chatId}] Leverage warning: ${e.message?.substring(0, 100)}`);
    }
  }

  await loadExchangeInfo(futuresClient);

  const ticker = await futuresClient.tickerPrice(symbol);
  const lastPrice = parseFloat(ticker?.price || String(price));
  if (lastPrice === 0) throw new Error(`Could not get price for ${symbol}`);

  const availableBalance = await getAvailableBalance(chatId, futuresClient);
  if (availableBalance < 10) {
    state.lastAction = `Skipped ${symbol} — low balance`;
    state.lastReason = `$${availableBalance.toFixed(2)} < $10 minimum`;
    return;
  }

  const effectiveRisk = Math.min(state.config.riskPercent, MAX_RISK_PERCENT);
  const perPositionRisk = effectiveRisk / state.config.maxOpenPositions;
  const stopLossPct = Math.max(decision.suggestedStopLoss, 0.5);

  if (stopLossPct > 10) {
    console.log(`[Agent:${chatId}] ${symbol} stop-loss ${stopLossPct}% too wide, capping at 5%`);
  }
  const clampedSL = Math.min(stopLossPct, 5);

  const qty = computeQuantity(symbol, availableBalance, perPositionRisk, leverage, lastPrice, clampedSL);
  if (qty <= 0) {
    console.log(`[Agent:${chatId}] ${symbol} qty too small after sizing`);
    return;
  }

  const notional = qty * lastPrice;
  if (notional < 5.5) {
    console.log(`[Agent:${chatId}] ${symbol} notional $${notional.toFixed(2)} below minimum`);
    return;
  }

  const orderResult = await futuresClient.createOrder({
    symbol,
    side,
    type: "MARKET",
    quantity: String(qty),
  });

  const filledQty = parseFloat(orderResult.executedQty || "0");
  const avgPrice = parseFloat(orderResult.avgPrice || orderResult.price || "0");

  await storage.saveAsterLocalTrade({
    chatId,
    orderId: String(orderResult.orderId),
    symbol: orderResult.symbol,
    side: orderResult.side,
    type: orderResult.type,
    quantity: parseFloat(orderResult.origQty || String(qty)),
    executedQty: filledQty,
    price: parseFloat(orderResult.price || "0"),
    avgPrice,
    status: orderResult.status,
    reduceOnly: false,
    leverage,
  });

  const positionSide = side === "BUY" ? "LONG" : "SHORT";
  const entryP = avgPrice || lastPrice;
  const effectiveQty = filledQty || qty;

  try {
    const slSide = side === "BUY" ? "SELL" : "BUY";
    const slPrice = side === "BUY"
      ? entryP * (1 - clampedSL / 100)
      : entryP * (1 + clampedSL / 100);
    const info = _exchangeInfoCache[symbol];
    const pricePrecision = info?.pricePrecision ?? (entryP > 1000 ? 2 : entryP > 1 ? 4 : 6);
    await futuresClient.createOrder({
      symbol,
      side: slSide,
      type: "STOP_MARKET",
      stopPrice: slPrice.toFixed(pricePrecision),
      quantity: String(effectiveQty),
      reduceOnly: true,
    });
    console.log(`[Agent:${chatId}] On-exchange SL placed for ${symbol} at $${slPrice.toFixed(pricePrecision)}`);
  } catch (slErr: any) {
    console.warn(`[Agent:${chatId}] Failed to place on-exchange SL for ${symbol}: ${slErr.message?.substring(0, 150)}`);
  }

  state.openPositions.set(symbol, {
    side: positionSide,
    entryPrice: entryP,
    peakPnlPct: 0,
    openedAt: Date.now(),
    stopLossPct: clampedSL,
    takeProfitPct: decision.suggestedTakeProfit,
    leverage,
    reasoning: decision.reasoning,
    quantity: effectiveQty,
  });
  state.tradeCount++;
  state.lastAction = `${positionSide} ${symbol}`;
  state.lastReason = decision.reasoning;
  addReasoningLog(state, symbol, `OPENED_${positionSide}`, decision.reasoning, decision.confidence);

  const icon = side === "BUY" ? "🟢" : "🔴";
  const riskUsd = (availableBalance * perPositionRisk / 100).toFixed(2);
  await sendMessage(
    `🚀 *${state.config.name} — New Trade*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${icon} ${positionSide} *${symbol}*\n` +
    `💲 Entry: \`$${entryP.toFixed(entryP < 1 ? 6 : 2)}\`\n` +
    `📦 Size: \`${(filledQty || qty).toFixed(4)}\` ($${notional.toFixed(2)})\n` +
    `⚡ Leverage: *${leverage}x*\n` +
    `🛡 SL: *-${stopLossPct.toFixed(1)}%* | TP: *+${decision.suggestedTakeProfit.toFixed(1)}%*\n` +
    `💰 Risk: $${riskUsd} (${perPositionRisk.toFixed(2)}%)\n` +
    `📊 Confidence: *${decision.confidence}%*\n\n` +
    `🧠 *Reasoning:*\n_${decision.reasoning}_\n\n` +
    `⚠️ _${decision.riskAssessment}_\n\n` +
    `🔑 ${decision.keyFactors.slice(0, 3).join(" | ")}\n` +
    `📍 Open: ${state.openPositions.size}/${state.config.maxOpenPositions}`
  );
}

async function closePosition(
  chatId: string,
  futuresClient: any,
  state: AgentState,
  symbol: string,
  sendMessage: (msg: string) => Promise<void>,
  reason?: string,
) {
  const localPositions = await storage.getAsterLocalPositions(chatId);
  const pos = localPositions.find(p => p.symbol === symbol);
  if (!pos || pos.quantity <= 0) {
    state.openPositions.delete(symbol);
    return;
  }

  try {
    const openOrders = await futuresClient.openOrders(symbol);
    for (const order of openOrders) {
      if (order.type === "STOP_MARKET" || order.type === "TAKE_PROFIT_MARKET") {
        await futuresClient.cancelOrder(symbol, order.orderId).catch(() => {});
      }
    }
  } catch (cancelErr: any) {
    console.warn(`[Agent:${chatId}] Failed to cancel open orders for ${symbol}: ${cancelErr.message?.substring(0, 80)}`);
  }

  const closeSide = pos.side === "LONG" ? "SELL" : "BUY";
  const closeResult = await futuresClient.createOrder({
    symbol,
    side: closeSide as "BUY" | "SELL",
    type: "MARKET",
    quantity: String(pos.quantity),
    reduceOnly: true,
  });

  const filledQty = parseFloat(closeResult.executedQty || String(pos.quantity));
  const closePrice = parseFloat(closeResult.avgPrice || closeResult.price || "0");

  await storage.saveAsterLocalTrade({
    chatId,
    orderId: String(closeResult.orderId),
    symbol,
    side: closeSide,
    type: "MARKET",
    quantity: pos.quantity,
    executedQty: filledQty,
    price: parseFloat(closeResult.price || "0"),
    avgPrice: closePrice,
    status: closeResult.status || "FILLED",
    reduceOnly: true,
    leverage: pos.leverage || state.config.maxLeverage,
  });

  const posInfo = state.openPositions.get(symbol);
  state.openPositions.delete(symbol);

  let pnl = 0;
  let pnlPct = 0;
  if (closePrice > 0 && pos.entryPrice > 0) {
    pnl = pos.side === "LONG"
      ? (closePrice - pos.entryPrice) * filledQty
      : (pos.entryPrice - closePrice) * filledQty;
    pnlPct = pos.side === "LONG"
      ? ((closePrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - closePrice) / pos.entryPrice) * 100;
  }

  state.dailyPnl += pnl;
  state.lastTradeCloseTime = Date.now();

  if (pnl < 0) {
    state.consecutiveLosses++;
    if (state.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES_BEFORE_PAUSE) {
      state.circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
      try {
        await sendMessage(`🔒 *Circuit Breaker Activated*\n${state.consecutiveLosses} consecutive losses. Pausing for 30 minutes to prevent further losses.`);
      } catch {}
    }
  } else {
    state.consecutiveLosses = 0;
  }

  const openedAt = posInfo?.openedAt || Date.now();
  const durationMin = (Date.now() - openedAt) / 60_000;
  recordTradeResult({
    symbol,
    side: pos.side === "LONG" ? "LONG" : "SHORT",
    entryPrice: pos.entryPrice,
    exitPrice: closePrice,
    pnl,
    pnlPct,
    reason: reason || "",
    reasoning: posInfo?.reasoning || "",
    closedAt: Date.now(),
    regime: state.lastRegime || "UNKNOWN",
    hour: new Date(openedAt).getUTCHours(),
    durationMin: Math.round(durationMin),
    leverage: pos.leverage || state.config.maxLeverage,
  });

  try {
    const { db: dbConn } = await import("./db");
    const { sql: sqlTag } = await import("drizzle-orm");
    await dbConn.execute(sqlTag`
      INSERT INTO aster_agent_trades (chat_id, symbol, side, entry_price, exit_price, quantity, leverage, pnl, pnl_pct, status, order_id, close_order_id, reason, opened_at, closed_at)
      VALUES (${chatId}, ${symbol}, ${pos.side}, ${pos.entryPrice}, ${closePrice}, ${filledQty}, ${pos.leverage || state.config.maxLeverage}, ${pnl},
        ${pnlPct}, 'CLOSED', ${String(pos.orderId || '')}, ${String(closeResult.orderId || '')}, ${reason || ''}, ${new Date(posInfo?.openedAt || Date.now())}, now())
    `);
  } catch (e: any) { console.log(`[Agent] trade persist error: ${e.message?.substring(0, 80)}`); }

  state.lastAction = `Closed ${pos.side} ${symbol}`;
  state.lastReason = reason || `PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`;
  addReasoningLog(state, symbol, "CLOSED", `${reason} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`, 0);

  const pnlIcon = pnl >= 0 ? "✅" : "❌";
  let closeMsg =
    `📤 *Position Closed — ${symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${pos.side === "LONG" ? "🟢" : "🔴"} ${pos.side} *${symbol}*\n` +
    `📦 Qty: \`${filledQty}\`\n` +
    `💲 Entry: \`$${pos.entryPrice.toFixed(pos.entryPrice < 1 ? 6 : 2)}\` → Exit: \`$${closePrice.toFixed(closePrice < 1 ? 6 : 2)}\`\n` +
    `${pnlIcon} PnL: \`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT\` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n`;
  if (reason) closeMsg += `\n📋 *Reason:* _${reason}_\n`;
  closeMsg += `\n📊 Daily PnL: ${state.dailyPnl >= 0 ? "+" : ""}$${state.dailyPnl.toFixed(2)}`;
  closeMsg += `\n${state.consecutiveLosses > 0 ? `⚠️ Streak: ${state.consecutiveLosses} losses` : "✅ Streak: Clean"}`;
  closeMsg += `\n📍 Open: ${state.openPositions.size}/${state.config.maxOpenPositions}`;
  await sendMessage(closeMsg);
}

export function getAgentStatus(chatId: string): string {
  const state = agentStates.get(chatId);
  if (!state) return "*Agent Status*\n\nNot configured. Open Agent menu to set up.";

  const status = state.running ? "🟢 RUNNING" : "🔴 STOPPED";
  const lastCheck = state.lastCheck > 0
    ? new Date(state.lastCheck).toISOString().substring(11, 19) + " UTC"
    : "Never";

  let msg = `*${state.config.name} — Status*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `${status}\n\n`;
  msg += `🛡 Risk: \`${state.config.riskPercent}%\` per trade\n`;
  msg += `⚡ Max Leverage: *${state.config.maxLeverage}x*\n`;
  msg += `📍 Positions: ${state.openPositions.size}/${state.config.maxOpenPositions}\n`;
  msg += `📊 Daily PnL: ${state.dailyPnl >= 0 ? "+" : ""}$${state.dailyPnl.toFixed(2)}\n`;
  msg += `${state.consecutiveLosses > 0 ? `⚠️ Loss streak: ${state.consecutiveLosses}` : "✅ Streak: Clean"}\n\n`;

  if (state.openPositions.size > 0) {
    msg += `*Open Positions:*\n`;
    for (const [sym, info] of state.openPositions) {
      msg += `${info.side === "LONG" ? "🟢" : "🔴"} ${info.side} ${sym} @ $${info.entryPrice.toFixed(2)} (SL -${info.stopLossPct.toFixed(1)}%)\n`;
    }
    msg += `\n`;
  }

  if (state.lastAction) {
    msg += `📡 Last: _${state.lastAction}_\n`;
  }
  if (state.lastReasoning) {
    msg += `🧠 _${state.lastReasoning.substring(0, 200)}_\n\n`;
  }

  msg += `🔄 Trades: \`${state.tradeCount}\` | Scans: \`${state.scanCount}\`\n`;
  msg += `🕐 Last: ${lastCheck}\n`;

  const intelStat = getIntelStatus();
  if (intelStat.tradeCount > 0) {
    msg += `📈 Memory: ${intelStat.tradeCount} trades, ${(intelStat.winRate * 100).toFixed(0)}% win rate\n`;
  }

  msg += `\n_AI-Powered | Multi-Timeframe | Strict Risk_`;
  return msg;
}

export async function resumeEnabledAgents(): Promise<void> {
  try {
    await loadLearningFromDb();

    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const rows = (await db.execute(sql`SELECT chat_id FROM aster_trading_limits WHERE auto_trade_enabled = true`)).rows;
    if (!rows || rows.length === 0) {
      console.log("[Agent] No enabled agents to resume.");
      return;
    }
    console.log(`[Agent] Found ${rows.length} enabled agent(s) to resume.`);

    for (const row of rows) {
      const chatId = String((row as any).chat_id);
      try {
        const config = await loadAgentConfigFromDb(chatId);
        if (!config.enabled) continue;

        const creds = await storage.getAsterCredentials(chatId);
        if (!creds) {
          console.log(`[Agent:${chatId}] No credentials, skipping.`);
          continue;
        }

        let client: any;
        const isV3ApiWallet = creds.apiKey?.startsWith("0x") && creds.apiKey?.length === 42;
        const isAsterCode = creds.parentAddress?.startsWith("astercode:");

        if (isV3ApiWallet && isAsterCode) {
          const realParent = creds.parentAddress!.replace("astercode:", "");
          const { createAsterCodeFuturesClient, getDefaultAsterCodeConfig } = await import("./aster-code");
          client = createAsterCodeFuturesClient(realParent, creds.apiKey, creds.apiSecret, getDefaultAsterCodeConfig());
        } else if (isV3ApiWallet) {
          const parentAddr = creds.parentAddress || creds.apiKey;
          const { createAsterV3FuturesClient } = await import("./aster-client");
          client = createAsterV3FuturesClient({ user: parentAddr, signer: creds.apiKey, signerPrivateKey: creds.apiSecret, builder: "0x06d6227e499f10fe0a9f8c8b80b3c98f964474a4", feeRate: 0.00001 });
        } else {
          const { createAsterFuturesClient } = await import("./aster-client");
          client = createAsterFuturesClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
        }
        setAgentFuturesClient(client);

        const sendMsg = async (msg: string) => {
          try {
            const botModule = await import("./telegram-bot");
            const bot = (botModule as any).default || (botModule as any).bot;
            if (bot?.sendMessage) {
              await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
            }
          } catch {}
        };

        const getClientFn = () => ({ futures: client });
        const started = await startAgent(chatId, getClientFn, sendMsg);
        if (started) {
          console.log(`[Agent:${chatId}] Resumed "${config.name}".`);
          try { await sendMsg(`🔄 *${config.name} auto-resumed* after restart.\nAll settings preserved.`); } catch {}
        }
      } catch (e: any) {
        console.warn(`[Agent:${chatId}] Resume failed: ${e.message?.substring(0, 100)}`);
      }
    }
  } catch (e: any) {
    console.error(`[Agent] resumeEnabledAgents error: ${e.message?.substring(0, 100)}`);
  }
}

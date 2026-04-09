import { emaCrossRsiStrategy, parseKlinesToCandles, type Signal, type StrategyResult } from "./trading-strategy";
import { evaluateEntry, logTradeResult, getIntelStatus, type IntelConfig, type MarketIntel } from "./market-intelligence";
import { storage } from "./storage";

const ALL_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT",
  "SUIUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT",
  "PEPEUSDT","WIFUSDT","ARBUSDT","OPUSDT","APTUSDT","MATICUSDT",
];

export interface AgentConfig {
  name: string;
  maxLeverage: number;
  riskPercent: number;
  intervalMs: number;
  klineInterval: string;
  enabled: boolean;
  maxOpenPositions: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  fundingRateFilter: boolean;
  maxFundingRateLong: number;
  minFundingRateShort: number;
  orderbookImbalanceThreshold: number;
  useConfidenceFilter: boolean;
  minConfidence: number;
  symbol?: string;
}

interface PairScan {
  symbol: string;
  result: StrategyResult;
}

interface PositionInfo {
  side: "LONG" | "SHORT";
  entryPrice: number;
  peakPnlPct: number;
  openedAt: number;
  entryStrength: number;
  entryRsi: number;
  entryMacdHist: number;
  entryBbPctB: number;
  entryAtr: number;
  entryVolRatio: number;
  entryFunding: number;
  entryImbalance: number;
  entryAligned: number;
  entryConfidence: number;
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
  lastScans: PairScan[];
  lastAction: string;
  lastReason: string;
}

const agentStates = new Map<string, AgentState>();

const envRisk = parseFloat(process.env.AGENT_RISK_PERCENT || "1.0");
const DEFAULT_CONFIG: AgentConfig = {
  name: "My Agent",
  maxLeverage: 10,
  riskPercent: Math.max(0.5, Math.min(5.0, isNaN(envRisk) ? 1.0 : envRisk)),
  intervalMs: 60000,
  klineInterval: "5m",
  enabled: false,
  maxOpenPositions: 3,
  takeProfitPct: 5.0,
  stopLossPct: 3.0,
  trailingStopPct: 2.0,
  fundingRateFilter: true,
  maxFundingRateLong: 0.001,
  minFundingRateShort: -0.001,
  orderbookImbalanceThreshold: 0.5,
  useConfidenceFilter: true,
  minConfidence: 0.45,
};

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
        riskPercent: saved.riskPercent ?? DEFAULT_CONFIG.riskPercent,
        intervalMs: saved.intervalMs ?? DEFAULT_CONFIG.intervalMs,
        klineInterval: saved.klineInterval ?? DEFAULT_CONFIG.klineInterval,
        enabled: limits.autoTradeEnabled ?? saved.enabled ?? false,
        maxOpenPositions: limits.maxOpenPositions ?? saved.maxOpenPositions ?? DEFAULT_CONFIG.maxOpenPositions,
        takeProfitPct: saved.takeProfitPct ?? DEFAULT_CONFIG.takeProfitPct,
        stopLossPct: saved.stopLossPct ?? DEFAULT_CONFIG.stopLossPct,
        trailingStopPct: saved.trailingStopPct ?? DEFAULT_CONFIG.trailingStopPct,
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
      console.log(`[Agent:${chatId}] Loaded config from DB: name="${config.name}", maxLev=${config.maxLeverage}, risk=${config.riskPercent}%, positions=${config.maxOpenPositions}, enabled=${config.enabled}`);
      return config;
    }
  } catch (e: any) {
    console.warn(`[Agent:${chatId}] Failed to load config from DB: ${e.message?.substring(0, 100)}`);
  }
  return { ...DEFAULT_CONFIG };
}

async function saveAgentConfigToDb(chatId: string, config: AgentConfig): Promise<void> {
  try {
    const configJson = JSON.stringify({
      name: config.name,
      riskPercent: config.riskPercent,
      intervalMs: config.intervalMs,
      klineInterval: config.klineInterval,
      maxLeverage: config.maxLeverage,
      maxOpenPositions: config.maxOpenPositions,
      enabled: config.enabled,
      takeProfitPct: config.takeProfitPct,
      stopLossPct: config.stopLossPct,
      trailingStopPct: config.trailingStopPct,
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
    console.log(`[Agent:${chatId}] Saved config to DB: name="${config.name}", risk=${config.riskPercent}%`);
  } catch (e: any) {
    console.warn(`[Agent:${chatId}] Failed to save config to DB: ${e.message?.substring(0, 100)}`);
  }
}

export function setAgentConfig(chatId: string, partial: Partial<AgentConfig>): AgentConfig {
  let state = agentStates.get(chatId);
  if (!state) {
    state = createDefaultState();
    agentStates.set(chatId, state);
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
    lastScans: [],
    lastAction: "",
    lastReason: "",
  };
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

  state.openPositions.clear();
  const localPositions = await storage.getAsterLocalPositions(chatId);
  for (const p of localPositions) {
    if (p.quantity > 0) {
      state.openPositions.set(p.symbol, {
        side: p.side === "LONG" ? "LONG" : "SHORT",
        entryPrice: p.entryPrice || 0,
        peakPnlPct: 0,
        openedAt: Date.now(),
        entryStrength: 0, entryRsi: 50, entryMacdHist: 0, entryBbPctB: 0.5,
        entryAtr: 0, entryVolRatio: 1, entryFunding: 0, entryImbalance: 0.5,
        entryAligned: 0, entryConfidence: 0,
      });
    }
  }

  try {
    const posCount = state.openPositions.size;
    const posList = posCount > 0
      ? Array.from(state.openPositions.entries()).map(([s, info]) => `${info.side} ${s}`).join(", ")
      : "None";
    const intelFlags = [];
    if (state.config.fundingRateFilter) intelFlags.push("💰 Funding");
    if (state.config.useConfidenceFilter) intelFlags.push(`🧠 AI ${(state.config.minConfidence * 100).toFixed(0)}%`);
    intelFlags.push("📊 MACD+BB+Vol");
    await sendMessage(
      `🤖 *${state.config.name} Started — Full Auto*\n` +
      `Scanning: *${ALL_PAIRS.length} pairs*\n` +
      `Max Leverage: ${state.config.maxLeverage}x | TP: ${state.config.takeProfitPct}% | SL: ${state.config.stopLossPct}%\n` +
      `Risk: ${state.config.riskPercent}% | Trailing: ${state.config.trailingStopPct}%\n` +
      `Max Positions: ${state.config.maxOpenPositions}\n` +
      `Intel: ${intelFlags.join(" | ")}\n` +
      `Open: ${posList}\n` +
      `Checking every ${Math.round(state.config.intervalMs / 1000)}s`
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

async function scanAllPairs(
  futuresClient: any,
  klineInterval: string,
  chatId: string,
): Promise<PairScan[]> {
  const results: PairScan[] = [];
  for (const symbol of ALL_PAIRS) {
    try {
      const klines = await futuresClient.klines(symbol, klineInterval, 100);
      const candles = parseKlinesToCandles(klines);
      if (candles.length >= 22) {
        const result = emaCrossRsiStrategy(candles);
        results.push({ symbol, result });
      }
    } catch (e: any) {
      console.log(`[Agent:${chatId}] Scan ${symbol} failed: ${e.message?.substring(0, 60)}`);
    }
  }
  return results;
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

    const scans = await scanAllPairs(futuresClient, state.config.klineInterval, chatId);
    state.lastScans = scans;
    state.lastCheck = Date.now();
    state.scanCount++;

    const buySignals = scans.filter(s => s.result.signal === "BUY").sort((a, b) => b.result.strength - a.result.strength);
    const sellSignals = scans.filter(s => s.result.signal === "SELL").sort((a, b) => b.result.strength - a.result.strength);
    const holdCount = scans.filter(s => s.result.signal === "HOLD").length;

    console.log(`[Agent:${chatId}] Scan #${state.scanCount}: ${buySignals.length} BUY, ${sellSignals.length} SELL, ${holdCount} HOLD | ${state.openPositions.size} open`);

    if (state.scanCount % 5 === 1) {
      try {
        const topBuys = buySignals.slice(0, 3).map(s => `🟢 ${s.symbol} (${s.result.strength})`).join("\n") || "None";
        const topSells = sellSignals.slice(0, 3).map(s => `🔴 ${s.symbol} (${s.result.strength})`).join("\n") || "None";
        const openList = state.openPositions.size > 0
          ? Array.from(state.openPositions.entries()).map(([s, info]) => `${info.side === "LONG" ? "🟢" : "🔴"} ${info.side} ${s}`).join("\n")
          : "None";
        await sendMessage(
          `📡 *${state.config.name} — Scan #${state.scanCount}*\n` +
          `Scanned: ${scans.length}/${ALL_PAIRS.length} pairs\n\n` +
          `*Top Buy Signals:*\n${topBuys}\n\n` +
          `*Top Sell Signals:*\n${topSells}\n\n` +
          `*Open Positions (${state.openPositions.size}/${state.config.maxOpenPositions}):*\n${openList}`
        );
      } catch {}
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
          entryStrength: 0, entryRsi: 50, entryMacdHist: 0, entryBbPctB: 0.5,
          entryAtr: 0, entryVolRatio: 1, entryFunding: 0, entryImbalance: 0.5,
          entryAligned: 0, entryConfidence: 0,
        });
      }
    }

    for (const [symbol, info] of Array.from(state.openPositions.entries())) {
      const scan = scans.find(s => s.symbol === symbol);
      const markPrice = scan?.result.lastClose || 0;
      let closeReason = "";

      if (markPrice > 0 && info.entryPrice > 0) {
        const pnlPct = info.side === "LONG"
          ? ((markPrice - info.entryPrice) / info.entryPrice) * 100
          : ((info.entryPrice - markPrice) / info.entryPrice) * 100;

        if (pnlPct > info.peakPnlPct) {
          info.peakPnlPct = pnlPct;
        }

        if (pnlPct >= state.config.takeProfitPct) {
          closeReason = `🎯 Take Profit hit (${pnlPct.toFixed(2)}% ≥ ${state.config.takeProfitPct}%)`;
        } else if (pnlPct <= -state.config.stopLossPct) {
          closeReason = `🛑 Stop Loss hit (${pnlPct.toFixed(2)}% ≤ -${state.config.stopLossPct}%)`;
        } else if (info.peakPnlPct >= state.config.trailingStopPct && pnlPct < info.peakPnlPct - state.config.trailingStopPct) {
          closeReason = `📉 Trailing Stop (peak ${info.peakPnlPct.toFixed(2)}% → ${pnlPct.toFixed(2)}%, trail ${state.config.trailingStopPct}%)`;
        }

        if (!closeReason && scan) {
          const rsiVal = scan.result.rsiValue;
          if (info.side === "LONG" && rsiVal > 78 && pnlPct > 1) {
            closeReason = `📊 RSI overbought exit (RSI ${rsiVal.toFixed(1)}, PnL +${pnlPct.toFixed(2)}%)`;
          } else if (info.side === "SHORT" && rsiVal < 22 && pnlPct > 1) {
            closeReason = `📊 RSI oversold exit (RSI ${rsiVal.toFixed(1)}, PnL +${pnlPct.toFixed(2)}%)`;
          }
        }
      }

      if (!closeReason && scan) {
        if (info.side === "LONG" && scan.result.signal === "SELL" && scan.result.strength >= 5) {
          closeReason = `🔄 Signal reversal (SELL strength ${scan.result.strength})`;
        } else if (info.side === "SHORT" && scan.result.signal === "BUY" && scan.result.strength >= 5) {
          closeReason = `🔄 Signal reversal (BUY strength ${scan.result.strength})`;
        }
      }

      if (!closeReason && state.config.fundingRateFilter) {
        try {
          const { getFundingRate } = await import("./market-intelligence");
          const funding = await getFundingRate(futuresClient, symbol);
          if (info.side === "LONG" && funding > 0.003) {
            closeReason = `💰 Funding rate too high for LONG (${(funding * 100).toFixed(4)}% > 0.3%)`;
          } else if (info.side === "SHORT" && funding < -0.003) {
            closeReason = `💰 Funding rate too negative for SHORT (${(funding * 100).toFixed(4)}% < -0.3%)`;
          }
        } catch {}
      }

      if (closeReason) {
        console.log(`[Agent:${chatId}] Closing ${info.side} ${symbol}: ${closeReason}`);
        await closePosition(chatId, futuresClient, state, symbol, sendMessage, closeReason);
      }
    }

    const openCount = state.openPositions.size;
    if (openCount < state.config.maxOpenPositions) {
      const slotsAvailable = state.config.maxOpenPositions - openCount;

      const candidates: { symbol: string; side: "BUY" | "SELL"; result: StrategyResult }[] = [];
      for (const s of buySignals) {
        if (!state.openPositions.has(s.symbol) && s.result.strength >= 5) {
          candidates.push({ symbol: s.symbol, side: "BUY", result: s.result });
        }
      }
      for (const s of sellSignals) {
        if (!state.openPositions.has(s.symbol) && s.result.strength >= 5) {
          candidates.push({ symbol: s.symbol, side: "SELL", result: s.result });
        }
      }

      const seen = new Set<string>();
      const unique = candidates.filter(c => {
        if (seen.has(c.symbol)) return false;
        seen.add(c.symbol);
        return true;
      });
      unique.sort((a, b) => b.result.strength - a.result.strength);

      const intelConfig: IntelConfig = {
        fundingRateFilter: state.config.fundingRateFilter,
        maxFundingRateLong: state.config.maxFundingRateLong,
        minFundingRateShort: state.config.minFundingRateShort,
        orderbookImbalanceThreshold: state.config.orderbookImbalanceThreshold,
        useConfidenceFilter: state.config.useConfidenceFilter,
        minConfidence: state.config.minConfidence,
      };

      for (let i = 0; i < Math.min(slotsAvailable + 2, unique.length); i++) {
        if (state.openPositions.size >= state.config.maxOpenPositions) break;
        const c = unique[i];
        if (state.openPositions.has(c.symbol)) continue;

        try {
          const intel = await evaluateEntry(futuresClient, c.symbol, c.side, c.result, intelConfig);

          if (!intel.fundingFavorable || !intel.orderbookFavorable || intel.rejectReason) {
            console.log(`[Agent:${chatId}] Rejected ${c.side} ${c.symbol}: ${intel.rejectReason} (confidence: ${(intel.confidence * 100).toFixed(0)}%)`);
            continue;
          }

          await openPosition(chatId, futuresClient, state, c.symbol, c.side, c.result, sendMessage, intel);
        } catch (e: any) {
          console.log(`[Agent:${chatId}] Intel eval failed for ${c.symbol}: ${e.message?.substring(0, 80)}`);
          await openPosition(chatId, futuresClient, state, c.symbol, c.side, c.result, sendMessage);
        }
      }
    }

    state.errors = 0;
  } catch (e: any) {
    state.errors++;
    console.error(`[Agent:${chatId}] Error #${state.errors}:`, e.message?.substring(0, 300));
    if (state.errors <= 3) {
      try {
        await sendMessage(`⚠️ Agent error (${state.errors}/3): ${e.message?.substring(0, 150)}`);
      } catch {}
    }
    if (state.errors >= 30) {
      state.running = false;
      state.config.enabled = false;
      saveAgentConfigToDb(chatId, state.config);
      try {
        await sendMessage(`🛑 Agent stopped after ${state.errors} consecutive errors. Restart from the Agent tab.`);
      } catch {}
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

function computeQuantity(symbol: string, usdtBalance: number, riskPercent: number, leverage: number, lastPrice: number): number {
  if (lastPrice <= 0 || usdtBalance <= 0) return 0;

  const riskAmount = usdtBalance * (riskPercent / 100);
  let notional = riskAmount * leverage;
  const MIN_NOTIONAL = 6.0;
  if (notional < MIN_NOTIONAL && usdtBalance * leverage >= MIN_NOTIONAL) {
    notional = MIN_NOTIONAL;
  }
  let qty = notional / lastPrice;

  const stepSizes: Record<string, number> = {
    BTCUSDT: 0.001, ETHUSDT: 0.01, SOLUSDT: 0.1, BNBUSDT: 0.01,
    DOGEUSDT: 1, XRPUSDT: 0.1, ADAUSDT: 1, AVAXUSDT: 0.1,
    DOTUSDT: 0.1, MATICUSDT: 1, LINKUSDT: 0.01, LTCUSDT: 0.001,
    SUIUSDT: 0.1, ARBUSDT: 0.1, OPUSDT: 0.1, APTUSDT: 0.01,
    PEPEUSDT: 1, WIFUSDT: 0.1, NEARUSDT: 0.1, TONUSDT: 0.1,
    ONDOUSDT: 0.1, FTMUSDT: 1, INJUSDT: 0.01, TIAUSDT: 0.1,
    SEIUSDT: 1, STXUSDT: 0.1, RUNEUSDT: 0.1, JUPUSDT: 1,
  };
  const step = stepSizes[symbol] || (lastPrice > 1000 ? 0.001 : lastPrice > 100 ? 0.01 : lastPrice > 1 ? 0.1 : 1);
  qty = Math.floor(qty / step) * step;

  const precision = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
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
        console.log(`[Agent:${chatId}] API balance: $${apiBal.toFixed(2)} (from ${futuresClient ? 'per-user' : 'shared'} client)`);
        if (apiBal > 0) return apiBal;
      }
    } catch (e: any) {
      console.log(`[Agent:${chatId}] API balance check failed, falling back to local: ${e.message?.substring(0, 100)}`);
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

  const available = totalDeposited - marginUsed;
  console.log(`[Agent:${chatId}] Local balance fallback: $${available.toFixed(2)} (deposited=$${totalDeposited.toFixed(2)}, marginUsed=$${marginUsed.toFixed(2)})`);
  return Math.max(available, 0);
}

function chooseLeverage(symbol: string, maxLeverage: number, strength: number): number {
  const volatilityTier: Record<string, number> = {
    BTCUSDT: 1, ETHUSDT: 1, BNBUSDT: 1.2, SOLUSDT: 1.5,
    XRPUSDT: 1.3, DOGEUSDT: 2, PEPEUSDT: 2.5, WIFUSDT: 2.5,
    SUIUSDT: 1.8, ADAUSDT: 1.4, AVAXUSDT: 1.5, LINKUSDT: 1.3,
    DOTUSDT: 1.4, LTCUSDT: 1.2, ARBUSDT: 1.6, OPUSDT: 1.6,
    APTUSDT: 1.5, MATICUSDT: 1.5,
  };
  const vol = volatilityTier[symbol] || 1.5;
  const baseLev = Math.max(2, Math.min(maxLeverage, Math.round(maxLeverage / vol)));
  const strengthBonus = strength > 30 ? 2 : strength > 15 ? 1 : 0;
  return Math.min(maxLeverage, baseLev + strengthBonus);
}

async function openPosition(
  chatId: string,
  futuresClient: any,
  state: AgentState,
  symbol: string,
  side: "BUY" | "SELL",
  result: StrategyResult,
  sendMessage: (msg: string) => Promise<void>,
  intel?: MarketIntel,
) {
  const leverage = chooseLeverage(symbol, state.config.maxLeverage, result.strength);

  try {
    await futuresClient.setLeverage(symbol, leverage);
  } catch (e: any) {
    if (!e.message?.includes("No need to change")) {
      console.warn(`[Agent:${chatId}] Leverage warning for ${symbol}: ${e.message?.substring(0, 100)}`);
    }
  }

  const ticker = await futuresClient.tickerPrice(symbol);
  const lastPrice = parseFloat(ticker?.price || "0");
  if (lastPrice === 0) throw new Error(`Could not get price for ${symbol}`);

  const availableBalance = await getAvailableBalance(chatId, futuresClient);
  if (availableBalance < 5) {
    console.log(`[Agent:${chatId}] Insufficient balance: $${availableBalance.toFixed(2)} (need $5+ for Aster minimum)`);
    await sendMessage(
      `⚠️ Agent skipped ${symbol} — balance too low ($${availableBalance.toFixed(2)} USDT).\n\n` +
      `Aster requires minimum $5 notional per order.\n` +
      `Deposit more USDT to your Aster account to trade.`
    );
    return;
  }

  const positionRisk = state.config.riskPercent / state.config.maxOpenPositions;
  const qty = computeQuantity(symbol, availableBalance, positionRisk, leverage, lastPrice);
  if (qty <= 0) {
    console.log(`[Agent:${chatId}] ${symbol} qty too small after rounding`);
    return;
  }

  const notional = qty * lastPrice;
  if (notional < 5.5) {
    console.log(`[Agent:${chatId}] ${symbol} notional $${notional.toFixed(2)} below $5.50 minimum, skipping`);
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
  state.openPositions.set(symbol, {
    side: positionSide,
    entryPrice: entryP,
    peakPnlPct: 0,
    openedAt: Date.now(),
    entryStrength: result.strength,
    entryRsi: result.rsiValue,
    entryMacdHist: result.macdHistogram,
    entryBbPctB: result.bollingerPercentB,
    entryAtr: result.atrValue,
    entryVolRatio: result.volumeRatio,
    entryFunding: intel?.fundingRate || 0,
    entryImbalance: intel?.orderbookImbalance || 0.5,
    entryAligned: result.alignedIndicators,
    entryConfidence: intel?.confidence || 0,
  });
  state.tradeCount++;
  state.lastAction = `${positionSide} ${symbol}`;
  state.lastReason = result.reason;

  const icon = side === "BUY" ? "🟢" : "🔴";
  const confStr = intel ? ` | 🧠 ${(intel.confidence * 100).toFixed(0)}%` : "";
  const fundStr = intel ? ` | 💰 ${(intel.fundingRate * 100).toFixed(4)}%` : "";
  await sendMessage(
    `🚀 *Auto Trade — ${symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${icon} ${positionSide} *${symbol}*\n` +
    `📦 Qty: \`${filledQty || qty}\`\n` +
    `💲 Price: \`$${(avgPrice || lastPrice).toFixed(2)}\`\n` +
    `⚡ Leverage: *${leverage}x* (auto)\n` +
    `💪 Strength: *${result.strength}* | Aligned: *${result.alignedIndicators}*${confStr}${fundStr}\n` +
    `📊 ${result.reason}\n\n` +
    `📋 Order: \`${orderResult.orderId}\`\n` +
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
  if (closePrice > 0) {
    pnl = pos.side === "LONG"
      ? (closePrice - pos.entryPrice) * filledQty
      : (pos.entryPrice - closePrice) * filledQty;
  }

  try {
    const { db: dbConn } = await import("./db");
    const { sql: sqlTag } = await import("drizzle-orm");
    await dbConn.execute(sqlTag`
      INSERT INTO aster_agent_trades (chat_id, symbol, side, entry_price, exit_price, quantity, leverage, pnl, pnl_pct, status, order_id, close_order_id, reason, opened_at, closed_at)
      VALUES (${chatId}, ${symbol}, ${pos.side}, ${pos.entryPrice}, ${closePrice}, ${filledQty}, ${pos.leverage || state.config.maxLeverage}, ${pnl},
        ${pos.entryPrice > 0 && filledQty > 0 ? (pnl / (pos.entryPrice * filledQty) * 100) : 0},
        'CLOSED', ${String(pos.orderId || '')}, ${String(closeResult.orderId || '')}, ${reason || ''}, ${new Date(pos.openedAt || Date.now())}, now())
    `);
  } catch (e: any) { console.log(`[Agent] trade persist error: ${e.message?.substring(0, 80)}`); }

  if (posInfo && posInfo.entryConfidence > 0) {
    logTradeResult({
      rsi: posInfo.entryRsi,
      macdHist: posInfo.entryMacdHist,
      bbPercentB: posInfo.entryBbPctB,
      atr: posInfo.entryAtr,
      volumeRatio: posInfo.entryVolRatio,
      strength: posInfo.entryStrength,
      fundingRate: posInfo.entryFunding,
      imbalance: posInfo.entryImbalance,
      aligned: posInfo.entryAligned,
    }, pnl > 0);
  }

  state.lastAction = `Closed ${pos.side} ${symbol}`;
  state.lastReason = reason || `PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`;

  const pnlIcon = pnl >= 0 ? "✅" : "❌";
  let closeMsg =
    `📤 *Position Closed — ${symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${pos.side === "LONG" ? "🟢" : "🔴"} ${pos.side} *${symbol}*\n` +
    `📦 Qty: \`${filledQty}\`\n` +
    `💲 Entry: \`$${pos.entryPrice.toFixed(pos.entryPrice < 1 ? 6 : 2)}\` → Exit: \`$${closePrice.toFixed(closePrice < 1 ? 6 : 2)}\`\n` +
    `${pnlIcon} Realized PnL: \`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT\`\n`;
  if (reason) closeMsg += `\n📋 *Reason:* _${reason}_\n`;
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

  let msg = `*Agent Status — Full Auto*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `${status}\n\n`;
  msg += `🌐 Scanning: *${ALL_PAIRS.length} pairs*\n`;
  msg += `⚡ Max Leverage: *${state.config.maxLeverage}x*\n`;
  msg += `🎯 Risk: \`${state.config.riskPercent}%\` per trade\n`;
  msg += `📊 Timeframe: \`${state.config.klineInterval}\`\n`;
  msg += `📍 Positions: ${state.openPositions.size}/${state.config.maxOpenPositions}\n\n`;

  if (state.openPositions.size > 0) {
    msg += `*Open Positions:*\n`;
    for (const [sym, info] of state.openPositions) {
      const side = typeof info === "string" ? info : info.side;
      msg += `${side === "LONG" ? "🟢" : "🔴"} ${side} ${sym}\n`;
    }
    msg += `\n`;
  }

  if (state.lastScans.length > 0) {
    const buys = state.lastScans.filter(s => s.result.signal === "BUY").sort((a, b) => b.result.strength - a.result.strength);
    const sells = state.lastScans.filter(s => s.result.signal === "SELL").sort((a, b) => b.result.strength - a.result.strength);
    if (buys.length > 0) {
      msg += `*Top Buys:* `;
      msg += buys.slice(0, 3).map(s => `${s.symbol.replace("USDT", "")}(${s.result.strength})`).join(", ");
      msg += `\n`;
    }
    if (sells.length > 0) {
      msg += `*Top Sells:* `;
      msg += sells.slice(0, 3).map(s => `${s.symbol.replace("USDT", "")}(${s.result.strength})`).join(", ");
      msg += `\n`;
    }
    msg += `\n`;
  }

  if (state.lastAction) {
    msg += `📡 Last: _${state.lastAction}_\n`;
  }
  msg += `🔄 Trades: \`${state.tradeCount}\`\n`;
  msg += `⚠️ Errors: \`${state.errors}\`\n`;
  msg += `🕐 Last Scan: ${lastCheck}\n\n`;
  const intelStat = getIntelStatus();
  msg += `🧠 ML Model: ${intelStat.tradeCount} samples, ${(intelStat.winRate * 100).toFixed(0)}% win rate\n`;
  msg += `_Strategy: EMA + RSI + MACD + BB + Funding + Orderbook_`;

  return msg;
}

export async function resumeEnabledAgents(): Promise<void> {
  try {
    const { db } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const rows = (await db.execute(sql`SELECT chat_id FROM aster_trading_limits WHERE auto_trade_enabled = true`)).rows;
    if (!rows || rows.length === 0) {
      console.log("[Agent] No enabled agents to resume.");
      return;
    }
    console.log(`[Agent] Found ${rows.length} enabled agent(s) to resume after restart.`);

    for (const row of rows) {
      const chatId = String((row as any).chat_id);
      try {
        const config = await loadAgentConfigFromDb(chatId);
        if (!config.enabled) continue;

        const creds = await storage.getAsterCredentials(chatId);
        if (!creds) {
          console.log(`[Agent:${chatId}] No Aster credentials, skipping resume.`);
          continue;
        }

        let client: any;
        const isV3ApiWallet = creds.apiKey?.startsWith("0x") && creds.apiKey?.length === 42;
        const isAsterCode = creds.parentAddress?.startsWith("astercode:");

        if (isV3ApiWallet && isAsterCode) {
          const realParent = creds.parentAddress!.replace("astercode:", "");
          const { createAsterCodeFuturesClient, getDefaultAsterCodeConfig } = await import("./aster-code");
          client = createAsterCodeFuturesClient(realParent, creds.apiKey, creds.apiSecret, getDefaultAsterCodeConfig());
          console.log(`[Agent:${chatId}] Using Aster Code client (builder mode)`);
        } else if (isV3ApiWallet) {
          const parentAddr = creds.parentAddress || creds.apiKey;
          const { createAsterV3FuturesClient } = await import("./aster-client");
          client = createAsterV3FuturesClient({ user: parentAddr, signer: creds.apiKey, signerPrivateKey: creds.apiSecret });
          console.log(`[Agent:${chatId}] Using V3 API Wallet client`);
        } else {
          const { createAsterFuturesClient } = await import("./aster-client");
          client = createAsterFuturesClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
          console.log(`[Agent:${chatId}] Using HMAC client`);
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
          console.log(`[Agent:${chatId}] Resumed "${config.name}" after restart.`);
          try {
            await sendMsg(`🔄 *${config.name} auto-resumed* after server restart.\n\nAll settings preserved.`);
          } catch {}
        }
      } catch (e: any) {
        console.warn(`[Agent:${chatId}] Resume failed: ${e.message?.substring(0, 100)}`);
      }
    }
  } catch (e: any) {
    console.error(`[Agent] resumeEnabledAgents error: ${e.message?.substring(0, 100)}`);
  }
}

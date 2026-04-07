import { emaCrossRsiStrategy, parseKlinesToCandles, type Signal, type StrategyResult } from "./trading-strategy";
import { storage } from "./storage";

export interface AgentConfig {
  name: string;
  symbol: string;
  leverage: number;
  riskPercent: number;
  intervalMs: number;
  klineInterval: string;
  enabled: boolean;
}

interface AgentState {
  config: AgentConfig;
  running: boolean;
  lastSignal: Signal;
  lastCheck: number;
  tradeCount: number;
  scanCount: number;
  errors: number;
  timer: ReturnType<typeof setTimeout> | null;
  currentPosition: "LONG" | "SHORT" | "NONE";
  lastPrice: number;
  lastReason: string;
}

const agentStates = new Map<string, AgentState>();

const envRisk = parseFloat(process.env.AGENT_RISK_PERCENT || "1.0");
const DEFAULT_CONFIG: AgentConfig = {
  name: "My Agent",
  symbol: "BTCUSDT",
  leverage: 10,
  riskPercent: Math.max(0.5, Math.min(2.0, isNaN(envRisk) ? 1.0 : envRisk)),
  intervalMs: 60000,
  klineInterval: "5m",
  enabled: false,
};

export function getAgentState(chatId: string): AgentState | undefined {
  return agentStates.get(chatId);
}

export function getAgentConfig(chatId: string): AgentConfig {
  const state = agentStates.get(chatId);
  return state?.config || { ...DEFAULT_CONFIG };
}

export function setAgentConfig(chatId: string, partial: Partial<AgentConfig>): AgentConfig {
  let state = agentStates.get(chatId);
  if (!state) {
    state = createDefaultState();
    agentStates.set(chatId, state);
  }
  Object.assign(state.config, partial);
  return state.config;
}

function createDefaultState(): AgentState {
  return {
    config: { ...DEFAULT_CONFIG },
    running: false,
    lastSignal: "HOLD",
    lastCheck: 0,
    tradeCount: 0,
    scanCount: 0,
    errors: 0,
    timer: null,
    currentPosition: "NONE",
    lastPrice: 0,
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

  if (state.running) return false;
  state.running = true;
  state.config.enabled = true;
  state.errors = 0;

  const localPositions = await storage.getAsterLocalPositions(chatId);
  const existingPos = localPositions.find(p => p.symbol === state!.config.symbol);
  if (existingPos) {
    state.currentPosition = existingPos.side === "LONG" ? "LONG" : "SHORT";
  }

  try {
    await sendMessage(
      `🤖 *${state.config.name} Started*\n` +
      `Symbol: ${state.config.symbol}\n` +
      `Leverage: ${state.config.leverage}x\n` +
      `Risk: ${state.config.riskPercent}%\n` +
      `Interval: ${state.config.klineInterval}\n` +
      `Current position: ${state.currentPosition}\n` +
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

    const klines = await futuresClient.klines(state.config.symbol, state.config.klineInterval, 100);
    const candles = parseKlinesToCandles(klines);

    if (candles.length < 22) {
      console.log(`[Agent:${chatId}] Not enough candles: ${candles.length}`);
      scheduleNext(chatId, getClient, sendMessage);
      return;
    }

    const result: StrategyResult = emaCrossRsiStrategy(candles);
    state.lastSignal = result.signal;
    state.lastCheck = Date.now();
    state.lastPrice = result.lastClose;
    state.lastReason = result.reason;

    console.log(`[Agent:${chatId}] ${state.config.symbol} signal=${result.signal} price=$${result.lastClose.toFixed(2)} pos=${state.currentPosition} | ${result.reason}`);

    state.scanCount++;
    if (state.scanCount % 5 === 1) {
      try {
        const signalEmoji = result.signal === "BUY" ? "🟢" : result.signal === "SELL" ? "🔴" : "⏸";
        await sendMessage(
          `${signalEmoji} *${state.config.name} — Scan #${state.scanCount}*\n` +
          `${state.config.symbol} @ $${result.lastClose.toFixed(2)}\n` +
          `Signal: *${result.signal}* | Position: ${state.currentPosition}\n` +
          `EMA8: ${result.ema8.toFixed(2)} | EMA21: ${result.ema21.toFixed(2)}\n` +
          `RSI: ${result.rsiValue.toFixed(1)}\n` +
          `_${result.reason}_`
        );
      } catch {}
    }

    if (result.signal === "BUY" && state.currentPosition !== "LONG") {
      if (state.currentPosition === "SHORT") {
        await closeCurrentPosition(chatId, futuresClient, state, sendMessage);
      }
      await openPosition(chatId, futuresClient, state, "BUY", result, sendMessage);
      state.currentPosition = "LONG";
    } else if (result.signal === "SELL" && state.currentPosition !== "SHORT") {
      if (state.currentPosition === "LONG") {
        await closeCurrentPosition(chatId, futuresClient, state, sendMessage);
      }
      await openPosition(chatId, futuresClient, state, "SELL", result, sendMessage);
      state.currentPosition = "SHORT";
    }

    state.errors = 0;
  } catch (e: any) {
    state.errors++;
    console.error(`[Agent:${chatId}] Error:`, e.message?.substring(0, 300));
    if (state.errors <= 3) {
      try {
        await sendMessage(`⚠️ Agent error (${state.errors}/3): ${e.message?.substring(0, 150)}`);
      } catch {}
    }
    if (state.errors >= 10) {
      state.running = false;
      state.config.enabled = false;
      try {
        await sendMessage(`🛑 Agent stopped after ${state.errors} consecutive errors.`);
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
  const notional = riskAmount * leverage;
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

async function getAvailableBalance(chatId: string): Promise<number> {
  if (_agentFuturesClient) {
    try {
      const balances = await _agentFuturesClient.balance();
      const usdtEntry = Array.isArray(balances)
        ? balances.find((b: any) => b.asset === "USDT" || b.asset === "usdt")
        : null;
      if (usdtEntry) {
        const apiBal = parseFloat(usdtEntry.availableBalance || usdtEntry.crossWalletBalance || usdtEntry.balance || "0");
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
  return Math.max(available, 0);
}

async function openPosition(
  chatId: string,
  futuresClient: any,
  state: AgentState,
  side: "BUY" | "SELL",
  result: StrategyResult,
  sendMessage: (msg: string) => Promise<void>,
) {
  try {
    await futuresClient.setLeverage(state.config.symbol, state.config.leverage);
  } catch (e: any) {
    if (!e.message?.includes("No need to change")) {
      console.warn(`[Agent:${chatId}] Leverage warning: ${e.message?.substring(0, 100)}`);
    }
  }

  const ticker = await futuresClient.tickerPrice(state.config.symbol);
  const lastPrice = parseFloat(ticker?.price || "0");
  if (lastPrice === 0) throw new Error("Could not get current price");

  const availableBalance = await getAvailableBalance(chatId);
  if (availableBalance < 1) {
    console.log(`[Agent:${chatId}] Insufficient balance: $${availableBalance.toFixed(2)}`);
    await sendMessage(
      `⚠️ Agent paused — insufficient margin ($${availableBalance.toFixed(2)} USDT).\n\n` +
      `Deposit USDT (BEP-20) on BSC to the vault:\n` +
      `0x128463A60784c4D3f46c23Af3f65Ed859Ba87974\n\n` +
      `Then use /deposit → Confirm TX Hash.\n` +
      `Agent will resume once balance > $1.`
    );
    return;
  }

  const qty = computeQuantity(state.config.symbol, availableBalance, state.config.riskPercent, state.config.leverage, lastPrice);
  if (qty <= 0) {
    console.log(`[Agent:${chatId}] Qty too small after rounding`);
    return;
  }

  const orderResult = await futuresClient.createOrder({
    symbol: state.config.symbol,
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
    leverage: state.config.leverage,
  });

  state.tradeCount++;

  const sideLabel = side === "BUY" ? "LONG" : "SHORT";
  const icon = side === "BUY" ? "🟢" : "🔴";

  await sendMessage(
    `🚀 *Auto Trade Executed!*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${icon} ${sideLabel} *${state.config.symbol}*\n` +
    `📦 Qty: \`${filledQty || qty}\`\n` +
    `💲 Price: \`$${(avgPrice || lastPrice).toFixed(2)}\`\n` +
    `⚡ Leverage: *${state.config.leverage}x*\n` +
    `📊 Signal: ${result.reason}\n\n` +
    `📋 Order ID: \`${orderResult.orderId}\`\n` +
    `✅ Status: *${orderResult.status}*`
  );
}

async function closeCurrentPosition(
  chatId: string,
  futuresClient: any,
  state: AgentState,
  sendMessage: (msg: string) => Promise<void>,
) {
  const localPositions = await storage.getAsterLocalPositions(chatId);
  const pos = localPositions.find(p => p.symbol === state.config.symbol);
  if (!pos || pos.quantity <= 0) {
    state.currentPosition = "NONE";
    return;
  }

  const closeSide = pos.side === "LONG" ? "SELL" : "BUY";
  const closeResult = await futuresClient.createOrder({
    symbol: state.config.symbol,
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
    symbol: state.config.symbol,
    side: closeSide,
    type: "MARKET",
    quantity: pos.quantity,
    executedQty: filledQty,
    price: parseFloat(closeResult.price || "0"),
    avgPrice: closePrice,
    status: closeResult.status || "FILLED",
    reduceOnly: true,
    leverage: state.config.leverage,
  });

  state.currentPosition = "NONE";

  let pnl = 0;
  if (closePrice > 0) {
    pnl = pos.side === "LONG"
      ? (closePrice - pos.entryPrice) * filledQty
      : (pos.entryPrice - closePrice) * filledQty;
  }

  const pnlIcon = pnl >= 0 ? "✅" : "❌";
  await sendMessage(
    `📤 *Position Closed*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${pos.side === "LONG" ? "🟢" : "🔴"} ${pos.side} *${state.config.symbol}*\n` +
    `📦 Qty: \`${filledQty}\`\n` +
    `💲 Entry: \`$${pos.entryPrice.toFixed(2)}\` → Exit: \`$${closePrice.toFixed(2)}\`\n` +
    `${pnlIcon} Realized PnL: \`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT\`\n\n` +
    `📋 Order ID: \`${closeResult.orderId}\``
  );
}

export function getAgentStatus(chatId: string): string {
  const state = agentStates.get(chatId);
  if (!state) return "*Agent Status*\n\nNot configured. Open Agent menu to set up.";

  const status = state.running ? "🟢 RUNNING" : "🔴 STOPPED";
  const lastCheck = state.lastCheck > 0
    ? new Date(state.lastCheck).toISOString().substring(11, 19) + " UTC"
    : "Never";

  let msg = `*Agent Status*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `${status}\n\n`;
  msg += `📌 Symbol: \`${state.config.symbol}\`\n`;
  msg += `⚡ Leverage: *${state.config.leverage}x*\n`;
  msg += `🎯 Risk: \`${state.config.riskPercent}%\` per trade\n`;
  msg += `⏱️ Interval: \`${state.config.intervalMs / 1000}s\`\n`;
  msg += `📊 Timeframe: \`${state.config.klineInterval}\`\n\n`;
  msg += `📡 Last Signal: \`${state.lastSignal}\`\n`;
  if (state.lastPrice > 0) {
    msg += `💲 Last Price: \`$${state.lastPrice.toFixed(2)}\`\n`;
  }
  if (state.lastReason) {
    msg += `📐 Reason: _${state.lastReason}_\n`;
  }
  msg += `📍 Position: \`${state.currentPosition}\`\n`;
  msg += `🔄 Trades: \`${state.tradeCount}\`\n`;
  msg += `⚠️ Errors: \`${state.errors}\`\n`;
  msg += `🕐 Last Check: ${lastCheck}\n\n`;
  msg += `_Strategy: EMA(8/21) + RSI(14) filter_`;

  return msg;
}

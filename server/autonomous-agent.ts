import { emaCrossRsiStrategy, parseKlinesToCandles, type Signal, type StrategyResult } from "./trading-strategy";
import { storage } from "./storage";

export interface AgentConfig {
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
  errors: number;
  timer: ReturnType<typeof setTimeout> | null;
  currentPosition: "LONG" | "SHORT" | "NONE";
}

const agentStates = new Map<string, AgentState>();

const DEFAULT_CONFIG: AgentConfig = {
  symbol: "BTCUSDT",
  leverage: 10,
  riskPercent: 1.0,
  intervalMs: 60000,
  klineInterval: "1m",
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
    state = {
      config: { ...DEFAULT_CONFIG },
      running: false,
      lastSignal: "HOLD",
      lastCheck: 0,
      tradeCount: 0,
      errors: 0,
      timer: null,
      currentPosition: "NONE",
    };
    agentStates.set(chatId, state);
  }
  Object.assign(state.config, partial);
  return state.config;
}

export async function startAgent(
  chatId: string,
  getClient: () => any,
  sendMessage: (msg: string) => Promise<void>,
): Promise<boolean> {
  let state = agentStates.get(chatId);
  if (!state) {
    state = {
      config: { ...DEFAULT_CONFIG },
      running: false,
      lastSignal: "HOLD",
      lastCheck: 0,
      tradeCount: 0,
      errors: 0,
      timer: null,
      currentPosition: "NONE",
    };
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

    const klines = await futuresClient.klines(state.config.symbol, state.config.klineInterval, 50);
    const candles = parseKlinesToCandles(klines);

    if (candles.length < 22) {
      console.log(`[Agent:${chatId}] Not enough candles: ${candles.length}`);
      scheduleNext(chatId, getClient, sendMessage);
      return;
    }

    const result: StrategyResult = emaCrossRsiStrategy(candles);
    state.lastSignal = result.signal;
    state.lastCheck = Date.now();

    console.log(`[Agent:${chatId}] ${state.config.symbol} signal=${result.signal} reason=${result.reason} pos=${state.currentPosition}`);

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
  const price = parseFloat(ticker?.price || "0");
  if (price === 0) throw new Error("Could not get current price");

  const localPositions = await storage.getAsterLocalPositions(chatId);
  let availableMargin = 10;

  const allTrades = await storage.getAsterLocalTrades(chatId);
  const deposits = allTrades.filter((t: any) => t.type === "DEPOSIT");
  const totalDeposited = deposits.reduce((sum: number, t: any) => sum + (t.price || 0), 0);
  if (totalDeposited > 0) availableMargin = totalDeposited;

  const riskAmount = availableMargin * (state.config.riskPercent / 100);
  const notional = riskAmount * state.config.leverage;
  let qty = notional / price;

  const symbolInfo = state.config.symbol;
  if (symbolInfo.includes("BTC")) {
    qty = Math.floor(qty * 1000) / 1000;
  } else if (symbolInfo.includes("ETH")) {
    qty = Math.floor(qty * 100) / 100;
  } else {
    qty = Math.floor(qty * 10) / 10;
  }

  if (qty <= 0) {
    console.log(`[Agent:${chatId}] Qty too small: ${qty}`);
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
    `${icon} *Auto Trade: ${sideLabel} ${state.config.symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📦 Qty: \`${filledQty || qty}\`\n` +
    `💲 Price: \`$${(avgPrice || price).toFixed(2)}\`\n` +
    `⚡ Leverage: *${state.config.leverage}x*\n` +
    `📊 Strategy: ${result.reason}\n\n` +
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

  await storage.saveAsterLocalTrade({
    chatId,
    orderId: String(closeResult.orderId),
    symbol: state.config.symbol,
    side: closeSide,
    type: "MARKET",
    quantity: pos.quantity,
    executedQty: parseFloat(closeResult.executedQty || String(pos.quantity)),
    price: parseFloat(closeResult.price || "0"),
    avgPrice: parseFloat(closeResult.avgPrice || closeResult.price || "0"),
    status: closeResult.status || "FILLED",
    reduceOnly: true,
    leverage: state.config.leverage,
  });

  state.currentPosition = "NONE";

  const ticker = await futuresClient.tickerPrice(state.config.symbol);
  const markPrice = parseFloat(ticker?.price || "0");
  let pnl = 0;
  if (markPrice > 0) {
    pnl = pos.side === "LONG"
      ? (markPrice - pos.entryPrice) * pos.quantity
      : (pos.entryPrice - markPrice) * pos.quantity;
  }

  await sendMessage(
    `📤 *Auto Close: ${pos.side} ${state.config.symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📦 Qty: \`${pos.quantity}\`\n` +
    `💲 Entry: \`$${pos.entryPrice.toFixed(2)}\`\n` +
    `${pnl >= 0 ? "📈" : "📉"} PnL: \`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT\`\n\n` +
    `📋 Order ID: \`${closeResult.orderId}\``
  );
}

export function getAgentStatus(chatId: string): string {
  const state = agentStates.get(chatId);
  if (!state) return "Not configured";

  const status = state.running ? "🟢 RUNNING" : "🔴 STOPPED";
  const lastCheck = state.lastCheck > 0
    ? new Date(state.lastCheck).toISOString().substring(11, 19) + " UTC"
    : "Never";

  return (
    `*Agent Status*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Status: ${status}\n` +
    `Symbol: \`${state.config.symbol}\`\n` +
    `Leverage: *${state.config.leverage}x*\n` +
    `Risk: \`${state.config.riskPercent}%\` per trade\n` +
    `Interval: \`${state.config.intervalMs / 1000}s\`\n` +
    `Timeframe: \`${state.config.klineInterval}\`\n` +
    `Last Signal: \`${state.lastSignal}\`\n` +
    `Position: \`${state.currentPosition}\`\n` +
    `Trades: \`${state.tradeCount}\`\n` +
    `Errors: \`${state.errors}\`\n` +
    `Last Check: ${lastCheck}`
  );
}

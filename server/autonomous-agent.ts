import { emaCrossRsiStrategy, parseKlinesToCandles, type Signal, type StrategyResult } from "./trading-strategy";
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
  symbol?: string;
}

interface PairScan {
  symbol: string;
  result: StrategyResult;
}

interface AgentState {
  config: AgentConfig;
  running: boolean;
  lastCheck: number;
  tradeCount: number;
  scanCount: number;
  errors: number;
  timer: ReturnType<typeof setTimeout> | null;
  openPositions: Map<string, "LONG" | "SHORT">;
  lastScans: PairScan[];
  lastAction: string;
  lastReason: string;
}

const agentStates = new Map<string, AgentState>();

const envRisk = parseFloat(process.env.AGENT_RISK_PERCENT || "1.0");
const DEFAULT_CONFIG: AgentConfig = {
  name: "My Agent",
  maxLeverage: 10,
  riskPercent: Math.max(0.5, Math.min(2.0, isNaN(envRisk) ? 1.0 : envRisk)),
  intervalMs: 60000,
  klineInterval: "5m",
  enabled: false,
  maxOpenPositions: 3,
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

  if (state.running) return false;
  state.running = true;
  state.config.enabled = true;
  state.errors = 0;

  state.openPositions.clear();
  const localPositions = await storage.getAsterLocalPositions(chatId);
  for (const p of localPositions) {
    if (p.quantity > 0) {
      state.openPositions.set(p.symbol, p.side === "LONG" ? "LONG" : "SHORT");
    }
  }

  try {
    const posCount = state.openPositions.size;
    const posList = posCount > 0
      ? Array.from(state.openPositions.entries()).map(([s, side]) => `${side} ${s}`).join(", ")
      : "None";
    await sendMessage(
      `🤖 *${state.config.name} Started — Full Auto*\n` +
      `Scanning: *${ALL_PAIRS.length} pairs*\n` +
      `Max Leverage: ${state.config.maxLeverage}x\n` +
      `Risk: ${state.config.riskPercent}%\n` +
      `Max Positions: ${state.config.maxOpenPositions}\n` +
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
          ? Array.from(state.openPositions.entries()).map(([s, side]) => `${side === "LONG" ? "🟢" : "🔴"} ${side} ${s}`).join("\n")
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
        state.openPositions.set(p.symbol, p.side === "LONG" ? "LONG" : "SHORT");
      }
    }

    for (const [symbol, side] of state.openPositions.entries()) {
      const scan = scans.find(s => s.symbol === symbol);
      if (!scan) continue;

      if (side === "LONG" && scan.result.signal === "SELL") {
        await closePosition(chatId, futuresClient, state, symbol, sendMessage);
      } else if (side === "SHORT" && scan.result.signal === "BUY") {
        await closePosition(chatId, futuresClient, state, symbol, sendMessage);
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

      candidates.sort((a, b) => b.result.strength - a.result.strength);

      for (let i = 0; i < Math.min(slotsAvailable, candidates.length); i++) {
        const c = candidates[i];
        await openPosition(chatId, futuresClient, state, c.symbol, c.side, c.result, sendMessage);
      }
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
  state.openPositions.set(symbol, positionSide);
  state.tradeCount++;
  state.lastAction = `${positionSide} ${symbol}`;
  state.lastReason = result.reason;

  const icon = side === "BUY" ? "🟢" : "🔴";
  await sendMessage(
    `🚀 *Auto Trade — ${symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${icon} ${positionSide} *${symbol}*\n` +
    `📦 Qty: \`${filledQty || qty}\`\n` +
    `💲 Price: \`$${(avgPrice || lastPrice).toFixed(2)}\`\n` +
    `⚡ Leverage: *${leverage}x* (auto)\n` +
    `💪 Signal Strength: *${result.strength}*\n` +
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

  state.openPositions.delete(symbol);

  let pnl = 0;
  if (closePrice > 0) {
    pnl = pos.side === "LONG"
      ? (closePrice - pos.entryPrice) * filledQty
      : (pos.entryPrice - closePrice) * filledQty;
  }

  state.lastAction = `Closed ${pos.side} ${symbol}`;
  state.lastReason = `PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`;

  const pnlIcon = pnl >= 0 ? "✅" : "❌";
  await sendMessage(
    `📤 *Position Closed — ${symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${pos.side === "LONG" ? "🟢" : "🔴"} ${pos.side} *${symbol}*\n` +
    `📦 Qty: \`${filledQty}\`\n` +
    `💲 Entry: \`$${pos.entryPrice.toFixed(2)}\` → Exit: \`$${closePrice.toFixed(2)}\`\n` +
    `${pnlIcon} Realized PnL: \`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT\`\n\n` +
    `📍 Open: ${state.openPositions.size}/${state.config.maxOpenPositions}`
  );
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
    for (const [sym, side] of state.openPositions) {
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
  msg += `_Strategy: EMA(8/21) + RSI(14) multi-pair scanner_`;

  return msg;
}

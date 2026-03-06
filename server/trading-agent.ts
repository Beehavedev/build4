import { ethers } from "ethers";
import { storage } from "./storage";
import { log } from "./index";
import {
  fourMemeGetTokenInfo,
  fourMemeBuyToken,
  fourMemeSellToken,
  fourMemeGetTokenBalance,
  type FourMemeTokenInfo,
} from "./token-launcher";

const FOUR_MEME_API = "https://four.meme";

const SCAN_INTERVAL_MS = 60_000;
const POSITION_CHECK_INTERVAL_MS = 30_000;
const MAX_POSITIONS_PER_USER = 5;
const DEFAULT_BUY_AMOUNT_BNB = "0.1";
const DEFAULT_TAKE_PROFIT = 2.0;
const DEFAULT_STOP_LOSS = 0.7;
const DEFAULT_SLIPPAGE = 15;
const MIN_PROGRESS_FOR_ENTRY = 5;
const MAX_PROGRESS_FOR_ENTRY = 60;
const MIN_WALLET_BALANCE_BNB = 0.15;
const MAX_TOKEN_AGE_SECONDS = 3600;

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
}

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
let running = false;

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
  return updated;
}

export function getUserTradingStatus(chatId: number): { config: TradingConfig; positions: TradingPosition[]; history: TradingPosition[] } {
  const config = getUserConfig(chatId);
  const positions = Array.from(activePositions.values()).filter(p => p.chatId === chatId && p.status === "open");
  const history = tradeHistory.filter(p => p.chatId === chatId).slice(-20);
  return { config, positions, history };
}

async function fetchNewTokens(): Promise<Array<{ address: string; name: string; symbol: string; launchTime: number }>> {
  try {
    const res = await fetch(`${FOUR_MEME_API}/meme-api/v1/public/token/list?pageNum=1&pageSize=20&orderBy=launchTime&direction=desc`, {
      headers: { "Accept": "application/json", "User-Agent": "BUILD4/1.0" },
    });
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
}

async function evaluateToken(token: { address: string; name: string; symbol: string; launchTime: number }): Promise<TokenSignal | null> {
  try {
    const info = await fourMemeGetTokenInfo(token.address);
    const score = 0;
    const reasons: string[] = [];

    if (info.liquidityAdded) return null;

    const progress = info.progressPercent;
    if (progress < MIN_PROGRESS_FOR_ENTRY) return null;
    if (progress > MAX_PROGRESS_FOR_ENTRY) return null;

    let tokenScore = 0;

    if (progress >= 10 && progress <= 30) {
      tokenScore += 40;
      reasons.push(`Sweet spot curve: ${progress.toFixed(1)}%`);
    } else if (progress > 30 && progress <= 50) {
      tokenScore += 25;
      reasons.push(`Filling curve: ${progress.toFixed(1)}%`);
    } else {
      tokenScore += 10;
      reasons.push(`Early curve: ${progress.toFixed(1)}%`);
    }

    const age = Math.floor(Date.now() / 1000) - (token.launchTime || info.launchTime);
    if (age > 0 && age < MAX_TOKEN_AGE_SECONDS) {
      if (age < 600) {
        tokenScore += 30;
        reasons.push(`Very fresh: ${Math.floor(age / 60)}m old`);
      } else if (age < 1800) {
        tokenScore += 20;
        reasons.push(`Fresh: ${Math.floor(age / 60)}m old`);
      } else {
        tokenScore += 10;
        reasons.push(`Recent: ${Math.floor(age / 60)}m old`);
      }
    } else if (age > MAX_TOKEN_AGE_SECONDS) {
      return null;
    }

    const fundsNum = parseFloat(info.funds);
    if (fundsNum >= 1.0) {
      tokenScore += 20;
      reasons.push(`Good volume: ${fundsNum.toFixed(2)} BNB raised`);
    } else if (fundsNum >= 0.3) {
      tokenScore += 10;
      reasons.push(`Some volume: ${fundsNum.toFixed(2)} BNB raised`);
    }

    if (progress > 0 && age > 0) {
      const velocityPerMin = progress / (age / 60);
      if (velocityPerMin > 1.0) {
        tokenScore += 20;
        reasons.push(`High velocity: ${velocityPerMin.toFixed(1)}%/min`);
      } else if (velocityPerMin > 0.3) {
        tokenScore += 10;
        reasons.push(`Good velocity: ${velocityPerMin.toFixed(1)}%/min`);
      }
    }

    if (tokenScore < 40) return null;

    return { address: token.address, name: token.name, symbol: token.symbol, score: tokenScore, reasons, info };
  } catch (e: any) {
    return null;
  }
}

async function executeBuy(chatId: number, agentId: string, signal: TokenSignal, privateKey: string, walletAddress: string): Promise<TradingPosition | null> {
  const config = getUserConfig(chatId);
  const positionId = `trade_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  try {
    log(`[TradingAgent] Buying ${signal.symbol} for ${config.buyAmountBnb} BNB (score: ${signal.score})`, "trading");

    const result = await fourMemeBuyToken(signal.address, config.buyAmountBnb, DEFAULT_SLIPPAGE, privateKey);

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
      entryPriceBnb: config.buyAmountBnb,
      tokenAmount: tokenBalance,
      buyTxHash: result.txHash || "",
      entryTime: Date.now(),
      takeProfitMultiple: config.takeProfitMultiple,
      stopLossMultiple: config.stopLossMultiple,
      status: "open",
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

      if (info.liquidityAdded) {
        log(`[TradingAgent] ${position.tokenSymbol} hit DEX — selling at ${multiple.toFixed(2)}x`, "trading");
        await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb);
        continue;
      }

      if (multiple >= position.takeProfitMultiple) {
        log(`[TradingAgent] ${position.tokenSymbol} hit take-profit at ${multiple.toFixed(2)}x`, "trading");
        await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb);
        continue;
      }

      if (multiple <= position.stopLossMultiple) {
        log(`[TradingAgent] ${position.tokenSymbol} hit stop-loss at ${multiple.toFixed(2)}x`, "trading");
        await closePosition(position, "closed_loss", notifyFn, multiple, currentValueBnb);
        continue;
      }

      const ageMinutes = (Date.now() - position.entryTime) / 60000;
      if (ageMinutes > 120 && multiple < 1.1) {
        log(`[TradingAgent] ${position.tokenSymbol} stale (${ageMinutes.toFixed(0)}m, ${multiple.toFixed(2)}x) — closing`, "trading");
        await closePosition(position, multiple >= 1 ? "closed_profit" : "closed_loss", notifyFn, multiple, currentValueBnb);
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
    tradeHistory.push(position);

    const emoji = reason === "closed_profit" ? "💰" : "📉";
    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4);
    const holdTime = Math.floor((Date.now() - position.entryTime) / 60000);

    let msg = `${emoji} TRADE CLOSED: $${position.tokenSymbol}\n\n`;
    msg += `Entry: ${position.entryPriceBnb} BNB\n`;
    msg += `Exit: ~${currentValueBnb.toFixed(4)} BNB\n`;
    msg += `PnL: ${pnlStr} BNB (${multiple.toFixed(2)}x)\n`;
    msg += `Hold: ${holdTime}m\n`;
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
  const enabledUsers: Array<{ chatId: number; agentId: string; privateKey: string }> = [];

  for (const [chatId, config] of userTradingConfig.entries()) {
    if (!config.enabled) continue;

    const openCount = Array.from(activePositions.values()).filter(p => p.chatId === chatId && p.status === "open").length;
    if (openCount >= config.maxPositions) continue;

    try {
      const chatIdStr = chatId.toString();
      const wallets = await storage.getTelegramWalletLinks(chatIdStr);
      if (wallets.length === 0) continue;

      const activeWallet = wallets.find(w => w.isActive) || wallets[0];
      const pk = await storage.getTelegramWalletPrivateKey(chatIdStr, activeWallet.walletAddress);
      if (!pk) continue;

      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const balance = await provider.getBalance(activeWallet.walletAddress);
      const balBnb = parseFloat(ethers.formatEther(balance));
      if (balBnb < MIN_WALLET_BALANCE_BNB) continue;

      const agents = await storage.getAgentsByOwner(chatIdStr);
      const agentId = agents.length > 0 ? agents[0].id : "auto-trader";

      enabledUsers.push({ chatId, agentId, privateKey: pk, walletAddress: activeWallet.walletAddress });
    } catch {}
  }

  if (enabledUsers.length === 0) return;

  const tokens = await fetchNewTokens();
  if (tokens.length === 0) return;

  const newTokens = tokens.filter(t => !recentlyScannedTokens.has(t.address));
  for (const t of tokens) recentlyScannedTokens.add(t.address);

  if (recentlyScannedTokens.size > 500) {
    const arr = Array.from(recentlyScannedTokens);
    for (let i = 0; i < arr.length - 200; i++) recentlyScannedTokens.delete(arr[i]);
  }

  const signals: TokenSignal[] = [];
  for (const token of newTokens.slice(0, 10)) {
    const signal = await evaluateToken(token);
    if (signal) signals.push(signal);
  }

  if (signals.length === 0) return;

  signals.sort((a, b) => b.score - a.score);
  const bestSignal = signals[0];

  log(`[TradingAgent] Best signal: ${bestSignal.symbol} (score: ${bestSignal.score}) — ${bestSignal.reasons.join(", ")}`, "trading");

  for (const user of enabledUsers) {
    const openCount = Array.from(activePositions.values()).filter(p => p.chatId === user.chatId && p.status === "open").length;
    const config = getUserConfig(user.chatId);
    if (openCount >= config.maxPositions) continue;

    const alreadyHolding = Array.from(activePositions.values()).some(
      p => p.chatId === user.chatId && p.tokenAddress === bestSignal.address && p.status === "open"
    );
    if (alreadyHolding) continue;

    const position = await executeBuy(user.chatId, user.agentId, bestSignal, user.privateKey, user.walletAddress);
    if (position) {
      let msg = `🤖 AGENT TRADE: Bought $${bestSignal.symbol}\n\n`;
      msg += `Amount: ${config.buyAmountBnb} BNB\n`;
      msg += `Score: ${bestSignal.score}/100\n`;
      msg += `Reasons:\n`;
      bestSignal.reasons.forEach(r => msg += `  • ${r}\n`);
      msg += `\nTake Profit: ${config.takeProfitMultiple}x | Stop Loss: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
      if (position.buyTxHash) msg += `TX: https://bscscan.com/tx/${position.buyTxHash}`;

      notifyFn(user.chatId, msg);
    }
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
}

export function stopTradingAgent(): void {
  if (scanTimer) clearInterval(scanTimer);
  if (positionTimer) clearInterval(positionTimer);
  scanTimer = null;
  positionTimer = null;
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

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

async function aiEvaluateBuy(tokens: Array<{ address: string; name: string; symbol: string; launchTime: number; info: FourMemeTokenInfo }>): Promise<TokenSignal | null> {
  if (tokens.length === 0) return null;

  const tokenDataLines = tokens.map((t, i) => {
    const age = Math.floor(Date.now() / 1000) - (t.launchTime || t.info.launchTime);
    const ageMin = Math.floor(age / 60);
    const velocity = age > 0 ? (t.info.progressPercent / (age / 60)).toFixed(2) : "0";
    return `${i + 1}. $${t.symbol} (${t.name}) — Curve: ${t.info.progressPercent.toFixed(1)}%, Age: ${ageMin}m, Raised: ${parseFloat(t.info.funds).toFixed(3)} BNB / ${parseFloat(t.info.maxFunds).toFixed(1)} BNB, Velocity: ${velocity}%/min, Price: ${t.info.lastPrice}`;
  }).join("\n");

  const memoryCtx = buildTradeMemoryContext();

  const prompt = `You are an expert meme token trader on Four.meme (BNB Chain bonding curve platform). Analyze these new tokens and decide which ONE to buy, or NONE if none look good.

TOKENS:
${tokenDataLines}

YOUR TRADE MEMORY:
${memoryCtx}

KEY METRICS TO CONSIDER:
- Curve progress: 10-30% is early momentum (best entry), 30-50% is mid (riskier), >50% is late
- Age: Under 10 min = very fresh (higher risk/reward), 10-30 min = ideal, >30 min with low progress = dying
- Velocity (%/min): >1.0 = parabolic, 0.3-1.0 = healthy, <0.3 = sluggish
- Funds raised: More BNB = more real buyers
- Token name/symbol: Memes with trending themes or clever names attract more buyers

THINK THROUGH:
1. Which token has the best momentum signals?
2. Is the risk/reward favorable given current data?
3. Have similar tokens worked or failed in your trade history?
4. Would a skilled degen trader buy this?

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

    if (tokenScore >= 40 && (!best || tokenScore > best.score)) {
      best = { address: token.address, name: token.name, symbol: token.symbol, score: tokenScore, reasons, info };
    }
  }

  return best;
}

async function aiEvaluateSell(position: TradingPosition, info: FourMemeTokenInfo, multiple: number, ageMinutes: number): Promise<{ decision: "HOLD" | "SELL"; reasoning: string }> {
  const memoryCtx = buildTradeMemoryContext();
  const velocity = info.progressPercent > 0 && ageMinutes > 0 ? (info.progressPercent / ageMinutes).toFixed(2) : "unknown";
  const fundsRaised = parseFloat(info.funds).toFixed(3);
  const maxFunds = parseFloat(info.maxFunds).toFixed(1);
  const pnlPct = ((multiple - 1) * 100).toFixed(1);

  const prompt = `You are managing an open meme token position. Decide whether to HOLD or SELL.

POSITION:
- Token: $${position.tokenSymbol}
- Entry: ${position.entryPriceBnb} BNB
- Current multiple: ${multiple.toFixed(3)}x (${pnlPct}% PnL)
- Hold time: ${ageMinutes.toFixed(0)} minutes
- Tokens held: ${parseFloat(position.tokenAmount).toFixed(2)}

CURRENT TOKEN STATE:
- Curve progress: ${info.progressPercent.toFixed(1)}% (of ${maxFunds} BNB)
- Current velocity: ${velocity}%/min
- Funds raised: ${fundsRaised} BNB
- Liquidity added (graduated to DEX): ${info.liquidityAdded}
- Take-profit target: ${position.takeProfitMultiple}x
- Stop-loss target: ${((1 - position.stopLossMultiple) * 100).toFixed(0)}% loss

YOUR TRADE MEMORY:
${memoryCtx}

THINK THROUGH:
1. Is momentum accelerating, stable, or fading?
2. Is the curve filling fast enough to expect more upside?
3. Are we near TP/SL targets? Should we let it ride or lock in profits?
4. If graduated to DEX — should we sell immediately or hold for DEX pump?
5. Would a skilled trader hold or take profits here?

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

      const ageMinutes = (Date.now() - position.entryTime) / 60000;

      if (info.liquidityAdded) {
        log(`[TradingAgent] ${position.tokenSymbol} graduated to DEX — selling at ${multiple.toFixed(2)}x`, "trading");
        await closePosition(position, "closed_profit", notifyFn, multiple, currentValueBnb, "Token graduated to DEX — auto-sell");
        continue;
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

      const aiSell = await aiEvaluateSell(position, info, multiple, ageMinutes);
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
    msg += `Hold: ${holdTime}m\n`;
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

  if (candidatesWithInfo.length === 0) return;

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

    const position = await executeBuy(user.chatId, user.agentId, bestSignal, user.privateKey, user.walletAddress);
    if (position) {
      let msg = `🤖 AI TRADE: Bought $${bestSignal.symbol}\n\n`;
      msg += `Amount: ${config.buyAmountBnb} BNB\n`;
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

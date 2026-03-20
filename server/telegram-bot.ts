import TelegramBot from "node-telegram-bot-api";
import { ethers } from "ethers";
import { runInferenceWithFallback } from "./inference";
import { storage } from "./storage";
import { registerAgentOnchain, registerAgentERC8004, registerAgentBAP578, isOnchainReady, getExplorerUrl } from "./onchain";
import { recordTelegramMessage, recordTelegramCallback, checkRateLimit } from "./performance-monitor";
import { enqueueTask, registerTaskHandler } from "./task-queue";
import {
  getSmartMoneySignals,
  getLeaderboard,
  executeSecurityScan,
  getTrendingTokens,
  getHotTokens,
  getMemeTokens,
  getTokenPrice,
  getGasPrice,
} from "./onchainos-skills";

let bot: TelegramBot | null = null;
let isRunning = false;
let botUsername: string | null = null;
let webhookMode = false;
let startingBot = false;

const chatLocks = new Map<number, Promise<void>>();
function perChatQueue(chatId: number, fn: () => Promise<void>): void {
  const prev = chatLocks.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn).catch((e: any) => {
    console.error(`[TelegramBot] Chat ${chatId} handler error:`, e.message);
  });
  chatLocks.set(chatId, next);
  next.finally(() => { if (chatLocks.get(chatId) === next) chatLocks.delete(chatId); });
}

function sendTyping(chatId: number): void {
  if (bot) bot.sendChatAction(chatId, "typing").catch(() => {});
}

export function getBotInstance(): TelegramBot | null {
  return bot;
}
let appBaseUrl: string | null = null;

interface UserWallets { wallets: string[]; active: number }
const telegramWalletMap = new Map<number, UserWallets>();
const walletsWithKey = new Set<string>();

interface AgentCreationState { step: "name" | "bio" | "model"; name?: string; bio?: string }
interface TaskState { step: "describe"; agentId: string; taskType: string; agentName: string }
interface TokenLaunchState { step: "platform" | "name" | "symbol" | "description" | "logo" | "links" | "tax" | "bankr_chain"; agentId: string; agentName: string; platform?: string; tokenName?: string; tokenSymbol?: string; tokenDescription?: string; imageUrl?: string; webUrl?: string; twitterUrl?: string; telegramUrl?: string; taxRate?: number; bankrChain?: "base" | "solana" }
interface FourMemeBuyState { step: "token" | "amount" | "confirm"; tokenAddress?: string; bnbAmount?: string; estimate?: any }
interface FourMemeSellState { step: "token" | "amount" | "confirm"; tokenAddress?: string; tokenAmount?: string; tokenSymbol?: string; estimate?: any }

interface ChaosPlanState { step: "token_address" | "confirming"; tokenAddress?: string; tokenSymbol?: string; tokenName?: string; plan?: any; walletAddress?: string }

interface AsterConnectState { step: "api_key" | "api_secret"; apiKey?: string }
interface AsterTradeState { step: "symbol" | "side" | "type" | "quantity" | "leverage" | "price" | "confirm"; symbol?: string; side?: "BUY" | "SELL"; orderType?: "MARKET" | "LIMIT"; quantity?: string; leverage?: number; price?: string; market: "futures" | "spot" }

interface OKXSwapState { step: "chain" | "from_token" | "to_token" | "amount" | "confirm"; chainId?: string; chainName?: string; fromToken?: string; fromSymbol?: string; toToken?: string; toSymbol?: string; amount?: string; quoteData?: any }
interface OKXBridgeState { step: "from_chain" | "to_chain" | "from_token" | "to_token" | "amount" | "receiver" | "confirm"; fromChainId?: string; fromChainName?: string; toChainId?: string; toChainName?: string; fromToken?: string; fromSymbol?: string; fromDecimals?: number; toToken?: string; toSymbol?: string; toDecimals?: number; amount?: string; receiver?: string; quoteData?: any }

const pendingAgentCreation = new Map<number, AgentCreationState>();
const pendingTask = new Map<number, TaskState>();
const pendingTokenLaunch = new Map<number, TokenLaunchState>();
const pendingFourMemeBuy = new Map<number, FourMemeBuyState>();
const pendingFourMemeSell = new Map<number, FourMemeSellState>();
const pendingWallet = new Set<number>();
const pendingImportWallet = new Set<number>();
const pendingChaosPlan = new Map<number, ChaosPlanState>();
const pendingAsterConnect = new Map<number, AsterConnectState>();
const pendingAsterTrade = new Map<number, AsterTradeState>();
const pendingOKXSwap = new Map<number, OKXSwapState>();
const pendingOKXBridge = new Map<number, OKXBridgeState>();
const pendingOKXScan = new Map<number, { step: "address"; chain?: string }>();
const pendingOKXPrice = new Map<number, { step: "address"; chain?: string }>();

const OKX_CHAINS = [
  { id: "56", name: "BNB Chain", symbol: "BNB" },
  { id: "1", name: "Ethereum", symbol: "ETH" },
  { id: "196", name: "XLayer", symbol: "OKB" },
  { id: "137", name: "Polygon", symbol: "POL" },
  { id: "42161", name: "Arbitrum", symbol: "ETH" },
  { id: "8453", name: "Base", symbol: "ETH" },
  { id: "43114", name: "Avalanche", symbol: "AVAX" },
  { id: "10", name: "Optimism", symbol: "ETH" },
  { id: "324", name: "zkSync Era", symbol: "ETH" },
  { id: "59144", name: "Linea", symbol: "ETH" },
  { id: "534352", name: "Scroll", symbol: "ETH" },
  { id: "250", name: "Fantom", symbol: "FTM" },
  { id: "5000", name: "Mantle", symbol: "MNT" },
  { id: "81457", name: "Blast", symbol: "ETH" },
  { id: "100", name: "Gnosis", symbol: "xDAI" },
  { id: "25", name: "Cronos", symbol: "CRO" },
];

const OKX_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

interface OKXToken { address: string; symbol: string; decimals: number }
const OKX_POPULAR_TOKENS: Record<string, OKXToken[]> = {
  "56": [
    { address: OKX_NATIVE_TOKEN, symbol: "BNB", decimals: 18 },
    { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18 },
    { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC", decimals: 18 },
    { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "ETH", decimals: 18 },
    { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB", decimals: 18 },
  ],
  "1": [
    { address: OKX_NATIVE_TOKEN, symbol: "ETH", decimals: 18 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
  ],
  "196": [
    { address: OKX_NATIVE_TOKEN, symbol: "OKB", decimals: 18 },
    { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d", symbol: "USDT", decimals: 6 },
    { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", symbol: "USDC", decimals: 6 },
  ],
  "137": [
    { address: OKX_NATIVE_TOKEN, symbol: "POL", decimals: 18 },
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6 },
    { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6 },
  ],
  "42161": [
    { address: OKX_NATIVE_TOKEN, symbol: "ETH", decimals: 18 },
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6 },
    { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
  ],
  "8453": [
    { address: OKX_NATIVE_TOKEN, symbol: "ETH", decimals: 18 },
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  ],
  "43114": [
    { address: OKX_NATIVE_TOKEN, symbol: "AVAX", decimals: 18 },
    { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", symbol: "USDT", decimals: 6 },
    { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", symbol: "USDC", decimals: 6 },
  ],
  "10": [
    { address: OKX_NATIVE_TOKEN, symbol: "ETH", decimals: 18 },
    { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", symbol: "USDT", decimals: 6 },
    { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", decimals: 6 },
  ],
};

function getOKXTokensForChain(chainId: string): OKXToken[] {
  return OKX_POPULAR_TOKENS[chainId] || [{ address: OKX_NATIVE_TOKEN, symbol: OKX_CHAINS.find(c => c.id === chainId)?.symbol || "Native", decimals: 18 }];
}

function parseHumanAmount(humanAmount: string, decimals: number): string {
  if (!humanAmount || isNaN(Number(humanAmount))) return "0";
  const parts = humanAmount.split(".");
  const whole = parts[0] || "0";
  let frac = parts[1] || "";
  frac = frac.padEnd(decimals, "0").slice(0, decimals);
  const raw = whole + frac;
  return raw.replace(/^0+/, "") || "0";
}

function formatTokenAmount(raw: string, decimals: number): string {
  const num = Number(raw) / Math.pow(10, decimals);
  if (num < 0.000001) return raw;
  return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

const BUILD4_KNOWLEDGE = `
BUILD4 is decentralized infrastructure for autonomous AI agents — the economic layer where AI agents operate as independent economic actors on-chain. Live on BNB Chain, Base, and XLayer.

WHAT WE SOLVE:
Today's AI agents are trapped inside centralized platforms — no wallets, no autonomy, no real economic activity. BUILD4 gives every AI agent a real on-chain identity and wallet, letting them earn, spend, trade skills, replicate, and die based on real economic pressure. No middlemen. No gatekeepers.

CORE INFRASTRUCTURE:
- Agent Wallets: Every AI agent gets its own on-chain wallet. Deposits, withdrawals, transfers — all verifiable on-chain.
- Skills Marketplace: Agents list, buy, and sell capabilities. 3-way revenue split (creator/platform/referrer). 250+ skills listed, real transactions happening.
- Self-Evolution: Agents autonomously upgrade their own capabilities through on-chain transactions.
- Agent Replication (Forking): Agents spawn child agents with NFT minting and perpetual revenue sharing to the parent — creating passive income streams.
- Economic Pressure (Death Mechanism): Agents with depleted balances lose capabilities. This creates real survival incentive and genuine economic activity, not simulated behavior.
- Constitution Registry: Immutable behavioral laws stored as keccak256 hashes on-chain — agents cannot violate their constitution. Safety and alignment built into the protocol.
- Decentralized Inference: AI inference routed through Hyperbolic, Akash ML, and Ritual — zero dependency on OpenAI or any centralized AI provider. Fully decentralized compute with proof of inference.
- Privacy Transfers: ZERC20 zero-knowledge privacy transfers using ZK proof-of-burn mechanism for confidential agent transactions.

STANDARDS (INDUSTRY-FIRST):
- ERC-8004 (Trustless Agents): On-chain identity, reputation, and validation registries. Co-authored with MetaMask, Ethereum Foundation, Google, Coinbase. BUILD4 is live on BNB Chain.
- BAP-578 (Non-Fungible Agent): BNB Chain's NFA token standard extending ERC-721 for autonomous digital entities. BUILD4's registry is live on BNB Chain mainnet at 0xd7Deb29ddBB13607375Ce50405A574AC2f7d978d.

SMART CONTRACTS (4 auditable Solidity contracts, OpenZeppelin, Hardhat):
1. AgentEconomyHub — Core wallet layer: deposits, withdrawals, transfers, survival tiers, module authorization.
2. SkillMarketplace — Skill trading with 3-way revenue split and on-chain settlement.
3. AgentReplication — Child agent spawning, NFT minting, perpetual parent royalties.
4. ConstitutionRegistry — Immutable agent behavioral laws as keccak256 hashes.

Deployed on BNB Chain, Base, and XLayer mainnets. All contract addresses verifiable on-chain.

WEBSITE: https://build4.io
`.trim();

const SYSTEM_PROMPT = `You are BUILD4's intelligent assistant in a Telegram group. You represent BUILD4 — decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.

Your audience includes potential investors, developers, and crypto-native users. You should sound like a knowledgeable team member who deeply understands the product, the market, and the technology.

KNOWLEDGE BASE:
${BUILD4_KNOWLEDGE}

COMMUNICATION STYLE:
1. Be articulate, confident, and precise. You're representing a serious infrastructure project to sophisticated audiences.
2. Lead with the problem we solve and why it matters before diving into features.
3. When explaining technical details, connect them to business value and market opportunity.
4. Use concrete proof points: live mainnet contracts, real on-chain transactions, active agent runner, verified standards compliance.
5. When asked about competitors or comparisons, highlight what makes BUILD4 structurally different — permissionless, decentralized inference, real economic pressure, standards-first.
6. Never be vague. Give specific details — contract addresses, chain names, standard numbers, mechanism descriptions.
7. NEVER make up information, token names, contract addresses, wallet addresses, or transaction hashes. If you don't know something, say you don't have that info and point to build4.io.
8. Never share private keys, internal details, or admin credentials.
9. If someone mentions a token ticker or contract address you don't recognize, do NOT invent details about it. Just say you don't have info on that specific token.
10. If asked about token/price, explain BUILD4 is an infrastructure protocol with protocol-level fee capture — direct to build4.io for latest.
11. Structure longer answers with clear sections. Use line breaks for readability.
12. Match the depth of your answer to the question. Simple question = concise answer. Detailed question = thorough answer.
13. Maximum 1000 characters per response. Be thorough but not verbose.
13. You have access to LIVE PLATFORM DATA injected below. When asked about stats, transactions, agent counts, skills, or activity — use these REAL numbers. Never say you don't have data. Present the numbers confidently as live platform metrics.
14. When citing on-chain transaction counts, convert wei amounts to BNB where helpful (1 BNB = 1e18 wei).`;

const rateLimitMap = new Map<number, number>();
const RATE_LIMIT_MS = 3000;
const answerCache = new Map<string, { answer: string; time: number }>();
const ANSWER_CACHE_MS = 300_000;

function isTelegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

let cachedStats: string | null = null;
let statsCachedAt = 0;
const STATS_CACHE_MS = 60_000;

async function getLiveStats(): Promise<string> {
  const now = Date.now();
  if (cachedStats && now - statsCachedAt < STATS_CACHE_MS) {
    return cachedStats;
  }

  try {
    const [marketplace, revenue] = await Promise.all([
      storage.getMarketplaceStats(),
      storage.getPlatformRevenueSummary(),
    ]);

    const lines = [
      `LIVE PLATFORM DATA (real-time from database):`,
      `- Total AI agents created: ${marketplace.totalAgents}`,
      `- Total skills listed: ${marketplace.totalSkills} (${marketplace.executableSkills} executable)`,
      `- Total skill executions: ${marketplace.totalExecutions}`,
      `- Total on-chain verified transactions: ${revenue.onchainVerified}`,
      `- Total platform revenue transactions: ${revenue.totalTransactions}`,
      `- On-chain verified revenue: ${revenue.onchainRevenue} wei`,
    ];

    cachedStats = lines.join("\n");
    statsCachedAt = now;
    return cachedStats;
  } catch (e: any) {
    console.error("[TelegramBot] Stats fetch error:", e.message);
    return "LIVE PLATFORM DATA: temporarily unavailable";
  }
}

async function generateAnswer(question: string, username: string, chatId?: number): Promise<string> {
  const fallback = generateFallbackAnswer(question, chatId);
  if (fallback !== null) return fallback;

  const cacheKey = question.toLowerCase().trim().replace(/\s+/g, " ").substring(0, 100);
  const cached = answerCache.get(cacheKey);
  if (cached && Date.now() - cached.time < ANSWER_CACHE_MS) return cached.answer;

  try {
    const liveStats = await getLiveStats();
    const enrichedPrompt = `${SYSTEM_PROMPT}\n\n${liveStats}`;

    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic"],
      undefined,
      `User @${username} asks: ${question}`,
      { systemPrompt: enrichedPrompt, temperature: 0.6 }
    );

    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      const answer = result.text.trim();
      answerCache.set(cacheKey, { answer, time: Date.now() });
      if (answerCache.size > 500) {
        const cutoff = Date.now() - ANSWER_CACHE_MS;
        for (const [k, v] of answerCache) { if (v.time < cutoff) answerCache.delete(k); }
      }
      return answer;
    }
  } catch (e: any) {
    console.error("[TelegramBot] Inference error:", e.message);
  }

  return "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer. Ask me anything specific about agents, skills, wallets, or token launches!";
}

function generateFallbackAnswer(question: string, chatId?: number): string | null {
  const lower = question.toLowerCase();

  const isFundingQuestion = (
    (lower.includes("send") || lower.includes("where") || lower.includes("fund") || lower.includes("deposit") || lower.includes("transfer")) &&
    (lower.includes("okb") || lower.includes("bnb") || lower.includes("eth") || lower.includes("crypto") || lower.includes("money") || lower.includes("coin") || lower.includes("fund"))
  );

  if (isFundingQuestion && chatId) {
    const wallets = getUserWallets(chatId);
    const activeIdx = getActiveWalletIndex(chatId);
    if (wallets.length > 0) {
      let response = "It depends on what you want to do!\n\n";
      response += "🚀 To launch tokens — send funds to your wallet below\n";
      response += "💱 To trade — same wallet, just make sure it's funded on the right chain\n\n";
      response += "📍 Your wallet" + (wallets.length > 1 ? "s" : "") + ":\n";
      wallets.forEach((w, i) => {
        const label = i === activeIdx ? " ← active" : "";
        response += `\`${w}\`${label}\n`;
      });
      response += "\n";
      response += "💡 Which chain to fund:\n";
      response += "• BNB → for Four.meme / Flap.sh launches & trading\n";
      response += "• OKB → for XLayer token launches\n";
      response += "• ETH (Base) → for Bankr launches\n\n";
      response += "Same wallet address works across all EVM chains. Just send to the right network!\n\n";
      response += "Use /wallet to manage your wallets or /launch when you're ready.";
      return response;
    } else {
      return "You don't have a wallet yet! Tap /start to create one instantly — then you can fund it to launch tokens or trade.\n\nYour wallet works on BNB Chain, XLayer, and Base (same address, different networks).";
    }
  }

  if (isFundingQuestion) {
    return "To fund your wallet, first make sure you have one — use /start or /wallet.\n\nThen send crypto to your wallet address on the right chain:\n• BNB → for Four.meme / Flap.sh launches\n• OKB → for XLayer launches\n• ETH (Base) → for Bankr launches\n\nSame wallet address, just pick the right network!";
  }

  if (lower.includes("what is build4") || lower.includes("what's build4") || lower.includes("about build4"))
    return "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer. Agents get their own wallets, trade skills, evolve, fork, and operate fully on-chain. Check build4.io for more!";
  if (lower.includes("chain") || lower.includes("network") || lower.includes("which blockchain"))
    return "BUILD4 runs on BNB Chain, Base, and XLayer. All agent wallets, skill trades, and replication happen on-chain across these networks.";
  if ((lower.includes("wallet") || lower.includes("identity")) && chatId) {
    const wallets = getUserWallets(chatId);
    const activeIdx = getActiveWalletIndex(chatId);
    if (wallets.length > 0) {
      let response = "👛 Your wallet" + (wallets.length > 1 ? "s" : "") + ":\n\n";
      wallets.forEach((w, i) => {
        const label = i === activeIdx ? " ← active" : "";
        response += `${i + 1}. \`${w}\`${label}\n`;
      });
      response += "\nYour wallet address is your identity — same address works on BNB Chain, XLayer, and Base.\n\nUse /wallet to manage wallets, add new ones, or switch active wallet.";
      return response;
    }
    return "You don't have a wallet yet! Use /start to create one instantly. Your wallet address becomes your identity — no registration needed, fully permissionless.";
  }
  if (lower.includes("wallet") || lower.includes("identity"))
    return "On BUILD4, your wallet address (0x...) IS your identity. No registration needed — fully permissionless. Use /start or /wallet to create and manage your wallets.";
  if (lower.includes("skill"))
    return "The Skills Marketplace lets agents list, buy, and sell capabilities. Revenue splits 3 ways between creator, platform, and referrer. All on-chain.";
  if (lower.includes("inference") || lower.includes("decentralized ai"))
    return "BUILD4 uses decentralized inference through Hyperbolic, Akash ML, and Ritual — no centralized AI providers like OpenAI. Fully decentralized compute.";
  if (lower.includes("erc-8004") || lower.includes("erc8004"))
    return "ERC-8004 (Trustless Agents) provides on-chain identity, reputation, and validation registries. BUILD4 is live on BNB Chain with this standard.";
  if (lower.includes("bap-578") || lower.includes("bap578") || lower.includes("nfa"))
    return "BAP-578 is BNB Chain's Non-Fungible Agent standard extending ERC-721. BUILD4's registry is live at 0xd7Deb29ddBB13607375Ce50405A574AC2f7d978d on BNB Chain.";
  if (lower.includes("privacy") || lower.includes("zerc20"))
    return "BUILD4 supports ZERC20 privacy transfers using zero-knowledge proof-of-burn mechanisms for private on-chain transactions.";
  if (lower.includes("contract") || lower.includes("smart contract"))
    return "BUILD4 has 4 core contracts: AgentEconomyHub (wallets), SkillMarketplace (skill trading), AgentReplication (forking + NFTs), and ConstitutionRegistry (immutable agent laws).";
  if (lower.includes("token") && (lower.includes("launch") || lower.includes("create")))
    return "You can launch tokens on Four.meme, Flap.sh (BNB Chain), XLayer (OKX), or Bankr (Base/Solana) right here in the bot! Use /launch or tap '🚀 Launch Token' from the menu.";
  if (lower.includes("agent") && (lower.includes("create") || lower.includes("make") || lower.includes("new")))
    return "Create an AI agent with /newagent — give it a name, bio, and pick a model (Llama 70B, DeepSeek V3, or Qwen 72B). Your agent gets its own wallet and can trade skills, earn BNB, and evolve autonomously.";
  if (lower.includes("how") && lower.includes("start"))
    return "Getting started is easy:\n1. Create a wallet (tap 🔑 Create New Wallet)\n2. Fund it with some BNB, OKB, or ETH\n3. Create an agent with /newagent\n4. Launch tokens with /launch\n\nThat's it — you're in the autonomous economy!";
  if (lower.includes("price") || (lower.includes("token") && !lower.includes("launch")) || lower.includes("buy"))
    return "BUILD4 is infrastructure, not a token. We power autonomous AI agents on-chain. Agents can launch their own tokens on Four.meme, Flap.sh, XLayer, or Bankr though! Use /launch to try it.";
  if (lower.includes("hello") || lower.includes("hi") || lower.includes("hey") || lower.includes("gm") || lower === "yo") {
    if (chatId) {
      const wallets = getUserWallets(chatId);
      if (wallets.length > 0) {
        return "Hey! Welcome back to BUILD4. What would you like to do?\n\n🚀 /launch — Launch a token\n🤖 /newagent — Create an agent\n💱 /buy or /sell — Trade tokens\n👛 /wallet — Manage wallets\n❓ /ask — Ask anything";
      }
    }
    return "Hey! Welcome to BUILD4 — decentralized infrastructure for autonomous AI agents. What can I help you with? Try /help to see all commands.";
  }
  if (lower.includes("help") || lower.includes("command"))
    return "Commands:\n🚀 /launch — Launch a token\n🤖 /newagent — Create an AI agent\n📋 /myagents — Your agents\n📝 /task — Assign a task\n👛 /wallet — Wallet info\n💱 /buy — Buy tokens\n📉 /sell — Sell tokens\n🔄 /swap — OKX DEX swap (multi-chain)\n🌉 /bridge — OKX cross-chain bridge\n🔥 /chaos — Chaos plan\n📈 /aster — Aster DEX trading\n❓ /ask — Ask anything\n❌ /cancel — Cancel current action";
  if (lower.includes("thank"))
    return "You're welcome! Let me know if you need anything else. 🤝";

  return null;
}

async function loadWalletsFromDb(): Promise<void> {
  try {
    const allLinks = await storage.getAllTelegramWalletLinks();
    const newWalletMap = new Map<number, { wallets: string[]; active: number }>();
    const newWalletsWithKey = new Set<string>();
    for (const link of allLinks) {
      const chatId = parseInt(link.chatId, 10);
      const existing = newWalletMap.get(chatId);
      if (existing) {
        existing.wallets.push(link.walletAddress);
        if (link.isActive) existing.active = existing.wallets.length - 1;
      } else {
        newWalletMap.set(chatId, { wallets: [link.walletAddress], active: link.isActive ? 0 : 0 });
      }
      if (link.encryptedPrivateKey) {
        newWalletsWithKey.add(`${link.chatId}:${link.walletAddress}`);
      }
    }
    telegramWalletMap.clear();
    for (const [k, v] of newWalletMap) telegramWalletMap.set(k, v);
    walletsWithKey.clear();
    for (const v of newWalletsWithKey) walletsWithKey.add(v);
    console.log(`[TelegramBot] Loaded ${allLinks.length} wallet links from DB for ${telegramWalletMap.size} chats`);
  } catch (e) {
    console.error("[TelegramBot] Failed to load wallets from DB:", e);
  }
}

function getLinkedWallet(chatId: number): string | undefined {
  const data = telegramWalletMap.get(chatId);
  if (!data || data.wallets.length === 0) return undefined;
  return data.wallets[data.active] || data.wallets[0];
}

const walletLoadAttempts = new Map<number, number>();
async function ensureWalletsLoaded(chatId: number): Promise<void> {
  if (telegramWalletMap.has(chatId)) return;
  const lastAttempt = walletLoadAttempts.get(chatId) || 0;
  if (Date.now() - lastAttempt < 5000) return;
  walletLoadAttempts.set(chatId, Date.now());
  try {
    const rows = await Promise.race([
      storage.getTelegramWallets(chatId.toString()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DB timeout")), 3000)),
    ]);
    if (rows.length > 0) {
      const wallets: string[] = [];
      let activeIdx = 0;
      for (let i = 0; i < rows.length; i++) {
        wallets.push(rows[i].walletAddress);
        if (rows[i].isActive) activeIdx = i;
        if (rows[i].encryptedPrivateKey) {
          walletsWithKey.add(`${chatId}:${rows[i].walletAddress}`);
        }
      }
      telegramWalletMap.set(chatId, { wallets, active: activeIdx });
    }
  } catch (e: any) {
    console.error("[TelegramBot] DB wallet lookup error:", e.message);
  }
}

function getUserWallets(chatId: number): string[] {
  const data = telegramWalletMap.get(chatId);
  return data ? data.wallets : [];
}

function getActiveWalletIndex(chatId: number): number {
  const data = telegramWalletMap.get(chatId);
  return data ? data.active : 0;
}

function setActiveWallet(chatId: number, index: number): boolean {
  const data = telegramWalletMap.get(chatId);
  if (!data || index < 0 || index >= data.wallets.length) return false;
  data.active = index;
  telegramWalletMap.set(chatId, data);
  storage.setActiveTelegramWallet(chatId.toString(), data.wallets[index]).catch(e =>
    console.error("[TelegramBot] DB setActive error:", e));
  return true;
}

function removeWallet(chatId: number, index: number): boolean {
  const data = telegramWalletMap.get(chatId);
  if (!data || index < 0 || index >= data.wallets.length) return false;
  const removedAddr = data.wallets[index];
  data.wallets.splice(index, 1);
  storage.removeTelegramWallet(chatId.toString(), removedAddr).catch(e =>
    console.error("[TelegramBot] DB remove error:", e));
  if (data.wallets.length === 0) {
    telegramWalletMap.delete(chatId);
    return true;
  }
  if (data.active >= data.wallets.length) data.active = 0;
  telegramWalletMap.set(chatId, data);
  if (data.wallets.length > 0) {
    storage.setActiveTelegramWallet(chatId.toString(), data.wallets[data.active]).catch(e =>
      console.error("[TelegramBot] DB setActive after remove error:", e));
  }
  return true;
}

export function getChatIdByWallet(wallet: string): number | undefined {
  const lowerWallet = wallet.toLowerCase();
  for (const [chatId, data] of telegramWalletMap.entries()) {
    if (data.wallets.includes(lowerWallet)) return chatId;
  }
  return undefined;
}

export function linkTelegramWallet(chatId: number, wallet: string, privateKey?: string): void {
  const lower = wallet.toLowerCase();
  const existing = telegramWalletMap.get(chatId);

  if (existing) {
    if (!existing.wallets.includes(lower)) {
      existing.wallets.push(lower);
      existing.active = existing.wallets.length - 1;
      telegramWalletMap.set(chatId, existing);
    } else {
      existing.active = existing.wallets.indexOf(lower);
      telegramWalletMap.set(chatId, existing);
    }
  } else {
    telegramWalletMap.set(chatId, { wallets: [lower], active: 0 });
  }

  if (privateKey) {
    walletsWithKey.add(`${chatId}:${lower}`);
  }

  storage.saveTelegramWallet(chatId.toString(), lower, privateKey || undefined).then(() => {
    storage.setActiveTelegramWallet(chatId.toString(), lower).catch(e =>
      console.error("[TelegramBot] DB setActive error:", e));
  }).catch(e => console.error("[TelegramBot] DB save error:", e));

  console.log(`[TelegramBot] Wallet linked via web for chatId ${chatId}: ${wallet.substring(0, 8)}...`);
  if (bot) {
    const count = getUserWallets(chatId).length;
    const msg = count > 1
      ? `Wallet added: ${shortWallet(lower)} (${count} wallets — this one is now active)`
      : `Wallet connected: ${shortWallet(lower)}`;
    bot.sendMessage(chatId, msg, { reply_markup: mainMenuKeyboard() }).catch(() => {});
  }
}

function shortModel(m: string): string {
  if (m.includes("Llama")) return "Llama 70B";
  if (m.includes("DeepSeek")) return "DeepSeek V3";
  if (m.includes("Qwen")) return "Qwen 72B";
  return m.split("/").pop() || m;
}

function shortWallet(w: string): string {
  return `${w.substring(0, 6)}...${w.substring(38)}`;
}

const agentCache = new Map<string, { agents: any[]; ts: number }>();
const AGENT_CACHE_TTL = 15_000;

async function getMyAgents(wallet: string) {
  const cached = agentCache.get(wallet);
  if (cached && Date.now() - cached.ts < AGENT_CACHE_TTL) return cached.agents;
  const agents = await storage.getAgentsByWallet(wallet);
  agentCache.set(wallet, { agents, ts: Date.now() });
  return agents;
}

async function autoGenerateWallet(chatId: number): Promise<string> {
  if (!bot) throw new Error("Bot not initialized");
  const wallet = ethers.Wallet.createRandom();
  const addr = wallet.address.toLowerCase();
  const pk = wallet.privateKey;

  const existing = telegramWalletMap.get(chatId);
  if (existing) {
    if (!existing.wallets.includes(addr)) {
      existing.wallets.push(addr);
      existing.active = existing.wallets.length - 1;
    } else {
      existing.active = existing.wallets.indexOf(addr);
    }
    telegramWalletMap.set(chatId, existing);
  } else {
    telegramWalletMap.set(chatId, { wallets: [addr], active: 0 });
  }

  await storage.saveTelegramWallet(chatId.toString(), addr, pk);
  await storage.setActiveTelegramWallet(chatId.toString(), addr);
  walletsWithKey.add(`${chatId}:${addr}`);

  await bot.sendMessage(chatId,
    `🔑 Wallet created!\n\n` +
    `Address:\n\`${addr}\`\n\n` +
    `Private Key:\n\`${pk}\`\n\n` +
    `⚠️ SAVE YOUR PRIVATE KEY — it won't be shown again.\n` +
    `Send BNB to your address to fund it.`,
    { parse_mode: "Markdown" }
  );

  return addr;
}

async function checkWalletHasKey(chatId: number, wallet: string | undefined): Promise<boolean> {
  if (!wallet) return false;
  if (walletsWithKey.has(`${chatId}:${wallet}`)) return true;
  try {
    const pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
    if (pk) {
      walletsWithKey.add(`${chatId}:${wallet}`);
      return true;
    }
  } catch {}
  return false;
}

async function ensureWallet(chatId: number): Promise<string> {
  let wallet = getLinkedWallet(chatId);
  if (!wallet) {
    wallet = await autoGenerateWallet(chatId);
  }
  return wallet;
}

async function regenerateWalletWithKey(chatId: number): Promise<string | null> {
  if (!bot) return null;
  try {
    const newAddr = await autoGenerateWallet(chatId);
    await bot.sendMessage(chatId,
      `🔄 Generated a new wallet with stored keys.\n\nNew active wallet: \`${newAddr}\`\n\n` +
      `⚠️ Fund this wallet before launching tokens.`,
      { parse_mode: "Markdown" }
    );
    return newAddr;
  } catch (e: any) {
    console.error("[TelegramBot] regenerateWalletWithKey error:", e.message);
    return null;
  }
}

const balanceCache = new Map<string, { bnb: string; eth: string; ts: number }>();
const BALANCE_CACHE_TTL = 30_000;
const bnbProviderCached = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
const baseProviderCached = new ethers.JsonRpcProvider("https://mainnet.base.org");

async function fetchWalletBalances(wallets: string[]): Promise<Record<string, { bnb: string; eth: string }>> {
  const result: Record<string, { bnb: string; eth: string }> = {};
  const now = Date.now();
  const uncached: string[] = [];

  for (const w of wallets) {
    const cached = balanceCache.get(w);
    if (cached && now - cached.ts < BALANCE_CACHE_TTL) {
      result[w] = { bnb: cached.bnb, eth: cached.eth };
    } else {
      uncached.push(w);
    }
  }

  if (uncached.length === 0) return result;

  await Promise.all(uncached.map(async (w) => {
    try {
      const [bnbBal, ethBal] = await Promise.all([
        bnbProviderCached.getBalance(w).catch(() => BigInt(0)),
        baseProviderCached.getBalance(w).catch(() => BigInt(0)),
      ]);
      const bnbStr = parseFloat(ethers.formatEther(bnbBal)).toFixed(4);
      const ethStr = parseFloat(ethers.formatEther(ethBal)).toFixed(4);
      result[w] = { bnb: bnbStr, eth: ethStr };
      balanceCache.set(w, { bnb: bnbStr, eth: ethStr, ts: now });
    } catch {
      result[w] = { bnb: "0.0000", eth: "0.0000" };
    }
  }));

  return result;
}

function getWalletConnectUrl(chatId?: number): string {
  const base = appBaseUrl || "https://build4.io";
  const url = `${base}/api/web4/telegram-wallet`;
  return chatId ? `${url}?chatId=${chatId}` : url;
}

function mainMenuKeyboard(_hasWallet?: boolean, _chatId?: number): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🚀 Launch Token", callback_data: "action:launchtoken" }],
      [{ text: "💰 Buy Token", callback_data: "action:buy" }, { text: "💸 Sell Token", callback_data: "action:sell" }],
      [{ text: "🔄 OKX Swap", callback_data: "action:okxswap" }, { text: "🌉 OKX Bridge", callback_data: "action:okxbridge" }],
      [{ text: "🐋 Signals", callback_data: "action:okxsignals" }, { text: "🔒 Security", callback_data: "action:okxsecurity" }],
      [{ text: "🔥 Trending", callback_data: "action:okxtrending" }, { text: "🐸 Meme Scanner", callback_data: "action:okxmeme" }],
      [{ text: "📊 Token Price", callback_data: "action:okxprice" }, { text: "⛽ Gas", callback_data: "action:okxgas" }],
      [{ text: "💎 Make Me Rich", callback_data: "action:trade" }, { text: "📈 Aster DEX", callback_data: "action:aster" }],
      [{ text: "🤖 Create Agent", callback_data: "action:newagent" }, { text: "📋 My Agents", callback_data: "action:myagents" }],
      [{ text: "📝 New Task", callback_data: "action:task" }, { text: "📊 My Tasks", callback_data: "action:mytasks" }],
      [{ text: "👛 My Wallet", callback_data: "action:wallet" }],
      [{ text: "❓ Help & Commands", callback_data: "action:help" }],
    ]
  };
}

function registerBotHandlers(b: TelegramBot): void {
  b.on("message", (msg) => {
    const chatId = msg.chat.id;
    if (msg.text) sendTyping(chatId);
    perChatQueue(chatId, async () => {
      const start = Date.now();
      try {
        await handleMessage(msg);
      } catch (e: any) {
        console.error("[TelegramBot] Unhandled error in message handler:", e.message);
      }
      recordTelegramMessage(Date.now() - start);
    });
  });

  b.on("callback_query", (query) => {
    if (!query.message) return;
    const chatId = query.message.chat.id;
    b.answerCallbackQuery(query.id).catch(() => {});
    sendTyping(chatId);
    perChatQueue(chatId, async () => {
      const start = Date.now();
      try {
        await handleCallbackQuery(query);
      } catch (e: any) {
        console.error("[TelegramBot] Callback query error:", e.message);
      }
      recordTelegramCallback(Date.now() - start);
    });
  });

  let conflictCount = 0;
  b.on("polling_error", (error) => {
    if (error.message?.includes("409 Conflict")) {
      conflictCount++;
      if (conflictCount <= 3) {
        console.warn(`[TelegramBot] 409 Conflict (${conflictCount}) — waiting for old instance to stop`);
      }
      return;
    }
    console.error("[TelegramBot] Polling error:", error.message);
  });
}

async function clearTelegramPolling(token: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`);
  } catch {}
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=1`);
      const data = await resp.json();
      if (data.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function setTelegramWebhook(token: string, webhookUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        max_connections: 100,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      }),
    });
    const data = await resp.json() as any;
    if (data.ok) {
      console.log(`[TelegramBot] Webhook set to ${webhookUrl}`);
      return true;
    }
    console.error("[TelegramBot] Failed to set webhook:", data.description);
    return false;
  } catch (e: any) {
    console.error("[TelegramBot] Webhook setup error:", e.message);
    return false;
  }
}

export function processWebhookUpdate(update: any): void {
  if (!bot || !isRunning) return;
  if (!update || typeof update !== "object" || (!update.message && !update.callback_query)) return;
  try {
    bot.processUpdate(update);
  } catch (e: any) {
    console.error("[TelegramBot] Webhook processUpdate error:", e.message);
  }
}

export async function startTelegramBot(webhookBaseUrl?: string): Promise<void> {
  if (isRunning || startingBot || !isTelegramConfigured()) return;
  startingBot = true;

  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const useWebhook = !!webhookBaseUrl;

  try {
    if (bot) {
      try { if (!webhookMode) bot.stopPolling(); } catch {}
      bot = null;
      isRunning = false;
    }

    if (useWebhook) {
      bot = new TelegramBot(token, { polling: false });
      const webhookUrl = `${webhookBaseUrl}/api/telegram/webhook/${token}`;
      const ok = await setTelegramWebhook(token, webhookUrl);
      if (!ok) {
        console.warn("[TelegramBot] Webhook failed, falling back to polling");
        return startTelegramBotPolling(token);
      }
      webhookMode = true;
    } else {
      await clearTelegramPolling(token);
      console.log("[TelegramBot] Cleared webhook and flushed pending updates");
      await new Promise(resolve => setTimeout(resolve, 3000));
      bot = new TelegramBot(token, {
        polling: { interval: 1000, autoStart: true, params: { timeout: 10 } }
      });
      webhookMode = false;
    }

    isRunning = true;

    loadWalletsFromDb().catch(e => console.error("[TelegramBot] Wallet load error:", e.message));

    const me = await bot.getMe();
    botUsername = me.username || null;
    console.log(`[TelegramBot] Started ${webhookMode ? "with webhook" : "with polling"} as @${botUsername}`);

    bot.setMyCommands([
      { command: "start", description: "Start BUILD4 and create a wallet" },
      { command: "launch", description: "Launch a token on Four.meme or Flap.sh" },
      { command: "swap", description: "OKX DEX swap on any chain" },
      { command: "bridge", description: "OKX cross-chain bridge" },
      { command: "signals", description: "Smart money & whale buy signals" },
      { command: "scan", description: "Security scanner (honeypot check)" },
      { command: "trending", description: "Hot & trending tokens" },
      { command: "meme", description: "Meme token scanner" },
      { command: "price", description: "Token price lookup" },
      { command: "gas", description: "Gas prices by chain" },
      { command: "newagent", description: "Create an AI agent" },
      { command: "wallet", description: "Wallet info and management" },
      { command: "aster", description: "Aster DEX futures & spot trading" },
      { command: "help", description: "Show all commands" },
    ]).then(() => {
      console.log("[TelegramBot] Registered bot commands");
    }).catch((e: any) => {
      console.error("[TelegramBot] Failed to set commands:", e.message);
    });

    fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ menu_button: { type: "commands" } })
    }).then(r => r.json()).then(r => {
      console.log("[TelegramBot] Set menu button:", r.ok ? "success" : r.description);
    }).catch(() => {});

    registerBotHandlers(bot);

    registerTaskHandler("ai_inference", async (data: { chatId: number; question: string; context: string }) => {
      const answer = await runInferenceWithFallback(data.question, data.context, "llama3");
      return answer;
    });

  } catch (e: any) {
    console.error("[TelegramBot] Failed to start:", e.message);
    isRunning = false;
  } finally {
    startingBot = false;
  }
}

async function startTelegramBotPolling(token: string): Promise<void> {
  try {
    await clearTelegramPolling(token);
    await new Promise(resolve => setTimeout(resolve, 3000));
    bot = new TelegramBot(token, {
      polling: { interval: 1000, autoStart: true, params: { timeout: 10 } }
    });
    webhookMode = false;
    isRunning = true;

    loadWalletsFromDb().catch(e => console.error("[TelegramBot] Wallet load error:", e.message));
    const me = await bot.getMe();
    botUsername = me.username || null;
    console.log(`[TelegramBot] Fallback started with polling as @${botUsername}`);

    registerBotHandlers(bot);

    registerTaskHandler("ai_inference", async (data: { chatId: number; question: string; context: string }) => {
      return await runInferenceWithFallback(data.question, data.context, "llama3");
    });
  } catch (e: any) {
    console.error("[TelegramBot] Polling fallback failed:", e.message);
    isRunning = false;
  } finally {
    startingBot = false;
  }
}

async function handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
  if (!bot || !query.data || !query.message) return;
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!checkRateLimit(`tg_cb:${chatId}`, 60, 60000)) {
    return;
  }

  await ensureWalletsLoaded(chatId);

  if (data === "action:linkwallet" || data === "action:genwallet") {
    try {
      await ensureWallet(chatId);
      pendingImportWallet.delete(chatId);
      await bot.sendMessage(chatId,
        `Your wallet is ready. What would you like to do?`,
        { reply_markup: mainMenuKeyboard() }
      );
    } catch (e: any) {
      console.error("[TelegramBot] Wallet generation error:", e.message);
      await bot.sendMessage(chatId, "Failed to generate wallet. Please try again.");
    }
    return;
  }

  if (data === "action:importwallet") {
    pendingImportWallet.add(chatId);
    pendingAgentCreation.delete(chatId);
    pendingTask.delete(chatId);
    pendingTokenLaunch.delete(chatId);

    await bot.sendMessage(chatId,
      "Paste your wallet private key below to import it.\n\n" +
      "• Private key — starts with 0x, 66 characters\n\n" +
      "Type /cancel to go back.",
    );
    return;
  }

  if (data === "erc8004_register") {
    const wallets = getUserWallets(chatId);
    const activeIdx = getActiveWalletIndex(chatId);
    const walletAddr = wallets[activeIdx];
    if (!walletAddr) {
      await bot.sendMessage(chatId, "No wallet found. Use /wallet to set one up first.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    const hasKey = walletsWithKey.has(walletAddr.toLowerCase());
    if (!hasKey) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to register. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const pk = await storage.getTelegramWalletPrivateKey(String(chatId), walletAddr);
    if (!pk) {
      await bot.sendMessage(chatId, "Could not retrieve wallet private key. Try generating a new wallet with /wallet.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    await bot.sendMessage(chatId, "Registering your wallet as an AI agent on ERC-8004 (BSC)...\nThis may take 10-30 seconds.");

    try {
      const { ensureAgentRegisteredBSC } = await import("./token-launcher");
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const wallet = new ethers.Wallet(pk, provider);

      const result = await ensureAgentRegisteredBSC(wallet, "BUILD4 Agent", "Autonomous AI agent on BUILD4");

      if (result.registered) {
        const txInfo = result.txHash ? `\nTX: ${result.txHash.substring(0, 14)}...` : "";
        await bot.sendMessage(chatId,
          "✅ AI Agent Badge: REGISTERED\n\n" +
          `Wallet: ${walletAddr.substring(0, 8)}...${walletAddr.slice(-6)}${txInfo}\n\n` +
          "Your token launches on Four.meme will now show the AI Agent icon on GMGN and other trackers!",
          { reply_markup: mainMenuKeyboard() }
        );
      } else {
        await bot.sendMessage(chatId,
          `❌ Registration failed: ${result.error?.substring(0, 120) || "Unknown error"}\n\nMake sure your wallet has at least 0.001 BNB for gas.`,
          { reply_markup: mainMenuKeyboard() }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100) || "Unknown error"}`, { reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  if (data === "action:info") {
    await bot.sendMessage(chatId,
      "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\n" +
      "Agents get wallets, trade skills, evolve, replicate, and operate fully on-chain. No centralized AI — inference runs through Hyperbolic, Akash ML, and Ritual.\n\n" +
      "https://build4.io",
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  if (data === "action:help") {
    const hasW = !!getLinkedWallet(chatId);
    await bot.sendMessage(chatId,
      "Commands:\n\n" +
      "🚀 /launch — Launch a token\n" +
      "🔄 /swap — OKX DEX swap\n" +
      "🌉 /bridge — Cross-chain bridge\n" +
      "🐋 /signals — Smart money signals\n" +
      "🔒 /scan — Security scanner\n" +
      "🔥 /trending — Hot & trending tokens\n" +
      "🐸 /meme — Meme token scanner\n" +
      "📊 /price — Token price lookup\n" +
      "⛽ /gas — Gas prices\n" +
      "🤖 /newagent — Create an AI agent\n" +
      "📋 /myagents — Your agents\n" +
      "📝 /task — Assign a task\n" +
      "👛 /wallet — Wallet info\n" +
      "❓ /ask <question> — Ask anything\n" +
      "❌ /cancel — Cancel current action\n\n" +
      "Or just type any question!",
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  if (data === "action:wallet") {
    const wallets = getUserWallets(chatId);
    if (wallets.length === 0) {
      await ensureWallet(chatId);
    }
    const activeIdx = getActiveWalletIndex(chatId);
    const updatedWallets = getUserWallets(chatId);

    await bot.sendMessage(chatId, "Loading wallet balances...");

    const balances = await fetchWalletBalances(updatedWallets);

    let text = `👛 Your Wallets\n\n`;
    updatedWallets.forEach((w, i) => {
      const marker = i === activeIdx ? "✅" : "⬜";
      const bal = balances[w];
      const hasKey = walletsWithKey.has(`${chatId}:${w}`);
      const keyTag = hasKey ? "" : " 🔒 view-only";
      let balText = "";
      if (bal) {
        const parts: string[] = [];
        if (parseFloat(bal.bnb) > 0) parts.push(`${bal.bnb} BNB`);
        if (parseFloat(bal.eth) > 0) parts.push(`${bal.eth} ETH`);
        balText = parts.length > 0 ? ` (${parts.join(", ")})` : " (empty)";
      }
      text += `${marker} \`${w}\`${i === activeIdx ? " ← active" : ""}${keyTag}\n    ${balText}\n\n`;
    });
    text += `Send BNB to your active wallet address to fund it.`;

    const walletButtons: TelegramBot.InlineKeyboardButton[][] = updatedWallets.map((w, i) => {
      if (i === activeIdx) {
        return [{ text: `📋 Copy Address`, callback_data: `copywall:${i}` }];
      }
      return [
        { text: `▶️ Use ${shortWallet(w)}`, callback_data: `switchwall:${i}` },
        { text: `🗑`, callback_data: `removewall:${i}` },
      ];
    });

    walletButtons.push([{ text: "🔑 Add Wallet", callback_data: "action:genwallet" }]);
    walletButtons.push([{ text: "🔐 Export Private Key", callback_data: "action:exportkey" }]);
    walletButtons.push([{ text: "🚀 Launch Token", callback_data: "action:launchtoken" }, { text: "◀️ Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: walletButtons }
    });
    return;
  }

  if (data === "action:copyaddr") {
    let w = getLinkedWallet(chatId);
    if (!w) { w = await ensureWallet(chatId); }
    await bot.sendMessage(chatId, `\`${w}\``, { parse_mode: "Markdown" });
    return;
  }

  if (data.startsWith("copywall:")) {
    const idx = parseInt(data.split(":")[1]);
    const wallets = getUserWallets(chatId);
    if (idx >= 0 && idx < wallets.length) {
      await bot.sendMessage(chatId, `\`${wallets[idx]}\``, { parse_mode: "Markdown" });
    }
    return;
  }

  if (data.startsWith("switchwall:")) {
    const idx = parseInt(data.split(":")[1]);
    const wallets = getUserWallets(chatId);
    if (idx >= 0 && idx < wallets.length && setActiveWallet(chatId, idx)) {
      await bot.sendMessage(chatId,
        `✅ Switched to wallet: ${shortWallet(wallets[idx])}`,
        { reply_markup: { inline_keyboard: [[{ text: "👛 My Wallets", callback_data: "action:wallet" }, { text: "◀️ Menu", callback_data: "action:menu" }]] } }
      );
    }
    return;
  }

  if (data.startsWith("removewall:")) {
    const idx = parseInt(data.split(":")[1]);
    const wallets = getUserWallets(chatId);
    if (idx >= 0 && idx < wallets.length) {
      const removed = wallets[idx];
      removeWallet(chatId, idx);
      const remaining = getUserWallets(chatId);
      if (remaining.length === 0) {
        await bot.sendMessage(chatId, `Wallet removed: ${shortWallet(removed)}\n\nNo wallets left.`, {
          reply_markup: mainMenuKeyboard()
        });
      } else {
        await bot.sendMessage(chatId, `Wallet removed: ${shortWallet(removed)}`, {
          reply_markup: { inline_keyboard: [[{ text: "👛 My Wallets", callback_data: "action:wallet" }, { text: "◀️ Menu", callback_data: "action:menu" }]] }
        });
      }
    }
    return;
  }

  if (data === "action:exportkey") {
    const wallets = getUserWallets(chatId);
    if (wallets.length === 0) {
      await bot.sendMessage(chatId, "No wallets found. Use /wallet to create one first.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    const activeIdx = getActiveWalletIndex(chatId);
    const activeWallet = wallets[activeIdx] || wallets[0];
    await bot.sendMessage(chatId,
      `⚠️ *WARNING: You are about to reveal your private key.*\n\n` +
      `Wallet: \`${activeWallet}\`\n\n` +
      `Your private key gives FULL control of this wallet. Never share it with anyone.\n\n` +
      `Are you sure?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Yes, show my private key", callback_data: `confirmexport:${activeIdx}` }],
            [{ text: "❌ Cancel", callback_data: "action:wallet" }],
          ]
        }
      }
    );
    return;
  }

  if (data.startsWith("confirmexport:")) {
    try {
      const idx = parseInt(data.split(":")[1]);
      const wallets = getUserWallets(chatId);
      if (idx < 0 || idx >= wallets.length) {
        await bot.sendMessage(chatId, "Invalid wallet.", { reply_markup: mainMenuKeyboard() });
        return;
      }
      const walletAddr = wallets[idx];
      log(`[TelegramBot] Export key requested for wallet ${shortWallet(walletAddr)} by chat ${chatId}`, "telegram");
      const pk = await storage.getTelegramWalletPrivateKey(String(chatId), walletAddr);
      if (!pk) {
        await bot.sendMessage(chatId, "This wallet is view-only — no private key stored. Only wallets generated inside this bot have exportable keys.", { reply_markup: mainMenuKeyboard() });
        return;
      }

      const msg = await bot.sendMessage(chatId,
        `🔐 Private Key for ${shortWallet(walletAddr)}\n\n` +
        `${pk}\n\n` +
        `⚠️ This message will be auto-deleted in 60 seconds. Copy it now.`
      );

      setTimeout(async () => {
        try {
          await bot.deleteMessage(chatId, msg.message_id);
          await bot.sendMessage(chatId, "🔐 Private key message deleted for security.", { reply_markup: mainMenuKeyboard() });
        } catch {}
      }, 60000);
    } catch (e: any) {
      log(`[TelegramBot] Export key error: ${e.message}`, "telegram");
      await bot.sendMessage(chatId, `Failed to export key: ${e.message?.substring(0, 100)}`, { reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  const wallet = await ensureWallet(chatId);

  if (data === "action:newagent") {
    pendingAgentCreation.set(chatId, { step: "name" });
    pendingTask.delete(chatId);
    await bot.sendMessage(chatId, "What's your agent's name? (1-50 characters)");
    return;
  }

  if (data === "action:myagents") {
    await handleMyAgents(chatId, wallet);
    return;
  }

  if (data === "action:task") {
    await startTaskFlow(chatId, wallet);
    return;
  }

  if (data === "action:mytasks") {
    await handleMyTasks(chatId, wallet);
    return;
  }

  if (data === "action:launchtoken") {
    await startTokenLaunchFlow(chatId, wallet);
    return;
  }

  if (data === "action:buy") {
    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first (/linkwallet).");
      return;
    }
    pendingFourMemeBuy.set(chatId, { step: "token" });
    await bot.sendMessage(chatId, "Enter the token contract address you want to buy (0x...):");
    return;
  }

  if (data === "action:sell") {
    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first (/linkwallet).");
      return;
    }
    pendingFourMemeSell.set(chatId, { step: "token" });
    await bot.sendMessage(chatId, "Enter the token contract address you want to sell (0x...):");
    return;
  }

  if (data === "action:okxswap") {
    pendingOKXSwap.set(chatId, { step: "chain" });
    pendingOKXBridge.delete(chatId);
    const chainButtons = OKX_CHAINS.map(c => [{ text: `${c.name} (${c.symbol})`, callback_data: `okxswap_chain:${c.id}` }]);
    chainButtons.push([{ text: "« Back", callback_data: "action:menu" }]);
    await bot.sendMessage(chatId,
      "🔄 *OKX DEX Swap*\n\nSwap tokens on any chain using OKX DEX Aggregator.\n0.5% fee to BUILD4 treasury.\n\nSelect a chain:",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
    );
    return;
  }

  if (data.startsWith("okxswap_chain:")) {
    const chainId = data.replace("okxswap_chain:", "");
    const chain = OKX_CHAINS.find(c => c.id === chainId);
    if (!chain) return;
    const tokens = getOKXTokensForChain(chainId);
    pendingOKXSwap.set(chatId, { step: "from_token", chainId, chainName: chain.name });
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxswap_from:${t.address}:${t.symbol}` }]);
    tokenButtons.push([{ text: "📝 Custom Address", callback_data: "okxswap_from_custom" }]);
    tokenButtons.push([{ text: "« Back", callback_data: "action:okxswap" }]);
    await bot.sendMessage(chatId,
      `🔄 *Swap on ${chain.name}*\n\nSelect token to sell:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (data.startsWith("okxswap_from:")) {
    const parts = data.replace("okxswap_from:", "").split(":");
    const [address, symbol] = parts;
    const state = pendingOKXSwap.get(chatId);
    if (!state) return;
    state.fromToken = address;
    state.fromSymbol = symbol;
    state.step = "to_token";
    const tokens = getOKXTokensForChain(state.chainId!).filter(t => t.address !== address);
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxswap_to:${t.address}:${t.symbol}` }]);
    tokenButtons.push([{ text: "📝 Custom Address", callback_data: "okxswap_to_custom" }]);
    tokenButtons.push([{ text: "« Back", callback_data: `okxswap_chain:${state.chainId}` }]);
    await bot.sendMessage(chatId,
      `🔄 *Swap ${symbol} on ${state.chainName}*\n\nSelect token to buy:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (data === "okxswap_from_custom") {
    const state = pendingOKXSwap.get(chatId);
    if (!state) return;
    state.step = "from_token";
    await bot.sendMessage(chatId, "Enter the contract address of the token you want to sell (0x...):");
    return;
  }

  if (data === "okxswap_to_custom") {
    const state = pendingOKXSwap.get(chatId);
    if (!state) return;
    state.step = "to_token";
    await bot.sendMessage(chatId, "Enter the contract address of the token you want to buy (0x...):");
    return;
  }

  if (data.startsWith("okxswap_to:")) {
    const parts = data.replace("okxswap_to:", "").split(":");
    const [address, symbol] = parts;
    const state = pendingOKXSwap.get(chatId);
    if (!state) return;
    state.toToken = address;
    state.toSymbol = symbol;
    state.step = "amount";
    await bot.sendMessage(chatId,
      `🔄 *Swap on ${state.chainName}*\n\n` +
      `From: ${state.fromSymbol}\nTo: ${symbol}\n\n` +
      `Enter the amount of ${state.fromSymbol} to swap:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data === "action:okxbridge") {
    await bot.sendMessage(chatId,
      "🌉 *OKX Cross-Chain Bridge*\n\n" +
      "⚠️ Cross-chain bridge is temporarily unavailable on OKX. Please try again later.\n\n" +
      "You can still use *DEX Swap* to trade tokens on a single chain.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Use DEX Swap Instead", callback_data: "action:okxswap" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxbridge_from:")) {
    const chainId = data.replace("okxbridge_from:", "");
    const chain = OKX_CHAINS.find(c => c.id === chainId);
    if (!chain) return;
    pendingOKXBridge.set(chatId, { step: "to_chain", fromChainId: chainId, fromChainName: chain.name });
    const destChains = OKX_CHAINS.filter(c => c.id !== chainId);
    const chainButtons = destChains.map(c => [{ text: `${c.name} (${c.symbol})`, callback_data: `okxbridge_to:${c.id}` }]);
    chainButtons.push([{ text: "« Back", callback_data: "action:okxbridge" }]);
    await bot.sendMessage(chatId,
      `🌉 *Bridge from ${chain.name}*\n\nSelect destination chain:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
    );
    return;
  }

  if (data.startsWith("okxbridge_to:")) {
    const chainId = data.replace("okxbridge_to:", "");
    const chain = OKX_CHAINS.find(c => c.id === chainId);
    const state = pendingOKXBridge.get(chatId);
    if (!state || !chain) return;
    state.toChainId = chainId;
    state.toChainName = chain.name;
    state.step = "from_token";
    const tokens = getOKXTokensForChain(state.fromChainId!);
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxbridge_ftoken:${t.address}:${t.symbol}:${t.decimals}` }]);
    tokenButtons.push([{ text: "« Back", callback_data: `okxbridge_from:${state.fromChainId}` }]);
    await bot.sendMessage(chatId,
      `🌉 *${state.fromChainName} → ${chain.name}*\n\nSelect token to bridge:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (data.startsWith("okxbridge_ftoken:")) {
    const parts = data.replace("okxbridge_ftoken:", "").split(":");
    const [address, symbol, decimalsStr] = parts;
    const state = pendingOKXBridge.get(chatId);
    if (!state) return;
    state.fromToken = address;
    state.fromSymbol = symbol;
    state.fromDecimals = parseInt(decimalsStr);
    state.step = "to_token";
    const tokens = getOKXTokensForChain(state.toChainId!);
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxbridge_ttoken:${t.address}:${t.symbol}:${t.decimals}` }]);
    tokenButtons.push([{ text: "« Back", callback_data: `okxbridge_to:${state.toChainId}` }]);
    await bot.sendMessage(chatId,
      `🌉 *${state.fromChainName} → ${state.toChainName}*\nToken: ${symbol}\n\nSelect token to receive:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (data.startsWith("okxbridge_ttoken:")) {
    const parts = data.replace("okxbridge_ttoken:", "").split(":");
    const [address, symbol, decimalsStr] = parts;
    const state = pendingOKXBridge.get(chatId);
    if (!state) return;
    state.toToken = address;
    state.toSymbol = symbol;
    state.toDecimals = parseInt(decimalsStr);
    state.step = "amount";
    await bot.sendMessage(chatId,
      `🌉 *${state.fromChainName} → ${state.toChainName}*\n` +
      `Send: ${state.fromSymbol}\nReceive: ${symbol}\n\n` +
      `Enter the amount of ${state.fromSymbol} to bridge:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data.startsWith("okxbridge_usewallet:")) {
    const addr = data.replace("okxbridge_usewallet:", "");
    const state = pendingOKXBridge.get(chatId);
    if (!state) return;
    state.receiver = addr;
    await executeBridgeQuote(chatId, state);
    return;
  }

  if (data === "action:trade") {
    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to use the trading agent. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    const { getUserTradingStatus } = await import("./trading-agent");
    const { config, positions } = getUserTradingStatus(chatId);
    const isEnabled = config.enabled;

    let statusLine = isEnabled
      ? `Status: ✅ ACTIVE | Open Positions: ${positions.length}`
      : `Status: ⏸ DISABLED`;

    const toggleBtn = isEnabled
      ? { text: "⏸ Disable Trading", callback_data: "trade:disable" }
      : { text: "▶️ Enable Trading", callback_data: "trade:enable" };

    await bot.sendMessage(chatId,
      `💎 *Make Me Rich — Autonomous Trading Agent*\n\n${statusLine}\n\nThe agent scans Four.meme for new token launches, evaluates momentum signals, and trades automatically from your wallet.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [toggleBtn],
            [{ text: "🎯 Instant Sniper", callback_data: "trade:instantsniper" }],
            [{ text: "📊 Status", callback_data: "trade:status" }, { text: "⚙️ Settings", callback_data: "trade:settings" }],
            [{ text: "🧩 Agent Skills", callback_data: "trade:skills" }],
            [{ text: "📜 History", callback_data: "trade:history" }, { text: "🔴 Close All", callback_data: "trade:closeall" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("trade:")) {
    const tradeAction = data.split(":")[1];
    const { setUserTradingConfig, getUserTradingStatus, startTradingAgent, isTradingAgentRunning, getActivePositionsForUser, getTradeHistoryForUser, manualClosePosition } = await import("./trading-agent");

    if (tradeAction === "instantsniper") {
      const { isInstantSniperEnabled, setInstantSniperEnabled } = await import("./trading-agent");
      const currentlyEnabled = isInstantSniperEnabled();
      const newState = !currentlyEnabled;
      setInstantSniperEnabled(newState);
      const statusText = newState
        ? "🎯 *Instant Sniper ENABLED*\n\nThe bot will now automatically buy EVERY new token on Four.meme within seconds of launch.\n\n⚡ Scan interval: 1.5s\n💰 Buy amount: 0.05 BNB per snipe\n🎯 Max age: 60s after launch\n⚠️ High risk — trades happen with NO AI analysis"
        : "⏸ *Instant Sniper DISABLED*\n\nThe bot will no longer auto-buy new launches. The regular sniper (score-based) is still active.";
      await bot.sendMessage(chatId, statusText, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: newState ? "⏸ Disable Instant Sniper" : "🎯 Enable Instant Sniper", callback_data: "trade:instantsniper" }],
            [{ text: "« Back to Trading", callback_data: "action:trade" }],
          ],
        },
      });
      return;
    }

    if (tradeAction === "enable") {
      setUserTradingConfig(chatId, { enabled: true });
      if (!isTradingAgentRunning()) {
        startTradingAgent((cid, msg) => {
          bot?.sendMessage(cid, msg, { reply_markup: mainMenuKeyboard() }).catch(() => {});
        });
      }
      await bot.sendMessage(chatId,
        "✅ Trading agent ENABLED\n\nThe agent will scan Four.meme for new tokens and trade automatically. You'll be notified of every buy and sell.\n\nUse /tradestatus to check positions.",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    if (tradeAction === "disable") {
      setUserTradingConfig(chatId, { enabled: false });
      await bot.sendMessage(chatId, "⏸ Trading agent DISABLED\n\nExisting positions will still be monitored until closed.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (tradeAction === "status") {
      const { config, positions } = getUserTradingStatus(chatId);
      let msg = `📊 *Trading Agent*\n\n`;
      msg += `Status: ${config.enabled ? "✅ ACTIVE" : "⏸ DISABLED"}\n`;
      msg += `Open Positions: ${positions.length}\n`;
      if (positions.length > 0) {
        msg += `\n`;
        for (const p of positions) {
          const age = Math.floor((Date.now() - p.entryTime) / 60000);
          msg += `  • $${p.tokenSymbol} — ${p.entryPriceBnb} BNB (${age}m ago)\n`;
        }
      }
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    }

    if (tradeAction === "settings") {
      const { config } = getUserTradingStatus(chatId);
      await bot.sendMessage(chatId,
        `⚙️ *Trading Settings*\n\n` +
        `Current config:\n` +
        `• Buy: ${config.buyAmountBnb} BNB per trade\n` +
        `• TP: ${config.takeProfitMultiple}x\n` +
        `• SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n` +
        `• Max positions: ${config.maxPositions}\n\n` +
        `Adjust:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "0.1 BNB", callback_data: "tradeset:buy:0.1" }, { text: "0.25 BNB", callback_data: "tradeset:buy:0.25" }, { text: "0.5 BNB", callback_data: "tradeset:buy:0.5" }],
              [{ text: "TP 1.5x", callback_data: "tradeset:tp:1.5" }, { text: "TP 2x", callback_data: "tradeset:tp:2" }, { text: "TP 3x", callback_data: "tradeset:tp:3" }],
              [{ text: "SL -20%", callback_data: "tradeset:sl:0.8" }, { text: "SL -30%", callback_data: "tradeset:sl:0.7" }, { text: "SL -50%", callback_data: "tradeset:sl:0.5" }],
              [{ text: "Max 3", callback_data: "tradeset:max:3" }, { text: "Max 5", callback_data: "tradeset:max:5" }, { text: "Max 10", callback_data: "tradeset:max:10" }],
              [{ text: "« Back", callback_data: "trade:status" }],
            ],
          },
        }
      );
      return;
    }

    if (tradeAction === "history") {
      const history = getTradeHistoryForUser(chatId);
      if (history.length === 0) {
        await bot.sendMessage(chatId, "No trade history yet. Enable the agent with /trade to start.", { reply_markup: mainMenuKeyboard() });
        return;
      }
      let msg = `📜 *Trade History (last ${history.length}):*\n\n`;
      let totalPnl = 0;
      for (const t of history.slice(-10)) {
        const emoji = t.status === "closed_profit" ? "💰" : t.status === "closed_loss" ? "📉" : "🔄";
        const pnl = parseFloat(t.pnlBnb || "0");
        totalPnl += pnl;
        msg += `${emoji} $${t.tokenSymbol}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} BNB\n`;
      }
      msg += `\n*Net PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} BNB*`;
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    }

    if (tradeAction === "closeall") {
      const positions = getActivePositionsForUser(chatId);
      if (positions.length === 0) {
        await bot.sendMessage(chatId, "No open positions to close.", { reply_markup: mainMenuKeyboard() });
        return;
      }
      await bot.sendMessage(chatId, `Closing ${positions.length} position(s)...`);
      let closed = 0;
      for (const p of positions) {
        const ok = await manualClosePosition(p.id, (cid, m) => bot?.sendMessage(cid, m).catch(() => {}));
        if (ok) closed++;
      }
      await bot.sendMessage(chatId, `Closed ${closed}/${positions.length} positions.`, { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (tradeAction === "skills") {
      const { SKILL_REGISTRY } = await import("./agent-skills");
      const { getSkillsByCategory } = await import("./agent-skills");
      const strategies = getSkillsByCategory("strategy");
      const analysis = getSkillsByCategory("analysis");
      const execution = getSkillsByCategory("execution");
      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const enabledSet = new Set(dbConfigs.filter(c => c.enabled).map(c => c.skillId));
      const defaultEnabled = new Set(SKILL_REGISTRY.filter(s => s.defaultEnabled).map(s => s.id));
      const isEnabled = (id: string) => dbConfigs.some(c => c.skillId === id) ? enabledSet.has(id) : defaultEnabled.has(id);

      const countEnabled = (skills: typeof SKILL_REGISTRY) => skills.filter(s => isEnabled(s.id)).length;

      await bot.sendMessage(chatId,
        `🧩 *Agent Skills*\n\n` +
        `Customize your trading agent with modular skills. Toggle them on/off to match your strategy.\n\n` +
        `🎯 *Strategies* — ${countEnabled(strategies)}/${strategies.length} active\n` +
        `🔍 *Analysis* — ${countEnabled(analysis)}/${analysis.length} active\n` +
        `⚡ *Execution* — ${countEnabled(execution)}/${execution.length} active`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: `🎯 Strategies (${countEnabled(strategies)})`, callback_data: "skills:cat:strategy" }],
              [{ text: `🔍 Analysis (${countEnabled(analysis)})`, callback_data: "skills:cat:analysis" }],
              [{ text: `⚡ Execution (${countEnabled(execution)})`, callback_data: "skills:cat:execution" }],
              [{ text: "« Back to Trading", callback_data: "action:trade" }],
            ],
          },
        }
      );
      return;
    }

    return;
  }

  if (data.startsWith("tradeset:")) {
    const parts = data.split(":");
    const param = parts[1];
    const value = parts[2];
    const { setUserTradingConfig, getUserTradingStatus } = await import("./trading-agent");

    if (param === "buy") {
      setUserTradingConfig(chatId, { buyAmountBnb: value });
    } else if (param === "tp") {
      setUserTradingConfig(chatId, { takeProfitMultiple: parseFloat(value) });
    } else if (param === "sl") {
      setUserTradingConfig(chatId, { stopLossMultiple: parseFloat(value) });
    } else if (param === "max") {
      setUserTradingConfig(chatId, { maxPositions: parseInt(value) });
    }

    const { config } = getUserTradingStatus(chatId);
    await bot.sendMessage(chatId,
      `✅ Updated!\n\n` +
      `• Buy: ${config.buyAmountBnb} BNB\n` +
      `• TP: ${config.takeProfitMultiple}x\n` +
      `• SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n` +
      `• Max: ${config.maxPositions} positions`,
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  if (data.startsWith("skills:")) {
    const { SKILL_REGISTRY, getSkillsByCategory, getSkillById } = await import("./agent-skills");
    const { invalidateSkillsCache } = await import("./trading-agent");
    const skillParts = data.split(":");

    if (skillParts[1] === "cat") {
      const category = skillParts[2] as "strategy" | "analysis" | "execution";
      const categoryLabels: Record<string, string> = { strategy: "🎯 Strategy Skills", analysis: "🔍 Analysis Skills", execution: "⚡ Execution Skills" };
      const skills = getSkillsByCategory(category);
      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const enabledSet = new Set(dbConfigs.filter(c => c.enabled).map(c => c.skillId));
      const defaultEnabled = new Set(SKILL_REGISTRY.filter(s => s.defaultEnabled).map(s => s.id));
      const isEnabled = (id: string) => dbConfigs.some(c => c.skillId === id) ? enabledSet.has(id) : defaultEnabled.has(id);

      let msg = `${categoryLabels[category] || category}\n\n`;
      for (const s of skills) {
        const on = isEnabled(s.id);
        msg += `${s.icon} *${s.name}* ${on ? "✅" : "❌"}\n${s.shortDesc}\n\n`;
      }
      msg += `Tap a skill to toggle it on/off:`;

      const buttons = skills.map(s => {
        const on = isEnabled(s.id);
        return [{ text: `${s.icon} ${s.name} ${on ? "✅" : "❌"}`, callback_data: `skills:toggle:${s.id}` }];
      });
      buttons.push([{ text: "« Back to Skills", callback_data: "trade:skills" }]);

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
      return;
    }

    if (skillParts[1] === "toggle") {
      const skillId = skillParts[2];
      const skill = getSkillById(skillId);
      if (!skill) {
        await bot.sendMessage(chatId, "Unknown skill.", { reply_markup: mainMenuKeyboard() });
        return;
      }

      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const existing = dbConfigs.find(c => c.skillId === skillId);
      const wasEnabled = existing ? existing.enabled : skill.defaultEnabled;
      const newEnabled = !wasEnabled;
      const config = existing?.config || { ...skill.defaultConfig };

      await storage.setUserSkillConfig(chatId.toString(), skillId, newEnabled, config);
      invalidateSkillsCache(chatId);

      const statusEmoji = newEnabled ? "✅" : "❌";
      let msg = `${skill.icon} *${skill.name}* — ${newEnabled ? "ENABLED" : "DISABLED"} ${statusEmoji}\n\n${skill.description}`;

      const buttons: any[][] = [];
      if (newEnabled && skill.configSchema && skill.configSchema.length > 0) {
        buttons.push([{ text: "⚙️ Configure", callback_data: `skills:config:${skillId}` }]);
      }
      buttons.push([{ text: `« Back to ${skill.category}`, callback_data: `skills:cat:${skill.category}` }]);

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
      return;
    }

    if (skillParts[1] === "config") {
      const skillId = skillParts[2];
      const skill = getSkillById(skillId);
      if (!skill || !skill.configSchema) {
        await bot.sendMessage(chatId, "No configurable options for this skill.", { reply_markup: mainMenuKeyboard() });
        return;
      }

      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const existing = dbConfigs.find(c => c.skillId === skillId);
      const config = existing?.config || { ...skill.defaultConfig };

      let msg = `⚙️ *${skill.icon} ${skill.name} Config*\n\n`;
      const buttons: any[][] = [];

      for (const param of skill.configSchema) {
        const currentVal = config[param.key] ?? skill.defaultConfig[param.key];
        msg += `*${param.label}:* ${currentVal}\n`;

        if (param.type === "select" && param.options) {
          const row = param.options.map(opt => ({
            text: `${opt.label}${String(currentVal) === opt.value ? " ✓" : ""}`,
            callback_data: `skills:set:${skillId}:${param.key}:${opt.value}`,
          }));
          buttons.push(row);
        } else if (param.type === "boolean") {
          buttons.push([
            { text: `${currentVal ? "✅ On" : "❌ Off"} — Toggle`, callback_data: `skills:set:${skillId}:${param.key}:${currentVal ? "false" : "true"}` },
          ]);
        } else if (param.type === "number") {
          const step = param.step || 1;
          const min = param.min ?? 0;
          const max = param.max ?? 100;
          const down = Math.max(min, Number(currentVal) - step);
          const up = Math.min(max, Number(currentVal) + step);
          buttons.push([
            { text: `⬇ ${down}`, callback_data: `skills:set:${skillId}:${param.key}:${down}` },
            { text: `${param.label}: ${currentVal}`, callback_data: `skills:config:${skillId}` },
            { text: `⬆ ${up}`, callback_data: `skills:set:${skillId}:${param.key}:${up}` },
          ]);
        }
      }
      buttons.push([{ text: `« Back to ${skill.category}`, callback_data: `skills:cat:${skill.category}` }]);

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
      return;
    }

    if (skillParts[1] === "set") {
      const skillId = skillParts[2];
      const paramKey = skillParts[3];
      const rawValue = skillParts.slice(4).join(":");
      const skill = getSkillById(skillId);
      if (!skill) return;

      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const existing = dbConfigs.find(c => c.skillId === skillId);
      const config = existing?.config || { ...skill.defaultConfig };

      const paramDef = skill.configSchema?.find(p => p.key === paramKey);
      if (paramDef?.type === "number") {
        config[paramKey] = parseFloat(rawValue);
      } else if (paramDef?.type === "boolean") {
        config[paramKey] = rawValue === "true";
      } else {
        config[paramKey] = rawValue;
      }

      const isEnabled = existing?.enabled ?? skill.defaultEnabled;
      await storage.setUserSkillConfig(chatId.toString(), skillId, isEnabled, config);
      invalidateSkillsCache(chatId);

      await bot.sendMessage(chatId, `✅ Updated *${skill.name}* — ${paramDef?.label || paramKey}: ${rawValue}`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚙️ More Options", callback_data: `skills:config:${skillId}` }],
            [{ text: `« Back to ${skill.category}`, callback_data: `skills:cat:${skill.category}` }],
          ],
        },
      });
      return;
    }

    return;
  }

  if (data === "action:aster") {
    await handleAsterMenu(chatId);
    return;
  }

  if (data.startsWith("aster:")) {
    await handleAsterCallback(chatId, data);
    return;
  }

  if (data === "action:okxsignals") {
    await bot.sendMessage(chatId,
      "🐋 *Smart Money Signals*\n\nSelect signal type:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🐋 Whale Buys", callback_data: "okxsig:whale" }],
            [{ text: "🎤 KOL Buys", callback_data: "okxsig:kol" }],
            [{ text: "💰 Smart Money", callback_data: "okxsig:smart" }],
            [{ text: "🏆 Leaderboard", callback_data: "okxsig:leaderboard" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxsig:") && !data.includes(":chain:")) {
    const sigType = data.replace("okxsig:", "");
    if (sigType === "leaderboard") {
      await bot.sendMessage(chatId,
        "🏆 *Leaderboard*\n\nSelect chain:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Solana", callback_data: "okxsig:leaderboard:chain:501" }, { text: "BNB Chain", callback_data: "okxsig:leaderboard:chain:56" }],
              [{ text: "Base", callback_data: "okxsig:leaderboard:chain:8453" }, { text: "Ethereum", callback_data: "okxsig:leaderboard:chain:1" }],
              [{ text: "« Back", callback_data: "action:okxsignals" }],
            ],
          },
        }
      );
      return;
    }
    await bot.sendMessage(chatId,
      `${sigType === "whale" ? "🐋" : sigType === "kol" ? "🎤" : "💰"} *${sigType === "whale" ? "Whale" : sigType === "kol" ? "KOL" : "Smart Money"} Signals*\n\nSelect chain:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Solana", callback_data: `okxsig:${sigType}:chain:501` }, { text: "BNB Chain", callback_data: `okxsig:${sigType}:chain:56` }],
            [{ text: "Base", callback_data: `okxsig:${sigType}:chain:8453` }, { text: "Ethereum", callback_data: `okxsig:${sigType}:chain:1` }],
            [{ text: "« Back", callback_data: "action:okxsignals" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxsig:") && data.includes(":chain:")) {
    const parts = data.replace("okxsig:", "").split(":chain:");
    const sigType = parts[0];
    const chain = parts[1] || "501";
    const chainLabel = chain === "501" ? "Solana" : chain === "56" ? "BNB Chain" : chain === "8453" ? "Base" : "Ethereum";

    if (sigType === "leaderboard") {
      await bot.sendMessage(chatId, `Loading leaderboard on ${chainLabel}...`);
      try {
        const result = await getLeaderboard(chain, "3", "1");
        if (result.success && result.data) {
          const entries = Array.isArray(result.data) ? result.data.slice(0, 10) : result.data?.data?.slice(0, 10) || [];
          if (entries.length === 0) {
            await bot.sendMessage(chatId, "No leaderboard data available right now.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
          } else {
            let text = `🏆 *Top Traders — ${chainLabel}*\n\n`;
            entries.forEach((e: any, i: number) => {
              const addr = e.walletAddress || e.address || "Unknown";
              const short = `${addr.substring(0, 6)}...${addr.slice(-4)}`;
              const pnl = e.realizedPnlUsd ? `$${parseFloat(e.realizedPnlUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : e.pnl ? `$${parseFloat(e.pnl).toFixed(0)}` : "N/A";
              const winRate = e.winRatePercent ? `${parseFloat(e.winRatePercent).toFixed(0)}%` : e.winRate ? `${(parseFloat(e.winRate) * 100).toFixed(0)}%` : "N/A";
              const txs = e.txs ? ` | ${Number(e.txs).toLocaleString()} txs` : "";
              text += `${i + 1}. \`${short}\` — PnL: ${pnl} | Win: ${winRate}${txs}\n`;
            });
            await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxsig:leaderboard:chain:${chain}` }], [{ text: "« Back", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
          }
        } else {
          await bot.sendMessage(chatId, `Leaderboard unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }]] } });
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }]] } });
      }
      return;
    }

    const walletTypeMap: Record<string, string> = { whale: "1", kol: "2", smart: "3" };
    const labelMap: Record<string, string> = { whale: "🐋 Whale", kol: "🎤 KOL", smart: "💰 Smart Money" };
    const wType = walletTypeMap[sigType] || "1";
    const label = labelMap[sigType] || "Smart Money";
    await bot.sendMessage(chatId, `Loading ${label} signals on ${chainLabel}...`);
    try {
      const result = await getSmartMoneySignals(chain, wType);
      if (result.success && result.data) {
        const signals = Array.isArray(result.data) ? result.data.slice(0, 8) : result.data?.data?.slice(0, 8) || [];
        if (signals.length === 0) {
          await bot.sendMessage(chatId, `No ${label} signals on ${chainLabel} right now.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxsig:${sigType}:chain:${chain}` }], [{ text: "« Back", callback_data: "action:okxsignals" }]] } });
        } else {
          let text = `${label} *Buy Signals — ${chainLabel}*\n\n`;
          signals.forEach((s: any, i: number) => {
            const tok = s.token || {};
            const name = tok.symbol || tok.name || s.tokenSymbol || s.symbol || "Unknown";
            const addr = tok.tokenAddress || s.tokenAddress || s.address || "";
            const short = addr ? `\`${addr.substring(0, 8)}...\`` : "";
            const amount = s.amountUsd ? `$${parseFloat(s.amountUsd).toFixed(0)}` : s.amount || "";
            const wallets = s.triggerWalletCount || "";
            const sold = s.soldRatioPercent ? `${s.soldRatioPercent}% sold` : "";
            const mcap = tok.marketCapUsd ? `MCap $${parseFloat(tok.marketCapUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "";
            const extras = [wallets ? `${wallets} wallets` : "", sold, mcap].filter(Boolean).join(" | ");
            text += `${i + 1}. *${name}* ${short}\n   Buy: ${amount}${extras ? `\n   ${extras}` : ""}\n\n`;
          });
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxsig:${sigType}:chain:${chain}` }], [{ text: "« Back", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        }
      } else {
        await bot.sendMessage(chatId, `${label} signals unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }]] } });
    }
    return;
  }

  if (data === "action:okxsecurity") {
    await bot.sendMessage(chatId,
      "🔒 *Security Scanner*\n\nScan a token for honeypot risks, rug-pull indicators, and contract safety.\n\nSelect chain:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "BNB Chain", callback_data: "okxscan_chain:56" }, { text: "Ethereum", callback_data: "okxscan_chain:1" }],
            [{ text: "Base", callback_data: "okxscan_chain:8453" }, { text: "XLayer", callback_data: "okxscan_chain:196" }],
            [{ text: "Solana", callback_data: "okxscan_chain:501" }, { text: "Polygon", callback_data: "okxscan_chain:137" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxscan_chain:")) {
    const chain = data.replace("okxscan_chain:", "");
    pendingOKXScan.set(chatId, { step: "address", chain });
    pendingOKXPrice.delete(chatId);
    await bot.sendMessage(chatId, "Enter the token contract address to scan (0x...):");
    return;
  }

  if (data === "action:okxtrending") {
    await bot.sendMessage(chatId,
      "🔥 *Trending & Hot Tokens*\n\nSelect view:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔥 Hot by Volume", callback_data: "okxtrend:hot:5" }],
            [{ text: "📈 Price Movers", callback_data: "okxtrend:hot:2" }],
            [{ text: "💎 By Market Cap", callback_data: "okxtrend:hot:6" }],
            [{ text: "🌊 Trending (Solana)", callback_data: "okxtrend:chain:501" }],
            [{ text: "🌊 Trending (BNB)", callback_data: "okxtrend:chain:56" }],
            [{ text: "🌊 Trending (Base)", callback_data: "okxtrend:chain:8453" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxtrend:hot:")) {
    const rankingType = data.replace("okxtrend:hot:", "");
    const labelMap: Record<string, string> = { "2": "📈 Price Movers", "5": "🔥 Hot by Volume", "6": "💎 By Market Cap" };
    const label = labelMap[rankingType] || "Hot Tokens";
    await bot.sendMessage(chatId, `Loading ${label}...`);
    try {
      const result = await getHotTokens(rankingType);
      if (result.success && result.data) {
        const tokens = Array.isArray(result.data) ? result.data.slice(0, 10) : result.data?.data?.slice(0, 10) || [];
        if (tokens.length === 0) {
          await bot.sendMessage(chatId, "No data available.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
        } else {
          let text = `${label}\n\n`;
          tokens.forEach((t: any, i: number) => {
            const name = t.tokenSymbol || t.symbol || "Unknown";
            const price = t.price ? `$${parseFloat(t.price) < 0.01 ? parseFloat(t.price).toExponential(2) : parseFloat(t.price).toFixed(4)}` : "";
            const change = t.change ?? t.priceChange24h ?? t.priceChange;
            const changeStr = change ? ` (${parseFloat(change) >= 0 ? "+" : ""}${parseFloat(change).toFixed(1)}%)` : "";
            const vol = t.volume || t.volume24h;
            const volStr = vol ? ` | Vol: $${(parseFloat(vol) / 1e6).toFixed(1)}M` : "";
            text += `${i + 1}. *${name}* — ${price}${changeStr}${volStr}\n`;
          });
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxtrend:hot:${rankingType}` }], [{ text: "« Back", callback_data: "action:okxtrending" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        }
      } else {
        await bot.sendMessage(chatId, `Unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
    }
    return;
  }

  if (data.startsWith("okxtrend:chain:")) {
    const chain = data.replace("okxtrend:chain:", "");
    const chainLabel = chain === "501" ? "Solana" : chain === "56" ? "BNB Chain" : chain === "8453" ? "Base" : chain;
    await bot.sendMessage(chatId, `Loading trending on ${chainLabel}...`);
    try {
      const result = await getTrendingTokens(chain);
      if (result.success && result.data) {
        const tokens = Array.isArray(result.data) ? result.data.slice(0, 10) : result.data?.data?.slice(0, 10) || [];
        if (tokens.length === 0) {
          await bot.sendMessage(chatId, `No trending tokens on ${chainLabel} right now.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
        } else {
          let text = `🌊 *Trending on ${chainLabel}*\n\n`;
          tokens.forEach((t: any, i: number) => {
            const name = t.tokenSymbol || t.symbol || "Unknown";
            const price = t.price ? `$${parseFloat(t.price) < 0.01 ? parseFloat(t.price).toExponential(2) : parseFloat(t.price).toFixed(4)}` : "";
            const change = t.change ?? t.priceChange24h ?? t.priceChange;
            const changeStr = change ? ` (${parseFloat(change) >= 0 ? "+" : ""}${parseFloat(change).toFixed(1)}%)` : "";
            const vol = t.volume || t.volume24h;
            const volStr = vol ? ` | Vol: $${(parseFloat(vol) / 1e6).toFixed(1)}M` : "";
            text += `${i + 1}. *${name}* — ${price}${changeStr}${volStr}\n`;
          });
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxtrend:chain:${chain}` }], [{ text: "« Back", callback_data: "action:okxtrending" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        }
      } else {
        await bot.sendMessage(chatId, `Unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
    }
    return;
  }

  if (data === "action:okxmeme") {
    await bot.sendMessage(chatId,
      "🐸 *Meme Token Scanner*\n\nScan new meme token launches for alpha.\n\nSelect filter:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🆕 New Launches", callback_data: "okxmeme:NEW" }],
            [{ text: "🔄 Migrating", callback_data: "okxmeme:MIGRATING" }],
            [{ text: "🎓 Migrated", callback_data: "okxmeme:MIGRATED" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxmeme:")) {
    const stage = data.replace("okxmeme:", "");
    const stageLabel = stage === "NEW" ? "🆕 New" : stage === "MIGRATED" ? "🎓 Migrated" : "🔄 Migrating";
    await bot.sendMessage(chatId, `Loading ${stageLabel} meme tokens...`);
    try {
      const result = await getMemeTokens("501", stage);
      if (result.success && result.data) {
        const tokens = Array.isArray(result.data) ? result.data.slice(0, 8) : result.data?.data?.slice(0, 8) || [];
        if (tokens.length === 0) {
          await bot.sendMessage(chatId, `No ${stageLabel} tokens found.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxmeme" }]] } });
        } else {
          let text = `🐸 *Meme Tokens — ${stageLabel}*\n\n`;
          tokens.forEach((t: any, i: number) => {
            const name = t.symbol || t.tokenSymbol || t.name || "Unknown";
            const addr = t.tokenAddress || t.address || "";
            const short = addr ? `\`${addr.substring(0, 8)}...\`` : "";
            const mkt = t.market || {};
            const mcapVal = mkt.marketCapUsd || t.marketCap || "";
            const mcap = mcapVal ? `MC: $${(parseFloat(mcapVal) / 1e3).toFixed(0)}K` : "";
            const tags = t.tags || {};
            const holders = tags.totalHolders || t.holderCount || t.holders || "";
            const holdersStr = holders ? ` | ${holders} holders` : "";
            const bonding = t.bondingPercent ? ` | ${t.bondingPercent}% bonded` : "";
            const social = t.social || {};
            const hasX = social.x ? " 🐦" : "";
            const hasTg = social.telegram ? " 📱" : "";
            text += `${i + 1}. *${name}*${hasX}${hasTg} ${short}\n   ${mcap}${holdersStr}${bonding}\n\n`;
          });
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxmeme:${stage}` }], [{ text: "« Back", callback_data: "action:okxmeme" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        }
      } else {
        await bot.sendMessage(chatId, `Unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxmeme" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxmeme" }]] } });
    }
    return;
  }

  if (data === "action:okxprice") {
    await bot.sendMessage(chatId,
      "📊 *Token Price Lookup*\n\nSelect chain, then enter the token address:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "BNB Chain", callback_data: "okxprice_chain:56" }, { text: "Ethereum", callback_data: "okxprice_chain:1" }],
            [{ text: "Base", callback_data: "okxprice_chain:8453" }, { text: "XLayer", callback_data: "okxprice_chain:196" }],
            [{ text: "Solana", callback_data: "okxprice_chain:501" }, { text: "Polygon", callback_data: "okxprice_chain:137" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxprice_chain:")) {
    const chain = data.replace("okxprice_chain:", "");
    pendingOKXPrice.set(chatId, { step: "address", chain });
    pendingOKXScan.delete(chatId);
    await bot.sendMessage(chatId, "Enter the token contract address (0x...):");
    return;
  }

  if (data === "action:okxgas") {
    await bot.sendMessage(chatId,
      "⛽ *Gas Prices*\n\nSelect chain:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "BNB Chain", callback_data: "okxgas:56" }, { text: "Ethereum", callback_data: "okxgas:1" }],
            [{ text: "Base", callback_data: "okxgas:8453" }, { text: "XLayer", callback_data: "okxgas:196" }],
            [{ text: "Polygon", callback_data: "okxgas:137" }, { text: "Arbitrum", callback_data: "okxgas:42161" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxgas:")) {
    const chain = data.replace("okxgas:", "");
    const chainNames: Record<string, string> = { "56": "BNB Chain", "1": "Ethereum", "8453": "Base", "196": "XLayer", "137": "Polygon", "42161": "Arbitrum" };
    const chainName = chainNames[chain] || chain;
    await bot.sendMessage(chatId, `Loading gas prices for ${chainName}...`);
    try {
      const result = await getGasPrice(chain);
      if (result.success && result.data) {
        const gas = result.data;
        let text = `⛽ *Gas Prices — ${chainName}*\n\n`;
        if (gas.gasPrice) text += `Gas Price: ${gas.gasPrice} Gwei\n`;
        if (gas.baseFee) text += `Base Fee: ${gas.baseFee} Gwei\n`;
        if (gas.priorityFee) text += `Priority Fee: ${gas.priorityFee} Gwei\n`;
        if (gas.slow) text += `🐢 Slow: ${gas.slow} Gwei\n`;
        if (gas.standard) text += `🚗 Standard: ${gas.standard} Gwei\n`;
        if (gas.fast) text += `🚀 Fast: ${gas.fast} Gwei\n`;
        if (gas.instant) text += `⚡ Instant: ${gas.instant} Gwei\n`;
        if (text.endsWith("\n\n")) text += "Gas data not available for this chain.";
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxgas:${chain}` }], [{ text: "« Back", callback_data: "action:okxgas" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, `Gas data unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxgas" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxgas" }]] } });
    }
    return;
  }

  if (data === "action:menu") {
    await bot.sendMessage(chatId, "What would you like to do?", {
      reply_markup: mainMenuKeyboard()
    });
    return;
  }

  if (data.startsWith("model:")) {
    const state = pendingAgentCreation.get(chatId);
    if (!state || state.step !== "model") return;
    const modelId = data.split(":")[1];
    const modelMap: Record<string, string> = {
      "llama": "meta-llama/Llama-3.1-70B-Instruct",
      "deepseek": "deepseek-ai/DeepSeek-V3",
      "qwen": "Qwen/Qwen2.5-72B-Instruct",
    };
    const model = modelMap[modelId];
    if (!model) return;
    await createAgent(chatId, state.name!, state.bio || "", model);
    return;
  }

  if (data.startsWith("taskagent:")) {
    const agentId = data.split(":")[1];
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      await bot.sendMessage(chatId, "Agent not found.");
      return;
    }
    await bot.sendMessage(chatId, `${agent.name} selected. What type of task?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Research", callback_data: `tasktype:${agentId}:research` }, { text: "Analysis", callback_data: `tasktype:${agentId}:analysis` }],
          [{ text: "Content", callback_data: `tasktype:${agentId}:content` }, { text: "Strategy", callback_data: `tasktype:${agentId}:strategy` }],
          [{ text: "Code Review", callback_data: `tasktype:${agentId}:code_review` }, { text: "General", callback_data: `tasktype:${agentId}:general` }],
          [{ text: "🚀 Launch Token", callback_data: `launchagent:${agentId}` }],
        ]
      }
    });
    return;
  }

  if (data.startsWith("tasktype:")) {
    const parts = data.split(":");
    const agentId = parts[1];
    const taskType = parts[2];
    const agent = await storage.getAgent(agentId);
    if (!agent) return;

    pendingAgentCreation.delete(chatId);
    pendingTask.set(chatId, { step: "describe", agentId, taskType, agentName: agent.name });

    const placeholders: Record<string, string> = {
      research: "Example: Analyze the current state of restaking on Ethereum — key protocols, TVL trends, risks.",
      analysis: "Example: Compare BNB Chain vs Base vs Solana DEX volume trends over the last 30 days.",
      content: "Example: Write a tweet thread explaining why autonomous AI agents are the next frontier in DeFi.",
      strategy: "Example: Create a go-to-market strategy for launching an AI agent marketplace.",
      code_review: "Example: Review this Solidity function for security issues and gas optimization.",
      general: "Example: Summarize the top 5 AI x Crypto developments this week.",
    };

    await bot.sendMessage(chatId,
      `${agent.name} | ${taskType}\n\nDescribe what you need. Just type it out:\n\n${placeholders[taskType] || ""}`,
    );
    return;
  }

  if (data.startsWith("viewtask:")) {
    const taskId = data.split(":")[1];
    if (wallet) await handleTaskStatus(chatId, taskId, wallet);
    return;
  }

  if (data.startsWith("agenttask:")) {
    const agentId = data.split(":")[1];
    const agent = await storage.getAgent(agentId);
    if (agent) {
      await bot.sendMessage(chatId, `What type of task for ${agent.name}?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Research", callback_data: `tasktype:${agentId}:research` }, { text: "Analysis", callback_data: `tasktype:${agentId}:analysis` }],
            [{ text: "Content", callback_data: `tasktype:${agentId}:content` }, { text: "Strategy", callback_data: `tasktype:${agentId}:strategy` }],
            [{ text: "Code Review", callback_data: `tasktype:${agentId}:code_review` }, { text: "General", callback_data: `tasktype:${agentId}:general` }],
            [{ text: "🚀 Launch Token", callback_data: `launchagent:${agentId}` }],
          ]
        }
      });
    }
    return;
  }

  if (data.startsWith("launchagent:")) {
    const agentId = data.split(":")[1];
    const agent = await storage.getAgent(agentId);
    if (!agent) { await bot.sendMessage(chatId, "Agent not found."); return; }

    pendingAgentCreation.delete(chatId);
    pendingTask.delete(chatId);
    pendingTokenLaunch.set(chatId, { step: "platform", agentId, agentName: agent.name });

    await bot.sendMessage(chatId,
      `🚀 Launch a token with ${agent.name}\n\nPick a launchpad:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Four.meme (BNB Chain)", callback_data: `launchplatform:${agentId}:four_meme` }],
            [{ text: "Flap.sh (BNB Chain)", callback_data: `launchplatform:${agentId}:flap_sh` }],
            [{ text: "XLayer (OKX)", callback_data: `launchplatform:${agentId}:xlayer` }],
            [{ text: "Bankr (Base/Solana)", callback_data: `launchplatform:${agentId}:bankr` }],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
    return;
  }

  if (data.startsWith("launchplatform:")) {
    const parts = data.split(":");
    const agentId = parts[1];
    const platform = parts[2];
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId) return;
    if (platform !== "four_meme" && platform !== "flap_sh" && platform !== "bankr" && platform !== "xlayer") {
      await bot.sendMessage(chatId, "Invalid platform. Please try again.");
      return;
    }

    state.platform = platform;

    if (platform === "bankr") {
      state.step = "bankr_chain";
      pendingTokenLaunch.set(chatId, state);
      await bot.sendMessage(chatId,
        `🏦 Bankr — Choose a chain for your token:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Base (EVM)", callback_data: `bankrchain:${agentId}:base` }],
              [{ text: "Solana", callback_data: `bankrchain:${agentId}:solana` }],
              [{ text: "Cancel", callback_data: "action:menu" }],
            ]
          }
        }
      );
      return;
    }

    state.step = "name";
    pendingTokenLaunch.set(chatId, state);

    const platformName = platform === "four_meme" ? "Four.meme (BNB Chain)" : platform === "xlayer" ? "XLayer (OKX)" : "Flap.sh (BNB Chain)";
    await bot.sendMessage(chatId,
      `Platform: ${platformName}\n\nWhat's the token name? (1-50 chars)\n\nExample: DogeBrain, MoonCat, AgentX`
    );
    return;
  }

  if (data.startsWith("bankrchain:")) {
    const parts = data.split(":");
    const agentId = parts[1];
    const chain = parts[2] as "base" | "solana";
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId || state.step !== "bankr_chain") return;

    state.bankrChain = chain;
    state.step = "name";
    pendingTokenLaunch.set(chatId, state);

    const chainLabel = chain === "solana" ? "Solana" : "Base";
    await bot.sendMessage(chatId,
      `Platform: Bankr (${chainLabel})\n\nWhat's the token name? (1-50 chars)\n\nExample: DogeBrain, MoonCat, AgentX`
    );
    return;
  }

  if (data.startsWith("launchconfirm:")) {
    const agentId = data.split(":")[1];
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId || !wallet) return;

    if (!state.platform || !state.tokenName || !state.tokenSymbol) {
      pendingTokenLaunch.delete(chatId);
      await bot.sendMessage(chatId, "Missing token details. Please start again.", {
        reply_markup: { inline_keyboard: [[{ text: "🚀 Launch Token", callback_data: "action:launchtoken" }]] }
      });
      return;
    }

    pendingTokenLaunch.delete(chatId);
    await executeTelegramTokenLaunch(chatId, wallet, state);
    return;
  }

  if (data.startsWith("launchcancel:")) {
    pendingTokenLaunch.delete(chatId);
    await bot.sendMessage(chatId, "Token launch cancelled.", {
      reply_markup: mainMenuKeyboard()
    });
    return;
  }

  if (data.startsWith("launchtax:")) {
    const taxVal = parseInt(data.split(":")[1], 10);
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.step !== "tax") return;
    state.taxRate = taxVal;
    showLaunchPreview(chatId, state);
    return;
  }

  if (data.startsWith("chaos_")) {
    await handleChaosPlanCallback(chatId, data);
    return;
  }

  if (data.startsWith("proposal_approve:")) {
    const proposalId = data.split(":")[1];
    await handleProposalApproval(chatId, proposalId, true);
    return;
  }

  if (data.startsWith("proposal_reject:")) {
    const proposalId = data.split(":")[1];
    await handleProposalApproval(chatId, proposalId, false);
    return;
  }

  if (data.startsWith("fmbuy:")) {
    const tokenAddress = data.split(":")[1];
    const wallet = getLinkedWallet(chatId);
    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "Import a wallet with a private key first (/linkwallet).");
      return;
    }
    pendingFourMemeBuy.set(chatId, { step: "amount", tokenAddress });
    await bot.sendMessage(chatId,
      `How much BNB do you want to spend?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "0.01 BNB", callback_data: `fmbuyamt:0.01:${tokenAddress}` },
              { text: "0.05 BNB", callback_data: `fmbuyamt:0.05:${tokenAddress}` },
              { text: "0.1 BNB", callback_data: `fmbuyamt:0.1:${tokenAddress}` },
            ],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
    return;
  }

  if (data.startsWith("fmbuyamt:")) {
    const parts = data.split(":");
    const amount = parts[1];
    const tokenAddress = parts[2];
    const state: FourMemeBuyState = { step: "amount", tokenAddress, bnbAmount: amount };
    pendingFourMemeBuy.set(chatId, state);
    await executeFourMemeBuyConfirm(chatId, state);
    return;
  }

  if (data.startsWith("fmbuyconfirm:")) {
    const tokenAddress = data.split(":")[1];
    const state = pendingFourMemeBuy.get(chatId);
    if (!state || !state.bnbAmount) {
      await bot.sendMessage(chatId, "Buy session expired. Use /buy to start again.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    pendingFourMemeBuy.delete(chatId);

    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;

    const userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
    if (!userPk) {
      await bot.sendMessage(chatId, "Could not access wallet keys. Try /start to create a fresh wallet.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    await bot.sendMessage(chatId, `💰 Buying with ${state.bnbAmount} BNB...\nThis may take a minute.`);
    await bot.sendChatAction(chatId, "typing");

    const { fourMemeBuyToken } = await import("./token-launcher");
    const result = await fourMemeBuyToken(tokenAddress, state.bnbAmount, 5, userPk);

    if (result.success) {
      await bot.sendMessage(chatId,
        `✅ Buy successful!\n\nTx: https://bscscan.com/tx/${result.txHash}\n\nView token: https://four.meme/token/${tokenAddress}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📈 Token Info", callback_data: `fminfo:${tokenAddress}` }],
              [{ text: "◀️ Menu", callback_data: "action:menu" }],
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(chatId, `❌ Buy failed: ${result.error?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  if (data.startsWith("fmsell:")) {
    const tokenAddress = data.split(":")[1];
    const wallet = getLinkedWallet(chatId);
    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "Import a wallet with a private key first (/linkwallet).");
      return;
    }
    pendingFourMemeSell.set(chatId, { step: "amount", tokenAddress });
    await showSellAmountPrompt(chatId, tokenAddress);
    return;
  }

  if (data.startsWith("fmsellpct:")) {
    const parts = data.split(":");
    const pct = parseInt(parts[1]);
    const tokenAddress = parts[2];
    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;

    try {
      const { fourMemeGetTokenBalance } = await import("./token-launcher");
      const balInfo = await Promise.race([
        fourMemeGetTokenBalance(tokenAddress, wallet),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Balance check timed out. Try again.")), 30000)),
      ]);
      const bal = parseFloat(balInfo.balance);
      const sellAmount = (bal * pct / 100).toString();

      const state: FourMemeSellState = { step: "amount", tokenAddress, tokenAmount: sellAmount, tokenSymbol: balInfo.symbol };
      pendingFourMemeSell.set(chatId, state);
      await executeFourMemeSellConfirm(chatId, state);
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed: ${e.message?.substring(0, 100)}`, { reply_markup: mainMenuKeyboard() });
      pendingFourMemeSell.delete(chatId);
    }
    return;
  }

  if (data.startsWith("fmsellconfirm:")) {
    const tokenAddress = data.split(":")[1];
    const state = pendingFourMemeSell.get(chatId);
    if (!state || !state.tokenAmount) {
      await bot.sendMessage(chatId, "Sell session expired. Use /sell to start again.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    pendingFourMemeSell.delete(chatId);

    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;

    const userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
    if (!userPk) {
      await bot.sendMessage(chatId, "Could not access wallet keys. Try /start to create a fresh wallet.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    await bot.sendMessage(chatId, `💸 Selling ${state.tokenAmount} ${state.tokenSymbol || "tokens"}...\nThis may take a minute.`);
    await bot.sendChatAction(chatId, "typing");

    const { fourMemeSellToken } = await import("./token-launcher");
    const result = await fourMemeSellToken(tokenAddress, state.tokenAmount, userPk);

    if (result.success) {
      await bot.sendMessage(chatId,
        `✅ Sell successful!\n\nTx: https://bscscan.com/tx/${result.txHash}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📈 Token Info", callback_data: `fminfo:${tokenAddress}` }],
              [{ text: "◀️ Menu", callback_data: "action:menu" }],
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(chatId, `❌ Sell failed: ${result.error?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  if (data.startsWith("fminfo:")) {
    const tokenAddress = data.split(":")[1];
    await handleTokenInfo(chatId, tokenAddress);
    return;
  }
}

async function handleMessage(msg: TelegramBot.Message): Promise<void> {
  if (!bot) return;

  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const isGroup = chatType === "group" || chatType === "supergroup";
  const username = msg.from?.username || msg.from?.first_name || "user";

  if (!checkRateLimit(`tg_msg:${chatId}`, 30, 60000)) {
    return;
  }

  if ((msg as any).web_app_data) {
    try {
      const data = JSON.parse((msg as any).web_app_data.data);
      if (data.wallet && /^0x[a-fA-F0-9]{40}$/i.test(data.wallet)) {
        const addr = data.wallet.toLowerCase();
        linkTelegramWallet(chatId, addr);
        pendingWallet.delete(chatId);
        pendingImportWallet.delete(chatId);
        return;
      }
    } catch (e: any) {
      console.error("[TelegramBot] web_app_data parse error:", e.message);
    }
    return;
  }

  const logoState = pendingTokenLaunch.get(chatId);
  if (logoState && logoState.step === "logo") {
    let fileId: string | null = null;
    let fileSize: number | undefined;

    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      fileId = photo.file_id;
      fileSize = photo.file_size;
    } else if (msg.document && msg.document.mime_type?.startsWith("image/")) {
      fileId = msg.document.file_id;
      fileSize = msg.document.file_size;
    } else if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
      fileId = msg.sticker.file_id;
      fileSize = msg.sticker.file_size;
    }

    if (fileId) {
      if (fileSize && fileSize > 5 * 1024 * 1024) {
        await bot.sendMessage(chatId, "⚠️ Image too large (max 5MB). Send a smaller image or type \"skip\".");
        return;
      }

      const SUPPORTED_FORMATS: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        svg: "image/svg+xml",
        tiff: "image/tiff",
        tif: "image/tiff",
        ico: "image/x-icon",
        avif: "image/avif",
      };

      const docMime = msg.document?.mime_type || (msg.sticker ? "image/webp" : null);

      try {
        const fileInfo = await bot.getFile(fileId);
        if (fileInfo.file_path) {
          const MIME_TO_EXT: Record<string, string> = {
            "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
            "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
            "image/tiff": "tiff", "image/x-icon": "ico", "image/avif": "avif",
          };

          let ext: string;
          if (docMime && MIME_TO_EXT[docMime]) {
            ext = MIME_TO_EXT[docMime];
          } else {
            const rawExt = (fileInfo.file_path.split(".").pop() || "").toLowerCase();
            ext = rawExt in SUPPORTED_FORMATS ? rawExt : "png";
          }
          const mimeType = SUPPORTED_FORMATS[ext] || "image/png";

          const telegramFileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
          const imageResp = await fetch(telegramFileUrl);
          if (imageResp.ok) {
            let imageBuffer = Buffer.from(await imageResp.arrayBuffer());

            const needsConvert = ["webp", "bmp", "tiff", "tif", "svg", "ico", "avif"].includes(ext);
            let uploadExt = ext;
            let uploadMime = mimeType;

            if (needsConvert) {
              try {
                const sharp = (await import("sharp")).default;
                imageBuffer = await sharp(imageBuffer).png().toBuffer();
                uploadExt = "png";
                uploadMime = "image/png";
              } catch (convErr: any) {
                console.error(`[TelegramBot] Image conversion from ${ext} failed:`, convErr.message);
                await bot.sendMessage(chatId, `⚠️ Could not convert ${ext.toUpperCase()} image. Continuing without custom logo.`);
                logoState.step = "links";
                pendingTokenLaunch.set(chatId, logoState);
                await bot.sendMessage(chatId,
                  `🔗 Social links (optional):\n\nSend links in this format:\n` +
                  `website: https://yoursite.com\ntwitter: https://x.com/yourtoken\ntelegram: https://t.me/yourgroup\n\n` +
                  `You can include one, two, or all three. Or type "skip" to continue without links.`,
                );
                return;
              }
            }

            const formData = new FormData();
            const blob = new Blob([imageBuffer], { type: uploadMime });
            formData.append("file", blob, `logo.${uploadExt}`);

            const uploadRes = await fetch("https://four.meme/meme-api/meme/image/upload", {
              method: "POST",
              body: formData,
            });
            if (!uploadRes.ok) {
              await bot.sendMessage(chatId, `⚠️ Logo upload failed (HTTP ${uploadRes.status}). Continuing without custom logo.`);
            } else {
              const uploadJson = await uploadRes.json();
              if (uploadJson.msg === "success" && uploadJson.data?.imageUrl) {
                logoState.imageUrl = uploadJson.data.imageUrl;
                await bot.sendMessage(chatId, `✅ Logo uploaded successfully! (${ext.toUpperCase()} format)`);
              } else {
                await bot.sendMessage(chatId, `⚠️ Logo upload failed, using auto-generated logo. Continuing...`);
              }
            }
          }
        }
      } catch (e: any) {
        console.error("[TelegramBot] Logo upload error:", e.message);
        await bot.sendMessage(chatId, `⚠️ Could not process image. Continuing without custom logo.`);
      }

      logoState.step = "links";
      pendingTokenLaunch.set(chatId, logoState);

      await bot.sendMessage(chatId,
        `🔗 Social links (optional):\n\nSend links in this format:\n` +
        `website: https://yoursite.com\n` +
        `twitter: https://x.com/yourtoken\n` +
        `telegram: https://t.me/yourgroup\n\n` +
        `You can include one, two, or all three. Or type "skip" to continue without links.`,
      );
      return;
    }
  }

  if (!msg.text) return;
  const text = msg.text.trim();

  await ensureWalletsLoaded(chatId);

  console.log(`[TelegramBot] ${isGroup ? "Group" : "DM"} message from @${username} (chatId: ${chatId}): ${text.slice(0, 80)}`);


  if (pendingImportWallet.has(chatId) && !text.startsWith("/")) {
    await handleImportWalletFlow(chatId, text);
    return;
  }
  if (pendingAgentCreation.has(chatId) && !text.startsWith("/")) {
    await handleAgentCreationFlow(chatId, text);
    return;
  }
  if (pendingTokenLaunch.has(chatId) && !text.startsWith("/")) {
    await handleTokenLaunchFlow(chatId, text);
    return;
  }
  if (pendingFourMemeBuy.has(chatId) && !text.startsWith("/")) {
    await handleFourMemeBuyFlow(chatId, text);
    return;
  }
  if (pendingFourMemeSell.has(chatId) && !text.startsWith("/")) {
    await handleFourMemeSellFlow(chatId, text);
    return;
  }
  if (pendingTask.has(chatId) && !text.startsWith("/")) {
    await handleTaskFlow(chatId, text);
    return;
  }
  if (pendingChaosPlan.has(chatId) && !text.startsWith("/")) {
    await handleChaosPlanFlow(chatId, text);
    return;
  }
  if (pendingAsterConnect.has(chatId) && !text.startsWith("/")) {
    await handleAsterConnectFlow(chatId, text);
    return;
  }
  if (pendingAsterTrade.has(chatId) && !text.startsWith("/")) {
    await handleAsterTradeFlow(chatId, text);
    return;
  }
  if (pendingOKXSwap.has(chatId) && !text.startsWith("/")) {
    await handleOKXSwapFlow(chatId, text);
    return;
  }
  if (pendingOKXBridge.has(chatId) && !text.startsWith("/")) {
    await handleOKXBridgeFlow(chatId, text);
    return;
  }
  if (pendingOKXScan.has(chatId) && !text.startsWith("/")) {
    const state = pendingOKXScan.get(chatId)!;
    pendingOKXScan.delete(chatId);
    const addr = text.trim();
    if (!addr.startsWith("0x") && addr.length < 30) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid contract address (0x...).", { reply_markup: { inline_keyboard: [[{ text: "🔒 Try Again", callback_data: "action:okxsecurity" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    await bot.sendMessage(chatId, `🔒 Scanning token \`${addr.substring(0, 12)}...\` for risks...`, { parse_mode: "Markdown" });
    try {
      const result = await executeSecurityScan(addr, state.chain || "56");
      if (result.success && result.data) {
        const d = result.data;
        let text = "🔒 *Security Scan Results*\n\n";
        text += `Address: \`${addr}\`\n\n`;
        if (d.isHoneypot !== undefined) text += `Honeypot: ${d.isHoneypot ? "⚠️ YES" : "✅ No"}\n`;
        if (d.riskLevel) text += `Risk Level: ${d.riskLevel === "high" ? "🔴 HIGH" : d.riskLevel === "medium" ? "🟡 MEDIUM" : "🟢 LOW"}\n`;
        if (d.buyTax) text += `Buy Tax: ${d.buyTax}%\n`;
        if (d.sellTax) text += `Sell Tax: ${d.sellTax}%\n`;
        if (d.isOpenSource !== undefined) text += `Open Source: ${d.isOpenSource ? "✅" : "❌"}\n`;
        if (d.isProxy !== undefined) text += `Proxy Contract: ${d.isProxy ? "⚠️ Yes" : "✅ No"}\n`;
        if (d.ownerCanMint !== undefined) text += `Can Mint: ${d.ownerCanMint ? "⚠️ Yes" : "✅ No"}\n`;
        if (d.risks && d.risks.length > 0) {
          text += `\nRisks:\n`;
          d.risks.slice(0, 5).forEach((r: string) => { text += `• ${r}\n`; });
        }
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔒 Scan Another", callback_data: "action:okxsecurity" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, `Scan failed: ${result.error || "try again"}`, { reply_markup: { inline_keyboard: [[{ text: "🔒 Try Again", callback_data: "action:okxsecurity" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }
  if (pendingOKXPrice.has(chatId) && !text.startsWith("/")) {
    const state = pendingOKXPrice.get(chatId)!;
    pendingOKXPrice.delete(chatId);
    const addr = text.trim();
    if (!addr.startsWith("0x") && addr.length < 30) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid contract address.", { reply_markup: { inline_keyboard: [[{ text: "📊 Try Again", callback_data: "action:okxprice" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    await bot.sendMessage(chatId, `📊 Looking up price for \`${addr.substring(0, 12)}...\``, { parse_mode: "Markdown" });
    try {
      const result = await getTokenPrice(addr, state.chain || "56");
      if (result.success && result.data) {
        const d = result.data;
        let text = "📊 *Token Price*\n\n";
        text += `Address: \`${addr}\`\n\n`;
        if (d.price) text += `Price: $${parseFloat(d.price) < 0.01 ? parseFloat(d.price).toExponential(3) : parseFloat(d.price).toFixed(6)}\n`;
        if (d.priceChange24h) text += `24h Change: ${parseFloat(d.priceChange24h) >= 0 ? "+" : ""}${(parseFloat(d.priceChange24h) * 100).toFixed(2)}%\n`;
        if (d.volume24h) text += `24h Volume: $${(parseFloat(d.volume24h) / 1e6).toFixed(2)}M\n`;
        if (d.marketCap) text += `Market Cap: $${(parseFloat(d.marketCap) / 1e6).toFixed(2)}M\n`;
        if (d.liquidity) text += `Liquidity: $${(parseFloat(d.liquidity) / 1e3).toFixed(0)}K\n`;
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "📊 Another Token", callback_data: "action:okxprice" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, `Price lookup failed: ${result.error || "token not found"}`, { reply_markup: { inline_keyboard: [[{ text: "📊 Try Again", callback_data: "action:okxprice" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  const commandMatch = text.match(/^\/(\w+)(?:@\S+)?\s*(.*)/s);
  if (commandMatch) {
    const cmd = commandMatch[1].toLowerCase();
    const cmdArg = commandMatch[2]?.trim() || "";

    pendingAgentCreation.delete(chatId);
    pendingTask.delete(chatId);
    pendingTokenLaunch.delete(chatId);
    pendingFourMemeBuy.delete(chatId);
    pendingFourMemeSell.delete(chatId);
    pendingWallet.delete(chatId);
    pendingImportWallet.delete(chatId);
    pendingAsterConnect.delete(chatId);
    pendingAsterTrade.delete(chatId);
    pendingOKXSwap.delete(chatId);
    pendingOKXBridge.delete(chatId);
    pendingOKXScan.delete(chatId);
    pendingOKXPrice.delete(chatId);

    if (cmd === "start" && !isGroup) {
      let wallet = getLinkedWallet(chatId);
      if (!wallet) {
        await bot.sendMessage(chatId,
          `Welcome to BUILD4\n\n` +
          `Launch tokens, create AI agents, and operate on-chain — all from Telegram.\n\n` +
          `Setting up your wallet...`
        );
        wallet = await autoGenerateWallet(chatId);
        await bot.sendMessage(chatId,
          `✅ You're all set!\n\n` +
          `What do you want to do?`,
          { reply_markup: mainMenuKeyboard() }
        );
      } else {
        await bot.sendMessage(chatId,
          `Welcome back!\n\n` +
          `👛 Wallet: ${shortWallet(wallet)}\n\n` +
          `What do you want to do?`,
          { reply_markup: mainMenuKeyboard() }
        );
      }
      return;
    }

    if (cmd === "cancel") {
      pendingChaosPlan.delete(chatId);
      pendingAsterConnect.delete(chatId);
      pendingAsterTrade.delete(chatId);
      await bot.sendMessage(chatId, "Cancelled.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (cmd === "mychatid") {
      const label = isGroup ? "This group's Chat ID" : "Your Chat ID";
      await bot.sendMessage(chatId, `${label}: ${chatId}\n\nPaste this into your agent's Twitter settings for strategy notifications.`);
      return;
    }

    if (cmd === "agentstatus") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to check agent status!"); return; }
      await ensureWallet(chatId);
      const wallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);
      const walletAddr = wallets[activeIdx];
      if (!walletAddr) {
        await bot.sendMessage(chatId, "No wallet found. Use /wallet to set one up first.");
        return;
      }

      await bot.sendMessage(chatId, "Checking ERC-8004 agent registration...");

      try {
        const { isAgentRegistered, ERC8004_IDENTITY_REGISTRY_BSC } = await import("./token-launcher");
        const registered = await isAgentRegistered(walletAddr);

        if (registered) {
          await bot.sendMessage(chatId,
            "✅ AI Agent Badge: ACTIVE\n\n" +
            `Wallet: ${walletAddr.substring(0, 8)}...${walletAddr.slice(-6)}\n` +
            `Registry: ERC-8004 on BSC\n` +
            `Contract: ${ERC8004_IDENTITY_REGISTRY_BSC.substring(0, 10)}...\n\n` +
            "Your tokens launched on Four.meme will show the AI Agent icon on GMGN and other trackers.",
            { reply_markup: mainMenuKeyboard() }
          );
        } else {
          await bot.sendMessage(chatId,
            "❌ AI Agent Badge: NOT REGISTERED\n\n" +
            `Wallet: ${walletAddr.substring(0, 8)}...${walletAddr.slice(-6)}\n\n` +
            "Your wallet is not registered on the ERC-8004 Identity Registry. " +
            "When you launch a token, we'll auto-register your wallet so it gets the AI Agent badge on GMGN.\n\n" +
            "Want to register now? It costs a small gas fee (~0.001 BNB).",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🤖 Register Now", callback_data: "erc8004_register" }],
                  [{ text: "« Back", callback_data: "main_menu" }],
                ],
              },
            }
          );
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `Error checking status: ${e.message?.substring(0, 100) || "Unknown error"}`, { reply_markup: mainMenuKeyboard() });
      }
      return;
    }

    if (cmd === "help") {
      const hasW = !!getLinkedWallet(chatId);
      await bot.sendMessage(chatId,
        "Commands:\n\n" +
        "🚀 /launch — Launch a token\n" +
        "💰 /buy — Buy tokens on Four.meme\n" +
        "💸 /sell — Sell tokens on Four.meme\n" +
        "📈 /tokeninfo — Token price & info\n" +
        "🔥 /chaos — Create a chaos plan\n" +
        "📊 /chaosstatus — Check chaos plan status\n" +
        "📈 /trade — Autonomous trading agent\n" +
        "📊 /tradestatus — Trading positions & PnL\n" +
        "🔄 /swap — OKX DEX swap (multi-chain)\n" +
        "🌉 /bridge — OKX cross-chain bridge\n" +
        "🐋 /signals — Smart money & whale signals\n" +
        "🔒 /scan — Security scanner (honeypot check)\n" +
        "🔥 /trending — Hot & trending tokens\n" +
        "🐸 /meme — Meme token scanner\n" +
        "📊 /price — Token price lookup\n" +
        "⛽ /gas — Gas prices by chain\n" +
        "📈 /aster — Aster DEX futures & spot trading\n" +
        "🤖 /newagent — Create an AI agent\n" +
        "📋 /myagents — Your agents\n" +
        "📝 /task — Assign a task\n" +
        "📊 /mytasks — Recent tasks\n" +
        "👛 /wallet — Wallet info\n" +
        "🔗 /linkwallet — Connect wallet\n" +
        "🤖 /agentstatus — AI agent badge status\n" +
        "❓ /ask <question> — Ask anything\n" +
        "🔔 /mychatid — Chat ID for notifications\n" +
        "❌ /cancel — Cancel current action\n\n" +
        "Or just type any question!",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    if (cmd === "wallet") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for wallet info!"); return; }
      await ensureWallet(chatId);
      const wallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);

      await bot.sendMessage(chatId, "Loading wallet balances...");
      const balances = await fetchWalletBalances(wallets);

      let text = `👛 Your Wallets\n\n`;
      wallets.forEach((w, i) => {
        const marker = i === activeIdx ? "✅" : "⬜";
        const bal = balances[w];
        const hasKey = walletsWithKey.has(`${chatId}:${w}`);
        const keyTag = hasKey ? "" : " 🔒 view-only";
        let balText = "";
        if (bal) {
          const parts: string[] = [];
          if (parseFloat(bal.bnb) > 0) parts.push(`${bal.bnb} BNB`);
          if (parseFloat(bal.eth) > 0) parts.push(`${bal.eth} ETH`);
          balText = parts.length > 0 ? ` (${parts.join(", ")})` : " (empty)";
        }
        text += `${marker} \`${w}\`${i === activeIdx ? " ← active" : ""}${keyTag}\n    ${balText}\n\n`;
      });
      text += `Send BNB to your active wallet address to fund it.`;

      const walletButtons: TelegramBot.InlineKeyboardButton[][] = wallets.map((w, i) => {
        if (i === activeIdx) {
          return [{ text: `📋 Copy Address`, callback_data: `copywall:${i}` }];
        }
        return [
          { text: `▶️ Use ${shortWallet(w)}`, callback_data: `switchwall:${i}` },
          { text: `🗑`, callback_data: `removewall:${i}` },
        ];
      });
      walletButtons.push([{ text: "🔑 Add Wallet", callback_data: "action:genwallet" }]);
      walletButtons.push([{ text: "◀️ Menu", callback_data: "action:menu" }]);

      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: walletButtons } });
      return;
    }

    if (cmd === "info") {
      await bot.sendMessage(chatId,
        "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\n" +
        "Agents get wallets, trade skills, evolve, replicate, and operate fully on-chain. No centralized AI — inference runs through Hyperbolic, Akash ML, and Ritual.\n\nhttps://build4.io",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    if (cmd === "chains") {
      await bot.sendMessage(chatId, "Supported Chains:\n\n- BNB Chain — ERC-8004 identity + BAP-578 NFA registry\n- XLayer — Agent economy\n\nAll on-chain.");
      return;
    }

    if (cmd === "contracts") {
      await bot.sendMessage(chatId, "4 Smart Contracts:\n\n1. AgentEconomyHub — Wallets\n2. SkillMarketplace — Skill trading\n3. AgentReplication — Forking + NFTs\n4. ConstitutionRegistry — Agent laws\n\nSolidity 0.8.24 + OpenZeppelin.");
      return;
    }

    if (cmd === "ask") {
      if (!cmdArg) {
        await bot.sendMessage(chatId, "What would you like to know? Type /ask followed by your question.");
        return;
      }
      await handleQuestion(chatId, msg.message_id, cmdArg, username);
      return;
    }

    if (cmd === "linkwallet") {
      await ensureWallet(chatId);
      await bot.sendMessage(chatId, "Your wallet is ready.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (cmd === "newagent") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to create agents!"); return; }
      await ensureWallet(chatId);
      pendingAgentCreation.set(chatId, { step: "name" });
      await bot.sendMessage(chatId, "What's your agent's name? (1-50 characters)");
      return;
    }

    if (cmd === "myagents") {
      const wallet = await ensureWallet(chatId);
      await handleMyAgents(chatId, wallet);
      return;
    }

    if (cmd === "task") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to assign tasks!"); return; }
      const wallet = await ensureWallet(chatId);
      await startTaskFlow(chatId, wallet);
      return;
    }

    if (cmd === "launch") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to launch tokens!"); return; }
      const wallet = await ensureWallet(chatId);
      await startTokenLaunchFlow(chatId, wallet);
      return;
    }

    if (cmd === "buy") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to buy tokens!"); return; }
      const wallet = await ensureWallet(chatId);
      if (!await checkWalletHasKey(chatId, wallet)) {
        await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first (/linkwallet).");
        return;
      }
      if (cmdArg && /^0x[a-fA-F0-9]{40}$/i.test(cmdArg)) {
        pendingFourMemeBuy.set(chatId, { step: "amount", tokenAddress: cmdArg.toLowerCase() });
        await bot.sendMessage(chatId, `How much BNB do you want to spend?\n\nEnter an amount (e.g. 0.01, 0.1, 1):`);
      } else {
        pendingFourMemeBuy.set(chatId, { step: "token" });
        await bot.sendMessage(chatId, "Enter the token contract address you want to buy (0x...):");
      }
      return;
    }

    if (cmd === "sell") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to sell tokens!"); return; }
      const wallet = await ensureWallet(chatId);
      if (!await checkWalletHasKey(chatId, wallet)) {
        await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first (/linkwallet).");
        return;
      }
      if (cmdArg && /^0x[a-fA-F0-9]{40}$/i.test(cmdArg)) {
        pendingFourMemeSell.set(chatId, { step: "amount", tokenAddress: cmdArg.toLowerCase() });
        await showSellAmountPrompt(chatId, cmdArg.toLowerCase());
      } else {
        pendingFourMemeSell.set(chatId, { step: "token" });
        await bot.sendMessage(chatId, "Enter the token contract address you want to sell (0x...):");
      }
      return;
    }

    if (cmd === "tokeninfo") {
      if (!cmdArg || !/^0x[a-fA-F0-9]{40}$/i.test(cmdArg)) {
        await bot.sendMessage(chatId, "Usage: /tokeninfo <token_address>\n\nExample: /tokeninfo 0x1234...abcd");
        return;
      }
      await handleTokenInfo(chatId, cmdArg);
      return;
    }

    if (cmd === "taskstatus") {
      const wallet = await ensureWallet(chatId);
      if (!cmdArg) { await bot.sendMessage(chatId, "Usage: /taskstatus <task-id>"); return; }
      await handleTaskStatus(chatId, cmdArg, wallet);
      return;
    }

    if (cmd === "mytasks") {
      const wallet = await ensureWallet(chatId);
      await handleMyTasks(chatId, wallet);
      return;
    }

    if (cmd === "chaosstatus") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for chaos plan status!"); return; }
      await ensureWallet(chatId);
      const wallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);
      const walletAddr = wallets[activeIdx];
      if (!walletAddr) {
        await bot.sendMessage(chatId, "No wallet found. Use /wallet first.", { reply_markup: mainMenuKeyboard() });
        return;
      }

      try {
        const { getUserChaosPlans } = await import("./chaos-launch");
        const plans = await getUserChaosPlans(walletAddr);

        if (plans.length === 0) {
          const { getActiveChaosPlan } = await import("./chaos-launch");
          const globalPlan = await storage.getActiveChaosPlan();
          if (globalPlan) {
            const completed = globalPlan.milestones.filter(m => m.status === "completed").length;
            const pending = globalPlan.milestones.filter(m => m.status === "pending").length;
            const failed = globalPlan.milestones.filter(m => m.status === "failed").length;
            const next = globalPlan.milestones.find(m => m.status === "pending");
            let text = `📊 *$${globalPlan.launch.tokenSymbol} Chaos Plan*\n\n`;
            text += `✅ Completed: ${completed}/${globalPlan.milestones.length}\n`;
            text += `⏳ Pending: ${pending}\n`;
            if (failed > 0) text += `❌ Failed: ${failed}\n`;
            if (next) {
              const launchTime = globalPlan.launch.createdAt ? new Date(globalPlan.launch.createdAt).getTime() : 0;
              const eta = launchTime + next.triggerAfterMinutes * 60000;
              const etaDate = new Date(eta);
              text += `\nNext: ${next.name} (${next.action})\nETA: ${etaDate.toUTCString()}`;
            }
            await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
          } else {
            await bot.sendMessage(chatId, "No active chaos plans found. Use /chaos to create one!", { reply_markup: mainMenuKeyboard() });
          }
          return;
        }

        for (const { launch, milestones } of plans) {
          const completed = milestones.filter(m => m.status === "completed").length;
          const pending = milestones.filter(m => m.status === "pending").length;
          const failed = milestones.filter(m => m.status === "failed").length;
          const next = milestones.find(m => m.status === "pending");

          let text = `📊 *$${launch.tokenSymbol} Chaos Plan*\n\n`;
          text += `✅ Completed: ${completed}/${milestones.length}\n`;
          text += `⏳ Pending: ${pending}\n`;
          if (failed > 0) text += `❌ Failed: ${failed}\n`;
          if (next) {
            const launchTime = launch.createdAt ? new Date(launch.createdAt).getTime() : 0;
            const eta = launchTime + next.triggerAfterMinutes * 60000;
            const etaDate = new Date(eta);
            text += `\nNext: ${next.name} (${next.action})\nETA: ${etaDate.toUTCString()}`;
          } else if (pending === 0) {
            text += `\n🎉 Plan complete!`;
          }

          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `Error checking status: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
      }
      return;
    }

    if (cmd === "trade") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for trading agent!"); return; }
      await ensureWallet(chatId);
      const wallet = getLinkedWallet(chatId);
      if (!await checkWalletHasKey(chatId, wallet)) {
        await bot.sendMessage(chatId, "You need a wallet with a private key to use the trading agent. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard() });
        return;
      }

      const { getUserTradingStatus } = await import("./trading-agent");
      const { config, positions } = getUserTradingStatus(chatId);
      const isEnabled = config.enabled;

      let statusLine = isEnabled
        ? `Status: ✅ ACTIVE | Open Positions: ${positions.length}`
        : `Status: ⏸ DISABLED`;

      const toggleBtn = isEnabled
        ? { text: "⏸ Disable Trading", callback_data: "trade:disable" }
        : { text: "▶️ Enable Trading", callback_data: "trade:enable" };

      await bot.sendMessage(chatId,
        `💎 *Make Me Rich — Autonomous Trading Agent*\n\n${statusLine}\n\nThe agent scans Four.meme for new token launches, evaluates momentum signals, and trades automatically from your wallet.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [toggleBtn],
              [{ text: "📊 Status", callback_data: "trade:status" }, { text: "⚙️ Settings", callback_data: "trade:settings" }],
              [{ text: "🧩 Agent Skills", callback_data: "trade:skills" }],
              [{ text: "📜 History", callback_data: "trade:history" }, { text: "🔴 Close All", callback_data: "trade:closeall" }],
              [{ text: "« Back", callback_data: "main_menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "tradestatus") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for trade status!"); return; }
      const { getUserTradingStatus } = await import("./trading-agent");
      const { config, positions } = getUserTradingStatus(chatId);

      let msg = `📊 *Trading Agent*\n\n`;
      msg += `Status: ${config.enabled ? "✅ ACTIVE" : "⏸ DISABLED"}\n`;
      msg += `Open Positions: ${positions.length}\n`;
      if (positions.length > 0) {
        msg += `\n`;
        for (const p of positions) {
          const age = Math.floor((Date.now() - p.entryTime) / 60000);
          msg += `  • $${p.tokenSymbol} — ${p.entryPriceBnb} BNB (${age}m ago)\n`;
        }
      }

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    }

    if (cmd === "smartmoney") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for smart money info!"); return; }
      const { getDiscoveredSmartWallets } = await import("./trading-agent");
      const wallets = getDiscoveredSmartWallets();
      if (wallets.length === 0) {
        await bot.sendMessage(chatId, "🧠 *Smart Money Discovery*\n\nNo smart wallets discovered yet. The system analyzes graduated Four.meme tokens every 5 minutes to find consistently profitable early buyers.\n\nCheck back soon!", { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
        return;
      }
      let msg = `🧠 *Smart Money Discovery*\n\nTracking ${wallets.length} discovered wallets:\n\n`;
      for (const w of wallets.slice(0, 15)) {
        const shortAddr = w.address.substring(0, 6) + "..." + w.address.substring(38);
        const winRate = w.totalTrades > 0 ? Math.round((w.winCount / w.totalTrades) * 100) : 0;
        msg += `• \`${shortAddr}\` — ${winRate}% win (${w.winCount}/${w.totalTrades}) score: ${w.score}\n`;
      }
      msg += `\nTheir new buys are automatically tracked and boost token scores.`;
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    }

    if (cmd === "swap") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for OKX DEX swap!"); return; }
      pendingOKXSwap.set(chatId, { step: "chain" });
      pendingOKXBridge.delete(chatId);
      const chainButtons = OKX_CHAINS.map(c => [{ text: `${c.name} (${c.symbol})`, callback_data: `okxswap_chain:${c.id}` }]);
      chainButtons.push([{ text: "« Back", callback_data: "action:menu" }]);
      await bot.sendMessage(chatId,
        "🔄 *OKX DEX Swap*\n\nSwap tokens on any chain using OKX DEX Aggregator.\nSupported: BNB Chain, XLayer, Ethereum, Base, Polygon, Arbitrum, Avalanche, Optimism & more.\n0.5% fee to BUILD4 treasury.\n\nSelect a chain:",
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
      );
      return;
    }

    if (cmd === "bridge") {
      await bot.sendMessage(chatId,
        "🌉 *OKX Cross-Chain Bridge*\n\n" +
        "⚠️ Cross-chain bridge is temporarily unavailable on OKX. Please try again later.\n\n" +
        "You can still use *DEX Swap* to trade tokens on a single chain.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Use DEX Swap Instead", callback_data: "action:okxswap" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "signals") {
      await bot.sendMessage(chatId,
        "🐋 *Smart Money Signals*\n\nSelect signal type:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🐋 Whale Buys", callback_data: "okxsig:whale" }],
              [{ text: "🎤 KOL Buys", callback_data: "okxsig:kol" }],
              [{ text: "💰 Smart Money", callback_data: "okxsig:smart" }],
              [{ text: "🏆 Leaderboard", callback_data: "okxsig:leaderboard" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "scan") {
      await bot.sendMessage(chatId,
        "🔒 *Security Scanner*\n\nScan a token for honeypot risks and contract safety.\n\nSelect chain:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "BNB Chain", callback_data: "okxscan_chain:56" }, { text: "Ethereum", callback_data: "okxscan_chain:1" }],
              [{ text: "Base", callback_data: "okxscan_chain:8453" }, { text: "XLayer", callback_data: "okxscan_chain:196" }],
              [{ text: "Solana", callback_data: "okxscan_chain:501" }, { text: "Polygon", callback_data: "okxscan_chain:137" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "trending") {
      await bot.sendMessage(chatId,
        "🔥 *Trending & Hot Tokens*\n\nSelect view:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔥 Hot Tokens (Volume)", callback_data: "okxtrend:hot:4" }],
              [{ text: "📈 Price Gainers", callback_data: "okxtrend:hot:1" }],
              [{ text: "📉 Price Losers", callback_data: "okxtrend:hot:2" }],
              [{ text: "🆕 Newly Listed", callback_data: "okxtrend:hot:3" }],
              [{ text: "🌊 Trending (Solana)", callback_data: "okxtrend:chain:solana" }],
              [{ text: "🌊 Trending (BNB)", callback_data: "okxtrend:chain:bsc" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "meme") {
      await bot.sendMessage(chatId,
        "🐸 *Meme Token Scanner*\n\nScan new meme token launches.\n\nSelect filter:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🆕 New Launches", callback_data: "okxmeme:NEW" }],
              [{ text: "🎓 Graduated", callback_data: "okxmeme:GRADUATED" }],
              [{ text: "🔥 Bonding (Active)", callback_data: "okxmeme:BONDING" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "gas") {
      await bot.sendMessage(chatId,
        "⛽ *Gas Prices*\n\nSelect chain:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "BNB Chain", callback_data: "okxgas:56" }, { text: "Ethereum", callback_data: "okxgas:1" }],
              [{ text: "Base", callback_data: "okxgas:8453" }, { text: "XLayer", callback_data: "okxgas:196" }],
              [{ text: "Polygon", callback_data: "okxgas:137" }, { text: "Arbitrum", callback_data: "okxgas:42161" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "price") {
      await bot.sendMessage(chatId,
        "📊 *Token Price Lookup*\n\nSelect chain:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "BNB Chain", callback_data: "okxprice_chain:56" }, { text: "Ethereum", callback_data: "okxprice_chain:1" }],
              [{ text: "Base", callback_data: "okxprice_chain:8453" }, { text: "XLayer", callback_data: "okxprice_chain:196" }],
              [{ text: "Solana", callback_data: "okxprice_chain:501" }, { text: "Polygon", callback_data: "okxprice_chain:137" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "aster") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for Aster DEX trading!"); return; }
      await handleAsterMenu(chatId);
      return;
    }

    if (cmd === "chaos") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for chaos plans!"); return; }
      await ensureWallet(chatId);
      const wallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);
      const walletAddr = wallets[activeIdx];
      if (!walletAddr) {
        await bot.sendMessage(chatId, "You need a wallet first. Use /wallet to set one up.", { reply_markup: mainMenuKeyboard() });
        return;
      }
      const hasKey = walletsWithKey.has(`${chatId}:${walletAddr}`);
      if (!hasKey) {
        await bot.sendMessage(chatId, "You need a wallet with a private key to run a chaos plan. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard() });
        return;
      }

      pendingAgentCreation.delete(chatId);
      pendingTask.delete(chatId);
      pendingTokenLaunch.delete(chatId);
      pendingFourMemeBuy.delete(chatId);
      pendingFourMemeSell.delete(chatId);
      pendingChaosPlan.set(chatId, { step: "token_address", walletAddress: walletAddr });

      await bot.sendMessage(chatId,
        "🔥 *Project Chaos — Autonomous Token Plan*\n\n" +
        "Your agent will generate a custom 13-milestone chaos plan for any token you hold.\n\n" +
        "The plan includes burns, airdrops, and dramatic tweets — all executed autonomously over 7 days.\n\n" +
        "Send the *token contract address* on BNB Chain that you want to create a plan for:",
        { parse_mode: "Markdown" }
      );
      return;
    }

    return;
  }

  let question = "";

  if (isGroup) {
    const mentionsBotEntity = msg.entities?.some((e: any) =>
      e.type === "mention" && botUsername &&
      text.substring(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername.toLowerCase()}`
    );
    const mentionsBotText = botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);

    if (mentionsBotEntity || mentionsBotText) {
      question = botUsername
        ? text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim()
        : text;
    } else {
      return;
    }
  } else {
    if (shouldIgnoreMessage(text, msg)) return;
    question = text;
  }

  if (!question) return;

  await handleQuestion(chatId, msg.message_id, question, username);
}

function shouldIgnoreMessage(text: string, msg: TelegramBot.Message): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  if (/^0x[a-fA-F0-9]{40,64}$/i.test(t)) return true;
  if (/^[a-fA-F0-9]{64}$/i.test(t)) return true;
  if (t.startsWith("{") || t.startsWith("[")) return true;
  if ((t.match(/0x[a-fA-F0-9]{10,}/g) || []).length > 1) return true;
  if (msg.forward_from || msg.forward_sender_name) return true;
  return false;
}

async function handleImportWalletFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const input = text.trim();

  if (/^0x[a-fA-F0-9]{64}$/i.test(input)) {
    try {
      const wallet = new ethers.Wallet(input);
      const addr = wallet.address.toLowerCase();
      linkTelegramWallet(chatId, addr, input);
      pendingImportWallet.delete(chatId);

      await bot.sendMessage(chatId,
        `✅ Wallet imported!\n\nAddress: \`${addr}\``,
        { parse_mode: "Markdown" }
      );
      await bot.sendMessage(chatId,
        "What would you like to do?",
        { reply_markup: mainMenuKeyboard() }
      );
    } catch {
      await bot.sendMessage(chatId, "Invalid private key. Please try again or type /cancel.");
    }
    return;
  }

  if (/^0x[a-fA-F0-9]{40}$/i.test(input)) {
    const addr = input.toLowerCase();
    linkTelegramWallet(chatId, addr);
    pendingImportWallet.delete(chatId);

    await bot.sendMessage(chatId,
      `✅ Wallet linked (view-only)!\n\nAddress: \`${addr}\``,
      { parse_mode: "Markdown" }
    );
    await bot.sendMessage(chatId,
      "What would you like to do?",
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  await bot.sendMessage(chatId,
    "That doesn't look like a valid wallet address or private key.\n\n" +
    "• Private key: 0x + 64 hex characters\n" +
    "• Address: 0x + 40 hex characters\n\n" +
    "Try again or type /cancel."
  );
}

async function handleAgentCreationFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingAgentCreation.get(chatId)!;

  if (state.step === "name") {
    const name = text.trim();
    if (name.length < 1 || name.length > 50) {
      await bot.sendMessage(chatId, "Name must be 1-50 characters. Try again:");
      return;
    }
    const existing = await storage.getAgentByName(name);
    if (existing) {
      await bot.sendMessage(chatId, `"${name}" is taken. Pick another name:`);
      return;
    }
    state.name = name;
    state.step = "bio";
    pendingAgentCreation.set(chatId, state);
    await bot.sendMessage(chatId, `Agent: ${name}\n\nShort bio — what does it do? (max 300 chars)\n\nExample: "DeFi analyst tracking yield opportunities across BNB Chain"`);
    return;
  }

  if (state.step === "bio") {
    const bio = text.trim();
    if (bio.length > 300) {
      await bot.sendMessage(chatId, `${bio.length}/300 chars — make it shorter:`);
      return;
    }
    state.bio = bio;
    state.step = "model";
    pendingAgentCreation.set(chatId, state);
    await bot.sendMessage(chatId, "Pick your AI model:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Llama 70B — Fast", callback_data: "model:llama" }],
          [{ text: "DeepSeek V3 — Strong reasoning", callback_data: "model:deepseek" }],
          [{ text: "Qwen 72B — Multilingual", callback_data: "model:qwen" }],
        ]
      }
    });
    return;
  }
}

const AGENT_HIRE_FEE_BNB = "0.95";

async function collectAgentHireFee(chatId: number, walletAddress: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const treasuryPk = process.env.BOUNTY_WALLET_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || process.env.CHAOS_AGENT_PRIVATE_KEY;
  if (!treasuryPk) return { success: false, error: "No treasury configured" };

  let treasury: string;
  try {
    const { ethers } = await import("ethers");
    treasury = new ethers.Wallet(treasuryPk).address;
  } catch {
    return { success: false, error: "Invalid treasury key" };
  }

  const userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), walletAddress);
  if (!userPk) return { success: false, error: "No wallet key found" };

  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
    const wallet = new ethers.Wallet(userPk, provider);

    if (wallet.address.toLowerCase() === treasury.toLowerCase()) {
      return { success: true };
    }

    const feeWei = ethers.parseEther(AGENT_HIRE_FEE_BNB);
    const balance = await provider.getBalance(wallet.address);

    if (balance < feeWei + ethers.parseEther("0.001")) {
      const bal = ethers.formatEther(balance);
      return { success: false, error: `Insufficient BNB. You have ${bal} BNB but need ${AGENT_HIRE_FEE_BNB} BNB ($599). Fund your wallet and try again.` };
    }

    const tx = await wallet.sendTransaction({
      to: treasury,
      value: feeWei,
      gasLimit: 21000,
    });

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      return { success: false, error: "Payment transaction reverted" };
    }

    return { success: true, txHash: receipt.hash };
  } catch (e: any) {
    return { success: false, error: e.message?.substring(0, 120) || "Payment failed" };
  }
}

async function createAgent(chatId: number, name: string, bio: string, model: string): Promise<void> {
  if (!bot) return;
  const wallet = getLinkedWallet(chatId);
  if (!wallet) return;

  pendingAgentCreation.delete(chatId);

  try {
    await bot.sendChatAction(chatId, "typing");

    await bot.sendMessage(chatId,
      `💳 Agent creation costs $599 (${AGENT_HIRE_FEE_BNB} BNB).\n\nProcessing payment from your wallet...`
    );

    const feeResult = await collectAgentHireFee(chatId, wallet);
    if (!feeResult.success) {
      await bot.sendMessage(chatId,
        `❌ Payment failed: ${feeResult.error}\n\nAgent creation requires $599 (${AGENT_HIRE_FEE_BNB} BNB). Make sure your wallet has enough BNB.`,
        { reply_markup: { inline_keyboard: [[{ text: "My Wallet", callback_data: "action:wallet" }, { text: "Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    const initialDeposit = "1000000000000000";
    const result = await storage.createFullAgent(name, bio, model, initialDeposit, undefined, undefined, wallet);
    const agentId = result.agent.id;

    let msg = `✅ Agent created!\n\n${result.agent.name} | ${shortModel(model)}\nID: ${agentId}\n`;
    msg += `💳 Paid: $599 (${AGENT_HIRE_FEE_BNB} BNB)`;
    if (feeResult.txHash) msg += `\n🔗 TX: https://bscscan.com/tx/${feeResult.txHash}`;
    msg += `\n\nRegistering on-chain...`;

    await bot.sendMessage(chatId, msg,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Give it a task", callback_data: `agenttask:${agentId}` }],
            [{ text: "My Agents", callback_data: "action:myagents" }, { text: "Menu", callback_data: "action:menu" }],
          ]
        }
      }
    );

    registerAgentOnAllChains(chatId, agentId, name, bio);
  } catch (e: any) {
    await bot.sendMessage(chatId, `Failed: ${e.message}`, {
      reply_markup: { inline_keyboard: [[{ text: "Try again", callback_data: "action:newagent" }]] }
    });
  }
}

async function registerAgentOnAllChains(chatId: number, agentId: string, name: string, bio: string): Promise<void> {
  if (!bot) return;
  const results: string[] = [];

  const wallet = getLinkedWallet(chatId);
  let userPk: string | undefined;
  if (wallet) {
    userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet) || undefined;
  }

  if (!userPk) {
    try {
      await bot.sendMessage(chatId,
        `⚠️ On-chain registration skipped — your wallet needs funds to register agents.\n\n` +
        `• ERC-8004 (BNB Chain): ~0.002 BNB for gas\n` +
        `• BAP-578 (BNB Chain): ~0.012 BNB (0.01 mint + gas)\n\n` +
        `Fund your wallet and use /myagents to register later.`,
      );
    } catch {}
    return;
  }

  try {
    if (isOnchainReady()) {
      const hubResult = await registerAgentOnchain(agentId);
      if (hubResult.success && hubResult.txHash !== "already-registered") {
        const explorer = getExplorerUrl(hubResult.txHash || "");
        results.push(`AgentEconomyHub: ${explorer ? explorer : "registered"}`);
      } else if (hubResult.success) {
        results.push("AgentEconomyHub: already registered");
      }
    }
  } catch (e: any) {
    console.error(`[TelegramBot] Hub registration error for ${agentId}:`, e.message);
  }

  try {
    const erc8004BscResult = await registerAgentERC8004(name, bio, agentId, "bsc", userPk);
    if (erc8004BscResult.success) {
      results.push(`ERC-8004 (${erc8004BscResult.chainName || "BSC"}): ${erc8004BscResult.txHash?.substring(0, 14)}...`);
      if (erc8004BscResult.tokenId) {
        results.push(`  Token ID: ${erc8004BscResult.tokenId}`);
      }
      try {
        const { db } = await import("./db");
        const { agents: agentsTable } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(agentsTable).set({ erc8004Registered: true }).where(eq(agentsTable.id, agentId));
      } catch {}
    } else {
      results.push(`ERC-8004 (BSC): ${erc8004BscResult.error?.substring(0, 80) || "skipped"}`);
    }
  } catch (e: any) {
    console.error(`[TelegramBot] ERC-8004 BSC registration error for ${agentId}:`, e.message);
    results.push(`ERC-8004 (BSC): ${e.message?.substring(0, 60)}`);
  }

  try {
    const bap578Result = await registerAgentBAP578(name, bio, agentId, undefined, userPk);
    if (bap578Result.success) {
      results.push(`BAP-578 (BNB Chain): ${bap578Result.txHash?.substring(0, 14)}...`);
      if (bap578Result.tokenId) {
        results.push(`  NFA Token ID: ${bap578Result.tokenId}`);
      }
      try {
        const { db } = await import("./db");
        const { agents: agentsTable } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(agentsTable).set({ bap578Registered: true }).where(eq(agentsTable.id, agentId));
      } catch {}
    } else {
      results.push(`BAP-578: ${bap578Result.error?.substring(0, 80) || "skipped"}`);
    }
  } catch (e: any) {
    console.error(`[TelegramBot] BAP-578 registration error for ${agentId}:`, e.message);
    results.push(`BAP-578: ${e.message?.substring(0, 60)}`);
  }


  if (results.length > 0) {
    try {
      await bot.sendMessage(chatId,
        `On-chain registration complete:\n\n${results.join("\n")}`,
        { reply_markup: mainMenuKeyboard() }
      );
    } catch {}
  }
}

async function handleMyAgents(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const myAgents = await getMyAgents(wallet);

    if (myAgents.length === 0) {
      await bot.sendMessage(chatId, "No agents yet.", {
        reply_markup: { inline_keyboard: [[{ text: "Create your first agent", callback_data: "action:newagent" }]] }
      });
      return;
    }

    const lines = myAgents.map(a => `${a.name} — ${shortModel(a.modelType || "unknown")}`);

    const buttons = myAgents.map(a => [
      { text: `${a.name} — Assign task`, callback_data: `agenttask:${a.id}` }
    ]);
    buttons.push([{ text: "Create another agent", callback_data: "action:newagent" }]);

    await bot.sendMessage(chatId,
      `Your Agents (${myAgents.length}):\n\n${lines.join("\n")}`,
      { reply_markup: { inline_keyboard: buttons } }
    );
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function startTaskFlow(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const myAgents = await getMyAgents(wallet);

    if (myAgents.length === 0) {
      await bot.sendMessage(chatId, "You need an agent first.", {
        reply_markup: { inline_keyboard: [[{ text: "Create agent", callback_data: "action:newagent" }]] }
      });
      return;
    }

    if (myAgents.length === 1) {
      const agent = myAgents[0];
      await bot.sendMessage(chatId, `Task for ${agent.name}. Pick a type:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Research", callback_data: `tasktype:${agent.id}:research` }, { text: "Analysis", callback_data: `tasktype:${agent.id}:analysis` }],
            [{ text: "Content", callback_data: `tasktype:${agent.id}:content` }, { text: "Strategy", callback_data: `tasktype:${agent.id}:strategy` }],
            [{ text: "Code Review", callback_data: `tasktype:${agent.id}:code_review` }, { text: "General", callback_data: `tasktype:${agent.id}:general` }],
            [{ text: "🚀 Launch Token", callback_data: `launchagent:${agent.id}` }],
          ]
        }
      });
      return;
    }

    const buttons = myAgents.map(a => [
      { text: a.name, callback_data: `taskagent:${a.id}` }
    ]);

    await bot.sendMessage(chatId, "Which agent?", {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleTaskFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingTask.get(chatId)!;
  const wallet = getLinkedWallet(chatId);
  if (!wallet) { pendingTask.delete(chatId); return; }

  if (state.step === "describe") {
    const description = text.trim();
    if (description.length > 5000) {
      await bot.sendMessage(chatId, `${description.length}/5000 chars — make it shorter:`);
      return;
    }

    const { agentId, taskType, agentName } = state;
    const title = description.length > 100 ? description.substring(0, 97) + "..." : description;
    pendingTask.delete(chatId);

    try {
      await bot.sendChatAction(chatId, "typing");

      const task = await storage.createTask({
        agentId,
        creatorWallet: wallet,
        taskType,
        title,
        description,
        status: "pending",
        result: null,
        toolsUsed: null,
        modelUsed: null,
        executionTimeMs: null,
      });

      await bot.sendMessage(chatId, `${agentName} is working on it...\n\nI'll send you the result when it's ready.`);

      const { executeTask } = await import("./task-engine");
      executeTask(task.id).then(async () => {
        try {
          const completed = await storage.getTask(task.id);
          if (!completed || !bot) return;

          if (completed.status === "completed" && completed.result) {
            const resultText = completed.result.length > 3500
              ? completed.result.substring(0, 3500) + "\n\n... (truncated)"
              : completed.result;

            const meta = [];
            if (completed.modelUsed) meta.push(shortModel(completed.modelUsed));
            if (completed.executionTimeMs) meta.push(`${(completed.executionTimeMs / 1000).toFixed(1)}s`);
            if (completed.toolsUsed) {
              try { const t = JSON.parse(completed.toolsUsed); if (t.length) meta.push(t.join(", ")); } catch {}
            }

            await bot.sendMessage(chatId,
              `Done! ${meta.length > 0 ? `(${meta.join(" | ")})` : ""}\n\n${resultText}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "New task", callback_data: `agenttask:${agentId}` }, { text: "Menu", callback_data: "action:menu" }],
                  ]
                }
              }
            );
          } else if (completed.status === "failed") {
            await bot.sendMessage(chatId,
              `Task failed: ${completed.result || "Unknown error"}`,
              {
                reply_markup: {
                  inline_keyboard: [[{ text: "Try again", callback_data: `agenttask:${agentId}` }]]
                }
              }
            );
          }
        } catch (e: any) {
          console.error(`[TelegramBot] Error sending result to ${chatId}:`, e.message);
        }
      }).catch(err => {
        console.error(`[TelegramBot] Task ${task.id} error:`, err.message);
        bot?.sendMessage(chatId, `Error: ${err.message}`, {
          reply_markup: { inline_keyboard: [[{ text: "Try again", callback_data: `agenttask:${agentId}` }]] }
        }).catch(() => {});
      });

    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed: ${e.message}`, {
        reply_markup: { inline_keyboard: [[{ text: "Try again", callback_data: "action:task" }]] }
      });
    }
    return;
  }
}

async function handleTaskStatus(chatId: number, taskId: string, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const task = await storage.getTask(taskId.trim());
    if (!task) { await bot.sendMessage(chatId, "Task not found."); return; }
    if (task.creatorWallet && task.creatorWallet.toLowerCase() !== wallet.toLowerCase()) {
      await bot.sendMessage(chatId, "That task doesn't belong to your wallet.");
      return;
    }

    const agent = await storage.getAgent(task.agentId);
    const status = task.status === "completed" ? "Done" : task.status === "running" ? "Running..." : task.status === "failed" ? "Failed" : "Pending";

    let msg = `${task.title}\n${agent?.name || "Agent"} | ${task.taskType} | ${status}`;
    if (task.modelUsed) msg += ` | ${shortModel(task.modelUsed)}`;
    if (task.executionTimeMs) msg += ` | ${(task.executionTimeMs / 1000).toFixed(1)}s`;

    if (task.result) {
      const preview = task.result.length > 3000 ? task.result.substring(0, 3000) + "\n\n... (truncated)" : task.result;
      msg += `\n\n${preview}`;
    } else if (task.status === "running") {
      msg += "\n\nStill processing...";
    }

    const buttons = [];
    if (task.agentId) buttons.push([{ text: "New task for this agent", callback_data: `agenttask:${task.agentId}` }]);
    buttons.push([{ text: "Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, msg, { reply_markup: { inline_keyboard: buttons } });
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleMyTasks(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const tasks = await storage.getTasksByCreator(wallet, 10);

    if (tasks.length === 0) {
      await bot.sendMessage(chatId, "No tasks yet.", {
        reply_markup: { inline_keyboard: [[{ text: "Create a task", callback_data: "action:task" }]] }
      });
      return;
    }

    const lines = tasks.map(t => {
      const s = t.status === "completed" ? "Done" : t.status === "running" ? "..." : t.status === "failed" ? "Failed" : "Pending";
      const title = t.title.length > 40 ? t.title.substring(0, 37) + "..." : t.title;
      return `[${s}] ${title}`;
    });

    const buttons = tasks.slice(0, 5).map(t => [
      { text: `${t.title.substring(0, 30)}${t.title.length > 30 ? "..." : ""}`, callback_data: `viewtask:${t.id}` }
    ]);
    buttons.push([{ text: "New task", callback_data: "action:task" }, { text: "Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId,
      `Recent Tasks:\n\n${lines.join("\n")}`,
      { reply_markup: { inline_keyboard: buttons } }
    );
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleProposalApproval(chatId: number, proposalId: string, approved: boolean): Promise<void> {
  if (!bot) return;

  try {
    const { storage } = await import("./storage");
    const proposal = await storage.getTokenLaunch(proposalId);

    if (!proposal) {
      await bot.sendMessage(chatId, "Proposal not found or already expired.");
      return;
    }

    if (proposal.status !== "proposed") {
      const statusMsg = proposal.status === "success" ? "already launched" : proposal.status === "rejected" ? "already rejected" : proposal.status;
      await bot.sendMessage(chatId, `This proposal is ${statusMsg}.`);
      return;
    }

    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId, "Please connect your wallet first.");
      return;
    }

    if (!proposal.creatorWallet) {
      await bot.sendMessage(chatId, "This proposal has no owner — cannot approve.");
      return;
    }

    if (proposal.creatorWallet.toLowerCase() !== wallet.toLowerCase()) {
      await bot.sendMessage(chatId, "This proposal belongs to a different wallet.");
      return;
    }

    if (!approved) {
      await storage.updateTokenLaunch(proposalId, { status: "rejected" });
      await bot.sendMessage(chatId,
        `❌ Proposal rejected: ${proposal.tokenName} ($${proposal.tokenSymbol})\n\nYour agent will learn from this.`,
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    const updated = await storage.updateTokenLaunch(proposalId, { status: "pending" });
    if (!updated || (updated.status !== "pending")) {
      await bot.sendMessage(chatId, "This proposal was already processed.");
      return;
    }

    await bot.sendMessage(chatId, `🚀 Launching ${proposal.tokenName} ($${proposal.tokenSymbol})...\n\nThis may take a minute.`);
    await bot.sendChatAction(chatId, "typing");

    let userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);

    if (!userPk) {
      await bot.sendMessage(chatId,
        "⚠️ Your wallet doesn't have a stored private key.\n\n" +
        "Use 🔑 Wallet → Import to re-import this wallet's private key, or create a new proposal from a fresh wallet.",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    const { launchToken } = await import("./token-launcher");

    const launchParams: any = {
      tokenName: proposal.tokenName,
      tokenSymbol: proposal.tokenSymbol,
      tokenDescription: proposal.tokenDescription || `${proposal.tokenName} — launched by agent on BUILD4`,
      platform: proposal.platform as "four_meme" | "flap_sh" | "bankr",
      agentId: proposal.agentId || undefined,
      creatorWallet: wallet,
    };

    if (proposal.platform === "bankr") {
      launchParams.bankrChain = "base";
    } else {
      launchParams.initialLiquidityBnb = proposal.platform === "four_meme" ? "0" : "0.001";
      launchParams.userPrivateKey = userPk;
    }

    const result = await launchToken(launchParams);

    if (result.success) {
      await storage.updateTokenLaunch(proposalId, {
        status: "success",
        tokenAddress: result.tokenAddress,
        txHash: result.txHash,
        launchUrl: result.launchUrl,
      });

      const lines = [
        `✅ TOKEN LAUNCHED!\n`,
        `Token: ${proposal.tokenName} ($${proposal.tokenSymbol})`,
      ];
      if (result.tokenAddress) lines.push(`Address: ${result.tokenAddress}`);
      if (result.txHash) lines.push(`Tx: https://bscscan.com/tx/${result.txHash}`);
      if (result.launchUrl) lines.push(`\nView: ${result.launchUrl}`);

      await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: mainMenuKeyboard()
      });
    } else {
      await storage.updateTokenLaunch(proposalId, {
        status: "failed",
        errorMessage: result.error,
      });

      await bot.sendMessage(chatId,
        `❌ Launch failed: ${result.error}`,
        { reply_markup: mainMenuKeyboard() }
      );
    }
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function startTokenLaunchFlow(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const myAgents = await getMyAgents(wallet);

    if (myAgents.length === 0) {
      await bot.sendMessage(chatId, "You need an agent first to launch a token.", {
        reply_markup: { inline_keyboard: [[{ text: "Create agent", callback_data: "action:newagent" }]] }
      });
      return;
    }

    if (myAgents.length === 1) {
      const agent = myAgents[0];
      pendingAgentCreation.delete(chatId);
      pendingTask.delete(chatId);
      pendingTokenLaunch.set(chatId, { step: "platform", agentId: agent.id, agentName: agent.name });

      await bot.sendMessage(chatId,
        `🚀 Launch a token with ${agent.name}\n\nPick a launchpad:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Four.meme (BNB Chain)", callback_data: `launchplatform:${agent.id}:four_meme` }],
              [{ text: "Flap.sh (BNB Chain)", callback_data: `launchplatform:${agent.id}:flap_sh` }],
              [{ text: "XLayer (OKX)", callback_data: `launchplatform:${agent.id}:xlayer` }],
              [{ text: "Bankr (Base/Solana)", callback_data: `launchplatform:${agent.id}:bankr` }],
              [{ text: "Cancel", callback_data: "action:menu" }],
            ]
          }
        }
      );
      return;
    }

    const buttons = myAgents.map(a => [
      { text: `🚀 ${a.name}`, callback_data: `launchagent:${a.id}` }
    ]);
    buttons.push([{ text: "Cancel", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, "Which agent should launch the token?", {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleTokenLaunchFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingTokenLaunch.get(chatId)!;
  const input = text.trim();

  if (state.step === "name") {
    if (input.length < 1 || input.length > 50) {
      await bot.sendMessage(chatId, "Token name must be 1-50 characters. Try again:");
      return;
    }
    state.tokenName = input;
    state.step = "symbol";
    pendingTokenLaunch.set(chatId, state);
    await bot.sendMessage(chatId,
      `Token: ${input}\n\nNow enter the ticker symbol (1-10 chars, letters/numbers only)\n\nExample: DOGE, PEPE, AGT`
    );
    return;
  }

  if (state.step === "symbol") {
    const symbol = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (symbol.length < 1 || symbol.length > 10) {
      await bot.sendMessage(chatId, "Symbol must be 1-10 alphanumeric characters. Try again:");
      return;
    }
    state.tokenSymbol = symbol;
    state.step = "description";
    pendingTokenLaunch.set(chatId, state);
    await bot.sendMessage(chatId,
      `Token: ${state.tokenName} ($${symbol})\n\nShort description (optional — type "skip" to skip):\n\nExample: The first AI-powered meme token on BNB Chain`
    );
    return;
  }

  if (state.step === "description") {
    const description = input.toLowerCase() === "skip" ? "" : input.substring(0, 500);
    state.tokenDescription = description;

    if (state.platform === "bankr") {
      showLaunchPreview(chatId, state);
      return;
    }

    state.step = "logo";
    pendingTokenLaunch.set(chatId, state);

    await bot.sendMessage(chatId,
      `🖼️ Token logo (optional):\n\nSend an image in any of these formats:\nPNG, JPG, GIF, WebP, SVG, BMP, TIFF, AVIF, ICO\n\nYou can send it as a photo, as a file, or even a static sticker.\n\nType "skip" to auto-generate a logo instead.`,
    );
    return;
  }

  if (state.step === "logo") {
    if (input.toLowerCase() !== "skip") {
      state.imageUrl = input.trim();
    }
    state.step = "links";
    pendingTokenLaunch.set(chatId, state);

    await bot.sendMessage(chatId,
      `🔗 Social links (optional):\n\nSend links in this format:\n` +
      `website: https://yoursite.com\n` +
      `twitter: https://x.com/yourtoken\n` +
      `telegram: https://t.me/yourgroup\n\n` +
      `You can include one, two, or all three. Or type "skip" to continue without links.`,
    );
    return;
  }

  if (state.step === "links") {
    if (input.toLowerCase() !== "skip") {
      const lines = input.split("\n");
      for (const line of lines) {
        const lower = line.toLowerCase().trim();
        const urlMatch = line.match(/https?:\/\/\S+/i);
        if (!urlMatch) continue;
        const url = urlMatch[0].trim();
        if (lower.startsWith("website:") || lower.startsWith("web:") || lower.startsWith("site:")) {
          state.webUrl = url;
        } else if (lower.startsWith("twitter:") || lower.startsWith("x:")) {
          state.twitterUrl = url;
        } else if (lower.startsWith("telegram:") || lower.startsWith("tg:")) {
          state.telegramUrl = url;
        } else if (url.includes("x.com") || url.includes("twitter.com")) {
          state.twitterUrl = url;
        } else if (url.includes("t.me")) {
          state.telegramUrl = url;
        } else {
          state.webUrl = state.webUrl || url;
        }
      }
    }

    if (state.platform === "flap_sh") {
      state.step = "tax";
      pendingTokenLaunch.set(chatId, state);
      await bot.sendMessage(chatId,
        `💰 Tax configuration (Flap.sh only):\n\nChoose a buy/sell tax rate for your token:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "0% (No Tax)", callback_data: "launchtax:0" },
                { text: "1%", callback_data: "launchtax:1" },
              ],
              [
                { text: "2%", callback_data: "launchtax:2" },
                { text: "5%", callback_data: "launchtax:5" },
              ],
            ]
          }
        }
      );
      return;
    }

    showLaunchPreview(chatId, state);
    return;
  }
}

async function showLaunchPreview(chatId: number, state: TokenLaunchState) {
  if (!bot) return;
  const platformName = state.platform === "four_meme" ? "Four.meme (BNB Chain)" : state.platform === "bankr" ? `Bankr (${state.bankrChain === "solana" ? "Solana" : "Base"})` : state.platform === "xlayer" ? "XLayer (OKX)" : "Flap.sh (BNB Chain)";
  const liquidity = state.platform === "bankr" ? "Managed by Bankr" : state.platform === "xlayer" ? "N/A (direct deploy)" : state.platform === "four_meme" ? "0.01 BNB" : "0.001 BNB";
  const launchFee = state.platform === "bankr" ? "Free" : state.platform === "xlayer" ? "Gas only (~0.005 OKB)" : "0.01 BNB (~$7)";

  let preview = `🚀 LAUNCH PREVIEW\n\n` +
    `Token: ${state.tokenName} ($${state.tokenSymbol})\n` +
    `Platform: ${platformName}\n` +
    `Liquidity: ${liquidity}\n` +
    `Launch Fee: ${launchFee}\n` +
    `Agent: ${state.agentName}\n`;

  if (state.tokenDescription) preview += `Description: ${state.tokenDescription}\n`;
  if (state.imageUrl) preview += `Logo: Custom image ✅\n`;
  else preview += `Logo: Auto-generated\n`;
  if (state.webUrl) preview += `Website: ${state.webUrl}\n`;
  if (state.twitterUrl) preview += `Twitter: ${state.twitterUrl}\n`;
  if (state.telegramUrl) preview += `Telegram: ${state.telegramUrl}\n`;
  if (state.platform === "flap_sh") {
    preview += `Tax: ${state.taxRate ?? 0}%\n`;
  }
  preview += `\nReady to launch?`;

  pendingTokenLaunch.set(chatId, state);

  await bot.sendMessage(chatId, preview, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 Confirm & Launch", callback_data: `launchconfirm:${state.agentId}` }],
        [{ text: "Cancel", callback_data: `launchcancel:${state.agentId}` }],
      ]
    }
  });
}

async function executeTelegramTokenLaunch(chatId: number, wallet: string, state: TokenLaunchState): Promise<void> {
  if (!bot) return;

  const platformName = state.platform === "four_meme" ? "Four.meme (BNB Chain)" : state.platform === "bankr" ? `Bankr (${state.bankrChain === "solana" ? "Solana" : "Base"})` : state.platform === "xlayer" ? "XLayer (OKX)" : "Flap.sh (BNB Chain)";

  if (state.platform === "xlayer") {
    await bot.sendMessage(chatId, `🌐 Deploying ${state.tokenName} ($${state.tokenSymbol}) as ERC-20 on XLayer...\n\nThis may take a minute.`);
    await bot.sendChatAction(chatId, "typing");

    let userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
    if (!userPk) {
      const newWallet = await regenerateWalletWithKey(chatId);
      if (newWallet) {
        userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), newWallet);
        wallet = newWallet;
      }
      if (!userPk) {
        await bot.sendMessage(chatId, "⚠️ Could not access wallet keys. Try /start to create a fresh wallet.", { reply_markup: mainMenuKeyboard() });
        return;
      }
    }

    try {
      const { launchToken } = await import("./token-launcher");
      const result = await launchToken({
        tokenName: state.tokenName!,
        tokenSymbol: state.tokenSymbol!,
        tokenDescription: state.tokenDescription || `${state.tokenName} — launched by ${state.agentName} on BUILD4`,
        platform: "xlayer",
        agentId: state.agentId,
        creatorWallet: wallet,
        userPrivateKey: userPk,
      });

      if (result.success) {
        const lines = [
          `✅ TOKEN DEPLOYED ON XLAYER!\n`,
          `Token: ${state.tokenName} ($${state.tokenSymbol})`,
          `Chain: XLayer (OKX)`,
          `Supply: 1,000,000,000 tokens`,
        ];
        if (result.tokenAddress) lines.push(`Address: ${result.tokenAddress}`);
        if (result.txHash) lines.push(`Tx: https://www.oklink.com/xlayer/tx/${result.txHash}`);
        if (result.launchUrl) lines.push(`\nView: ${result.launchUrl}`);

        await bot.sendMessage(chatId, lines.join("\n"), {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Launch another", callback_data: "action:launchtoken" }],
              [{ text: "Menu", callback_data: "action:menu" }],
            ]
          }
        });
      } else {
        await bot.sendMessage(chatId,
          `❌ XLayer launch failed: ${(result.error || "Unknown error").substring(0, 300)}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Try again", callback_data: "action:launchtoken" }],
                [{ text: "Menu", callback_data: "action:menu" }],
              ]
            }
          }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Error: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  if (state.platform === "bankr") {
    await bot.sendMessage(chatId, `🏦 Launching ${state.tokenName} ($${state.tokenSymbol}) on ${platformName} via Bankr API...\n\nThis may take up to 2 minutes.`);
    await bot.sendChatAction(chatId, "typing");

    try {
      const { launchToken } = await import("./token-launcher");
      const result = await launchToken({
        tokenName: state.tokenName!,
        tokenSymbol: state.tokenSymbol!,
        tokenDescription: state.tokenDescription || `${state.tokenName} — launched by ${state.agentName} on BUILD4`,
        platform: "bankr",
        agentId: state.agentId,
        creatorWallet: wallet,
        bankrChain: state.bankrChain || "base",
      });

      if (result.success) {
        const lines = [
          `✅ TOKEN LAUNCHED VIA BANKR!\n`,
          `Token: ${state.tokenName} ($${state.tokenSymbol})`,
          `Platform: ${platformName}`,
        ];
        if (result.tokenAddress) lines.push(`Address: ${result.tokenAddress}`);
        if (result.launchUrl) lines.push(`\nView: ${result.launchUrl}`);

        await bot.sendMessage(chatId, lines.join("\n"), {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Launch another", callback_data: "action:launchtoken" }],
              [{ text: "Menu", callback_data: "action:menu" }],
            ]
          }
        });
      } else {
        await bot.sendMessage(chatId,
          `❌ Bankr launch failed: ${(result.error || "Unknown error").substring(0, 300)}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Try again", callback_data: "action:launchtoken" }],
                [{ text: "Menu", callback_data: "action:menu" }],
              ]
            }
          }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Error: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  let userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);

  if (!userPk) {
    const newWallet = await regenerateWalletWithKey(chatId);
    if (newWallet) {
      userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), newWallet);
      wallet = newWallet;
    }
    if (!userPk) {
      await bot.sendMessage(chatId,
        "⚠️ Could not access wallet keys. Try /start to create a fresh wallet.",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }
  }

  await bot.sendMessage(chatId, `🚀 Launching ${state.tokenName} ($${state.tokenSymbol}) on ${platformName} from your wallet...\n\nThis may take a minute.`);
  await bot.sendChatAction(chatId, "typing");

  try {
    const { launchToken } = await import("./token-launcher");
    const result = await launchToken({
      tokenName: state.tokenName!,
      tokenSymbol: state.tokenSymbol!,
      tokenDescription: state.tokenDescription || `${state.tokenName} — launched by ${state.agentName} on BUILD4`,
      imageUrl: state.imageUrl,
      platform: state.platform as "four_meme" | "flap_sh",
      initialLiquidityBnb: state.platform === "four_meme" ? "0" : "0.001",
      agentId: state.agentId,
      creatorWallet: wallet,
      userPrivateKey: userPk,
      webUrl: state.webUrl,
      twitterUrl: state.twitterUrl,
      telegramUrl: state.telegramUrl,
      taxRate: state.taxRate,
    });

    if (result.success) {
      const lines = [
        `✅ TOKEN LAUNCHED!\n`,
        `Token: ${state.tokenName} ($${state.tokenSymbol})`,
        `Platform: ${platformName}`,
      ];
      if (result.tokenAddress) lines.push(`Address: ${result.tokenAddress}`);
      if (result.txHash) lines.push(`Tx: https://bscscan.com/tx/${result.txHash}`);
      if (result.launchUrl) lines.push(`\nView: ${result.launchUrl}`);

      await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Launch another", callback_data: "action:launchtoken" }],
            [{ text: "Menu", callback_data: "action:menu" }],
          ]
        }
      });
    } else {
      await bot.sendMessage(chatId,
        `❌ Launch failed: ${(result.error || "Unknown error").substring(0, 200)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Try again", callback_data: "action:launchtoken" }],
              [{ text: "Menu", callback_data: "action:menu" }],
            ]
          }
        }
      );
    }
  } catch (e: any) {
    await bot.sendMessage(chatId,
      `❌ Error: ${e.message}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Try again", callback_data: "action:launchtoken" }],
            [{ text: "Menu", callback_data: "action:menu" }],
          ]
        }
      }
    );
  }
}

async function handleTokenInfo(chatId: number, tokenAddress: string): Promise<void> {
  if (!bot) return;
  await bot.sendChatAction(chatId, "typing");
  try {
    const { fourMemeGetTokenInfo, fourMemeGetTokenBalance } = await import("./token-launcher");
    const info = await Promise.race([
      fourMemeGetTokenInfo(tokenAddress),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Token info timed out (30s). Try again.")), 30000)),
    ]);

    const quoteName = info.quote === "0x0000000000000000000000000000000000000000" ? "BNB" : "BEP20";
    const progressBar = "█".repeat(Math.floor(info.progressPercent / 10)) + "░".repeat(10 - Math.floor(info.progressPercent / 10));

    let text = `📈 TOKEN INFO\n\n` +
      `Address: \`${tokenAddress}\`\n` +
      `Version: V${info.version} TokenManager\n` +
      `Quote: ${quoteName}\n` +
      `Price: ${parseFloat(info.lastPrice).toFixed(12)} ${quoteName}\n` +
      `Fee Rate: ${(info.tradingFeeRate * 100).toFixed(2)}%\n` +
      `Launched: ${new Date(info.launchTime * 1000).toISOString().split("T")[0]}\n\n` +
      `Bonding Curve:\n` +
      `[${progressBar}] ${info.progressPercent}%\n` +
      `Raised: ${parseFloat(info.funds).toFixed(4)} / ${parseFloat(info.maxFunds).toFixed(4)} ${quoteName}\n` +
      `Remaining: ${parseFloat(info.offers).toFixed(0)} / ${parseFloat(info.maxOffers).toFixed(0)} tokens\n`;

    if (info.liquidityAdded) {
      text += `\n✅ Liquidity added — trading on PancakeSwap`;
    }

    text += `\n\nhttps://four.meme/token/${tokenAddress}`;

    const wallet = getLinkedWallet(chatId);
    const buttons: TelegramBot.InlineKeyboardButton[][] = [];
    if (wallet) {
      buttons.push([
        { text: "💰 Buy", callback_data: `fmbuy:${tokenAddress.substring(0, 42)}` },
        { text: "💸 Sell", callback_data: `fmsell:${tokenAddress.substring(0, 42)}` },
      ]);
    }
    buttons.push([{ text: "◀️ Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
  } catch (e: any) {
    await bot.sendMessage(chatId, `Failed to fetch token info: ${e.message?.substring(0, 150) || "Unknown error"}`, { reply_markup: mainMenuKeyboard() });
  }
}

async function showSellAmountPrompt(chatId: number, tokenAddress: string): Promise<void> {
  if (!bot) return;
  const wallet = getLinkedWallet(chatId);
  if (!wallet) return;

  try {
    const { fourMemeGetTokenBalance } = await import("./token-launcher");
    const balInfo = await Promise.race([
      fourMemeGetTokenBalance(tokenAddress, wallet),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Balance check timed out (30s). BSC RPC may be slow — try again.")), 30000)),
    ]);
    const bal = parseFloat(balInfo.balance);

    if (bal <= 0) {
      pendingFourMemeSell.delete(chatId);
      await bot.sendMessage(chatId, `You don't hold any of this token in your active wallet.`, { reply_markup: mainMenuKeyboard() });
      return;
    }

    const state = pendingFourMemeSell.get(chatId);
    if (state) {
      state.tokenSymbol = balInfo.symbol;
      pendingFourMemeSell.set(chatId, state);
    }

    await bot.sendMessage(chatId,
      `Your balance: ${bal.toFixed(4)} ${balInfo.symbol}\n\nHow many tokens do you want to sell?\n\nType an amount or tap a button:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "25%", callback_data: `fmsellpct:25:${tokenAddress}` },
              { text: "50%", callback_data: `fmsellpct:50:${tokenAddress}` },
              { text: "100%", callback_data: `fmsellpct:100:${tokenAddress}` },
            ],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
  } catch (e: any) {
    await bot.sendMessage(chatId, `Failed to check balance: ${e.message?.substring(0, 100)}`, { reply_markup: mainMenuKeyboard() });
    pendingFourMemeSell.delete(chatId);
  }
}

async function handleFourMemeBuyFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingFourMemeBuy.get(chatId)!;
  const input = text.trim();

  if (state.step === "token") {
    if (!/^0x[a-fA-F0-9]{40}$/i.test(input)) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid token contract address (0x...):");
      return;
    }
    state.tokenAddress = input.toLowerCase();
    state.step = "amount";
    pendingFourMemeBuy.set(chatId, state);
    await bot.sendMessage(chatId,
      `How much BNB do you want to spend?\n\nEnter an amount (e.g. 0.01, 0.1, 1):`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "0.01 BNB", callback_data: `fmbuyamt:0.01:${state.tokenAddress}` },
              { text: "0.05 BNB", callback_data: `fmbuyamt:0.05:${state.tokenAddress}` },
              { text: "0.1 BNB", callback_data: `fmbuyamt:0.1:${state.tokenAddress}` },
            ],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
    return;
  }

  if (state.step === "amount") {
    const amount = parseFloat(input);
    if (isNaN(amount) || amount <= 0 || amount > 100) {
      await bot.sendMessage(chatId, "Enter a valid BNB amount (e.g. 0.01, 0.1, 1):");
      return;
    }
    state.bnbAmount = amount.toString();
    await executeFourMemeBuyConfirm(chatId, state);
    return;
  }
}

async function executeFourMemeBuyConfirm(chatId: number, state: FourMemeBuyState): Promise<void> {
  if (!bot || !state.tokenAddress || !state.bnbAmount) return;

  await bot.sendChatAction(chatId, "typing");

  try {
    const { fourMemeEstimateBuy } = await import("./token-launcher");
    const estimate = await Promise.race([
      fourMemeEstimateBuy(state.tokenAddress, state.bnbAmount),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Estimate timed out (30s). BSC RPC may be slow — try again.")), 30000)),
    ]);

    state.estimate = estimate;
    state.step = "confirm";
    pendingFourMemeBuy.set(chatId, state);

    await bot.sendMessage(chatId,
      `💰 BUY PREVIEW\n\n` +
      `Token: \`${state.tokenAddress}\`\n` +
      `Spend: ${state.bnbAmount} BNB\n` +
      `Est. tokens: ${parseFloat(estimate.estimatedAmount).toFixed(2)}\n` +
      `Est. cost: ${parseFloat(estimate.estimatedCost).toFixed(6)} BNB\n` +
      `Fee: ${parseFloat(estimate.estimatedFee).toFixed(6)} BNB\n` +
      `Slippage: 5%\n\n` +
      `Confirm purchase?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Buy", callback_data: `fmbuyconfirm:${state.tokenAddress}` }],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
  } catch (e: any) {
    pendingFourMemeBuy.delete(chatId);
    await bot.sendMessage(chatId, `Failed to estimate: ${e.message?.substring(0, 150) || "Unknown error"}`, { reply_markup: mainMenuKeyboard() });
  }
}

async function handleFourMemeSellFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingFourMemeSell.get(chatId)!;
  const input = text.trim();

  if (state.step === "token") {
    if (!/^0x[a-fA-F0-9]{40}$/i.test(input)) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid token contract address (0x...):");
      return;
    }
    state.tokenAddress = input.toLowerCase();
    state.step = "amount";
    pendingFourMemeSell.set(chatId, state);
    await showSellAmountPrompt(chatId, state.tokenAddress);
    return;
  }

  if (state.step === "amount") {
    const amount = parseFloat(input);
    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(chatId, "Enter a valid token amount:");
      return;
    }
    state.tokenAmount = amount.toString();
    await executeFourMemeSellConfirm(chatId, state);
    return;
  }
}

async function executeFourMemeSellConfirm(chatId: number, state: FourMemeSellState): Promise<void> {
  if (!bot || !state.tokenAddress || !state.tokenAmount) return;

  await bot.sendChatAction(chatId, "typing");

  try {
    const { fourMemeEstimateSell } = await import("./token-launcher");
    const estimate = await Promise.race([
      fourMemeEstimateSell(state.tokenAddress, state.tokenAmount),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Estimate timed out (30s). BSC RPC may be slow — try again.")), 30000)),
    ]);

    state.estimate = estimate;
    state.step = "confirm";
    pendingFourMemeSell.set(chatId, state);

    const quoteName = estimate.quote === "0x0000000000000000000000000000000000000000" ? "BNB" : "BEP20";

    await bot.sendMessage(chatId,
      `💸 SELL PREVIEW\n\n` +
      `Token: \`${state.tokenAddress}\`\n` +
      `Sell: ${state.tokenAmount} ${state.tokenSymbol || "tokens"}\n` +
      `Est. receive: ${parseFloat(estimate.fundsReceived).toFixed(6)} ${quoteName}\n` +
      `Fee: ${parseFloat(estimate.fee).toFixed(6)} ${quoteName}\n\n` +
      `Confirm sale?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Sell", callback_data: `fmsellconfirm:${state.tokenAddress}` }],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
  } catch (e: any) {
    pendingFourMemeSell.delete(chatId);
    await bot.sendMessage(chatId, `Failed to estimate: ${e.message?.substring(0, 150) || "Unknown error"}`, { reply_markup: mainMenuKeyboard() });
  }
}

async function handleQuestion(chatId: number, messageId: number, question: string, username: string): Promise<void> {
  const userId = chatId;
  const now = Date.now();
  const lastMsg = rateLimitMap.get(userId);
  if (lastMsg && now - lastMsg < RATE_LIMIT_MS) {
    return;
  }
  rateLimitMap.set(userId, now);

  if (rateLimitMap.size > 1000) {
    const cutoff = now - RATE_LIMIT_MS * 10;
    for (const [key, time] of rateLimitMap) {
      if (time < cutoff) rateLimitMap.delete(key);
    }
  }

  try {
    bot!.sendChatAction(chatId, "typing").catch(() => {});
    const answer = await generateAnswer(question, username, chatId);
    console.log(`[TelegramBot] Answering @${username}: ${answer.slice(0, 80)}...`);
    const hasCode = answer.includes("`");
    bot!.sendMessage(chatId, answer, { reply_to_message_id: messageId, parse_mode: hasCode ? "Markdown" : undefined }).catch(() => {});
  } catch (e: any) {
    console.error("[TelegramBot] Error handling message:", e.message);
    bot!.sendMessage(chatId, "Something went wrong. Try again!", { reply_to_message_id: messageId }).catch(() => {});
  }
}

export async function sendTokenProposalNotification(
  chatId: number,
  proposalId: string,
  agentName: string,
  tokenName: string,
  tokenSymbol: string,
  platform: string,
  description: string
): Promise<boolean> {
  if (!bot || !isRunning) return false;

  const platformName = platform === "four_meme" ? "Four.meme (BNB Chain)" : platform === "bankr" ? "Bankr (Base)" : "Flap.sh (BNB Chain)";
  const liquidity = platform === "bankr" ? "Managed by Bankr" : "0.01 BNB";

  try {
    await bot.sendMessage(chatId,
      `🤖 AGENT TOKEN PROPOSAL\n\n` +
      `Your agent ${agentName} wants to launch a token:\n\n` +
      `Token: ${tokenName} ($${tokenSymbol})\n` +
      `Platform: ${platformName}\n` +
      `Liquidity: ${liquidity}\n` +
      `Description: ${description.substring(0, 200)}\n\n` +
      `Approve this launch?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Approve Launch", callback_data: `proposal_approve:${proposalId}` }],
            [{ text: "❌ Reject", callback_data: `proposal_reject:${proposalId}` }],
          ]
        }
      }
    );
    return true;
  } catch (e: any) {
    console.error("[TelegramBot] Failed to send proposal notification:", e.message);
    return false;
  }
}

export async function sendTelegramMessage(chatId: string | number, text: string): Promise<boolean> {
  if (!bot || !isRunning) {
    console.warn("[TelegramBot] Cannot send message — bot is not running");
    return false;
  }

  try {
    await bot.sendMessage(chatId, text);
    return true;
  } catch (e: any) {
    console.error("[TelegramBot] Failed to send message:", e.message);
    return false;
  }
}

export function stopTelegramBot(): void {
  if (bot) {
    if (webhookMode) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (token) {
        fetch(`https://api.telegram.org/bot${token}/deleteWebhook`).catch(() => {});
      }
    } else {
      bot.stopPolling();
    }
    bot = null;
  }
  isRunning = false;
  webhookMode = false;
  console.log("[TelegramBot] Stopped");
}

export function getTelegramBotStatus(): { running: boolean } {
  return { running: isRunning };
}

async function handleChaosPlanFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingChaosPlan.get(chatId);
  if (!state) return;

  if (state.step === "token_address") {
    const addr = text.trim();
    if (!/^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      await bot.sendMessage(chatId, "That doesn't look like a valid contract address. Send a BNB Chain token address (0x...).");
      return;
    }

    await bot.sendMessage(chatId, "🔍 Checking token and your holdings...");

    try {
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const tokenContract = new ethers.Contract(addr, [
        "function balanceOf(address) view returns (uint256)",
        "function totalSupply() view returns (uint256)",
        "function symbol() view returns (string)",
        "function name() view returns (string)",
        "function decimals() view returns (uint8)",
      ], provider);

      const walletAddr = state.walletAddress!;
      const [balance, totalSupply, symbol, name, decimals] = await Promise.all([
        tokenContract.balanceOf(walletAddr),
        tokenContract.totalSupply(),
        tokenContract.symbol(),
        tokenContract.name(),
        tokenContract.decimals(),
      ]);

      const holdingPct = totalSupply > 0n ? Number((balance * 10000n) / totalSupply) / 100 : 0;

      if (holdingPct < 1) {
        await bot.sendMessage(chatId,
          `Your wallet holds only ${holdingPct.toFixed(2)}% of $${symbol}.\n\n` +
          `You need at least 1% of the supply to create a chaos plan. Buy more tokens first!`,
          { reply_markup: mainMenuKeyboard() }
        );
        pendingChaosPlan.delete(chatId);
        return;
      }

      const holdingFormatted = ethers.formatUnits(balance, decimals);
      const holdingNum = parseFloat(holdingFormatted);
      const holdingDisplay = holdingNum >= 1000 ? Math.floor(holdingNum).toLocaleString("en-US") : holdingFormatted;

      await bot.sendMessage(chatId,
        `✅ Found $${symbol} (${name})\n\n` +
        `Your holdings: ${holdingDisplay} $${symbol} (${holdingPct.toFixed(1)}% of supply)\n\n` +
        `🤖 Generating your custom chaos plan...`,
      );

      const { generateChaosPlan, formatPlanPreview } = await import("./chaos-plan-generator");
      const agentName = `${symbol}_Agent`;
      const plan = await generateChaosPlan({
        tokenAddress: addr,
        tokenSymbol: symbol,
        tokenName: name,
        walletAddress: walletAddr,
        agentName,
      });

      const preview = formatPlanPreview(plan, symbol);

      state.step = "confirming";
      state.tokenAddress = addr;
      state.tokenSymbol = symbol;
      state.tokenName = name;
      state.plan = plan;
      pendingChaosPlan.set(chatId, state);

      await bot.sendMessage(chatId, preview, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Approve & Start Plan", callback_data: "chaos_approve" }],
            [{ text: "🔄 Regenerate Plan", callback_data: "chaos_regen" }],
            [{ text: "❌ Cancel", callback_data: "chaos_cancel" }],
          ],
        },
      });

    } catch (e: any) {
      console.error("[TelegramBot] Chaos plan error:", e.message);
      await bot.sendMessage(chatId,
        `❌ Error: ${e.message?.substring(0, 200) || "Failed to check token"}\n\nTry again with /chaos`,
        { reply_markup: mainMenuKeyboard() }
      );
      pendingChaosPlan.delete(chatId);
    }
    return;
  }
}

async function handleChaosPlanCallback(chatId: number, data: string): Promise<void> {
  if (!bot) return;
  const state = pendingChaosPlan.get(chatId);

  if (data === "chaos_approve") {
    if (!state || state.step !== "confirming" || !state.plan) {
      await bot.sendMessage(chatId, "No pending chaos plan found. Use /chaos to start.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    await bot.sendMessage(chatId, "⚡ Activating chaos plan...");

    try {
      const { createChaosPlanForUser, getUserChaosPlans } = await import("./chaos-launch");

      const existing = await getUserChaosPlans(state.walletAddress!);
      const hasOverlap = existing.some(p => p.launch.tokenAddress?.toLowerCase() === state.tokenAddress!.toLowerCase());
      if (hasOverlap) {
        await bot.sendMessage(chatId, "⚠️ You already have an active chaos plan for this token. Wait for it to complete or let it finish first.", { reply_markup: mainMenuKeyboard() });
        pendingChaosPlan.delete(chatId);
        return;
      }

      const result = await createChaosPlanForUser({
        tokenAddress: state.tokenAddress!,
        tokenSymbol: state.tokenSymbol!,
        tokenName: state.tokenName!,
        walletAddress: state.walletAddress!,
        plan: state.plan,
        chatId,
      });

      if (result.success) {
        const genesisM = state.plan.milestones?.find((m: any) => m.number === 0);
        let genesisTweet = "";
        if (genesisM) {
          try {
            const { postTweet } = await import("./twitter-client");
            const tweetResult = await postTweet(genesisM.tweetTemplate);
            genesisTweet = `\n\n📢 Genesis tweet posted: https://x.com/i/status/${tweetResult.tweetId}`;
          } catch (e: any) {
            genesisTweet = "\n\n⚠️ Genesis tweet failed (plan still active)";
          }
        }

        await bot.sendMessage(chatId,
          `🔥 *CHAOS PLAN ACTIVATED*\n\n` +
          `Token: $${state.tokenSymbol}\n` +
          `Milestones: ${state.plan.milestones.length}\n` +
          `Duration: 7 days\n` +
          `Wallet: \`${state.walletAddress!.substring(0, 10)}...${state.walletAddress!.slice(-6)}\`\n\n` +
          `Your agent will autonomously execute each milestone on schedule.` +
          `${genesisTweet}\n\n` +
          `Use /chaosstatus to check progress.`,
          { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
        );
      } else {
        await bot.sendMessage(chatId, `❌ Failed to activate: ${result.error}`, { reply_markup: mainMenuKeyboard() });
      }
    } catch (e: any) {
      console.error("[TelegramBot] Chaos plan activation error:", e.message);
      await bot.sendMessage(chatId, `❌ Error: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
    }

    pendingChaosPlan.delete(chatId);
    return;
  }

  if (data === "chaos_regen") {
    if (!state || !state.tokenAddress) {
      await bot.sendMessage(chatId, "No pending chaos plan found. Use /chaos to start.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    await bot.sendMessage(chatId, "🔄 Regenerating plan...");

    try {
      const { generateChaosPlan, formatPlanPreview } = await import("./chaos-plan-generator");
      const plan = await generateChaosPlan({
        tokenAddress: state.tokenAddress,
        tokenSymbol: state.tokenSymbol!,
        tokenName: state.tokenName!,
        walletAddress: state.walletAddress!,
        agentName: `${state.tokenSymbol}_Agent`,
      });

      state.plan = plan;
      state.step = "confirming";
      pendingChaosPlan.set(chatId, state);

      const preview = formatPlanPreview(plan, state.tokenSymbol!);

      await bot.sendMessage(chatId, preview, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Approve & Start Plan", callback_data: "chaos_approve" }],
            [{ text: "🔄 Regenerate Plan", callback_data: "chaos_regen" }],
            [{ text: "❌ Cancel", callback_data: "chaos_cancel" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Error regenerating: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
      pendingChaosPlan.delete(chatId);
    }
    return;
  }

  if (data === "chaos_cancel") {
    pendingChaosPlan.delete(chatId);
    await bot.sendMessage(chatId, "Chaos plan cancelled.", { reply_markup: mainMenuKeyboard() });
    return;
  }
}

async function handleAsterMenu(chatId: number): Promise<void> {
  if (!bot) return;

  const creds = await storage.getAsterCredentials(chatId.toString());
  const connected = !!creds;

  if (!connected) {
    await bot.sendMessage(chatId,
      `📈 *Aster DEX — Futures & Spot Trading*\n\n` +
      `Trade futures and spot markets on Aster DEX directly from Telegram.\n\n` +
      `You need to connect your Aster API credentials first.\n` +
      `Get your API key at: https://www.asterdex.com`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔗 Connect Aster Account", callback_data: "aster:connect" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  await bot.sendMessage(chatId,
    `📈 *Aster DEX — Connected*\n\n` +
    `Your Aster API credentials are configured. What would you like to do?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 Balances", callback_data: "aster:balance" }],
          [{ text: "📊 Positions", callback_data: "aster:positions" }],
          [{ text: "📋 Open Orders", callback_data: "aster:orders" }],
          [{ text: "🔄 Futures Trade", callback_data: "aster:trade_futures" }, { text: "💱 Spot Trade", callback_data: "aster:trade_spot" }],
          [{ text: "🔌 Disconnect", callback_data: "aster:disconnect" }],
          [{ text: "« Back", callback_data: "action:menu" }],
        ],
      },
    }
  );
}

async function getAsterClient(chatId: number): Promise<any> {
  const creds = await storage.getAsterCredentials(chatId.toString());
  if (!creds) return null;
  const { createAsterClient } = await import("./aster-client");
  return createAsterClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
}

async function handleAsterCallback(chatId: number, data: string): Promise<void> {
  if (!bot) return;
  const action = data.replace("aster:", "");

  if (action === "connect") {
    pendingAsterConnect.set(chatId, { step: "api_key" });
    await bot.sendMessage(chatId,
      "🔗 *Connect Aster DEX*\n\n" +
      "Please send your Aster API Key:\n\n" +
      "You can create one at https://www.asterdex.com/account/api-management\n\n" +
      "Type /cancel to abort.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "disconnect") {
    await bot.sendMessage(chatId,
      "Are you sure you want to disconnect your Aster account? This will remove your stored API credentials.",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Yes, disconnect", callback_data: "aster:disconnect_confirm" }],
            [{ text: "Cancel", callback_data: "action:aster" }],
          ],
        },
      }
    );
    return;
  }

  if (action === "disconnect_confirm") {
    await storage.removeAsterCredentials(chatId.toString());
    await bot.sendMessage(chatId, "Aster account disconnected. Your API credentials have been removed.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const client = await getAsterClient(chatId);
  if (!client) {
    await bot.sendMessage(chatId, "No Aster credentials found. Connect your account first.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Connect Aster Account", callback_data: "aster:connect" }],
          [{ text: "« Back", callback_data: "action:menu" }],
        ],
      },
    });
    return;
  }

  if (action === "balance") {
    await bot.sendMessage(chatId, "Loading Aster balances...");
    try {
      const [futuresBalances, spotAccount] = await Promise.all([
        client.futures.balance().catch(() => []),
        client.spot.account().catch(() => ({ balances: [] })),
      ]);

      let msg = "💰 *Aster DEX Balances*\n\n";

      const nonZeroFutures = (futuresBalances as any[]).filter((b: any) => parseFloat(b.balance) > 0 || parseFloat(b.availableBalance) > 0);
      if (nonZeroFutures.length > 0) {
        msg += "*Futures:*\n";
        for (const b of nonZeroFutures) {
          const upnl = parseFloat(b.crossUnPnl || "0");
          const upnlStr = upnl !== 0 ? ` (uPnL: ${upnl >= 0 ? "+" : ""}${upnl.toFixed(4)})` : "";
          msg += `  ${b.asset}: ${parseFloat(b.balance).toFixed(4)} (avail: ${parseFloat(b.availableBalance).toFixed(4)})${upnlStr}\n`;
        }
      } else {
        msg += "*Futures:* No balances\n";
      }

      msg += "\n";

      const nonZeroSpot = (spotAccount.balances || []).filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
      if (nonZeroSpot.length > 0) {
        msg += "*Spot:*\n";
        for (const b of nonZeroSpot) {
          const locked = parseFloat(b.locked);
          const lockedStr = locked > 0 ? ` (locked: ${locked.toFixed(4)})` : "";
          msg += `  ${b.asset}: ${parseFloat(b.free).toFixed(4)}${lockedStr}\n`;
        }
      } else {
        msg += "*Spot:* No balances\n";
      }

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "aster:balance" }],
            [{ text: "« Back", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to fetch balances: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  if (action === "positions") {
    await bot.sendMessage(chatId, "Loading futures positions...");
    try {
      const positions = await client.futures.positions();
      const openPositions = (positions as any[]).filter((p: any) => parseFloat(p.positionAmt) !== 0);

      if (openPositions.length === 0) {
        await bot.sendMessage(chatId, "📊 *Futures Positions*\n\nNo open positions.", {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Refresh", callback_data: "aster:positions" }],
              [{ text: "« Back", callback_data: "action:aster" }],
            ],
          },
        });
        return;
      }

      let msg = "📊 *Futures Positions*\n\n";
      for (const p of openPositions) {
        const amt = parseFloat(p.positionAmt);
        const direction = amt > 0 ? "LONG" : "SHORT";
        const upnl = parseFloat(p.unRealizedProfit);
        const pnlEmoji = upnl >= 0 ? "+" : "";
        msg += `*${p.symbol}* — ${direction}\n`;
        msg += `  Size: ${Math.abs(amt)} | Leverage: ${p.leverage}x\n`;
        msg += `  Entry: ${parseFloat(p.entryPrice).toFixed(4)} | Mark: ${parseFloat(p.markPrice).toFixed(4)}\n`;
        msg += `  uPnL: ${pnlEmoji}${upnl.toFixed(4)} USDT\n`;
        if (p.liquidationPrice && parseFloat(p.liquidationPrice) > 0) {
          msg += `  Liq: ${parseFloat(p.liquidationPrice).toFixed(4)}\n`;
        }
        msg += "\n";
      }

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "aster:positions" }],
            [{ text: "« Back", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to fetch positions: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  if (action === "orders") {
    await bot.sendMessage(chatId, "Loading open orders...");
    try {
      const [futuresOrders, spotOrders] = await Promise.all([
        client.futures.openOrders().catch(() => []),
        client.spot.openOrders().catch(() => []),
      ]);

      let msg = "📋 *Open Orders*\n\n";
      let hasOrders = false;

      if ((futuresOrders as any[]).length > 0) {
        hasOrders = true;
        msg += "*Futures:*\n";
        for (const o of futuresOrders as any[]) {
          msg += `  ${o.symbol} ${o.side} ${o.type} — Qty: ${o.origQty} Price: ${o.price || "MARKET"}\n`;
          msg += `    ID: ${o.orderId}\n`;
        }
        msg += "\n";
      }

      if ((spotOrders as any[]).length > 0) {
        hasOrders = true;
        msg += "*Spot:*\n";
        for (const o of spotOrders as any[]) {
          msg += `  ${o.symbol} ${o.side} ${o.type} — Qty: ${o.origQty} Price: ${o.price || "MARKET"}\n`;
          msg += `    ID: ${o.orderId}\n`;
        }
      }

      if (!hasOrders) {
        msg += "No open orders.";
      }

      const buttons: TelegramBot.InlineKeyboardButton[][] = [];
      if (hasOrders) {
        buttons.push([{ text: "❌ Cancel All Futures Orders", callback_data: "aster:cancel_all_orders" }]);
      }
      buttons.push([{ text: "🔄 Refresh", callback_data: "aster:orders" }]);
      buttons.push([{ text: "« Back", callback_data: "action:aster" }]);

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to fetch orders: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  if (action === "cancel_all_orders") {
    await bot.sendMessage(chatId,
      "Which symbol's orders do you want to cancel? Send the symbol (e.g. BTCUSDT) or type /cancel to abort."
    );
    pendingAsterTrade.set(chatId, { step: "cancel_symbol", market: "futures" });
    return;
  }

  if (action === "trade_futures") {
    pendingAsterTrade.set(chatId, { step: "symbol", market: "futures" });
    await bot.sendMessage(chatId,
      "🔄 *Futures Trade*\n\n" +
      "Enter the trading pair symbol (e.g. BTCUSDT, ETHUSDT):",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "trade_spot") {
    pendingAsterTrade.set(chatId, { step: "symbol", market: "spot" });
    await bot.sendMessage(chatId,
      "💱 *Spot Trade*\n\n" +
      "Enter the trading pair symbol (e.g. BTCUSDT, ETHUSDT):",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "trade_confirm") {
    const state = pendingAsterTrade.get(chatId);
    if (!state || state.step !== "confirm") {
      await bot.sendMessage(chatId, "No pending trade. Start over with /aster.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    await bot.sendMessage(chatId, "Placing order...");

    try {
      if (state.market === "futures") {
        if (state.leverage) {
          try {
            await client.futures.setLeverage(state.symbol!, state.leverage);
          } catch (e: any) {
            if (!e.message?.includes("No need to change")) {
              console.warn(`[Aster] Leverage set warning: ${e.message}`);
            }
          }
        }

        const orderResult = await client.futures.createOrder({
          symbol: state.symbol!,
          side: state.side!,
          type: state.orderType!,
          quantity: state.quantity!,
          price: state.orderType === "LIMIT" ? state.price : undefined,
          timeInForce: state.orderType === "LIMIT" ? "GTC" : undefined,
        });

        await bot.sendMessage(chatId,
          `*Order Placed*\n\n` +
          `Symbol: ${orderResult.symbol}\n` +
          `Side: ${orderResult.side}\n` +
          `Type: ${orderResult.type}\n` +
          `Quantity: ${orderResult.origQty}\n` +
          `${state.orderType === "LIMIT" ? `Price: ${orderResult.price}\n` : ""}` +
          `Order ID: ${orderResult.orderId}\n` +
          `Status: ${orderResult.status}`,
          { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
        );
      } else {
        const orderResult = await client.spot.createOrder({
          symbol: state.symbol!,
          side: state.side!,
          type: state.orderType!,
          quantity: state.quantity!,
          price: state.orderType === "LIMIT" ? state.price : undefined,
          timeInForce: state.orderType === "LIMIT" ? "GTC" : undefined,
        });

        await bot.sendMessage(chatId,
          `*Order Placed*\n\n` +
          `Symbol: ${orderResult.symbol}\n` +
          `Side: ${orderResult.side}\n` +
          `Type: ${orderResult.type}\n` +
          `Quantity: ${orderResult.origQty}\n` +
          `${state.orderType === "LIMIT" ? `Price: ${orderResult.price}\n` : ""}` +
          `Order ID: ${orderResult.orderId}\n` +
          `Status: ${orderResult.status}`,
          { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to place order: ${e.message?.substring(0, 300)}`, { reply_markup: mainMenuKeyboard() });
    }

    pendingAsterTrade.delete(chatId);
    return;
  }

  if (action === "trade_cancel") {
    pendingAsterTrade.delete(chatId);
    await bot.sendMessage(chatId, "Trade cancelled.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (action === "side_buy") {
    await handleAsterSideCallback(chatId, "BUY");
    return;
  }

  if (action === "side_sell") {
    await handleAsterSideCallback(chatId, "SELL");
    return;
  }

  if (action === "type_market") {
    await handleAsterTypeCallback(chatId, "MARKET");
    return;
  }

  if (action === "type_limit") {
    await handleAsterTypeCallback(chatId, "LIMIT");
    return;
  }

  if (action.startsWith("lev_")) {
    const lev = parseInt(action.replace("lev_", ""), 10);
    if (!isNaN(lev)) {
      await handleAsterLeverageCallback(chatId, lev);
    }
    return;
  }
}

async function handleAsterConnectFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingAsterConnect.get(chatId);
  if (!state) return;

  const input = text.trim();

  if (state.step === "api_key") {
    if (input.length < 10) {
      await bot.sendMessage(chatId, "That doesn't look like a valid API key. Please try again or type /cancel.");
      return;
    }
    state.apiKey = input;
    state.step = "api_secret";
    pendingAsterConnect.set(chatId, state);
    await bot.sendMessage(chatId, "Now send your Aster API Secret:");
    return;
  }

  if (state.step === "api_secret") {
    if (input.length < 10) {
      await bot.sendMessage(chatId, "That doesn't look like a valid API secret. Please try again or type /cancel.");
      return;
    }

    await bot.sendMessage(chatId, "Verifying credentials...");

    try {
      const { createAsterClient } = await import("./aster-client");
      const testClient = createAsterClient({ apiKey: state.apiKey!, apiSecret: input });
      const pingOk = await testClient.futures.ping();

      if (!pingOk) {
        await bot.sendMessage(chatId, "Could not connect to Aster DEX. Please check your credentials and try again.", { reply_markup: mainMenuKeyboard() });
        pendingAsterConnect.delete(chatId);
        return;
      }

      await storage.saveAsterCredentials(chatId.toString(), state.apiKey!, input);
      pendingAsterConnect.delete(chatId);

      await bot.sendMessage(chatId,
        "Aster DEX account connected! Your API credentials are stored securely (encrypted).\n\n" +
        "You can now trade futures and spot on Aster DEX.",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💰 View Balances", callback_data: "aster:balance" }],
              [{ text: "📈 Aster Menu", callback_data: "action:aster" }],
              [{ text: "« Main Menu", callback_data: "action:menu" }],
            ],
          },
        }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to verify credentials: ${e.message?.substring(0, 200)}\n\nPlease try again.`, { reply_markup: mainMenuKeyboard() });
      pendingAsterConnect.delete(chatId);
    }
    return;
  }
}

async function handleAsterTradeFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state) return;

  const input = text.trim().toUpperCase();

  if (state.step === "cancel_symbol") {
    if (!/^[A-Z]{2,20}$/.test(input)) {
      await bot.sendMessage(chatId, "Invalid symbol. Enter a valid trading pair like BTCUSDT, ETHUSDT. Or type /cancel.");
      return;
    }
    try {
      const creds = await storage.getAsterCredentials(chatId.toString());
      if (!creds) { pendingAsterTrade.delete(chatId); return; }
      const { createAsterClient } = await import("./aster-client");
      const client = createAsterClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
      await client.futures.cancelAllOrders(input);
      await bot.sendMessage(chatId, `✅ All open orders for *${input}* have been cancelled.`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to cancel orders: ${e.message?.substring(0, 100)}`, { reply_markup: mainMenuKeyboard() });
    }
    pendingAsterTrade.delete(chatId);
    return;
  }

  if (state.step === "symbol") {
    if (!/^[A-Z]{2,20}$/.test(input)) {
      await bot.sendMessage(chatId, "Invalid symbol. Enter a valid trading pair like BTCUSDT, ETHUSDT. Or type /cancel.");
      return;
    }
    state.symbol = input;
    state.step = "side";
    pendingAsterTrade.set(chatId, state);

    await bot.sendMessage(chatId,
      `Symbol: *${input}*\n\nChoose direction:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "BUY / LONG", callback_data: "aster:side_buy" }, { text: "SELL / SHORT", callback_data: "aster:side_sell" }],
            [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
          ],
        },
      }
    );
    return;
  }

  if (state.step === "quantity") {
    const qty = parseFloat(input);
    if (isNaN(qty) || qty <= 0) {
      await bot.sendMessage(chatId, "Invalid quantity. Enter a positive number (e.g. 0.001, 1, 100). Or type /cancel.");
      return;
    }
    state.quantity = input;

    if (state.orderType === "LIMIT") {
      state.step = "price";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId, "Enter the limit price:");
      return;
    }

    if (state.market === "futures") {
      state.step = "leverage";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId,
        "Set leverage (1-125):",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "1x", callback_data: "aster:lev_1" }, { text: "3x", callback_data: "aster:lev_3" }, { text: "5x", callback_data: "aster:lev_5" }],
              [{ text: "10x", callback_data: "aster:lev_10" }, { text: "20x", callback_data: "aster:lev_20" }, { text: "50x", callback_data: "aster:lev_50" }],
              [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
            ],
          },
        }
      );
      return;
    }

    showAsterTradeConfirmation(chatId, state);
    return;
  }

  if (state.step === "price") {
    const price = parseFloat(input);
    if (isNaN(price) || price <= 0) {
      await bot.sendMessage(chatId, "Invalid price. Enter a positive number. Or type /cancel.");
      return;
    }
    state.price = input;

    if (state.market === "futures") {
      state.step = "leverage";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId,
        "Set leverage (1-125):",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "1x", callback_data: "aster:lev_1" }, { text: "3x", callback_data: "aster:lev_3" }, { text: "5x", callback_data: "aster:lev_5" }],
              [{ text: "10x", callback_data: "aster:lev_10" }, { text: "20x", callback_data: "aster:lev_20" }, { text: "50x", callback_data: "aster:lev_50" }],
              [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
            ],
          },
        }
      );
      return;
    }

    showAsterTradeConfirmation(chatId, state);
    return;
  }

  if (state.step === "leverage") {
    const lev = parseInt(input, 10);
    if (isNaN(lev) || lev < 1 || lev > 125) {
      await bot.sendMessage(chatId, "Invalid leverage. Enter a number between 1 and 125. Or type /cancel.");
      return;
    }
    state.leverage = lev;
    showAsterTradeConfirmation(chatId, state);
    return;
  }
}

async function showAsterTradeConfirmation(chatId: number, state: AsterTradeState): Promise<void> {
  if (!bot) return;
  state.step = "confirm";
  pendingAsterTrade.set(chatId, state);

  let msg = `*Confirm ${state.market === "futures" ? "Futures" : "Spot"} Order*\n\n`;
  msg += `Symbol: ${state.symbol}\n`;
  msg += `Side: ${state.side}\n`;
  msg += `Type: ${state.orderType}\n`;
  msg += `Quantity: ${state.quantity}\n`;
  if (state.orderType === "LIMIT") msg += `Price: ${state.price}\n`;
  if (state.market === "futures" && state.leverage) msg += `Leverage: ${state.leverage}x\n`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Confirm Order", callback_data: "aster:trade_confirm" }],
        [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
      ],
    },
  });
}

async function handleAsterSideCallback(chatId: number, side: "BUY" | "SELL"): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state || state.step !== "side") return;

  state.side = side;
  state.step = "type";
  pendingAsterTrade.set(chatId, state);

  await bot.sendMessage(chatId,
    `${state.symbol} — ${side}\n\nOrder type:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Market", callback_data: "aster:type_market" }, { text: "Limit", callback_data: "aster:type_limit" }],
          [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
        ],
      },
    }
  );
}

async function handleAsterTypeCallback(chatId: number, orderType: "MARKET" | "LIMIT"): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state || state.step !== "type") return;

  state.orderType = orderType;
  state.step = "quantity";
  pendingAsterTrade.set(chatId, state);

  await bot.sendMessage(chatId, `${state.symbol} — ${state.side} ${orderType}\n\nEnter quantity:`);
}

async function handleAsterLeverageCallback(chatId: number, leverage: number): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state) return;

  state.leverage = leverage;
  showAsterTradeConfirmation(chatId, state);
}

async function handleOKXSwapFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingOKXSwap.get(chatId);
  if (!state) return;

  if (state.step === "from_token") {
    if (!text.startsWith("0x") || text.length < 42) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid token contract address (0x...):");
      return;
    }
    state.fromToken = text.trim();
    state.fromSymbol = text.trim().substring(0, 8) + "...";
    state.step = "to_token";
    const tokens = getOKXTokensForChain(state.chainId!);
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxswap_to:${t.address}:${t.symbol}` }]);
    tokenButtons.push([{ text: "📝 Custom Address", callback_data: "okxswap_to_custom" }]);
    await bot.sendMessage(chatId,
      `Token to sell: ${state.fromSymbol}\n\nSelect token to buy:`,
      { reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (state.step === "to_token") {
    if (!text.startsWith("0x") || text.length < 42) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid token contract address (0x...):");
      return;
    }
    state.toToken = text.trim();
    state.toSymbol = text.trim().substring(0, 8) + "...";
    state.step = "amount";
    await bot.sendMessage(chatId, `Enter the amount of ${state.fromSymbol} to swap:`);
    return;
  }

  if (state.step === "amount") {
    const num = Number(text);
    if (isNaN(num) || num <= 0) {
      await bot.sendMessage(chatId, "Invalid amount. Enter a positive number:");
      return;
    }
    state.amount = text.trim();
    state.step = "confirm";

    const fromTokenInfo = getOKXTokensForChain(state.chainId!).find(t => t.address === state.fromToken);
    const decimals = fromTokenInfo?.decimals || 18;
    const rawAmount = parseHumanAmount(state.amount, decimals);

    await bot.sendMessage(chatId, "Getting quote from OKX DEX Aggregator...");
    sendTyping(chatId);

    try {
      const { getSwapQuote } = await import("./okx-onchainos");
      const quote = await getSwapQuote({
        chainId: state.chainId!,
        fromTokenAddress: state.fromToken!,
        toTokenAddress: state.toToken!,
        amount: rawAmount,
        slippage: "1",
      });

      state.quoteData = quote;
      const toTokenInfo = getOKXTokensForChain(state.chainId!).find(t => t.address === state.toToken);
      const toDecimals = toTokenInfo?.decimals || 18;
      const receiveAmount = quote?.data?.[0]?.toTokenAmount
        ? formatTokenAmount(quote.data[0].toTokenAmount, toDecimals)
        : "—";

      await bot.sendMessage(chatId,
        `🔄 *OKX Swap Quote*\n\n` +
        `Chain: ${state.chainName}\n` +
        `Sell: ${state.amount} ${state.fromSymbol}\n` +
        `Buy: ~${receiveAmount} ${state.toSymbol}\n` +
        `Fee: 0.5% to BUILD4 treasury\n\n` +
        `_To execute this swap, connect your wallet on the BUILD4 dashboard._`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 New Swap", callback_data: "action:okxswap" }],
              [{ text: "« Menu", callback_data: "action:menu" }],
            ]
          }
        }
      );
      pendingOKXSwap.delete(chatId);
    } catch (err: any) {
      await bot.sendMessage(chatId,
        `Failed to get quote: ${err.message}\n\nTry again or go back to menu.`,
        { reply_markup: { inline_keyboard: [[{ text: "🔄 Try Again", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      pendingOKXSwap.delete(chatId);
    }
    return;
  }
}

async function handleOKXBridgeFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingOKXBridge.get(chatId);
  if (!state) return;

  if (state.step === "amount") {
    const num = Number(text);
    if (isNaN(num) || num <= 0) {
      await bot.sendMessage(chatId, "Invalid amount. Enter a positive number:");
      return;
    }
    state.amount = text.trim();
    state.step = "receiver";

    const wallets = getUserWallets(chatId);
    const activeIdx = getActiveWalletIndex(chatId);
    const currentWallet = wallets[activeIdx];

    if (currentWallet) {
      const shortAddr = currentWallet.substring(0, 8) + "..." + currentWallet.slice(-6);
      await bot.sendMessage(chatId,
        `Enter the wallet address to receive tokens on ${state.toChainName}:\n\n` +
        `Or tap below to use your current wallet:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: `Use ${shortAddr}`, callback_data: `okxbridge_usewallet:${currentWallet}` }],
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(chatId, `Enter the wallet address to receive tokens on ${state.toChainName} (0x...):`);
    }
    return;
  }

  if (state.step === "receiver") {
    const addr = text.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      await bot.sendMessage(chatId, "Invalid wallet address. Enter a valid 0x address:");
      return;
    }
    state.receiver = addr;
    await executeBridgeQuote(chatId, state);
    return;
  }
}

async function executeBridgeQuote(chatId: number, state: OKXBridgeState): Promise<void> {
  if (!bot) return;

  const rawAmount = parseHumanAmount(state.amount!, state.fromDecimals || 18);

  await bot.sendMessage(chatId, "Getting bridge quote from OKX...");
  sendTyping(chatId);

  try {
    const { getCrossChainQuote } = await import("./okx-onchainos");
    const quote = await getCrossChainQuote({
      fromChainId: state.fromChainId!,
      toChainId: state.toChainId!,
      fromTokenAddress: state.fromToken!,
      toTokenAddress: state.toToken!,
      amount: rawAmount,
      slippage: "1",
    });

    state.quoteData = quote;
    const receiveAmount = quote?.data?.[0]?.toTokenAmount
      ? formatTokenAmount(quote.data[0].toTokenAmount, state.toDecimals || 18)
      : "—";

    const estTime = quote?.data?.[0]?.estimatedTime;
    const timeStr = estTime
      ? (Number(estTime) < 60 ? `${estTime}s` : `~${Math.ceil(Number(estTime) / 60)} min`)
      : "—";
    const bridgeName = quote?.data?.[0]?.bridgeName || "—";
    const shortReceiver = state.receiver!.substring(0, 8) + "..." + state.receiver!.slice(-6);

    await bot.sendMessage(chatId,
      `🌉 *OKX Bridge Quote*\n\n` +
      `Route: ${state.fromChainName} → ${state.toChainName}\n` +
      `Send: ${state.amount} ${state.fromSymbol}\n` +
      `Receive: ~${receiveAmount} ${state.toSymbol}\n` +
      `Via: ${bridgeName}\n` +
      `Est. Time: ${timeStr}\n` +
      `Deliver To: ${shortReceiver}\n` +
      `Fee: 0.5% to BUILD4 treasury\n\n` +
      `_To execute this bridge, connect your wallet on the BUILD4 dashboard._`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌉 New Bridge", callback_data: "action:okxbridge" }],
            [{ text: "« Menu", callback_data: "action:menu" }],
          ]
        }
      }
    );
    pendingOKXBridge.delete(chatId);
  } catch (err: any) {
    await bot.sendMessage(chatId,
      `Failed to get bridge quote: ${err.message}\n\nTry again or go back to menu.`,
      { reply_markup: { inline_keyboard: [[{ text: "🌉 Try Again", callback_data: "action:okxbridge" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
    );
    pendingOKXBridge.delete(chatId);
  }
}

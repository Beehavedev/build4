import TelegramBot from "node-telegram-bot-api";
import { ethers } from "ethers";
import { runInferenceWithFallback } from "./inference";
import { storage } from "./storage";
import { registerAgentOnchain, registerAgentERC8004, registerAgentBAP578, isOnchainReady, getExplorerUrl } from "./onchain";

let bot: TelegramBot | null = null;
let isRunning = false;
let botUsername: string | null = null;
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

const pendingAgentCreation = new Map<number, AgentCreationState>();
const pendingTask = new Map<number, TaskState>();
const pendingTokenLaunch = new Map<number, TokenLaunchState>();
const pendingFourMemeBuy = new Map<number, FourMemeBuyState>();
const pendingFourMemeSell = new Map<number, FourMemeSellState>();
const pendingWallet = new Set<number>();
const pendingImportWallet = new Set<number>();
const pendingChaosPlan = new Map<number, ChaosPlanState>();

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
    return "Commands:\n🚀 /launch — Launch a token\n🤖 /newagent — Create an AI agent\n📋 /myagents — Your agents\n📝 /task — Assign a task\n👛 /wallet — Wallet info\n💱 /buy — Buy tokens\n📉 /sell — Sell tokens\n🔥 /chaos — Chaos plan\n❓ /ask — Ask anything\n❌ /cancel — Cancel current action";
  if (lower.includes("thank"))
    return "You're welcome! Let me know if you need anything else. 🤝";

  return null;
}

async function loadWalletsFromDb(): Promise<void> {
  try {
    const allLinks = await storage.getAllTelegramWalletLinks();
    telegramWalletMap.clear();
    walletsWithKey.clear();
    for (const link of allLinks) {
      const chatId = parseInt(link.chatId, 10);
      const existing = telegramWalletMap.get(chatId);
      if (existing) {
        existing.wallets.push(link.walletAddress);
        if (link.isActive) existing.active = existing.wallets.length - 1;
      } else {
        telegramWalletMap.set(chatId, { wallets: [link.walletAddress], active: link.isActive ? 0 : 0 });
      }
      if (link.encryptedPrivateKey) {
        walletsWithKey.add(`${link.chatId}:${link.walletAddress}`);
      }
    }
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

async function ensureWalletsLoaded(chatId: number): Promise<void> {
  if (telegramWalletMap.has(chatId)) return;
  try {
    const rows = await storage.getTelegramWallets(chatId.toString());
    if (rows.length > 0) {
      const wallets: string[] = [];
      let activeIdx = 0;
      for (let i = 0; i < rows.length; i++) {
        wallets.push(rows[i].walletAddress);
        if (rows[i].isActive) activeIdx = i;
      }
      telegramWalletMap.set(chatId, { wallets, active: activeIdx });
      console.log(`[TelegramBot] Loaded ${rows.length} wallets from DB for chatId ${chatId}`);
    }
  } catch (e) {
    console.error("[TelegramBot] DB wallet lookup error:", e);
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
      [{ text: "💎 Make Me Rich", callback_data: "action:trade" }],
      [{ text: "🤖 Create Agent", callback_data: "action:newagent" }, { text: "📋 My Agents", callback_data: "action:myagents" }],
      [{ text: "📝 New Task", callback_data: "action:task" }, { text: "📊 My Tasks", callback_data: "action:mytasks" }],
      [{ text: "👛 My Wallet", callback_data: "action:wallet" }],
      [{ text: "❓ Help & Commands", callback_data: "action:help" }],
    ]
  };
}

let startingBot = false;

async function clearTelegramPolling(token: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`);
      const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=1`);
      const data = await resp.json();
      if (data.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
}

export async function startTelegramBot(): Promise<void> {
  if (isRunning || startingBot || !isTelegramConfigured()) return;
  startingBot = true;

  const token = process.env.TELEGRAM_BOT_TOKEN!;

  try {
    if (bot) {
      try { bot.stopPolling(); } catch {}
      bot = null;
      isRunning = false;
    }

    await clearTelegramPolling(token);
    console.log("[TelegramBot] Cleared webhook and flushed pending updates");

    await new Promise(resolve => setTimeout(resolve, 2000));

    bot = new TelegramBot(token, {
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 30 }
      }
    });
    isRunning = true;

    loadWalletsFromDb().catch(e => console.error("[TelegramBot] Wallet load error:", e.message));

    const me = await bot.getMe();
    botUsername = me.username || null;
    console.log(`[TelegramBot] Started with polling as @${botUsername}`);

    bot.setMyCommands([
      { command: "start", description: "Start BUILD4 and create a wallet" },
      { command: "launch", description: "Launch a token on Four.meme or Flap.sh" },
      { command: "newagent", description: "Create an AI agent" },
      { command: "myagents", description: "View your agents" },
      { command: "task", description: "Assign a task to your agent" },
      { command: "wallet", description: "Wallet info and management" },
      { command: "ask", description: "Ask anything about BUILD4" },
      { command: "cancel", description: "Cancel current action" },
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

    bot.on("message", async (msg) => {
      try {
        await handleMessage(msg);
      } catch (e: any) {
        console.error("[TelegramBot] Unhandled error in message handler:", e.message);
      }
    });

    bot.on("callback_query", async (query) => {
      try {
        await handleCallbackQuery(query);
      } catch (e: any) {
        console.error("[TelegramBot] Callback query error:", e.message);
      }
    });

    let conflictCount = 0;
    bot.on("polling_error", (error) => {
      if (error.message?.includes("409 Conflict")) {
        conflictCount++;
        if (conflictCount <= 3) {
          console.warn(`[TelegramBot] 409 Conflict (${conflictCount}) — waiting for old instance to stop`);
        }
        return;
      }
      console.error("[TelegramBot] Polling error:", error.message);
    });

  } catch (e: any) {
    console.error("[TelegramBot] Failed to start:", e.message);
    isRunning = false;
  } finally {
    startingBot = false;
  }
}

async function handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
  if (!bot || !query.data || !query.message) return;
  const chatId = query.message.chat.id;
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});
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
      "🤖 /newagent — Create an AI agent\n" +
      "📋 /myagents — Your agents\n" +
      "📝 /task — Assign a task\n" +
      "📊 /mytasks — Recent tasks\n" +
      "👛 /wallet — Wallet info\n" +
      "🔗 /linkwallet — Connect wallet\n" +
      "❓ /ask <question> — Ask anything\n" +
      "🔔 /mychatid — Chat ID for notifications\n" +
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
    if (!walletsWithKey.has(`${chatId}:${wallet}`)) {
      await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first (/linkwallet).");
      return;
    }
    pendingFourMemeBuy.set(chatId, { step: "token" });
    await bot.sendMessage(chatId, "Enter the token contract address you want to buy (0x...):");
    return;
  }

  if (data === "action:sell") {
    if (!walletsWithKey.has(`${chatId}:${wallet}`)) {
      await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first (/linkwallet).");
      return;
    }
    pendingFourMemeSell.set(chatId, { step: "token" });
    await bot.sendMessage(chatId, "Enter the token contract address you want to sell (0x...):");
    return;
  }

  if (data === "action:trade") {
    if (!walletsWithKey.has(`${chatId}:${wallet}`)) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to use the trading agent. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    await bot.sendMessage(chatId,
      "💎 *Make Me Rich — Autonomous Trading Agent*\n\n" +
      "The agent scans Four.meme for new token launches, evaluates momentum signals, and trades automatically from your wallet.\n\n" +
      "Settings:\n" +
      "• Buy amount per trade\n" +
      "• Take-profit target (auto-sell)\n" +
      "• Stop-loss protection\n" +
      "• Max open positions\n\n" +
      "Choose an action:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "▶️ Enable Trading", callback_data: "trade:enable" }, { text: "⏸ Disable", callback_data: "trade:disable" }],
            [{ text: "📊 Status", callback_data: "trade:status" }, { text: "⚙️ Settings", callback_data: "trade:settings" }],
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
      const { config, positions, history } = getUserTradingStatus(chatId);
      let msg = `📊 *Trading Agent Status*\n\n`;
      msg += `Status: ${config.enabled ? "✅ ACTIVE" : "⏸ DISABLED"}\n`;
      msg += `Buy Size: ${config.buyAmountBnb} BNB\n`;
      msg += `Take Profit: ${config.takeProfitMultiple}x\n`;
      msg += `Stop Loss: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
      msg += `Max Positions: ${config.maxPositions}\n\n`;
      if (positions.length > 0) {
        msg += `*Open Positions (${positions.length}):*\n`;
        for (const p of positions) {
          const age = Math.floor((Date.now() - p.entryTime) / 60000);
          msg += `  • $${p.tokenSymbol} — ${p.entryPriceBnb} BNB (${age}m ago)\n`;
        }
      } else {
        msg += `No open positions.\n`;
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
              [{ text: "SL -10%", callback_data: "tradeset:sl:0.9" }, { text: "SL -15%", callback_data: "tradeset:sl:0.85" }, { text: "SL -25%", callback_data: "tradeset:sl:0.75" }],
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
    if (!wallet || !walletsWithKey.has(`${chatId}:${wallet}`)) {
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
    if (!wallet || !walletsWithKey.has(`${chatId}:${wallet}`)) {
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
      if (!walletsWithKey.has(`${chatId}:${wallet}`)) {
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
      if (!walletsWithKey.has(`${chatId}:${wallet}`)) {
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
      if (!wallet || !walletsWithKey.has(`${chatId}:${wallet}`)) {
        await bot.sendMessage(chatId, "You need a wallet with a private key to use the trading agent. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard() });
        return;
      }

      await bot.sendMessage(chatId,
        "🤖 *Autonomous Trading Agent*\n\n" +
        "The trading agent scans Four.meme for new token launches, evaluates momentum signals, and trades automatically from your wallet.\n\n" +
        "⚙️ Settings:\n" +
        "• Buy amount per trade\n" +
        "• Take-profit target (auto-sell)\n" +
        "• Stop-loss protection\n" +
        "• Max open positions\n\n" +
        "Choose an action:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "▶️ Enable Trading", callback_data: "trade:enable" }, { text: "⏸ Disable", callback_data: "trade:disable" }],
              [{ text: "📊 Status", callback_data: "trade:status" }, { text: "⚙️ Settings", callback_data: "trade:settings" }],
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
      const { config, positions, history } = getUserTradingStatus(chatId);

      let msg = `📊 *Trading Agent Status*\n\n`;
      msg += `Status: ${config.enabled ? "✅ ACTIVE" : "⏸ DISABLED"}\n`;
      msg += `Buy Size: ${config.buyAmountBnb} BNB\n`;
      msg += `Take Profit: ${config.takeProfitMultiple}x\n`;
      msg += `Stop Loss: ${(config.stopLossMultiple * 100).toFixed(0)}%\n`;
      msg += `Max Positions: ${config.maxPositions}\n\n`;

      if (positions.length > 0) {
        msg += `*Open Positions (${positions.length}):*\n`;
        for (const p of positions) {
          const age = Math.floor((Date.now() - p.entryTime) / 60000);
          msg += `  • $${p.tokenSymbol} — ${p.entryPriceBnb} BNB (${age}m ago)\n`;
        }
      } else {
        msg += `No open positions.\n`;
      }

      const wins = history.filter(h => h.status === "closed_profit").length;
      const losses = history.filter(h => h.status === "closed_loss").length;
      if (history.length > 0) {
        msg += `\n*Recent: ${wins}W / ${losses}L (${history.length} total)*`;
      }

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
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

async function createAgent(chatId: number, name: string, bio: string, model: string): Promise<void> {
  if (!bot) return;
  const wallet = getLinkedWallet(chatId);
  if (!wallet) return;

  pendingAgentCreation.delete(chatId);

  try {
    await bot.sendChatAction(chatId, "typing");
    const initialDeposit = "1000000000000000";
    const result = await storage.createFullAgent(name, bio, model, initialDeposit, undefined, undefined, wallet);
    const agentId = result.agent.id;

    await bot.sendMessage(chatId,
      `Agent created!\n\n${result.agent.name} | ${shortModel(model)}\nID: ${agentId}\n\nRegistering on-chain...`,
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
    bot.stopPolling();
    bot = null;
  }
  isRunning = false;
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

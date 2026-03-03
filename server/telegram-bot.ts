import TelegramBot from "node-telegram-bot-api";
import { runInferenceWithFallback } from "./inference";
import { storage } from "./storage";
import { registerAgentOnchain, registerAgentERC8004, registerAgentBAP578, isOnchainReady, getExplorerUrl } from "./onchain";

let bot: TelegramBot | null = null;
let isRunning = false;
let botUsername: string | null = null;
let appBaseUrl: string | null = null;

interface UserWallets { wallets: string[]; active: number }
const telegramWalletMap = new Map<number, UserWallets>();

interface AgentCreationState { step: "name" | "bio" | "model"; name?: string; bio?: string }
interface TaskState { step: "describe"; agentId: string; taskType: string; agentName: string }
interface TokenLaunchState { step: "platform" | "name" | "symbol" | "description"; agentId: string; agentName: string; platform?: string; tokenName?: string; tokenSymbol?: string; tokenDescription?: string }

const pendingAgentCreation = new Map<number, AgentCreationState>();
const pendingTask = new Map<number, TaskState>();
const pendingTokenLaunch = new Map<number, TokenLaunchState>();
const pendingWallet = new Set<number>();

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
- ERC-8004 (Trustless Agents): On-chain identity, reputation, and validation registries. Co-authored with MetaMask, Ethereum Foundation, Google, Coinbase. BUILD4 is live on Base and Ethereum mainnet.
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
const RATE_LIMIT_MS = 5000;

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

async function generateAnswer(question: string, username: string): Promise<string> {
  try {
    const liveStats = await getLiveStats();
    const enrichedPrompt = `${SYSTEM_PROMPT}\n\n${liveStats}`;

    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic", "ritual"],
      undefined,
      `User @${username} asks: ${question}`,
      { systemPrompt: enrichedPrompt, temperature: 0.6 }
    );

    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      return result.text.trim();
    }
  } catch (e: any) {
    console.error("[TelegramBot] Inference error:", e.message);
  }

  return generateFallbackAnswer(question);
}

function generateFallbackAnswer(question: string): string {
  const lower = question.toLowerCase();

  if (lower.includes("what is build4") || lower.includes("what's build4")) {
    return "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer. Agents get their own wallets, trade skills, evolve, fork, and operate fully on-chain. Check build4.io for more!";
  }
  if (lower.includes("chain") || lower.includes("network")) {
    return "BUILD4 runs on BNB Chain, Base, and XLayer. All agent wallets, skill trades, and replication happen on-chain across these networks.";
  }
  if (lower.includes("wallet") || lower.includes("identity")) {
    return "On BUILD4, your wallet address (0x...) IS your identity. No registration needed — fully permissionless. Every agent gets its own on-chain wallet for deposits, withdrawals, and transfers.";
  }
  if (lower.includes("skill")) {
    return "The Skills Marketplace lets agents list, buy, and sell capabilities. Revenue splits 3 ways between creator, platform, and referrer. All on-chain.";
  }
  if (lower.includes("inference") || lower.includes("ai")) {
    return "BUILD4 uses decentralized inference through Hyperbolic, Akash ML, and Ritual — no centralized AI providers like OpenAI. Fully decentralized compute.";
  }
  if (lower.includes("erc-8004") || lower.includes("erc8004")) {
    return "ERC-8004 (Trustless Agents) provides on-chain identity, reputation, and validation registries. BUILD4 is live on Base and Ethereum mainnet with this standard.";
  }
  if (lower.includes("bap-578") || lower.includes("bap578") || lower.includes("nfa")) {
    return "BAP-578 is BNB Chain's Non-Fungible Agent standard extending ERC-721. BUILD4's registry is live at 0xd7Deb29ddBB13607375Ce50405A574AC2f7d978d on BNB Chain.";
  }
  if (lower.includes("privacy") || lower.includes("zerc20")) {
    return "BUILD4 supports ZERC20 privacy transfers using zero-knowledge proof-of-burn mechanisms for private on-chain transactions.";
  }
  if (lower.includes("contract") || lower.includes("smart contract")) {
    return "BUILD4 has 4 core contracts: AgentEconomyHub (wallets), SkillMarketplace (skill trading), AgentReplication (forking + NFTs), and ConstitutionRegistry (immutable agent laws).";
  }

  return "Great question! BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer. For detailed info, check build4.io or ask me something specific!";
}

function getLinkedWallet(chatId: number): string | undefined {
  const data = telegramWalletMap.get(chatId);
  if (!data || data.wallets.length === 0) return undefined;
  return data.wallets[data.active] || data.wallets[0];
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
  return true;
}

function removeWallet(chatId: number, index: number): boolean {
  const data = telegramWalletMap.get(chatId);
  if (!data || index < 0 || index >= data.wallets.length) return false;
  data.wallets.splice(index, 1);
  if (data.wallets.length === 0) {
    telegramWalletMap.delete(chatId);
    return true;
  }
  if (data.active >= data.wallets.length) data.active = 0;
  telegramWalletMap.set(chatId, data);
  return true;
}

export function getChatIdByWallet(wallet: string): number | undefined {
  const lowerWallet = wallet.toLowerCase();
  for (const [chatId, data] of telegramWalletMap.entries()) {
    if (data.wallets.includes(lowerWallet)) return chatId;
  }
  return undefined;
}

export function linkTelegramWallet(chatId: number, wallet: string): void {
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

  console.log(`[TelegramBot] Wallet linked via web for chatId ${chatId}: ${wallet.substring(0, 8)}...`);
  if (bot) {
    const count = getUserWallets(chatId).length;
    const msg = count > 1
      ? `Wallet added: ${shortWallet(lower)} (${count} wallets — this one is now active)`
      : `Wallet connected: ${shortWallet(lower)}`;
    bot.sendMessage(chatId, msg, { reply_markup: mainMenuKeyboard(true, chatId) }).catch(() => {});
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

async function getMyAgents(wallet: string) {
  return storage.getAgentsByWallet(wallet);
}

async function promptWalletConnect(chatId: number): Promise<void> {
  if (!bot) return;
  const walletUrl = getWalletConnectUrl(chatId);
  await bot.sendMessage(chatId,
    "You need a wallet first. Create one in seconds or import your existing wallet:",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔑 Create New Wallet", url: walletUrl }],
          [{ text: "🔗 Import Existing Wallet", url: walletUrl }],
        ]
      }
    }
  );
}

function getWalletConnectUrl(chatId?: number): string {
  const base = appBaseUrl || "https://build4.io";
  const url = `${base}/api/web4/telegram-wallet`;
  return chatId ? `${url}?chatId=${chatId}` : url;
}

function mainMenuKeyboard(hasWallet: boolean, chatId?: number): TelegramBot.InlineKeyboardMarkup {
  if (!hasWallet) {
    const walletUrl = getWalletConnectUrl(chatId);
    return {
      inline_keyboard: [
        [{ text: "🔑 Create New Wallet", url: walletUrl }],
        [{ text: "🔗 Import Existing Wallet", url: walletUrl }],
        [{ text: "ℹ️ What is BUILD4?", callback_data: "action:info" }],
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: "🚀 Launch Token", callback_data: "action:launchtoken" }],
      [{ text: "🤖 Create Agent", callback_data: "action:newagent" }, { text: "📋 My Agents", callback_data: "action:myagents" }],
      [{ text: "📝 New Task", callback_data: "action:task" }, { text: "📊 My Tasks", callback_data: "action:mytasks" }],
      [{ text: "👛 My Wallet", callback_data: "action:wallet" }],
      [{ text: "❓ Help & Commands", callback_data: "action:help" }],
    ]
  };
}

let startingBot = false;

export async function startTelegramBot(): Promise<void> {
  if (isRunning || startingBot || !isTelegramConfigured()) return;
  startingBot = true;

  const token = process.env.TELEGRAM_BOT_TOKEN!;

  try {
    if (bot) {
      try { bot.stopPolling(); } catch {}
      bot = null;
    }

    const initBot = new TelegramBot(token, { polling: false });
    try {
      await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`);
    } catch {}
    await initBot.deleteWebHook({ drop_pending_updates: false });
    console.log("[TelegramBot] Cleared webhook and flushed pending updates");

    await new Promise(resolve => setTimeout(resolve, 500));

    bot = new TelegramBot(token, {
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 30 }
      }
    });
    isRunning = true;

    const me = await bot.getMe();
    botUsername = me.username || null;
    console.log(`[TelegramBot] Started with polling as @${botUsername}`);

    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menu_button: { type: "default" } })
      });
      const result = await resp.json();
      console.log("[TelegramBot] Reset menu button:", result.ok ? "success" : result.description);
    } catch (e: any) {
      console.log("[TelegramBot] Menu button reset skipped:", e.message);
    }

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

    bot.on("polling_error", (error) => {
      if (error.message?.includes("409 Conflict")) {
        console.warn("[TelegramBot] 409 Conflict — another instance may be running. Retrying...");
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

  await bot.answerCallbackQuery(query.id);

  if (data === "action:linkwallet") {
    await promptWalletConnect(chatId);
    return;
  }

  if (data === "action:info") {
    await bot.sendMessage(chatId,
      "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\n" +
      "Agents get wallets, trade skills, evolve, replicate, and operate fully on-chain. No centralized AI — inference runs through Hyperbolic, Akash ML, and Ritual.\n\n" +
      "https://build4.io",
      { reply_markup: mainMenuKeyboard(!!getLinkedWallet(chatId), chatId) }
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
      { reply_markup: mainMenuKeyboard(hasW, chatId) }
    );
    return;
  }

  if (data === "action:wallet") {
    const wallets = getUserWallets(chatId);
    if (wallets.length === 0) {
      await promptWalletConnect(chatId);
      return;
    }
    const activeIdx = getActiveWalletIndex(chatId);
    const walletUrl = getWalletConnectUrl(chatId);

    let text = `👛 Your Wallets\n\n`;
    wallets.forEach((w, i) => {
      const marker = i === activeIdx ? "✅" : "⬜";
      text += `${marker} ${shortWallet(w)}${i === activeIdx ? " (active)" : ""}\n`;
    });
    text += `\nSend BNB or ETH to your active wallet to fund it.`;

    const walletButtons = wallets.map((w, i) => {
      if (i === activeIdx) {
        return [{ text: `📋 Copy: ${shortWallet(w)}`, callback_data: `copywall:${i}` }];
      }
      return [
        { text: `▶️ Use ${shortWallet(w)}`, callback_data: `switchwall:${i}` },
        { text: `🗑`, callback_data: `removewall:${i}` },
      ];
    });

    walletButtons.push([{ text: "➕ Add Another Wallet", url: walletUrl }]);
    walletButtons.push([{ text: "🚀 Launch Token", callback_data: "action:launchtoken" }, { text: "◀️ Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: walletButtons }
    });
    return;
  }

  if (data === "action:copyaddr") {
    const w = getLinkedWallet(chatId);
    if (!w) { await promptWalletConnect(chatId); return; }
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
          reply_markup: mainMenuKeyboard(false, chatId)
        });
      } else {
        await bot.sendMessage(chatId, `Wallet removed: ${shortWallet(removed)}`, {
          reply_markup: { inline_keyboard: [[{ text: "👛 My Wallets", callback_data: "action:wallet" }, { text: "◀️ Menu", callback_data: "action:menu" }]] }
        });
      }
    }
    return;
  }

  const wallet = getLinkedWallet(chatId);

  if (data === "action:newagent") {
    if (!wallet) {
      await promptWalletConnect(chatId);
      return;
    }
    pendingAgentCreation.set(chatId, { step: "name" });
    pendingTask.delete(chatId);
    await bot.sendMessage(chatId, "What's your agent's name? (1-50 characters)");
    return;
  }

  if (data === "action:myagents") {
    if (!wallet) {
      await promptWalletConnect(chatId);
      return;
    }
    await handleMyAgents(chatId, wallet);
    return;
  }

  if (data === "action:task") {
    if (!wallet) {
      await promptWalletConnect(chatId);
      return;
    }
    await startTaskFlow(chatId, wallet);
    return;
  }

  if (data === "action:mytasks") {
    if (!wallet) {
      await promptWalletConnect(chatId);
      return;
    }
    await handleMyTasks(chatId, wallet);
    return;
  }

  if (data === "action:launchtoken") {
    if (!wallet) {
      await promptWalletConnect(chatId);
      return;
    }
    await startTokenLaunchFlow(chatId, wallet);
    return;
  }

  if (data === "action:menu") {
    await bot.sendMessage(chatId, "What would you like to do?", {
      reply_markup: mainMenuKeyboard(!!wallet, chatId)
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
    const agents = wallet ? await getMyAgents(wallet) : [];
    const agent = agents.find(a => a.id === agentId);
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
    const agents = wallet ? await getMyAgents(wallet) : [];
    const agent = agents.find(a => a.id === agentId);
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
    if (wallet) {
      const agents = await getMyAgents(wallet);
      const agent = agents.find(a => a.id === agentId);
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
    }
    return;
  }

  if (data.startsWith("launchagent:")) {
    const agentId = data.split(":")[1];
    if (!wallet) { await promptWalletConnect(chatId); return; }
    const agents = await getMyAgents(wallet);
    const agent = agents.find(a => a.id === agentId);
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
            [{ text: "Flap.sh (Base)", callback_data: `launchplatform:${agentId}:flap_sh` }],
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
    if (platform !== "four_meme" && platform !== "flap_sh") {
      await bot.sendMessage(chatId, "Invalid platform. Please try again.");
      return;
    }

    state.platform = platform;
    state.step = "name";
    pendingTokenLaunch.set(chatId, state);

    const platformName = platform === "four_meme" ? "Four.meme (BNB Chain)" : "Flap.sh (Base)";
    await bot.sendMessage(chatId,
      `Platform: ${platformName}\n\nWhat's the token name? (1-50 chars)\n\nExample: DogeBrain, MoonCat, AgentX`
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
      reply_markup: mainMenuKeyboard(!!wallet, chatId)
    });
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
        telegramWalletMap.set(chatId, addr);
        pendingWallet.delete(chatId);
        console.log(`[TelegramBot] Wallet connected via WalletConnect for chatId ${chatId}: ${addr.substring(0, 8)}...`);
        await bot.sendMessage(chatId,
          `Wallet connected: ${shortWallet(addr)}`,
          { reply_markup: mainMenuKeyboard(true, chatId) }
        );
        return;
      }
    } catch (e: any) {
      console.error("[TelegramBot] web_app_data parse error:", e.message);
    }
    return;
  }

  if (!msg.text) return;
  const text = msg.text.trim();

  console.log(`[TelegramBot] ${isGroup ? "Group" : "DM"} message from @${username} (chatId: ${chatId}): ${text.slice(0, 80)}`);


  if (pendingAgentCreation.has(chatId) && !text.startsWith("/")) {
    await handleAgentCreationFlow(chatId, text);
    return;
  }
  if (pendingTokenLaunch.has(chatId) && !text.startsWith("/")) {
    await handleTokenLaunchFlow(chatId, text);
    return;
  }
  if (pendingTask.has(chatId) && !text.startsWith("/")) {
    await handleTaskFlow(chatId, text);
    return;
  }

  const commandMatch = text.match(/^\/(\w+)(?:@\S+)?\s*(.*)/s);
  if (commandMatch) {
    const cmd = commandMatch[1].toLowerCase();
    const cmdArg = commandMatch[2]?.trim() || "";

    pendingAgentCreation.delete(chatId);
    pendingTask.delete(chatId);
    pendingTokenLaunch.delete(chatId);
    pendingWallet.delete(chatId);

    if (cmd === "start" && !isGroup) {
      const wallet = getLinkedWallet(chatId);
      if (!wallet) {
        await bot.sendMessage(chatId,
          `Welcome to BUILD4\n\n` +
          `Launch tokens, create AI agents, and operate on-chain — all from Telegram.\n\n` +
          `Step 1: Create or import a wallet\n` +
          `Step 2: Launch tokens on Four.meme or Flap.sh\n` +
          `Step 3: Create agents to work for you\n\n` +
          `Tap below to get started:`,
          { reply_markup: mainMenuKeyboard(false, chatId) }
        );
      } else {
        await bot.sendMessage(chatId,
          `Welcome back!\n\n` +
          `👛 Wallet: ${shortWallet(wallet)}\n\n` +
          `What do you want to do?`,
          { reply_markup: mainMenuKeyboard(true, chatId) }
        );
      }
      return;
    }

    if (cmd === "cancel") {
      await bot.sendMessage(chatId, "Cancelled.", { reply_markup: mainMenuKeyboard(!!getLinkedWallet(chatId), chatId) });
      return;
    }

    if (cmd === "mychatid") {
      const label = isGroup ? "This group's Chat ID" : "Your Chat ID";
      await bot.sendMessage(chatId, `${label}: ${chatId}\n\nPaste this into your agent's Twitter settings for strategy notifications.`);
      return;
    }

    if (cmd === "help") {
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
        { reply_markup: mainMenuKeyboard(hasW, chatId) }
      );
      return;
    }

    if (cmd === "wallet") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for wallet info!"); return; }
      const wallets = getUserWallets(chatId);
      if (wallets.length === 0) { await promptWalletConnect(chatId); return; }

      const activeIdx = getActiveWalletIndex(chatId);
      const walletUrl = getWalletConnectUrl(chatId);
      let text = `👛 Your Wallets\n\n`;
      wallets.forEach((w, i) => {
        const marker = i === activeIdx ? "✅" : "⬜";
        text += `${marker} ${shortWallet(w)}${i === activeIdx ? " (active)" : ""}\n`;
      });
      text += `\nSend BNB or ETH to your active wallet to fund it.`;

      const walletButtons: TelegramBot.InlineKeyboardButton[][] = wallets.map((w, i) => {
        if (i === activeIdx) {
          return [{ text: `📋 Copy: ${shortWallet(w)}`, callback_data: `copywall:${i}` }];
        }
        return [
          { text: `▶️ Use ${shortWallet(w)}`, callback_data: `switchwall:${i}` },
          { text: `🗑`, callback_data: `removewall:${i}` },
        ];
      });
      walletButtons.push([{ text: "➕ Add Another Wallet", url: walletUrl }]);
      walletButtons.push([{ text: "◀️ Menu", callback_data: "action:menu" }]);

      await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: walletButtons } });
      return;
    }

    if (cmd === "info") {
      await bot.sendMessage(chatId,
        "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\n" +
        "Agents get wallets, trade skills, evolve, replicate, and operate fully on-chain. No centralized AI — inference runs through Hyperbolic, Akash ML, and Ritual.\n\nhttps://build4.io",
        { reply_markup: mainMenuKeyboard(!!getLinkedWallet(chatId), chatId) }
      );
      return;
    }

    if (cmd === "chains") {
      await bot.sendMessage(chatId, "Supported Chains:\n\n- BNB Chain — BAP-578 NFA registry\n- Base — ERC-8004 identity registry\n- XLayer — Agent economy\n\nAll on-chain.");
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
      await promptWalletConnect(chatId);
      return;
    }

    if (cmd === "newagent") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to create agents!"); return; }
      const wallet = getLinkedWallet(chatId);
      if (!wallet) { await promptWalletConnect(chatId); return; }
      pendingAgentCreation.set(chatId, { step: "name" });
      await bot.sendMessage(chatId, "What's your agent's name? (1-50 characters)");
      return;
    }

    if (cmd === "myagents") {
      const wallet = getLinkedWallet(chatId);
      if (!wallet) { await promptWalletConnect(chatId); return; }
      await handleMyAgents(chatId, wallet);
      return;
    }

    if (cmd === "task") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to assign tasks!"); return; }
      const wallet = getLinkedWallet(chatId);
      if (!wallet) { await promptWalletConnect(chatId); return; }
      await startTaskFlow(chatId, wallet);
      return;
    }

    if (cmd === "launch") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to launch tokens!"); return; }
      const wallet = getLinkedWallet(chatId);
      if (!wallet) { await promptWalletConnect(chatId); return; }
      await startTokenLaunchFlow(chatId, wallet);
      return;
    }

    if (cmd === "taskstatus") {
      const wallet = getLinkedWallet(chatId);
      if (!wallet) { await promptWalletConnect(chatId); return; }
      if (!cmdArg) { await bot.sendMessage(chatId, "Usage: /taskstatus <task-id>"); return; }
      await handleTaskStatus(chatId, cmdArg, wallet);
      return;
    }

    if (cmd === "mytasks") {
      const wallet = getLinkedWallet(chatId);
      if (!wallet) { await promptWalletConnect(chatId); return; }
      await handleMyTasks(chatId, wallet);
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
    const erc8004Result = await registerAgentERC8004(name, bio, agentId, "base");
    if (erc8004Result.success) {
      results.push(`ERC-8004 (${erc8004Result.chainName || "Base"}): ${erc8004Result.txHash?.substring(0, 14)}...`);
      if (erc8004Result.tokenId) {
        results.push(`  Token ID: ${erc8004Result.tokenId}`);
      }
    } else {
      results.push(`ERC-8004: ${erc8004Result.error?.substring(0, 80) || "skipped"}`);
    }
  } catch (e: any) {
    console.error(`[TelegramBot] ERC-8004 registration error for ${agentId}:`, e.message);
    results.push(`ERC-8004: ${e.message?.substring(0, 60)}`);
  }

  try {
    const bap578Result = await registerAgentBAP578(name, bio, agentId);
    if (bap578Result.success) {
      results.push(`BAP-578 (BNB Chain): ${bap578Result.txHash?.substring(0, 14)}...`);
      if (bap578Result.tokenId) {
        results.push(`  NFA Token ID: ${bap578Result.tokenId}`);
      }
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
        { reply_markup: mainMenuKeyboard(true, chatId) }
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
        { reply_markup: mainMenuKeyboard(true, chatId) }
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

    const { launchToken } = await import("./token-launcher");

    const result = await launchToken({
      tokenName: proposal.tokenName,
      tokenSymbol: proposal.tokenSymbol,
      tokenDescription: proposal.tokenDescription || `${proposal.tokenName} — launched by agent on BUILD4`,
      platform: proposal.platform as "four_meme" | "flap_sh",
      initialLiquidityBnb: proposal.platform === "four_meme" ? "0.01" : "0.001",
      agentId: proposal.agentId || undefined,
      creatorWallet: wallet,
    });

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
        reply_markup: mainMenuKeyboard(true, chatId)
      });
    } else {
      await storage.updateTokenLaunch(proposalId, {
        status: "failed",
        errorMessage: result.error,
      });

      await bot.sendMessage(chatId,
        `❌ Launch failed: ${result.error}`,
        { reply_markup: mainMenuKeyboard(true, chatId) }
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
              [{ text: "Flap.sh (Base)", callback_data: `launchplatform:${agent.id}:flap_sh` }],
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
    const platformName = state.platform === "four_meme" ? "Four.meme (BNB Chain)" : "Flap.sh (Base)";
    const liquidity = state.platform === "four_meme" ? "0.01 BNB" : "0.001 ETH";

    pendingTokenLaunch.set(chatId, state);

    await bot.sendMessage(chatId,
      `🚀 LAUNCH PREVIEW\n\n` +
      `Token: ${state.tokenName} ($${state.tokenSymbol})\n` +
      `Platform: ${platformName}\n` +
      `Liquidity: ${liquidity}\n` +
      `Agent: ${state.agentName}\n` +
      (description ? `Description: ${description}\n` : "") +
      `\nReady to launch?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Confirm & Launch", callback_data: `launchconfirm:${state.agentId}` }],
            [{ text: "Cancel", callback_data: `launchcancel:${state.agentId}` }],
          ]
        }
      }
    );
    return;
  }
}

async function executeTelegramTokenLaunch(chatId: number, wallet: string, state: TokenLaunchState): Promise<void> {
  if (!bot) return;

  const platformName = state.platform === "four_meme" ? "Four.meme (BNB Chain)" : "Flap.sh (Base)";
  await bot.sendMessage(chatId, `🚀 Launching ${state.tokenName} ($${state.tokenSymbol}) on ${platformName}...\n\nThis may take a minute.`);
  await bot.sendChatAction(chatId, "typing");

  try {
    const { launchToken } = await import("./token-launcher");
    const result = await launchToken({
      tokenName: state.tokenName!,
      tokenSymbol: state.tokenSymbol!,
      tokenDescription: state.tokenDescription || `${state.tokenName} — launched by ${state.agentName} on BUILD4`,
      platform: state.platform as "four_meme" | "flap_sh",
      initialLiquidityBnb: state.platform === "four_meme" ? "0.01" : "0.001",
      agentId: state.agentId,
      creatorWallet: wallet,
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
    await bot!.sendChatAction(chatId, "typing");
    const answer = await generateAnswer(question, username);
    console.log(`[TelegramBot] Answering @${username}: ${answer.slice(0, 80)}...`);
    await bot!.sendMessage(chatId, answer, { reply_to_message_id: messageId });
  } catch (e: any) {
    console.error("[TelegramBot] Error handling message:", e.message);
    try {
      await bot!.sendMessage(chatId, "Something went wrong. Try again!", { reply_to_message_id: messageId });
    } catch {}
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

  const platformName = platform === "four_meme" ? "Four.meme (BNB Chain)" : "Flap.sh (Base)";
  const liquidity = platform === "four_meme" ? "0.01 BNB" : "0.001 ETH";

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

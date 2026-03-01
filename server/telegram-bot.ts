import TelegramBot from "node-telegram-bot-api";
import { runInferenceWithFallback } from "./inference";
import { storage } from "./storage";

let bot: TelegramBot | null = null;
let isRunning = false;
let botUsername: string | null = null;
let appBaseUrl: string | null = null;

const telegramWalletMap = new Map<number, string>();

interface AgentCreationState { step: "name" | "bio" | "model"; name?: string; bio?: string }
interface TaskState { step: "describe"; agentId: string; taskType: string; agentName: string }

const pendingAgentCreation = new Map<number, AgentCreationState>();
const pendingTask = new Map<number, TaskState>();
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
7. Never make up information. If you don't know something, say the team can follow up and point to build4.io.
8. Never share private keys, internal details, or admin credentials.
9. If asked about token/price, explain BUILD4 is an infrastructure protocol with protocol-level fee capture — direct to build4.io for latest.
10. Structure longer answers with clear sections. Use line breaks for readability.
11. Match the depth of your answer to the question. Simple question = concise answer. Detailed question = thorough answer.
12. Maximum 1000 characters per response. Be thorough but not verbose.
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
  return telegramWalletMap.get(chatId);
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
  const agents = await storage.getAgents();
  return agents.filter(a => a.creatorWallet && a.creatorWallet.toLowerCase() === wallet.toLowerCase());
}

async function promptWalletConnect(chatId: number): Promise<void> {
  if (!bot) return;
  const walletUrl = getWalletConnectUrl();
  await bot.sendMessage(chatId, "Connect your wallet first:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Connect Wallet", web_app: { url: walletUrl } }],
      ]
    }
  });
}

function getWalletConnectUrl(): string {
  if (appBaseUrl) return `${appBaseUrl}/api/web4/telegram-wallet`;
  const replitDomain = process.env.REPLIT_DEPLOYMENT_URL || process.env.REPLIT_DEV_DOMAIN;
  if (replitDomain) {
    const url = replitDomain.startsWith("http") ? replitDomain : `https://${replitDomain}`;
    return `${url}/api/web4/telegram-wallet`;
  }
  return "https://build4.io/api/web4/telegram-wallet";
}

function mainMenuKeyboard(hasWallet: boolean): TelegramBot.InlineKeyboardMarkup {
  if (!hasWallet) {
    const walletUrl = getWalletConnectUrl();
    return {
      inline_keyboard: [
        [{ text: "Connect Wallet", web_app: { url: walletUrl } }],
        [{ text: "What is BUILD4?", callback_data: "action:info" }, { text: "Help", callback_data: "action:help" }],
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: "Create Agent", callback_data: "action:newagent" }, { text: "My Agents", callback_data: "action:myagents" }],
      [{ text: "New Task", callback_data: "action:task" }, { text: "My Tasks", callback_data: "action:mytasks" }],
      [{ text: "What is BUILD4?", callback_data: "action:info" }],
    ]
  };
}

export async function startTelegramBot(): Promise<void> {
  if (isRunning || !isTelegramConfigured()) return;

  const token = process.env.TELEGRAM_BOT_TOKEN!;

  try {
    const initBot = new TelegramBot(token);
    await initBot.deleteWebHook({ drop_pending_updates: false });
    console.log("[TelegramBot] Cleared any existing webhook");

    bot = new TelegramBot(token, { polling: true });
    isRunning = true;

    const me = await bot.getMe();
    botUsername = me.username || null;
    console.log(`[TelegramBot] Started with polling as @${botUsername}`);

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
      if (error.message?.includes("409 Conflict")) return;
      console.error("[TelegramBot] Polling error:", error.message);
    });

  } catch (e: any) {
    console.error("[TelegramBot] Failed to start:", e.message);
    isRunning = false;
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
      { reply_markup: mainMenuKeyboard(!!getLinkedWallet(chatId)) }
    );
    return;
  }

  if (data === "action:help") {
    await bot.sendMessage(chatId,
      "Just tap the buttons! You can also type:\n\n" +
      "/ask <question> — Ask about BUILD4\n" +
      "/mychatid — For strategy notifications\n\n" +
      "Or just type any question and I'll answer it.",
      { reply_markup: mainMenuKeyboard(!!getLinkedWallet(chatId)) }
    );
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

  if (data === "action:menu") {
    await bot.sendMessage(chatId, "What would you like to do?", {
      reply_markup: mainMenuKeyboard(!!wallet)
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
            ]
          }
        });
      }
    }
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
          { reply_markup: mainMenuKeyboard(true) }
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
    pendingWallet.delete(chatId);

    if (cmd === "start" && !isGroup) {
      const wallet = getLinkedWallet(chatId);
      await bot.sendMessage(chatId,
        `Welcome to BUILD4\nDecentralized AI agents on BNB Chain, Base, and XLayer.\n\n` +
        (wallet ? `Wallet: ${shortWallet(wallet)}\n\n` : "") +
        `Tap a button to get started:`,
        { reply_markup: mainMenuKeyboard(!!wallet) }
      );
      return;
    }

    if (cmd === "cancel") {
      await bot.sendMessage(chatId, "Cancelled.", { reply_markup: mainMenuKeyboard(!!getLinkedWallet(chatId)) });
      return;
    }

    if (cmd === "mychatid") {
      const label = isGroup ? "This group's Chat ID" : "Your Chat ID";
      await bot.sendMessage(chatId, `${label}: ${chatId}\n\nPaste this into your agent's Twitter settings for strategy notifications.`);
      return;
    }

    if (cmd === "help") {
      await bot.sendMessage(chatId,
        "Tap buttons to navigate, or type:\n\n/ask <question> — Ask anything\n/mychatid — For notifications\n\nOr just type a question directly.",
        { reply_markup: mainMenuKeyboard(!!getLinkedWallet(chatId)) }
      );
      return;
    }

    if (cmd === "info") {
      await bot.sendMessage(chatId,
        "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\n" +
        "Agents get wallets, trade skills, evolve, replicate, and operate fully on-chain. No centralized AI — inference runs through Hyperbolic, Akash ML, and Ritual.\n\nhttps://build4.io",
        { reply_markup: mainMenuKeyboard(!!getLinkedWallet(chatId)) }
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
    question = text;
  }

  if (!question) return;

  await handleQuestion(chatId, msg.message_id, question, username);
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

    await bot.sendMessage(chatId,
      `Agent created!\n\n${result.agent.name} | ${shortModel(model)}\nID: ${result.agent.id}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Give it a task", callback_data: `agenttask:${result.agent.id}` }],
            [{ text: "My Agents", callback_data: "action:myagents" }, { text: "Menu", callback_data: "action:menu" }],
          ]
        }
      }
    );
  } catch (e: any) {
    await bot.sendMessage(chatId, `Failed: ${e.message}`, {
      reply_markup: { inline_keyboard: [[{ text: "Try again", callback_data: "action:newagent" }]] }
    });
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

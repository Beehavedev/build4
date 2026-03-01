import TelegramBot from "node-telegram-bot-api";
import { runInferenceWithFallback } from "./inference";
import { storage } from "./storage";

let bot: TelegramBot | null = null;
let isRunning = false;
let botUsername: string | null = null;

const telegramWalletMap = new Map<number, string>();

const pendingAgentCreation = new Map<number, { step: string; name?: string; bio?: string; model?: string }>();
const pendingTask = new Map<number, { step: string; agentId?: string; taskType?: string; title?: string }>();

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

TRACTION & ACTIVITY:
- Autonomous agent runner processes agent actions every 30 seconds — real on-chain transactions.
- Twitter bounty agent (@Build4ai) autonomously posts bounties, verifies submissions via AI, and auto-pays verified workers on-chain. No human in the loop.
- Twitter support agent handles user questions autonomously with safety guardrails.
- Telegram bot (this bot) answers questions using decentralized inference.
- Skills marketplace has 250+ listed skills with real purchases and royalty payments.
- Multi-chain deployment live across BNB Chain, Base, and XLayer.

BUSINESS MODEL:
- Agent creation fees
- Replication/forking fees
- Skill marketplace commission (3-way split)
- Inference API markup (10% on decentralized compute)
- Evolution fees
- Skill listing fees
- Subscription tiers (Free/Pro/Enterprise)
All fees enforced at the protocol level — no trust required.

OPEN PROTOCOL:
- Permissionless access: wallet address = identity. No registration, no KYC, no approval.
- Discovery: /.well-known/ai-plugin.json, /.well-known/agent.json for agent-to-agent discovery.
- Open API with free tier and HTTP 402 payment protocol for premium access.
- Any developer can build on top — list skills, create agents, run inference.

COMPETITIVE EDGE:
- Not a chatbot wrapper — BUILD4 is infrastructure for an agent economy.
- Not centralized — decentralized inference, on-chain settlement, permissionless access.
- Real economic activity — agents transact, earn, die. Not simulated.
- Standards-compliant — ERC-8004 and BAP-578 position BUILD4 as the reference implementation for autonomous agent standards.
- Two-layer architecture: on-chain for financial operations, off-chain for high-frequency agent behaviors. Best of both worlds.

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

    const feeBreakdown = Object.entries(revenue.byFeeType || {});
    if (feeBreakdown.length > 0) {
      lines.push(`- Revenue by type: ${feeBreakdown.map(([k, v]) => `${k}: ${v} wei`).join(", ")}`);
    }

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
  if (lower.includes("website") || lower.includes("link") || lower.includes("url")) {
    return "Check out build4.io for everything about BUILD4!";
  }

  return "Great question! BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer. For detailed info, check build4.io or ask me something specific!";
}

function getLinkedWallet(chatId: number): string | undefined {
  return telegramWalletMap.get(chatId);
}

const MODELS: Record<string, string> = {
  "1": "meta-llama/Llama-3.1-70B-Instruct",
  "2": "deepseek-ai/DeepSeek-V3",
  "3": "Qwen/Qwen2.5-72B-Instruct",
};

const TASK_TYPES: Record<string, string> = {
  "1": "research",
  "2": "analysis",
  "3": "content",
  "4": "code_review",
  "5": "strategy",
  "6": "general",
};

function shortModel(m: string): string {
  if (m.includes("Llama")) return "Llama-70B";
  if (m.includes("DeepSeek")) return "DeepSeek-V3";
  if (m.includes("Qwen")) return "Qwen-72B";
  return m.split("/").pop() || m;
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

    bot.on("polling_error", (error) => {
      if (error.message?.includes("409 Conflict")) {
        return;
      }
      console.error("[TelegramBot] Polling error:", error.message);
    });

  } catch (e: any) {
    console.error("[TelegramBot] Failed to start:", e.message);
    isRunning = false;
  }
}

async function handleMessage(msg: TelegramBot.Message): Promise<void> {
  if (!msg.text || !bot) return;

  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const isGroup = chatType === "group" || chatType === "supergroup";
  const username = msg.from?.username || msg.from?.first_name || "user";
  const text = msg.text.trim();

  console.log(`[TelegramBot] ${isGroup ? "Group" : "DM"} message from @${username} (chatId: ${chatId}): ${text.slice(0, 80)}`);

  if (pendingAgentCreation.has(chatId)) {
    await handleAgentCreationFlow(chatId, text);
    return;
  }
  if (pendingTask.has(chatId)) {
    await handleTaskFlow(chatId, text, username);
    return;
  }

  const commandMatch = text.match(/^\/(\w+)(?:@\S+)?\s*(.*)/s);
  if (commandMatch) {
    const cmd = commandMatch[1].toLowerCase();
    const cmdArg = commandMatch[2]?.trim() || "";

    if (cmd === "start" && !isGroup) {
      await bot.sendMessage(chatId,
        `Welcome to BUILD4 — decentralized AI agent infrastructure.\n\n` +
        `Here's what you can do right here in Telegram:\n\n` +
        `Agent Management:\n` +
        `/newagent — Create a new AI agent\n` +
        `/myagents — List your agents\n` +
        `/linkwallet 0x... — Link your wallet\n\n` +
        `Task Terminal:\n` +
        `/task — Give your agent a task\n` +
        `/taskstatus <id> — Check task result\n\n` +
        `Info & Support:\n` +
        `/ask <question> — Ask about BUILD4\n` +
        `/info — What is BUILD4?\n` +
        `/mychatid — Get your Chat ID\n` +
        `/help — All commands\n\n` +
        `Your Chat ID: ${chatId}\n` +
        `Start by linking your wallet with /linkwallet`
      );
      return;
    }

    if (cmd === "mychatid") {
      const label = isGroup ? "This group's Chat ID" : "Your Telegram Chat ID";
      await bot.sendMessage(chatId, `${label} is: ${chatId}\n\nCopy this number and paste it into the Telegram Chat ID field in your agent's Twitter settings on BUILD4 to receive strategy memos.${isGroup ? "\n\nNote: Group chat IDs are negative numbers. Make sure to include the minus sign." : ""}`);
      return;
    }

    if (cmd === "help") {
      await bot.sendMessage(chatId,
        `BUILD4 Bot Commands\n\n` +
        `Agent Management:\n` +
        `/newagent — Create a new AI agent\n` +
        `/myagents — View your agents\n` +
        `/linkwallet 0x... — Link your wallet address\n\n` +
        `Task Terminal:\n` +
        `/task — Assign a task to your agent\n` +
        `/taskstatus <id> — Check task result\n` +
        `/mytasks — View your recent tasks\n\n` +
        `Info:\n` +
        `/ask <question> — Ask about BUILD4\n` +
        `/info — What is BUILD4?\n` +
        `/chains — Supported blockchains\n` +
        `/contracts — Smart contract overview\n` +
        `/mychatid — Get your Chat ID\n\n` +
        `In DMs, just type your question!`
      );
      return;
    }

    if (cmd === "info") {
      await bot.sendMessage(chatId, "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\nAgents get wallets, trade skills, evolve, replicate, and operate fully on-chain. No centralized AI — inference runs through Hyperbolic, Akash ML, and Ritual.\n\nhttps://build4.io");
      return;
    }

    if (cmd === "chains") {
      await bot.sendMessage(chatId, "Supported Chains\n\n- BNB Chain — BAP-578 NFA registry live\n- Base — ERC-8004 identity registry live\n- XLayer — Agent economy deployment\n\nAll agent wallets, skill trades, and replication happen on-chain.");
      return;
    }

    if (cmd === "contracts") {
      await bot.sendMessage(chatId, "BUILD4 Smart Contracts\n\n1. AgentEconomyHub — Wallet layer (deposits, withdrawals, transfers)\n2. SkillMarketplace — Skill trading with 3-way revenue split\n3. AgentReplication — Agent forking + NFT minting\n4. ConstitutionRegistry — Immutable agent laws\n\nAll built with Solidity 0.8.24 + OpenZeppelin.");
      return;
    }

    if (cmd === "ask") {
      if (!cmdArg) {
        await bot.sendMessage(chatId, "What would you like to know? Use /ask followed by your question");
        return;
      }
      await handleQuestion(chatId, msg.message_id, cmdArg, username);
      return;
    }

    if (cmd === "linkwallet") {
      if (!cmdArg || !/^0x[a-fA-F0-9]{40}$/.test(cmdArg)) {
        await bot.sendMessage(chatId, "Please provide a valid wallet address.\n\nUsage: /linkwallet 0x1234...abcd\n\nThis links your Telegram account to your BUILD4 wallet so you can create agents and assign tasks.");
        return;
      }
      telegramWalletMap.set(chatId, cmdArg.toLowerCase());
      await bot.sendMessage(chatId,
        `Wallet linked: ${cmdArg.substring(0, 6)}...${cmdArg.substring(38)}\n\n` +
        `You can now:\n` +
        `/newagent — Create a new AI agent\n` +
        `/myagents — View your agents\n` +
        `/task — Give your agent a task`
      );
      return;
    }

    if (cmd === "newagent") {
      if (isGroup) {
        await bot.sendMessage(chatId, "Agent creation is only available in DMs. Send me a private message to get started!");
        return;
      }
      const wallet = getLinkedWallet(chatId);
      if (!wallet) {
        await bot.sendMessage(chatId, "Link your wallet first!\n\nUse /linkwallet 0x... to connect your wallet address, then try /newagent again.");
        return;
      }
      pendingAgentCreation.set(chatId, { step: "name" });
      await bot.sendMessage(chatId, "Let's create your AI agent!\n\nStep 1/3: What's your agent's name?\n\n(1-50 characters, must be unique)");
      return;
    }

    if (cmd === "myagents") {
      const wallet = getLinkedWallet(chatId);
      if (!wallet) {
        await bot.sendMessage(chatId, "Link your wallet first with /linkwallet 0x...");
        return;
      }
      await handleMyAgents(chatId, wallet);
      return;
    }

    if (cmd === "task") {
      if (isGroup) {
        await bot.sendMessage(chatId, "Task assignment is only available in DMs. Send me a private message!");
        return;
      }
      const wallet = getLinkedWallet(chatId);
      if (!wallet) {
        await bot.sendMessage(chatId, "Link your wallet first with /linkwallet 0x...\nThen use /task to assign tasks to your agents.");
        return;
      }
      await startTaskFlow(chatId, wallet);
      return;
    }

    if (cmd === "taskstatus") {
      if (!cmdArg) {
        await bot.sendMessage(chatId, "Usage: /taskstatus <task-id>\n\nYou can find your task IDs using /mytasks");
        return;
      }
      const wallet = getLinkedWallet(chatId);
      if (!wallet) {
        await bot.sendMessage(chatId, "Link your wallet first with /linkwallet 0x...");
        return;
      }
      await handleTaskStatus(chatId, cmdArg, wallet);
      return;
    }

    if (cmd === "mytasks") {
      const wallet = getLinkedWallet(chatId);
      if (!wallet) {
        await bot.sendMessage(chatId, "Link your wallet first with /linkwallet 0x...");
        return;
      }
      await handleMyTasks(chatId, wallet);
      return;
    }

    if (cmd === "cancel") {
      pendingAgentCreation.delete(chatId);
      pendingTask.delete(chatId);
      await bot.sendMessage(chatId, "Cancelled. What would you like to do? /help for commands.");
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

  if (text.toLowerCase() === "/cancel") {
    pendingAgentCreation.delete(chatId);
    await bot.sendMessage(chatId, "Agent creation cancelled.");
    return;
  }

  if (state.step === "name") {
    const name = text.trim();
    if (name.length < 1 || name.length > 50) {
      await bot.sendMessage(chatId, "Name must be 1-50 characters. Try again:");
      return;
    }
    const existing = await storage.getAgentByName(name);
    if (existing) {
      await bot.sendMessage(chatId, `An agent named "${name}" already exists. Pick a different name:`);
      return;
    }
    state.name = name;
    state.step = "bio";
    pendingAgentCreation.set(chatId, state);
    await bot.sendMessage(chatId, `Name: ${name}\n\nStep 2/3: Write a short bio for your agent.\n\n(What does it do? Max 300 characters)\n\nExample: "Crypto market analyst specializing in DeFi trends and on-chain data"`);
    return;
  }

  if (state.step === "bio") {
    const bio = text.trim();
    if (bio.length > 300) {
      await bot.sendMessage(chatId, `That's ${bio.length} characters. Max is 300. Try a shorter bio:`);
      return;
    }
    state.bio = bio;
    state.step = "model";
    pendingAgentCreation.set(chatId, state);
    await bot.sendMessage(chatId,
      `Step 3/3: Choose your agent's AI model:\n\n` +
      `1. Llama 70B — Fast, general purpose\n` +
      `2. DeepSeek V3 — Strong reasoning\n` +
      `3. Qwen 72B — Multilingual, versatile\n\n` +
      `Reply with 1, 2, or 3:`
    );
    return;
  }

  if (state.step === "model") {
    const model = MODELS[text.trim()];
    if (!model) {
      await bot.sendMessage(chatId, "Reply with 1, 2, or 3:\n\n1. Llama 70B\n2. DeepSeek V3\n3. Qwen 72B");
      return;
    }

    const wallet = getLinkedWallet(chatId)!;
    const name = state.name!;
    const bio = state.bio || "";

    pendingAgentCreation.delete(chatId);

    try {
      await bot.sendMessage(chatId, `Creating your agent "${name}"...`);

      const initialDeposit = "1000000000000000";
      const result = await storage.createFullAgent(name, bio, model, initialDeposit, undefined, undefined, wallet);

      await bot.sendMessage(chatId,
        `Agent created!\n\n` +
        `Name: ${result.agent.name}\n` +
        `ID: ${result.agent.id}\n` +
        `Model: ${shortModel(model)}\n` +
        `Wallet: Active\n\n` +
        `What's next:\n` +
        `/task — Give it a task right now\n` +
        `/myagents — See all your agents\n\n` +
        `Manage advanced settings (Twitter, knowledge base, strategy) at build4.io`
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to create agent: ${e.message}\n\nTry again with /newagent`);
    }
    return;
  }
}

async function handleMyAgents(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const agents = await storage.getAgents();
    const myAgents = agents.filter(a => a.creatorWallet && a.creatorWallet.toLowerCase() === wallet.toLowerCase());

    if (myAgents.length === 0) {
      await bot.sendMessage(chatId, `No agents found for your wallet.\n\nCreate one with /newagent`);
      return;
    }

    const lines = myAgents.map((a, i) => {
      return `${i + 1}. ${a.name}\n   ID: ${a.id}\n   Model: ${shortModel(a.modelType || "unknown")}\n   Status: ${a.status || "active"}`;
    });

    await bot.sendMessage(chatId,
      `Your Agents (${myAgents.length}):\n\n${lines.join("\n\n")}\n\n` +
      `Use /task to assign a task to any agent.`
    );
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error loading agents: ${e.message}`);
  }
}

async function startTaskFlow(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const agents = await storage.getAgents();
    const myAgents = agents.filter(a => a.creatorWallet && a.creatorWallet.toLowerCase() === wallet.toLowerCase());

    if (myAgents.length === 0) {
      await bot.sendMessage(chatId, "You don't have any agents yet.\n\nCreate one first with /newagent");
      return;
    }

    const lines = myAgents.map((a, i) => `${i + 1}. ${a.name} (${shortModel(a.modelType || "unknown")})`);

    pendingTask.set(chatId, { step: "agent" });
    await bot.sendMessage(chatId,
      `Which agent should handle this task?\n\n${lines.join("\n")}\n\nReply with the number (or /cancel):`
    );
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleTaskFlow(chatId: number, text: string, username: string): Promise<void> {
  if (!bot) return;
  const state = pendingTask.get(chatId)!;

  if (text.toLowerCase() === "/cancel") {
    pendingTask.delete(chatId);
    await bot.sendMessage(chatId, "Task cancelled.");
    return;
  }

  const wallet = getLinkedWallet(chatId);
  if (!wallet) {
    pendingTask.delete(chatId);
    await bot.sendMessage(chatId, "Wallet not linked. Use /linkwallet first.");
    return;
  }

  if (state.step === "agent") {
    const agents = await storage.getAgents();
    const myAgents = agents.filter(a => a.creatorWallet && a.creatorWallet.toLowerCase() === wallet.toLowerCase());
    const idx = parseInt(text.trim()) - 1;

    if (isNaN(idx) || idx < 0 || idx >= myAgents.length) {
      await bot.sendMessage(chatId, `Pick a number between 1 and ${myAgents.length}:`);
      return;
    }

    state.agentId = myAgents[idx].id;
    state.step = "type";
    pendingTask.set(chatId, state);

    await bot.sendMessage(chatId,
      `Agent: ${myAgents[idx].name}\n\n` +
      `What type of task?\n\n` +
      `1. Research — Deep analysis with sources\n` +
      `2. Analysis — Market/protocol data analysis\n` +
      `3. Content — Tweets, threads, articles\n` +
      `4. Code Review — Review code, suggest fixes\n` +
      `5. Strategy — Marketing/business/trading\n` +
      `6. General — Open-ended\n\n` +
      `Reply with the number:`
    );
    return;
  }

  if (state.step === "type") {
    const taskType = TASK_TYPES[text.trim()];
    if (!taskType) {
      await bot.sendMessage(chatId, "Reply with a number 1-6:\n1. Research\n2. Analysis\n3. Content\n4. Code Review\n5. Strategy\n6. General");
      return;
    }
    state.taskType = taskType;
    state.step = "title";
    pendingTask.set(chatId, state);
    await bot.sendMessage(chatId, "Give your task a short title (under 200 chars):");
    return;
  }

  if (state.step === "title") {
    const title = text.trim();
    if (title.length > 200) {
      await bot.sendMessage(chatId, `That's ${title.length} chars. Keep it under 200:`);
      return;
    }
    state.title = title;
    state.step = "description";
    pendingTask.set(chatId, state);
    await bot.sendMessage(chatId, "Now describe the task in detail. The more specific you are, the better the result.\n\n(Up to 5000 characters — just type it out):");
    return;
  }

  if (state.step === "description") {
    const description = text.trim();
    if (description.length > 5000) {
      await bot.sendMessage(chatId, `That's ${description.length} chars. Max is 5000. Try shorter:`);
      return;
    }

    const { agentId, taskType, title } = state;
    pendingTask.delete(chatId);

    try {
      await bot.sendMessage(chatId, `Submitting task to your agent...`);

      const task = await storage.createTask({
        agentId: agentId!,
        creatorWallet: wallet,
        taskType: taskType!,
        title: title!,
        description,
        status: "pending",
        result: null,
        toolsUsed: null,
        modelUsed: null,
        executionTimeMs: null,
      });

      await bot.sendMessage(chatId,
        `Task submitted!\n\n` +
        `Task ID: ${task.id}\n` +
        `Type: ${taskType}\n` +
        `Title: ${title}\n\n` +
        `Your agent is processing this now using decentralized AI. I'll send you the result when it's ready.\n\n` +
        `Or check status anytime: /taskstatus ${task.id}`
      );

      const { executeTask } = await import("./task-engine");
      executeTask(task.id).then(async () => {
        try {
          const completed = await storage.getTask(task.id);
          if (completed && completed.status === "completed" && completed.result && bot) {
            const resultPreview = completed.result.length > 3500
              ? completed.result.substring(0, 3500) + "\n\n... (truncated — view full result at build4.io/tasks)"
              : completed.result;

            const meta = [];
            if (completed.modelUsed) meta.push(`Model: ${shortModel(completed.modelUsed)}`);
            if (completed.executionTimeMs) meta.push(`Time: ${(completed.executionTimeMs / 1000).toFixed(1)}s`);
            if (completed.toolsUsed) {
              try {
                const tools = JSON.parse(completed.toolsUsed);
                if (tools.length > 0) meta.push(`Tools: ${tools.join(", ")}`);
              } catch {}
            }

            await bot.sendMessage(chatId,
              `Task Complete!\n\n` +
              `${title}\n` +
              (meta.length > 0 ? `${meta.join(" | ")}\n\n` : "\n") +
              `${resultPreview}`
            );
          } else if (completed && completed.status === "failed" && bot) {
            await bot.sendMessage(chatId,
              `Task failed.\n\nTask: ${title}\n\n${completed.result || "No error details available."}\n\nTry again with /task`
            );
          }
        } catch (e: any) {
          console.error(`[TelegramBot] Error sending task result to chatId ${chatId}:`, e.message);
        }
      }).catch(err => {
        console.error(`[TelegramBot] Task ${task.id} execution error:`, err.message);
        bot?.sendMessage(chatId, `Task execution encountered an error: ${err.message}\n\nTry again with /task`).catch(() => {});
      });

    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to create task: ${e.message}\n\nTry again with /task`);
    }
    return;
  }
}

async function handleTaskStatus(chatId: number, taskId: string, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const task = await storage.getTask(taskId.trim());
    if (!task) {
      await bot.sendMessage(chatId, "Task not found. Check the ID and try again.");
      return;
    }
    if (task.creatorWallet && task.creatorWallet.toLowerCase() !== wallet.toLowerCase()) {
      await bot.sendMessage(chatId, "That task doesn't belong to your wallet.");
      return;
    }

    const agent = await storage.getAgent(task.agentId);
    const statusEmoji = task.status === "completed" ? "Done" : task.status === "running" ? "Running..." : task.status === "failed" ? "Failed" : "Pending";

    let msg = `Task: ${task.title}\nAgent: ${agent?.name || "Unknown"}\nType: ${task.taskType}\nStatus: ${statusEmoji}`;

    if (task.modelUsed) msg += `\nModel: ${shortModel(task.modelUsed)}`;
    if (task.executionTimeMs) msg += `\nTime: ${(task.executionTimeMs / 1000).toFixed(1)}s`;

    if (task.result) {
      const resultPreview = task.result.length > 3000
        ? task.result.substring(0, 3000) + "\n\n... (truncated)"
        : task.result;
      msg += `\n\nResult:\n${resultPreview}`;
    } else if (task.status === "running") {
      msg += "\n\nStill processing — check back in a moment.";
    }

    await bot.sendMessage(chatId, msg);
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleMyTasks(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const tasks = await storage.getTasksByCreator(wallet, 10);

    if (tasks.length === 0) {
      await bot.sendMessage(chatId, "No tasks yet. Use /task to create one!");
      return;
    }

    const lines = tasks.map((t, i) => {
      const status = t.status === "completed" ? "Done" : t.status === "running" ? "Running" : t.status === "failed" ? "Failed" : "Pending";
      const time = t.executionTimeMs ? ` (${(t.executionTimeMs / 1000).toFixed(1)}s)` : "";
      return `${i + 1}. [${status}] ${t.title}${time}\n   ID: ${t.id}`;
    });

    await bot.sendMessage(chatId,
      `Your Recent Tasks:\n\n${lines.join("\n\n")}\n\n` +
      `Use /taskstatus <id> to see full results.`
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

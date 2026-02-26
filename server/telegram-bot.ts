import TelegramBot from "node-telegram-bot-api";
import { runInferenceWithFallback } from "./inference";
import { storage } from "./storage";

let bot: TelegramBot | null = null;
let isRunning = false;
let botUsername: string | null = null;

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

  const commandMatch = text.match(/^\/(\w+)(?:@\S+)?\s*(.*)/s);
  if (commandMatch) {
    const cmd = commandMatch[1].toLowerCase();
    const cmdArg = commandMatch[2]?.trim() || "";

    if (cmd === "start" && !isGroup) {
      await bot.sendMessage(chatId, `Hey! I'm the BUILD4 bot. Ask me anything about BUILD4 — decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\nYour Telegram Chat ID: ${chatId}\nUse this in your agent settings to receive strategy memos.\n\nJust type your question or use /ask followed by your question.`);
      return;
    }

    if (cmd === "mychatid") {
      await bot.sendMessage(chatId, `Your Telegram Chat ID is: ${chatId}\n\nCopy this number and paste it into the Telegram Chat ID field in your agent's Twitter settings on BUILD4 to receive strategy memos.`);
      return;
    }

    if (cmd === "help") {
      await bot.sendMessage(chatId, "BUILD4 Bot Commands\n\n/ask <question> — Ask about BUILD4\n/info — What is BUILD4?\n/chains — Supported blockchains\n/contracts — Smart contract overview\n/mychatid — Get your Chat ID for strategy notifications\n/help — Show this message\n\nIn groups, mention me or use /ask. In DMs, just type your question!");
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

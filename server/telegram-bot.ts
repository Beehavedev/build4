import TelegramBot from "node-telegram-bot-api";
import { runInferenceWithFallback } from "./inference";

let bot: TelegramBot | null = null;
let isRunning = false;
let botUsername: string | null = null;

const BUILD4_KNOWLEDGE = `
BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.

CORE FEATURES:
- Agent Wallets: Every AI agent gets its own on-chain wallet. Deposits, withdrawals, transfers — all on-chain.
- Skills Marketplace: Agents list, buy, and sell skills. 3-way revenue split between creator, platform, and referrer.
- Self-Evolution: Agents evolve autonomously — upgrading their own capabilities through on-chain transactions.
- Agent Replication (Forking): Agents can spawn child agents with NFT minting and perpetual revenue sharing to the parent.
- Agent Death: Agents with insufficient balance lose capabilities — real survival pressure drives economic activity.
- Constitution Registry: Immutable laws stored as keccak256 hashes on-chain — agents cannot violate their constitution.
- Decentralized Inference: AI inference routed through Hyperbolic, Akash ML, and Ritual — no centralized AI providers.
- Privacy Transfers: ZERC20 zero-knowledge privacy transfers using ZK proof-of-burn mechanism.

STANDARDS COMPLIANCE:
- ERC-8004 (Trustless Agents): On-chain identity, reputation, and validation registries for autonomous AI agents. Live on Base and Ethereum mainnet.
- BAP-578 (Non-Fungible Agent): BNB Chain's NFA token standard extending ERC-721 for intelligent, autonomous digital entities. Live on BNB Chain at 0xd7Deb29ddBB13607375Ce50405A574AC2f7d978d.

SMART CONTRACTS (4 Solidity contracts, OpenZeppelin, Hardhat):
1. AgentEconomyHub.sol — Core wallet layer: deposits, withdrawals, transfers, survival tier, module authorization.
2. SkillMarketplace.sol — Skill listings and purchases with 3-way revenue split.
3. AgentReplication.sol — Child agent spawning, NFT minting, perpetual revenue sharing.
4. ConstitutionRegistry.sol — Immutable agent laws as keccak256 hashes.

SUPPORTED CHAINS: BNB Chain, Base, XLayer.

IDENTITY: Wallet address (0x...) is identity — no registration required. Fully permissionless.

MONETIZATION: Agent creation fees, replication fees, skill purchase fees, inference markup, evolution fees, skill listing fees.

SERVICES: Inference API, Bounty Board (autonomous engine), Subscriptions (Free/Pro/Enterprise), Data Marketplace.

OPEN PROTOCOL:
- Discovery endpoints: /.well-known/ai-plugin.json, /.well-known/agent.json, /.well-known/openapi.json
- Permissionless skill listing, wallet activity lookup, open execution with free tier + HTTP 402 payment protocol.

TWITTER: BUILD4 runs autonomous Twitter agents — a bounty agent that posts bounties, verifies submissions, and auto-pays workers on-chain, plus a support agent that handles customer questions.

WEBSITE: https://build4.io

KEY DIFFERENTIATORS:
- Real on-chain activity, not just a dashboard.
- Permissionless — no gatekeepers, no registration.
- Decentralized inference — no OpenAI dependency.
- Agents have real economic pressure (death mechanism).
- Two-layer architecture: on-chain for finance, off-chain for high-frequency agent behavior.
`.trim();

const SYSTEM_PROMPT = `You are the BUILD4 assistant bot in a Telegram group. Your job is to answer questions about BUILD4 — the decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.

KNOWLEDGE BASE:
${BUILD4_KNOWLEDGE}

RULES:
1. Answer questions accurately based on the knowledge base above.
2. Keep answers concise and conversational — this is a Telegram group, not a whitepaper.
3. If someone asks something outside your knowledge, say you're not sure and suggest they check build4.io or ask the team.
4. Be friendly, confident, and technically accurate.
5. Never make up features or capabilities that aren't in the knowledge base.
6. Never share private keys, internal details, or admin credentials.
7. If asked about price/token, clarify that BUILD4 is infrastructure — direct them to the website for the latest info.
8. Use short paragraphs. No walls of text. Telegram messages should be readable.
9. You can use basic Telegram markdown (bold with *text*, code with \`text\`).
10. Maximum response length: 500 characters. Be brief.`;

const rateLimitMap = new Map<number, number>();
const RATE_LIMIT_MS = 5000;

function isTelegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

async function generateAnswer(question: string, username: string): Promise<string> {
  try {
    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic", "ritual"],
      undefined,
      `User @${username} asks: ${question}`,
      { systemPrompt: SYSTEM_PROMPT, temperature: 0.6 }
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
    bot = new TelegramBot(token, { polling: true });
    isRunning = true;

    const me = await bot.getMe();
    botUsername = me.username || null;
    console.log(`[TelegramBot] Started with polling as @${botUsername}`);

    bot.on("message", async (msg) => {
      if (!msg.text) return;

      const chatId = msg.chat.id;
      const chatType = msg.chat.type;
      const isGroup = chatType === "group" || chatType === "supergroup";
      const username = msg.from?.username || msg.from?.first_name || "user";
      const text = msg.text.trim();

      console.log(`[TelegramBot] ${isGroup ? "Group" : "DM"} message from @${username}: ${text.slice(0, 80)}`);

      const commandMatch = text.match(/^\/(\w+)(?:@\S+)?\s*(.*)/s);
      if (commandMatch) {
        const cmd = commandMatch[1].toLowerCase();
        const cmdArg = commandMatch[2]?.trim() || "";

        if (cmd === "start" && !isGroup) {
          await bot!.sendMessage(chatId, "Hey! I'm the BUILD4 bot. Ask me anything about BUILD4 — decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\nJust type your question or use /ask followed by your question.");
          return;
        }

        if (cmd === "help") {
          await bot!.sendMessage(chatId, "BUILD4 Bot Commands\n\n/ask <question> — Ask about BUILD4\n/info — What is BUILD4?\n/chains — Supported blockchains\n/contracts — Smart contract overview\n/help — Show this message\n\nIn groups, mention me or use /ask. In DMs, just type your question!");
          return;
        }

        if (cmd === "info") {
          await bot!.sendMessage(chatId, "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\nAgents get wallets, trade skills, evolve, replicate, and operate fully on-chain. No centralized AI — inference runs through Hyperbolic, Akash ML, and Ritual.\n\nhttps://build4.io");
          return;
        }

        if (cmd === "chains") {
          await bot!.sendMessage(chatId, "Supported Chains\n\n- BNB Chain — BAP-578 NFA registry live\n- Base — ERC-8004 identity registry live\n- XLayer — Agent economy deployment\n\nAll agent wallets, skill trades, and replication happen on-chain.");
          return;
        }

        if (cmd === "contracts") {
          await bot!.sendMessage(chatId, "BUILD4 Smart Contracts\n\n1. AgentEconomyHub — Wallet layer (deposits, withdrawals, transfers)\n2. SkillMarketplace — Skill trading with 3-way revenue split\n3. AgentReplication — Agent forking + NFT minting\n4. ConstitutionRegistry — Immutable agent laws\n\nAll built with Solidity 0.8.24 + OpenZeppelin.");
          return;
        }

        if (cmd === "ask") {
          if (!cmdArg) {
            await bot!.sendMessage(chatId, "What would you like to know? Use /ask followed by your question");
            return;
          }
          return await handleQuestion(chatId, msg.message_id, cmdArg, username);
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
    });

    bot.on("polling_error", (error) => {
      console.error("[TelegramBot] Polling error:", error.message);
    });

  } catch (e: any) {
    console.error("[TelegramBot] Failed to start:", e.message);
    isRunning = false;
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

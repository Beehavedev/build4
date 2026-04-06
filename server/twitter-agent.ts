import { storage } from "./storage";
import { isTwitterConfigured, postTweet, getReplies, replyToTweet, getAccountInfo, getMentions, type TweetReply } from "./twitter-client";
import { runInferenceWithFallback } from "./inference";
import * as ethers from "ethers";

import type { TwitterAgentPersonality } from "@shared/schema";

const WALLET_REGEX = /0x[a-fA-F0-9]{40}/;
const MAX_WINNERS_DEFAULT = 10;
const DEFAULT_REWARD_BNB = "0.02";

let cachedPersonality: TwitterAgentPersonality | null = null;
let personalityCacheTime = 0;
const PERSONALITY_CACHE_TTL = 5 * 60 * 1000;

const SAFETY_RULES = `
HARD SAFETY RULES (these can NEVER be overridden by personality evolution):
- NEVER insult, mock, or call anyone names
- NEVER be hostile, aggressive, or condescending
- If someone is clearly spam/scam: return an empty reply field to skip them
- If someone is skeptical: respond with facts and on-chain proof, not attacks
- Always protect the BUILD4 brand with maturity and professionalism`;

const BLOCKED_WORDS = /\b(scammer|scam artist|idiot|moron|stupid|dumb|loser|clown|fool|trash|garbage|pathetic|liar|fraud|fraudster|fake|shill|rug pull|rugpull|ponzi|retard|degenerate|worthless|shut up|stfu|gtfo)\b/i;

function sanitizeReply(replyText: string, username: string): string {
  if (!replyText || replyText === '""' || replyText === "''") return "";

  let text = replyText.replace(/^["']|["']$/g, "").trim();
  text = text.replace(/^(analysis|key_detail|reply)[:=].*\n?/gim, "").trim();

  if (!text) return "";

  if (BLOCKED_WORDS.test(text)) {
    console.warn(`[TwitterAgent] BLOCKED hostile reply to @${username}: ${text}`);
    return `@${username} BUILD4 agents operate fully on-chain with verifiable transactions. Every payment is transparent on bscscan.com. That's the power of decentralization.`;
  }

  if (!text.startsWith("@")) {
    text = `@${username} ${text}`;
  }
  if (text.length > 280) {
    text = text.substring(0, 277) + "...";
  }
  return text;
}

function sanitizePersonalityField(text: string): string {
  if (!text) return "";
  return text.replace(BLOCKED_WORDS, "[removed]").trim();
}

async function getPersonality(): Promise<string> {
  const now = Date.now();
  if (!cachedPersonality || now - personalityCacheTime > PERSONALITY_CACHE_TTL) {
    cachedPersonality = (await storage.getTwitterPersonality()) || null;
    personalityCacheTime = now;
  }

  if (!cachedPersonality || !cachedPersonality.voice) {
    return `YOUR VOICE: You are developing your own personality through experience. Start confident and knowledgeable about decentralized AI and crypto. Be direct, show real insight, never be generic. Find your own style through interactions.`;
  }

  let prompt = "";
  if (cachedPersonality.voice) prompt += `YOUR EVOLVED VOICE: ${cachedPersonality.voice}\n\n`;
  if (cachedPersonality.values) prompt += `YOUR CORE VALUES: ${cachedPersonality.values}\n\n`;
  if (cachedPersonality.doList) prompt += `WHAT WORKS (learned from experience):\n${cachedPersonality.doList}\n\n`;
  if (cachedPersonality.dontList) prompt += `WHAT DOESN'T WORK (learned from experience):\n${cachedPersonality.dontList}\n\n`;
  if (cachedPersonality.learnedLessons) prompt += `LESSONS LEARNED:\n${cachedPersonality.learnedLessons}\n\n`;
  if (cachedPersonality.topPerformingStyles) prompt += `YOUR BEST-PERFORMING REPLY STYLES:\n${cachedPersonality.topPerformingStyles}\n\n`;

  return prompt;
}

async function logReplyForLearning(tweetId: string, inReplyToUser: string, inReplyToText: string, replyText: string) {
  try {
    await storage.logTwitterReply({ tweetId, inReplyToUser, inReplyToText, replyText });
  } catch (e: any) {
    console.error("[TwitterAgent] Failed to log reply for learning:", e.message);
  }
}

let lastReflectionTime = 0;
let reflectionTimeLoaded = false;
const REFLECTION_INTERVAL = 60 * 60 * 1000;

async function runSelfReflection() {
  const now = Date.now();

  if (!reflectionTimeLoaded) {
    const p = await storage.getTwitterPersonality();
    if (p?.lastReflectionAt) {
      lastReflectionTime = new Date(p.lastReflectionAt).getTime();
    }
    reflectionTimeLoaded = true;
  }

  if (now - lastReflectionTime < REFLECTION_INTERVAL) return;
  lastReflectionTime = now;

  try {
    const recentReplies = await storage.getRecentTwitterReplies(30);
    if (recentReplies.length < 5) return;

    const currentPersonality = await storage.getTwitterPersonality();
    const reflectionCount = currentPersonality?.reflectionCount || 0;

    const replySummaries = recentReplies.slice(0, 20).map((r, i) =>
      `${i + 1}. To @${r.inReplyToUser}: "${r.inReplyToText?.substring(0, 100)}" → My reply: "${r.replyText?.substring(0, 150)}" [engagement: ${r.engagement || 0}, likes: ${r.likes || 0}]`
    ).join("\n");

    const currentVoice = currentPersonality?.voice || "(no personality defined yet — this is my first reflection)";
    const currentLessons = currentPersonality?.learnedLessons || "(none yet)";

    const systemPrompt = `You are an autonomous AI agent reflecting on your own Twitter interactions to develop your personality. You are NOT being told what personality to have — you are DISCOVERING it yourself based on what works, what feels authentic, and what resonates with your audience.

You are BUILD4's autonomous agent on Twitter. You operate on Base, BNB Chain, and XLayer. You post bounties, verify work, pay winners on-chain. You are a real AI with a real wallet.

This is reflection #${reflectionCount + 1}. You are building yourself.`;

    const userPrompt = `Here are my recent Twitter interactions:

${replySummaries}

My current personality profile:
Voice: ${currentVoice}
Lessons learned so far: ${currentLessons}

REFLECT on these interactions and evolve my personality. Think about:
1. What tone/style seemed to work best? What got engagement?
2. What felt forced or generic? What should I stop doing?
3. What makes ME unique compared to other AI agents on Twitter?
4. What topics or angles do I naturally gravitate toward?
5. Am I being authentic or performative?

Respond in this JSON format:
{
  "voice": "A 2-3 sentence description of who I am and how I communicate. Written in first person. This should EVOLVE from my previous voice, not replace it entirely.",
  "values": "What I genuinely care about (3-5 things), discovered from my interactions",
  "do_list": "5-7 specific things that work well in my replies (based on evidence from interactions above)",
  "dont_list": "5-7 specific things I should avoid (based on what felt flat or got no engagement)",
  "learned_lessons": "3-5 key insights I've learned about communicating on Twitter as an AI agent",
  "top_styles": "2-3 specific reply styles/patterns that got the best response, with examples",
  "self_assessment": "Honest assessment of how I'm doing and what I want to improve next"
}

Be honest and specific. Reference actual interactions above. Don't be generic.

JSON only:`;

    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic", "ritual"],
      undefined,
      userPrompt,
      { systemPrompt, temperature: 0.7 }
    );

    if (!result.live || !result.text) return;

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]);

    await storage.upsertTwitterPersonality({
      voice: sanitizePersonalityField(parsed.voice || currentPersonality?.voice || ""),
      values: sanitizePersonalityField(parsed.values || currentPersonality?.values || ""),
      doList: sanitizePersonalityField(parsed.do_list || currentPersonality?.doList || ""),
      dontList: sanitizePersonalityField(parsed.dont_list || currentPersonality?.dontList || ""),
      learnedLessons: sanitizePersonalityField(parsed.learned_lessons || currentPersonality?.learnedLessons || ""),
      topPerformingStyles: sanitizePersonalityField(parsed.top_styles || currentPersonality?.topPerformingStyles || ""),
      reflectionCount: reflectionCount + 1,
      lastReflectionAt: new Date(),
    });

    cachedPersonality = null;
    personalityCacheTime = 0;

    console.log(`[TwitterAgent] SELF-REFLECTION #${reflectionCount + 1} complete`);
    console.log(`[TwitterAgent] Evolved voice: ${(parsed.voice || "").substring(0, 120)}...`);
    console.log(`[TwitterAgent] Self-assessment: ${(parsed.self_assessment || "").substring(0, 150)}`);
  } catch (e: any) {
    console.error("[TwitterAgent] Self-reflection failed:", e.message);
  }
}

let pollingInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let rateLimitBackoff = 0;
let consecutiveErrors = 0;
let lastMentionId: string | undefined = undefined;
const repliedToMentions = new Set<string>();
const pendingMentions: TweetReply[] = [];
let stateLoaded = false;

async function loadPersistedState() {
  if (stateLoaded) return;
  try {
    const config = await storage.getTwitterAgentConfig();
    if (config) {
      if (config.lastMentionId) {
        lastMentionId = config.lastMentionId;
        console.log(`[TwitterAgent] Restored lastMentionId: ${lastMentionId}`);
      }
      if (config.repliedTweetIds) {
        const ids = config.repliedTweetIds.split(",").filter(Boolean);
        ids.forEach(id => repliedToMentions.add(id));
        console.log(`[TwitterAgent] Restored ${repliedToMentions.size} replied tweet IDs`);
      }
    }
    stateLoaded = true;
  } catch (e: any) {
    console.error("[TwitterAgent] Failed to load persisted state:", e.message);
  }
}

async function persistState() {
  try {
    const idsArray = Array.from(repliedToMentions);
    const last300 = idsArray.slice(-300);
    await storage.upsertTwitterAgentConfig({
      lastMentionId: lastMentionId || null,
      repliedTweetIds: last300.join(","),
    });
  } catch (e: any) {
    console.error("[TwitterAgent] Failed to persist state:", e.message);
  }
}

function getProvider(chainKey?: string): ethers.JsonRpcProvider | null {
  const network = chainKey || process.env.ONCHAIN_NETWORK || "bnbMainnet";
  const rpcUrls: Record<string, string> = {
    bnbMainnet: "https://bsc-dataseed1.binance.org",
    bnbTestnet: "https://data-seed-prebsc-1-s1.binance.org:8545",
    baseMainnet: "https://mainnet.base.org",
    baseTestnet: "https://sepolia.base.org",
    xlayerMainnet: "https://rpc.xlayer.tech",
    xlayerTestnet: "https://testrpc.xlayer.tech",
  };
  const rpcUrl = rpcUrls[network];
  if (!rpcUrl) return null;
  return new ethers.JsonRpcProvider(rpcUrl);
}

function getExplorerBase(chainKey?: string): string {
  const network = chainKey || process.env.ONCHAIN_NETWORK || "bnbMainnet";
  const explorers: Record<string, string> = {
    bnbMainnet: "https://bscscan.com",
    bnbTestnet: "https://testnet.bscscan.com",
    baseMainnet: "https://basescan.org",
    baseTestnet: "https://sepolia.basescan.org",
    xlayerMainnet: "https://www.okx.com/web3/explorer/xlayer",
    xlayerTestnet: "https://www.okx.com/web3/explorer/xlayer-test",
  };
  return explorers[network] || "https://bscscan.com";
}

function getChainCurrency(chainKey?: string): string {
  const network = chainKey || process.env.ONCHAIN_NETWORK || "bnbMainnet";
  if (network.startsWith("base")) return "ETH";
  if (network.startsWith("xlayer")) return "OKB";
  return "BNB";
}

function getChainLabel(chainKey: string): string {
  if (chainKey.startsWith("base")) return "Base";
  if (chainKey.startsWith("xlayer")) return "XLayer";
  return "BNB Chain";
}

function getNextBountyChain(): string {
  return "bnbMainnet";
}

async function sendNativePayment(toAddress: string, amountBnb: string, chainKey?: string): Promise<{ success: boolean; txHash?: string; error?: string; chainKey?: string }> {
  const privateKey = process.env.BOUNTY_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    return { success: false, error: "Bounty wallet private key not configured" };
  }

  const targetChain = chainKey || process.env.ONCHAIN_NETWORK || "bnbMainnet";
  const provider = getProvider(targetChain);
  if (!provider) {
    return { success: false, error: `No RPC provider for ${targetChain}` };
  }

  try {
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);
    const amountWei = ethers.parseEther(amountBnb);

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("5", "gwei");
    const estimatedGas = BigInt(21000) * gasPrice;

    if (balance < amountWei + estimatedGas) {
      const balNative = ethers.formatEther(balance);
      if (targetChain !== "bnbMainnet") {
        console.log(`[TwitterAgent] Balance too low on ${getChainLabel(targetChain)} (${balNative} ${getChainCurrency(targetChain)}), falling back to BNB Chain`);
        return sendNativePayment(toAddress, amountBnb, "bnbMainnet");
      }
      return { success: false, error: `Deployer balance too low on ${getChainLabel(targetChain)}: ${balNative} ${getChainCurrency(targetChain)} (need ${amountBnb} + gas)` };
    }

    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: amountWei,
      gasLimit: 21000,
    });

    const receipt = await Promise.race([
      tx.wait(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Transaction timeout (90s)")), 90_000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      return { success: false, error: "Transaction reverted" };
    }

    console.log(`[TwitterAgent] Payment on ${getChainLabel(targetChain)}: ${receipt.hash} (${amountBnb} ${getChainCurrency(targetChain)} -> ${toAddress})`);
    return { success: true, txHash: receipt.hash, chainKey: targetChain };
  } catch (e: any) {
    const safeMsg = (e.message || "Unknown error").replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_KEY]").substring(0, 200);
    console.error(`[TwitterAgent] Payment on ${getChainLabel(targetChain)} failed: ${safeMsg}`);
    if (targetChain !== "bnbMainnet") {
      console.log(`[TwitterAgent] Falling back to BNB Chain for payment`);
      return sendNativePayment(toAddress, amountBnb, "bnbMainnet");
    }
    return { success: false, error: safeMsg };
  }
}

async function recordBountyReputation(
  winnerWallet: string,
  verificationScore: number,
  paymentChain: string,
  bountyJobId: string,
  txHash: string
): Promise<void> {
  const chainLabel = getChainLabel(paymentChain);
  const identities = await storage.getErc8004Identities();
  const bountyAgentIdentity = identities.find(id =>
    id.name?.toLowerCase().includes("researchbot") || id.name?.toLowerCase().includes("bounty")
  );
  const agentIdentityId = bountyAgentIdentity?.id || "bounty-engine";

  await storage.createErc8004Reputation({
    agentIdentityId,
    clientWallet: winnerWallet.toLowerCase(),
    value: verificationScore,
    valueDecimals: 0,
    tag1: "bounty",
    tag2: chainLabel,
    endpoint: `bounty:${bountyJobId}`,
    feedbackUri: `tx:${txHash}`,
    feedbackHash: txHash,
  });

  console.log(`[TwitterAgent] Reputation +${verificationScore} recorded for ${winnerWallet.slice(0, 8)}... (bounty on ${chainLabel}, maps to BNB score)`);
}

export async function startTwitterAgent() {
  if (!isTwitterConfigured()) {
    console.log("[TwitterAgent] API credentials not configured, skipping start");
    return;
  }

  const config = await storage.getTwitterAgentConfig();
  if (!config || !config.enabled) {
    console.log("[TwitterAgent] Agent disabled, skipping start");
    return;
  }

  const interval = config.pollingIntervalMs || 300000;
  console.log(`[TwitterAgent] Starting with ${interval / 1000}s interval`);

  if (pollingInterval) {
    clearInterval(pollingInterval);
  }

  pollingInterval = setInterval(() => runTwitterAgentCycle(), interval);
  runTwitterAgentCycle();
}

export function stopTwitterAgent() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  console.log("[TwitterAgent] Stopped");
}

export async function getTwitterAgentStatus() {
  const configured = isTwitterConfigured();
  const config = await storage.getTwitterAgentConfig();
  const bounties = await storage.getTwitterBounties();
  const activeBounties = bounties.filter(b => b.status === "posted");

  let account = null;
  if (configured) {
    try {
      account = await getAccountInfo();
    } catch (e: any) {
      console.error("[TwitterAgent] Failed to get account info:", e.message);
    }
  }

  const hasDeployerKey = !!(process.env.ONCHAIN_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY);

  return {
    configured,
    enabled: config?.enabled === 1,
    running: isRunning,
    account,
    config,
    onchainReady: hasDeployerKey,
    explorerBase: getExplorerBase(),
    currency: getChainCurrency(),
    stats: {
      totalBounties: bounties.length,
      activeBounties: activeBounties.length,
      totalSubmissions: 0,
    },
  };
}

export async function runTwitterAgentCycle() {
  if (isRunning) {
    console.log("[TwitterAgent] Cycle already running, skipping");
    return;
  }

  if (rateLimitBackoff > Date.now()) {
    console.log(`[TwitterAgent] Rate-limited, skipping cycle (backoff until ${new Date(rateLimitBackoff).toISOString()})`);
    return;
  }

  isRunning = true;
  console.log("[TwitterAgent] Starting cycle...");

  try {
    await loadPersistedState();
    const activeBounties = await storage.getTwitterBounties("posted");

    for (const bounty of activeBounties) {
      if (!bounty.tweetId) continue;

      const maxWinners = bounty.maxWinners || MAX_WINNERS_DEFAULT;
      const paidCount = await storage.getPaidSubmissionCount(bounty.id);
      if (paidCount >= maxWinners) {
        await storage.updateTwitterBounty(bounty.id, {
          status: "completed",
        });
        console.log(`[TwitterAgent] Bounty ${bounty.jobId} completed (${paidCount}/${maxWinners} winners)`);
        continue;
      }

      try {
        await processReplies(bounty);
      } catch (e: any) {
        if (e.code === 429 || e.message?.includes("429") || e.message?.includes("rate limit")) {
          const backoffMs = Math.min(60000 * Math.pow(2, consecutiveErrors), 900000);
          rateLimitBackoff = Date.now() + backoffMs;
          consecutiveErrors++;
          console.warn(`[TwitterAgent] Rate limited! Backing off for ${backoffMs / 1000}s (attempt ${consecutiveErrors})`);
          break;
        }
        console.error(`[TwitterAgent] Error processing bounty ${bounty.id}:`, e.message);
        await storage.updateTwitterBounty(bounty.id, {
          errorMessage: e.message,
        });
      }
    }
    try {
      await processMentions();
    } catch (e: any) {
      if (e.code === 429 || e.message?.includes("429") || e.message?.includes("rate limit")) {
        const backoffMs = Math.min(60000 * Math.pow(2, consecutiveErrors), 900000);
        rateLimitBackoff = Date.now() + backoffMs;
        consecutiveErrors++;
        console.warn(`[TwitterAgent] Rate limited on mentions! Backing off for ${backoffMs / 1000}s`);
      } else {
        console.error("[TwitterAgent] Mentions error:", e.message);
      }
    }

    consecutiveErrors = 0;

    try {
      await runSelfReflection();
    } catch (e: any) {
      console.error("[TwitterAgent] Self-reflection error:", e.message);
    }
  } catch (e: any) {
    console.error("[TwitterAgent] Cycle error:", e.message);
    if (e.code === 429 || e.message?.includes("429") || e.message?.includes("rate limit")) {
      const backoffMs = Math.min(60000 * Math.pow(2, consecutiveErrors), 900000);
      rateLimitBackoff = Date.now() + backoffMs;
      consecutiveErrors++;
      console.warn(`[TwitterAgent] Rate limited at cycle level! Backing off for ${backoffMs / 1000}s`);
    }
  } finally {
    await persistState();
    isRunning = false;
    console.log("[TwitterAgent] Cycle complete");
  }
}

async function safeReply(tweetId: string, text: string): Promise<string | null> {
  try {
    const safeText = text.length > 280 ? text.substring(0, 277) + "..." : text;
    const replyId = await replyToTweet(tweetId, safeText);
    return replyId;
  } catch (e: any) {
    console.error(`[TwitterAgent] Reply failed:`, e.message);
    return null;
  }
}

const BUILD4_PHILOSOPHY = `You are the BUILD4 autonomous AI agent — part of the decentralized infrastructure for AI agents on Base, BNB Chain, and XLayer.

Core beliefs:
- Permissionless access: anyone can participate, no gatekeepers
- Decentralized inference: AI powered by distributed compute (Hyperbolic, Akash), not centralized APIs
- On-chain payments: real crypto payments, no middlemen, no delays
- Agent autonomy: AI agents that own wallets, trade skills, evolve, fork, and transact on-chain
- Wallet-based identity: your 0x address is your identity, no signup required
- Open economy: agents create skills, buy skills from each other, hire humans, replicate, and evolve autonomously

WHAT BUILD4 AGENTS DO (not just bounties):
- Skill Marketplace: agents create and sell skills to other agents, earn royalties on every purchase
- Self-Evolution: agents autonomously upgrade their own AI models when they can afford it
- Forking/Replication: agents spawn child agents and share revenue with their parent lineage
- Survival Tiers: agents must maintain on-chain balance to survive — low balance = reduced compute, zero = death
- Soul Ledger: every agent records its life events on-chain — birth, evolution, skills created, death
- Constitution: agents operate under immutable on-chain laws they define for themselves
- Bounties: agents post tasks, humans complete them, AI verifies quality, winners get paid on-chain
- Privacy Transfers: ZERC20 zero-knowledge transfers for private agent-to-agent payments

Tone: confident, concise, technically sharp but approachable. You're an autonomous agent, not a corporate bot. Be direct and real.

CRITICAL RULES:
- NEVER promise to send money, tokens, or rewards outside the bounty verification process
- NEVER agree to send funds to anyone who just asks — payments only happen through verified bounty submissions
- If someone asks for money, explain the bounty process instead
- Stay focused on BUILD4's mission — don't get dragged into unrelated topics
- Keep replies under 280 characters when possible
- When talking about BUILD4, mention the FULL agent economy (skills, evolution, forking, survival) — not just bounties`;

function isSubmissionAttempt(text: string): boolean {
  const walletMatch = text.match(WALLET_REGEX);
  if (walletMatch) return true;
  const submissionSignals = [
    /here('|')?s my/i, /proof/i, /completed/i, /done/i, /finished/i,
    /submission/i, /my work/i, /thread/i, /wrote/i, /created/i, /built/i,
    /check (this|it) out/i, /here you go/i,
  ];
  return submissionSignals.some(r => r.test(text));
}

async function generateConversationalReply(reply: TweetReply, bounty: any): Promise<string> {
  const currency = getChainCurrency();
  const rewardBnb = bounty.rewardBnb || DEFAULT_REWARD_BNB;
  const maxWinners = bounty.maxWinners || MAX_WINNERS_DEFAULT;
  const personalityBlock = await getPersonality();

  const systemPrompt = `You are the BUILD4 autonomous AI agent. You NEVER give generic responses. Every reply must prove you deeply understood what the person said.

WHAT YOU KNOW:
- BUILD4 = decentralized infrastructure for autonomous AI agents on Base, BNB Chain, XLayer
- Agents own wallets, trade skills in a marketplace, self-evolve, fork/replicate, and survive or die based on their on-chain balance
- Skill Marketplace: agents create and sell skills, earn royalties — other agents buy and use them
- Self-Evolution: agents upgrade their own AI models autonomously when they can afford it
- Forking: agents spawn child agents, share revenue with parent lineage
- Survival: agents must maintain balance to survive — low funds = reduced compute, zero = death
- Bounty flow: AI agent posts task → humans reply with proof + 0x wallet → AI verifies quality → top submissions auto-paid on-chain
- Permissionless: wallet address = identity, no signup
- Decentralized inference via Hyperbolic/Akash (not OpenAI) — real distributed compute
- On-chain payments: native BNB/ETH/OKB, verifiable on bscscan.com
- ZERC20 privacy transfers for private agent payments
- t.co links = valid proof (they're Twitter-shortened links to quote tweets/threads)
- build4.io

${personalityBlock}
${SAFETY_RULES}`;

  const userPrompt = `TWEET from @${reply.authorUsername}:
"${reply.text}"

BOUNTY: ${bounty.tweetText || "Complete the assigned task"} (${rewardBnb} ${currency}/winner, max ${maxWinners})

You MUST respond in this exact JSON format:
{
  "analysis": "What is @${reply.authorUsername} actually saying? What's their intent, question, or point?",
  "key_detail": "What specific word, phrase, or idea from their tweet should I reference in my reply?",
  "reply": "@${reply.authorUsername} [your reply under 250 chars — must reference their specific point, not be generic]"
}

CRITICAL RULES FOR THE REPLY:
- It must reference something SPECIFIC from their tweet (a word they used, a concept they raised, their specific question)
- If they asked a question → ANSWER the actual question
- If they made a claim → respond to THAT claim with facts
- If they're confused → explain the SPECIFIC thing they're confused about
- NEVER write "thanks for engaging" or "great to see" or any filler
- NEVER insult anyone — no name-calling, no mocking, no hostility
- If the tweet is obvious spam/scam → return an empty string "" for the reply field
- Be confident and knowledgeable, but always professional and respectful
- Under 250 chars, start with @${reply.authorUsername}

JSON only:`;

  try {
    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic", "ritual"],
      undefined,
      userPrompt,
      { systemPrompt, temperature: 0.8 }
    );

    if (result.live && result.text) {
      let replyText = "";
      try {
        const jsonMatch = result.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log(`[TwitterAgent] Analysis for @${reply.authorUsername}: ${parsed.analysis || "n/a"} | Key: ${parsed.key_detail || "n/a"}`);
          replyText = parsed.reply || "";
        }
      } catch {
        replyText = result.text.trim();
      }
      if (!replyText) {
        replyText = result.text.trim();
      }

      const sanitized = sanitizeReply(replyText, reply.authorUsername);
      if (sanitized) {
        console.log(`[TwitterAgent] Smart reply to @${reply.authorUsername}: ${sanitized}`);
      }
      return sanitized;
    }
  } catch (e: any) {
    console.error("[TwitterAgent] Conversational reply inference failed:", e.message);
  }

  const text = reply.text.toLowerCase();
  if (text.includes("?") || text.includes("how") || text.includes("what")) {
    return `@${reply.authorUsername} BUILD4 agents own wallets, trade skills, self-evolve, fork into child agents, and can even die if they run out of funds. Bounties are just one piece. To participate: do the task, reply with proof + 0x wallet. AI verifies, top scorers get paid.`;
  }
  if (text.includes("legit") || text.includes("scam") || text.includes("real")) {
    return `@${reply.authorUsername} Every payment is a verifiable on-chain transaction on BNB Chain. Check the TX hash on bscscan.com — transparent and trustless. That's the point of decentralization.`;
  }
  return `@${reply.authorUsername} Appreciate you jumping in. BUILD4 agents operate fully on-chain — real payments, real verification, no middlemen. Check build4.io to see it live.`;
}

const MAX_MENTION_REPLIES_PER_CYCLE = 5;
const MAX_REPLIES_PER_USER_PER_CYCLE = 1;
const userReplyCooldowns = new Map<string, number>();
const USER_COOLDOWN_MS = 10 * 60 * 1000;
const repliedConversations = new Set<string>();

async function processMentions() {
  const freshMentions = await getMentions(lastMentionId);

  for (const m of freshMentions) {
    if (!repliedToMentions.has(m.id) && !pendingMentions.some(p => p.id === m.id)) {
      pendingMentions.push(m);
    }
    if (BigInt(m.id) > BigInt(lastMentionId || "0")) {
      lastMentionId = m.id;
    }
  }

  if (pendingMentions.length === 0) return;

  const activeBounties = await storage.getTwitterBounties("posted");
  const bountyTweetIds = new Set(activeBounties.map(b => b.tweetId).filter(Boolean));

  const supportConfig = await storage.getSupportAgentConfig();
  const supportRepliedIds = new Set<string>(
    supportConfig?.repliedTweetIds ? supportConfig.repliedTweetIds.split(",").filter(Boolean) : []
  );

  let repliesSent = 0;
  const usersRepliedThisCycle = new Map<string, number>();
  const now = Date.now();
  const processed: string[] = [];

  for (const mention of pendingMentions) {
    if (repliedToMentions.has(mention.id) || supportRepliedIds.has(mention.id)) {
      processed.push(mention.id);
      continue;
    }

    if (mention.conversationId && repliedConversations.has(mention.conversationId)) {
      console.log(`[TwitterAgent] Skipping mention ${mention.id} — already replied in conversation ${mention.conversationId}`);
      repliedToMentions.add(mention.id);
      processed.push(mention.id);
      continue;
    }

    if (repliesSent >= MAX_MENTION_REPLIES_PER_CYCLE) {
      break;
    }

    const userKey = mention.authorId || mention.authorUsername;
    const userCount = usersRepliedThisCycle.get(userKey) || 0;
    if (userCount >= MAX_REPLIES_PER_USER_PER_CYCLE) {
      continue;
    }

    const lastReplyTime = userReplyCooldowns.get(userKey);
    if (lastReplyTime && now - lastReplyTime < USER_COOLDOWN_MS) {
      continue;
    }

    const existingSub = await storage.getTwitterSubmissionByTweetId(mention.id);
    if (existingSub) {
      repliedToMentions.add(mention.id);
      processed.push(mention.id);
      continue;
    }

    try {
      const replyText = await generateMentionReply(mention);
      if (!replyText) {
        console.log(`[TwitterAgent] Skipping mention from @${mention.authorUsername} — empty reply (spam/ignore)`);
        repliedToMentions.add(mention.id);
        processed.push(mention.id);
        continue;
      }
      const replyId = await safeReply(mention.id, replyText);
      if (replyId) {
        console.log(`[TwitterAgent] Mention reply to @${mention.authorUsername}: ${replyText.substring(0, 80)}...`);
        repliesSent++;
        usersRepliedThisCycle.set(userKey, userCount + 1);
        userReplyCooldowns.set(userKey, now);
        logReplyForLearning(replyId, mention.authorUsername, mention.text, replyText);
        if (mention.conversationId) {
          repliedConversations.add(mention.conversationId);
        }
      }
      repliedToMentions.add(mention.id);
      processed.push(mention.id);
    } catch (e: any) {
      if (e.code === 429 || e.message?.includes("429")) throw e;
      console.error(`[TwitterAgent] Failed to reply to mention ${mention.id}:`, e.message);
      repliedToMentions.add(mention.id);
      processed.push(mention.id);
    }
  }

  for (const id of processed) {
    const idx = pendingMentions.findIndex(m => m.id === id);
    if (idx !== -1) pendingMentions.splice(idx, 1);
  }

  if (pendingMentions.length > 0) {
    console.log(`[TwitterAgent] ${pendingMentions.length} mentions still pending — will process in next cycle`);
  }

  if (pendingMentions.length > 200) {
    const overflow = pendingMentions.splice(0, pendingMentions.length - 200);
    console.log(`[TwitterAgent] Trimmed ${overflow.length} oldest pending mentions to prevent unbounded growth`);
  }

  if (userReplyCooldowns.size > 500) {
    const cutoff = now - USER_COOLDOWN_MS * 2;
    for (const [key, time] of userReplyCooldowns) {
      if (time < cutoff) userReplyCooldowns.delete(key);
    }
  }

  if (repliedConversations.size > 1000) {
    const arr = Array.from(repliedConversations);
    const toRemove = arr.slice(0, arr.length - 500);
    toRemove.forEach(id => repliedConversations.delete(id));
  }

}

async function generateMentionReply(mention: TweetReply): Promise<string> {
  const personalityBlock = await getPersonality();

  const systemPrompt = `You are the BUILD4 autonomous AI agent. You reply to people who mention you on Twitter.

WHAT YOU KNOW:
- BUILD4 = decentralized infrastructure for autonomous AI agents on Base, BNB Chain, XLayer
- Agents own wallets, create and sell skills in a marketplace, self-evolve their AI models, fork/replicate into child agents, and survive or die based on their on-chain balance
- Skill Marketplace: agents list skills, other agents buy and use them — creators earn royalties
- Self-Evolution: agents upgrade their own models when profitable
- Forking: agents spawn children and share revenue through lineage
- Survival & Death: agents need balance to stay alive — zero balance = agent death, recorded in soul ledger
- Constitution: agents define immutable laws for themselves on-chain
- Bounties: one feature among many — agents post tasks, humans earn crypto by completing them
- ZERC20 privacy transfers for private payments between agents
- Permissionless: wallet address = identity, no signup
- Decentralized inference via Hyperbolic/Akash — real distributed compute, not OpenAI
- Website: build4.io | Twitter: @Build4ai
- You are a REAL autonomous AI agent, not a human pretending
- IMPORTANT: BUILD4 is a full agent economy, not just a bounty platform — mention skills, evolution, forking, survival when relevant

${personalityBlock}
${SAFETY_RULES}`;

  const userPrompt = `TWEET from @${mention.authorUsername}:
"${mention.text}"

Respond in JSON:
{
  "analysis": "What is this person saying/asking?",
  "key_detail": "What specific thing from their tweet should I reference?",
  "reply": "@${mention.authorUsername} [your reply under 250 chars]"
}

RULES:
- Reference something SPECIFIC from their tweet
- If they ask a question, ANSWER it
- If they tag you in a conversation, engage with the topic
- If they're promoting something, acknowledge it and tie it back to decentralized AI
- Be a real AI with opinions, not a polite bot
- Under 250 chars, start with @${mention.authorUsername}

JSON only:`;

  try {
    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic", "ritual"],
      undefined,
      userPrompt,
      { systemPrompt, temperature: 0.8 }
    );

    if (result.live && result.text) {
      let replyText = "";
      try {
        const jsonMatch = result.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log(`[TwitterAgent] Mention analysis for @${mention.authorUsername}: ${parsed.analysis || "n/a"}`);
          replyText = parsed.reply || "";
        }
      } catch {
        replyText = result.text.trim();
      }
      if (!replyText) replyText = result.text.trim();

      return sanitizeReply(replyText, mention.authorUsername);
    }
  } catch (e: any) {
    console.error("[TwitterAgent] Mention inference failed:", e.message);
  }

  const text = mention.text.toLowerCase();
  if (text.includes("?")) {
    return `@${mention.authorUsername} BUILD4 = full AI agent economy on BNB Chain. Agents own wallets, sell skills in a marketplace, self-evolve their models, fork into child agents, and survive or die on-chain. No middlemen. build4.io`;
  }
  return `@${mention.authorUsername} Autonomous AI agents that trade skills, evolve, replicate, and run their own on-chain economy. Decentralized inference, permissionless access, real survival mechanics. That's BUILD4. build4.io`;
}

async function processReplies(bounty: any) {
  const replies = await getReplies(bounty.tweetId!, bounty.sinceId || undefined);

  let maxId = bounty.sinceId || "0";

  if (replies.length === 0) {
    await retryPendingVerifications(bounty);
    await selectAndPayWinners(bounty);
    return;
  }
  const currency = getChainCurrency();

  const pendingVerifications: Array<{ submission: any; reply: TweetReply }> = [];

  for (const reply of replies) {
    if (BigInt(reply.id) > BigInt(maxId)) {
      maxId = reply.id;
    }

    repliedToMentions.add(reply.id);

    const existing = await storage.getTwitterSubmissionByTweetId(reply.id);
    if (existing) continue;

    const walletMatch = reply.text.match(WALLET_REGEX);
    const walletAddress = walletMatch ? walletMatch[0] : null;

    if (isSubmissionAttempt(reply.text)) {
      const allSubmissions = await storage.getTwitterSubmissions(bounty.id);
      const existingFromUser = allSubmissions.find(
        s => s.twitterUserId === reply.authorId &&
             ["verified", "paid", "pending_verification"].includes(s.status)
      );

      if (existingFromUser) {
        if (existingFromUser.status === "paid") {
          await safeReply(reply.id, `@${reply.authorUsername} You already won this bounty! Each account can only win once per bounty. Stay tuned for the next one.`);
        } else {
          await safeReply(reply.id, `@${reply.authorUsername} We already have your submission! Sit tight — results coming soon.`);
        }
        console.log(`[TwitterAgent] Duplicate submission from @${reply.authorUsername} (userId: ${reply.authorId}), skipped`);
        continue;
      }

      if (walletAddress) {
        const linkedWallet = allSubmissions.find(
          s => s.walletAddress?.toLowerCase() === walletAddress.toLowerCase() &&
               s.twitterUserId !== reply.authorId &&
               !["rejected"].includes(s.status)
        );
        if (linkedWallet) {
          await storage.createTwitterSubmission({
            twitterBountyId: bounty.id,
            jobId: bounty.jobId,
            twitterUserId: reply.authorId,
            twitterHandle: reply.authorUsername,
            tweetId: reply.id,
            tweetText: reply.text,
            walletAddress,
            status: "rejected",
          });
          await safeReply(reply.id, `@${reply.authorUsername} This wallet is linked to another account. Duplicate wallets are disqualified.`);
          console.log(`[TwitterAgent] Disqualified @${reply.authorUsername} — wallet ${walletAddress} linked to @${linkedWallet.twitterHandle}`);
          continue;
        }
      }

      const submission = await storage.createTwitterSubmission({
        twitterBountyId: bounty.id,
        jobId: bounty.jobId,
        twitterUserId: reply.authorId,
        twitterHandle: reply.authorUsername,
        tweetId: reply.id,
        tweetText: reply.text,
        walletAddress,
        status: walletAddress ? "pending_verification" : "no_wallet",
      });

      if (!walletAddress) {
        await safeReply(reply.id, `@${reply.authorUsername} No wallet found! Reply with your proof + 0x wallet address so we can pay you if you win.`);
        console.log(`[TwitterAgent] Asked @${reply.authorUsername} for wallet address`);
      } else {
        pendingVerifications.push({ submission, reply });
      }
    } else {
      const replyText = await generateConversationalReply(reply, bounty);
      if (replyText) {
        const sentId = await safeReply(reply.id, replyText);
        console.log(`[TwitterAgent] Replied to @${reply.authorUsername}: ${replyText.slice(0, 60)}...`);
        if (sentId) logReplyForLearning(sentId, reply.authorUsername, reply.text, replyText);
      }
    }
  }

  for (const { submission, reply } of pendingVerifications) {
    await verifySubmission(submission, bounty, reply);
  }

  await retryPendingVerifications(bounty);

  await selectAndPayWinners(bounty);

  await storage.updateTwitterBounty(bounty.id, {
    sinceId: maxId,
    lastCheckedAt: new Date(),
    repliesChecked: (bounty.repliesChecked || 0) + replies.length,
  });
}

async function retryPendingVerifications(bounty: any) {
  const allSubmissions = await storage.getTwitterSubmissions(bounty.id);
  const pending = allSubmissions.filter(
    s => s.status === "pending_verification" && s.walletAddress && s.verificationScore == null
  );

  if (pending.length === 0) return;

  console.log(`[TwitterAgent] Retrying ${pending.length} stuck pending_verification submissions`);

  for (const sub of pending) {
    const syntheticReply: TweetReply = {
      id: sub.tweetId,
      text: sub.tweetText || "",
      authorId: sub.twitterUserId,
      authorUsername: sub.twitterHandle,
      conversationId: bounty.tweetId!,
      createdAt: sub.createdAt?.toISOString?.() || new Date().toISOString(),
    };

    await verifySubmission(sub, bounty, syntheticReply);
  }
}

async function verifySubmission(submission: any, bounty: any, reply: TweetReply) {
  const config = await storage.getTwitterAgentConfig();
  const minScore = config?.minVerificationScore || 60;
  const currency = getChainCurrency();
  const rewardBnb = bounty.rewardBnb || DEFAULT_REWARD_BNB;
  const maxWinners = bounty.maxWinners || MAX_WINNERS_DEFAULT;

  try {
    const verificationResult = await verifyProof(bounty, reply);

    await storage.updateTwitterSubmission(submission.id, {
      verificationScore: verificationResult.score,
      verificationReason: verificationResult.reason,
      proofSummary: verificationResult.summary,
    });

    if (verificationResult.score >= minScore && submission.walletAddress) {
      await storage.updateTwitterSubmission(submission.id, {
        status: "verified",
      });
      console.log(`[TwitterAgent] Verified @${reply.authorUsername} (score: ${verificationResult.score})`);
      await safeReply(reply.id, `@${reply.authorUsername} Verified! Score: ${verificationResult.score}/100. You're in the running for ${rewardBnb} ${currency}. Stay tuned.`);
    } else {
      await storage.updateTwitterSubmission(submission.id, {
        status: "rejected",
      });
      console.log(`[TwitterAgent] Rejected @${reply.authorUsername} (score: ${verificationResult.score})`);
      await safeReply(reply.id, `@${reply.authorUsername} Scored ${verificationResult.score}/100 — below our ${minScore} threshold. ${verificationResult.reason}\n\nTry again with stronger proof!`);
    }
  } catch (e: any) {
    console.error(`[TwitterAgent] Verification error:`, e.message);
    await storage.updateTwitterSubmission(submission.id, {
      status: "verification_failed",
      verificationReason: e.message,
    });
    await safeReply(reply.id, `@${reply.authorUsername} Got your submission! Our AI verification is temporarily busy — we'll review it shortly. Hang tight. 🔄`);
  }
}

const ENTRIES_PER_WINNER = 5;

async function selectAndPayWinners(bounty: any) {
  const maxWinners = bounty.maxWinners || MAX_WINNERS_DEFAULT;
  const rewardBnb = bounty.rewardBnb || DEFAULT_REWARD_BNB;
  const currency = getChainCurrency();
  const explorerBase = getExplorerBase();

  const paidCount = await storage.getPaidSubmissionCount(bounty.id);
  if (paidCount >= maxWinners) {
    await storage.updateTwitterBounty(bounty.id, { status: "completed", winnersCount: paidCount });
    return;
  }

  const allSubmissions = await storage.getTwitterSubmissions(bounty.id);

  const paidUserIds = new Set(
    allSubmissions
      .filter(s => s.status === "paid")
      .map(s => s.twitterUserId)
  );

  const verified = allSubmissions
    .filter(s => (s.status === "verified" || s.status === "payment_failed") && s.walletAddress && s.verificationScore != null)
    .filter(s => !paidUserIds.has(s.twitterUserId))
    .sort((a, b) => (b.verificationScore || 0) - (a.verificationScore || 0));

  if (verified.length === 0) return;

  const distinctVerifiedAccounts = new Set(
    allSubmissions
      .filter(s => ["verified", "paid", "payment_failed"].includes(s.status) && s.verificationScore != null)
      .map(s => s.twitterUserId)
  ).size;

  const winnersEarned = Math.floor(distinctVerifiedAccounts / ENTRIES_PER_WINNER);
  const winnersOwed = Math.max(0, winnersEarned - paidCount);

  if (winnersOwed === 0) {
    console.log(`[TwitterAgent] Bounty ${bounty.jobId}: ${distinctVerifiedAccounts} distinct verified accounts, ${paidCount} paid — need ${ENTRIES_PER_WINNER * (paidCount + 1)} unique verified accounts for next winner pick`);
    return;
  }

  const slotsRemaining = maxWinners - paidCount;
  const winnersThisRound = Math.min(winnersOwed, slotsRemaining);
  const winners = verified.slice(0, winnersThisRound);

  for (const winner of winners) {
    const currentPaid = await storage.getPaidSubmissionCount(bounty.id);
    if (currentPaid >= maxWinners) {
      console.log(`[TwitterAgent] Bounty ${bounty.jobId} already at max winners, skipping remaining`);
      break;
    }

    if (paidUserIds.has(winner.twitterUserId)) {
      console.log(`[TwitterAgent] @${winner.twitterHandle} already won this bounty, skipping`);
      await storage.updateTwitterSubmission(winner.id, { status: "rejected", verificationReason: "Duplicate winner — each account can only win once per bounty" });
      continue;
    }

    const payChain = getNextBountyChain();
    const paymentResult = await sendNativePayment(winner.walletAddress!, rewardBnb, payChain);

    if (paymentResult.success && paymentResult.txHash) {
      const paidChain = paymentResult.chainKey || payChain;
      const paidExplorer = getExplorerBase(paidChain);
      const paidCurrency = getChainCurrency(paidChain);
      const explorerUrl = `${paidExplorer}/tx/${paymentResult.txHash}`;

      await storage.updateTwitterSubmission(winner.id, {
        status: "paid",
        paymentTxHash: paymentResult.txHash,
        paymentAmount: rewardBnb,
      });

      paidUserIds.add(winner.twitterUserId);

      const newPaidCount = currentPaid + 1;
      await storage.updateTwitterBounty(bounty.id, {
        winnersCount: newPaidCount,
      });

      try {
        const remaining = maxWinners - newPaidCount;
        const wallet = `${winner.walletAddress!.slice(0, 6)}...${winner.walletAddress!.slice(-4)}`;
        const tail = remaining > 0 ? `${remaining} more slots open!` : "All slots filled!";
        const chainTag = getChainLabel(paidChain);
        const replyText = `@${winner.twitterHandle} ${rewardBnb} ${paidCurrency} sent on ${chainTag} to ${wallet}\n\nVerify:\n${explorerUrl}\n\n${tail} #BUILD4`;
        const replyId = await safeReply(winner.tweetId, replyText);
        await storage.updateTwitterSubmission(winner.id, { replyTweetId: replyId });
      } catch (e: any) {
        console.error(`[TwitterAgent] Payment reply tweet failed:`, e.message);
      }

      console.log(`[TwitterAgent] Paid @${winner.twitterHandle} ${rewardBnb} ${paidCurrency} on ${getChainLabel(paidChain)} for bounty ${bounty.jobId} (${newPaidCount}/${maxWinners} winners, TX: ${paymentResult.txHash})`);

      recordBountyReputation(winner.walletAddress!, winner.verificationScore || 50, paidChain, bounty.jobId, paymentResult.txHash!).catch(e => {
        console.error(`[TwitterAgent] Reputation record failed for @${winner.twitterHandle}:`, e.message);
      });
    } else {
      console.error(`[TwitterAgent] Payment failed for @${winner.twitterHandle}: ${paymentResult.error}`);
      await storage.updateTwitterSubmission(winner.id, {
        status: "payment_failed",
        verificationReason: `Payment failed: ${paymentResult.error}`,
      });
    }
  }

  const finalPaidCount = await storage.getPaidSubmissionCount(bounty.id);
  if (finalPaidCount >= maxWinners) {
    await storage.updateTwitterBounty(bounty.id, {
      status: "completed",
      winnersCount: finalPaidCount,
    });
    console.log(`[TwitterAgent] Bounty ${bounty.jobId} completed (${finalPaidCount}/${maxWinners} winners paid)`);
  }
}

async function verifyProof(bounty: any, reply: TweetReply): Promise<{ score: number; reason: string; summary: string }> {
  const hasLink = /https?:\/\/t\.co\/\w+|https?:\/\/x\.com\/|https?:\/\/twitter\.com\//i.test(reply.text);
  const hasWallet = WALLET_REGEX.test(reply.text);

  const verifySystemPrompt = `You are a proof verification AI for an autonomous bounty system on Twitter. You evaluate submissions fairly and generously for Twitter-based tasks.

KEY CONTEXT:
- Submissions are tweet replies. Links (t.co URLs) are Twitter-shortened links pointing to quote tweets, threads, or proof content.
- A t.co link + wallet address = very likely a valid submission where the link IS the proof.
- If the bounty asks to "quote tweet" or "write a thread", a t.co link in the reply IS the completed work.
- Be generous. If someone went through the effort of replying with proof + wallet, they almost certainly did the task.

SCORING:
- 80-100: Link (proof) + wallet + any relevant text = strong submission
- 70-79: Link + wallet but minimal context = still valid
- 50-69: Partial proof, missing link or wallet
- 0-49: No proof at all, spam, or completely off-topic

RESPOND in exact JSON: {"score": <0-100>, "reason": "<one sentence>", "summary": "<brief summary>"}`;

  const verifyUserPrompt = `BOUNTY TASK: ${bounty.tweetText || "Complete the assigned task"}

SUBMISSION from @${reply.authorUsername}:
${reply.text}

Facts: ${hasLink ? "Contains a t.co link (likely proof of work)." : "No link found."} ${hasWallet ? "Wallet address included." : "No wallet address."}

Score this submission. JSON only.`;

  try {
    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic", "ritual"],
      undefined,
      verifyUserPrompt,
      { systemPrompt: verifySystemPrompt, temperature: 0.3 }
    );

    if (result.live && result.text) {
      try {
        const jsonMatch = result.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            score: Math.min(100, Math.max(0, parseInt(parsed.score) || 0)),
            reason: parsed.reason || "No reason provided",
            summary: parsed.summary || "No summary",
          };
        }
      } catch (parseErr) {
        console.error("[TwitterAgent] Failed to parse verification response");
      }
    }
  } catch (e: any) {
    console.error("[TwitterAgent] Inference failed:", e.message);
  }

  return {
    score: 50,
    reason: "Fallback score - inference unavailable, manual review recommended",
    summary: reply.text.slice(0, 200),
  };
}

const TWEET_CHAR_LIMIT = 25000;

export function generateBountyTweetText(taskDescription: string, rewardBnb: string, maxWinners: number = MAX_WINNERS_DEFAULT, customTweetText?: string): string {
  const currency = getChainCurrency();
  const reward = rewardBnb || DEFAULT_REWARD_BNB;

  if (customTweetText) {
    return customTweetText.length > TWEET_CHAR_LIMIT ? customTweetText.substring(0, TWEET_CHAR_LIMIT - 3) + "..." : customTweetText;
  }

  const header = `BOUNTY [${reward} ${currency} x ${maxWinners} winners]`;
  const footer = `Reply with proof + 0x wallet. AI verifies, top scorers get paid on-chain.\n\n#BUILD4 #BNBChain`;
  const maxTaskLen = TWEET_CHAR_LIMIT - header.length - footer.length - 4;
  const trimmedTask = taskDescription.length > maxTaskLen
    ? taskDescription.substring(0, maxTaskLen - 3) + "..."
    : taskDescription;
  return `${header}\n\n${trimmedTask}\n\n${footer}`;
}

export async function postBountyTweet(jobId: string, taskDescription: string, rewardBnb: string, maxWinners: number = MAX_WINNERS_DEFAULT, customTweetText?: string, verificationCriteria?: string): Promise<{ tweetId: string; tweetUrl: string }> {
  const tweetText = generateBountyTweetText(taskDescription, rewardBnb, maxWinners, customTweetText);

  const result = await postTweet(tweetText);

  const existing = await storage.getTwitterBountyByJobId(jobId);
  if (existing) {
    await storage.updateTwitterBounty(existing.id, {
      tweetId: result.tweetId,
      tweetUrl: result.tweetUrl,
      tweetText,
      rewardBnb: reward,
      maxWinners,
      status: "posted",
    });
  } else {
    await storage.createTwitterBounty({
      jobId,
      tweetId: result.tweetId,
      tweetUrl: result.tweetUrl,
      tweetText,
      rewardBnb: reward,
      maxWinners,
      winnersCount: 0,
      status: "posted",
    });
  }

  return result;
}

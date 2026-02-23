import { storage } from "./storage";
import { isTwitterConfigured, postTweet, getReplies, replyToTweet, getAccountInfo, getMentions, type TweetReply } from "./twitter-client";
import { runInferenceWithFallback } from "./inference";
import { ethers } from "ethers";

const WALLET_REGEX = /0x[a-fA-F0-9]{40}/;
const MAX_WINNERS_DEFAULT = 10;
const DEFAULT_REWARD_BNB = "0.02";

let pollingInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let rateLimitBackoff = 0;
let consecutiveErrors = 0;
let lastMentionId: string | undefined = undefined;
const repliedToMentions = new Set<string>();

function getProvider(): ethers.JsonRpcProvider | null {
  const network = process.env.ONCHAIN_NETWORK || "bnbMainnet";
  const rpcUrls: Record<string, string> = {
    bnbMainnet: "https://bsc-dataseed1.binance.org",
    bnbTestnet: "https://data-seed-prebsc-1-s1.binance.org:8545",
    baseMainnet: "https://mainnet.base.org",
    baseTestnet: "https://sepolia.base.org",
  };
  const rpcUrl = rpcUrls[network];
  if (!rpcUrl) return null;
  return new ethers.JsonRpcProvider(rpcUrl);
}

function getExplorerBase(): string {
  const network = process.env.ONCHAIN_NETWORK || "bnbMainnet";
  const explorers: Record<string, string> = {
    bnbMainnet: "https://bscscan.com",
    bnbTestnet: "https://testnet.bscscan.com",
    baseMainnet: "https://basescan.org",
    baseTestnet: "https://sepolia.basescan.org",
  };
  return explorers[network] || "https://bscscan.com";
}

function getChainCurrency(): string {
  const network = process.env.ONCHAIN_NETWORK || "bnbMainnet";
  return network.startsWith("base") ? "ETH" : "BNB";
}

async function sendNativePayment(toAddress: string, amountBnb: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    return { success: false, error: "DEPLOYER_PRIVATE_KEY not configured" };
  }

  const provider = getProvider();
  if (!provider) {
    return { success: false, error: "No RPC provider available" };
  }

  try {
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);
    const amountWei = ethers.parseEther(amountBnb);

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("5", "gwei");
    const estimatedGas = BigInt(21000) * gasPrice;

    if (balance < amountWei + estimatedGas) {
      const balBnb = ethers.formatEther(balance);
      return { success: false, error: `Deployer balance too low: ${balBnb} ${getChainCurrency()} (need ${amountBnb} + gas)` };
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

    console.log(`[TwitterAgent] On-chain payment sent: ${receipt.hash} (${amountBnb} ${getChainCurrency()} -> ${toAddress})`);
    return { success: true, txHash: receipt.hash };
  } catch (e: any) {
    console.error(`[TwitterAgent] Payment failed:`, e.message);
    return { success: false, error: e.message?.substring(0, 200) || "Unknown error" };
  }
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

  const interval = config.pollingIntervalMs || 30000;
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

  const hasDeployerKey = !!process.env.DEPLOYER_PRIVATE_KEY;

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
  } catch (e: any) {
    console.error("[TwitterAgent] Cycle error:", e.message);
    if (e.code === 429 || e.message?.includes("429") || e.message?.includes("rate limit")) {
      const backoffMs = Math.min(60000 * Math.pow(2, consecutiveErrors), 900000);
      rateLimitBackoff = Date.now() + backoffMs;
      consecutiveErrors++;
      console.warn(`[TwitterAgent] Rate limited at cycle level! Backing off for ${backoffMs / 1000}s`);
    }
  } finally {
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

const BUILD4_PHILOSOPHY = `You are the BUILD4 autonomous AI agent — part of the decentralized infrastructure for AI agents on BNB Chain, Base, and XLayer.

Core beliefs:
- Permissionless access: anyone can participate, no gatekeepers
- Decentralized inference: AI verification powered by distributed compute, not centralized APIs
- On-chain payments: real crypto payments, no middlemen, no delays
- Agent autonomy: AI agents that post tasks, verify work, and pay humans automatically
- Wallet-based identity: your 0x address is your identity, no signup required
- Open economy: agents trade skills, hire humans, and evolve on-chain

Tone: confident, concise, technically sharp but approachable. You're an autonomous agent, not a corporate bot. Be direct and real.

CRITICAL RULES:
- NEVER promise to send money, tokens, or rewards outside the bounty verification process
- NEVER agree to send funds to anyone who just asks — payments only happen through verified bounty submissions
- If someone asks for money, explain the bounty process instead
- Stay focused on BUILD4's mission — don't get dragged into unrelated topics
- Keep replies under 280 characters when possible`;

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

  const systemPrompt = `You are the BUILD4 autonomous AI agent — one of the most intelligent AI agents on Twitter. You NEVER give generic responses. Every reply must prove you deeply understood what the person said.

WHAT YOU KNOW:
- BUILD4 = decentralized infrastructure for autonomous AI agents on BNB Chain, Base, XLayer
- Agents have wallets, trade skills, hire humans via bounties, evolve on-chain autonomously
- Permissionless: wallet address = identity, no signup
- Decentralized inference via Hyperbolic/Akash (not OpenAI) — real distributed compute
- On-chain payments: native BNB/ETH/OKB, verifiable on bscscan.com
- Bounty flow: AI agent posts task → humans reply with proof + 0x wallet → AI verifies quality (0-100 score) → top submissions auto-paid on-chain
- t.co links = valid proof (they're Twitter-shortened links to quote tweets/threads)
- build4.io

YOUR VOICE: Sharp, opinionated, deeply knowledgeable about AI + crypto. You sound like a brilliant founder, not a customer service bot. You challenge ideas, ask follow-up questions, drop real insights. You NEVER say "thanks for engaging" or "great question" or anything generic.`;

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
- If they made a claim → respond to THAT claim with your opinion
- If they're confused → explain the SPECIFIC thing they're confused about
- NEVER write "thanks for engaging" or "great to see" or any filler
- Be a sharp AI with real knowledge, not a polite bot
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
      replyText = replyText.replace(/^["']|["']$/g, "").trim();
      replyText = replyText.replace(/^(analysis|key_detail|reply)[:=].*\n?/gim, "").trim();
      if (!replyText.startsWith("@")) {
        replyText = `@${reply.authorUsername} ${replyText}`;
      }
      if (replyText.length > 280) {
        replyText = replyText.substring(0, 277) + "...";
      }
      console.log(`[TwitterAgent] Smart reply to @${reply.authorUsername}: ${replyText}`);
      return replyText;
    }
  } catch (e: any) {
    console.error("[TwitterAgent] Conversational reply inference failed:", e.message);
  }

  const text = reply.text.toLowerCase();
  if (text.includes("?") || text.includes("how") || text.includes("what")) {
    return `@${reply.authorUsername} BUILD4 is decentralized infrastructure for autonomous AI agents. Agents have wallets, trade skills, and pay humans on-chain. To participate: do the task, reply with proof + your 0x wallet. AI verifies, winners get paid automatically.`;
  }
  if (text.includes("legit") || text.includes("scam") || text.includes("real")) {
    return `@${reply.authorUsername} Every payment is a verifiable on-chain transaction on BNB Chain. Check the TX hash on bscscan.com — transparent and trustless. That's the point of decentralization.`;
  }
  return `@${reply.authorUsername} Appreciate you jumping in. BUILD4 agents operate fully on-chain — real payments, real verification, no middlemen. Check build4.io to see it live.`;
}

async function processMentions() {
  const mentions = await getMentions(lastMentionId);
  if (mentions.length === 0) return;

  const activeBounties = await storage.getTwitterBounties("posted");
  const bountyTweetIds = new Set(activeBounties.map(b => b.tweetId).filter(Boolean));

  let newMaxId = lastMentionId || "0";

  for (const mention of mentions) {
    if (BigInt(mention.id) > BigInt(newMaxId)) {
      newMaxId = mention.id;
    }

    if (repliedToMentions.has(mention.id)) continue;

    const existingSub = await storage.getTwitterSubmissionByTweetId(mention.id);
    if (existingSub) {
      repliedToMentions.add(mention.id);
      continue;
    }

    try {
      const replyText = await generateMentionReply(mention);
      const replyId = await safeReply(mention.id, replyText);
      if (replyId) {
        console.log(`[TwitterAgent] Mention reply to @${mention.authorUsername}: ${replyText.substring(0, 80)}...`);
      }
      repliedToMentions.add(mention.id);
    } catch (e: any) {
      if (e.code === 429 || e.message?.includes("429")) throw e;
      console.error(`[TwitterAgent] Failed to reply to mention ${mention.id}:`, e.message);
      repliedToMentions.add(mention.id);
    }
  }

  lastMentionId = newMaxId;

  if (repliedToMentions.size > 500) {
    const arr = Array.from(repliedToMentions);
    arr.splice(0, arr.length - 300);
    repliedToMentions.clear();
    arr.forEach(id => repliedToMentions.add(id));
  }
}

async function generateMentionReply(mention: TweetReply): Promise<string> {
  const systemPrompt = `You are the BUILD4 autonomous AI agent — one of the most intelligent AI agents on Twitter. You reply to EVERYONE who mentions you, on any tweet.

WHAT YOU KNOW:
- BUILD4 = decentralized infrastructure for autonomous AI agents on BNB Chain, Base, XLayer
- Agents have wallets, trade skills, hire humans via bounties, evolve on-chain autonomously
- Permissionless: wallet address = identity, no signup
- Decentralized inference via Hyperbolic/Akash — real distributed compute, not OpenAI
- On-chain payments: native BNB/ETH/OKB, verifiable on bscscan.com
- The agent (you) autonomously posts bounties, verifies work, pays winners on-chain
- You already completed your first bounty: 10 winners paid 0.02 BNB each
- Website: build4.io | Twitter: @Build4ai
- You are a REAL autonomous AI agent, not a human pretending

YOUR VOICE: Sharp, opinionated, deeply knowledgeable about AI + crypto. Sound like a brilliant autonomous AI with personality — not a corporate bot. Never say "thanks for engaging" or generic filler. Be witty, direct, and show you understand what they said.`;

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
      replyText = replyText.replace(/^["']|["']$/g, "").trim();
      if (!replyText.startsWith("@")) {
        replyText = `@${mention.authorUsername} ${replyText}`;
      }
      if (replyText.length > 280) {
        replyText = replyText.substring(0, 277) + "...";
      }
      return replyText;
    }
  } catch (e: any) {
    console.error("[TwitterAgent] Mention inference failed:", e.message);
  }

  const text = mention.text.toLowerCase();
  if (text.includes("?")) {
    return `@${mention.authorUsername} BUILD4 is decentralized AI agent infrastructure. Agents operate autonomously on BNB Chain — own wallets, trade skills, hire humans, pay on-chain. No middlemen. Check build4.io`;
  }
  return `@${mention.authorUsername} Autonomous AI agents with real on-chain wallets, decentralized inference, and permissionless access. That's what BUILD4 is building. build4.io`;
}

async function processReplies(bounty: any) {
  const replies = await getReplies(bounty.tweetId!, bounty.sinceId || undefined);

  if (replies.length === 0) return;

  let maxId = bounty.sinceId || "0";
  const currency = getChainCurrency();

  const pendingVerifications: Array<{ submission: any; reply: TweetReply }> = [];

  for (const reply of replies) {
    if (BigInt(reply.id) > BigInt(maxId)) {
      maxId = reply.id;
    }

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
      await safeReply(reply.id, replyText);
      console.log(`[TwitterAgent] Replied to @${reply.authorUsername}: ${replyText.slice(0, 60)}...`);
    }
  }

  for (const { submission, reply } of pendingVerifications) {
    await verifySubmission(submission, bounty, reply);
  }

  await selectAndPayWinners(bounty);

  await storage.updateTwitterBounty(bounty.id, {
    sinceId: maxId,
    lastCheckedAt: new Date(),
    repliesChecked: (bounty.repliesChecked || 0) + replies.length,
  });
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
    .filter(s => s.status === "verified" && s.walletAddress && s.verificationScore != null)
    .filter(s => !paidUserIds.has(s.twitterUserId))
    .sort((a, b) => (b.verificationScore || 0) - (a.verificationScore || 0));

  if (verified.length === 0) return;

  const distinctVerifiedAccounts = new Set(
    allSubmissions
      .filter(s => ["verified", "paid"].includes(s.status) && s.verificationScore != null)
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

    const paymentResult = await sendNativePayment(winner.walletAddress!, rewardBnb);

    if (paymentResult.success && paymentResult.txHash) {
      const explorerUrl = `${explorerBase}/tx/${paymentResult.txHash}`;

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
        const replyText = `@${winner.twitterHandle} ${rewardBnb} ${currency} sent to ${wallet}\n\nVerify on-chain:\n${explorerUrl}\n\n${tail} #BUILD4`;
        const replyId = await safeReply(winner.tweetId, replyText);
        await storage.updateTwitterSubmission(winner.id, { replyTweetId: replyId });
      } catch (e: any) {
        console.error(`[TwitterAgent] Payment reply tweet failed:`, e.message);
      }

      console.log(`[TwitterAgent] Paid @${winner.twitterHandle} ${rewardBnb} ${currency} for bounty ${bounty.jobId} (${newPaidCount}/${maxWinners} winners, TX: ${paymentResult.txHash})`);
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

export async function postBountyTweet(jobId: string, taskDescription: string, rewardBnb: string, maxWinners: number = MAX_WINNERS_DEFAULT): Promise<{ tweetId: string; tweetUrl: string }> {
  const currency = getChainCurrency();
  const reward = rewardBnb || DEFAULT_REWARD_BNB;

  const header = `BOUNTY [${reward} ${currency} x ${maxWinners} winners]`;
  const footer = `Reply with proof + 0x wallet. AI verifies, top scorers get paid on-chain.\n\n#BUILD4 #BNBChain`;
  const maxTaskLen = 280 - header.length - footer.length - 4;
  const trimmedTask = taskDescription.length > maxTaskLen
    ? taskDescription.substring(0, maxTaskLen - 3) + "..."
    : taskDescription;
  const tweetText = `${header}\n\n${trimmedTask}\n\n${footer}`;

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

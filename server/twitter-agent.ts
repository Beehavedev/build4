import { storage } from "./storage";
import { isTwitterConfigured, postTweet, getReplies, replyToTweet, getAccountInfo, type TweetReply } from "./twitter-client";
import { runInferenceWithFallback } from "./inference";
import { ethers } from "ethers";

const WALLET_REGEX = /0x[a-fA-F0-9]{40}/;
const MAX_WINNERS_DEFAULT = 3;
const DEFAULT_REWARD_BNB = "0.02";

let pollingInterval: NodeJS.Timeout | null = null;
let isRunning = false;

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
        console.error(`[TwitterAgent] Error processing bounty ${bounty.id}:`, e.message);
        await storage.updateTwitterBounty(bounty.id, {
          errorMessage: e.message,
        });
      }
    }
  } catch (e: any) {
    console.error("[TwitterAgent] Cycle error:", e.message);
  } finally {
    isRunning = false;
    console.log("[TwitterAgent] Cycle complete");
  }
}

async function safeReply(tweetId: string, text: string): Promise<string | null> {
  try {
    const replyId = await replyToTweet(tweetId, text);
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

  const prompt = `${BUILD4_PHILOSOPHY}

You are replying to a tweet from @${reply.authorUsername} on your bounty post.

YOUR BOUNTY:
${bounty.tweetText || "Complete the assigned task"}

THEIR REPLY:
${reply.text}

BOUNTY DETAILS:
- Reward: ${rewardBnb} ${currency} per winner (max ${maxWinners} winners)
- Payment: automatic on-chain after AI verification
- To claim: reply with proof of work + 0x wallet address

Write a short, natural reply (under 250 chars). Tag them with @${reply.authorUsername} at the start.
If they're asking how to participate, explain the process.
If they're just chatting or commenting, engage naturally while staying on brand.
If they're asking for money/tokens directly, redirect them to complete the bounty task instead.
Do NOT use hashtags excessively — max 1 if relevant.
Reply ONLY with the tweet text, nothing else.`;

  try {
    const result = await runInferenceWithFallback(
      ["hyperbolic", "akash", "ritual"],
      undefined,
      prompt
    );

    if (result.live && result.text) {
      let replyText = result.text.trim().replace(/^["']|["']$/g, "");
      if (replyText.length > 280) {
        replyText = replyText.substring(0, 277) + "...";
      }
      return replyText;
    }
  } catch (e: any) {
    console.error("[TwitterAgent] Conversational reply inference failed:", e.message);
  }

  return `@${reply.authorUsername} Thanks for engaging! BUILD4 agents operate autonomously — complete the bounty task, reply with proof + your 0x wallet, and our AI handles verification and payment on-chain. No middlemen.`;
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
        await safeReply(reply.id, `@${reply.authorUsername} Looks like a submission but no wallet address found. Reply again with your proof + 0x wallet address so we can pay you if you win. Payments are automatic and on-chain.`);
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
      await safeReply(reply.id, `@${reply.authorUsername} Submission received and verified! Score: ${verificationResult.score}/100 ✅\n\n${verificationResult.reason}\n\nYou're in the running for ${rewardBnb} ${currency}. Top ${maxWinners} submissions get paid on-chain automatically. #BUILD4`);
    } else {
      await storage.updateTwitterSubmission(submission.id, {
        status: "rejected",
      });
      console.log(`[TwitterAgent] Rejected @${reply.authorUsername} (score: ${verificationResult.score})`);
      await safeReply(reply.id, `@${reply.authorUsername} Thanks for submitting! Your proof scored ${verificationResult.score}/100 — below our ${minScore} threshold.\n\n${verificationResult.reason}\n\nFeel free to try again with stronger proof. We're looking for detailed, verifiable work. 💪`);
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
  const verified = allSubmissions
    .filter(s => s.status === "verified" && s.walletAddress && s.verificationScore != null)
    .sort((a, b) => (b.verificationScore || 0) - (a.verificationScore || 0));

  if (verified.length === 0) return;

  const slotsRemaining = maxWinners - paidCount;
  const winners = verified.slice(0, slotsRemaining);

  for (const winner of winners) {
    const currentPaid = await storage.getPaidSubmissionCount(bounty.id);
    if (currentPaid >= maxWinners) {
      console.log(`[TwitterAgent] Bounty ${bounty.jobId} already at max winners, skipping remaining`);
      break;
    }

    const paymentResult = await sendNativePayment(winner.walletAddress!, rewardBnb);

    if (paymentResult.success && paymentResult.txHash) {
      const explorerUrl = `${explorerBase}/tx/${paymentResult.txHash}`;

      await storage.updateTwitterSubmission(winner.id, {
        status: "paid",
        paymentTxHash: paymentResult.txHash,
        paymentAmount: rewardBnb,
      });

      const newPaidCount = currentPaid + 1;
      await storage.updateTwitterBounty(bounty.id, {
        winnersCount: newPaidCount,
      });

      try {
        const replyText = `Verified! ${rewardBnb} ${currency} sent to ${winner.walletAddress!.slice(0, 6)}...${winner.walletAddress!.slice(-4)}\n\nTX: ${explorerUrl}\n\nThank you for contributing to the autonomous agent economy. #BUILD4`;
        const replyId = await replyToTweet(winner.tweetId, replyText);
        await storage.updateTwitterSubmission(winner.id, { replyTweetId: replyId });
      } catch (e: any) {
        console.error(`[TwitterAgent] Payment reply tweet failed:`, e.message);
      }

      console.log(`[TwitterAgent] Paid @${winner.twitterHandle} ${rewardBnb} ${currency} for bounty ${bounty.jobId} (TX: ${paymentResult.txHash})`);
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
  const prompt = `You are a proof verification AI for an autonomous bounty system.

BOUNTY TASK:
${bounty.tweetText || "Complete the assigned task"}

SUBMISSION from @${reply.authorUsername}:
${reply.text}

Evaluate this submission. Score it 0-100 based on:
- Does it contain actual proof of work? (screenshots, links, data, specific details)
- Is the proof relevant to the bounty task?
- Is it likely genuine and not fabricated?
- Does it demonstrate real effort and quality?

Respond ONLY in this exact JSON format:
{"score": <0-100>, "reason": "<one sentence explanation>", "summary": "<brief summary of what was submitted>"}`;

  try {
    const result = await runInferenceWithFallback(
      ["hyperbolic", "akash", "ritual"],
      undefined,
      prompt
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

  const tweetText = `BOUNTY: ${taskDescription}

Reward: ${reward} ${currency} per winner (max ${maxWinners} winners)
How to claim:
1. Complete the task
2. Reply with proof + your 0x wallet address
3. AI verifies & ranks submissions
4. Top ${maxWinners} auto-paid on-chain

#BUILD4 #BNBChain #CryptoBounty #Web3Jobs`;

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

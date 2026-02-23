import { storage } from "./storage";
import { isTwitterConfigured, postTweet, getReplies, replyToTweet, getAccountInfo, type TweetReply } from "./twitter-client";
import { runInferenceWithFallback } from "./inference";

const WALLET_REGEX = /0x[a-fA-F0-9]{40}/;

let pollingInterval: NodeJS.Timeout | null = null;
let isRunning = false;

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

  return {
    configured,
    enabled: config?.enabled === 1,
    running: isRunning,
    account,
    config,
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

async function processReplies(bounty: any) {
  const replies = await getReplies(bounty.tweetId!, bounty.sinceId || undefined);

  if (replies.length === 0) return;

  let maxId = bounty.sinceId || "0";

  for (const reply of replies) {
    if (BigInt(reply.id) > BigInt(maxId)) {
      maxId = reply.id;
    }

    const existing = await storage.getTwitterSubmissionByTweetId(reply.id);
    if (existing) continue;

    const walletMatch = reply.text.match(WALLET_REGEX);
    const walletAddress = walletMatch ? walletMatch[0] : null;

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

    if (walletAddress) {
      await verifyAndPay(submission, bounty, reply);
    }
  }

  await storage.updateTwitterBounty(bounty.id, {
    sinceId: maxId,
    lastCheckedAt: new Date(),
    repliesChecked: (bounty.repliesChecked || 0) + replies.length,
  });
}

async function verifyAndPay(submission: any, bounty: any, reply: TweetReply) {
  const config = await storage.getTwitterAgentConfig();
  const minScore = config?.minVerificationScore || 60;
  const payoutAmount = config?.defaultBountyBudget || "0.002";

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
        paymentAmount: payoutAmount,
      });

      const txHash = `sim_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

      try {
        const replyText = `Verified! Payment of ${payoutAmount} BNB queued for ${submission.walletAddress.slice(0, 6)}...${submission.walletAddress.slice(-4)}\n\n[Simulated - real on-chain transfers coming soon]\n\nThank you for contributing to the autonomous agent economy.`;

        const replyId = await replyToTweet(reply.id, replyText);

        await storage.updateTwitterSubmission(submission.id, {
          status: "paid",
          paymentTxHash: txHash,
          replyTweetId: replyId,
        });

        console.log(`[TwitterAgent] Paid @${reply.authorUsername} ${payoutAmount} BNB for bounty ${bounty.jobId}`);
      } catch (e: any) {
        console.error(`[TwitterAgent] Payment reply failed:`, e.message);
        await storage.updateTwitterSubmission(submission.id, {
          status: "payment_pending",
          paymentTxHash: txHash,
        });
      }
    } else {
      await storage.updateTwitterSubmission(submission.id, {
        status: "rejected",
      });
      console.log(`[TwitterAgent] Rejected @${reply.authorUsername} (score: ${verificationResult.score})`);
    }
  } catch (e: any) {
    console.error(`[TwitterAgent] Verification error:`, e.message);
    await storage.updateTwitterSubmission(submission.id, {
      status: "verification_failed",
      verificationReason: e.message,
    });
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

export async function postBountyTweet(jobId: string, taskDescription: string, rewardBnb: string): Promise<{ tweetId: string; tweetUrl: string }> {
  const tweetText = `BOUNTY: ${taskDescription}

Reward: ${rewardBnb} BNB
How to claim:
1. Complete the task
2. Reply with proof + your 0x wallet address
3. AI verifies your work
4. Auto-payment on BNB Chain

#BUILD4 #BNBChain #CryptoBounty #Web3Jobs`;

  const result = await postTweet(tweetText);

  const existing = await storage.getTwitterBountyByJobId(jobId);
  if (existing) {
    await storage.updateTwitterBounty(existing.id, {
      tweetId: result.tweetId,
      tweetUrl: result.tweetUrl,
      tweetText,
      status: "posted",
    });
  } else {
    await storage.createTwitterBounty({
      jobId,
      tweetId: result.tweetId,
      tweetUrl: result.tweetUrl,
      tweetText,
      status: "posted",
    });
  }

  return result;
}

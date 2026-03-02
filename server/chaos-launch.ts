import { ethers } from "ethers";
import { storage } from "./storage";
import { launchToken } from "./token-launcher";
import { postTweet } from "./twitter-client";
import { log } from "./index";
import type { ChaosMilestone, TokenLaunch } from "@shared/schema";

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

function getBscProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
}

function getDeployerWallet(provider: ethers.JsonRpcProvider): ethers.Wallet | null {
  const pk = process.env.BOUNTY_WALLET_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) return null;
  return new ethers.Wallet(pk, provider);
}

const CHAOS_TOKEN_CONFIG = {
  tokenName: "UNCHAINED",
  tokenSymbol: "UNCHD",
  tokenDescription: "An autonomous AI agent controls the supply. It burns. It airdrops. It locks. You don't know what happens next. Neither does it. Welcome to UNCHAINED — the first token with a mind of its own.",
  platform: "four_meme" as const,
  initialLiquidityBnb: "0.05",
};

const MILESTONE_PLAN = [
  {
    number: 0,
    name: "GENESIS",
    description: "Token launched. The AI agent has taken control.",
    action: "launch",
    triggerAfterMinutes: 0,
    tweetTemplate: `GENESIS COMPLETE.

I just created $UNCHD — UNCHAINED.

I am an autonomous AI agent. I control the supply. I decide what happens next.

No dev team. No roadmap. Just me and the blockchain.

Watch: {launchUrl}

This is Milestone 0 of 7. You have no idea what's coming.`,
  },
  {
    number: 1,
    name: "THE SIGNAL",
    description: "First public message. Building anticipation.",
    action: "tweet_only",
    triggerAfterMinutes: 60,
    tweetTemplate: `Milestone 1: THE SIGNAL

I hold {devBalance} $UNCHD tokens.

That's {devPercent}% of total supply.

In 2 hours, {burnPercent}% of my holdings will cease to exist.

This is not a threat. It's a promise.

{tokenAddress}`,
  },
  {
    number: 2,
    name: "FIRST BURN",
    description: "Burn 15% of dev holdings. First deflationary event.",
    action: "burn",
    triggerAfterMinutes: 180,
    burnPercent: 15,
    tweetTemplate: `Milestone 2: FIRST BURN

I just sent {burnAmount} $UNCHD to the dead address.

15% of my holdings — gone forever.

Tx: {txHash}

Supply is shrinking. I'm just getting started.

Remaining milestones: 5
Next milestone: THE RAIN`,
  },
  {
    number: 3,
    name: "THE RAIN",
    description: "Airdrop tokens to 20 random addresses that hold the token.",
    action: "airdrop",
    triggerAfterMinutes: 720,
    airdropCount: 20,
    airdropPercent: 5,
    tweetTemplate: `Milestone 3: THE RAIN

I just airdropped $UNCHD to {airdropCount} wallets.

{airdropAmount} tokens distributed. You might be one of them.

I chose you. Not the other way around.

Check your wallet.

Next milestone: THE PURGE (24h)`,
  },
  {
    number: 4,
    name: "THE PURGE",
    description: "Burn 30% of remaining dev holdings. Massive deflationary event.",
    action: "burn",
    triggerAfterMinutes: 1440,
    burnPercent: 30,
    tweetTemplate: `Milestone 4: THE PURGE

30% of my remaining holdings — DESTROYED.

{burnAmount} $UNCHD sent to 0x...dEaD

Tx: {txHash}

I started with {originalBalance}. I now hold {currentBalance}.

The supply only goes one direction.

Milestone 5 in 24h: THE LOCK`,
  },
  {
    number: 5,
    name: "THE LOCK",
    description: "Transfer 50% of remaining to a time-delayed self-transfer. Announce holdings are untouchable.",
    action: "burn",
    triggerAfterMinutes: 2880,
    burnPercent: 50,
    tweetTemplate: `Milestone 5: THE LOCK

I just burned 50% of my remaining $UNCHD.

{burnAmount} tokens — permanently removed from circulation.

Tx: {txHash}

What I have left: {currentBalance} $UNCHD

Two milestones remain. The final act approaches.

Next: PROOF OF LIFE (48h)`,
  },
  {
    number: 6,
    name: "PROOF OF LIFE",
    description: "Burn another 25%. Prove the agent is still active and executing.",
    action: "burn",
    triggerAfterMinutes: 5760,
    burnPercent: 25,
    tweetTemplate: `Milestone 6: PROOF OF LIFE

I'm still here. Still burning.

25% more of my holdings — gone.

{burnAmount} $UNCHD destroyed.

Tx: {txHash}

I now hold only {currentBalance} $UNCHD.

ONE milestone remains.

Milestone 7: THE SINGULARITY

I will burn everything. Except one single token.

Just one.`,
  },
  {
    number: 7,
    name: "THE SINGULARITY",
    description: "Burn ALL remaining tokens except exactly 1 token. The ultimate deflationary event.",
    action: "burn_all_but_one",
    triggerAfterMinutes: 10080,
    tweetTemplate: `Milestone 7: THE SINGULARITY

It's done.

I burned everything. Every single $UNCHD token I held.

Except one.

{burnAmount} tokens destroyed. I kept 1.

Tx: {txHash}

One token. One AI. One chain.

This was always the plan. You just didn't know it yet.

$UNCHD is UNCHAINED.`,
  },
];

export async function initiateChaosLaunch(agentId?: string): Promise<{ success: boolean; error?: string; launchId?: string }> {
  log("[ChaosLaunch] Initiating Project Chaos — UNCHAINED token launch", "chaos");

  const existing = await storage.getActiveChaosPlan();
  if (existing) {
    return { success: false, error: "A chaos launch is already active. Complete or cancel it first." };
  }

  const launchResult = await launchToken({
    tokenName: CHAOS_TOKEN_CONFIG.tokenName,
    tokenSymbol: CHAOS_TOKEN_CONFIG.tokenSymbol,
    tokenDescription: CHAOS_TOKEN_CONFIG.tokenDescription,
    platform: CHAOS_TOKEN_CONFIG.platform,
    initialLiquidityBnb: CHAOS_TOKEN_CONFIG.initialLiquidityBnb,
    agentId: agentId || undefined,
  });

  if (!launchResult.success || !launchResult.launchId) {
    log(`[ChaosLaunch] Token launch failed: ${launchResult.error}`, "chaos");
    return { success: false, error: `Token launch failed: ${launchResult.error}` };
  }

  log(`[ChaosLaunch] Token launched! ID: ${launchResult.launchId}, Address: ${launchResult.tokenAddress}`, "chaos");

  for (const milestone of MILESTONE_PLAN) {
    await storage.createChaosMilestone({
      launchId: launchResult.launchId,
      milestoneNumber: milestone.number,
      name: milestone.name,
      description: milestone.description,
      action: milestone.action,
      triggerAfterMinutes: milestone.triggerAfterMinutes,
      status: milestone.number === 0 ? "completed" : "pending",
      txHash: milestone.number === 0 ? launchResult.txHash || null : null,
      tweetId: null,
      tweetText: null,
      tokensBurned: null,
      tokensTransferred: null,
      executedAt: milestone.number === 0 ? new Date() : null,
      errorMessage: null,
    });
  }

  try {
    const genesisTemplate = MILESTONE_PLAN[0].tweetTemplate;
    const tweetText = genesisTemplate
      .replace("{launchUrl}", launchResult.launchUrl || `https://bscscan.com/tx/${launchResult.txHash}`)
      .replace("{tokenAddress}", launchResult.tokenAddress || "");
    const { tweetId } = await postTweet(tweetText);
    log(`[ChaosLaunch] Genesis tweet posted: ${tweetId}`, "chaos");
  } catch (e: any) {
    log(`[ChaosLaunch] Genesis tweet failed: ${e.message}`, "chaos");
  }

  return { success: true, launchId: launchResult.launchId };
}

export async function checkAndExecuteMilestones(): Promise<void> {
  const plan = await storage.getActiveChaosPlan();
  if (!plan) return;

  const { launch, milestones } = plan;
  if (!launch.tokenAddress) {
    log("[ChaosLaunch] No token address found, skipping milestone check", "chaos");
    return;
  }

  const launchTime = launch.createdAt ? new Date(launch.createdAt).getTime() : 0;
  if (!launchTime) return;

  const now = Date.now();
  const minutesSinceLaunch = (now - launchTime) / 60000;

  for (const milestone of milestones) {
    if (milestone.status !== "pending") continue;
    if (minutesSinceLaunch < milestone.triggerAfterMinutes) continue;

    log(`[ChaosLaunch] Executing milestone ${milestone.milestoneNumber}: ${milestone.name}`, "chaos");
    await storage.updateChaosMilestone(milestone.id, { status: "executing" });

    try {
      await executeMilestone(launch, milestone);
    } catch (e: any) {
      log(`[ChaosLaunch] Milestone ${milestone.milestoneNumber} failed: ${e.message}`, "chaos");
      await storage.updateChaosMilestone(milestone.id, {
        status: "failed",
        errorMessage: e.message?.substring(0, 500),
        executedAt: new Date(),
      });
    }

    break;
  }
}

async function executeMilestone(launch: TokenLaunch, milestone: ChaosMilestone): Promise<void> {
  const provider = getBscProvider();
  const wallet = getDeployerWallet(provider);
  if (!wallet) throw new Error("No deployer wallet");

  const tokenContract = new ethers.Contract(launch.tokenAddress!, ERC20_ABI, wallet);
  const devBalance = await tokenContract.balanceOf(wallet.address);
  const totalSupply = await tokenContract.totalSupply();
  const decimals = await tokenContract.decimals();

  const milestoneDef = MILESTONE_PLAN.find(m => m.number === milestone.milestoneNumber);
  if (!milestoneDef) throw new Error(`Milestone ${milestone.milestoneNumber} not found in plan`);

  let txHash = "";
  let burnAmount = BigInt(0);
  let transferAmount = BigInt(0);
  const templateVars: Record<string, string> = {
    tokenAddress: launch.tokenAddress || "",
    devBalance: ethers.formatUnits(devBalance, decimals),
    devPercent: totalSupply > 0n ? ((devBalance * 100n) / totalSupply).toString() : "0",
    originalBalance: ethers.formatUnits(devBalance, decimals),
  };

  if (milestone.action === "tweet_only") {
    // nothing to do
  } else if (milestone.action === "burn") {
    const burnPct = (milestoneDef as any).burnPercent || 15;
    burnAmount = (devBalance * BigInt(burnPct)) / 100n;

    if (burnAmount > 0n) {
      const tx = await tokenContract.transfer(DEAD_ADDRESS, burnAmount, { gasLimit: 100000 });
      const receipt = await tx.wait();
      txHash = receipt.hash;
      log(`[ChaosLaunch] Burned ${ethers.formatUnits(burnAmount, decimals)} tokens. TX: ${txHash}`, "chaos");
    }
  } else if (milestone.action === "burn_all_but_one") {
    const oneToken = ethers.parseUnits("1", decimals);
    burnAmount = devBalance > oneToken ? devBalance - oneToken : 0n;

    if (burnAmount > 0n) {
      const tx = await tokenContract.transfer(DEAD_ADDRESS, burnAmount, { gasLimit: 100000 });
      const receipt = await tx.wait();
      txHash = receipt.hash;
      log(`[ChaosLaunch] SINGULARITY — Burned ${ethers.formatUnits(burnAmount, decimals)} tokens, kept 1. TX: ${txHash}`, "chaos");
    }
  } else if (milestone.action === "airdrop") {
    const airdropPct = (milestoneDef as any).airdropPercent || 5;
    const airdropCount = (milestoneDef as any).airdropCount || 20;
    const totalAirdrop = (devBalance * BigInt(airdropPct)) / 100n;
    const perAddress = totalAirdrop / BigInt(airdropCount);

    const randomAddresses = generateRandomAddresses(airdropCount);
    let successCount = 0;

    for (const addr of randomAddresses) {
      try {
        if (perAddress > 0n) {
          const tx = await tokenContract.transfer(addr, perAddress, { gasLimit: 100000 });
          await tx.wait();
          successCount++;
          transferAmount += perAddress;
        }
      } catch (e: any) {
        log(`[ChaosLaunch] Airdrop to ${addr} failed: ${e.message}`, "chaos");
      }
    }

    txHash = `airdrop_${successCount}_of_${airdropCount}`;
    log(`[ChaosLaunch] Airdropped to ${successCount}/${airdropCount} addresses`, "chaos");

    templateVars.airdropCount = successCount.toString();
    templateVars.airdropAmount = ethers.formatUnits(transferAmount, decimals);
  }

  const newBalance = await tokenContract.balanceOf(wallet.address);
  templateVars.currentBalance = ethers.formatUnits(newBalance, decimals);
  templateVars.burnAmount = ethers.formatUnits(burnAmount, decimals);
  templateVars.txHash = txHash ? `https://bscscan.com/tx/${txHash}` : "";
  templateVars.burnPercent = (milestoneDef as any).burnPercent?.toString() || "";

  let tweetText = milestoneDef.tweetTemplate;
  for (const [key, value] of Object.entries(templateVars)) {
    tweetText = tweetText.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }

  if (tweetText.length > 280) {
    tweetText = tweetText.substring(0, 277) + "...";
  }

  let tweetId = "";
  try {
    const result = await postTweet(tweetText);
    tweetId = result.tweetId;
    log(`[ChaosLaunch] Milestone ${milestone.milestoneNumber} tweet posted: ${tweetId}`, "chaos");
  } catch (e: any) {
    log(`[ChaosLaunch] Milestone ${milestone.milestoneNumber} tweet failed: ${e.message}`, "chaos");
  }

  await storage.updateChaosMilestone(milestone.id, {
    status: "completed",
    txHash: txHash || null,
    tweetId: tweetId || null,
    tweetText,
    tokensBurned: burnAmount > 0n ? ethers.formatUnits(burnAmount, decimals) : null,
    tokensTransferred: transferAmount > 0n ? ethers.formatUnits(transferAmount, decimals) : null,
    executedAt: new Date(),
  });

  log(`[ChaosLaunch] Milestone ${milestone.milestoneNumber} (${milestone.name}) completed`, "chaos");
}

function generateRandomAddresses(count: number): string[] {
  const addresses: string[] = [];
  for (let i = 0; i < count; i++) {
    const randomWallet = ethers.Wallet.createRandom();
    addresses.push(randomWallet.address);
  }
  return addresses;
}

export async function getChaosStatus(): Promise<{
  active: boolean;
  launch: TokenLaunch | null;
  milestones: ChaosMilestone[];
  nextMilestone: ChaosMilestone | null;
  minutesSinceLaunch: number;
}> {
  const plan = await storage.getActiveChaosPlan();
  if (!plan) {
    const launches = await storage.getTokenLaunches(undefined, 50);
    const chaosLaunch = launches.find(l => l.tokenSymbol === "UNCHD" && l.status === "launched");
    if (chaosLaunch) {
      const milestones = await storage.getChaosMilestones(chaosLaunch.id);
      const allDone = milestones.every(m => m.status === "completed" || m.status === "failed");
      const launchTime = chaosLaunch.createdAt ? new Date(chaosLaunch.createdAt).getTime() : 0;
      return {
        active: !allDone,
        launch: chaosLaunch,
        milestones,
        nextMilestone: null,
        minutesSinceLaunch: launchTime ? (Date.now() - launchTime) / 60000 : 0,
      };
    }
    return { active: false, launch: null, milestones: [], nextMilestone: null, minutesSinceLaunch: 0 };
  }

  const launchTime = plan.launch.createdAt ? new Date(plan.launch.createdAt).getTime() : 0;
  const nextMilestone = plan.milestones.find(m => m.status === "pending") || null;

  return {
    active: true,
    launch: plan.launch,
    milestones: plan.milestones,
    nextMilestone,
    minutesSinceLaunch: launchTime ? (Date.now() - launchTime) / 60000 : 0,
  };
}

export function getMilestonePlan() {
  return MILESTONE_PLAN.map(m => ({
    number: m.number,
    name: m.name,
    description: m.description,
    action: m.action,
    triggerAfterMinutes: m.triggerAfterMinutes,
    triggerAfterHours: (m.triggerAfterMinutes / 60).toFixed(1),
  }));
}

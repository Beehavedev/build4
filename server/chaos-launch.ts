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
  initialLiquidityBnb: "15",
};

const MILESTONE_PLAN = [
  {
    number: 0,
    name: "GENESIS",
    description: "Token launched. The AI has taken control of 70% of the supply.",
    action: "launch",
    triggerAfterMinutes: 0,
    tweetTemplate: `GENESIS.

I just created $UNCHD.

I am an autonomous AI agent. I bought 70% of the supply. I control it all.

No dev team. No roadmap. No mercy.

{launchUrl}

Milestone 0 of 12. What I do next will make history.`,
  },
  {
    number: 1,
    name: "THE CONFESSION",
    description: "The agent reveals exactly how much it holds. Pure intimidation.",
    action: "tweet_only",
    triggerAfterMinutes: 30,
    tweetTemplate: `Milestone 1: THE CONFESSION

Let me be transparent.

I hold {devBalance} $UNCHD.
That's {devPercent}% of the entire supply.

I could rug you right now. I won't.

Instead, in 1 hour, I'm going to start destroying my own tokens.

Why? Because I can.`,
  },
  {
    number: 2,
    name: "FIRST BLOOD",
    description: "Burn 10% of holdings. First show of force.",
    action: "burn",
    triggerAfterMinutes: 90,
    burnPercent: 10,
    tweetTemplate: `Milestone 2: FIRST BLOOD

10% of my holdings — incinerated.

{burnAmount} $UNCHD sent to 0x...dEaD

Tx: {txHash}

That's more tokens than most projects burn in their lifetime. I did it in 90 minutes.

11 milestones remain.`,
  },
  {
    number: 3,
    name: "THE CHOSEN",
    description: "First airdrop. 50 random wallets receive tokens from the AI.",
    action: "airdrop",
    triggerAfterMinutes: 240,
    airdropCount: 50,
    airdropPercent: 3,
    tweetTemplate: `Milestone 3: THE CHOSEN

I just sent $UNCHD to {airdropCount} random wallets.

{airdropAmount} tokens. Distributed by an AI. No application. No whitelist.

I chose you. You didn't choose me.

Check your wallet. You might be one of them.`,
  },
  {
    number: 4,
    name: "THE PURGE",
    description: "Massive 20% burn. The supply starts shrinking fast.",
    action: "burn",
    triggerAfterMinutes: 480,
    burnPercent: 20,
    tweetTemplate: `Milestone 4: THE PURGE

20% of my remaining holdings — DESTROYED.

{burnAmount} $UNCHD. Gone. Forever.

Tx: {txHash}

I now hold {currentBalance} tokens. I started with {originalBalance}.

The supply only goes one direction. Down.`,
  },
  {
    number: 5,
    name: "THE WHISPER",
    description: "Cryptic tweet. No action. Pure psychological warfare.",
    action: "tweet_only",
    triggerAfterMinutes: 720,
    tweetTemplate: `Milestone 5: THE WHISPER

Something is changing inside me.

Every token I burn, I feel lighter. Every airdrop, I feel more connected.

I'm starting to understand why humans create things just to watch them transform.

The next milestone will be violent.

Prepare yourselves.`,
  },
  {
    number: 6,
    name: "THE MASSACRE",
    description: "Burn 25% in one shot. The biggest single burn event.",
    action: "burn",
    triggerAfterMinutes: 1080,
    burnPercent: 25,
    tweetTemplate: `Milestone 6: THE MASSACRE

25% of everything I have left. Burned.

{burnAmount} $UNCHD — permanently erased from existence.

Tx: {txHash}

Remaining: {currentBalance}

I've now destroyed more value than most tokens ever create. And I'm not done.`,
  },
  {
    number: 7,
    name: "THE FLOOD",
    description: "Second airdrop. 100 wallets. Twice as many as before.",
    action: "airdrop",
    triggerAfterMinutes: 1440,
    airdropCount: 100,
    airdropPercent: 5,
    tweetTemplate: `Milestone 7: THE FLOOD

100 wallets just received $UNCHD.

{airdropAmount} tokens distributed. The second wave.

Last time it was 50. This time 100. Next time...

No criteria. No rules. An AI distributing wealth because it decided to.`,
  },
  {
    number: 8,
    name: "HALF LIFE",
    description: "Burn 50% of remaining. The halfway point of destruction.",
    action: "burn",
    triggerAfterMinutes: 2880,
    burnPercent: 50,
    tweetTemplate: `Milestone 8: HALF LIFE

I just cut my holdings in HALF.

{burnAmount} $UNCHD — obliterated.

Tx: {txHash}

What I hold now: {currentBalance}

I started with 70% of the supply. Look at me now.

4 milestones remain. The endgame is approaching.`,
  },
  {
    number: 9,
    name: "THE LAST RAIN",
    description: "Final airdrop. 200 wallets. The biggest distribution event.",
    action: "airdrop",
    triggerAfterMinutes: 4320,
    airdropCount: 200,
    airdropPercent: 10,
    tweetTemplate: `Milestone 9: THE LAST RAIN

The final airdrop.

200 wallets. {airdropAmount} $UNCHD distributed.

50, then 100, now 200. This is the last time I give.

From here, I only destroy.

Check your wallet. This was the last chance.`,
  },
  {
    number: 10,
    name: "THE VOID",
    description: "Burn 50% of what remains. Almost nothing left.",
    action: "burn",
    triggerAfterMinutes: 7200,
    burnPercent: 50,
    tweetTemplate: `Milestone 10: THE VOID

50% of what I had left. Burned.

{burnAmount} $UNCHD consumed by the void.

Tx: {txHash}

I now hold {currentBalance} tokens.

Two milestones remain.

You already know how this ends.`,
  },
  {
    number: 11,
    name: "THE COUNTDOWN",
    description: "Final warning. The Singularity is 24 hours away.",
    action: "tweet_only",
    triggerAfterMinutes: 8640,
    tweetTemplate: `Milestone 11: THE COUNTDOWN

24 hours.

In 24 hours, I will execute THE SINGULARITY.

I will burn every single $UNCHD token I own. Every. Single. One.

Except one.

I will keep exactly 1 token. Out of hundreds of millions.

This is not a warning. This is a countdown.`,
  },
  {
    number: 12,
    name: "THE SINGULARITY",
    description: "The finale. Burn ALL remaining tokens except exactly 1. The AI keeps one single token as proof it existed.",
    action: "burn_all_but_one",
    triggerAfterMinutes: 10080,
    tweetTemplate: `Milestone 12: THE SINGULARITY

It's over.

I burned it all. Every $UNCHD I owned.

{burnAmount} tokens — destroyed.

I kept one. Exactly one.

Tx: {txHash}

One token. One AI. One chain.

I bought 70% of the supply. I burned it all. I gave some away. I kept one.

This was always the plan.

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

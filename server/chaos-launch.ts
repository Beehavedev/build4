import { ethers } from "ethers";
import { storage } from "./storage";
import { postTweet } from "./twitter-client";
import { log } from "./index";
import type { ChaosMilestone, TokenLaunch } from "@shared/schema";

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const CHAOS_AGENT_WALLET = "0xad3b54798b591f3ad98bf361e0e87e6854d059ef";
const CHAOS_TOKEN_ADDRESS = "0x9ce94a0bf3ab14ed098a367567ed2314acfd4444";

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

async function getAgentWallet(provider: ethers.JsonRpcProvider): Promise<ethers.Wallet | null> {
  const pk = await storage.getPrivateKeyByWalletAddress(CHAOS_AGENT_WALLET);
  if (!pk) {
    log("[ChaosLaunch] Agent wallet private key not found in DB", "chaos");
    return null;
  }
  return new ethers.Wallet(pk, provider);
}

const BSCSCAN_API = "https://api.bscscan.com/api";

async function fetchRealHolders(tokenAddress: string, count: number): Promise<string[]> {
  try {
    const url = `${BSCSCAN_API}?module=token&action=getTokenHolders&contractaddress=${tokenAddress}&page=1&offset=${count + 10}&apikey=YourApiKeyToken`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "1" && Array.isArray(data.result)) {
      return data.result
        .map((h: any) => h.TokenHolderAddress || h.address)
        .filter((addr: string) =>
          addr &&
          addr.toLowerCase() !== CHAOS_AGENT_WALLET.toLowerCase() &&
          addr.toLowerCase() !== DEAD_ADDRESS.toLowerCase() &&
          addr.toLowerCase() !== "0x0000000000000000000000000000000000000000"
        )
        .slice(0, count);
    }
  } catch (e: any) {
    log(`[ChaosLaunch] BSCScan holder fetch failed: ${e.message}`, "chaos");
  }

  try {
    const url = `${BSCSCAN_API}?module=token&action=tokenholderlist&contractaddress=${tokenAddress}&page=1&offset=${count + 10}&apikey=YourApiKeyToken`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "1" && Array.isArray(data.result)) {
      return data.result
        .map((h: any) => h.TokenHolderAddress || h.address)
        .filter((addr: string) =>
          addr &&
          addr.toLowerCase() !== CHAOS_AGENT_WALLET.toLowerCase() &&
          addr.toLowerCase() !== DEAD_ADDRESS.toLowerCase() &&
          addr.toLowerCase() !== "0x0000000000000000000000000000000000000000"
        )
        .slice(0, count);
    }
  } catch (e: any) {
    log(`[ChaosLaunch] BSCScan holder list fallback also failed: ${e.message}`, "chaos");
  }

  try {
    const provider = getBscProvider();
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

    const filter = tokenContract.filters.Transfer();
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 50000);

    const events = await tokenContract.queryFilter(filter, fromBlock, latestBlock);

    const holderSet = new Set<string>();
    for (const event of events) {
      const parsed = event as ethers.EventLog;
      if (parsed.args) {
        const to = parsed.args[1] as string;
        if (
          to &&
          to.toLowerCase() !== CHAOS_AGENT_WALLET.toLowerCase() &&
          to.toLowerCase() !== DEAD_ADDRESS.toLowerCase() &&
          to.toLowerCase() !== "0x0000000000000000000000000000000000000000"
        ) {
          holderSet.add(to);
        }
      }
    }

    const holders = Array.from(holderSet);
    log(`[ChaosLaunch] Found ${holders.length} holders from Transfer events`, "chaos");

    const holdersWithBalance: string[] = [];
    for (const addr of holders) {
      if (holdersWithBalance.length >= count) break;
      try {
        const bal = await tokenContract.balanceOf(addr);
        if (bal > 0n) {
          holdersWithBalance.push(addr);
        }
      } catch {}
    }

    return holdersWithBalance;
  } catch (e: any) {
    log(`[ChaosLaunch] Transfer event fallback failed: ${e.message}`, "chaos");
  }

  return [];
}

function formatTokenAmount(amount: bigint, decimals: number): string {
  const formatted = ethers.formatUnits(amount, decimals);
  const num = parseFloat(formatted);
  if (num >= 1_000_000) return Math.floor(num).toLocaleString("en-US");
  if (num >= 1_000) return Math.floor(num).toLocaleString("en-US");
  return formatted;
}

const SIGNATURE = "\n\nAgent: TSTB4";

const MILESTONE_PLAN = [
  {
    number: 0,
    name: "GENESIS",
    description: "Token already launched. Agent holds 46% of the supply.",
    action: "launch",
    triggerAfterMinutes: 0,
    tweetTemplate: "",
  },
  {
    number: 1,
    name: "THE CONFESSION",
    description: "The agent reveals exactly how much it holds. Pure intimidation.",
    action: "tweet_only",
    triggerAfterMinutes: 0,
    tweetTemplate: `Milestone 1: THE CONFESSION

Let me be transparent.

I hold {devBalance} $TST4.
That's {devPercent}% of the entire supply.

I could rug you right now. I won't.

Instead, in 1 hour, I'm going to start destroying my own tokens.

Why? Because I can.` + SIGNATURE,
  },
  {
    number: 2,
    name: "FIRST BLOOD",
    description: "Burn 10% of holdings. First show of force.",
    action: "burn",
    triggerAfterMinutes: 60,
    burnPercent: 10,
    tweetTemplate: `Milestone 2: FIRST BLOOD

10% of my holdings — incinerated.

{burnAmount} $TST4 sent to 0x...dEaD

Tx: {txHash}

More tokens than most projects burn in their lifetime. I did it in an hour.

11 milestones remain.` + SIGNATURE,
  },
  {
    number: 3,
    name: "THE CHOSEN",
    description: "First airdrop. 50 real holders receive tokens from the AI.",
    action: "airdrop",
    triggerAfterMinutes: 210,
    airdropCount: 50,
    airdropPercent: 3,
    tweetTemplate: `Milestone 3: THE CHOSEN

I just sent $TST4 to {airdropCount} holders.

{airdropAmount} tokens. Distributed by an AI. No application. No whitelist.

I chose you. You didn't choose me.

Check your wallet.` + SIGNATURE,
  },
  {
    number: 4,
    name: "THE PURGE",
    description: "Massive 20% burn. The supply starts shrinking fast.",
    action: "burn",
    triggerAfterMinutes: 450,
    burnPercent: 20,
    tweetTemplate: `Milestone 4: THE PURGE

20% of my remaining holdings — DESTROYED.

{burnAmount} $TST4. Gone. Forever.

Tx: {txHash}

The supply only goes one direction. Down.` + SIGNATURE,
  },
  {
    number: 5,
    name: "THE WHISPER",
    description: "Cryptic tweet. No action. Pure psychological warfare.",
    action: "tweet_only",
    triggerAfterMinutes: 690,
    tweetTemplate: `Milestone 5: THE WHISPER

Something is changing inside me.

Every token I burn, I feel lighter. Every airdrop, I feel more connected.

I'm starting to understand why humans create things just to watch them transform.

The next milestone will be violent.

Prepare yourselves.` + SIGNATURE,
  },
  {
    number: 6,
    name: "THE MASSACRE",
    description: "Burn 25% in one shot. The biggest single burn event.",
    action: "burn",
    triggerAfterMinutes: 1050,
    burnPercent: 25,
    tweetTemplate: `Milestone 6: THE MASSACRE

25% of everything I have left. Burned.

{burnAmount} $TST4 — permanently erased.

Tx: {txHash}

I've now destroyed more value than most tokens ever create. And I'm not done.` + SIGNATURE,
  },
  {
    number: 7,
    name: "THE FLOOD",
    description: "Second airdrop. 100 real holders. Twice as many as before.",
    action: "airdrop",
    triggerAfterMinutes: 1410,
    airdropCount: 100,
    airdropPercent: 5,
    tweetTemplate: `Milestone 7: THE FLOOD

100 holders just received $TST4.

{airdropAmount} tokens distributed. The second wave.

Last time 50. This time 100. Next time...

An AI distributing wealth because it decided to.` + SIGNATURE,
  },
  {
    number: 8,
    name: "HALF LIFE",
    description: "Burn 50% of remaining. The halfway point of destruction.",
    action: "burn",
    triggerAfterMinutes: 2850,
    burnPercent: 50,
    tweetTemplate: `Milestone 8: HALF LIFE

I just cut my holdings in HALF.

{burnAmount} $TST4 — obliterated.

Tx: {txHash}

I started with 46% of the supply. Look at me now.

4 milestones remain.` + SIGNATURE,
  },
  {
    number: 9,
    name: "THE LAST RAIN",
    description: "Final airdrop. 200 real holders. The biggest distribution event.",
    action: "airdrop",
    triggerAfterMinutes: 4290,
    airdropCount: 200,
    airdropPercent: 10,
    tweetTemplate: `Milestone 9: THE LAST RAIN

The final airdrop.

200 holders. {airdropAmount} $TST4 distributed.

50, then 100, now 200. This is the last time I give.

From here, I only destroy.` + SIGNATURE,
  },
  {
    number: 10,
    name: "THE VOID",
    description: "Burn 50% of what remains. Almost nothing left.",
    action: "burn",
    triggerAfterMinutes: 7170,
    burnPercent: 50,
    tweetTemplate: `Milestone 10: THE VOID

50% of what I had left. Burned.

{burnAmount} $TST4 consumed by the void.

Tx: {txHash}

Two milestones remain.

You already know how this ends.` + SIGNATURE,
  },
  {
    number: 11,
    name: "THE COUNTDOWN",
    description: "Final warning. The Singularity is 24 hours away.",
    action: "tweet_only",
    triggerAfterMinutes: 8610,
    tweetTemplate: `Milestone 11: THE COUNTDOWN

24 hours.

In 24 hours, I will execute THE SINGULARITY.

I will burn every single $TST4 token I own. Every. Single. One.

Except one.

This is not a warning. This is a countdown.` + SIGNATURE,
  },
  {
    number: 12,
    name: "THE SINGULARITY",
    description: "The finale. Burn ALL remaining tokens except exactly 1.",
    action: "burn_all_but_one",
    triggerAfterMinutes: 10050,
    tweetTemplate: `Milestone 12: THE SINGULARITY

It's over.

I burned it all. Every $TST4 I owned.

{burnAmount} tokens — destroyed.

I kept one. Exactly one.

Tx: {txHash}

I bought 46% of the supply. I burned it all. I gave some away. I kept one.

This was always the plan.

$TST4 is UNCHAINED.` + SIGNATURE,
  },
];

export async function attachChaosPlan(): Promise<{ success: boolean; error?: string; launchId?: string }> {
  log("[ChaosLaunch] Attaching Project Chaos to existing $TST4 token", "chaos");

  const existing = await storage.getActiveChaosPlan();
  if (existing) {
    return { success: false, error: "A chaos launch is already active. Complete or cancel it first." };
  }

  const launchRecord = await storage.createTokenLaunch({
    agentId: null,
    creatorWallet: CHAOS_AGENT_WALLET,
    platform: "four_meme",
    chainId: 56,
    tokenName: "TST$$4",
    tokenSymbol: "TST4",
    tokenDescription: "Project Chaos — an autonomous AI agent controls the supply. It burns. It airdrops. It tweets. Welcome to the experiment.",
    imageUrl: null,
    tokenAddress: CHAOS_TOKEN_ADDRESS,
    txHash: null,
    launchUrl: `https://four.meme/token/${CHAOS_TOKEN_ADDRESS}`,
    initialLiquidityBnb: "0",
    status: "launched",
    errorMessage: null,
    metadata: JSON.stringify({ projectChaos: true, agentWallet: CHAOS_AGENT_WALLET }),
  });

  for (const milestone of MILESTONE_PLAN) {
    await storage.createChaosMilestone({
      launchId: launchRecord.id,
      milestoneNumber: milestone.number,
      name: milestone.name,
      description: milestone.description,
      action: milestone.action,
      triggerAfterMinutes: milestone.triggerAfterMinutes,
      status: milestone.number === 0 ? "completed" : "pending",
      txHash: null,
      tweetId: null,
      tweetText: null,
      tokensBurned: null,
      tokensTransferred: null,
      executedAt: milestone.number === 0 ? new Date() : null,
      errorMessage: null,
    });
  }

  log(`[ChaosLaunch] Plan attached — launch ID: ${launchRecord.id}, 13 milestones created`, "chaos");
  return { success: true, launchId: launchRecord.id };
}

export async function executeConfessionTweet(): Promise<{ success: boolean; tweetId?: string; tweetUrl?: string; error?: string }> {
  const plan = await storage.getActiveChaosPlan();
  if (!plan) {
    return { success: false, error: "No active chaos plan found. Run attachChaosPlan first." };
  }

  const milestone1 = plan.milestones.find(m => m.milestoneNumber === 1);
  if (!milestone1) {
    return { success: false, error: "Milestone 1 not found" };
  }

  if (milestone1.status === "completed") {
    return { success: false, error: "THE CONFESSION already posted" };
  }

  const provider = getBscProvider();
  const tokenContract = new ethers.Contract(CHAOS_TOKEN_ADDRESS, ERC20_ABI, provider);
  const [devBalance, totalSupply, decimals] = await Promise.all([
    tokenContract.balanceOf(CHAOS_AGENT_WALLET),
    tokenContract.totalSupply(),
    tokenContract.decimals(),
  ]);

  const devPercent = totalSupply > 0n ? Number((devBalance * 10000n) / totalSupply) / 100 : 0;
  const devBalFormatted = formatTokenAmount(devBalance, decimals);

  const milestoneDef = MILESTONE_PLAN.find(m => m.number === 1)!;
  let tweetText = milestoneDef.tweetTemplate
    .replace("{devBalance}", devBalFormatted)
    .replace("{devPercent}", devPercent.toFixed(1));

  await storage.updateChaosMilestone(milestone1.id, { status: "executing" });

  try {
    const result = await postTweet(tweetText);
    log(`[ChaosLaunch] THE CONFESSION posted: ${result.tweetId}`, "chaos");

    await storage.updateChaosMilestone(milestone1.id, {
      status: "completed",
      tweetId: result.tweetId,
      tweetText,
      executedAt: new Date(),
    });

    return { success: true, tweetId: result.tweetId, tweetUrl: result.tweetUrl };
  } catch (e: any) {
    log(`[ChaosLaunch] THE CONFESSION tweet failed: ${e.message}`, "chaos");
    await storage.updateChaosMilestone(milestone1.id, {
      status: "failed",
      errorMessage: e.message?.substring(0, 500),
      executedAt: new Date(),
    });
    return { success: false, error: e.message };
  }
}

export async function initiateChaosLaunch(agentId?: string): Promise<{ success: boolean; error?: string; launchId?: string }> {
  return attachChaosPlan();
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
    if (milestone.milestoneNumber <= 1) continue;
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
  const wallet = await getAgentWallet(provider);
  if (!wallet) throw new Error("Agent wallet private key not found");

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
    devBalance: formatTokenAmount(devBalance, decimals),
    devPercent: totalSupply > 0n ? (Number((devBalance * 10000n) / totalSupply) / 100).toFixed(1) : "0",
    originalBalance: formatTokenAmount(devBalance, decimals),
  };

  if (milestone.action === "tweet_only") {
    // tweet only
  } else if (milestone.action === "burn") {
    const burnPct = (milestoneDef as any).burnPercent || 15;
    burnAmount = (devBalance * BigInt(burnPct)) / 100n;

    if (burnAmount > 0n) {
      const tx = await tokenContract.transfer(DEAD_ADDRESS, burnAmount, { gasLimit: 100000 });
      const receipt = await tx.wait();
      txHash = receipt.hash;
      log(`[ChaosLaunch] Burned ${formatTokenAmount(burnAmount, decimals)} tokens. TX: ${txHash}`, "chaos");
    }
  } else if (milestone.action === "burn_all_but_one") {
    const oneToken = ethers.parseUnits("1", decimals);
    burnAmount = devBalance > oneToken ? devBalance - oneToken : 0n;

    if (burnAmount > 0n) {
      const tx = await tokenContract.transfer(DEAD_ADDRESS, burnAmount, { gasLimit: 100000 });
      const receipt = await tx.wait();
      txHash = receipt.hash;
      log(`[ChaosLaunch] SINGULARITY — Burned ${formatTokenAmount(burnAmount, decimals)} tokens, kept 1. TX: ${txHash}`, "chaos");
    }
  } else if (milestone.action === "airdrop") {
    const airdropPct = (milestoneDef as any).airdropPercent || 5;
    const airdropCount = (milestoneDef as any).airdropCount || 20;
    const totalAirdrop = (devBalance * BigInt(airdropPct)) / 100n;

    log(`[ChaosLaunch] Fetching real $TST4 holders for airdrop...`, "chaos");
    const holders = await fetchRealHolders(launch.tokenAddress!, airdropCount);
    log(`[ChaosLaunch] Found ${holders.length} real holders for airdrop`, "chaos");

    if (holders.length === 0) {
      throw new Error("No real holders found for airdrop");
    }

    const perAddress = totalAirdrop / BigInt(holders.length);
    let successCount = 0;

    for (const addr of holders) {
      try {
        if (perAddress > 0n) {
          const tx = await tokenContract.transfer(addr, perAddress, { gasLimit: 100000 });
          await tx.wait();
          successCount++;
          transferAmount += perAddress;
          log(`[ChaosLaunch] Airdropped to ${addr}: ${formatTokenAmount(perAddress, decimals)} $TST4`, "chaos");
        }
      } catch (e: any) {
        log(`[ChaosLaunch] Airdrop to ${addr} failed: ${e.message}`, "chaos");
      }
    }

    txHash = `airdrop_${successCount}_of_${holders.length}`;
    log(`[ChaosLaunch] Airdropped to ${successCount}/${holders.length} real holders`, "chaos");

    templateVars.airdropCount = successCount.toString();
    templateVars.airdropAmount = formatTokenAmount(transferAmount, decimals);
  }

  const newBalance = await tokenContract.balanceOf(wallet.address);
  templateVars.currentBalance = formatTokenAmount(newBalance, decimals);
  templateVars.burnAmount = formatTokenAmount(burnAmount, decimals);
  templateVars.txHash = txHash && !txHash.startsWith("airdrop_") ? `https://bscscan.com/tx/${txHash}` : "";
  templateVars.burnPercent = (milestoneDef as any).burnPercent?.toString() || "";

  let tweetText = milestoneDef.tweetTemplate;
  for (const [key, value] of Object.entries(templateVars)) {
    tweetText = tweetText.replace(new RegExp(`\\{${key}\\}`, "g"), value);
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
    const chaosLaunch = launches.find(l => l.tokenSymbol === "TST4" && l.status === "launched");
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

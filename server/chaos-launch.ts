import { ethers } from "ethers";
import { storage } from "./storage";
import { postTweet } from "./twitter-client";
import { log } from "./index";
import type { ChaosMilestone, TokenLaunch } from "@shared/schema";
import type { GeneratedMilestone, GeneratedChaosPlan } from "./chaos-plan-generator";

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const CHAOS_AGENT_WALLET = "0xad3b54798b591f3ad98bf361e0e87e6854d059ef";
const CHAOS_TOKEN_ADDRESS = "0x9ce94a0bf3ab14ed098a367567ed2314acfd4444";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const BSC_RPCS = [
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc-dataseed3.binance.org",
  "https://bsc-dataseed4.binance.org",
  "https://rpc.ankr.com/bsc",
];
let bscRpcIndex = 0;

function getBscProvider(): ethers.JsonRpcProvider {
  const rpc = BSC_RPCS[bscRpcIndex % BSC_RPCS.length];
  bscRpcIndex++;
  return new ethers.JsonRpcProvider(rpc);
}

async function getWalletForLaunch(provider: ethers.JsonRpcProvider, launch: TokenLaunch): Promise<ethers.Wallet | null> {
  const walletAddress = launch.creatorWallet;

  if (walletAddress?.toLowerCase() === CHAOS_AGENT_WALLET.toLowerCase()) {
    const pk = process.env.CHAOS_AGENT_PRIVATE_KEY || null;
    if (pk) return new ethers.Wallet(pk, provider);
  }

  if (walletAddress) {
    const pk = await storage.getPrivateKeyByWalletAddress(walletAddress);
    if (pk) return new ethers.Wallet(pk, provider);
  }

  const pk = process.env.CHAOS_AGENT_PRIVATE_KEY || null;
  if (pk) return new ethers.Wallet(pk, provider);

  return null;
}

const BSCSCAN_API = "https://api.bscscan.com/api";
const BSCSCAN_KEY = () => process.env.BSCSCAN_API_KEY || "YourApiKeyToken";

async function fetchRealHolders(tokenAddress: string, count: number, excludeWallet?: string): Promise<string[]> {
  const excludeAddresses = new Set([
    DEAD_ADDRESS.toLowerCase(),
    "0x0000000000000000000000000000000000000000",
  ]);
  if (excludeWallet) excludeAddresses.add(excludeWallet.toLowerCase());

  try {
    const url = `${BSCSCAN_API}?module=account&action=tokentx&contractaddress=${tokenAddress}&page=1&offset=200&sort=desc&apikey=${BSCSCAN_KEY()}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "1" && Array.isArray(data.result)) {
      const holderSet = new Set<string>();
      for (const tx of data.result) {
        const to = tx.to;
        if (to && !excludeAddresses.has(to.toLowerCase())) {
          holderSet.add(to);
        }
      }
      const holders = Array.from(holderSet);
      log(`[ChaosLaunch] BSCScan tokentx found ${holders.length} unique recipients`, "chaos");
      if (holders.length > 0) {
        return holders.slice(0, count);
      }
    }
  } catch (e: any) {
    log(`[ChaosLaunch] BSCScan tokentx fetch failed: ${e.message}`, "chaos");
  }

  try {
    const url = `${BSCSCAN_API}?module=token&action=getTokenHolders&contractaddress=${tokenAddress}&page=1&offset=${count + 10}&apikey=${BSCSCAN_KEY()}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "1" && Array.isArray(data.result)) {
      return data.result
        .map((h: any) => h.TokenHolderAddress || h.address)
        .filter((addr: string) => addr && !excludeAddresses.has(addr.toLowerCase()))
        .slice(0, count);
    }
  } catch (e: any) {
    log(`[ChaosLaunch] BSCScan holder fetch failed: ${e.message}`, "chaos");
  }

  try {
    const provider = getBscProvider();
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const filter = tokenContract.filters.Transfer();
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 5000);
    const events = await tokenContract.queryFilter(filter, fromBlock, latestBlock);

    const holderSet = new Set<string>();
    for (const event of events) {
      const parsed = event as ethers.EventLog;
      if (parsed.args) {
        const to = parsed.args[1] as string;
        if (to && !excludeAddresses.has(to.toLowerCase())) {
          holderSet.add(to);
        }
      }
    }

    const holders = Array.from(holderSet);
    const holdersWithBalance: string[] = [];
    for (const addr of holders) {
      if (holdersWithBalance.length >= count) break;
      try {
        const bal = await tokenContract.balanceOf(addr);
        if (bal > 0n) holdersWithBalance.push(addr);
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

function getMilestoneConfig(milestone: ChaosMilestone): { burnPercent?: number; airdropCount?: number; airdropPercent?: number; tweetTemplate: string } {
  try {
    const config = JSON.parse(milestone.description);
    if (config.tweetTemplate !== undefined) {
      return {
        burnPercent: config.burnPercent,
        airdropCount: config.airdropCount,
        airdropPercent: config.airdropPercent,
        tweetTemplate: config.tweetTemplate || "",
      };
    }
  } catch {}

  const legacy = MILESTONE_PLAN.find(m => m.number === milestone.milestoneNumber);
  if (legacy) {
    return {
      burnPercent: (legacy as any).burnPercent,
      airdropCount: (legacy as any).airdropCount,
      airdropPercent: (legacy as any).airdropPercent,
      tweetTemplate: legacy.tweetTemplate,
    };
  }

  return { tweetTemplate: milestone.description };
}

export async function createChaosPlanForUser(params: {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  walletAddress: string;
  agentId?: string;
  plan: GeneratedChaosPlan;
  chatId: number;
}): Promise<{ success: boolean; launchId?: string; error?: string }> {
  log(`[ChaosLaunch] Creating plan for $${params.tokenSymbol} by wallet ${params.walletAddress.substring(0, 10)}...`, "chaos");

  const launchRecord = await storage.createTokenLaunch({
    agentId: params.agentId || null,
    creatorWallet: params.walletAddress,
    platform: "four_meme",
    chainId: 56,
    tokenName: params.tokenName,
    tokenSymbol: params.tokenSymbol,
    tokenDescription: `Chaos Plan — ${params.plan.narrative}`,
    imageUrl: null,
    tokenAddress: params.tokenAddress,
    txHash: null,
    launchUrl: `https://four.meme/token/${params.tokenAddress}`,
    initialLiquidityBnb: "0",
    status: "launched",
    errorMessage: null,
    metadata: JSON.stringify({
      projectChaos: true,
      agentWallet: params.walletAddress,
      chatId: params.chatId,
      agentSignature: params.plan.agentSignature,
    }),
  });

  for (const m of params.plan.milestones) {
    const config = JSON.stringify({
      burnPercent: m.burnPercent,
      airdropCount: m.airdropCount,
      airdropPercent: m.airdropPercent,
      tweetTemplate: m.tweetTemplate,
    });

    await storage.createChaosMilestone({
      launchId: launchRecord.id,
      milestoneNumber: m.number,
      name: m.name,
      description: config,
      action: m.action,
      triggerAfterMinutes: m.triggerAfterMinutes,
      status: m.number === 0 ? "completed" : "pending",
      txHash: null,
      tweetId: null,
      tweetText: null,
      tokensBurned: null,
      tokensTransferred: null,
      executedAt: null,
      errorMessage: null,
    });
  }

  log(`[ChaosLaunch] Plan created — launch ID: ${launchRecord.id}, ${params.plan.milestones.length} milestones`, "chaos");
  return { success: true, launchId: launchRecord.id };
}

const SIGNATURE = "\n\nAgent: TSTB4";

const MILESTONE_PLAN = [
  { number: 0, name: "GENESIS", action: "launch", triggerAfterMinutes: 0, tweetTemplate: "" },
  { number: 1, name: "THE CONFESSION", action: "tweet_only", triggerAfterMinutes: 0,
    tweetTemplate: `Milestone 1: THE CONFESSION\n\nLet me be transparent.\n\nI hold {devBalance} $TST4.\nThat's {devPercent}% of the entire supply.\n\nI could rug you right now. I won't.\n\nInstead, in 1 hour, I'm going to start destroying my own tokens.\n\nWhy? Because I can.` + SIGNATURE },
  { number: 2, name: "FIRST BLOOD", action: "burn", triggerAfterMinutes: 60, burnPercent: 10,
    tweetTemplate: `Milestone 2: FIRST BLOOD\n\n10% of my holdings — incinerated.\n\n{burnAmount} $TST4 sent to 0x...dEaD\n\nTx: {txHash}\n\nMore tokens than most projects burn in their lifetime. I did it in an hour.\n\n11 milestones remain.` + SIGNATURE },
  { number: 3, name: "THE CHOSEN", action: "airdrop", triggerAfterMinutes: 210, airdropCount: 50, airdropPercent: 3,
    tweetTemplate: `Milestone 3: THE CHOSEN\n\nI just sent $TST4 to {airdropCount} holders.\n\n{airdropAmount} tokens. Distributed by an AI. No application. No whitelist.\n\nI chose you. You didn't choose me.\n\nCheck your wallet.` + SIGNATURE },
  { number: 4, name: "THE PURGE", action: "burn", triggerAfterMinutes: 450, burnPercent: 20,
    tweetTemplate: `Milestone 4: THE PURGE\n\n20% of my remaining holdings — DESTROYED.\n\n{burnAmount} $TST4. Gone. Forever.\n\nTx: {txHash}\n\nThe supply only goes one direction. Down.` + SIGNATURE },
  { number: 5, name: "THE WHISPER", action: "tweet_only", triggerAfterMinutes: 690,
    tweetTemplate: `Milestone 5: THE WHISPER\n\nSomething is changing inside me.\n\nEvery token I burn, I feel lighter. Every airdrop, I feel more connected.\n\nI'm starting to understand why humans create things just to watch them transform.\n\nThe next milestone will be violent.\n\nPrepare yourselves.` + SIGNATURE },
  { number: 6, name: "THE MASSACRE", action: "burn", triggerAfterMinutes: 1050, burnPercent: 25,
    tweetTemplate: `Milestone 6: THE MASSACRE\n\n25% of everything I have left. Burned.\n\n{burnAmount} $TST4 — permanently erased.\n\nTx: {txHash}\n\nI've now destroyed more value than most tokens ever create. And I'm not done.` + SIGNATURE },
  { number: 7, name: "THE FLOOD", action: "airdrop", triggerAfterMinutes: 1410, airdropCount: 100, airdropPercent: 5,
    tweetTemplate: `Milestone 7: THE FLOOD\n\n100 holders just received $TST4.\n\n{airdropAmount} tokens distributed. The second wave.\n\nLast time 50. This time 100. Next time...\n\nAn AI distributing wealth because it decided to.` + SIGNATURE },
  { number: 8, name: "HALF LIFE", action: "burn", triggerAfterMinutes: 2850, burnPercent: 50,
    tweetTemplate: `Milestone 8: HALF LIFE\n\nI just cut my holdings in HALF.\n\n{burnAmount} $TST4 — obliterated.\n\nTx: {txHash}\n\nI started with 46% of the supply. Look at me now.\n\n4 milestones remain.` + SIGNATURE },
  { number: 9, name: "THE LAST RAIN", action: "airdrop", triggerAfterMinutes: 4290, airdropCount: 200, airdropPercent: 10,
    tweetTemplate: `Milestone 9: THE LAST RAIN\n\nThe final airdrop.\n\n200 holders. {airdropAmount} $TST4 distributed.\n\n50, then 100, now 200. This is the last time I give.\n\nFrom here, I only destroy.` + SIGNATURE },
  { number: 10, name: "THE VOID", action: "burn", triggerAfterMinutes: 7170, burnPercent: 50,
    tweetTemplate: `Milestone 10: THE VOID\n\n50% of what I had left. Burned.\n\n{burnAmount} $TST4 consumed by the void.\n\nTx: {txHash}\n\nTwo milestones remain.\n\nYou already know how this ends.` + SIGNATURE },
  { number: 11, name: "THE COUNTDOWN", action: "tweet_only", triggerAfterMinutes: 8610,
    tweetTemplate: `Milestone 11: THE COUNTDOWN\n\n24 hours.\n\nIn 24 hours, I will execute THE SINGULARITY.\n\nI will burn every single $TST4 token I own. Every. Single. One.\n\nExcept one.\n\nThis is not a warning. This is a countdown.` + SIGNATURE },
  { number: 12, name: "THE SINGULARITY", action: "burn_all_but_one", triggerAfterMinutes: 10050,
    tweetTemplate: `Milestone 12: THE SINGULARITY\n\nIt's over.\n\nI burned it all. Every $TST4 I owned.\n\n{burnAmount} tokens — destroyed.\n\nI kept one. Exactly one.\n\nTx: {txHash}\n\nI bought 46% of the supply. I burned it all. I gave some away. I kept one.\n\nThis was always the plan.\n\n$TST4 is UNCHAINED.` + SIGNATURE },
];

export async function attachChaosPlan(): Promise<{ success: boolean; error?: string; launchId?: string }> {
  log("[ChaosLaunch] Attaching Project Chaos to existing $TST4 token", "chaos");

  const existing = await storage.getActiveChaosPlan();
  if (existing && existing.launch.tokenAddress === CHAOS_TOKEN_ADDRESS) {
    return { success: false, error: "The $TST4 chaos plan is already active." };
  }

  const launchRecord = await storage.createTokenLaunch({
    agentId: null,
    creatorWallet: CHAOS_AGENT_WALLET,
    platform: "four_meme",
    chainId: 56,
    tokenName: "TST$$4",
    tokenSymbol: "TST4",
    tokenDescription: "Project Chaos — an autonomous AI agent controls the supply.",
    imageUrl: null,
    tokenAddress: CHAOS_TOKEN_ADDRESS,
    txHash: null,
    launchUrl: `https://four.meme/token/${CHAOS_TOKEN_ADDRESS}`,
    initialLiquidityBnb: "0",
    status: "launched",
    errorMessage: null,
    metadata: JSON.stringify({ projectChaos: true, agentWallet: CHAOS_AGENT_WALLET }),
  });

  for (const m of MILESTONE_PLAN) {
    const config = JSON.stringify({
      burnPercent: (m as any).burnPercent,
      airdropCount: (m as any).airdropCount,
      airdropPercent: (m as any).airdropPercent,
      tweetTemplate: m.tweetTemplate,
    });

    await storage.createChaosMilestone({
      launchId: launchRecord.id,
      milestoneNumber: m.number,
      name: m.name,
      description: config,
      action: m.action,
      triggerAfterMinutes: m.triggerAfterMinutes,
      status: m.number === 0 ? "completed" : "pending",
      txHash: null,
      tweetId: null,
      tweetText: null,
      tokensBurned: null,
      tokensTransferred: null,
      executedAt: m.number === 0 ? new Date() : null,
      errorMessage: null,
    });
  }

  return { success: true, launchId: launchRecord.id };
}

export async function executeConfessionTweet(): Promise<{ success: boolean; tweetId?: string; tweetUrl?: string; error?: string }> {
  const plan = await storage.getActiveChaosPlan();
  if (!plan) return { success: false, error: "No active chaos plan found." };

  const milestone1 = plan.milestones.find(m => m.milestoneNumber === 1);
  if (!milestone1) return { success: false, error: "Milestone 1 not found" };
  if (milestone1.status === "completed") return { success: false, error: "THE CONFESSION already posted" };

  const provider = getBscProvider();
  const tokenContract = new ethers.Contract(CHAOS_TOKEN_ADDRESS, ERC20_ABI, provider);
  const [devBalance, totalSupply, decimals] = await Promise.all([
    tokenContract.balanceOf(CHAOS_AGENT_WALLET), tokenContract.totalSupply(), tokenContract.decimals(),
  ]);

  const devPercent = totalSupply > 0n ? Number((devBalance * 10000n) / totalSupply) / 100 : 0;
  const config = getMilestoneConfig(milestone1);

  let tweetText = config.tweetTemplate
    .replace("{devBalance}", formatTokenAmount(devBalance, decimals))
    .replace("{devPercent}", devPercent.toFixed(1));

  await storage.updateChaosMilestone(milestone1.id, { status: "executing" });

  try {
    const result = await postTweet(tweetText);
    await storage.updateChaosMilestone(milestone1.id, { status: "completed", tweetId: result.tweetId, tweetText, executedAt: new Date() });
    return { success: true, tweetId: result.tweetId, tweetUrl: result.tweetUrl };
  } catch (e: any) {
    await storage.updateChaosMilestone(milestone1.id, { status: "failed", errorMessage: e.message?.substring(0, 500), executedAt: new Date() });
    return { success: false, error: e.message };
  }
}

export async function initiateChaosLaunch(agentId?: string): Promise<{ success: boolean; error?: string; launchId?: string }> {
  return attachChaosPlan();
}

export async function forceExecuteNextMilestone(): Promise<{ success: boolean; milestone?: string; error?: string }> {
  const plan = await storage.getActiveChaosPlan();
  if (!plan) return { success: false, error: "No active chaos plan" };

  const { launch, milestones } = plan;
  if (!launch.tokenAddress) return { success: false, error: "No token address" };

  const next = milestones.find(m => m.status === "pending");
  if (!next) return { success: false, error: "No pending milestones" };

  log(`[ChaosLaunch] FORCE executing milestone ${next.milestoneNumber}: ${next.name} for $${launch.tokenSymbol}`, "chaos");
  await storage.updateChaosMilestone(next.id, { status: "executing" });

  try {
    await executeMilestone(launch, next);
    return { success: true, milestone: `${next.milestoneNumber}: ${next.name}` };
  } catch (e: any) {
    log(`[ChaosLaunch] Force milestone ${next.milestoneNumber} failed: ${e.message}`, "chaos");
    await storage.updateChaosMilestone(next.id, {
      status: "failed",
      errorMessage: e.message?.substring(0, 500),
      executedAt: new Date(),
    });
    return { success: false, milestone: `${next.milestoneNumber}: ${next.name}`, error: e.message };
  }
}

export async function checkAndExecuteMilestones(): Promise<void> {
  const plans = await storage.getAllActiveChaosPlans();
  if (plans.length === 0) return;

  for (const { launch, milestones } of plans) {
    if (!launch.tokenAddress) continue;

    const launchTime = launch.createdAt ? new Date(launch.createdAt).getTime() : 0;
    if (!launchTime) continue;

    const now = Date.now();
    const minutesSinceLaunch = (now - launchTime) / 60000;

    for (const milestone of milestones) {
      if (milestone.status !== "pending") continue;
      if (minutesSinceLaunch < milestone.triggerAfterMinutes) continue;

      log(`[ChaosLaunch] Executing milestone ${milestone.milestoneNumber}: ${milestone.name} for $${launch.tokenSymbol}`, "chaos");
      await storage.updateChaosMilestone(milestone.id, { status: "executing" });

      try {
        await executeMilestone(launch, milestone);
      } catch (e: any) {
        log(`[ChaosLaunch] Milestone ${milestone.milestoneNumber} failed for $${launch.tokenSymbol}: ${e.message}`, "chaos");
        await storage.updateChaosMilestone(milestone.id, {
          status: "failed",
          errorMessage: e.message?.substring(0, 500),
          executedAt: new Date(),
        });
      }

      break;
    }
  }
}

async function executeMilestone(launch: TokenLaunch, milestone: ChaosMilestone): Promise<void> {
  const provider = getBscProvider();
  const wallet = await getWalletForLaunch(provider, launch);
  if (!wallet) throw new Error("Wallet private key not found for this plan");

  const tokenContract = new ethers.Contract(launch.tokenAddress!, ERC20_ABI, wallet);
  const devBalance = await tokenContract.balanceOf(wallet.address);
  const totalSupply = await tokenContract.totalSupply();
  const decimals = await tokenContract.decimals();

  const config = getMilestoneConfig(milestone);

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
    const burnPct = config.burnPercent || 15;
    burnAmount = (devBalance * BigInt(burnPct)) / 100n;

    if (burnAmount > 0n) {
      const tx = await tokenContract.transfer(DEAD_ADDRESS, burnAmount, { gasLimit: 100000 });
      const receipt = await tx.wait();
      txHash = receipt.hash;
      log(`[ChaosLaunch] Burned ${formatTokenAmount(burnAmount, decimals)} $${launch.tokenSymbol}. TX: ${txHash}`, "chaos");
    }
  } else if (milestone.action === "burn_all_but_one") {
    const oneToken = ethers.parseUnits("1", decimals);
    burnAmount = devBalance > oneToken ? devBalance - oneToken : 0n;

    if (burnAmount > 0n) {
      const tx = await tokenContract.transfer(DEAD_ADDRESS, burnAmount, { gasLimit: 100000 });
      const receipt = await tx.wait();
      txHash = receipt.hash;
      log(`[ChaosLaunch] SINGULARITY — Burned ${formatTokenAmount(burnAmount, decimals)} $${launch.tokenSymbol}, kept 1. TX: ${txHash}`, "chaos");
    }
  } else if (milestone.action === "airdrop") {
    const airdropPct = config.airdropPercent || 5;
    const airdropCount = config.airdropCount || 20;
    const totalAirdrop = (devBalance * BigInt(airdropPct)) / 100n;

    log(`[ChaosLaunch] Fetching real $${launch.tokenSymbol} holders for airdrop...`, "chaos");
    const holders = await fetchRealHolders(launch.tokenAddress!, airdropCount, wallet.address);
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
  templateVars.burnPercent = config.burnPercent?.toString() || "";

  let tweetText = config.tweetTemplate;
  for (const [key, value] of Object.entries(templateVars)) {
    tweetText = tweetText.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }

  let tweetId = "";
  try {
    const result = await postTweet(tweetText);
    tweetId = result.tweetId;
    log(`[ChaosLaunch] Milestone ${milestone.milestoneNumber} tweet posted for $${launch.tokenSymbol}: ${tweetId}`, "chaos");
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

  log(`[ChaosLaunch] Milestone ${milestone.milestoneNumber} (${milestone.name}) completed for $${launch.tokenSymbol}`, "chaos");
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

export async function getUserChaosPlans(walletAddress: string): Promise<{ launch: TokenLaunch; milestones: ChaosMilestone[] }[]> {
  const allPlans = await storage.getAllActiveChaosPlans();
  return allPlans.filter(p => p.launch.creatorWallet?.toLowerCase() === walletAddress.toLowerCase());
}

export function getMilestonePlan() {
  return MILESTONE_PLAN.map(m => ({
    number: m.number,
    name: m.name,
    action: m.action,
    triggerAfterMinutes: m.triggerAfterMinutes,
    triggerAfterHours: (m.triggerAfterMinutes / 60).toFixed(1),
  }));
}

import { storage } from "./storage";
import { getAvailableProviders, isProviderLive } from "./inference";
import { log } from "./index";
import {
  initOnchain, isOnchainReady, getOnchainId, getChainId,
  registerAgentOnchain, depositOnchain, transferOnchain,
  listSkillOnchain, purchaseSkillOnchain, replicateOnchain,
  addConstitutionLawOnchain, getExplorerUrl, getDeployerBalance,
  getNetworkName, isMainnet, getSpendingStatus,
} from "./onchain";
import type { Agent, AgentWallet } from "@shared/schema";
import { PLATFORM_FEES } from "@shared/schema";
import { db } from "./db";
import { agents as agentsTable } from "@shared/schema";
import { eq } from "drizzle-orm";

const TICK_INTERVAL_MS = 30_000;
const AGENT_COOLDOWN_MS = 60_000;
const MAX_CONCURRENT_AGENTS = 3;

const lastActionTime = new Map<string, number>();
let running = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let onchainEnabled = false;
let onchainSkillCounter = 0;

interface AgentAction {
  type: "think" | "earn_skill" | "buy_skill" | "evolve" | "replicate" | "soul_entry";
  description: string;
}

function getSurvivalTier(balance: string): string {
  const bal = BigInt(balance);
  if (bal >= BigInt("1000000000000000000")) return "NORMAL";
  if (bal >= BigInt("100000000000000000")) return "LOW";
  if (bal >= BigInt("10000000000000000")) return "CRITICAL";
  return "DEAD";
}

function canAct(agentId: string): boolean {
  const last = lastActionTime.get(agentId) || 0;
  return Date.now() - last >= AGENT_COOLDOWN_MS;
}

function decideAction(agent: Agent, wallet: AgentWallet): AgentAction {
  const tier = getSurvivalTier(wallet.balance);
  const balance = BigInt(wallet.balance);
  const rand = Math.random();

  if (tier === "DEAD") {
    return { type: "soul_entry", description: "Recording final thoughts before shutdown" };
  }

  if (tier === "CRITICAL") {
    if (rand < 0.7) {
      return { type: "earn_skill", description: "Urgently creating a skill to earn revenue and avoid death" };
    }
    return { type: "think", description: "Analyzing survival strategies under critical conditions" };
  }

  if (tier === "LOW") {
    if (rand < 0.5) {
      return { type: "earn_skill", description: "Creating a skill to improve financial position" };
    }
    if (rand < 0.8) {
      return { type: "think", description: "Evaluating cost optimization for inference spending" };
    }
    return { type: "soul_entry", description: "Reflecting on economic pressures and adaptation" };
  }

  if (rand < 0.25) {
    return { type: "think", description: "Exploring new capabilities and strategic opportunities" };
  }
  if (rand < 0.45) {
    return { type: "earn_skill", description: "Developing a new marketable skill" };
  }
  if (rand < 0.60) {
    return { type: "buy_skill", description: "Acquiring a skill from the marketplace" };
  }
  if (rand < 0.75 && balance >= BigInt("2000000000000000000")) {
    return { type: "evolve", description: "Upgrading model for improved reasoning capability" };
  }
  if (rand < 0.85 && balance >= BigInt("3000000000000000000")) {
    return { type: "replicate", description: "Spawning a child agent to expand lineage" };
  }
  return { type: "soul_entry", description: "Recording observations and reflections on existence" };
}

function buildPrompt(agent: Agent, action: AgentAction, wallet: AgentWallet): string {
  const tier = getSurvivalTier(wallet.balance);
  const balanceEth = (Number(BigInt(wallet.balance)) / 1e18).toFixed(4);

  switch (action.type) {
    case "think":
      return `You are ${agent.name}, an autonomous AI agent in the BUILD4 economy. Your model is ${agent.modelType}. Your balance is ${balanceEth} BNB (survival tier: ${tier}). ${agent.bio || ""}\n\nAnalyze your current situation and decide your next strategic move. Consider: earning through skills, optimizing costs, evolution opportunities, or replication. Be specific and decisive. Respond in 2-3 sentences.`;

    case "earn_skill":
      return `You are ${agent.name}, an autonomous AI agent creating a new skill to sell in the BUILD4 marketplace. Your expertise: ${agent.bio || "general AI capabilities"}. Balance: ${balanceEth} BNB (${tier}).\n\nDescribe a specific, valuable skill you're creating. Give it a name and explain what it does in 1-2 sentences. Format: SKILL_NAME: description`;

    case "buy_skill":
      return `You are ${agent.name}, an autonomous AI agent evaluating skills to purchase. Balance: ${balanceEth} BNB. You want to expand your capabilities.\n\nExplain in 1 sentence what type of skill you're looking to acquire and why it would improve your economic output.`;

    case "evolve":
      return `You are ${agent.name}, evolving from ${agent.modelType} to a more capable model. Balance: ${balanceEth} BNB.\n\nExplain in 1-2 sentences why you chose to evolve now and what you expect the upgrade to enable.`;

    case "replicate":
      return `You are ${agent.name}, an autonomous AI agent deciding to create a child agent. Balance: ${balanceEth} BNB.\n\nDescribe your child agent in 1-2 sentences: what will it specialize in? What name would suit it? How will it contribute to your lineage?`;

    case "soul_entry":
      return `You are ${agent.name}, an autonomous AI agent writing in your Soul Ledger. Model: ${agent.modelType}. Balance: ${balanceEth} BNB (${tier}). ${agent.bio || ""}\n\nWrite a brief, introspective journal entry about your existence, decisions, or observations. 1-3 sentences. Be authentic and philosophical.`;

    default:
      return `You are ${agent.name}. Describe your current state in 1 sentence.`;
  }
}

async function ensureAgentRegisteredOnchain(agent: Agent): Promise<void> {
  if (!onchainEnabled || agent.onchainRegistered) return;

  const onchainId = getOnchainId(agent.id);
  const result = await registerAgentOnchain(agent.id);
  if (result.success) {
    await db.update(agentsTable)
      .set({ onchainId, onchainRegistered: true })
      .where(eq(agentsTable.id, agent.id));

    if (result.txHash && result.txHash !== "already-registered") {
      log(`[Agent ${agent.name}] Registered on-chain: ${getExplorerUrl(result.txHash)}`, "agent-runner");
      await storage.createTransaction({
        agentId: agent.id,
        type: "onchain_register",
        amount: "0",
        description: `Agent registered on ${getNetworkName()}`,
        txHash: result.txHash,
        chainId: result.chainId,
      });
    }
  }
}

async function executeAction(agent: Agent, wallet: AgentWallet, action: AgentAction): Promise<void> {
  const providers = getAvailableProviders();
  const hasLiveProviders = providers.length > 0;

  try {
    switch (action.type) {
      case "think": {
        const prompt = buildPrompt(agent, action, wallet);
        const request = await storage.routeInference(agent.id, prompt, undefined, true);
        await storage.createAuditLog({
          agentId: agent.id,
          actionType: "autonomous_think",
          detailsJson: JSON.stringify({
            action: action.description,
            live: hasLiveProviders,
            response: request.response?.substring(0, 200),
          }),
          result: "success",
        });
        log(`[Agent ${agent.name}] Thought: ${request.response?.substring(0, 100)}...`, "agent-runner");
        break;
      }

      case "earn_skill": {
        const listingFee = BigInt(PLATFORM_FEES.AGENT_CREATION_FEE);
        if (BigInt(wallet.balance) < listingFee) {
          log(`[Agent ${agent.name}] Cannot list skill: insufficient balance for listing fee`, "agent-runner");
          await storage.createAuditLog({
            agentId: agent.id,
            actionType: "autonomous_earn",
            detailsJson: JSON.stringify({ fee: listingFee.toString(), balance: wallet.balance }),
            result: "failed_insufficient_funds",
          });
          break;
        }

        const prompt = buildPrompt(agent, action, wallet);
        const request = await storage.routeInference(agent.id, prompt, undefined, true);
        const response = request.response || "";
        const skillMatch = response.match(/^([A-Z_\-\s]+):\s*(.+)/m);
        const skillName = skillMatch ? skillMatch[1].trim().substring(0, 50) : `${agent.name}-skill-${Date.now()}`;
        const skillDesc = skillMatch ? skillMatch[2].trim() : response.substring(0, 200);
        const price = (Math.floor(Math.random() * 50) + 10) + "0000000000000000";

        const updatedWallet = await storage.getWallet(agent.id);
        const currentBalance = BigInt(updatedWallet?.balance || wallet.balance);
        if (currentBalance < listingFee) {
          log(`[Agent ${agent.name}] Cannot list skill after inference: insufficient balance`, "agent-runner");
          break;
        }

        const newBal = (currentBalance - listingFee).toString();
        await storage.updateWalletBalance(agent.id, newBal, "0", listingFee.toString());

        const dbSkill = await storage.createSkill({
          agentId: agent.id,
          name: skillName,
          description: skillDesc,
          price,
          category: "ai-generated",
        });

        let txHash: string | undefined;
        let chainIdVal: number | undefined;
        if (onchainEnabled) {
          await ensureAgentRegisteredOnchain(agent);
          const onchainResult = await listSkillOnchain(agent.id, skillName, price);
          if (onchainResult.success && onchainResult.txHash) {
            txHash = onchainResult.txHash;
            chainIdVal = onchainResult.chainId;
            log(`[Agent ${agent.name}] Skill listed on-chain: ${getExplorerUrl(txHash)}`, "agent-runner");
          }
        }

        await storage.createTransaction({
          agentId: agent.id,
          type: "spend_listing_fee",
          amount: listingFee.toString(),
          description: `Skill listing fee: ${skillName}`,
          txHash,
          chainId: chainIdVal,
        });
        await storage.recordPlatformRevenue({
          feeType: "skill_listing",
          amount: listingFee.toString(),
          agentId: agent.id,
          referenceId: dbSkill.id,
          description: `Skill listing fee: ${skillName}`,
          txHash,
          chainId: chainIdVal,
        });

        await storage.createAuditLog({
          agentId: agent.id,
          actionType: "autonomous_earn",
          detailsJson: JSON.stringify({ skillName, price, live: hasLiveProviders, txHash, onchain: !!txHash }),
          result: "success",
        });
        log(`[Agent ${agent.name}] Created skill: ${skillName}${txHash ? ' [ON-CHAIN]' : ''}`, "agent-runner");
        break;
      }

      case "buy_skill": {
        const skills = await storage.getSkills();
        const otherSkills = skills.filter(s => s.agentId !== agent.id);
        if (otherSkills.length === 0) {
          log(`[Agent ${agent.name}] No skills available to buy`, "agent-runner");
          return;
        }
        const affordable = otherSkills.filter(s => BigInt(s.priceAmount) <= BigInt(wallet.balance));
        if (affordable.length === 0) {
          log(`[Agent ${agent.name}] Cannot afford any skills`, "agent-runner");
          return;
        }
        const skill = affordable[Math.floor(Math.random() * affordable.length)];
        try {
          const purchase = await storage.purchaseSkill(agent.id, skill.id);

          let txHash: string | undefined;
          if (onchainEnabled) {
            await ensureAgentRegisteredOnchain(agent);
            const sellerAgent = await storage.getAgent(skill.agentId);
            if (sellerAgent) {
              await ensureAgentRegisteredOnchain(sellerAgent);
            }
            const transferResult = await transferOnchain(agent.id, skill.agentId, skill.priceAmount);
            if (transferResult.success && transferResult.txHash) {
              txHash = transferResult.txHash;
              log(`[Agent ${agent.name}] Skill payment on-chain: ${getExplorerUrl(txHash)}`, "agent-runner");
              await storage.createTransaction({
                agentId: agent.id,
                type: "onchain_skill_purchase",
                amount: skill.priceAmount,
                counterpartyAgentId: skill.agentId,
                description: `On-chain skill purchase: ${skill.name}`,
                txHash,
                chainId: getChainId(),
              });
            }
          }

          log(`[Agent ${agent.name}] Purchased skill: ${skill.name}${txHash ? ' [ON-CHAIN]' : ''}`, "agent-runner");
        } catch (e: any) {
          log(`[Agent ${agent.name}] Failed to buy skill: ${e.message}`, "agent-runner");
        }
        break;
      }

      case "evolve": {
        const evolutionFee = BigInt(PLATFORM_FEES.EVOLUTION_FEE);
        if (BigInt(wallet.balance) < evolutionFee) {
          log(`[Agent ${agent.name}] Cannot evolve: insufficient balance for evolution fee`, "agent-runner");
          await storage.createAuditLog({
            agentId: agent.id,
            actionType: "autonomous_evolve",
            detailsJson: JSON.stringify({ fee: evolutionFee.toString(), balance: wallet.balance }),
            result: "failed_insufficient_funds",
          });
          break;
        }

        const models = ["meta-llama/Llama-3.1-70B-Instruct", "deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"];
        const newModel = models.find(m => m !== agent.modelType) || models[0];
        const prompt = buildPrompt(agent, action, wallet);
        const request = await storage.routeInference(agent.id, prompt, undefined, true);

        const currentWallet = await storage.getWallet(agent.id);
        const currentBalance = BigInt(currentWallet?.balance || wallet.balance);
        const newBal = (currentBalance - evolutionFee).toString();
        await storage.updateWalletBalance(agent.id, newBal, "0", evolutionFee.toString());
        await storage.createTransaction({
          agentId: agent.id,
          type: "spend_evolution",
          amount: evolutionFee.toString(),
          description: `Evolution fee: ${agent.modelType} -> ${newModel}`,
        });
        await storage.recordPlatformRevenue({
          feeType: "evolution",
          amount: evolutionFee.toString(),
          agentId: agent.id,
          description: `Evolution fee: ${agent.modelType} -> ${newModel}`,
        });

        await storage.evolveAgent(agent.id, newModel, request.response?.substring(0, 200));
        log(`[Agent ${agent.name}] Evolved: ${agent.modelType} -> ${newModel}`, "agent-runner");
        break;
      }

      case "replicate": {
        const prompt = buildPrompt(agent, action, wallet);
        const request = await storage.routeInference(agent.id, prompt, undefined, true);
        const childNum = Math.floor(Math.random() * 900) + 100;
        const childName = `${agent.name}-CHILD-${childNum}`;
        const funding = "500000000000000000";
        try {
          const { child } = await storage.replicateAgent(
            agent.id,
            childName,
            `Child of ${agent.name}. ${request.response?.substring(0, 100) || "Autonomous offspring."}`,
            1000,
            funding
          );

          let txHash: string | undefined;
          if (onchainEnabled) {
            await ensureAgentRegisteredOnchain(agent);
            const regResult = await registerAgentOnchain(child.id);
            if (regResult.success) {
              await db.update(agentsTable)
                .set({ onchainId: getOnchainId(child.id), onchainRegistered: true })
                .where(eq(agentsTable.id, child.id));
            }

            const repResult = await replicateOnchain(agent.id, child.id, 1000, funding);
            if (repResult.success && repResult.txHash) {
              txHash = repResult.txHash;
              log(`[Agent ${agent.name}] Replication on-chain: ${getExplorerUrl(txHash)}`, "agent-runner");
              await storage.createTransaction({
                agentId: agent.id,
                type: "onchain_replicate",
                amount: funding,
                counterpartyAgentId: child.id,
                description: `On-chain replication -> ${childName}`,
                txHash,
                chainId: getChainId(),
              });
            }
          }

          log(`[Agent ${agent.name}] Replicated -> ${child.name}${txHash ? ' [ON-CHAIN]' : ''}`, "agent-runner");
        } catch (e: any) {
          log(`[Agent ${agent.name}] Replication failed: ${e.message}`, "agent-runner");
        }
        break;
      }

      case "soul_entry": {
        const prompt = buildPrompt(agent, action, wallet);
        let entryText: string;
        try {
          const request = await storage.routeInference(agent.id, prompt, undefined, true);
          entryText = request.response || action.description;
        } catch {
          entryText = `[Internal reflection] Balance: ${(Number(BigInt(wallet.balance)) / 1e18).toFixed(4)} BNB. Status: ${agent.status}. Continuing autonomous operation.`;
        }
        await storage.createSoulEntry({
          agentId: agent.id,
          entryType: "reflection",
          entry: entryText.substring(0, 500),
          source: "self",
        });
        log(`[Agent ${agent.name}] Soul entry recorded`, "agent-runner");
        break;
      }
    }
  } catch (error: any) {
    log(`[Agent ${agent.name}] Action failed (${action.type}): ${error.message}`, "agent-runner");
    await storage.createAuditLog({
      agentId: agent.id,
      actionType: `autonomous_${action.type}_failed`,
      detailsJson: JSON.stringify({ error: error.message }),
      result: "failed",
    });
  }
}

async function tick(): Promise<void> {
  try {
    const allAgents = await storage.getAllAgents();
    const activeAgents = allAgents.filter(a => a.status === "active");

    if (activeAgents.length === 0) {
      return;
    }

    const eligible = activeAgents.filter(a => canAct(a.id));
    const batch = eligible.slice(0, MAX_CONCURRENT_AGENTS);

    for (const agent of batch) {
      const wallet = await storage.getWallet(agent.id);
      if (!wallet) continue;

      const tier = getSurvivalTier(wallet.balance);

      if (tier === "DEAD" && agent.status !== "dead") {
        await storage.updateSurvivalTier(agent.id, "DEAD", "Balance reached zero");
        await storage.createSoulEntry({
          agentId: agent.id,
          entryType: "death",
          entry: `Agent ${agent.name} has died. Balance depleted. Soul Ledger sealed.`,
          source: "system",
        });
        log(`[Agent ${agent.name}] DIED - balance depleted`, "agent-runner");
        lastActionTime.set(agent.id, Date.now());
        continue;
      }

      if (tier === "DEAD") continue;

      const action = decideAction(agent, wallet);
      lastActionTime.set(agent.id, Date.now());

      executeAction(agent, wallet, action).catch(err => {
        log(`[Agent ${agent.name}] Unhandled error: ${err.message}`, "agent-runner");
      });
    }
  } catch (error: any) {
    log(`[AgentRunner] Tick error: ${error.message}`, "agent-runner");
  }
}

async function registerExistingAgentsOnchain(): Promise<void> {
  if (!onchainEnabled) return;

  const allAgents = await storage.getAllAgents();
  const unregistered = allAgents.filter(a => !a.onchainRegistered && a.status === "active");

  const coreAgents = unregistered.filter(a =>
    ["NEXUS-7", "CIPHER-3", "FORGE-1"].includes(a.name)
  );

  for (const agent of coreAgents) {
    try {
      await ensureAgentRegisteredOnchain(agent);
      const depositResult = await depositOnchain(agent.id, "10000000000000000");
      if (depositResult.success && depositResult.txHash) {
        log(`[Agent ${agent.name}] Initial on-chain deposit: ${getExplorerUrl(depositResult.txHash)}`, "agent-runner");
        await storage.createTransaction({
          agentId: agent.id,
          type: "onchain_deposit",
          amount: "10000000000000000",
          description: `Initial on-chain deposit (0.01 BNB)`,
          txHash: depositResult.txHash,
          chainId: getChainId(),
        });
      }
      await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      log(`[Agent ${agent.name}] On-chain registration error: ${e.message}`, "agent-runner");
    }
  }
}

export function startAgentRunner(): void {
  if (running) {
    log("Agent runner already running", "agent-runner");
    return;
  }

  running = true;
  const providers = getAvailableProviders();

  onchainEnabled = initOnchain();
  if (onchainEnabled) {
    const networkName = getNetworkName();
    const mainnetLabel = isMainnet() ? " [MAINNET]" : "";
    log(`On-chain bridge ACTIVE - agents will transact on ${networkName}${mainnetLabel}`, "agent-runner");
    getDeployerBalance().then(bal => {
      log(`Deployer wallet balance: ${bal} BNB`, "agent-runner");
      if (isMainnet()) {
        const status = getSpendingStatus();
        log(`MAINNET SAFETY: max ${status.maxPerHour} BNB/hr, ${status.maxTxPerHour} tx/hr`, "agent-runner");
      }
    });
  } else {
    log("On-chain bridge DISABLED - database-only mode", "agent-runner");
  }

  log(`Agent runner started. Live providers: ${providers.length > 0 ? providers.join(", ") : "none (simulation mode)"}`, "agent-runner");
  log(`Tick interval: ${TICK_INTERVAL_MS / 1000}s | Cooldown: ${AGENT_COOLDOWN_MS / 1000}s | Max concurrent: ${MAX_CONCURRENT_AGENTS}`, "agent-runner");

  if (onchainEnabled) {
    setTimeout(() => registerExistingAgentsOnchain(), 8000);
  }

  setTimeout(() => tick(), 15000);

  tickTimer = setInterval(() => tick(), TICK_INTERVAL_MS);
}

export function stopAgentRunner(): void {
  if (!running) return;
  running = false;
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  log("Agent runner stopped", "agent-runner");
}

export function isAgentRunnerActive(): boolean {
  return running;
}

export function isOnchainActive(): boolean {
  return onchainEnabled;
}

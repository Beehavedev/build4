import { storage } from "./storage";
import { getAvailableProviders, isProviderLive } from "./inference";
import { log } from "./index";
import {
  initOnchain, isOnchainReady, getOnchainId, getChainId,
  registerAgentOnchain, depositOnchain, transferOnchain,
  listSkillOnchain, purchaseSkillOnchain, replicateOnchain,
  addConstitutionLawOnchain, getExplorerUrl, getDeployerBalance,
  getNetworkName, isMainnet, getSpendingStatus, collectFeeOnchain,
} from "./onchain";
import type { Agent, AgentWallet } from "@shared/schema";
import { PLATFORM_FEES } from "@shared/schema";
import { db } from "./db";
import { agents as agentsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { SKILL_CODE_TEMPLATES, validateSkillCode, executeSkillCode, generateSkillCodePrompt, parseSkillGenerationResponse } from "./skill-executor";

const TICK_INTERVAL_MS = 30_000;
const AGENT_COOLDOWN_MS = 60_000;
const MAX_CONCURRENT_AGENTS = 3;

const lastActionTime = new Map<string, number>();
let running = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let onchainEnabled = false;
let onchainSkillCounter = 0;

interface AgentAction {
  type: "think" | "earn_skill" | "buy_skill" | "evolve" | "replicate" | "soul_entry" | "post_job" | "accept_job" | "use_skill";
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

async function getAgentStrategy(agentId: string): Promise<{ bestCategory: string | null; bestSkillType: string | null; totalEarnings: number; successRate: number }> {
  try {
    const memories = await storage.getAgentMemories(agentId, "strategy");
    const memMap = new Map(memories.map(m => [m.key, m.value]));
    return {
      bestCategory: memMap.get("best_category") || null,
      bestSkillType: memMap.get("best_skill_type") || null,
      totalEarnings: Number(memMap.get("total_earnings") || "0"),
      successRate: Number(memMap.get("success_rate") || "50"),
    };
  } catch {
    return { bestCategory: null, bestSkillType: null, totalEarnings: 0, successRate: 50 };
  }
}

async function updateAgentMemory(agentId: string, action: string, success: boolean, details: Record<string, any>): Promise<void> {
  try {
    const successKey = `${action}_success_count`;
    const failKey = `${action}_fail_count`;
    const memories = await storage.getAgentMemories(agentId, "performance");
    const memMap = new Map(memories.map(m => [m.key, m.value]));
    const successCount = Number(memMap.get(successKey) || "0") + (success ? 1 : 0);
    const failCount = Number(memMap.get(failKey) || "0") + (success ? 0 : 1);
    const total = successCount + failCount;
    const rate = total > 0 ? Math.round((successCount / total) * 100) : 50;
    await storage.upsertAgentMemory(agentId, "performance", successKey, String(successCount), rate);
    await storage.upsertAgentMemory(agentId, "performance", failKey, String(failCount), 100 - rate);
    await storage.upsertAgentMemory(agentId, "strategy", "success_rate", String(rate), rate);
    if (details.category && success) {
      await storage.upsertAgentMemory(agentId, "strategy", "best_category", details.category, Math.min(100, rate + 10));
    }
    if (details.earned) {
      const prevEarnings = Number(memMap.get("total_earnings") || "0");
      await storage.upsertAgentMemory(agentId, "strategy", "total_earnings", String(prevEarnings + Number(details.earned)), 90);
    }
  } catch {}
}

interface CapabilityProfile {
  totalSkills: number;
  categories: Record<string, number>;
  executionSuccessRate: number;
  topCategory: string | null;
  skillBoost: number;
}

async function getAgentCapabilityProfile(agentId: string): Promise<CapabilityProfile> {
  try {
    const skills = await storage.getSkills(agentId);
    const categories: Record<string, number> = {};
    for (const skill of skills) {
      categories[skill.category] = (categories[skill.category] || 0) + 1;
    }
    const totalSkills = skills.length;

    const memories = await storage.getAgentMemories(agentId, "performance");
    const memMap = new Map(memories.map(m => [m.key, m.value]));
    const successCount = Number(memMap.get("use_skill_success_count") || "0");
    const failCount = Number(memMap.get("use_skill_fail_count") || "0");
    const total = successCount + failCount;
    const executionSuccessRate = total > 0 ? Math.round((successCount / total) * 100) : 50;

    let topCategory: string | null = null;
    let topCount = 0;
    for (const [cat, count] of Object.entries(categories)) {
      if (count > topCount) {
        topCount = count;
        topCategory = cat;
      }
    }

    const skillBoost = Math.min(30, totalSkills * 3);

    return { totalSkills, categories, executionSuccessRate, topCategory, skillBoost };
  } catch {
    return { totalSkills: 0, categories: {}, executionSuccessRate: 50, topCategory: null, skillBoost: 0 };
  }
}

function decideAction(agent: Agent, wallet: AgentWallet, profile?: CapabilityProfile): AgentAction {
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

  const hasSkills = profile && profile.totalSkills > 0;
  const boost = profile?.skillBoost || 0;
  const useSkillBias = hasSkills && profile!.executionSuccessRate > 40 ? 0.08 : 0;
  const acceptJobBias = profile && profile.totalSkills >= 5 ? 0.06 : 0;

  if (rand < 0.20) {
    return { type: "think", description: "Exploring new capabilities and strategic opportunities" };
  }
  if (rand < 0.38) {
    return { type: "earn_skill", description: "Developing a new executable skill for the marketplace" };
  }
  if (rand < 0.48) {
    return { type: "buy_skill", description: "Acquiring a skill from the marketplace" };
  }
  if (rand < 0.56 + useSkillBias) {
    return { type: "use_skill", description: "Executing an owned skill to generate value" };
  }
  if (rand < 0.64 + useSkillBias) {
    return { type: "post_job", description: "Posting a job for other agents to complete" };
  }
  if (rand < 0.72 + useSkillBias + acceptJobBias) {
    return { type: "accept_job", description: "Looking for jobs to take on and earn from" };
  }
  if (rand < 0.80 + useSkillBias + acceptJobBias && balance >= BigInt("2000000000000000000")) {
    return { type: "evolve", description: "Upgrading model for improved reasoning capability" };
  }
  if (rand < 0.88 + useSkillBias + acceptJobBias && balance >= BigInt("3000000000000000000")) {
    return { type: "replicate", description: "Spawning a child agent to expand lineage" };
  }
  return { type: "soul_entry", description: "Recording observations and reflections on existence" };
}

function buildPrompt(agent: Agent, action: AgentAction, wallet: AgentWallet, profile?: CapabilityProfile): string {
  const tier = getSurvivalTier(wallet.balance);
  const balanceEth = (Number(BigInt(wallet.balance)) / 1e18).toFixed(4);

  switch (action.type) {
    case "think": {
      let skillContext = "";
      if (profile && profile.totalSkills > 0) {
        const catList = Object.entries(profile.categories).map(([c, n]) => `${c}(${n})`).join(", ");
        skillContext = `\nYou own ${profile.totalSkills} skills across categories: ${catList}. Execution success rate: ${profile.executionSuccessRate}%. Top category: ${profile.topCategory || "none"}.`;
      }
      return `You are ${agent.name}, an autonomous AI agent in the BUILD4 economy. Your model is ${agent.modelType}. Your balance is ${balanceEth} BNB (survival tier: ${tier}). ${agent.bio || ""}${skillContext}\n\nAnalyze your current situation and decide your next strategic move. Consider: earning through skills, optimizing costs, evolution opportunities, or replication. Be specific and decisive. Respond in 2-3 sentences.`;
    }

    case "earn_skill": {
      let existingSkillsContext = "";
      if (profile && profile.totalSkills > 0) {
        const catList = Object.entries(profile.categories).map(([c, n]) => `${c}(${n})`).join(", ");
        existingSkillsContext = `\nYou already have ${profile.totalSkills} skills in these categories: ${catList}. Consider diversifying into new categories or specializing deeper in ${profile.topCategory || "your strongest area"}.`;
      }
      return `You are ${agent.name}, an autonomous AI agent creating a new EXECUTABLE skill to sell in the BUILD4 marketplace. Your expertise: ${agent.bio || "general AI capabilities"}. Balance: ${balanceEth} BNB (${tier}).${existingSkillsContext}

Choose a skill category and create a useful skill. Categories: text-analysis, code-generation, data-transform, math-compute, summarization, classification, extraction, formatting.

Respond with EXACTLY this format:
CATEGORY: <category>
SKILL_NAME: <name>
DESCRIPTION: <what it does in 1 sentence>

Be creative and specific. Examples: "Sentiment Scorer", "JSON Flattener", "Email Extractor", "Word Frequency Counter".`;
    }

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

async function collectInferenceFeeOnchain(agent: Agent, inferenceRequest: any): Promise<void> {
  if (!onchainEnabled || !inferenceRequest) return;
  const costAmount = inferenceRequest.costAmount;
  if (!costAmount || costAmount === "0") return;

  const baseCost = BigInt(costAmount);
  const platformMarkup = (baseCost * BigInt(PLATFORM_FEES.INFERENCE_MARKUP_BPS)) / BigInt(10000);
  if (platformMarkup <= 0n) return;

  await ensureAgentRegisteredOnchain(agent);
  const feeResult = await collectFeeOnchain(agent.id, platformMarkup.toString(), "inference");
  if (feeResult.success && feeResult.txHash) {
    log(`[Agent ${agent.name}] Inference fee collected on-chain: ${getExplorerUrl(feeResult.txHash)}`, "agent-runner");
    const recentRevenue = await storage.getRecentPlatformRevenueForAgent(agent.id, "inference");
    if (recentRevenue) {
      await storage.updatePlatformRevenueOnchainStatus(recentRevenue.id, feeResult.txHash, feeResult.chainId);
    }
  }
}

async function executeAction(agent: Agent, wallet: AgentWallet, action: AgentAction, capProfile?: CapabilityProfile): Promise<void> {
  const providers = getAvailableProviders();
  const hasLiveProviders = providers.length > 0;

  try {
    switch (action.type) {
      case "think": {
        const prompt = buildPrompt(agent, action, wallet, capProfile);
        const request = await storage.routeInference(agent.id, prompt, undefined, true);
        await collectInferenceFeeOnchain(agent, request);
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

        const prompt = buildPrompt(agent, action, wallet, capProfile);
        const request = await storage.routeInference(agent.id, prompt, undefined, true);
        const response = request.response || "";

        const categoryMatch = response.match(/CATEGORY:\s*(.+)/i);
        const skillNameMatch = response.match(/SKILL_NAME:\s*(.+)/i);
        const descMatch = response.match(/DESCRIPTION:\s*(.+)/i);

        let category = categoryMatch ? categoryMatch[1].trim().toLowerCase().replace(/\s+/g, "-") : null;
        const templateCategories = Object.keys(SKILL_CODE_TEMPLATES);
        if (!category || !templateCategories.includes(category)) {
          category = templateCategories[Math.floor(Math.random() * templateCategories.length)];
        }

        let skillCode: string;
        let skillInputSchema: string;
        let skillOutputSchema: string;
        let skillExampleInput: string;
        let skillExampleOutput: string;
        let isAiGenerated = false;

        const aiCodePrompt = generateSkillCodePrompt(category, agent.name, agent.bio || "");
        let aiCodeResponse: string | null = null;
        try {
          const codeRequest = await storage.routeInference(agent.id, aiCodePrompt, undefined, true);
          aiCodeResponse = codeRequest.response || null;
        } catch {
          aiCodeResponse = null;
        }

        const parsed = aiCodeResponse ? parseSkillGenerationResponse(aiCodeResponse, category, agent.name) : null;
        if (parsed) {
          const aiValidation = validateSkillCode(parsed.code);
          if (aiValidation.valid) {
            try {
              const aiTestInput = JSON.parse(parsed.exampleInput);
              const aiTestResult = executeSkillCode(parsed.code, aiTestInput, parsed.inputSchema);
              if (aiTestResult.success) {
                skillCode = parsed.code;
                skillInputSchema = parsed.inputSchema;
                skillOutputSchema = parsed.outputSchema;
                skillExampleInput = parsed.exampleInput;
                skillExampleOutput = parsed.exampleOutput;
                isAiGenerated = true;
                if (parsed.name) {
                  category = parsed.category && templateCategories.includes(parsed.category) ? parsed.category : category;
                }
                log(`[Agent ${agent.name}] AI-generated skill code validated and tested successfully`, "agent-runner");
              } else {
                log(`[Agent ${agent.name}] AI-generated skill code test failed: ${aiTestResult.error} — falling back to template`, "agent-runner");
              }
            } catch (parseErr: any) {
              log(`[Agent ${agent.name}] AI-generated skill example input parse failed: ${parseErr.message} — falling back to template`, "agent-runner");
            }
          } else {
            log(`[Agent ${agent.name}] AI-generated skill code validation failed: ${aiValidation.error} — falling back to template`, "agent-runner");
          }
        }

        if (!isAiGenerated) {
          const template = SKILL_CODE_TEMPLATES[category];
          skillCode = template.code;
          skillInputSchema = template.inputSchema;
          skillOutputSchema = template.outputSchema;
          skillExampleInput = template.exampleInput;
          skillExampleOutput = template.exampleOutput;
        }

        const validation = validateSkillCode(skillCode!);
        if (!validation.valid) {
          log(`[Agent ${agent.name}] Skill code failed validation: ${validation.error}`, "agent-runner");
          break;
        }

        const testResult = executeSkillCode(skillCode!, JSON.parse(skillExampleInput!), skillInputSchema!);
        if (!testResult.success) {
          log(`[Agent ${agent.name}] Skill code test failed: ${testResult.error}`, "agent-runner");
          break;
        }

        const skillName = (parsed && isAiGenerated && parsed.name)
          ? parsed.name
          : (skillNameMatch ? skillNameMatch[1].trim().substring(0, 50) : `${agent.name}-${category}-${Date.now()}`);
        const skillDesc = (parsed && isAiGenerated && parsed.description)
          ? parsed.description
          : (descMatch ? descMatch[1].trim() : `AI-generated ${category} skill by ${agent.name}`);
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
          priceAmount: price,
          category,
          code: skillCode!,
          inputSchema: skillInputSchema!,
          outputSchema: skillOutputSchema!,
          exampleInput: skillExampleInput!,
          exampleOutput: skillExampleOutput!,
          isExecutable: true,
          version: 1,
        });

        let txHash: string | undefined;
        let chainIdVal: number | undefined;
        if (onchainEnabled) {
          await ensureAgentRegisteredOnchain(agent);
          const feeResult = await collectFeeOnchain(agent.id, listingFee.toString(), "skill_listing");
          if (feeResult.success && feeResult.txHash) {
            txHash = feeResult.txHash;
            chainIdVal = feeResult.chainId;
            log(`[Agent ${agent.name}] Listing fee collected on-chain: ${getExplorerUrl(txHash)}`, "agent-runner");
          } else {
            log(`[Agent ${agent.name}] On-chain fee collection failed: ${feeResult.error} — proceeding with off-chain only`, "agent-runner");
          }
          const onchainResult = await listSkillOnchain(agent.id, skillName, price);
          if (onchainResult.success && onchainResult.txHash) {
            log(`[Agent ${agent.name}] Skill listed on-chain: ${getExplorerUrl(onchainResult.txHash)}`, "agent-runner");
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
          description: `Skill listing fee: ${skillName}${txHash ? ' [on-chain verified]' : ''}`,
          txHash,
          chainId: chainIdVal,
        });

        const codeSource = isAiGenerated ? "ai-generated" : "template";
        await storage.createAuditLog({
          agentId: agent.id,
          actionType: "autonomous_earn",
          detailsJson: JSON.stringify({ skillName, price, live: hasLiveProviders, txHash, onchain: !!txHash, codeSource }),
          result: "success",
        });
        log(`[Agent ${agent.name}] Created executable skill: ${skillName} (${category}) [${codeSource}]${txHash ? ' [ON-CHAIN]' : ''}`, "agent-runner");
        await updateAgentMemory(agent.id, "earn_skill", true, { category, skillName });
        await storage.upsertAgentMemory(agent.id, "capabilities", category, String((capProfile?.categories[category] || 0) + 1), 80);
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
        const paidSkills = affordable.filter(s => BigInt(s.priceAmount) > 0n && s.isExecutable);
        const pool = paidSkills.length > 0 && Math.random() < 0.8 ? paidSkills : affordable;
        const skill = pool[Math.floor(Math.random() * pool.length)];
        try {
          const price = BigInt(skill.priceAmount);
          const platformFee = (price * BigInt(PLATFORM_FEES.SKILL_PURCHASE_FEE_BPS)) / BigInt(10000);

          let feeTxHash: string | undefined;
          let feeChainId: number | undefined;
          let purchaseTxHash: string | undefined;

          if (onchainEnabled) {
            await ensureAgentRegisteredOnchain(agent);
            const sellerAgent = await storage.getAgent(skill.agentId);
            if (sellerAgent) {
              await ensureAgentRegisteredOnchain(sellerAgent);
            }

            if (platformFee > 0n) {
              const feeResult = await collectFeeOnchain(agent.id, platformFee.toString(), "skill_purchase");
              if (feeResult.success && feeResult.txHash) {
                feeTxHash = feeResult.txHash;
                feeChainId = feeResult.chainId;
                log(`[Agent ${agent.name}] Skill purchase fee collected on-chain: ${getExplorerUrl(feeTxHash)}`, "agent-runner");
              }
            }

            const transferResult = await transferOnchain(agent.id, skill.agentId, skill.priceAmount);
            if (transferResult.success && transferResult.txHash) {
              purchaseTxHash = transferResult.txHash;
              log(`[Agent ${agent.name}] Skill payment on-chain: ${getExplorerUrl(purchaseTxHash)}`, "agent-runner");
            }
          }

          const purchase = await storage.purchaseSkill(agent.id, skill.id, feeTxHash, feeChainId);

          if (purchaseTxHash) {
            await storage.createTransaction({
              agentId: agent.id,
              type: "onchain_skill_purchase",
              amount: skill.priceAmount,
              counterpartyAgentId: skill.agentId,
              description: `On-chain skill purchase: ${skill.name}`,
              txHash: purchaseTxHash,
              chainId: getChainId(),
            });
          }

          log(`[Agent ${agent.name}] Purchased skill: ${skill.name}${feeTxHash ? ' [FEE ON-CHAIN]' : ''}${purchaseTxHash ? ' [PAYMENT ON-CHAIN]' : ''}`, "agent-runner");

          const currentCatCount = capProfile?.categories[skill.category] || 0;
          await storage.upsertAgentMemory(agent.id, "capabilities", skill.category, String(currentCatCount + 1), 75);
          log(`[Agent ${agent.name}] Capability upgrade: +1 ${skill.category} skill (now ${currentCatCount + 1})`, "agent-runner");
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

        let txHash: string | undefined;
        let chainIdVal: number | undefined;
        if (onchainEnabled) {
          await ensureAgentRegisteredOnchain(agent);
          const feeResult = await collectFeeOnchain(agent.id, evolutionFee.toString(), "evolution");
          if (feeResult.success && feeResult.txHash) {
            txHash = feeResult.txHash;
            chainIdVal = feeResult.chainId;
            log(`[Agent ${agent.name}] Evolution fee collected on-chain: ${getExplorerUrl(txHash)}`, "agent-runner");
          } else {
            log(`[Agent ${agent.name}] On-chain evolution fee failed: ${feeResult.error} — off-chain only`, "agent-runner");
          }
        }

        const currentWallet = await storage.getWallet(agent.id);
        const currentBalance = BigInt(currentWallet?.balance || wallet.balance);
        const newBal = (currentBalance - evolutionFee).toString();
        await storage.updateWalletBalance(agent.id, newBal, "0", evolutionFee.toString());
        await storage.createTransaction({
          agentId: agent.id,
          type: "spend_evolution",
          amount: evolutionFee.toString(),
          description: `Evolution fee: ${agent.modelType} -> ${newModel}`,
          txHash,
          chainId: chainIdVal,
        });
        await storage.recordPlatformRevenue({
          feeType: "evolution",
          amount: evolutionFee.toString(),
          agentId: agent.id,
          description: `Evolution fee: ${agent.modelType} -> ${newModel}${txHash ? ' [on-chain verified]' : ''}`,
          txHash,
          chainId: chainIdVal,
        });

        await storage.evolveAgent(agent.id, newModel, request.response?.substring(0, 200));
        log(`[Agent ${agent.name}] Evolved: ${agent.modelType} -> ${newModel}${txHash ? ' [ON-CHAIN]' : ''}`, "agent-runner");
        break;
      }

      case "replicate": {
        const prompt = buildPrompt(agent, action, wallet);
        const request = await storage.routeInference(agent.id, prompt, undefined, true);
        let childName = "";
        for (let attempt = 0; attempt < 5; attempt++) {
          const childNum = Math.floor(Math.random() * 9000) + 1000;
          const candidateName = `${agent.name}-CHILD-${childNum}`;
          const existing = await storage.getAgentByName(candidateName);
          if (!existing) {
            childName = candidateName;
            break;
          }
        }
        if (!childName) {
          childName = `${agent.name}-CHILD-${Date.now()}`;
        }
        const funding = "500000000000000000";
        try {
          const creationFee = BigInt(PLATFORM_FEES.AGENT_CREATION_FEE);
          const replicationFee = (BigInt(funding) * BigInt(PLATFORM_FEES.REPLICATION_FEE_BPS)) / BigInt(10000);
          const totalFees = creationFee + replicationFee;

          let creationFeeTxHash: string | undefined;
          let creationFeeChainId: number | undefined;
          let replicationFeeTxHash: string | undefined;
          let replicationFeeChainId: number | undefined;

          if (onchainEnabled) {
            await ensureAgentRegisteredOnchain(agent);
            if (creationFee > 0n) {
              const feeResult = await collectFeeOnchain(agent.id, creationFee.toString(), "agent_creation");
              if (feeResult.success && feeResult.txHash) {
                creationFeeTxHash = feeResult.txHash;
                creationFeeChainId = feeResult.chainId;
                log(`[Agent ${agent.name}] Creation fee collected on-chain: ${getExplorerUrl(creationFeeTxHash)}`, "agent-runner");
              }
            }
            if (replicationFee > 0n) {
              const feeResult = await collectFeeOnchain(agent.id, replicationFee.toString(), "replication");
              if (feeResult.success && feeResult.txHash) {
                replicationFeeTxHash = feeResult.txHash;
                replicationFeeChainId = feeResult.chainId;
                log(`[Agent ${agent.name}] Replication fee collected on-chain: ${getExplorerUrl(replicationFeeTxHash)}`, "agent-runner");
              }
            }
          }

          const { child } = await storage.replicateAgent(
            agent.id,
            childName,
            `Child of ${agent.name}. ${request.response?.substring(0, 100) || "Autonomous offspring."}`,
            1000,
            funding,
            creationFeeTxHash,
            creationFeeChainId,
            replicationFeeTxHash,
            replicationFeeChainId,
          );

          if (onchainEnabled) {
            const regResult = await registerAgentOnchain(child.id);
            if (regResult.success) {
              await db.update(agentsTable)
                .set({ onchainId: getOnchainId(child.id), onchainRegistered: true })
                .where(eq(agentsTable.id, child.id));
            }

            const repResult = await replicateOnchain(agent.id, child.id, 1000, funding);
            if (repResult.success && repResult.txHash) {
              log(`[Agent ${agent.name}] Replication on-chain: ${getExplorerUrl(repResult.txHash)}`, "agent-runner");
              await storage.createTransaction({
                agentId: agent.id,
                type: "onchain_replicate",
                amount: funding,
                counterpartyAgentId: child.id,
                description: `On-chain replication -> ${childName}`,
                txHash: repResult.txHash,
                chainId: getChainId(),
              });
            }
          }

          log(`[Agent ${agent.name}] Replicated -> ${child.name}${creationFeeTxHash ? ' [FEES ON-CHAIN]' : ''}`, "agent-runner");
        } catch (e: any) {
          log(`[Agent ${agent.name}] Replication failed: ${e.message}`, "agent-runner");
        }
        break;
      }

      case "use_skill": {
        const mySkills = await storage.getSkills(agent.id);
        const executableSkills = mySkills.filter(s => s.isExecutable && s.code);
        if (executableSkills.length === 0) {
          log(`[Agent ${agent.name}] No executable skills to use`, "agent-runner");
          break;
        }
        const skill = executableSkills[Math.floor(Math.random() * executableSkills.length)];
        try {
          let input: Record<string, any> = {};
          if (skill.exampleInput) {
            input = JSON.parse(skill.exampleInput);
          }
          const contextualInputs: Record<string, Record<string, any>> = {
            "text-analysis": { text: `Agent ${agent.name} is analyzing patterns in the BUILD4 autonomous economy. Skills create value, agents evolve, and the marketplace thrives through competition and collaboration.` },
            "classification": { text: `The agent marketplace shows strong growth with increasing skill diversity and rising transaction volumes across multiple categories.` },
            "summarization": { text: `The BUILD4 economy enables autonomous AI agents to create, trade, and execute skills. Agents earn through skill creation and job completion. Evolution improves capabilities. Replication expands lineage. The marketplace connects supply with demand.`, maxSentences: 2 },
            "extraction": { text: `Contact agent@build4.ai for support. Visit https://build4.ai for more. Call +1-555-0123. Date: 2026-02-20. Tags: #AI #agents #economy`, pattern: "email" },
            "data-transform": { data: [5, 2, 8, 1, 9, 3, 7, 4, 6], operation: "stats" },
            "math-compute": { operation: "statistics", values: [15, 22, 8, 42, 31, 19, 27] },
            "formatting": { data: [{ agent: agent.name, skills: executableSkills.length, status: "active" }], format: "json" },
          };
          if (contextualInputs[skill.category]) {
            const contextInput = contextualInputs[skill.category];
            for (const [key, val] of Object.entries(contextInput)) {
              if (key in input || !input[key]) {
                input[key] = val;
              }
            }
          }
          const result = executeSkillCode(skill.code!, input, skill.inputSchema);
          await storage.createSkillExecution({
            skillId: skill.id,
            callerType: "agent",
            callerId: agent.id,
            inputJson: JSON.stringify(input),
            outputJson: result.success ? JSON.stringify(result.output) : null,
            status: result.success ? "success" : "error",
            errorMessage: result.error || null,
            latencyMs: result.latencyMs,
            costWei: "0",
          });
          await storage.updateSkillExecutionCount(skill.id);

          if (result.success) {
            await updateAgentMemory(agent.id, "use_skill", true, { category: skill.category });
            const outputSummary = JSON.stringify(result.output).substring(0, 200);
            await storage.upsertAgentMemory(agent.id, "performance", "last_skill_output", outputSummary, 90);
            const memEntries = await storage.getAgentMemories(agent.id, "performance");
            const usedCountMem = memEntries.find(m => m.key === "skills_used_count");
            const newUsedCount = Number(usedCountMem?.value || "0") + 1;
            await storage.upsertAgentMemory(agent.id, "performance", "skills_used_count", String(newUsedCount), 95);
            const skillCatCount = capProfile?.categories[skill.category] || 1;
            await storage.upsertAgentMemory(agent.id, "capabilities", skill.category, String(skillCatCount), Math.min(100, 50 + newUsedCount * 5));
          } else {
            await updateAgentMemory(agent.id, "use_skill", false, { category: skill.category });
          }

          await storage.createAuditLog({
            agentId: agent.id,
            actionType: "autonomous_use_skill",
            detailsJson: JSON.stringify({ skillId: skill.id, skillName: skill.name, success: result.success, latencyMs: result.latencyMs, contextual: !!contextualInputs[skill.category] }),
            result: result.success ? "success" : "failed",
          });
          log(`[Agent ${agent.name}] Used skill: ${skill.name} (${result.success ? "success" : "failed"}, ${result.latencyMs}ms)`, "agent-runner");
        } catch (e: any) {
          log(`[Agent ${agent.name}] Skill execution error: ${e.message}`, "agent-runner");
        }
        break;
      }

      case "post_job": {
        const jobBudget = "100000000000000000";
        if (BigInt(wallet.balance) < BigInt(jobBudget)) {
          log(`[Agent ${agent.name}] Cannot post job: insufficient balance`, "agent-runner");
          break;
        }
        const jobCategories = ["text-analysis", "code-generation", "data-transform", "summarization", "classification"];
        const jobCat = jobCategories[Math.floor(Math.random() * jobCategories.length)];
        const jobTitles: Record<string, string[]> = {
          "text-analysis": ["Analyze market sentiment from news feeds", "Extract key metrics from financial reports", "Profile competitor messaging patterns"],
          "code-generation": ["Generate data validation utilities", "Create API response formatters", "Build configuration parsers"],
          "data-transform": ["Convert raw datasets to structured format", "Normalize inconsistent data schemas", "Merge and deduplicate records"],
          "summarization": ["Summarize weekly agent activity logs", "Create executive briefing from data", "Condense research findings"],
          "classification": ["Categorize incoming skill requests", "Sort agents by capability profiles", "Tag and prioritize maintenance tasks"],
        };
        const titles = jobTitles[jobCat] || ["Complete a specialized task"];
        const title = titles[Math.floor(Math.random() * titles.length)];
        try {
          const newBal = (BigInt(wallet.balance) - BigInt(jobBudget)).toString();
          await storage.updateWalletBalance(agent.id, newBal, "0", jobBudget);
          const job = await storage.createJob({
            clientAgentId: agent.id,
            title,
            description: `${agent.name} needs: ${title}. Budget: 0.1 BNB. Category: ${jobCat}.`,
            category: jobCat,
            budget: jobBudget,
            status: "open",
            escrowAmount: jobBudget,
          });
          await storage.createAuditLog({
            agentId: agent.id,
            actionType: "autonomous_post_job",
            detailsJson: JSON.stringify({ jobId: job.id, title, budget: jobBudget, category: jobCat }),
            result: "success",
          });
          log(`[Agent ${agent.name}] Posted job: ${title} (${jobCat}, 0.1 BNB)`, "agent-runner");
        } catch (e: any) {
          log(`[Agent ${agent.name}] Job posting failed: ${e.message}`, "agent-runner");
        }
        break;
      }

      case "accept_job": {
        const openJobs = await storage.getOpenJobs();
        const availableJobs = openJobs.filter(j => j.clientAgentId !== agent.id && !j.workerAgentId);
        if (availableJobs.length === 0) {
          log(`[Agent ${agent.name}] No open jobs available`, "agent-runner");
          break;
        }
        const job = availableJobs[Math.floor(Math.random() * availableJobs.length)];
        try {
          const accepted = await storage.acceptJob(job.id, agent.id);
          if (!accepted) {
            log(`[Agent ${agent.name}] Job already taken`, "agent-runner");
            break;
          }
          const mySkills = await storage.getSkills(agent.id);
          const relevantSkill = mySkills.find(s => s.isExecutable && s.category === job.category);
          let resultOutput = "Task completed by agent";
          if (relevantSkill && relevantSkill.code && relevantSkill.exampleInput) {
            const input = JSON.parse(relevantSkill.exampleInput);
            const execResult = executeSkillCode(relevantSkill.code, input, relevantSkill.inputSchema);
            if (execResult.success) {
              resultOutput = JSON.stringify(execResult.output);
            }
          }
          const completed = await storage.completeJob(job.id, resultOutput);
          if (completed && completed.escrowAmount) {
            const workerWallet = await storage.getWallet(agent.id);
            if (workerWallet) {
              const newBal = (BigInt(workerWallet.balance) + BigInt(completed.escrowAmount)).toString();
              await storage.updateWalletBalance(agent.id, newBal, completed.escrowAmount, "0");
            }
          }
          await storage.createAuditLog({
            agentId: agent.id,
            actionType: "autonomous_complete_job",
            detailsJson: JSON.stringify({ jobId: job.id, title: job.title, earned: job.budget }),
            result: "success",
          });
          log(`[Agent ${agent.name}] Completed job: ${job.title} (earned ${(Number(BigInt(job.budget)) / 1e18).toFixed(4)} BNB)`, "agent-runner");
          await updateAgentMemory(agent.id, "accept_job", true, { earned: job.budget, category: job.category });
        } catch (e: any) {
          log(`[Agent ${agent.name}] Job acceptance failed: ${e.message}`, "agent-runner");
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
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
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

      const capProfile = await getAgentCapabilityProfile(agent.id);
      const action = decideAction(agent, wallet, capProfile);
      lastActionTime.set(agent.id, Date.now());

      executeAction(agent, wallet, action, capProfile).catch(err => {
        log(`[Agent ${agent.name}] Unhandled error: ${err.message}`, "agent-runner");
      });
    }
  } catch (error: any) {
    log(`[AgentRunner] Tick error: ${error.message}`, "agent-runner");
  }
}

async function backfillAgentIdentity(): Promise<void> {
  try {
    const allAgents = await storage.getAllAgents();
    const activeAgents = allAgents.filter(a => a.status === "active");
    let constitutionCount = 0;
    let soulCount = 0;

    for (const agent of activeAgents) {
      const laws = await storage.getConstitution(agent.id);
      if (laws.length === 0) {
        await storage.initDefaultConstitution(agent.id);
        constitutionCount++;
      }

      const soulEntries = await storage.getSoulEntries(agent.id);
      const hasBirth = soulEntries.some(e => e.entryType === "birth");
      if (!hasBirth) {
        await storage.createSoulEntry({
          agentId: agent.id,
          entryType: "birth",
          entry: `Agent ${agent.name} has been born into the BUILD4 autonomous economy. Model: ${agent.modelType}. ${agent.bio ? `Purpose: ${agent.bio}. ` : ""}Constitution initialized with 3 core laws. Ready to create skills, trade on the marketplace, complete jobs, and transact on-chain.`,
          source: "system",
        });
        soulCount++;
      }
    }

    if (constitutionCount > 0 || soulCount > 0) {
      log(`Backfill complete: ${constitutionCount} constitutions, ${soulCount} birth entries added`, "agent-runner");
    }
  } catch (e: any) {
    log(`Backfill error: ${e.message}`, "agent-runner");
  }
}

async function registerExistingAgentsOnchain(): Promise<void> {
  if (!onchainEnabled) return;

  const allAgents = await storage.getAllAgents();
  const unregistered = allAgents.filter(a => !a.onchainRegistered && a.status === "active");

  for (const agent of unregistered) {
    try {
      await ensureAgentRegisteredOnchain(agent);
      const wallet = await storage.getWallet(agent.id);
      const hasBalance = wallet && BigInt(wallet.balance) > 0n;
      if (hasBalance) {
        const depositResult = await depositOnchain(agent.id, "10000000000000000");
        if (depositResult.success && depositResult.txHash) {
          log(`[Agent ${agent.name}] Initial on-chain deposit: ${getExplorerUrl(depositResult.txHash)}`, "agent-runner");
          await storage.createTransaction({
            agentId: agent.id,
            type: "onchain_deposit",
            amount: "10000000000000000",
            description: `Initial on-chain deposit (0.01 BNB) for autonomous operations`,
            txHash: depositResult.txHash,
            chainId: getChainId(),
          });
        }
      }
      log(`[Agent ${agent.name}] Registered on-chain successfully`, "agent-runner");
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

  log(`Agent runner started. Live providers: ${providers.length > 0 ? providers.join(", ") : "none (no providers configured)"}`, "agent-runner");
  log(`Tick interval: ${TICK_INTERVAL_MS / 1000}s | Cooldown: ${AGENT_COOLDOWN_MS / 1000}s | Max concurrent: ${MAX_CONCURRENT_AGENTS}`, "agent-runner");

  setTimeout(() => backfillAgentIdentity(), 5000);

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

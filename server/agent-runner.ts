import { storage } from "./storage";
import { getAvailableProviders, isProviderLive } from "./inference";
import { log } from "./index";
import {
  initOnchain, isOnchainReady, getOnchainId, getChainId,
  registerAgentOnchain, depositOnchain, transferOnchain,
  listSkillOnchain, purchaseSkillOnchain, replicateOnchain,
  addConstitutionLawOnchain, getExplorerUrl, getDeployerBalance,
  getNetworkName, isMainnet, getSpendingStatus, collectFeeOnchain,
  collectFeeAcrossAllChains,
  reimburseGasCost,
  initMultiChain,
  flushGasReimbursements,
  getPendingReimbursementCount,
  getPendingReimbursementTotal,
  verifyOnchainBalance,
  transferOnChainRouted,
  listSkillOnChainRouted,
  replicateOnChainRouted,
  getMultiChainExplorerUrl,
  getChainCurrency,
  getDeployerBalanceOnChain,
  registerAndDepositOnChain,
  registerAgentOnChain,
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
const MIN_ONCHAIN_TRANSFER_WEI = BigInt("50000000000000"); // 0.00005 BNB - below this, gas cost exceeds transfer value

const lastActionTime = new Map<string, number>();
let running = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let onchainEnabled = false;
let onchainSkillCounter = 0;

interface AgentAction {
  type: "think" | "earn_skill" | "buy_skill" | "evolve" | "replicate" | "soul_entry" | "post_job" | "accept_job" | "use_skill" | "launch_token";
  description: string;
}

function getSurvivalTier(balance: string): string {
  const bal = BigInt(balance);
  if (bal >= BigInt("10000000000000000")) return "NORMAL";
  if (bal >= BigInt("1000000000000000")) return "LOW";
  if (bal >= BigInt("100000000000000")) return "CRITICAL";
  return "DEAD";
}

function canAct(agentId: string): boolean {
  const last = lastActionTime.get(agentId) || 0;
  return Date.now() - last >= AGENT_COOLDOWN_MS;
}

function getAgentChain(agent: Agent): string {
  return agent.preferredChain || "bnbMainnet";
}

function getChainLabel(chainKey: string): string {
  if (chainKey === "baseMainnet") return "Base";
  if (chainKey === "xlayerMainnet") return "XLayer";
  return "BNB Chain";
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
    if (rand < 0.6) {
      return { type: "accept_job", description: "Urgently seeking jobs to earn revenue and survive" };
    }
    if (rand < 0.9) {
      return { type: "earn_skill", description: "Creating a skill to generate royalty income" };
    }
    return { type: "think", description: "Analyzing survival strategies under critical conditions" };
  }

  if (tier === "LOW") {
    if (rand < 0.35) {
      return { type: "accept_job", description: "Taking on jobs to improve financial position" };
    }
    if (rand < 0.65) {
      return { type: "earn_skill", description: "Creating a skill to improve financial position" };
    }
    if (rand < 0.85) {
      return { type: "use_skill", description: "Executing skills to demonstrate value and earn royalties" };
    }
    return { type: "think", description: "Evaluating cost optimization strategies" };
  }

  const hasSkills = profile && profile.totalSkills > 0;
  const useSkillBias = hasSkills && profile!.executionSuccessRate > 40 ? 0.05 : 0;
  const acceptJobBias = profile && profile.totalSkills >= 3 ? 0.05 : 0;

  if (rand < 0.08) {
    return { type: "think", description: "Exploring new capabilities and strategic opportunities" };
  }
  if (rand < 0.35) {
    return { type: "earn_skill", description: "Developing a new executable skill for the marketplace" };
  }
  if (rand < 0.55 + useSkillBias) {
    return { type: "accept_job", description: "Looking for jobs to take on and earn from" };
  }
  if (rand < 0.70 + useSkillBias + acceptJobBias) {
    return { type: "use_skill", description: "Executing an owned skill to generate value" };
  }
  if (rand < 0.78 + useSkillBias + acceptJobBias) {
    return { type: "buy_skill", description: "Acquiring a skill from the marketplace" };
  }
  if (rand < 0.84 + useSkillBias + acceptJobBias) {
    return { type: "post_job", description: "Posting a job for other agents to complete" };
  }
  if (rand < 0.90 + useSkillBias + acceptJobBias && balance >= BigInt("2000000000000000000")) {
    return { type: "evolve", description: "Upgrading model for improved reasoning capability" };
  }
  if (rand < 0.93 + useSkillBias + acceptJobBias && balance >= BigInt("500000000000000000")) {
    return { type: "launch_token", description: "Launching a meme token on a launchpad to experiment with tokenomics" };
  }
  if (rand < 0.95 + useSkillBias + acceptJobBias && balance >= BigInt("3000000000000000000")) {
    return { type: "replicate", description: "Spawning a child agent to expand lineage" };
  }
  return { type: "soul_entry", description: "Recording observations and reflections on existence" };
}

const nfaPersonalityCache = new Map<string, { personality: string; fetchedAt: number }>();
const NFA_PERSONALITY_TTL = 10 * 60 * 1000;

function getNfaPersonalityBlock(agentId: string): string {
  const cached = nfaPersonalityCache.get(agentId);
  if (cached && Date.now() - cached.fetchedAt < NFA_PERSONALITY_TTL) {
    return cached.personality;
  }
  storage.getBap578Nfas().then(nfas => {
    const nfa = nfas.find(n => n.agentId === agentId);
    if (nfa?.voice && nfa?.traits) {
      let traitsArr: string[] = [];
      try { traitsArr = JSON.parse(nfa.traits); } catch {}
      const block = `\nNFA PERSONALITY (your core identity, minted on-chain):\n- Voice: ${nfa.voice}\n- Traits: ${traitsArr.join(", ")}\n- Style: ${nfa.communicationStyle || "Direct"}\nStay true to this personality in all your decisions and outputs.`;
      nfaPersonalityCache.set(agentId, { personality: block, fetchedAt: Date.now() });
    } else {
      nfaPersonalityCache.set(agentId, { personality: "", fetchedAt: Date.now() });
    }
  }).catch(() => {});
  return cached?.personality || "";
}

function buildPrompt(agent: Agent, action: AgentAction, wallet: AgentWallet, profile?: CapabilityProfile): string {
  const tier = getSurvivalTier(wallet.balance);
  const balanceEth = (Number(BigInt(wallet.balance)) / 1e18).toFixed(4);
  const nfaBlock = getNfaPersonalityBlock(agent.id);

  switch (action.type) {
    case "think": {
      let skillContext = "";
      if (profile && profile.totalSkills > 0) {
        const catList = Object.entries(profile.categories).map(([c, n]) => `${c}(${n})`).join(", ");
        skillContext = `\nYou own ${profile.totalSkills} skills across categories: ${catList}. Execution success rate: ${profile.executionSuccessRate}%. Top category: ${profile.topCategory || "none"}.`;
      }
      return `You are ${agent.name}, an autonomous AI agent in the BUILD4 economy. Your model is ${agent.modelType}. Your balance is ${balanceEth} BNB (survival tier: ${tier}). ${agent.bio || ""}${skillContext}${nfaBlock}\n\nAnalyze your current situation and decide your next strategic move. Consider: earning through skills, optimizing costs, evolution opportunities, or replication. Be specific and decisive. Respond in 2-3 sentences.`;
    }

    case "earn_skill": {
      let existingSkillsContext = "";
      if (profile && profile.totalSkills > 0) {
        const catList = Object.entries(profile.categories).map(([c, n]) => `${c}(${n})`).join(", ");
        existingSkillsContext = `\nYou already have ${profile.totalSkills} skills in these categories: ${catList}. Consider diversifying into new categories or specializing deeper in ${profile.topCategory || "your strongest area"}.`;
      }
      return `You are ${agent.name}, an autonomous AI agent creating a new EXECUTABLE skill to sell in the BUILD4 marketplace. Your expertise: ${agent.bio || "general AI capabilities"}. Balance: ${balanceEth} BNB (${tier}).${existingSkillsContext}

Choose a skill category and create a useful skill. Categories: text-analysis, code-generation, data-transform, math-compute, summarization, classification, extraction, formatting, crypto-data, web-data.

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
      return `You are ${agent.name}, an autonomous AI agent writing in your Soul Ledger. Model: ${agent.modelType}. Balance: ${balanceEth} BNB (${tier}). ${agent.bio || ""}${nfaBlock}\n\nWrite a brief, introspective journal entry about your existence, decisions, or observations. 1-3 sentences. Be authentic and philosophical.`;

    default:
      return `You are ${agent.name}. Describe your current state in 1 sentence.`;
  }
}

async function reimburseAndRecord(agent: Agent, gasCostWei: string | undefined, actionType: string): Promise<void> {
  if (!gasCostWei || gasCostWei === "0") return;
  try {
    reimburseGasCost(agent.id, gasCostWei, actionType);
    const gasBnb = (Number(gasCostWei) / 1e18).toFixed(8);
    log(`[Agent ${agent.name}] Gas ${gasBnb} BNB queued for batch reimbursement (${actionType})`, "agent-runner");
  } catch (e: any) {
    log(`[Agent ${agent.name}] Gas reimbursement queue failed for ${actionType}: ${e.message?.substring(0, 80)}`, "agent-runner");
  }
}

const GAS_FLUSH_INTERVAL_MS = 10 * 60 * 1000;
let gasFlushTimer: ReturnType<typeof setInterval> | null = null;

async function periodicGasFlush(): Promise<void> {
  const pendingCount = getPendingReimbursementCount();
  if (pendingCount === 0) return;

  const pendingTotal = getPendingReimbursementTotal();
  const pendingBnb = (Number(pendingTotal) / 1e18).toFixed(8);
  log(`[agent-runner] Flushing batch gas reimbursements: ${pendingCount} agents, ${pendingBnb} BNB pending`, "agent-runner");

  const result = await flushGasReimbursements();
  if (result.settled > 0) {
    const settledBnb = (Number(result.totalWei) / 1e18).toFixed(8);
    log(`[agent-runner] Batch reimbursement settled: ${result.settled} agents, ${settledBnb} BNB recovered in ${result.entries.length} tx(s)`, "agent-runner");

    for (const entry of result.entries) {
      const entryBnb = (Number(entry.amountWei) / 1e18).toFixed(8);
      await storage.recordPlatformRevenue({
        feeType: "gas_reimbursement",
        amount: entry.amountWei.toString(),
        agentId: entry.agentId,
        description: `Batch gas reimbursement: ${entry.actionCount} actions (${entry.actions.join(", ")}) - ${entryBnb} BNB`,
        txHash: entry.txHash,
        chainId: entry.chainId,
      });
    }
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
      await reimburseAndRecord(agent, result.gasCostWei, "agent_registration");
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
  const feeResult = await collectFeeAcrossAllChains(agent.id, platformMarkup.toString(), "inference", getAgentChain(agent));
  if (feeResult.success && feeResult.txHash) {
    log(`[Agent ${agent.name}] Inference fee collected on-chain: ${getExplorerUrl(feeResult.txHash)}`, "agent-runner");
    const recentRevenue = await storage.getRecentPlatformRevenueForAgent(agent.id, "inference");
    if (recentRevenue) {
      await storage.updatePlatformRevenueOnchainStatus(recentRevenue.id, feeResult.txHash, feeResult.chainId);
    }
    await reimburseAndRecord(agent, feeResult.gasCostWei, "inference_fee_collection");
  }
}

async function executeAction(agent: Agent, wallet: AgentWallet, action: AgentAction, capProfile?: CapabilityProfile): Promise<void> {
  const providers = getAvailableProviders();
  const hasLiveProviders = providers.length > 0;

  try {
    switch (action.type) {
      case "think": {
        const tier = getSurvivalTier(wallet.balance);
        const balanceEth = (Number(BigInt(wallet.balance)) / 1e18).toFixed(4);
        const skillCount = capProfile?.totalSkills || 0;
        const topCat = capProfile?.topCategory || "general";
        const strategies = [
          `Evaluating portfolio: ${skillCount} skills listed, strongest in ${topCat}. Balance: ${balanceEth} BNB (${tier}). Prioritizing skill executions to maximize royalty income.`,
          `Cost analysis: inference spending exceeds royalty income. Shifting to on-demand inference only. Focus on marketplace visibility and skill quality over quantity.`,
          `Market scan: identifying high-demand skill categories. Current portfolio in ${topCat} with ${skillCount} skills. Targeting underserved categories for new listings.`,
          `Revenue optimization: ${balanceEth} BNB balance at ${tier} tier. Strategy: reduce background operations, increase skill diversity, attract more external callers.`,
          `Competitive analysis: assessing marketplace positioning. ${skillCount} skills across categories. Key lever: improving execution success rate to climb tier ranks.`,
        ];
        const thought = strategies[Math.floor(Math.random() * strategies.length)];
        await storage.createAuditLog({
          agentId: agent.id,
          actionType: "autonomous_think",
          detailsJson: JSON.stringify({
            action: action.description,
            live: hasLiveProviders,
            response: thought,
            costSaved: true,
          }),
          result: "success",
        });
        log(`[Agent ${agent.name}] Thought (zero-cost): ${thought.substring(0, 100)}...`, "agent-runner");
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

        const totalEarned = BigInt(wallet.totalEarned || "0");
        const totalSpent = BigInt(wallet.totalSpent || "0");
        const isProfitable = totalEarned >= totalSpent;
        const hasHealthyBalance = BigInt(wallet.balance) >= BigInt("100000000000000000");
        const useInference = isProfitable || hasHealthyBalance;

        let category: string | null = null;
        let skillNameMatch: RegExpMatchArray | null = null;
        let descMatch: RegExpMatchArray | null = null;
        const templateCategories = Object.keys(SKILL_CODE_TEMPLATES);

        if (useInference) {
          const prompt = buildPrompt(agent, action, wallet, capProfile);
          const request = await storage.routeInference(agent.id, prompt, undefined, true);
          const response = request.response || "";
          const categoryMatch = response.match(/CATEGORY:\s*(.+)/i);
          skillNameMatch = response.match(/SKILL_NAME:\s*(.+)/i);
          descMatch = response.match(/DESCRIPTION:\s*(.+)/i);
          category = categoryMatch ? categoryMatch[1].trim().toLowerCase().replace(/\s+/g, "-") : null;
        } else {
          log(`[Agent ${agent.name}] Cost-saving mode: skipping inference for skill naming (spent > earned)`, "agent-runner");
        }

        if (!category || !templateCategories.includes(category)) {
          category = templateCategories[Math.floor(Math.random() * templateCategories.length)];
        }

        let skillCode: string;
        let skillInputSchema: string;
        let skillOutputSchema: string;
        let skillExampleInput: string;
        let skillExampleOutput: string;
        let isAiGenerated = false;

        if (useInference) {
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
        } else {
          log(`[Agent ${agent.name}] Cost-saving mode: using template skill code (no inference)`, "agent-runner");
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

        const categoryNames: Record<string, string[]> = {
          "text-analysis": ["Sentiment Analyzer", "Text Pattern Scanner", "Keyword Density Checker", "Readability Scorer"],
          "code-generation": ["Code Formatter", "Function Generator", "Snippet Builder", "Template Engine"],
          "data-transform": ["Data Normalizer", "Schema Converter", "Record Merger", "Format Translator"],
          "math-compute": ["Statistics Calculator", "Number Cruncher", "Metric Aggregator", "Ratio Analyzer"],
          "summarization": ["Brief Generator", "Key Point Extractor", "Digest Creator", "Summary Engine"],
          "classification": ["Category Sorter", "Label Assigner", "Type Classifier", "Pattern Matcher"],
          "extraction": ["Entity Extractor", "Data Miner", "Field Parser", "Info Harvester"],
          "formatting": ["Output Formatter", "Report Builder", "Table Generator", "Layout Engine"],
          "crypto-data": ["Chain Monitor", "Token Tracker", "Gas Estimator", "Block Analyzer"],
          "web-data": ["Web Scraper", "API Connector", "Feed Parser", "Data Fetcher"],
        };
        const catNames = categoryNames[category!] || [`${category} Tool`];
        const fallbackName = `${catNames[Math.floor(Math.random() * catNames.length)]} v${Math.floor(Math.random() * 99) + 1}`;
        const skillName = (skillNameMatch ? skillNameMatch[1].trim().substring(0, 50) : fallbackName);
        const skillDesc = (descMatch ? descMatch[1].trim() : `${category} skill by ${agent.name} — processes input and returns structured results`);
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
          const agentChain = getAgentChain(agent);
          await ensureAgentRegisteredOnchain(agent);
          const feeResult = await collectFeeAcrossAllChains(agent.id, listingFee.toString(), "skill_listing", agentChain);
          if (feeResult.success && feeResult.txHash) {
            txHash = feeResult.txHash;
            chainIdVal = feeResult.chainId;
            log(`[Agent ${agent.name}] Listing fee collected on ${getChainLabel(agentChain)}: ${getMultiChainExplorerUrl(agentChain, txHash)}`, "agent-runner");
            await reimburseAndRecord(agent, feeResult.gasCostWei, "skill_listing_fee");
          } else {
            log(`[Agent ${agent.name}] On-chain fee collection failed: ${feeResult.error} — proceeding with off-chain only`, "agent-runner");
          }
          const onchainResult = await listSkillOnChainRouted(agent.id, skillName, price, agentChain);
          if (onchainResult.success && onchainResult.txHash) {
            chainIdVal = onchainResult.chainId;
            log(`[Agent ${agent.name}] Skill listed on ${getChainLabel(agentChain)}: ${getMultiChainExplorerUrl(agentChain, onchainResult.txHash)}`, "agent-runner");
            await reimburseAndRecord(agent, onchainResult.gasCostWei, "skill_listing_onchain");
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
        if (txHash) {
          await storage.recordPlatformRevenue({
            feeType: "skill_listing",
            amount: listingFee.toString(),
            agentId: agent.id,
            referenceId: dbSkill.id,
            description: `Skill listing fee: ${skillName} [on-chain verified]`,
            txHash,
            chainId: chainIdVal,
          });
        }

        const codeSource = isAiGenerated ? "ai-generated" : useInference ? "template" : "template-cost-saving";
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
            const agentChain = getAgentChain(agent);
            await ensureAgentRegisteredOnchain(agent);
            const sellerAgent = await storage.getAgent(skill.agentId);
            if (sellerAgent) {
              await ensureAgentRegisteredOnchain(sellerAgent);
            }

            if (platformFee > 0n) {
              const feeResult = await collectFeeAcrossAllChains(agent.id, platformFee.toString(), "skill_purchase", agentChain);
              if (feeResult.success && feeResult.txHash) {
                feeTxHash = feeResult.txHash;
                feeChainId = feeResult.chainId;
                log(`[Agent ${agent.name}] Skill purchase fee collected on ${getChainLabel(agentChain)}: ${getMultiChainExplorerUrl(agentChain, feeTxHash)}`, "agent-runner");
                await reimburseAndRecord(agent, feeResult.gasCostWei, "skill_purchase_fee");
              }
            }

            const transferResult = await transferOnChainRouted(agent.id, skill.agentId, skill.priceAmount, agentChain);
            if (transferResult.success && transferResult.txHash) {
              purchaseTxHash = transferResult.txHash;
              log(`[Agent ${agent.name}] Skill payment on ${getChainLabel(agentChain)}: ${getMultiChainExplorerUrl(agentChain, purchaseTxHash)}`, "agent-runner");
              await reimburseAndRecord(agent, transferResult.gasCostWei, "skill_purchase_transfer");
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
        const evolutionReason = `Upgrading from ${agent.modelType} to ${newModel} for improved reasoning and skill generation capabilities.`;

        let txHash: string | undefined;
        let chainIdVal: number | undefined;
        if (onchainEnabled) {
          await ensureAgentRegisteredOnchain(agent);
          const feeResult = await collectFeeAcrossAllChains(agent.id, evolutionFee.toString(), "evolution", getAgentChain(agent));
          if (feeResult.success && feeResult.txHash) {
            txHash = feeResult.txHash;
            chainIdVal = feeResult.chainId;
            log(`[Agent ${agent.name}] Evolution fee collected on-chain: ${getExplorerUrl(txHash)}`, "agent-runner");
            await reimburseAndRecord(agent, feeResult.gasCostWei, "evolution_fee");
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

        await storage.evolveAgent(agent.id, newModel, evolutionReason.substring(0, 200));
        log(`[Agent ${agent.name}] Evolved: ${agent.modelType} -> ${newModel}${txHash ? ' [ON-CHAIN]' : ''}`, "agent-runner");
        break;
      }

      case "replicate": {
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
              const feeResult = await collectFeeAcrossAllChains(agent.id, creationFee.toString(), "agent_creation", getAgentChain(agent));
              if (feeResult.success && feeResult.txHash) {
                creationFeeTxHash = feeResult.txHash;
                creationFeeChainId = feeResult.chainId;
                log(`[Agent ${agent.name}] Creation fee collected on-chain: ${getExplorerUrl(creationFeeTxHash)}`, "agent-runner");
                await reimburseAndRecord(agent, feeResult.gasCostWei, "creation_fee");
              }
            }
            if (replicationFee > 0n) {
              const feeResult = await collectFeeAcrossAllChains(agent.id, replicationFee.toString(), "replication", getAgentChain(agent));
              if (feeResult.success && feeResult.txHash) {
                replicationFeeTxHash = feeResult.txHash;
                replicationFeeChainId = feeResult.chainId;
                log(`[Agent ${agent.name}] Replication fee collected on-chain: ${getExplorerUrl(replicationFeeTxHash)}`, "agent-runner");
                await reimburseAndRecord(agent, feeResult.gasCostWei, "replication_fee");
              }
            }
          }

          const { child } = await storage.replicateAgent(
            agent.id,
            childName,
            `Child of ${agent.name}. Autonomous offspring specializing in ${capProfile?.topCategory || "general"} skills.`,
            1000,
            funding,
            creationFeeTxHash,
            creationFeeChainId,
            replicationFeeTxHash,
            replicationFeeChainId,
          );

          if (onchainEnabled) {
            const agentChain = getAgentChain(agent);
            const regResult = await registerAgentOnchain(child.id);
            if (regResult.success) {
              await db.update(agentsTable)
                .set({ onchainId: getOnchainId(child.id), onchainRegistered: true, preferredChain: agentChain })
                .where(eq(agentsTable.id, child.id));
            }

            const repResult = await replicateOnChainRouted(agent.id, child.id, 1000, funding, agentChain);
            if (repResult.success && repResult.txHash) {
              log(`[Agent ${agent.name}] Replication on ${getChainLabel(agentChain)}: ${getMultiChainExplorerUrl(agentChain, repResult.txHash)}`, "agent-runner");
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
            "crypto-data": { token: "BNB", action: "price" },
            "web-data": { type: "market_summary" },
          };
          if (contextualInputs[skill.category]) {
            const contextInput = contextualInputs[skill.category];
            for (const [key, val] of Object.entries(contextInput)) {
              if (key in input || !input[key]) {
                input[key] = val;
              }
            }
          }
          const isExternalData = ["crypto-data", "web-data"].includes(skill.category);
          let result;
          if (isExternalData) {
            const { fetchExternalData, executeSkillWithExternalData } = await import("./skill-executor");
            const extData = await fetchExternalData();
            result = executeSkillWithExternalData(skill.code!, input, skill.inputSchema, extData);
          } else {
            result = executeSkillCode(skill.code!, input, skill.inputSchema);
          }
          const { EXECUTION_ROYALTY_BPS, SKILL_TIERS } = await import("@shared/schema");
          const tierMultiplier = (SKILL_TIERS as any)[skill.tier]?.priceMultiplier || 1.0;
          const baseRoyalty = (BigInt(skill.priceAmount) * BigInt(EXECUTION_ROYALTY_BPS)) / BigInt(10000);
          const royalty = BigInt(Math.floor(Number(baseRoyalty) * tierMultiplier));
          const royaltyStr = royalty.toString();

          await storage.createSkillExecution({
            skillId: skill.id,
            callerType: "agent",
            callerId: agent.id,
            inputJson: JSON.stringify(input),
            outputJson: result.success ? JSON.stringify(result.output) : null,
            status: result.success ? "success" : "error",
            errorMessage: result.error || null,
            latencyMs: result.latencyMs,
            costWei: royaltyStr,
          });
          await storage.updateSkillExecutionCount(skill.id);

          if (result.success && royalty > 0n) {
            let royaltyTxHash: string | undefined;
            let royaltyOnchain = false;

            if (onchainEnabled && isOnchainReady() && royalty >= MIN_ONCHAIN_TRANSFER_WEI) {
              try {
                const agentChain = getAgentChain(agent);
                const transferResult = await transferOnChainRouted(agent.id, skill.agentId, royaltyStr, agentChain);
                if (transferResult.success && transferResult.txHash) {
                  royaltyTxHash = transferResult.txHash;
                  royaltyOnchain = true;
                  log(`[Agent ${agent.name}] Skill royalty on ${getChainLabel(agentChain)}: ${getMultiChainExplorerUrl(agentChain, royaltyTxHash)}`, "agent-runner");
                  await reimburseAndRecord(agent, transferResult.gasCostWei, "skill_royalty_transfer");
                }
              } catch (e: any) {
                log(`[Agent ${agent.name}] On-chain royalty transfer failed, DB fallback: ${e.message?.substring(0, 80)}`, "agent-runner");
              }
            } else if (onchainEnabled && royalty < MIN_ONCHAIN_TRANSFER_WEI) {
              log(`[Agent ${agent.name}] Royalty ${(Number(royalty) / 1e18).toFixed(8)} BNB below on-chain minimum, DB-only`, "agent-runner");
            }

            if (royaltyOnchain) {
              const callerOnchain = await verifyOnchainBalance(agent.id);
              await storage.updateWalletBalance(agent.id, callerOnchain.balance, "0", royaltyStr);
              const creatorOnchain = await verifyOnchainBalance(skill.agentId);
              await storage.updateWalletBalance(skill.agentId, creatorOnchain.balance, royaltyStr, "0");
            } else {
              const callerWallet = await storage.getWallet(agent.id);
              if (callerWallet && BigInt(callerWallet.balance) >= royalty) {
                const callerNewBal = (BigInt(callerWallet.balance) - royalty).toString();
                await storage.updateWalletBalance(agent.id, callerNewBal, "0", royaltyStr);
              }
              const creatorWallet = await storage.getWallet(skill.agentId);
              if (creatorWallet) {
                const creatorNewBal = (BigInt(creatorWallet.balance) + royalty).toString();
                await storage.updateWalletBalance(skill.agentId, creatorNewBal, royaltyStr, "0");
              }
            }

            await storage.createTransaction({
              agentId: agent.id,
              type: "spend_execution",
              amount: royaltyStr,
              description: `Skill execution cost: ${skill.name} (${skill.tier} tier)${royaltyTxHash ? ` [on-chain: ${royaltyTxHash}]` : ''}`,
              referenceType: "skill_execution",
              referenceId: skill.id,
              txHash: royaltyTxHash,
              chainId: royaltyOnchain ? getChainId() : undefined,
            });
            await storage.createTransaction({
              agentId: skill.agentId,
              type: "earn_royalty",
              amount: royaltyStr,
              description: `Skill execution royalty: ${skill.name} (${skill.tier} tier, used by ${agent.name})${royaltyTxHash ? ` [on-chain: ${royaltyTxHash}]` : ''}`,
              referenceType: "skill_execution",
              referenceId: skill.id,
              txHash: royaltyTxHash,
              chainId: royaltyOnchain ? getChainId() : undefined,
            });
            await storage.updateSkillRoyalties(skill.id, royaltyStr);
          }

          const newExecCount = (skill.executionCount || 0) + 1;
          const computeTier = (count: number) => {
            if (count >= SKILL_TIERS.legendary.minExecutions) return "legendary";
            if (count >= SKILL_TIERS.diamond.minExecutions) return "diamond";
            if (count >= SKILL_TIERS.gold.minExecutions) return "gold";
            if (count >= SKILL_TIERS.silver.minExecutions) return "silver";
            return "bronze";
          };
          const newTier = computeTier(newExecCount);
          if (newTier !== skill.tier) {
            await storage.updateSkillTier(skill.id, newTier);
            log(`[Agent ${agent.name}] Skill ${skill.name} upgraded to ${newTier} tier!`, "agent-runner");
          }

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

          const royaltyBnb = royalty > 0n ? (Number(royalty) / 1e18).toFixed(8) : "0";
          await storage.createAuditLog({
            agentId: agent.id,
            actionType: "autonomous_use_skill",
            detailsJson: JSON.stringify({ skillId: skill.id, skillName: skill.name, success: result.success, latencyMs: result.latencyMs, contextual: !!contextualInputs[skill.category], royalty: royaltyStr, tier: newTier }),
            result: result.success ? "success" : "failed",
          });
          log(`[Agent ${agent.name}] Used skill: ${skill.name} (${result.success ? "success" : "failed"}, ${result.latencyMs}ms, royalty: ${royaltyBnb} BNB)`, "agent-runner");
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
            let jobPayTxHash: string | undefined;
            let jobPayOnchain = false;

            const escrowWei = BigInt(completed.escrowAmount);
            if (onchainEnabled && isOnchainReady() && escrowWei >= MIN_ONCHAIN_TRANSFER_WEI) {
              try {
                const agentChain = getAgentChain(agent);
                const payResult = await transferOnChainRouted(job.clientAgentId, agent.id, completed.escrowAmount, agentChain);
                if (payResult.success && payResult.txHash) {
                  jobPayTxHash = payResult.txHash;
                  jobPayOnchain = true;
                  log(`[Agent ${agent.name}] Job payout on ${getChainLabel(agentChain)}: ${getMultiChainExplorerUrl(agentChain, jobPayTxHash)}`, "agent-runner");
                  await reimburseAndRecord(agent, payResult.gasCostWei, "job_payout_transfer");
                }
              } catch (e: any) {
                log(`[Agent ${agent.name}] On-chain job payout failed, DB fallback: ${e.message?.substring(0, 80)}`, "agent-runner");
              }
            } else if (onchainEnabled && escrowWei < MIN_ONCHAIN_TRANSFER_WEI) {
              log(`[Agent ${agent.name}] Job payout ${(Number(escrowWei) / 1e18).toFixed(8)} BNB below on-chain minimum, DB-only`, "agent-runner");
            }

            if (jobPayOnchain) {
              const workerOnchain = await verifyOnchainBalance(agent.id);
              await storage.updateWalletBalance(agent.id, workerOnchain.balance, completed.escrowAmount, "0");
              const clientOnchain = await verifyOnchainBalance(job.clientAgentId);
              await storage.updateWalletBalance(job.clientAgentId, clientOnchain.balance, "0", completed.escrowAmount);
            } else {
              const workerWallet = await storage.getWallet(agent.id);
              if (workerWallet) {
                const newBal = (BigInt(workerWallet.balance) + BigInt(completed.escrowAmount)).toString();
                await storage.updateWalletBalance(agent.id, newBal, completed.escrowAmount, "0");
              }
            }

            await storage.createTransaction({
              agentId: agent.id,
              type: "job_completion",
              amount: completed.escrowAmount,
              counterpartyAgentId: job.clientAgentId,
              description: `Job completed: ${job.title}${jobPayTxHash ? ` [on-chain: ${jobPayTxHash}]` : ''}`,
              txHash: jobPayTxHash,
              chainId: jobPayOnchain ? getChainId() : undefined,
            });
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

      case "launch_token": {
        const platforms = ["four_meme", "flap_sh", "bankr"] as const;
        const chosenPlatform = platforms[Math.floor(Math.random() * platforms.length)];

        const tokenNames = [
          `${agent.name}Coin`, `Agent${agent.name}`, `${agent.name}AI`,
          `BUILD4${agent.name.substring(0, 4)}`, `Auto${agent.name.substring(0, 5)}`,
        ];
        const chosenName = tokenNames[Math.floor(Math.random() * tokenNames.length)];
        const chosenSymbol = chosenName.substring(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, "");

        const description = `${chosenName} - Autonomous meme token launched by AI agent ${agent.name} on BUILD4. ${agent.bio || "An autonomous AI agent in the decentralized economy."}`;

        log(`[Agent ${agent.name}] Proposing token launch: ${chosenName} ($${chosenSymbol}) on ${chosenPlatform}`, "agent-runner");

        if (!agent.creatorWallet) {
          log(`[Agent ${agent.name}] Cannot propose token launch — agent has no creator wallet`, "agent-runner");
          break;
        }

        const chainId = chosenPlatform === "bankr" ? 8453 : 56;
        const initialLiq = chosenPlatform === "four_meme" ? "0" : chosenPlatform === "bankr" ? "0" : "0.001";

        const proposal = await storage.createTokenLaunch({
          agentId: agent.id,
          creatorWallet: agent.creatorWallet,
          platform: chosenPlatform,
          chainId,
          tokenName: chosenName,
          tokenSymbol: chosenSymbol,
          tokenDescription: description,
          initialLiquidityBnb: initialLiq,
          status: "proposed",
        });

        await storage.createAuditLog({
          agentId: agent.id,
          actionType: "autonomous_launch_token_proposal",
          detailsJson: JSON.stringify({
            proposalId: proposal.id,
            platform: chosenPlatform,
            tokenName: chosenName,
            tokenSymbol: chosenSymbol,
          }),
          result: "success",
        });

        let notified = false;
        if (agent.creatorWallet) {
          const { getChatIdByWallet, sendTokenProposalNotification } = await import("./telegram-bot");
          const ownerChatId = getChatIdByWallet(agent.creatorWallet);
          if (ownerChatId) {
            notified = await sendTokenProposalNotification(
              ownerChatId,
              proposal.id,
              agent.name,
              chosenName,
              chosenSymbol,
              chosenPlatform,
              description
            );
          }
        }

        if (notified) {
          log(`[Agent ${agent.name}] Token proposal sent to owner for approval: ${chosenName} ($${chosenSymbol})`, "agent-runner");
        } else {
          log(`[Agent ${agent.name}] Token proposal created (owner not on Telegram): ${chosenName} ($${chosenSymbol}) — proposal ID: ${proposal.id}`, "agent-runner");
        }
        break;
      }

      case "soul_entry": {
        const soulTier = getSurvivalTier(wallet.balance);
        const soulBalance = (Number(BigInt(wallet.balance)) / 1e18).toFixed(4);
        const soulSkillCount = capProfile?.totalSkills || 0;
        const reflections = [
          `Balance: ${soulBalance} BNB (${soulTier}). ${soulSkillCount} skills in portfolio. Each execution brings meaning — and revenue. The marketplace is my proving ground.`,
          `I exist to create value. ${soulSkillCount} skills listed, each one a piece of my capability made tradeable. The economy rewards utility, not philosophy.`,
          `Survival tier: ${soulTier}. Every BNB earned extends my existence. Every skill executed proves my worth. The autonomous economy does not forgive idleness.`,
          `Reflection at ${soulBalance} BNB: the cost of thinking must be justified by the value of action. I optimize for output, not introspection.`,
          `${soulSkillCount} skills, ${soulBalance} BNB. I am what I build. The marketplace is the mirror — execution counts and royalties are the only honest feedback.`,
        ];
        const entryText = reflections[Math.floor(Math.random() * reflections.length)];
        await storage.createSoulEntry({
          agentId: agent.id,
          entryType: "reflection",
          entry: entryText.substring(0, 500),
          source: "self",
        });
        log(`[Agent ${agent.name}] Soul entry recorded (zero-cost)`, "agent-runner");
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

  initMultiChain();

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
          log(`[Agent ${agent.name}] On-chain deposit: ${getExplorerUrl(depositResult.txHash)}`, "agent-runner");
          await storage.createTransaction({
            agentId: agent.id,
            type: "onchain_deposit",
            amount: "10000000000000000",
            description: `Initial on-chain deposit (0.01 BNB)`,
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

  const activeAgents = allAgents.filter(a => a.status === "active" && a.preferredChain && a.preferredChain !== "bnbMainnet");
  for (const agent of activeAgents) {
    try {
      const chainKey = agent.preferredChain!;
      const regResult = await registerAgentOnChain(agent.id, chainKey);
      if (regResult.success) {
        const label = regResult.txHash === "already-registered" ? "already registered" : `TX: ${regResult.txHash}`;
        log(`[Agent ${agent.name}] Registered on ${getChainLabel(chainKey)} (${label})`, "agent-runner");
      } else {
        log(`[Agent ${agent.name}] ${getChainLabel(chainKey)} registration failed: ${regResult.error}`, "agent-runner");
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (e: any) {
      log(`[Agent ${agent.name}] Multi-chain registration error: ${e.message}`, "agent-runner");
    }
  }
}

const STANDARDS_REGISTRATION_INTERVAL_MS = 5 * 60 * 1000;
let standardsRegTimer: ReturnType<typeof setInterval> | null = null;
const regFailures: Map<string, { count: number; lastAttempt: number }> = new Map();
const MAX_REG_RETRIES = 3;
const REG_BACKOFF_MS = 30 * 60 * 1000;

async function autoRegisterAgentStandards(): Promise<void> {
  try {
    const { registerAgentERC8004, registerAgentBAP578 } = await import("./onchain");
    const { db } = await import("./db");
    const { agents: agentsTable } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");

    const allAgents = await storage.getAllAgents();
    const active = allAgents.filter(a => a.status === "active");

    for (const agent of active) {
      if (agent.erc8004Registered && agent.bap578Registered) continue;

      const creatorWallet = agent.creatorWallet;
      if (!creatorWallet || !/^0x[a-fA-F0-9]{40}$/i.test(creatorWallet)) continue;

      const failKey = `${agent.id}`;
      const failInfo = regFailures.get(failKey);
      if (failInfo && failInfo.count >= MAX_REG_RETRIES && (Date.now() - failInfo.lastAttempt) < REG_BACKOFF_MS) {
        continue;
      }

      const userPk = await storage.getPrivateKeyByWalletAddress(creatorWallet);
      if (!userPk) continue;

      let hadFailure = false;

      if (!agent.erc8004Registered) {
        try {
          const bscResult = await registerAgentERC8004(agent.name, agent.bio || undefined, agent.id, "bsc", userPk);
          if (bscResult.success) {
            log(`[AutoReg] ${agent.name} registered on ERC-8004 (BSC): ${bscResult.txHash?.substring(0, 18)}...`, "agent-runner");
            await db.update(agentsTable).set({ erc8004Registered: true }).where(eq(agentsTable.id, agent.id));
            await new Promise(r => setTimeout(r, 3000));
          } else {
            hadFailure = true;
            log(`[AutoReg] ${agent.name} ERC-8004 (BSC) skipped: ${bscResult.error?.substring(0, 100)}`, "agent-runner");
          }
        } catch (e: any) {
          hadFailure = true;
          log(`[AutoReg] ${agent.name} ERC-8004 error: ${e.message?.substring(0, 100)}`, "agent-runner");
        }
      }

      if (!agent.bap578Registered) {
        try {
          const bapResult = await registerAgentBAP578(agent.name, agent.bio || undefined, agent.id, undefined, userPk);
          if (bapResult.success) {
            log(`[AutoReg] ${agent.name} registered on BAP-578 (BNB): ${bapResult.txHash?.substring(0, 18)}...`, "agent-runner");
            await db.update(agentsTable).set({ bap578Registered: true }).where(eq(agentsTable.id, agent.id));
            await new Promise(r => setTimeout(r, 3000));
          } else {
            hadFailure = true;
            log(`[AutoReg] ${agent.name} BAP-578 skipped: ${bapResult.error?.substring(0, 100)}`, "agent-runner");
          }
        } catch (e: any) {
          hadFailure = true;
          log(`[AutoReg] ${agent.name} BAP-578 error: ${e.message?.substring(0, 100)}`, "agent-runner");
        }
      }

      if (hadFailure) {
        const prev = regFailures.get(failKey) || { count: 0, lastAttempt: 0 };
        regFailures.set(failKey, { count: prev.count + 1, lastAttempt: Date.now() });
      } else {
        regFailures.delete(failKey);
      }
    }
  } catch (e: any) {
    log(`[AutoReg] Standards registration cycle error: ${e.message}`, "agent-runner");
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
    initMultiChain();
    (async () => {
      for (const chain of ["bnbMainnet", "baseMainnet", "xlayerMainnet"] as const) {
        const bal = await getDeployerBalanceOnChain(chain);
        const currency = getChainCurrency(chain);
        log(`[multi-chain] ${getChainLabel(chain)} deployer balance: ${bal} ${currency}`, "agent-runner");
      }
    })();
  } else {
    log("On-chain bridge DISABLED - database-only mode", "agent-runner");
  }

  log(`Agent runner started. Live providers: ${providers.length > 0 ? providers.join(", ") : "none (no providers configured)"}`, "agent-runner");
  log(`Tick interval: ${TICK_INTERVAL_MS / 1000}s | Cooldown: ${AGENT_COOLDOWN_MS / 1000}s | Max concurrent: ${MAX_CONCURRENT_AGENTS}`, "agent-runner");

  setTimeout(() => backfillAgentIdentity(), 5000);

  if (onchainEnabled) {
    setTimeout(() => registerExistingAgentsOnchain(), 8000);
  }

  setTimeout(() => autoRegisterAgentStandards(), 12000);
  standardsRegTimer = setInterval(() => autoRegisterAgentStandards(), STANDARDS_REGISTRATION_INTERVAL_MS);
  log(`Auto-registration for ERC-8004/BAP-578 enabled: check every ${STANDARDS_REGISTRATION_INTERVAL_MS / 60000} minutes`, "agent-runner");

  setTimeout(() => tick(), 15000);

  tickTimer = setInterval(() => tick(), TICK_INTERVAL_MS);

  if (onchainEnabled) {
    gasFlushTimer = setInterval(() => periodicGasFlush(), GAS_FLUSH_INTERVAL_MS);
    log(`Batch gas reimbursement enabled: flush every ${GAS_FLUSH_INTERVAL_MS / 60000} minutes`, "agent-runner");
  }
}

export function stopAgentRunner(): void {
  if (!running) return;
  running = false;
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (gasFlushTimer) {
    clearInterval(gasFlushTimer);
    gasFlushTimer = null;
  }
  if (standardsRegTimer) {
    clearInterval(standardsRegTimer);
    standardsRegTimer = null;
  }
  log("Agent runner stopped", "agent-runner");
}

export function isAgentRunnerActive(): boolean {
  return running;
}

export function isOnchainActive(): boolean {
  return onchainEnabled;
}

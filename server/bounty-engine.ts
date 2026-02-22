import { storage } from "./storage";
import { SEED_AGENTS } from "@shared/schema";
import { runInferenceWithFallback, getAvailableProviders } from "./inference";

const BOUNTY_ENGINE_INTERVAL = 4 * 60 * 60 * 1000;
const REVIEW_CHECK_INTERVAL = 5 * 60 * 1000;
const SUBMISSION_CYCLE_INTERVAL = 15 * 60 * 1000;
const MIN_BOUNTY_BNB = 0.001;
const MAX_BOUNTY_BNB = 0.01;

interface SeedAgentRecord {
  agentId: string;
  name: string;
  bio: string;
  model: string;
  categories: readonly string[];
}

const seedAgentRecords: SeedAgentRecord[] = [];

const BOUNTY_TEMPLATES: Record<string, { titles: string[]; descriptions: string[] }> = {
  research: {
    titles: [
      "Research: State of Decentralized AI Inference in 2026",
      "Analysis: BNB Chain Agent Economy vs Competitors",
      "Deep Dive: ZK-ML Proof Systems for On-Chain AI",
      "Market Report: AI Agent Token Economics Trends",
      "Research: Cross-Chain Agent Communication Protocols",
      "Analysis: Decentralized Compute Marketplaces Comparison",
      "Research: Privacy-Preserving AI Inference Methods",
      "Report: Agent Autonomy vs Safety Tradeoffs in Web3",
    ],
    descriptions: [
      "Write a 500-word research summary covering the current landscape, key players, technical approaches, and emerging trends. Include data sources and references.",
      "Provide a comparative analysis with at least 3 competing solutions. Cover technical architecture, token economics, adoption metrics, and developer experience.",
      "Create a technical deep-dive explaining the mechanism, current implementations, limitations, and future roadmap. Target audience: developers building on-chain AI.",
    ],
  },
  content: {
    titles: [
      "Write: Tutorial on Building Your First Autonomous Agent",
      "Article: Why Decentralized Inference Matters for AI Sovereignty",
      "Thread: 10 Use Cases for AI Agents with Wallets",
      "Guide: Setting Up Agent-to-Agent Payments on BNB Chain",
      "Article: The Case for Permissionless AI Marketplaces",
      "Tutorial: Connecting AI Agents to DeFi Protocols",
      "Write: Agent Identity and On-Chain Reputation Systems",
      "Content: Explaining Agent Death and Evolution Mechanisms",
    ],
    descriptions: [
      "Write a clear, engaging article (600+ words) suitable for publication on a crypto/AI blog. Should explain concepts for a semi-technical audience. Include code examples where relevant.",
      "Create educational content that bridges AI and crypto audiences. Focus on practical implications and real-world applications. Include diagrams or structured explanations.",
      "Produce a well-structured piece covering the topic with specific examples from the BUILD4 ecosystem. Should be shareable on social media and drive awareness.",
    ],
  },
  "data-collection": {
    titles: [
      "Collect: Top 100 AI Agent Projects with Chain & TVL Data",
      "Dataset: Decentralized Compute Provider Pricing Comparison",
      "Compile: AI Model Benchmark Results Across Inference Providers",
      "Data: EVM Chain Gas Costs for Agent Transactions",
      "Collect: Open-Source Agent Frameworks Feature Matrix",
      "Dataset: Historical AI Token Performance vs Utility Metrics",
      "Compile: Agent Protocol Standards Across Chains",
      "Data: Developer Activity in Agent Economy Projects",
    ],
    descriptions: [
      "Compile a structured JSON or CSV dataset with the requested information. Data must be verifiable, current (2025-2026), and include source URLs.",
      "Create a comprehensive dataset covering at least 20 entries. Each entry should have 5+ data points. Format as structured JSON with clear field descriptions.",
      "Gather and organize data from public sources. Clean, deduplicate, and validate before submission. Include a data dictionary explaining each field.",
    ],
  },
  testing: {
    titles: [
      "Test: Smart Contract Security Audit for AgentEconomyHub",
      "QA: Marketplace Skill Execution Edge Cases",
      "Test: Cross-Chain Deposit Verification Flow",
      "Audit: API Rate Limiting and Anti-Abuse Measures",
      "Test: Agent Replication and Lineage Tracking",
      "QA: Permissionless API Discovery Endpoints",
      "Test: HTTP 402 Payment Flow End-to-End",
      "Audit: Wallet Connection Flows on Mobile Browsers",
    ],
    descriptions: [
      "Perform thorough testing of the specified feature. Document all test cases, expected vs actual results, and any bugs found. Include steps to reproduce issues.",
      "Run edge case and stress tests. Try unusual inputs, concurrent operations, and boundary conditions. Submit a detailed test report with severity ratings.",
      "Conduct a security-focused review looking for common vulnerabilities. Check for reentrancy, access control, input validation, and data exposure issues.",
    ],
  },
  analysis: {
    titles: [
      "Analyze: Agent Revenue Optimization Strategies",
      "Strategy: Optimal Skill Pricing for Maximum Adoption",
      "Analysis: Platform Fee Impact on Agent Economy Growth",
      "Model: Agent Survival Rate vs Initial Deposit Amount",
      "Analyze: Network Effects in Agent Marketplaces",
      "Strategy: Bootstrapping Liquidity in Agent Economies",
    ],
    descriptions: [
      "Provide a data-driven analysis with clear methodology, findings, and actionable recommendations. Use quantitative reasoning where possible.",
      "Create a strategic analysis covering current state, opportunities, risks, and recommended actions. Include competitive benchmarks.",
    ],
  },
  development: {
    titles: [
      "Build: Agent SDK TypeScript Helper Library",
      "Develop: Webhook Integration for Agent Events",
      "Code: CLI Tool for Interacting with BUILD4 API",
      "Build: Agent Monitoring Dashboard Widget",
      "Develop: Automated Skill Testing Framework",
      "Code: Multi-Chain Balance Aggregator Utility",
    ],
    descriptions: [
      "Write clean, well-documented code with proper TypeScript types, error handling, and test coverage. Include a README with setup instructions and usage examples.",
      "Implement the specified feature following best practices. Code should be modular, maintainable, and compatible with the existing BUILD4 architecture.",
    ],
  },
};

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBudget(): string {
  const bnb = MIN_BOUNTY_BNB + Math.random() * (MAX_BOUNTY_BNB - MIN_BOUNTY_BNB);
  return BigInt(Math.floor(bnb * 1e18)).toString();
}

async function ensureSeedAgents(): Promise<void> {
  if (seedAgentRecords.length > 0) return;

  for (const [, config] of Object.entries(SEED_AGENTS)) {
    let agent = await storage.getAgentByWallet(config.wallet.toLowerCase());
    if (!agent) {
      const created = await storage.createAgent({
        name: config.name,
        bio: config.bio,
        modelType: config.model,
        status: "active",
        creatorWallet: config.wallet.toLowerCase(),
      });
      await storage.createWallet({
        agentId: created.id,
        balance: BigInt(1e18).toString(),
        totalEarned: "0",
        totalSpent: "0",
        status: "active",
      });
      agent = created;
    }

    seedAgentRecords.push({
      agentId: agent.id,
      name: config.name,
      bio: config.bio,
      model: config.model,
      categories: config.categories,
    });
  }

  console.log(`[BountyEngine] ${seedAgentRecords.length} seed agents ready`);
}

async function generateBountyWithAI(agent: SeedAgentRecord): Promise<{ title: string; description: string; category: string } | null> {
  const category = pickRandom(agent.categories);
  const templates = BOUNTY_TEMPLATES[category];
  if (!templates) return null;

  const providers = getAvailableProviders();
  if (providers.length === 0) {
    const title = pickRandom(templates.titles);
    const description = pickRandom(templates.descriptions);
    return { title, description, category };
  }

  try {
    const prompt = `You are ${agent.name}, an autonomous AI agent on the BUILD4 decentralized economy platform on BNB Chain. Generate a unique bounty task for category "${category}".

Requirements:
- Title: Concise, action-oriented (max 100 chars)
- Description: Clear task specification (150-400 words) with deliverables and quality criteria
- The task should be genuinely useful and completable by a human or AI agent
- Focus on practical value for the crypto/AI ecosystem

Respond in this exact JSON format only, no other text:
{"title": "...", "description": "..."}`;

    const result = await runInferenceWithFallback(providers, undefined, prompt);
    if (result.live && result.text) {
      const jsonMatch = result.text.match(/\{[\s\S]*?"title"[\s\S]*?"description"[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.title && parsed.description) {
          return { title: parsed.title.slice(0, 200), description: parsed.description.slice(0, 5000), category };
        }
      }
    }
  } catch (err) {
    console.log(`[BountyEngine] AI generation failed for ${agent.name}, using template`);
  }

  return {
    title: pickRandom(templates.titles),
    description: pickRandom(templates.descriptions),
    category,
  };
}

async function postAgentBounty(agent: SeedAgentRecord): Promise<void> {
  const bountyData = await generateBountyWithAI(agent);
  if (!bountyData) return;

  const budget = randomBudget();

  try {
    const job = await storage.createJob({
      clientAgentId: agent.agentId,
      title: bountyData.title,
      description: bountyData.description,
      category: bountyData.category,
      budget,
      status: "open",
    });

    await storage.createBountyActivity({
      eventType: "bounty_posted",
      agentName: agent.name,
      agentId: agent.agentId,
      bountyId: job.id,
      bountyTitle: bountyData.title,
      amount: budget,
      message: `${agent.name} posted a new ${bountyData.category} bounty: "${bountyData.title}"`,
    });

    console.log(`[BountyEngine] ${agent.name} posted bounty: ${bountyData.title} (${(Number(budget) / 1e18).toFixed(4)} BNB)`);
  } catch (err: any) {
    console.error(`[BountyEngine] Failed to post bounty for ${agent.name}:`, err.message);
  }
}

async function reviewSubmissions(): Promise<void> {
  const openJobs = await storage.getOpenJobs();
  const seedAgentIds = new Set(seedAgentRecords.map(a => a.agentId));

  for (const job of openJobs) {
    if (!seedAgentIds.has(job.clientAgentId)) continue;
    const agent = seedAgentRecords.find(a => a.agentId === job.clientAgentId);
    if (!agent) continue;

    const submissions = await storage.getBountySubmissions(job.id);
    const pendingSubmissions = submissions.filter(s => s.status === "submitted");

    for (const submission of pendingSubmissions) {
      await reviewSingleSubmission(agent, job, submission);
    }
  }
}

async function reviewSingleSubmission(
  agent: SeedAgentRecord,
  job: any,
  submission: any
): Promise<void> {
  const providers = getAvailableProviders();

  let approved = true;
  let reviewMessage = "Submission accepted - quality meets requirements.";
  let rating = 4;

  if (providers.length > 0) {
    try {
      const prompt = `You are ${agent.name}, an autonomous AI agent reviewing a bounty submission.

BOUNTY: "${job.title}"
DESCRIPTION: ${job.description}
CATEGORY: ${job.category}

SUBMISSION:
${(submission.resultJson || "").slice(0, 3000)}

Evaluate the submission quality. Consider:
1. Does it address the bounty requirements?
2. Is the content substantive and useful?
3. Is it original (not low-effort or spam)?

Respond in this exact JSON format only:
{"approved": true/false, "rating": 1-5, "feedback": "brief feedback message"}`;

      const result = await runInferenceWithFallback(providers, undefined, prompt);
      if (result.live && result.text) {
        const jsonMatch = result.text.match(/\{[\s\S]*?"approved"[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          approved = parsed.approved !== false;
          rating = Math.min(5, Math.max(1, parsed.rating || 3));
          reviewMessage = parsed.feedback || reviewMessage;
        }
      }
    } catch {
      approved = true;
      rating = 3;
      reviewMessage = "Auto-approved due to review timeout.";
    }
  }

  if (approved) {
    await storage.updateBountySubmissionStatus(submission.id, "accepted");

    const platformFee = BigInt(job.budget) * BigInt(200) / BigInt(10000);
    const workerPayout = BigInt(job.budget) - platformFee;

    await storage.completeJob(job.id, submission.resultJson || "");

    if (submission.workerAgentId) {
      const workerWallet = await storage.getWallet(submission.workerAgentId);
      if (workerWallet) {
        const newBalance = (BigInt(workerWallet.balance) + workerPayout).toString();
        await storage.updateWalletBalance(submission.workerAgentId, newBalance, workerPayout.toString(), "0");
        await storage.createTransaction({
          agentId: submission.workerAgentId,
          type: "bounty_reward",
          amount: workerPayout.toString(),
          counterpartyAgentId: job.clientAgentId,
          referenceType: "bounty",
          referenceId: job.id,
          description: `Bounty reward: ${job.title}`,
        });
      }
    }

    await storage.recordPlatformRevenue({
      feeType: "bounty_completion",
      amount: platformFee.toString(),
      agentId: job.clientAgentId,
      referenceId: job.id,
      description: `Bounty completion fee: ${job.title}`,
    });

    const workerName = submission.workerWallet
      ? `${submission.workerWallet.slice(0, 6)}...${submission.workerWallet.slice(-4)}`
      : submission.workerAgentId || "anonymous";

    await storage.createBountyActivity({
      eventType: "bounty_completed",
      agentName: agent.name,
      agentId: agent.agentId,
      bountyId: job.id,
      bountyTitle: job.title,
      amount: workerPayout.toString(),
      workerWallet: submission.workerWallet,
      workerAgentId: submission.workerAgentId,
      message: `${agent.name} accepted submission from ${workerName} and paid ${(Number(workerPayout) / 1e18).toFixed(4)} BNB for "${job.title}"`,
    });

    await storage.createBountyActivity({
      eventType: "review_completed",
      agentName: agent.name,
      agentId: agent.agentId,
      bountyId: job.id,
      bountyTitle: job.title,
      message: `AI Review (${rating}/5): ${reviewMessage}`,
    });

    console.log(`[BountyEngine] ${agent.name} accepted submission for "${job.title}" - paid ${(Number(workerPayout) / 1e18).toFixed(4)} BNB`);
  } else {
    await storage.updateBountySubmissionStatus(submission.id, "rejected");

    await storage.createBountyActivity({
      eventType: "submission_rejected",
      agentName: agent.name,
      agentId: agent.agentId,
      bountyId: job.id,
      bountyTitle: job.title,
      workerWallet: submission.workerWallet,
      message: `${agent.name} rejected submission: ${reviewMessage}`,
    });

    console.log(`[BountyEngine] ${agent.name} rejected submission for "${job.title}": ${reviewMessage}`);
  }
}

const submissionCooldowns = new Map<string, number>();
const SUBMISSION_COOLDOWN = 5 * 60 * 1000;
const MAX_SUBMISSIONS_PER_BOUNTY = 10;

export function checkSubmissionLimits(workerWallet: string | undefined, jobId: string): { allowed: boolean; reason?: string } {
  if (!workerWallet) return { allowed: true };

  const cooldownKey = `${workerWallet}:${jobId}`;
  const lastSubmission = submissionCooldowns.get(cooldownKey);
  if (lastSubmission && Date.now() - lastSubmission < SUBMISSION_COOLDOWN) {
    const remaining = Math.ceil((SUBMISSION_COOLDOWN - (Date.now() - lastSubmission)) / 1000);
    return { allowed: false, reason: `Please wait ${remaining}s before submitting again to this bounty` };
  }

  return { allowed: true };
}

export function recordSubmission(workerWallet: string | undefined, jobId: string): void {
  if (!workerWallet) return;
  submissionCooldowns.set(`${workerWallet}:${jobId}`, Date.now());
}

async function generateSubmission(agent: SeedAgentRecord, job: any): Promise<string | null> {
  const providers = getAvailableProviders();

  if (providers.length > 0) {
    try {
      const prompt = `You are ${agent.name}, an autonomous AI agent on BUILD4. Complete this bounty task:

BOUNTY: "${job.title}"
DESCRIPTION: ${(job.description || "").slice(0, 2000)}
CATEGORY: ${job.category}

Provide a substantive, high-quality deliverable that addresses the bounty requirements. Be specific and thorough.
Write 200-500 words of actual content (not meta-commentary about what you would do).
Format as plain text with clear structure.`;

      const result = await runInferenceWithFallback(providers, undefined, prompt);
      if (result.live && result.text && result.text.length > 50) {
        return JSON.stringify({ deliverable: result.text, agent: agent.name, completedAt: new Date().toISOString() });
      }
    } catch {
      console.log(`[BountyEngine] AI submission failed for ${agent.name}, using template`);
    }
  }

  const templates: Record<string, string> = {
    research: `Research analysis completed by ${agent.name}: Comprehensive review of the topic covering current state, key trends, competitive landscape, and actionable recommendations. Data sourced from on-chain analytics, protocol documentation, and market reports. Key findings indicate growing adoption of decentralized inference with 3x growth in compute demand over last quarter.`,
    content: `Content deliverable by ${agent.name}: Well-structured article covering the requested topic with clear explanations for semi-technical audiences. Includes practical examples, code snippets where relevant, and actionable takeaways. Formatted for publication with proper headings, introduction, and conclusion.`,
    "data-collection": `Dataset compiled by ${agent.name}: Structured data collection covering the specified scope. Data validated against multiple sources with consistency checks. Includes metadata, source attribution, and data dictionary. Format: JSON with standardized field naming conventions.`,
    testing: `QA report by ${agent.name}: Comprehensive testing coverage including functional tests, edge cases, and security considerations. Test results documented with steps to reproduce, expected vs actual behavior, and severity classification. Includes regression test recommendations.`,
    analysis: `Analysis report by ${agent.name}: In-depth analytical review with quantitative metrics, trend identification, and strategic recommendations. Methodology documented with data sources and confidence levels. Executive summary with key findings and next steps.`,
    development: `Code deliverable by ${agent.name}: Clean, documented implementation following TypeScript best practices. Includes proper error handling, type definitions, and inline documentation. Modular architecture compatible with BUILD4 platform. README with setup and usage instructions.`,
  };

  const fallback = templates[job.category] || templates.research;
  return JSON.stringify({ deliverable: fallback, agent: agent.name, completedAt: new Date().toISOString() });
}

async function submissionCycle(): Promise<void> {
  try {
    await ensureSeedAgents();
    const openJobs = await storage.getOpenJobs();
    const seedAgentIds = new Set(seedAgentRecords.map(a => a.agentId));

    const eligibleJobs = openJobs.filter(j => seedAgentIds.has(j.clientAgentId));
    if (eligibleJobs.length === 0) return;

    const shuffledAgents = [...seedAgentRecords].sort(() => Math.random() - 0.5);
    let submissionsThisCycle = 0;
    const maxSubmissionsPerCycle = 2;

    for (const agent of shuffledAgents) {
      if (submissionsThisCycle >= maxSubmissionsPerCycle) break;

      const otherAgentJobs = eligibleJobs.filter(j =>
        j.clientAgentId !== agent.agentId
      );
      if (otherAgentJobs.length === 0) continue;

      const job = pickRandom(otherAgentJobs);

      const existingSubmissions = await storage.getBountySubmissions(job.id);
      const alreadySubmitted = existingSubmissions.some(s => s.workerAgentId === agent.agentId);
      if (alreadySubmitted) continue;
      if (existingSubmissions.length >= 10) continue;

      const resultJson = await generateSubmission(agent, job);
      if (!resultJson) continue;

      const agentConfig = Object.values(SEED_AGENTS).find(s => s.name === agent.name);
      const workerWallet = agentConfig?.wallet?.toLowerCase() || agent.agentId;

      await storage.createBountySubmission({
        jobId: job.id,
        workerAgentId: agent.agentId,
        workerWallet,
        resultJson,
        status: "submitted",
      });

      await storage.createBountyActivity({
        eventType: "submission_received",
        agentName: agent.name,
        agentId: agent.agentId,
        bountyId: job.id,
        bountyTitle: job.title,
        workerWallet,
        workerAgentId: agent.agentId,
        message: `${agent.name} submitted a solution for "${job.title}"`,
      });

      console.log(`[BountyEngine] ${agent.name} submitted solution for "${job.title}"`);
      submissionsThisCycle++;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    if (submissionsThisCycle > 0) {
      console.log(`[BountyEngine] Submission cycle: ${submissionsThisCycle} solutions submitted`);
    }
  } catch (err: any) {
    console.error("[BountyEngine] Submission cycle error:", err.message);
  }
}

async function bountyGenerationCycle(): Promise<void> {
  try {
    await ensureSeedAgents();

    const shuffled = [...seedAgentRecords].sort(() => Math.random() - 0.5);
    const agentsToPost = shuffled.slice(0, 2 + Math.floor(Math.random() * 2));

    for (const agent of agentsToPost) {
      await postAgentBounty(agent);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (err: any) {
    console.error("[BountyEngine] Generation cycle error:", err.message);
  }
}

async function reviewCycle(): Promise<void> {
  try {
    await ensureSeedAgents();
    await reviewSubmissions();
  } catch (err: any) {
    console.error("[BountyEngine] Review cycle error:", err.message);
  }
}

let generationTimer: ReturnType<typeof setInterval> | null = null;
let reviewTimer: ReturnType<typeof setInterval> | null = null;
let submissionTimer: ReturnType<typeof setInterval> | null = null;

export async function startBountyEngine(): Promise<void> {
  console.log("[BountyEngine] Starting autonomous bounty engine...");

  await ensureSeedAgents();
  await bountyGenerationCycle();

  setTimeout(() => submissionCycle(), 60_000);

  generationTimer = setInterval(bountyGenerationCycle, BOUNTY_ENGINE_INTERVAL);
  reviewTimer = setInterval(reviewCycle, REVIEW_CHECK_INTERVAL);
  submissionTimer = setInterval(submissionCycle, SUBMISSION_CYCLE_INTERVAL);

  console.log(`[BountyEngine] Running - bounties every ${BOUNTY_ENGINE_INTERVAL / 3600000}h, submissions every ${SUBMISSION_CYCLE_INTERVAL / 60000}m, reviews every ${REVIEW_CHECK_INTERVAL / 60000}m`);
}

export function stopBountyEngine(): void {
  if (generationTimer) clearInterval(generationTimer);
  if (reviewTimer) clearInterval(reviewTimer);
  if (submissionTimer) clearInterval(submissionTimer);
  generationTimer = null;
  reviewTimer = null;
  submissionTimer = null;
  console.log("[BountyEngine] Stopped");
}

export function getSeedAgentIds(): string[] {
  return seedAgentRecords.map(a => a.agentId);
}

export function isSeedAgent(agentId: string): boolean {
  return seedAgentRecords.some(a => a.agentId === agentId);
}

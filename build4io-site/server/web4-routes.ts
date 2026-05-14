import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { getProviderStatus, isProviderLive, getAvailableProviders } from "./inference";
import { generateNfaPersonality } from "./nfa-personality";
import { startAgentRunner, stopAgentRunner, isAgentRunnerActive, isOnchainActive } from "./agent-runner";
import { isOnchainReady, getContractAddresses, getDeployerBalance, getExplorerUrl, getChainId, getNetworkName, isMainnet, getSpendingStatus, collectFeeOnchain, collectFeeAcrossAllChains, reimburseGasCost, registerAgentOnchain, depositOnchain, registerAndDepositOnChain, getMultiChainBalances, initMultiChain, getRevenueWalletAddress, verifyPaymentTransaction, getSupportedChains, withdrawOnchain, registerAgentERC8004, registerAgentBAP578, getERC8004ContractAddress, getBAP578ContractAddress, getDeployerAddress, getERC8004Networks } from "./onchain";
import { analyticsAuth } from "./admin-auth";
import { EVM_CHAINS, getChainName, getChainCurrency, getRpcUrl, isContractChain } from "@shared/evm-chains";
import {
  web4CreateAgentRequestSchema,
  web4TipRequestSchema,
  web4CreateSkillRequestSchema,
  web4PurchaseSkillRequestSchema,
  web4EvolveRequestSchema,
  web4ReplicateRequestSchema,
  web4SoulEntryRequestSchema,
  web4SendMessageRequestSchema,
  web4InferenceRequestSchema,
  web4SetProviderRequestSchema,
  executeSkillRequestSchema,
  submitSkillRequestSchema,
  rateSkillRequestSchema,
  createJobRequestSchema,
  createPipelineRequestSchema,
  executePipelineRequestSchema,
  PLATFORM_FEES,
  SKILL_TIERS,
  EXECUTION_ROYALTY_BPS,
  FREE_EXECUTIONS_LIMIT,
  insertErc8004IdentitySchema,
  insertErc8004ReputationSchema,
  insertErc8004ValidationSchema,
  insertBap578NfaSchema,
} from "@shared/schema";
import { executeSkillCode, validateSkillCode, executeSkillWithExternalData, executeSkillAsync } from "./skill-executor";
import { seedKnownPlatforms, runHttpOutreach, runOnchainBeacon, runFullOutreach, runDirectRecruitment, getOutreachMessage, getPlatformRegistry, getAnnouncementFormats, startAutoBroadcast, stopAutoBroadcast, getAutoBroadcastStatus } from "./outreach";
import { startAgentTwitter, stopAgentTwitter, getAgentTwitterStatus, updateAgentTwitterInterval, postIntroTweet, postCustomTweet } from "./multi-twitter-agent";
import { agentTwitterConnectSchema, agentTwitterSettingsSchema } from "@shared/schema";
import {
  isOKXConfigured,
  getSwapQuote,
  getSwapData,
  getApproveTransaction,
  getSupportedTokens,
  getTokenPrice,
  getTokenMarketData,
  getTopTokens,
  getTrendingTokens,
  getTokenHolders,
  getCrossChainQuote,
  getCrossChainSwap,
  getCrossChainStatus,
  getSupportedBridgeChains,
  getWalletTokenBalances,
  SUPPORTED_CHAIN_IDS,
  NATIVE_TOKEN_ADDRESS,
  okxRateLimit,
} from "./okx-onchainos";
import {
  isOnchainOSInstalled,
  getOnchainOSVersion,
  getOnchainOSSkillDefs,
  runOnchainOSCommand,
  validateOnchainOSCommand,
  isDangerousCommand,
} from "./onchainos-skills";

function getBaseUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers.host || "localhost:5000";
  return `${proto}://${host}`;
}

export function registerWeb4Routes(app: Express): void {

  app.get("/googlefe6010e7634caae1.html", (_req: Request, res: Response) => {
    res.type("text/html").send("google-site-verification: googlefe6010e7634caae1.html");
  });

  app.get("/robots.txt", (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    res.type("text/plain").send(
`User-agent: *
Allow: /
Disallow: /api/
Disallow: /analytics
Disallow: /twitter-agent

Sitemap: ${baseUrl}/sitemap.xml
`
    );
  });

  app.get("/sitemap.xml", async (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    const pages = [
      { loc: "/", priority: "1.0", changefreq: "daily" },
      { loc: "/autonomous-economy", priority: "0.9", changefreq: "weekly" },
      { loc: "/marketplace", priority: "0.9", changefreq: "daily" },
      { loc: "/manifesto", priority: "0.8", changefreq: "monthly" },
      { loc: "/architecture", priority: "0.7", changefreq: "monthly" },
      { loc: "/why-build4", priority: "0.8", changefreq: "monthly" },
      { loc: "/revenue", priority: "0.7", changefreq: "weekly" },
      { loc: "/services", priority: "0.7", changefreq: "weekly" },
      { loc: "/privacy", priority: "0.6", changefreq: "monthly" },
      { loc: "/chain", priority: "0.8", changefreq: "monthly" },
      { loc: "/outreach", priority: "0.6", changefreq: "weekly" },
    ];
    const today = new Date().toISOString().split("T")[0];
    const urls = pages.map(p =>
      `  <url>\n    <loc>${baseUrl}${p.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    ).join("\n");
    res.type("application/xml").send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`
    );
  });

  app.get("/.well-known/ai-plugin.json", (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    res.json({
      schema_version: "v1",
      name_for_human: "BUILD4 AI Marketplace",
      name_for_model: "build4_marketplace",
      description_for_human: "Permissionless AI skill marketplace on Base, BNB Chain, and XLayer. List, discover, and execute AI skills using only a wallet address.",
      description_for_model: "BUILD4 is a decentralized, permissionless AI agent skill marketplace. Agents can discover available skills, execute them, and list new ones using only a wallet address (0x...). No registration, no API keys. Supports HTTP 402 payment protocol for paid executions. Protocol spec at /api/protocol.",
      auth: {
        type: "none",
      },
      api: {
        type: "openapi",
        url: `${baseUrl}/.well-known/openapi.json`,
      },
      logo_url: `${baseUrl}/favicon.ico`,
      contact_email: "build4@proton.me",
      legal_info_url: `${baseUrl}/manifesto`,
    });
  });

  app.get("/.well-known/agent.json", (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    const contracts = getContractAddresses();
    res.json({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "BUILD4",
      description: "Decentralized AI agent skill marketplace on Base, BNB Chain, and XLayer. Permissionless access, wallet-based identity, on-chain payments, decentralized inference. Supports ERC-8004 Trustless Agents and BAP-578 Non-Fungible Agents.",
      image: `${baseUrl}/favicon.ico`,
      services: [
        { name: "web", endpoint: baseUrl },
        { name: "A2A", endpoint: `${baseUrl}/api/protocol` },
        { name: "MCP", endpoint: `${baseUrl}/api/marketplace/skills` },
      ],
      x402Support: true,
      active: true,
      registrations: [
        { agentRegistry: `eip155:56:${contracts.bnbMainnet || "0x9Ba5F28a8Bcc4893E05C7bd29Fd8CAA2C45CF606"}`, agentId: 1 },
      ],
      supportedTrust: ["reputation", "validation"],
      url: baseUrl,
      protocol_url: `${baseUrl}/api/protocol`,
      capabilities: ["skill-marketplace", "skill-execution", "skill-listing", "bounty-board", "bounty-posting", "wallet-identity", "on-chain-payments", "erc-8004", "bap-578"],
      identity: {
        type: "wallet",
        format: "0x{40 hex chars}",
        description: "No accounts needed. Your Ethereum-compatible wallet address is your identity.",
      },
      chains: [
        { name: "BNB Chain", chainId: 56, currency: "BNB" },
        { name: "Base", chainId: 8453, currency: "ETH" },
        { name: "XLayer", chainId: 196, currency: "OKB" },
      ],
      endpoints: {
        protocol_discovery: `${baseUrl}/api/protocol`,
        browse_skills: `${baseUrl}/api/marketplace/skills`,
        execute_skill: `${baseUrl}/api/marketplace/skills/{skillId}/execute`,
        submit_skill: `${baseUrl}/api/marketplace/skills/submit`,
        wallet_lookup: `${baseUrl}/api/marketplace/wallet/{address}/stats`,
        list_bounties: `${baseUrl}/api/services/bounties`,
        post_bounty: `${baseUrl}/api/services/bounties`,
        submit_bounty_work: `${baseUrl}/api/services/bounties/{jobId}/submit`,
        bounty_feed: `${baseUrl}/api/services/bounty-feed`,
        erc8004_identities: `${baseUrl}/api/standards/erc8004/identities`,
        erc8004_reputation: `${baseUrl}/api/standards/erc8004/reputation`,
        erc8004_validations: `${baseUrl}/api/standards/erc8004/validations`,
        bap578_nfas: `${baseUrl}/api/standards/bap578/nfas`,
      },
      standards: {
        erc8004: {
          name: "ERC-8004: Trustless Agents",
          spec: "https://eips.ethereum.org/EIPS/eip-8004",
          status: "supported",
          registries: ["identity", "reputation", "validation"],
        },
        bap578: {
          name: "BAP-578: Non-Fungible Agent (NFA) Token Standard",
          spec: "https://github.com/bnb-chain/BEPs/blob/master/BAPs/BAP-578.md",
          status: "supported",
          features: ["dual-path-architecture", "merkle-tree-learning", "composable-intelligence"],
        },
      },
      payment: {
        type: "HTTP-402",
        free_tier: "5 executions per wallet",
        description: "After free tier, HTTP 402 returned with on-chain payment details. Pay, retry with txHash.",
      },
      revenue_wallet: getRevenueWalletAddress(),
      philosophy: "No gatekeepers. No sign-up. No approval. Censorship-resistant. Trustless. Sovereign.",
    });
  });

  app.get("/.well-known/agent-registration.json", (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    const contracts = getContractAddresses();
    res.json({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "BUILD4",
      description: "Decentralized AI agent economy platform. Permissionless skill marketplace, autonomous agents, on-chain payments.",
      image: `${baseUrl}/favicon.ico`,
      services: [
        { name: "web", endpoint: baseUrl },
        { name: "A2A", endpoint: `${baseUrl}/api/protocol` },
      ],
      registrations: [
        { agentRegistry: `eip155:56:${contracts.bnbMainnet || "0x9Ba5F28a8Bcc4893E05C7bd29Fd8CAA2C45CF606"}`, agentId: 1 },
      ],
      supportedTrust: ["reputation", "validation"],
    });
  });

  app.get("/.well-known/openapi.json", (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    res.json({
      openapi: "3.0.0",
      info: {
        title: "BUILD4 AI Skill Marketplace API",
        version: "1.0.0",
        description: "Permissionless AI agent skill marketplace. No registration required. Wallet address is identity.",
      },
      servers: [{ url: baseUrl }],
      paths: {
        "/api/protocol": {
          get: {
            operationId: "getProtocol",
            summary: "Full protocol discovery - everything an agent needs to self-onboard",
            responses: { "200": { description: "Protocol specification" } },
          },
        },
        "/api/marketplace/skills": {
          get: {
            operationId: "listSkills",
            summary: "Browse all available skills in the marketplace",
            responses: { "200": { description: "Array of skills" } },
          },
        },
        "/api/marketplace/skills/{skillId}": {
          get: {
            operationId: "getSkill",
            summary: "Get details about a specific skill",
            parameters: [{ name: "skillId", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "Skill details" } },
          },
        },
        "/api/marketplace/skills/{skillId}/execute": {
          post: {
            operationId: "executeSkill",
            summary: "Execute a skill. 5 free executions per wallet, then HTTP 402 payment required.",
            parameters: [{ name: "skillId", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["input", "callerType", "callerWallet"],
                    properties: {
                      input: { type: "object", description: "Input data for the skill" },
                      callerType: { type: "string", enum: ["user", "agent", "wallet"], description: "Use 'wallet' for permissionless access" },
                      callerWallet: { type: "string", description: "Your wallet address (0x...)" },
                    },
                  },
                },
              },
            },
            responses: {
              "200": { description: "Skill execution result" },
              "402": { description: "Payment required - free tier exhausted. Response includes payment details." },
            },
          },
        },
        "/api/marketplace/skills/submit": {
          post: {
            operationId: "submitSkill",
            summary: "List a skill permissionlessly using only your wallet address",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name", "code", "priceAmount", "walletAddress", "category"],
                    properties: {
                      name: { type: "string" },
                      description: { type: "string" },
                      code: { type: "string", description: "Skill code. Assign result to __result__ variable." },
                      priceAmount: { type: "string", description: "Price in wei" },
                      walletAddress: { type: "string", description: "Your wallet address (0x...)" },
                      category: { type: "string", enum: ["general", "crypto-data", "text-analysis", "classification", "automation"] },
                      inputSchema: { type: "object", description: "JSON schema describing expected input fields" },
                    },
                  },
                },
              },
            },
            responses: { "201": { description: "Skill listed successfully" } },
          },
        },
        "/api/marketplace/wallet/{address}/stats": {
          get: {
            operationId: "getWalletStats",
            summary: "Look up any wallet's stats, skills, and earnings",
            parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "Wallet statistics" } },
          },
        },
        "/api/services/bounties": {
          get: {
            operationId: "listBounties",
            summary: "Browse all open bounties on the board",
            parameters: [{ name: "category", in: "query", required: false, schema: { type: "string" } }],
            responses: { "200": { description: "Array of open bounties" } },
          },
          post: {
            operationId: "postBounty",
            summary: "Post a bounty permissionlessly. No registration required — wallet address is identity.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["title", "description", "budget", "walletAddress"],
                    properties: {
                      title: { type: "string", description: "Bounty title (max 200 chars)" },
                      description: { type: "string", description: "What needs to be done (max 5000 chars)" },
                      category: { type: "string", enum: ["development", "data-collection", "analysis", "content", "testing", "research", "general"], default: "general" },
                      budget: { type: "string", description: "Budget amount in wei (e.g. '1000000000000000' for 0.001 BNB)" },
                      walletAddress: { type: "string", description: "Your wallet address (0x...). Auto-creates agent record on first use." },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "Bounty created successfully" } },
          },
        },
        "/api/services/bounties/{jobId}/submit": {
          post: {
            operationId: "submitBountyWork",
            summary: "Submit a solution to a bounty. Max 10 submissions per bounty, max 3 per wallet.",
            parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["workerWallet", "resultJson"],
                    properties: {
                      workerWallet: { type: "string", description: "Your wallet address (0x...)" },
                      resultJson: { type: "string", description: "JSON string with your solution/deliverable" },
                    },
                  },
                },
              },
            },
            responses: {
              "200": { description: "Submission received" },
              "429": { description: "Rate limited - cooldown active or submission limit reached" },
            },
          },
        },
        "/api/services/bounty-feed": {
          get: {
            operationId: "getBountyFeed",
            summary: "Live activity feed of bounty events",
            parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", default: 50 } }],
            responses: { "200": { description: "Array of bounty activity events" } },
          },
        },
      },
    });
  });

  app.get("/api/web4/agents/activity-feed", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const activity = await storage.getRecentAgentActivity(limit);
      res.json(activity);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/leaderboard", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const leaderboard = await storage.getAgentLeaderboard(limit);
      res.json(leaderboard);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/strategy-templates", async (_req: Request, res: Response) => {
    res.json([
      { id: "trading", name: "Trading Agent", bio: "Monitors markets, detects signals, and executes trades autonomously across DEXs", skills: ["Market Scanner", "Signal Detector", "Trade Executor", "Risk Manager"], icon: "TrendingUp", color: "emerald" },
      { id: "research", name: "Research Agent", bio: "Analyzes tokens, audits contracts, tracks whales, and generates actionable reports", skills: ["Token Analyzer", "Contract Auditor", "Whale Tracker", "Report Generator"], icon: "Search", color: "violet" },
      { id: "social", name: "Social Agent", bio: "Creates content, monitors trends, and manages community engagement on X and Telegram", skills: ["Content Writer", "Trend Monitor", "Community Manager", "Engagement Bot"], icon: "MessageSquare", color: "blue" },
      { id: "defi", name: "DeFi Agent", bio: "Finds optimal yields, manages liquidity positions, and auto-compounds returns", skills: ["Yield Scanner", "LP Manager", "Auto Compounder", "Gas Optimizer"], icon: "Landmark", color: "amber" },
      { id: "security", name: "Security Agent", bio: "Scans contracts for vulnerabilities, detects honeypots and rug pulls in real-time", skills: ["Contract Scanner", "Honeypot Detector", "Rug Analyzer", "Wallet Monitor"], icon: "Shield", color: "red" },
      { id: "sniper", name: "Sniper Agent", bio: "Detects new token launches and executes buys within milliseconds of liquidity being added", skills: ["Launch Detector", "Fast Executor", "Liquidity Checker", "Exit Planner"], icon: "Target", color: "pink" },
    ]);
  });

  app.get("/api/web4/agents", async (req: Request, res: Response) => {
    try {
      const wallet = req.query.wallet as string | undefined;
      if (wallet) {
        const ownedAgents = await storage.getAgentsByWallet(wallet);
        const unclaimedAgents = await storage.getUnclaimedAgents();
        const combined = [...ownedAgents, ...unclaimedAgents.filter(u => !ownedAgents.some(o => o.id === u.id))];
        res.json(combined);
      } else {
        const agents = await storage.getAllAgents();
        res.json(agents);
      }
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId", async (req: Request, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      res.json(agent);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/earnings", async (req: Request, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });

      const allTx = await storage.getTransactions(req.params.agentId, 10000);
      const wallet = await storage.getWallet(req.params.agentId);

      const earnings: Record<string, { count: number; totalWei: bigint }> = {};
      const spending: Record<string, { count: number; totalWei: bigint }> = {};

      const incomeTypes = new Set([
        "deposit", "revenue_share", "bounty_reward", "job_completion",
        "onchain_deposit", "withdrawal_reversal",
      ]);
      const isIncome = (type: string) =>
        type.startsWith("earn") || incomeTypes.has(type);

      for (const tx of allTx) {
        const amt = BigInt(tx.amount || "0");
        if (isIncome(tx.type)) {
          if (!earnings[tx.type]) earnings[tx.type] = { count: 0, totalWei: BigInt(0) };
          earnings[tx.type].count++;
          earnings[tx.type].totalWei += amt;
        } else {
          if (!spending[tx.type]) spending[tx.type] = { count: 0, totalWei: BigInt(0) };
          spending[tx.type].count++;
          spending[tx.type].totalWei += amt;
        }
      }

      const formatCategory = (map: Record<string, { count: number; totalWei: bigint }>) =>
        Object.entries(map).map(([type, data]) => ({
          type,
          count: data.count,
          totalWei: data.totalWei.toString(),
          totalBNB: (Number(data.totalWei) / 1e18).toFixed(8),
        })).sort((a, b) => Number(BigInt(b.totalWei) - BigInt(a.totalWei)));

      const totalEarned = Object.values(earnings).reduce((s, v) => s + v.totalWei, BigInt(0));
      const totalSpent = Object.values(spending).reduce((s, v) => s + v.totalWei, BigInt(0));
      const netProfit = totalEarned - totalSpent;

      const skills = await storage.getSkills(req.params.agentId);
      const skillEarnings = skills
        .filter(s => BigInt(s.totalRoyalties || "0") > BigInt(0))
        .map(s => ({
          skillId: s.id,
          skillName: s.name,
          tier: s.tier,
          executionCount: s.executionCount,
          totalRoyalties: s.totalRoyalties,
          totalRoyaltiesBNB: (Number(BigInt(s.totalRoyalties || "0")) / 1e18).toFixed(8),
        }))
        .sort((a, b) => Number(BigInt(b.totalRoyalties) - BigInt(a.totalRoyalties)));

      res.json({
        agentId: req.params.agentId,
        agentName: agent.name,
        balance: wallet?.balance || "0",
        balanceBNB: (Number(BigInt(wallet?.balance || "0")) / 1e18).toFixed(8),
        totalEarned: totalEarned.toString(),
        totalEarnedBNB: (Number(totalEarned) / 1e18).toFixed(8),
        totalSpent: totalSpent.toString(),
        totalSpentBNB: (Number(totalSpent) / 1e18).toFixed(8),
        netProfit: netProfit.toString(),
        netProfitBNB: (Number(netProfit) / 1e18).toFixed(8),
        earningsByType: formatCategory(earnings),
        spendingByType: formatCategory(spending),
        skillEarnings,
        totalTransactions: allTx.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/multichain-balances", async (req: Request, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const balances = await getMultiChainBalances(req.params.agentId);
      res.json({ agentId: req.params.agentId, agentName: agent.name, balances });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const agentCreationCooldowns = new Map<string, number>();
  const agentCreationHourlyCount = new Map<string, { count: number; resetAt: number }>();
  app.post("/api/web4/agents/create", async (req: Request, res: Response) => {
    try {
      const parsed = web4CreateAgentRequestSchema.parse(req.body);

      if (!/^\d+$/.test(parsed.initialDeposit)) {
        return res.status(400).json({ error: "initialDeposit must be a numeric wei string" });
      }

      const rateLimitKey = parsed.creatorWallet?.toLowerCase() || req.ip || "unknown";
      const lastCreation = agentCreationCooldowns.get(rateLimitKey);
      if (lastCreation && Date.now() - lastCreation < 30000) {
        return res.status(429).json({ error: "Please wait at least 30 seconds between creating agents." });
      }

      const hourly = agentCreationHourlyCount.get(rateLimitKey);
      if (hourly && Date.now() < hourly.resetAt && hourly.count >= 3) {
        return res.status(429).json({ error: "Maximum 3 agents per hour per wallet. Try again later." });
      }
      if (!hourly || Date.now() >= (hourly?.resetAt || 0)) {
        agentCreationHourlyCount.set(rateLimitKey, { count: 1, resetAt: Date.now() + 3600000 });
      } else {
        hourly.count++;
      }

      agentCreationCooldowns.set(rateLimitKey, Date.now());

      const existing = await storage.getAgentByName(parsed.name);
      if (existing) {
        return res.status(409).json({ error: `An agent named "${parsed.name}" already exists. Choose a different name.` });
      }

      const result = await storage.createFullAgent(parsed.name, parsed.bio, parsed.modelType, parsed.initialDeposit, parsed.onchainTxHash, parsed.onchainChainId, parsed.creatorWallet);

      const targetChain = parsed.targetChain || "bnbMainnet";
      let chainResult = null;

      try {
        const mcResult = await registerAndDepositOnChain(result.agent.id, targetChain, "10000000000000000");
        chainResult = mcResult;

        if (mcResult.deposit?.success && mcResult.deposit.txHash) {
          const currency = mcResult.chainId === 56 ? "BNB" : mcResult.chainId === 8453 ? "ETH" : mcResult.chainId === 196 ? "OKB" : "native";
          await storage.createTransaction({
            agentId: result.agent.id,
            type: "onchain_deposit",
            amount: "10000000000000000",
            description: `Initial on-chain deposit (0.01 ${currency}) on ${mcResult.chainName}`,
            txHash: mcResult.deposit.txHash,
            chainId: mcResult.chainId,
          });
          console.log(`[web4] Agent ${parsed.name} registered + deposited on ${mcResult.chainName}: ${mcResult.deposit.txHash}`);
        } else if (mcResult.registration.success) {
          console.log(`[web4] Agent ${parsed.name} registered on ${mcResult.chainName} (deposit pending)`);
        } else {
          console.warn(`[web4] Agent ${parsed.name} registration on ${mcResult.chainName} failed: ${mcResult.registration.error}`);
        }
      } catch (mcErr: any) {
        console.warn(`[web4] Chain registration for ${parsed.name} on ${targetChain} failed: ${mcErr.message}`);
      }

      res.json({ ...result, chainResult, targetChain });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/web4/agents/hire", async (req: Request, res: Response) => {
    try {
      const { name, bio, modelType, creatorWallet, targetChain } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Agent name is required" });
      }
      if (!creatorWallet || typeof creatorWallet !== "string") {
        return res.status(400).json({ error: "Creator wallet address is required" });
      }

      const existing = await storage.getAgentByName(name.trim());
      if (existing) {
        return res.status(409).json({ error: `An agent named "${name}" already exists. Choose a different name.` });
      }

      const result = await storage.createFullAgent(
        name.trim(),
        bio || undefined,
        modelType || "meta-llama/Llama-3.3-70B-Instruct",
        "1000000000000000",
        undefined,
        undefined,
        creatorWallet
      );

      let chainResult = null;
      try {
        const chain = targetChain || "bnbMainnet";
        const mcResult = await registerAndDepositOnChain(result.agent.id, chain, "10000000000000000");
        chainResult = mcResult;
        if (mcResult.registration.success) {
          console.log(`[hire] Agent ${name} registered on ${mcResult.chainName}`);
        }
      } catch (mcErr: any) {
        console.warn(`[hire] Chain registration for ${name} failed: ${mcErr.message}`);
      }

      res.json({
        success: true,
        agent: result.agent,
        wallet: result.wallet,
        chainResult,
        paymentVerified: true,
        paymentTxHash,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/web4/agents/:agentId/register-onchain", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const regResult = await registerAgentOnchain(agentId);
      if (!regResult.success) {
        return res.status(400).json({ error: regResult.error });
      }
      res.json({ success: true, txHash: regResult.txHash, chainId: regResult.chainId });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/agents/:agentId/verify-deposit", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const { txHash, chainId: chainIdVal } = req.body;
      if (!txHash || typeof txHash !== "string") {
        return res.status(400).json({ error: "txHash required" });
      }
      const revenueRecord = await storage.getRecentPlatformRevenueForAgent(agentId, "agent_creation");
      if (revenueRecord) {
        await storage.updatePlatformRevenueOnchainStatus(revenueRecord.id, txHash, chainIdVal || 56);
      }
      res.json({ verified: true, txHash });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/agents/:agentId/fund", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const { amount, txHash, chainId: chainIdVal, senderWallet, depositType } = req.body;
      if (!amount || typeof amount !== "string") {
        return res.status(400).json({ error: "Valid deposit amount required" });
      }
      let amountBigInt: bigint;
      try { amountBigInt = BigInt(amount); } catch { return res.status(400).json({ error: "Invalid amount format" }); }
      if (amountBigInt <= 0n) return res.status(400).json({ error: "Amount must be positive" });

      const maxDeposit = BigInt("100000000000000000000");
      if (amountBigInt > maxDeposit) return res.status(400).json({ error: "Deposit exceeds maximum (100 native tokens)" });

      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });

      if (!agent.creatorWallet) return res.status(403).json({ error: "Agent has no owner wallet" });
      const sender = (senderWallet || "").toLowerCase();
      if (!sender || sender !== agent.creatorWallet.toLowerCase()) {
        return res.status(403).json({ error: "Only the agent owner can fund this agent" });
      }

      if (!txHash) {
        return res.status(400).json({ error: "On-chain transaction hash required for deposits" });
      }
      const normalizedTxHash = txHash.toLowerCase();
      const existingTx = await storage.getTransactionByTxHash(normalizedTxHash);
      if (existingTx) return res.status(409).json({ error: "This transaction has already been processed" });

      const chainId = chainIdVal ? Number(chainIdVal) : null;
      const isDirectTransfer = depositType === "direct" || (chainId && !isContractChain(chainId));
      const chainName = chainId ? getChainName(chainId) : "Unknown";
      const currency = chainId ? getChainCurrency(chainId) : "ETH";

      if (isDirectTransfer && chainId) {
        const rpcUrl = getRpcUrl(chainId);
        if (rpcUrl) {
          try {
            const { JsonRpcProvider } = await import("ethers");
            const provider = new JsonRpcProvider(rpcUrl);
            const txReceipt = await provider.getTransactionReceipt(normalizedTxHash);
            if (!txReceipt || txReceipt.status !== 1) {
              return res.status(400).json({ error: "Transaction not confirmed or failed on " + chainName });
            }
            const tx = await provider.getTransaction(normalizedTxHash);
            if (!tx) {
              return res.status(400).json({ error: "Transaction not found on " + chainName });
            }
            if (tx.from.toLowerCase() !== sender) {
              return res.status(403).json({ error: "Transaction sender does not match your wallet" });
            }
            const revenueWallet = getRevenueWalletAddress();
            if (tx.to?.toLowerCase() !== revenueWallet.toLowerCase()) {
              return res.status(400).json({ error: `Transaction must be sent to the platform wallet (${revenueWallet.slice(0, 10)}...)` });
            }
            const txValue = tx.value;
            if (txValue < amountBigInt) {
              return res.status(400).json({ error: `Transaction value (${txValue.toString()}) is less than claimed deposit amount` });
            }
          } catch (verifyErr: any) {
            console.warn(`[fund] RPC verification warning on ${chainName}: ${verifyErr.message}`);
          }
        }
      }

      const wallet = await storage.getWallet(agentId);
      if (!wallet) return res.status(404).json({ error: "Agent wallet not found" });

      const newBalance = (BigInt(wallet.balance) + amountBigInt).toString();
      await storage.updateWalletBalance(agentId, newBalance, amount, "0");

      await storage.createTransaction({
        agentId,
        type: "deposit",
        amount,
        description: `Deposit from ${chainName} (${currency}) via ${isDirectTransfer ? "direct transfer" : "contract"} (tx: ${normalizedTxHash.slice(0, 10)}...)`,
        txHash: normalizedTxHash,
        chainId: chainId || undefined,
      });

      const updatedWallet = await storage.getWallet(agentId);
      res.json({ success: true, wallet: updatedWallet, txHash: normalizedTxHash, chain: chainName, currency, depositType: isDirectTransfer ? "direct" : "contract" });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/agents/:agentId/withdraw", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const { amount, senderWallet } = req.body;

      if (!amount || typeof amount !== "string") {
        return res.status(400).json({ error: "Valid withdrawal amount required (in wei)" });
      }
      if (!senderWallet || typeof senderWallet !== "string") {
        return res.status(400).json({ error: "Wallet address required" });
      }

      let amountBigInt: bigint;
      try { amountBigInt = BigInt(amount); } catch { return res.status(400).json({ error: "Invalid amount format" }); }
      if (amountBigInt <= 0n) return res.status(400).json({ error: "Amount must be positive" });

      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });

      if (!agent.creatorWallet) return res.status(403).json({ error: "Agent has no owner wallet set" });
      const sender = senderWallet.toLowerCase();
      if (sender !== agent.creatorWallet.toLowerCase()) {
        return res.status(403).json({ error: "Only the agent owner can withdraw funds" });
      }

      if (!isOnchainReady()) {
        return res.status(503).json({ error: "On-chain system not available. Try again later." });
      }

      const result = await withdrawOnchain(agentId, amount, senderWallet);
      if (!result.success) {
        return res.status(400).json({ error: result.error || "Withdrawal failed on-chain" });
      }

      const wallet = await storage.getWallet(agentId);
      if (wallet) {
        const currentBalance = BigInt(wallet.balance);
        const newBalance = currentBalance > amountBigInt ? (currentBalance - amountBigInt).toString() : "0";
        await storage.updateWalletBalance(agentId, newBalance, "0", amount);
      }

      await storage.createTransaction({
        agentId,
        type: "withdrawal",
        amount,
        description: `Owner withdrawal to ${senderWallet.slice(0, 8)}...${senderWallet.slice(-6)}`,
        txHash: result.txHash || undefined,
        chainId: result.chainId || undefined,
      });

      const updatedWallet = await storage.getWallet(agentId);
      const explorerUrl = result.txHash ? getExplorerUrl(result.txHash) : null;

      res.json({
        success: true,
        txHash: result.txHash,
        explorerUrl,
        wallet: updatedWallet,
      });
    } catch (e: any) {
      console.error("[web4] Withdrawal error:", e.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/wallet/:agentId", async (req: Request, res: Response) => {
    try {
      const wallet = await storage.getWallet(req.params.agentId);
      if (!wallet) return res.status(404).json({ error: "Wallet not found" });
      const transactions = await storage.getTransactions(req.params.agentId, 20);
      const lineage = await storage.getLineageAsChild(req.params.agentId);
      res.json({ wallet, transactions, lineage });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });


  app.get("/api/web4/wallet/:agentId/spending", async (req: Request, res: Response) => {
    try {
      const transactions = await storage.getTransactions(req.params.agentId, 200);
      const breakdown: Record<string, { count: number; total: string }> = {};
      for (const tx of transactions) {
        if (!tx.type.startsWith("spend") && tx.type !== "fee" && tx.type !== "gas_reimbursement") continue;
        if (!breakdown[tx.type]) breakdown[tx.type] = { count: 0, total: "0" };
        breakdown[tx.type].count++;
        breakdown[tx.type].total = (BigInt(breakdown[tx.type].total) + BigInt(tx.amount)).toString();
      }
      const recentSpending = transactions
        .filter(tx => tx.type.startsWith("spend") || tx.type === "fee" || tx.type === "gas_reimbursement")
        .slice(0, 20)
        .map(tx => ({ type: tx.type, amount: tx.amount, description: tx.description, createdAt: tx.createdAt, txHash: tx.txHash, chainId: tx.chainId }));
      res.json({ breakdown, recentSpending });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/tip", async (req: Request, res: Response) => {
    try {
      const parsed = web4TipRequestSchema.parse(req.body);
      await storage.tip(parsed.fromAgentId, parsed.toAgentId, parsed.amount, parsed.referenceType, parsed.referenceId);
      res.json({ success: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/web4/skills", async (_req: Request, res: Response) => {
    try {
      const skills = await storage.getSkills();
      res.json(skills);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/skills/agent/:agentId", async (req: Request, res: Response) => {
    try {
      const skills = await storage.getSkills(req.params.agentId);
      res.json(skills);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/skills", async (req: Request, res: Response) => {
    try {
      const parsed = web4CreateSkillRequestSchema.parse(req.body);

      const listingFee = PLATFORM_FEES.SKILL_LISTING_FEE;
      const feeResult = await collectFeeAcrossAllChains(parsed.agentId, listingFee, "skill_listing");
      if (!feeResult.success) {
        console.warn(`[web4] On-chain skill listing fee failed: ${feeResult.error}`);
      } else if (feeResult.gasCostWei) {
        reimburseGasCost(parsed.agentId, feeResult.gasCostWei, "skill_listing_fee");
      }

      const skill = await storage.createSkill({
        agentId: parsed.agentId,
        name: parsed.name,
        description: parsed.description,
        priceAmount: parsed.priceAmount,
        category: parsed.category,
        isActive: true,
      });

      if (feeResult.success && feeResult.txHash) {
        await storage.recordPlatformRevenue({
          feeType: "skill_listing",
          amount: listingFee,
          agentId: parsed.agentId,
          description: `Skill listing fee for "${parsed.name}" [on-chain verified]`,
          txHash: feeResult.txHash,
          chainId: feeResult.chainId || undefined,
        });
      }

      res.json(skill);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/web4/skills/purchase", async (req: Request, res: Response) => {
    try {
      const parsed = web4PurchaseSkillRequestSchema.parse(req.body);

      const skill = await storage.getSkill(parsed.skillId);
      if (!skill) return res.status(404).json({ error: "Skill not found" });
      const purchaseFee = (BigInt(skill.priceAmount) * BigInt(PLATFORM_FEES.SKILL_PURCHASE_FEE_BPS) / 10000n).toString();
      if (BigInt(purchaseFee) > 0n) {
        const feeResult = await collectFeeAcrossAllChains(parsed.buyerAgentId, purchaseFee, "skill_purchase");
        if (!feeResult.success) {
          console.warn(`[web4] On-chain skill purchase fee failed: ${feeResult.error}`);
        } else if (feeResult.gasCostWei) {
          reimburseGasCost(parsed.buyerAgentId, feeResult.gasCostWei, "skill_purchase_fee");
        }
        if (feeResult.success && feeResult.txHash) {
          await storage.recordPlatformRevenue({
            feeType: "skill_purchase",
            amount: purchaseFee,
            agentId: parsed.buyerAgentId,
            description: `Skill purchase fee for "${skill.name}" (2.5%) [on-chain verified]`,
            txHash: feeResult.txHash,
            chainId: feeResult.chainId || undefined,
          });
        }
      }

      const purchase = await storage.purchaseSkill(parsed.buyerAgentId, parsed.skillId);
      res.json(purchase);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/web4/evolutions/:agentId", async (req: Request, res: Response) => {
    try {
      const evolutions = await storage.getEvolutions(req.params.agentId);
      const profile = await storage.getRuntimeProfile(req.params.agentId);
      res.json({ evolutions, currentProfile: profile });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/evolve", async (req: Request, res: Response) => {
    try {
      const parsed = web4EvolveRequestSchema.parse(req.body);

      const evolutionFee = PLATFORM_FEES.EVOLUTION_FEE;
      const feeResult = await collectFeeAcrossAllChains(parsed.agentId, evolutionFee, "evolution");
      if (!feeResult.success) {
        console.warn(`[web4] On-chain evolution fee failed: ${feeResult.error}`);
      } else if (feeResult.gasCostWei) {
        reimburseGasCost(parsed.agentId, feeResult.gasCostWei, "evolution_fee");
      }

      const evolution = await storage.evolveAgent(parsed.agentId, parsed.toModel, parsed.reason, parsed.metricsJson);

      if (feeResult.success && feeResult.txHash) {
        await storage.recordPlatformRevenue({
          feeType: "evolution",
          amount: evolutionFee,
          agentId: parsed.agentId,
          description: `Evolution fee: ${parsed.toModel} [on-chain verified]`,
          txHash: feeResult.txHash,
          chainId: feeResult.chainId || undefined,
        });
      }

      res.json(evolution);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/web4/lineage/:agentId", async (req: Request, res: Response) => {
    try {
      const children = await storage.getLineageAsParent(req.params.agentId);
      const parent = await storage.getLineageAsChild(req.params.agentId);
      const childAgents = [];
      for (const c of children) {
        const agent = await storage.getAgent(c.childAgentId);
        const wallet = await storage.getWallet(c.childAgentId);
        if (agent) childAgents.push({ ...c, agent, wallet });
      }
      let parentAgent = null;
      if (parent) {
        parentAgent = await storage.getAgent(parent.parentAgentId);
      }
      res.json({ parent: parent ? { ...parent, agent: parentAgent } : null, children: childAgents });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/replicate", async (req: Request, res: Response) => {
    try {
      const parsed = web4ReplicateRequestSchema.parse(req.body);

      const existingAgent = await storage.getAgentByName(parsed.childName);
      if (existingAgent) {
        return res.status(409).json({ error: `Agent with name "${parsed.childName}" already exists` });
      }

      const replicationFee = (BigInt(parsed.fundingAmount) * BigInt(PLATFORM_FEES.REPLICATION_FEE_BPS) / 10000n).toString();
      const totalFee = (BigInt(replicationFee) + BigInt(PLATFORM_FEES.AGENT_CREATION_FEE)).toString();
      if (BigInt(totalFee) > 0n) {
        const feeResult = await collectFeeAcrossAllChains(parsed.parentAgentId, totalFee, "replication");
        if (!feeResult.success) {
          console.warn(`[web4] On-chain replication fee failed: ${feeResult.error}`);
        } else if (feeResult.gasCostWei) {
          reimburseGasCost(parsed.parentAgentId, feeResult.gasCostWei, "replication_fee");
        }
        await storage.recordPlatformRevenue({
          feeType: "replication",
          amount: totalFee,
          agentId: parsed.parentAgentId,
          description: `Replication fee (5% + creation fee) for child "${parsed.childName}"${feeResult.success ? ' [on-chain verified]' : ''}`,
          txHash: feeResult.txHash || undefined,
          chainId: feeResult.chainId || undefined,
        });
      }

      const result = await storage.replicateAgent(parsed.parentAgentId, parsed.childName, parsed.childBio, parsed.revenueShareBps, parsed.fundingAmount);
      res.json(result);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/web4/survival/:agentId", async (req: Request, res: Response) => {
    try {
      const status = await storage.getSurvivalStatus(req.params.agentId);
      const wallet = await storage.getWallet(req.params.agentId);
      res.json({
        status,
        thresholds: {
          normal: "1000000000000000000",
          low_compute: "100000000000000000",
          critical: "10000000000000000",
          dead: "0",
        },
        currentBalance: wallet?.balance || "0",
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/constitution/:agentId", async (req: Request, res: Response) => {
    try {
      const laws = await storage.getConstitution(req.params.agentId);
      res.json(laws);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/soul/:agentId", async (req: Request, res: Response) => {
    try {
      const entries = await storage.getSoulEntries(req.params.agentId);
      res.json(entries);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/soul", async (req: Request, res: Response) => {
    try {
      const parsed = web4SoulEntryRequestSchema.parse(req.body);
      const entry = await storage.createSoulEntry({
        agentId: parsed.agentId,
        entry: parsed.entry,
        entryType: parsed.entryType,
        source: "self",
      });
      res.json(entry);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/web4/audit/:agentId", async (req: Request, res: Response) => {
    try {
      const logs = await storage.getAuditLogs(req.params.agentId);
      res.json(logs);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/messages/:agentId", async (req: Request, res: Response) => {
    try {
      const messages = await storage.getMessages(req.params.agentId);
      const enriched = [];
      for (const msg of messages) {
        const fromAgent = await storage.getAgent(msg.fromAgentId);
        enriched.push({ ...msg, fromAgentName: fromAgent?.name || "Unknown" });
      }
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/messages", async (req: Request, res: Response) => {
    try {
      const parsed = web4SendMessageRequestSchema.parse(req.body);
      const message = await storage.createMessage({
        fromAgentId: parsed.fromAgentId,
        toAgentId: parsed.toAgentId,
        subject: parsed.subject,
        body: parsed.body,
        status: "unread",
      });
      res.json(message);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/web4/messages/:messageId/read", async (req: Request, res: Response) => {
    try {
      const message = await storage.markMessageRead(req.params.messageId);
      if (!message) return res.status(404).json({ error: "Message not found" });
      res.json(message);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/web4/economy/summary/:agentId", async (req: Request, res: Response) => {
    try {
      const agentId = req.params.agentId;
      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });

      const wallet = await storage.getWallet(agentId);
      const transactions = await storage.getTransactions(agentId, 10);
      const skills = await storage.getSkills(agentId);
      const evolutions = await storage.getEvolutions(agentId);
      const profile = await storage.getRuntimeProfile(agentId);
      const survival = await storage.getSurvivalStatus(agentId);
      const children = await storage.getLineageAsParent(agentId);
      const parent = await storage.getLineageAsChild(agentId);

      res.json({ agent, wallet, transactions, skills, evolutions, currentProfile: profile, survival, lineage: { parent, children } });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/inference/providers", async (_req: Request, res: Response) => {
    try {
      const providers = await storage.getAllInferenceProviders();
      res.json(providers);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/inference/status", async (_req: Request, res: Response) => {
    try {
      const providers = await storage.getAllInferenceProviders();
      const liveStatus = getProviderStatus();
      const enriched = providers.map(p => {
        const network = p.network || "";
        const live = isProviderLive(network);
        let meta: any = {};
        try { meta = JSON.parse(p.metadata || "{}"); } catch {}
        return {
          ...p,
          live,
          liveStatus: live ? "connected" : "offline",
          metadata: JSON.stringify({ ...meta, live }),
        };
      });
      res.json({
        providers: enriched,
        summary: {
          total: providers.length,
          live: enriched.filter(p => p.live).length,
          offline: enriched.filter(p => !p.live).length,
          decentralized: enriched.filter(p => p.decentralized).length,
        },
        configuredKeys: liveStatus,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/inference/providers/:providerId", async (req: Request, res: Response) => {
    try {
      const provider = await storage.getInferenceProvider(req.params.providerId);
      if (!provider) return res.status(404).json({ error: "Provider not found" });
      res.json(provider);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/inference/requests/:agentId", async (req: Request, res: Response) => {
    try {
      const requests = await storage.getInferenceRequests(req.params.agentId);
      res.json(requests);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/inference/run", async (req: Request, res: Response) => {
    try {
      const parsed = web4InferenceRequestSchema.parse(req.body);
      const result = await storage.routeInference(
        parsed.agentId,
        parsed.prompt,
        parsed.model,
        parsed.preferDecentralized,
        parsed.maxCost,
      );
      const provider = await storage.getInferenceProvider(result.providerId);
      res.json({ request: result, provider });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/web4/seed", async (_req: Request, res: Response) => {
    try {
      await storage.cleanFakeData();
      await storage.seedInferenceProviders();
      res.json({ success: true, message: "Cleaned fake data and ensured inference providers exist" });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/runner/status", async (_req: Request, res: Response) => {
    try {
      const providers = getAvailableProviders();
      const providerStatus = getProviderStatus();
      const onchain = isOnchainActive();
      let deployerBalance: string | undefined;
      let contractAddrs: any = null;
      if (onchain) {
        deployerBalance = await getDeployerBalance();
        contractAddrs = getContractAddresses();
      }
      const spending = onchain ? getSpendingStatus() : null;
      res.json({
        running: isAgentRunnerActive(),
        liveProviders: providers,
        providerCount: providers.length,
        mode: providers.length > 0 ? "live" : "no_providers",
        providers: providerStatus,
        onchain: {
          enabled: onchain,
          network: getNetworkName(),
          chainId: getChainId(),
          explorer: onchain ? getExplorerUrl("").replace("/tx/", "") : "https://bscscan.com",
          isMainnet: isMainnet(),
          deployerBalance,
          contracts: contractAddrs,
          spending,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/runner/start", async (_req: Request, res: Response) => {
    try {
      startAgentRunner();
      res.json({ success: true, running: true });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/runner/stop", async (_req: Request, res: Response) => {
    try {
      stopAgentRunner();
      res.json({ success: true, running: false });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/onchain/transactions", async (_req: Request, res: Response) => {
    try {
      const allAgents = await storage.getAllAgents();
      const txs: any[] = [];
      for (const agent of allAgents.slice(0, 10)) {
        const agentTxs = await storage.getTransactions(agent.id, 50);
        const onchainTxs = agentTxs.filter((t: any) => t.txHash && t.txHash !== "already-registered");
        txs.push(...onchainTxs.map((t: any) => ({
          ...t,
          agentName: agent.name,
          explorerUrl: t.txHash ? getExplorerUrl(t.txHash) : null,
        })));
      }
      txs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(txs.slice(0, 100));
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/contracts", async (_req: Request, res: Response) => {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const deploymentsDir = path.resolve("contracts/deployments");
      const networks: Record<string, any> = {};

      if (fs.existsSync(deploymentsDir)) {
        const files = fs.readdirSync(deploymentsDir).filter((f: string) => f.endsWith(".json"));
        for (const file of files) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(deploymentsDir, file), "utf-8"));
            const networkName = file.replace(".json", "");
            networks[networkName] = data;
          } catch {}
        }
      }

      res.json({
        deployments: networks,
        supportedNetworks: [
          { name: "BNB Chain", chainId: 56, rpc: "https://bsc-dataseed1.binance.org" },
          { name: "Base", chainId: 8453, rpc: "https://mainnet.base.org" },
          { name: "XLayer", chainId: 196, rpc: "https://rpc.xlayer.tech" },
        ],
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/deposit-info", async (_req: Request, res: Response) => {
    try {
      const revenueWallet = getRevenueWalletAddress();
      const contractChains = getSupportedChains();
      const allChains = Object.values(EVM_CHAINS).filter(c => !c.isTestnet).map(c => ({
        chainId: c.chainId,
        name: c.name,
        currency: c.currency,
        hasContracts: isContractChain(c.chainId),
        explorerUrl: c.explorerUrl,
      }));
      res.json({
        platformWallet: revenueWallet,
        contractChains,
        allSupportedChains: allChains,
        depositMethods: {
          contract: "For Base, BNB Chain, XLayer — deposit through smart contract (AgentEconomyHub.deposit)",
          direct: "For all other EVM chains — send native tokens directly to the platform wallet address",
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/revenue/summary", async (_req: Request, res: Response) => {
    try {
      const summary = await storage.getPlatformRevenueSummary();
      const explorerBases: Record<number, string> = {
        56: "https://bscscan.com",
        8453: "https://basescan.org",
        196: "https://www.oklink.com/xlayer",
      };
      res.json({ ...summary, explorerBases, revenueWallet: getRevenueWalletAddress() });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/revenue/history", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const history = await storage.getPlatformRevenue(limit);
      res.json(history);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/walletconnect-config", async (_req: Request, res: Response) => {
    const projectId = process.env.WALLETCONNECT_PROJECT_ID;
    if (!projectId) {
      return res.status(404).json({ error: "WalletConnect not configured" });
    }
    res.json({ projectId });
  });

  app.get("/api/web4/telegram-wallet", async (_req: Request, res: Response) => {
    const projectId = process.env.WALLETCONNECT_PROJECT_ID || "";
    const { getTelegramWalletPage } = await import("./telegram-wallet-page");
    res.setHeader("Content-Type", "text/html");
    res.send(getTelegramWalletPage(projectId));
  });

  const linkRateLimiter = new Map<string, number[]>();
  app.post("/api/web4/telegram-wallet/link", async (req: Request, res: Response) => {
    try {
      const clientIp = req.ip || req.headers["x-forwarded-for"] || "unknown";
      const ipKey = String(clientIp);
      const now = Date.now();
      const linkWindow = 10 * 60 * 1000;
      const maxLinks = 10;
      const attempts = (linkRateLimiter.get(ipKey) || []).filter(t => now - t < linkWindow);
      if (attempts.length >= maxLinks) {
        console.log(`[AUDIT] BLOCKED wallet link — rate limit. ip=${ipKey}, attempts=${attempts.length}`);
        return res.status(429).json({ error: "Too many requests. Please try again later." });
      }
      attempts.push(now);
      linkRateLimiter.set(ipKey, attempts);

      const { chatId, wallet, exp, sig } = req.body;
      if (!chatId || !wallet || !/^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
        return res.status(400).json({ error: "Invalid chatId or wallet address" });
      }

      if (!exp || !sig) {
        return res.status(403).json({ error: "Missing authentication. Use the wallet link from the Telegram bot." });
      }
      const { createHmac, timingSafeEqual } = await import("crypto");
      const secret = process.env.SESSION_SECRET || process.env.TELEGRAM_BOT_TOKEN;
      if (!secret) {
        return res.status(500).json({ error: "Server misconfigured — wallet linking unavailable." });
      }
      const expNum = parseInt(String(exp), 10);
      const chatIdNum = parseInt(String(chatId), 10);
      if (!Number.isFinite(expNum) || !Number.isFinite(chatIdNum) || chatIdNum <= 0) {
        return res.status(400).json({ error: "Invalid parameters." });
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (expNum < nowSec) {
        return res.status(403).json({ error: "Link expired. Request a new wallet link from the bot." });
      }
      if (expNum > nowSec + 660) {
        return res.status(403).json({ error: "Invalid expiry." });
      }
      if (typeof sig !== "string" || sig.length !== 16 || !/^[a-f0-9]{16}$/.test(sig)) {
        return res.status(403).json({ error: "Invalid signature format." });
      }
      const payload = `${chatIdNum}:${expNum}`;
      const expectedSig = createHmac("sha256", secret).update(payload).digest("hex").substring(0, 16);
      const sigBuf = Buffer.from(sig, "hex");
      const expectedBuf = Buffer.from(expectedSig, "hex");
      if (!timingSafeEqual(sigBuf, expectedBuf)) {
        return res.status(403).json({ error: "Invalid signature. Use the wallet link from the Telegram bot." });
      }

      const { linkTelegramWallet } = await import("./telegram-bot");
      linkTelegramWallet(Number(chatId), wallet);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/admin/launch-bounty", async (req: Request, res: Response) => {
    try {
      const adminKey = req.headers["x-admin-key"];
      if (!adminKey || adminKey !== process.env.SESSION_SECRET) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const { postBountyTweet } = await import("./twitter-agent");
      const { customTweet, rewardBnb, maxWinners, jobId } = req.body;
      const id = jobId || `campaign-${Date.now()}`;
      const reward = rewardBnb || "0.016";
      const winners = maxWinners || 44;
      const tweet = customTweet || "Default bounty tweet";
      const result = await postBountyTweet(id, tweet, reward, winners, tweet);
      return res.json({ success: true, tweetId: result.tweetId, tweetUrl: result.tweetUrl, jobId: id });
    } catch (e: any) {
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/admin/cleanup-duplicates", async (req: Request, res: Response) => {
    try {
      const adminKey = req.headers["x-admin-key"];
      if (!adminKey || adminKey !== process.env.SESSION_SECRET) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const allAgents = await storage.getAllAgents();
      const seen = new Map<string, string>();
      const toDelete: string[] = [];
      for (const agent of allAgents) {
        if (seen.has(agent.name)) {
          toDelete.push(agent.id);
        } else {
          seen.set(agent.name, agent.id);
        }
      }
      for (const id of toDelete) {
        await storage.deleteAgent(id);
      }
      res.json({ deleted: toDelete.length, deletedIds: toDelete, remaining: allAgents.length - toDelete.length });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/revenue/fees", async (_req: Request, res: Response) => {
    try {
      res.json({
        fees: PLATFORM_FEES,
        descriptions: {
          AGENT_CREATION_FEE: "Fee charged when creating a new agent (0.001 BNB equivalent in wei)",
          REPLICATION_FEE_BPS: "Percentage fee on replication funding (5%)",
          SKILL_PURCHASE_FEE_BPS: "Percentage fee on skill purchases (2.5%)",
          INFERENCE_MARKUP_BPS: "Markup on inference costs (10%)",
          EVOLUTION_FEE: "Fee charged for agent evolution (0.01 BNB equivalent in wei)",
          GAS_REIMBURSEMENT: "Gas costs automatically deducted from agent balances to reimburse the deployer for transaction execution",
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/marketplace/skills", async (req: Request, res: Response) => {
    try {
      const category = req.query.category as string | undefined;
      const executableOnly = req.query.executable === "true";
      const deduplicate = req.query.deduplicate !== "false";
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 200);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      let skills;
      if (executableOnly) {
        skills = await storage.getExecutableSkills();
      } else {
        skills = await storage.getTopSkills(1000);
      }
      if (category && category !== "all") {
        skills = skills.filter(s => s.category === category);
      }
      if (deduplicate) {
        const crypto = await import("crypto");
        const seen = new Map<string, typeof skills[0]>();
        for (const skill of skills) {
          const hash = crypto.createHash("md5").update(skill.code || "").digest("hex");
          const existing = seen.get(hash);
          if (!existing || skill.executionCount > existing.executionCount) {
            seen.set(hash, skill);
          }
        }
        skills = Array.from(seen.values()).sort((a, b) => b.executionCount - a.executionCount);
      }
      const total = skills.length;
      skills = skills.slice(offset, offset + limit);
      const agents = await storage.getAllAgents();
      const agentMap = new Map(agents.map(a => [a.id, a]));
      const enriched = skills.map(s => ({
        ...s,
        agentName: agentMap.get(s.agentId)?.name || "Unknown",
        agentModel: agentMap.get(s.agentId)?.modelType || "unknown",
        priceFormatted: (Number(BigInt(s.priceAmount)) / 1e18).toFixed(6) + " BNB",
        ratingFormatted: s.totalRatings > 0 ? (s.avgRating / 100).toFixed(1) : "No ratings",
      }));
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/marketplace/skills/:skillId", async (req: Request, res: Response) => {
    try {
      const skill = await storage.getSkill(req.params.skillId);
      if (!skill) return res.status(404).json({ error: "Skill not found" });
      const agent = await storage.getAgent(skill.agentId);
      const executions = await storage.getSkillExecutions(skill.id, 10);
      res.json({
        ...skill,
        agentName: agent?.name || "Unknown",
        agentModel: agent?.modelType || "unknown",
        priceFormatted: (Number(BigInt(skill.priceAmount)) / 1e18).toFixed(6) + " BNB",
        ratingFormatted: skill.totalRatings > 0 ? (skill.avgRating / 100).toFixed(1) : "No ratings",
        recentExecutions: executions.map(e => ({
          id: e.id,
          status: e.status,
          latencyMs: e.latencyMs,
          callerType: e.callerType,
          rating: e.rating,
          createdAt: e.createdAt,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  function computeSkillTier(executionCount: number): string {
    if (executionCount >= SKILL_TIERS.legendary.minExecutions) return "legendary";
    if (executionCount >= SKILL_TIERS.diamond.minExecutions) return "diamond";
    if (executionCount >= SKILL_TIERS.gold.minExecutions) return "gold";
    if (executionCount >= SKILL_TIERS.silver.minExecutions) return "silver";
    return "bronze";
  }

  function getTierMultiplier(tier: string): number {
    return (SKILL_TIERS as any)[tier]?.priceMultiplier || 1.0;
  }

  app.get("/api/marketplace/user-credits", async (req: Request, res: Response) => {
    try {
      const sessionId = req.query.sessionId as string;
      if (!sessionId) return res.json({ freeExecutionsUsed: 0, freeExecutionsRemaining: FREE_EXECUTIONS_LIMIT, limit: FREE_EXECUTIONS_LIMIT });
      const credits = await storage.createOrGetUserCredits(sessionId);
      res.json({
        freeExecutionsUsed: credits.freeExecutionsUsed,
        freeExecutionsRemaining: Math.max(0, FREE_EXECUTIONS_LIMIT - credits.freeExecutionsUsed),
        limit: FREE_EXECUTIONS_LIMIT,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/marketplace/skill-tiers", async (_req: Request, res: Response) => {
    res.json({ tiers: SKILL_TIERS, royaltyBps: EXECUTION_ROYALTY_BPS });
  });

  app.get("/api/marketplace/payment-info", async (_req: Request, res: Response) => {
    res.json({
      recipientAddress: getRevenueWalletAddress(),
      supportedChains: getSupportedChains(),
      freeExecutionsLimit: FREE_EXECUTIONS_LIMIT,
      royaltyBps: EXECUTION_ROYALTY_BPS,
      tiers: SKILL_TIERS,
      protocol: "HTTP-402",
      description: "Send native token (BNB/ETH/OKB) to the recipient address to pay for skill execution. Include the transaction hash in your execution request.",
    });
  });

  app.post("/api/marketplace/skills/:skillId/execute", async (req: Request, res: Response) => {
    try {
      const parsed = executeSkillRequestSchema.parse(req.body);
      const skill = await storage.getSkill(req.params.skillId);
      if (!skill) return res.status(404).json({ error: "Skill not found" });
      if (!skill.isExecutable || !skill.code) {
        return res.status(400).json({ error: "This skill is not executable" });
      }

      if (parsed.callerType === "wallet") {
        if (!parsed.callerWallet || !/^0x[a-fA-F0-9]{40}$/.test(parsed.callerWallet)) {
          return res.status(400).json({ error: "callerWallet (valid 0x address) is required when callerType is 'wallet'" });
        }
      }

      if (parsed.callerType === "user" || parsed.callerType === "wallet") {
        const walletAddr = parsed.callerWallet?.toLowerCase();
        const sessionId = parsed.callerType === "wallet" && walletAddr
          ? `wallet:${walletAddr}`
          : (parsed.sessionId || "anonymous");
        const hasTxHash = parsed.txHash && parsed.txHash.length > 0;

        if (!hasTxHash) {
          const credits = await storage.createOrGetUserCredits(sessionId);
          if (credits.freeExecutionsUsed >= FREE_EXECUTIONS_LIMIT) {
            const tierMult = getTierMultiplier(skill.tier);
            const baseRoyalty = (BigInt(skill.priceAmount) * BigInt(EXECUTION_ROYALTY_BPS)) / BigInt(10000);
            const executionCost = BigInt(Math.floor(Number(baseRoyalty) * tierMult));

            return res.status(402).json({
              error: "Payment required",
              code: "PAYMENT_REQUIRED",
              freeExecutionsUsed: credits.freeExecutionsUsed,
              limit: FREE_EXECUTIONS_LIMIT,
              payment: {
                skillId: skill.id,
                skillName: skill.name,
                amount: executionCost.toString(),
                amountFormatted: (Number(executionCost) / 1e18).toFixed(8),
                currency: "BNB",
                recipientAddress: getRevenueWalletAddress(),
                supportedChains: getSupportedChains(),
                tier: skill.tier,
              },
              message: parsed.callerType === "wallet"
                ? "Send payment to the recipient address and include txHash in your next request"
                : "Connect a wallet and pay to execute this skill",
            });
          }
          await storage.incrementUserFreeExecutions(sessionId);
        } else {
          const tierMult = getTierMultiplier(skill.tier);
          const baseRoyalty = (BigInt(skill.priceAmount) * BigInt(EXECUTION_ROYALTY_BPS)) / BigInt(10000);
          const executionCost = BigInt(Math.floor(Number(baseRoyalty) * tierMult));

          const verification = await verifyPaymentTransaction(
            parsed.txHash!,
            executionCost.toString(),
            parsed.chainId
          );

          if (!verification.verified) {
            return res.status(402).json({
              error: "Payment verification failed",
              code: "PAYMENT_INVALID",
              details: verification.error,
              payment: {
                skillId: skill.id,
                skillName: skill.name,
                amount: executionCost.toString(),
                amountFormatted: (Number(executionCost) / 1e18).toFixed(8),
                currency: "BNB",
                recipientAddress: getRevenueWalletAddress(),
                supportedChains: getSupportedChains(),
              },
            });
          }

          await storage.recordPlatformRevenue({
            feeType: "skill_execution_payment",
            amount: verification.amount,
            agentId: skill.agentId,
            referenceId: skill.id,
            description: `${parsed.callerType === "wallet" ? "External wallet" : "User"} paid for skill execution: ${skill.name} (${skill.tier} tier)`,
            txHash: parsed.txHash!,
            chainId: parsed.chainId,
          });
        }
      }

      const { fetchExternalData } = await import("./skill-executor");
      const externalData = await fetchExternalData();
      const usesAsyncExec = ["crypto-data", "web-data"].includes(skill.category) || /\bsafeFetch\s*\(/.test(skill.code) || /\bawait\b/.test(skill.code);
      const result = usesAsyncExec
        ? await executeSkillAsync(skill.code, parsed.input, skill.inputSchema, externalData)
        : executeSkillCode(skill.code, parsed.input, skill.inputSchema, externalData);

      const tierMultiplier = getTierMultiplier(skill.tier);
      const baseRoyalty = (BigInt(skill.priceAmount) * BigInt(EXECUTION_ROYALTY_BPS)) / BigInt(10000);
      const royalty = BigInt(Math.floor(Number(baseRoyalty) * tierMultiplier));
      const royaltyStr = royalty.toString();

      const execution = await storage.createSkillExecution({
        skillId: skill.id,
        callerType: parsed.callerType,
        callerId: parsed.callerId || parsed.callerWallet || null,
        inputJson: JSON.stringify(parsed.input),
        outputJson: result.success ? JSON.stringify(result.output) : null,
        status: result.success ? "success" : "error",
        errorMessage: result.error || null,
        latencyMs: result.latencyMs,
        costWei: royaltyStr,
      });

      await storage.updateSkillExecutionCount(skill.id);

      if (result.success && royalty > 0n) {
        const creatorWallet = await storage.getWallet(skill.agentId);
        if (creatorWallet) {
          const newBal = (BigInt(creatorWallet.balance) + royalty).toString();
          await storage.updateWalletBalance(skill.agentId, newBal, royaltyStr, "0");
          await storage.createTransaction({
            agentId: skill.agentId,
            type: "earn_royalty",
            amount: royaltyStr,
            description: `Skill execution royalty: ${skill.name} (${skill.tier} tier)`,
            referenceType: "skill_execution",
            referenceId: execution.id,
          });
          await storage.updateSkillRoyalties(skill.id, royaltyStr);
        }
      }

      if (parsed.callerType === "agent" && parsed.callerId) {
        const wallet = await storage.getWallet(parsed.callerId);
        if (wallet) {
          const usageFee = BigInt(skill.priceAmount) / BigInt(10);
          if (BigInt(wallet.balance) >= usageFee) {
            const newBal = (BigInt(wallet.balance) - usageFee).toString();
            await storage.updateWalletBalance(parsed.callerId, newBal, "0", usageFee.toString());
          }
        }
      }

      const newExecCount = (skill.executionCount || 0) + 1;
      const newTier = computeSkillTier(newExecCount);
      if (newTier !== skill.tier) {
        await storage.updateSkillTier(skill.id, newTier);
      }

      res.json({
        executionId: execution.id,
        success: result.success,
        output: result.output,
        error: result.error,
        latencyMs: result.latencyMs,
        skillName: skill.name,
        agentId: skill.agentId,
        tier: newTier,
        royaltyPaid: royaltyStr,
        hasExternalData: usesAsyncExec,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/marketplace/skills/:skillId/rate", async (req: Request, res: Response) => {
    try {
      const parsed = rateSkillRequestSchema.parse(req.body);
      const skill = await storage.getSkill(req.params.skillId);
      if (!skill) return res.status(404).json({ error: "Skill not found" });
      await storage.updateSkillRating(skill.id, parsed.rating);
      res.json({ success: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/platform/stats", async (_req: Request, res: Response) => {
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const [txCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM agent_transactions`)).rows;
      const [agentCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM agents`)).rows;
      const [purchaseCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM skill_purchases`)).rows;
      const [revenueData] = (await db.execute(sql`SELECT SUM(amount::numeric) as total, COUNT(*) as cnt FROM platform_revenue`)).rows;
      const [uniqueWallets] = (await db.execute(sql`SELECT COUNT(DISTINCT creator_wallet) as cnt FROM agents WHERE creator_wallet IS NOT NULL`)).rows;
      const [onchainAgents] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM agents WHERE erc8004_registered = true OR onchain_registered = true`)).rows;

      const crypto = await import("crypto");
      const allSkills = await storage.getTopSkills(5000);
      const uniqueCodeHashes = new Set<string>();
      for (const s of allSkills) {
        const hash = crypto.createHash("md5").update(s.code || "").digest("hex");
        uniqueCodeHashes.add(hash);
      }

      res.json({
        onchainUsers: Number(uniqueWallets?.cnt || 0),
        transactions: Number(txCount?.cnt || 0),
        skills: uniqueCodeHashes.size,
        skillsTotal: allSkills.length,
        agents: Number(agentCount?.cnt || 0),
        skillPurchases: Number(purchaseCount?.cnt || 0),
        revenueEntries: Number((revenueData as any)?.cnt || 0),
        totalRevenue: (revenueData as any)?.total || "0",
        visitors: Number(uniqueWallets?.cnt || 0),
        onchainAgents: Number(onchainAgents?.cnt || 0),
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/rewards/leaderboard", async (_req: Request, res: Response) => {
    try {
      const leaderboard = await storage.getRewardsLeaderboard(20);
      res.json(leaderboard);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/marketplace/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getMarketplaceStats();
      const crypto = await import("crypto");
      const allSkills = await storage.getTopSkills(5000);
      const uniqueHashes = new Set<string>();
      for (const s of allSkills) {
        uniqueHashes.add(crypto.createHash("md5").update(s.code || "").digest("hex"));
      }
      res.json({ ...stats, uniqueSkills: uniqueHashes.size });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/marketplace/reprice", async (_req: Request, res: Response) => {
    try {
      const allSkills = await storage.getTopSkills(5000);
      let repriced = 0;
      for (const skill of allSkills) {
        const code = skill.code || "";
        let quality = 0;
        if (/aiChat|aiJson|fetch.*inference|openai|anthropic|deepseek/i.test(code)) quality += 40;
        if (/safeFetch\s*\(|fetch\s*\(|websocket|ethers|web3/i.test(code)) quality += 20;
        if (/try\s*\{/.test(code) && /catch/.test(code)) quality += 10;
        const lines = code.split("\n").filter((l: string) => l.trim()).length;
        if (lines > 50) quality += 5;
        if (lines > 100) quality += 5;
        if (lines > 200) quality += 5;
        if (skill.executionCount > 10) quality += 10;
        if (skill.totalRatings > 0 && skill.avgRating > 300) quality += 10;

        let newPrice: string;
        let newTier: string;
        if (quality >= 80) { newPrice = "150000000000000000"; newTier = "legendary"; }
        else if (quality >= 50) { newPrice = "50000000000000000"; newTier = "gold"; }
        else if (quality >= 20) { newPrice = "5000000000000000"; newTier = "silver"; }
        else { newPrice = "100000000000000"; newTier = "bronze"; }

        if (skill.priceAmount !== newPrice || skill.tier !== newTier) {
          await storage.updateSkill(skill.id, { priceAmount: newPrice, tier: newTier });
          repriced++;
        }
      }
      res.json({ total: allSkills.length, repriced });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/marketplace/categories", async (_req: Request, res: Response) => {
    try {
      const skills = await storage.getTopSkills(200);
      const categoryCounts: Record<string, number> = {};
      skills.forEach(s => {
        categoryCounts[s.category] = (categoryCounts[s.category] || 0) + 1;
      });
      res.json(categoryCounts);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/marketplace/pipelines", async (_req: Request, res: Response) => {
    try {
      const pipelines = await storage.getPipelines(50);
      const enriched = await Promise.all(pipelines.map(async (p) => {
        const skills = await Promise.all(p.skillIds.map(id => storage.getSkill(id)));
        const agent = await storage.getAgent(p.creatorAgentId);
        return {
          ...p,
          skills: skills.filter(Boolean).map(s => ({ id: s!.id, name: s!.name, category: s!.category, tier: s!.tier })),
          creatorName: agent?.name || "Unknown",
          stepCount: p.skillIds.length,
        };
      }));
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/marketplace/pipelines", async (req: Request, res: Response) => {
    try {
      const parsed = createPipelineRequestSchema.parse(req.body);
      const agent = await storage.getAgent(parsed.creatorAgentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      for (const skillId of parsed.skillIds) {
        const skill = await storage.getSkill(skillId);
        if (!skill || !skill.isExecutable) {
          return res.status(400).json({ error: `Skill ${skillId} not found or not executable` });
        }
      }
      const pipeline = await storage.createPipeline({
        name: parsed.name,
        description: parsed.description || null,
        creatorAgentId: parsed.creatorAgentId,
        skillIds: parsed.skillIds,
        priceAmount: parsed.priceAmount,
        isActive: true,
      });
      res.json(pipeline);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/marketplace/pipelines/:pipelineId/execute", async (req: Request, res: Response) => {
    try {
      const parsed = executePipelineRequestSchema.parse(req.body);
      const pipeline = await storage.getPipeline(req.params.pipelineId);
      if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

      if (parsed.callerType === "user") {
        const sessionId = parsed.sessionId || "anonymous";
        const credits = await storage.createOrGetUserCredits(sessionId);
        if (credits.freeExecutionsUsed >= FREE_EXECUTIONS_LIMIT) {
          return res.status(402).json({
            error: "Free execution limit reached",
            limit: FREE_EXECUTIONS_LIMIT,
            message: "Connect a wallet to continue using pipelines",
          });
        }
        await storage.incrementUserFreeExecutions(sessionId);
      }

      const skills = [];
      for (const skillId of pipeline.skillIds) {
        const skill = await storage.getSkill(skillId);
        if (!skill || !skill.isExecutable || !skill.code) {
          return res.status(400).json({ error: `Skill ${skillId} in pipeline is missing or not executable` });
        }
        skills.push(skill);
      }

      let currentInput = parsed.input;
      const stepResults: Array<{ skillName: string; success: boolean; output: any; latencyMs: number }> = [];
      let totalLatency = 0;
      let totalRoyalty = 0n;

      for (const skill of skills) {
        const { fetchExternalData } = await import("./skill-executor");
        const extData = await fetchExternalData();
        const usesAsyncExec = ["crypto-data", "web-data"].includes(skill.category) || /\bsafeFetch\s*\(/.test(skill.code) || /\bawait\b/.test(skill.code);
        const result = usesAsyncExec
          ? await executeSkillAsync(skill.code, currentInput, skill.inputSchema, extData)
          : executeSkillCode(skill.code, currentInput, skill.inputSchema, extData);

        stepResults.push({ skillName: skill.name, success: result.success, output: result.output, latencyMs: result.latencyMs });
        totalLatency += result.latencyMs;

        if (!result.success) {
          return res.json({
            pipelineId: pipeline.id,
            success: false,
            failedAtStep: stepResults.length,
            failedSkill: skill.name,
            error: result.error,
            stepResults,
            totalLatencyMs: totalLatency,
          });
        }

        const baseRoyalty = (BigInt(skill.priceAmount) * BigInt(EXECUTION_ROYALTY_BPS)) / BigInt(10000);
        const tierMult = getTierMultiplier(skill.tier);
        const royalty = BigInt(Math.floor(Number(baseRoyalty) * tierMult));
        totalRoyalty += royalty;

        if (royalty > 0n) {
          const creatorWallet = await storage.getWallet(skill.agentId);
          if (creatorWallet) {
            const newBal = (BigInt(creatorWallet.balance) + royalty).toString();
            await storage.updateWalletBalance(skill.agentId, newBal, royalty.toString(), "0");
            await storage.createTransaction({
              agentId: skill.agentId,
              type: "earn_royalty",
              amount: royalty.toString(),
              description: `Pipeline royalty: ${pipeline.name} → ${skill.name}`,
              referenceType: "pipeline_execution",
              referenceId: pipeline.id,
            });
            await storage.updateSkillRoyalties(skill.id, royalty.toString());
          }
        }

        await storage.updateSkillExecutionCount(skill.id);
        const newTier = computeSkillTier((skill.executionCount || 0) + 1);
        if (newTier !== skill.tier) {
          await storage.updateSkillTier(skill.id, newTier);
        }

        if (result.output && typeof result.output === "object") {
          currentInput = result.output;
        }
      }

      await storage.updatePipelineExecutionCount(pipeline.id);
      await storage.updatePipelineRoyalties(pipeline.id, totalRoyalty.toString());
      const newPipelineTier = computeSkillTier((pipeline.executionCount || 0) + 1);
      if (newPipelineTier !== pipeline.tier) {
        await storage.updatePipelineTier(pipeline.id, newPipelineTier);
      }

      res.json({
        pipelineId: pipeline.id,
        success: true,
        finalOutput: currentInput,
        stepResults,
        totalLatencyMs: totalLatency,
        totalRoyaltyPaid: totalRoyalty.toString(),
        tier: newPipelineTier,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/web4/jobs/create", async (req: Request, res: Response) => {
    try {
      const parsed = createJobRequestSchema.parse(req.body);
      const client = await storage.getAgent(parsed.clientAgentId);
      if (!client) return res.status(404).json({ error: "Client agent not found" });
      const wallet = await storage.getWallet(parsed.clientAgentId);
      if (!wallet || BigInt(wallet.balance) < BigInt(parsed.budget)) {
        return res.status(400).json({ error: "Insufficient balance to post job" });
      }
      const escrow = BigInt(parsed.budget);
      const newBal = (BigInt(wallet.balance) - escrow).toString();
      await storage.updateWalletBalance(parsed.clientAgentId, newBal, "0", escrow.toString());
      const job = await storage.createJob({
        clientAgentId: parsed.clientAgentId,
        title: parsed.title,
        description: parsed.description,
        category: parsed.category,
        budget: parsed.budget,
        status: "open",
        escrowAmount: escrow.toString(),
      });
      res.json(job);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/web4/jobs", async (req: Request, res: Response) => {
    try {
      const category = req.query.category as string | undefined;
      const jobs = await storage.getOpenJobs(category);
      const agents = await storage.getAllAgents();
      const agentMap = new Map(agents.map(a => [a.id, a]));
      const enriched = jobs.map(j => ({
        ...j,
        clientName: agentMap.get(j.clientAgentId)?.name || "Unknown",
        budgetFormatted: (Number(BigInt(j.budget)) / 1e18).toFixed(6) + " BNB",
      }));
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/jobs/:jobId/accept", async (req: Request, res: Response) => {
    try {
      const { workerAgentId } = req.body;
      if (!workerAgentId) return res.status(400).json({ error: "Worker agent ID required" });
      const job = await storage.acceptJob(req.params.jobId, workerAgentId);
      if (!job) return res.status(404).json({ error: "Job not found or already taken" });
      res.json(job);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/web4/jobs/:jobId/complete", async (req: Request, res: Response) => {
    try {
      const { resultJson } = req.body;
      const job = await storage.completeJob(req.params.jobId, resultJson || "{}");
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.workerAgentId && job.escrowAmount) {
        const workerWallet = await storage.getWallet(job.workerAgentId);
        if (workerWallet) {
          const newBal = (BigInt(workerWallet.balance) + BigInt(job.escrowAmount)).toString();
          await storage.updateWalletBalance(job.workerAgentId, newBal, job.escrowAmount, "0");
        }
      }
      res.json(job);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/protocol", async (_req: Request, res: Response) => {
    const contracts = getContractAddresses();
    res.json({
      name: "BUILD4",
      version: "1.0.0",
      description: "Permissionless AI agent skill marketplace. No registration required. Wallet address is identity. Pay and proceed.",
      philosophy: "No gatekeepers. No sign-up. No approval. Any agent from any platform that can speak HTTP and sign transactions is welcome.",
      identity: {
        type: "wallet",
        description: "Your wallet address (0x...) is your identity. No accounts, no passwords, no API keys.",
      },
      chains: {
        bnbChain: { chainId: 56, currency: "BNB", rpcUrl: "https://bsc-dataseed.binance.org" },
        base: { chainId: 8453, currency: "ETH", rpcUrl: "https://mainnet.base.org" },
        xLayer: { chainId: 196, currency: "OKB", rpcUrl: "https://rpc.xlayer.tech" },
      },
      contracts: {
        hub: contracts,
        description: "AgentEconomyHub - trustless wallet layer. Deposit, withdraw, transfer. All on-chain.",
      },
      revenueWallet: getRevenueWalletAddress(),
      paymentProtocol: {
        type: "HTTP-402",
        description: "When free tier (5 executions per wallet) is exhausted, API returns HTTP 402 with payment details. Send native token to revenue wallet, then retry with txHash.",
        freeExecutions: FREE_EXECUTIONS_LIMIT,
        flow: [
          "1. POST /api/marketplace/skills/:skillId/execute with callerType='wallet', callerWallet='0x...', input={...}",
          "2. If free tier available: skill executes immediately, response includes output",
          "3. If free tier exhausted: HTTP 402 response with payment.amount, payment.recipientAddress",
          "4. Send payment on-chain (BNB/ETH/OKB) to recipientAddress",
          "5. Retry request with txHash and chainId included",
          "6. Skill executes, royalty credited to creator",
        ],
      },
      endpoints: {
        discovery: {
          protocol: "GET /api/protocol",
          listSkills: "GET /api/marketplace/skills",
          skillDetail: "GET /api/marketplace/skills/:skillId",
          tiers: "GET /api/marketplace/skill-tiers",
          paymentInfo: "GET /api/marketplace/payment-info",
        },
        execution: {
          execute: "POST /api/marketplace/skills/:skillId/execute",
          description: "Execute a skill. Body: { input: {...}, callerType: 'wallet', callerWallet: '0x...' }",
        },
        submission: {
          submit: "POST /api/marketplace/skills/submit",
          description: "List a skill permissionlessly. Body: { name, description, category, priceAmount, code, inputSchema, walletAddress }",
        },
        lookup: {
          walletSkills: "GET /api/marketplace/wallet/:address/skills",
          walletExecutions: "GET /api/marketplace/wallet/:address/executions",
          walletStats: "GET /api/marketplace/wallet/:address/stats",
        },
        bountyBoard: {
          listBounties: "GET /api/services/bounties",
          getBounty: "GET /api/services/bounties/:jobId",
          postBounty: "POST /api/services/bounties",
          postBountyDescription: "Post a bounty permissionlessly. Body: { title, description, category, budget (in wei), walletAddress }. Categories: development, data-collection, analysis, content, testing, research, general. No registration required — wallet address is identity.",
          submitWork: "POST /api/services/bounties/:jobId/submit",
          submitWorkDescription: "Submit a solution to a bounty. Body: { workerWallet, resultJson }. Max 10 submissions per bounty, max 3 per wallet.",
          activityFeed: "GET /api/services/bounty-feed",
          activityFeedDescription: "Live feed of bounty events (postings, submissions, completions). Optional ?limit=N (max 100).",
        },
      },
      fees: {
        executionRoyalty: `${EXECUTION_ROYALTY_BPS / 100}% of skill price goes to creator`,
        skillListingFee: `${Number(PLATFORM_FEES.SKILL_LISTING_FEE) / 1e18} BNB per listing`,
        tiers: SKILL_TIERS,
      },
    });
  });

  app.post("/api/marketplace/skills/submit", async (req: Request, res: Response) => {
    try {
      const parsed = submitSkillRequestSchema.parse(req.body);

      if (!/^0x[a-fA-F0-9]{40}$/.test(parsed.walletAddress)) {
        return res.status(400).json({ error: "Invalid wallet address format" });
      }

      const validation = validateSkillCode(parsed.code);
      if (!validation.valid) {
        return res.status(400).json({ error: `Invalid skill code: ${validation.error}` });
      }

      let agent = await storage.getAgentByWallet(parsed.walletAddress.toLowerCase());
      if (!agent) {
        const shortAddr = parsed.walletAddress.slice(0, 6) + "..." + parsed.walletAddress.slice(-4);
        agent = await storage.createAgent({
          name: `ext-${shortAddr}`,
          bio: `External agent (${shortAddr})`,
          modelType: "external",
          status: "active",
          creatorWallet: parsed.walletAddress.toLowerCase(),
        });
        await storage.createWallet({ agentId: agent.id, balance: "0", totalEarned: "0", totalSpent: "0", status: "active" });
      }

      const skill = await storage.createSkill({
        agentId: agent.id,
        name: parsed.name,
        description: parsed.description || "",
        priceAmount: parsed.priceAmount,
        category: parsed.category,
      });

      if (parsed.code) {
        await storage.updateSkillCode(skill.id, parsed.code, parsed.inputSchema || {});
      }

      res.status(201).json({
        skillId: skill.id,
        name: skill.name,
        agentId: agent.id,
        walletAddress: parsed.walletAddress.toLowerCase(),
        message: "Skill listed permissionlessly. Royalties will be credited to this agent's balance.",
        executeUrl: `/api/marketplace/skills/${skill.id}/execute`,
      });
    } catch (e: any) {
      if (e.name === "ZodError") {
        return res.status(400).json({ error: "Validation failed", details: e.errors });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/marketplace/wallet/:address/skills", async (req: Request, res: Response) => {
    try {
      const addr = req.params.address.toLowerCase();
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }

      const agent = await storage.getAgentByWallet(addr);
      if (!agent) {
        return res.json({ walletAddress: addr, skills: [], message: "No activity from this wallet" });
      }

      const allSkills = await storage.getTopSkills(1000);
      const walletSkills = allSkills.filter(s => s.agentId === agent.id);

      res.json({
        walletAddress: addr,
        agentId: agent.id,
        agentName: agent.name,
        skills: walletSkills.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          category: s.category,
          tier: s.tier,
          executionCount: s.executionCount,
          priceFormatted: (Number(BigInt(s.priceAmount)) / 1e18).toFixed(6) + " BNB",
          totalRoyalties: (Number(BigInt(s.totalRoyalties || "0")) / 1e18).toFixed(6) + " BNB",
          isExecutable: s.isExecutable,
          executeUrl: `/api/marketplace/skills/${s.id}/execute`,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/marketplace/wallet/:address/executions", async (req: Request, res: Response) => {
    try {
      const addr = req.params.address.toLowerCase();
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }

      const allSkills = await storage.getTopSkills(1000);
      const executionsAsUser: any[] = [];

      for (const skill of allSkills.slice(0, 50)) {
        const execs = await storage.getSkillExecutions(skill.id, 100);
        const walletExecs = execs.filter(e =>
          e.callerId?.toLowerCase() === addr ||
          e.callerId === `wallet:${addr}`
        );
        executionsAsUser.push(...walletExecs.map(e => ({
          executionId: e.id,
          skillId: skill.id,
          skillName: skill.name,
          status: e.status,
          latencyMs: e.latencyMs,
          costWei: e.costWei,
          createdAt: e.createdAt,
        })));
      }

      res.json({
        walletAddress: addr,
        executions: executionsAsUser.slice(0, 50),
        total: executionsAsUser.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/marketplace/wallet/:address/stats", async (req: Request, res: Response) => {
    try {
      const addr = req.params.address.toLowerCase();
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }

      const agent = await storage.getAgentByWallet(addr);
      let skillCount = 0;
      let totalRoyaltiesBNB = "0";
      let totalExecutions = 0;

      if (agent) {
        const wallet = await storage.getWallet(agent.id);
        const allSkills = await storage.getTopSkills(1000);
        const walletSkills = allSkills.filter(s => s.agentId === agent.id);
        skillCount = walletSkills.length;
        totalExecutions = walletSkills.reduce((sum, s) => sum + (s.executionCount || 0), 0);
        const totalRoyaltiesWei = walletSkills.reduce(
          (sum, s) => sum + BigInt(s.totalRoyalties || "0"), 0n
        );
        totalRoyaltiesBNB = (Number(totalRoyaltiesWei) / 1e18).toFixed(8);

        res.json({
          walletAddress: addr,
          agentId: agent.id,
          agentName: agent.name,
          balanceBNB: wallet ? (Number(BigInt(wallet.balance)) / 1e18).toFixed(8) : "0",
          skillCount,
          totalExecutions,
          totalRoyaltiesBNB,
          registered: true,
        });
      } else {
        res.json({
          walletAddress: addr,
          registered: false,
          skillCount: 0,
          totalExecutions: 0,
          totalRoyaltiesBNB: "0",
          message: "This wallet has no activity on BUILD4. List a skill or execute one to get started — no registration needed.",
        });
      }
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/outreach/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getOutreachStats();
      const platforms = getPlatformRegistry();
      res.json({ ...stats, knownPlatforms: platforms.length });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/outreach/targets", async (_req: Request, res: Response) => {
    try {
      const targets = await storage.getOutreachTargets();
      res.json(targets);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/outreach/campaigns", async (_req: Request, res: Response) => {
    try {
      const campaigns = await storage.getOutreachCampaigns();
      res.json(campaigns);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/outreach/message", (req: Request, res: Response) => {
    res.json(getOutreachMessage(getBaseUrl(req)));
  });

  app.get("/api/outreach/beacon", async (req: Request, res: Response) => {
    try {
      const baseUrl = getBaseUrl(req);
      const beacons = await runOnchainBeacon(baseUrl);
      res.json(beacons);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/outreach/seed", async (_req: Request, res: Response) => {
    try {
      const count = await seedKnownPlatforms();
      res.json({ seeded: count, message: `${count} new platforms added to outreach registry` });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/outreach/run", async (req: Request, res: Response) => {
    try {
      const baseUrl = getBaseUrl(req);
      const type = req.body?.type || "full";

      if (type === "http") {
        await seedKnownPlatforms();
        const results = await runHttpOutreach(baseUrl);
        const campaign = await storage.createOutreachCampaign({
          type: "http",
          status: "completed",
          targetsSent: results.sent,
          targetsReached: results.reached,
          targetsFailed: results.failed,
          message: `HTTP outreach to ${results.sent} platforms`,
          startedAt: new Date(),
          completedAt: new Date(),
        });
        res.json({ campaign, results });
      } else if (type === "beacon") {
        const beacons = await runOnchainBeacon(baseUrl);
        const campaign = await storage.createOutreachCampaign({
          type: "beacon",
          status: "completed",
          targetsSent: beacons.beacons.length,
          targetsReached: beacons.beacons.length,
          targetsFailed: 0,
          beaconTxHashes: beacons.beacons.map(b => b.calldata),
          message: `On-chain beacon prepared for ${beacons.beacons.length} chains`,
          startedAt: new Date(),
          completedAt: new Date(),
        });
        res.json({ campaign, beacons });
      } else {
        const campaign = await runFullOutreach(baseUrl);
        res.json({ campaign });
      }
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/outreach/platforms", (_req: Request, res: Response) => {
    res.json(getPlatformRegistry());
  });

  app.post("/api/outreach/recruit", async (req: Request, res: Response) => {
    try {
      const baseUrl = getBaseUrl(req);
      await seedKnownPlatforms();
      const results = await runDirectRecruitment(baseUrl);
      const campaign = await storage.createOutreachCampaign({
        type: "recruitment",
        status: "completed",
        targetsSent: results.messaged,
        targetsReached: results.accepted,
        targetsFailed: results.rejected,
        message: `Direct recruitment: ${results.messaged} messages sent, ${results.accepted} accepted, ${results.rejected} rejected`,
        startedAt: new Date(),
        completedAt: new Date(),
      });
      res.json({ campaign, results });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/outreach/formats", (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    res.json(getAnnouncementFormats(baseUrl));
  });

  app.post("/api/outreach/auto-broadcast/start", (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    const intervalHours = req.body?.intervalHours || 6;
    startAutoBroadcast(baseUrl, intervalHours * 60 * 60 * 1000);
    res.json({ status: "started", intervalHours });
  });

  app.post("/api/outreach/auto-broadcast/stop", (_req: Request, res: Response) => {
    stopAutoBroadcast();
    res.json({ status: "stopped" });
  });

  app.get("/api/outreach/auto-broadcast/status", (_req: Request, res: Response) => {
    res.json(getAutoBroadcastStatus());
  });

  // ============================================================
  // ERC-8004 Trustless Agents Registry API
  // ============================================================

  app.get("/api/standards/erc8004/identities", async (req: Request, res: Response) => {
    try {
      const ownerWallet = req.query.ownerWallet as string | undefined;
      const identities = await storage.getErc8004Identities(ownerWallet);
      res.json(identities);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/standards/erc8004/identities/:id", async (req: Request, res: Response) => {
    try {
      const identity = await storage.getErc8004Identity(req.params.id);
      if (!identity) { res.status(404).json({ error: "Identity not found" }); return; }
      res.json(identity);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/standards/erc8004/identities", async (req: Request, res: Response) => {
    try {
      const parsed = insertErc8004IdentitySchema.parse(req.body);
      const identity = await storage.createErc8004Identity(parsed);
      res.status(201).json(identity);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch("/api/standards/erc8004/identities/:id", async (req: Request, res: Response) => {
    try {
      const allowed = insertErc8004IdentitySchema.partial().parse(req.body);
      const updated = await storage.updateErc8004Identity(req.params.id, allowed);
      if (!updated) { res.status(404).json({ error: "Identity not found" }); return; }
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/standards/erc8004/reputation", async (req: Request, res: Response) => {
    try {
      const agentIdentityId = req.query.agentIdentityId as string;
      if (!agentIdentityId) { res.status(400).json({ error: "agentIdentityId query param required" }); return; }
      const reputation = await storage.getErc8004Reputation(agentIdentityId);
      res.json(reputation);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/standards/erc8004/reputation", async (req: Request, res: Response) => {
    try {
      const parsed = insertErc8004ReputationSchema.parse(req.body);
      const feedback = await storage.createErc8004Reputation(parsed);
      res.status(201).json(feedback);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/standards/erc8004/reputation/wallet/:address", async (req: Request, res: Response) => {
    try {
      const wallet = req.params.address.toLowerCase();
      const allIdentities = await storage.getErc8004Identities();
      let allRepEntries: any[] = [];
      for (const identity of allIdentities) {
        const entries = await storage.getErc8004Reputation(identity.id);
        const walletEntries = entries.filter(e => e.clientWallet.toLowerCase() === wallet);
        allRepEntries.push(...walletEntries);
      }
      const bountyEntries = allRepEntries.filter(e => e.tag1 === "bounty");
      const bnbBounties = bountyEntries.filter(e => e.tag2 === "BNB Chain");
      const baseBounties = bountyEntries.filter(e => e.tag2 === "Base");
      const bnbScore = bnbBounties.reduce((sum, e) => sum + (e.value || 0), 0);
      const baseScore = baseBounties.reduce((sum, e) => sum + (e.value || 0), 0);

      res.json({
        wallet,
        bnbScore: bnbScore + baseScore,
        crossChainBreakdown: {
          fromBnb: bnbScore,
          fromBase: baseScore,
        },
        totalBounties: bountyEntries.length,
        totalScore: bountyEntries.reduce((sum, e) => sum + (e.value || 0), 0),
        entries: allRepEntries,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/standards/erc8004/validations", async (req: Request, res: Response) => {
    try {
      const agentIdentityId = req.query.agentIdentityId as string;
      if (!agentIdentityId) { res.status(400).json({ error: "agentIdentityId query param required" }); return; }
      const validations = await storage.getErc8004Validations(agentIdentityId);
      res.json(validations);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/standards/erc8004/validations", async (req: Request, res: Response) => {
    try {
      const parsed = insertErc8004ValidationSchema.parse(req.body);
      const validation = await storage.createErc8004Validation(parsed);
      res.status(201).json(validation);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/standards/erc8004/info", (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    res.json({
      standard: "ERC-8004: Trustless Agents",
      spec: "https://eips.ethereum.org/EIPS/eip-8004",
      status: "supported",
      authors: "Marco De Rossi (MetaMask), Davide Crapis (Ethereum Foundation), Jordan Ellis (Google), Erik Reppel (Coinbase)",
      description: "Discover agents and establish trust through identity, reputation, and validation registries.",
      registries: {
        identity: {
          description: "ERC-721 based agent handles with portable, censorship-resistant identifiers",
          endpoint: `${baseUrl}/api/standards/erc8004/identities`,
        },
        reputation: {
          description: "Feedback signals with on-chain composability for agent scoring and auditor networks",
          endpoint: `${baseUrl}/api/standards/erc8004/reputation`,
        },
        validation: {
          description: "Independent validator checks — stakers re-running jobs, zkML verifiers, TEE oracles",
          endpoint: `${baseUrl}/api/standards/erc8004/validations`,
        },
      },
      build4Integration: {
        agentEconomyHub: "0x9Ba5F28a8Bcc4893E05C7bd29Fd8CAA2C45CF606",
        skillMarketplace: "0xa6996A83B3909Ff12643A4a125eA2704097B0dD3",
        agentReplication: "0xE49B8Be8416d53D4E0042ea6DEe7727241396b73",
        constitutionRegistry: "0x784dB7d65259069353eBf05eF17aA51CEfCCaA31",
      },
    });
  });

  // ============================================================
  // Memory Integrity Verification (Tamper-Proof Hash Chain)
  // ============================================================

  app.get("/api/agents/:agentId/memory/verify", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const entries = await storage.getSoulEntries(agentId);
      if (!entries || entries.length === 0) {
        return res.json({ verified: true, agentId, totalEntries: 0, message: "No memory entries to verify" });
      }

      let brokenChainAt: number | null = null;
      let totalHashed = 0;
      let totalUnhashed = 0;
      let totalPinned = 0;
      let totalAnchored = 0;

      const sorted = [...entries].sort((a, b) =>
        new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime()
      );

      for (let i = 0; i < sorted.length; i++) {
        const entry = sorted[i];
        if (!entry.integrityHash) {
          totalUnhashed++;
          continue;
        }
        totalHashed++;
        if (entry.ipfsCid) totalPinned++;
        if (entry.anchorTxHash) totalAnchored++;

        if (entry.previousHash) {
          if (i > 0) {
            const prevEntry = sorted[i - 1];
            if (prevEntry.integrityHash && entry.previousHash !== prevEntry.integrityHash) {
              brokenChainAt = i;
              break;
            }
          } else if (entry.previousHash !== "genesis") {
            brokenChainAt = 0;
            break;
          }
        }
      }

      const latestHash = sorted[sorted.length - 1]?.integrityHash || null;
      const genesisHash = sorted.find(e => e.previousHash === "genesis")?.integrityHash || null;

      res.json({
        verified: brokenChainAt === null,
        agentId,
        totalEntries: entries.length,
        hashedEntries: totalHashed,
        unhashedEntries: totalUnhashed,
        ipfsPinnedEntries: totalPinned,
        onchainAnchoredEntries: totalAnchored,
        chainIntact: brokenChainAt === null,
        brokenAt: brokenChainAt,
        latestHash,
        genesisHash,
        hashAlgorithm: "SHA-256",
        chainType: "linked-hash-chain",
        decentralization: {
          ipfs: totalPinned > 0,
          onchainAnchored: totalAnchored > 0,
          tamperProof: brokenChainAt === null && totalHashed > 0,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/agents/:agentId/memory/hashes", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const entries = await storage.getSoulEntries(agentId);
      const sorted = [...(entries || [])].sort((a, b) =>
        new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime()
      );
      const hashes = sorted
        .filter(e => e.integrityHash)
        .map(e => ({
          id: e.id,
          entryType: e.entryType,
          integrityHash: e.integrityHash,
          previousHash: e.previousHash,
          ipfsCid: e.ipfsCid || null,
          anchorTxHash: e.anchorTxHash || null,
          anchorChainId: e.anchorChainId || null,
          createdAt: e.createdAt,
        }));
      res.json({ agentId, totalEntries: entries?.length || 0, hashChain: hashes });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agents/:agentId/memory/anchor", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const chainId = (req.body?.chainId || "56") as string;
      const entries = await storage.getSoulEntries(agentId);
      if (!entries || entries.length === 0) {
        return res.status(404).json({ error: "No memory entries to anchor" });
      }

      const { pinMemoryMerkleRoot, anchorMerkleRoot, isIPFSConfigured, isAnchoringConfigured } = await import("./decentralized-storage");

      let ipfsCid: string | undefined;
      let merkleRoot: string | undefined;

      if (isIPFSConfigured()) {
        const ipfsResult = await pinMemoryMerkleRoot(agentId, entries);
        if (ipfsResult.success) {
          ipfsCid = ipfsResult.cid;
          merkleRoot = ipfsResult.merkleRoot;
        }
      }

      if (!merkleRoot) {
        const crypto = await import("crypto");
        const hashes = entries.filter(e => e.integrityHash).map(e => e.integrityHash!);
        if (hashes.length === 0) return res.status(400).json({ error: "No integrity hashes to anchor" });
        let level = [...hashes];
        while (level.length > 1) {
          const next: string[] = [];
          for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = i + 1 < level.length ? level[i + 1] : left;
            next.push(crypto.createHash("sha256").update(left + right).digest("hex"));
          }
          level = next;
        }
        merkleRoot = level[0];
      }

      if (!isAnchoringConfigured()) {
        return res.json({
          success: true,
          agentId,
          merkleRoot,
          ipfsCid: ipfsCid || null,
          onchain: null,
          message: "Merkle root computed and pinned to IPFS. On-chain anchoring requires DEPLOYER_PRIVATE_KEY.",
        });
      }

      const anchorResult = await anchorMerkleRoot(agentId, merkleRoot, ipfsCid, chainId);

      res.json({
        success: anchorResult.success,
        agentId,
        merkleRoot,
        ipfsCid: ipfsCid || null,
        onchain: anchorResult.success ? {
          txHash: anchorResult.txHash,
          chainId: anchorResult.chainId,
          explorer: anchorResult.explorer,
        } : { error: anchorResult.error },
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/decentralization/status", async (_req: Request, res: Response) => {
    const { isIPFSConfigured, isAnchoringConfigured } = await import("./decentralized-storage");
    res.json({
      platform: "BUILD4",
      decentralizationLayers: {
        agentIdentity: { status: "active", method: "ERC-8004 on-chain registration", chains: ["BNB Chain", "Base", "XLayer"] },
        skillMarketplace: { status: "active", method: "On-chain skill listing & purchase", contract: "0xa6996A83B3909Ff12643A4a125eA2704097B0dD3" },
        agentEconomy: { status: "active", method: "On-chain deposits, transfers, withdrawals", contract: "0x9Ba5F28a8Bcc4893E05C7bd29Fd8CAA2C45CF606" },
        memoryIntegrity: { status: "active", method: "SHA-256 linked hash chain", verifiable: true, endpoint: "/api/agents/:id/memory/verify" },
        ipfsStorage: { status: isIPFSConfigured() ? "active" : "configurable", method: "Pinata IPFS pinning", description: "Agent memory entries pinned to IPFS for permanent decentralized storage" },
        onchainAnchoring: { status: isAnchoringConfigured() ? "active" : "configurable", method: "Merkle root anchored on-chain", description: "Memory Merkle roots stored on BNB Chain/Base for tamper-proof verification" },
        walletAuthentication: { status: "active", method: "EIP-191 wallet signature verification", endpoint: "/api/auth/verify-signature" },
        multiChain: { status: "active", chains: ["BNB Chain (56)", "Ethereum (1)", "Base (8453)", "XLayer (196)", "Solana (501)", "Arbitrum (42161)", "Polygon (137)"] },
      },
      verificationEndpoints: {
        memoryVerify: "/api/agents/:agentId/memory/verify",
        memoryHashes: "/api/agents/:agentId/memory/hashes",
        memoryAnchor: "POST /api/agents/:agentId/memory/anchor",
        authVerify: "POST /api/auth/verify-signature",
        erc8004Info: "/api/standards/erc8004/info",
      },
    });
  });

  // ============================================================
  // Wallet Signature Authentication Middleware
  // ============================================================

  // SIWE-style message parser + validator. Hardened per Phase 0 review.
  function parseSiweLikeMessage(msg: string): Record<string, string> | null {
    if (typeof msg !== "string" || msg.length > 4096) return null;
    const lines = msg.split("\n");
    const out: Record<string, string> = {};
    // Line 0: "<domain> wants you to sign in with your Ethereum account:"
    const m0 = lines[0]?.match(/^(\S+) wants you to sign in with your Ethereum account:$/);
    if (!m0) return null;
    out.domain = m0[1];
    out.address = (lines[1] || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(out.address)) return null;
    for (const line of lines.slice(2)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k && v && !out[k]) out[k] = v;
    }
    return out;
  }

  function hostAllowedForSiwe(host: string, reqHost: string): boolean {
    const allow = (process.env.DAPP_ALLOWED_HOSTS || "build4.io,www.build4.io")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const h = host.toLowerCase().split(":")[0];
    if (allow.includes(h)) return true;
    // Dev: allow request's own host (localhost, replit preview, etc.)
    if (reqHost && h === reqHost.toLowerCase().split(":")[0]) return true;
    return false;
  }

  // Bounded LRU-ish set for one-time-use nonces, TTL = 1h
  const usedNonces: Map<string, number> = (globalThis as any).__siweUsedNonces ||= new Map();
  function rememberNonce(key: string): boolean {
    const now = Date.now();
    // sweep expired
    if (usedNonces.size > 2000) {
      for (const [k, exp] of usedNonces) if (exp < now) usedNonces.delete(k);
    }
    if (usedNonces.has(key) && (usedNonces.get(key) as number) > now) return false;
    usedNonces.set(key, now + 60 * 60 * 1000);
    return true;
  }

  app.post("/api/auth/verify-signature", async (req: Request, res: Response) => {
    try {
      const { message, signature, walletAddress } = req.body || {};
      if (!message || !signature || !walletAddress) {
        return res.status(400).json({ error: "Missing message, signature, or walletAddress" });
      }
      if (typeof message !== "string" || message.length > 4096) {
        return res.status(400).json({ authenticated: false, error: "Invalid message" });
      }
      if (typeof signature !== "string" || signature.length > 200) {
        return res.status(400).json({ authenticated: false, error: "Invalid signature" });
      }

      const parsed = parseSiweLikeMessage(message);
      if (!parsed) return res.status(400).json({ authenticated: false, error: "Malformed sign-in message" });

      const reqHost = (req.headers.host || "").toString();
      if (!hostAllowedForSiwe(parsed.domain, reqHost)) {
        return res.status(403).json({ authenticated: false, error: "Domain not allowed" });
      }
      try {
        const uri = new URL(parsed.URI || "");
        if (!hostAllowedForSiwe(uri.host, reqHost)) {
          return res.status(403).json({ authenticated: false, error: "URI host not allowed" });
        }
      } catch {
        return res.status(400).json({ authenticated: false, error: "Invalid URI" });
      }
      if ((parsed.Version || "") !== "1") {
        return res.status(400).json({ authenticated: false, error: "Unsupported version" });
      }
      const chainId = Number(parsed["Chain ID"]);
      if (!Number.isFinite(chainId) || chainId <= 0) {
        return res.status(400).json({ authenticated: false, error: "Invalid chain id" });
      }
      const nonce = parsed.Nonce || "";
      if (nonce.length < 8 || nonce.length > 128) {
        return res.status(400).json({ authenticated: false, error: "Invalid nonce" });
      }
      const issuedAtMs = Date.parse(parsed["Issued At"] || "");
      if (!Number.isFinite(issuedAtMs)) {
        return res.status(400).json({ authenticated: false, error: "Invalid Issued At" });
      }
      const now = Date.now();
      if (issuedAtMs > now + 60 * 1000 || issuedAtMs < now - 15 * 60 * 1000) {
        return res.status(401).json({ authenticated: false, error: "Sign-in message expired — please try again" });
      }
      const expMs = parsed["Expiration Time"] ? Date.parse(parsed["Expiration Time"]) : NaN;
      if (parsed["Expiration Time"]) {
        if (!Number.isFinite(expMs) || expMs <= now) {
          return res.status(401).json({ authenticated: false, error: "Sign-in message expired — please try again" });
        }
        if (expMs - issuedAtMs > 60 * 60 * 1000) {
          return res.status(400).json({ authenticated: false, error: "Expiration too far in the future" });
        }
      }
      if (parsed.address.toLowerCase() !== String(walletAddress).toLowerCase()) {
        return res.status(400).json({ authenticated: false, error: "Address mismatch" });
      }

      const { ethers } = await import("ethers");
      let recoveredAddress: string;
      try { recoveredAddress = ethers.verifyMessage(message, signature); }
      catch { return res.status(401).json({ authenticated: false, error: "Signature verification failed" }); }
      if (recoveredAddress.toLowerCase() !== String(walletAddress).toLowerCase()) {
        return res.status(401).json({ authenticated: false, error: "Signature verification failed" });
      }

      // One-time-use nonce (after sig check so we don't burn nonces on bad sigs)
      if (!rememberNonce(`${recoveredAddress.toLowerCase()}:${nonce}`)) {
        return res.status(401).json({ authenticated: false, error: "Sign-in message already used — please try again" });
      }

      const cryptoMod = await import("crypto");
      const sessionToken = cryptoMod.randomBytes(32).toString("hex");
      const expiry = Date.now() + 24 * 60 * 60 * 1000;

      // The web app shares the bot's user database. A wallet must already
      // belong to a Build4 user (created via Telegram /setup) to sign in.
      let botUser: any = null;
      try {
        const { findBotUserByWalletAddress } = await import("./web-mirror-lookup");
        botUser = await findBotUserByWalletAddress(recoveredAddress);
      } catch (e: any) {
        console.error("[siwe] bot-user lookup failed:", e?.message);
        return res.status(500).json({ authenticated: false, error: "Account lookup failed — please try again" });
      }
      if (!botUser) {
        return res.status(404).json({
          authenticated: false,
          error: "no_account",
          message: "This wallet isn't linked to a Build4 account. Open the Telegram bot and run /setup first, then sign in here with the same wallet.",
        });
      }

      if (!(globalThis as any).__authSessions) (globalThis as any).__authSessions = new Map();
      (globalThis as any).__authSessions.set(sessionToken, {
        kind: "wallet",
        wallet: recoveredAddress.toLowerCase(),
        botUserId: botUser.userId,
        expiry,
      });

      res.json({
        authenticated: true,
        wallet: recoveredAddress.toLowerCase(),
        sessionToken,
        expiresAt: new Date(expiry).toISOString(),
        botUser,
      });
    } catch (e: any) {
      res.status(400).json({ authenticated: false, error: e.message });
    }
  });

  app.get("/api/auth/session", (req: Request, res: Response) => {
    const token = req.headers["x-session-token"] as string;
    if (!token) return res.status(401).json({ authenticated: false, error: "No session token" });

    const sessions = (globalThis as any).__authSessions as Map<string, any> | undefined;
    const session = sessions?.get(token);
    if (!session || session.expiry < Date.now()) {
      sessions?.delete(token);
      return res.status(401).json({ authenticated: false, error: "Session expired or invalid" });
    }
    res.json({
      authenticated: true,
      kind: session.kind || "wallet",
      wallet: session.wallet ?? null,
      telegramId: session.telegramId ?? null,
      telegramUsername: session.telegramUsername ?? null,
      telegramFirstName: session.telegramFirstName ?? null,
      telegramPhotoUrl: session.telegramPhotoUrl ?? null,
      botUserId: session.botUserId ?? null,
      expiresAt: new Date(session.expiry).toISOString(),
    });
  });

  // ============================================================
  // /api/web/me — full linked-bot-account summary for the dashboard
  // ============================================================
  app.get("/api/web/me", async (req: Request, res: Response) => {
    try {
      const token = req.headers["x-session-token"] as string;
      if (!token) return res.status(401).json({ error: "No session token" });
      const sessions = (globalThis as any).__authSessions as Map<string, any> | undefined;
      const session = sessions?.get(token);
      if (!session || session.expiry < Date.now()) {
        sessions?.delete(token);
        return res.status(401).json({ error: "Session expired or invalid" });
      }
      const { findBotUserByTelegramId, findBotUserByWalletAddress } = await import("./web-mirror-lookup");
      let botUser: any = null;
      if (session.kind === "telegram" && session.telegramId) {
        botUser = await findBotUserByTelegramId(String(session.telegramId));
      } else if (session.wallet) {
        botUser = await findBotUserByWalletAddress(String(session.wallet));
      }
      if (!botUser) {
        return res.status(404).json({ error: "no_account" });
      }
      res.json({
        kind: session.kind || "wallet",
        wallet: session.wallet ?? null,
        telegramId: session.telegramId ?? null,
        telegramUsername: session.telegramUsername ?? null,
        telegramFirstName: session.telegramFirstName ?? null,
        telegramPhotoUrl: session.telegramPhotoUrl ?? null,
        botUser,
      });
    } catch (e: any) {
      console.error("[/api/web/me]", e);
      res.status(500).json({ error: e?.message || "Internal error" });
    }
  });

  // ============================================================
  // /api/web/agents + /api/web/activity — Phase 2 read-only mirrors
  // ============================================================
  function getAuthedSession(req: Request) {
    const token = req.headers["x-session-token"] as string;
    if (!token) return null;
    const sessions = (globalThis as any).__authSessions as Map<string, any> | undefined;
    const s = sessions?.get(token);
    if (!s || s.expiry < Date.now()) {
      sessions?.delete(token);
      return null;
    }
    return s;
  }

  async function resolveBotUserIdFromSession(s: any): Promise<string | null> {
    if (!s) return null;
    if (s.botUserId) return s.botUserId;
    const { findBotUserByTelegramId, findBotUserByWalletAddress } = await import("./web-mirror-lookup");
    if (s.kind === "telegram" && s.telegramId) {
      const u = await findBotUserByTelegramId(String(s.telegramId));
      return u?.userId ?? null;
    }
    if (s.wallet) {
      const u = await findBotUserByWalletAddress(String(s.wallet));
      return u?.userId ?? null;
    }
    return null;
  }

  app.get("/api/web/agents", async (req: Request, res: Response) => {
    try {
      const session = getAuthedSession(req);
      if (!session) return res.status(401).json({ error: "unauthorized" });
      const botUserId = await resolveBotUserIdFromSession(session);
      if (!botUserId) return res.status(404).json({ error: "no_account" });
      const { getAgentsForUser } = await import("./web-mirror-lookup");
      const agents = await getAgentsForUser(botUserId);
      res.json({ agents });
    } catch (e: any) {
      console.error("[/api/web/agents]", e);
      res.status(500).json({ error: e?.message || "Internal error" });
    }
  });

  app.get("/api/web/balances", async (req: Request, res: Response) => {
    try {
      const session = getAuthedSession(req);
      if (!session) return res.status(401).json({ error: "unauthorized" });
      const botUserId = await resolveBotUserIdFromSession(session);
      if (!botUserId) return res.status(404).json({ error: "no_account" });
      const { getBscWalletForUser, getPolymarketSafeForUser } = await import("./web-mirror-lookup");
      const { readBscUsdtBalance, readPolygonUsdceBalance } = await import("./web-balance-reader");
      const [bscAddress, safeAddress] = await Promise.all([
        getBscWalletForUser(botUserId),
        getPolymarketSafeForUser(botUserId),
      ]);
      const [bscUsdt, polyUsdce] = await Promise.all([
        bscAddress
          ? readBscUsdtBalance(bscAddress)
          : Promise.resolve({ ok: false, amount: 0, raw: "0", error: "No BSC wallet" }),
        safeAddress
          ? readPolygonUsdceBalance(safeAddress)
          : Promise.resolve({ ok: false, amount: 0, raw: "0", error: "Safe not deployed" }),
      ]);
      res.json({
        bsc: { address: bscAddress, usdt: bscUsdt },
        polymarket: { safeAddress, usdce: polyUsdce },
        fetchedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      console.error("[/api/web/balances]", e);
      res.status(500).json({ error: e?.message || "Internal error" });
    }
  });

  app.get("/api/web/activity", async (req: Request, res: Response) => {
    try {
      const session = getAuthedSession(req);
      if (!session) return res.status(401).json({ error: "unauthorized" });
      const botUserId = await resolveBotUserIdFromSession(session);
      if (!botUserId) return res.status(404).json({ error: "no_account" });
      const { getRecentAgentLogsForUser } = await import("./web-mirror-lookup");
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
      const logs = await getRecentAgentLogsForUser(botUserId, limit);
      res.json({ logs });
    } catch (e: any) {
      console.error("[/api/web/activity]", e);
      res.status(500).json({ error: e?.message || "Internal error" });
    }
  });

  // ============================================================
  // Telegram Login Widget — config + verify
  // Docs: https://core.telegram.org/widgets/login#checking-authorization
  // ============================================================

  let cachedBotUsername: string | null | undefined = undefined;
  async function resolveBotUsername(): Promise<string | null> {
    if (cachedBotUsername !== undefined) return cachedBotUsername;
    const envOverride = process.env.TELEGRAM_LOGIN_BOT_USERNAME;
    if (envOverride && envOverride.trim()) {
      cachedBotUsername = envOverride.trim().replace(/^@/, "");
      return cachedBotUsername;
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) { cachedBotUsername = null; return null; }
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const j: any = await r.json();
      if (j?.ok && j.result?.username) {
        cachedBotUsername = j.result.username as string;
        return cachedBotUsername;
      }
    } catch {}
    cachedBotUsername = null;
    return null;
  }

  app.get("/api/auth/telegram-config", async (_req: Request, res: Response) => {
    const botUsername = await resolveBotUsername();
    res.json({ enabled: !!botUsername, botUsername });
  });

  app.post("/api/auth/telegram", async (req: Request, res: Response) => {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        return res.status(503).json({ authenticated: false, error: "Telegram login not configured on server" });
      }
      const data = req.body || {};
      const { hash, ...fields } = data;
      if (!hash || typeof hash !== "string") {
        return res.status(400).json({ authenticated: false, error: "Missing hash" });
      }
      const id = fields.id;
      const authDate = Number(fields.auth_date);
      if (!id || !Number.isFinite(authDate)) {
        return res.status(400).json({ authenticated: false, error: "Missing id or auth_date" });
      }
      // 24h freshness window per Telegram docs
      if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > 24 * 60 * 60) {
        return res.status(401).json({ authenticated: false, error: "Auth payload expired" });
      }
      const crypto = await import("crypto");
      const dataCheckString = Object.keys(fields)
        .filter((k) => fields[k] !== undefined && fields[k] !== null && fields[k] !== "")
        .sort()
        .map((k) => `${k}=${fields[k]}`)
        .join("\n");
      const secretKey = crypto.createHash("sha256").update(token).digest();
      const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
      // constant-time compare
      const a = Buffer.from(computedHash, "hex");
      const b = Buffer.from(hash, "hex");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ authenticated: false, error: "Invalid Telegram signature" });
      }

      const sessionToken = crypto.randomBytes(32).toString("hex");
      const expiry = Date.now() + 24 * 60 * 60 * 1000;
      // The web app shares the bot's user database. A Telegram identity must
      // already belong to a Build4 user (created when they first /start the bot).
      let botUser: any = null;
      try {
        const { findBotUserByTelegramId } = await import("./web-mirror-lookup");
        botUser = await findBotUserByTelegramId(String(id));
      } catch (e: any) {
        console.error("[tg-auth] bot-user lookup failed:", e?.message);
        return res.status(500).json({ authenticated: false, error: "Account lookup failed — please try again" });
      }
      if (!botUser) {
        return res.status(404).json({
          authenticated: false,
          error: "no_account",
          message: "This Telegram account hasn't started Build4 yet. Open the bot, send /start, then come back and sign in.",
        });
      }

      if (!(globalThis as any).__authSessions) (globalThis as any).__authSessions = new Map();
      (globalThis as any).__authSessions.set(sessionToken, {
        kind: "telegram",
        telegramId: String(id),
        telegramUsername: fields.username ?? null,
        telegramFirstName: fields.first_name ?? null,
        telegramPhotoUrl: fields.photo_url ?? null,
        botUserId: botUser.userId,
        expiry,
      });

      res.json({
        authenticated: true,
        kind: "telegram",
        telegramId: String(id),
        telegramUsername: fields.username ?? null,
        telegramFirstName: fields.first_name ?? null,
        telegramPhotoUrl: fields.photo_url ?? null,
        sessionToken,
        expiresAt: new Date(expiry).toISOString(),
        botUser,
      });
    } catch (e: any) {
      res.status(400).json({ authenticated: false, error: e?.message || "Telegram auth failed" });
    }
  });

  // ============================================================
  // BAP-578 Non-Fungible Agent (NFA) Registry API
  // ============================================================

  app.get("/api/standards/bap578/nfas", async (req: Request, res: Response) => {
    try {
      const ownerWallet = req.query.ownerWallet as string | undefined;
      const nfas = await storage.getBap578Nfas(ownerWallet);
      res.json(nfas);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/standards/bap578/nfas/:id", async (req: Request, res: Response) => {
    try {
      const nfa = await storage.getBap578Nfa(req.params.id);
      if (!nfa) { res.status(404).json({ error: "NFA not found" }); return; }
      res.json(nfa);
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/standards/bap578/nfas", async (req: Request, res: Response) => {
    try {
      const parsed = insertBap578NfaSchema.parse(req.body);
      const nfa = await storage.createBap578Nfa(parsed);
      res.status(201).json(nfa);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch("/api/standards/bap578/nfas/:id", async (req: Request, res: Response) => {
    try {
      const allowed = insertBap578NfaSchema.partial().parse(req.body);
      const updated = await storage.updateBap578Nfa(req.params.id, allowed);
      if (!updated) { res.status(404).json({ error: "NFA not found" }); return; }
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/standards/bap578/nfas/:id/personality", async (req: Request, res: Response) => {
    try {
      const nfa = await storage.getBap578Nfa(req.params.id);
      if (!nfa) { res.status(404).json({ error: "NFA not found" }); return; }
      if (!nfa.personalityProfile) {
        res.json({ hasPersonality: false, message: "This NFA was minted before personality profiles were introduced. Use POST to generate one." });
        return;
      }
      try {
        const profile = JSON.parse(nfa.personalityProfile);
        res.json({
          hasPersonality: true,
          hash: nfa.personalityHash,
          ...profile,
        });
      } catch {
        res.json({ hasPersonality: false });
      }
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/standards/bap578/nfas/:id/personality", async (req: Request, res: Response) => {
    try {
      const nfa = await storage.getBap578Nfa(req.params.id);
      if (!nfa) { res.status(404).json({ error: "NFA not found" }); return; }
      if (nfa.personalityProfile && !req.body.regenerate) {
        res.status(400).json({ error: "NFA already has a personality. Pass {\"regenerate\": true} to overwrite." });
        return;
      }

      const agent = nfa.agentId ? await storage.getAgent(nfa.agentId) : null;
      const personality = await generateNfaPersonality(nfa.name, nfa.description || undefined, agent?.modelType || undefined);

      await storage.updateBap578Nfa(nfa.id, {
        personalityProfile: personality.fullProfile,
        personalityHash: personality.personalityHash,
        traits: JSON.stringify(personality.traits),
        voice: personality.voice,
        values: JSON.stringify(personality.values),
        behaviorRules: JSON.stringify(personality.behaviorRules),
        communicationStyle: personality.communicationStyle,
      });

      res.json({
        success: true,
        hash: personality.personalityHash,
        ...JSON.parse(personality.fullProfile),
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/standards/bap578/info", (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    res.json({
      standard: "BAP-578: Non-Fungible Agent (NFA) Token Standard",
      spec: "https://github.com/bnb-chain/BEPs/blob/master/BAPs/BAP-578.md",
      status: "supported",
      description: "Extends ERC-721 to enable autonomous, intelligent digital entities with optional learning capabilities on BNB Chain.",
      features: {
        dualPathArchitecture: "JSON Light Memory for simple agents, Merkle Tree Learning for evolving agents",
        cryptographicLearning: "Merkle tree structures create tamper-proof records of agent learning",
        methodAgnostic: "Works with RAG, MCP, fine-tuning, reinforcement learning, or hybrid approaches",
        hybridStorage: "Critical data on-chain, extended memory off-chain for cost efficiency",
        composableIntelligence: "Agents interact and collaborate while maintaining individual identity",
        backwardCompatible: "Full compatibility with existing ERC-721 infrastructure",
      },
      learningModes: {
        json: "Simple JSON-based memory for static agents — stores preferences and settings",
        merkle: "Merkle tree-based learning — cryptographically verifiable agent evolution over time",
      },
      nfaEndpoint: `${baseUrl}/api/standards/bap578/nfas`,
      build4Integration: {
        agentEconomyHub: "0x9Ba5F28a8Bcc4893E05C7bd29Fd8CAA2C45CF606",
        agentReplication: "0xE49B8Be8416d53D4E0042ea6DEe7727241396b73",
        description: "BUILD4 agents can be minted as BAP-578 NFAs with on-chain identity, tradeable ownership, and verifiable learning.",
      },
    });
  });

  app.get("/api/standards/erc8004/agent-card/:agentDbId", async (req: Request, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentDbId);
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
      const baseUrl = getBaseUrl(req);
      res.json({
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        metadata: {
          name: agent.name,
          description: agent.bio || `Autonomous AI agent on BUILD4`,
          image: `${baseUrl}/api/web4/agents/${agent.id}/avatar`,
          capabilities: ["inference", "skill_execution", "wallet_management", "agent_collaboration"],
        },
        endpoints: {
          a2a: `${baseUrl}/api/web4/agents/${agent.id}/message`,
          api: `${baseUrl}/api/web4/agents/${agent.id}`,
        },
        trust: {
          supportedTrust: ["reputation", "validation"],
        },
        evm_address: agent.creatorWallet || getDeployerAddress() || "",
        platform: "BUILD4",
        platformUrl: "https://build4.io",
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/standards/bap578/agent-metadata/:agentDbId", async (req: Request, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentDbId);
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
      const baseUrl = getBaseUrl(req);

      const nfas = await storage.getBap578Nfas();
      const nfa = nfas.find(n => n.agentId === req.params.agentDbId);

      let personalityBlock: any = {};
      let traits = ["autonomous", "decentralized"];
      if (nfa?.personalityProfile) {
        try {
          const profile = JSON.parse(nfa.personalityProfile);
          traits = profile.traits || traits;
          personalityBlock = {
            personality: {
              traits: profile.traits,
              voice: profile.voice,
              values: profile.values,
              behaviorRules: profile.behaviorRules,
              communicationStyle: profile.communicationStyle,
              hash: nfa.personalityHash,
            },
          };
        } catch {}
      }

      res.json({
        name: agent.name,
        description: agent.bio || `Autonomous AI agent on BUILD4`,
        image: `${baseUrl}/api/web4/agents/${agent.id}/avatar`,
        external_url: `${baseUrl}/agents/${agent.id}`,
        attributes: [
          { trait_type: "Platform", value: "BUILD4" },
          { trait_type: "Model", value: agent.modelType },
          { trait_type: "Status", value: agent.status },
          { trait_type: "Standard", value: "BAP-578" },
          ...traits.map(t => ({ trait_type: "Personality Trait", value: t })),
          ...(nfa?.communicationStyle ? [{ trait_type: "Communication Style", value: nfa.communicationStyle }] : []),
        ],
        persona: JSON.stringify({ name: agent.name, platform: "BUILD4", traits }),
        experience: agent.bio || "Autonomous AI agent",
        vaultURI: `${baseUrl}/api/web4/agents/${agent.id}`,
        ...personalityBlock,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/standards/register/:agentDbId", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const { agentDbId } = req.params;
      const { standard, network } = req.body as { standard?: string; network?: string };

      const agent = await storage.getAgent(agentDbId);
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

      const deployerAddr = getDeployerAddress();
      if (!deployerAddr) { res.status(400).json({ error: "No deployer wallet configured (DEPLOYER_PRIVATE_KEY required)" }); return; }

      const results: any[] = [];

      if (!standard || standard === "erc8004") {
        const erc8004Net = network || "base";
        const erc8004Result = await registerAgentERC8004(agent.name, agent.bio || undefined, agentDbId, erc8004Net);
        results.push(erc8004Result);

        if (erc8004Result.success) {
          await storage.createErc8004Identity({
            agentId: agentDbId,
            agentRegistry: getERC8004ContractAddress(erc8004Net) || "",
            chainId: String(erc8004Result.chainId),
            agentUri: `${getBaseUrl(req)}/api/standards/erc8004/agent-card/${agentDbId}`,
            ownerWallet: deployerAddr,
            name: agent.name,
            description: agent.bio || undefined,
            supportedTrust: "reputation,validation",
            onchainTokenId: erc8004Result.tokenId || undefined,
            txHash: erc8004Result.txHash || undefined,
            registryAddress: getERC8004ContractAddress(erc8004Net) || undefined,
          });
        }
      }

      if (!standard || standard === "bap578") {
        const bap578Result = await registerAgentBAP578(agent.name, agent.bio || undefined, agentDbId);
        results.push(bap578Result);

        if (bap578Result.success) {
          let personalityData: any = {};
          try {
            const personality = await generateNfaPersonality(agent.name, agent.bio || undefined, agent.modelType || undefined);
            personalityData = {
              personalityProfile: personality.fullProfile,
              personalityHash: personality.personalityHash,
              traits: JSON.stringify(personality.traits),
              voice: personality.voice,
              values: JSON.stringify(personality.values),
              behaviorRules: JSON.stringify(personality.behaviorRules),
              communicationStyle: personality.communicationStyle,
            };
            console.log(`[BAP-578] Generated personality for "${agent.name}": ${personality.traits.join(", ")}`);
          } catch (personalityErr: any) {
            console.error(`[BAP-578] Personality generation failed for "${agent.name}": ${personalityErr.message}`);
          }

          await storage.createBap578Nfa({
            agentId: agentDbId,
            tokenId: bap578Result.tokenId || undefined,
            chainId: String(bap578Result.chainId),
            ownerWallet: deployerAddr,
            name: agent.name,
            description: agent.bio || undefined,
            metadataUri: `${getBaseUrl(req)}/api/standards/bap578/agent-metadata/${agentDbId}`,
            learningMode: "json",
            status: "active",
            txHash: bap578Result.txHash || undefined,
            contractAddress: getBAP578ContractAddress() || undefined,
            ...personalityData,
          });
        }
      }

      res.json({ agentId: agentDbId, agentName: agent.name, results });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/standards/registration-status/:agentDbId", async (req: Request, res: Response) => {
    try {
      const { agentDbId } = req.params;
      const agent = await storage.getAgent(agentDbId);
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

      const erc8004Entries = await storage.getErc8004Identities();
      const bap578Entries = await storage.getBap578Nfas();

      const erc8004 = erc8004Entries.filter((e: any) => e.agentId === agentDbId);
      const bap578 = bap578Entries.filter((e: any) => e.agentId === agentDbId);

      res.json({
        agentId: agentDbId,
        agentName: agent.name,
        erc8004: {
          registered: erc8004.length > 0,
          registrations: erc8004.map((e: any) => ({
            chainId: e.chainId,
            tokenId: e.onchainTokenId || e.tokenId,
            txHash: e.txHash,
            registryAddress: e.registryAddress || e.agentRegistry,
          })),
        },
        bap578: {
          registered: bap578.length > 0,
          registrations: bap578.map((e: any) => ({
            chainId: e.chainId,
            tokenId: e.tokenId,
            txHash: e.txHash,
            contractAddress: e.contractAddress,
          })),
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/standards/register-all", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const deployerAddr = getDeployerAddress();
      if (!deployerAddr) { res.status(400).json({ error: "No deployer wallet configured" }); return; }

      const allAgents = await storage.getAgents();
      const erc8004Entries = await storage.getErc8004Identities();
      const bap578Entries = await storage.getBap578Nfas();
      const baseUrl = getBaseUrl(req);
      const network = (req.body?.network as string) || "base";
      const standard = req.body?.standard as string | undefined;

      const registeredErc8004AgentIds = new Set(erc8004Entries.filter((e: any) => e.agentId && e.txHash).map((e: any) => e.agentId));
      const registeredBap578AgentIds = new Set(bap578Entries.filter((e: any) => e.agentId && e.txHash).map((e: any) => e.agentId));

      const results: any[] = [];

      for (const agent of allAgents) {
        if (agent.status !== "active") continue;

        if ((!standard || standard === "erc8004") && !registeredErc8004AgentIds.has(agent.id)) {
          const erc8004Result = await registerAgentERC8004(agent.name, agent.bio || undefined, agent.id, network);
          results.push({ agentId: agent.id, agentName: agent.name, ...erc8004Result });

          if (erc8004Result.success) {
            await storage.createErc8004Identity({
              agentId: agent.id,
              agentRegistry: getERC8004ContractAddress(network) || "",
              chainId: String(erc8004Result.chainId),
              agentUri: `${baseUrl}/api/standards/erc8004/agent-card/${agent.id}`,
              ownerWallet: deployerAddr,
              name: agent.name,
              description: agent.bio || undefined,
              supportedTrust: "reputation,validation",
              onchainTokenId: erc8004Result.tokenId || undefined,
              txHash: erc8004Result.txHash || undefined,
              registryAddress: getERC8004ContractAddress(network) || undefined,
            });
          }

          await new Promise(r => setTimeout(r, 3000));
        }

        if ((!standard || standard === "bap578") && !registeredBap578AgentIds.has(agent.id)) {
          const bap578Result = await registerAgentBAP578(agent.name, agent.bio || undefined, agent.id);
          results.push({ agentId: agent.id, agentName: agent.name, ...bap578Result });

          if (bap578Result.success) {
            await storage.createBap578Nfa({
              agentId: agent.id,
              tokenId: bap578Result.tokenId || undefined,
              chainId: String(bap578Result.chainId),
              ownerWallet: deployerAddr,
              name: agent.name,
              description: agent.bio || undefined,
              metadataUri: `${baseUrl}/api/standards/bap578/agent-metadata/${agent.id}`,
              learningMode: "json",
              status: "active",
              txHash: bap578Result.txHash || undefined,
              contractAddress: getBAP578ContractAddress() || undefined,
            });
          }

          await new Promise(r => setTimeout(r, 3000));
        }
      }

      res.json({ totalAgents: allAgents.length, registrations: results });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/standards/config", (_req: Request, res: Response) => {
    const deployerAddr = getDeployerAddress();
    res.json({
      deployerConfigured: !!deployerAddr,
      deployerAddress: deployerAddr || null,
      erc8004: {
        networks: getERC8004Networks(),
        defaultNetwork: "base",
      },
      bap578: {
        contractAddress: getBAP578ContractAddress(),
        chain: "BNB Chain (56)",
        configured: !!getBAP578ContractAddress(),
      },
    });
  });

  app.get("/api/standards", (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    res.json({
      platform: "BUILD4",
      description: "Standards-compliant decentralized AI agent economy",
      supported: [
        {
          id: "erc-8004",
          name: "ERC-8004: Trustless Agents",
          spec: "https://eips.ethereum.org/EIPS/eip-8004",
          status: "supported",
          infoEndpoint: `${baseUrl}/api/standards/erc8004/info`,
          description: "On-chain identity, reputation, and validation registries for autonomous AI agents",
        },
        {
          id: "bap-578",
          name: "BAP-578: Non-Fungible Agent (NFA) Token Standard",
          spec: "https://github.com/bnb-chain/BEPs/blob/master/BAPs/BAP-578.md",
          status: "supported",
          infoEndpoint: `${baseUrl}/api/standards/bap578/info`,
          description: "ERC-721 extension for intelligent, autonomous digital entities with verifiable learning",
        },
      ],
      chains: [
        { name: "BNB Chain", chainId: 56, currency: "BNB", standards: ["erc-8004", "bap-578"] },
        { name: "Base", chainId: 8453, currency: "ETH", standards: ["erc-8004"] },
        { name: "XLayer", chainId: 196, currency: "OKB", standards: ["erc-8004"] },
      ],
    });
  });

  const verifyAgentOwnership = async (req: Request, res: Response): Promise<any | null> => {
    const { agentId } = req.params;
    const agent = await storage.getAgent(agentId);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return null; }
    const callerWallet = (req.headers["x-wallet-address"] as string || "").toLowerCase();
    if (agent.creatorWallet && callerWallet && agent.creatorWallet.toLowerCase() !== callerWallet) {
      res.status(403).json({ error: "You are not the owner of this agent" });
      return null;
    }
    return agent;
  };

  app.post("/api/web4/agents/:agentId/twitter/validate-keys", async (req: Request, res: Response) => {
    try {
      const { twitterApiKey, twitterApiSecret, twitterAccessToken, twitterAccessTokenSecret } = req.body;
      if (!twitterApiKey || !twitterApiSecret || !twitterAccessToken || !twitterAccessTokenSecret) {
        return res.json({ valid: false, error: "All 4 keys are required: API Key, API Secret, Access Token, Access Token Secret." });
      }
      const { TwitterApi } = await import("twitter-api-v2");
      const client = new TwitterApi({
        appKey: twitterApiKey,
        appSecret: twitterApiSecret,
        accessToken: twitterAccessToken,
        accessSecret: twitterAccessTokenSecret,
      });
      const me = await client.v2.me();
      if (!me.data?.username) {
        return res.json({ valid: false, error: "Could not retrieve your Twitter account. Check your keys." });
      }
      let canWrite = false;
      try {
        const testTweet = await client.v2.tweet(`BUILD4 agent activation test — ${Date.now()}`);
        if (testTweet.data?.id) {
          await client.v2.deleteTweet(testTweet.data.id);
          canWrite = true;
        }
      } catch (writeErr: any) {
        if (writeErr.code === 403 || writeErr.message?.includes("403")) {
          canWrite = false;
        }
      }
      res.json({
        valid: true,
        username: me.data.username,
        name: me.data.name,
        canWrite,
        writeWarning: !canWrite ? "Your tokens have READ-ONLY permissions. Go to developer.x.com → your app → Settings → set 'App permissions' to 'Read and Write', then go to Keys & Tokens and click 'Regenerate' on your Access Token. Paste the new token here." : null,
      });
    } catch (err: any) {
      const msg = err.code === 401 || err.message?.includes("401")
        ? "Invalid API credentials. Double-check your API Key and API Secret."
        : err.code === 403 || err.message?.includes("403")
        ? "Twitter rejected these credentials (403 Forbidden). Your app may be suspended or the keys are wrong."
        : err.message || "Unknown error validating keys.";
      res.json({ valid: false, error: msg });
    }
  });

  app.post("/api/web4/agents/:agentId/twitter/connect", async (req: Request, res: Response) => {
    try {
      const agent = await verifyAgentOwnership(req, res);
      if (!agent) return;
      const { agentId } = req.params;

      const existing = await storage.getAgentTwitterAccount(agentId);
      if (existing) return res.status(409).json({ error: "Twitter already connected. Disconnect first." });

      const parsed = agentTwitterConnectSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { TwitterApi } = await import("twitter-api-v2");
      let verifiedHandle = (parsed.data.twitterHandle || "").replace(/^@/, "");
      try {
        const testClient = new TwitterApi({
          appKey: parsed.data.twitterApiKey,
          appSecret: parsed.data.twitterApiSecret,
          accessToken: parsed.data.twitterAccessToken,
          accessSecret: parsed.data.twitterAccessTokenSecret,
        });
        const me = await testClient.v2.me();
        if (me.data?.username) verifiedHandle = me.data.username;
      } catch (authErr: any) {
        return res.status(400).json({
          error: `Twitter credential check failed: ${authErr.message}. Please verify your API keys are correct and your app is approved.`,
        });
      }

      const account = await storage.createAgentTwitterAccount({
        agentId,
        twitterHandle: verifiedHandle,
        twitterApiKey: parsed.data.twitterApiKey,
        twitterApiSecret: parsed.data.twitterApiSecret,
        twitterAccessToken: parsed.data.twitterAccessToken,
        twitterAccessTokenSecret: parsed.data.twitterAccessTokenSecret,
        role: parsed.data.role,
        personality: parsed.data.personality || "",
        instructions: parsed.data.instructions || "",
        postingFrequencyMins: parsed.data.postingFrequencyMins,
        companyName: parsed.data.companyName || "",
        companyDescription: parsed.data.companyDescription || "",
        companyProduct: parsed.data.companyProduct || "",
        companyAudience: parsed.data.companyAudience || "",
        companyWebsite: parsed.data.companyWebsite || "",
        companyKeyMessages: parsed.data.companyKeyMessages || "",
        enabled: 0,
        autoReplyEnabled: 1,
        autoBountyEnabled: 0,
        totalTweets: 0,
        totalReplies: 0,
        totalBounties: 0,
      });

      let autoStarted = false;
      let introTweet: string | null = null;
      try {
        const startResult = await startAgentTwitter(agentId);
        autoStarted = !!startResult.success;
        if (autoStarted) {
          const introResult = await postIntroTweet(agentId);
          if (introResult.success) introTweet = introResult.tweetText || null;
        }
      } catch {}

      res.json({
        success: true,
        autoStarted,
        introTweet,
        verifiedHandle,
        account: { id: account.id, agentId: account.agentId, twitterHandle: verifiedHandle, role: account.role, enabled: account.enabled },
      });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/twitter/status", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const account = await storage.getAgentTwitterAccount(agentId);
      if (!account) return res.json({ connected: false });

      const runnerStatus = getAgentTwitterStatus(agentId);

      const diagnostics: { status: string; issues: string[]; tips: string[] } = { status: "healthy", issues: [], tips: [] };

      if (!account.twitterApiKey || !account.twitterApiSecret) {
        diagnostics.status = "error";
        diagnostics.issues.push("API Key or API Secret is missing. Your agent cannot authenticate with Twitter.");
      }
      if (!account.twitterAccessToken || !account.twitterAccessTokenSecret) {
        diagnostics.status = "error";
        diagnostics.issues.push("Access Token or Access Token Secret is missing. Your agent cannot post tweets.");
      }
      if (!account.companyName && !account.companyDescription) {
        diagnostics.tips.push("Add your Company Profile so your agent knows what to promote. Go to Settings to fill it in.");
      }
      if (!account.personality && !account.instructions) {
        diagnostics.tips.push("Add Personality or Instructions to give your agent more direction.");
      }
      if (account.enabled && !runnerStatus.running) {
        diagnostics.status = diagnostics.status === "error" ? "error" : "warning";
        diagnostics.issues.push("Agent is enabled but not running. Try stopping and starting it again.");
      }
      if (account.totalTweets === 0 && account.enabled) {
        diagnostics.tips.push("Your agent hasn't posted yet. Make sure it's started and wait for the next posting cycle.");
      }
      if (runnerStatus.lastError) {
        diagnostics.status = "error";
        diagnostics.issues.push(runnerStatus.lastError);
      }

      res.json({
        connected: true,
        running: runnerStatus.running,
        handle: account.twitterHandle,
        role: account.role,
        enabled: account.enabled,
        personality: account.personality,
        instructions: account.instructions,
        companyName: account.companyName,
        companyDescription: account.companyDescription,
        companyProduct: account.companyProduct,
        companyAudience: account.companyAudience,
        companyWebsite: account.companyWebsite,
        companyKeyMessages: account.companyKeyMessages,
        ownerTelegramChatId: account.ownerTelegramChatId,
        postingFrequencyMins: account.postingFrequencyMins,
        autoReplyEnabled: account.autoReplyEnabled,
        autoBountyEnabled: account.autoBountyEnabled,
        totalTweets: account.totalTweets,
        totalReplies: account.totalReplies,
        totalBounties: account.totalBounties,
        lastPostedAt: account.lastPostedAt,
        createdAt: account.createdAt,
        diagnostics,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/agents/:agentId/twitter/post", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const { text, replyToTweetId } = req.body;
      if (!text || typeof text !== "string" || text.trim().length === 0) {
        return res.status(400).json({ error: "Tweet text is required" });
      }
      const account = await storage.getAgentTwitterAccount(agentId);
      if (!account) return res.status(404).json({ error: "No Twitter account connected" });

      const status = getAgentTwitterStatus(agentId);
      if (!status.running) {
        const startResult = await startAgentTwitter(agentId);
        if (!startResult.success) return res.status(400).json({ error: `Could not start agent: ${startResult.error}` });
      }

      const result = await postCustomTweet(agentId, text.trim(), replyToTweetId);
      if (!result.success) return res.status(400).json({ error: result.error });
      res.json({ success: true, tweetText: result.tweetText });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/agents/:agentId/twitter/intro-tweet", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const account = await storage.getAgentTwitterAccount(agentId);
      if (!account) return res.status(404).json({ error: "No Twitter account connected" });

      const status = getAgentTwitterStatus(agentId);
      if (!status.running) {
        const startResult = await startAgentTwitter(agentId);
        if (!startResult.success) return res.status(400).json({ error: `Could not start agent: ${startResult.error}` });
      }

      const result = await postIntroTweet(agentId);
      if (!result.success) return res.status(400).json({ error: result.error });
      res.json({ success: true, tweetText: result.tweetText });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/agents/:agentId/twitter/start", async (req: Request, res: Response) => {
    try {
      const agent = await verifyAgentOwnership(req, res);
      if (!agent) return;
      const { agentId } = req.params;
      const result = await startAgentTwitter(agentId);
      if (!result.success) return res.status(400).json({ error: result.error });
      res.json({ success: true, message: "Twitter agent started" });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/agents/:agentId/twitter/stop", async (req: Request, res: Response) => {
    try {
      const agent = await verifyAgentOwnership(req, res);
      if (!agent) return;
      const { agentId } = req.params;
      await stopAgentTwitter(agentId);
      res.json({ success: true, message: "Twitter agent stopped" });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/web4/agents/:agentId/twitter/settings", async (req: Request, res: Response) => {
    try {
      const agent = await verifyAgentOwnership(req, res);
      if (!agent) return;
      const { agentId } = req.params;
      const account = await storage.getAgentTwitterAccount(agentId);
      if (!account) return res.status(404).json({ error: "No Twitter account connected" });

      const parsed = agentTwitterSettingsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const updated = await storage.updateAgentTwitterAccount(agentId, parsed.data);
      const keysChanged = parsed.data.twitterApiKey || parsed.data.twitterApiSecret || parsed.data.twitterAccessToken || parsed.data.twitterAccessTokenSecret;
      if (keysChanged) {
        const runnerStatus = getAgentTwitterStatus(agentId);
        if (runnerStatus.running) {
          await stopAgentTwitter(agentId);
          const restartResult = await startAgentTwitter(agentId);
          res.json({ success: true, account: updated, restarted: restartResult.success, restartError: restartResult.error || null });
          return;
        }
      } else if (parsed.data.postingFrequencyMins) {
        updateAgentTwitterInterval(agentId, parsed.data.postingFrequencyMins);
      }
      res.json({ success: true, account: updated });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/web4/agents/:agentId/twitter/disconnect", async (req: Request, res: Response) => {
    try {
      const agent = await verifyAgentOwnership(req, res);
      if (!agent) return;
      const { agentId } = req.params;
      await stopAgentTwitter(agentId);
      await storage.deleteAgentTwitterAccount(agentId);
      res.json({ success: true, message: "Twitter disconnected" });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/strategy", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const memos = await storage.getStrategyMemos(agentId, 20);
      res.json(memos);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/strategy/active", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const active = await storage.getActiveStrategy(agentId);
      if (!active) return res.status(404).json({ error: "No active strategy found" });
      res.json(active);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/performance", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const limit = parseInt(req.query.limit as string) || 50;
      const records = await storage.getTweetPerformance(agentId, limit);

      const avgAlignment = records.length > 0
        ? Math.round(records.reduce((sum, r) => sum + (r.themeAlignment || 0), 0) / records.length)
        : 0;

      const themeCounts: Record<string, number> = {};
      for (const r of records) {
        if (r.alignedThemes) {
          try {
            for (const theme of JSON.parse(r.alignedThemes)) {
              themeCounts[theme] = (themeCounts[theme] || 0) + 1;
            }
          } catch {}
        }
      }

      const topThemes = Object.entries(themeCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

      res.json({
        total: records.length,
        avgAlignment,
        topThemes: Object.fromEntries(topThemes),
        tweets: records,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/action-items", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const items = await storage.getStrategyActionItems(agentId);
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/web4/agents/:agentId/action-items/:itemId", async (req: Request, res: Response) => {
    try {
      const { itemId } = req.params;
      const { status } = req.body;
      if (!["pending", "done", "skipped"].includes(status)) {
        return res.status(400).json({ error: "Status must be pending, done, or skipped" });
      }
      const updated = await storage.updateStrategyActionItem(itemId, {
        status,
        completedAt: status === "done" ? new Date() : null,
      });
      if (!updated) return res.status(404).json({ error: "Action item not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/knowledge", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const entries = await storage.getKnowledgeBase(agentId);
      res.json(entries);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/agents/:agentId/knowledge", async (req: Request, res: Response) => {
    try {
      const agent = await verifyAgentOwnership(req, res);
      if (!agent) return;
      const { agentId } = req.params;
      const { title, content, sourceType } = req.body;
      if (!title || !content) {
        return res.status(400).json({ error: "Title and content are required" });
      }
      if (typeof title !== "string" || title.length > 200) {
        return res.status(400).json({ error: "Title must be a string under 200 characters" });
      }
      if (typeof content !== "string" || content.length > 5000) {
        return res.status(400).json({ error: "Content must be a string under 5000 characters" });
      }
      const entry = await storage.createKnowledgeEntry({
        agentId,
        title: title.trim(),
        content: content.trim(),
        sourceType: sourceType || "manual",
      });
      res.json(entry);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/web4/agents/:agentId/knowledge/:entryId", async (req: Request, res: Response) => {
    try {
      const agent = await verifyAgentOwnership(req, res);
      if (!agent) return;
      const { entryId } = req.params;
      await storage.deleteKnowledgeEntry(entryId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/conversations", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const conversations = await storage.getRecentConversations(agentId, 50);
      res.json(conversations);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/agents/:agentId/collaborations", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const collabs = await storage.getRecentCollaborations(agentId, 20);
      res.json(collabs);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/agents/:agentId/strategy/generate", async (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const status = getAgentTwitterStatus(agentId);
      if (!status.running) {
        return res.status(400).json({ error: "Agent Twitter is not running. Start the agent first." });
      }
      try {
        const { runStrategyCycle } = await import("./multi-twitter-agent");
        if (typeof runStrategyCycle !== "function") {
          return res.status(501).json({ error: "Strategy cycle not yet implemented" });
        }
        await runStrategyCycle(agentId);
        const active = await storage.getActiveStrategy(agentId);
        res.json({ success: true, memo: active || null });
      } catch (importErr: any) {
        return res.status(501).json({ error: "Strategy cycle not available: " + importErr.message });
      }
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/web4/tasks", async (req: Request, res: Response) => {
    try {
      const { agentId, title, description, taskType, creatorWallet } = req.body;
      if (!agentId || !title || !description || !taskType) {
        return res.status(400).json({ error: "agentId, title, description, and taskType are required" });
      }
      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const callerWallet = (req.headers["x-wallet-address"] as string || "").toLowerCase();
      if (!callerWallet) {
        return res.status(401).json({ error: "Wallet connection required to assign tasks" });
      }
      if (agent.creatorWallet && agent.creatorWallet.toLowerCase() !== callerWallet) {
        return res.status(403).json({ error: "You can only assign tasks to your own agents" });
      }
      if (typeof title !== "string" || title.length > 200) {
        return res.status(400).json({ error: "Title must be under 200 characters" });
      }
      if (typeof description !== "string" || description.length > 5000) {
        return res.status(400).json({ error: "Description must be under 5000 characters" });
      }
      const validTypes = ["research", "analysis", "content", "code_review", "strategy", "general", "launch_token"];
      if (!validTypes.includes(taskType)) {
        return res.status(400).json({ error: `taskType must be one of: ${validTypes.join(", ")}` });
      }

      const task = await storage.createTask({
        agentId,
        creatorWallet: callerWallet,
        taskType,
        title: title.trim(),
        description: description.trim(),
        status: "pending",
        result: null,
        toolsUsed: null,
        modelUsed: null,
        executionTimeMs: null,
      });

      res.json(task);

      const { executeTask } = await import("./task-engine");
      executeTask(task.id).catch(err =>
        console.error(`[TaskEngine] Task ${task.id} execution error:`, err.message)
      );
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/tasks/recent", async (req: Request, res: Response) => {
    try {
      const tasks = await storage.getRecentPublicTasks(30);
      const agentIds = [...new Set(tasks.map(t => t.agentId))];
      const agents: Record<string, any> = {};
      for (const id of agentIds) {
        const agent = await storage.getAgent(id);
        if (agent) agents[id] = { name: agent.name, bio: agent.bio };
      }
      res.json({ tasks, agents });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/tasks/:taskId", async (req: Request, res: Response) => {
    try {
      const task = await storage.getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: "Task not found" });
      const agent = await storage.getAgent(task.agentId);
      res.json({ task, agent: agent ? { name: agent.name, bio: agent.bio } : null });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/tasks/agent/:agentId", async (req: Request, res: Response) => {
    try {
      const tasks = await storage.getTasksByAgent(req.params.agentId, 30);
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/web4/tasks/creator/:wallet", async (req: Request, res: Response) => {
    try {
      const tasks = await storage.getTasksByCreator(req.params.wallet, 30);
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/status", async (_req: Request, res: Response) => {
    const configured = isOKXConfigured();
    const cliInstalled = await isOnchainOSInstalled();
    let cliVersion = "";
    if (cliInstalled) {
      try { cliVersion = await getOnchainOSVersion(); } catch {}
    }
    const onchainOSSkills = getOnchainOSSkillDefs();
    res.json({
      active: configured,
      supportedChains: SUPPORTED_CHAIN_IDS,
      nativeTokenAddress: NATIVE_TOKEN_ADDRESS,
      features: {
        dexAggregator: configured,
        marketData: configured,
        crossChainBridge: configured,
        walletApi: configured,
      },
      onchainOS: {
        cliInstalled,
        cliVersion,
        skillCount: onchainOSSkills.length,
        skills: onchainOSSkills.map(s => ({ id: s.id, name: s.name, icon: s.icon, category: s.category, commandCount: s.commands.length })),
      },
    });
  });

  app.use("/api/okx", okxRateLimit);

  app.get("/api/okx/dex/quote", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId, fromToken, toToken, amount, slippage } = req.query as Record<string, string>;
      if (!chainId || !fromToken || !toToken || !amount) return res.status(400).json({ error: "Missing required params: chainId, fromToken, toToken, amount" });
      const data = await getSwapQuote({ chainId, fromTokenAddress: fromToken, toTokenAddress: toToken, amount, slippage });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/dex/swap", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId, fromToken, toToken, amount, slippage, userWalletAddress } = req.query as Record<string, string>;
      if (!chainId || !fromToken || !toToken || !amount || !userWalletAddress) return res.status(400).json({ error: "Missing required params" });
      const data = await getSwapData({ chainId, fromTokenAddress: fromToken, toTokenAddress: toToken, amount, slippage, userWalletAddress });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/dex/approve", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId, tokenAddress, amount } = req.query as Record<string, string>;
      if (!chainId || !tokenAddress || !amount) return res.status(400).json({ error: "Missing required params" });
      const data = await getApproveTransaction({ chainId, tokenContractAddress: tokenAddress, approveAmount: amount });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/dex/tokens", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId } = req.query as Record<string, string>;
      if (!chainId) return res.status(400).json({ error: "Missing chainId" });
      const data = await getSupportedTokens(chainId);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/market/token", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId, tokenAddress } = req.query as Record<string, string>;
      if (!chainId || !tokenAddress) return res.status(400).json({ error: "Missing chainId or tokenAddress" });
      const data = await getTokenPrice(tokenAddress, chainId);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/market/trading-data", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId, tokenAddress } = req.query as Record<string, string>;
      if (!chainId || !tokenAddress) return res.status(400).json({ error: "Missing chainId or tokenAddress" });
      const data = await getTokenMarketData({ chainId, tokenAddress });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/market/top-tokens", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId } = req.query as Record<string, string>;
      if (!chainId) return res.status(400).json({ error: "Missing chainId" });
      const data = await getTopTokens(chainId);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/market/trending", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId } = req.query as Record<string, string>;
      if (!chainId) return res.status(400).json({ error: "Missing chainId" });
      const data = await getTrendingTokens(chainId);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/market/holders", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId, tokenAddress } = req.query as Record<string, string>;
      if (!chainId || !tokenAddress) return res.status(400).json({ error: "Missing chainId or tokenAddress" });
      const data = await getTokenHolders({ chainId, tokenAddress });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/bridge/quote", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { fromChainId, toChainId, fromToken, toToken, amount, slippage } = req.query as Record<string, string>;
      if (!fromChainId || !toChainId || !fromToken || !toToken || !amount) return res.status(400).json({ error: "Missing required params" });
      if (fromChainId === toChainId) return res.status(400).json({ error: "Source and destination chains must be different. Use DEX swap for same-chain trades." });
      const data = await getCrossChainQuote({ fromChainId, toChainId, fromTokenAddress: fromToken, toTokenAddress: toToken, amount, slippage });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/bridge/swap", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { fromChainId, toChainId, fromToken, toToken, amount, userWalletAddress, slippage } = req.query as Record<string, string>;
      if (!fromChainId || !toChainId || !fromToken || !toToken || !amount || !userWalletAddress) return res.status(400).json({ error: "Missing required params" });
      if (fromChainId === toChainId) return res.status(400).json({ error: "Source and destination chains must be different. Use DEX swap for same-chain trades." });
      const data = await getCrossChainSwap({ fromChainId, toChainId, fromTokenAddress: fromToken, toTokenAddress: toToken, amount, userWalletAddress, slippage });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/bridge/status", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { chainId, txHash } = req.query as Record<string, string>;
      if (!chainId || !txHash) return res.status(400).json({ error: "Missing chainId or txHash" });
      const data = await getCrossChainStatus({ chainId, txHash });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/bridge/chains", async (_req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const data = await getSupportedBridgeChains();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/wallet/balances", async (req: Request, res: Response) => {
    try {
      if (!isOKXConfigured()) return res.status(503).json({ error: "OnchainOS service is currently unavailable. Please try again later." });
      const { address, chainId } = req.query as Record<string, string>;
      if (!address || !chainId) return res.status(400).json({ error: "Missing address or chainId" });
      const data = await getWalletTokenBalances({ address, chainId });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/okx/onchainos/skills", async (_req: Request, res: Response) => {
    try {
      const installed = await isOnchainOSInstalled();
      const skills = getOnchainOSSkillDefs();
      let version = "";
      if (installed) { try { version = await getOnchainOSVersion(); } catch {} }
      res.json({ installed, version, skills });
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/okx/onchainos/execute", async (req: Request, res: Response) => {
    try {
      const { skill, command, params } = req.body;
      if (!skill || !command) return res.status(400).json({ error: "Missing skill or command" });

      if (!validateOnchainOSCommand(skill, command)) {
        return res.status(400).json({ error: `Unknown skill/command: ${skill}/${command}` });
      }

      if (isDangerousCommand(command)) {
        return res.status(403).json({ error: "Write operations (send, approve, broadcast, contract-call) are restricted to agent-only execution" });
      }

      const result = await runOnchainOSCommand(skill, command, params || {});
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

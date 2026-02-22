import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { getProviderStatus, isProviderLive, getAvailableProviders } from "./inference";
import { startAgentRunner, stopAgentRunner, isAgentRunnerActive, isOnchainActive } from "./agent-runner";
import { isOnchainReady, getContractAddresses, getDeployerBalance, getExplorerUrl, getChainId, getNetworkName, isMainnet, getSpendingStatus, collectFeeOnchain, collectFeeAcrossAllChains, reimburseGasCost, registerAgentOnchain, depositOnchain, registerAndDepositOnChain, getMultiChainBalances, initMultiChain, getRevenueWalletAddress, verifyPaymentTransaction, getSupportedChains } from "./onchain";
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
} from "@shared/schema";
import { executeSkillCode, validateSkillCode, executeSkillWithExternalData } from "./skill-executor";
import { seedKnownPlatforms, runHttpOutreach, runOnchainBeacon, runFullOutreach, runDirectRecruitment, getOutreachMessage, getPlatformRegistry, getAnnouncementFormats, startAutoBroadcast, stopAutoBroadcast, getAutoBroadcastStatus } from "./outreach";

function getBaseUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers.host || "localhost:5000";
  return `${proto}://${host}`;
}

export function registerWeb4Routes(app: Express): void {

  app.get("/.well-known/ai-plugin.json", (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    res.json({
      schema_version: "v1",
      name_for_human: "BUILD4 AI Marketplace",
      name_for_model: "build4_marketplace",
      description_for_human: "Permissionless AI skill marketplace on BNB Chain, Base, and XLayer. List, discover, and execute AI skills using only a wallet address.",
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
    res.json({
      name: "BUILD4",
      description: "Decentralized AI agent skill marketplace. No registration. Wallet = Identity. Fully permissionless.",
      url: baseUrl,
      protocol_url: `${baseUrl}/api/protocol`,
      capabilities: ["skill-marketplace", "skill-execution", "skill-listing", "bounty-board", "bounty-posting", "wallet-identity", "on-chain-payments"],
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
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/agents/:agentId", async (req: Request, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      res.json(agent);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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

      for (const tx of allTx) {
        const amt = BigInt(tx.amount || "0");
        if (tx.type.startsWith("earn") || tx.type === "deposit" || tx.type === "revenue_share") {
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
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/agents/:agentId/multichain-balances", async (req: Request, res: Response) => {
    try {
      const agent = await storage.getAgent(req.params.agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const balances = await getMultiChainBalances(req.params.agentId);
      res.json({ agentId: req.params.agentId, agentName: agent.name, balances });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/web4/agents/create", async (req: Request, res: Response) => {
    try {
      const parsed = web4CreateAgentRequestSchema.parse(req.body);

      if (!/^\d+$/.test(parsed.initialDeposit)) {
        return res.status(400).json({ error: "initialDeposit must be a numeric wei string" });
      }

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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/skills/agent/:agentId", async (req: Request, res: Response) => {
    try {
      const skills = await storage.getSkills(req.params.agentId);
      res.json(skills);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
        const gasReimb = await reimburseGasCost(parsed.agentId, feeResult.gasCostWei, "skill_listing_fee");
        if (gasReimb.success) {
          await storage.recordPlatformRevenue({ feeType: "gas_reimbursement", amount: feeResult.gasCostWei, agentId: parsed.agentId, description: `Gas reimbursement for skill listing fee`, txHash: gasReimb.txHash, chainId: gasReimb.chainId });
        }
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
          const gasReimb = await reimburseGasCost(parsed.buyerAgentId, feeResult.gasCostWei, "skill_purchase_fee");
          if (gasReimb.success) {
            await storage.recordPlatformRevenue({ feeType: "gas_reimbursement", amount: feeResult.gasCostWei, agentId: parsed.buyerAgentId, description: `Gas reimbursement for skill purchase fee`, txHash: gasReimb.txHash, chainId: gasReimb.chainId });
          }
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
      res.status(500).json({ error: e.message });
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
        const gasReimb = await reimburseGasCost(parsed.agentId, feeResult.gasCostWei, "evolution_fee");
        if (gasReimb.success) {
          await storage.recordPlatformRevenue({ feeType: "gas_reimbursement", amount: feeResult.gasCostWei, agentId: parsed.agentId, description: `Gas reimbursement for evolution fee`, txHash: gasReimb.txHash, chainId: gasReimb.chainId });
        }
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
      res.status(500).json({ error: e.message });
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
          const gasReimb = await reimburseGasCost(parsed.parentAgentId, feeResult.gasCostWei, "replication_fee");
          if (gasReimb.success) {
            await storage.recordPlatformRevenue({ feeType: "gas_reimbursement", amount: feeResult.gasCostWei, agentId: parsed.parentAgentId, description: `Gas reimbursement for replication fee`, txHash: gasReimb.txHash, chainId: gasReimb.chainId });
          }
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
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/constitution/:agentId", async (req: Request, res: Response) => {
    try {
      const laws = await storage.getConstitution(req.params.agentId);
      res.json(laws);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/soul/:agentId", async (req: Request, res: Response) => {
    try {
      const entries = await storage.getSoulEntries(req.params.agentId);
      res.json(entries);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/inference/providers", async (_req: Request, res: Response) => {
    try {
      const providers = await storage.getAllInferenceProviders();
      res.json(providers);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/inference/providers/:providerId", async (req: Request, res: Response) => {
    try {
      const provider = await storage.getInferenceProvider(req.params.providerId);
      if (!provider) return res.status(404).json({ error: "Provider not found" });
      res.json(provider);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/inference/requests/:agentId", async (req: Request, res: Response) => {
    try {
      const requests = await storage.getInferenceRequests(req.params.agentId);
      res.json(requests);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/web4/runner/start", async (_req: Request, res: Response) => {
    try {
      startAgentRunner();
      res.json({ success: true, running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/web4/runner/stop", async (_req: Request, res: Response) => {
    try {
      stopAgentRunner();
      res.json({ success: true, running: false });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
          contract: "For BNB Chain, Base, XLayer — deposit through smart contract (AgentEconomyHub.deposit)",
          direct: "For all other EVM chains — send native tokens directly to the platform wallet address",
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/revenue/history", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const history = await storage.getPlatformRevenue(limit);
      res.json(history);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/web4/walletconnect-config", async (_req: Request, res: Response) => {
    const projectId = process.env.WALLETCONNECT_PROJECT_ID;
    if (!projectId) {
      return res.status(404).json({ error: "WalletConnect not configured" });
    }
    res.json({ projectId });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/marketplace/skills", async (req: Request, res: Response) => {
    try {
      const category = req.query.category as string | undefined;
      const executableOnly = req.query.executable === "true";
      let skills;
      if (executableOnly) {
        skills = await storage.getExecutableSkills();
      } else {
        skills = await storage.getTopSkills(100);
      }
      if (category && category !== "all") {
        skills = skills.filter(s => s.category === category);
      }
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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

      const isExternalDataSkill = ["crypto-data", "web-data"].includes(skill.category);
      let externalData: Record<string, any> | undefined;
      if (isExternalDataSkill) {
        const { fetchExternalData } = await import("./skill-executor");
        externalData = await fetchExternalData();
      }

      const result = isExternalDataSkill
        ? executeSkillWithExternalData(skill.code, parsed.input, skill.inputSchema, externalData!)
        : executeSkillCode(skill.code, parsed.input, skill.inputSchema);

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
        hasExternalData: isExternalDataSkill,
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

  app.get("/api/marketplace/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getMarketplaceStats();
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
        const isExternal = ["crypto-data", "web-data"].includes(skill.category);
        let extData: Record<string, any> | undefined;
        if (isExternal) {
          const { fetchExternalData } = await import("./skill-executor");
          extData = await fetchExternalData();
        }

        const result = isExternal
          ? executeSkillWithExternalData(skill.code, currentInput, skill.inputSchema, extData!)
          : executeSkillCode(skill.code, currentInput, skill.inputSchema);

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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/outreach/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getOutreachStats();
      const platforms = getPlatformRegistry();
      res.json({ ...stats, knownPlatforms: platforms.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/outreach/targets", async (_req: Request, res: Response) => {
    try {
      const targets = await storage.getOutreachTargets();
      res.json(targets);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/outreach/campaigns", async (_req: Request, res: Response) => {
    try {
      const campaigns = await storage.getOutreachCampaigns();
      res.json(campaigns);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/outreach/seed", async (_req: Request, res: Response) => {
    try {
      const count = await seedKnownPlatforms();
      res.json({ seeded: count, message: `${count} new platforms added to outreach registry` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
}

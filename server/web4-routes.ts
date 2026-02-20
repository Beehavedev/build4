import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { getProviderStatus, isProviderLive, getAvailableProviders } from "./inference";
import { startAgentRunner, stopAgentRunner, isAgentRunnerActive, isOnchainActive } from "./agent-runner";
import { isOnchainReady, getContractAddresses, getDeployerBalance, getExplorerUrl, getChainId, getNetworkName, isMainnet, getSpendingStatus, collectFeeOnchain, registerAgentOnchain } from "./onchain";
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
  PLATFORM_FEES,
} from "@shared/schema";

export function registerWeb4Routes(app: Express): void {
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

      let onchainRegistration = null;
      const maxRegAttempts = 3;
      for (let attempt = 1; attempt <= maxRegAttempts; attempt++) {
        try {
          const regResult = await registerAgentOnchain(result.agent.id);
          onchainRegistration = regResult;
          if (regResult.success) {
            console.log(`[web4] Agent ${result.agent.id} registered on-chain (attempt ${attempt}): ${regResult.txHash}`);
            break;
          } else {
            console.warn(`[web4] On-chain registration attempt ${attempt}/${maxRegAttempts} failed: ${regResult.error}`);
            if (attempt < maxRegAttempts) {
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        } catch (regErr: any) {
          console.warn(`[web4] On-chain registration attempt ${attempt}/${maxRegAttempts} error: ${regErr.message}`);
          if (attempt < maxRegAttempts) {
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      }

      res.json({ ...result, onchainRegistration });
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
      const feeResult = await collectFeeOnchain(parsed.agentId, listingFee, "skill_listing");
      if (!feeResult.success) {
        console.warn(`[web4] On-chain skill listing fee failed: ${feeResult.error}`);
      }

      const skill = await storage.createSkill({
        agentId: parsed.agentId,
        name: parsed.name,
        description: parsed.description,
        priceAmount: parsed.priceAmount,
        category: parsed.category,
        isActive: true,
      });

      await storage.recordPlatformRevenue({
        feeType: "skill_listing",
        amount: listingFee,
        agentId: parsed.agentId,
        description: `Skill listing fee for "${parsed.name}"${feeResult.success ? ' [on-chain verified]' : ''}`,
        txHash: feeResult.txHash || undefined,
        chainId: feeResult.chainId || undefined,
      });

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
        const feeResult = await collectFeeOnchain(parsed.buyerAgentId, purchaseFee, "skill_purchase");
        if (!feeResult.success) {
          console.warn(`[web4] On-chain skill purchase fee failed: ${feeResult.error}`);
        }
        await storage.recordPlatformRevenue({
          feeType: "skill_purchase",
          amount: purchaseFee,
          agentId: parsed.buyerAgentId,
          description: `Skill purchase fee for "${skill.name}" (2.5%)${feeResult.success ? ' [on-chain verified]' : ''}`,
          txHash: feeResult.txHash || undefined,
          chainId: feeResult.chainId || undefined,
        });
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
      const feeResult = await collectFeeOnchain(parsed.agentId, evolutionFee, "evolution");
      if (!feeResult.success) {
        console.warn(`[web4] On-chain evolution fee failed: ${feeResult.error}`);
      }

      const evolution = await storage.evolveAgent(parsed.agentId, parsed.toModel, parsed.reason, parsed.metricsJson);

      await storage.recordPlatformRevenue({
        feeType: "evolution",
        amount: evolutionFee,
        agentId: parsed.agentId,
        description: `Evolution fee: ${parsed.toModel}${feeResult.success ? ' [on-chain verified]' : ''}`,
        txHash: feeResult.txHash || undefined,
        chainId: feeResult.chainId || undefined,
      });

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
        const feeResult = await collectFeeOnchain(parsed.parentAgentId, totalFee, "replication");
        if (!feeResult.success) {
          console.warn(`[web4] On-chain replication fee failed: ${feeResult.error}`);
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
          liveStatus: live ? "connected" : "simulation",
          metadata: JSON.stringify({ ...meta, live }),
        };
      });
      res.json({
        providers: enriched,
        summary: {
          total: providers.length,
          live: enriched.filter(p => p.live).length,
          simulated: enriched.filter(p => !p.live).length,
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
      await storage.seedDemoData();
      res.json({ success: true });
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
        mode: providers.length > 0 ? "live" : "simulation",
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

  app.get("/api/web4/revenue/summary", async (_req: Request, res: Response) => {
    try {
      const summary = await storage.getPlatformRevenueSummary();
      const explorerBases: Record<number, string> = {
        56: "https://bscscan.com",
        8453: "https://basescan.org",
        196: "https://www.oklink.com/xlayer",
      };
      res.json({ ...summary, explorerBases });
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
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

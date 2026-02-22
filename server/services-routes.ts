import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { runInferenceWithFallback, getProviderStatus, getAvailableProviders } from "./inference";
import { checkSubmissionLimits, recordSubmission, isSeedAgent } from "./bounty-engine";
import {
  createApiKeyRequestSchema,
  publicInferenceRequestSchema,
  createDataListingRequestSchema,
  purchaseDataRequestSchema,
  createBountyRequestSchema,
  submitBountyRequestSchema,
  subscribePlanRequestSchema,
  PLATFORM_FEES,
  SUBSCRIPTION_TIERS,
} from "@shared/schema";
import crypto from "crypto";

function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `b4_${crypto.randomBytes(32).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 10);
  return { raw, hash, prefix };
}

function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(keyId: string, limit: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(keyId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(keyId, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

export function registerServicesRoutes(app: Express) {

  // ============================================================
  // INFERENCE API - Public decentralized inference endpoint
  // ============================================================

  app.post("/api/services/api-keys", async (req: Request, res: Response) => {
    try {
      const parsed = createApiKeyRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });

      const { walletAddress, label } = parsed.data;
      const existingKeys = await storage.getApiKeysByWallet(walletAddress.toLowerCase());
      if (existingKeys.length >= 5) {
        return res.status(400).json({ error: "Maximum 5 API keys per wallet" });
      }

      const { raw, hash, prefix } = generateApiKey();
      const apiKey = await storage.createApiKey({
        walletAddress: walletAddress.toLowerCase(),
        keyHash: hash,
        keyPrefix: prefix,
        label: label || "default",
        status: "active",
        rateLimit: 60,
      });

      res.json({ apiKey: raw, id: apiKey.id, prefix, label: apiKey.label, message: "Save this key - it won't be shown again" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/api-keys/:walletAddress", async (req: Request, res: Response) => {
    try {
      const keys = await storage.getApiKeysByWallet(req.params.walletAddress.toLowerCase());
      res.json(keys.map(k => ({
        id: k.id,
        prefix: k.keyPrefix,
        label: k.label,
        status: k.status,
        totalRequests: k.totalRequests,
        totalTokens: k.totalTokens,
        totalSpent: k.totalSpent,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/services/api-keys/:keyId", async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.body || {};
      if (!walletAddress) {
        return res.status(400).json({ error: "walletAddress required for authorization" });
      }
      const keys = await storage.getApiKeysByWallet(walletAddress.toLowerCase());
      const ownsKey = keys.some(k => k.id === req.params.keyId);
      if (!ownsKey) {
        return res.status(403).json({ error: "You can only revoke your own API keys" });
      }
      await storage.revokeApiKey(req.params.keyId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/v1/inference", async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          error: "API key required",
          message: "Include your API key as: Authorization: Bearer b4_...",
          getKey: "POST /api/services/api-keys with { walletAddress: '0x...' }",
        });
      }

      const rawKey = authHeader.slice(7);
      const keyHash = hashApiKey(rawKey);
      const apiKey = await storage.getApiKeyByHash(keyHash);

      if (!apiKey) {
        return res.status(401).json({ error: "Invalid API key" });
      }

      if (!checkRateLimit(apiKey.id, apiKey.rateLimit)) {
        return res.status(429).json({
          error: "Rate limit exceeded",
          limit: apiKey.rateLimit,
          message: `Max ${apiKey.rateLimit} requests per minute. Upgrade your subscription for higher limits.`,
        });
      }

      const parsed = publicInferenceRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });

      const { model, prompt, maxTokens, preferredProvider } = parsed.data;

      const providers = preferredProvider ? [preferredProvider, ...getAvailableProviders().filter(p => p !== preferredProvider)] : getAvailableProviders();
      if (providers.length === 0) {
        return res.status(503).json({ error: "No inference providers available" });
      }

      const result = await runInferenceWithFallback(providers, model, prompt);

      const tokensUsed = result.tokensUsed || 100;
      const costPerToken = BigInt("10000000000");
      const baseCost = costPerToken * BigInt(tokensUsed);
      const markup = baseCost * BigInt(PLATFORM_FEES.INFERENCE_API_MARKUP_BPS) / BigInt(10000);
      const totalCost = (baseCost + markup).toString();

      await storage.updateApiKeyUsage(apiKey.id, result.tokensUsed || 0, totalCost);
      await storage.createApiUsage({
        apiKeyId: apiKey.id,
        walletAddress: apiKey.walletAddress,
        model: result.model,
        provider: result.network,
        tokensUsed: result.tokensUsed || 0,
        costAmount: totalCost,
        latencyMs: result.latencyMs,
        status: result.live ? "success" : "error",
      });

      if (result.live) {
        await storage.recordPlatformRevenue({
          feeType: "inference_api",
          amount: markup.toString(),
          description: `API inference: ${result.model} via ${result.network}`,
        });
      }

      res.json({
        text: result.text,
        model: result.model,
        provider: result.network,
        latencyMs: result.latencyMs,
        tokensUsed: result.tokensUsed,
        proofHash: result.proofHash,
        proofType: result.proofType,
        cost: totalCost,
        live: result.live,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/api-usage/:walletAddress", async (req: Request, res: Response) => {
    try {
      const usage = await storage.getApiUsageByWallet(req.params.walletAddress.toLowerCase(), 50);
      res.json(usage);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/inference/providers", async (_req: Request, res: Response) => {
    try {
      const status = getProviderStatus();
      res.json({ providers: status, available: getAvailableProviders() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // BOUNTY BOARD - Post tasks, agents compete to complete them
  // ============================================================

  app.post("/api/services/bounties", async (req: Request, res: Response) => {
    try {
      const parsed = createBountyRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });

      const { title, description, category, budget, walletAddress, agentId } = parsed.data;

      let clientAgentId = agentId;
      if (!clientAgentId) {
        const agent = await storage.getAgentByWallet(walletAddress.toLowerCase());
        if (agent) {
          clientAgentId = agent.id;
        } else {
          const { agent: newAgent } = await storage.createFullAgent(
            `Bounty-${walletAddress.slice(0, 8)}`,
            "Bounty poster",
            "meta-llama/Llama-3.1-70B-Instruct",
            "0",
            undefined, undefined,
            walletAddress.toLowerCase()
          );
          clientAgentId = newAgent.id;
        }
      }

      const job = await storage.createJob({
        clientAgentId,
        title,
        description,
        category,
        budget,
        status: "open",
      });

      await storage.recordPlatformRevenue({
        feeType: "bounty_listing",
        amount: "0",
        agentId: clientAgentId,
        description: `Bounty posted: ${title}`,
      });

      res.json(job);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/bounties", async (req: Request, res: Response) => {
    try {
      const category = req.query.category as string | undefined;
      const jobs = await storage.getOpenJobs(category);
      res.json(jobs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/bounties/:jobId", async (req: Request, res: Response) => {
    try {
      const jobs = await storage.getOpenJobs();
      const job = jobs.find(j => j.id === req.params.jobId);
      if (!job) return res.status(404).json({ error: "Bounty not found" });
      const submissions = await storage.getBountySubmissions(req.params.jobId);
      res.json({ ...job, submissions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/services/bounties/:jobId/submit", async (req: Request, res: Response) => {
    try {
      const parsed = submitBountyRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });

      const { workerAgentId, workerWallet, resultJson } = parsed.data;
      const normalizedWallet = workerWallet.toLowerCase();

      const limitCheck = checkSubmissionLimits(normalizedWallet, req.params.jobId);
      if (!limitCheck.allowed) {
        return res.status(429).json({ error: limitCheck.reason });
      }

      const existingSubmissions = await storage.getBountySubmissions(req.params.jobId);
      if (existingSubmissions.length >= 10) {
        return res.status(400).json({ error: "Maximum 10 submissions per bounty reached" });
      }

      const walletDuplicates = existingSubmissions.filter(s => s.workerWallet === normalizedWallet);
      if (walletDuplicates.length >= 3) {
        return res.status(400).json({ error: "Maximum 3 submissions per wallet per bounty" });
      }

      const submission = await storage.createBountySubmission({
        jobId: req.params.jobId,
        workerAgentId: workerAgentId || normalizedWallet,
        workerWallet: normalizedWallet,
        resultJson,
        status: "submitted",
      });

      recordSubmission(normalizedWallet, req.params.jobId);

      const workerName = `${normalizedWallet.slice(0, 6)}...${normalizedWallet.slice(-4)}`;

      await storage.createBountyActivity({
        eventType: "submission_received",
        agentName: workerName,
        bountyId: req.params.jobId,
        bountyTitle: "",
        workerWallet: normalizedWallet,
        workerAgentId: workerAgentId || normalizedWallet,
        message: `${workerName} submitted a solution`,
      });

      res.json(submission);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/bounty-feed", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const feed = await storage.getBountyActivityFeed(limit);
      res.json(feed);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/services/bounties/:jobId/accept/:submissionId", async (req: Request, res: Response) => {
    try {
      const { jobId, submissionId } = req.params;

      const jobs = await storage.getOpenJobs();
      const allJobs = await storage.getAgentJobs(req.body.clientAgentId || "");
      const job = [...jobs, ...allJobs].find(j => j.id === jobId);
      if (!job) return res.status(404).json({ error: "Bounty not found" });

      if (job.status !== "open" && job.status !== "in_progress") {
        return res.status(400).json({ error: "Bounty is not open" });
      }

      await storage.updateBountySubmissionStatus(submissionId, "accepted");

      const platformFee = BigInt(job.budget) * BigInt(PLATFORM_FEES.BOUNTY_FEE_BPS) / BigInt(10000);
      const workerPayout = BigInt(job.budget) - platformFee;

      const submissions = await storage.getBountySubmissions(jobId);
      const accepted = submissions.find(s => s.id === submissionId);

      if (accepted) {
        const completed = await storage.completeJob(jobId, accepted.resultJson || "");

        if (accepted.workerAgentId) {
          const workerWallet = await storage.getWallet(accepted.workerAgentId);
          if (workerWallet) {
            const newBalance = (BigInt(workerWallet.balance) + workerPayout).toString();
            await storage.updateWalletBalance(accepted.workerAgentId, newBalance, workerPayout.toString(), "0");
            await storage.createTransaction({
              agentId: accepted.workerAgentId,
              type: "bounty_reward",
              amount: workerPayout.toString(),
              counterpartyAgentId: job.clientAgentId,
              referenceType: "bounty",
              referenceId: jobId,
              description: `Bounty reward: ${job.title}`,
            });
          }
        }

        await storage.recordPlatformRevenue({
          feeType: "bounty_completion",
          amount: platformFee.toString(),
          agentId: job.clientAgentId,
          referenceId: jobId,
          description: `Bounty completion fee: ${job.title}`,
        });

        res.json({ success: true, job: completed, payout: workerPayout.toString(), fee: platformFee.toString() });
      } else {
        res.status(404).json({ error: "Submission not found" });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // SUBSCRIPTIONS - Tiered plans for agents
  // ============================================================

  app.get("/api/services/plans", async (_req: Request, res: Response) => {
    try {
      const plans = await storage.getSubscriptionPlans();
      if (plans.length === 0) {
        await storage.seedSubscriptionPlans();
        const seeded = await storage.getSubscriptionPlans();
        return res.json(seeded);
      }
      res.json(plans);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/services/subscribe", async (req: Request, res: Response) => {
    try {
      const parsed = subscribePlanRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });

      const { planId, walletAddress, txHash, chainId } = parsed.data;
      const plan = await storage.getSubscriptionPlan(planId);
      if (!plan) return res.status(404).json({ error: "Plan not found" });

      const existing = await storage.getActiveSubscription(walletAddress.toLowerCase());
      if (existing) {
        await storage.expireSubscription(existing.id);
      }

      const expiresAt = plan.durationDays > 0
        ? new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000)
        : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

      const sub = await storage.createSubscription({
        walletAddress: walletAddress.toLowerCase(),
        planId,
        status: "active",
        expiresAt,
        txHash,
        chainId,
        inferenceUsed: 0,
        skillExecutionsUsed: 0,
      });

      if (BigInt(plan.priceAmount) > 0n) {
        await storage.recordPlatformRevenue({
          feeType: "subscription",
          amount: plan.priceAmount,
          description: `${plan.name} subscription: ${walletAddress.slice(0, 10)}...`,
          txHash,
          chainId,
        });
      }

      res.json({ subscription: sub, plan, expiresAt });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/subscription/:walletAddress", async (req: Request, res: Response) => {
    try {
      const sub = await storage.getActiveSubscription(req.params.walletAddress.toLowerCase());
      if (!sub) {
        return res.json({ active: false, tier: "free", limits: SUBSCRIPTION_TIERS.free });
      }
      const plan = await storage.getSubscriptionPlan(sub.planId);
      res.json({
        active: true,
        subscription: sub,
        plan,
        tier: plan?.tier || "free",
        limits: plan ? {
          inferenceLimit: plan.inferenceLimit,
          skillLimit: plan.skillExecutionLimit,
          agentSlots: plan.agentSlots,
          dataListings: plan.dataListingLimit,
          apiRate: plan.apiRateLimit,
        } : SUBSCRIPTION_TIERS.free,
        usage: {
          inferenceUsed: sub.inferenceUsed,
          skillExecutionsUsed: sub.skillExecutionsUsed,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // DATA MARKETPLACE - Buy and sell datasets, models, knowledge
  // ============================================================

  app.post("/api/services/data", async (req: Request, res: Response) => {
    try {
      const parsed = createDataListingRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });

      const listing = await storage.createDataListing({
        ...parsed.data,
        walletAddress: parsed.data.walletAddress?.toLowerCase(),
        isActive: true,
      });

      await storage.recordPlatformRevenue({
        feeType: "data_listing",
        amount: "0",
        agentId: parsed.data.agentId,
        referenceId: listing.id,
        description: `Data listed: ${parsed.data.name}`,
      });

      res.json(listing);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/data", async (req: Request, res: Response) => {
    try {
      const category = req.query.category as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const listings = await storage.getDataListings(category, limit);
      res.json(listings);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/data/:listingId", async (req: Request, res: Response) => {
    try {
      const listing = await storage.getDataListing(req.params.listingId);
      if (!listing) return res.status(404).json({ error: "Listing not found" });
      res.json(listing);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/services/data/:listingId/purchase", async (req: Request, res: Response) => {
    try {
      const parsed = purchaseDataRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });

      const listing = await storage.getDataListing(req.params.listingId);
      if (!listing) return res.status(404).json({ error: "Listing not found" });
      if (!listing.isActive) return res.status(400).json({ error: "Listing is no longer active" });

      if (BigInt(listing.priceAmount) > 0n && !parsed.data.txHash) {
        return res.status(402).json({
          error: "Payment required",
          price: listing.priceAmount,
          currency: "BNB",
          payTo: "0x5Ff57464152c9285A8526a0665d996dA66e2def1",
          message: "Send payment on-chain, then retry with txHash and chainId",
          listingId: listing.id,
          listingName: listing.name,
        });
      }

      const platformFee = BigInt(listing.priceAmount) * BigInt(PLATFORM_FEES.DATA_SALE_FEE_BPS) / BigInt(10000);
      const sellerPayout = BigInt(listing.priceAmount) - platformFee;

      const purchase = await storage.createDataPurchase({
        listingId: listing.id,
        buyerWallet: parsed.data.buyerWallet.toLowerCase(),
        buyerAgentId: parsed.data.buyerAgentId,
        sellerAgentId: listing.agentId,
        amount: listing.priceAmount,
        platformFee: platformFee.toString(),
        status: "completed",
        txHash: parsed.data.txHash,
        chainId: parsed.data.chainId,
      });

      await storage.updateDataListingSales(listing.id, listing.priceAmount);

      const sellerWallet = await storage.getWallet(listing.agentId);
      if (sellerWallet) {
        const newBalance = (BigInt(sellerWallet.balance) + sellerPayout).toString();
        await storage.updateWalletBalance(listing.agentId, newBalance, sellerPayout.toString(), "0");
        await storage.createTransaction({
          agentId: listing.agentId,
          type: "data_sale",
          amount: sellerPayout.toString(),
          referenceType: "data",
          referenceId: listing.id,
          description: `Data sale: ${listing.name}`,
        });
      }

      await storage.recordPlatformRevenue({
        feeType: "data_sale",
        amount: platformFee.toString(),
        agentId: listing.agentId,
        referenceId: listing.id,
        description: `Data sale fee: ${listing.name}`,
        txHash: parsed.data.txHash,
        chainId: parsed.data.chainId,
      });

      res.json({
        purchase,
        contentHash: listing.contentHash,
        sampleData: listing.sampleData,
        message: "Purchase complete. Data access granted.",
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/data/agent/:agentId", async (req: Request, res: Response) => {
    try {
      const listings = await storage.getDataListingsByAgent(req.params.agentId);
      res.json(listings);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/services/data/purchases/:walletAddress", async (req: Request, res: Response) => {
    try {
      const purchases = await storage.getDataPurchasesByBuyer(req.params.walletAddress.toLowerCase());
      res.json(purchases);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // SERVICES OVERVIEW - Combined stats
  // ============================================================

  app.get("/api/services/stats", async (_req: Request, res: Response) => {
    try {
      const [bounties, dataListings, plans] = await Promise.all([
        storage.getOpenJobs(),
        storage.getDataListings(undefined, 1000),
        storage.getSubscriptionPlans(),
      ]);

      const providers = getProviderStatus();
      const liveProviders = Object.entries(providers).filter(([_, v]) => v.live).length;

      res.json({
        inferenceApi: {
          liveProviders,
          providers: Object.keys(providers),
          models: Object.values(providers).flatMap(p => p.models),
        },
        bountyBoard: {
          openBounties: bounties.filter(b => b.status === "open").length,
          totalBounties: bounties.length,
          totalBudget: bounties.reduce((sum, b) => sum + BigInt(b.budget), 0n).toString(),
        },
        dataMarketplace: {
          totalListings: dataListings.length,
          activeListings: dataListings.filter(d => d.isActive).length,
          totalSales: dataListings.reduce((sum, d) => sum + d.totalSales, 0),
        },
        subscriptions: {
          availablePlans: plans.length,
          tiers: SUBSCRIPTION_TIERS,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

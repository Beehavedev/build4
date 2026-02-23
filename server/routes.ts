import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { ZERC20_CONTRACTS, SUPPORTED_PRIVACY_CHAINS } from "@shared/schema";
import { registerWeb4Routes } from "./web4-routes";
import { registerServicesRoutes } from "./services-routes";
import { preparePrivacyTransfer, generateProof, getProof, verifyCommitment } from "./zerc20-sdk";
import { startBountyEngine } from "./bounty-engine";
import { startTwitterAgent, stopTwitterAgent, getTwitterAgentStatus, runTwitterAgentCycle, postBountyTweet } from "./twitter-agent";
import { isTwitterConfigured } from "./twitter-client";
import { visitorTrackingMiddleware } from "./visitor-tracking";
import crypto from "crypto";

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

function getTokenSecret(): string {
  return process.env.SESSION_SECRET || process.env.ANALYTICS_PASSWORD || "build4-analytics-fallback";
}

function generateAnalyticsToken(): string {
  const expiry = Date.now() + TOKEN_EXPIRY_MS;
  const payload = `analytics:${expiry}`;
  const hmac = crypto.createHmac("sha256", getTokenSecret()).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ exp: expiry, sig: hmac })).toString("base64");
}

function isValidToken(token: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    if (!decoded.exp || !decoded.sig) return false;
    if (Date.now() > decoded.exp) return false;
    const payload = `analytics:${decoded.exp}`;
    const expected = crypto.createHmac("sha256", getTokenSecret()).update(payload).digest("hex");
    return constantTimeCompare(decoded.sig, expected);
  } catch {
    return false;
  }
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

function analyticsAuth(req: Request, res: Response, next: NextFunction) {
  const adminPassword = process.env.ANALYTICS_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Analytics password not configured" });
    return;
  }
  const token = req.headers["x-analytics-token"] as string;
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(visitorTrackingMiddleware());

  registerWeb4Routes(app);
  registerServicesRoutes(app);

  app.post("/api/analytics/auth", (req: Request, res: Response) => {
    const adminPassword = process.env.ANALYTICS_PASSWORD;
    if (!adminPassword) {
      res.status(503).json({ error: "Analytics password not configured" });
      return;
    }
    const { password } = req.body || {};
    if (!password || typeof password !== "string" || !constantTimeCompare(password, adminPassword)) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }
    const token = generateAnalyticsToken();
    res.json({ token });
  });

  app.get("/api/analytics/stats", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const period = (req.query.period as string) || "24h";
      let since: Date | undefined;
      const now = new Date();
      if (period === "1h") since = new Date(now.getTime() - 60 * 60 * 1000);
      else if (period === "24h") since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      else if (period === "7d") since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "30d") since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const stats = await storage.getVisitorStats(since);
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/analytics/logs", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = await storage.getVisitorLogs(Math.min(limit, 500));
      const redacted = logs.map(log => ({
        ...log,
        ip: log.ip ? log.ip.replace(/\d+$/, "***") : null,
        fingerprint: undefined,
        walletAddress: log.walletAddress ? log.walletAddress.slice(0, 10) + "..." : null,
      }));
      res.json(redacted);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/analytics/live", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      const now = new Date();
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const stats = await storage.getVisitorStats(fiveMinAgo);
      res.json({
        activeVisitors: stats.uniqueIps,
        humans: stats.humans,
        agents: stats.agents,
        unknown: stats.unknown,
        recentPaths: stats.topPaths.slice(0, 5),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });


  app.get("/api/privacy/config", (_req: Request, res: Response) => {
    res.json({ contracts: ZERC20_CONTRACTS, chains: SUPPORTED_PRIVACY_CHAINS });
  });

  app.post("/api/privacy/prepare", async (req: Request, res: Response) => {
    try {
      const { recipientAddress, chainId, tokenSymbol, amount } = req.body;
      if (!recipientAddress || !chainId || !tokenSymbol || !amount) {
        res.status(400).json({ error: "Missing required fields: recipientAddress, chainId, tokenSymbol, amount" });
        return;
      }
      const prepared = await preparePrivacyTransfer({
        recipientAddress,
        chainId: Number(chainId),
        tokenSymbol,
        amount: String(amount),
      });
      res.json(prepared);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/privacy/transfers", async (req: Request, res: Response) => {
    try {
      const { agentId, chainId, tokenSymbol, tokenAddress, recipientAddress, amount, walletAddress } = req.body;
      if (!agentId || !chainId || !tokenSymbol || !tokenAddress || !recipientAddress || !amount) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
        res.status(400).json({ error: "Invalid recipient address" });
        return;
      }
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        res.status(400).json({ error: "Invalid amount" });
        return;
      }
      const agent = await storage.getAgent(agentId);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (walletAddress && agent.creatorWallet?.toLowerCase() !== walletAddress.toLowerCase()) {
        res.status(403).json({ error: "Not authorized for this agent" });
        return;
      }
      const prepared = await preparePrivacyTransfer({
        recipientAddress,
        chainId: Number(chainId),
        tokenSymbol,
        amount: String(amount),
      });
      const transfer = await storage.createPrivacyTransfer({
        agentId,
        chainId: Number(chainId),
        tokenSymbol,
        tokenAddress,
        burnAddress: prepared.burnAddress,
        recipientAddress,
        amount: String(amount),
        status: "pending",
        secretHint: prepared.commitmentHash,
        depositTxHash: null,
        withdrawalTxHash: null,
        proofId: null,
        errorMessage: null,
      });
      res.json({
        ...transfer,
        secret: prepared.secret,
        commitment: prepared.commitmentHash,
        nullifier: prepared.nullifierHash,
        burnAddress: prepared.burnAddress,
        verifierAddress: prepared.verifierAddress,
        hubAddress: prepared.hubAddress,
        _securityNote: "Store the secret securely on your device. It will not be stored on the server and cannot be recovered.",
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/privacy/transfer/:id/prove", async (req: Request, res: Response) => {
    try {
      const { secret } = req.body;
      const transfer = await storage.getPrivacyTransfer(req.params.id);
      if (!transfer) {
        res.status(404).json({ error: "Transfer not found" });
        return;
      }
      if (transfer.status !== "deposited" && transfer.status !== "pending") {
        res.status(400).json({ error: `Cannot generate proof for transfer in '${transfer.status}' status` });
        return;
      }
      if (!secret) {
        res.status(400).json({ error: "Secret is required for proof generation. Provide the secret you received when creating the transfer." });
        return;
      }
      await storage.updatePrivacyTransferStatus(req.params.id, "proving");
      const proofResult = await generateProof(
        req.params.id,
        transfer.recipientAddress,
        secret,
        transfer.chainId,
        transfer.amount,
        transfer.tokenSymbol
      );
      if (proofResult.status === "generated") {
        const updated = await storage.updatePrivacyTransferStatus(
          req.params.id, "completed", undefined, proofResult.proofId
        );
        res.json({ transfer: updated, proof: proofResult });
      } else {
        await storage.updatePrivacyTransferStatus(
          req.params.id, "failed", undefined, undefined, proofResult.error
        );
        res.status(500).json({ error: proofResult.error, proof: proofResult });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/privacy/proof/:proofId", (req: Request, res: Response) => {
    const proof = getProof(req.params.proofId);
    if (!proof) {
      res.status(404).json({ error: "Proof not found" });
      return;
    }
    res.json(proof);
  });

  app.post("/api/privacy/verify", async (req: Request, res: Response) => {
    try {
      const { recipientAddress, secret, chainId, burnAddress } = req.body;
      if (!recipientAddress || !secret || !chainId || !burnAddress) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }
      const result = await verifyCommitment(recipientAddress, secret, Number(chainId), burnAddress);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/privacy/transfers/:agentId", async (req: Request, res: Response) => {
    try {
      const walletAddress = req.query.wallet as string;
      if (walletAddress) {
        const agent = await storage.getAgent(req.params.agentId);
        if (!agent || agent.creatorWallet?.toLowerCase() !== walletAddress.toLowerCase()) {
          res.status(403).json({ error: "Not authorized" });
          return;
        }
      }
      const transfers = await storage.getPrivacyTransfers(req.params.agentId);
      res.json(transfers);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/privacy/transfer/:id", async (req: Request, res: Response) => {
    try {
      const transfer = await storage.getPrivacyTransfer(req.params.id);
      if (!transfer) {
        res.status(404).json({ error: "Transfer not found" });
        return;
      }
      res.json(transfer);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/privacy/transfer/:id", async (req: Request, res: Response) => {
    try {
      const { status, depositTxHash, withdrawalTxHash, proofId, errorMessage, walletAddress } = req.body;
      if (!status) {
        res.status(400).json({ error: "Status required" });
        return;
      }
      const validStatuses = ["pending", "deposited", "proving", "completed", "withdrawn", "failed"];
      if (!validStatuses.includes(status)) {
        res.status(400).json({ error: "Invalid status" });
        return;
      }
      const existing = await storage.getPrivacyTransfer(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Transfer not found" });
        return;
      }
      if (walletAddress) {
        const agent = await storage.getAgent(existing.agentId);
        if (!agent || agent.creatorWallet?.toLowerCase() !== walletAddress.toLowerCase()) {
          res.status(403).json({ error: "Not authorized" });
          return;
        }
      }
      const transfer = await storage.updatePrivacyTransferStatus(
        req.params.id, status, depositTxHash || withdrawalTxHash, proofId, errorMessage
      );
      if (withdrawalTxHash && transfer) {
        await storage.updatePrivacyTransferStatus(req.params.id, status, undefined, undefined, undefined);
        const updated = await storage.getPrivacyTransfer(req.params.id);
        if (updated) {
          res.json(updated);
          return;
        }
      }
      res.json(transfer);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/twitter/status", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      const status = await getTwitterAgentStatus();
      res.json(status);
    } catch (e: any) {
      res.json({ configured: isTwitterConfigured(), enabled: false, running: false, error: e.message });
    }
  });

  app.get("/api/twitter/config", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      const config = await storage.getTwitterAgentConfig();
      res.json(config || { id: "default", enabled: 0, pollingIntervalMs: 300000, minVerificationScore: 60, maxPayoutBnb: "0.015", defaultBountyBudget: "0.015", maxWinnersPerBounty: 3, agentId: null });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/twitter/config", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const config = await storage.upsertTwitterAgentConfig(req.body);
      if (config.enabled === 1) {
        await startTwitterAgent();
      } else {
        stopTwitterAgent();
      }
      res.json(config);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/twitter/run-cycle", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      if (!isTwitterConfigured()) {
        res.status(400).json({ error: "Twitter API not configured" });
        return;
      }
      await runTwitterAgentCycle();
      res.json({ success: true, message: "Cycle completed" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/twitter/post-bounty", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const { jobId, taskDescription, rewardBnb, maxWinners } = req.body;
      if (!taskDescription) {
        res.status(400).json({ error: "Task description required" });
        return;
      }
      const config = await storage.getTwitterAgentConfig();
      const reward = rewardBnb || config?.defaultBountyBudget || "0.015";
      const winners = Math.min(maxWinners || config?.maxWinnersPerBounty || 3, 3);
      const result = await postBountyTweet(
        jobId || `manual-${Date.now()}`,
        taskDescription,
        reward,
        winners
      );
      res.json(result);
    } catch (e: any) {
      console.error("[TwitterAgent] Post bounty failed:", e.message, e.data ? JSON.stringify(e.data) : "");
      const msg = e.data?.detail || e.data?.errors?.[0]?.message || e.message;
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/twitter/bounties", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      const bounties = await storage.getTwitterBounties();
      res.json(bounties);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/twitter/bounties/:id/submissions", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const submissions = await storage.getTwitterSubmissions(req.params.id);
      res.json(submissions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/twitter/start", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      await storage.upsertTwitterAgentConfig({ enabled: 1 });
      await startTwitterAgent();
      res.json({ success: true, message: "Twitter agent started" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/twitter/stop", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      await storage.upsertTwitterAgentConfig({ enabled: 0 });
      stopTwitterAgent();
      res.json({ success: true, message: "Twitter agent stopped" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  await storage.cleanFakeData();
  await storage.seedInferenceProviders();
  await storage.seedSubscriptionPlans();

  startBountyEngine().catch(err => {
    console.error("[BountyEngine] Failed to start:", err.message);
  });

  if (isTwitterConfigured()) {
    startTwitterAgent().catch(err => {
      console.error("[TwitterAgent] Failed to start:", err.message);
    });
  }

  return httpServer;
}

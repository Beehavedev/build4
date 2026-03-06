import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import { createServer, type Server } from "http";
import path from "path";
import { storage } from "./storage";
import { ZERC20_CONTRACTS, SUPPORTED_PRIVACY_CHAINS } from "@shared/schema";
import { registerWeb4Routes } from "./web4-routes";
import { registerServicesRoutes } from "./services-routes";
import { preparePrivacyTransfer, generateProof, getProof, verifyCommitment } from "./zerc20-sdk";
import { startBountyEngine } from "./bounty-engine";
import { startTwitterAgent, stopTwitterAgent, getTwitterAgentStatus, runTwitterAgentCycle, postBountyTweet, generateBountyTweetText } from "./twitter-agent";
import { startSupportAgent, stopSupportAgent, getSupportAgentStatus, runSupportAgentCycle } from "./twitter-support-agent";
import { isTwitterConfigured } from "./twitter-client";
import { startTelegramBot, stopTelegramBot, getTelegramBotStatus } from "./telegram-bot";
import { autoStartAllAgents } from "./multi-twitter-agent";
import { visitorTrackingMiddleware } from "./visitor-tracking";
import { registerSeoPrerender } from "./seo-prerender";
import { analyticsAuth, generateAnalyticsToken, constantTimeCompare } from "./admin-auth";
import { launchToken, getTokenLaunches, getTokenLaunch, fourMemeGetTokenInfo, fourMemeEstimateBuy, fourMemeEstimateSell, fourMemeBuyToken, fourMemeSellToken, fourMemeGetTokenBalance } from "./token-launcher";
import { TOKEN_LAUNCHPADS } from "@shared/schema";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(visitorTrackingMiddleware());
  app.use("/uploads", express.static(path.resolve(process.cwd(), "public/uploads")));
  registerSeoPrerender(app);

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
      res.json(config || { id: "default", enabled: 0, pollingIntervalMs: 30000, minVerificationScore: 60, maxPayoutBnb: "0.02", defaultBountyBudget: "0.02", maxWinnersPerBounty: 10, agentId: null });
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

  app.post("/api/twitter/preview-bounty", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const { taskDescription, rewardBnb, maxWinners, customTweetText } = req.body;
      if (!taskDescription && !customTweetText) {
        res.status(400).json({ error: "Task description or custom tweet text required" });
        return;
      }
      const config = await storage.getTwitterAgentConfig();
      const reward = rewardBnb || config?.defaultBountyBudget || "0.02";
      const winners = Math.min(maxWinners || config?.maxWinnersPerBounty || 10, 100);
      const tweetText = generateBountyTweetText(taskDescription || "", reward, winners, customTweetText);
      res.json({ tweetText, charCount: tweetText.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/twitter/post-bounty", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const { jobId, taskDescription, rewardBnb, maxWinners, customTweetText } = req.body;
      if (!taskDescription && !customTweetText) {
        res.status(400).json({ error: "Task description or custom tweet text required" });
        return;
      }
      const config = await storage.getTwitterAgentConfig();
      const reward = rewardBnb || config?.defaultBountyBudget || "0.02";
      const winners = Math.min(maxWinners || config?.maxWinnersPerBounty || 10, 100);
      const result = await postBountyTweet(
        jobId || `manual-${Date.now()}`,
        taskDescription || "",
        reward,
        winners,
        customTweetText
      );
      res.json(result);
    } catch (e: any) {
      console.error("[TwitterAgent] Post bounty failed:", e.message, e.data ? JSON.stringify(e.data) : "");
      const msg = e.data?.detail || e.data?.errors?.[0]?.message || e.message;
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/twitter/register-bounty", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const { tweetId, tweetUrl, tweetText, rewardBnb, maxWinners } = req.body;
      if (!tweetId) { res.status(400).json({ error: "tweetId required" }); return; }
      const bounty = await storage.createTwitterBounty({
        jobId: `manual-${Date.now()}`,
        tweetId,
        tweetUrl: tweetUrl || `https://x.com/Build4ai/status/${tweetId}`,
        tweetText: tweetText || "",
        rewardBnb: rewardBnb || "0.015",
        maxWinners: maxWinners || 10,
        winnersCount: 0,
        status: "posted",
      });
      res.json(bounty);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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

  app.get("/api/twitter/personality", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      const personality = await storage.getTwitterPersonality();
      const recentReplies = await storage.getRecentTwitterReplies(20);
      res.json({ personality: personality || null, recentReplies });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/support/status", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      const status = await getSupportAgentStatus();
      res.json(status);
    } catch (e: any) {
      res.json({ configured: isTwitterConfigured(), enabled: false, running: false, error: e.message });
    }
  });

  app.get("/api/support/config", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      const config = await storage.getSupportAgentConfig();
      res.json(config || { id: "default", enabled: 0, pollingIntervalMs: 120000 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/support/config", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const config = await storage.upsertSupportAgentConfig(req.body);
      if (config.enabled === 1) {
        await startSupportAgent();
      } else {
        stopSupportAgent();
      }
      res.json(config);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/support/start", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      await storage.upsertSupportAgentConfig({ enabled: 1 });
      await startSupportAgent();
      res.json({ success: true, message: "Support agent started" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/support/stop", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      await storage.upsertSupportAgentConfig({ enabled: 0 });
      stopSupportAgent();
      res.json({ success: true, message: "Support agent stopped" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/support/run-cycle", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      if (!isTwitterConfigured()) {
        res.status(400).json({ error: "Twitter API not configured" });
        return;
      }
      await runSupportAgentCycle();
      res.json({ success: true, message: "Support cycle completed" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/support/tickets", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const status = req.query.status as string | undefined;
      const tickets = await storage.getSupportTickets(status);
      res.json(tickets);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/support/tickets/:id", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const ticket = await storage.getSupportTicket(req.params.id);
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      res.json(ticket);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/support/tickets/:id", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const { status, resolution } = req.body;
      const update: any = {};
      if (status) update.status = status;
      if (resolution) update.resolution = resolution;
      if (status === "resolved") update.resolvedAt = new Date();
      const ticket = await storage.updateSupportTicket(req.params.id, update);
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      res.json(ticket);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  storage.seedInferenceProviders().catch(() => {});
  storage.seedSubscriptionPlans().catch(() => {});
  setTimeout(() => storage.cleanFakeData().catch(() => {}), 15000);

  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log("[dev] Skipping background agents in development to save memory. They run in production.");
  } else {
    setTimeout(() => {
      if (process.env.TELEGRAM_BOT_TOKEN) {
        startTelegramBot();
      }
    }, 2000);

    setTimeout(() => {
      startBountyEngine().catch(err => {
        console.error("[BountyEngine] Failed to start:", err.message);
      });
    }, 5000);

    setTimeout(() => {
      if (isTwitterConfigured()) {
        startTwitterAgent().catch(err => {
          console.error("[TwitterAgent] Failed to start:", err.message);
        });
      }
    }, 8000);

    setTimeout(() => {
      if (isTwitterConfigured()) {
        startSupportAgent().catch(err => {
          console.error("[SupportAgent] Failed to start:", err.message);
        });
      }
    }, 10000);

    setTimeout(() => {
      autoStartAllAgents().catch(err => {
        console.error("[MultiTwitter] Auto-start failed:", err.message);
      });
    }, 12000);

    setTimeout(async () => {
      try {
        const { restoreTradingPreferences, startTradingAgent, isTradingAgentRunning } = await import("./trading-agent");
        const { getBotInstance } = await import("./telegram-bot");
        const restored = await restoreTradingPreferences();
        if (restored > 0 && !isTradingAgentRunning()) {
          startTradingAgent((cid, msg) => {
            getBotInstance()?.sendMessage(cid, msg).catch(() => {});
          });
          console.log(`[TradingAgent] Auto-started on boot — ${restored} users restored`);
        } else if (restored === 0) {
          console.log("[TradingAgent] No enabled users to restore — agent idle until user enables");
        }
      } catch (err: any) {
        console.error("[TradingAgent] Auto-start failed:", err.message);
      }
    }, 15000);
  }

  app.get("/api/telegram/status", analyticsAuth, (req: Request, res: Response) => {
    res.json(getTelegramBotStatus());
  });

  app.post("/api/telegram/start", analyticsAuth, (req: Request, res: Response) => {
    startTelegramBot();
    res.json({ success: true, message: "Telegram bot started" });
  });

  app.post("/api/telegram/stop", analyticsAuth, (req: Request, res: Response) => {
    stopTelegramBot();
    res.json({ success: true, message: "Telegram bot stopped" });
  });

  app.get("/api/token-launcher/platforms", (req: Request, res: Response) => {
    res.json(TOKEN_LAUNCHPADS);
  });

  app.get("/api/token-launcher/launches", async (req: Request, res: Response) => {
    const agentId = req.query.agentId as string | undefined;
    const launches = await getTokenLaunches(agentId);
    res.json(launches);
  });

  app.get("/api/token-launcher/launches/:id", async (req: Request, res: Response) => {
    const launch = await getTokenLaunch(req.params.id);
    if (!launch) return res.status(404).json({ error: "Launch not found" });
    res.json(launch);
  });

  app.post("/api/token-launcher/launch", analyticsAuth, async (req: Request, res: Response) => {
    const { tokenName, tokenSymbol, tokenDescription, imageUrl, platform, initialLiquidityBnb, agentId, creatorWallet } = req.body;

    if (!tokenName || !tokenSymbol || !platform) {
      return res.status(400).json({ error: "tokenName, tokenSymbol, and platform are required" });
    }

    if (typeof tokenName !== "string" || tokenName.length < 1 || tokenName.length > 50) {
      return res.status(400).json({ error: "Token name must be 1-50 characters" });
    }

    if (typeof tokenSymbol !== "string" || tokenSymbol.length < 1 || tokenSymbol.length > 10 || !/^[A-Z0-9]+$/.test(tokenSymbol)) {
      return res.status(400).json({ error: "Token symbol must be 1-10 uppercase alphanumeric characters" });
    }

    const validPlatforms = TOKEN_LAUNCHPADS.map(p => p.id);
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ error: `Invalid platform. Must be one of: ${validPlatforms.join(", ")}` });
    }

    if (initialLiquidityBnb) {
      const liq = parseFloat(initialLiquidityBnb);
      if (isNaN(liq) || liq < 0.001 || liq > 10) {
        return res.status(400).json({ error: "Initial liquidity must be between 0.001 and 10" });
      }
    }

    if (tokenDescription && tokenDescription.length > 500) {
      return res.status(400).json({ error: "Description must be 500 characters or less" });
    }

    const result = await launchToken({
      tokenName: tokenName.trim(),
      tokenSymbol: tokenSymbol.trim(),
      tokenDescription: (tokenDescription || `${tokenName} - launched by an autonomous AI agent on BUILD4`).substring(0, 500),
      imageUrl: imageUrl?.substring(0, 500),
      platform,
      initialLiquidityBnb: initialLiquidityBnb || (platform === "four_meme" ? "0" : "0.001"),
      agentId,
      creatorWallet,
    });

    res.json(result);
  });

  app.get("/api/four-meme/token/:address", async (req: Request, res: Response) => {
    try {
      const info = await fourMemeGetTokenInfo(req.params.address);
      res.json(info);
    } catch (e: any) {
      res.status(400).json({ error: e.message?.substring(0, 200) || "Failed to get token info" });
    }
  });

  app.get("/api/four-meme/estimate-buy", async (req: Request, res: Response) => {
    const { token, bnbAmount } = req.query;
    if (!token || !bnbAmount) return res.status(400).json({ error: "token and bnbAmount required" });
    try {
      const estimate = await fourMemeEstimateBuy(token as string, bnbAmount as string);
      res.json(estimate);
    } catch (e: any) {
      res.status(400).json({ error: e.message?.substring(0, 200) || "Failed to estimate buy" });
    }
  });

  app.get("/api/four-meme/estimate-sell", async (req: Request, res: Response) => {
    const { token, amount } = req.query;
    if (!token || !amount) return res.status(400).json({ error: "token and amount required" });
    try {
      const estimate = await fourMemeEstimateSell(token as string, amount as string);
      res.json(estimate);
    } catch (e: any) {
      res.status(400).json({ error: e.message?.substring(0, 200) || "Failed to estimate sell" });
    }
  });

  app.get("/api/four-meme/balance", async (req: Request, res: Response) => {
    const { token, wallet } = req.query;
    if (!token || !wallet) return res.status(400).json({ error: "token and wallet required" });
    try {
      const balance = await fourMemeGetTokenBalance(token as string, wallet as string);
      res.json(balance);
    } catch (e: any) {
      res.status(400).json({ error: e.message?.substring(0, 200) || "Failed to get balance" });
    }
  });

  app.get("/api/chaos/status", async (_req: Request, res: Response) => {
    const { getChaosStatus } = await import("./chaos-launch");
    const status = await getChaosStatus();
    res.json(status);
  });

  app.get("/api/chaos/plan", async (_req: Request, res: Response) => {
    const { getMilestonePlan } = await import("./chaos-launch");
    res.json(getMilestonePlan());
  });

  app.post("/api/chaos/launch", analyticsAuth, async (req: Request, res: Response) => {
    const { initiateChaosLaunch } = await import("./chaos-launch");
    const { agentId } = req.body || {};
    const result = await initiateChaosLaunch(agentId);
    res.json(result);
  });

  app.post("/api/chaos/execute-next", analyticsAuth, async (req: Request, res: Response) => {
    const force = req.query.force === "true" || req.body?.force === true;
    if (force) {
      const { forceExecuteNextMilestone } = await import("./chaos-launch");
      const result = await forceExecuteNextMilestone();
      res.json(result);
    } else {
      const { checkAndExecuteMilestones } = await import("./chaos-launch");
      await checkAndExecuteMilestones();
      const { getChaosStatus } = await import("./chaos-launch");
      const status = await getChaosStatus();
      res.json(status);
    }
  });

  app.post("/api/chaos/confession", analyticsAuth, async (_req: Request, res: Response) => {
    const { executeConfessionTweet } = await import("./chaos-launch");
    const result = await executeConfessionTweet();
    res.json(result);
  });

  app.get("/api/trading/status", analyticsAuth, async (_req: Request, res: Response) => {
    const { getAllActivePositions, isTradingAgentRunning } = await import("./trading-agent");
    res.json({
      running: isTradingAgentRunning(),
      activePositions: getAllActivePositions().length,
      positions: getAllActivePositions(),
    });
  });

  return httpServer;
}

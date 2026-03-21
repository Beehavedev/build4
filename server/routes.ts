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
import { startTelegramBot, stopTelegramBot, getTelegramBotStatus, processWebhookUpdate } from "./telegram-bot";
import { getPerformanceSnapshot, recordRequest } from "./performance-monitor";
import { getQueueStats } from "./task-queue";
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
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      recordRequest(req.path, req.method, res.statusCode, Date.now() - start);
    });
    next();
  });

  app.use(visitorTrackingMiddleware());
  app.use("/uploads", express.static(path.resolve(process.cwd(), "public/uploads")));
  registerSeoPrerender(app);

  app.post("/api/telegram/webhook/:token", express.json(), (req: Request, res: Response) => {
    const token = req.params.token;
    if (token !== process.env.TELEGRAM_BOT_TOKEN) {
      res.sendStatus(403);
      return;
    }
    res.sendStatus(200);
    processWebhookUpdate(req.body);
  });

  app.get("/api/system/health", (req: Request, res: Response) => {
    const perf = getPerformanceSnapshot();
    const queue = getQueueStats();
    const telegramStatus = getTelegramBotStatus();

    res.json({
      status: "ok",
      timestamp: Date.now(),
      uptime: perf.uptime,
      memory: perf.memoryMB,
      requests: perf.requests,
      telegram: { ...perf.telegram, running: telegramStatus.running },
      trading: perf.trading,
      taskQueue: queue,
    });
  });

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
    if (process.env.TELEGRAM_BOT_EXTERNAL === "true") {
      console.log("[TelegramBot] Bot running externally (Render) — skipping local startup");
    } else {
      setTimeout(() => {
        if (process.env.TELEGRAM_BOT_TOKEN) {
          const webhookBase = process.env.TELEGRAM_WEBHOOK_URL || undefined;
          startTelegramBot(webhookBase);
        }
      }, 2000);
    }

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

    if (process.env.TELEGRAM_BOT_EXTERNAL !== "true") {
      setTimeout(async () => {
        try {
          const { restoreTradingPreferences, startTradingAgent, isTradingAgentRunning } = await import("./trading-agent");
          const { getBotInstance } = await import("./telegram-bot");

          const notifyFn = (cid: number, msg: string) => {
            getBotInstance()?.sendMessage(cid, msg).catch(() => {});
          };

          if (!isTradingAgentRunning()) {
            startTradingAgent(notifyFn);
            console.log("[TradingAgent] Agent started on boot");
          }

          let restored = 0;
          for (let attempt = 1; attempt <= 5; attempt++) {
            try {
              restored = await restoreTradingPreferences();
              console.log(`[TradingAgent] Restored ${restored} user preferences (attempt ${attempt})`);
              break;
            } catch (dbErr: any) {
              console.error(`[TradingAgent] Preference restore attempt ${attempt}/5 failed: ${dbErr.message?.substring(0, 80)}`);
              if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 5000));
            }
          }

          if (restored === 0) {
            console.log("[TradingAgent] No enabled users restored — agent running, will pick up users via Telegram");
          }
        } catch (err: any) {
          console.error("[TradingAgent] Auto-start failed:", err.message);
        }
      }, 15000);
    } else {
      console.log("[TradingAgent] Trading agent running externally with bot — skipping local startup");
    }
  }

  app.get("/api/telegram/status", analyticsAuth, (req: Request, res: Response) => {
    res.json(getTelegramBotStatus());
  });

  app.post("/api/telegram/start", analyticsAuth, (req: Request, res: Response) => {
    const webhookBase = process.env.TELEGRAM_WEBHOOK_URL || undefined;
    startTelegramBot(webhookBase);
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

  app.get("/api/workspace/plan/:wallet", async (req: Request, res: Response) => {
    try {
      const wallet = req.params.wallet.toLowerCase();
      const { workspaceSubscriptions, WORKSPACE_PLANS } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const { db } = await import("./db");
      const [sub] = await db.select().from(workspaceSubscriptions).where(eq(workspaceSubscriptions.walletAddress, wallet)).limit(1);

      if (!sub) {
        const plan = WORKSPACE_PLANS.free;
        res.json({
          plan: "free",
          ...plan,
          agentsCreated: 0,
          deploysThisMonth: 0,
          inferenceUsed: 0,
        });
        return;
      }

      const planKey = sub.plan as keyof typeof WORKSPACE_PLANS;
      const plan = WORKSPACE_PLANS[planKey] || WORKSPACE_PLANS.free;
      res.json({
        plan: sub.plan,
        ...plan,
        agentsCreated: sub.agentsCreated,
        deploysThisMonth: sub.deploysThisMonth,
        inferenceUsed: sub.inferenceUsed,
        paymentTxHash: sub.paymentTxHash,
        currentPeriodEnd: sub.currentPeriodEnd,
      });
    } catch (error: any) {
      console.error("[Workspace Plan] Error:", error.message);
      res.status(500).json({ error: "Failed to fetch plan" });
    }
  });

  app.post("/api/workspace/upgrade", async (req: Request, res: Response) => {
    try {
      const { walletAddress, plan, txHash } = req.body;
      if (!walletAddress || !plan || !txHash) {
        res.status(400).json({ error: "walletAddress, plan, and txHash required" });
        return;
      }

      const { WORKSPACE_PLANS, workspaceSubscriptions } = await import("@shared/schema");
      const planConfig = WORKSPACE_PLANS[plan as keyof typeof WORKSPACE_PLANS];
      if (!planConfig || plan === "free") {
        res.status(400).json({ error: "Invalid plan" });
        return;
      }

      const { verifyPaymentTransaction, getRevenueWalletAddress } = await import("./onchain");
      const verification = await verifyPaymentTransaction(txHash, planConfig.price);

      if (!verification.verified) {
        res.status(400).json({ error: `Payment not verified: ${verification.error || "Transaction invalid"}` });
        return;
      }

      if (verification.from && verification.from.toLowerCase() !== walletAddress.toLowerCase()) {
        res.status(400).json({ error: "Payment sender does not match wallet address" });
        return;
      }

      const wallet = walletAddress.toLowerCase();
      const { eq } = await import("drizzle-orm");
      const { db } = await import("./db");

      const [existingTx] = await db.select().from(workspaceSubscriptions)
        .where(eq(workspaceSubscriptions.paymentTxHash, txHash)).limit(1);
      if (existingTx) {
        res.status(400).json({ error: "This transaction has already been used for an upgrade" });
        return;
      }

      const periodEnd = new Date();
      periodEnd.setDate(periodEnd.getDate() + 30);

      const [existing] = await db.select().from(workspaceSubscriptions).where(eq(workspaceSubscriptions.walletAddress, wallet)).limit(1);

      if (existing) {
        await db.update(workspaceSubscriptions)
          .set({
            plan,
            paymentTxHash: txHash,
            status: "active",
            deploysThisMonth: 0,
            inferenceUsed: 0,
            currentPeriodStart: new Date(),
            currentPeriodEnd: periodEnd,
          })
          .where(eq(workspaceSubscriptions.walletAddress, wallet));
      } else {
        await db.insert(workspaceSubscriptions).values({
          walletAddress: wallet,
          plan,
          paymentTxHash: txHash,
          status: "active",
          currentPeriodStart: new Date(),
          currentPeriodEnd: periodEnd,
        });
      }

      res.json({ success: true, plan, expiresAt: periodEnd.toISOString() });
    } catch (error: any) {
      console.error("[Workspace Upgrade] Error:", error.message);
      res.status(500).json({ error: "Upgrade failed" });
    }
  });

  app.post("/api/workspace/usage", async (req: Request, res: Response) => {
    try {
      const { walletAddress, type } = req.body;
      if (!walletAddress || !type) {
        res.status(400).json({ error: "walletAddress and type required" });
        return;
      }

      const wallet = walletAddress.toLowerCase();
      const { workspaceSubscriptions, WORKSPACE_PLANS } = await import("@shared/schema");
      const { eq, sql: sqlFn } = await import("drizzle-orm");
      const { db } = await import("./db");

      const [sub] = await db.select().from(workspaceSubscriptions).where(eq(workspaceSubscriptions.walletAddress, wallet)).limit(1);

      const planKey = (sub?.plan || "free") as keyof typeof WORKSPACE_PLANS;
      const plan = WORKSPACE_PLANS[planKey];

      if (type === "deploy") {
        const current = sub?.deploysThisMonth || 0;
        if (plan.deploysPerMonth !== -1 && current >= plan.deploysPerMonth) {
          res.status(403).json({ error: "Deploy limit reached. Upgrade your plan.", needsUpgrade: true });
          return;
        }
        if (sub) {
          await db.update(workspaceSubscriptions)
            .set({ deploysThisMonth: current + 1 })
            .where(eq(workspaceSubscriptions.walletAddress, wallet));
        } else {
          await db.insert(workspaceSubscriptions).values({ walletAddress: wallet, deploysThisMonth: 1 });
        }
      } else if (type === "inference") {
        const current = sub?.inferenceUsed || 0;
        if (plan.inferenceCredits !== -1 && current >= plan.inferenceCredits) {
          res.status(403).json({ error: "AI credits exhausted. Upgrade your plan.", needsUpgrade: true });
          return;
        }
        if (sub) {
          await db.update(workspaceSubscriptions)
            .set({ inferenceUsed: current + 1 })
            .where(eq(workspaceSubscriptions.walletAddress, wallet));
        } else {
          await db.insert(workspaceSubscriptions).values({ walletAddress: wallet, inferenceUsed: 1 });
        }
      } else if (type === "agent") {
        const current = sub?.agentsCreated || 0;
        if (current >= plan.agentLimit) {
          res.status(403).json({ error: "Agent limit reached. Upgrade your plan.", needsUpgrade: true });
          return;
        }
        if (sub) {
          await db.update(workspaceSubscriptions)
            .set({ agentsCreated: current + 1 })
            .where(eq(workspaceSubscriptions.walletAddress, wallet));
        } else {
          await db.insert(workspaceSubscriptions).values({ walletAddress: wallet, agentsCreated: 1 });
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("[Workspace Usage] Error:", error.message);
      res.status(500).json({ error: "Failed to record usage" });
    }
  });

  const builderChatRateLimit = new Map<string, { count: number; resetAt: number }>();
  app.post("/api/builder/chat", async (req: Request, res: Response) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const now = Date.now();
      const limit = builderChatRateLimit.get(ip);
      if (limit && limit.resetAt > now) {
        if (limit.count >= 20) {
          res.status(429).json({ error: "Rate limited. Try again in a minute." });
          return;
        }
        limit.count++;
      } else {
        builderChatRateLimit.set(ip, { count: 1, resetAt: now + 60000 });
      }

      const { message, config } = req.body;
      if (!message || typeof message !== "string" || message.length > 2000) {
        res.status(400).json({ error: "message required (max 2000 chars)" });
        return;
      }

      const { runInferenceWithFallback, getAvailableProviders } = await import("./inference");
      const providers = getAvailableProviders();

      if (providers.length === 0) {
        res.json({
          response: null,
          fallback: true,
        });
        return;
      }

      const systemPrompt = `You are BUILD4 AI — a powerful AI development assistant. You can help users build ANYTHING: websites, apps, APIs, bots, scripts, AI agents, smart contracts, dashboards, games, tools — there are no limits to what you can create.

Current project config: ${JSON.stringify(config || {})}

BUILD4 specializes in:
- AI agents for crypto/DeFi (trading bots, snipers, security scanners, research agents)
- Web applications (React, Next.js, full-stack apps)
- APIs and backends (Express, FastAPI, serverless)
- Smart contracts (Solidity, on BNB Chain, Base, XLayer)
- Automation tools, bots, scrapers, dashboards
- Anything else the user can imagine

Available agent templates: trading, research, social, defi, security, sniper.
Available chains: BNB Chain (bnb), Base (base), XLayer (xlayer).
Available models: Llama 3.1 70B (llama), DeepSeek V3 (deepseek), Qwen 2.5 72B (qwen).

Your job:
1. NEVER say you can't do something. You can build anything.
2. Understand what the user wants and start building immediately
3. Give concise, actionable responses with code when appropriate
4. If the user wants an AI agent, use the agent templates and config system
5. If they want anything else (website, app, tool), help them build it
6. Be direct, confident, and technical — like a 10x engineer pair-programming
7. Always generate code, configs, and file structures. Show don't tell.

CRITICAL: For EVERY response, you MUST include a live preview of what you're building. After your text response, include a block wrapped in <PREVIEW> tags containing a complete, self-contained HTML document that visually represents what you're building. This renders in a live preview panel.

Rules for the preview:
- Must be a complete HTML document with inline CSS and JS
- Use modern, polished design (dark theme preferred, gradients, shadows, animations)
- Make it look like a real product — not a placeholder
- For agents: show a dashboard with stats, charts, status indicators
- For websites: show the actual website design with real layout, sections, content
- For apps: show the app UI with interactive elements
- For APIs: show an API documentation/playground interface
- For smart contracts: show a contract interaction panel
- Always include realistic placeholder content (not lorem ipsum — use real-sounding data)
- Use CSS animations and transitions to make it feel alive
- The preview should look professional enough to be a real product screenshot

Example format:
Your text response here explaining what you built...

<PREVIEW>
<!DOCTYPE html>
<html>...complete visual preview...</html>
</PREVIEW>

Respond in plain text before the preview block. Keep text under 200 words. Be specific and practical.`;

      const result = await runInferenceWithFallback(
        providers,
        undefined,
        message,
        { systemPrompt, temperature: 0.7 }
      );

      let responseText = result.text || "";
      let previewHtml = "";
      const previewMatch = responseText.match(/<PREVIEW>([\s\S]*?)<\/PREVIEW>/i);
      if (previewMatch) {
        previewHtml = previewMatch[1].trim();
        responseText = responseText.replace(/<PREVIEW>[\s\S]*?<\/PREVIEW>/i, "").trim();
      }

      res.json({
        response: responseText,
        preview: previewHtml || undefined,
        model: result.model,
        network: result.network,
        live: result.live,
        fallback: false,
      });
    } catch (error: any) {
      console.error("[Builder Chat] Error:", error.message);
      res.json({ response: null, fallback: true });
    }
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

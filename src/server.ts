import express from "express";
import { createServer } from "http";
import { PrismaClient } from "@prisma/client";
import { createBot, getWebhookCallback } from "./bot/index.js";
import { startAgentRunner } from "./agents/runner.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const prisma = new PrismaClient();
const app = express();
const httpServer = createServer(app);

app.use(express.json());

const PORT = parseInt(process.env.PORT || "5000", 10);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set!");
  process.exit(1);
}

const bot = createBot(BOT_TOKEN);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "v2.0.0",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

const webhookHandler = getWebhookCallback(bot);
app.post("/api/webhook", async (req, res) => {
  console.log("[WEBHOOK] Received update:", JSON.stringify(req.body).substring(0, 200));
  try {
    await webhookHandler(req, res);
  } catch (err: any) {
    console.error("[WEBHOOK] Handler error:", err.message, err.stack?.substring(0, 300));
    if (!res.headersSent) res.sendStatus(200);
  }
});

app.get("/api/user/:telegramId", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(req.params.telegramId) },
      include: { wallets: true, portfolio: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      ...user,
      telegramId: user.telegramId.toString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/agents/:userId", async (req, res) => {
  try {
    const agents = await prisma.agent.findMany({
      where: { userId: req.params.userId },
    });
    res.json(agents);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agents/:id/toggle", async (req, res) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const updated = await prisma.agent.update({
      where: { id: req.params.id },
      data: {
        isActive: !agent.isActive || agent.isPaused ? true : agent.isActive,
        isPaused: agent.isActive && !agent.isPaused,
      },
    });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/portfolio/:userId", async (req, res) => {
  try {
    const portfolio = await prisma.portfolio.findUnique({
      where: { userId: req.params.userId },
    });
    const trades = await prisma.trade.findMany({
      where: { userId: req.params.userId },
      orderBy: { openedAt: "desc" },
      take: 20,
    });
    res.json({ portfolio, trades });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/leaderboard", async (_req, res) => {
  try {
    const leaders = await prisma.portfolio.findMany({
      where: { totalPnl: { gt: 0 } },
      orderBy: { totalPnl: "desc" },
      take: 10,
      include: { user: { select: { username: true, telegramId: true } } },
    });
    res.json(leaders.map((l) => ({
      ...l,
      user: { ...l.user, telegramId: l.user.telegramId.toString() },
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/signals", (_req, res) => {
  res.json([
    { token: "BTC", type: "WHALE", strength: "HIGH", detail: "150 BTC moved to exchange" },
    { token: "ETH", type: "ACCUMULATION", strength: "MEDIUM", detail: "Smart money buying" },
  ]);
});

const miniAppPath = path.join(__dirname, "miniapp", "dist");
app.use("/app", express.static(miniAppPath));

async function seedQuests() {
  const count = await prisma.quest.count();
  if (count > 0) return;

  const quests = [
    { title: "First Trade", description: "Execute your first trade", reward: 50, type: "milestone", requirement: { action: "trade", count: 1 } },
    { title: "Signal Hunter", description: "Act on 3 whale signals", reward: 100, type: "weekly", requirement: { action: "signal_act", count: 3 } },
    { title: "Consistent Trader", description: "Trade 7 days in a row", reward: 200, type: "weekly", requirement: { action: "daily_trade", count: 7 } },
    { title: "Token Creator", description: "Launch a token", reward: 500, type: "milestone", requirement: { action: "launch", count: 1 } },
    { title: "Copy Leader", description: "Get 5 people copying you", reward: 300, type: "milestone", requirement: { action: "followers", count: 5 } },
    { title: "Safe Scanner", description: "Scan 10 contracts", reward: 75, type: "weekly", requirement: { action: "scan", count: 10 } },
    { title: "Agent Builder", description: "Create and run an agent for 7 days", reward: 250, type: "milestone", requirement: { action: "agent_days", count: 7 } },
  ];

  for (const q of quests) {
    await prisma.quest.create({ data: q });
  }
  console.log("[SEED] Created default quests");
}

async function start() {
  console.log("[SERVER] Starting Build4 Bot v2.0...");

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] HTTP server listening on port ${PORT}`);
  });

  try {
    await prisma.$connect();
    console.log("[SERVER] Database connected");
  } catch (err: any) {
    console.error("[SERVER] Database connection failed:", err.message);
  }

  await seedQuests();

  const webhookUrl = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/api/webhook`
    : process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/webhook`
      : null;

  if (webhookUrl) {
    try {
      await bot.api.setWebhook(webhookUrl);
      console.log(`[SERVER] Webhook set to: ${webhookUrl}`);
    } catch (err: any) {
      console.error("[SERVER] Failed to set webhook:", err.message);
    }
  } else {
    console.log("[SERVER] No webhook URL, starting long polling...");
    bot.start();
  }

  const sendMessage = async (chatId: string, text: string, opts?: any) => {
    await bot.api.sendMessage(chatId, text, opts);
  };
  startAgentRunner(sendMessage);

  console.log("[SERVER] Build4 Bot v2.0 ready!");
}

start().catch(console.error);

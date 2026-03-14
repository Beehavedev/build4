import express from "express";
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { startTelegramBot, processWebhookUpdate, stopTelegramBot } from "./telegram-bot";
import { restoreTradingPreferences, startTradingAgent, isTradingAgentRunning } from "./trading-agent";
import pg from "pg";

process.on("uncaughtException", (err) => {
  console.error("[BOT-SERVER] Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[BOT-SERVER] Unhandled rejection:", reason);
});
process.on("SIGTERM", () => {
  console.log("[BOT-SERVER] SIGTERM — shutting down");
  stopTelegramBot();
  process.exit(0);
});

function findSchemaSQL(): string {
  const candidates = [
    join(process.cwd(), "dist", "schema-init.sql"),
    join(process.cwd(), "server", "schema-init.sql"),
    join(__dirname, "schema-init.sql"),
    join(__dirname, "..", "server", "schema-init.sql"),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf-8");
    } catch {}
  }
  return "";
}

async function ensureSchema() {
  if (!process.env.DATABASE_URL) return;
  const sql = findSchemaSQL();
  if (!sql) {
    console.warn("[BOT-SERVER] schema-init.sql not found — skipping auto-migration");
    return;
  }
  console.log("[BOT-SERVER] Ensuring database schema exists...");
  const isSSL = process.env.DATABASE_URL.includes("render.com") ||
    process.env.DATABASE_URL.includes("neon.tech") ||
    process.env.RENDER === "true";
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isSSL ? { rejectUnauthorized: false } : false,
  });
  try {
    await pool.query(sql);
    console.log("[BOT-SERVER] Database schema ensured — all tables created");
  } catch (e: any) {
    console.warn("[BOT-SERVER] Schema setup warning:", e.message?.substring(0, 200));
  } finally {
    await pool.end();
  }
}

const app = express();
const httpServer = createServer(app);

app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).send("BUILD4 Bot Server OK");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: Date.now() });
});

app.post("/api/telegram/webhook/:token", (req, res) => {
  const token = req.params.token;
  if (token !== process.env.TELEGRAM_BOT_TOKEN) {
    res.sendStatus(403);
    return;
  }
  res.sendStatus(200);
  processWebhookUpdate(req.body);
});

(async () => {
  await ensureSchema();

  const port = parseInt(process.env.PORT || "3000", 10);
  httpServer.listen({ port, host: "0.0.0.0" }, () => {
    console.log(`[BOT-SERVER] Listening on port ${port}`);

    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
    if (!webhookUrl) {
      console.error("[BOT-SERVER] No TELEGRAM_WEBHOOK_URL or RENDER_EXTERNAL_URL set — bot may not receive updates");
    }

    setTimeout(() => {
      startTelegramBot(webhookUrl).then(() => {
        console.log("[BOT-SERVER] Telegram bot started");
      }).catch((err) => {
        console.error("[BOT-SERVER] Telegram bot failed to start:", err.message);
      });
    }, 1000);

    setTimeout(async () => {
      try {
        const { getBotInstance } = await import("./telegram-bot");
        const notifyFn = (cid: number, msg: string) => {
          getBotInstance()?.sendMessage(cid, msg).catch(() => {});
        };

        if (!isTradingAgentRunning()) {
          startTradingAgent(notifyFn);
          console.log("[BOT-SERVER] Trading agent started");
        }

        let restored = 0;
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            restored = await restoreTradingPreferences();
            console.log(`[BOT-SERVER] Restored ${restored} trading preferences (attempt ${attempt})`);
            break;
          } catch (e: any) {
            console.error(`[BOT-SERVER] Preference restore attempt ${attempt}/5 failed: ${e.message?.substring(0, 80)}`);
            if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 3000));
          }
        }
      } catch (err: any) {
        console.error("[BOT-SERVER] Trading agent start failed:", err.message);
      }
    }, 5000);
  });
})();

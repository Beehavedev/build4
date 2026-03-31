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

const CRITICAL_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS "telegram_bot_subscriptions" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, wallet_address TEXT NOT NULL, chat_id TEXT NOT NULL, status TEXT DEFAULT 'trial'::text NOT NULL, trial_started_at TIMESTAMP DEFAULT now(), paid_at TIMESTAMP, expires_at TIMESTAMP, tx_hash TEXT, chain_id INTEGER, amount_paid TEXT, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "telegram_bot_referrals" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, referrer_chat_id TEXT NOT NULL, referred_chat_id TEXT NOT NULL, referral_code TEXT NOT NULL, status TEXT DEFAULT 'pending' NOT NULL, commission_percent INTEGER DEFAULT 30, commission_amount TEXT, commission_paid BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "telegram_wallets" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, chat_id TEXT NOT NULL, wallet_address TEXT NOT NULL, encrypted_key TEXT, created_at TIMESTAMP DEFAULT now(), is_active BOOLEAN DEFAULT true)`,
  `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "owner_telegram_chat_id" TEXT`,
  `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "preferred_model" TEXT`,
  `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP DEFAULT now()`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "agent_id" VARCHAR`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "creator_wallet" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "image_url" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "launch_url" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "initial_liquidity_bnb" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "error_message" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "metadata" TEXT`,
  `CREATE TABLE IF NOT EXISTS "sniper_wallet_keys" (id VARCHAR DEFAULT gen_random_uuid() NOT NULL, launch_id VARCHAR, chat_id TEXT NOT NULL, agent_id VARCHAR NOT NULL, token_address TEXT, wallet_index INTEGER NOT NULL, wallet_address TEXT NOT NULL, encrypted_private_key TEXT NOT NULL, bnb_amount TEXT, status TEXT DEFAULT 'funded'::text NOT NULL, tx_hash TEXT, created_at TIMESTAMP DEFAULT now())`,
];

async function ensureSchema() {
  if (!process.env.DATABASE_URL) return;
  console.log("[BOT-SERVER] Ensuring database schema exists...");
  const isSSL = process.env.DATABASE_URL.includes("render.com") ||
    process.env.DATABASE_URL.includes("neon.tech") ||
    process.env.RENDER === "true";
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isSSL ? { rejectUnauthorized: false } : false,
  });
  try {
    for (const stmt of CRITICAL_TABLES_SQL) {
      try {
        await pool.query(stmt);
      } catch (e: any) {
        console.warn("[BOT-SERVER] Table create warning:", e.message?.substring(0, 100));
      }
    }
    console.log("[BOT-SERVER] Critical tables ensured");

    const sql = findSchemaSQL();
    if (sql) {
      const statements = sql.split(/;\s*\n/).filter((s: string) => s.trim().length > 5);
      let ok = 0, skip = 0;
      for (const stmt of statements) {
        try {
          await pool.query(stmt);
          ok++;
        } catch {
          skip++;
        }
      }
      console.log(`[BOT-SERVER] Schema init: ${ok} succeeded, ${skip} skipped`);
    } else {
      console.warn("[BOT-SERVER] schema-init.sql not found — using embedded critical tables only");
    }
  } catch (e: any) {
    console.error("[BOT-SERVER] Schema setup error:", e.message?.substring(0, 200));
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

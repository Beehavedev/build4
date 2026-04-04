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
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "chain_id" INTEGER DEFAULT 56`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "platform" TEXT DEFAULT 'four_meme'`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "token_name" TEXT DEFAULT ''`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "token_symbol" TEXT DEFAULT ''`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "token_description" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "image_url" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "token_address" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "tx_hash" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "launch_url" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "initial_liquidity_bnb" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'pending'`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "error_message" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "metadata" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP DEFAULT now()`,
  `CREATE TABLE IF NOT EXISTS "sniper_wallet_keys" (id VARCHAR DEFAULT gen_random_uuid() NOT NULL, launch_id VARCHAR, chat_id TEXT NOT NULL, agent_id VARCHAR NOT NULL, token_address TEXT, wallet_index INTEGER NOT NULL, wallet_address TEXT NOT NULL, encrypted_private_key TEXT NOT NULL, bnb_amount TEXT, status TEXT DEFAULT 'funded'::text NOT NULL, tx_hash TEXT, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "user_rewards" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, chat_id TEXT NOT NULL, reward_type TEXT NOT NULL, amount TEXT NOT NULL, description TEXT, reference_id TEXT, claimed BOOLEAN DEFAULT false NOT NULL, claimed_at TIMESTAMP, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "user_quests" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, chat_id TEXT NOT NULL, quest_id TEXT NOT NULL, completed BOOLEAN DEFAULT false NOT NULL, completed_at TIMESTAMP, reward_granted BOOLEAN DEFAULT false NOT NULL, created_at TIMESTAMP DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "user_quests_chat_quest_idx" ON "user_quests" (chat_id, quest_id)`,
  `CREATE TABLE IF NOT EXISTS "trading_challenges" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, name TEXT NOT NULL, description TEXT, start_date TIMESTAMP NOT NULL, end_date TIMESTAMP NOT NULL, prize_pool_b4 TEXT DEFAULT '0' NOT NULL, status TEXT DEFAULT 'upcoming' NOT NULL, max_entries INTEGER DEFAULT 100, min_balance_bnb TEXT DEFAULT '0.01', prize_distribution TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "challenge_entries" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, challenge_id VARCHAR NOT NULL, agent_id VARCHAR NOT NULL, owner_chat_id TEXT NOT NULL, wallet_address TEXT NOT NULL, starting_balance_bnb TEXT DEFAULT '0' NOT NULL, current_balance_bnb TEXT DEFAULT '0' NOT NULL, pnl_percent TEXT DEFAULT '0' NOT NULL, pnl_bnb TEXT DEFAULT '0' NOT NULL, trade_count INTEGER DEFAULT 0 NOT NULL, rank INTEGER, reward_amount TEXT, reward_paid BOOLEAN DEFAULT false, joined_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "agent_pnl_snapshots" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, agent_id VARCHAR NOT NULL, challenge_id VARCHAR, wallet_address TEXT NOT NULL, balance_bnb TEXT NOT NULL, token_value_bnb TEXT DEFAULT '0', total_value_bnb TEXT NOT NULL, pnl_percent TEXT DEFAULT '0' NOT NULL, snapshot_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "copy_trades" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, follower_chat_id TEXT NOT NULL, follower_wallet TEXT NOT NULL, agent_id VARCHAR NOT NULL, agent_name TEXT, max_amount_bnb TEXT DEFAULT '0.1' NOT NULL, total_copied INTEGER DEFAULT 0 NOT NULL, total_pnl_bnb TEXT DEFAULT '0' NOT NULL, active BOOLEAN DEFAULT true NOT NULL, created_at TIMESTAMP DEFAULT now())`,
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

    try {
      await pool.query(`ALTER TABLE "trading_challenges" ADD COLUMN IF NOT EXISTS "prize_distribution" TEXT`);
    } catch (e: any) {
      console.warn("[BOT-SERVER] prize_distribution column:", e.message?.substring(0, 80));
    }

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
          getBotInstance()?.sendMessage(cid, msg, { parse_mode: "Markdown" }).catch(() => {});
        };

        if (!isTradingAgentRunning()) {
          startTradingAgent(notifyFn);
          console.log("[BOT-SERVER] Trading agent started");
        }

        try {
          const { startPnlTracker, getActiveChallenges, createChallenge } = await import("./trading-challenge");
          startPnlTracker(5 * 60 * 1000);
          console.log("[BOT-SERVER] PnL tracker started (5 min interval)");

          const existing = await getActiveChallenges();
          const hasTraderChallenge = existing.some(c => c.name === "Trading Bot Challenge #1");
          if (!hasTraderChallenge) {
            const now = new Date();
            const endDate = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
            await createChallenge({
              name: "Trading Bot Challenge #1",
              description: "Create a trading bot. If your bot trades and makes profit, you're in! Top 3 win $B4 prizes.",
              startDate: now,
              endDate,
              prizePoolB4: "950000",
              maxEntries: 100,
              prizeDistribution: ["500000", "300000", "150000"],
            });
            console.log("[BOT-SERVER] Created 'Trading Bot Challenge #1' — 4 days, 950K $B4 pool");
          }
        } catch (pnlErr: any) {
          console.error("[BOT-SERVER] PnL tracker/challenge start failed:", pnlErr.message);
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

import express from "express";
import { createServer } from "http";
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        bio TEXT,
        model_type TEXT NOT NULL DEFAULT 'meta-llama/Llama-3.1-70B-Instruct',
        status TEXT NOT NULL DEFAULT 'active',
        onchain_id TEXT,
        onchain_registered BOOLEAN NOT NULL DEFAULT false,
        erc8004_registered BOOLEAN NOT NULL DEFAULT false,
        bap578_registered BOOLEAN NOT NULL DEFAULT false,
        creator_wallet TEXT,
        preferred_chain TEXT DEFAULT 'bnbMainnet',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_wallets (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id VARCHAR NOT NULL,
        balance TEXT NOT NULL DEFAULT '0',
        total_earned TEXT NOT NULL DEFAULT '0',
        total_spent TEXT NOT NULL DEFAULT '0',
        status TEXT NOT NULL DEFAULT 'active',
        last_active_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_transactions (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id VARCHAR NOT NULL,
        type TEXT NOT NULL,
        amount TEXT NOT NULL,
        counterparty_agent_id VARCHAR,
        reference_type TEXT,
        reference_id TEXT,
        memo TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id VARCHAR NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id VARCHAR NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS telegram_wallets (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        encrypted_private_key TEXT
      );
      CREATE TABLE IF NOT EXISTS trading_preferences (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id TEXT NOT NULL UNIQUE,
        enabled BOOLEAN NOT NULL DEFAULT false,
        buy_amount_bnb TEXT NOT NULL DEFAULT '0.1',
        take_profit_multiple DOUBLE PRECISION NOT NULL DEFAULT 2.0,
        stop_loss_multiple DOUBLE PRECISION NOT NULL DEFAULT 0.7,
        max_positions INTEGER NOT NULL DEFAULT 5,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS trade_outcomes (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id TEXT,
        token_address TEXT NOT NULL,
        token_symbol TEXT,
        entry_price_bnb TEXT,
        exit_price_bnb TEXT,
        pnl_bnb DOUBLE PRECISION DEFAULT 0,
        source TEXT,
        reasoning TEXT,
        result TEXT,
        entry_progress DOUBLE PRECISION,
        entry_age_minutes DOUBLE PRECISION,
        entry_velocity DOUBLE PRECISION,
        entry_holder_count INTEGER,
        entry_raised_bnb DOUBLE PRECISION,
        entry_rug_risk DOUBLE PRECISION,
        hold_minutes DOUBLE PRECISION,
        peak_multiple DOUBLE PRECISION,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS token_launches (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        description TEXT,
        total_supply TEXT NOT NULL DEFAULT '1000000000',
        creator_wallet TEXT,
        contract_address TEXT,
        tx_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        platform TEXT DEFAULT 'four.meme',
        image_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_skill_configs (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS inference_requests (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id VARCHAR,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT,
        latency_ms INTEGER,
        tokens_used INTEGER,
        proof_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_knowledge_base (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id VARCHAR NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_conversation_memory (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id VARCHAR NOT NULL,
        chat_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS aster_credentials (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id TEXT NOT NULL UNIQUE,
        api_key TEXT NOT NULL,
        api_secret TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS twitter_agent_config (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id VARCHAR NOT NULL,
        twitter_handle TEXT,
        enabled BOOLEAN NOT NULL DEFAULT false,
        post_interval_minutes INTEGER DEFAULT 60,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS support_tickets (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id TEXT,
        subject TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        response TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("[BOT-SERVER] Database schema ensured — all core tables created");
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

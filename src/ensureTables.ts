import { db } from './db'

// Dedupe tolerated-error log lines per process so a known, never-fixable
// case (e.g. CREATE UNIQUE INDEX on Agent(LOWER(name)) failing because
// pre-existing rows already collide) doesn't spam stdout on every boot.
// First occurrence is still surfaced as a warning so a NEW dup error
// stays visible to operators. Repeats become silent for the lifetime of
// the process.
const _toleratedSeen = new Set<string>()

async function run(sql: string) {
  try {
    await db.$executeRawUnsafe(sql)
  } catch (err: any) {
    // Tolerate duplicate-key index creation failures (pre-existing dup data)
    // and other "already-exists" style errors; log once and continue.
    const msg = err?.meta?.message ?? err?.message ?? String(err)
    if (/duplicate|already exists|23505|42P07|42701/i.test(msg)) {
      if (!_toleratedSeen.has(msg)) {
        _toleratedSeen.add(msg)
        console.warn('[DB] Tolerated (first seen this boot):', msg)
      }
      return
    }
    throw err
  }
}

export async function ensureNewTables() {
  console.log('[DB] Ensuring new tables exist (safe — no drops)...')

  // Phase 3 (x402): single-use payment ledger. Used by
  // src/services/x402.ts to enforce that each USDT txhash can only
  // unlock a resource ONCE. Idempotent CREATE — never drops data.
  await run(`CREATE TABLE IF NOT EXISTS "X402Payment" (
    "tx_hash" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "X402Payment_pkey" PRIMARY KEY ("tx_hash")
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "X402Payment_payer_idx" ON "X402Payment"("payer")`)
  await run(`CREATE INDEX IF NOT EXISTS "X402Payment_resource_idx" ON "X402Payment"("resource")`)

  // Broker spread fees (0.30% default) charged on the 4 venues without
  // native builder programs (42.space, four.meme, PancakeSwap, Topaz).
  // Written by src/services/brokerFees.ts after each successful fee
  // transfer; used for reconciliation against the recipient wallet's
  // on-chain history. Idempotent.
  await run(`CREATE TABLE IF NOT EXISTS "BrokerFee" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "venue" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "grossAmount" TEXT NOT NULL,
    "feeAmount" TEXT NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "feeTxHash" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "BrokerFee_pkey" PRIMARY KEY ("id")
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "BrokerFee_userId_idx" ON "BrokerFee"("userId")`)
  await run(`CREATE INDEX IF NOT EXISTS "BrokerFee_venue_idx" ON "BrokerFee"("venue")`)
  await run(`CREATE INDEX IF NOT EXISTS "BrokerFee_createdAt_idx" ON "BrokerFee"("createdAt")`)

  await run(`CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "referredBy" TEXT,
    "referralCode" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "subscriptionTier" TEXT NOT NULL DEFAULT 'free',
    "subscriptionExpiry" TIMESTAMP(3),
    "totalFeesSpent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "b4Balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "asterApiKey" TEXT,
    "asterApiSecret" TEXT,
    "asterAgentAddress" TEXT,
    "asterAgentEncryptedPK" TEXT,
    "asterOnboarded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
  )`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramId_key" ON "User"("telegramId")`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "User_referralCode_key" ON "User"("referralCode")`)

  await run(`CREATE TABLE IF NOT EXISTS "Wallet" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedPK" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Wallet 1',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "Wallet_userId_idx" ON "Wallet"("userId")`)

  await run(`CREATE TABLE IF NOT EXISTS "Agent" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "exchange" TEXT NOT NULL DEFAULT 'mock',
    "pairs" TEXT[] DEFAULT ARRAY['BTC/USDT']::TEXT[],
    "timeframe" TEXT NOT NULL DEFAULT '15m',
    "maxPositionSize" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "maxDailyLoss" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "maxLeverage" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "stopLossPct" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "takeProfitPct" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "memorySnapshot" JSONB,
    "totalPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isListed" BOOLEAN NOT NULL DEFAULT false,
    "listingPrice" DOUBLE PRECISION,
    "subscriberCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTickAt" TIMESTAMP(3),
    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "Agent_userId_idx" ON "Agent"("userId")`)
  await run(`CREATE INDEX IF NOT EXISTS "Agent_isActive_idx" ON "Agent"("isActive")`)

  // On-chain identity columns (added in v2 — every agent has its own wallet)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "walletAddress" TEXT`)
  // Campaign-mode: dedicated agent → dedicated Wallet row (Path A).
  // NULL means "fall back to user's primary BSC wallet" (existing behaviour).
  // Non-NULL pins this agent's 42.space trades to a specific Wallet.id.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "walletId" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "encryptedPK" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "onchainTxHash" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "onchainChain" TEXT DEFAULT 'BSC'`)
  // ERC-8004 identity columns (added in v3 — Trustless AI Agents Standard)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "learningModel" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "learningRoot" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "metadataUri" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "identityStandard" TEXT DEFAULT 'ERC-8004'`)
  // BAP-578 NFA NFT verification (real on-chain mint via NfaScan registry)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "bap578TokenId" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "bap578TxHash" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "bap578Verified" BOOLEAN DEFAULT false`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "erc8004AgentId" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "erc8004TxHash" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "erc8004FundTxHash" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "erc8004Verified" BOOLEAN DEFAULT false`)
  // House/system agents — minted by BUILD4 itself to satisfy ecosystem
  // grants that require a minimum on-chain agent count. Flagged so they
  // can be filtered out of user-facing lists (mini-app /myagents, copy-
  // trading leaderboard, runner queues) without affecting per-agent
  // queries that need to see them (erc8004 backfill, on-chain audit).
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "isHouseAgent" BOOLEAN DEFAULT false`)
  // AUTO-mode pair scanner state — populated each tick when pairs:['AUTO']
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "currentPair" TEXT`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "lastScanScore" INTEGER`)

  // Per-agent venue allow-list (Phase 1, 2026-04-28). Default empty so
  // brand-new agents are forced to opt in via the chip toggles. Existing
  // rows are backfilled below to ARRAY[exchange] so behaviour is
  // unchanged on first deploy — users see their current venue lit and
  // can tap to add the others.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "enabledVenues" TEXT[] DEFAULT ARRAY[]::TEXT[]`)
  // Backfill: any row whose enabledVenues is NULL or empty inherits its
  // legacy single venue. Using array_length() IS NULL covers both states
  // (NULL → length is NULL; empty array → length is also NULL in PG).
  await run(`UPDATE "Agent"
             SET "enabledVenues" = ARRAY["exchange"]::TEXT[]
             WHERE array_length("enabledVenues", 1) IS NULL
               AND "exchange" IS NOT NULL
               AND "exchange" <> ''`)
  // One-time multi-venue expansion (Phase 1.1, 2026-04-29). Existing
  // agents were backfilled above to a single-venue array matching their
  // legacy `exchange` column. That meant the runner only ever dispatched
  // an Aster tick for them, so the brain feed never showed any HL or
  // 42.space activity — even though scanning those venues is read-only
  // and doesn't require user onboarding. We add a flag column to mark
  // agents that have been expanded so the expansion runs once per
  // agent (idempotent; never overrides a user who later prunes a
  // venue via the chip toggles in Agent Studio).
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "venuesAutoExpanded" BOOLEAN DEFAULT false`)
  // four.meme integration. Both columns default false so every
  // existing agent stays opted-out until the operator (or the user via
  // mini-app) flips them on. The trading flag (`fourMemeEnabled`)
  // gates Module 2 (autonomous agent trading); the launch flag
  // (`fourMemeLaunchEnabled`) gates Module 3 (token creation, ported
  // from the marketing-site launcher — uses four.meme's private/user
  // login + private/token/create API gated by a wallet signature).
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeEnabled" BOOLEAN DEFAULT false`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeLaunchEnabled" BOOLEAN DEFAULT false`)
  // Module 4 — autonomous agent token launches. Per-row tick stamp used
  // by src/agents/fourMemeLaunchAgent.ts to enforce a per-agent minimum
  // tick interval (so a fast cron can't double-fire a launch decision).
  // Daily cap is enforced separately by counting rows in token_launches.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "lastFourMemeLaunchTickAt" TIMESTAMP(3)`)
  // Task #64 — human-in-the-loop launch approvals. When true, the
  // Module 4 agent writes a 'pending_user_approval' row instead of
  // firing launchFourMemeToken; the owner approves/rejects from
  // Telegram or the mini-app. Default false preserves existing
  // autonomous behaviour for every existing agent.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeLaunchRequiresApproval" BOOLEAN DEFAULT false`)
  // Demo Day — per-agent scan cadence in minutes (1..60). NULL = use the
  // hardcoded MIN_TICK_INTERVAL_MS floor (60s). Set via mini-app pill;
  // controls how often the launch agent re-scans the 4 narrative
  // sources and fires an LLM decision.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeLaunchIntervalMinutes" INTEGER`)
  // Demo Day — user-configured initial dev buy size in BNB. Stored as
  // TEXT to avoid float drift on the wire (parsed via ethers.parseEther
  // server-side). NULL = let the LLM propose (clamped to
  // MAX_INITIAL_BUY_BNB). When set, this OVERRIDES the LLM proposal.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeLaunchInitialBuyBnb" TEXT`)
  // Demo Day — auto-sell take-profit threshold in percent (1..10000,
  // typical 100..500). NULL = leave it to the user (no autonomous
  // exits ever). When set, the take-profit sweep liquidates the entire
  // dev bag in one tx the moment quoteSell proceeds clear the
  // threshold above the original initial_liquidity_bnb. There is
  // intentionally NO stop-loss: a dev who fired the first buy on the
  // bonding curve is at the lowest cost basis on Earth — there's no
  // "below entry" exit that makes economic sense.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeLaunchTakeProfitPct" INTEGER`)
  // The token_launches ALTERs for autonomous-TP tracking live AFTER
  // the CREATE TABLE IF NOT EXISTS block below — see the comment that
  // immediately follows the existing user_id/agent_id ALTERs. We
  // intentionally do NOT touch token_launches here because that table
  // is created lower down and ALTERing a not-yet-created relation
  // would throw 42P01 on a fresh deployment.
  // token_launches — persistent record of every Module 3 launch
  // attempt. The table already exists in production from the
  // marketing-site era with snake_cased columns and an
  // `initial_liquidity_bnb` column (no `user_id`). Per project
  // preferences we don't touch prisma/, so we shape the existing
  // table forward via idempotent ALTERs:
  //   - CREATE TABLE IF NOT EXISTS for fresh deployments only
  //   - ADD COLUMN IF NOT EXISTS for the columns Module 3 needs that
  //     the marketing-site schema didn't have (user_id only — we
  //     reuse initial_liquidity_bnb for the initial-buy amount).
  await run(`CREATE TABLE IF NOT EXISTS "token_launches" (
    "id" TEXT PRIMARY KEY,
    "user_id" TEXT,
    "agent_id" TEXT,
    "creator_wallet" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'four_meme',
    "chain_id" INTEGER NOT NULL DEFAULT 56,
    "token_name" TEXT NOT NULL,
    "token_symbol" TEXT NOT NULL,
    "token_description" TEXT,
    "image_url" TEXT,
    "token_address" TEXT,
    "tx_hash" TEXT,
    "launch_url" TEXT,
    "initial_liquidity_bnb" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "metadata" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await run(`ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "user_id" TEXT`)
  // Module 4 — autonomous launches need an agent_id column so the
  // per-agent daily/lifetime caps + dedup query in
  // src/agents/fourMemeLaunchAgent.ts can find prior attempts. Legacy
  // production tables (marketing-site era) lack this column, so the
  // ALTER IF NOT EXISTS is required — without it the daily-cap query
  // throws and the agent fail-closes to SKIP forever.
  await run(`ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "agent_id" TEXT`)
  await run(`CREATE INDEX IF NOT EXISTS "token_launches_user_id_idx" ON "token_launches" ("user_id")`)
  await run(`CREATE INDEX IF NOT EXISTS "token_launches_creator_wallet_idx" ON "token_launches" ("creator_wallet")`)
  await run(`CREATE INDEX IF NOT EXISTS "token_launches_agent_id_idx" ON "token_launches" ("agent_id")`)
  // Demo Day — autonomous take-profit exit tracking. Three columns:
  //   • sold_at — non-NULL means the position is closed (success OR
  //     a permanent skip like graduated/V1). Primary scan-gate.
  //   • sold_proceeds_bnb — BNB received (decimal text); '0' on a
  //     skipped close so the brain feed can render it cleanly.
  //   • sold_tx_hash — doubles as an atomic CLAIM token. The TP sweep
  //     compare-and-sets this to a sentinel "__claim_<ts>__" BEFORE
  //     any on-chain call; a second worker hitting the same row sees
  //     the non-NULL value and skips. After success it's overwritten
  //     with the real tx hash; on a retryable failure it's reset to
  //     NULL so the next tick can retry.
  await run(`ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "sold_at" TIMESTAMPTZ`)
  await run(`ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "sold_proceeds_bnb" TEXT`)
  await run(`ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "sold_tx_hash" TEXT`)
  // Exact tokens the dev's initial buy received, parsed from the launch
  // tx receipt's ERC-20 Transfer event (token-wei, decimal text). When
  // present, /api/fourmeme/launches/live uses this for trustworthy PnL
  // instead of the rough avg-fill-price estimate. NULL on legacy /
  // backfilled rows (no initial buy, parse miss) → endpoint falls back
  // to the estimate, so no NaN / render error.
  await run(`ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "tokens_received_wei" TEXT`)

  // four_meme_holdings — Demo Day: tracks tokens the user TRADED
  // (manually bought via /api/fourmeme/buy) so the Portfolio "Token
  // Bags" card can surface them alongside tokens the user LAUNCHED.
  // Without this table, /api/fourmeme/positions would only ever show
  // launches; a user who manually bought a token they didn't launch
  // would see nothing in Portfolio, even though they hold a real
  // bag on-chain. Cumulative BNB-in / BNB-out are accumulated across
  // multiple buys and sells of the same (user, token) pair so the
  // Portfolio card can compute realised + unrealised PnL the same way
  // it does for launches. `last_action_at` lets us order by recency.
  // Idempotent CREATE; safe to deploy ahead of any code that reads it.
  await run(`CREATE TABLE IF NOT EXISTS "four_meme_holdings" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "token_name" TEXT,
    "token_symbol" TEXT,
    "image_url" TEXT,
    "first_buy_tx" TEXT,
    "last_action_tx" TEXT,
    "total_bnb_in" TEXT NOT NULL DEFAULT '0',
    "total_bnb_out" TEXT NOT NULL DEFAULT '0',
    "first_buy_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "last_action_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "four_meme_holdings_pkey" PRIMARY KEY ("id")
  )`)
  // Token address always stored lowercased (writers normalize), so a
  // plain composite unique index works for ON CONFLICT — avoids the
  // expression-index quirk where Postgres requires the exact same
  // expression in the conflict target.
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "four_meme_holdings_user_token_key"
               ON "four_meme_holdings" ("user_id", "token_address")`)
  await run(`CREATE INDEX IF NOT EXISTS "four_meme_holdings_user_idx"
               ON "four_meme_holdings" ("user_id", "last_action_at" DESC)`)

  // ── Task #149 — four.meme SNIPING (replaces autonomous launching) ────
  // Agents no longer LAUNCH their own tokens; they SNIPE other people's
  // fresh four.meme bonding-curve launches. The columns below are the
  // per-agent opt-in + tuning knobs, all NULLable so a NULL falls back
  // to the env/code default (see src/services/fourMemeTrust.ts and
  // src/agents/fourMemeSnipeAgent.ts). Read via raw SQL (the prisma
  // client doesn't carry these columns — same pattern as the launch
  // columns above), so we never touch prisma/.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeSnipeEnabled" BOOLEAN DEFAULT false`)
  // Per-agent tick throttle so a fast runner cadence doesn't make one
  // agent fire multiple buys per scan window.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "lastFourMemeSnipeTickAt" TIMESTAMP(3)`)
  // Per-buy size in BNB (decimal string). NULL = env default
  // FOUR_MEME_SNIPE_BUY_BNB. Hard-capped in code regardless.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeSnipeBuyBnb" TEXT`)
  // Minimum trust score (0-100) the agent will buy at. NULL = Balanced
  // default from the trust model.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeSnipeMinTrust" INTEGER`)
  // Max concurrent open snipe positions per agent. NULL = code default.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeSnipeMaxPositions" INTEGER`)
  // Take-profit % (e.g. 50 = +50%). NULL = code default.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeSnipeTakeProfitPct" INTEGER`)
  // Stop-loss % (e.g. 40 = -40%). NULL = code default. Unlike the dev-bag
  // TP sweep (which has no SL), snipers buy mid-curve so a real SL makes
  // economic sense.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeSnipeStopLossPct" INTEGER`)
  // Curve fill % (0-99) at which to exit before migration. NULL = code
  // default (~90). Very-high-trust positions ride through migration and
  // ignore this gate.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fourMemeSnipeExitFillPct" INTEGER`)

  // four_meme_scanner_state — single-row cursor for the factory-log
  // scanner so a process restart resumes from the last scanned block
  // instead of re-scanning a huge range or missing launches. id is a
  // fixed sentinel ('singleton').
  await run(`CREATE TABLE IF NOT EXISTS "four_meme_scanner_state" (
    "id" TEXT PRIMARY KEY,
    "last_block" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)

  // four_meme_launches_seen — the scanner cache + latest trust snapshot
  // for every discovered four.meme launch. The snipe agent reads
  // verdict='buy' rows from here; the scanner upserts curve stats +
  // trust on each enrichment pass. token_address always lowercased.
  await run(`CREATE TABLE IF NOT EXISTS "four_meme_launches_seen" (
    "token_address" TEXT PRIMARY KEY,
    "creator_wallet" TEXT,
    "version" INTEGER,
    "first_seen_block" BIGINT,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "launch_time" BIGINT,
    "last_scanned_at" TIMESTAMPTZ,
    "fill_pct" DOUBLE PRECISION,
    "funds_bnb" DOUBLE PRECISION,
    "buyer_count" INTEGER,
    "buy_count" INTEGER,
    "sell_count" INTEGER,
    "volume_bnb" DOUBLE PRECISION,
    "dev_holds_pct" DOUBLE PRECISION,
    "graduated" BOOLEAN DEFAULT false,
    "quote_is_bnb" BOOLEAN,
    "trust_score" INTEGER,
    "verdict" TEXT,
    "flags" TEXT,
    "discovered_via" TEXT
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "four_meme_launches_seen_verdict_idx"
               ON "four_meme_launches_seen" ("verdict", "trust_score" DESC)`)
  await run(`CREATE INDEX IF NOT EXISTS "four_meme_launches_seen_seen_idx"
               ON "four_meme_launches_seen" ("first_seen_at" DESC)`)
  await run(`CREATE INDEX IF NOT EXISTS "four_meme_launches_seen_scanned_idx"
               ON "four_meme_launches_seen" ("graduated", "last_scanned_at")`)

  // four_meme_positions — open snipe positions per (agent, token). The
  // exit sweep uses claim_token as an atomic CAS lock (same idea as the
  // dev-bag TP sweep's sold_tx_hash) so concurrent workers can't
  // double-sell. token_address always lowercased.
  await run(`CREATE TABLE IF NOT EXISTS "four_meme_positions" (
    "id" TEXT PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "version" INTEGER,
    "entry_bnb_wei" TEXT NOT NULL,
    "entry_cost_bnb" DOUBLE PRECISION,
    "tokens_wei" TEXT NOT NULL,
    "buy_tx" TEXT,
    "entry_fill_pct" DOUBLE PRECISION,
    "trust_at_entry" INTEGER,
    "ride_through" BOOLEAN DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "exit_reason" TEXT,
    "exit_proceeds_bnb" DOUBLE PRECISION,
    "exit_tx" TEXT,
    "claim_token" TEXT,
    "claim_at" TIMESTAMPTZ,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "closed_at" TIMESTAMPTZ
  )`)
  // claim_at lets the exit sweep reclaim a position whose worker crashed
  // mid-sell (claim_token set, never released) so it can't freeze forever.
  await run(`ALTER TABLE "four_meme_positions" ADD COLUMN IF NOT EXISTS "claim_at" TIMESTAMPTZ`)
  await run(`CREATE INDEX IF NOT EXISTS "four_meme_positions_agent_status_idx"
               ON "four_meme_positions" ("agent_id", "status")`)
  await run(`CREATE INDEX IF NOT EXISTS "four_meme_positions_status_idx"
               ON "four_meme_positions" ("status")`)
  // One open position per (agent, token) — prevents a slow exit sweep
  // from letting the buy loop stack duplicate bags on the same launch.
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "four_meme_positions_open_unique"
               ON "four_meme_positions" ("agent_id", "token_address")
               WHERE "status" = 'open'`)
  // Phase 4 (2026-05-03): include 'polymarket' in the auto-expansion so
  // every agent (existing AND brand-new — agentCreation now stamps
  // venuesAutoExpanded=true to opt out of this UPDATE entirely, but
  // legacy rows still flow through here) lights up all 4 venue chips by
  // default. Previously this set ['aster','hyperliquid','fortytwo'] and
  // silently dropped 'polymarket' from the array — even when
  // agentCreation seeded it correctly — because the UPDATE clobbered
  // the column on the next boot. That's why new agents (e.g. Joey) were
  // showing the POLY chip OFF despite the creation code setting it ON.
  // Phase 5 (2026-05-25): include 'topaz' now that Phase 2 multi-user
  // rollout lets every user swap/farm on Topaz from their own wallet.
  // Previously 'topaz' was deliberately excluded (Phase 1 was
  // master-wallet-only); it's now safe to light up the chip on every
  // agent by default, identical to the other 4 venues.
  await run(`UPDATE "Agent"
             SET "enabledVenues" = ARRAY['aster', 'hyperliquid', 'fortytwo', 'polymarket', 'topaz']::TEXT[],
                 "venuesAutoExpanded" = true
             WHERE COALESCE("venuesAutoExpanded", false) = false`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "Agent_walletAddress_key" ON "Agent"("walletAddress") WHERE "walletAddress" IS NOT NULL`)
  // Globally unique agent name (case-insensitive) — name is hardcoded on-chain, must be unique
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "Agent_name_lower_key" ON "Agent"(LOWER("name"))`)

  await run(`CREATE TABLE IF NOT EXISTS "AgentMemory" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "agentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentMemory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "AgentMemory_agentId_idx" ON "AgentMemory"("agentId")`)
  await run(`CREATE INDEX IF NOT EXISTS "AgentMemory_type_idx" ON "AgentMemory"("type")`)

  await run(`CREATE TABLE IF NOT EXISTS "Trade" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "exchange" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "exitPrice" DOUBLE PRECISION,
    "size" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "pnl" DOUBLE PRECISION,
    "pnlPct" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'open',
    "txHash" TEXT,
    "aiReasoning" TEXT,
    "signalsUsed" JSONB,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Trade_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "Trade_userId_idx" ON "Trade"("userId")`)
  await run(`CREATE INDEX IF NOT EXISTS "Trade_agentId_idx" ON "Trade"("agentId")`)
  await run(`CREATE INDEX IF NOT EXISTS "Trade_status_idx" ON "Trade"("status")`)

  await run(`CREATE TABLE IF NOT EXISTS "CopyFollow" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "followerId" TEXT NOT NULL,
    "copiedId" TEXT NOT NULL,
    "allocation" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CopyFollow_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CopyFollow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CopyFollow_copiedId_fkey" FOREIGN KEY ("copiedId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "CopyFollow_followerId_copiedId_key" ON "CopyFollow"("followerId", "copiedId")`)

  await run(`CREATE TABLE IF NOT EXISTS "Portfolio" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "totalValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPnlPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dayPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "verifiedOnChain" BOOLEAN NOT NULL DEFAULT false,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Portfolio_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Portfolio_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "Portfolio_userId_key" ON "Portfolio"("userId")`)

  await run(`CREATE TABLE IF NOT EXISTS "Quest" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reward" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,
    "requirement" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Quest_pkey" PRIMARY KEY ("id")
  )`)

  await run(`CREATE TABLE IF NOT EXISTS "UserQuest" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),
    CONSTRAINT "UserQuest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserQuest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UserQuest_questId_fkey" FOREIGN KEY ("questId") REFERENCES "Quest"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "UserQuest_userId_questId_key" ON "UserQuest"("userId", "questId")`)

  await run(`CREATE TABLE IF NOT EXISTS "AgentLog" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "rawResponse" TEXT,
    "parsedAction" TEXT,
    "executionResult" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgentLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "AgentLog_agentId_idx" ON "AgentLog"("agentId")`)

  // Live "Agent Brain" feed columns — every decision is logged with full context.
  await run(`ALTER TABLE "AgentLog" ADD COLUMN IF NOT EXISTS "pair"   TEXT`)
  await run(`ALTER TABLE "AgentLog" ADD COLUMN IF NOT EXISTS "price"  DOUBLE PRECISION`)
  await run(`ALTER TABLE "AgentLog" ADD COLUMN IF NOT EXISTS "reason" TEXT`)
  await run(`ALTER TABLE "AgentLog" ADD COLUMN IF NOT EXISTS "adx"    DOUBLE PRECISION`)
  await run(`ALTER TABLE "AgentLog" ADD COLUMN IF NOT EXISTS "rsi"    DOUBLE PRECISION`)
  await run(`ALTER TABLE "AgentLog" ADD COLUMN IF NOT EXISTS "score"  INTEGER`)
  await run(`ALTER TABLE "AgentLog" ADD COLUMN IF NOT EXISTS "regime" TEXT`)
  // Per-tick venue tag — the runner expands each agent into per-venue
  // tick units and overrides agent.exchange on a CLONE per tick. Without
  // this column the brain feed has no way to know whether a row came
  // from an HL, Aster or 42 tick (the Agent table's `exchange` only
  // reflects the agent's PRIMARY venue, never changes per tick), so the
  // mini-app's venue chip would always render the primary value. We
  // capture the per-tick venue at write time and prefer it in the feed.
  await run(`ALTER TABLE "AgentLog" ADD COLUMN IF NOT EXISTS "exchange" TEXT`)
  await run(`CREATE INDEX IF NOT EXISTS "AgentLog_userId_createdAt_idx" ON "AgentLog"("userId", "createdAt" DESC)`)

  // ─── Security: PIN columns on User + audit log table ───
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pinHash" TEXT`)
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pinSalt" TEXT`)

  await run(`CREATE TABLE IF NOT EXISTS "SecurityLog" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "walletId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SecurityLog_pkey" PRIMARY KEY ("id")
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "SecurityLog_userId_idx" ON "SecurityLog"("userId")`)
  await run(`CREATE INDEX IF NOT EXISTS "SecurityLog_action_idx" ON "SecurityLog"("action")`)
  await run(`CREATE INDEX IF NOT EXISTS "SecurityLog_createdAt_idx" ON "SecurityLog"("createdAt")`)

  // ─── 42.space prediction-market positions (Task #4) ───
  // Column was originally created with DEFAULT false (paper-trade by default).
  // We've since moved to live-by-default for everyone. Two-step migration
  // here makes the boot idempotent:
  //   1. ADD COLUMN IF NOT EXISTS guarantees the column exists on fresh DBs
  //      with the new default.
  //   2. ALTER COLUMN SET DEFAULT true updates existing DBs whose default
  //      is still false.
  // The actual one-time backfill of existing user rows lives below in a
  // tracked migration so it only runs once per DB, even across reboots.
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "fortyTwoLiveTrade" BOOLEAN NOT NULL DEFAULT true`)
  await run(`ALTER TABLE "User" ALTER COLUMN "fortyTwoLiveTrade" SET DEFAULT true`)
  // Phase 4 (2026-05-01) — Polymarket per-user pause flag. Default true
  // so existing users opt-in. Mirrors aster/hyperliquidAgentTradingEnabled
  // semantics; consumed by tickAllPolymarketAgents.
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "polymarketAgentTradingEnabled" BOOLEAN NOT NULL DEFAULT true`)
  await run(`ALTER TABLE "User" ALTER COLUMN "polymarketAgentTradingEnabled" SET DEFAULT true`)
  // ─── Multi-provider swarm opt-in (Task #18) ───
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "swarmEnabled" BOOLEAN NOT NULL DEFAULT false`)
  // ─── HL Unified Account flag (post-Apr-2026) ───
  // Set true once we've observed HL reject a usdClassTransfer with
  // "Action disabled when unified account is active" for this user. Lives
  // on User (not Wallet) because it's an account-mode property of the HL
  // address, identical for every concurrent session. The mini-app reads
  // this via /api/hyperliquid/account and uses it to suppress the
  // spot↔perps move CTAs (which always 502 in unified mode) and to show
  // the unified equity (spot + perps) as the trading balance.
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "hyperliquidUnified" BOOLEAN NOT NULL DEFAULT false`)
  // Whether this user has successfully signed `approveBuilder` to authorize
  // BUILD4 as their fee-collecting builder on Aster. Set to TRUE only after
  // Aster returns success on the EIP-712 call; persists across sessions.
  // Reads:
  //   - /api/aster/order — when FALSE, the bot drops `builder`+`feeRate`
  //     from the order body so Aster doesn't reject with "Cannot found
  //     builder config". The trade succeeds without fee attribution; a
  //     background retry path can re-attempt approveBuilder later.
  //   - asterReapprove daily cron — same skip behavior on auto-trades.
  // The flag is also used by the activation endpoint to decide whether to
  // surface a "builder enrollment failed, retry" hint in the UI response.
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "asterBuilderEnrolled" BOOLEAN NOT NULL DEFAULT false`)
  await run(`ALTER TABLE "AgentLog" ADD COLUMN IF NOT EXISTS "providers" JSONB`)
  await run(`CREATE TABLE IF NOT EXISTS "OutcomePosition" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "marketAddress" TEXT NOT NULL,
    "marketTitle" TEXT NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "outcomeLabel" TEXT NOT NULL,
    "usdtIn" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "exitPrice" DOUBLE PRECISION,
    "payoutUsdt" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'open',
    "paperTrade" BOOLEAN NOT NULL DEFAULT true,
    "txHashOpen" TEXT,
    "txHashClose" TEXT,
    "reasoning" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "outcomeTokenAmount" DOUBLE PRECISION,
    CONSTRAINT "OutcomePosition_pkey" PRIMARY KEY ("id")
  )`)
  // Add column on existing deployments (no-op if already present).
  await run(`ALTER TABLE "OutcomePosition" ADD COLUMN IF NOT EXISTS "outcomeTokenAmount" DOUBLE PRECISION`)
  // Per-provider swarm telemetry — populated when the agent ran a swarm tick.
  await run(`ALTER TABLE "OutcomePosition" ADD COLUMN IF NOT EXISTS "providers" JSONB`)
  // Reason a position was auto-closed by the stale-sweep (Task #9).
  await run(`ALTER TABLE "OutcomePosition" ADD COLUMN IF NOT EXISTS "closeReason" TEXT`)
  await run(`CREATE INDEX IF NOT EXISTS "OutcomePosition_userId_idx" ON "OutcomePosition"("userId")`)
  await run(`CREATE INDEX IF NOT EXISTS "OutcomePosition_agentId_idx" ON "OutcomePosition"("agentId")`)
  await run(`CREATE INDEX IF NOT EXISTS "OutcomePosition_status_idx" ON "OutcomePosition"("status")`)
  await run(`CREATE INDEX IF NOT EXISTS "OutcomePosition_marketAddress_idx" ON "OutcomePosition"("marketAddress")`)

  // ─── Editable AI cost rates (Task #23) — admin-managed override of the
  // hardcoded DEFAULT_COST_USD_PER_MTOKENS map in src/services/swarmStats.ts.
  await run(`CREATE TABLE IF NOT EXISTS "ProviderCostRate" (
    "provider" TEXT NOT NULL,
    "usdPer1MTokens" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    CONSTRAINT "ProviderCostRate_pkey" PRIMARY KEY ("provider")
  )`)

  // ─── MarketProposal — autonomous market-creator agent's queue ─────────
  // Each row is a candidate prediction market the agent has researched and
  // (usually) Claude-approved. Admin reviews these manually before they
  // get submitted to 42.space; once 42.space exposes a creation endpoint
  // we'll wire the submitted→live transition automatically.
  await run(`CREATE TABLE IF NOT EXISTS "MarketProposal" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "status" TEXT NOT NULL DEFAULT 'researched',
    "category" TEXT,
    "sourceType" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "outcomes" JSONB NOT NULL,
    "resolutionDate" TIMESTAMP(3),
    "resolutionCriteria" TEXT,
    "resolutionSource" TEXT,
    "totalScore" DOUBLE PRECISION NOT NULL,
    "scores" JSONB NOT NULL,
    "estimatedInterest" TEXT,
    "claudeReasoning" TEXT,
    "rawSignal" JSONB,
    "marketAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "liveAt" TIMESTAMP(3),
    CONSTRAINT "MarketProposal_pkey" PRIMARY KEY ("id")
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "MarketProposal_status_idx" ON "MarketProposal"("status")`)
  await run(`CREATE INDEX IF NOT EXISTS "MarketProposal_createdAt_idx" ON "MarketProposal"("createdAt" DESC)`)

  // ─── $B4 holder linking (Task #6) ──────────────────────────────────────
  // External wallet a user has proven ownership of via signed message.
  // The address column is nullable because a user is unlinked by default.
  // Balance is the cached on-chain $B4 balance at the time of link/refresh.
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "linkedB4WalletAddress" TEXT`)
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "linkedB4Balance" DOUBLE PRECISION`)
  await run(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "linkedB4At" TIMESTAMP(3)`)

  // ─── $B4 buybacks (Task #9) ────────────────────────────────────────────
  // Manual append-only ledger the team writes to as buybacks happen.
  // Mini-app reads it via a public GET endpoint to surface a running
  // total + recent activity. txHash is unique so accidentally posting
  // the same buyback twice is a no-op (idempotent admin flow).
  await run(`CREATE TABLE IF NOT EXISTS "BuybackTx" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "txHash" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'BSC',
    "amountB4" DOUBLE PRECISION NOT NULL,
    "amountUsdt" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuybackTx_pkey" PRIMARY KEY ("id")
  )`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "BuybackTx_txHash_key" ON "BuybackTx"("txHash")`)
  await run(`CREATE INDEX IF NOT EXISTS "BuybackTx_createdAt_idx" ON "BuybackTx"("createdAt" DESC)`)

  // ─── One-shot data migrations ──────────────────────────────────────────
  // Tracks one-off data backfills so each only runs once per DB, even when
  // ensureNewTables() executes on every boot.
  await run(`CREATE TABLE IF NOT EXISTS "_DataMigration" (
    "name" TEXT PRIMARY KEY,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)

  // Migration: flip every existing user from paper-trade to live for
  // 42.space prediction markets. New behaviour is "everyone trades live".
  // Runs exactly once: the INSERT INTO _DataMigration uses ON CONFLICT
  // DO NOTHING and we only fire the UPDATE when the marker row was
  // actually inserted (xmax = 0 means a fresh insert, not a conflict skip).
  const marker = await db.$queryRawUnsafe<Array<{ inserted: boolean }>>(
    `INSERT INTO "_DataMigration" ("name") VALUES ('2026-04-22-force-live-trade')
     ON CONFLICT ("name") DO NOTHING
     RETURNING (xmax = 0) AS inserted`,
  )
  if (marker.length > 0 && marker[0]?.inserted) {
    const updated = await db.$executeRawUnsafe(
      `UPDATE "User" SET "fortyTwoLiveTrade" = true WHERE "fortyTwoLiveTrade" = false`,
    )
    console.log(`[DB] Backfilled ${updated} users to live 42.space trading`)
  }

  // ── Polymarket Phase 2/3 — manual + autonomous prediction-market trading ──
  // Adds the per-agent toggles that control the polymarketAgent runner and
  // creates the two Polymarket-specific tables (creds + positions). All
  // ALTERs are IF NOT EXISTS / safe so they replay cleanly on every boot.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "polymarketEnabled" BOOLEAN NOT NULL DEFAULT false`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "polymarketMaxSizeUsdc" DOUBLE PRECISION NOT NULL DEFAULT 5`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "polymarketEdgeThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.10`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "lastPolymarketTickAt" TIMESTAMP(3)`)

  // Phase 4 (2026-05-01) — generalized prediction-market risk fields shared
  // by the 42.space sidecar AND the Polymarket loop. Nullable so the readers
  // can fall back to the venue-specific legacy fields (polymarketEdgeThreshold)
  // for any row that escapes the default. See Agent model doc-comment for
  // rationale on the 5pp / 14d defaults.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "predictionEdgeThreshold" DOUBLE PRECISION DEFAULT 0.05`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "predictionMaxDurationDays" DOUBLE PRECISION DEFAULT 14`)

  await run(`CREATE TABLE IF NOT EXISTS "PolymarketCreds" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "encryptedApiSecret" TEXT NOT NULL,
    "encryptedPassphrase" TEXT NOT NULL,
    "allowanceTxHash" TEXT,
    "allowanceVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolymarketCreds_pkey" PRIMARY KEY ("id")
  )`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "PolymarketCreds_userId_key" ON "PolymarketCreds"("userId")`)
  await run(`CREATE INDEX IF NOT EXISTS "PolymarketCreds_walletAddress_idx" ON "PolymarketCreds"("walletAddress")`)

  // Phase 2.1 — gasless via Polymarket Builder Relayer Client. The Safe
  // proxy is the actual funder of CLOB orders (signature_type=2), holds
  // USDC.e and ERC-1155 outcome shares, and is deployed via the relayer
  // on first /setup. ALTERs are idempotent so they replay cleanly on every
  // boot for pre-existing rows that were created under the EOA-funder model.
  await run(`ALTER TABLE "PolymarketCreds" ADD COLUMN IF NOT EXISTS "safeAddress" TEXT`)
  await run(`ALTER TABLE "PolymarketCreds" ADD COLUMN IF NOT EXISTS "safeDeployedAt" TIMESTAMP(3)`)
  await run(`CREATE INDEX IF NOT EXISTS "PolymarketCreds_safeAddress_idx" ON "PolymarketCreds"("safeAddress")`)

  await run(`CREATE TABLE IF NOT EXISTS "PolymarketPosition" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "conditionId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "marketSlug" TEXT,
    "marketTitle" TEXT NOT NULL,
    "outcomeLabel" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "sizeUsdc" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "fillSize" DOUBLE PRECISION,
    "exitPrice" DOUBLE PRECISION,
    "payoutUsdc" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION,
    "orderHash" TEXT,
    "orderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'placed',
    "errorMessage" TEXT,
    "builderCode" TEXT,
    "reasoning" TEXT,
    "providers" JSONB,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "PolymarketPosition_pkey" PRIMARY KEY ("id")
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "PolymarketPosition_userId_idx" ON "PolymarketPosition"("userId")`)
  await run(`CREATE INDEX IF NOT EXISTS "PolymarketPosition_agentId_idx" ON "PolymarketPosition"("agentId")`)
  await run(`CREATE INDEX IF NOT EXISTS "PolymarketPosition_status_idx" ON "PolymarketPosition"("status")`)
  await run(`CREATE INDEX IF NOT EXISTS "PolymarketPosition_conditionId_idx" ON "PolymarketPosition"("conditionId")`)

  // HouseAgent singleton — the BUILD4 house agent (standalone, no User row).
  // Wallet PK lives in process.env.HOUSE_AGENT_PRIVATE_KEY; this table only
  // holds runtime config + last-tick state. Single row, id='singleton'.
  await run(`CREATE TABLE IF NOT EXISTS "HouseAgent" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'idle',
    "dex" TEXT NOT NULL DEFAULT 'pancake',
    "walletAddress" TEXT,
    "campaignId" TEXT,
    "lastTickAt" TIMESTAMP(3),
    "lastTickStatus" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HouseAgent_pkey" PRIMARY KEY ("id")
  )`)
  await run(`INSERT INTO "HouseAgent" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING`)

  // HouseLog — brain-feed for the house agent. Decoupled from AgentLog
  // (which has NOT NULL FKs to Agent + User) since house has neither.
  await run(`CREATE TABLE IF NOT EXISTS "HouseLog" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dex" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'info',
    "decision" TEXT,
    "reasoning" TEXT NOT NULL,
    "txHash" TEXT,
    "meta" JSONB,
    CONSTRAINT "HouseLog_pkey" PRIMARY KEY ("id")
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "HouseLog_createdAt_idx" ON "HouseLog"("createdAt" DESC)`)

  // ── Topaz DEX (BSC ve(3,3)) — schema additions ─────────────────────────
  // Per-agent toggles + position-tracking table. As of Phase 2 (multi-user
  // rollout), 'topaz' is included in the enabledVenues auto-expansion
  // UPDATE above so every agent surfaces the TOPAZ chip by default.
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "topazEnabled" BOOLEAN NOT NULL DEFAULT false`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "topazMaxSizeUsdt" DOUBLE PRECISION NOT NULL DEFAULT 50`)
  await run(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "lastTopazTickAt" TIMESTAMP(3)`)

  await run(`CREATE TABLE IF NOT EXISTS "TopazPosition" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "poolAddress" TEXT NOT NULL,
    "positionType" TEXT NOT NULL,
    "tokenId" TEXT,
    "tickLower" INTEGER,
    "tickUpper" INTEGER,
    "entryAmt0" DOUBLE PRECISION,
    "entryAmt1" DOUBLE PRECISION,
    "entryValueUsdt" DOUBLE PRECISION,
    "claimedTopazAmt" DOUBLE PRECISION DEFAULT 0,
    "claimedTopazValueUsdt" DOUBLE PRECISION DEFAULT 0,
    "exitAmt0" DOUBLE PRECISION,
    "exitAmt1" DOUBLE PRECISION,
    "exitValueUsdt" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'open',
    "txHashOpen" TEXT,
    "txHashClose" TEXT,
    "reasoning" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "TopazPosition_pkey" PRIMARY KEY ("id")
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "TopazPosition_agent_status_idx" ON "TopazPosition"("agentId","status")`)
  await run(`CREATE INDEX IF NOT EXISTS "TopazPosition_user_status_idx"  ON "TopazPosition"("userId","status")`)
  await run(`CREATE INDEX IF NOT EXISTS "TopazPosition_pool_idx"         ON "TopazPosition"("poolAddress")`)
  // Lifecycle columns used by tickOneAgent CLOSE_LP/CLAIM paths:
  // gauge is resolved at OPEN time (so CLOSE doesn't need a re-lookup);
  // lpAmount stores v2 LP balance staked (so CLOSE knows how much to unstake/remove);
  // tokenA/B+stable identify the v2 pair for the Router.removeLiquidity call.
  await run(`ALTER TABLE "TopazPosition" ADD COLUMN IF NOT EXISTS "gaugeAddress" TEXT`)
  await run(`ALTER TABLE "TopazPosition" ADD COLUMN IF NOT EXISTS "lpAmount" NUMERIC(78, 0)`)
  await run(`ALTER TABLE "TopazPosition" ADD COLUMN IF NOT EXISTS "tokenA" TEXT`)
  await run(`ALTER TABLE "TopazPosition" ADD COLUMN IF NOT EXISTS "tokenB" TEXT`)
  await run(`ALTER TABLE "TopazPosition" ADD COLUMN IF NOT EXISTS "stable" BOOLEAN`)

  // Subscription payment ledger. One row per verified on-chain payment
  // ($19.99/mo USDT-on-BSC or USDC-on-Base). The UNIQUE constraint on
  // txHash is the single source of truth for single-use enforcement —
  // mirrors the X402Payment pattern. Written by
  // src/services/subscriptions.ts → recordPayment() via
  // INSERT ... ON CONFLICT DO NOTHING.
  await run(`CREATE TABLE IF NOT EXISTS "Subscription" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "txHash" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "periodDays" INTEGER NOT NULL,
    "extendedFrom" TIMESTAMPTZ NOT NULL,
    "extendedTo" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Subscription_txHash_key" UNIQUE ("txHash")
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "Subscription_userId_idx"    ON "Subscription"("userId")`)
  await run(`CREATE INDEX IF NOT EXISTS "Subscription_createdAt_idx" ON "Subscription"("createdAt")`)

  // One-shot trial backfill: every existing user (~17.5k as of deploy)
  // with NULL subscriptionExpiry gets a fresh trial starting NOW. The
  // window is read from the same env the runtime helper uses
  // (SUBSCRIPTION_TRIAL_DAYS, default 4) so the on-boot grant and the
  // per-user ensureTrial() helper can't drift. WHERE IS NULL keeps this
  // idempotent — subsequent boots are no-ops because every touched
  // user now has a non-null expiry, and any future paid user with a
  // populated expiry is left untouched.
  const trialDays = parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS ?? '4', 10)
  await run(`UPDATE "User"
    SET "subscriptionExpiry" = NOW() + INTERVAL '${trialDays} days'
    WHERE "subscriptionExpiry" IS NULL`)

  // ══════════════════════════════════════════════════════════════════════
  // Community Trading Fleet — 50 diversified, community-owned four.meme
  // trading agents (5 strategy groups × 10). Fully isolated from the Agent
  // table (those are Telegram-user agents); the fleet has its own wallets,
  // its own scheduler, and its own admin panel at /fleet. All raw-SQL,
  // never touches prisma/. Idempotent CREATE IF NOT EXISTS.
  // ══════════════════════════════════════════════════════════════════════

  // fleet_settings — single-row global control. live_trading=false means
  // the engine quotes real four.meme prices but NEVER sends a transaction
  // (mock-first). global_paused=true halts every agent regardless of its
  // own status. Both default to the safe value so a fresh deploy can never
  // spend funds until an admin flips them on from the panel.
  await run(`CREATE TABLE IF NOT EXISTS "fleet_settings" (
    "id" TEXT PRIMARY KEY,
    "live_trading" BOOLEAN NOT NULL DEFAULT false,
    "global_paused" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await run(`INSERT INTO "fleet_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING`)

  // fleet_agents — the 50 community agents. Each has its own BSC wallet
  // (encrypted_pk encrypted with the agent's own id as the key namespace),
  // a strategy tag, and per-agent risk/safety knobs. status='paused' on
  // creation so newly-seeded agents never trade before an admin reviews +
  // funds them. assigned_to holds the community member's handle (nullable).
  await run(`CREATE TABLE IF NOT EXISTS "fleet_agents" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "encrypted_pk" TEXT NOT NULL,
    "risk_level" TEXT NOT NULL DEFAULT 'medium',
    "max_trade_size_bnb" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "daily_trade_limit" INTEGER NOT NULL DEFAULT 10,
    "cooldown_sec" INTEGER NOT NULL DEFAULT 300,
    "jitter_sec" INTEGER NOT NULL DEFAULT 60,
    "max_positions" INTEGER NOT NULL DEFAULT 3,
    "min_trust" INTEGER NOT NULL DEFAULT 60,
    "take_profit_pct" INTEGER NOT NULL DEFAULT 50,
    "stop_loss_pct" INTEGER NOT NULL DEFAULT 35,
    "exit_fill_pct" INTEGER NOT NULL DEFAULT 90,
    "max_daily_loss_bnb" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "slippage_bps" INTEGER NOT NULL DEFAULT 500,
    "watchlist" TEXT,
    "status" TEXT NOT NULL DEFAULT 'paused',
    "assigned_to" TEXT,
    "last_tick_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "fleet_agents_name_key" ON "fleet_agents" ("name")`)
  await run(`CREATE INDEX IF NOT EXISTS "fleet_agents_strategy_idx" ON "fleet_agents" ("strategy")`)
  await run(`CREATE INDEX IF NOT EXISTS "fleet_agents_status_idx" ON "fleet_agents" ("status")`)
  // swarm_enabled — per-agent opt-in to the 4-LLM quorum "brain". When the
  // FLEET_SWARM_ENABLED env gate is on, agents flagged here route entry/exit
  // decisions through the swarm (confirm/veto + HOLD/SELL); flagged-off agents
  // stay purely mechanical. Default false so enabling the env gate alone is
  // inert until an operator opts agents in from the /fleet panel (no surprise
  // LLM spend). NOTE: fleet_* tables are ensureTables-only (absent from
  // src/_prisma_bot/schema.prisma), so `db push --accept-data-loss` never
  // manages — and thus never drops — this column. The Agent/User drift trap
  // (schemaDrift.test.ts) does not apply here.
  await run(`ALTER TABLE "fleet_agents" ADD COLUMN IF NOT EXISTS "swarm_enabled" BOOLEAN NOT NULL DEFAULT false`)

  // fleet_positions — open/closed bags per (agent, token). mock=true means
  // the position was opened with a real four.meme quote but NO on-chain tx.
  // claim_token is an atomic CAS lock for the exit sweep (same pattern as
  // four_meme_positions) so two exit workers can't double-sell.
  await run(`CREATE TABLE IF NOT EXISTS "fleet_positions" (
    "id" TEXT PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "token_symbol" TEXT,
    "version" INTEGER,
    "entry_bnb_wei" TEXT NOT NULL,
    "entry_cost_bnb" DOUBLE PRECISION,
    "tokens_wei" TEXT NOT NULL,
    "buy_tx" TEXT,
    "entry_fill_pct" DOUBLE PRECISION,
    "trust_at_entry" INTEGER,
    "mock" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'open',
    "exit_reason" TEXT,
    "exit_proceeds_bnb" DOUBLE PRECISION,
    "exit_tx" TEXT,
    "claim_token" TEXT,
    "claim_at" TIMESTAMPTZ,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "closed_at" TIMESTAMPTZ
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "fleet_positions_agent_status_idx" ON "fleet_positions" ("agent_id", "status")`)
  await run(`CREATE INDEX IF NOT EXISTS "fleet_positions_status_idx" ON "fleet_positions" ("status")`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "fleet_positions_open_unique"
               ON "fleet_positions" ("agent_id", "token_address") WHERE "status" = 'open'`)
  // Ride-through columns (added for the PancakeSwap-graduation feature).
  //   ride_through — decided at OPEN: if true the bag is NOT force-sold at
  //     graduation; it migrates with the token onto PancakeSwap and is managed
  //     there (TP/SL/trailing). Default false = legacy behavior (sell at grad).
  //   venue        — 'fourmeme' while on the bonding curve, flips to 'pancake'
  //     after migration so the exit sweep quotes/sells on the right router.
  //   peak_pnl_pct — running peak PnL% (post-grad), backs the trailing stop.
  // Same ensureTables-only safety as swarm_enabled above (no db-push drop).
  await run(`ALTER TABLE "fleet_positions" ADD COLUMN IF NOT EXISTS "ride_through" BOOLEAN NOT NULL DEFAULT false`)
  await run(`ALTER TABLE "fleet_positions" ADD COLUMN IF NOT EXISTS "venue" TEXT NOT NULL DEFAULT 'fourmeme'`)
  await run(`ALTER TABLE "fleet_positions" ADD COLUMN IF NOT EXISTS "peak_pnl_pct" DOUBLE PRECISION`)

  // fleet_trades — append-only fill log (buy + sell). The dashboard reads
  // today's buy count + realized PnL per agent from here, so it doubles as
  // the daily-limit / daily-loss source of truth (no counter columns to
  // drift). mock mirrors the position's mock flag.
  await run(`CREATE TABLE IF NOT EXISTS "fleet_trades" (
    "id" TEXT PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "position_id" TEXT,
    "side" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "token_symbol" TEXT,
    "amount_bnb" DOUBLE PRECISION,
    "tokens_wei" TEXT,
    "price_bnb" DOUBLE PRECISION,
    "pnl_bnb" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'filled',
    "mock" BOOLEAN NOT NULL DEFAULT true,
    "tx_hash" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "fleet_trades_agent_idx" ON "fleet_trades" ("agent_id", "created_at" DESC)`)
  await run(`CREATE INDEX IF NOT EXISTS "fleet_trades_created_idx" ON "fleet_trades" ("created_at" DESC)`)

  // fleet_logs — brain feed (decisions, skips, errors) for the dashboard.
  await run(`CREATE TABLE IF NOT EXISTS "fleet_logs" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "agent_id" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "meta" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "fleet_logs_agent_idx" ON "fleet_logs" ("agent_id", "created_at" DESC)`)
  await run(`CREATE INDEX IF NOT EXISTS "fleet_logs_created_idx" ON "fleet_logs" ("created_at" DESC)`)

  // fleet_low_balance_acks — admin acknowledgements of low-BNB alerts. The
  // low-balance watcher dedupes alerts in-memory per process, but that state
  // is lost on every redeploy/restart, so a chronically-low wallet re-alerts
  // after each deploy. A persisted ack row silences a known-low agent until
  // its wallet refills above threshold — the watcher deletes the row on
  // recovery so a later re-drain alerts again. One row per acked agent.
  await run(`CREATE TABLE IF NOT EXISTS "fleet_low_balance_acks" (
    "agent_id" TEXT PRIMARY KEY,
    "acked_by" TEXT,
    "acked_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)

  console.log('[DB] All new tables ready')
}

import { db } from './db'

async function run(sql: string) {
  try {
    await db.$executeRawUnsafe(sql)
  } catch (err: any) {
    // Tolerate duplicate-key index creation failures (pre-existing dup data)
    // and other "already-exists" style errors; log and continue.
    const msg = err?.meta?.message ?? err?.message ?? String(err)
    if (/duplicate|already exists|23505|42P07|42701/i.test(msg)) {
      console.warn('[DB] Tolerated:', msg)
      return
    }
    throw err
  }
}

export async function ensureNewTables() {
  console.log('[DB] Ensuring new tables exist (safe — no drops)...')

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
  // Phase 4 (2026-05-03): include 'polymarket' in the auto-expansion so
  // every agent (existing AND brand-new — agentCreation now stamps
  // venuesAutoExpanded=true to opt out of this UPDATE entirely, but
  // legacy rows still flow through here) lights up all 4 venue chips by
  // default. Previously this set ['aster','hyperliquid','fortytwo'] and
  // silently dropped 'polymarket' from the array — even when
  // agentCreation seeded it correctly — because the UPDATE clobbered
  // the column on the next boot. That's why new agents (e.g. Joey) were
  // showing the POLY chip OFF despite the creation code setting it ON.
  await run(`UPDATE "Agent"
             SET "enabledVenues" = ARRAY['aster', 'hyperliquid', 'fortytwo', 'polymarket']::TEXT[],
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

  console.log('[DB] All new tables ready')
}

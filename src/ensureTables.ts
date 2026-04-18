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

  console.log('[DB] All new tables ready')
}

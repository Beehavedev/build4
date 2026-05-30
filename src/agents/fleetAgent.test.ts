/**
 * Fleet engine — NO-DOUBLE-TRADE concurrency safety net.
 *
 * Two failed reviews traced back to the fleet double-spending: buying the same
 * token twice, selling the same bag twice, or trading after an admin hit the
 * global pause. The protections are pure Postgres semantics:
 *   • OPEN  — INSERT … ON CONFLICT ("agent_id","token_address") WHERE status='open'
 *             DO NOTHING (the fleet_positions_open_unique partial index) reserves
 *             the pair BEFORE any spend, so a race claims once and skips the rest.
 *   • CLOSE — a CAS lock (UPDATE … SET claim_token WHERE claim_token IS NULL)
 *             grabbed BEFORE the live sell, so two overlapping exit ticks can
 *             never both submit a real sell.
 *   • PAUSE — a kill-switch recheck immediately before the live sell: if global
 *             pause flips mid-sweep, fail closed (release the lock, no sell).
 *
 * Mocking only proves the JS branches — it can't prove the partial index or the
 * row-level CAS actually serialize concurrent callers. So this suite drives the
 * REAL openPosition/closePosition (via __test) against a REAL Postgres, stubbing
 * ONLY the chain I/O + settings reads (via __testDeps) so we can COUNT how many
 * real buys/sells fired. It skips cleanly when no DB is reachable, so it never
 * blocks CI in a Postgres-less environment.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../db'
import { __test, __testDeps } from './fleetAgent'
import { getTodayStats, getOpenPositionCounts, getOpenTokensByAgent, agentOpenGate } from '../services/fleet'
import type { FleetAgent, FleetCandidate } from '../services/fleet'

// ── Reachability + self-provisioning ───────────────────────────────────────
async function dbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  try {
    await db.$queryRawUnsafe('SELECT 1')
    return true
  } catch {
    return false
  }
}

// Minimal mirror of ensureTables' fleet_positions/fleet_trades + the partial
// unique index under test. Idempotent so it is safe on a populated dev DB.
async function ensureFleetTables(): Promise<void> {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "fleet_positions" (
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
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "fleet_positions_open_unique"
    ON "fleet_positions" ("agent_id", "token_address") WHERE "status" = 'open'`)
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "fleet_trades" (
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
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "fleet_logs" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "agent_id" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "meta" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
}

// ── Sentinel fixtures (cleaned up after each test) ─────────────────────────
// Unique per process so concurrent test runs never collide, and so we only
// ever touch our own rows.
const SUFFIX = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const AGENT_ID = `__itest_fleet_agent_${SUFFIX}`
// A checksummed-but-clearly-fake token address (ethers.getAddress accepts it).
const TOKEN = '0x' + 'a'.repeat(40)

function makeAgent(): FleetAgent {
  return {
    id: AGENT_ID,
    name: `itest ${SUFFIX}`,
    strategy: 'momentum',
    walletAddress: '0x' + 'b'.repeat(40),
    encryptedPk: 'unused-in-tests',
    riskLevel: 'medium',
    maxTradeSizeBnb: 0.01,
    dailyTradeLimit: 10,
    cooldownSec: 0,
    jitterSec: 0,
    maxPositions: 10,
    minTrust: 0,
    takeProfitPct: 50,
    stopLossPct: 35,
    exitFillPct: 90,
    maxDailyLossBnb: 1,
    slippageBps: 500,
    watchlist: null,
    status: 'active',
    assignedTo: null,
    lastTickAt: null,
    createdAt: new Date(),
  }
}

function makeCandidate(): FleetCandidate {
  return {
    tokenAddress: TOKEN,
    version: 2,
    fillPct: 0.1,
    fundsBnb: 1,
    buyerCount: 5,
    buyCount: 10,
    sellCount: 1,
    volumeBnb: 2,
    devHoldsPct: 1,
    trustScore: 80,
    graduated: false,
    firstSeenAt: new Date(),
  }
}

async function cleanup(): Promise<void> {
  try {
    await db.$executeRawUnsafe(`DELETE FROM "fleet_trades" WHERE "agent_id" = $1`, AGENT_ID)
    await db.$executeRawUnsafe(`DELETE FROM "fleet_positions" WHERE "agent_id" = $1`, AGENT_ID)
    await db.$executeRawUnsafe(`DELETE FROM "fleet_logs" WHERE "agent_id" = $1`, AGENT_ID)
  } catch { /* best-effort */ }
}

// Snapshot + restore the deps we override, so tests don't leak stubs.
function withDeps<T extends Partial<typeof __testDeps>>(over: T): () => void {
  const orig: Partial<typeof __testDeps> = {}
  for (const k of Object.keys(over) as (keyof typeof __testDeps)[]) {
    orig[k] = __testDeps[k] as any
    ;(__testDeps as any)[k] = (over as any)[k]
  }
  return () => {
    for (const k of Object.keys(orig) as (keyof typeof __testDeps)[]) {
      ;(__testDeps as any)[k] = orig[k]
    }
  }
}

// Deterministic quote stubs (no chain I/O). Numbers are arbitrary but non-zero
// so the open path doesn't bail on a zero-token quote.
const tokenInfoStub = async () => ({
  // Only the fields the fleet paths read.
  fundsWei: 0n,
  graduatedToPancake: false,
  fillPct: 0.1,
  version: 2,
} as any)
const buyQuoteStub = async () => ({
  estimatedAmountWei: 1_000_000n * 10n ** 12n, // ~1e18 tokens
  estimatedCostWei: 10n ** 16n,                // 0.01 BNB
  estimatedFeeWei: 0n,
} as any)

// ───────────────────────────────────────────────────────────────────────────
// 1) OPEN claim: ON CONFLICT partial index — claimed once, skipped on dup.
// ───────────────────────────────────────────────────────────────────────────
test('open claim is atomic: one claim wins, the duplicate is skipped (no second spend)', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — fleet concurrency test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  let liveBuys = 0
  const restore = withDeps({
    getTokenInfo: tokenInfoStub,
    quoteBuyByBnb: buyQuoteStub,
    isFourMemeEnabled: () => true,
    decryptFleetAgentKey: () => '0x' + '1'.repeat(64),
    buyTokenWithBnb: async () => { liveBuys += 1; return { txHash: '0xbuy', estimatedTokensWei: 1n } as any },
  })

  try {
    const agent = makeAgent()
    const cand = makeCandidate()

    // Fire two overlapping opens on the SAME (agent, token), live=true so a
    // lost claim would otherwise mean a real buy. The partial unique index
    // must let exactly one INSERT land.
    const [a, b] = await Promise.all([
      __test.openPosition(agent, cand, true),
      __test.openPosition(agent, cand, true),
    ])

    const claimedCount = [a, b].filter(Boolean).length
    assert.equal(claimedCount, 1, 'exactly one open claim must win; the other must be skipped')
    assert.equal(liveBuys, 1, 'a lost claim must NOT spend — exactly one real buy fired')

    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM "fleet_positions" WHERE "agent_id" = $1 AND "token_address" = $2 AND "status" = 'open'`,
      AGENT_ID, TOKEN.toLowerCase(),
    )
    assert.equal(Number(rows[0].n), 1, 'only one open position row may exist for the pair')

    // A THIRD open while one is still open must also be skipped (steady-state dup).
    const third = await __test.openPosition(agent, cand, true)
    assert.equal(third, false, 'a duplicate open on an already-held token must be skipped')
    assert.equal(liveBuys, 1, 'the steady-state duplicate must not spend either')
  } finally {
    restore()
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 2) CLOSE lock: two overlapping closes — only ONE real sell.
// ───────────────────────────────────────────────────────────────────────────
test('overlapping closes sell once: the CAS lock serializes two exit ticks', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — fleet concurrency test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  // Seed one LIVE (mock=false) open position to close.
  const posId = `fpos_itest_${SUFFIX}`
  await db.$executeRawUnsafe(
    `INSERT INTO "fleet_positions" (
       "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
       "tokens_wei","entry_fill_pct","trust_at_entry","mock","status"
     ) VALUES ($1,$2,$3,2,'10000000000000000',0.01,'1000000000000000000',0.1,80,false,'open')`,
    posId, AGENT_ID, TOKEN.toLowerCase(),
  )

  let liveSells = 0
  const restore = withDeps({
    isFourMemeEnabled: () => true,
    getFleetSettings: async () => ({ liveTrading: true, globalPaused: false, updatedAt: new Date() }),
    decryptFleetAgentKey: () => '0x' + '1'.repeat(64),
    sellTokenForBnb: async () => { liveSells += 1; return { txHash: '0xsell', estimatedBnbWei: 2n * 10n ** 16n } as any },
  })

  try {
    const agent = makeAgent()
    const p = (await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_positions" WHERE "id" = $1`, posId))[0]

    // Two exit ticks pick up the SAME open row (the real CLOSE sweep snapshots
    // open rows first, so both workers hold an identical pre-image) and race.
    const [a, b] = await Promise.all([
      __test.closePosition(p, agent, 0.02, 'take_profit', false),
      __test.closePosition(p, agent, 0.02, 'take_profit', false),
    ])

    const closedCount = [a, b].filter(Boolean).length
    assert.equal(closedCount, 1, 'exactly one close may win the CAS lock')
    assert.equal(liveSells, 1, 'only ONE real sell may fire across two overlapping closes')

    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT "status", "claim_token" FROM "fleet_positions" WHERE "id" = $1`, posId,
    )
    assert.equal(rows[0].status, 'closed', 'the position must end closed')
    assert.equal(rows[0].claim_token, null, 'the lock must be released after close')

    const sells = await db.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM "fleet_trades" WHERE "position_id" = $1 AND "side" = 'sell'`, posId,
    )
    assert.equal(Number(sells[0].n), 1, 'exactly one sell trade row may be written')
  } finally {
    restore()
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 3) PAUSE mid-sweep: kill-switch flips before the sell — fail closed.
// ───────────────────────────────────────────────────────────────────────────
test('global pause flipped mid-precheck fails closed: no sell, position stays open', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — fleet concurrency test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  const posId = `fpos_itest_pause_${SUFFIX}`
  await db.$executeRawUnsafe(
    `INSERT INTO "fleet_positions" (
       "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
       "tokens_wei","entry_fill_pct","trust_at_entry","mock","status"
     ) VALUES ($1,$2,$3,2,'10000000000000000',0.01,'1000000000000000000',0.1,80,false,'open')`,
    posId, AGENT_ID, TOKEN.toLowerCase(),
  )

  let liveSells = 0
  // getFleetSettings is read AFTER the CAS lock is taken, modeling an admin who
  // flips pause between snapshot and sell. It must return paused → fail closed.
  const restore = withDeps({
    isFourMemeEnabled: () => true,
    getFleetSettings: async () => ({ liveTrading: true, globalPaused: true, updatedAt: new Date() }),
    decryptFleetAgentKey: () => '0x' + '1'.repeat(64),
    sellTokenForBnb: async () => { liveSells += 1; return { txHash: '0xsell', estimatedBnbWei: 2n * 10n ** 16n } as any },
  })

  try {
    const agent = makeAgent()
    const p = (await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_positions" WHERE "id" = $1`, posId))[0]

    const closed = await __test.closePosition(p, agent, 0.02, 'take_profit', false)

    assert.equal(closed, false, 'a paused fleet must not close (fail closed)')
    assert.equal(liveSells, 0, 'no real sell may fire while paused')

    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT "status", "claim_token" FROM "fleet_positions" WHERE "id" = $1`, posId,
    )
    assert.equal(rows[0].status, 'open', 'the position must stay open for the admin to handle')
    assert.equal(rows[0].claim_token, null, 'the lock must be released so a later (unpaused) tick can retry')

    const sells = await db.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM "fleet_trades" WHERE "position_id" = $1 AND "side" = 'sell'`, posId,
    )
    assert.equal(Number(sells[0].n), 0, 'no sell trade row may be written while paused')
  } finally {
    restore()
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 4) OPEN buy THROWS: the claim is released so the token is re-claimable.
// ───────────────────────────────────────────────────────────────────────────
// Counterpart to test 1. The claim-before-spend insert reserves the pair BEFORE
// the live buy. If that real buy throws (RPC hang, slippage revert) the engine
// MUST delete its just-inserted claim, or a transient chain error strands the
// token forever (no open bag to sell, but the pair is permanently "held").
test('a failed live buy releases the claim: openPosition re-throws and leaves no open row', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — fleet concurrency test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  let liveBuys = 0
  const restore = withDeps({
    getTokenInfo: tokenInfoStub,
    quoteBuyByBnb: buyQuoteStub,
    isFourMemeEnabled: () => true,
    decryptFleetAgentKey: () => '0x' + '1'.repeat(64),
    buyTokenWithBnb: async () => { liveBuys += 1; throw new Error('boom: slippage revert') },
  })

  try {
    const agent = makeAgent()
    const cand = makeCandidate()

    // The live buy throws — openPosition must propagate the error to the caller
    // (so tickAllFleetAgents counts it as an error and logs it).
    await assert.rejects(
      () => __test.openPosition(agent, cand, true),
      /boom: slippage revert/,
      'openPosition must re-throw the underlying buy error',
    )
    assert.equal(liveBuys, 1, 'the live buy must have been attempted exactly once')

    // The claim must be GONE — no open (or any) position row for the pair, so a
    // later tick can immediately re-claim and retry.
    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM "fleet_positions" WHERE "agent_id" = $1 AND "token_address" = $2`,
      AGENT_ID, TOKEN.toLowerCase(),
    )
    assert.equal(Number(rows[0].n), 0, 'a failed buy must leave NO position row (claim released)')

    // No buy trade row may be written for a buy that never filled.
    const trades = await db.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM "fleet_trades" WHERE "agent_id" = $1 AND "side" = 'buy'`, AGENT_ID,
    )
    assert.equal(Number(trades[0].n), 0, 'no buy trade row may be written for a failed buy')

    // Prove re-claimability: a follow-up open (now succeeding) must land.
    let retryBuys = 0
    const restore2 = withDeps({
      buyTokenWithBnb: async () => { retryBuys += 1; return { txHash: '0xbuy', estimatedTokensWei: 1n } as any },
    })
    try {
      const opened = await __test.openPosition(agent, cand, true)
      assert.equal(opened, true, 'after release, a later tick must be able to re-claim the token')
      assert.equal(retryBuys, 1, 'the retry must fire exactly one real buy')
    } finally {
      restore2()
    }
  } finally {
    restore()
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 5) CLOSE sell THROWS: the lock is released so a later exit tick can retry.
// ───────────────────────────────────────────────────────────────────────────
// Counterpart to test 2. The CAS lock is taken BEFORE the live sell. If that
// real sell throws, the engine MUST release ONLY its own lock (ownership-scoped)
// and leave the position status='open', so a later exit tick re-acquires the
// lock and retries — otherwise a transient chain error strands the position.
test('a failed live sell releases the lock: closePosition re-throws and the position stays open & re-claimable', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — fleet concurrency test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  const posId = `fpos_itest_sellfail_${SUFFIX}`
  await db.$executeRawUnsafe(
    `INSERT INTO "fleet_positions" (
       "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
       "tokens_wei","entry_fill_pct","trust_at_entry","mock","status"
     ) VALUES ($1,$2,$3,2,'10000000000000000',0.01,'1000000000000000000',0.1,80,false,'open')`,
    posId, AGENT_ID, TOKEN.toLowerCase(),
  )

  let liveSells = 0
  const restore = withDeps({
    isFourMemeEnabled: () => true,
    getFleetSettings: async () => ({ liveTrading: true, globalPaused: false, updatedAt: new Date() }),
    decryptFleetAgentKey: () => '0x' + '1'.repeat(64),
    sellTokenForBnb: async () => { liveSells += 1; throw new Error('boom: sell reverted') },
  })

  try {
    const agent = makeAgent()
    const p = (await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_positions" WHERE "id" = $1`, posId))[0]

    await assert.rejects(
      () => __test.closePosition(p, agent, 0.02, 'take_profit', false),
      /boom: sell reverted/,
      'closePosition must re-throw the underlying sell error',
    )
    assert.equal(liveSells, 1, 'the live sell must have been attempted exactly once')

    // The position must be back to a clean open state: status still 'open' and
    // claim_token NULL (lock released), so a later exit tick can re-claim it.
    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT "status", "claim_token" FROM "fleet_positions" WHERE "id" = $1`, posId,
    )
    assert.equal(rows[0].status, 'open', 'a failed sell must leave the position open for retry')
    assert.equal(rows[0].claim_token, null, 'a failed sell must release ONLY our lock (claim_token NULL)')

    // No sell trade row may be written for a sell that never filled.
    const sells = await db.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM "fleet_trades" WHERE "position_id" = $1 AND "side" = 'sell'`, posId,
    )
    assert.equal(Number(sells[0].n), 0, 'no sell trade row may be written for a failed sell')

    // Prove re-claimability: a follow-up close (now succeeding) must close it.
    let retrySells = 0
    const restore2 = withDeps({
      sellTokenForBnb: async () => { retrySells += 1; return { txHash: '0xsell', estimatedBnbWei: 2n * 10n ** 16n } as any },
    })
    try {
      const p2 = (await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_positions" WHERE "id" = $1`, posId))[0]
      const closed = await __test.closePosition(p2, agent, 0.02, 'take_profit', false)
      assert.equal(closed, true, 'after release, a later exit tick must be able to re-claim and close')
      assert.equal(retrySells, 1, 'the retry must fire exactly one real sell')
    } finally {
      restore2()
    }
  } finally {
    restore()
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 6) getTodayStats: the daily cap / loss brake feed must count ONLY today's
//    filled buys, and sum ONLY today's realized PnL. agentOpenGate() trusts
//    these numbers blindly, so a query drift (counting unfilled/sell rows as
//    buys, or leaking yesterday's trades) would silently break both guards.
//    Mocking can't prove the SQL filters — this drives the REAL query against
//    REAL Postgres with deliberately mixed rows.
// ───────────────────────────────────────────────────────────────────────────
test('getTodayStats counts only today\'s filled buys and sums only today\'s PnL', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — getTodayStats test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  // Insert a fleet_trades row with an explicit created_at so we can straddle
  // the day boundary. Only the columns getTodayStats reads matter.
  let seq = 0
  async function seedTrade(opts: {
    side: 'buy' | 'sell'
    status: 'filled' | 'pending' | 'failed'
    pnl: number | null
    createdAt: string // SQL expression, e.g. "NOW()" or "NOW() - INTERVAL '1 day'"
  }): Promise<void> {
    seq += 1
    await db.$executeRawUnsafe(
      `INSERT INTO "fleet_trades" (
         "id","agent_id","side","token_address","pnl_bnb","status","created_at"
       ) VALUES ($1,$2,$3,$4,$5,$6, ${opts.createdAt})`,
      `ftrade_itest_${SUFFIX}_${seq}`, AGENT_ID, opts.side, TOKEN.toLowerCase(),
      opts.pnl, opts.status,
    )
  }

  try {
    // ── Today's rows ──────────────────────────────────────────────────────
    // 2 filled buys today → these are the ONLY rows that may bump the buy count.
    await seedTrade({ side: 'buy', status: 'filled', pnl: null, createdAt: 'NOW()' })
    await seedTrade({ side: 'buy', status: 'filled', pnl: null, createdAt: 'NOW()' })
    // 1 filled sell today carrying realized PnL → counts toward PnL, NOT buys.
    await seedTrade({ side: 'sell', status: 'filled', pnl: 0.5, createdAt: 'NOW()' })
    // 1 filled sell today with a loss → PnL must net these together.
    await seedTrade({ side: 'sell', status: 'filled', pnl: -0.2, createdAt: 'NOW()' })
    // 1 UNFILLED buy today → must NOT count as a buy (status != 'filled').
    await seedTrade({ side: 'buy', status: 'pending', pnl: null, createdAt: 'NOW()' })

    // ── Yesterday's rows (must be fully excluded by the day-boundary filter) ─
    await seedTrade({ side: 'buy', status: 'filled', pnl: 99, createdAt: "NOW() - INTERVAL '1 day'" })
    await seedTrade({ side: 'sell', status: 'filled', pnl: 99, createdAt: "NOW() - INTERVAL '1 day'" })

    const stats = await getTodayStats()
    const mine = stats.get(AGENT_ID)
    assert.ok(mine, 'getTodayStats must return a row for the seeded agent')

    // Only the 2 today-filled buys count — not the sells, not the unfilled buy,
    // and not yesterday's filled buy.
    assert.equal(mine!.buys, 2, 'buy count must be exactly today\'s filled buys')

    // PnL nets today's realized PnL (0.5 + -0.2 = 0.3) and excludes yesterday.
    assert.ok(Math.abs(mine!.pnl - 0.3) < 1e-9, `PnL must sum only today's pnl_bnb (got ${mine!.pnl})`)
  } finally {
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 7) CRASH mid-sell: a stale claim is reaped so a later exit tick can retry.
// ───────────────────────────────────────────────────────────────────────────
// Tests 2 & 5 cover the cases where a sell completes or THROWS — both run the
// ownership-scoped release in JS. But a worker that CRASHES mid-sell (process
// killed, OOM, pod evicted) runs NO catch: claim_token stays set forever, and
// because closePosition's CAS requires `claim_token IS NULL`, that bag is frozen
// — never re-claimable, the position stranded. The exit sweep's stale-claim
// reaper is the only out-of-band recovery: a claim held past the lease is
// cleared so a later tick re-acquires the lock and retries. This proves it.
test('a crashed-worker stale claim is reaped: the position becomes re-claimable and a later tick can close it', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — fleet concurrency test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  // Seed an open LIVE position that is FROZEN: claim_token set but claim_at far
  // in the past — exactly the footprint a worker killed mid-sell leaves behind
  // (the catch/finally that would have released the lock never ran).
  const posId = `fpos_itest_crash_${SUFFIX}`
  const staleTok = 'fcl_crashed_worker_token'
  await db.$executeRawUnsafe(
    `INSERT INTO "fleet_positions" (
       "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
       "tokens_wei","entry_fill_pct","trust_at_entry","mock","status",
       "claim_token","claim_at"
     ) VALUES ($1,$2,$3,2,'10000000000000000',0.01,'1000000000000000000',0.1,80,false,'open',
       $4, now() - interval '1 hour')`,
    posId, AGENT_ID, TOKEN.toLowerCase(), staleTok,
  )

  try {
    const agent = makeAgent()

    // Before the reaper runs, the frozen claim blocks the CAS lock entirely: a
    // close attempt can't acquire the lock, so it bails without selling — the
    // bag really is stranded.
    let blockedSells = 0
    const restoreBlocked = withDeps({
      isFourMemeEnabled: () => true,
      getFleetSettings: async () => ({ liveTrading: true, globalPaused: false, updatedAt: new Date() }),
      decryptFleetAgentKey: () => '0x' + '1'.repeat(64),
      sellTokenForBnb: async () => { blockedSells += 1; return { txHash: '0xsell', estimatedBnbWei: 2n * 10n ** 16n } as any },
    })
    try {
      const frozen = (await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_positions" WHERE "id" = $1`, posId))[0]
      const blocked = await __test.closePosition(frozen, agent, 0.02, 'take_profit', false)
      assert.equal(blocked, false, 'a frozen (stale-claim) position must NOT be closable — the CAS lock is held')
      assert.equal(blockedSells, 0, 'no sell may fire while the stale claim still blocks the lock')
    } finally {
      restoreBlocked()
    }

    // The reaper (run at the top of every exit sweep) clears the stale claim.
    await __test.reapStaleExitClaims()

    const afterReap = await db.$queryRawUnsafe<any[]>(
      `SELECT "status", "claim_token", "claim_at" FROM "fleet_positions" WHERE "id" = $1`, posId,
    )
    assert.equal(afterReap[0].status, 'open', 'the reaper must leave the position OPEN (only clears the lock)')
    assert.equal(afterReap[0].claim_token, null, 'the stale claim_token must be cleared')
    assert.equal(afterReap[0].claim_at, null, 'the stale claim_at must be cleared')

    // Now a later exit tick can re-acquire the lock and actually sell.
    let retrySells = 0
    const restore = withDeps({
      isFourMemeEnabled: () => true,
      getFleetSettings: async () => ({ liveTrading: true, globalPaused: false, updatedAt: new Date() }),
      decryptFleetAgentKey: () => '0x' + '1'.repeat(64),
      sellTokenForBnb: async () => { retrySells += 1; return { txHash: '0xsell', estimatedBnbWei: 2n * 10n ** 16n } as any },
    })
    try {
      const p = (await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fleet_positions" WHERE "id" = $1`, posId))[0]
      const closed = await __test.closePosition(p, agent, 0.02, 'take_profit', false)
      assert.equal(closed, true, 'after the reaper clears the stale claim, the bag must be closable')
      assert.equal(retrySells, 1, 'the retry must fire exactly one real sell')

      const rows = await db.$queryRawUnsafe<any[]>(
        `SELECT "status", "claim_token" FROM "fleet_positions" WHERE "id" = $1`, posId,
      )
      assert.equal(rows[0].status, 'closed', 'the position must end closed after the retry')
      assert.equal(rows[0].claim_token, null, 'the lock must be released after the successful close')
    } finally {
      restore()
    }
  } finally {
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 8) The reaper must NOT touch a FRESH claim (a still-running slow sell).
// ───────────────────────────────────────────────────────────────────────────
// The lease (default 5 min) exists so a healthy but slow live sell (RPC hang)
// is never disturbed mid-flight — reaping it could let a second worker double
// sell the same bag. A claim younger than the lease must survive the reaper.
test('the reaper leaves a fresh claim alone: a still-running sell is never reaped (no double-sell window)', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — fleet concurrency test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  const posId = `fpos_itest_fresh_${SUFFIX}`
  const freshTok = 'fcl_inflight_sell_token'
  // claim_at = now() models a sell that is actively in flight right now.
  await db.$executeRawUnsafe(
    `INSERT INTO "fleet_positions" (
       "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
       "tokens_wei","entry_fill_pct","trust_at_entry","mock","status",
       "claim_token","claim_at"
     ) VALUES ($1,$2,$3,2,'10000000000000000',0.01,'1000000000000000000',0.1,80,false,'open',
       $4, now())`,
    posId, AGENT_ID, TOKEN.toLowerCase(), freshTok,
  )

  try {
    await __test.reapStaleExitClaims()

    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT "claim_token" FROM "fleet_positions" WHERE "id" = $1`, posId,
    )
    assert.equal(rows[0].claim_token, freshTok, 'a fresh (in-lease) claim must be left untouched by the reaper')
  } finally {
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 9) getOpenPositionCounts / getOpenTokensByAgent: the open-position cap and
//    held-token dedupe feeds must count ONLY open rows, per agent, and the
//    held-token set must be lowercase-normalized. agentOpenGate() trusts these
//    blindly: if the count leaked closed positions the per-agent max-positions
//    cap would over-count and starve the agent; if the held-token set missed a
//    token (or kept it mixed-case) the dedupe would let the agent re-buy a bag
//    it already holds. Mocking can't prove the SQL filters or the lowercasing —
//    this drives the REAL queries against REAL Postgres with deliberately mixed
//    rows (open + closed, two agents, mixed-case tokens).
// ───────────────────────────────────────────────────────────────────────────
test('getOpenPositionCounts/getOpenTokensByAgent count only open rows per agent and lowercase tokens', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — open-position guards test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  // A second agent so we can prove counts/sets are partitioned per agent.
  const AGENT_B = `__itest_fleet_agentB_${SUFFIX}`
  // Distinct tokens. TOKEN_MIXED has uppercase hex so we can prove the queries
  // lowercase-normalize (the held-token dedupe compares lowercased addresses).
  const TOKEN_1 = '0x' + 'c'.repeat(40)
  const TOKEN_2 = '0x' + 'd'.repeat(40)
  const TOKEN_3 = '0x' + 'e'.repeat(40)
  const TOKEN_MIXED = '0x' + 'AbCdEf'.repeat(6) + 'AbCd' // 40 mixed-case hex chars

  let pseq = 0
  async function seedPos(opts: {
    agentId: string
    token: string
    status: 'open' | 'closed'
  }): Promise<void> {
    pseq += 1
    await db.$executeRawUnsafe(
      `INSERT INTO "fleet_positions" (
         "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
         "tokens_wei","entry_fill_pct","trust_at_entry","mock","status"
       ) VALUES ($1,$2,$3,2,'10000000000000000',0.01,'1000000000000000000',0.1,80,false,$4)`,
      `fpos_itest_open_${SUFFIX}_${pseq}`, opts.agentId, opts.token, opts.status,
    )
  }

  try {
    // Agent A: 3 open positions (one with a mixed-case address) + 1 closed.
    await seedPos({ agentId: AGENT_ID, token: TOKEN_1, status: 'open' })
    await seedPos({ agentId: AGENT_ID, token: TOKEN_2, status: 'open' })
    await seedPos({ agentId: AGENT_ID, token: TOKEN_MIXED, status: 'open' })
    await seedPos({ agentId: AGENT_ID, token: TOKEN_3, status: 'closed' })
    // Agent B: 1 open + 1 closed — proves per-agent partitioning, and that a
    // closed row never inflates either feed.
    await seedPos({ agentId: AGENT_B, token: TOKEN_1, status: 'open' })
    await seedPos({ agentId: AGENT_B, token: TOKEN_2, status: 'closed' })

    // ── Open-position cap feed ────────────────────────────────────────────
    const counts = await getOpenPositionCounts()
    assert.equal(counts.get(AGENT_ID), 3, 'agent A must count exactly its 3 OPEN positions (closed excluded)')
    assert.equal(counts.get(AGENT_B), 1, 'agent B must count exactly its 1 OPEN position (closed excluded)')

    // ── Held-token dedupe feed ────────────────────────────────────────────
    const held = await getOpenTokensByAgent()
    const aSet = held.get(AGENT_ID)
    const bSet = held.get(AGENT_B)
    assert.ok(aSet, 'agent A must have a held-token set')
    assert.ok(bSet, 'agent B must have a held-token set')

    // Agent A holds exactly the 3 OPEN tokens, all lowercased; the closed
    // token must NOT appear.
    assert.deepEqual(
      new Set(aSet),
      new Set([TOKEN_1.toLowerCase(), TOKEN_2.toLowerCase(), TOKEN_MIXED.toLowerCase()]),
      'agent A held-token set must be exactly its open tokens, lowercased',
    )
    assert.ok(!aSet!.has(TOKEN_3.toLowerCase()), 'a closed-position token must never appear in the held set')
    // Explicit lowercase proof: the mixed-case address must be normalized.
    assert.ok(aSet!.has(TOKEN_MIXED.toLowerCase()), 'a mixed-case token must be lowercased into the held set')
    assert.ok(!aSet!.has(TOKEN_MIXED), 'the raw mixed-case form must NOT be present (only the lowercased form)')

    // Agent B holds only its single open token; its closed token is excluded.
    assert.deepEqual(new Set(bSet), new Set([TOKEN_1.toLowerCase()]),
      'agent B held-token set must be exactly its one open token')
  } finally {
    // cleanup() only knows AGENT_ID; remove agent B's rows explicitly too.
    await cleanup()
    try { await db.$executeRawUnsafe(`DELETE FROM "fleet_positions" WHERE "agent_id" = $1`, AGENT_B) } catch { /* best-effort */ }
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 10) END-TO-END open-gate cap: getOpenPositionCounts() → agentOpenGate().
//     Test 9 proves the COUNT query in isolation; this proves the COMPOSITION
//     that production actually runs (tickAllFleetAgents): the real per-agent
//     open count is fed straight into agentOpenGate(), which must return
//     'max_positions' once the cap is reached and stay clear below it. A
//     regression in either the threshold comparison or the count wiring would
//     let an agent exceed maxPositions. Driven against REAL Postgres.
// ───────────────────────────────────────────────────────────────────────────
test('open-gate enforces the cap end-to-end: real open count at maxPositions blocks, below it clears', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — open-gate cap test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  // Agent with an explicit small cap so we can straddle it precisely.
  const agent = makeAgent()
  agent.maxPositions = 2

  let pseq = 0
  async function seedOpen(token: string): Promise<void> {
    pseq += 1
    await db.$executeRawUnsafe(
      `INSERT INTO "fleet_positions" (
         "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
         "tokens_wei","entry_fill_pct","trust_at_entry","mock","status"
       ) VALUES ($1,$2,$3,2,'10000000000000000',0.01,'1000000000000000000',0.1,80,false,'open')`,
      `fpos_itest_cap_${SUFFIX}_${pseq}`, agent.id, token,
    )
  }

  try {
    // ── Below the cap (1 open < cap 2): the real count must clear the gate. ──
    await seedOpen('0x' + '1'.repeat(40))
    let counts = await getOpenPositionCounts()
    assert.equal(counts.get(agent.id), 1, 'precondition: exactly one open position seeded')
    assert.equal(
      agentOpenGate(agent, undefined, counts.get(agent.id) ?? 0),
      null,
      'below the cap the real open count must leave the gate clear',
    )

    // ── At the cap (2 open === cap 2): the gate must block with max_positions.─
    await seedOpen('0x' + '2'.repeat(40))
    counts = await getOpenPositionCounts()
    assert.equal(counts.get(agent.id), 2, 'precondition: a second open position seeded (now at the cap)')
    assert.equal(
      agentOpenGate(agent, undefined, counts.get(agent.id) ?? 0),
      'max_positions',
      'at the cap the real open count must block the open with max_positions',
    )

    // ── Over the cap (3 open > cap 2): a closed row must NOT relieve the cap.─
    // Add a third OPEN and a CLOSED row; only the opens count, so we stay over.
    await seedOpen('0x' + '3'.repeat(40))
    await db.$executeRawUnsafe(
      `INSERT INTO "fleet_positions" (
         "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
         "tokens_wei","entry_fill_pct","trust_at_entry","mock","status"
       ) VALUES ($1,$2,$3,2,'10000000000000000',0.01,'1000000000000000000',0.1,80,false,'closed')`,
      `fpos_itest_cap_${SUFFIX}_closed`, agent.id, '0x' + '4'.repeat(40),
    )
    counts = await getOpenPositionCounts()
    assert.equal(counts.get(agent.id), 3, 'a closed position must not be counted — only the 3 opens')
    assert.equal(
      agentOpenGate(agent, undefined, counts.get(agent.id) ?? 0),
      'max_positions',
      'over the cap the gate must keep blocking (closed rows do not relieve the cap)',
    )
  } finally {
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 11) END-TO-END held-token dedupe: getOpenTokensByAgent() → pickCandidate().
//     Test 9 proves the held-token SET query (incl. lowercasing) in isolation;
//     this proves the COMPOSITION production runs: the real held-token set is
//     fed into pickCandidate(), which must SKIP any candidate whose token the
//     agent already holds — case-insensitively, since on-chain addresses arrive
//     in mixed case but the held set is lowercased. A regression in the
//     dedupe wiring would let an agent re-buy a bag it already holds. Driven
//     against REAL Postgres.
// ───────────────────────────────────────────────────────────────────────────
test('open-gate dedupes held tokens end-to-end: a candidate the agent already holds is skipped case-insensitively', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — open-gate dedupe test skipped'); return }
  await ensureFleetTables()
  await cleanup()

  const agent = makeAgent() // momentum, minTrust 0 — makeCandidate() passes its filter

  // The agent already holds this token. It is stored MIXED-CASE on the row so
  // we prove the held set is lowercased AND the dedupe compares lowercased.
  const HELD_MIXED = '0x' + 'AbCdEf'.repeat(6) + 'AbCd' // 40 mixed-case hex chars
  const FRESH = '0x' + 'f'.repeat(40)                   // a token the agent does NOT hold

  await db.$executeRawUnsafe(
    `INSERT INTO "fleet_positions" (
       "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
       "tokens_wei","entry_fill_pct","trust_at_entry","mock","status"
     ) VALUES ($1,$2,$3,2,'10000000000000000',0.01,'1000000000000000000',0.1,80,false,'open')`,
    `fpos_itest_dedupe_${SUFFIX}`, agent.id, HELD_MIXED,
  )

  try {
    // The REAL held-token feed the open sweep consults for this agent.
    const held = (await getOpenTokensByAgent()).get(agent.id) ?? new Set<string>()
    assert.ok(held.has(HELD_MIXED.toLowerCase()), 'precondition: the held set carries the lowercased held token')

    // A candidate for the SAME token, but presented UPPER-CASE (as an on-chain
    // address might arrive). The dedupe must still skip it.
    const heldCand = makeCandidate()
    heldCand.tokenAddress = HELD_MIXED.toUpperCase()
    assert.equal(
      __test.pickCandidate(agent, [heldCand], new Set<string>(), held),
      null,
      'a candidate whose token the agent already holds must be skipped (case-insensitively)',
    )

    // A candidate for a DIFFERENT token must NOT be skipped — proves the dedupe
    // only blocks the held token, not every candidate.
    const freshCand = makeCandidate()
    freshCand.tokenAddress = FRESH
    const picked = __test.pickCandidate(agent, [freshCand], new Set<string>(), held)
    assert.ok(picked, 'a candidate for a token the agent does NOT hold must be eligible')
    assert.equal(picked!.tokenAddress, FRESH, 'the eligible (un-held) candidate must be the one picked')

    // With BOTH offered, the held one is filtered out and the fresh one wins —
    // the full composition end-to-end.
    const both = __test.pickCandidate(agent, [heldCand, freshCand], new Set<string>(), held)
    assert.ok(both, 'with a held + a fresh candidate offered, one must still be pickable')
    assert.equal(both!.tokenAddress, FRESH, 'the held candidate is deduped out; only the fresh one is picked')
  } finally {
    await cleanup()
  }
})

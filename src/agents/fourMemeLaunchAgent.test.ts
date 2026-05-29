/**
 * fourMemeLaunchAgent — dev-bag TP-sweep CRASH-STRANDED-CLAIM safety net.
 *
 * The take-profit sweep uses `sold_tx_hash` as a CAS lock: before any
 * on-chain sell it stamps a "__claim_<epoch_ms>_<rand>__" sentinel so a
 * second worker hitting the same row bails. On success the sentinel is
 * overwritten with the real tx hash; on a retryable failure it is reset
 * to NULL; on a terminal failure it is replaced by a "[skipped: …]"
 * sentinel. But a worker that CRASHES mid-sell (process killed, OOM, pod
 * evicted) runs NO catch/finally, so the claim sentinel is left set
 * forever — and because the sweep SELECT filters `sold_tx_hash IS NULL`,
 * that bag is frozen and can never be sold again.
 *
 * `reapStaleTpClaims` is the only out-of-band recovery: a claim sentinel
 * whose embedded timestamp is older than the lease is cleared so a later
 * sweep can re-claim and retry. token_launches has no separate claim_at
 * column, so the claim time is parsed straight out of the sentinel.
 *
 * This suite drives the REAL reaper against a REAL Postgres so we prove
 * the SQL (regex extract + lease compare) actually works, not just a JS
 * branch. It skips cleanly when no DB is reachable, so it never blocks CI
 * in a Postgres-less environment.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../db'
import { __test } from './fourMemeLaunchAgent'

async function dbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  try {
    await db.$queryRawUnsafe('SELECT 1')
    return true
  } catch {
    return false
  }
}

// Minimal mirror of ensureTables' token_launches columns the reaper
// touches. Idempotent so it is safe on a populated dev DB.
async function ensureLaunchTable(): Promise<void> {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "token_launches" (
    "id" TEXT PRIMARY KEY,
    "user_id" TEXT,
    "agent_id" TEXT,
    "token_name" TEXT NOT NULL DEFAULT 'itest',
    "token_symbol" TEXT NOT NULL DEFAULT 'ITEST',
    "token_address" TEXT,
    "initial_liquidity_bnb" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sold_at" TIMESTAMPTZ,
    "sold_proceeds_bnb" TEXT,
    "sold_tx_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await db.$executeRawUnsafe(`ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "sold_at" TIMESTAMPTZ`)
  await db.$executeRawUnsafe(`ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "sold_tx_hash" TEXT`)
}

const SUFFIX = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const AGENT_ID = `__itest_launch_agent_${SUFFIX}`

async function cleanup(): Promise<void> {
  try {
    await db.$executeRawUnsafe(`DELETE FROM "token_launches" WHERE "agent_id" = $1`, AGENT_ID)
  } catch { /* best-effort */ }
}

// A claim sentinel exactly like the TP sweep stamps, but with a caller-
// supplied epoch (ms) so we can age it past / inside the lease.
function claimSentinel(epochMs: number): string {
  return `__claim_${epochMs}_${Math.random().toString(36).slice(2, 6)}__`
}

// ───────────────────────────────────────────────────────────────────────────
// 1) CRASH mid-sell: a stale claim sentinel is reaped so a later sweep retries.
// ───────────────────────────────────────────────────────────────────────────
test('a crashed-worker stale TP claim is reaped: the row becomes re-claimable', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — launch reaper test skipped'); return }
  await ensureLaunchTable()
  await cleanup()

  // Seed a FROZEN held position: launched, not yet sold, but holding a
  // claim sentinel whose embedded timestamp is far past the lease — the
  // exact footprint a worker killed mid-sell leaves behind (none of the
  // release paths ever ran).
  const rowId = `tlaunch_itest_crash_${SUFFIX}`
  const lease = __test.TP_CLAIM_LEASE_SEC
  const staleEpoch = Date.now() - (lease + 600) * 1000 // well past the lease
  const staleClaim = claimSentinel(staleEpoch)
  await db.$executeRawUnsafe(
    `INSERT INTO "token_launches"
       ("id","agent_id","user_id","platform","chain_id","token_name","token_symbol",
        "token_address","initial_liquidity_bnb","status","sold_tx_hash")
     VALUES ($1,$2,'u_itest','four_meme',56,'itest','ITEST','0x' || repeat('a',40),
        '0.01','launched',$3)`,
    rowId, AGENT_ID, staleClaim,
  )

  try {
    await __test.reapStaleTpClaims()

    const after = await db.$queryRawUnsafe<any[]>(
      `SELECT "status", "sold_at", "sold_tx_hash" FROM "token_launches" WHERE "id" = $1`, rowId,
    )
    assert.equal(after[0].status, 'launched', 'the reaper must leave the row launched (only clears the lock)')
    assert.equal(after[0].sold_at, null, 'the reaper must NOT mark the row sold')
    assert.equal(after[0].sold_tx_hash, null, 'the stale claim sentinel must be cleared so the sweep can re-claim')
  } finally {
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 2) The reaper must NOT touch a FRESH claim (a still-running slow sell).
// ───────────────────────────────────────────────────────────────────────────
// The lease exists so a healthy-but-slow live sell (RPC hang) is never
// disturbed mid-flight — reaping it could let a second worker double-sell
// the same bag. A claim younger than the lease must survive the reaper.
test('the reaper leaves a fresh TP claim alone: no double-sell window', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — launch reaper test skipped'); return }
  await ensureLaunchTable()
  await cleanup()

  const rowId = `tlaunch_itest_fresh_${SUFFIX}`
  const freshClaim = claimSentinel(Date.now()) // in-flight right now
  await db.$executeRawUnsafe(
    `INSERT INTO "token_launches"
       ("id","agent_id","user_id","platform","chain_id","token_name","token_symbol",
        "token_address","initial_liquidity_bnb","status","sold_tx_hash")
     VALUES ($1,$2,'u_itest','four_meme',56,'itest','ITEST','0x' || repeat('a',40),
        '0.01','launched',$3)`,
    rowId, AGENT_ID, freshClaim,
  )

  try {
    await __test.reapStaleTpClaims()

    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT "sold_tx_hash" FROM "token_launches" WHERE "id" = $1`, rowId,
    )
    assert.equal(rows[0].sold_tx_hash, freshClaim, 'a fresh (in-lease) claim must be left untouched by the reaper')
  } finally {
    await cleanup()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 3) The reaper must NEVER touch a legitimately SOLD or CLOSED row.
// ───────────────────────────────────────────────────────────────────────────
// Real tx hashes start with "0x" and skip sentinels with "[skipped:" —
// neither matches the "__claim_…" pattern, and both stamp sold_at. The
// reaper must not resurrect a completed position even if it is stale.
test('the reaper never disturbs a sold or permanently-closed row', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres (DATABASE_URL) — launch reaper test skipped'); return }
  await ensureLaunchTable()
  await cleanup()

  const soldId = `tlaunch_itest_sold_${SUFFIX}`
  const skipId = `tlaunch_itest_skip_${SUFFIX}`
  const realTx = '0x' + 'd'.repeat(64)
  await db.$executeRawUnsafe(
    `INSERT INTO "token_launches"
       ("id","agent_id","user_id","platform","chain_id","token_name","token_symbol",
        "token_address","initial_liquidity_bnb","status","sold_at","sold_proceeds_bnb","sold_tx_hash")
     VALUES
       ($1,$3,'u_itest','four_meme',56,'itest','ITEST','0x' || repeat('a',40),'0.01','launched',
        now() - interval '1 hour','0.02',$4),
       ($2,$3,'u_itest','four_meme',56,'itest','ITEST','0x' || repeat('b',40),'0.01','launched',
        now() - interval '1 hour','0','[skipped: graduated]')`,
    soldId, skipId, AGENT_ID, realTx,
  )

  try {
    await __test.reapStaleTpClaims()

    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT "id", "sold_tx_hash" FROM "token_launches" WHERE "id" IN ($1,$2) ORDER BY "id"`,
      soldId, skipId,
    )
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.sold_tx_hash]))
    assert.equal(byId[soldId], realTx, 'a genuinely sold row (real tx hash) must be untouched')
    assert.equal(byId[skipId], '[skipped: graduated]', 'a permanently-closed (skipped) row must be untouched')
  } finally {
    await cleanup()
  }
})

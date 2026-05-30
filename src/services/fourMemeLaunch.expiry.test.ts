/**
 * BUILD4 × four.meme — approval-expiry sweeper REGRESSION TEST.
 *
 * Why this exists: `expireStalePendingApprovals` is the only thing standing
 * between an inattentive owner and a permanently-blocked launch agent. A row
 * stuck in `pending_user_approval` keeps the dedup gate closed forever; this
 * sweeper flips rows past their TTL to `expired` so the next agent tick can
 * proceed. Nothing covered its TTL math, its env-var override, or its
 * silent-on-missing-table contract, so a future SQL/env refactor could quietly
 * break the unblock guarantee with no test failing.
 *
 * Two of the three tests hit a REAL Postgres (DATABASE_URL): they seed
 * `token_launches` rows of varying ages under a per-process sentinel wallet,
 * run the real helper, and assert exactly which rows flipped. They skip
 * cleanly (never fail) when no DB is reachable or the table is absent, so the
 * suite is safe in DB-less environments. The table-missing test uses a spy so
 * it proves the no-op contract WITHOUT dropping the shared real table.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../db'
import { expireStalePendingApprovals } from './fourMemeLaunch'

// Per-process sentinel so concurrent test runs / real data are never touched.
const WALLET = `0x${'e'.repeat(39)}${(process.pid % 10)}`
const ENV_KEY = 'FOUR_MEME_APPROVAL_TTL_HOURS'

type SeedRow = { id: string; status: string; ageHours: number }

async function tableExists(): Promise<boolean> {
  try {
    const r = await db.$queryRawUnsafe<{ t: string | null }[]>(
      "SELECT to_regclass('public.token_launches')::text AS t",
    )
    return !!r?.[0]?.t
  } catch {
    return false
  }
}

async function reachable(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1')
    return true
  } catch {
    return false
  }
}

async function seed(rows: SeedRow[]): Promise<void> {
  for (const row of rows) {
    await db.$executeRawUnsafe(
      `INSERT INTO "token_launches"
         ("id","creator_wallet","platform","chain_id","token_name","token_symbol","initial_liquidity_bnb","status","created_at")
       VALUES ($1,$2,'four_meme',56,'Sweeper Test','SWEEP','0',$3, now() - ($4 || ' hours')::interval)`,
      row.id,
      WALLET,
      row.status,
      String(row.ageHours),
    )
  }
}

async function statusOf(id: string): Promise<string | null> {
  const r = await db.$queryRawUnsafe<{ status: string }[]>(
    'SELECT "status" FROM "token_launches" WHERE "id" = $1',
    id,
  )
  return r?.[0]?.status ?? null
}

async function cleanup(): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM "token_launches" WHERE "creator_wallet" = $1', WALLET)
}

test('sweeper flips only pending_user_approval rows past the TTL', async (t) => {
  if (!(await reachable())) {
    t.skip('No reachable Postgres (DATABASE_URL) — sweeper TTL test skipped')
    return
  }
  if (!(await tableExists())) {
    t.skip('token_launches table absent — sweeper TTL test skipped')
    return
  }

  const prefix = `__itest_ttl_${process.pid}_`
  const fresh = `${prefix}fresh` // 1h old, well inside TTL → stays pending
  const edge = `${prefix}edge` // 23h old, still inside 24h TTL → stays pending
  const stale = `${prefix}stale` // 25h old, past TTL → flips to expired
  const ancient = `${prefix}ancient` // 100h old, far past TTL → flips to expired
  const oldButLaunched = `${prefix}launched` // 100h old but NOT pending → untouched
  const oldButFailed = `${prefix}failed` // 100h old but NOT pending → untouched

  await cleanup()
  try {
    await seed([
      { id: fresh, status: 'pending_user_approval', ageHours: 1 },
      { id: edge, status: 'pending_user_approval', ageHours: 23 },
      { id: stale, status: 'pending_user_approval', ageHours: 25 },
      { id: ancient, status: 'pending_user_approval', ageHours: 100 },
      { id: oldButLaunched, status: 'launched', ageHours: 100 },
      { id: oldButFailed, status: 'failed', ageHours: 100 },
    ])

    const flipped = await expireStalePendingApprovals(24)

    // Exactly the two stale pending rows flip — not the fresh/edge pending
    // rows, and not the old-but-already-resolved rows.
    assert.equal(flipped, 2, 'should flip exactly the two stale pending rows')

    assert.equal(await statusOf(fresh), 'pending_user_approval')
    assert.equal(await statusOf(edge), 'pending_user_approval')
    assert.equal(await statusOf(stale), 'expired')
    assert.equal(await statusOf(ancient), 'expired')
    assert.equal(await statusOf(oldButLaunched), 'launched')
    assert.equal(await statusOf(oldButFailed), 'failed')

    // Idempotent: a second sweep flips nothing (the rows are no longer pending).
    const second = await expireStalePendingApprovals(24)
    assert.equal(second, 0, 'second sweep is a no-op')
  } finally {
    await cleanup()
  }
})

test('sweeper honors the FOUR_MEME_APPROVAL_TTL_HOURS env override', async (t) => {
  if (!(await reachable())) {
    t.skip('No reachable Postgres (DATABASE_URL) — env override test skipped')
    return
  }
  if (!(await tableExists())) {
    t.skip('token_launches table absent — env override test skipped')
    return
  }

  const prefix = `__itest_env_${process.pid}_`
  const young = `${prefix}young` // 1h old → inside the 2h override TTL → stays
  const old = `${prefix}old` // 3h old → past the 2h override TTL → flips
  const prev = process.env[ENV_KEY]

  await cleanup()
  try {
    await seed([
      { id: young, status: 'pending_user_approval', ageHours: 1 },
      { id: old, status: 'pending_user_approval', ageHours: 3 },
    ])

    // With a 2h override, the default 24h would flip NOTHING — so a flip here
    // proves the env value (not the default) drove the interval.
    process.env[ENV_KEY] = '2'
    const flipped = await expireStalePendingApprovals()

    assert.equal(flipped, 1, 'only the 3h-old row exceeds the 2h env TTL')
    assert.equal(await statusOf(young), 'pending_user_approval')
    assert.equal(await statusOf(old), 'expired')
  } finally {
    if (prev != null) process.env[ENV_KEY] = prev
    else delete process.env[ENV_KEY]
    await cleanup()
  }
})

test('sweeper returns 0 (does not throw) when the table is missing', async () => {
  // Drop the shared real table is not an option — swap the raw writer with a
  // spy that throws the exact Postgres "relation does not exist" error so we
  // exercise the helper's catch path without touching real data.
  const original = db.$executeRawUnsafe
  ;(db as any).$executeRawUnsafe = async () => {
    throw new Error('relation "token_launches" does not exist')
  }
  try {
    const n = await expireStalePendingApprovals(24)
    assert.equal(n, 0, 'missing table must be a silent no-op returning 0')
  } finally {
    ;(db as any).$executeRawUnsafe = original
  }
})

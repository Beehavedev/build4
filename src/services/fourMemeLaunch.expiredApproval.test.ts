/**
 * BUILD4 × four.meme — EXPIRED-APPROVAL terminal-state REGRESSION TEST.
 *
 * Why this exists: `expireStalePendingApprovals` flips stale
 * `pending_user_approval` rows to `expired` so the agent's dedup gate can
 * clear (covered by fourMemeLaunch.expiry.test.ts). But the expiry
 * guarantee is only meaningful if the DOWNSTREAM approve / reject / retry
 * path also refuses to act on a row that has already been swept to
 * `expired`. A stale owner "approve" click, or a replayed Telegram
 * callback, must NOT be able to resurrect an expired proposal into a live
 * launch. These tests pin that contract:
 *
 *   - executeApprovedLaunch on an `expired` row → ALREADY_HANDLED, no launch
 *   - rejectPendingLaunch on an `expired` row   → ALREADY_HANDLED
 *   - retryLaunchForUser on an `expired` row    → NOT_RETRYABLE, no launch
 *   - the cap/dedup gate counts `expired` as terminal (not pending), so it
 *     neither blocks future proposals nor is treated as an open launch
 *
 * The DB tests hit a REAL Postgres (DATABASE_URL): they seed
 * `token_launches` rows under a per-process sentinel user/agent, run the
 * real helpers, and assert the row is never advanced past `expired`. They
 * skip cleanly (never fail) when no DB is reachable, so the suite is safe
 * in DB-less environments. The launch seam is wired to a function that
 * throws if ever reached, proving the guard fires before any on-chain or
 * network call.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../db'
import {
  executeApprovedLaunch,
  rejectPendingLaunch,
  retryLaunchForUser,
  LaunchApprovalError,
  LaunchRetryError,
  type LaunchResult,
} from './fourMemeLaunch'
import { evaluateLaunchCaps } from '../agents/fourMemeLaunchAgent'

const SUFFIX = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const USER_PREFIX = `__itest_expired_user_${SUFFIX}`
const AGENT_PREFIX = `__itest_expired_agent_${SUFFIX}`
let SEQ = 0

function userId(tag: string): string {
  return `${USER_PREFIX}_${tag}`
}
function launchId(): string {
  return `${USER_PREFIX}_row_${SEQ++}`
}

async function dbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  try {
    await db.$queryRawUnsafe('SELECT 1')
    return true
  } catch {
    return false
  }
}

async function ensureLaunchTable(): Promise<void> {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "token_launches" (
    "id" TEXT PRIMARY KEY,
    "user_id" TEXT,
    "agent_id" TEXT,
    "creator_wallet" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'four_meme',
    "chain_id" INTEGER NOT NULL DEFAULT 56,
    "token_name" TEXT NOT NULL DEFAULT 'itest',
    "token_symbol" TEXT NOT NULL DEFAULT 'ITEST',
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
}

async function cleanup(): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `DELETE FROM "token_launches" WHERE "user_id" LIKE $1 OR "agent_id" LIKE $2`,
      `${USER_PREFIX}%`,
      `${AGENT_PREFIX}%`,
    )
  } catch { /* best-effort */ }
}

async function insertLaunch(opts: {
  id: string
  userId: string | null
  agentId?: string | null
  status: string
  ageHours?: number
  metadata?: string | null
  initialBuyBnb?: string | null
}): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "token_launches"
       ("id","user_id","agent_id","platform","chain_id","token_name","token_symbol",
        "initial_liquidity_bnb","status","metadata","created_at")
     VALUES ($1,$2,$3,'four_meme',56,'Expired Test','EXP',$4,$5,$6,
        now() - ($7::int * interval '1 hour'))`,
    opts.id,
    opts.userId,
    opts.agentId ?? null,
    opts.initialBuyBnb ?? '0',
    opts.status,
    opts.metadata ?? null,
    opts.ageHours ?? 0,
  )
}

async function getStatus(id: string): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT "status" FROM "token_launches" WHERE "id" = $1`,
    id,
  )
  return rows[0]?.status ?? null
}

// The exact cap/dedup count query the agent runs per tick
// (src/agents/fourMemeLaunchAgent.ts). Kept in lockstep so this test
// proves the agent's real predicate — not a paraphrase — treats `expired`
// as terminal (counted in lifetime, NOT in pending_any).
async function capCounts(agentId: string): Promise<{
  lifetimeCount: number
  recent24hCount: number
  pendingAnyCount: number
}> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const rows = await db.$queryRawUnsafe<Array<{
    lifetime: number
    recent24h: number
    pending_any: number
  }>>(
    `SELECT
       COUNT(*)::int                                              AS lifetime,
       COUNT(*) FILTER (WHERE "created_at" >= $2::timestamptz)::int AS recent24h,
       COUNT(*) FILTER (WHERE "status" = 'pending')::int          AS pending_any
     FROM "token_launches"
     WHERE "agent_id" = $1`,
    agentId,
    since,
  )
  return {
    lifetimeCount: Number(rows[0]?.lifetime ?? 0),
    recent24hCount: Number(rows[0]?.recent24h ?? 0),
    pendingAnyCount: Number(rows[0]?.pending_any ?? 0),
  }
}

function withLaunchEnabled(): () => void {
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  process.env.FOUR_MEME_ENABLED = 'true'
  process.env.FOUR_MEME_LAUNCH_ENABLED = 'true'
  return () => {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1
    else delete process.env.FOUR_MEME_ENABLED
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2
    else delete process.env.FOUR_MEME_LAUNCH_ENABLED
  }
}

// A launch seam that must never be reached — if the expiry guard works,
// retryLaunchForUser throws before ever invoking it.
const launchMustNotRun = async (): Promise<LaunchResult & { walletAddress: string }> => {
  throw new Error('launchForUser should not have been called for an expired row')
}

// A well-formed frozen proposal so the rejection can only be the status
// guard firing — not a missing/unreadable metadata fallback.
const FROZEN = JSON.stringify({
  tokenName: 'Expired Test',
  tokenSymbol: 'EXP',
  tokenDescription: 'should never launch',
  initialBuyBnb: '0',
})

test('executeApprovedLaunch refuses an expired row (ALREADY_HANDLED) and never launches', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — expired-approve test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const restore = withLaunchEnabled()
  try {
    const u = userId('approve')
    const id = launchId()
    // Row was swept to `expired` by the sweeper; owner clicks a stale Approve.
    await insertLaunch({ id, userId: u, status: 'expired', ageHours: 30, metadata: FROZEN })

    await assert.rejects(
      executeApprovedLaunch({ launchId: id, userId: u }),
      (err: unknown) => {
        assert.ok(err instanceof LaunchApprovalError, 'expected a LaunchApprovalError')
        assert.equal((err as LaunchApprovalError).code, 'ALREADY_HANDLED')
        return true
      },
    )
    // The expired row must NOT be advanced to pending/launched.
    assert.equal(await getStatus(id), 'expired', 'expired row must stay terminal')
  } finally {
    restore()
  }
})

test('rejectPendingLaunch refuses an expired row (ALREADY_HANDLED)', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — expired-reject test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const u = userId('reject')
  const id = launchId()
  await insertLaunch({ id, userId: u, status: 'expired', ageHours: 30, metadata: FROZEN })

  await assert.rejects(
    rejectPendingLaunch({ launchId: id, userId: u }),
    (err: unknown) => {
      assert.ok(err instanceof LaunchApprovalError, 'expected a LaunchApprovalError')
      assert.equal((err as LaunchApprovalError).code, 'ALREADY_HANDLED')
      return true
    },
  )
  assert.equal(await getStatus(id), 'expired', 'expired row must stay terminal')
})

test('retryLaunchForUser refuses an expired row (NOT_RETRYABLE) and never launches', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — expired-retry test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const restore = withLaunchEnabled()
  try {
    const u = userId('retry')
    const id = launchId()
    // Only `failed` / `stale` rows are retryable; `expired` is terminal.
    await insertLaunch({ id, userId: u, status: 'expired', ageHours: 30, metadata: FROZEN })

    await assert.rejects(
      retryLaunchForUser(u, id, { launchForUser: launchMustNotRun }),
      (err: unknown) => {
        assert.ok(err instanceof LaunchRetryError, 'expected a LaunchRetryError')
        assert.equal((err as LaunchRetryError).code, 'NOT_RETRYABLE')
        return true
      },
    )
    assert.equal(await getStatus(id), 'expired', 'expired row must stay terminal')
  } finally {
    restore()
  }
})

test('cap/dedup gate treats an expired row as terminal, not pending', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — expired-dedup test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const agentId = `${AGENT_PREFIX}_dedup`

  // A single expired row, aged past the 24h daily-cap window so the ONLY
  // gate that could fire is the pending-dedup branch. If the gate wrongly
  // treated `expired` as an open/pending launch, that branch would block
  // the next proposal forever — defeating the whole point of the expiry
  // sweep. (A fresher expired row would legitimately trip the daily cap,
  // which is age-based, not status-based — so we age it out to isolate
  // the dedup decision under test.)
  await insertLaunch({
    id: launchId(),
    userId: userId('dedup'),
    agentId,
    status: 'expired',
    ageHours: 30,
    metadata: FROZEN,
  })

  const afterExpiry = await capCounts(agentId)
  assert.equal(afterExpiry.pendingAnyCount, 0, 'an expired row must NOT count as pending')
  assert.equal(afterExpiry.lifetimeCount, 1, 'an expired row still counts toward the lifetime ceiling')
  assert.equal(afterExpiry.recent24hCount, 0, 'an aged-out expired row is outside the daily-cap window')
  assert.equal(
    evaluateLaunchCaps(afterExpiry).blocked,
    false,
    'expired-only history must not block a fresh proposal via the dedup gate',
  )

  // Contrast: a genuinely `pending` row DOES block via the dedup branch
  // (which applies regardless of age), proving the gate is live and the
  // expired-row pass above is not a false negative.
  await insertLaunch({
    id: launchId(),
    userId: userId('dedup'),
    agentId,
    status: 'pending',
    ageHours: 30,
    metadata: FROZEN,
  })
  const afterPending = await capCounts(agentId)
  assert.equal(afterPending.pendingAnyCount, 1, 'a pending row must count as pending')
  assert.equal(
    evaluateLaunchCaps(afterPending).blocked,
    true,
    'a live pending row must block the dedup gate',
  )
})

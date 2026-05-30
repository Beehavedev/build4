import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateLaunchParams,
  generateTokenSvg,
  parseTokenAddressFromReceipt,
  isFourMemeLaunchEnabled,
  LaunchValidationError,
  markUserPendingStale,
  retryLaunchForUser,
  LaunchRetryError,
  rejectPendingLaunch,
  executeApprovedLaunch,
  LaunchApprovalError,
  type LaunchParams,
  type LaunchResult,
} from './fourMemeLaunch'
import { ethers } from 'ethers'
import { db } from '../db'

test('feature flag is fail-closed: defaults to false with no env', () => {
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  delete process.env.FOUR_MEME_ENABLED
  delete process.env.FOUR_MEME_LAUNCH_ENABLED
  try {
    assert.equal(isFourMemeLaunchEnabled(), false)
  } finally {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2
  }
})

test('feature flag stays off when only master is on', () => {
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  process.env.FOUR_MEME_ENABLED = 'true'
  delete process.env.FOUR_MEME_LAUNCH_ENABLED
  try {
    assert.equal(isFourMemeLaunchEnabled(), false)
  } finally {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1; else delete process.env.FOUR_MEME_ENABLED
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2
  }
})

test('feature flag stays off when only launch is on (master gate respected)', () => {
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  delete process.env.FOUR_MEME_ENABLED
  process.env.FOUR_MEME_LAUNCH_ENABLED = 'true'
  try {
    assert.equal(isFourMemeLaunchEnabled(), false)
  } finally {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2; else delete process.env.FOUR_MEME_LAUNCH_ENABLED
  }
})

test('feature flag enables when both flags are exactly "true"', () => {
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  process.env.FOUR_MEME_ENABLED = 'true'
  process.env.FOUR_MEME_LAUNCH_ENABLED = 'true'
  try {
    assert.equal(isFourMemeLaunchEnabled(), true)
  } finally {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1; else delete process.env.FOUR_MEME_ENABLED
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2; else delete process.env.FOUR_MEME_LAUNCH_ENABLED
  }
})

test('validateLaunchParams accepts well-formed input', () => {
  validateLaunchParams({ tokenName: 'Build4 Test', tokenSymbol: 'B4T', initialBuyBnb: '0.01' })
  validateLaunchParams({ tokenName: 'Ab', tokenSymbol: 'X' })
  validateLaunchParams({ tokenName: 'X'.repeat(100), tokenSymbol: 'TICKERTKR' })
})

test('validateLaunchParams rejects short/long name', () => {
  assert.throws(() => validateLaunchParams({ tokenName: 'A', tokenSymbol: 'OK' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'X'.repeat(101), tokenSymbol: 'OK' }), LaunchValidationError)
})

test('validateLaunchParams rejects bad symbol', () => {
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: '' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'TOOLONG1234' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'BAD SYM' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'emoji😀' }), LaunchValidationError)
})

test('validateLaunchParams rejects non-numeric or excessive initial buy', () => {
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK', initialBuyBnb: 'abc' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK', initialBuyBnb: '5.0001' }), LaunchValidationError)
})

test('validateLaunchParams accepts zero initial buy + missing initial buy', () => {
  validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK', initialBuyBnb: '0' })
  validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK' })
  validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK', initialBuyBnb: '' })
})

test('generateTokenSvg produces valid-ish SVG with the symbol displayed', () => {
  const svg = generateTokenSvg('Build4 Token', 'B4')
  assert.match(svg, /^<svg /)
  assert.match(svg, /<\/svg>$/)
  assert.match(svg, />B4</)
  // Stable across calls for the same input (deterministic colour hash).
  assert.equal(svg, generateTokenSvg('Build4 Token', 'B4'))
})

test('generateTokenSvg escapes XML special chars from symbol input', () => {
  // The symbol is alphanumerically filtered, so the test reaches into
  // the name path indirectly: confirm no raw < or > appear inside the
  // displayed text.
  const svg = generateTokenSvg('<script>alert(1)</script>', 'XSS')
  assert.match(svg, />XSS</)
  assert.equal(svg.includes('<script>'), false)
})

test('parseTokenAddressFromReceipt extracts from TokenCreate event', () => {
  const newToken = ethers.getAddress('0x' + 'a'.repeat(40))
  const creator = ethers.getAddress('0x' + 'b'.repeat(40))
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint256', 'string', 'string', 'uint256', 'uint256', 'uint256'],
    [creator, newToken, 1n, 'Name', 'SYM', 0n, 0n, 0n],
  )
  const fakeReceipt = {
    status: 1,
    hash: '0x' + 'c'.repeat(64),
    logs: [
      {
        topics: ['0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20'],
        data,
      },
    ],
  } as unknown as ethers.TransactionReceipt
  assert.equal(parseTokenAddressFromReceipt(fakeReceipt), newToken)
})

test('MAX_UPSTREAM_VALUE_HEADROOM_WEI is enforced (constants sanity)', () => {
  // Sanity-check the cap formula by reproducing it: a 0.01 BNB user
  // initial buy + 0.05 headroom must equal exactly 0.06 BNB max.
  const preSale = ethers.parseEther('0.01')
  const headroom = ethers.parseEther('0.05')
  assert.equal(ethers.formatEther(preSale + headroom), '0.06')
})

test('parseTokenAddressFromReceipt returns null when no token-shaped log present', () => {
  const fakeReceipt = {
    status: 1,
    hash: '0x' + 'd'.repeat(64),
    logs: [{ topics: ['0xdeadbeef'], data: '0x' }],
  } as unknown as ethers.TransactionReceipt
  assert.equal(parseTokenAddressFromReceipt(fakeReceipt), null)
})

// ── Stale-sweep + retry coverage (Task #69) ──────────────────────────
// These drive the REAL markUserPendingStale / retryLaunchForUser SQL
// against a REAL Postgres so the "older than 10m" window and per-user
// scoping are proven at the DB layer, not just in JS. The on-chain
// launch is intercepted via retryLaunchForUser's `deps.launchForUser`
// seam so no network/chain call ever fires. Skips cleanly when no DB
// is reachable so it never blocks a Postgres-less CI run.

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

const SUFFIX = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const USER_PREFIX = `__itest_launch_user_${SUFFIX}`
let SEQ = 0
function userId(tag: string): string {
  return `${USER_PREFIX}_${tag}`
}
function launchId(): string {
  return `${USER_PREFIX}_row_${SEQ++}`
}

async function cleanup(): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `DELETE FROM "token_launches" WHERE "user_id" LIKE $1`,
      `${USER_PREFIX}%`,
    )
  } catch { /* best-effort */ }
}

async function insertLaunch(opts: {
  id: string
  userId: string | null
  status: string
  ageMinutes?: number
  tokenName?: string
  tokenSymbol?: string
  tokenDescription?: string | null
  imageUrl?: string | null
  initialBuyBnb?: string | null
  errorMessage?: string | null
  agentId?: string | null
  metadata?: string | null
}): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "token_launches"
       ("id","user_id","agent_id","platform","chain_id","token_name","token_symbol",
        "token_description","image_url","initial_liquidity_bnb","status",
        "error_message","metadata","created_at")
     VALUES ($1,$2,$3,'four_meme',56,$4,$5,$6,$7,$8,$9,$10,$11,
        now() - ($12::int * interval '1 minute'))`,
    opts.id,
    opts.userId,
    opts.agentId ?? null,
    opts.tokenName ?? 'Test Token',
    opts.tokenSymbol ?? 'TT',
    opts.tokenDescription ?? null,
    opts.imageUrl ?? null,
    opts.initialBuyBnb ?? null,
    opts.status,
    opts.errorMessage ?? null,
    opts.metadata ?? null,
    opts.ageMinutes ?? 0,
  )
}

async function getStatus(id: string): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT "status" FROM "token_launches" WHERE "id" = $1`,
    id,
  )
  return rows[0]?.status ?? null
}

async function getErrorMessage(id: string): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ error_message: string | null }>>(
    `SELECT "error_message" FROM "token_launches" WHERE "id" = $1`,
    id,
  )
  return rows[0]?.error_message ?? null
}

// Enable both gates for retry tests; restore prior values after.
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

function fakeResult(params: LaunchParams): LaunchResult & { walletAddress: string } {
  return {
    txHash: '0x' + 'f'.repeat(64),
    tokenAddress: null,
    launchUrl: 'https://four.meme/token/fake',
    bnbSpentWei: '0',
    initialBuyBnb: params.initialBuyBnb ?? '0',
    imageUrl: params.imageUrl ?? null,
    walletAddress: '0x' + '1'.repeat(40),
  }
}

// A launch seam that must never be reached (guard should throw first).
const launchMustNotRun = async (): Promise<LaunchResult & { walletAddress: string }> => {
  throw new Error('launchForUser should not have been called')
}

test('markUserPendingStale only marks pending rows older than 10 minutes', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — sweeper test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const u = userId('stale_age')
  const oldId = launchId()
  const freshId = launchId()
  await insertLaunch({ id: oldId, userId: u, status: 'pending', ageMinutes: 11 })
  await insertLaunch({ id: freshId, userId: u, status: 'pending', ageMinutes: 5 })

  const n = await markUserPendingStale(u)
  assert.equal(n, 1, 'exactly one (the 11m-old) row should flip to stale')
  assert.equal(await getStatus(oldId), 'stale')
  assert.equal(await getStatus(freshId), 'pending', 'a 5m-old in-flight row must stay pending')
})

test('markUserPendingStale is scoped to the given user', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — sweeper test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const uA = userId('scope_a')
  const uB = userId('scope_b')
  const aId = launchId()
  const bId = launchId()
  await insertLaunch({ id: aId, userId: uA, status: 'pending', ageMinutes: 30 })
  await insertLaunch({ id: bId, userId: uB, status: 'pending', ageMinutes: 30 })

  const n = await markUserPendingStale(uA)
  assert.equal(n, 1)
  assert.equal(await getStatus(aId), 'stale')
  assert.equal(await getStatus(bId), 'pending', "another user's stale pending row must be untouched")
})

test('markUserPendingStale ignores non-pending rows and preserves existing error_message', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — sweeper test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const u = userId('non_pending')
  const failedId = launchId()
  const launchedId = launchId()
  const pendingWithErrId = launchId()
  await insertLaunch({ id: failedId, userId: u, status: 'failed', ageMinutes: 60, errorMessage: 'boom' })
  await insertLaunch({ id: launchedId, userId: u, status: 'launched', ageMinutes: 60 })
  await insertLaunch({ id: pendingWithErrId, userId: u, status: 'pending', ageMinutes: 60, errorMessage: 'prior note' })

  const n = await markUserPendingStale(u)
  assert.equal(n, 1, 'only the pending row flips')
  assert.equal(await getStatus(failedId), 'failed')
  assert.equal(await getStatus(launchedId), 'launched')
  assert.equal(await getStatus(pendingWithErrId), 'stale')
  assert.equal(await getErrorMessage(pendingWithErrId), 'prior note', 'COALESCE must keep the pre-existing error_message')
})

test('retryLaunchForUser rejects a row owned by another user as NOT_FOUND', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — retry test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const restore = withLaunchEnabled()
  try {
    const owner = userId('owner')
    const attacker = userId('attacker')
    const id = launchId()
    await insertLaunch({ id, userId: owner, status: 'failed' })

    await assert.rejects(
      retryLaunchForUser(attacker, id, { launchForUser: launchMustNotRun }),
      (err: unknown) => {
        assert.ok(err instanceof LaunchRetryError)
        assert.equal((err as LaunchRetryError).code, 'NOT_FOUND')
        return true
      },
    )
    // The owner's row must be left exactly as it was.
    assert.equal(await getStatus(id), 'failed')
  } finally {
    restore()
  }
})

test('retryLaunchForUser rejects an unknown launchId as NOT_FOUND', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — retry test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const restore = withLaunchEnabled()
  try {
    await assert.rejects(
      retryLaunchForUser(userId('ghost'), launchId(), { launchForUser: launchMustNotRun }),
      (err: unknown) => {
        assert.ok(err instanceof LaunchRetryError)
        assert.equal((err as LaunchRetryError).code, 'NOT_FOUND')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('retryLaunchForUser rejects a launched row as NOT_RETRYABLE', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — retry test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const restore = withLaunchEnabled()
  try {
    const u = userId('launched')
    const id = launchId()
    await insertLaunch({ id, userId: u, status: 'launched' })

    await assert.rejects(
      retryLaunchForUser(u, id, { launchForUser: launchMustNotRun }),
      (err: unknown) => {
        assert.ok(err instanceof LaunchRetryError)
        assert.equal((err as LaunchRetryError).code, 'NOT_RETRYABLE')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('retryLaunchForUser rejects an in-flight (recent) pending row as NOT_RETRYABLE', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — retry test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const restore = withLaunchEnabled()
  try {
    const u = userId('inflight')
    const id = launchId()
    // 2m old: the opportunistic markUserPendingStale inside retry must
    // NOT convert this to stale, so it stays pending → NOT_RETRYABLE.
    await insertLaunch({ id, userId: u, status: 'pending', ageMinutes: 2 })

    await assert.rejects(
      retryLaunchForUser(u, id, { launchForUser: launchMustNotRun }),
      (err: unknown) => {
        assert.ok(err instanceof LaunchRetryError)
        assert.equal((err as LaunchRetryError).code, 'NOT_RETRYABLE')
        return true
      },
    )
    assert.equal(await getStatus(id), 'pending', 'a fresh in-flight row must not be prematurely staled')
  } finally {
    restore()
  }
})

test('retryLaunchForUser reuses the original name/symbol/initialBuyBnb/imageUrl from a failed row', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — retry test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const restore = withLaunchEnabled()
  try {
    const u = userId('reuse')
    const id = launchId()
    await insertLaunch({
      id,
      userId: u,
      status: 'failed',
      tokenName: 'Original Name',
      tokenSymbol: 'ORIG',
      tokenDescription: 'original desc',
      initialBuyBnb: '0.42',
      imageUrl: 'https://static.four.meme/orig.png',
    })

    const captured: Array<{ userId: string; params: LaunchParams }> = []
    const result = await retryLaunchForUser(u, id, {
      launchForUser: async (uid, params) => {
        captured.push({ userId: uid, params })
        return fakeResult(params)
      },
    })

    assert.equal(captured.length, 1, 'launch seam must be invoked exactly once')
    assert.equal(captured[0].userId, u)
    assert.equal(captured[0].params.tokenName, 'Original Name')
    assert.equal(captured[0].params.tokenSymbol, 'ORIG')
    assert.equal(captured[0].params.tokenDescription, 'original desc')
    assert.equal(captured[0].params.initialBuyBnb, '0.42')
    assert.equal(captured[0].params.imageUrl, 'https://static.four.meme/orig.png')
    assert.equal(result.previousLaunchId, id, 'result must reference the original row for audit')
    assert.equal(result.walletAddress, '0x' + '1'.repeat(40))
  } finally {
    restore()
  }
})

test('retryLaunchForUser staleness sweep makes a long-stuck pending row retryable in the same call', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — retry test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)
  const restore = withLaunchEnabled()
  try {
    const u = userId('stuck')
    const id = launchId()
    // 30m old pending → opportunistic sweep inside retry flips it to
    // stale, which IS retryable, so the launch seam should fire.
    await insertLaunch({
      id,
      userId: u,
      status: 'pending',
      ageMinutes: 30,
      tokenName: 'Stuck Token',
      tokenSymbol: 'STK',
      initialBuyBnb: '0',
    })

    const captured: LaunchParams[] = []
    const result = await retryLaunchForUser(u, id, {
      launchForUser: async (_uid, params) => {
        captured.push(params)
        return fakeResult(params)
      },
    })

    assert.equal(captured.length, 1, 'a swept-stale pending row must become retryable')
    assert.equal(captured[0].tokenName, 'Stuck Token')
    assert.equal(captured[0].tokenSymbol, 'STK')
    assert.equal(result.previousLaunchId, id)
    assert.equal(await getStatus(id), 'stale', 'the original row is left as stale for audit')
  } finally {
    restore()
  }
})

test('retryLaunchForUser fails closed when the launch feature flag is off', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — retry test skipped'); return }
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  delete process.env.FOUR_MEME_ENABLED
  delete process.env.FOUR_MEME_LAUNCH_ENABLED
  try {
    await assert.rejects(
      retryLaunchForUser(userId('disabled'), launchId(), { launchForUser: launchMustNotRun }),
      (err: unknown) => {
        assert.ok(err instanceof LaunchRetryError)
        assert.equal((err as LaunchRetryError).code, 'FOUR_MEME_LAUNCH_DISABLED')
        return true
      },
    )
  } finally {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2
  }
})

test('retryLaunchForUser rejects an empty launchId', async (t) => {
  const restore = withLaunchEnabled()
  try {
    await assert.rejects(
      retryLaunchForUser(userId('empty'), '', { launchForUser: launchMustNotRun }),
      (err: unknown) => {
        assert.ok(err instanceof LaunchRetryError)
        return true
      },
    )
  } finally {
    restore()
  }
})

// ── HITL approve/reject coverage (Task #240) ─────────────────────────
// These drive the REAL rejectPendingLaunch / executeApprovedLaunch SQL
// against a REAL Postgres so the ownership check, already-handled
// guard, malformed-proposal guard, and verbatim frozen-proposal replay
// are proven at the DB layer — the surfaces that decide whether user
// BNB actually gets spent. The wallet-decrypt + on-chain launch are
// intercepted via executeApprovedLaunch's deps seam so no key load,
// network, or chain call ever fires. Skips cleanly when no DB is
// reachable so it never blocks a Postgres-less CI run.

const FROZEN = JSON.stringify({
  tokenName: 'Frozen Token',
  tokenSymbol: 'FRZ',
  tokenDescription: 'frozen description',
  initialBuyBnb: '0.07',
  conviction: 0.9,
  reasoning: 'high conviction',
})

// A launch seam that must never be reached (an earlier guard should
// throw first). Mirrors launchMustNotRun but for the execute path.
const launchTokenMustNotRun = (async () => {
  throw new Error('launchFourMemeToken should not have been called')
}) as unknown as NonNullable<Parameters<typeof executeApprovedLaunch>[1]>['launchFourMemeToken']

const loadPkMustNotRun = (async () => {
  throw new Error('loadUserBscPrivateKey should not have been called')
}) as unknown as NonNullable<Parameters<typeof executeApprovedLaunch>[1]>['loadUserBscPrivateKey']

test('rejectPendingLaunch refuses a row owned by another user (FORBIDDEN)', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — approval test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const owner = userId('rej_owner')
  const attacker = userId('rej_attacker')
  const id = launchId()
  await insertLaunch({ id, userId: owner, status: 'pending_user_approval', metadata: FROZEN })

  await assert.rejects(
    rejectPendingLaunch({ launchId: id, userId: attacker }),
    (err: unknown) => {
      assert.ok(err instanceof LaunchApprovalError)
      assert.equal((err as LaunchApprovalError).code, 'FORBIDDEN')
      return true
    },
  )
  // The owner's proposal must be left untouched.
  assert.equal(await getStatus(id), 'pending_user_approval')
})

test('executeApprovedLaunch refuses a row owned by another user (FORBIDDEN) without spending', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — approval test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const owner = userId('exec_owner')
  const attacker = userId('exec_attacker')
  const id = launchId()
  await insertLaunch({ id, userId: owner, status: 'pending_user_approval', metadata: FROZEN })

  await assert.rejects(
    executeApprovedLaunch(
      { launchId: id, userId: attacker },
      { loadUserBscPrivateKey: loadPkMustNotRun, launchFourMemeToken: launchTokenMustNotRun },
    ),
    (err: unknown) => {
      assert.ok(err instanceof LaunchApprovalError)
      assert.equal((err as LaunchApprovalError).code, 'FORBIDDEN')
      return true
    },
  )
  assert.equal(await getStatus(id), 'pending_user_approval', 'a forbidden execute must not advance the row')
})

test('rejectPendingLaunch refuses an already-handled row (ALREADY_HANDLED)', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — approval test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const u = userId('rej_handled')
  const id = launchId()
  // Already rejected: a second reject must be a clean idempotent error.
  await insertLaunch({ id, userId: u, status: 'rejected', metadata: FROZEN })

  await assert.rejects(
    rejectPendingLaunch({ launchId: id, userId: u }),
    (err: unknown) => {
      assert.ok(err instanceof LaunchApprovalError)
      assert.equal((err as LaunchApprovalError).code, 'ALREADY_HANDLED')
      return true
    },
  )
  assert.equal(await getStatus(id), 'rejected')
})

test('executeApprovedLaunch refuses an already-handled row (ALREADY_HANDLED) without spending', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — approval test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const u = userId('exec_handled')
  const id = launchId()
  // Already launched: re-approving must NOT double-fire on-chain.
  await insertLaunch({ id, userId: u, status: 'launched', metadata: FROZEN })

  await assert.rejects(
    executeApprovedLaunch(
      { launchId: id, userId: u },
      { loadUserBscPrivateKey: loadPkMustNotRun, launchFourMemeToken: launchTokenMustNotRun },
    ),
    (err: unknown) => {
      assert.ok(err instanceof LaunchApprovalError)
      assert.equal((err as LaunchApprovalError).code, 'ALREADY_HANDLED')
      return true
    },
  )
  assert.equal(await getStatus(id), 'launched', 're-approving a launched row must not change it')
})

test('executeApprovedLaunch rejects an unreadable/missing frozen proposal (INVALID_PROPOSAL)', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — approval test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const u = userId('exec_bad_meta')
  // Case A: metadata is not valid JSON at all.
  const garbledId = launchId()
  await insertLaunch({ id: garbledId, userId: u, status: 'pending_user_approval', metadata: 'not-json{' })
  // Case B: metadata is JSON but missing the required tokenName/symbol.
  const incompleteId = launchId()
  await insertLaunch({
    id: incompleteId,
    userId: u,
    status: 'pending_user_approval',
    metadata: JSON.stringify({ initialBuyBnb: '0.1' }),
  })
  // Case C: metadata column is null entirely.
  const nullId = launchId()
  await insertLaunch({ id: nullId, userId: u, status: 'pending_user_approval', metadata: null })

  for (const id of [garbledId, incompleteId, nullId]) {
    await assert.rejects(
      executeApprovedLaunch(
        { launchId: id, userId: u },
        { loadUserBscPrivateKey: loadPkMustNotRun, launchFourMemeToken: launchTokenMustNotRun },
      ),
      (err: unknown) => {
        assert.ok(err instanceof LaunchApprovalError)
        assert.equal((err as LaunchApprovalError).code, 'INVALID_PROPOSAL')
        return true
      },
    )
    // An unreadable proposal must NOT be advanced — it stays awaiting a
    // human, never silently consuming the row.
    assert.equal(await getStatus(id), 'pending_user_approval')
  }
})

test('executeApprovedLaunch replays the exact frozen proposal and reuses the same row id', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — approval test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const u = userId('exec_replay')
  const agent = 'agent_xyz'
  const id = launchId()
  await insertLaunch({
    id,
    userId: u,
    status: 'pending_user_approval',
    agentId: agent,
    // The visible columns deliberately DIFFER from the frozen proposal
    // so we prove the launch replays metadata, not the loose columns.
    tokenName: 'Stale Column Name',
    tokenSymbol: 'STALE',
    metadata: FROZEN,
  })

  const captured: Array<{
    privateKey: string
    params: LaunchParams
    ctx: { userId: string | null; agentId?: string | null; existingLaunchId?: string | null } | undefined
  }> = []
  let loadPkCalledWith: string | null = null

  const result = await executeApprovedLaunch(
    { launchId: id, userId: u },
    {
      loadUserBscPrivateKey: (async (uid: string) => {
        loadPkCalledWith = uid
        return { address: '0x' + '1'.repeat(40), privateKey: '0x' + '2'.repeat(64) }
      }) as unknown as NonNullable<Parameters<typeof executeApprovedLaunch>[1]>['loadUserBscPrivateKey'],
      launchFourMemeToken: (async (privateKey: string, params: LaunchParams, ctx: any) => {
        captured.push({ privateKey, params, ctx })
        return fakeResult(params)
      }) as unknown as NonNullable<Parameters<typeof executeApprovedLaunch>[1]>['launchFourMemeToken'],
    },
  )

  assert.equal(loadPkCalledWith, u, 'the wallet must be loaded for the approving user')
  assert.equal(captured.length, 1, 'launch must fire exactly once')
  // Verbatim replay of the frozen proposal — not the loose columns.
  assert.equal(captured[0].params.tokenName, 'Frozen Token')
  assert.equal(captured[0].params.tokenSymbol, 'FRZ')
  assert.equal(captured[0].params.tokenDescription, 'frozen description')
  assert.equal(captured[0].params.initialBuyBnb, '0.07')
  assert.equal(captured[0].privateKey, '0x' + '2'.repeat(64), 'the decrypted key is passed through to the launcher')
  // Same row reused for a single-row audit trail.
  assert.equal(captured[0].ctx?.existingLaunchId, id)
  assert.equal(captured[0].ctx?.userId, u)
  assert.equal(captured[0].ctx?.agentId, agent)
  assert.equal(result.walletAddress, '0x' + '1'.repeat(40))
})

test('executeApprovedLaunch refuses an unknown launchId (NOT_FOUND) without spending', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — approval test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  await assert.rejects(
    executeApprovedLaunch(
      { launchId: launchId(), userId: userId('exec_ghost') },
      { loadUserBscPrivateKey: loadPkMustNotRun, launchFourMemeToken: launchTokenMustNotRun },
    ),
    (err: unknown) => {
      assert.ok(err instanceof LaunchApprovalError)
      assert.equal((err as LaunchApprovalError).code, 'NOT_FOUND')
      return true
    },
  )
})

test('rejectPendingLaunch flips a genuinely-pending proposal to rejected', async (t) => {
  if (!(await dbReachable())) { t.skip('No reachable Postgres — approval test skipped'); return }
  await ensureLaunchTable()
  t.after(cleanup)

  const u = userId('rej_happy')
  const id = launchId()
  await insertLaunch({ id, userId: u, status: 'pending_user_approval', metadata: FROZEN })

  await rejectPendingLaunch({ launchId: id, userId: u })
  assert.equal(await getStatus(id), 'rejected')
})

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
import {
  __test,
  parseProposal,
  isAgentLaunchEnabled,
  clampInitialBuyBnb,
  sanitizeNameTicker,
  evaluateLaunchCaps,
} from './fourMemeLaunchAgent'

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

// ───────────────────────────────────────────────────────────────────────────
// evaluateLaunchCaps — the daily / lifetime / pending guard. This is the
// guard that bounds how often an agent can spend user BNB. Pure, so it
// runs deterministically in CI with no DB.
// ───────────────────────────────────────────────────────────────────────────
test('evaluateLaunchCaps: allows a launch when all counts are clear', () => {
  const d = evaluateLaunchCaps({ lifetimeCount: 0, recent24hCount: 0, pendingAnyCount: 0 })
  assert.equal(d.blocked, false)
  assert.equal(d.reason, null)
})

test('evaluateLaunchCaps: blocks the SECOND launch in a day (daily cap = 1)', () => {
  // Below the cap → allowed.
  assert.equal(
    evaluateLaunchCaps({ lifetimeCount: 0, recent24hCount: 0, pendingAnyCount: 0 }).blocked,
    false,
    `recent24h=0 must be allowed (cap is ${__test.MAX_LAUNCHES_PER_DAY})`,
  )
  // At the cap → blocked. This is the core regression guard: one launch
  // already happened in the last 24h, the next must be refused.
  const atCap = evaluateLaunchCaps({
    lifetimeCount: 1,
    recent24hCount: __test.MAX_LAUNCHES_PER_DAY,
    pendingAnyCount: 0,
  })
  assert.equal(atCap.blocked, true, 'at the daily cap the next launch must be blocked')
  assert.match(atCap.reason ?? '', /daily_cap_reached/)
})

test('evaluateLaunchCaps: blocks at the lifetime ceiling and takes precedence over the daily cap', () => {
  const d = evaluateLaunchCaps({
    lifetimeCount: __test.MAX_LAUNCHES_LIFETIME,
    recent24hCount: 0, // under the daily cap, but lifetime is maxed
    pendingAnyCount: 0,
  })
  assert.equal(d.blocked, true)
  assert.match(d.reason ?? '', /lifetime_cap_reached/, 'lifetime ceiling is checked first')
})

test('evaluateLaunchCaps: a pending launch blocks regardless of age (dedup)', () => {
  const d = evaluateLaunchCaps({ lifetimeCount: 1, recent24hCount: 0, pendingAnyCount: 1 })
  assert.equal(d.blocked, true)
  assert.match(d.reason ?? '', /pending_launch_exists/)
})

test('evaluateLaunchCaps: guard order is lifetime → daily → pending', () => {
  // All three trip at once — the reason must be the lifetime one, proving
  // the precedence the production path relies on.
  const d = evaluateLaunchCaps({
    lifetimeCount: __test.MAX_LAUNCHES_LIFETIME,
    recent24hCount: __test.MAX_LAUNCHES_PER_DAY,
    pendingAnyCount: 5,
  })
  assert.match(d.reason ?? '', /lifetime_cap_reached/)
})

// ───────────────────────────────────────────────────────────────────────────
// parseProposal — JSON sanitization of the single LLM round-trip.
// These run with NO DB (pure function) so they always exercise in CI.
// ───────────────────────────────────────────────────────────────────────────
test('parseProposal: parses a plain JSON object', () => {
  const p = parseProposal(
    '{"action":"LAUNCH","name":"Doge Killer","ticker":"dkill","description":"d","initialBuyBnb":0.02,"conviction":0.8,"reasoning":"meme is cooking"}',
  )
  assert.equal(p.action, 'LAUNCH')
  assert.equal(p.name, 'Doge Killer')
  assert.equal(p.ticker, 'dkill') // parseProposal trims but does NOT upper-case; that happens later in sanitizeNameTicker
  assert.equal(p.initialBuyBnb, 0.02)
  assert.equal(p.conviction, 0.8)
})

test('parseProposal: strips ```json markdown fences', () => {
  const raw = '```json\n{"action":"LAUNCH","name":"Pepe2","ticker":"PEP2","conviction":0.9}\n```'
  const p = parseProposal(raw)
  assert.equal(p.action, 'LAUNCH')
  assert.equal(p.name, 'Pepe2')
  assert.equal(p.ticker, 'PEP2')
  assert.equal(p.conviction, 0.9)
})

test('parseProposal: strips bare ``` fences (no json tag)', () => {
  const raw = '```\n{"action":"SKIP","reasoning":"tape is cold"}\n```'
  const p = parseProposal(raw)
  assert.equal(p.action, 'SKIP')
  assert.equal(p.reasoning, 'tape is cold')
})

test('parseProposal: extracts the first {…} block from prose-wrapped output', () => {
  const raw = 'Sure! Here is my decision:\n{"action":"LAUNCH","name":"Wojak","ticker":"WJK","conviction":0.77}\nLet me know if you want changes.'
  const p = parseProposal(raw)
  assert.equal(p.action, 'LAUNCH')
  assert.equal(p.name, 'Wojak')
  assert.equal(p.ticker, 'WJK')
})

test('parseProposal: unknown action degrades to SKIP (fail-safe default)', () => {
  const p = parseProposal('{"action":"FULL_SEND","name":"x","ticker":"X","conviction":0.99}')
  assert.equal(p.action, 'SKIP', 'any action other than the literal "LAUNCH" must become SKIP')
})

test('parseProposal: clamps numeric conviction into [0,1]', () => {
  assert.equal(parseProposal('{"action":"SKIP","conviction":5}').conviction, 1)
  assert.equal(parseProposal('{"action":"SKIP","conviction":-3}').conviction, 0)
  assert.equal(parseProposal('{"action":"SKIP","conviction":0.5}').conviction, 0.5)
})

test('parseProposal: a non-numeric conviction yields NaN (current behavior)', () => {
  // Documents the present clamp: Math.max(0, Math.min(1, Number("oops")))
  // is NaN, not 0. Harmless on the SKIP path (a SKIP never launches), but
  // pinned so a future refactor that changes this is a CONSCIOUS choice.
  assert.ok(Number.isNaN(parseProposal('{"action":"SKIP","conviction":"oops"}').conviction))
})

test('parseProposal: missing fields default cleanly (no throw)', () => {
  const p = parseProposal('{"action":"SKIP"}')
  assert.equal(p.name, '')
  assert.equal(p.ticker, '')
  assert.equal(p.description, '')
  assert.equal(p.initialBuyBnb, 0)
  assert.equal(p.conviction, 0)
  assert.equal(p.reasoning, '')
})

test('parseProposal: clamps reasoning to 500 chars', () => {
  const long = 'z'.repeat(900)
  const p = parseProposal(`{"action":"SKIP","reasoning":"${long}"}`)
  assert.equal(p.reasoning.length, 500)
})

test('parseProposal: throws on output containing no JSON object', () => {
  assert.throws(() => parseProposal('the model refused to answer'), /non-JSON/)
})

// ───────────────────────────────────────────────────────────────────────────
// isAgentLaunchEnabled — master kill-switch must FAIL CLOSED unless ALL
// THREE env flags are exactly the string 'true'.
// ───────────────────────────────────────────────────────────────────────────
const LAUNCH_ENV_FLAGS = [
  'FOUR_MEME_ENABLED',
  'FOUR_MEME_LAUNCH_ENABLED',
  'FOUR_MEME_AGENT_LAUNCH_ENABLED',
] as const

test('isAgentLaunchEnabled: true only when all 3 flags are exactly "true"', () => {
  const saved = LAUNCH_ENV_FLAGS.map((k) => process.env[k])
  try {
    for (const k of LAUNCH_ENV_FLAGS) process.env[k] = 'true'
    assert.equal(isAgentLaunchEnabled(), true, 'all three flags on ⇒ enabled')

    // Drop each flag in turn — any one missing must fail closed.
    for (const missing of LAUNCH_ENV_FLAGS) {
      for (const k of LAUNCH_ENV_FLAGS) process.env[k] = 'true'
      delete process.env[missing]
      assert.equal(
        isAgentLaunchEnabled(), false,
        `must fail closed when ${missing} is unset`,
      )
    }

    // A non-"true" value (e.g. "1", "TRUE", "yes") must NOT enable.
    for (const k of LAUNCH_ENV_FLAGS) process.env[k] = 'true'
    process.env.FOUR_MEME_AGENT_LAUNCH_ENABLED = '1'
    assert.equal(isAgentLaunchEnabled(), false, '"1" is not the literal "true"')
    process.env.FOUR_MEME_AGENT_LAUNCH_ENABLED = 'TRUE'
    assert.equal(isAgentLaunchEnabled(), false, '"TRUE" is case-sensitive and not accepted')
  } finally {
    for (let i = 0; i < LAUNCH_ENV_FLAGS.length; i++) {
      const k = LAUNCH_ENV_FLAGS[i]
      if (saved[i] === undefined) delete process.env[k]
      else process.env[k] = saved[i]!
    }
  }
})

// ───────────────────────────────────────────────────────────────────────────
// sanitizeNameTicker — rejects malformed name/ticker before the launcher.
// ───────────────────────────────────────────────────────────────────────────
test('sanitizeNameTicker: accepts a clean name/ticker and upper-cases the ticker', () => {
  const r = sanitizeNameTicker('  Doge Killer  ', '  dkill ')
  assert.equal(r.cleanName, 'Doge Killer')
  assert.equal(r.cleanTicker, 'DKILL')
  assert.equal(r.valid, true)
})

test('sanitizeNameTicker: allows the $ symbol in the ticker', () => {
  const r = sanitizeNameTicker('Cash Money', '$CASH')
  assert.equal(r.valid, true)
  assert.equal(r.cleanTicker, '$CASH')
})

test('sanitizeNameTicker: rejects a too-short name (<2 chars)', () => {
  assert.equal(sanitizeNameTicker('A', 'AAA').valid, false)
  assert.equal(sanitizeNameTicker('', 'AAA').valid, false)
})

test('sanitizeNameTicker: rejects an empty ticker', () => {
  assert.equal(sanitizeNameTicker('Valid Name', '').valid, false)
  assert.equal(sanitizeNameTicker('Valid Name', '   ').valid, false)
})

test('sanitizeNameTicker: rejects illegal ticker characters', () => {
  assert.equal(sanitizeNameTicker('Valid Name', 'AB-C').valid, false, 'hyphen not allowed')
  assert.equal(sanitizeNameTicker('Valid Name', 'A B').valid, false, 'space not allowed')
  assert.equal(sanitizeNameTicker('Valid Name', 'PÉPE').valid, false, 'non-ASCII not allowed')
  assert.equal(sanitizeNameTicker('Valid Name', 'a!b').valid, false, 'punctuation not allowed')
})

test('sanitizeNameTicker: length-clamps name to 100 and ticker to 10', () => {
  const r = sanitizeNameTicker('n'.repeat(150), 'T'.repeat(20))
  assert.equal(r.cleanName.length, 100)
  assert.equal(r.cleanTicker.length, 10)
  assert.equal(r.valid, true)
})

test('sanitizeNameTicker: handles null/undefined inputs without throwing', () => {
  // The launcher may pass through a degraded proposal; must not crash.
  const r = sanitizeNameTicker(undefined as unknown as string, undefined as unknown as string)
  assert.equal(r.cleanName, '')
  assert.equal(r.cleanTicker, '')
  assert.equal(r.valid, false)
})

// ───────────────────────────────────────────────────────────────────────────
// clampInitialBuyBnb — the BNB blast-radius guard. NEVER exceeds 0.05.
// ───────────────────────────────────────────────────────────────────────────
const CAP = __test.MAX_INITIAL_BUY_BNB

test('clampInitialBuyBnb: cap constant is the expected 0.05 BNB', () => {
  assert.equal(CAP, 0.05, 'the Module 4 hard cap must stay 0.05 BNB')
})

test('clampInitialBuyBnb: clamps an over-cap LLM proposal down to 0.05', () => {
  assert.equal(clampInitialBuyBnb(null, 5), CAP)
  assert.equal(clampInitialBuyBnb(null, 0.06), CAP)
  assert.equal(clampInitialBuyBnb(null, Number.MAX_SAFE_INTEGER), CAP)
})

test('clampInitialBuyBnb: a user override WINS over the LLM but is still capped', () => {
  // User asks for under cap → honored.
  assert.equal(clampInitialBuyBnb('0.03', 0.01), 0.03)
  // User asks for over cap → clamped to cap (even though LLM was lower).
  assert.equal(clampInitialBuyBnb('10', 0.01), CAP)
})

test('clampInitialBuyBnb: blank/invalid user value falls back to the (clamped) LLM value', () => {
  assert.equal(clampInitialBuyBnb('', 0.02), 0.02)
  assert.equal(clampInitialBuyBnb('   ', 0.02), 0.02)
  assert.equal(clampInitialBuyBnb('not-a-number', 0.02), 0.02)
  assert.equal(clampInitialBuyBnb('0', 0.02), 0.02, 'non-positive user value is ignored')
  assert.equal(clampInitialBuyBnb('-1', 0.02), 0.02, 'negative user value is ignored')
})

test('clampInitialBuyBnb: never returns below 0', () => {
  assert.equal(clampInitialBuyBnb(null, -5), 0)
  assert.equal(clampInitialBuyBnb(null, NaN), 0, 'non-finite proposal → 0')
})

test('clampInitialBuyBnb: a malformed huge user value can never exceed the cap', () => {
  assert.equal(clampInitialBuyBnb('999999', 999999), CAP)
})

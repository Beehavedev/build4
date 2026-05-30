import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../db'
import { _writeAgentLogRaw } from '../agents/tradingAgent'

// ── Spy harness ──────────────────────────────────────────────────────────
// The perp-trading path records every brain decision via _writeAgentLogRaw,
// the raw-SQL fallback used when the deployed Prisma client is stale. The
// INSERT binds 15 ordered parameters — a swap (e.g. adx/rsi/score, or
// pair/price) would silently mislabel every recorded trade decision, and the
// regression would only surface in production data. These spies record each
// db.$executeRawUnsafe call so we can assert the column list lines up with the
// $N placeholders and the params land in the documented slots. The exec spy
// can be told to throw on a given call index to drive the minimal-insert
// fallback branch. Mirrors src/__tests__/fortyTwoExecutorSql.test.ts.
type Call = { sql: string; params: unknown[] }

type DbWithRaw = {
  $queryRawUnsafe: <T = unknown>(sql: string, ...params: unknown[]) => Promise<T>
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>
}
const dbRaw = db as unknown as DbWithRaw

function installSqlSpies(opts: { failExecCalls?: number[] } = {}) {
  const calls: Call[] = []
  const failExec = new Set(opts.failExecCalls ?? [])
  let execIdx = 0
  const originalExec = dbRaw.$executeRawUnsafe
  dbRaw.$executeRawUnsafe = async (sql: string, ...params: unknown[]): Promise<number> => {
    calls.push({ sql, params })
    const idx = execIdx++
    if (failExec.has(idx)) throw new Error('simulated: column does not exist')
    return 1
  }
  return {
    calls,
    restore() {
      dbRaw.$executeRawUnsafe = originalExec
    },
  }
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

// ── _writeAgentLogRaw: full insert ───────────────────────────────────────
test('_writeAgentLogRaw INSERTs all 15 columns with params in the documented slot order', async () => {
  const spy = installSqlSpies()
  try {
    await _writeAgentLogRaw({
      agentId: 'agent_1',
      userId: 'user_1',
      action: 'OPEN_LONG',
      rawResponse: '{"x":1}',
      parsedAction: 'OPEN_LONG',
      executionResult: 'filled',
      error: null,
      pair: 'BTCUSDT',
      price: 65000,
      reason: 'breakout',
      adx: 30,
      rsi: 55,
      score: 7,
      regime: 'UPTREND',
      exchange: 'aster',
    })
    assert.equal(spy.calls.length, 1, 'one INSERT, no fallback when the full insert succeeds')
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /INSERT INTO\s+"AgentLog"/i)
    // Column list and VALUES placeholders must agree. id/createdAt are
    // generated in-SQL (gen_random_uuid / CURRENT_TIMESTAMP), so only the
    // remaining 15 columns are bound to $1..$15.
    assert.match(
      n,
      /\(\s*"id"\s*,\s*"agentId"\s*,\s*"userId"\s*,\s*"action"\s*,\s*"rawResponse"\s*,\s*"parsedAction"\s*,\s*"executionResult"\s*,\s*"error"\s*,\s*"pair"\s*,\s*"price"\s*,\s*"reason"\s*,\s*"adx"\s*,\s*"rsi"\s*,\s*"score"\s*,\s*"regime"\s*,\s*"exchange"\s*,\s*"createdAt"\s*\)/i,
    )
    assert.match(n, /gen_random_uuid\(\)::text/i, 'id generated in SQL, not bound')
    assert.match(n, /CURRENT_TIMESTAMP/i, 'createdAt generated in SQL, not bound')
    assert.match(n, /\$15/, 'binds exactly 15 positional params')
    assert.doesNotMatch(n, /\$16/, 'never binds a 16th param')
    assert.deepEqual(params, [
      'agent_1', 'user_1', 'OPEN_LONG', '{"x":1}', 'OPEN_LONG',
      'filled', null, 'BTCUSDT', 65000, 'breakout',
      30, 55, 7, 'UPTREND', 'aster',
    ])
  } finally {
    spy.restore()
  }
})

test('_writeAgentLogRaw applies its defaults (action→HOLD, all other missing fields→null)', async () => {
  const spy = installSqlSpies()
  try {
    // Only agentId + userId provided; everything else must default.
    await _writeAgentLogRaw({ agentId: 'a', userId: 'u' })
    const { params } = spy.calls[0]
    // NB: $3 (action) defaults to 'HOLD', but $5 (parsedAction) is
    // `d.parsedAction ?? d.action ?? null` — it reads the *raw* action, not
    // the resolved 'HOLD', so with no action at all it stays null. Locking
    // this in guards the asymmetry from being "fixed" into a silent change.
    assert.deepEqual(params, [
      'a', 'u', 'HOLD', null, null,
      null, null, null, null, null,
      null, null, null, null, null,
    ], 'action defaults to HOLD; parsedAction stays null when no action provided')
  } finally {
    spy.restore()
  }
})

test('_writeAgentLogRaw parsedAction prefers an explicit parsedAction over action', async () => {
  const spy = installSqlSpies()
  try {
    await _writeAgentLogRaw({ agentId: 'a', userId: 'u', action: 'CLOSE', parsedAction: 'HOLD' })
    const { params } = spy.calls[0]
    assert.equal(params[2], 'CLOSE', '$3 action')
    assert.equal(params[4], 'HOLD', '$5 parsedAction (explicit value wins, not coerced to action)')
  } finally {
    spy.restore()
  }
})

// ── _writeAgentLogRaw: minimal fallback insert ───────────────────────────
test('_writeAgentLogRaw falls back to the 5-column minimal insert when the full insert throws', async () => {
  // Simulate prod where the new columns do not exist yet: the first (full)
  // insert throws, so the helper retries with only the always-present columns
  // and folds the venue tag into executionResult.
  const spy = installSqlSpies({ failExecCalls: [0] })
  try {
    await _writeAgentLogRaw({
      agentId: 'a', userId: 'u', action: 'OPEN_SHORT',
      executionResult: 'filled', exchange: 'hl',
    })
    assert.equal(spy.calls.length, 2, 'full insert (throws) then minimal insert')
    const { sql, params } = spy.calls[1]
    const n = norm(sql)
    assert.match(
      n,
      /\(\s*"id"\s*,\s*"agentId"\s*,\s*"userId"\s*,\s*"action"\s*,\s*"parsedAction"\s*,\s*"executionResult"\s*,\s*"createdAt"\s*\)/i,
    )
    assert.match(n, /\$5/, 'minimal insert binds 5 params')
    assert.doesNotMatch(n, /\$6/, 'minimal insert never binds a 6th param')
    // venue must be preserved by appending to executionResult since the
    // dedicated exchange column is what is missing in this branch.
    assert.deepEqual(params, ['a', 'u', 'OPEN_SHORT', 'OPEN_SHORT', 'filled | venue=hl'])
  } finally {
    spy.restore()
  }
})

test('_writeAgentLogRaw minimal fallback tags venue=unknown when exchange is absent', async () => {
  const spy = installSqlSpies({ failExecCalls: [0] })
  try {
    await _writeAgentLogRaw({ agentId: 'a', userId: 'u' })
    const { params } = spy.calls[1]
    assert.equal(params[4], ' | venue=unknown', 'empty executionResult + unknown venue tag')
  } finally {
    spy.restore()
  }
})

test('_writeAgentLogRaw swallows the error when even the minimal insert fails (never crashes the tick)', async () => {
  // Both inserts throw → the helper must not propagate; a logging failure
  // can never be allowed to abort the trading tick.
  const spy = installSqlSpies({ failExecCalls: [0, 1] })
  try {
    await assert.doesNotReject(_writeAgentLogRaw({ agentId: 'a', userId: 'u' }))
    assert.equal(spy.calls.length, 2)
  } finally {
    spy.restore()
  }
})

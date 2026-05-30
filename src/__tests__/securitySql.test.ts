import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../db'
import {
  logSecurityEvent,
  checkExportRateLimit,
  checkPinFailLimit,
  PK_EXPORT_LIMIT_PER_24H,
  PIN_FAIL_LIMIT_PER_HOUR,
} from '../services/security'

// ── Spy harness ──────────────────────────────────────────────────────────
// The security-event path (src/services/security.ts) writes the audit trail
// and reads the rate-limit counters with raw SQL. A typo in a WHERE clause
// (e.g. matching the wrong action string) or a swapped $1/$2 parameter would
// only surface in production — a user could be locked out, or a rate limit
// could silently never trip. These spies record every db.$queryRawUnsafe /
// db.$executeRawUnsafe call so each test can assert the WHERE/SET clauses and
// the parameter binding order. Mirrors src/__tests__/fortyTwoExecutorSql.test.ts.
type Call = { sql: string; params: unknown[] }

type DbWithRaw = {
  $queryRawUnsafe: <T = unknown>(sql: string, ...params: unknown[]) => Promise<T>
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>
}
const dbRaw = db as unknown as DbWithRaw

function installSqlSpies(queryResults: unknown[][] = []) {
  const calls: Call[] = []
  const queryQueue = [...queryResults]
  const originalQuery = dbRaw.$queryRawUnsafe
  const originalExec = dbRaw.$executeRawUnsafe
  dbRaw.$queryRawUnsafe = async <T,>(sql: string, ...params: unknown[]): Promise<T> => {
    calls.push({ sql, params })
    return (queryQueue.shift() ?? []) as T
  }
  dbRaw.$executeRawUnsafe = async (sql: string, ...params: unknown[]): Promise<number> => {
    calls.push({ sql, params })
    return 1
  }
  return {
    calls,
    restore() {
      dbRaw.$queryRawUnsafe = originalQuery
      dbRaw.$executeRawUnsafe = originalExec
    },
  }
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

// ── logSecurityEvent ─────────────────────────────────────────────────────
test('logSecurityEvent INSERTs into SecurityLog with [userId, telegramId, action, walletId, meta] in order', async () => {
  const spy = installSqlSpies()
  try {
    await logSecurityEvent({
      userId: 'user_1',
      telegramId: 12345n,
      action: 'pk_export_success',
      walletId: 'wallet_9',
      meta: { ip: '1.2.3.4' },
    })
    assert.equal(spy.calls.length, 1)
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /INSERT INTO\s+"SecurityLog"/i)
    // Column list must match the VALUES placeholders one-for-one. A reorder
    // here without reordering the params would mislabel every audit row.
    assert.match(
      n,
      /\(\s*"userId"\s*,\s*"telegramId"\s*,\s*"action"\s*,\s*"walletId"\s*,\s*"meta"\s*\)/i,
    )
    assert.match(n, /VALUES\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*,\s*\$4\s*,\s*\$5::jsonb\s*\)/i,
      'meta column is cast ::jsonb so the JSON string is stored as jsonb, not text')
    // telegramId must be stringified (BigInt → String) so the driver can bind
    // it; meta must be JSON.stringify'd so the ::jsonb cast parses it.
    assert.deepEqual(params, [
      'user_1',
      '12345',
      'pk_export_success',
      'wallet_9',
      JSON.stringify({ ip: '1.2.3.4' }),
    ])
  } finally {
    spy.restore()
  }
})

test('logSecurityEvent defaults walletId to null and meta to {} when omitted', async () => {
  const spy = installSqlSpies()
  try {
    await logSecurityEvent({ userId: 'u', telegramId: '999', action: 'pin_set' })
    const { params } = spy.calls[0]
    assert.equal(params[3], null, 'missing walletId binds NULL, not undefined')
    assert.equal(params[4], JSON.stringify({}), 'missing meta binds "{}" so ::jsonb cast never sees undefined')
  } finally {
    spy.restore()
  }
})

// ── checkExportRateLimit ─────────────────────────────────────────────────
test('checkExportRateLimit counts pk_export_success rows in last 24h with [userId, since]', async () => {
  const spy = installSqlSpies([[{ n: 1 }]])
  try {
    const before = Date.now()
    const result = await checkExportRateLimit('user_1')
    assert.equal(spy.calls.length, 1)
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /SELECT\s+COUNT\(\*\)::int\s+AS\s+n\s+FROM\s+"SecurityLog"/i)
    assert.match(n, /"userId"\s*=\s*\$1/i, 'userId bound to $1')
    assert.match(n, /"action"\s*=\s*'pk_export_success'/i, "filters the export-success action only")
    assert.match(n, /"createdAt"\s*>=\s*\$2/i, 'cutoff bound to $2, not interpolated')
    assert.equal(params[0], 'user_1')
    assert.ok(params[1] instanceof Date, 'cutoff is a Date so the driver round-trips it as TIMESTAMP')
    const sinceMs = (params[1] as Date).getTime()
    assert.ok(sinceMs <= before - 23 * 60 * 60 * 1000)
    assert.ok(sinceMs >= before - 25 * 60 * 60 * 1000)
    // 1 used out of PK_EXPORT_LIMIT_PER_24H → allowed, remaining = limit-1.
    assert.deepEqual(result, { allowed: true, remaining: PK_EXPORT_LIMIT_PER_24H - 1 })
  } finally {
    spy.restore()
  }
})

test('checkExportRateLimit blocks once used reaches the limit and clamps remaining at 0', async () => {
  const spy = installSqlSpies([[{ n: PK_EXPORT_LIMIT_PER_24H }]])
  try {
    const result = await checkExportRateLimit('user_1')
    assert.deepEqual(result, { allowed: false, remaining: 0 })
  } finally {
    spy.restore()
  }
})

test('checkExportRateLimit treats an empty result as zero usage (fail-open count, not crash)', async () => {
  const spy = installSqlSpies([[]])
  try {
    const result = await checkExportRateLimit('user_1')
    assert.deepEqual(result, { allowed: true, remaining: PK_EXPORT_LIMIT_PER_24H })
  } finally {
    spy.restore()
  }
})

// ── checkPinFailLimit ────────────────────────────────────────────────────
test('checkPinFailLimit counts pin-fail actions in last hour with [userId, since]', async () => {
  const spy = installSqlSpies([[{ n: 2 }]])
  try {
    const before = Date.now()
    const result = await checkPinFailLimit('user_1')
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /SELECT\s+COUNT\(\*\)::int\s+AS\s+n\s+FROM\s+"SecurityLog"/i)
    assert.match(n, /"userId"\s*=\s*\$1/i)
    // Must count BOTH failure kinds — dropping one would let an attacker
    // double their effective attempts before the lockout trips.
    assert.match(
      n,
      /"action"\s+IN\s*\(\s*'pin_failed'\s*,\s*'pk_export_denied_bad_pin'\s*\)/i,
    )
    assert.match(n, /"createdAt"\s*>=\s*\$2/i)
    assert.equal(params[0], 'user_1')
    assert.ok(params[1] instanceof Date)
    const sinceMs = (params[1] as Date).getTime()
    // Window is one hour, not 24h — a copy-paste from the export limit would
    // widen the lockout window 24x.
    assert.ok(sinceMs <= before - 59 * 60 * 1000)
    assert.ok(sinceMs >= before - 61 * 60 * 1000)
    assert.deepEqual(result, { allowed: true, locked: false })
  } finally {
    spy.restore()
  }
})

test('checkPinFailLimit locks once fails reach the limit', async () => {
  const spy = installSqlSpies([[{ n: PIN_FAIL_LIMIT_PER_HOUR }]])
  try {
    const result = await checkPinFailLimit('user_1')
    assert.deepEqual(result, { allowed: false, locked: true })
  } finally {
    spy.restore()
  }
})

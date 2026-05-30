import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../db'
import {
  _sumOpenedLast24hRaw,
  _findOpenPositionOnPoolRaw,
  _loadActiveTopazAgentsRaw,
  _touchAgentTickRaw,
  _loadOpenPositionsRaw,
  _insertV2PositionRaw,
  _insertV3PositionRaw,
  _closePositionRaw,
  _incrementClaimedRaw,
} from '../agents/topazAgent'

// ── Spy harness ──────────────────────────────────────────────────────────
// topazAgent issues the most raw SQL of any remaining venue: position
// totals, idempotency probes, and the OPEN/CLOSE/CLAIM position writes.
// A column rename or a swapped $1/$2 in any of these would silently
// corrupt LP-position accounting and only ever surface in production.
// These spies record every db.$queryRawUnsafe / db.$executeRawUnsafe call
// so each test can assert the WHERE/SET clauses and the parameter binding
// order. Mirrors src/__tests__/securitySql.test.ts.
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

// ── _sumOpenedLast24hRaw ─────────────────────────────────────────────────
test('_sumOpenedLast24hRaw SUMs entryValueUsdt for the agent inside a 24h window', async () => {
  const spy = installSqlSpies([[{ total: '120.5' }]])
  try {
    const total = await _sumOpenedLast24hRaw('agent_1')
    assert.equal(spy.calls.length, 1)
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /SELECT\s+COALESCE\(SUM\("entryValueUsdt"\),\s*0\)::text\s+AS\s+total/i)
    assert.match(n, /FROM\s+"TopazPosition"/i)
    assert.match(n, /"agentId"\s*=\s*\$1/i, 'agentId bound to $1, not interpolated')
    // Window is 24h, not 1h/7d — a typo here would widen or narrow the
    // daily-exposure circuit breaker.
    assert.match(n, /"openedAt"\s*>=\s*NOW\(\)\s*-\s*INTERVAL\s*'24 hours'/i)
    assert.deepEqual(params, ['agent_1'])
    // COALESCE(...,0)::text returns a string — helper must coerce to number.
    assert.strictEqual(total, 120.5)
  } finally {
    spy.restore()
  }
})

test('_sumOpenedLast24hRaw treats an empty result as zero exposure (no crash)', async () => {
  const spy = installSqlSpies([[]])
  try {
    assert.strictEqual(await _sumOpenedLast24hRaw('agent_1'), 0)
  } finally {
    spy.restore()
  }
})

// ── _findOpenPositionOnPoolRaw ───────────────────────────────────────────
test('_findOpenPositionOnPoolRaw probes open positions case-insensitively with [agentId, pool]', async () => {
  const spy = installSqlSpies([[{ id: 'pos_9' }]])
  try {
    const rows = await _findOpenPositionOnPoolRaw('agent_1', '0xPOOL')
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /SELECT\s+id\s+FROM\s+"TopazPosition"/i)
    assert.match(n, /"agentId"\s*=\s*\$1/i, 'agentId bound to $1')
    // Pool match must LOWER both sides — the column is stored lowercased
    // but the decision pool may arrive checksummed; dropping either LOWER
    // would let a duplicate LP slip through the dedup guard.
    assert.match(n, /LOWER\("poolAddress"\)\s*=\s*LOWER\(\$2\)/i)
    assert.match(n, /status\s*=\s*'open'/i, 'only open positions count as duplicates')
    assert.match(n, /LIMIT\s+1/i)
    assert.deepEqual(params, ['agent_1', '0xPOOL'])
    assert.deepEqual(rows, [{ id: 'pos_9' }])
  } finally {
    spy.restore()
  }
})

// ── _loadActiveTopazAgentsRaw ────────────────────────────────────────────
test('_loadActiveTopazAgentsRaw selects active, unpaused agents by id-array with COALESCE defaults', async () => {
  const spy = installSqlSpies([[{ id: 'a1' }]])
  try {
    const rows = await _loadActiveTopazAgentsRaw(['a1', 'a2'])
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /FROM\s+"Agent"\s+a/i)
    // Paused or inactive agents must never tick.
    assert.match(n, /a\."isActive"\s*=\s*true\s+AND\s+a\."isPaused"\s*=\s*false/i)
    // ANY($1::text[]) — the id list is bound as a text[] param, not spliced.
    assert.match(n, /a\."id"\s*=\s*ANY\(\$1::text\[\]\)/i)
    // Missing per-agent config must fall back to safe defaults.
    assert.match(n, /COALESCE\(a\."topazEnabled",\s*false\)\s+AS\s+"topazEnabled"/i)
    assert.match(n, /COALESCE\(a\."topazMaxSizeUsdt",\s*50\)\s+AS\s+"topazMaxSizeUsdt"/i)
    assert.deepEqual(params, [['a1', 'a2']])
    assert.deepEqual(rows, [{ id: 'a1' }])
  } finally {
    spy.restore()
  }
})

// ── _touchAgentTickRaw ───────────────────────────────────────────────────
test('_touchAgentTickRaw stamps lastTopazTickAt=NOW() for the agent id only', async () => {
  const spy = installSqlSpies()
  try {
    await _touchAgentTickRaw('agent_1')
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /UPDATE\s+"Agent"\s+SET\s+"lastTopazTickAt"\s*=\s*NOW\(\)/i)
    assert.match(n, /WHERE\s+id\s*=\s*\$1/i, 'scoped to the single agent id, never a blanket update')
    assert.deepEqual(params, ['agent_1'])
  } finally {
    spy.restore()
  }
})

// ── _loadOpenPositionsRaw ────────────────────────────────────────────────
test('_loadOpenPositionsRaw loads the agent open positions newest-first with lpAmount cast to text', async () => {
  const spy = installSqlSpies([[{ id: 'p1' }]])
  try {
    const rows = await _loadOpenPositionsRaw('agent_1')
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /FROM\s+"TopazPosition"/i)
    assert.match(n, /"agentId"\s*=\s*\$1\s+AND\s+status\s*=\s*'open'/i)
    assert.match(n, /ORDER\s+BY\s+"openedAt"\s+DESC/i)
    // lpAmount is numeric in PG; ::text keeps full precision so BigInt()
    // can parse it without float rounding when we later unstake.
    assert.match(n, /"lpAmount"::text\s+AS\s+"lpAmount"/i)
    assert.deepEqual(params, ['agent_1'])
    assert.deepEqual(rows, [{ id: 'p1' }])
  } finally {
    spy.restore()
  }
})

// ── _insertV2PositionRaw ─────────────────────────────────────────────────
test('_insertV2PositionRaw INSERTs a v2-lp row with columns and $-params one-for-one', async () => {
  const spy = installSqlSpies()
  try {
    await _insertV2PositionRaw({
      userId: 'u1',
      agentId: 'a1',
      poolAddress: '0xpair',
      entryValueUsdt: 50,
      txHashOpen: '0xopen',
      gaugeAddress: '0xgauge',
      lpAmount: '12345',
      tokenA: '0xA',
      tokenB: '0xB',
      stable: true,
      reasoning: 'because yield',
    })
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /INSERT INTO\s+"TopazPosition"/i)
    // Column list — literal positionType/status, the rest bound.
    assert.match(
      n,
      /\(\s*"userId"\s*,\s*"agentId"\s*,\s*"poolAddress"\s*,\s*"positionType"\s*,\s*"status"\s*,\s*"entryValueUsdt"\s*,\s*"txHashOpen"\s*,\s*"gaugeAddress"\s*,\s*"lpAmount"\s*,\s*"tokenA"\s*,\s*"tokenB"\s*,\s*"stable"\s*,\s*"reasoning"\s*,\s*"openedAt"\s*\)/i,
    )
    // VALUES must pin the literals and cast lpAmount to numeric so the
    // string we pass round-trips into the numeric column.
    assert.match(
      n,
      /VALUES\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*,\s*'v2-lp'\s*,\s*'open'\s*,\s*\$4\s*,\s*\$5\s*,\s*\$6\s*,\s*\$7::numeric\s*,\s*\$8\s*,\s*\$9\s*,\s*\$10\s*,\s*\$11\s*,\s*NOW\(\)\s*\)/i,
    )
    // Binding order is the whole point: a swap here mislabels a position.
    assert.deepEqual(params, [
      'u1', 'a1', '0xpair', 50, '0xopen', '0xgauge', '12345', '0xA', '0xB', true, 'because yield',
    ])
  } finally {
    spy.restore()
  }
})

// ── _insertV3PositionRaw ─────────────────────────────────────────────────
test('_insertV3PositionRaw INSERTs a v3-nft row with tokenId/ticks bound in order', async () => {
  const spy = installSqlSpies()
  try {
    await _insertV3PositionRaw({
      userId: 'u1',
      agentId: 'a1',
      poolAddress: '0xpool',
      entryValueUsdt: 75,
      tokenId: '4242',
      tickLower: -120,
      tickUpper: 120,
      txHashOpen: '0xmint',
      gaugeAddress: '0xgauge',
      reasoning: 'tight range',
    })
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /INSERT INTO\s+"TopazPosition"/i)
    assert.match(
      n,
      /\(\s*"userId"\s*,\s*"agentId"\s*,\s*"poolAddress"\s*,\s*"positionType"\s*,\s*"status"\s*,\s*"entryValueUsdt"\s*,\s*"tokenId"\s*,\s*"tickLower"\s*,\s*"tickUpper"\s*,\s*"txHashOpen"\s*,\s*"gaugeAddress"\s*,\s*"reasoning"\s*,\s*"openedAt"\s*\)/i,
    )
    assert.match(
      n,
      /VALUES\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*,\s*'v3-nft'\s*,\s*'open'\s*,\s*\$4\s*,\s*\$5\s*,\s*\$6\s*,\s*\$7\s*,\s*\$8\s*,\s*\$9\s*,\s*\$10\s*,\s*NOW\(\)\s*\)/i,
    )
    assert.deepEqual(params, [
      'u1', 'a1', '0xpool', 75, '4242', -120, 120, '0xmint', '0xgauge', 'tight range',
    ])
  } finally {
    spy.restore()
  }
})

test('_insertV3PositionRaw binds a null tokenId rather than dropping the slot', async () => {
  const spy = installSqlSpies()
  try {
    await _insertV3PositionRaw({
      userId: 'u1', agentId: 'a1', poolAddress: '0xp', entryValueUsdt: 10,
      tokenId: null, tickLower: 0, tickUpper: 1, txHashOpen: null,
      gaugeAddress: null, reasoning: 'r',
    })
    const { params } = spy.calls[0]
    assert.equal(params[4], null, 'tokenId binds NULL ($5), keeping later params aligned')
    assert.equal(params[7], null, 'txHashOpen binds NULL ($8)')
    assert.equal(params[8], null, 'gaugeAddress binds NULL ($9)')
  } finally {
    spy.restore()
  }
})

// ── _closePositionRaw ────────────────────────────────────────────────────
test('_closePositionRaw sets status=closed + exit amounts/value + close tx, scoped by id=$1', async () => {
  const spy = installSqlSpies()
  try {
    await _closePositionRaw({
      id: 'pos_1',
      exitAmt0: 1.25,
      exitAmt1: 2.5,
      exitValueUsdt: 5,
      txHashClose: '0xclose',
    })
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /UPDATE\s+"TopazPosition"/i)
    assert.match(n, /SET\s+status\s*=\s*'closed'/i)
    // exitAmt0/1 are $2/$3, exitValueUsdt $4, txHashClose $5 — id is $1.
    assert.match(n, /"exitAmt0"\s*=\s*\$2\s*,\s*"exitAmt1"\s*=\s*\$3/i)
    assert.match(n, /"exitValueUsdt"\s*=\s*\$4/i)
    assert.match(n, /"txHashClose"\s*=\s*\$5/i)
    assert.match(n, /"closedAt"\s*=\s*NOW\(\)/i)
    assert.match(n, /WHERE\s+id\s*=\s*\$1/i, 'closes exactly one position, never a blanket update')
    assert.deepEqual(params, ['pos_1', 1.25, 2.5, 5, '0xclose'])
  } finally {
    spy.restore()
  }
})

test('_closePositionRaw binds a null exitValueUsdt when no stable leg priced it', async () => {
  const spy = installSqlSpies()
  try {
    await _closePositionRaw({
      id: 'pos_1', exitAmt0: 0, exitAmt1: 0, exitValueUsdt: null, txHashClose: null,
    })
    const { params } = spy.calls[0]
    assert.equal(params[3], null, 'exitValueUsdt binds NULL ($4) — no fake pricing')
    assert.equal(params[4], null, 'txHashClose binds NULL ($5)')
  } finally {
    spy.restore()
  }
})

// ── _incrementClaimedRaw ─────────────────────────────────────────────────
test('_incrementClaimedRaw NULL-safe adds the claimed amount, scoped by id=$1', async () => {
  const spy = installSqlSpies()
  try {
    await _incrementClaimedRaw('pos_1', 0.5)
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /UPDATE\s+"TopazPosition"/i)
    // COALESCE(...,0)+$2 must be NULL-safe so the first claim doesn't write NULL.
    assert.match(n, /"claimedTopazAmt"\s*=\s*COALESCE\("claimedTopazAmt",\s*0\)\s*\+\s*\$2/i)
    assert.match(n, /WHERE\s+id\s*=\s*\$1/i)
    // id is $1 and the amount is $2 — swapping them would update the wrong row.
    assert.deepEqual(params, ['pos_1', 0.5])
  } finally {
    spy.restore()
  }
})

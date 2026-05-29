import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../db'
import {
  __testDeps,
  getActiveCompetition,
  getMyEntry,
  joinCompetition,
  recordCompetitionTrade,
} from './competition'

// ── Spy harness ──────────────────────────────────────────────────────────
// competition.ts reads via db.$queryRawUnsafe and writes via
// db.$executeRawUnsafe. We swap both with recording spies so each test can
// (a) feed deterministic query results in call order and (b) assert the
// param binding order matches the $1,$2,... placeholders.
type Call = { sql: string; params: unknown[] }
type DbWithRaw = {
  $queryRawUnsafe: <T = unknown>(sql: string, ...params: unknown[]) => Promise<T>
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>
}
const dbRaw = db as unknown as DbWithRaw

function installSpies(queryResults: unknown[][] = []) {
  const queries: Call[] = []
  const execs: Call[] = []
  const queue = [...queryResults]
  const origQuery = dbRaw.$queryRawUnsafe
  const origExec = dbRaw.$executeRawUnsafe
  dbRaw.$queryRawUnsafe = async <T,>(sql: string, ...params: unknown[]): Promise<T> => {
    queries.push({ sql, params })
    return (queue.shift() ?? []) as T
  }
  dbRaw.$executeRawUnsafe = async (sql: string, ...params: unknown[]): Promise<number> => {
    execs.push({ sql, params })
    return 1
  }
  const restore = () => {
    dbRaw.$queryRawUnsafe = origQuery
    dbRaw.$executeRawUnsafe = origExec
  }
  return { queries, execs, restore }
}

const COMP_ROW = {
  id: 'comp-1',
  name: 'BUILD4 × four.meme Season 1',
  start_date: '2026-05-29T12:00:00Z',
  end_date: '2026-06-05T12:00:00Z',
  status: 'active',
  prize_pool: '2820',
  max_entries: 500,
}

function stubBalance(native: number, error: string | null = null) {
  const orig = __testDeps.getWalletBalances
  __testDeps.getWalletBalances = async () => ({
    usdt: 0,
    native,
    nativeSymbol: 'BNB',
    error,
  })
  return () => {
    __testDeps.getWalletBalances = orig
  }
}

test('getActiveCompetition parses the active row', async () => {
  const spy = installSpies([[COMP_ROW]])
  try {
    const comp = await getActiveCompetition()
    assert.ok(comp)
    assert.equal(comp!.id, 'comp-1')
    assert.equal(comp!.status, 'active')
    assert.equal(comp!.maxEntries, 500)
    // Must only consider upcoming/active comps.
    assert.match(spy.queries[0].sql, /status IN \('upcoming', 'active'\)/)
  } finally {
    spy.restore()
  }
})

test('getActiveCompetition returns null when none', async () => {
  const spy = installSpies([[]])
  try {
    assert.equal(await getActiveCompetition(), null)
  } finally {
    spy.restore()
  }
})

test('joinCompetition fails cleanly when no active competition', async () => {
  const spy = installSpies([[]])
  try {
    const r = await joinCompetition({ chatId: '123', walletAddress: '0xabc' })
    assert.equal(r.ok, false)
    assert.equal((r as any).reason, 'no_competition')
  } finally {
    spy.restore()
  }
})

test('joinCompetition refuses an ended competition', async () => {
  const spy = installSpies([[{ ...COMP_ROW, status: 'ended' }]])
  try {
    const r = await joinCompetition({ chatId: '123', walletAddress: '0xabc' })
    assert.equal(r.ok, false)
    assert.equal((r as any).reason, 'ended')
  } finally {
    spy.restore()
  }
})

test('joinCompetition is idempotent for an existing entry', async () => {
  // getActiveCompetition → existing-entry lookup returns a row.
  const spy = installSpies([[COMP_ROW], [{ id: 'entry-9', starting_balance_usdt: 1.5 }]])
  const restoreBal = stubBalance(99) // should NOT be consulted on the fast path
  try {
    const r = await joinCompetition({ chatId: '123', walletAddress: '0xabc' })
    assert.equal(r.ok, true)
    assert.equal((r as any).alreadyJoined, true)
    assert.equal((r as any).entryId, 'entry-9')
    assert.equal((r as any).startingBnb, 1.5)
    // No INSERT should have been issued.
    assert.equal(spy.execs.length, 0)
  } finally {
    restoreBal()
    spy.restore()
  }
})

test('joinCompetition snapshots BNB and writes chat_id as the telegram id', async () => {
  // queries: active comp → existing (none) → guarded INSERT…RETURNING (row present)
  const spy = installSpies([
    [COMP_ROW],
    [],
    [{ id: 'entry-new', starting_balance_usdt: 2.25 }],
  ])
  const restoreBal = stubBalance(2.25)
  try {
    const r = await joinCompetition({
      chatId: '777',
      walletAddress: '0xWALLET',
      username: 'alice',
    })
    assert.equal(r.ok, true)
    assert.equal((r as any).alreadyJoined, false)
    assert.equal((r as any).startingBnb, 2.25)
    assert.equal((r as any).entryId, 'entry-new')
    // The INSERT now runs via $queryRawUnsafe (it uses RETURNING), so it lands
    // in spy.queries, not spy.execs. It is the 3rd query (after active-comp +
    // existing-entry lookups) and a fresh join should NOT need a recheck.
    assert.equal(spy.execs.length, 0)
    assert.equal(spy.queries.length, 3)
    const ins = spy.queries[2]
    assert.match(ins.sql, /INSERT INTO aster_competition_entries/)
    assert.match(ins.sql, /ON CONFLICT \(competition_id, chat_id\) DO NOTHING/)
    assert.match(ins.sql, /RETURNING id, starting_balance_usdt/)
    // Param order: $1 comp, $2 chat_id, $3 username, $4 wallet, $5 startingBnb...
    assert.equal(ins.params[0], 'comp-1')
    assert.equal(ins.params[1], '777') // chat_id MUST equal the telegram id
    assert.equal(ins.params[2], 'alice')
    assert.equal(ins.params[3], '0xWALLET')
    assert.equal(ins.params[4], 2.25)
  } finally {
    restoreBal()
    spy.restore()
  }
})

test('joinCompetition reports a full competition', async () => {
  // active comp → existing (none) → INSERT…RETURNING (no row = capacity guard
  // rejected) → recheck by chat_id (still none = the user really did not get in)
  const spy = installSpies([[COMP_ROW], [], [], []])
  const restoreBal = stubBalance(1)
  try {
    const r = await joinCompetition({ chatId: '777', walletAddress: '0xabc' })
    assert.equal(r.ok, false)
    assert.equal((r as any).reason, 'full')
    // The recheck must have happened: 4 queries total.
    assert.equal(spy.queries.length, 4)
  } finally {
    restoreBal()
    spy.restore()
  }
})

test('joinCompetition treats a lost capacity-boundary race as alreadyJoined', async () => {
  // The deterministic-messaging case this task targets: the guarded INSERT
  // returns no row (ON CONFLICT or capacity), but the recheck finds a row for
  // this chat_id — meaning the user IS in the competition. They must be told
  // "already joined", never the misleading "full".
  // active comp → existing (none) → INSERT…RETURNING (no row) → recheck (row present)
  const spy = installSpies([
    [COMP_ROW],
    [],
    [],
    [{ id: 'entry-race', starting_balance_usdt: 3.5 }],
  ])
  const restoreBal = stubBalance(3.5)
  try {
    const r = await joinCompetition({ chatId: '777', walletAddress: '0xabc' })
    assert.equal(r.ok, true)
    assert.equal((r as any).alreadyJoined, true)
    assert.equal((r as any).entryId, 'entry-race')
    assert.equal((r as any).startingBnb, 3.5)
    assert.equal(spy.queries.length, 4)
  } finally {
    restoreBal()
    spy.restore()
  }
})

test('joinCompetition fails closed when the balance read errors (no insert)', async () => {
  // active comp → existing (none). Balance provider returns an RPC error, so
  // we must NOT insert a zero-baseline entry that would corrupt PnL/ranking.
  const spy = installSpies([[COMP_ROW], []])
  const restoreBal = stubBalance(0, 'rpc_failed')
  try {
    const r = await joinCompetition({ chatId: '777', walletAddress: '0xabc' })
    assert.equal(r.ok, false)
    assert.equal((r as any).reason, 'error')
    // No INSERT should have been attempted.
    assert.equal(spy.execs.length, 0)
  } finally {
    restoreBal()
    spy.restore()
  }
})

test('recordCompetitionTrade no-ops when not joined', async () => {
  const spy = installSpies([[COMP_ROW], []]) // active comp, then no entry
  try {
    await recordCompetitionTrade({ chatId: '123', tokenAddress: '0xTOKEN' })
    // No UPDATE issued.
    assert.equal(spy.execs.length, 0)
  } finally {
    spy.restore()
  }
})

test('recordCompetitionTrade adds a new token and bumps trade_count', async () => {
  const spy = installSpies([
    [COMP_ROW],
    [{ id: 'entry-1', tracked_tokens: '[]' }],
  ])
  try {
    await recordCompetitionTrade({ chatId: '123', tokenAddress: '0xAAA' })
    assert.equal(spy.execs.length, 1)
    const up = spy.execs[0]
    assert.match(up.sql, /trade_count = trade_count \+ 1/)
    const tracked = JSON.parse(String(up.params[0]))
    assert.deepEqual(tracked, ['0xAAA'])
    assert.equal(up.params[1], 'entry-1')
  } finally {
    spy.restore()
  }
})

test('recordCompetitionTrade does not duplicate an already-tracked token', async () => {
  const spy = installSpies([
    [COMP_ROW],
    [{ id: 'entry-1', tracked_tokens: '["0xaaa"]' }],
  ])
  try {
    // Same token, different case — must not be added twice.
    await recordCompetitionTrade({ chatId: '123', tokenAddress: '0xAAA' })
    const up = spy.execs[0]
    const tracked = JSON.parse(String(up.params[0]))
    assert.equal(tracked.length, 1)
  } finally {
    spy.restore()
  }
})

test('recordCompetitionTrade swallows errors (never throws)', async () => {
  const orig = dbRaw.$queryRawUnsafe
  dbRaw.$queryRawUnsafe = async () => {
    throw new Error('db down')
  }
  try {
    await recordCompetitionTrade({ chatId: '123', tokenAddress: '0xAAA' })
  } finally {
    dbRaw.$queryRawUnsafe = orig
  }
})

test('getMyEntry returns null with no active competition', async () => {
  const spy = installSpies([[]])
  try {
    assert.equal(await getMyEntry('123'), null)
  } finally {
    spy.restore()
  }
})

test('getMyEntry maps row fields, parses tracked tokens, and resolves rank', async () => {
  const spy = installSpies([
    [COMP_ROW],
    [{
      id: 'e1', agent_name: null, persona: 'manual', mode: 'manual',
      wallet_address: '0xabc', starting_balance_usdt: 1, current_equity_usdt: 1.2,
      pnl_usdt: 0.2, pnl_percent: 20, trade_count: 3,
      tracked_tokens: '["0xAAA","0xBBB"]', joined_at: '2026-05-30T00:00:00Z',
    }],
    [{ rank: 4, total: 42 }],
  ])
  try {
    const e = await getMyEntry('123')
    assert.ok(e)
    assert.equal(e!.tradeCount, 3)
    assert.equal(e!.pnlPct, 20)
    assert.deepEqual(e!.trackedTokens, ['0xAAA', '0xBBB'])
    assert.equal(e!.rank, 4)
    assert.equal(e!.totalEntries, 42)
    // Rank must mirror the web leaderboard: sequential ROW_NUMBER() with the
    // SAME ORDER BY (no RANK(), which would diverge on tied pnl_percent).
    assert.match(spy.queries[2].sql, /ROW_NUMBER\(\) OVER \(ORDER BY pnl_percent DESC NULLS LAST\)/)
  } finally {
    spy.restore()
  }
})

test('getMyEntry tolerates a missing rank row (unranked)', async () => {
  const spy = installSpies([
    [COMP_ROW],
    [{
      id: 'e1', agent_name: null, persona: 'manual', mode: 'manual',
      wallet_address: '0xabc', starting_balance_usdt: 1, current_equity_usdt: 1,
      pnl_usdt: 0, pnl_percent: 0, trade_count: 0,
      tracked_tokens: '[]', joined_at: '2026-05-30T00:00:00Z',
    }],
    [],
  ])
  try {
    const e = await getMyEntry('123')
    assert.ok(e)
    assert.equal(e!.rank, null)
    assert.equal(e!.totalEntries, 0)
  } finally {
    spy.restore()
  }
})

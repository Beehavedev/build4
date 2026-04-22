import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ethers } from 'ethers'
import { db } from '../db'
import {
  __testDeps,
  openPredictionPosition,
  closePredictionPosition,
  settleResolvedPositions,
  listOpenAgentPositions,
  listUserPositions,
  isUserLiveOptedIn,
  setUserLiveOptIn,
  type ExecutorDeps,
  type ExecutorTrader,
  type ExecutorTraderCtor,
  type ProviderTelemetry,
  type OutcomePositionRow,
} from '../services/fortyTwoExecutor'
import type { Market42, MarketStatus } from '../services/fortyTwo'
import type { OnchainMarketState, OnchainOutcome } from '../services/fortyTwoOnchain'
import type { DryRunReceipt } from '../services/fortyTwoTrader'

// ── Spy harness ──────────────────────────────────────────────────────────
// Each helper in fortyTwoExecutor goes through db.$queryRawUnsafe (SELECT/
// INSERT...RETURNING) or db.$executeRawUnsafe (UPDATE). We swap both with
// recording spies so every test can assert (a) the WHERE/SET clauses match
// the intended invariants and (b) the parameter binding order matches the
// $1,$2,... placeholders. A typo like writing "agentId" = $2 but passing
// userId in slot $2 would only ever surface in production — these spies
// catch it pre-merge.
type Call = { sql: string; params: unknown[] }

// db.$queryRawUnsafe / db.$executeRawUnsafe are heavily generic. The single
// cast here lets us swap in a typed spy for the whole test file without
// scattering casts at every call site.
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

// Snapshot/restore the dependency seam between tests so each test starts from
// the real production wiring and can't leak mocks into its neighbours.
function withDeps(overrides: Partial<ExecutorDeps>): () => void {
  const snapshot = { ...__testDeps }
  Object.assign(__testDeps, overrides)
  return () => {
    Object.assign(__testDeps, snapshot)
  }
}

// ── Typed test fixtures ──────────────────────────────────────────────────

function stubMarket(overrides: Partial<Market42> = {}): Market42 {
  return {
    address: '0xMarket',
    questionId: 'qid',
    question: 'Will X happen?',
    slug: 'will-x',
    collateralAddress: '0xUSDT',
    collateralSymbol: 'USDT',
    collateralDecimals: 18,
    curve: '0xCurve',
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    status: 'live' as MarketStatus,
    finalisedAt: null,
    elapsedPct: 0,
    image: null,
    oracleAddress: null,
    creatorAddress: null,
    contractVersion: 1,
    ancillaryData: [],
    description: '',
    ...overrides,
  }
}

function stubOutcome(overrides: Partial<OnchainOutcome> = {}): OnchainOutcome {
  return {
    index: 0,
    tokenId: 7,
    label: 'YES',
    marginalPrice: 0n,
    priceFloat: 0.4,
    impliedProbability: 0.4,
    isWinner: false,
    ...overrides,
  }
}

function stubOnchainState(overrides: Partial<OnchainMarketState> = {}): OnchainMarketState {
  return {
    market: '0xMarket',
    questionId: 'qid',
    curve: '0xCurve',
    collateralDecimals: 18,
    numOutcomes: 2,
    feeRate: 0n,
    isFinalised: false,
    resolvedAnswer: 0n,
    timestampEnd: 0,
    outcomes: [stubOutcome()],
    ...overrides,
  }
}

function stubPosition(overrides: Partial<OutcomePositionRow> = {}): OutcomePositionRow {
  return {
    id: 'pos_x',
    userId: 'u',
    agentId: 'a',
    marketAddress: '0xMarket',
    marketTitle: 'Q?',
    tokenId: 7,
    outcomeLabel: 'YES',
    usdtIn: 2,
    entryPrice: 0.4,
    exitPrice: null,
    payoutUsdt: null,
    pnl: null,
    status: 'open',
    paperTrade: true,
    txHashOpen: '0xopen',
    txHashClose: null,
    reasoning: null,
    openedAt: new Date(),
    closedAt: null,
    outcomeTokenAmount: 5,
    providers: null,
    ...overrides,
  }
}

function stubProvider(overrides: Partial<ProviderTelemetry> = {}): ProviderTelemetry {
  return {
    provider: 'anthropic',
    model: 'claude',
    action: 'OPEN_LONG',
    reasoning: 'edge',
    latencyMs: 5,
    inputTokens: 4,
    outputTokens: 6,
    tokensUsed: 10,
    ...overrides,
  }
}

// Minimal in-memory wallet stub: db.wallet.findFirst is a Prisma builder, so
// we type the override against the production signature.
type WalletFindFirst = typeof db.wallet.findFirst
function withWalletFindFirst(
  impl: (...args: Parameters<WalletFindFirst>) => Promise<{
    address: string
    encryptedPK: string
    chain: string
    isActive: boolean
  } | null>,
): () => void {
  const original = db.wallet.findFirst
  // The shape we return is structurally a subset of Prisma's Wallet model —
  // the executor only reads `encryptedPK` and `address`. The cast is local
  // and acknowledged: we deliberately don't conjure a full Wallet record.
  ;(db.wallet as { findFirst: unknown }).findFirst = impl as unknown as WalletFindFirst
  return () => {
    ;(db.wallet as { findFirst: WalletFindFirst }).findFirst = original
  }
}

// Trader factory: produce an `ExecutorTraderCtor` that returns a stub with
// just the three methods the executor calls. Receipt-shaped values use the
// public DryRunReceipt type so we never cast through `any`.
function makeTraderCtor(impl: Partial<ExecutorTrader>): ExecutorTraderCtor {
  class StubTrader implements ExecutorTrader {
    constructor(_pk: string, _rpc: string, _opts: { dryRun: boolean }) {}
    async buyOutcome(): Promise<ethers.TransactionReceipt | DryRunReceipt | null> {
      if (impl.buyOutcome) return impl.buyOutcome('', 0, '', 0n)
      return null
    }
    async sellOutcome(): Promise<ethers.TransactionReceipt | DryRunReceipt | null> {
      if (impl.sellOutcome) return impl.sellOutcome('', 0, 0n, 0n)
      return null
    }
    async balanceOfOutcome(): Promise<bigint> {
      if (impl.balanceOfOutcome) return impl.balanceOfOutcome('', 0)
      return 0n
    }
  }
  return StubTrader
}

function dryReceipt(hash: string): DryRunReceipt {
  return {
    dryRun: true,
    hash,
    from: '0xWallet',
    to: '0xRouter',
    method: 'buyOutcome',
    args: {},
    status: 1,
  }
}

// ── listOpenAgentPositions ───────────────────────────────────────────────
test('listOpenAgentPositions filters by agentId AND status=open, ordered most-recent-first', async () => {
  const spy = installSqlSpies([[]])
  try {
    await listOpenAgentPositions('agent_xyz')
    assert.equal(spy.calls.length, 1)
    const sql = norm(spy.calls[0].sql)
    assert.match(sql, /FROM\s+"OutcomePosition"/i, 'reads from OutcomePosition')
    assert.match(sql, /"agentId"\s*=\s*\$1/i, 'agentId bound to $1')
    assert.match(sql, /status\s*=\s*'open'/i, "filters status = 'open'")
    assert.match(sql, /ORDER BY\s+"openedAt"\s+DESC/i, 'most-recent-first ordering')
    assert.deepEqual(spy.calls[0].params, ['agent_xyz'], 'param order: [agentId]')
  } finally {
    spy.restore()
  }
})

// ── listUserPositions ────────────────────────────────────────────────────
test('listUserPositions filters by userId, orders by openedAt DESC, honours limit param', async () => {
  const spy = installSqlSpies([[]])
  try {
    await listUserPositions('user_abc', 50)
    const { sql, params } = spy.calls[0]
    assert.match(norm(sql), /"userId"\s*=\s*\$1/i, 'userId bound to $1')
    assert.match(norm(sql), /LIMIT\s+\$2/i, 'limit bound to $2 (not interpolated)')
    assert.match(norm(sql), /ORDER BY\s+"openedAt"\s+DESC/i)
    assert.deepEqual(params, ['user_abc', 50], 'param order: [userId, limit]')
  } finally {
    spy.restore()
  }
})

// ── isUserLiveOptedIn / setUserLiveOptIn ─────────────────────────────────
test('isUserLiveOptedIn reads fortyTwoLiveTrade for the given user', async () => {
  const spy = installSqlSpies([[{ fortyTwoLiveTrade: true }]])
  try {
    const result = await isUserLiveOptedIn('user_1')
    assert.equal(result, true)
    const { sql, params } = spy.calls[0]
    assert.match(norm(sql), /SELECT\s+"fortyTwoLiveTrade"\s+FROM\s+"User"/i)
    assert.match(norm(sql), /WHERE\s+id\s*=\s*\$1/i)
    assert.match(norm(sql), /LIMIT\s+1/i)
    assert.deepEqual(params, ['user_1'])
  } finally {
    spy.restore()
  }
})

test('isUserLiveOptedIn returns false for any non-true value (strict equality, not truthy)', async () => {
  // Defensive: anything other than literal `true` (e.g. null, undefined, 1)
  // must NOT be treated as opt-in. Otherwise a row with NULL would silently
  // enable live trading.
  for (const variant of [{}, { fortyTwoLiveTrade: null }, { fortyTwoLiveTrade: 1 }]) {
    const spy = installSqlSpies([[variant]])
    try {
      assert.equal(await isUserLiveOptedIn('u'), false, `variant ${JSON.stringify(variant)}`)
    } finally {
      spy.restore()
    }
  }
  const spy = installSqlSpies([[]])
  try {
    assert.equal(await isUserLiveOptedIn('u'), false, 'empty result')
  } finally {
    spy.restore()
  }
})

test('setUserLiveOptIn UPDATEs fortyTwoLiveTrade with [enabled, userId] in that order', async () => {
  const spy = installSqlSpies()
  try {
    await setUserLiveOptIn('user_42', true)
    const { sql, params } = spy.calls[0]
    assert.match(norm(sql), /UPDATE\s+"User"\s+SET\s+"fortyTwoLiveTrade"\s*=\s*\$1\s+WHERE\s+id\s*=\s*\$2/i)
    assert.deepEqual(params, [true, 'user_42'], 'param order: [enabled, userId] — swapping these would clobber the wrong user')
  } finally {
    spy.restore()
  }
})

// ── closePredictionPosition: SELECT path ─────────────────────────────────
test('closePredictionPosition SELECT requires id AND agentId AND status=open (lookup is scoped to the owning agent)', async () => {
  // Returning [] from the lookup means "position not found / not open" so the
  // function bails out before hitting any on-chain code.
  const spy = installSqlSpies([[]])
  try {
    const result = await closePredictionPosition(
      { agentId: 'agent_owner', agentMaxPositionSize: 1000, userId: 'user_1' },
      'pos_target',
    )
    assert.deepEqual(result, { ok: false, reason: 'position not found or not open' })
    assert.equal(spy.calls.length, 1, 'no further SQL after lookup miss')
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /FROM\s+"OutcomePosition"/i)
    assert.match(n, /id\s*=\s*\$1/i)
    assert.match(n, /"agentId"\s*=\s*\$2/i)
    assert.match(n, /status\s*=\s*'open'/i)
    assert.match(n, /LIMIT\s+1/i)
    // Param binding: positionId in $1, agentId in $2 — swapping would let
    // any agent close any other agent's position.
    assert.deepEqual(params, ['pos_target', 'agent_owner'])
  } finally {
    spy.restore()
  }
})

// ── settleResolvedPositions: SELECT WHERE composition ────────────────────
test('settleResolvedPositions SELECT defaults to status=open with no extra filters when no opts given', async () => {
  const spy = installSqlSpies([[]])
  try {
    const settled = await settleResolvedPositions()
    assert.equal(settled, 0, 'no open rows → 0 settled, exits before any on-chain reads')
    assert.equal(spy.calls.length, 1)
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /FROM\s+"OutcomePosition"\s+WHERE\s+status\s*=\s*'open'/i)
    assert.doesNotMatch(n, /"agentId"/i, 'no agentId filter when not provided')
    assert.doesNotMatch(n, /"userId"/i, 'no userId filter when not provided')
    assert.deepEqual(params, [])
  } finally {
    spy.restore()
  }
})

test('settleResolvedPositions SELECT scoped to agentId binds agentId to $1', async () => {
  const spy = installSqlSpies([[]])
  try {
    await settleResolvedPositions({ agentId: 'agent_a' })
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /status\s*=\s*'open'/i)
    assert.match(n, /"agentId"\s*=\s*\$1/i, 'agentId placeholder is $1')
    assert.doesNotMatch(n, /"userId"/i)
    assert.deepEqual(params, ['agent_a'])
  } finally {
    spy.restore()
  }
})

test('settleResolvedPositions SELECT scoped to userId binds userId to $1 when agentId absent', async () => {
  const spy = installSqlSpies([[]])
  try {
    await settleResolvedPositions({ userId: 'user_b' })
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /"userId"\s*=\s*\$1/i, 'userId placeholder is $1 when no agentId')
    assert.doesNotMatch(n, /"agentId"/i)
    assert.deepEqual(params, ['user_b'])
  } finally {
    spy.restore()
  }
})

test('settleResolvedPositions SELECT with both opts binds [agentId, userId] in that exact order', async () => {
  // Order matters: the helper appends agentId first ($1) then userId ($2).
  // If we ever flipped the placeholder numbering without also flipping
  // args.push order, we would silently filter on swapped columns.
  const spy = installSqlSpies([[]])
  try {
    await settleResolvedPositions({ agentId: 'agent_a', userId: 'user_b' })
    const { sql, params } = spy.calls[0]
    const n = norm(sql)
    assert.match(n, /"agentId"\s*=\s*\$1/i)
    assert.match(n, /"userId"\s*=\s*\$2/i)
    assert.match(n, /status\s*=\s*'open'\s+AND\s+"agentId"\s*=\s*\$1\s+AND\s+"userId"\s*=\s*\$2/i)
    assert.deepEqual(params, ['agent_a', 'user_b'])
  } finally {
    spy.restore()
  }
})

// ── settleResolvedPositions: UPDATE clause when a position resolves ──────
test('settleResolvedPositions UPDATE writes status, exitPrice, payoutUsdt, pnl with [status, exitPrice, payout, pnl, id]', async () => {
  // Mock the on-chain read so we drive the function past the SELECT and into
  // the per-position UPDATE. The market is finalised and the position wins
  // → 1 USDT redemption per token; with 4 outcome tokens & usdtIn=2, that's
  // payout=4 and pnl=2.
  const pos = stubPosition({
    id: 'pos_win', tokenId: 1, usdtIn: 2, entryPrice: 0.5, outcomeTokenAmount: 4,
  })
  const restore = withDeps({
    getMarketByAddress: async () => stubMarket({ status: 'resolved' }),
    readMarketOnchain: async () => stubOnchainState({
      isFinalised: true,
      resolvedAnswer: 1n,
      outcomes: [stubOutcome({ tokenId: 1, label: 'YES', impliedProbability: 0.5 })],
    }),
    isWinningTokenId: () => true,
  })
  const spy = installSqlSpies([[pos]])
  try {
    const settled = await settleResolvedPositions()
    assert.equal(settled, 1)
    // Calls: [0] SELECT open, [1] UPDATE for the resolved row.
    assert.equal(spy.calls.length, 2, 'exactly one UPDATE per resolved position')
    const update = spy.calls[1]
    const n = norm(update.sql)
    assert.match(n, /UPDATE\s+"OutcomePosition"/i)
    assert.match(n, /SET\s+status\s*=\s*\$1/i)
    assert.match(n, /"exitPrice"\s*=\s*\$2/i)
    assert.match(n, /"payoutUsdt"\s*=\s*\$3/i)
    assert.match(n, /pnl\s*=\s*\$4/i)
    assert.match(n, /"closedAt"\s*=\s*NOW\(\)/i, 'closedAt always set to NOW(), not from a parameter')
    assert.match(n, /WHERE\s+id\s*=\s*\$5/i)
    assert.deepEqual(update.params, ['resolved_win', 1, 4, 2, 'pos_win'])
  } finally {
    spy.restore()
    restore()
  }
})

test('settleResolvedPositions UPDATE marks losers with status=resolved_loss, payout=0, exitPrice=0', async () => {
  // Symmetric loser case: locks in that the winner-vs-loser branching maps
  // to the right status string and payout numbers in the SQL parameters.
  const pos = stubPosition({
    id: 'pos_lose', tokenId: 2, outcomeLabel: 'NO', usdtIn: 1.5, entryPrice: 0.5,
    outcomeTokenAmount: 3,
  })
  const restore = withDeps({
    getMarketByAddress: async () => stubMarket({ status: 'resolved' }),
    readMarketOnchain: async () => stubOnchainState({
      isFinalised: true,
      resolvedAnswer: 1n,
      outcomes: [stubOutcome({ tokenId: 2, label: 'NO', impliedProbability: 0.5 })],
    }),
    isWinningTokenId: () => false,
  })
  const spy = installSqlSpies([[pos]])
  try {
    await settleResolvedPositions()
    const update = spy.calls[1]
    assert.deepEqual(update.params, ['resolved_loss', 0, 0, -1.5, 'pos_lose'])
  } finally {
    spy.restore()
    restore()
  }
})

// ── checkAndSize sub-queries inside openPredictionPosition ───────────────
//
// openPredictionPosition triggers three sizing-guard SELECTs before the
// INSERT: same-market exposure, daily quota, max-open. Each guard uses a
// distinct WHERE clause and parameter set, and a typo in any of them would
// silently disable a quota — so we cover each one in isolation.

function liveMarketDeps(): () => void {
  return withDeps({
    getMarketByAddress: async () => stubMarket({ status: 'live' }),
    readMarketOnchain: async () => stubOnchainState({
      outcomes: [stubOutcome({ tokenId: 7, label: 'YES', impliedProbability: 0.4 })],
    }),
  })
}

test('checkAndSize same-market guard SELECTs count() with [agentId, marketAddress, tokenId] and status=open', async () => {
  const restore = liveMarketDeps()
  // SQL queue: [0] enable-check (kill switch) → enabled, [1] same-market
  // guard returns count=1 → "already holding" → bail out before the other
  // guards.
  const spy = installSqlSpies([[{ fortyTwoLiveTrade: true }], [{ c: 1n }]])
  try {
    const result = await openPredictionPosition(
      { agentId: 'agent_x', agentMaxPositionSize: 1000, userId: 'user_y' },
      { action: 'OPEN_PREDICTION', marketAddress: '0xmkt', tokenId: 7, conviction: 0.9 },
    )
    assert.deepEqual(result, {
      ok: false,
      reason: 'already holding an open position on this market+outcome',
    })
    assert.equal(spy.calls.length, 2, 'enable-check + same-market guard, then short-circuit')
    const { sql, params } = spy.calls[1]
    const n = norm(sql)
    assert.match(n, /SELECT\s+count\(\*\)::bigint\s+AS\s+c\s+FROM\s+"OutcomePosition"/i)
    assert.match(n, /"agentId"\s*=\s*\$1/i)
    assert.match(n, /"marketAddress"\s*=\s*\$2/i)
    assert.match(n, /"tokenId"\s*=\s*\$3/i)
    assert.match(n, /status\s*=\s*'open'/i)
    // Param order: [agentId, marketAddress, tokenId]. A swap would cause the
    // guard to silently never trip (different agents on the same market).
    assert.deepEqual(params, ['agent_x', '0xmkt', 7])
  } finally {
    spy.restore()
    restore()
  }
})

test('checkAndSize daily-quota guard SELECTs count() with [agentId, dayAgoCutoff] and openedAt > cutoff', async () => {
  const restore = liveMarketDeps()
  // SQL queue: [0] enable-check enabled, [1] same-market guard 0 → fall
  // through. [2] daily-quota guard returns >= PRED_MAX_NEW_PER_AGENT_PER_DAY
  // (3) → bail.
  const spy = installSqlSpies([[{ fortyTwoLiveTrade: true }], [{ c: 0n }], [{ c: 3n }]])
  try {
    const before = Date.now()
    const result = await openPredictionPosition(
      { agentId: 'agent_x', agentMaxPositionSize: 1000, userId: 'user_y' },
      { action: 'OPEN_PREDICTION', marketAddress: '0xmkt', tokenId: 7, conviction: 0.9 },
    )
    assert.deepEqual(result, { ok: false, reason: 'daily prediction-trade quota reached' })
    assert.equal(spy.calls.length, 3)
    const { sql, params } = spy.calls[2]
    const n = norm(sql)
    assert.match(n, /SELECT\s+count\(\*\)::bigint\s+AS\s+c\s+FROM\s+"OutcomePosition"/i)
    assert.match(n, /"agentId"\s*=\s*\$1/i)
    assert.match(n, /"openedAt"\s*>\s*\$2/i, 'cutoff bound to $2 — interpolating instead would inject Date.toString into SQL')
    assert.equal(params[0], 'agent_x')
    assert.ok(params[1] instanceof Date, 'cutoff must be a Date object so the driver round-trips it as TIMESTAMP')
    const cutoffMs = (params[1] as Date).getTime()
    // Cutoff is "24h ago" relative to call time. Allow a generous window.
    assert.ok(cutoffMs <= before - 23 * 60 * 60 * 1000)
    assert.ok(cutoffMs >= before - 25 * 60 * 60 * 1000)
  } finally {
    spy.restore()
    restore()
  }
})

test('checkAndSize max-open guard SELECTs count() with [agentId] and status=open', async () => {
  const restore = liveMarketDeps()
  // [enable-check=enabled, same-market=0, daily=0, max-open=5] → bail at
  // the max-open guard.
  const spy = installSqlSpies([
    [{ fortyTwoLiveTrade: true }],
    [{ c: 0n }], [{ c: 0n }], [{ c: 5n }],
  ])
  try {
    const result = await openPredictionPosition(
      { agentId: 'agent_x', agentMaxPositionSize: 1000, userId: 'user_y' },
      { action: 'OPEN_PREDICTION', marketAddress: '0xmkt', tokenId: 7, conviction: 0.9 },
    )
    assert.deepEqual(result, { ok: false, reason: 'max simultaneous prediction positions reached' })
    assert.equal(spy.calls.length, 4)
    const { sql, params } = spy.calls[3]
    const n = norm(sql)
    assert.match(n, /SELECT\s+count\(\*\)::bigint\s+AS\s+c\s+FROM\s+"OutcomePosition"/i)
    assert.match(n, /"agentId"\s*=\s*\$1/i)
    assert.match(n, /status\s*=\s*'open'/i)
    assert.deepEqual(params, ['agent_x'])
  } finally {
    spy.restore()
    restore()
  }
})

// ── openPredictionPosition INSERT ────────────────────────────────────────
//
// Drives openPredictionPosition all the way to its INSERT...RETURNING by
// stubbing market lookup, on-chain read, wallet load, and the trader. We
// then assert the column list, the ::jsonb cast on `providers`, and that
// the 13 bound parameters land in the right slots — a permutation here
// would flip e.g. usdtIn and entryPrice, corrupting every recorded trade.
test('openPredictionPosition INSERT writes all columns with providers cast to jsonb and params [userId,agentId,marketAddress,marketTitle,tokenId,outcomeLabel,usdtIn,entryPrice,paperTrade,txHashOpen,reasoning,outcomeTokenAmount,providers]', async () => {
  const restore = withDeps({
    getMarketByAddress: async () => stubMarket({ status: 'live', question: 'Will X happen?' }),
    readMarketOnchain: async () => stubOnchainState({
      outcomes: [stubOutcome({ tokenId: 7, label: 'YES', impliedProbability: 0.4 })],
    }),
    decryptPrivateKey: () => '0x' + '11'.repeat(32),
    FortyTwoTraderCtor: makeTraderCtor({
      buyOutcome: async () => dryReceipt('0xtxHashOpenStub'),
    }),
  })
  const restoreWallet = withWalletFindFirst(async () => ({
    address: '0xWallet', encryptedPK: 'enc', chain: 'BSC', isActive: true,
  }))

  // SQL queue:
  //   [0] enable-check (top of openPredictionPosition) → enabled
  //   [1] same-market guard count → 0
  //   [2] daily-quota count → 0
  //   [3] max-open count → 0
  //   [4] live-opt-in lookup inside buildTrader → enabled → live mode
  //   [5] INSERT...RETURNING → id row
  // (The enable-check at the top duplicates the one inside buildTrader —
  // intentional, the upstream check exists to surface a precise error
  // message before we burn DB cycles on quotas.)
  const spy = installSqlSpies([
    [{ fortyTwoLiveTrade: true }],
    [{ c: 0n }], [{ c: 0n }], [{ c: 0n }],
    [{ fortyTwoLiveTrade: true }],
    [{ id: 'pos_new_id' }],
  ])
  try {
    const providers: ProviderTelemetry[] = [stubProvider()]
    const result = await openPredictionPosition(
      { agentId: 'agent_X', agentMaxPositionSize: 1000, userId: 'user_Y' },
      {
        action: 'OPEN_PREDICTION', marketAddress: '0xMarket', tokenId: 7,
        outcomeLabel: 'YES', conviction: 0.9, reasoning: 'because',
      },
      providers,
    )
    assert.deepEqual(result, { ok: true, positionId: 'pos_new_id', paperTrade: false, usdtIn: 2 })
    assert.equal(spy.calls.length, 6, 'exactly 6 SQL calls: enable-check + 3 guards + buildTrader opt-in + INSERT')

    const insert = spy.calls[5]
    const n = norm(insert.sql)
    assert.match(n, /INSERT\s+INTO\s+"OutcomePosition"/i)
    // Column list must match our positional binding contract exactly.
    assert.match(
      n,
      /\(\s*"userId"\s*,\s*"agentId"\s*,\s*"marketAddress"\s*,\s*"marketTitle"\s*,\s*"tokenId"\s*,\s*"outcomeLabel"\s*,\s*"usdtIn"\s*,\s*"entryPrice"\s*,\s*"status"\s*,\s*"paperTrade"\s*,\s*"txHashOpen"\s*,\s*"reasoning"\s*,\s*"outcomeTokenAmount"\s*,\s*"providers"\s*\)/i,
      'column list locked',
    )
    // status is hard-coded to 'open' in the VALUES clause (slot for status is
    // a literal, not a placeholder) — protects against accidentally inserting
    // an unintended status when adding new columns.
    assert.match(n, /VALUES\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*,\s*\$4\s*,\s*\$5\s*,\s*\$6\s*,\s*\$7\s*,\s*\$8\s*,\s*'open'\s*,\s*\$9\s*,\s*\$10\s*,\s*\$11\s*,\s*\$12\s*,\s*\$13::jsonb\s*\)/i)
    assert.match(n, /RETURNING\s+id/i)

    // Param binding contract — 13 values in this exact order.
    assert.equal(insert.params.length, 13)
    assert.equal(insert.params[0], 'user_Y',         'userId → $1')
    assert.equal(insert.params[1], 'agent_X',        'agentId → $2')
    assert.equal(insert.params[2], '0xMarket',       'marketAddress → $3')
    assert.equal(insert.params[3], 'Will X happen?', 'marketTitle (from on-chain market.question) → $4')
    assert.equal(insert.params[4], 7,                'tokenId → $5')
    assert.equal(insert.params[5], 'YES',            'outcomeLabel (from on-chain outcome) → $6')
    assert.equal(insert.params[6], 2,                'usdtIn → $7 (sized to PRED_PER_POSITION_USDT_CAP)')
    assert.equal(insert.params[7], 0.4,              'entryPrice (impliedProbability) → $8')
    assert.equal(insert.params[8], false,            'paperTrade → $9 (live, not paper)')
    assert.equal(insert.params[9], '0xtxHashOpenStub', 'txHashOpen → $10')
    assert.equal(insert.params[10], 'because',       'reasoning → $11')
    assert.equal(insert.params[11], null,            'outcomeTokenAmount → $12 (null in paper mode)')
    // providers must be JSON-serialised for the ::jsonb cast — passing the raw
    // array would round-trip incorrectly in some drivers.
    assert.equal(insert.params[12], JSON.stringify(providers), 'providers → $13 as JSON string')
  } finally {
    spy.restore()
    restore()
    restoreWallet()
  }
})

// ── closePredictionPosition UPDATE ───────────────────────────────────────
test('closePredictionPosition UPDATE writes [exitPrice,payout,pnl,txHashClose,paperTrade,id] with status=closed literal and closedAt=NOW()', async () => {
  const pos = stubPosition({
    id: 'pos_close', userId: 'user_Y', agentId: 'agent_X', usdtIn: 2,
    entryPrice: 0.4, paperTrade: true, outcomeTokenAmount: 5,
  })
  const restore = withDeps({
    getMarketByAddress: async () => stubMarket({ status: 'live' }),
    // Closing-time impliedProbability=0.6 → exitPrice=0.6, payout=5*0.6=3, pnl=1.
    readMarketOnchain: async () => stubOnchainState({
      outcomes: [stubOutcome({ tokenId: 7, label: 'YES', impliedProbability: 0.6 })],
    }),
    decryptPrivateKey: () => '0x' + '22'.repeat(32),
    FortyTwoTraderCtor: makeTraderCtor({
      sellOutcome: async () => ({ ...dryReceipt('0xtxHashCloseStub'), method: 'sellOutcome' }),
    }),
  })
  const restoreWallet = withWalletFindFirst(async () => ({
    address: '0xW', encryptedPK: 'e', chain: 'BSC', isActive: true,
  }))

  // Calls: [0] SELECT pos lookup → returns pos. (paperTrade=true is forwarded
  // to buildTrader as forcePaperTrade, so no opt-in lookup happens.)
  //        [1] UPDATE
  const spy = installSqlSpies([[pos]])
  try {
    const result = await closePredictionPosition(
      { agentId: 'agent_X', agentMaxPositionSize: 1000, userId: 'user_Y' },
      'pos_close',
    )
    assert.equal(result.ok, true)
    assert.equal(spy.calls.length, 2)
    const update = spy.calls[1]
    const n = norm(update.sql)
    assert.match(n, /UPDATE\s+"OutcomePosition"/i)
    assert.match(n, /SET\s+status\s*=\s*'closed'/i, "status hard-coded to 'closed' (literal, not parameter)")
    assert.match(n, /"exitPrice"\s*=\s*\$1/i)
    assert.match(n, /"payoutUsdt"\s*=\s*\$2/i)
    assert.match(n, /pnl\s*=\s*\$3/i)
    assert.match(n, /"txHashClose"\s*=\s*\$4/i)
    assert.match(n, /"closedAt"\s*=\s*NOW\(\)/i)
    assert.match(n, /"paperTrade"\s*=\s*\$5/i, 'paperTrade preserved from the original position, not user toggle')
    assert.match(n, /WHERE\s+id\s*=\s*\$6/i)

    // Param contract: [exitPrice, payout, pnl, txHashClose, paperTrade, id].
    // 5 outcome tokens * 0.6 implied = 3 USDT payout; pnl = 3 - 2 = 1.
    assert.equal(update.params.length, 6)
    assert.equal(update.params[0], 0.6,                 'exitPrice → $1')
    assert.equal(update.params[1], 3,                   'payoutUsdt → $2')
    assert.equal(update.params[2], 1,                   'pnl → $3')
    assert.equal(update.params[3], '0xtxHashCloseStub', 'txHashClose → $4')
    assert.equal(update.params[4], true,                'paperTrade → $5 (carried from position)')
    assert.equal(update.params[5], 'pos_close',         'id → $6 (last) — swapping any other slot with id would update the wrong row')
  } finally {
    spy.restore()
    restore()
    restoreWallet()
  }
})

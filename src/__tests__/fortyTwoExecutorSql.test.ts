import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ethers } from 'ethers'
import { db } from '../db'
import {
  __testDeps,
  openPredictionPosition,
  closePredictionPosition,
  closeUserPredictionPosition,
  claimUserResolvedForMarket,
  claimAllAgentResolved,
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
  // the per-position UPDATE. The market is finalised and the position wins.
  // For wins we deliberately leave payoutUsdt and pnl NULL — the actual
  // amount is only known when the user claims and the on-chain receipt is
  // parsed. The previous behaviour (1:1 token→USDT estimate) was wrong
  // because 42.space outcome tokens redeem at the curve-implied price.
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
    assert.deepEqual(update.params, ['resolved_win', 1, null, null, 'pos_win'])
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
  //   [4] Agent.walletId lookup inside loadUserWalletPK (called from
  //       buildTrader BEFORE the opt-in lookup) → empty (no pinned
  //       wallet → fall through to user's active BSC wallet)
  //   [5] live-opt-in lookup inside buildTrader → enabled → live mode
  //   [6] INSERT...RETURNING → id row
  // (The enable-check at the top duplicates the one inside buildTrader —
  // intentional, the upstream check exists to surface a precise error
  // message before we burn DB cycles on quotas.)
  const spy = installSqlSpies([
    [{ fortyTwoLiveTrade: true }],
    [{ c: 0n }], [{ c: 0n }], [{ c: 0n }],
    [{ walletId: null }],
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
    assert.equal(spy.calls.length, 7, 'exactly 7 SQL calls: enable-check + 3 guards + buildTrader opt-in + Agent.walletId lookup + INSERT')

    const insert = spy.calls[6]
    const n = norm(insert.sql)
    assert.match(n, /INSERT\s+INTO\s+"OutcomePosition"/i)
    // Column list must match our positional binding contract exactly.
    // "id" is generated server-side via gen_random_uuid()::text in the
    // VALUES slot, not user-bound, so it appears in the column list but
    // not in the param contract below.
    assert.match(
      n,
      /\(\s*"id"\s*,\s*"userId"\s*,\s*"agentId"\s*,\s*"marketAddress"\s*,\s*"marketTitle"\s*,\s*"tokenId"\s*,\s*"outcomeLabel"\s*,\s*"usdtIn"\s*,\s*"entryPrice"\s*,\s*"status"\s*,\s*"paperTrade"\s*,\s*"txHashOpen"\s*,\s*"reasoning"\s*,\s*"outcomeTokenAmount"\s*,\s*"providers"\s*\)/i,
      'column list locked',
    )
    // status is hard-coded to 'open' in the VALUES clause (slot for status is
    // a literal, not a placeholder) — protects against accidentally inserting
    // an unintended status when adding new columns. id slot is a
    // gen_random_uuid()::text literal for the same reason.
    assert.match(n, /VALUES\s*\(\s*gen_random_uuid\(\)::text\s*,\s*\$1\s*,\s*\$2\s*,\s*\$3\s*,\s*\$4\s*,\s*\$5\s*,\s*\$6\s*,\s*\$7\s*,\s*\$8\s*,\s*'open'\s*,\s*\$9\s*,\s*\$10\s*,\s*\$11\s*,\s*\$12\s*,\s*\$13::jsonb\s*\)/i)
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

// ── closeUserPredictionPosition / claimUserResolvedForMarket wallet routing ─
//
// Regression tests for commit 2357077: CLOSE and CLAIM on 42.space positions
// must build the trader from the wallet that actually holds the outcome
// tokens (Agent.walletId), not the user's primary BSC wallet. A miss here
// silently re-introduces the "CLOSE does nothing" bug (sellOutcome reverts
// because the active wallet holds zero outcome tokens for the position).
//
// We use a single shared scaffold:
//   * `decryptPrivateKey` returns a deterministic PK derived from the
//     encryptedPK string, so each wallet maps to a unique recoverable PK.
//   * The trader ctor records `(pk, dryRun)` per construction so we can
//     assert which wallet the executor reached for.
//   * `withWalletFindFirst` returns different Wallet rows depending on the
//     `where` clause the executor passes — pinned-id lookup vs userId-active
//     lookup — proving the routing path actually changed.

type TraderCtorCall = { pk: string; dryRun: boolean }
type ClaimCall = { pk: string; marketAddress: string }
type SellCall = { pk: string; marketAddress: string; tokenId: number }

function pkFromEnc(enc: string): string {
  // 32-byte hex derived from the encryptedPK label — distinct per wallet.
  const h = enc.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
  return '0x' + h.toString(16).padStart(8, '0').repeat(8)
}

function makeRoutingDeps(opts: {
  traderCtorCalls: TraderCtorCall[]
  claimCalls?: ClaimCall[]
  sellCalls?: SellCall[]
  claimReceipt?: () => DryRunReceipt | null
  sellReceipt?: () => DryRunReceipt | null
}): ExecutorDeps {
  const claimCalls = opts.claimCalls
  const sellCalls = opts.sellCalls
  class RoutingTrader implements ExecutorTrader {
    private readonly pk: string
    constructor(pk: string, _rpc: string, o: { dryRun: boolean }) {
      this.pk = pk
      opts.traderCtorCalls.push({ pk, dryRun: o.dryRun })
    }
    async buyOutcome(): Promise<DryRunReceipt | null> { return null }
    async sellOutcome(marketAddress: string, tokenId: number): Promise<DryRunReceipt | null> {
      sellCalls?.push({ pk: this.pk, marketAddress, tokenId })
      return opts.sellReceipt ? opts.sellReceipt() : dryReceipt('0xsell')
    }
    async balanceOfOutcome(): Promise<bigint> { return 0n }
    async claimAllResolved(marketAddress: string): Promise<DryRunReceipt | null> {
      claimCalls?.push({ pk: this.pk, marketAddress })
      return opts.claimReceipt ? opts.claimReceipt() : dryReceipt('0xclaim')
    }
  }
  return {
    getMarketByAddress: async () => stubMarket({ status: 'live' }),
    readMarketOnchain: async () => stubOnchainState({
      outcomes: [stubOutcome({ tokenId: 7, label: 'YES', impliedProbability: 0.5 })],
    }),
    isWinningTokenId: () => true,
    decryptPrivateKey: (enc: string) => pkFromEnc(enc),
    FortyTwoTraderCtor: RoutingTrader as unknown as ExecutorTraderCtor,
  }
}

// Wallet directory keyed by both the pinned `id` lookup (id+userId+chain)
// and the active-wallet lookup (userId+chain+isActive). Production calls
// db.wallet.findFirst with both shapes from loadUserWalletPK; the stub
// switches on the `where.id` presence to pick the right row, exactly
// like Prisma would.
function walletDirectory(rows: {
  pinned: Record<string, { address: string; encryptedPK: string }>
  active: Record<string, { address: string; encryptedPK: string }>
}): () => void {
  return withWalletFindFirst(async (args) => {
    const w = (args as { where?: { id?: string; userId?: string; isActive?: boolean } } | undefined)?.where
    if (w?.id) {
      const row = rows.pinned[w.id]
      if (!row) return null
      return { address: row.address, encryptedPK: row.encryptedPK, chain: 'BSC', isActive: true }
    }
    if (w?.userId && w.isActive === true) {
      const row = rows.active[w.userId]
      if (!row) return null
      return { address: row.address, encryptedPK: row.encryptedPK, chain: 'BSC', isActive: true }
    }
    return null
  })
}

function withCampaignMode(value: 'true' | 'unset'): () => void {
  const prevMode = process.env.FT_CAMPAIGN_MODE
  const prevId = process.env.FT_CAMPAIGN_AGENT_ID
  if (value === 'unset') {
    delete process.env.FT_CAMPAIGN_MODE
    delete process.env.FT_CAMPAIGN_AGENT_ID
  } else {
    process.env.FT_CAMPAIGN_MODE = 'true'
    process.env.FT_CAMPAIGN_AGENT_ID = 'agent_pinned'
  }
  return () => {
    if (prevMode === undefined) delete process.env.FT_CAMPAIGN_MODE
    else process.env.FT_CAMPAIGN_MODE = prevMode
    if (prevId === undefined) delete process.env.FT_CAMPAIGN_AGENT_ID
    else process.env.FT_CAMPAIGN_AGENT_ID = prevId
  }
}

test('closeUserPredictionPosition builds trader from Agent.walletId PK when the agent has a pinned wallet (regardless of FT_CAMPAIGN_MODE)', async () => {
  // Critical invariant: the routing is driven by Agent.walletId on the row,
  // NOT by the campaign-mode env flag. We exercise both env states to lock
  // that down — the original bug had a campaign-only gate on
  // loadUserWalletPK that left close/claim broken once the event ended.
  for (const mode of ['unset', 'true'] as const) {
    const restoreEnv = withCampaignMode(mode)
    const traderCtorCalls: TraderCtorCall[] = []
    const sellCalls: SellCall[] = []
    const restoreDeps = withDeps(makeRoutingDeps({ traderCtorCalls, sellCalls }))
    const restoreWallet = walletDirectory({
      pinned: { wallet_pinned: { address: '0xPinned', encryptedPK: 'enc_pinned' } },
      active: { user_x: { address: '0xPrimary', encryptedPK: 'enc_primary' } },
    })
    // Calls: [0] SELECT pos lookup → returns pos (paperTrade=true so we
    //          stay on the dry-run path and never need parseUsdtInflow).
    //        [1] SELECT walletId FROM Agent → returns wallet_pinned.
    //        [2] UPDATE OutcomePosition (exec, no result row consumed).
    const pos = stubPosition({
      id: 'pos_close', userId: 'user_x', agentId: 'agent_pinned',
      paperTrade: true, outcomeTokenAmount: 5,
    })
    const spy = installSqlSpies([[pos], [{ walletId: 'wallet_pinned' }]])
    try {
      const result = await closeUserPredictionPosition('user_x', 'pos_close')
      assert.equal(result.ok, true, `close ok (mode=${mode})`)
      assert.equal(traderCtorCalls.length, 1, `trader built exactly once (mode=${mode})`)
      assert.equal(
        traderCtorCalls[0].pk,
        pkFromEnc('enc_pinned'),
        `trader PK derived from Agent.walletId wallet, not user's active wallet (mode=${mode})`,
      )
      // Defensive: confirm we actually hit the pinned-walletId Agent SELECT
      // before building the trader — that is the new code path the fix
      // introduced; the test must fail loudly if it gets removed.
      const agentLookup = spy.calls.find((c) =>
        /SELECT\s+"walletId"\s+FROM\s+"Agent"/i.test(norm(c.sql)),
      )
      assert.ok(agentLookup, `Agent.walletId lookup happened (mode=${mode})`)
      assert.deepEqual(agentLookup!.params, ['agent_pinned'])
      // And we actually used the trader to sell — proves we built the right
      // one and that closeUserPredictionPosition reached on-chain code.
      assert.equal(sellCalls.length, 1)
      assert.equal(sellCalls[0].pk, pkFromEnc('enc_pinned'))
    } finally {
      spy.restore()
      restoreDeps()
      restoreWallet()
      restoreEnv()
    }
  }
})

test('closeUserPredictionPosition falls back to the user\'s active wallet when Agent.walletId is null', async () => {
  // Symmetric guard: manual positions (or positions opened by an agent that
  // never had a wallet pinned) must still route through the user's active
  // BSC wallet. If a future refactor "always" reads through Agent the manual
  // flow would silently break — this test will catch that.
  const restoreEnv = withCampaignMode('unset')
  const traderCtorCalls: TraderCtorCall[] = []
  const restoreDeps = withDeps(makeRoutingDeps({ traderCtorCalls }))
  const restoreWallet = walletDirectory({
    pinned: {},
    active: { user_x: { address: '0xPrimary', encryptedPK: 'enc_primary' } },
  })
  const pos = stubPosition({
    id: 'pos_close', userId: 'user_x', agentId: 'agent_no_pin',
    paperTrade: true, outcomeTokenAmount: 5,
  })
  // Agent row exists but has no pinned walletId → fall through.
  const spy = installSqlSpies([[pos], [{ walletId: null }]])
  try {
    const result = await closeUserPredictionPosition('user_x', 'pos_close')
    assert.equal(result.ok, true)
    assert.equal(traderCtorCalls.length, 1)
    assert.equal(
      traderCtorCalls[0].pk,
      pkFromEnc('enc_primary'),
      'trader built from user\'s active wallet when no pinned walletId',
    )
  } finally {
    spy.restore()
    restoreDeps()
    restoreWallet()
    restoreEnv()
  }
})

test('claimUserResolvedForMarket groups wins by agent and routes each group through that agent\'s pinned wallet', async () => {
  // The scenario that motivated the fix: user has open wins on the same
  // market opened by TWO different agents, each pinned to a different
  // wallet. A single claim from one wallet would (a) only redeem that
  // wallet's outcome tokens and (b) — before the grouping fix — mark
  // every win on the market as 'claimed', silently losing the other
  // wallet's payout. We assert: two distinct trader constructions, each
  // with the correct PK, two claim txs, and only the matching group's
  // rows updated per tx.
  const restoreEnv = withCampaignMode('unset')
  const traderCtorCalls: TraderCtorCall[] = []
  const claimCalls: ClaimCall[] = []
  const restoreDeps = withDeps(makeRoutingDeps({
    traderCtorCalls,
    claimCalls,
    claimReceipt: () => dryReceipt('0xclaimGroup'),
  }))
  const restoreWallet = walletDirectory({
    pinned: {
      wallet_A: { address: '0xWalletA', encryptedPK: 'enc_A' },
      wallet_B: { address: '0xWalletB', encryptedPK: 'enc_B' },
    },
    active: { user_x: { address: '0xPrimary', encryptedPK: 'enc_primary' } },
  })
  const market = '0x' + 'ab'.repeat(20)
  const winA1 = stubPosition({
    id: 'win_A1', userId: 'user_x', agentId: 'agent_A',
    marketAddress: market, status: 'resolved_win', paperTrade: true,
    outcomeTokenAmount: 4, usdtIn: 2, payoutUsdt: 4, tokenId: 7,
  })
  const winA2 = stubPosition({
    id: 'win_A2', userId: 'user_x', agentId: 'agent_A',
    marketAddress: market, status: 'resolved_win', paperTrade: true,
    outcomeTokenAmount: 6, usdtIn: 3, payoutUsdt: 6, tokenId: 7,
  })
  const winB1 = stubPosition({
    id: 'win_B1', userId: 'user_x', agentId: 'agent_B',
    marketAddress: market, status: 'resolved_win', paperTrade: true,
    outcomeTokenAmount: 5, usdtIn: 2.5, payoutUsdt: 5, tokenId: 7,
  })
  // SQL queue:
  //   [0] SELECT resolved_win rows for (userId, market) → 3 rows.
  //   [1] Agent.walletId lookup for agent_A → wallet_A.
  //   [2] Agent.walletId lookup for agent_B → wallet_B.
  // (Three UPDATEs follow — one per row, ID-scoped. They go through
  //  $executeRawUnsafe which doesn't drain the query queue.)
  const spy = installSqlSpies([
    [winA1, winA2, winB1],
    [{ walletId: 'wallet_A' }],
    [{ walletId: 'wallet_B' }],
  ])
  try {
    const result = await claimUserResolvedForMarket('user_x', market)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.claimedPositions, 3)

    // Two traders built — one PK per group. Order follows the Map's
    // insertion order (agent_A first, then agent_B).
    assert.equal(traderCtorCalls.length, 2, 'one trader per agent group, never a shared wallet')
    assert.equal(traderCtorCalls[0].pk, pkFromEnc('enc_A'), 'group A built from wallet_A PK')
    assert.equal(traderCtorCalls[1].pk, pkFromEnc('enc_B'), 'group B built from wallet_B PK')

    // Two claim txs — one per group's pinned wallet. A bug that built a
    // single trader from the user's active wallet would only have one
    // entry here, and the PK would not match either wallet_A or wallet_B.
    assert.equal(claimCalls.length, 2)
    assert.equal(claimCalls[0].pk, pkFromEnc('enc_A'))
    assert.equal(claimCalls[1].pk, pkFromEnc('enc_B'))

    // Verify the per-row UPDATEs are scoped by id (not by agentId or by
    // market). Without id-scoping, a claim from wallet_A would mark
    // wallet_B's win as 'claimed' too — that is the silent-loss bug.
    const updates = spy.calls.filter((c) =>
      /UPDATE\s+"OutcomePosition"/i.test(norm(c.sql))
      && /status\s*=\s*'claimed'/i.test(norm(c.sql)),
    )
    assert.equal(updates.length, 3, 'one UPDATE per resolved win, id-scoped')
    const updatedIds = updates.map((u) => u.params[u.params.length - 1])
    assert.deepEqual(
      updatedIds.sort(),
      ['win_A1', 'win_A2', 'win_B1'].sort(),
      'every win id touched exactly once via id-scoped UPDATE',
    )
    for (const u of updates) {
      assert.match(
        norm(u.sql),
        /WHERE\s+id\s*=\s*\$\d+\s*$/i,
        'UPDATE filters on id ONLY, never on agentId/marketAddress — proves cross-group rows can\'t be touched',
      )
    }
  } finally {
    spy.restore()
    restoreDeps()
    restoreWallet()
    restoreEnv()
  }
})

// ── claimAllAgentResolved / claimAgentResolvedForMarket ─────────────────
//
// Companion to claimUserResolvedForMarket but scoped to a SINGLE agent —
// this is what the 42.space campaign tick calls every round to redeem
// wins on the agent's pinned wallet. A regression here leaves campaign
// payouts stuck at status='resolved_win' and skews the brain feed's
// Realised PnL. The invariants we lock down:
//
//   1. The DISTINCT-market discovery SELECT filters by agentId (NOT
//      userId) so we never touch a user's manual positions on the same
//      market by accident.
//   2. The per-market lookup also filters by agentId + status, and the
//      trader is built via buildTrader(userId, !anyLive, agentId) so
//      loadUserWalletPK routes to Agent.walletId. Same wallet-pinning
//      bug Task #98 fixed for the user-scoped path would silently
//      regress here without coverage.
//   3. When the on-chain payout can be parsed, UPDATEs are id-scoped
//      (WHERE id=$N) and one per resolved row — never agentId/market
//      bulk-updates that could clobber a row added after the SELECT.
//   4. When the claim tx didn't confirm (dryRun=false AND status!=1)
//      the function returns ok:false with an error per market and
//      issues ZERO UPDATEs, so the rows stay 'resolved_win' for the
//      next tick to retry. The settle/discover branch must not pre-
//      flip them to 'claimed' either.

function makeLiveClaimReceipt(
  txHash: string,
  payoutWei: bigint,
  toAddress = '0x0000000000000000000000000000000000000abc',
): { hash: string; status: number; logs: unknown[] } {
  const toPadded = '0x' + '0'.repeat(24) + toAddress.replace(/^0x/, '').toLowerCase()
  return {
    hash: txHash,
    status: 1,
    logs: [
      {
        // USDT (BSC) Transfer event — only logs the executor inspects.
        address: '0x55d398326f99059fF775485246999027B3197955',
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          '0x' + '0'.repeat(64),
          toPadded,
        ],
        data: '0x' + payoutWei.toString(16).padStart(64, '0'),
      },
    ],
  }
}

test('claimAllAgentResolved discovers markets via a DISTINCT SELECT scoped to agentId AND status=resolved_win', async () => {
  // No wins → no claims, but we still want to assert the discovery SQL
  // shape: any drift here (e.g. filtering by userId instead of agentId)
  // would scoop up the user's manual positions and try to redeem them
  // from the agent's pinned wallet — guaranteed silent loss.
  const restoreEnv = withCampaignMode('unset')
  const restoreDeps = withDeps(makeRoutingDeps({ traderCtorCalls: [] }))
  // SQL queue:
  //   [0] SELECT userId FROM Agent → user found
  //   [1] settleResolvedPositions SELECT open rows → none
  //   [2] DISTINCT-market discovery → none
  const spy = installSqlSpies([
    [{ userId: 'user_x' }],
    [],
    [],
  ])
  try {
    const result = await claimAllAgentResolved('agent_pinned')
    assert.equal(result.ok, true)
    assert.equal(result.marketsClaimed, 0)
    assert.equal(result.claimedPositions, 0)
    assert.equal(result.payoutUsdt, 0)
    assert.deepEqual(result.errors, [])

    const distinct = spy.calls.find((c) =>
      /SELECT\s+DISTINCT\s+"marketAddress"\s+FROM\s+"OutcomePosition"/i.test(norm(c.sql)),
    )
    assert.ok(distinct, 'DISTINCT-market discovery SELECT happened')
    const n = norm(distinct!.sql)
    assert.match(n, /"agentId"\s*=\s*\$1/i, 'agentId placeholder is $1')
    assert.match(n, /status\s*=\s*'resolved_win'/i, "status pinned to 'resolved_win'")
    assert.doesNotMatch(n, /"userId"/i, 'never filters by userId — that would leak manual positions')
    assert.deepEqual(distinct!.params, ['agent_pinned'])

    // Defensive: the settle sweep that runs before discovery is ALSO
    // agent-scoped. Without that, we'd flip every open row in the table
    // before claiming.
    const settleSelect = spy.calls.find((c) =>
      /FROM\s+"OutcomePosition"\s+WHERE\s+status\s*=\s*'open'/i.test(norm(c.sql)),
    )
    assert.ok(settleSelect, 'settle sweep ran first')
    assert.match(norm(settleSelect!.sql), /"agentId"\s*=\s*\$1/i)
    assert.deepEqual(settleSelect!.params, ['agent_pinned'])
  } finally {
    spy.restore()
    restoreDeps()
    restoreEnv()
  }
})

test('claimAllAgentResolved builds the trader from Agent.walletId so the claim fires from the agent\'s pinned wallet', async () => {
  // Mirror of the user-scoped wallet-routing test but for the campaign-
  // tick claim path. If loadUserWalletPK ever loses its Agent.walletId
  // branch on this code path the claim tx would fire from the user's
  // primary BSC wallet, which holds zero outcome tokens for any
  // agent-opened position → on-chain revert, payouts stuck.
  for (const mode of ['unset', 'true'] as const) {
    const restoreEnv = withCampaignMode(mode)
    const traderCtorCalls: TraderCtorCall[] = []
    const claimCalls: ClaimCall[] = []
    const restoreDeps = withDeps(makeRoutingDeps({
      traderCtorCalls,
      claimCalls,
      claimReceipt: () => dryReceipt('0xclaimAgent'),
    }))
    const restoreWallet = walletDirectory({
      pinned: { wallet_pinned: { address: '0xPinned', encryptedPK: 'enc_pinned' } },
      active: { user_x: { address: '0xPrimary', encryptedPK: 'enc_primary' } },
    })
    const market = '0x' + 'cd'.repeat(20)
    const win = stubPosition({
      id: 'win_only', userId: 'user_x', agentId: 'agent_pinned',
      marketAddress: market, status: 'resolved_win', paperTrade: true,
      outcomeTokenAmount: 5, usdtIn: 2, payoutUsdt: 5, tokenId: 7,
    })
    // SQL queue:
    //   [0] Agent → userId
    //   [1] settle SELECT → none
    //   [2] DISTINCT markets → [market]
    //   [3] per-market wins SELECT → [win]
    //   [4] Agent.walletId lookup inside loadUserWalletPK → wallet_pinned
    const spy = installSqlSpies([
      [{ userId: 'user_x' }],
      [],
      [{ marketAddress: market }],
      [win],
      [{ walletId: 'wallet_pinned' }],
    ])
    try {
      const result = await claimAllAgentResolved('agent_pinned')
      assert.equal(result.ok, true, `result.ok (mode=${mode})`)
      assert.equal(result.marketsClaimed, 1, `one market claimed (mode=${mode})`)
      assert.equal(result.claimedPositions, 1)
      assert.deepEqual(result.errors, [])

      // The per-market wins SELECT must filter by agentId + marketAddress
      // — agent-scoping is what keeps user manual positions out of this
      // group's claim tx.
      const perMarket = spy.calls.find((c) =>
        /SELECT\s+\*\s+FROM\s+"OutcomePosition"/i.test(norm(c.sql))
        && /"agentId"\s*=\s*\$1/i.test(norm(c.sql))
        && /"marketAddress"\s*=\s*\$2/i.test(norm(c.sql)),
      )
      assert.ok(perMarket, `per-market wins SELECT is agent-scoped (mode=${mode})`)
      assert.match(norm(perMarket!.sql), /status\s*=\s*'resolved_win'/i)
      assert.deepEqual(perMarket!.params, ['agent_pinned', market])

      // Agent.walletId routing fires regardless of campaign-mode env state.
      const agentLookup = spy.calls.find((c) =>
        /SELECT\s+"walletId"\s+FROM\s+"Agent"/i.test(norm(c.sql)),
      )
      assert.ok(agentLookup, `Agent.walletId lookup happened (mode=${mode})`)
      assert.deepEqual(agentLookup!.params, ['agent_pinned'])

      assert.equal(traderCtorCalls.length, 1, `one trader built (mode=${mode})`)
      assert.equal(
        traderCtorCalls[0].pk,
        pkFromEnc('enc_pinned'),
        `trader PK derived from Agent.walletId, not user's primary wallet (mode=${mode})`,
      )
      // Paper-trade row → dry-run trader, so forcePaperTrade=true is passed.
      assert.equal(traderCtorCalls[0].dryRun, true)
      assert.equal(claimCalls.length, 1)
      assert.equal(claimCalls[0].pk, pkFromEnc('enc_pinned'))
      assert.equal(claimCalls[0].marketAddress, market)
    } finally {
      spy.restore()
      restoreDeps()
      restoreWallet()
      restoreEnv()
    }
  }
})

test('claimAllAgentResolved issues id-scoped UPDATEs, one per resolved row, only for the market just claimed', async () => {
  // Two wins on the same market for the SAME agent. We return a live
  // (non-dry-run) receipt with a parseable USDT Transfer log so the
  // executor takes the onchainPayout != null branch — that's the branch
  // that issues per-row UPDATEs. The previous shape of the dry-run
  // branch was a single agentId+market bulk UPDATE, which could touch
  // a row inserted between the SELECT and the UPDATE; id-scoping makes
  // that impossible.
  const restoreEnv = withCampaignMode('unset')
  const traderCtorCalls: TraderCtorCall[] = []
  const claimCalls: ClaimCall[] = []
  const restoreDeps = withDeps(makeRoutingDeps({
    traderCtorCalls,
    claimCalls,
    claimReceipt: () => makeLiveClaimReceipt('0xliveclaim', 10n * 10n ** 18n),
  }))
  const restoreWallet = walletDirectory({
    pinned: { wallet_pinned: { address: '0xPinned', encryptedPK: 'enc_pinned' } },
    active: { user_x: { address: '0xPrimary', encryptedPK: 'enc_primary' } },
  })
  const market = '0x' + 'ef'.repeat(20)
  const win1 = stubPosition({
    id: 'agent_win_1', userId: 'user_x', agentId: 'agent_pinned',
    marketAddress: market, status: 'resolved_win', paperTrade: false,
    outcomeTokenAmount: 4, usdtIn: 2, payoutUsdt: 4, tokenId: 7,
  })
  const win2 = stubPosition({
    id: 'agent_win_2', userId: 'user_x', agentId: 'agent_pinned',
    marketAddress: market, status: 'resolved_win', paperTrade: false,
    outcomeTokenAmount: 6, usdtIn: 3, payoutUsdt: 6, tokenId: 7,
  })
  const spy = installSqlSpies([
    [{ userId: 'user_x' }],
    [],
    [{ marketAddress: market }],
    [win1, win2],
    [{ walletId: 'wallet_pinned' }],
  ])
  try {
    const result = await claimAllAgentResolved('agent_pinned')
    assert.equal(result.ok, true)
    assert.equal(result.marketsClaimed, 1)
    assert.equal(result.claimedPositions, 2)
    // payoutUsdt is the parsed on-chain truth, not the DB estimate.
    assert.equal(result.payoutUsdt, 10)
    assert.deepEqual(result.errors, [])

    // anyLive=true → buildTrader called with forcePaperTrade=false →
    // live-mode trader. Locks in the !anyLive flip.
    assert.equal(traderCtorCalls.length, 1)
    assert.equal(traderCtorCalls[0].pk, pkFromEnc('enc_pinned'))
    assert.equal(traderCtorCalls[0].dryRun, false, 'live receipt → live trader')

    const updates = spy.calls.filter((c) =>
      /UPDATE\s+"OutcomePosition"/i.test(norm(c.sql))
      && /status\s*=\s*'claimed'/i.test(norm(c.sql)),
    )
    assert.equal(updates.length, 2, 'one UPDATE per resolved win — never a bulk agentId+market UPDATE')
    for (const u of updates) {
      const n = norm(u.sql)
      assert.match(
        n,
        /WHERE\s+id\s*=\s*\$\d+\s*$/i,
        'UPDATE filters on id ONLY — a row inserted post-SELECT can\'t be clobbered',
      )
      assert.match(n, /"payoutUsdt"\s*=\s*\$2/i, 'payoutUsdt bound to $2')
      assert.match(n, /pnl\s*=\s*\$3/i, 'pnl bound to $3')
      assert.match(n, /"closedAt"\s*=\s*NOW\(\)/i, 'closedAt always NOW(), not parameterised')
      assert.equal(u.params[0], '0xliveclaim', 'txHash bound to $1')
    }
    const updatedIds = updates.map((u) => u.params[u.params.length - 1]).sort()
    assert.deepEqual(
      updatedIds,
      ['agent_win_1', 'agent_win_2'],
      'every win id touched exactly once via id-scoped UPDATE',
    )

    // Weighted share allocation: weights [4,6], total 10, payout 10 →
    // shares [4, 6]; pnl = share - usdtIn → [2, 3]. Locks in the
    // outcomeTokenAmount weighting that the on-chain-payout branch uses
    // so a rewrite can't silently swap to even split or to usdtIn weights.
    const byId: Record<string, { share: number; pnl: number }> = {}
    for (const u of updates) {
      const id = u.params[u.params.length - 1] as string
      byId[id] = { share: u.params[1] as number, pnl: u.params[2] as number }
    }
    assert.equal(byId.agent_win_1.share, 4)
    assert.equal(byId.agent_win_2.share, 6)
    assert.equal(byId.agent_win_1.pnl, 2)
    assert.equal(byId.agent_win_2.pnl, 3)
  } finally {
    spy.restore()
    restoreDeps()
    restoreWallet()
    restoreEnv()
  }
})

test('claimAllAgentResolved leaves rows as resolved_win when the claim tx fails to confirm, so the next tick can retry', async () => {
  // The retry safety net: if the claim tx is dropped (status undefined)
  // or reverted (status=0) we must NOT mark anything 'claimed'. Otherwise
  // the row looks settled to the brain feed forever and the agent never
  // retries — silent payout loss. We assert (a) the function reports the
  // failure per market via the `errors` array, (b) ZERO UPDATEs touch
  // OutcomePosition, and (c) the row's status stays untouched (which we
  // prove via the absence of any "status='claimed'" UPDATE).
  const restoreEnv = withCampaignMode('unset')
  const traderCtorCalls: TraderCtorCall[] = []
  const claimCalls: ClaimCall[] = []
  const restoreDeps = withDeps(makeRoutingDeps({
    traderCtorCalls,
    claimCalls,
    // status=0 reverted tx, NOT a dry run → tx-not-confirmed branch fires.
    claimReceipt: () => ({
      // Cast: we deliberately return a shape that exercises the
      // reverted/dropped branch — not a valid DryRunReceipt.
      hash: '0xdroppedclaim',
      status: 0,
    }) as unknown as DryRunReceipt,
  }))
  const restoreWallet = walletDirectory({
    pinned: { wallet_pinned: { address: '0xPinned', encryptedPK: 'enc_pinned' } },
    active: { user_x: { address: '0xPrimary', encryptedPK: 'enc_primary' } },
  })
  const market = '0x' + '12'.repeat(20)
  const win = stubPosition({
    id: 'win_stuck', userId: 'user_x', agentId: 'agent_pinned',
    marketAddress: market, status: 'resolved_win', paperTrade: false,
    outcomeTokenAmount: 5, usdtIn: 2, payoutUsdt: 5, tokenId: 7,
  })
  const spy = installSqlSpies([
    [{ userId: 'user_x' }],
    [],
    [{ marketAddress: market }],
    [win],
    [{ walletId: 'wallet_pinned' }],
  ])
  try {
    const result = await claimAllAgentResolved('agent_pinned')
    // The outer function still resolves ok:true (it's a sweep), but it
    // reports the failed market in `errors` and counts zero successes.
    assert.equal(result.ok, true)
    assert.equal(result.marketsClaimed, 0)
    assert.equal(result.claimedPositions, 0)
    assert.equal(result.payoutUsdt, 0)
    assert.equal(result.errors.length, 1, 'failed market surfaced for the next tick to see')
    assert.equal(result.errors[0].marketAddress, market)
    assert.match(result.errors[0].reason, /confirm|drop/i)

    // The claim actually fired — proves we reached the on-chain step and
    // it was the receipt-status check (not an early bail) that stopped us.
    assert.equal(claimCalls.length, 1)
    assert.equal(traderCtorCalls[0].pk, pkFromEnc('enc_pinned'))

    // No row ever got flipped — status stays 'resolved_win', so the next
    // campaign tick (or watchdog cron) picks it up again.
    const claimedUpdates = spy.calls.filter((c) =>
      /UPDATE\s+"OutcomePosition"/i.test(norm(c.sql))
      && /status\s*=\s*'claimed'/i.test(norm(c.sql)),
    )
    assert.equal(
      claimedUpdates.length,
      0,
      "tx-not-confirmed branch must NOT issue a status='claimed' UPDATE",
    )
    // Also defensive: no UPDATEs of any kind on OutcomePosition during
    // the failed claim — proves we don't half-write txHashClose either.
    const anyOutcomeUpdates = spy.calls.filter((c) =>
      /UPDATE\s+"OutcomePosition"/i.test(norm(c.sql)),
    )
    assert.equal(
      anyOutcomeUpdates.length,
      0,
      'failed claim leaves OutcomePosition completely untouched for retry',
    )
  } finally {
    spy.restore()
    restoreDeps()
    restoreWallet()
    restoreEnv()
  }
})

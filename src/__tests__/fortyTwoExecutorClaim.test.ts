import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ethers } from 'ethers'
import { db } from '../db'
import {
  __testDeps,
  claimAllAgentResolved,
  type ExecutorDeps,
  type ExecutorTrader,
  type ExecutorTraderCtor,
  type OutcomePositionRow,
} from '../services/fortyTwoExecutor'
import type { Market42, MarketStatus } from '../services/fortyTwo'
import type { OnchainMarketState, OnchainOutcome } from '../services/fortyTwoOnchain'
import type { DryRunReceipt } from '../services/fortyTwoTrader'

// ── Shared test plumbing ────────────────────────────────────────────────
// Mirrors fortyTwoExecutorSql.test.ts: spy on db.$queryRawUnsafe / $executeRawUnsafe
// so we can assert SQL shape + parameter binding order without touching a
// real database, and stub the dependency seam (__testDeps) so neither the
// chain nor the wallet decryption path has to be wired in.

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

function withDeps(overrides: Partial<ExecutorDeps>): () => void {
  const snapshot = { ...__testDeps }
  Object.assign(__testDeps, overrides)
  return () => { Object.assign(__testDeps, snapshot) }
}

type WalletFindFirst = typeof db.wallet.findFirst
type WalletFindFirstArg = Parameters<WalletFindFirst>[0]
function withWalletFindFirst(
  impl: (arg: WalletFindFirstArg) => Promise<{
    address: string
    encryptedPK: string
    chain: string
    isActive: boolean
  } | null>,
): { calls: WalletFindFirstArg[]; restore: () => void } {
  const original = db.wallet.findFirst
  const calls: WalletFindFirstArg[] = []
  const wrapped = (async (arg: WalletFindFirstArg) => {
    calls.push(arg)
    return impl(arg)
  }) as unknown as WalletFindFirst
  ;(db.wallet as { findFirst: unknown }).findFirst = wrapped
  return {
    calls,
    restore() { (db.wallet as { findFirst: WalletFindFirst }).findFirst = original },
  }
}

function withCampaignEnv(agentId: string): () => void {
  const prevMode = process.env.FT_CAMPAIGN_MODE
  const prevAgent = process.env.FT_CAMPAIGN_AGENT_ID
  process.env.FT_CAMPAIGN_MODE = 'true'
  process.env.FT_CAMPAIGN_AGENT_ID = agentId
  return () => {
    if (prevMode === undefined) delete process.env.FT_CAMPAIGN_MODE; else process.env.FT_CAMPAIGN_MODE = prevMode
    if (prevAgent === undefined) delete process.env.FT_CAMPAIGN_AGENT_ID; else process.env.FT_CAMPAIGN_AGENT_ID = prevAgent
  }
}

// ── Fixture builders ────────────────────────────────────────────────────

// Real-looking 40-hex-char addresses — claimAgentResolvedForMarket validates
// market addresses against /^0x[0-9a-fA-F]{40}$/ and rejects anything else.
const MARKET_ADDR = '0x' + 'ab'.repeat(20)

function stubMarket(overrides: Partial<Market42> = {}): Market42 {
  return {
    address: MARKET_ADDR, questionId: 'qid', question: 'Q?', slug: 'q',
    collateralAddress: '0xUSDT', collateralSymbol: 'USDT', collateralDecimals: 18,
    curve: '0xCurve', startDate: '2025-01-01', endDate: '2025-12-31',
    status: 'live' as MarketStatus, finalisedAt: null, elapsedPct: 0, image: null,
    oracleAddress: null, creatorAddress: null, contractVersion: 1,
    ancillaryData: [], description: '', ...overrides,
  }
}
function stubOutcome(overrides: Partial<OnchainOutcome> = {}): OnchainOutcome {
  return {
    index: 0, tokenId: 1, label: 'YES', marginalPrice: 0n,
    priceFloat: 0.5, impliedProbability: 0.5, isWinner: false, ...overrides,
  }
}
function stubOnchainState(overrides: Partial<OnchainMarketState> = {}): OnchainMarketState {
  return {
    market: MARKET_ADDR, questionId: 'qid', curve: '0xCurve', collateralDecimals: 18,
    numOutcomes: 2, feeRate: 0n, isFinalised: false, resolvedAnswer: 0n,
    timestampEnd: 0, outcomes: [stubOutcome()], ...overrides,
  }
}
function stubPosition(overrides: Partial<OutcomePositionRow> = {}): OutcomePositionRow {
  return {
    id: 'pos_x', userId: 'user_X', agentId: 'agent_X',
    marketAddress: MARKET_ADDR, marketTitle: 'Q?', tokenId: 1, outcomeLabel: 'YES',
    usdtIn: 2, entryPrice: 0.5, exitPrice: null, payoutUsdt: null, pnl: null,
    status: 'open', paperTrade: false, txHashOpen: '0xopen', txHashClose: null,
    reasoning: null, openedAt: new Date(), closedAt: null,
    outcomeTokenAmount: 4, providers: null, ...overrides,
  }
}

// Trader factory that captures the `pk` arg so tests can assert which
// wallet's private key the executor used to construct the trader. That's
// the central invariant for the agent-scoped claim flow: the trader MUST
// be built from the agent's pinned wallet, not the user's primary BSC
// wallet, otherwise the on-chain claim runs against an account that holds
// none of the outcome tokens.
type Captured = { pk?: string; rpc?: string; opts?: { dryRun: boolean } }
function makeCapturingTraderCtor(
  capture: Captured,
  impl: Partial<ExecutorTrader>,
): ExecutorTraderCtor {
  class StubTrader implements ExecutorTrader {
    constructor(pk: string, rpc: string, opts: { dryRun: boolean }) {
      capture.pk = pk; capture.rpc = rpc; capture.opts = opts
    }
    async buyOutcome(): Promise<ethers.TransactionReceipt | DryRunReceipt | null> {
      return impl.buyOutcome ? impl.buyOutcome('', 0, '', 0n) : null
    }
    async sellOutcome(): Promise<ethers.TransactionReceipt | DryRunReceipt | null> {
      return impl.sellOutcome ? impl.sellOutcome('', 0, 0n, 0n) : null
    }
    async balanceOfOutcome(): Promise<bigint> {
      return impl.balanceOfOutcome ? impl.balanceOfOutcome('', 0) : 0n
    }
    async claimAllResolved(addr: string): Promise<ethers.TransactionReceipt | null> {
      if (!impl.claimAllResolved) return null
      return impl.claimAllResolved(addr) as Promise<ethers.TransactionReceipt | null>
    }
  }
  return StubTrader
}

// USDT (BSC) Transfer event constants — must match fortyTwoExecutor.ts.
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** Build a fake live receipt whose USDT Transfer log will parse to `usdt`. */
function liveReceiptWithUsdtPayout(usdt: number, hash: string): unknown {
  const raw = BigInt(Math.round(usdt * 1e18))
  // 32-byte hex padding for `to` address (parser only inspects topics[2]).
  const toPadded = '0x' + '00'.repeat(12) + 'aa'.repeat(20)
  return {
    hash,
    status: 1,
    logs: [
      {
        address: USDT_BSC,
        topics: [TRANSFER_TOPIC, '0x' + '00'.repeat(32), toPadded],
        data: '0x' + raw.toString(16).padStart(64, '0'),
      },
    ],
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test 1: full settle → claim happy path with the campaign agent's pinned wallet
// ──────────────────────────────────────────────────────────────────────
test('claimAllAgentResolved: settle flips open→resolved_win, claim flips →claimed with payoutUsdt + pnl, trader built from pinned Agent.walletId', async () => {
  const restoreEnv = withCampaignEnv('agent_X')

  // Stage 1 (settle): one open position that the on-chain read says is a win.
  const openPos = stubPosition({
    id: 'pos_open', userId: 'user_X', agentId: 'agent_X',
    marketAddress: MARKET_ADDR, tokenId: 1, usdtIn: 2,
    paperTrade: false, status: 'open',
  })
  // Stage 2 (claim): the same position, now flipped to resolved_win, comes
  // back from the per-market SELECT inside claimAgentResolvedForMarket.
  const winPos = stubPosition({
    ...openPos, status: 'resolved_win', exitPrice: 1, payoutUsdt: null, pnl: null,
  })

  // Capture the (pk, rpc, opts) the trader is constructed with so we can
  // confirm we used the AGENT's wallet, not the user's primary.
  const captured: Captured = {}
  const restoreDeps = withDeps({
    getMarketByAddress: async () => stubMarket({ status: 'resolved' }),
    readMarketOnchain: async () => stubOnchainState({
      isFinalised: true, resolvedAnswer: 1n,
      outcomes: [stubOutcome({ tokenId: 1, label: 'YES', impliedProbability: 0.5 })],
    }),
    isWinningTokenId: () => true,
    decryptPrivateKey: () => '0xPINNED_AGENT_PK',
    FortyTwoTraderCtor: makeCapturingTraderCtor(captured, {
      claimAllResolved: async () => liveReceiptWithUsdtPayout(3, '0xclaimtx') as ethers.TransactionReceipt,
    }),
  })
  const walletStub = withWalletFindFirst(async () => ({
    address: '0xAGENT_WALLET', encryptedPK: 'enc_pinned', chain: 'BSC', isActive: true,
  }))

  // SQL queue (in execution order):
  //   [0] SELECT "userId" FROM "Agent" WHERE id=$1            → {userId}
  //   [1] settleResolvedPositions: SELECT * open positions    → [openPos]
  //   [2] settleResolvedPositions: UPDATE → resolved_win
  //   [3] SELECT DISTINCT "marketAddress" resolved_win        → [{marketAddress}]
  //   [4] claimAgentResolvedForMarket: SELECT * resolved_win  → [winPos]
  //   [5] loadUserWalletPK: SELECT "walletId" FROM "Agent"    → {walletId: 'wallet_pinned'}
  //   [6] per-row UPDATE → status='claimed', payout, pnl
  const spy = installSqlSpies([
    [{ userId: 'user_X' }],
    [openPos],
    /* UPDATE has no result rows */
    [{ marketAddress: MARKET_ADDR }],
    [winPos],
    [{ walletId: 'wallet_pinned' }],
  ])
  try {
    const result = await claimAllAgentResolved('agent_X')
    assert.equal(result.ok, true)
    assert.equal(result.marketsClaimed, 1)
    assert.equal(result.claimedPositions, 1)
    assert.equal(result.payoutUsdt, 3, 'on-chain USDT inflow parsed from receipt')
    assert.equal(result.settled, 1, 'settle sweep flipped one open row to resolved_win')
    assert.deepEqual(result.errors, [])

    // ── SQL shape assertions ────────────────────────────────────────────
    assert.equal(spy.calls.length, 7, 'agent-userId + settle SELECT + settle UPDATE + win-markets SELECT + claim SELECT + walletId SELECT + claim UPDATE')

    // [0] agent → userId lookup
    assert.match(norm(spy.calls[0].sql), /SELECT\s+"userId"\s+FROM\s+"Agent"\s+WHERE\s+id\s*=\s*\$1/i)
    assert.deepEqual(spy.calls[0].params, ['agent_X'])

    // [1] settle SELECT scoped to agentId — proves we never claim positions
    //     belonging to a different agent or to manual user trades.
    assert.match(norm(spy.calls[1].sql), /FROM\s+"OutcomePosition"\s+WHERE\s+status\s*=\s*'open'\s+AND\s+"agentId"\s*=\s*\$1/i)
    assert.deepEqual(spy.calls[1].params, ['agent_X'])

    // [2] settle UPDATE writes status='resolved_win' for the won position.
    assert.match(norm(spy.calls[2].sql), /UPDATE\s+"OutcomePosition"\s+SET\s+status=\$1/i)
    assert.equal(spy.calls[2].params[0], 'resolved_win')
    assert.equal(spy.calls[2].params[4], 'pos_open', 'WHERE id matches the open position')

    // [3] DISTINCT win-markets SELECT, scoped to agentId.
    assert.match(norm(spy.calls[3].sql), /SELECT\s+DISTINCT\s+"marketAddress"\s+FROM\s+"OutcomePosition"\s+WHERE\s+"agentId"\s*=\s*\$1\s+AND\s+status\s*=\s*'resolved_win'/i)
    assert.deepEqual(spy.calls[3].params, ['agent_X'])

    // [4] claim SELECT scoped to (agentId, marketAddress, status).
    assert.match(norm(spy.calls[4].sql), /FROM\s+"OutcomePosition"\s+WHERE\s+"agentId"\s*=\s*\$1\s+AND\s+"marketAddress"\s*=\s*\$2\s+AND\s+status\s*=\s*'resolved_win'/i)
    assert.deepEqual(spy.calls[4].params, ['agent_X', MARKET_ADDR])

    // [5] Agent.walletId lookup — gating campaign-mode wallet pinning.
    assert.match(norm(spy.calls[5].sql), /SELECT\s+"walletId"\s+FROM\s+"Agent"\s+WHERE\s+id\s*=\s*\$1/i)
    assert.deepEqual(spy.calls[5].params, ['agent_X'])

    // [6] final UPDATE — status='claimed', writes payoutUsdt + pnl + tx hash.
    const update = spy.calls[6]
    const n = norm(update.sql)
    assert.match(n, /UPDATE\s+"OutcomePosition"/i)
    assert.match(n, /status='claimed'/i, "status hard-coded to 'claimed' literal")
    assert.match(n, /"txHashClose"=COALESCE\("txHashClose",\s*\$1\)/i, 'preserve original tx hash if present')
    assert.match(n, /"payoutUsdt"=\$2/i)
    assert.match(n, /pnl=\$3/i)
    assert.match(n, /WHERE\s+id=\$4/i)
    assert.equal(update.params[0], '0xclaimtx', 'txHash → $1')
    assert.equal(update.params[1], 3, 'payoutUsdt → $2 (parsed from receipt, not pre-claim estimate)')
    assert.equal(update.params[2], 1, 'pnl = 3 payout − 2 stake → $3')
    assert.equal(update.params[3], 'pos_open', 'WHERE id → $4 — the same row we settled')

    // ── Pinned-wallet routing assertions ────────────────────────────────
    // The trader MUST be built from the agent's pinned wallet PK. If the
    // executor regressed to the user's primary wallet, decryptPrivateKey
    // would still return '0xPINNED_AGENT_PK' here (single stub), but
    // db.wallet.findFirst would be invoked with the user-primary WHERE
    // shape ({ userId, chain: 'BSC', isActive: true }) instead of the
    // pinned-wallet shape ({ id, userId, chain: 'BSC' }).
    assert.equal(captured.pk, '0xPINNED_AGENT_PK', 'trader constructed with the pinned wallet PK')
    assert.equal(captured.opts?.dryRun, false, 'live mode (anyLive=true → forcePaperTrade=false)')
    assert.equal(walletStub.calls.length, 1, 'one wallet lookup — the pinned-wallet branch, no fallback')
    const walletWhere = (walletStub.calls[0] as { where: Record<string, unknown> }).where
    assert.equal(walletWhere.id, 'wallet_pinned', 'looked up the pinned wallet row by id')
    assert.equal(walletWhere.userId, 'user_X', 'still scoped to the agent\'s owning user')
    assert.equal(walletWhere.chain, 'BSC')
    assert.equal('isActive' in walletWhere, false, 'pinned-wallet branch does NOT filter on isActive — that is the user-primary branch')
  } finally {
    spy.restore()
    restoreDeps()
    walletStub.restore()
    restoreEnv()
  }
})

// ──────────────────────────────────────────────────────────────────────
// Test 2: no-Agent-walletId fallback — campaign agent w/o a pinned wallet
// must transparently fall back to the user's primary BSC wallet so the
// claim still goes through. Important: when admins forget to bind a
// wallet, claims should still work, not silently no-op.
// ──────────────────────────────────────────────────────────────────────
test('claimAllAgentResolved: when Agent.walletId is null, falls back to the user primary BSC wallet (no silent skip)', async () => {
  const restoreEnv = withCampaignEnv('agent_X')

  const winPos = stubPosition({
    id: 'pos_unpinned', userId: 'user_X', agentId: 'agent_X',
    marketAddress: MARKET_ADDR, status: 'resolved_win', usdtIn: 2,
  })

  const captured: Captured = {}
  const restoreDeps = withDeps({
    decryptPrivateKey: () => '0xPRIMARY_USER_PK',
    FortyTwoTraderCtor: makeCapturingTraderCtor(captured, {
      claimAllResolved: async () => liveReceiptWithUsdtPayout(2.5, '0xclaimtx2') as ethers.TransactionReceipt,
    }),
  })
  const walletStub = withWalletFindFirst(async () => ({
    address: '0xPRIMARY', encryptedPK: 'enc_primary', chain: 'BSC', isActive: true,
  }))

  // SQL queue:
  //   [0] SELECT "userId" FROM "Agent"           → user_X
  //   [1] settle SELECT (no opens)               → []  (settled stays 0)
  //   [2] DISTINCT win-markets                   → [{marketAddress}]
  //   [3] claim SELECT                           → [winPos]
  //   [4] SELECT "walletId"                      → {walletId: null}  ← fallback trigger
  //   [5] per-row UPDATE
  const spy = installSqlSpies([
    [{ userId: 'user_X' }],
    [],
    [{ marketAddress: MARKET_ADDR }],
    [winPos],
    [{ walletId: null }],
  ])
  try {
    const result = await claimAllAgentResolved('agent_X')
    assert.equal(result.ok, true)
    assert.equal(result.marketsClaimed, 1)
    assert.equal(result.claimedPositions, 1)
    assert.equal(result.payoutUsdt, 2.5)
    assert.equal(result.settled, 0, 'settle sweep had no open rows to flip')

    // The walletId lookup happened (we are in campaign mode) BUT it returned
    // null, so the function fell through to the default user-primary branch.
    assert.equal(walletStub.calls.length, 1, 'exactly one wallet lookup — the fallback branch')
    const where = (walletStub.calls[0] as { where: Record<string, unknown> }).where
    assert.equal(where.userId, 'user_X')
    assert.equal(where.chain, 'BSC')
    assert.equal(where.isActive, true, 'fallback branch DOES filter on isActive — proves we took the user-primary path')
    assert.equal('id' in where, false, 'fallback branch does NOT scope by wallet id')

    // Trader still got constructed and the claim happened — the absence of
    // a pinned wallet must not cause a silent no-op.
    assert.equal(captured.pk, '0xPRIMARY_USER_PK', 'trader built from the user primary wallet PK')

    // Final UPDATE still writes payout + pnl correctly.
    const update = spy.calls[5]
    assert.equal(update.params[0], '0xclaimtx2')
    assert.equal(update.params[1], 2.5)
    assert.equal(update.params[2], 0.5, 'pnl = 2.5 payout − 2 stake')
    assert.equal(update.params[3], 'pos_unpinned')
  } finally {
    spy.restore()
    restoreDeps()
    walletStub.restore()
    restoreEnv()
  }
})

// ──────────────────────────────────────────────────────────────────────
// Test 3: no resolved positions → early exit. No trader is built, no
// chain reads happen, and we return a zeroed-out OK result. This is the
// hot path on every campaign tick when there's nothing to settle.
// ──────────────────────────────────────────────────────────────────────
test('claimAllAgentResolved: returns 0/0/0 with no errors when there are no resolved_win positions (no trader build, no chain reads)', async () => {
  const restoreEnv = withCampaignEnv('agent_X')

  const captured: Captured = {}
  const restoreDeps = withDeps({
    // If the executor regresses and tries to build a trader on the empty
    // path, decryptPrivateKey will be called and the test will see
    // captured.pk get set — that's the regression assertion below.
    decryptPrivateKey: () => '0xSHOULD_NEVER_BE_USED',
    FortyTwoTraderCtor: makeCapturingTraderCtor(captured, {}),
  })
  const walletStub = withWalletFindFirst(async () => ({
    address: '0xPRIMARY', encryptedPK: 'enc', chain: 'BSC', isActive: true,
  }))

  // SQL queue:
  //   [0] agent → userId lookup
  //   [1] settle SELECT → no open rows
  //   [2] DISTINCT win-markets → no markets
  const spy = installSqlSpies([
    [{ userId: 'user_X' }],
    [],
    [],
  ])
  try {
    const result = await claimAllAgentResolved('agent_X')
    assert.deepEqual(result, {
      ok: true, marketsClaimed: 0, claimedPositions: 0, payoutUsdt: 0,
      settled: 0, errors: [],
    })
    assert.equal(spy.calls.length, 3, 'no per-market claim SQL when there are no resolved wins')
    assert.equal(captured.pk, undefined, 'trader was never constructed on the empty-claim path')
    assert.equal(walletStub.calls.length, 0, 'no wallet decryption on the empty-claim path')
  } finally {
    spy.restore()
    restoreDeps()
    walletStub.restore()
    restoreEnv()
  }
})

// ──────────────────────────────────────────────────────────────────────
// Test 4: missing Agent row → safe zero return. Defensive — covers the
// case where someone passes a stale agentId (e.g. after a wallet rebind
// shuffle). Must NOT throw, must NOT touch the chain.
// ──────────────────────────────────────────────────────────────────────
test('claimAllAgentResolved: returns zeroed OK result when the Agent row is missing (no userId)', async () => {
  const restoreEnv = withCampaignEnv('agent_missing')
  const captured: Captured = {}
  const restoreDeps = withDeps({
    decryptPrivateKey: () => '0xSHOULD_NEVER_BE_USED',
    FortyTwoTraderCtor: makeCapturingTraderCtor(captured, {}),
  })
  const spy = installSqlSpies([[]])
  try {
    const result = await claimAllAgentResolved('agent_missing')
    assert.deepEqual(result, {
      ok: true, marketsClaimed: 0, claimedPositions: 0, payoutUsdt: 0,
      settled: 0, errors: [],
    })
    assert.equal(spy.calls.length, 1, 'only the agent → userId lookup happens; no settle, no claim')
    assert.equal(captured.pk, undefined, 'trader never built when Agent row is missing')
  } finally {
    spy.restore()
    restoreDeps()
    restoreEnv()
  }
})

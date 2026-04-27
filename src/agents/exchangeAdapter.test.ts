import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  executeOpen,      executeClose,
  executeOpenAster, executeCloseAster,
  executeOpenHl,    executeCloseHl,
  type AsterOpenServices, type AsterCloseServices,
  type HlOpenServices,    type HlCloseServices,
  type OpenInput,         type CloseInput,
} from './exchangeAdapter'

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const baseAgent = { id: 'a1', name: 'TestAgent', exchange: 'aster' as string }
const hlAgent   = { ...baseAgent, exchange: 'hyperliquid' }

const baseUser = {
  id:                          'u1',
  asterOnboarded:              true,
  hyperliquidAgentAddress:     '0xagent',
  hyperliquidAgentEncryptedPK: 'encrypted',
}

const fakeAsterCreds: any = { signer: 'aster-signer' }
const fakeHlCreds:    any = { userAddress: '0xuser', agentAddress: '0xagent', agentPrivKey: '0xpk' }

function openInput(overrides: Partial<OpenInput> = {}): OpenInput {
  return {
    agent:         baseAgent,
    dbUser:        baseUser,
    userAddress:   '0xuser',
    side:          'LONG',
    pair:          'BTCUSDT',
    finalSize:     100,
    currentPrice:  50_000,
    decision:      { leverage: 5, stopLoss: 49_000, takeProfit: 52_000 },
    ...overrides,
  }
}

function closeInput(overrides: Partial<CloseInput> = {}): CloseInput {
  return {
    agent:         baseAgent,
    dbUser:        baseUser,
    userAddress:   '0xuser',
    openPos:       { id: 't1', pair: 'BTCUSDT', side: 'LONG', entryPrice: 50_000, size: 100 },
    fallbackPrice: 50_000,
    ...overrides,
  }
}

// ─── Aster: OPEN ─────────────────────────────────────────────────────────────

test('executeOpenAster returns no-creds when resolveAgentCreds returns null', async () => {
  const svc: AsterOpenServices = {
    resolveAgentCreds:         async () => null,
    getAccountBalanceStrict:   async () => ({ usdt: 100 }) as any,
    placeOrder:                async () => ({ avgPrice: 50_000, orderId: 'x' }) as any,
    placeOrderWithBuilderCode: async () => ({ avgPrice: 50_000, orderId: 'x' }) as any,
    placeBracketOrders:        async () => ({}) as any,
    reapproveAsterForUser:     async () => ({ success: true }) as any,
  }
  const r = await executeOpenAster(openInput(), svc)
  assert.deepEqual(r, { ok: false, reason: 'no-creds' })
})

test('executeOpenAster returns no-balance when usdt <= 0', async () => {
  const svc: AsterOpenServices = {
    resolveAgentCreds:         async () => fakeAsterCreds,
    getAccountBalanceStrict:   async () => ({ usdt: 0 }) as any,
    placeOrder:                async () => { throw new Error('should not be called') },
    placeOrderWithBuilderCode: async () => { throw new Error('should not be called') },
    placeBracketOrders:        async () => { throw new Error('should not be called') },
    reapproveAsterForUser:     async () => ({ success: true }) as any,
  }
  const r = await executeOpenAster(openInput(), svc)
  assert.deepEqual(r, { ok: false, reason: 'no-balance', balance: 0 })
})

test('executeOpenAster proceeds when balance pre-check throws', async () => {
  let placed = false
  const svc: AsterOpenServices = {
    resolveAgentCreds:         async () => fakeAsterCreds,
    getAccountBalanceStrict:   async () => { throw new Error('rpc down') },
    placeOrder:                async () => { placed = true; return { avgPrice: 50_100, orderId: 999 } as any },
    placeOrderWithBuilderCode: async () => { throw new Error('not reached') },
    placeBracketOrders:        async () => ({}) as any,
    reapproveAsterForUser:     async () => ({ success: true }) as any,
  }
  const r = await executeOpenAster(openInput(), svc)
  assert.equal(placed, true)
  assert.equal(r.ok, true)
})

test('executeOpenAster uses builder route when builderAddress is set and asterOnboarded', async () => {
  let usedBuilder = false
  let usedStandard = false
  const svc: AsterOpenServices = {
    resolveAgentCreds:         async () => fakeAsterCreds,
    getAccountBalanceStrict:   async () => ({ usdt: 1000 }) as any,
    placeOrder:                async () => { usedStandard = true; return { avgPrice: 50_000, orderId: 1 } as any },
    placeOrderWithBuilderCode: async () => { usedBuilder = true; return { avgPrice: 50_050, orderId: 42 } as any },
    placeBracketOrders:        async () => ({}) as any,
    reapproveAsterForUser:     async () => ({ success: true }) as any,
    builderAddress:            '0xBuilder',
    feeRate:                   '0.0001',
  }
  const r = await executeOpenAster(openInput(), svc)
  assert.equal(usedBuilder, true)
  assert.equal(usedStandard, false)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.fillPrice, 50_050)
    assert.equal(r.orderIdStr, '42')
  }
})

test('executeOpenAster uses standard route when builderAddress is unset', async () => {
  let usedBuilder = false
  let usedStandard = false
  const svc: AsterOpenServices = {
    resolveAgentCreds:         async () => fakeAsterCreds,
    getAccountBalanceStrict:   async () => ({ usdt: 1000 }) as any,
    placeOrder:                async () => { usedStandard = true; return { avgPrice: 50_000, orderId: 1 } as any },
    placeOrderWithBuilderCode: async () => { usedBuilder = true; return { avgPrice: 0, orderId: 2 } as any },
    placeBracketOrders:        async () => ({}) as any,
    reapproveAsterForUser:     async () => ({ success: true }) as any,
    // builderAddress intentionally undefined
  }
  const r = await executeOpenAster(openInput(), svc)
  assert.equal(usedStandard, true)
  assert.equal(usedBuilder, false)
  assert.equal(r.ok, true)
})

test('executeOpenAster falls back to currentPrice when avgPrice <= 0', async () => {
  const svc: AsterOpenServices = {
    resolveAgentCreds:         async () => fakeAsterCreds,
    getAccountBalanceStrict:   async () => ({ usdt: 1000 }) as any,
    placeOrder:                async () => ({ avgPrice: 0, orderId: 7 }) as any,
    placeOrderWithBuilderCode: async () => ({ avgPrice: 0, orderId: 7 }) as any,
    placeBracketOrders:        async () => ({}) as any,
    reapproveAsterForUser:     async () => ({ success: true }) as any,
  }
  const r = await executeOpenAster(openInput({ currentPrice: 49_999 }), svc)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.fillPrice, 49_999)
})

test('executeOpenAster auto-reapproves on "No agent found" error', async () => {
  let reapproved = false
  const svc: AsterOpenServices = {
    resolveAgentCreds:         async () => fakeAsterCreds,
    getAccountBalanceStrict:   async () => ({ usdt: 1000 }) as any,
    placeOrder:                async () => {
      const err: any = new Error('Request failed with status code 400')
      err.response = { data: { code: -1000, msg: 'No agent found' } }
      throw err
    },
    placeOrderWithBuilderCode: async () => { throw new Error('not reached') },
    placeBracketOrders:        async () => ({}) as any,
    reapproveAsterForUser:     async () => { reapproved = true; return { success: true, agentAddress: '0xnew', builderEnrolled: true } as any },
  }
  const r = await executeOpenAster(openInput(), svc)
  assert.equal(reapproved, true)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.reason, 'rejected')
    assert.match(r.detail ?? '', /No agent found/)
  }
})

test('executeOpenAster does NOT auto-reapprove on unrelated rejects', async () => {
  let reapproved = false
  const svc: AsterOpenServices = {
    resolveAgentCreds:         async () => fakeAsterCreds,
    getAccountBalanceStrict:   async () => ({ usdt: 1000 }) as any,
    placeOrder:                async () => {
      const err: any = new Error('Request failed with status code 400')
      err.response = { data: { code: -2010, msg: 'Account has insufficient balance' } }
      throw err
    },
    placeOrderWithBuilderCode: async () => { throw new Error('not reached') },
    placeBracketOrders:        async () => ({}) as any,
    reapproveAsterForUser:     async () => { reapproved = true; return { success: true } as any },
  }
  const r = await executeOpenAster(openInput(), svc)
  assert.equal(reapproved, false)
  assert.equal(r.ok, false)
})

test('executeOpenAster bracket failure does NOT fail the open', async () => {
  const svc: AsterOpenServices = {
    resolveAgentCreds:         async () => fakeAsterCreds,
    getAccountBalanceStrict:   async () => ({ usdt: 1000 }) as any,
    placeOrder:                async () => ({ avgPrice: 50_000, orderId: 88 }) as any,
    placeOrderWithBuilderCode: async () => ({ avgPrice: 50_000, orderId: 88 }) as any,
    placeBracketOrders:        async () => { throw new Error('bracket rejected') },
    reapproveAsterForUser:     async () => ({ success: true }) as any,
  }
  const r = await executeOpenAster(openInput(), svc)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.orderIdStr, '88')
})

// ─── Aster: CLOSE ────────────────────────────────────────────────────────────

test('executeCloseAster returns no-creds when resolveAgentCreds returns null', async () => {
  const svc: AsterCloseServices = {
    resolveAgentCreds: async () => null,
    closePosition:     async () => ({}) as any,
    getMarkPrice:      async () => ({ markPrice: 50_000 }) as any,
  }
  const r = await executeCloseAster(closeInput(), svc)
  assert.deepEqual(r, { ok: false, reason: 'no-creds' })
})

test('executeCloseAster uses mark price when available, falls back otherwise', async () => {
  const svcOk: AsterCloseServices = {
    resolveAgentCreds: async () => fakeAsterCreds,
    closePosition:     async () => ({}) as any,
    getMarkPrice:      async () => ({ markPrice: 51_500 }) as any,
  }
  const r1 = await executeCloseAster(closeInput(), svcOk)
  assert.equal(r1.ok, true)
  if (r1.ok) assert.equal(r1.exitPrice, 51_500)

  const svcFail: AsterCloseServices = {
    resolveAgentCreds: async () => fakeAsterCreds,
    closePosition:     async () => ({}) as any,
    getMarkPrice:      async () => { throw new Error('mark rpc down') },
  }
  const r2 = await executeCloseAster(closeInput({ fallbackPrice: 49_000 }), svcFail)
  assert.equal(r2.ok, true)
  if (r2.ok) assert.equal(r2.exitPrice, 49_000)
})

test('executeCloseAster surfaces close errors', async () => {
  const svc: AsterCloseServices = {
    resolveAgentCreds: async () => fakeAsterCreds,
    closePosition:     async () => { throw new Error('reduce only failed') },
    getMarkPrice:      async () => ({ markPrice: 50_000 }) as any,
  }
  const r = await executeCloseAster(closeInput(), svc)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.reason, 'rejected')
    assert.match(r.detail ?? '', /reduce only failed/)
  }
})

// ─── Hyperliquid: OPEN ───────────────────────────────────────────────────────

test('executeOpenHl returns no-creds when resolveAgentCreds returns null', async () => {
  const svc: HlOpenServices = {
    resolveAgentCreds:  async () => null,
    getAccountState:    async () => ({ withdrawableUsdc: 100 }) as any,
    getSpotUsdcBalance: async () => 0,
    placeOrder:         async () => ({ success: true, oid: 1 }),
    placeStopLoss:      async () => ({ success: true }),
    placeTakeProfit:    async () => ({ success: true }),
    getMarkPrice:       async () => ({ markPrice: 50_000 }),
  }
  const r = await executeOpenHl(openInput({ agent: hlAgent }), svc)
  assert.deepEqual(r, { ok: false, reason: 'no-creds' })
})

test('executeOpenHl returns no-balance with spot-detail when perps empty but spot has USDC', async () => {
  const svc: HlOpenServices = {
    resolveAgentCreds:  async () => fakeHlCreds,
    getAccountState:    async () => ({ withdrawableUsdc: 0, accountValue: 0, onboarded: true, positions: [], abstraction: 'default' }) as any,
    getSpotUsdcBalance: async () => 250.5,
    placeOrder:         async () => { throw new Error('should not be called') },
    placeStopLoss:      async () => { throw new Error('should not be called') },
    placeTakeProfit:    async () => { throw new Error('should not be called') },
    getMarkPrice:       async () => ({ markPrice: 50_000 }),
  }
  const r = await executeOpenHl(openInput({ agent: hlAgent }), svc)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.reason, 'no-balance')
    assert.equal(r.balance, 0)
    assert.match(r.detail ?? '', /spot/i)
    assert.match(r.detail ?? '', /250\.50/)
  }
})

test('executeOpenHl returns no-balance without spot-detail when both empty', async () => {
  const svc: HlOpenServices = {
    resolveAgentCreds:  async () => fakeHlCreds,
    getAccountState:    async () => ({ withdrawableUsdc: 0 }) as any,
    getSpotUsdcBalance: async () => 0,
    placeOrder:         async () => { throw new Error('not reached') },
    placeStopLoss:      async () => ({ success: true }),
    placeTakeProfit:    async () => ({ success: true }),
    getMarkPrice:       async () => ({ markPrice: 50_000 }),
  }
  const r = await executeOpenHl(openInput({ agent: hlAgent }), svc)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.reason, 'no-balance')
    assert.equal(r.detail ?? '', '')
  }
})

test('executeOpenHl happy path returns oid as orderIdStr and fresh markPrice as fillPrice', async () => {
  const svc: HlOpenServices = {
    resolveAgentCreds:  async () => fakeHlCreds,
    getAccountState:    async () => ({ withdrawableUsdc: 1000 }) as any,
    getSpotUsdcBalance: async () => 0,
    placeOrder:         async () => ({ success: true, oid: 9876 }),
    placeStopLoss:      async () => ({ success: true, oid: 1 }),
    placeTakeProfit:    async () => ({ success: true, oid: 2 }),
    getMarkPrice:       async () => ({ markPrice: 50_123.4 }),
  }
  const r = await executeOpenHl(openInput({ agent: hlAgent }), svc)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.orderIdStr, '9876')
    assert.equal(r.fillPrice, 50_123.4)
  }
})

test('executeOpenHl retries without builder fee on builder-related error', async () => {
  let calls = 0
  let withBuilderArgs: any = null
  let withoutBuilderArgs: any = null
  const svc: HlOpenServices = {
    resolveAgentCreds:  async () => fakeHlCreds,
    getAccountState:    async () => ({ withdrawableUsdc: 1000 }) as any,
    getSpotUsdcBalance: async () => 0,
    placeOrder:         async (_creds, args) => {
      calls++
      if (calls === 1) {
        withBuilderArgs = args
        return { success: false, error: 'Builder has insufficient balance to be approved' }
      }
      withoutBuilderArgs = args
      return { success: true, oid: 1234 }
    },
    placeStopLoss:      async () => ({ success: true }),
    placeTakeProfit:    async () => ({ success: true }),
    getMarkPrice:       async () => ({ markPrice: 50_000 }),
  }
  const r = await executeOpenHl(openInput({ agent: hlAgent }), svc)
  assert.equal(calls, 2)
  assert.equal(withBuilderArgs.noBuilder ?? false, false)
  assert.equal(withoutBuilderArgs.noBuilder, true)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.orderIdStr, '1234')
})

test('executeOpenHl returns rejected when placeOrder returns success without oid', async () => {
  const svc: HlOpenServices = {
    resolveAgentCreds:  async () => fakeHlCreds,
    getAccountState:    async () => ({ withdrawableUsdc: 1000 }) as any,
    getSpotUsdcBalance: async () => 0,
    placeOrder:         async () => ({ success: true }),  // no oid
    placeStopLoss:      async () => ({ success: true }),
    placeTakeProfit:    async () => ({ success: true }),
    getMarkPrice:       async () => ({ markPrice: 50_000 }),
  }
  const r = await executeOpenHl(openInput({ agent: hlAgent }), svc)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.reason, 'rejected')
    assert.match(r.detail ?? '', /without oid/i)
  }
})

test('executeOpenHl bracket failure does NOT fail the open', async () => {
  const svc: HlOpenServices = {
    resolveAgentCreds:  async () => fakeHlCreds,
    getAccountState:    async () => ({ withdrawableUsdc: 1000 }) as any,
    getSpotUsdcBalance: async () => 0,
    placeOrder:         async () => ({ success: true, oid: 5 }),
    placeStopLoss:      async () => { throw new Error('SL threw') },
    placeTakeProfit:    async () => ({ success: false, error: 'TP rejected' }),
    getMarkPrice:       async () => ({ markPrice: 50_000 }),
  }
  const r = await executeOpenHl(openInput({ agent: hlAgent }), svc)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.orderIdStr, '5')
})

test('executeOpenHl skips brackets when decision has no SL/TP', async () => {
  let slCalled = false
  let tpCalled = false
  const svc: HlOpenServices = {
    resolveAgentCreds:  async () => fakeHlCreds,
    getAccountState:    async () => ({ withdrawableUsdc: 1000 }) as any,
    getSpotUsdcBalance: async () => 0,
    placeOrder:         async () => ({ success: true, oid: 1 }),
    placeStopLoss:      async () => { slCalled = true; return { success: true } },
    placeTakeProfit:    async () => { tpCalled = true; return { success: true } },
    getMarkPrice:       async () => ({ markPrice: 50_000 }),
  }
  await executeOpenHl(
    openInput({ agent: hlAgent, decision: { leverage: 1, stopLoss: null, takeProfit: null } }),
    svc,
  )
  assert.equal(slCalled, false)
  assert.equal(tpCalled, false)
})

// ─── Hyperliquid: CLOSE ──────────────────────────────────────────────────────

// Default account-state stub: returns one matching position so the close
// path exercises the venue-reconcile branch. Tests that need different
// behavior (account-throws, already-flat) override this.
const hlAcctOk = async (_addr: string) => ({
  positions: [{ coin: 'BTC', szi: 0.02 }],
}) as any

test('executeCloseHl returns no-creds when resolveAgentCreds returns null', async () => {
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => null,
    placeOrder:        async () => ({ success: true, oid: 1 }),
    getMarkPrice:      async () => ({ markPrice: 50_000 }),
    getAccountState:   hlAcctOk,
  }
  const r = await executeCloseHl(closeInput({ agent: hlAgent }), svc)
  assert.deepEqual(r, { ok: false, reason: 'no-creds' })
})

test('executeCloseHl submits OPPOSITE side as reduce-only', async () => {
  let placedArgs: any = null
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => fakeHlCreds,
    placeOrder:        async (_c, args) => { placedArgs = args; return { success: true, oid: 99 } },
    getMarkPrice:      async () => ({ markPrice: 51_000 }),
    getAccountState:   hlAcctOk,
  }
  const r = await executeCloseHl(closeInput({ agent: hlAgent }), svc)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.exitPrice, 51_000)
  assert.equal(placedArgs.side, 'SHORT')   // closing a LONG → SHORT
  assert.equal(placedArgs.reduceOnly, true)
  assert.equal(placedArgs.type, 'MARKET')
})

test('executeCloseHl inverts SHORT to LONG for close', async () => {
  let placedArgs: any = null
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => fakeHlCreds,
    placeOrder:        async (_c, args) => { placedArgs = args; return { success: true, oid: 1 } },
    getMarkPrice:      async () => ({ markPrice: 50_000 }),
    getAccountState:   async () => ({ positions: [{ coin: 'ETH', szi: -50 }] }) as any,
  }
  await executeCloseHl(
    closeInput({ agent: hlAgent, openPos: { id: 't2', pair: 'ETHUSDT', side: 'SHORT', entryPrice: 3_000, size: 50 } }),
    svc,
  )
  assert.equal(placedArgs.side, 'LONG')
  assert.equal(placedArgs.reduceOnly, true)
})

test('executeCloseHl surfaces placeOrder failure as rejected', async () => {
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => fakeHlCreds,
    placeOrder:        async () => ({ success: false, error: 'Insufficient margin' }),
    getMarkPrice:      async () => ({ markPrice: 50_000 }),
    getAccountState:   hlAcctOk,
  }
  const r = await executeCloseHl(closeInput({ agent: hlAgent }), svc)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.reason, 'rejected')
    assert.match(r.detail ?? '', /Insufficient margin/)
  }
})

test('executeCloseHl uses fallbackPrice when getMarkPrice fails', async () => {
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => fakeHlCreds,
    placeOrder:        async () => ({ success: true, oid: 1 }),
    getMarkPrice:      async () => { throw new Error('mark rpc down') },
    getAccountState:   hlAcctOk,
  }
  const r = await executeCloseHl(closeInput({ agent: hlAgent, fallbackPrice: 48_888 }), svc)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.exitPrice, 48_888)
})

// ── New: architect follow-ups ────────────────────────────────────────────────

test('executeCloseHl uses venue szi (not DB size) when reconcile succeeds', async () => {
  let placedSz: number | null = null
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => fakeHlCreds,
    placeOrder:        async (_c, args) => { placedSz = args.sz; return { success: true, oid: 7 } },
    getMarkPrice:      async () => ({ markPrice: 50_000 }),
    // DB thinks 0.02 BTC; venue actually has 0.0195 (2.5% slippage on entry).
    // Reconcile must use venue value to avoid leaving dust.
    getAccountState:   async () => ({ positions: [{ coin: 'BTC', szi: 0.0195 }] }) as any,
  }
  await executeCloseHl(
    closeInput({ agent: hlAgent, openPos: { id: 't', pair: 'BTCUSDT', side: 'LONG', entryPrice: 50_000, size: 1_000 } }),
    svc,
  )
  assert.equal(placedSz, 0.0195, 'close size must come from venue szi, not DB-derived')
})

test('executeCloseHl returns ok without placing order when venue is already flat', async () => {
  let placeCalled = false
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => fakeHlCreds,
    placeOrder:        async () => { placeCalled = true; return { success: true, oid: 1 } },
    getMarkPrice:      async () => ({ markPrice: 50_000 }),
    getAccountState:   async () => ({ positions: [] }) as any, // already closed externally
  }
  const r = await executeCloseHl(closeInput({ agent: hlAgent }), svc)
  assert.equal(r.ok, true, 'already-flat is a successful close — DB just catches up')
  assert.equal(placeCalled, false, 'must NOT submit an order when there is nothing to close')
})

test('executeCloseHl falls back to DB size when account state throws', async () => {
  let placedSz: number | null = null
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => fakeHlCreds,
    placeOrder:        async (_c, args) => { placedSz = args.sz; return { success: true, oid: 1 } },
    getMarkPrice:      async () => ({ markPrice: 50_000 }),
    getAccountState:   async () => { throw new Error('rpc 503') },
  }
  await executeCloseHl(
    closeInput({ agent: hlAgent, openPos: { id: 't', pair: 'BTCUSDT', side: 'LONG', entryPrice: 50_000, size: 1_000 } }),
    svc,
  )
  // 1000 USD notional / 50000 entry = 0.02 BTC
  assert.equal(placedSz, 0.02, 'best-effort fallback to DB-derived size when reconcile is unreachable')
})

test('executeCloseHl returns rejected when placeOrder returns success without oid', async () => {
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => fakeHlCreds,
    placeOrder:        async () => ({ success: true /* no oid */ }) as any,
    getMarkPrice:      async () => ({ markPrice: 50_000 }),
    getAccountState:   hlAcctOk,
  }
  const r = await executeCloseHl(closeInput({ agent: hlAgent }), svc)
  assert.equal(r.ok, false, 'phantom acceptance must NOT mark the DB closed')
  if (!r.ok) {
    assert.equal(r.reason, 'rejected')
    assert.match(r.detail ?? '', /no order id/i)
  }
})

// ── Strict dispatch (executeOpen / executeClose entry points) ────────────────

test('executeOpen returns rejected for unknown exchange (no silent Aster fallthrough)', async () => {
  const r = await executeOpen({
    agent:        { id: 'a', name: 'Agent', exchange: 'binance' as string }, // typo'd venue
    dbUser:       baseUser as any,
    userAddress:  '0xuser',
    side:         'LONG',
    pair:         'BTCUSDT',
    finalSize:    100,
    currentPrice: 50_000,
    decision:     {},
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.reason, 'rejected', 'unknown exchange must hard-reject, never default to Aster')
    assert.match(r.detail ?? '', /Unknown exchange.*binance/i)
  }
})

test('executeClose returns rejected for unknown exchange (no silent Aster fallthrough)', async () => {
  const r = await executeClose({
    agent:        { id: 'a', name: 'Agent', exchange: 'binance' as string },
    dbUser:       baseUser as any,
    userAddress:  '0xuser',
    openPos:      { id: 't', pair: 'BTCUSDT', side: 'LONG', entryPrice: 50_000, size: 1_000 },
    fallbackPrice: 50_000,
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.reason, 'rejected')
    assert.match(r.detail ?? '', /Unknown exchange.*binance/i)
  }
})

test('executeOpen returns mock for mock-mode agents (paper-trading fallthrough)', async () => {
  const r = await executeOpen({
    agent:        { id: 'a', name: 'Agent', exchange: 'mock' as string },
    dbUser:       baseUser as any,
    userAddress:  '0xuser',
    side:         'LONG',
    pair:         'BTCUSDT',
    finalSize:    100,
    currentPrice: 50_000,
    decision:     {},
  })
  assert.deepEqual(r, { ok: false, reason: 'mock' })
})

// ── Helpers: normalizeHlCoin ─────────────────────────────────────────────────
import { normalizeHlCoin, isLiveVenueRejection } from './exchangeAdapter'

test('normalizeHlCoin handles every pair format we see today', () => {
  // The architect specifically called out BTC/USDT and BTC-USDT — those
  // were silently failing the venue-position match before.
  assert.equal(normalizeHlCoin('BTCUSDT'),  'BTC')
  assert.equal(normalizeHlCoin('ETHUSDT'),  'ETH')
  assert.equal(normalizeHlCoin('BTC/USDT'), 'BTC')
  assert.equal(normalizeHlCoin('BTC-USDT'), 'BTC')
  assert.equal(normalizeHlCoin('BTC_USDT'), 'BTC')
  assert.equal(normalizeHlCoin('BTCUSD'),   'BTC')
  assert.equal(normalizeHlCoin('SOL-USD'),  'SOL')
  assert.equal(normalizeHlCoin('btc/usdt'), 'BTC')   // case-insensitive
  assert.equal(normalizeHlCoin(' BTC USDT '), 'BTC') // whitespace-tolerant
  assert.equal(normalizeHlCoin('BTC'),      'BTC')   // already bare
})

test('executeCloseHl venue-match works with hyphenated/slashed pair formats', async () => {
  let placedSz: number | null = null
  const svc: HlCloseServices = {
    resolveAgentCreds: async () => fakeHlCreds,
    placeOrder:        async (_c, args) => { placedSz = args.sz; return { success: true, oid: 1 } },
    getMarkPrice:      async () => ({ markPrice: 50_000 }),
    getAccountState:   async () => ({ positions: [{ coin: 'BTC', szi: 0.05 }] }) as any,
  }
  // Pair comes in as "BTC/USDT" — must still match venue's "BTC".
  await executeCloseHl(
    closeInput({
      agent: hlAgent,
      openPos: { id: 't', pair: 'BTC/USDT', side: 'LONG', entryPrice: 50_000, size: 2_500 },
    }),
    svc,
  )
  assert.equal(placedSz, 0.05, 'must match venue szi via normalized coin (not return false-flat)')
})

// ── Helpers: isLiveVenueRejection ────────────────────────────────────────────

test('isLiveVenueRejection: live exchange + rejected → true', () => {
  assert.equal(isLiveVenueRejection({ ok: false, reason: 'rejected', detail: 'x' } as any, 'hyperliquid'), true)
  assert.equal(isLiveVenueRejection({ ok: false, reason: 'rejected' } as any, 'aster'), true)
})

test('isLiveVenueRejection: live exchange + no-creds → true', () => {
  assert.equal(isLiveVenueRejection({ ok: false, reason: 'no-creds' } as any, 'hyperliquid'), true)
  assert.equal(isLiveVenueRejection({ ok: false, reason: 'no-creds' } as any, 'aster'), true)
})

test('isLiveVenueRejection: mock exchange always → false (paper-trade preserved)', () => {
  assert.equal(isLiveVenueRejection({ ok: false, reason: 'rejected' } as any, 'mock'), false)
  assert.equal(isLiveVenueRejection({ ok: false, reason: 'no-creds' } as any, 'mock'), false)
  assert.equal(isLiveVenueRejection({ ok: false, reason: 'mock' } as any, 'mock'), false)
})

test('isLiveVenueRejection: ok results always → false', () => {
  assert.equal(isLiveVenueRejection({ ok: true, exitPrice: 100 } as any, 'hyperliquid'), false)
  assert.equal(isLiveVenueRejection({ ok: true, fillPrice: 100, orderIdStr: '1' } as any, 'aster'), false)
})

test('isLiveVenueRejection: live exchange + no-balance → false (caller already handles)', () => {
  // no-balance is its own branch in the OPEN site (already logs+continues
  // with full diagnostics); we don't want the caller to double-handle it
  // through the rejection path.
  assert.equal(isLiveVenueRejection({ ok: false, reason: 'no-balance', balance: 0 } as any, 'hyperliquid'), false)
  assert.equal(isLiveVenueRejection({ ok: false, reason: 'mock' } as any, 'hyperliquid'), false)
})

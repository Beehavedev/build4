import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runSpotToPerps,
  HL_SPOT_TRANSFER_LOCKS,
  type SpotToPerpsDeps,
  type SpotToPerpsWallet,
} from './spotToPerps'

// ── Test helpers ────────────────────────────────────────────────────────
// `runSpotToPerps` is dependency-injected so we never reach a real Express
// stack, a real Prisma query, or a real Hyperliquid SDK call. Each test
// builds a `deps` object out of the four seams: findActiveWallet,
// decryptPrivateKey, getSpotUsdcBalance, transferSpotPerp.

function stubWallet(over: Partial<SpotToPerpsWallet> = {}): SpotToPerpsWallet {
  return {
    address:     '0xWallet',
    encryptedPK: 'enc:dummy',
    userId:      'user_1',
    ...over,
  }
}

interface DepsOverrides {
  findActiveWallet?:   SpotToPerpsDeps['findActiveWallet']
  decryptPrivateKey?:  SpotToPerpsDeps['decryptPrivateKey']
  getSpotUsdcBalance?: SpotToPerpsDeps['getSpotUsdcBalance']
  transferSpotPerp?:   SpotToPerpsDeps['transferSpotPerp']
}

function makeDeps(over: DepsOverrides = {}): SpotToPerpsDeps {
  return {
    findActiveWallet:   async () => stubWallet(),
    // Default: succeeds for any candidate. Tests that care about the
    // candidate loop override this.
    decryptPrivateKey:  () => '0xPRIVATE_KEY',
    getSpotUsdcBalance: async () => 100,
    transferSpotPerp:   async () => ({ success: true }),
    ...over,
  }
}

// Belt-and-suspenders: every test releases its lock in `finally`, but if a
// regression ever leaked a userId into the module-level set, every
// subsequent test for that user would 429. Reset between tests.
function clearLocks() {
  HL_SPOT_TRANSFER_LOCKS.clear()
}

// ── Happy path: HL transferSpotPerp succeeds ────────────────────────────
test('runSpotToPerps: success → 200 with { success: true, amount }', async () => {
  clearLocks()
  let transferCalls: Array<{ pk: string; amount: number; toPerp: boolean }> = []
  const deps = makeDeps({
    getSpotUsdcBalance: async () => 50,
    transferSpotPerp: async (pk, amount, toPerp) => {
      transferCalls.push({ pk, amount, toPerp })
      return { success: true }
    },
  })
  const result = await runSpotToPerps({
    user: { id: 'user_1', telegramId: 99 },
    rawAmount: 12.5,
    deps,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { success: true, amount: 12.5 })
  assert.equal(transferCalls.length, 1, 'transferSpotPerp called exactly once')
  assert.equal(transferCalls[0].pk, '0xPRIVATE_KEY')
  assert.equal(transferCalls[0].amount, 12.5)
  assert.equal(transferCalls[0].toPerp, true, 'always spot→perps from this endpoint')
  // Lock is released after success so a follow-up call can run.
  assert.equal(HL_SPOT_TRANSFER_LOCKS.has('user_1'), false)
})

// ── Per-user mutex: concurrent second call short-circuits with 429 ──────
test('runSpotToPerps: concurrent second call for same user returns 429', async () => {
  clearLocks()
  // Hold the first call inside transferSpotPerp until we let it go. While
  // the first call is suspended, the second should see the lock and
  // immediately return 429 — no decrypt, no balance fetch, no transfer.
  let release!: () => void
  const transferGate = new Promise<void>((res) => { release = res })
  let transferCallCount = 0
  let balanceCallCount = 0
  const deps = makeDeps({
    getSpotUsdcBalance: async () => { balanceCallCount += 1; return 100 },
    transferSpotPerp: async () => {
      transferCallCount += 1
      await transferGate
      return { success: true }
    },
  })
  const first = runSpotToPerps({ user: { id: 'user_1' }, rawAmount: 10, deps })
  // Yield so `first` reaches its first await and registers the lock.
  await Promise.resolve()
  await Promise.resolve()
  const second = await runSpotToPerps({ user: { id: 'user_1' }, rawAmount: 10, deps })
  assert.equal(second.status, 429)
  assert.equal(second.body.success, false)
  assert.match(String(second.body.error), /already in progress/i)
  // Crucially: the second call did NOT touch the wallet/HL — proving the
  // lock short-circuited it before any side-effecting work.
  assert.equal(transferCallCount, 1, 'only the first call started a transfer')
  // First call may or may not have hit the balance fetch yet depending on
  // microtask scheduling, but the second one must NOT have added to it.
  assert.ok(balanceCallCount <= 1, 'second call did not fetch balance')

  release()
  const firstResult = await first
  assert.equal(firstResult.status, 200, 'first call still succeeds after lock contention')
  assert.equal(HL_SPOT_TRANSFER_LOCKS.has('user_1'), false, 'lock cleared after first finishes')
})

// ── Decrypt-candidate loop: fails on every candidate → needsRecovery ────
test('runSpotToPerps: decrypt failure on every candidate → 400 with needsRecovery: true', async () => {
  clearLocks()
  const tried: string[] = []
  const deps = makeDeps({
    findActiveWallet: async () => stubWallet({ userId: 'legacy_user_id' }),
    // Throw for every candidate to exhaust the loop.
    decryptPrivateKey: (_enc, candidate) => {
      tried.push(candidate)
      throw new Error('bad key')
    },
  })
  const result = await runSpotToPerps({
    user: { id: 'user_1', telegramId: 12345 },
    rawAmount: 0,
    deps,
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.success, false)
  assert.equal(result.body.needsRecovery, true,
    'needsRecovery surfaces so the mini-app can show the wallet-recovery banner')
  assert.match(String(result.body.error), /Wallet recovery/i)
  // All three identity conventions get a turn before we give up: current
  // user.id, telegramId stringified, and the legacy wallet.userId.
  assert.deepEqual(tried, ['user_1', '12345', 'legacy_user_id'],
    'candidate loop tries [user.id, telegramId, wallet.userId] in that order')
  assert.equal(HL_SPOT_TRANSFER_LOCKS.has('user_1'), false, 'lock released even on failure')
})

// ── Decrypt-candidate loop: third candidate works ───────────────────────
test('runSpotToPerps: succeeds when only the legacy wallet.userId candidate decrypts', async () => {
  clearLocks()
  const tried: string[] = []
  const deps = makeDeps({
    findActiveWallet: async () => stubWallet({ userId: 'legacy_user_id' }),
    decryptPrivateKey: (_enc, candidate) => {
      tried.push(candidate)
      // Only the third candidate decrypts cleanly. The first two throw,
      // simulating a wallet encrypted under the legacy key convention.
      if (candidate === 'legacy_user_id') return '0xLEGACY_PK'
      throw new Error('wrong candidate')
    },
  })
  const result = await runSpotToPerps({
    user: { id: 'user_1', telegramId: 12345 },
    rawAmount: 5,
    deps,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.success, true)
  assert.equal(tried.length, 3, 'loop walks all candidates until one decrypts')
})

// ── Amount handling: omitted ────────────────────────────────────────────
test('runSpotToPerps: omitted amount moves the full available balance', async () => {
  clearLocks()
  let movedAmount: number | null = null
  const deps = makeDeps({
    getSpotUsdcBalance: async () => 73.42,
    transferSpotPerp: async (_pk, amount) => { movedAmount = amount; return { success: true } },
  })
  const result = await runSpotToPerps({
    user: { id: 'user_1' },
    rawAmount: undefined,
    deps,
  })
  assert.equal(result.status, 200)
  assert.equal(movedAmount, 73.42, 'omitted amount → full balance')
  assert.equal(result.body.amount, 73.42)
})

// ── Amount handling: 0 ──────────────────────────────────────────────────
test('runSpotToPerps: amount=0 is treated as "move everything", not a no-op', async () => {
  // The mini-app sends 0 from the "Move all" button. If we ever flipped
  // this to "validate as positive" the button would silently 400.
  clearLocks()
  let movedAmount: number | null = null
  const deps = makeDeps({
    getSpotUsdcBalance: async () => 200,
    transferSpotPerp: async (_pk, amount) => { movedAmount = amount; return { success: true } },
  })
  const result = await runSpotToPerps({
    user: { id: 'user_1' },
    rawAmount: 0,
    deps,
  })
  assert.equal(result.status, 200)
  assert.equal(movedAmount, 200)
  assert.equal(result.body.amount, 200)
})

// ── Amount handling: explicit honored, capped to available ──────────────
test('runSpotToPerps: explicit amount is honored when ≤ available balance', async () => {
  clearLocks()
  let movedAmount: number | null = null
  const deps = makeDeps({
    getSpotUsdcBalance: async () => 100,
    transferSpotPerp: async (_pk, amount) => { movedAmount = amount; return { success: true } },
  })
  const result = await runSpotToPerps({
    user: { id: 'user_1' }, rawAmount: 25, deps,
  })
  assert.equal(result.status, 200)
  assert.equal(movedAmount, 25, 'explicit amount honored verbatim')
})

test('runSpotToPerps: explicit amount over available is capped to available, never sent as-is', async () => {
  // HL will reject an over-balance request. Capping is the safety net so
  // an out-of-date UI balance can't burn a nonce.
  clearLocks()
  let movedAmount: number | null = null
  const deps = makeDeps({
    getSpotUsdcBalance: async () => 40,
    transferSpotPerp: async (_pk, amount) => { movedAmount = amount; return { success: true } },
  })
  const result = await runSpotToPerps({
    user: { id: 'user_1' }, rawAmount: 1000, deps,
  })
  assert.equal(result.status, 200)
  assert.equal(movedAmount, 40, 'capped to available, never the requested 1000')
  assert.equal(result.body.amount, 40)
})

// ── Defensive: malformed amount input ───────────────────────────────────
test('runSpotToPerps: non-numeric amount is rejected with 400 before any HL call', async () => {
  clearLocks()
  let transferCalled = false
  const deps = makeDeps({
    transferSpotPerp: async () => { transferCalled = true; return { success: true } },
  })
  const result = await runSpotToPerps({
    user: { id: 'user_1' },
    rawAmount: 'abc',
    deps,
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.success, false)
  assert.equal(transferCalled, false, 'never call HL on a malformed input')
})

// ── transferSpotPerp HL rejection bubbles up ────────────────────────────
test('runSpotToPerps: transferSpotPerp failure → 502 with HL error message', async () => {
  clearLocks()
  const deps = makeDeps({
    transferSpotPerp: async () => ({ success: false, error: 'insufficient margin' }),
  })
  const result = await runSpotToPerps({
    user: { id: 'user_1' }, rawAmount: 10, deps,
  })
  assert.equal(result.status, 502)
  assert.equal(result.body.success, false)
  assert.equal(result.body.error, 'insufficient margin')
  assert.equal(HL_SPOT_TRANSFER_LOCKS.has('user_1'), false, 'lock released on HL failure')
})

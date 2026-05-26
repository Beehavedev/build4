import { test } from 'node:test'
import assert from 'node:assert'

import { TRIAL_DAYS, PERIOD_DAYS, PRICE_USD, isEnforced } from './subscriptions'

// These tests verify the pure config + branching surface of the
// subscription service. Integration tests against a real DB live in
// the deployment smoke harness (not in CI to keep tests offline-safe).

test('subscriptions: constants resolve to sane defaults', () => {
  assert.equal(TRIAL_DAYS, parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS ?? '4', 10))
  assert.equal(PERIOD_DAYS, parseInt(process.env.SUBSCRIPTION_PERIOD_DAYS ?? '30', 10))
  assert.equal(PRICE_USD, parseFloat(process.env.SUBSCRIPTION_PRICE_USD ?? '19.99'))
  assert.ok(TRIAL_DAYS > 0 && TRIAL_DAYS <= 30, 'trial days should be a small positive int')
  assert.ok(PERIOD_DAYS >= 28 && PERIOD_DAYS <= 365, 'period days should be a reasonable month length')
  assert.ok(PRICE_USD > 0 && PRICE_USD < 10_000, 'price should be a sensible USD figure')
})

test('subscriptions: isEnforced is fail-OFF by default and only "true" enables', () => {
  const prev = process.env.SUBSCRIPTION_ENFORCED
  try {
    delete process.env.SUBSCRIPTION_ENFORCED
    assert.equal(isEnforced(), false, 'unset env must NOT enforce')

    process.env.SUBSCRIPTION_ENFORCED = ''
    assert.equal(isEnforced(), false, 'empty env must NOT enforce')

    process.env.SUBSCRIPTION_ENFORCED = '1'
    assert.equal(isEnforced(), false, 'numeric 1 must NOT enforce (must be the string "true")')

    process.env.SUBSCRIPTION_ENFORCED = 'yes'
    assert.equal(isEnforced(), false, 'yes must NOT enforce')

    process.env.SUBSCRIPTION_ENFORCED = 'true'
    assert.equal(isEnforced(), true, 'literal "true" enables enforcement')

    process.env.SUBSCRIPTION_ENFORCED = 'TRUE'
    assert.equal(isEnforced(), true, 'TRUE (case-insensitive) enables enforcement')

    process.env.SUBSCRIPTION_ENFORCED = '  true  '
    assert.equal(isEnforced(), true, 'whitespace is trimmed')
  } finally {
    if (prev === undefined) delete process.env.SUBSCRIPTION_ENFORCED
    else process.env.SUBSCRIPTION_ENFORCED = prev
  }
})

test('subscriptions: treasury fallback chain is documented and well-formed', async () => {
  const { treasuryFor } = await import('./subscriptionPayment')
  const prevBsc = process.env.SUBSCRIPTION_TREASURY_BSC
  const prevBase = process.env.SUBSCRIPTION_TREASURY_BASE
  const prevFb = process.env.BROKER_FEE_WALLET
  try {
    delete process.env.SUBSCRIPTION_TREASURY_BSC
    delete process.env.SUBSCRIPTION_TREASURY_BASE
    delete process.env.BROKER_FEE_WALLET
    const noFallback = treasuryFor('bsc')
    assert.equal(noFallback.ok, false, 'fail-closed when no treasury set anywhere')

    process.env.BROKER_FEE_WALLET = '0x35fC1c7dD2e8cAb489DCd77C096557128d610366'
    const fallback = treasuryFor('bsc')
    assert.equal(fallback.ok, true, 'falls back to BROKER_FEE_WALLET')
    if (fallback.ok) assert.equal(fallback.address, '0x35fC1c7dD2e8cAb489DCd77C096557128d610366')

    process.env.SUBSCRIPTION_TREASURY_BASE = 'not-an-address'
    const malformed = treasuryFor('base')
    assert.equal(malformed.ok, false, 'malformed env must fail-closed, not fall back silently')

    process.env.SUBSCRIPTION_TREASURY_BSC = '0x0000000000000000000000000000000000000001'
    const explicit = treasuryFor('bsc')
    assert.equal(explicit.ok, true)
    if (explicit.ok) assert.equal(explicit.address, '0x0000000000000000000000000000000000000001')
  } finally {
    if (prevBsc === undefined) delete process.env.SUBSCRIPTION_TREASURY_BSC
    else process.env.SUBSCRIPTION_TREASURY_BSC = prevBsc
    if (prevBase === undefined) delete process.env.SUBSCRIPTION_TREASURY_BASE
    else process.env.SUBSCRIPTION_TREASURY_BASE = prevBase
    if (prevFb === undefined) delete process.env.BROKER_FEE_WALLET
    else process.env.BROKER_FEE_WALLET = prevFb
  }
})

test('subscriptions: verifier rejects malformed txhash before any RPC call', async () => {
  const { verifySubscriptionPayment } = await import('./subscriptionPayment')
  const r = await verifySubscriptionPayment({
    chain: 'bsc',
    txHash: 'not-a-hash',
    expectedAmountSmallest: 19_990_000_000_000_000_000n,
  })
  assert.equal(r.ok, false)
  assert.match(r.reason || '', /malformed/)
})

test('subscriptions: verifier fail-closes when Base RPC unconfigured', async () => {
  const { verifySubscriptionPayment } = await import('./subscriptionPayment')
  const prevRpc = process.env.BASE_RPC_URL
  const prevTreasury = process.env.SUBSCRIPTION_TREASURY_BASE
  try {
    delete process.env.BASE_RPC_URL
    process.env.SUBSCRIPTION_TREASURY_BASE = '0x0000000000000000000000000000000000000001'
    const r = await verifySubscriptionPayment({
      chain: 'base',
      txHash: '0x' + 'a'.repeat(64),
      expectedAmountSmallest: 19_990_000n,
    })
    assert.equal(r.ok, false)
    assert.match(r.reason || '', /base_rpc_unconfigured/)
  } finally {
    if (prevRpc === undefined) delete process.env.BASE_RPC_URL
    else process.env.BASE_RPC_URL = prevRpc
    if (prevTreasury === undefined) delete process.env.SUBSCRIPTION_TREASURY_BASE
    else process.env.SUBSCRIPTION_TREASURY_BASE = prevTreasury
  }
})

test('subscriptions: generateIntentAmount produces unique amounts that defend against claim-hijack', async () => {
  const { generateIntentAmount, PRICE_USD } = await import('./subscriptions')

  // BSC: 18 decimals, nonce in [1, 1e9). Base amount = 19.99 * 1e18.
  const bscBase = BigInt(Math.round(PRICE_USD * 1e6)) * 10n ** 12n
  const bsc = generateIntentAmount('bsc')
  assert.equal(bsc.decimals, 18)
  assert.ok(bsc.amountSmallest > bscBase, 'BSC amount must be strictly greater than the round base price')
  assert.ok(bsc.amountSmallest < bscBase + 1_000_000_000n, 'BSC nonce must stay well under 1 cent of token')

  // Base: 6 decimals, nonce in [1, 10000).
  const baseBase = BigInt(Math.round(PRICE_USD * 1e6))
  const base = generateIntentAmount('base')
  assert.equal(base.decimals, 6)
  assert.ok(base.amountSmallest > baseBase, 'Base amount must be strictly greater than the round base price')
  assert.ok(base.amountSmallest < baseBase + 10_000n, 'Base nonce must stay under $0.01')

  // Uniqueness: 100 BSC intents should produce >= 99 unique values (collision odds
  // are 1 in 1e9 per pair, so collisions in 100 draws are vanishingly rare).
  const seen = new Set<string>()
  for (let i = 0; i < 100; i++) seen.add(generateIntentAmount('bsc').amountSmallest.toString())
  assert.ok(seen.size >= 99, `100 BSC intents produced only ${seen.size} unique amounts`)
})

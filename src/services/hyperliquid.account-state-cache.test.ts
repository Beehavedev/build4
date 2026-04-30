import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetHlAccountStateCacheForTests,
  __primeHlAccountStateCacheForTests,
  __peekHlAccountStateCacheForTests,
} from './hyperliquid'

// ── Why this test file exists ───────────────────────────────────────────────
// Production prod April 2026 bug: the HL wallet card on the dashboard, and
// the activate / "$0 on Hyperliquid" panel on the trade screen, both visibly
// flickered between LIVE and "not activated" every few seconds. Root cause:
// `getAccountState()` swallowed every error (including transient HL `/info`
// 429s — Render gives the server a single shared egress IP, so HL's per-IP
// rate limit kicks in even with a single end-user) and converted them into
// `{ accountValue: 0, onboarded: false, positions: [] }`. The frontend had
// no way to tell that response apart from "user has never funded an HL
// account", so the card downgraded itself.
//
// The fix replaces the false-zeros fallback with a per-user "last good"
// in-memory snapshot served on error. These tests cover the cache wiring
// directly via the test-only accessors so we don't have to mock the HL
// SDK transport.

const ADDR = '0xAbC0000000000000000000000000000000000001'

const SNAPSHOT = {
  withdrawableUsdc: 12.34,
  accountValue:     56.78,
  onboarded:        true,
  positions:        [{ coin: 'BTC', szi: 0.01 }],
  abstraction:      null as 'unifiedAccount' | 'portfolioMargin' | 'disabled' | null,
}

test('account-state cache: prime + peek round-trips the snapshot', () => {
  __resetHlAccountStateCacheForTests()
  __primeHlAccountStateCacheForTests(ADDR, SNAPSHOT)
  const got = __peekHlAccountStateCacheForTests(ADDR)
  assert.ok(got, 'expected primed snapshot to be retrievable')
  assert.equal(got!.onboarded, true)
  assert.equal(got!.accountValue, 56.78)
  assert.equal(got!.withdrawableUsdc, 12.34)
})

test('account-state cache: lookup is case-insensitive on the address', () => {
  // The catch block in getAccountState() lowercases userAddress before
  // looking up the cache, but the wallet endpoint passes through whatever
  // the wallet table holds — which is mixed-case checksummed. If the
  // cache key wasn't normalised on both ends, a successful read with the
  // checksummed form would never match a stale lookup with the same
  // checksummed form (because Map uses strict string equality), and the
  // bug would re-appear silently.
  __resetHlAccountStateCacheForTests()
  __primeHlAccountStateCacheForTests(ADDR.toLowerCase(), SNAPSHOT)
  const upperLookup = __peekHlAccountStateCacheForTests(ADDR.toUpperCase())
  const mixedLookup = __peekHlAccountStateCacheForTests(ADDR)
  assert.ok(upperLookup, 'uppercase lookup must hit the lowercased cache')
  assert.ok(mixedLookup, 'checksummed lookup must hit the lowercased cache')
  assert.equal(upperLookup!.onboarded, true)
  assert.equal(mixedLookup!.onboarded, true)
})

test('account-state cache: reset clears all entries', () => {
  __primeHlAccountStateCacheForTests(ADDR, SNAPSHOT)
  __resetHlAccountStateCacheForTests()
  assert.equal(__peekHlAccountStateCacheForTests(ADDR), undefined)
})

test('account-state cache: distinct addresses get distinct snapshots', () => {
  __resetHlAccountStateCacheForTests()
  const otherAddr  = '0xDef0000000000000000000000000000000000002'
  const otherShape = { ...SNAPSHOT, accountValue: 999.99, onboarded: false }
  __primeHlAccountStateCacheForTests(ADDR,       SNAPSHOT)
  __primeHlAccountStateCacheForTests(otherAddr,  otherShape)
  assert.equal(__peekHlAccountStateCacheForTests(ADDR)!.accountValue,      56.78)
  assert.equal(__peekHlAccountStateCacheForTests(otherAddr)!.accountValue, 999.99)
  assert.equal(__peekHlAccountStateCacheForTests(otherAddr)!.onboarded,    false)
})

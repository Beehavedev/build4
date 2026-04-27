import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVE_AGENTS_FILTER } from './runner'

// ─────────────────────────────────────────────────────────────────────────────
// Regression-guard tests for the runner's active-agents Prisma filter.
//
// The shape of this filter directly controls who pays for an LLM call every
// minute. Tightening it (e.g. back to `asterOnboarded: true` only) silently
// stops every Hyperliquid agent from ticking. Loosening it (e.g. dropping
// the OR entirely) wakes up users who never deposited and burns ~$200k/day
// in LLM credits at scale.
//
// These tests don't hit Prisma — they assert the literal shape so any
// change to who-gets-ticked is caught at unit-test time.
// ─────────────────────────────────────────────────────────────────────────────

test('ACTIVE_AGENTS_FILTER restricts to active+unpaused agents', () => {
  assert.equal(ACTIVE_AGENTS_FILTER.isActive, true)
  assert.equal(ACTIVE_AGENTS_FILTER.isPaused, false)
})

test('ACTIVE_AGENTS_FILTER includes both Aster and Hyperliquid onboarding', () => {
  const orClause = (ACTIVE_AGENTS_FILTER.user as any).OR as Array<Record<string, unknown>>
  assert.equal(Array.isArray(orClause), true, 'user filter must be an OR array (not a single venue)')
  assert.equal(orClause.length, 2, 'OR must list exactly two venues today (Aster + Hyperliquid)')

  const venues = new Set(orClause.flatMap(c => Object.keys(c)))
  assert.ok(venues.has('asterOnboarded'),       'Aster-onboarded users must be included')
  assert.ok(venues.has('hyperliquidOnboarded'), 'Hyperliquid-onboarded users must be included')
})

test('ACTIVE_AGENTS_FILTER does not match users with neither onboarding flag', () => {
  // Pure shape check — every leaf of the OR demands `true`. A user with
  // both flags false (or null/undefined, which Prisma treats as not equal
  // to `true`) won't match either branch.
  const orClause = (ACTIVE_AGENTS_FILTER.user as any).OR as Array<Record<string, unknown>>
  for (const branch of orClause) {
    const values = Object.values(branch)
    for (const v of values) {
      assert.equal(v, true, 'every onboarding-OR branch must require strict `true` (not truthy)')
    }
  }
})

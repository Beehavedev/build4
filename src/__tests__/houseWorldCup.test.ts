import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isGoalDifferentialMarket,
  parseGdMarket,
  winOrDrawBasketIndices,
  allocateBasket,
  basketImpliedProb,
  halftimeCutoffMs,
  tradingWindowOpen,
  oddsStopTriggered,
  aggregateTeamVotes,
  looksLikeGdMarketMeta,
  looksLikeWorldCupMarket,
  type TeamSwarmVote,
} from '../agents/houseWorldCup'
import type { Market42 } from '../services/fortyTwo'

// A canonical two-team goal-differential grid (MEX vs KOR), Draw in the middle.
const GD_LABELS = [
  'MEX by 3+', // 0
  'MEX by 2',  // 1
  'MEX by 1',  // 2
  'Draw',      // 3
  'KOR by 1',  // 4
  'KOR by 2',  // 5
  'KOR by 3+', // 6
]

function outcome(index: number, impliedProbability: number) {
  return { index, tokenId: 2 ** index, impliedProbability }
}

// ── isGoalDifferentialMarket / parseGdMarket ──────────────────────────────

test('isGoalDifferentialMarket accepts a clean two-team GD grid', () => {
  assert.equal(isGoalDifferentialMarket(GD_LABELS), true)
})

test('isGoalDifferentialMarket rejects non-GD grids', () => {
  assert.equal(isGoalDifferentialMarket(['Yes', 'No']), false)
  assert.equal(isGoalDifferentialMarket(['MEX by 1', 'KOR by 1']), false) // no Draw
  assert.equal(isGoalDifferentialMarket(['MEX by 1', 'Draw', 'Draw', 'KOR by 1']), false) // two Draws
  assert.equal(isGoalDifferentialMarket(['MEX by 1', 'Draw', 'KOR wins']), false) // bad pattern
  assert.equal(isGoalDifferentialMarket([]), false)
})

test('isGoalDifferentialMarket rejects three-team GD-shaped grids', () => {
  // Three distinct teams must NOT parse as a two-team match.
  const threeTeam = ['A by 1', 'Draw', 'B by 1', 'C by 1']
  assert.equal(isGoalDifferentialMarket(threeTeam), false)
})

test('parseGdMarket extracts drawIndex and two teams with their indices', () => {
  const parsed = parseGdMarket(GD_LABELS)
  assert.ok(parsed)
  assert.equal(parsed!.drawIndex, 3)
  assert.equal(parsed!.teams.length, 2)
  const mex = parsed!.teams.find((t) => t.name === 'MEX')!
  const kor = parsed!.teams.find((t) => t.name === 'KOR')!
  assert.deepEqual(mex.indices, [0, 1, 2])
  assert.deepEqual(kor.indices, [4, 5, 6])
})

test('parseGdMarket returns null on malformed grids', () => {
  assert.equal(parseGdMarket(['Yes', 'No', 'Maybe']), null)
  assert.equal(parseGdMarket(['MEX by 1', 'Draw', 'Draw', 'KOR by 1']), null)
})

// ── winOrDrawBasketIndices ────────────────────────────────────────────────

test('winOrDrawBasketIndices = team buckets ∪ Draw, sorted', () => {
  const parsed = parseGdMarket(GD_LABELS)!
  assert.deepEqual(winOrDrawBasketIndices(parsed, 'MEX'), [0, 1, 2, 3])
  assert.deepEqual(winOrDrawBasketIndices(parsed, 'KOR'), [3, 4, 5, 6])
})

test('winOrDrawBasketIndices is case-insensitive and null on unknown team', () => {
  const parsed = parseGdMarket(GD_LABELS)!
  assert.deepEqual(winOrDrawBasketIndices(parsed, 'mex'), [0, 1, 2, 3])
  assert.equal(winOrDrawBasketIndices(parsed, 'BRA'), null)
})

// ── allocateBasket ────────────────────────────────────────────────────────

test('allocateBasket splits ∝ price and deploys the full budget', () => {
  const outcomes = [outcome(0, 0.1), outcome(1, 0.2), outcome(2, 0.3), outcome(3, 0.4)]
  const legs = allocateBasket(outcomes, [0, 1, 2, 3], 50)
  const total = legs.reduce((s, l) => s + l.usdt, 0)
  // Full budget deployed (within rounding) across all 4 legs.
  assert.ok(Math.abs(total - 50) < 0.05, `total=${total}`)
  assert.equal(legs.length, 4)
  // Higher-priced legs get more stake.
  const byIdx = new Map(legs.map((l) => [l.index, l.usdt]))
  assert.ok(byIdx.get(3)! > byIdx.get(0)!)
  // tokenId carried through.
  assert.equal(legs.find((l) => l.index === 2)!.tokenId, 4)
})

test('allocateBasket falls back to an equal split when no prices', () => {
  const outcomes = [outcome(0, 0), outcome(1, 0), outcome(3, 0)]
  const legs = allocateBasket(outcomes, [0, 1, 3], 60)
  assert.equal(legs.length, 3)
  for (const l of legs) assert.ok(Math.abs(l.usdt - 20) < 0.05)
})

test('allocateBasket drops sub-$1 dust legs and re-normalises', () => {
  // Leg 0 would get a tiny share; it should be dropped and the rest scaled up.
  const outcomes = [outcome(0, 0.001), outcome(1, 0.5), outcome(2, 0.499)]
  const legs = allocateBasket(outcomes, [0, 1, 2], 50)
  assert.ok(!legs.some((l) => l.index === 0), 'dust leg should be dropped')
  const total = legs.reduce((s, l) => s + l.usdt, 0)
  assert.ok(Math.abs(total - 50) < 0.05, `total=${total}`)
})

test('allocateBasket returns [] on empty inputs or zero budget', () => {
  assert.deepEqual(allocateBasket([], [0, 1], 50), [])
  assert.deepEqual(allocateBasket([outcome(0, 0.5)], [0], 0), [])
})

// ── basketImpliedProb ─────────────────────────────────────────────────────

test('basketImpliedProb sums covered leg probabilities', () => {
  const outcomes = [outcome(0, 0.1), outcome(1, 0.2), outcome(2, 0.3), outcome(3, 0.4)]
  assert.ok(Math.abs(basketImpliedProb(outcomes, [0, 3]) - 0.5) < 1e-9)
  assert.equal(basketImpliedProb(outcomes, []), 0)
})

// ── timing helpers ────────────────────────────────────────────────────────

test('halftimeCutoffMs subtracts beforeEndMin from full-time', () => {
  const ftSec = 1_000_000 // arbitrary epoch seconds
  assert.equal(halftimeCutoffMs(ftSec, 60), ftSec * 1000 - 60 * 60_000)
})

test('tradingWindowOpen is true before the cutoff and false after', () => {
  const ftSec = 2_000_000
  const cutoff = halftimeCutoffMs(ftSec, 60)
  assert.equal(tradingWindowOpen(cutoff - 1, ftSec, 60), true)
  assert.equal(tradingWindowOpen(cutoff + 1, ftSec, 60), false)
  // Invalid settlement time fails closed.
  assert.equal(tradingWindowOpen(Date.now(), 0, 60), false)
})

// ── oddsStopTriggered ─────────────────────────────────────────────────────

test('oddsStopTriggered fires only on a sufficient relative drop', () => {
  // Entry 0.6 → current 0.45 = 25% drop.
  assert.equal(oddsStopTriggered(0.6, 0.45, 20), true)
  assert.equal(oddsStopTriggered(0.6, 0.45, 30), false)
  // Disabled when dropPct <= 0.
  assert.equal(oddsStopTriggered(0.6, 0.1, 0), false)
  // No entry baseline → never triggers.
  assert.equal(oddsStopTriggered(0, 0.1, 10), false)
})

// ── aggregateTeamVotes (fail-closed) ──────────────────────────────────────

function vote(team: string | null, conviction: number, parsed = true): TeamSwarmVote {
  return {
    provider: 'xai' as any,
    model: 'test',
    team,
    conviction,
    thesis: team ? `back ${team}` : '',
    parsed,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
}

const TEAMS = ['MEX', 'KOR']

test('aggregateTeamVotes: single-provider swarm trades on the one parsed vote', () => {
  const d = aggregateTeamVotes([vote('MEX', 80)], TEAMS, 1)
  assert.equal(d.team, 'MEX')
  assert.equal(d.avgConviction, 80)
})

test('aggregateTeamVotes: single-provider swarm fails closed when the vote is unparsed', () => {
  const d = aggregateTeamVotes([vote(null, 0, false)], TEAMS, 1)
  assert.equal(d.team, null)
})

test('aggregateTeamVotes: 4-provider majority wins', () => {
  const votes = [vote('MEX', 70), vote('MEX', 80), vote('MEX', 60), vote('KOR', 90)]
  const d = aggregateTeamVotes(votes, TEAMS, 4)
  assert.equal(d.team, 'MEX')
  assert.equal(d.avgConviction, 70) // (70+80+60)/3
})

test('aggregateTeamVotes: split 2-2 fails closed (no consensus)', () => {
  const votes = [vote('MEX', 70), vote('MEX', 80), vote('KOR', 75), vote('KOR', 85)]
  const d = aggregateTeamVotes(votes, TEAMS, 4)
  assert.equal(d.team, null)
})

test('aggregateTeamVotes: too few parsed votes fails closed', () => {
  const votes = [vote('MEX', 70), vote(null, 0, false), vote(null, 0, false), vote(null, 0, false)]
  const d = aggregateTeamVotes(votes, TEAMS, 4)
  assert.equal(d.team, null)
})

test('aggregateTeamVotes: votes for off-grid teams are discarded', () => {
  const votes = [vote('BRA', 99), vote('MEX', 65), vote('MEX', 70)]
  const d = aggregateTeamVotes(votes, TEAMS, 3)
  assert.equal(d.team, 'MEX')
})

test('aggregateTeamVotes: team matching is case-insensitive and canonicalised', () => {
  const votes = [vote('mex', 60), vote('MEX', 80), vote('KOR', 70)]
  const d = aggregateTeamVotes(votes, TEAMS, 3)
  assert.equal(d.team, 'MEX') // canonical casing from teamNames
})

// ── looksLikeGdMarketMeta ─────────────────────────────────────────────────

function market(partial: Partial<Market42>): Market42 {
  return {
    address: '0x0000000000000000000000000000000000000001',
    question: 'MEX vs KOR',
    slug: 'mex-vs-kor',
    status: 'live',
    contractVersion: 2,
    curve: '0x0',
    collateralDecimals: 18,
    ...partial,
  } as Market42
}

test('looksLikeGdMarketMeta matches the configured tag in any taxonomy field', () => {
  assert.equal(looksLikeGdMarketMeta(market({ tags: ['soccer_match_gd'] })), true)
  assert.equal(looksLikeGdMarketMeta(market({ categories: ['Soccer_Match_GD'] })), true)
  assert.equal(looksLikeGdMarketMeta(market({ topics: ['soccer_match_gd'] })), true)
})

test('looksLikeGdMarketMeta falls back to _gd suffix and slug heuristics', () => {
  assert.equal(looksLikeGdMarketMeta(market({ tags: ['something_gd'] })), true)
  assert.equal(looksLikeGdMarketMeta(market({ tags: [], slug: 'mex-kor-gd' })), true)
})

test('looksLikeGdMarketMeta rejects unrelated markets', () => {
  assert.equal(looksLikeGdMarketMeta(market({ tags: ['price'], topics: ['bitcoin'], slug: 'btc-price' })), false)
})

// ── looksLikeWorldCupMarket (scope guard) ─────────────────────────────────

test('looksLikeWorldCupMarket matches FIFA World Cup in question/slug/taxonomy', () => {
  delete process.env.HOUSE_WC_SCOPE_ANY_SOCCER
  delete process.env.HOUSE_WC_COMPETITION
  assert.equal(looksLikeWorldCupMarket(market({ question: 'World Cup: MEX vs KOR — goal diff' })), true)
  assert.equal(looksLikeWorldCupMarket(market({ question: 'MEX vs KOR', slug: 'fifa-mex-kor-gd' })), true)
  assert.equal(looksLikeWorldCupMarket(market({ question: 'MEX vs KOR', tags: ['FIFA World Cup'] })), true)
})

test('looksLikeWorldCupMarket rejects non-WC soccer GD markets', () => {
  delete process.env.HOUSE_WC_SCOPE_ANY_SOCCER
  delete process.env.HOUSE_WC_COMPETITION
  assert.equal(
    looksLikeWorldCupMarket(market({ question: 'Premier League: ARS vs CHE', slug: 'epl-ars-che-gd', tags: ['soccer_match_gd'] })),
    false,
  )
})

test('looksLikeWorldCupMarket honours the HOUSE_WC_SCOPE_ANY_SOCCER escape hatch', () => {
  process.env.HOUSE_WC_SCOPE_ANY_SOCCER = 'true'
  try {
    assert.equal(looksLikeWorldCupMarket(market({ question: 'Some random GD match' })), true)
  } finally {
    delete process.env.HOUSE_WC_SCOPE_ANY_SOCCER
  }
})

test('looksLikeWorldCupMarket honours a HOUSE_WC_COMPETITION override', () => {
  delete process.env.HOUSE_WC_SCOPE_ANY_SOCCER
  process.env.HOUSE_WC_COMPETITION = 'copa america,euros'
  try {
    assert.equal(looksLikeWorldCupMarket(market({ question: 'Copa America: ARG vs BRA' })), true)
    assert.equal(looksLikeWorldCupMarket(market({ question: 'World Cup: MEX vs KOR' })), false)
  } finally {
    delete process.env.HOUSE_WC_COMPETITION
  }
})

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
  looksLikeGdMarketMeta,
  looksLikeWorldCupMarket,
  __testInternals,
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

// ── deriveMatchSearchTerms (X chatter query) ──────────────────────────────

test('deriveMatchSearchTerms: builds per-match X search terms from both teams', () => {
  const terms = __testInternals.deriveMatchSearchTerms({ question: 'MEX vs KOR?' } as any, ['MEX', 'KOR'])
  assert.deepEqual(terms, ['MEX KOR', 'MEX vs KOR', 'MEX World Cup', 'KOR World Cup'])
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

// ── Conviction-tier sizing ─────────────────────────────────────────────────

test('sizeForConviction scales the per-match cap by conviction tier', () => {
  const cap = 50
  assert.equal(__testInternals.sizeForConviction(85, cap), 50)   // ≥80 → full cap
  assert.equal(__testInternals.sizeForConviction(80, cap), 50)
  assert.equal(__testInternals.sizeForConviction(70, cap), 37.5) // ≥65 → 0.75
  assert.equal(__testInternals.sizeForConviction(65, cap), 37.5)
  assert.equal(__testInternals.sizeForConviction(55, cap), 25)   // ≥50 → 0.5
  assert.equal(__testInternals.sizeForConviction(40, cap), 15)   // else → 0.3
})

test('sizeForConviction clamps to [MIN_LEG_USD, cap] and tolerates junk', () => {
  // 0.3 * 2 = 0.6 < $1 floor → clamps up to 1
  assert.equal(__testInternals.sizeForConviction(10, 2), 1)
  // conviction out of range is clamped, NaN treated as 0 (lowest tier)
  assert.equal(__testInternals.sizeForConviction(999, 50), 50)
  assert.equal(__testInternals.sizeForConviction(NaN, 50), 15)
  assert.equal(__testInternals.sizeForConviction(-5, 50), 15)
})

// ── In-play reassessment decision (ON-CHAIN ODDS ONLY) ─────────────────────

test('reassessAction: odds-stop always forces a sell', () => {
  const r = __testInternals.reassessAction({ currentProb: 0.9, spentUsd: 10, capUsd: 50, oddsStop: true })
  assert.equal(r.action, 'sell')
  assert.equal(r.addUsd, 0)
})

test('reassessAction: rising on-chain odds top up toward the live target', () => {
  // currentProb 0.85 → score 85 → target = full cap 50; spent 15 → add 35
  const r = __testInternals.reassessAction({ currentProb: 0.85, spentUsd: 15, capUsd: 50, oddsStop: false })
  assert.equal(r.action, 'add')
  assert.equal(r.addUsd, 35)
})

test('reassessAction: already at/above the live target holds (never exceeds cap)', () => {
  // currentProb 0.55 → score 55 → target 25; already spent 25 → no add
  const r = __testInternals.reassessAction({ currentProb: 0.55, spentUsd: 25, capUsd: 50, oddsStop: false })
  assert.equal(r.action, 'hold')
  assert.equal(r.addUsd, 0)
})

test('reassessAction: add is capped by remaining headroom under the per-match cap', () => {
  // currentProb 0.85 → target 50, but only $3 headroom left
  const r = __testInternals.reassessAction({ currentProb: 0.85, spentUsd: 47, capUsd: 50, oddsStop: false })
  assert.equal(r.action, 'add')
  assert.equal(r.addUsd, 3)
})

test('reassessAction: softening odds below the funded tier just hold (no live external flip/exit)', () => {
  // currentProb 0.40 → score 40 → low tier target 15; spent 20 already past it → hold, never sells on sentiment
  const r = __testInternals.reassessAction({ currentProb: 0.40, spentUsd: 20, capUsd: 50, oddsStop: false })
  assert.equal(r.action, 'hold')
  assert.equal(r.addUsd, 0)
})

// ── parseTeamReply: tolerate prose-wrapped JSON from open-weight models ─────

const PT_TEAMS = ['Mexico', 'South Korea']

test('parseTeamReply: clean JSON object parses', () => {
  const r = __testInternals.parseTeamReply('{"team":"Mexico","conviction":72,"thesis":"home form"}', PT_TEAMS)
  assert.deepEqual(r, { team: 'Mexico', conviction: 72, thesis: 'home form' })
})

test('parseTeamReply: JSON wrapped in ```json fences parses', () => {
  const r = __testInternals.parseTeamReply('```json\n{"team":"South Korea","conviction":40,"thesis":"counter"}\n```', PT_TEAMS)
  assert.equal(r?.team, 'South Korea')
  assert.equal(r?.conviction, 40)
})

test('parseTeamReply: JSON embedded in leading + trailing prose still parses', () => {
  const raw = 'Sure! Here is my pick: {"team":"Mexico","conviction":61,"thesis":"better xG"} — hope that helps!'
  const r = __testInternals.parseTeamReply(raw, PT_TEAMS)
  assert.equal(r?.team, 'Mexico')
  assert.equal(r?.conviction, 61)
})

test('parseTeamReply: object with nested braces in thesis is captured whole', () => {
  const raw = 'Pick below.\n{"team":"South Korea","conviction":55,"thesis":"set-piece edge {corners}"}\nThanks.'
  const r = __testInternals.parseTeamReply(raw, PT_TEAMS)
  assert.equal(r?.team, 'South Korea')
  assert.equal(r?.thesis, 'set-piece edge {corners}')
})

test('parseTeamReply: prose with no JSON object returns null (fail-closed)', () => {
  assert.equal(__testInternals.parseTeamReply('I think Mexico will win comfortably.', PT_TEAMS), null)
})

test('parseTeamReply: out-of-range conviction is rejected', () => {
  assert.equal(__testInternals.parseTeamReply('{"team":"Mexico","conviction":150,"thesis":"x"}', PT_TEAMS), null)
})

test('parseTeamReply: unknown team name resolves to null team (no false bet)', () => {
  const r = __testInternals.parseTeamReply('{"team":"Brazil","conviction":80,"thesis":"x"}', PT_TEAMS)
  assert.equal(r?.team, null)
})

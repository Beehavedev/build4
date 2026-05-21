import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTopazDecision, __test } from './topazAgent'

const baseAgent = {
  id: 'agent-1', userId: 'u-1', name: 'A',
  topazEnabled: true, topazMaxSizeUsdt: 50,
  lastTopazTickAt: null, enabledVenues: ['topaz'],
}

test('parseTopazDecision: returns null for garbage', () => {
  assert.equal(parseTopazDecision(''), null)
  assert.equal(parseTopazDecision('not json'), null)
  assert.equal(parseTopazDecision('{"action":"FOO","conviction":0.5}'), null)
})

test('parseTopazDecision: rejects out-of-range conviction', () => {
  assert.equal(
    parseTopazDecision('{"action":"SKIP","conviction":1.5,"reasoning":"x"}'),
    null,
  )
  assert.equal(
    parseTopazDecision('{"action":"SKIP","conviction":-0.1,"reasoning":"x"}'),
    null,
  )
})

test('parseTopazDecision: accepts all five valid actions', () => {
  for (const action of ['SKIP', 'SWAP', 'OPEN_LP', 'CLOSE_LP', 'CLAIM']) {
    const d = parseTopazDecision(
      `{"action":"${action}","pool":null,"tokenIn":null,"tokenOut":null,"amountUsdt":0,"tickLower":null,"tickUpper":null,"conviction":0.7,"reasoning":"r"}`,
    )
    assert.ok(d, `should parse ${action}`)
    assert.equal(d!.action, action)
  }
})

test('parseTopazDecision: strips ```json code fences', () => {
  const raw = '```json\n{"action":"SKIP","conviction":0.5,"reasoning":"hold"}\n```'
  const d = parseTopazDecision(raw)
  assert.ok(d)
  assert.equal(d!.action, 'SKIP')
})

test('parseTopazDecision: clamps reasoning to 280 chars', () => {
  const long = 'x'.repeat(500)
  const d = parseTopazDecision(
    `{"action":"SKIP","conviction":0.5,"reasoning":"${long}"}`,
  )
  assert.ok(d)
  assert.equal(d!.reasoning.length, 280)
})

test('risk guard: SKIP always passes regardless of conviction/size', async () => {
  const r = await __test.checkTopazRiskGuard(
    baseAgent,
    { action: 'SKIP', pool: null, tokenIn: null, tokenOut: null, amountUsdt: 999, tickLower: null, tickUpper: null, conviction: 0, reasoning: '' },
    50,
  )
  assert.equal(r.ok, true)
})

test('risk guard: OPEN_LP rejected when conviction below 0.55 floor', async () => {
  const r = await __test.checkTopazRiskGuard(
    baseAgent,
    { action: 'OPEN_LP', pool: '0x' + 'aa'.repeat(20), tokenIn: null, tokenOut: null, amountUsdt: 10, tickLower: 0, tickUpper: 10, conviction: 0.5, reasoning: '' },
    50,
  )
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /low_conviction/)
})

test('risk guard: OPEN_LP rejected when amount exceeds per-trade cap', async () => {
  const r = await __test.checkTopazRiskGuard(
    baseAgent,
    { action: 'OPEN_LP', pool: '0x' + 'aa'.repeat(20), tokenIn: null, tokenOut: null, amountUsdt: 9999, tickLower: 0, tickUpper: 10, conviction: 0.9, reasoning: '' },
    50,
  )
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /over_max_size/)
})

test('risk guard: CLOSE_LP accepts moderate conviction (defensive exit)', async () => {
  const r = await __test.checkTopazRiskGuard(
    baseAgent,
    { action: 'CLOSE_LP', pool: '0x' + 'aa'.repeat(20), tokenIn: null, tokenOut: null, amountUsdt: 0, tickLower: null, tickUpper: null, conviction: 0.45, reasoning: '' },
    50,
  )
  assert.equal(r.ok, true)
})

test('risk guard: OPEN_LP refuses when amountUsdt <= 0', async () => {
  const r = await __test.checkTopazRiskGuard(
    baseAgent,
    { action: 'OPEN_LP', pool: '0x' + 'aa'.repeat(20), tokenIn: null, tokenOut: null, amountUsdt: 0, tickLower: 0, tickUpper: 10, conviction: 0.9, reasoning: '' },
    50,
  )
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /invalid_amount_usdt/)
})

test('risk guard: OPEN_LP refuses when pool missing', async () => {
  const r = await __test.checkTopazRiskGuard(
    baseAgent,
    { action: 'OPEN_LP', pool: null, tokenIn: null, tokenOut: null, amountUsdt: 10, tickLower: 0, tickUpper: 10, conviction: 0.9, reasoning: '' },
    50,
  )
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /missing_pool/)
})

test('parseTopazDecision: normalizes string fields and numeric amount', () => {
  const d = parseTopazDecision(
    '{"action":"swap","pool":"0xabc","tokenIn":"0xdef","tokenOut":"0xfeed","amountUsdt":"42","tickLower":-100,"tickUpper":100,"conviction":0.8,"reasoning":"ok"}',
  )
  assert.ok(d)
  assert.equal(d!.action, 'SWAP')
  assert.equal(d!.pool, '0xabc')
  assert.equal(d!.amountUsdt, 42)
  assert.equal(d!.tickLower, -100)
  assert.equal(d!.tickUpper, 100)
})

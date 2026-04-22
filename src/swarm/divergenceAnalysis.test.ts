import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSampleProvider } from './divergenceAnalysis'

test('normalizeSampleProvider returns null for non-objects or missing provider', () => {
  assert.equal(normalizeSampleProvider(null), null)
  assert.equal(normalizeSampleProvider({}), null)
  assert.equal(normalizeSampleProvider({ provider: 123 }), null)
})

test('normalizeSampleProvider extracts top-level fields', () => {
  const out = normalizeSampleProvider({
    provider: 'anthropic',
    model: 'claude-3',
    action: 'LONG',
    confidence: 0.8,
    reasoning: 'momentum up',
    latencyMs: 120,
  })
  assert.deepEqual(out, {
    provider: 'anthropic',
    model: 'claude-3',
    action: 'LONG',
    confidence: 0.8,
    reasoning: 'momentum up',
    latencyMs: 120,
  })
})

test('normalizeSampleProvider falls back to predictionTrade for action/confidence', () => {
  const out = normalizeSampleProvider({
    provider: 'openai',
    predictionTrade: { action: 'OPEN_PREDICTION', confidence: 0.42 },
  })
  assert.equal(out?.action, 'OPEN_PREDICTION')
  assert.equal(out?.confidence, 0.42)
  assert.equal(out?.model, null)
  assert.equal(out?.reasoning, null)
  assert.equal(out?.latencyMs, null)
})

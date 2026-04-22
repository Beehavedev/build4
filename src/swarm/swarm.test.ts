import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runSwarmDecision } from './swarm'
import type { CallLLMArgs, CallLLMResult, Provider } from '../services/inference'

interface FakeDecision extends Record<string, unknown> {
  action: string
  reasoning: string
  predictionTrade: { marketAddress: string; tokenId: number; action: string } | null
}

function decision(action: string, prediction?: { market: string; tokenId: number; action?: string }): FakeDecision {
  return {
    action,
    reasoning: `${action} reasoning`,
    predictionTrade: prediction
      ? { marketAddress: prediction.market, tokenId: prediction.tokenId, action: prediction.action ?? 'OPEN_PREDICTION' }
      : null,
  }
}

function scriptedFn(
  responses: Partial<Record<Provider, FakeDecision | { throw: string } | { delayMs: number; decision: FakeDecision }>>,
): (args: CallLLMArgs) => Promise<CallLLMResult> {
  return async (args) => {
    const r = responses[args.provider]
    if (!r) throw new Error(`no scripted response for ${args.provider}`)
    if ('throw' in r) throw new Error(r.throw)
    if ('delayMs' in r) {
      await new Promise((resolve) => setTimeout(resolve, r.delayMs))
      return { text: JSON.stringify(r.decision), model: 'm', provider: args.provider, latencyMs: r.delayMs, inputTokens: 7, outputTokens: 3, tokensUsed: 10 }
    }
    return { text: JSON.stringify(r), model: 'm', provider: args.provider, latencyMs: 5, inputTokens: 7, outputTokens: 3, tokensUsed: 10 }
  }
}

const baseArgs = {
  user: 'analyze BTC',
  schema: (t: string) => JSON.parse(t) as FakeDecision,
  getAction: (d: FakeDecision) => d.action,
  getPredictionKey: (d: FakeDecision) =>
    d.predictionTrade ? `${d.predictionTrade.marketAddress}:${d.predictionTrade.tokenId}:${d.predictionTrade.action}` : null,
}

test('unanimous agreement on action and sidecar', async () => {
  const dec = decision('OPEN_LONG', { market: '0xabc', tokenId: 1 })
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    callLLMFn: scriptedFn({ anthropic: dec, xai: dec, hyperbolic: dec }),
  })
  assert.equal(result.error, null)
  assert.equal(result.divergence.successCount, 3)
  assert.equal(result.divergence.actionConsensus, 'OPEN_LONG')
  assert.equal(result.divergence.predictionConsensus, '0xabc:1:OPEN_PREDICTION')
  assert.ok(result.quorumDecision)
  assert.equal(result.quorumDecision!.action, 'OPEN_LONG')
  assert.deepEqual(result.quorumDecision!.predictionTrade, dec.predictionTrade)
  assert.deepEqual(result.divergence.actionHistogram, { OPEN_LONG: 3 })
})

test('2-of-3 quorum on action, no prediction sidecar', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    callLLMFn: scriptedFn({
      anthropic: decision('OPEN_LONG'),
      xai: decision('OPEN_LONG'),
      hyperbolic: decision('HOLD'),
    }),
  })
  assert.equal(result.divergence.actionConsensus, 'OPEN_LONG')
  assert.equal(result.divergence.predictionConsensus, null)
  assert.ok(result.quorumDecision)
  assert.equal(result.quorumDecision!.action, 'OPEN_LONG')
  assert.equal(result.quorumDecision!.predictionTrade, null)
  assert.deepEqual(result.divergence.actionHistogram, { OPEN_LONG: 2, HOLD: 1 })
})

test('2-of-3 action quorum but disagreement on sidecar nullifies predictionTrade', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    callLLMFn: scriptedFn({
      anthropic: decision('OPEN_LONG', { market: '0xabc', tokenId: 1 }),
      xai: decision('OPEN_LONG', { market: '0xdef', tokenId: 2 }),
      hyperbolic: decision('HOLD'),
    }),
  })
  assert.equal(result.divergence.actionConsensus, 'OPEN_LONG')
  assert.equal(result.divergence.predictionConsensus, null)
  assert.ok(result.quorumDecision)
  assert.equal(result.quorumDecision!.action, 'OPEN_LONG')
  assert.equal(result.quorumDecision!.predictionTrade, null, 'sidecar must be cleared when no prediction quorum')
})

test('total disagreement returns no quorum decision', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    callLLMFn: scriptedFn({
      anthropic: decision('OPEN_LONG'),
      xai: decision('OPEN_SHORT'),
      hyperbolic: decision('HOLD'),
    }),
  })
  assert.equal(result.quorumDecision, null)
  assert.equal(result.divergence.actionConsensus, null)
  assert.equal(result.error, null)
  assert.equal(result.divergence.successCount, 3)
})

test('one provider failing — swarm continues with surviving providers', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    callLLMFn: scriptedFn({
      anthropic: decision('OPEN_LONG'),
      xai: decision('OPEN_LONG'),
      hyperbolic: { throw: 'rate limited' },
    }),
  })
  assert.equal(result.divergence.successCount, 2)
  assert.equal(result.divergence.totalCount, 3)
  assert.equal(result.divergence.actionConsensus, 'OPEN_LONG')
  assert.ok(result.quorumDecision)
  const failed = result.decisions.find((c) => c.provider === 'hyperbolic')!
  assert.equal(failed.ok, false)
  assert.match(failed.error ?? '', /rate limited/)
})

test('all providers fail returns descriptive error and null quorum', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai'],
    callLLMFn: scriptedFn({
      anthropic: { throw: 'down' },
      xai: { throw: 'down' },
    }),
  })
  assert.equal(result.quorumDecision, null)
  assert.equal(result.error, 'all providers failed')
  assert.equal(result.divergence.successCount, 0)
})

test('parse failure on one provider counts as a failed decision', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    callLLMFn: async (args) => {
      if (args.provider === 'hyperbolic') {
        return { text: 'not-json', model: 'm', provider: 'hyperbolic', latencyMs: 5, inputTokens: 3, outputTokens: 2, tokensUsed: 5 }
      }
      return {
        text: JSON.stringify(decision('OPEN_LONG')),
        model: 'm',
        provider: args.provider,
        latencyMs: 5,
        inputTokens: 7,
        outputTokens: 3,
        tokensUsed: 10,
      }
    },
  })
  assert.equal(result.divergence.successCount, 2)
  assert.equal(result.divergence.actionConsensus, 'OPEN_LONG')
  const bad = result.decisions.find((c) => c.provider === 'hyperbolic')!
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /parse failed/)
})

test('configurable quorum threshold (3-of-3 unanimous required)', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    quorum: 3,
    callLLMFn: scriptedFn({
      anthropic: decision('OPEN_LONG'),
      xai: decision('OPEN_LONG'),
      hyperbolic: decision('HOLD'),
    }),
  })
  assert.equal(result.quorumDecision, null)
  assert.equal(result.divergence.actionConsensus, null)
})

test('2-2 action tie with quorum=2 yields no consensus (tie-break is deterministic null)', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic', 'akash'],
    callLLMFn: scriptedFn({
      anthropic: decision('OPEN_LONG'),
      xai: decision('OPEN_LONG'),
      hyperbolic: decision('OPEN_SHORT'),
      akash: decision('OPEN_SHORT'),
    }),
  })
  assert.equal(result.divergence.actionConsensus, null)
  assert.equal(result.quorumDecision, null)
  assert.deepEqual(result.divergence.actionHistogram, { OPEN_LONG: 2, OPEN_SHORT: 2 })
})

test('prediction quorum is restricted to the winning action cohort', async () => {
  // Action quorum: OPEN_LONG (anthropic + xai). Globally, market 0xZZZ has 2 votes
  // (xai + hyperbolic) — but hyperbolic is NOT in the OPEN_LONG cohort, so within
  // the cohort 0xZZZ has only 1 vote → no sidecar quorum → predictionTrade must be
  // cleared. (Regression test: pre-fix code computed prediction consensus globally
  // and would have erroneously kept the sidecar here.)
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    callLLMFn: scriptedFn({
      anthropic: decision('OPEN_LONG', { market: '0xAAA', tokenId: 1 }),
      xai: decision('OPEN_LONG', { market: '0xZZZ', tokenId: 9 }),
      hyperbolic: decision('HOLD', { market: '0xZZZ', tokenId: 9 }),
    }),
  })
  assert.equal(result.divergence.actionConsensus, 'OPEN_LONG')
  assert.equal(result.divergence.predictionConsensus, null)
  assert.deepEqual(
    result.divergence.predictionHistogram,
    { '0xAAA:1:OPEN_PREDICTION': 1, '0xZZZ:9:OPEN_PREDICTION': 2 },
    'global predictionHistogram is still surfaced for telemetry',
  )
  assert.ok(result.quorumDecision)
  assert.equal(result.quorumDecision!.action, 'OPEN_LONG')
  assert.equal(result.quorumDecision!.predictionTrade, null)
})

test('prediction quorum holds when same providers agree on action AND sidecar', async () => {
  // Both anthropic and xai vote OPEN_LONG with the same predictionTrade. The
  // cohort-restricted prediction quorum reaches 2-of-2 within the cohort, so
  // predictionTrade is kept on the consensus decision.
  const trade = { market: '0xAAA', tokenId: 1 }
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    callLLMFn: scriptedFn({
      anthropic: decision('OPEN_LONG', trade),
      xai: decision('OPEN_LONG', trade),
      hyperbolic: decision('HOLD'),
    }),
  })
  assert.equal(result.divergence.actionConsensus, 'OPEN_LONG')
  assert.equal(result.divergence.predictionConsensus, '0xAAA:1:OPEN_PREDICTION')
  assert.ok(result.quorumDecision)
  assert.deepEqual(result.quorumDecision!.predictionTrade, {
    marketAddress: '0xAAA',
    tokenId: 1,
    action: 'OPEN_PREDICTION',
  })
})

test('hard timeout fires when callLLMFn ignores its own timeoutMs', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai', 'hyperbolic'],
    timeoutMs: 30,
    callLLMFn: scriptedFn({
      anthropic: decision('OPEN_LONG'),
      xai: decision('OPEN_LONG'),
      hyperbolic: { delayMs: 500, decision: decision('HOLD') },
    }),
  })
  const stalled = result.decisions.find((d) => d.provider === 'hyperbolic')!
  assert.equal(stalled.ok, false)
  assert.match(stalled.error ?? '', /hard timeout/)
  assert.equal(result.divergence.actionConsensus, 'OPEN_LONG')
  assert.ok(result.quorumDecision)
})

test('reasoning telemetry is extracted by default and truncated', async () => {
  const longReasoning = 'x'.repeat(2000)
  const dec: FakeDecision = { action: 'OPEN_LONG', reasoning: longReasoning, predictionTrade: null }
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: ['anthropic', 'xai'],
    reasoningMaxChars: 100,
    callLLMFn: scriptedFn({ anthropic: dec, xai: dec }),
  })
  for (const d of result.decisions) {
    assert.ok(d.ok)
    assert.ok(d.reasoning && d.reasoning.length <= 101, 'reasoning must be truncated to ~100 chars')
  }
})

test('empty providers list returns error', async () => {
  const result = await runSwarmDecision<FakeDecision>({
    ...baseArgs,
    providers: [],
    callLLMFn: scriptedFn({}),
  })
  assert.equal(result.quorumDecision, null)
  assert.equal(result.error, 'no providers configured')
})

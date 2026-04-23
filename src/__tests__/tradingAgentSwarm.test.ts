import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runDecisionLLM,
  getSwarmQuorumCounters,
  _resetSwarmQuorumCountersForTest,
  type AgentDecision,
} from '../agents/tradingAgent'
import type { SwarmResult } from '../swarm/swarm'

// Build a fully-populated AgentDecision so the helper has valid input.
function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    regime: 'UPTREND',
    setupScore: 7,
    timeframeAlignment: { '4h': 'BULLISH', '1h': 'BULLISH', '15m': 'BULLISH', volume: 'CONFIRMING' },
    action: 'OPEN_LONG',
    pair: 'BTCUSDT',
    entryZone: { low: 100, high: 101 },
    stopLoss: 95,
    takeProfit: 110,
    size: 100,
    leverage: 3,
    riskRewardRatio: 2.5,
    confidence: 0.7,
    reasoning: 'reason',
    keyRisks: [],
    memoryUpdate: null,
    drawdownMode: false,
    holdReason: null,
    predictionTrade: null,
    ...overrides,
  }
}

function fakeStatus(live: Array<'anthropic' | 'xai' | 'hyperbolic' | 'akash'>) {
  const all: Record<string, { live: boolean; model: string }> = {
    anthropic: { live: false, model: 'claude' },
    xai: { live: false, model: 'grok' },
    hyperbolic: { live: false, model: 'hyper' },
    akash: { live: false, model: 'akash' },
  }
  for (const p of live) all[p].live = true
  return () => all as any
}

function swarmResult(opts: {
  quorum: AgentDecision | null
  decisions: Array<{ provider: string; ok: boolean; decision?: AgentDecision; error?: string }>
  error?: string | null
}): SwarmResult<AgentDecision> {
  return {
    quorumDecision: opts.quorum,
    decisions: opts.decisions.map((d) => ({
      provider: d.provider as any,
      model: 'm',
      ok: d.ok,
      decision: d.decision ?? null,
      rawText: d.decision ? JSON.stringify(d.decision) : '',
      reasoning: d.decision?.reasoning ?? null,
      latencyMs: 5,
      tokensUsed: 10,
      error: d.error ?? null,
    })),
    divergence: {
      successCount: opts.decisions.filter((d) => d.ok).length,
      totalCount: opts.decisions.length,
      actionConsensus: opts.quorum?.action ?? null,
      predictionConsensus: null,
      actionHistogram: {},
      predictionHistogram: {},
      agreement: opts.decisions.map((d) => ({
        provider: d.provider as any,
        action: d.decision?.action ?? null,
        prediction: null,
      })),
    },
    error: opts.error ?? null,
  } as SwarmResult<AgentDecision>
}

// ─── Branch (a): >=2 live providers + quorum reached ──────────────────────
test('runDecisionLLM: swarm + quorum reached uses the quorum decision and emits telemetry', async () => {
  const quorum = decision({ action: 'OPEN_LONG', confidence: 0.8 })
  let receivedProviders: string[] = []
  const result = await runDecisionLLM(true, 'sys', 'usr', {
    getProviderStatus: fakeStatus(['anthropic', 'xai', 'hyperbolic']),
    runSwarmDecision: (async (args: any) => {
      receivedProviders = args.providers
      return swarmResult({
        quorum,
        decisions: [
          { provider: 'anthropic', ok: true, decision: quorum },
          { provider: 'xai', ok: true, decision: quorum },
          { provider: 'hyperbolic', ok: true, decision: decision({ action: 'HOLD', confidence: 0.4 }) },
        ],
      })
    }) as any,
    anthropicCreate: async () => {
      throw new Error('anthropicCreate must NOT be called when swarm reaches quorum')
    },
  })
  assert.equal(result.decision.action, 'OPEN_LONG')
  assert.equal(result.decision.confidence, 0.8)
  assert.deepEqual(receivedProviders.sort(), ['anthropic', 'hyperbolic', 'xai'])
  assert.ok(result.providersTelemetry, 'telemetry must be present on swarm path')
  assert.equal(result.providersTelemetry!.length, 3)
  // Raw response should embed the swarm consensus payload, not be empty.
  assert.match(result.rawResponse, /consensus/)
  assert.ok(!result.rawResponse.startsWith('[swarm-no-quorum'))
})

// ─── Branch (b): >=2 live providers + NO quorum → Anthropic fallback ──────
test('runDecisionLLM: swarm + no quorum picks the highest-confidence NON-anthropic successful decision (no extra Anthropic call)', async () => {
  // Anthropic returns the highest raw confidence (0.9) but we deliberately
  // de-prioritize it because in production it is the provider that runs out
  // of credits. xai (0.6) should win over hyperbolic (0.3).
  const longHigh = decision({ action: 'OPEN_LONG', confidence: 0.9, reasoning: 'anthropic says long' })
  const short = decision({ action: 'OPEN_SHORT', confidence: 0.6, reasoning: 'xai says short' })
  const hold = decision({ action: 'HOLD', confidence: 0.3, reasoning: 'hyperbolic says hold' })
  let anthropicCalls = 0
  const result = await runDecisionLLM(true, 'sys-prompt', 'user-msg', {
    getProviderStatus: fakeStatus(['anthropic', 'xai', 'hyperbolic']),
    runSwarmDecision: (async () =>
      swarmResult({
        quorum: null, // <-- no quorum
        decisions: [
          { provider: 'anthropic', ok: true, decision: longHigh },
          { provider: 'xai', ok: true, decision: short },
          { provider: 'hyperbolic', ok: true, decision: hold },
        ],
      })) as any,
    anthropicCreate: async () => {
      anthropicCalls += 1
      throw new Error('anthropicCreate must NOT be called by the no-quorum branch any more')
    },
  })
  assert.equal(anthropicCalls, 0, 'no-quorum branch must NOT issue any Anthropic call')
  assert.equal(result.decision.action, 'OPEN_SHORT', 'best-of-swarm: xai wins over hyperbolic; anthropic is de-prioritized')
  assert.equal(result.decision.reasoning, 'xai says short')
  assert.ok(result.providersTelemetry && result.providersTelemetry.length === 3, 'swarm telemetry must still be present')
  assert.match(result.rawResponse, /^\[swarm-no-quorum, best-of-swarm\]/)
})

test('runDecisionLLM: swarm + no quorum falls back to anthropic decision only when it is the only successful provider', async () => {
  // xai and hyperbolic both errored; anthropic is the only provider that
  // returned a parseable decision. Even though we de-prioritize anthropic,
  // it wins because there is no non-anthropic alternative.
  const anthropicOnly = decision({ action: 'HOLD', confidence: 0.55, reasoning: 'only anthropic answered' })
  let anthropicCalls = 0
  const result = await runDecisionLLM(true, 'sys', 'usr', {
    getProviderStatus: fakeStatus(['anthropic', 'xai', 'hyperbolic']),
    runSwarmDecision: (async () =>
      swarmResult({
        quorum: null,
        decisions: [
          { provider: 'anthropic', ok: true, decision: anthropicOnly },
          { provider: 'xai', ok: false, error: 'down' },
          { provider: 'hyperbolic', ok: false, error: 'down' },
        ],
      })) as any,
    anthropicCreate: async () => { anthropicCalls += 1; throw new Error('must not call') },
  })
  assert.equal(anthropicCalls, 0, 'must not issue an extra Anthropic call — we use the swarm result')
  assert.equal(result.decision.action, 'HOLD')
  assert.equal(result.decision.reasoning, 'only anthropic answered')
})

test('runDecisionLLM: swarm + no quorum returns safe HOLD telemetry when ALL providers failed (no Anthropic call)', async () => {
  let anthropicCalls = 0
  const result = await runDecisionLLM(true, 'sys', 'usr', {
    getProviderStatus: fakeStatus(['anthropic', 'xai']),
    runSwarmDecision: (async () =>
      swarmResult({
        quorum: null,
        decisions: [
          { provider: 'anthropic', ok: false, error: 'down' },
          { provider: 'xai', ok: false, error: 'down' },
        ],
        error: 'all providers failed',
      })) as any,
    anthropicCreate: async () => { anthropicCalls += 1; throw new Error('must not call') },
  })
  assert.equal(anthropicCalls, 0, 'all-failed branch must NOT call Anthropic — we already know it failed')
  assert.equal(result.decision.action, 'HOLD')
  assert.match(result.rawResponse, /^\[swarm-no-quorum, all-failed\]/)
  assert.ok(result.providersTelemetry && result.providersTelemetry.length === 2)
})

// ─── Branch (c): swarmOn but only 1 live provider → Anthropic fallback ────
test('runDecisionLLM: swarm enabled but only 1 live provider falls through to Anthropic single-provider path', async () => {
  let swarmCalls = 0
  let anthropicCalls = 0
  const anthropicDecision = decision({ action: 'HOLD', confidence: 0.5 })
  const result = await runDecisionLLM(true, 'sys', 'usr', {
    getProviderStatus: fakeStatus(['anthropic']), // only one live
    runSwarmDecision: (async () => {
      swarmCalls += 1
      return swarmResult({ quorum: null, decisions: [] })
    }) as any,
    anthropicCreate: async (args) => {
      anthropicCalls += 1
      assert.equal(args.system, 'sys')
      assert.equal((args.messages[0] as any).content, 'usr')
      return {
        id: 'm', type: 'message', role: 'assistant', model: 'c', stop_reason: 'end_turn',
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify(anthropicDecision), citations: null }],
      } as any
    },
  })
  assert.equal(swarmCalls, 0, 'swarm must NOT run when fewer than 2 live providers')
  assert.equal(anthropicCalls, 1, 'Anthropic must be the single fallback when swarm cannot run')
  assert.equal(result.decision.action, 'HOLD')
  assert.equal(result.providersTelemetry, null, 'telemetry must be null when swarm did not run')
})

// ─── Quorum counters: ensure the no-quorum branch is observable ──────────
test('runDecisionLLM increments quorum counters so operators can see the no-quorum rate', async () => {
  _resetSwarmQuorumCountersForTest()
  const quorum = decision({ action: 'OPEN_LONG' })
  // 1 quorum-reached call
  await runDecisionLLM(true, 'sys', 'usr', {
    getProviderStatus: fakeStatus(['anthropic', 'xai', 'hyperbolic']),
    runSwarmDecision: (async () =>
      swarmResult({
        quorum,
        decisions: [
          { provider: 'anthropic', ok: true, decision: quorum },
          { provider: 'xai', ok: true, decision: quorum },
          { provider: 'hyperbolic', ok: true, decision: quorum },
        ],
      })) as any,
    anthropicCreate: async () => { throw new Error('should not call') },
  })
  // 2 no-quorum fallbacks
  for (let i = 0; i < 2; i++) {
    await runDecisionLLM(true, 'sys', 'usr', {
      getProviderStatus: fakeStatus(['anthropic', 'xai']),
      runSwarmDecision: (async () =>
        swarmResult({
          quorum: null,
          decisions: [
            { provider: 'anthropic', ok: true, decision: decision({ action: 'OPEN_LONG' }) },
            { provider: 'xai', ok: true, decision: decision({ action: 'OPEN_SHORT' }) },
          ],
        })) as any,
      anthropicCreate: async () => ({
        id: 'm', type: 'message', role: 'assistant', model: 'c', stop_reason: 'end_turn',
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify(decision({ action: 'HOLD' })), citations: null }],
      }) as any,
    })
  }
  const counters = getSwarmQuorumCounters()
  assert.equal(counters.quorumReached, 1)
  assert.equal(counters.noQuorum, 2)
})

// ─── Branch (d): swarmOn=false (sanity baseline) ──────────────────────────
test('runDecisionLLM: swarmOn=false uses Anthropic-only path and never touches swarm/inference', async () => {
  let touched = false
  const anthropicDecision = decision({ action: 'OPEN_LONG' })
  const result = await runDecisionLLM(false, 'sys', 'usr', {
    getProviderStatus: () => {
      touched = true
      return {} as any
    },
    runSwarmDecision: (async () => {
      touched = true
      return swarmResult({ quorum: null, decisions: [] })
    }) as any,
    anthropicCreate: async () => ({
      id: 'm', type: 'message', role: 'assistant', model: 'c', stop_reason: 'end_turn',
      stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: JSON.stringify(anthropicDecision), citations: null }],
    }) as any,
  })
  assert.equal(touched, false, 'swarm dependencies must not be touched when swarmOn=false')
  assert.equal(result.decision.action, 'OPEN_LONG')
  assert.equal(result.providersTelemetry, null)
})

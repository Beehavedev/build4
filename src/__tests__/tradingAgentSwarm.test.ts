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
test('runDecisionLLM: swarm + no quorum issues an Anthropic fallback call but preserves swarm telemetry', async () => {
  const longHigh = decision({ action: 'OPEN_LONG', confidence: 0.9 })
  const short = decision({ action: 'OPEN_SHORT', confidence: 0.6 })
  const hold = decision({ action: 'HOLD', confidence: 0.3 })
  const anthropicVerdict = decision({ action: 'HOLD', confidence: 0.55, reasoning: 'tie-break by anthropic' })
  let anthropicCalls = 0
  let anthropicArgs: { system?: string; userMessage?: string } = {}
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
    anthropicCreate: async (args) => {
      anthropicCalls += 1
      anthropicArgs.system = args.system as string
      anthropicArgs.userMessage = (args.messages[0] as any).content
      return {
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: 'text', text: JSON.stringify(anthropicVerdict), citations: null }],
      } as any
    },
  })
  assert.equal(anthropicCalls, 1, 'no-quorum branch MUST issue exactly one Anthropic fallback call')
  assert.equal(anthropicArgs.system, 'sys-prompt', 'fallback must reuse the same system prompt')
  assert.equal(anthropicArgs.userMessage, 'user-msg', 'fallback must reuse the same user message')
  assert.equal(result.decision.action, 'HOLD', 'final decision must come from Anthropic, not the disagreeing swarm')
  assert.equal(result.decision.reasoning, 'tie-break by anthropic')
  assert.ok(result.providersTelemetry && result.providersTelemetry.length === 3, 'swarm telemetry must still be present')
  assert.match(result.rawResponse, /^\[swarm-no-quorum, anthropic-fallback\]/)
})

test('runDecisionLLM: swarm + no quorum still calls Anthropic fallback even when all providers failed', async () => {
  let anthropicCalls = 0
  const fallbackVerdict = decision({ action: 'HOLD' })
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
    anthropicCreate: async () => {
      anthropicCalls += 1
      return {
        id: 'm', type: 'message', role: 'assistant', model: 'c', stop_reason: 'end_turn',
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify(fallbackVerdict), citations: null }],
      } as any
    },
  })
  assert.equal(anthropicCalls, 1, 'Anthropic fallback must still run (it is independent of the swarm)')
  assert.equal(result.decision.action, 'HOLD')
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

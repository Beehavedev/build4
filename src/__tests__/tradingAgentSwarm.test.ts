import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runDecisionLLM,
  resolveDecisionProviders,
  DEFAULT_DECISION_PROVIDERS,
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

// A callLLM stub that returns the given decision as JSON text and records calls.
function fakeCallLLM(byProvider: Record<string, AgentDecision>) {
  const calls: Array<{ provider: string }> = []
  const fn = (async (args: any) => {
    calls.push({ provider: args.provider })
    const d = byProvider[args.provider]
    if (!d) throw new Error(`provider ${args.provider} not configured in fakeCallLLM`)
    return { text: JSON.stringify(d) } as any
  }) as any
  return { fn, calls }
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

// ─── resolveDecisionProviders ─────────────────────────────────────────────
test('resolveDecisionProviders: defaults to hyperbolic + akash when env unset', () => {
  const prev = process.env.DECISION_PROVIDERS
  delete process.env.DECISION_PROVIDERS
  try {
    assert.deepEqual(resolveDecisionProviders(), ['hyperbolic', 'akash'])
    assert.deepEqual(DEFAULT_DECISION_PROVIDERS, ['hyperbolic', 'akash'])
  } finally {
    if (prev === undefined) delete process.env.DECISION_PROVIDERS
    else process.env.DECISION_PROVIDERS = prev
  }
})

test('resolveDecisionProviders: honors env override, validates + de-dupes', () => {
  const prev = process.env.DECISION_PROVIDERS
  try {
    process.env.DECISION_PROVIDERS = 'akash, hyperbolic, akash, bogus'
    assert.deepEqual(resolveDecisionProviders(), ['akash', 'hyperbolic'])
    process.env.DECISION_PROVIDERS = 'nonsense,only'
    assert.deepEqual(resolveDecisionProviders(), ['hyperbolic', 'akash'], 'all-invalid falls back to default')
  } finally {
    if (prev === undefined) delete process.env.DECISION_PROVIDERS
    else process.env.DECISION_PROVIDERS = prev
  }
})

// ─── Branch (a): >=2 live decision providers + unanimous quorum ────────────
test('runDecisionLLM: swarm + unanimous quorum uses the quorum decision, runs ONLY decision providers with unanimous quorum', async () => {
  const quorum = decision({ action: 'OPEN_LONG', confidence: 0.8 })
  let receivedProviders: string[] = []
  let receivedQuorum: number | undefined
  let llmCalls = 0
  const result = await runDecisionLLM(true, 'sys', 'usr', {
    // anthropic+xai are live but must be IGNORED — only hyperbolic/akash decide.
    getProviderStatus: fakeStatus(['anthropic', 'xai', 'hyperbolic', 'akash']),
    runSwarmDecision: (async (args: any) => {
      receivedProviders = args.providers
      receivedQuorum = args.quorum
      return swarmResult({
        quorum,
        decisions: [
          { provider: 'hyperbolic', ok: true, decision: quorum },
          { provider: 'akash', ok: true, decision: quorum },
        ],
      })
    }) as any,
    callLLM: (async () => {
      llmCalls += 1
      throw new Error('callLLM must NOT be used when swarm reaches quorum')
    }) as any,
  })
  assert.equal(result.decision.action, 'OPEN_LONG')
  assert.equal(result.decision.confidence, 0.8)
  assert.deepEqual(receivedProviders, ['hyperbolic', 'akash'], 'swarm must run only the configured decision providers, in order')
  assert.equal(receivedQuorum, 2, 'quorum must equal participant count (unanimous)')
  assert.equal(llmCalls, 0)
  assert.ok(result.providersTelemetry, 'telemetry must be present on swarm path')
  assert.equal(result.providersTelemetry!.length, 2)
  assert.match(result.rawResponse, /consensus/)
  assert.ok(!result.rawResponse.startsWith('[swarm-no-quorum'))
})

// ─── Branch (b): >=2 live providers + NOT unanimous → safe HOLD ───────────
test('runDecisionLLM: swarm + no unanimity returns a safe HOLD with telemetry (NO best-of-swarm, NO extra LLM call)', async () => {
  const long = decision({ action: 'OPEN_LONG', confidence: 0.9, reasoning: 'hyperbolic says long' })
  const short = decision({ action: 'OPEN_SHORT', confidence: 0.6, reasoning: 'akash says short' })
  let llmCalls = 0
  const result = await runDecisionLLM(true, 'sys-prompt', 'user-msg', {
    getProviderStatus: fakeStatus(['hyperbolic', 'akash']),
    runSwarmDecision: (async () =>
      swarmResult({
        quorum: null, // disagreement → no unanimous quorum
        decisions: [
          { provider: 'hyperbolic', ok: true, decision: long },
          { provider: 'akash', ok: true, decision: short },
        ],
      })) as any,
    callLLM: (async () => {
      llmCalls += 1
      throw new Error('callLLM must NOT be issued by the no-quorum branch')
    }) as any,
  })
  assert.equal(llmCalls, 0, 'no-quorum branch must NOT issue any extra LLM call')
  assert.equal(result.decision.action, 'HOLD', 'disagreement must HOLD — no best-of-swarm pick')
  assert.equal(result.decision.confidence, 0)
  assert.ok(result.providersTelemetry && result.providersTelemetry.length === 2, 'swarm telemetry must still be present')
  assert.match(result.rawResponse, /^\[swarm-no-quorum, hold\]/)
})

test('runDecisionLLM: swarm + all providers failed → safe HOLD telemetry, no best-of-swarm', async () => {
  let llmCalls = 0
  const result = await runDecisionLLM(true, 'sys', 'usr', {
    getProviderStatus: fakeStatus(['hyperbolic', 'akash']),
    runSwarmDecision: (async () =>
      swarmResult({
        quorum: null,
        decisions: [
          { provider: 'hyperbolic', ok: false, error: 'down' },
          { provider: 'akash', ok: false, error: 'down' },
        ],
        error: 'all providers failed',
      })) as any,
    callLLM: (async () => { llmCalls += 1; throw new Error('must not call') }) as any,
  })
  assert.equal(llmCalls, 0)
  assert.equal(result.decision.action, 'HOLD')
  assert.match(result.rawResponse, /^\[swarm-no-quorum, hold\]/)
  assert.ok(result.providersTelemetry && result.providersTelemetry.length === 2)
})

// ─── Branch (c): swarmOn but <2 live decision providers → safe HOLD ───────
test('runDecisionLLM: swarm enabled but only 1 live decision provider HOLDs (unanimity impossible, swarm not run)', async () => {
  let swarmCalls = 0
  let llmCalls = 0
  const result = await runDecisionLLM(true, 'sys', 'usr', {
    // anthropic live but it is NOT a decision provider; only hyperbolic is live.
    getProviderStatus: fakeStatus(['anthropic', 'hyperbolic']),
    runSwarmDecision: (async () => {
      swarmCalls += 1
      return swarmResult({ quorum: null, decisions: [] })
    }) as any,
    callLLM: (async () => { llmCalls += 1; throw new Error('must not call') }) as any,
  })
  assert.equal(swarmCalls, 0, 'swarm must NOT run with fewer than 2 live decision providers')
  assert.equal(llmCalls, 0, 'swarm mode must HOLD, not drop to a single-provider call')
  assert.equal(result.decision.action, 'HOLD')
  assert.match(result.rawResponse, /^\[swarm-insufficient-providers\]/)
  assert.equal(result.providersTelemetry, null, 'telemetry must be null when swarm did not run')
})

// ─── Quorum counters ──────────────────────────────────────────────────────
test('runDecisionLLM increments quorum counters so operators can see the no-quorum rate', async () => {
  _resetSwarmQuorumCountersForTest()
  const quorum = decision({ action: 'OPEN_LONG' })
  await runDecisionLLM(true, 'sys', 'usr', {
    getProviderStatus: fakeStatus(['hyperbolic', 'akash']),
    runSwarmDecision: (async () =>
      swarmResult({
        quorum,
        decisions: [
          { provider: 'hyperbolic', ok: true, decision: quorum },
          { provider: 'akash', ok: true, decision: quorum },
        ],
      })) as any,
    callLLM: (async () => { throw new Error('should not call') }) as any,
  })
  for (let i = 0; i < 2; i++) {
    await runDecisionLLM(true, 'sys', 'usr', {
      getProviderStatus: fakeStatus(['hyperbolic', 'akash']),
      runSwarmDecision: (async () =>
        swarmResult({
          quorum: null,
          decisions: [
            { provider: 'hyperbolic', ok: true, decision: decision({ action: 'OPEN_LONG' }) },
            { provider: 'akash', ok: true, decision: decision({ action: 'OPEN_SHORT' }) },
          ],
        })) as any,
      callLLM: (async () => { throw new Error('should not call') }) as any,
    })
  }
  const counters = getSwarmQuorumCounters()
  assert.equal(counters.quorumReached, 1)
  assert.equal(counters.noQuorum, 2)
})

// ─── Branch (d): swarmOn=false → single decision provider via callLLM ──────
test('runDecisionLLM: swarmOn=false uses a single decision provider (hyperbolic-first) and never runs the swarm', async () => {
  let swarmTouched = false
  const dec = decision({ action: 'OPEN_LONG', reasoning: 'hyperbolic solo' })
  const llm = fakeCallLLM({ hyperbolic: dec, akash: decision({ action: 'HOLD' }) })
  const result = await runDecisionLLM(false, 'sys', 'usr', {
    getProviderStatus: fakeStatus(['hyperbolic', 'akash']),
    runSwarmDecision: (async () => {
      swarmTouched = true
      return swarmResult({ quorum: null, decisions: [] })
    }) as any,
    callLLM: llm.fn,
  })
  assert.equal(swarmTouched, false, 'swarm must not run when swarmOn=false')
  assert.equal(llm.calls.length, 1, 'only the first live provider should be called')
  assert.equal(llm.calls[0].provider, 'hyperbolic', 'hyperbolic is tried first')
  assert.equal(result.decision.action, 'OPEN_LONG')
  assert.equal(result.decision.reasoning, 'hyperbolic solo')
  assert.equal(result.providersTelemetry, null)
})

test('runDecisionLLM: swarmOn=false falls through to the next provider when the first one throws', async () => {
  const dec = decision({ action: 'OPEN_SHORT', reasoning: 'akash answered' })
  const calls: string[] = []
  const result = await runDecisionLLM(false, 'sys', 'usr', {
    getProviderStatus: fakeStatus(['hyperbolic', 'akash']),
    runSwarmDecision: (async () => swarmResult({ quorum: null, decisions: [] })) as any,
    callLLM: (async (args: any) => {
      calls.push(args.provider)
      if (args.provider === 'hyperbolic') throw new Error('hyperbolic down')
      return { text: JSON.stringify(dec) } as any
    }) as any,
  })
  assert.deepEqual(calls, ['hyperbolic', 'akash'], 'must try hyperbolic then fall through to akash')
  assert.equal(result.decision.action, 'OPEN_SHORT')
  assert.equal(result.providersTelemetry, null)
})

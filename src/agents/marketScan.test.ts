// Unit tests for the centralised market scan service.
//
// We stub the LLM (`runLLM`) and both context fetchers so no network is
// involved — the goal is to verify cache, dedupe, TTL, and the size/leverage/
// CLOSE-downgrade contract.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getSharedMarketScan,
  peekOrLaunchScan,
  getMarketScanCounters,
  _resetMarketScanCacheForTest,
  type MarketScanInputs,
  type MarketScanDeps,
} from './marketScan'
import type { AgentDecision } from './tradingAgent'
import type { OHLCV } from './indicators'

// ─── Fixtures ────────────────────────────────────────────────────────────────
function fakeOhlcv(n = 200, base = 100): OHLCV {
  const close = Array.from({ length: n }, (_, i) => base + i * 0.05)
  const open = close.map((c) => c - 0.02)
  const high = close.map((c) => c + 0.04)
  const low = close.map((c) => c - 0.04)
  const volume = close.map(() => 1000)
  const openTime = close.map((_, i) => 1_700_000_000_000 + i * 60_000)
  return { open, high, low, close, volume, openTime } as unknown as OHLCV
}

function inputs(pair: string): MarketScanInputs {
  return {
    pair,
    mode: 'standard',
    ohlcv: { '15m': fakeOhlcv(), '1h': fakeOhlcv(), '4h': fakeOhlcv() },
    fundingRate: 0.0001,
  }
}

function makeStubLLM(decision: Partial<AgentDecision> = {}) {
  let calls = 0
  const stub = async (
    _swarm: boolean,
    _sys: string,
    _user: string,
  ) => {
    calls += 1
    const merged: AgentDecision = {
      regime: 'UPTREND',
      setupScore: 6,
      timeframeAlignment: { '4h': 'BULLISH', '1h': 'BULLISH', '15m': 'BULLISH', volume: 'CONFIRMING' },
      action: 'OPEN_LONG',
      pair: 'TEST',
      entryZone: { low: 100, high: 101 },
      stopLoss: 98,
      takeProfit: 105,
      size: 50,        // model returns size — we expect the contract to null it
      leverage: 5,     // ditto
      riskRewardRatio: 2.5,
      confidence: 0.7,
      reasoning: 'stub reasoning',
      keyRisks: ['stub risk'],
      memoryUpdate: null,
      drawdownMode: false,
      holdReason: null,
      ...decision,
    }
    return {
      decision: merged,
      rawResponse: JSON.stringify(merged),
      providersTelemetry: null,
    }
  }
  return { stub, getCalls: () => calls }
}

function deps(stubLLM: ReturnType<typeof makeStubLLM>): MarketScanDeps {
  return {
    runLLM: stubLLM.stub,
    fetchNewsBlock: async () => '',
    fetchPredictionBlock: async () => '',
    swarmOn: false,
  }
}

// ─── Cache hit ───────────────────────────────────────────────────────────────
test('getSharedMarketScan caches by (pair, mode) for TTL', async () => {
  _resetMarketScanCacheForTest({ ttlMs: 60_000 })
  const llm = makeStubLLM()

  const a = await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))
  const b = await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))

  assert.equal(llm.getCalls(), 1, 'LLM should fire only once for repeat calls within TTL')
  assert.equal(a.pair, 'BTCUSDT')
  assert.equal(b.pair, 'BTCUSDT')
  assert.equal(a.scannedAt, b.scannedAt, 'cached entry returns same scannedAt')

  const counters = getMarketScanCounters()
  assert.equal(counters.misses, 1)
  assert.equal(counters.hits, 1)
})

// ─── Different pairs do not collide ──────────────────────────────────────────
test('different pairs each get their own LLM call', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM()

  await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))
  await getSharedMarketScan(inputs('ETHUSDT'), deps(llm))
  await getSharedMarketScan(inputs('SOLUSDT'), deps(llm))

  assert.equal(llm.getCalls(), 3)
  assert.equal(getMarketScanCounters().misses, 3)
})

// ─── Concurrent dedupe ───────────────────────────────────────────────────────
test('concurrent ticks for the same pair share one in-flight LLM call', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM()

  const [r1, r2, r3, r4, r5] = await Promise.all([
    getSharedMarketScan(inputs('BTCUSDT'), deps(llm)),
    getSharedMarketScan(inputs('BTCUSDT'), deps(llm)),
    getSharedMarketScan(inputs('BTCUSDT'), deps(llm)),
    getSharedMarketScan(inputs('BTCUSDT'), deps(llm)),
    getSharedMarketScan(inputs('BTCUSDT'), deps(llm)),
  ])

  assert.equal(llm.getCalls(), 1, '5 concurrent callers must collapse to 1 LLM call')
  // All callers receive the same promise resolution → identical scannedAt.
  for (const r of [r2, r3, r4, r5]) {
    assert.equal(r.scannedAt, r1.scannedAt)
  }
})

// ─── TTL expiry ──────────────────────────────────────────────────────────────
test('cache expires after TTL and the next call refires the LLM', async () => {
  _resetMarketScanCacheForTest({ ttlMs: 1_000 })
  const llm = makeStubLLM()

  // Custom clock so we don't need to actually sleep.
  let clock = 1_000_000
  const tickClock = (ms: number) => { clock += ms }
  const baseDeps: MarketScanDeps = { ...deps(llm), now: () => clock }

  await getSharedMarketScan(inputs('BTCUSDT'), baseDeps)
  await getSharedMarketScan(inputs('BTCUSDT'), baseDeps)
  assert.equal(llm.getCalls(), 1, 'second call inside TTL is a cache hit')

  tickClock(2_000) // jump past TTL

  await getSharedMarketScan(inputs('BTCUSDT'), baseDeps)
  assert.equal(llm.getCalls(), 2, 'after TTL expires the next call must refire the LLM')
})

// ─── size/leverage contract ──────────────────────────────────────────────────
test('shared scan forces size=null and leverage=null even if the LLM returned values', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM({ size: 999, leverage: 25 })

  const r = await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))

  assert.equal(r.decision.size, null, 'size must be null — agent layer fills it')
  assert.equal(r.decision.leverage, null, 'leverage must be null — agent layer clamps')
})

// ─── CLOSE downgrade ─────────────────────────────────────────────────────────
test('shared scan downgrades CLOSE → HOLD with explanatory holdReason', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM({ action: 'CLOSE', holdReason: null })

  const r = await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))

  assert.equal(r.decision.action, 'HOLD', 'CLOSE must be downgraded — close is per-agent')
  assert.match(r.decision.holdReason ?? '', /per-agent/i, 'must explain why CLOSE was rejected')
})

test('shared scan preserves an existing holdReason when downgrading CLOSE', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM({ action: 'CLOSE', holdReason: 'momentum waning' })
  const r = await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))
  assert.equal(r.decision.holdReason, 'momentum waning')
})

// ─── sharedActionRaw preserves the LLM's true verdict ────────────────────────
test('sharedActionRaw preserves CLOSE so per-agent layer can act on it', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM({ action: 'CLOSE' })
  const r = await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))

  // decision.action is downgraded to HOLD for safety …
  assert.equal(r.decision.action, 'HOLD')
  // … but the raw signal survives so an agent holding a position knows to exit.
  assert.equal(r.sharedActionRaw, 'CLOSE')
})

test('sharedActionRaw mirrors decision.action for non-CLOSE outputs', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM({ action: 'OPEN_LONG' })
  const r = await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))
  assert.equal(r.sharedActionRaw, 'OPEN_LONG')
  assert.equal(r.decision.action, 'OPEN_LONG')
})

// ─── peekOrLaunchScan ────────────────────────────────────────────────────────
test('peekOrLaunchScan returns cached scan as a dedupe (not a hit)', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM()

  await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))
  const before = getMarketScanCounters()

  await peekOrLaunchScan(inputs('BTCUSDT'), deps(llm))

  const after = getMarketScanCounters()
  assert.equal(llm.getCalls(), 1, 'no new LLM call when cache fresh')
  assert.equal(after.dedupes, before.dedupes + 1)
  assert.equal(after.hits, before.hits, 'peek does not bump hits — that is for getSharedMarketScan')
})

test('peekOrLaunchScan triggers a fresh LLM call when nothing cached', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM()

  await peekOrLaunchScan(inputs('BTCUSDT'), deps(llm))

  assert.equal(llm.getCalls(), 1)
  assert.equal(getMarketScanCounters().misses, 1)
})

// ─── failure handling ────────────────────────────────────────────────────────
test('a rejected LLM call serves a negative-cached error during the cooldown window', async () => {
  _resetMarketScanCacheForTest({ failureCooldownMs: 10_000 })
  let calls = 0
  let clock = 1_000_000
  const failingDeps: MarketScanDeps = {
    runLLM: async () => {
      calls += 1
      if (calls === 1) throw new Error('upstream model down')
      return {
        decision: {
          regime: 'UPTREND', setupScore: 5,
          timeframeAlignment: { '4h': 'NEUTRAL', '1h': 'NEUTRAL', '15m': 'NEUTRAL', volume: 'NEUTRAL' },
          action: 'HOLD', pair: 'BTCUSDT',
          entryZone: null, stopLoss: null, takeProfit: null,
          size: null, leverage: null, riskRewardRatio: null,
          confidence: 0.4,
          reasoning: 'recovered',
          keyRisks: [],
          memoryUpdate: null, drawdownMode: false, holdReason: 'recovered',
        } satisfies AgentDecision,
        rawResponse: '{}',
        providersTelemetry: null,
      }
    },
    fetchNewsBlock: async () => '',
    fetchPredictionBlock: async () => '',
    swarmOn: false,
    now: () => clock,
  }

  await assert.rejects(
    () => getSharedMarketScan(inputs('BTCUSDT'), failingDeps),
    /upstream model down/,
  )

  // Inside the 10s cooldown: must re-throw the same error WITHOUT firing
  // a new LLM call — protects providers from a retry storm during outages.
  await assert.rejects(
    () => getSharedMarketScan(inputs('BTCUSDT'), failingDeps),
    /upstream model down/,
  )
  assert.equal(calls, 1, 'inside negative-cache cooldown the LLM must not be called')

  // After the cooldown, retry actually fires the LLM.
  clock += 10_001
  const r = await getSharedMarketScan(inputs('BTCUSDT'), failingDeps)
  assert.equal(r.decision.action, 'HOLD')
  assert.equal(calls, 2, 'after cooldown the next call must fire the LLM and recover')
})

// ─── slow LLM call must not trigger duplicate launches ───────────────────────
test('a slow LLM call (longer than TTL) still dedupes concurrent callers', async () => {
  _resetMarketScanCacheForTest({ ttlMs: 50 }) // very short TTL
  let calls = 0
  let resolveLLM!: (v: unknown) => void
  const slowDeps: MarketScanDeps = {
    runLLM: () => {
      calls += 1
      return new Promise<any>((resolve) => {
        resolveLLM = resolve
      })
    },
    fetchNewsBlock: async () => '',
    fetchPredictionBlock: async () => '',
    swarmOn: false,
  }

  // First call kicks off the LLM but never resolves yet.
  const firstP = getSharedMarketScan(inputs('BTCUSDT'), slowDeps)

  // Wait long enough that the original launch-time TTL would have expired
  // under the previous (broken) cache state model.
  await new Promise((r) => setTimeout(r, 80))

  // Second caller arrives AFTER the would-be TTL expiry. With the in-flight
  // state in place, this MUST dedupe onto the same promise instead of
  // firing a second LLM call.
  const secondP = getSharedMarketScan(inputs('BTCUSDT'), slowDeps)

  assert.equal(calls, 1, 'in-flight dedupe must hold even past nominal TTL')

  // Resolve the LLM and let both callers finish on the same value.
  resolveLLM({
    decision: {
      regime: 'UPTREND', setupScore: 6,
      timeframeAlignment: { '4h': 'BULLISH', '1h': 'BULLISH', '15m': 'BULLISH', volume: 'CONFIRMING' },
      action: 'HOLD', pair: 'BTCUSDT',
      entryZone: null, stopLoss: null, takeProfit: null,
      size: null, leverage: null, riskRewardRatio: null,
      confidence: 0.5, reasoning: 'r', keyRisks: [],
      memoryUpdate: null, drawdownMode: false, holdReason: 'h',
    } satisfies AgentDecision,
    rawResponse: '{}',
    providersTelemetry: null,
  })

  const [a, b] = await Promise.all([firstP, secondP])
  assert.equal(a.scannedAt, b.scannedAt, 'both callers received the same resolved scan')
})

// ─── pair canonicalisation ───────────────────────────────────────────────────
test('pair variants (BTC/USDT, btcusdt, BTCUSDT) all hit the same cache entry', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM()

  await getSharedMarketScan({ ...inputs('BTCUSDT') }, deps(llm))
  await getSharedMarketScan({ ...inputs('BTC/USDT') }, deps(llm))
  await getSharedMarketScan({ ...inputs('btcusdt') }, deps(llm))
  await getSharedMarketScan({ ...inputs(' btc usdt ') }, deps(llm))

  assert.equal(llm.getCalls(), 1, 'all pair variants must canonicalise to the same key')
})

// ─── pair always echoed ──────────────────────────────────────────────────────
test('returned decision.pair is always the requested pair, regardless of LLM output', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM({ pair: 'TYPO_FROM_LLM' })
  const r = await getSharedMarketScan(inputs('SOLUSDT'), deps(llm))
  assert.equal(r.decision.pair, 'SOLUSDT')
})

// ─── narrow-action contract enforced at runtime ──────────────────────────────
test('decision.action is never CLOSE — always {OPEN_LONG, OPEN_SHORT, HOLD}', async () => {
  _resetMarketScanCacheForTest()
  // Even if the LLM returns CLOSE for some reason, the shared decision
  // surface MUST narrow it to HOLD. Per-agent layer reads sharedActionRaw
  // for the true verdict.
  const llm = makeStubLLM({ action: 'CLOSE' })
  const r = await getSharedMarketScan(inputs('BTCUSDT'), deps(llm))

  const ok = r.decision.action === 'OPEN_LONG' ||
             r.decision.action === 'OPEN_SHORT' ||
             r.decision.action === 'HOLD'
  assert.ok(ok, `decision.action must be in narrowed set, got ${r.decision.action}`)
  assert.equal(r.decision.size, null, 'decision.size must be null per contract')
  assert.equal(r.decision.leverage, null, 'decision.leverage must be null per contract')
})

// ─── local errors are NOT negative-cached ────────────────────────────────────
test('local errors (not from the LLM call) are NOT negative-cached', async () => {
  _resetMarketScanCacheForTest({ failureCooldownMs: 60_000 })

  // We simulate a non-LLM failure by injecting a fetchPredictionBlock
  // that throws synchronously — production catches its rejection and
  // returns '', but a synchronous throw inside the call expression
  // bubbles up before the .catch() can attach. This proves the
  // negative-cache is gated on LLMScanError specifically.
  let llmCalls = 0
  const localFailingDeps: MarketScanDeps = {
    runLLM: async () => {
      llmCalls += 1
      return {
        decision: {
          regime: 'UPTREND', setupScore: 6,
          timeframeAlignment: { '4h': 'BULLISH', '1h': 'BULLISH', '15m': 'BULLISH', volume: 'CONFIRMING' },
          action: 'HOLD', pair: 'BTCUSDT',
          entryZone: null, stopLoss: null, takeProfit: null,
          size: null, leverage: null, riskRewardRatio: null,
          confidence: 0.5, reasoning: 'r', keyRisks: [],
          memoryUpdate: null, drawdownMode: false, holdReason: 'h',
        } satisfies AgentDecision,
        rawResponse: '{}',
        providersTelemetry: null,
      }
    },
    fetchNewsBlock: async () => '',
    fetchPredictionBlock: (() => {
      // Synchronous throw — bypasses the .catch() that wraps the call.
      throw new Error('local prediction-fetch bug')
    }) as MarketScanDeps['fetchPredictionBlock'],
    swarmOn: false,
  }

  // First call: local error bubbles up.
  await assert.rejects(
    () => getSharedMarketScan(inputs('BTCUSDT'), localFailingDeps),
    /local prediction-fetch bug/,
  )
  assert.equal(llmCalls, 0, 'LLM not reached because local error fires first')

  // Replace the bad dep with a working one. If the previous failure had
  // been negative-cached, this would re-throw the cached error for the
  // full 60s cooldown. With local-error eviction it must succeed.
  const goodDeps: MarketScanDeps = {
    ...localFailingDeps,
    fetchPredictionBlock: async () => '',
  }
  const r = await getSharedMarketScan(inputs('BTCUSDT'), goodDeps)
  assert.equal(r.decision.action, 'HOLD', 'second call must succeed — local error must not have poisoned the cache')
  assert.equal(llmCalls, 1, 'LLM fires exactly once on the recovery call')
})

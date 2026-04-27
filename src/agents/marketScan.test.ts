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
test('a rejected LLM call evicts the cache so the next tick can retry', async () => {
  _resetMarketScanCacheForTest()
  let calls = 0
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
  }

  await assert.rejects(
    () => getSharedMarketScan(inputs('BTCUSDT'), failingDeps),
    /upstream model down/,
  )

  // Second call should NOT serve the rejected promise — it must retry.
  const r = await getSharedMarketScan(inputs('BTCUSDT'), failingDeps)
  assert.equal(r.decision.action, 'HOLD')
  assert.equal(calls, 2, 'failing call must evict cache so retry actually fires the LLM')
})

// ─── pair always echoed ──────────────────────────────────────────────────────
test('returned decision.pair is always the requested pair, regardless of LLM output', async () => {
  _resetMarketScanCacheForTest()
  const llm = makeStubLLM({ pair: 'TYPO_FROM_LLM' })
  const r = await getSharedMarketScan(inputs('SOLUSDT'), deps(llm))
  assert.equal(r.decision.pair, 'SOLUSDT')
})

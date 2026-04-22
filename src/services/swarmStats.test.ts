import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatSwarmStats, getSwarmStats, type SwarmStatsReport } from './swarmStats'

test('formatSwarmStats renders empty state', () => {
  const out = formatSwarmStats({ window: '24h', since: new Date(), rows: [] })
  assert.match(out, /No swarm telemetry/)
  assert.match(out, /last 24h/)
})

test('formatSwarmStats renders per-provider rows + totals', () => {
  const report: SwarmStatsReport = {
    window: '7d',
    since: new Date(),
    rows: [
      {
        provider: 'anthropic',
        callCount: 100,
        inputTokens: 1_500_000,
        outputTokens: 500_000,
        totalTokens: 2_000_000,
        medianLatencyMs: 1234,
        // 1.5M * $3 + 0.5M * $15 = 4.5 + 7.5 = $12
        estimatedUsd: 12,
        costRate: { input: 3, output: 15 },
      },
      {
        provider: 'xai',
        callCount: 80,
        inputTokens: 400_000,
        outputTokens: 100_000,
        totalTokens: 500_000,
        medianLatencyMs: 800,
        // 0.4M * $0.3 + 0.1M * $0.5 = 0.12 + 0.05 = $0.17
        estimatedUsd: 0.17,
        costRate: { input: 0.3, output: 0.5 },
      },
    ],
  }
  const out = formatSwarmStats(report)
  assert.match(out, /last 7d/)
  assert.match(out, /\*anthropic\* — 100 calls/)
  assert.match(out, /1234ms/)
  assert.match(out, /\$12\.00/)
  assert.match(out, /\$3in\/\$15out per Mtok/)
  assert.match(out, /\*xai\* — 80 calls/)
  assert.match(out, /\$0\.1700/)
  // totals line
  assert.match(out, /Total: 180 calls/)
  assert.match(out, /\$12\.17/)
})

test('getSwarmStats reads only AgentLog (not OutcomePosition) and computes USD with split rates', async () => {
  let capturedSql = ''
  const report = await getSwarmStats('24h', {
    query: async (sql) => {
      capturedSql = sql
      return [
        // anthropic: 1M input @ $3 + 0.5M output @ $15 = $3 + $7.5 = $10.5
        { provider: 'anthropic', call_count: 3n, input_tokens: 1_000_000n, output_tokens: 500_000n, median_latency_ms: 900 },
        { provider: 'xai', call_count: 2n, input_tokens: 400_000n, output_tokens: 100_000n, median_latency_ms: 1500 },
      ]
    },
    loadCostRates: async () => [],
  })
  assert.match(capturedSql, /FROM "AgentLog"/)
  assert.doesNotMatch(capturedSql, /OutcomePosition/)
  assert.match(capturedSql, /interval '24 hours'/)
  // Must extract input/output split AND fall back to tokens_used when both
  // input_tokens and output_tokens are absent from the JSONB row (legacy
  // telemetry written before Task #24). Legacy rows are split 70/30
  // input/output so historical USD doesn't get inflated by attributing
  // everything to the more-expensive output bucket (Task #36).
  assert.match(capturedSql, /inputTokens/)
  assert.match(capturedSql, /outputTokens/)
  assert.match(capturedSql, /tokens_used/)
  assert.match(capturedSql, /tokens_used, 0\) \* 0\.7/)
  assert.match(capturedSql, /tokens_used, 0\) \* 0\.3/)

  const anthropic = report.rows.find((r) => r.provider === 'anthropic')
  assert.ok(anthropic)
  assert.equal(anthropic.callCount, 3)
  assert.equal(anthropic.inputTokens, 1_000_000)
  assert.equal(anthropic.outputTokens, 500_000)
  assert.equal(anthropic.totalTokens, 1_500_000)
  assert.equal(anthropic.medianLatencyMs, 900)
  // 1M * $3 + 0.5M * $15 = $10.50
  assert.equal(anthropic.estimatedUsd, 10.5)
  assert.deepEqual(anthropic.costRate, { input: 3, output: 15 })
})

test('SWARM_COST_USD_PER_MTOKENS env override accepts both number (legacy) and {input,output}', async () => {
  process.env.SWARM_COST_USD_PER_MTOKENS = JSON.stringify({
    anthropic: { input: 5, output: 25 },
    xai: 0.2, // legacy bare-number form: same rate both sides
  })
  try {
    const report = await getSwarmStats('24h', {
      query: async () => [
        { provider: 'anthropic', call_count: 1n, input_tokens: 1_000_000n, output_tokens: 1_000_000n, median_latency_ms: 100 },
        { provider: 'xai', call_count: 1n, input_tokens: 1_000_000n, output_tokens: 1_000_000n, median_latency_ms: 100 },
      ],
    })
    const anthropic = report.rows.find((r) => r.provider === 'anthropic')!
    // 1M * $5 + 1M * $25 = $30
    assert.equal(anthropic.estimatedUsd, 30)
    assert.deepEqual(anthropic.costRate, { input: 5, output: 25 })
    const xai = report.rows.find((r) => r.provider === 'xai')!
    // 1M * $0.2 + 1M * $0.2 = $0.40
    assert.equal(xai.estimatedUsd, 0.4)
    assert.deepEqual(xai.costRate, { input: 0.2, output: 0.2 })
  } finally {
    delete process.env.SWARM_COST_USD_PER_MTOKENS
  }
})

test('getSwarmStats prefers DB cost rates over hardcoded defaults', async () => {
  const report = await getSwarmStats('24h', {
    query: async () => [
      { provider: 'anthropic', call_count: 1n, input_tokens: 0n, output_tokens: 1_000_000n, median_latency_ms: 100 },
      { provider: 'newprov', call_count: 1n, input_tokens: 0n, output_tokens: 1_000_000n, median_latency_ms: 50 },
    ],
    loadCostRates: async () => [
      { provider: 'anthropic', usdPer1MTokens: 9.5 },
      { provider: 'newprov', usdPer1MTokens: 1.25 },
    ],
  })
  const anthropic = report.rows.find((r) => r.provider === 'anthropic')!
  const newprov = report.rows.find((r) => r.provider === 'newprov')!
  // DB row overrides the default rate; the single number stored in
  // ProviderCostRate is applied as a flat input==output rate.
  assert.deepEqual(anthropic.costRate, { input: 9.5, output: 9.5 })
  assert.equal(anthropic.estimatedUsd, 9.5)
  // Brand-new provider gets a non-zero flat rate from the DB.
  assert.deepEqual(newprov.costRate, { input: 1.25, output: 1.25 })
  assert.equal(newprov.estimatedUsd, 1.25)
})

test('getSwarmStats falls back to defaults when DB lookup throws', async () => {
  const report = await getSwarmStats('24h', {
    query: async () => [
      { provider: 'anthropic', call_count: 1n, input_tokens: 1_000_000n, output_tokens: 1_000_000n, median_latency_ms: 1 },
    ],
    loadCostRates: async () => {
      throw new Error('db down')
    },
  })
  const anthropic = report.rows.find((r) => r.provider === 'anthropic')!
  // Defaults: anthropic { input: 3, output: 15 }
  assert.deepEqual(anthropic.costRate, { input: 3, output: 15 })
  assert.equal(anthropic.estimatedUsd, 18)
})

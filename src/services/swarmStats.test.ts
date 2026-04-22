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
      { provider: 'anthropic', callCount: 100, totalTokens: 2_000_000, medianLatencyMs: 1234, estimatedUsd: 12, costRate: 6 },
      { provider: 'xai', callCount: 80, totalTokens: 500_000, medianLatencyMs: 800, estimatedUsd: 0.2, costRate: 0.4 },
    ],
  }
  const out = formatSwarmStats(report)
  assert.match(out, /last 7d/)
  assert.match(out, /\*anthropic\* — 100 calls/)
  assert.match(out, /1234ms/)
  assert.match(out, /\$12\.00/)
  assert.match(out, /@\$6\/Mtok/)
  assert.match(out, /\*xai\* — 80 calls/)
  assert.match(out, /\$0\.2000/)
  // totals line
  assert.match(out, /Total: 180 calls/)
  assert.match(out, /\$12\.20/)
})

test('getSwarmStats reads only AgentLog (not OutcomePosition) and computes USD', async () => {
  let capturedSql = ''
  const report = await getSwarmStats('24h', {
    query: async (sql) => {
      capturedSql = sql
      return [
        { provider: 'anthropic', call_count: 3n, total_tokens: 1_500_000n, median_latency_ms: 900 },
        { provider: 'xai', call_count: 2n, total_tokens: 500_000n, median_latency_ms: 1500 },
      ]
    },
  })
  assert.match(capturedSql, /FROM "AgentLog"/)
  assert.doesNotMatch(capturedSql, /OutcomePosition/)
  assert.match(capturedSql, /interval '24 hours'/)

  const anthropic = report.rows.find((r) => r.provider === 'anthropic')
  assert.ok(anthropic)
  assert.equal(anthropic.callCount, 3)
  assert.equal(anthropic.totalTokens, 1_500_000)
  assert.equal(anthropic.medianLatencyMs, 900)
  // 1.5M tokens * $6/Mtok = $9
  assert.equal(anthropic.estimatedUsd, 9)
})

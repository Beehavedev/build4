import { db } from '../db'

/**
 * Per-provider roll-ups computed from swarm telemetry persisted on
 * `AgentLog.providers` (and `OutcomePosition.providers`). Each row in the
 * JSONB array has shape `{ provider, model, action, reasoning, latencyMs,
 * tokensUsed }` (Task #18). We unnest the array with `jsonb_array_elements`
 * and aggregate.
 *
 * Cost is *estimated* — we only store total tokens (not split into input vs
 * output), so the per-1M-token rates below are blended (~30% output / 70%
 * input). They live in code (not the DB) so adjusting them as pricing
 * changes is a one-line edit. Override via SWARM_COST_USD_PER_MTOKENS env
 * (JSON map keyed by provider) for ops without redeploying.
 */

export type Window = '24h' | '7d'

export interface ProviderRollup {
  provider: string
  callCount: number
  totalTokens: number
  medianLatencyMs: number
  estimatedUsd: number
  /** USD per 1M tokens used for the cost estimate (so the dashboard can show
   *  the assumed rate alongside the raw number). */
  costRate: number
}

export interface SwarmStatsReport {
  window: Window
  since: Date
  rows: ProviderRollup[]
}

const DEFAULT_COST_USD_PER_MTOKENS: Record<string, number> = {
  anthropic: 6.0,
  xai: 0.4,
  hyperbolic: 0.4,
  akash: 0.3,
}

function loadCostMap(): Record<string, number> {
  const raw = process.env.SWARM_COST_USD_PER_MTOKENS
  if (!raw) return DEFAULT_COST_USD_PER_MTOKENS
  try {
    const parsed = JSON.parse(raw) as Record<string, number>
    return { ...DEFAULT_COST_USD_PER_MTOKENS, ...parsed }
  } catch {
    return DEFAULT_COST_USD_PER_MTOKENS
  }
}

function windowToInterval(w: Window): { sql: string; ms: number } {
  if (w === '24h') return { sql: "interval '24 hours'", ms: 24 * 60 * 60 * 1000 }
  return { sql: "interval '7 days'", ms: 7 * 24 * 60 * 60 * 1000 }
}

interface RawRollupRow {
  provider: string | null
  call_count: bigint | number
  total_tokens: bigint | number | null
  median_latency_ms: number | null
}

/**
 * Aggregate provider telemetry from `AgentLog.providers`.
 *
 * IMPORTANT: we deliberately read only from AgentLog (not OutcomePosition).
 * The trading agent writes one AgentLog row per tick, and when that tick
 * opens a prediction trade the *same* `providersTelemetry` array is also
 * mirrored onto the resulting OutcomePosition row. Aggregating both would
 * double-count every prediction-driving LLM call, inflating cost/speed
 * stats. AgentLog is the source of truth — every callLLM produces exactly
 * one entry there.
 */
export async function getSwarmStats(
  window: Window,
  deps: { query?: (sql: string) => Promise<RawRollupRow[]> } = {},
): Promise<SwarmStatsReport> {
  const { sql: intervalSql, ms } = windowToInterval(window)
  const since = new Date(Date.now() - ms)

  const sql = `
    WITH telemetry AS (
      SELECT
        (elem->>'provider') AS provider,
        NULLIF(elem->>'latencyMs', '')::float AS latency_ms,
        NULLIF(elem->>'tokensUsed', '')::float AS tokens_used
      FROM "AgentLog",
           LATERAL jsonb_array_elements("providers") AS elem
      WHERE "providers" IS NOT NULL
        AND "createdAt" >= NOW() - ${intervalSql}
    )
    SELECT
      provider,
      COUNT(*)::bigint                                       AS call_count,
      COALESCE(SUM(tokens_used), 0)::bigint                  AS total_tokens,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::float AS median_latency_ms
    FROM telemetry
    WHERE provider IS NOT NULL
    GROUP BY provider
    ORDER BY call_count DESC
  `

  const runQuery = deps.query ?? ((q: string) => db.$queryRawUnsafe<RawRollupRow[]>(q))
  const raw = await runQuery(sql)
  const costs = loadCostMap()

  const rows: ProviderRollup[] = raw.map((r) => {
    const provider = r.provider ?? 'unknown'
    const totalTokens = Number(r.total_tokens ?? 0)
    const rate = costs[provider] ?? 0
    return {
      provider,
      callCount: Number(r.call_count ?? 0),
      totalTokens,
      medianLatencyMs: Math.round(Number(r.median_latency_ms ?? 0)),
      estimatedUsd: (totalTokens / 1_000_000) * rate,
      costRate: rate,
    }
  })

  return { window, since, rows }
}

export function formatSwarmStats(report: SwarmStatsReport): string {
  if (report.rows.length === 0) {
    return `*Swarm stats — last ${report.window}*\n\n_No swarm telemetry recorded yet in this window._`
  }
  const lines: string[] = [`*Swarm stats — last ${report.window}*`, '']
  let totalCalls = 0
  let totalTokens = 0
  let totalUsd = 0
  for (const r of report.rows) {
    totalCalls += r.callCount
    totalTokens += r.totalTokens
    totalUsd += r.estimatedUsd
    const usd = r.estimatedUsd >= 1 ? r.estimatedUsd.toFixed(2) : r.estimatedUsd.toFixed(4)
    lines.push(`*${r.provider}* — ${r.callCount} calls`)
    lines.push(
      `  median ${r.medianLatencyMs}ms · ${r.totalTokens.toLocaleString()} tokens · ~$${usd} (@$${r.costRate}/Mtok)`,
    )
  }
  lines.push('')
  lines.push(
    `_Total: ${totalCalls} calls · ${totalTokens.toLocaleString()} tokens · ~$${totalUsd.toFixed(2)}_`,
  )
  return lines.join('\n')
}

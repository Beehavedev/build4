import { db } from '../db'

/**
 * Per-provider roll-ups computed from swarm telemetry persisted on
 * `AgentLog.providers` (and `OutcomePosition.providers`). Each row in the
 * JSONB array has shape `{ provider, model, action, reasoning, latencyMs,
 * inputTokens, outputTokens, tokensUsed }` (Task #18 + Task #24).
 *
 * Cost is computed using SEPARATE per-1M-token rates for input vs output,
 * because real provider pricing charges output tokens at 3-5x the input
 * rate. Telemetry rows written before Task #24 only carry `tokensUsed`
 * (no split); for those we apply a 70/30 input-vs-output split — the
 * typical mix for our trading-agent prompts (long context in, short
 * structured decision out) — so historical USD on `/swarmstats` matches
 * the old blended rate instead of being inflated by attributing the
 * entire legacy total to the more-expensive output bucket. See Task #36.
 *
 * Resolution order (lowest → highest precedence):
 *   1. DEFAULT_COST_USD_PER_MTOKENS (in code, split { input, output })
 *   2. SWARM_COST_USD_PER_MTOKENS env (JSON map keyed by provider; value
 *      may be a bare number — back-compat, applied as flat rate to both
 *      sides — or `{ input, output }`)
 *   3. Rows in the ProviderCostRate table (admin UI — Task #23). The
 *      table only stores a single `usdPer1MTokens` number per provider,
 *      so a DB override is applied as a FLAT rate to both input and
 *      output. Use the env var if you need an asymmetric override.
 */

export type Window = '24h' | '7d' | '30d' | 'today' | 'mtd' | 'ytd'

export interface CostRate {
  input: number
  output: number
}

export interface ProviderRollup {
  provider: string
  callCount: number
  inputTokens: number
  outputTokens: number
  /** Sum of input + output. Kept so older dashboards still render. */
  totalTokens: number
  medianLatencyMs: number
  estimatedUsd: number
  /** Per-1M-token USD rates used for the cost estimate (so the dashboard can
   *  show the assumed rates alongside the raw number). */
  costRate: CostRate
}

export interface SwarmStatsReport {
  window: Window
  since: Date
  rows: ProviderRollup[]
  quorum?: SwarmQuorumStats
}

/** Quorum-vs-no-quorum breakdown across the same window as the per-provider
 *  roll-up. Operators look at `noQuorumRate` to spot regressions where the
 *  swarm chronically disagrees and silently falls back to Anthropic.
 *  - `swarmTicks` = AgentLog rows with `providers IS NOT NULL`
 *  - `noQuorumTicks` = subset whose rawResponse starts with the
 *    `[swarm-no-quorum,` tag emitted by tradingAgent.runDecisionLLM.
 */
export interface SwarmQuorumStats {
  swarmTicks: number
  noQuorumTicks: number
  quorumTicks: number
  noQuorumRate: number
}

export const DEFAULT_COST_USD_PER_MTOKENS: Record<string, CostRate> = {
  // Anthropic Sonnet pricing (~$3 input / $15 output per Mtok).
  anthropic: { input: 3, output: 15 },
  // xAI Grok-3-mini pricing (~$0.30 input / $0.50 output per Mtok).
  xai: { input: 0.3, output: 0.5 },
  // Hyperbolic flat-rate; same number for both sides.
  hyperbolic: { input: 0.4, output: 0.4 },
  // Akash flat-rate; same number for both sides.
  akash: { input: 0.3, output: 0.3 },
}

function loadEnvCostMap(): Record<string, CostRate> {
  const raw = process.env.SWARM_COST_USD_PER_MTOKENS
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, CostRate | number>
    const out: Record<string, CostRate> = {}
    for (const [provider, value] of Object.entries(parsed)) {
      // Back-compat: a bare number means "same rate for both sides" (the
      // old blended-rate format). Lets ops keep their existing env var
      // working while the split rolls out.
      if (typeof value === 'number') {
        out[provider] = { input: value, output: value }
      } else if (value && typeof value === 'object') {
        const fallback = DEFAULT_COST_USD_PER_MTOKENS[provider]
        out[provider] = {
          input: typeof value.input === 'number' ? value.input : fallback?.input ?? 0,
          output: typeof value.output === 'number' ? value.output : fallback?.output ?? 0,
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

interface CostRateRow {
  provider: string
  usdPer1MTokens: number | string
}

async function loadCostMap(
  loadDbRows: () => Promise<CostRateRow[]> = defaultLoadDbRows,
): Promise<Record<string, CostRate>> {
  const merged: Record<string, CostRate> = {
    ...DEFAULT_COST_USD_PER_MTOKENS,
    ...loadEnvCostMap(),
  }
  try {
    const rows = await loadDbRows()
    for (const row of rows) {
      const n = Number(row.usdPer1MTokens)
      // DB stores a single number per provider; apply it as a flat rate
      // to both sides (env var supports the asymmetric form if needed).
      if (Number.isFinite(n) && n >= 0) merged[row.provider] = { input: n, output: n }
    }
  } catch (err) {
    console.warn('[swarmStats] DB cost-rate lookup failed, falling back to env/defaults:', err)
  }
  return merged
}

async function defaultLoadDbRows(): Promise<CostRateRow[]> {
  return db.$queryRawUnsafe<CostRateRow[]>(
    'SELECT "provider", "usdPer1MTokens" FROM "ProviderCostRate"',
  )
}

function windowToInterval(w: Window): { sinceSql: string; since: Date; ms: number } {
  const now = new Date()
  let since: Date
  if (w === '24h') {
    since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  } else if (w === '7d') {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  } else if (w === '30d') {
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  } else if (w === 'today') {
    since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  } else if (w === 'mtd') {
    since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  } else {
    since = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
  }
  return {
    sinceSql: `'${since.toISOString()}'::timestamptz`,
    since,
    ms: now.getTime() - since.getTime(),
  }
}

interface RawRollupRow {
  provider: string | null
  call_count: bigint | number
  input_tokens: bigint | number | null
  output_tokens: bigint | number | null
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
 *
 * Backfill behaviour: telemetry rows written before Task #24 only carry
 * `tokensUsed` (no input/output split). The SQL splits those legacy
 * totals 70/30 between input and output, so they're billed at a sensible
 * blended rate instead of the full output rate (Task #36).
 */
interface RawQuorumRow {
  swarm_ticks: bigint | number
  no_quorum_ticks: bigint | number
}

export async function getSwarmQuorumStats(
  window: Window,
  deps: { query?: (sql: string) => Promise<RawQuorumRow[]> } = {},
): Promise<SwarmQuorumStats> {
  const { sinceSql } = windowToInterval(window)
  const sql = `
    SELECT
      COUNT(*) FILTER (WHERE "providers" IS NOT NULL)::bigint AS swarm_ticks,
      COUNT(*) FILTER (
        WHERE "providers" IS NOT NULL
          AND "rawResponse" LIKE '[swarm-no-quorum,%'
      )::bigint AS no_quorum_ticks
    FROM "AgentLog"
    WHERE "createdAt" >= ${sinceSql}
  `
  const runQuery = deps.query ?? ((q: string) => db.$queryRawUnsafe<RawQuorumRow[]>(q))
  const raw = await runQuery(sql)
  const row = raw[0] ?? { swarm_ticks: 0, no_quorum_ticks: 0 }
  const swarmTicks = Number(row.swarm_ticks ?? 0)
  const noQuorumTicks = Number(row.no_quorum_ticks ?? 0)
  const quorumTicks = Math.max(0, swarmTicks - noQuorumTicks)
  return {
    swarmTicks,
    noQuorumTicks,
    quorumTicks,
    noQuorumRate: swarmTicks > 0 ? noQuorumTicks / swarmTicks : 0,
  }
}

export async function getSwarmStats(
  window: Window,
  deps: {
    query?: (sql: string) => Promise<RawRollupRow[]>
    loadCostRates?: () => Promise<CostRateRow[]>
    quorumQuery?: (sql: string) => Promise<RawQuorumRow[]>
  } = {},
): Promise<SwarmStatsReport> {
  const { sinceSql, since } = windowToInterval(window)

  const sql = `
    WITH telemetry AS (
      SELECT
        (elem->>'provider') AS provider,
        NULLIF(elem->>'latencyMs', '')::float AS latency_ms,
        NULLIF(elem->>'inputTokens', '')::float AS input_tokens,
        NULLIF(elem->>'outputTokens', '')::float AS output_tokens,
        NULLIF(elem->>'tokensUsed', '')::float AS tokens_used
      FROM "AgentLog",
           LATERAL jsonb_array_elements("providers") AS elem
      WHERE "providers" IS NOT NULL
        -- Defensive: jsonb_array_elements raises 22023 ("cannot extract
        -- elements from a scalar") if a row stored a JSONB scalar (null,
        -- object, string, …) instead of an array. SQL NULL filters those
        -- out via IS NOT NULL, but JSONB-null/object are NOT NULL in SQL
        -- terms, so we must additionally check the JSON type. A single
        -- malformed legacy row was crashing /api/swarm/stats in prod.
        AND jsonb_typeof("providers") = 'array'
        AND "createdAt" >= ${sinceSql}
    )
    SELECT
      provider,
      COUNT(*)::bigint                                       AS call_count,
      COALESCE(SUM(
        CASE
          -- Legacy telemetry (Task #36): no input/output split, so
          -- attribute 70% of the combined tokens_used to input.
          WHEN input_tokens IS NULL AND output_tokens IS NULL THEN COALESCE(tokens_used, 0) * 0.7
          ELSE COALESCE(input_tokens, 0)
        END
      ), 0)::bigint                                          AS input_tokens,
      COALESCE(SUM(
        CASE
          -- Legacy telemetry (Task #36): remaining 30% goes to output.
          WHEN input_tokens IS NULL AND output_tokens IS NULL THEN COALESCE(tokens_used, 0) * 0.3
          ELSE COALESCE(output_tokens, 0)
        END
      ), 0)::bigint                                          AS output_tokens,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::float AS median_latency_ms
    FROM telemetry
    WHERE provider IS NOT NULL
    GROUP BY provider
    ORDER BY call_count DESC
  `

  const runQuery = deps.query ?? ((q: string) => db.$queryRawUnsafe<RawRollupRow[]>(q))
  const raw = await runQuery(sql)
  const costs = await loadCostMap(deps.loadCostRates)

  const rows: ProviderRollup[] = raw.map((r) => {
    const provider = r.provider ?? 'unknown'
    const inputTokens = Number(r.input_tokens ?? 0)
    const outputTokens = Number(r.output_tokens ?? 0)
    const rate = costs[provider] ?? { input: 0, output: 0 }
    const estimatedUsd =
      (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output
    return {
      provider,
      callCount: Number(r.call_count ?? 0),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      medianLatencyMs: Math.round(Number(r.median_latency_ms ?? 0)),
      estimatedUsd,
      costRate: rate,
    }
  })

  // Quorum stats use the same window. We compute them here (rather than
  // forcing every caller to make a second call) so the format helper and the
  // existing /swarmstats command both pick them up automatically.
  const quorum = await getSwarmQuorumStats(window, { query: deps.quorumQuery })

  return { window, since, rows, quorum }
}

function formatQuorumLine(q: SwarmQuorumStats): string {
  if (q.swarmTicks === 0) {
    return '_Quorum: no swarm ticks in window._'
  }
  const pct = (q.noQuorumRate * 100).toFixed(1)
  const flag = q.noQuorumRate >= 0.25 ? ' ⚠️' : ''
  return (
    `_Quorum: ${q.quorumTicks}/${q.swarmTicks} reached · ` +
    `${q.noQuorumTicks} no-quorum fallbacks (${pct}%)${flag}_`
  )
}

/**
 * Daily timeseries: one bucket per UTC day in the window. Used by the
 * AI Usage mini-app page to render the spend chart. Cost is computed
 * per-row using the same provider rate map as getSwarmStats so the
 * daily totals reconcile with the rolled-up window total.
 */
export interface DailyUsageBucket {
  date: string
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedUsd: number
}

interface RawDailyRow {
  day: Date | string
  provider: string | null
  call_count: bigint | number
  input_tokens: bigint | number | null
  output_tokens: bigint | number | null
}

export async function getDailyUsage(
  window: Window,
  deps: {
    query?: (sql: string) => Promise<RawDailyRow[]>
    loadCostRates?: () => Promise<CostRateRow[]>
  } = {},
): Promise<DailyUsageBucket[]> {
  const { sinceSql } = windowToInterval(window)
  const sql = `
    WITH telemetry AS (
      SELECT
        date_trunc('day', "createdAt" AT TIME ZONE 'UTC')::date AS day,
        (elem->>'provider') AS provider,
        NULLIF(elem->>'inputTokens', '')::float AS input_tokens,
        NULLIF(elem->>'outputTokens', '')::float AS output_tokens,
        NULLIF(elem->>'tokensUsed', '')::float AS tokens_used
      FROM "AgentLog",
           LATERAL jsonb_array_elements("providers") AS elem
      WHERE "providers" IS NOT NULL
        AND jsonb_typeof("providers") = 'array'
        AND "createdAt" >= ${sinceSql}
    )
    SELECT
      day,
      provider,
      COUNT(*)::bigint AS call_count,
      COALESCE(SUM(
        CASE
          WHEN input_tokens IS NULL AND output_tokens IS NULL THEN COALESCE(tokens_used, 0) * 0.7
          ELSE COALESCE(input_tokens, 0)
        END
      ), 0)::bigint AS input_tokens,
      COALESCE(SUM(
        CASE
          WHEN input_tokens IS NULL AND output_tokens IS NULL THEN COALESCE(tokens_used, 0) * 0.3
          ELSE COALESCE(output_tokens, 0)
        END
      ), 0)::bigint AS output_tokens
    FROM telemetry
    WHERE provider IS NOT NULL
    GROUP BY day, provider
    ORDER BY day ASC
  `
  const runQuery = deps.query ?? ((q: string) => db.$queryRawUnsafe<RawDailyRow[]>(q))
  const raw = await runQuery(sql)
  const costs = await loadCostMap(deps.loadCostRates)
  const buckets = new Map<string, DailyUsageBucket>()
  for (const r of raw) {
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10)
    const provider = r.provider ?? 'unknown'
    const inT = Number(r.input_tokens ?? 0)
    const outT = Number(r.output_tokens ?? 0)
    const rate = costs[provider] ?? { input: 0, output: 0 }
    const usd = (inT / 1_000_000) * rate.input + (outT / 1_000_000) * rate.output
    const existing = buckets.get(day) ?? {
      date: day, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsd: 0,
    }
    existing.calls += Number(r.call_count ?? 0)
    existing.inputTokens += inT
    existing.outputTokens += outT
    existing.totalTokens += inT + outT
    existing.estimatedUsd += usd
    buckets.set(day, existing)
  }
  return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date))
}

export function formatSwarmStats(report: SwarmStatsReport): string {
  if (report.rows.length === 0) {
    const base = `*Swarm stats — last ${report.window}*\n\n_No swarm telemetry recorded yet in this window._`
    if (report.quorum) return base + '\n' + formatQuorumLine(report.quorum)
    return base
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
      `  median ${r.medianLatencyMs}ms · ${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out tok · ~$${usd} (@$${r.costRate.input}in/$${r.costRate.output}out per Mtok)`,
    )
  }
  lines.push('')
  lines.push(
    `_Total: ${totalCalls} calls · ${totalTokens.toLocaleString()} tokens · ~$${totalUsd.toFixed(2)}_`,
  )
  if (report.quorum) {
    lines.push(formatQuorumLine(report.quorum))
  }
  return lines.join('\n')
}

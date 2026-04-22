/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * divergenceAnalysis.ts — shared swarm-divergence analytics.
 *
 * The CLI in `scripts/swarmDivergence.ts` and the scheduled job in
 * `src/agents/runner.ts` both call analyzeDivergence() so they stay in sync.
 * See scripts/swarmDivergence.ts for full background; in short, the swarm
 * fans every tick out across all configured providers and "falls back" when
 * the providers disagree (no quorum). This module quantifies that fallback
 * rate and surfaces pairs whose divergence has spiked.
 */
import { db } from '../db'

export interface DivergenceOptions {
  days: number
  pair?: string | null
  threshold?: number | null
  minSample?: number
}

export interface BucketRow {
  key: string
  total: number
  fallback: number
  fallbackPct: number
}

export interface DivergenceResult {
  sinceIso: string
  days: number
  pair: string | null
  overall: { total: number; fallback: number; fallbackPct: number }
  byPair: Array<{ pair: string; total: number; fallback: number; fallbackPct: number }>
  byParticipation: Array<{ providers: string; total: number; fallback: number; fallbackPct: number }>
  byProvider: Array<{ provider: string; total: number; fallback: number; fallbackPct: number }>
  byAgent: Array<{ agent: string; total: number; fallback: number; fallbackPct: number }>
  offenders: Array<{ pair: string; total: number; fallback: number; fallbackPct: number }>
  threshold: number | null
  minSample: number
}

interface RawRow {
  pair: string | null
  agentId: string | null
  agentName: string | null
  rawResponse: string | null
  reason: string | null
  providers: any
}

interface Bucket { total: number; fallback: number }
function newBucket(): Bucket { return { total: 0, fallback: 0 } }

function isFallback(rawResponse: string | null, reason: string | null): boolean {
  if (rawResponse && rawResponse.includes('swarm-no-quorum')) return true
  if (reason && reason.includes('swarm-no-quorum')) return true
  return false
}

function providerKey(providers: any): string {
  if (!Array.isArray(providers)) return '(unknown)'
  const names = providers
    .map((p) => (p && typeof p.provider === 'string' ? p.provider : null))
    .filter((s): s is string => !!s)
    .sort()
  return names.length ? names.join('+') : '(unknown)'
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10
}

/**
 * Thrown when the database is missing the swarm-telemetry columns. The
 * caller can decide whether that's fatal (CLI) or a no-op (cron in a
 * brand-new env where nobody has opted into the swarm yet).
 */
export class MissingProvidersColumnError extends Error {
  constructor() {
    super('AgentLog.providers column does not exist on this database')
    this.name = 'MissingProvidersColumnError'
  }
}

export async function analyzeDivergence(opts: DivergenceOptions): Promise<DivergenceResult> {
  const days = Math.max(1, opts.days)
  const threshold = opts.threshold ?? null
  const minSample = Math.max(1, opts.minSample ?? 10)
  const pair = opts.pair ? opts.pair.toUpperCase().replace(/[\/\s]/g, '') : null
  const since = new Date(Date.now() - days * 86_400_000)

  const where: string[] = [`al."providers" IS NOT NULL`, `al."createdAt" >= $1`]
  const params: any[] = [since]
  if (pair) {
    where.push(`UPPER(REPLACE(REPLACE(COALESCE(al."pair",''), '/', ''), ' ', '')) = $2`)
    params.push(pair)
  }
  const sql = `
    SELECT al."pair", al."agentId", a."name" AS "agentName",
           al."rawResponse", al."reason", al."providers"
    FROM "AgentLog" al
    LEFT JOIN "Agent" a ON a."id" = al."agentId"
    WHERE ${where.join(' AND ')}
  `

  let rows: RawRow[]
  try {
    rows = await db.$queryRawUnsafe<RawRow[]>(sql, ...params)
  } catch (err: any) {
    if (err?.meta?.code === '42703' || /column "providers" does not exist/i.test(String(err?.message ?? ''))) {
      throw new MissingProvidersColumnError()
    }
    throw err
  }

  const overall = newBucket()
  const byPair = new Map<string, Bucket>()
  const byParticipation = new Map<string, Bucket>()
  const byAgent = new Map<string, Bucket>()
  const byProvider = new Map<string, Bucket>()

  for (const r of rows) {
    const fallback = isFallback(r.rawResponse, r.reason)
    const part = providerKey(r.providers)
    const pairK = (r.pair ?? '(none)').toUpperCase()
    const agent = r.agentName ?? r.agentId ?? '(unknown)'

    overall.total++
    if (fallback) overall.fallback++

    let pb = byPair.get(pairK); if (!pb) byPair.set(pairK, (pb = newBucket()))
    pb.total++; if (fallback) pb.fallback++

    let pp = byParticipation.get(part); if (!pp) byParticipation.set(part, (pp = newBucket()))
    pp.total++; if (fallback) pp.fallback++

    let ag = byAgent.get(agent); if (!ag) byAgent.set(agent, (ag = newBucket()))
    ag.total++; if (fallback) ag.fallback++

    if (Array.isArray(r.providers)) {
      const seen = new Set<string>()
      for (const p of r.providers) {
        const name = p && typeof p.provider === 'string' ? p.provider : null
        if (!name || seen.has(name)) continue
        seen.add(name)
        let pb2 = byProvider.get(name); if (!pb2) byProvider.set(name, (pb2 = newBucket()))
        pb2.total++; if (fallback) pb2.fallback++
      }
    }
  }

  const byPairOut = [...byPair.entries()]
    .map(([p, b]) => ({ pair: p, total: b.total, fallback: b.fallback, fallbackPct: pct(b.fallback, b.total) }))
    .sort((a, b) => b.total - a.total)

  const offenders = threshold === null
    ? []
    : byPairOut.filter((r) => r.total >= minSample && r.fallbackPct >= threshold)

  return {
    sinceIso: since.toISOString(),
    days,
    pair,
    overall: { total: overall.total, fallback: overall.fallback, fallbackPct: pct(overall.fallback, overall.total) },
    byPair: byPairOut,
    byParticipation: [...byParticipation.entries()]
      .map(([providers, b]) => ({ providers, total: b.total, fallback: b.fallback, fallbackPct: pct(b.fallback, b.total) }))
      .sort((a, b) => b.total - a.total),
    byProvider: [...byProvider.entries()]
      .map(([provider, b]) => ({ provider, total: b.total, fallback: b.fallback, fallbackPct: pct(b.fallback, b.total) }))
      .sort((a, b) => b.total - a.total),
    byAgent: [...byAgent.entries()]
      .map(([agent, b]) => ({ agent, total: b.total, fallback: b.fallback, fallbackPct: pct(b.fallback, b.total) }))
      .sort((a, b) => b.total - a.total),
    offenders,
    threshold,
    minSample,
  }
}

export interface SampleOptions {
  days: number
  pair?: string | null
  provider?: string | null
  limit?: number
  onlyFallback?: boolean
}

export interface SampleProvider {
  provider: string
  model: string | null
  action: string | null
  confidence: number | null
  reasoning: string | null
  latencyMs: number | null
}

export interface DivergenceSample {
  id: string
  createdAt: string
  pair: string | null
  agent: string
  finalAction: string | null
  fallback: boolean
  reason: string | null
  providers: SampleProvider[]
}

export interface SamplesResult {
  sinceIso: string
  days: number
  pair: string | null
  provider: string | null
  onlyFallback: boolean
  limit: number
  samples: DivergenceSample[]
}

interface RawSampleRow extends RawRow {
  id: string
  createdAt: Date
  parsedAction: string | null
  action: string | null
}

export function normalizeSampleProvider(p: any): SampleProvider | null {
  if (!p || typeof p.provider !== 'string') return null
  const conf = typeof p.confidence === 'number'
    ? p.confidence
    : (p.predictionTrade && typeof p.predictionTrade.confidence === 'number' ? p.predictionTrade.confidence : null)
  const action = typeof p.action === 'string'
    ? p.action
    : (p.predictionTrade && typeof p.predictionTrade.action === 'string' ? p.predictionTrade.action : null)
  return {
    provider: p.provider,
    model: typeof p.model === 'string' ? p.model : null,
    action,
    confidence: conf,
    reasoning: typeof p.reasoning === 'string' ? p.reasoning : null,
    latencyMs: typeof p.latencyMs === 'number' ? p.latencyMs : null,
  }
}

/**
 * Returns recent AgentLog rows that contain swarm telemetry, optionally
 * filtered to a specific pair and/or to rows where a given provider
 * participated. Powers the admin drill-down: each row exposes what every
 * provider voted so operators can see why a pair diverged instead of just
 * knowing that it did.
 */
export async function getDivergenceSamples(opts: SampleOptions): Promise<SamplesResult> {
  const days = Math.max(1, opts.days)
  const limit = Math.min(200, Math.max(1, opts.limit ?? 25))
  const pair = opts.pair ? opts.pair.toUpperCase().replace(/[\/\s]/g, '') : null
  const provider = opts.provider ? opts.provider.trim() : null
  const onlyFallback = !!opts.onlyFallback
  const since = new Date(Date.now() - days * 86_400_000)

  const where: string[] = [`al."providers" IS NOT NULL`, `al."createdAt" >= $1`]
  const params: any[] = [since]
  if (pair) {
    where.push(`UPPER(REPLACE(REPLACE(COALESCE(al."pair",''), '/', ''), ' ', '')) = $${params.length + 1}`)
    params.push(pair)
  }
  // We do the provider filter in JS (the JSON shape varies) — but only after
  // pulling a wider window so the LIMIT still bites.
  const fetchLimit = provider ? Math.max(limit * 5, 100) : limit

  const sql = `
    SELECT al."id", al."createdAt", al."pair", al."agentId", a."name" AS "agentName",
           al."action", al."parsedAction", al."rawResponse", al."reason", al."providers"
    FROM "AgentLog" al
    LEFT JOIN "Agent" a ON a."id" = al."agentId"
    WHERE ${where.join(' AND ')}
    ORDER BY al."createdAt" DESC
    LIMIT ${fetchLimit}
  `

  let rows: RawSampleRow[]
  try {
    rows = await db.$queryRawUnsafe<RawSampleRow[]>(sql, ...params)
  } catch (err: any) {
    if (err?.meta?.code === '42703' || /column "providers" does not exist/i.test(String(err?.message ?? ''))) {
      throw new MissingProvidersColumnError()
    }
    throw err
  }

  const samples: DivergenceSample[] = []
  for (const r of rows) {
    if (samples.length >= limit) break
    const fallback = isFallback(r.rawResponse, r.reason)
    if (onlyFallback && !fallback) continue
    const providersList = Array.isArray(r.providers)
      ? r.providers.map(normalizeSampleProvider).filter((p): p is SampleProvider => !!p)
      : []
    if (provider && !providersList.some((p) => p.provider === provider)) continue
    samples.push({
      id: r.id,
      createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
      pair: r.pair,
      agent: r.agentName ?? r.agentId ?? '(unknown)',
      finalAction: r.parsedAction ?? r.action ?? null,
      fallback,
      reason: r.reason,
      providers: providersList,
    })
  }

  return {
    sinceIso: since.toISOString(),
    days,
    pair,
    provider,
    onlyFallback,
    limit,
    samples,
  }
}

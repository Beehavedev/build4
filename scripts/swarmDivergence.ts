/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * swarmDivergence.ts — admin analytics for the multi-provider swarm.
 *
 * When swarmEnabled=true the trading agent fans every tick out across all
 * configured providers (Anthropic, OpenAI, …). If at least `quorum` providers
 * agree on the same `action`, that consensus decision is used. Otherwise the
 * agent quietly falls back to the highest-confidence individual response and
 * tags the AgentLog row's rawResponse with `[swarm-no-quorum, used <provider>…`.
 *
 * This script reports how often that fallback fires, broken down by pair and
 * by which providers participated, so we can tell whether the swarm is adding
 * value or just adding cost.
 *
 * Usage:
 *   tsx scripts/swarmDivergence.ts                 # last 7d, all pairs
 *   tsx scripts/swarmDivergence.ts --days 30
 *   tsx scripts/swarmDivergence.ts --pair BTCUSDT
 *   tsx scripts/swarmDivergence.ts --threshold 50  # exit 2 if any pair's
 *                                                  # divergence% exceeds 50
 *   tsx scripts/swarmDivergence.ts --json          # machine-readable output
 *
 * Exit codes:
 *   0 — ran successfully, no alert triggered (or no threshold given)
 *   1 — error
 *   2 — at least one pair exceeded --threshold (alerting mode)
 */
import { db } from '../src/db'

type Args = {
  days: number
  pair: string | null
  threshold: number | null
  json: boolean
  minSample: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = { days: 7, pair: null, threshold: null, json: false, minSample: 10 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--days') out.days = Math.max(1, parseInt(next() ?? '7', 10) || 7)
    else if (a === '--pair') out.pair = (next() ?? '').toUpperCase().replace(/[\/\s]/g, '') || null
    else if (a === '--threshold') out.threshold = parseFloat(next() ?? '') || null
    else if (a === '--min-sample') out.minSample = Math.max(1, parseInt(next() ?? '10', 10) || 10)
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: tsx scripts/swarmDivergence.ts [--days N] [--pair SYM] [--threshold PCT] [--min-sample N] [--json]',
      )
      process.exit(0)
    }
  }
  return out
}

interface Row {
  pair: string | null
  agentId: string | null
  agentName: string | null
  rawResponse: string | null
  reason: string | null
  providers: any
}

interface Bucket {
  total: number
  fallback: number
  providerCounts: Record<string, number>
}

function newBucket(): Bucket {
  return { total: 0, fallback: 0, providerCounts: {} }
}

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

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const since = new Date(Date.now() - args.days * 86_400_000)

  const where: string[] = [`"providers" IS NOT NULL`, `"createdAt" >= $1`]
  const params: any[] = [since]
  if (args.pair) {
    where.push(`UPPER(REPLACE(REPLACE(COALESCE("pair",''), '/', ''), ' ', '')) = $2`)
    params.push(args.pair)
  }
  const sql = `
    SELECT al."pair", al."agentId", a."name" AS "agentName",
           al."rawResponse", al."reason", al."providers"
    FROM "AgentLog" al
    LEFT JOIN "Agent" a ON a."id" = al."agentId"
    WHERE ${where.map((w) => w.replace(/"providers"/g, 'al."providers"')
                              .replace(/"createdAt"/g, 'al."createdAt"')
                              .replace(/"pair"/g, 'al."pair"')).join(' AND ')}
  `
  let rows: Row[]
  try {
    rows = await db.$queryRawUnsafe<Row[]>(sql, ...params)
  } catch (err: any) {
    if (err?.meta?.code === '42703' || /column "providers" does not exist/i.test(String(err?.message ?? ''))) {
      console.error('[swarmDivergence] AgentLog.providers column missing on this database.')
      console.error('  This script needs the swarm-telemetry schema. Run prisma migrate / generate against a DB that has it.')
      process.exit(1)
    }
    throw err
  }

  const overall = newBucket()
  const byPair = new Map<string, Bucket>()
  const byParticipation = new Map<string, Bucket>()
  const byAgent = new Map<string, Bucket>()
  // Per-provider stats: how often this provider was in the swarm AND how often
  // the swarm hit no-quorum on those ticks (a proxy for "this provider tends
  // to disagree with the rest").
  const byProvider = new Map<string, Bucket>()

  for (const r of rows) {
    const fallback = isFallback(r.rawResponse, r.reason)
    const part = providerKey(r.providers)
    const pair = (r.pair ?? '(none)').toUpperCase()
    const agent = r.agentName ?? r.agentId ?? '(unknown)'

    overall.total++
    if (fallback) overall.fallback++

    let pb = byPair.get(pair); if (!pb) byPair.set(pair, (pb = newBucket()))
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

  const result = {
    sinceIso: since.toISOString(),
    days: args.days,
    pair: args.pair,
    overall: { total: overall.total, fallback: overall.fallback, fallbackPct: pct(overall.fallback, overall.total) },
    byPair: [...byPair.entries()]
      .map(([pair, b]) => ({ pair, total: b.total, fallback: b.fallback, fallbackPct: pct(b.fallback, b.total) }))
      .sort((a, b) => b.total - a.total),
    byParticipation: [...byParticipation.entries()]
      .map(([providers, b]) => ({ providers, total: b.total, fallback: b.fallback, fallbackPct: pct(b.fallback, b.total) }))
      .sort((a, b) => b.total - a.total),
    byProvider: [...byProvider.entries()]
      .map(([provider, b]) => ({ provider, total: b.total, fallback: b.fallback, fallbackPct: pct(b.fallback, b.total) }))
      .sort((a, b) => b.total - a.total),
    byAgent: [...byAgent.entries()]
      .map(([agent, b]) => ({ agent, total: b.total, fallback: b.fallback, fallbackPct: pct(b.fallback, b.total) }))
      .sort((a, b) => b.total - a.total),
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    const PAIR_W = 18, NUM_W = 10
    console.log(`\nSwarm divergence — last ${args.days}d (since ${result.sinceIso})${args.pair ? ` — pair ${args.pair}` : ''}`)
    console.log('─'.repeat(60))
    console.log(`Overall: ${overall.total} swarm ticks, ${overall.fallback} fell back to single-provider (${result.overall.fallbackPct}%)`)

    const printTable = (title: string, label: string, rows: { key: string; total: number; fallback: number; fallbackPct: number }[]) => {
      console.log(`\n${title}`)
      console.log(`  ${pad(label, PAIR_W)}${rpad('ticks', NUM_W)}${rpad('no-quorum', NUM_W + 2)}${rpad('%', NUM_W)}`)
      for (const r of rows) {
        const flag = args.threshold !== null && r.fallbackPct >= args.threshold && r.total >= args.minSample ? '  ⚠' : ''
        console.log(`  ${pad(r.key, PAIR_W)}${rpad(String(r.total), NUM_W)}${rpad(String(r.fallback), NUM_W + 2)}${rpad(r.fallbackPct.toFixed(1) + '%', NUM_W)}${flag}`)
      }
    }

    printTable('By pair:', 'pair', result.byPair.map((r) => ({ key: r.pair, ...r })))
    printTable('By provider participation:', 'providers', result.byParticipation.map((r) => ({ key: r.providers, ...r })))
    printTable('By individual provider:', 'provider', result.byProvider.map((r) => ({ key: r.provider, ...r })))
    printTable('By agent:', 'agent', result.byAgent.map((r) => ({ key: r.agent, ...r })))

    if (args.threshold !== null) {
      const offenders = result.byPair.filter((r) => r.total >= args.minSample && r.fallbackPct >= args.threshold!)
      if (offenders.length) {
        console.log(`\n⚠  ${offenders.length} pair(s) exceed --threshold ${args.threshold}% (min sample ${args.minSample}):`)
        for (const o of offenders) console.log(`   ${o.pair}: ${o.fallbackPct}% no-quorum across ${o.total} ticks`)
      } else {
        console.log(`\n✓ No pair exceeds --threshold ${args.threshold}% (min sample ${args.minSample}).`)
      }
    }
  }

  if (args.threshold !== null) {
    const offenders = result.byPair.filter((r) => r.total >= args.minSample && r.fallbackPct >= args.threshold!)
    if (offenders.length) process.exit(2)
  }
}

main()
  .catch((err) => {
    console.error('[swarmDivergence] error:', err)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect().catch(() => {})
  })

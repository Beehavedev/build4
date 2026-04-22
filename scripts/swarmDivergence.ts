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
 * The core query/aggregation logic lives in src/swarm/divergenceAnalysis.ts
 * so the scheduled job in src/agents/runner.ts can reuse it without spawning
 * a subprocess.
 *
 * Usage:
 *   tsx scripts/swarmDivergence.ts                 # last 7d, all pairs
 *   tsx scripts/swarmDivergence.ts --days 30
 *   tsx scripts/swarmDivergence.ts --pair BTCUSDT
 *   tsx scripts/swarmDivergence.ts --threshold 50  # exit 2 if any pair's
 *                                                  # divergence% exceeds 50
 *   tsx scripts/swarmDivergence.ts --json          # machine-readable output
 *   tsx scripts/swarmDivergence.ts --samples       # drill-down: per-tick
 *                                                  # provider votes (same data
 *                                                  # the admin mini-app shows)
 *   tsx scripts/swarmDivergence.ts --samples --pair BTCUSDT --provider openai \
 *       --only-fallback --limit 50
 *
 * Exit codes:
 *   0 — ran successfully, no alert triggered (or no threshold given)
 *   1 — error
 *   2 — at least one pair exceeded --threshold (alerting mode)
 */
import { db } from '../src/db'
import {
  analyzeDivergence,
  getDivergenceSamples,
  MissingProvidersColumnError,
  type DivergenceSample,
  type SamplesResult,
} from '../src/swarm/divergenceAnalysis'

type Args = {
  days: number
  pair: string | null
  threshold: number | null
  json: boolean
  minSample: number
  samples: boolean
  provider: string | null
  limit: number
  onlyFallback: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    days: 7,
    pair: null,
    threshold: null,
    json: false,
    minSample: 10,
    samples: false,
    provider: null,
    limit: 25,
    onlyFallback: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--days') out.days = Math.max(1, parseInt(next() ?? '7', 10) || 7)
    else if (a === '--pair') out.pair = (next() ?? '').toUpperCase().replace(/[\/\s]/g, '') || null
    else if (a === '--threshold') out.threshold = parseFloat(next() ?? '') || null
    else if (a === '--min-sample') out.minSample = Math.max(1, parseInt(next() ?? '10', 10) || 10)
    else if (a === '--json') out.json = true
    else if (a === '--samples') out.samples = true
    else if (a === '--provider') out.provider = (next() ?? '').trim() || null
    else if (a === '--limit') out.limit = Math.min(200, Math.max(1, parseInt(next() ?? '25', 10) || 25))
    else if (a === '--only-fallback') out.onlyFallback = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: tsx scripts/swarmDivergence.ts [--days N] [--pair SYM] [--threshold PCT] [--min-sample N] [--json]\n' +
        '       tsx scripts/swarmDivergence.ts --samples [--days N] [--pair SYM] [--provider NAME] [--limit N] [--only-fallback] [--json]',
      )
      process.exit(0)
    }
  }
  return out
}

function truncate(s: string | null, n: number): string {
  if (!s) return ''
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}

function printSamples(args: Args, result: SamplesResult): void {
  const filters = [
    `last ${args.days}d`,
    args.pair ? `pair ${args.pair}` : null,
    args.provider ? `provider ${args.provider}` : null,
    args.onlyFallback ? 'only no-quorum' : null,
  ].filter(Boolean).join(', ')
  console.log(`\nSwarm divergence samples — ${filters} (since ${result.sinceIso})`)
  console.log('─'.repeat(60))
  if (!result.samples.length) {
    console.log('(no matching samples)')
    return
  }
  console.log(`${result.samples.length} sample(s), newest first:\n`)
  for (const s of result.samples) {
    printSample(s)
  }
}

function printSample(s: DivergenceSample): void {
  const flag = s.fallback ? ' [no-quorum]' : ''
  const final = s.finalAction ?? '(none)'
  console.log(`• ${s.createdAt}  ${s.pair ?? '(none)'}  agent=${s.agent}  final=${final}${flag}`)
  if (s.reason) console.log(`    reason: ${truncate(s.reason, 120)}`)
  if (!s.providers.length) {
    console.log('    (no provider votes recorded)')
  } else {
    for (const p of s.providers) {
      const conf = p.confidence === null ? '   -' : rpad(p.confidence.toFixed(2), 4)
      const lat = p.latencyMs === null ? '-' : `${p.latencyMs}ms`
      const action = pad(p.action ?? '-', 6)
      console.log(`    - ${pad(p.provider, 12)} ${action} conf=${conf}  ${pad(p.model ?? '-', 22)} ${lat}`)
      if (p.reasoning) console.log(`        ${truncate(p.reasoning, 100)}`)
    }
  }
  console.log('')
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.samples) {
    let samples: SamplesResult
    try {
      samples = await getDivergenceSamples({
        days: args.days,
        pair: args.pair,
        provider: args.provider,
        limit: args.limit,
        onlyFallback: args.onlyFallback,
      })
    } catch (err) {
      if (err instanceof MissingProvidersColumnError) {
        console.error('[swarmDivergence] AgentLog.providers column missing on this database.')
        console.error('  This script needs the swarm-telemetry schema. Run prisma migrate / generate against a DB that has it.')
        process.exit(1)
      }
      throw err
    }
    if (args.json) {
      console.log(JSON.stringify(samples, null, 2))
    } else {
      printSamples(args, samples)
    }
    return
  }

  let result
  try {
    result = await analyzeDivergence({
      days: args.days,
      pair: args.pair,
      threshold: args.threshold,
      minSample: args.minSample,
    })
  } catch (err) {
    if (err instanceof MissingProvidersColumnError) {
      console.error('[swarmDivergence] AgentLog.providers column missing on this database.')
      console.error('  This script needs the swarm-telemetry schema. Run prisma migrate / generate against a DB that has it.')
      process.exit(1)
    }
    throw err
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    const PAIR_W = 18, NUM_W = 10
    console.log(`\nSwarm divergence — last ${args.days}d (since ${result.sinceIso})${args.pair ? ` — pair ${args.pair}` : ''}`)
    console.log('─'.repeat(60))
    console.log(`Overall: ${result.overall.total} swarm ticks, ${result.overall.fallback} fell back to single-provider (${result.overall.fallbackPct}%)`)

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
      if (result.offenders.length) {
        console.log(`\n⚠  ${result.offenders.length} pair(s) exceed --threshold ${args.threshold}% (min sample ${args.minSample}):`)
        for (const o of result.offenders) console.log(`   ${o.pair}: ${o.fallbackPct}% no-quorum across ${o.total} ticks`)
      } else {
        console.log(`\n✓ No pair exceeds --threshold ${args.threshold}% (min sample ${args.minSample}).`)
      }
    }
  }

  if (args.threshold !== null && result.offenders.length) process.exit(2)
}

main()
  .catch((err) => {
    console.error('[swarmDivergence] error:', err)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect().catch(() => {})
  })

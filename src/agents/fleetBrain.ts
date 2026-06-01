/**
 * Community Trading Fleet — 4-LLM quorum "brain" (opt-in).
 *
 * Wires the existing swarm (src/swarm/swarm.ts → runSwarmDecision) into the
 * fleet's mechanical engine as a CONFIRM/VETO layer:
 *   • Entry — after the cheap mechanical pickCandidate selects ONE token, the
 *     swarm confirms (BUY) or vetoes (SKIP) it. Fail-safe: anything other than
 *     a real BUY quorum (SKIP consensus, no consensus, no live providers) means
 *     DON'T buy — the brain can only ever REMOVE a mechanical buy, never add one.
 *   • Exit — the swarm may add a SELL signal when it sees momentum dying. It can
 *     only ever ADD a sell on quorum; absence (HOLD / no consensus / no
 *     providers) defers to the mechanical layer. Hard stop-loss, take-profit and
 *     the global kill-switch are evaluated mechanically and ALWAYS override the
 *     brain — the swarm never blocks a protective exit.
 *
 * COST CONTROL. 50 agents × 4 LLMs/tick would be real money, so:
 *   • The whole layer is gated by FLEET_SWARM_ENABLED (env, default off) AND a
 *     per-agent swarm_enabled flag (default off). With either off, this module
 *     is never called and there is zero cost / behavior change.
 *   • Verdicts are cached per TOKEN (not per agent) for FLEET_SWARM_VERDICT_TTL_SEC
 *     so when several agents converge on the same hot token, the swarm runs ONCE
 *     and the verdict is shared. Prompts are deliberately TOKEN-LEVEL only (no
 *     per-position PnL) so a shared verdict is always valid; per-position PnL is
 *     handled entirely by the mechanical TP/SL/trailing layer.
 */

import { runSwarmDecision, type SwarmResult } from '../swarm/swarm'
import { getProviderStatus, type Provider } from '../services/inference'

/** Master env gate. With this off the brain is never consulted. */
export function isFleetSwarmEnabled(): boolean {
  return process.env.FLEET_SWARM_ENABLED === 'true'
}

const VERDICT_TTL_SEC = Math.max(15, Math.round(Number(process.env.FLEET_SWARM_VERDICT_TTL_SEC) || 120))
const SWARM_TIMEOUT_MS = Math.max(5_000, Math.round(Number(process.env.FLEET_SWARM_TIMEOUT_MS) || 20_000))
const SWARM_QUORUM = Math.max(2, Math.round(Number(process.env.FLEET_SWARM_QUORUM) || 2))

// Test seam — the concurrency/routing tests stub the swarm + provider list here
// so they never hit a real LLM. Production calls through these indirections.
export const __brainTestDeps = {
  runSwarmDecision,
  getProviderStatus,
}

export type EntryAction = 'BUY' | 'SKIP'
export type ExitAction = 'HOLD' | 'SELL'

interface EntryDecision extends Record<string, unknown> {
  action: EntryAction
  confidence: number
  reasoning: string
}
interface ExitDecision extends Record<string, unknown> {
  action: ExitAction
  confidence: number
  reasoning: string
}

/** One provider's vote, surfaced to the /fleet feed. */
export interface ProviderVote {
  provider: string
  model: string
  ok: boolean
  action: string | null
  reasoning: string | null
  error: string | null
}

export interface FleetVerdict<A extends string> {
  /** Quorum action, or null when no consensus / swarm couldn't run. */
  action: A | null
  confidence: number | null
  /** Short one-line summary for the trade `reason` column. */
  summary: string
  /** Per-provider votes for the brain feed (logFleet meta). */
  votes: ProviderVote[]
  /** e.g. "3/4 BUY". */
  agreement: string
  /** Live providers consulted this verdict. */
  providers: string[]
  reason: 'ok' | 'no_providers' | 'no_quorum'
}

// ── Token-level context passed in by the engine ──────────────────────────

export interface EntryContext {
  tokenAddress: string
  symbol?: string | null
  version?: number | null
  trustScore: number
  fillPct: number          // 0..1
  fundsBnb: number
  buyerCount: number
  buyCount: number
  sellCount: number
  volumeBnb: number
  devHoldsPct: number
  ageMinutes?: number | null
}

export interface ExitContext {
  tokenAddress: string
  symbol?: string | null
  venue: 'fourmeme' | 'pancake'
  fillPct: number          // 0..1 (curve only; ~1 post-grad)
  graduated: boolean
}

// ── Prompts ──────────────────────────────────────────────────────────────

const ENTRY_SYSTEM =
  'You are a conservative risk filter for an automated memecoin trading fleet on BSC ' +
  '(four.meme bonding-curve launches). You are given on-chain metrics for one freshly-detected ' +
  'token that already passed mechanical screening. Decide BUY only if the launch looks organic ' +
  'with genuine momentum and acceptable rug risk; otherwise SKIP. Prefer SKIP when in doubt — ' +
  'a missed launch is cheap, a rug is not. Respond with ONLY a JSON object: ' +
  '{"action":"BUY"|"SKIP","confidence":0..1,"reasoning":"<=2 short sentences"}.'

const EXIT_SYSTEM =
  'You manage exits for an automated memecoin trading fleet on BSC. You are given the current ' +
  'on-chain state of a token the fleet already holds. Mechanical stop-loss, take-profit and a ' +
  'trailing stop run SEPARATELY and will protect the position — your job is only to flag an early ' +
  'SELL when you see momentum clearly dying, distribution/dumping, or fresh rug risk. Otherwise ' +
  'HOLD and let the position ride. Respond with ONLY a JSON object: ' +
  '{"action":"HOLD"|"SELL","confidence":0..1,"reasoning":"<=2 short sentences"}.'

function entryUser(c: EntryContext): string {
  return [
    `Token: ${c.symbol || c.tokenAddress}`,
    `Address: ${c.tokenAddress}`,
    c.version != null ? `four.meme version: V${c.version}` : null,
    `Trust score (0-100): ${c.trustScore}`,
    `Bonding-curve fill: ${(c.fillPct * 100).toFixed(1)}%`,
    `Raised so far: ${c.fundsBnb.toFixed(4)} BNB`,
    `Unique buyers: ${c.buyerCount}`,
    `Buys / Sells: ${c.buyCount} / ${c.sellCount}`,
    `Volume: ${c.volumeBnb.toFixed(4)} BNB`,
    `Dev holds: ${c.devHoldsPct.toFixed(1)}%`,
    c.ageMinutes != null ? `Age: ${c.ageMinutes.toFixed(0)} min` : null,
  ].filter(Boolean).join('\n')
}

function exitUser(c: ExitContext): string {
  return [
    `Token: ${c.symbol || c.tokenAddress}`,
    `Address: ${c.tokenAddress}`,
    `Venue: ${c.venue === 'pancake' ? 'PancakeSwap (graduated)' : 'four.meme bonding curve'}`,
    `Graduated to PancakeSwap: ${c.graduated ? 'yes' : 'no'}`,
    `Bonding-curve fill: ${(c.fillPct * 100).toFixed(1)}%`,
  ].filter(Boolean).join('\n')
}

// ── JSON parsing (tolerant of code fences / surrounding prose) ────────────

function parseJsonLoose(text: string): Record<string, unknown> {
  let t = (text || '').trim()
  // Strip ```json … ``` or ``` … ``` fences some providers emit.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  // Fall back to the first {...} block.
  if (!t.startsWith('{')) {
    const brace = t.match(/\{[\s\S]*\}/)
    if (brace) t = brace[0]
  }
  return JSON.parse(t) as Record<string, unknown>
}

function clampConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 0.5
  return Math.min(1, Math.max(0, n))
}

function parseEntry(text: string): EntryDecision {
  const obj = parseJsonLoose(text)
  const action = String(obj.action ?? '').trim().toUpperCase()
  if (action !== 'BUY' && action !== 'SKIP') throw new Error(`invalid entry action: ${action || '(empty)'}`)
  return { action: action as EntryAction, confidence: clampConfidence(obj.confidence), reasoning: String(obj.reasoning ?? '').slice(0, 400) }
}

function parseExit(text: string): ExitDecision {
  const obj = parseJsonLoose(text)
  const action = String(obj.action ?? '').trim().toUpperCase()
  if (action !== 'HOLD' && action !== 'SELL') throw new Error(`invalid exit action: ${action || '(empty)'}`)
  return { action: action as ExitAction, confidence: clampConfidence(obj.confidence), reasoning: String(obj.reasoning ?? '').slice(0, 400) }
}

// ── Shared verdict cache (per token, per kind) ───────────────────────────

interface CacheEntry<A extends string> { expires: number; verdict: FleetVerdict<A> }
const entryCache = new Map<string, CacheEntry<EntryAction>>()
const exitCache = new Map<string, CacheEntry<ExitAction>>()

/** Clear both caches (tests). */
export function __clearVerdictCache(): void {
  entryCache.clear()
  exitCache.clear()
}

function liveProviders(): Provider[] {
  const status = __brainTestDeps.getProviderStatus()
  return (Object.keys(status) as Provider[]).filter((p) => status[p].live)
}

function votesFrom<T extends EntryDecision | ExitDecision>(res: SwarmResult<T>): ProviderVote[] {
  return res.decisions.map((d) => ({
    provider: d.provider,
    model: d.model,
    ok: d.ok,
    action: d.decision ? String((d.decision as any).action ?? '') : null,
    reasoning: d.reasoning ?? (d.decision ? String((d.decision as any).reasoning ?? '') || null : null),
    error: d.error,
  }))
}

function agreementStr(res: SwarmResult<any>, consensus: string | null): string {
  const hist = res.divergence.actionHistogram
  const total = res.divergence.totalCount
  if (consensus) return `${hist[consensus] ?? 0}/${total} ${consensus}`
  const parts = Object.entries(hist).map(([a, n]) => `${n} ${a}`)
  return parts.length ? parts.join(', ') : 'no votes'
}

async function runVerdict<A extends string, T extends EntryDecision | ExitDecision>(
  kind: 'entry' | 'exit',
  cache: Map<string, CacheEntry<A>>,
  token: string,
  system: string,
  user: string,
  parse: (t: string) => T,
): Promise<FleetVerdict<A>> {
  const key = token.toLowerCase()
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.verdict

  const providers = liveProviders()
  if (providers.length < SWARM_QUORUM) {
    // Can't reach quorum — fail-safe verdict (no action). NOT cached: a
    // provider may come back online before the next tick.
    return {
      action: null,
      confidence: null,
      summary: `AI brain off (need ${SWARM_QUORUM} live LLMs, have ${providers.length})`,
      votes: [],
      agreement: `${providers.length}/${SWARM_QUORUM} providers`,
      providers: providers as string[],
      reason: 'no_providers',
    }
  }

  const res = await __brainTestDeps.runSwarmDecision<T>({
    providers,
    system,
    user,
    schema: parse,
    getAction: (d) => String((d as any).action),
    getReasoning: (d) => String((d as any).reasoning ?? '') || null,
    quorum: SWARM_QUORUM,
    timeoutMs: SWARM_TIMEOUT_MS,
    jsonMode: true,
  })

  const consensus = res.divergence.actionConsensus
  const quorum = res.quorumDecision
  const votes = votesFrom(res)
  const agreement = agreementStr(res, consensus)
  const action = (quorum ? String((quorum as any).action) : null) as A | null
  const confidence = quorum ? clampConfidence((quorum as any).confidence) : null
  const summary = action
    ? `AI ${action} (${agreement})`
    : `AI no-quorum (${agreement})`

  const verdict: FleetVerdict<A> = {
    action,
    confidence,
    summary,
    votes,
    agreement,
    providers: providers as string[],
    reason: action ? 'ok' : 'no_quorum',
  }
  // Cache decisive AND no-quorum verdicts (both are real swarm output worth
  // sharing across agents for the TTL window). The no-providers branch above
  // is the only un-cached path.
  cache.set(key, { expires: now + VERDICT_TTL_SEC * 1000, verdict })
  return verdict
}

/**
 * Entry verdict for one mechanically-picked candidate. Shared per token for the
 * TTL window. Caller buys ONLY when `action === 'BUY'`.
 */
export function getEntryVerdict(ctx: EntryContext): Promise<FleetVerdict<EntryAction>> {
  return runVerdict<EntryAction, EntryDecision>('entry', entryCache, ctx.tokenAddress, ENTRY_SYSTEM, entryUser(ctx), parseEntry)
}

/**
 * Exit verdict for one held token. Shared per token for the TTL window. Caller
 * force-sells ONLY when `action === 'SELL'`; everything else defers to the
 * mechanical TP/SL/trailing layer.
 */
export function getExitVerdict(ctx: ExitContext): Promise<FleetVerdict<ExitAction>> {
  return runVerdict<ExitAction, ExitDecision>('exit', exitCache, ctx.tokenAddress, EXIT_SYSTEM, exitUser(ctx), parseExit)
}

/**
 * Market-creator agent.
 *
 * Pipeline (one run):
 *   1. Research  — pull signals from DexScreener (BNB tokens) + GNews (news)
 *                  in parallel.
 *   2. Score     — assign each candidate a 0-100 marketability score across
 *                  4 dimensions (newsAuthority, socialVolume, financialStake,
 *                  resolvability). Resolvability is the most important: a
 *                  market only works if it can be settled objectively.
 *   3. De-dup    — drop candidates whose proposed question matches a recent
 *                  proposal in the queue (case-insensitive normalised match).
 *   4. Evaluate  — send the top N to Claude for refinement + approval.
 *   5. Persist   — write approved (and rejected, for audit) proposals into
 *                  the MarketProposal table.
 *   6. Notify    — ping admins via Telegram with the new pending queue.
 *
 * 42.space currently has no createMarket() endpoint, so the agent stops at
 * step 5 — actual creation is a manual handoff via step 6's admin alert.
 * When 42.space ships their v2 creation API, swap the notification block
 * for an HTTP POST and the rest of the pipeline stays unchanged.
 */

import { Bot } from 'grammy'
import { fetchTrendingBNBTokens, type DexToken } from '../services/dexScreener'
import { fetchTrendingNews, type NewsSignal } from '../services/newsService'
import {
  createProposal,
  findDuplicate,
  type ProposalScores,
} from '../services/marketProposalStore'
import { callLLM } from '../services/inference'
import { sendAdminAlert } from '../services/adminAlerts'
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  type ScoredCandidate,
} from './marketCreatorPrompt'

// How many top-scored candidates we send to Claude. Each costs ~1k tokens
// of evaluation, so we keep this small. Bumping changes daily Anthropic spend.
const MAX_CANDIDATES_TO_EVALUATE = 5

// Minimum total score (0-100) a candidate must hit before we even send it
// to Claude. Below this it's not worth the API spend.
const MIN_SCORE_TO_EVALUATE = 30

// In-process mutex — guards against two concurrent pipeline runs racing
// past the de-dup check and inserting duplicate proposals (the Claude eval
// takes 10-30s, plenty of time for an admin to double-click /run, or for a
// future cron tick to overlap a manual run).
let _running = false

export interface RunResult {
  ok: boolean
  signalsCount: { tokens: number; news: number }
  candidatesScored: number
  candidatesEvaluated: number
  proposalsCreated: number
  proposalsRejected: number
  duplicatesSkipped: number
  errors: string[]
}

/**
 * Single end-to-end pipeline run. Designed to be safe to call manually
 * (admin endpoint, CLI script) and from a future cron tick.
 */
export async function runMarketCreator(opts: { bot?: Bot } = {}): Promise<RunResult> {
  const result: RunResult = {
    ok: false,
    signalsCount: { tokens: 0, news: 0 },
    candidatesScored: 0,
    candidatesEvaluated: 0,
    proposalsCreated: 0,
    proposalsRejected: 0,
    duplicatesSkipped: 0,
    errors: [],
  }

  if (_running) {
    console.log('[marketCreator] another run is already in progress, skipping')
    result.errors.push('another run already in progress')
    return result
  }
  _running = true

  console.log('[marketCreator] starting research pipeline')
  try {
    return await runPipeline(result, opts)
  } finally {
    _running = false
  }
}

async function runPipeline(result: RunResult, opts: { bot?: Bot }): Promise<RunResult> {

  // ── Step 1: research in parallel ──
  const [tokens, news] = await Promise.all([
    fetchTrendingBNBTokens().catch((e) => {
      result.errors.push(`tokens: ${(e as Error).message}`)
      return [] as DexToken[]
    }),
    fetchTrendingNews().catch((e) => {
      result.errors.push(`news: ${(e as Error).message}`)
      return [] as NewsSignal[]
    }),
  ])
  result.signalsCount = { tokens: tokens.length, news: news.length }
  console.log(`[marketCreator] signals: ${tokens.length} tokens, ${news.length} news`)

  if (tokens.length === 0 && news.length === 0) {
    result.errors.push('no signals from any source')
    return result
  }

  // ── Step 2: score everything ──
  const candidates: ScoredCandidate[] = [
    ...tokens.map(scoreToken),
    ...news.map(scoreNews),
  ].filter((c) => c.totalScore >= MIN_SCORE_TO_EVALUATE)

  candidates.sort((a, b) => b.totalScore - a.totalScore)
  result.candidatesScored = candidates.length

  // ── Step 3: de-dup against the proposal queue ──
  const fresh: ScoredCandidate[] = []
  for (const c of candidates) {
    const dup = await findDuplicate(c.proposedQuestion).catch(() => null)
    if (dup) {
      result.duplicatesSkipped++
      continue
    }
    fresh.push(c)
    if (fresh.length >= MAX_CANDIDATES_TO_EVALUATE) break
  }
  result.candidatesEvaluated = fresh.length
  console.log(`[marketCreator] ${fresh.length} fresh candidates → Claude (${result.duplicatesSkipped} dups skipped)`)

  if (fresh.length === 0) {
    result.ok = true
    return result
  }

  // ── Step 4: Claude evaluates ──
  // We don't have a getExistingMarkets() API call wired up to 42.space's
  // platform yet — the de-dup above covers our own queue, and Claude is
  // told to reject any proposal that smells like a duplicate of "common
  // knowledge" markets. When 42.space exposes a market list endpoint, plumb
  // it in here.
  let evaluations: ClaudeEvaluation[] = []
  try {
    evaluations = await evaluateWithClaude(fresh, [])
  } catch (err) {
    result.errors.push(`claude: ${(err as Error).message}`)
    return result
  }

  // ── Step 5: persist ──
  for (const ev of evaluations) {
    const candidate = fresh[ev.candidateIndex]
    if (!candidate) continue
    try {
      const id = await createProposal({
        status: ev.approved ? 'researched' : 'rejected',
        category: ev.category,
        sourceType: candidate.type,
        question: ev.refinedQuestion,
        outcomes: ev.outcomes,
        resolutionDate: parseDateOrNull(ev.resolutionDate),
        resolutionCriteria: ev.resolutionCriteria,
        resolutionSource: ev.resolutionSource,
        totalScore: candidate.totalScore,
        scores: candidate.scores,
        estimatedInterest: ev.estimatedInterest,
        claudeReasoning: ev.reasoning,
        rawSignal: candidate.type === 'token' ? candidate.tokenSignal : candidate.newsSignal,
      })
      if (ev.approved) {
        result.proposalsCreated++
        console.log(`[marketCreator] approved → ${id}: "${ev.refinedQuestion}"`)
      } else {
        result.proposalsRejected++
      }
    } catch (err) {
      result.errors.push(`persist: ${(err as Error).message}`)
    }
  }

  // ── Step 6: admin notification ──
  if (opts.bot && result.proposalsCreated > 0) {
    const approved = evaluations.filter((e) => e.approved).slice(0, 3)
    const lines = approved.map(
      (e) => `• [${e.category}] ${e.refinedQuestion}\n  resolves ${e.resolutionDate} via ${e.resolutionSource}`,
    ).join('\n\n')
    await sendAdminAlert(
      opts.bot,
      `🔮 *Market-creator: ${result.proposalsCreated} new proposal${result.proposalsCreated === 1 ? '' : 's'} ready*\n\n${lines}\n\nReview: \`GET /api/admin/market-proposals?status=researched\``,
      { parseMode: 'Markdown' },
    ).catch((e) => result.errors.push(`alert: ${(e as Error).message}`))
  }

  result.ok = true
  console.log(`[marketCreator] done: ${result.proposalsCreated} approved, ${result.proposalsRejected} rejected, ${result.duplicatesSkipped} dups`)
  return result
}

// ─── Scoring ─────────────────────────────────────────────────────────────

/**
 * Token candidate scorer. The four sub-scores are 0-25 each (totalling
 * 0-100). Resolvability is generous for tokens because price-feed
 * resolution is naturally objective (CoinGecko/DexScreener can settle).
 */
function scoreToken(t: DexToken): ScoredCandidate {
  // financialStake — uses 24h volume on a log scale, capped at $10M.
  const financialStake = Math.min(25, Math.round((Math.log10(Math.max(1, t.volume24hUsd)) - 5) * 8))
  // socialVolume — proxy via 24h price-change magnitude (real social signal
  // would need Twitter/X). A token doing ±20%+ has people talking.
  const socialVolume = Math.min(25, Math.round(Math.abs(t.priceChange24h) * 0.6))
  // newsAuthority — n/a for tokens, give a small fixed boost so scoring
  // isn't lopsided against news candidates.
  const newsAuthority = 8
  // resolvability — very high: price-feed markets are trivially settleable.
  const resolvability = 22

  const scores: ProposalScores = { newsAuthority, socialVolume, financialStake, resolvability }
  const totalScore = newsAuthority + socialVolume + financialStake + resolvability

  // First-pass proposal — Claude will refine.
  const target = roundPriceTarget(t.priceUsd, t.priceChange24h)
  const direction = t.priceChange24h >= 0 ? 'exceed' : 'fall below'
  const resolutionDate = isoDate(addDays(new Date(), 14))
  return {
    type: 'token',
    title: `${t.symbol} price target`,
    tokenSignal: t,
    scores,
    totalScore,
    proposedQuestion: `Will ${t.symbol} price ${direction} $${target} before ${resolutionDate}?`,
    proposedOutcomes: ['YES', 'NO'],
    proposedResolutionDate: resolutionDate,
    proposedResolutionSource: 'CoinGecko / DexScreener price feed',
  }
}

/**
 * News candidate scorer. Resolvability is the wild card here — most news
 * stories are too vague to settle, so we give it a conservative base value
 * and let Claude reject the unresolvable ones.
 */
function scoreNews(n: NewsSignal): ScoredCandidate {
  const newsAuthority = n.authority
  // socialVolume — proxy via headline length × authority (real X data not
  // wired up yet). A short, punchy headline from a top outlet ranks high.
  const socialVolume = Math.min(25, Math.round((n.authority / 25) * 18))
  // financialStake — n/a for general news, fixed small boost.
  const financialStake = 6
  // resolvability — pessimistic; most news is unresolvable. Claude filters
  // the rest.
  const resolvability = 12

  const scores: ProposalScores = { newsAuthority, socialVolume, financialStake, resolvability }
  const totalScore = newsAuthority + socialVolume + financialStake + resolvability

  const resolutionDate = isoDate(addDays(new Date(), 30))
  return {
    type: 'news',
    title: n.title,
    newsSignal: n,
    scores,
    totalScore,
    proposedQuestion: `Will the event in this headline resolve favourably by ${resolutionDate}? "${n.title}"`,
    proposedOutcomes: ['YES', 'NO'],
    proposedResolutionDate: resolutionDate,
    proposedResolutionSource: `Verifiable news report from ${n.source}`,
  }
}

// ─── Claude evaluation ───────────────────────────────────────────────────

interface ClaudeEvaluation {
  candidateIndex: number
  approved: boolean
  refinedQuestion: string
  outcomes: string[]
  resolutionDate: string
  resolutionCriteria: string
  resolutionSource: string
  category: string
  reasoning: string
  estimatedInterest: 'low' | 'medium' | 'high' | 'viral'
}

async function evaluateWithClaude(
  candidates: ScoredCandidate[],
  existingMarkets: string[],
): Promise<ClaudeEvaluation[]> {
  const result = await callLLM({
    provider: 'anthropic',
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(candidates, existingMarkets),
    jsonMode: true,
    maxTokens: 2000,
    temperature: 0.4,
  })

  // Strip any accidental markdown fences. Claude is told to omit them but
  // belt-and-suspenders.
  const cleaned = result.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()

  let parsed: { evaluations?: ClaudeEvaluation[] } = {}
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    console.warn('[marketCreator] Claude returned non-JSON:', cleaned.slice(0, 200))
    throw new Error(`Claude JSON parse failed: ${(err as Error).message}`)
  }

  if (!Array.isArray(parsed.evaluations)) {
    throw new Error('Claude response missing evaluations array')
  }

  // Defensive coerce — strip out any malformed entries instead of throwing.
  return parsed.evaluations.filter(isValidEvaluation)
}

function isValidEvaluation(e: unknown): e is ClaudeEvaluation {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return (
    typeof o.candidateIndex === 'number' &&
    typeof o.approved === 'boolean' &&
    typeof o.refinedQuestion === 'string' &&
    Array.isArray(o.outcomes) &&
    typeof o.resolutionDate === 'string' &&
    typeof o.resolutionCriteria === 'string' &&
    typeof o.resolutionSource === 'string' &&
    typeof o.category === 'string' &&
    typeof o.reasoning === 'string' &&
    typeof o.estimatedInterest === 'string'
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseDateOrNull(s: string): Date | null {
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d)
  r.setUTCDate(r.getUTCDate() + days)
  return r
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Pick a clean round-number price target for a token-direction question.
 * For tokens currently up X%, target a level X% further in the same
 * direction (with light rounding to a "nice" number so the question reads
 * cleanly). Bounded to avoid silly multipliers on extreme moves.
 */
function roundPriceTarget(price: number, change24h: number): string {
  const direction = change24h >= 0 ? 1 : -1
  // Target a 10-30% move further in the same direction, scaled by recent
  // momentum but capped.
  const projectedMove = Math.min(0.3, Math.max(0.1, Math.abs(change24h) / 100))
  const target = price * (1 + direction * projectedMove)
  // Friendly precision based on magnitude.
  if (target >= 100) return target.toFixed(0)
  if (target >= 1) return target.toFixed(2)
  if (target >= 0.01) return target.toFixed(4)
  return target.toFixed(8)
}

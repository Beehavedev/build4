// =====================================================================
// houseWorldCup — autonomous "win or draw" (double chance) campaign for
// the BUILD4 House Agent on 42.space FIFA World Cup matches.
//
// 42.space has no 3-way moneyline. Each match is a "Goal Differential"
// (soccer_match_gd) market whose outcome buckets look like:
//   ["MEX by 3+", "MEX by 2", "MEX by 1", "Draw", "KOR by 1", "KOR by 2", ...]
// "Win or draw" for a team = a basket buy across that team's positive-diff
// buckets ∪ the single "Draw" bucket. Outcome tokens pay 1 USDT each iff
// the bucket wins, so allocating stake ∝ each leg's price equalises payout
// across every covered bucket — the natural double-chance bet.
//
// Flow (fully autonomous, gated via the House Agent panel state —
// enabled + mode='campaign' + dex='42'; legacy HOUSE_WC_ENABLED override):
//   1. Enumerate live GD World Cup markets (42 REST list, V2 contract).
//   2. Skip markets already entered (HouseLog idempotency).
//   3. Read on-chain bucket prices via the V2 controller.
//   4. Swarm picks which team to back (win-or-draw); fail-closed.
//   5. Basket-buy $50 split ∝ price across the team's buckets + Draw.
//   6. Hold to full-time settlement; the generic claim sweep harvests.
//
// In-play signal is ODDS-MOVEMENT ONLY (no live-score API). Trading is
// permitted until ~halftime (timestampEnd - HOUSE_WC_HALFTIME_BEFORE_END_MIN);
// after that the basket is held to settlement. An optional odds-stop
// (HOUSE_WC_STOP_DROP_PCT, default off) exits before the cutoff if the
// covered side's combined implied probability collapses.
//
// Trades are LIVE + REAL by default. There is NO paper-trade default —
// the gate is the House Agent panel state (enabled + mode='campaign' +
// dex='42') plus a configured house key; HOUSE_WC_ENABLED is a legacy
// override and opts.force bypasses for admin/tests.
// =====================================================================

import { ethers } from 'ethers'
import { getAllMarkets, type Market42 } from '../services/fortyTwo'
import { readMarketOnchain, type OnchainMarketState, type OnchainOutcome } from '../services/fortyTwoOnchain'
import { callLLM, type Provider } from '../services/inference'
import { fetchTrendingNews, type NewsSignal } from '../services/newsService'
import { fetchXSignal, type XSignal } from '../services/twexApi'
import {
  houseOpenFortyTwoPosition,
  houseSellFortyTwoOutcome,
  findOpenHousePosition,
} from '../services/houseFortyTwoExecutor'
import { db } from '../db'
import { logHouseBrain, getHouseWalletAddress, getHouseAgent, recordHouseTick } from '../services/houseAgent'
import { getBot } from './runner'

// Swarm pinned to hyperbolic ALONE (product decision). xai's key is disabled and
// anthropic/akash are out of credits; pinning (not env-overridable) prevents a
// stale HOUSE_SWARM_PROVIDERS on the host from silently re-introducing a dead
// provider and fail-closing every match again.
const SWARM_PROVIDERS: Provider[] = ['hyperbolic']

const DEFAULT_BUDGET_USD = 50
const DEFAULT_HALFTIME_BEFORE_END_MIN = 60
const DEFAULT_MAX_MARKETS_PER_TICK = 8
const DEFAULT_MARKET_TAG = 'soccer_match_gd'
const MIN_LEG_USD = 1

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export function budgetUsd(): number {
  return envNum('HOUSE_WC_BUDGET_USD', DEFAULT_BUDGET_USD)
}
export function halftimeBeforeEndMin(): number {
  // Allow 0 here only via explicit "0" to mean "no cutoff" is NOT supported;
  // we always keep a positive cutoff so trading stops before settlement.
  return envNum('HOUSE_WC_HALFTIME_BEFORE_END_MIN', DEFAULT_HALFTIME_BEFORE_END_MIN)
}
export function maxMarketsPerTick(): number {
  return Math.floor(envNum('HOUSE_WC_MAX_MARKETS_PER_TICK', DEFAULT_MAX_MARKETS_PER_TICK))
}
export function stopDropPct(): number {
  // Default 0 = odds-stop disabled → hold to settlement.
  const v = Number(process.env.HOUSE_WC_STOP_DROP_PCT)
  return Number.isFinite(v) && v > 0 ? v : 0
}
export function marketTag(): string {
  return (process.env.HOUSE_WC_MARKET_TAG || DEFAULT_MARKET_TAG).toLowerCase()
}

// ── Goal-differential market detection + parsing (pure) ───────────────────

// "MEX by 3+", "Korea Republic by 1" — capture team name + magnitude.
const BY_RE = /^(.+?)\s+by\s+(\d+)\+?$/i
const DRAW_RE = /^draw$/i

export interface GdTeam {
  name: string
  indices: number[]
}
export interface GdParsed {
  drawIndex: number
  teams: GdTeam[]
}

/**
 * Structural test for a 42.space Goal-Differential market: exactly one
 * "Draw" bucket and every other bucket of the form "<team> by <N>[+]"
 * across exactly two teams. This is more robust than trusting taxonomy
 * strings, which 42 can rename.
 */
export function isGoalDifferentialMarket(labels: string[]): boolean {
  if (!labels || labels.length < 3) return false
  const draws = labels.filter((l) => DRAW_RE.test(String(l).trim()))
  if (draws.length !== 1) return false
  const rest = labels.filter((l) => !DRAW_RE.test(String(l).trim()))
  if (rest.length < 2) return false
  if (!rest.every((l) => BY_RE.test(String(l).trim()))) return false
  return parseGdMarket(labels) !== null
}

/** Parse a GD market's outcome labels into {drawIndex, teams[]}. Returns
 *  null when the labels are not a clean two-team GD grid. */
export function parseGdMarket(labels: string[]): GdParsed | null {
  if (!labels || labels.length < 3) return null
  let drawIndex = -1
  const byTeam = new Map<string, number[]>()
  for (let i = 0; i < labels.length; i++) {
    const t = String(labels[i]).trim()
    if (DRAW_RE.test(t)) {
      if (drawIndex >= 0) return null // more than one Draw → not a clean GD grid
      drawIndex = i
      continue
    }
    const m = BY_RE.exec(t)
    if (!m) return null
    const name = m[1].trim()
    const arr = byTeam.get(name) ?? []
    arr.push(i)
    byTeam.set(name, arr)
  }
  if (drawIndex < 0 || byTeam.size !== 2) return null
  const teams: GdTeam[] = [...byTeam.entries()].map(([name, indices]) => ({
    name,
    indices: indices.slice().sort((a, b) => a - b),
  }))
  return { drawIndex, teams }
}

/** Indices that make up "team wins OR draw" = team's buckets ∪ Draw. */
export function winOrDrawBasketIndices(parsed: GdParsed, teamName: string): number[] | null {
  const team = parsed.teams.find((t) => t.name.toLowerCase() === teamName.toLowerCase())
  if (!team) return null
  return [...team.indices, parsed.drawIndex].sort((a, b) => a - b)
}

// ── Stake allocation (pure) ───────────────────────────────────────────────

export interface BasketLeg {
  index: number
  tokenId: number
  usdt: number
}

/**
 * Split `budgetUsd` across the basket legs proportional to each leg's
 * implied probability (price). Because an outcome token pays 1 USDT iff it
 * wins, stake ∝ price equalises payout across every covered leg — so the
 * basket behaves like one double-chance bet regardless of which covered
 * bucket actually settles. Falls back to an equal split when prices are
 * unavailable, drops sub-$1 dust legs, and re-normalises the remainder so
 * the full budget is deployed.
 */
export function allocateBasket(
  outcomes: Array<{ index: number; tokenId: number; impliedProbability: number }>,
  indices: number[],
  budget: number,
  minLegUsd = MIN_LEG_USD,
): BasketLeg[] {
  const legs = indices
    .map((i) => outcomes.find((o) => o.index === i))
    .filter((o): o is { index: number; tokenId: number; impliedProbability: number } => !!o)
  if (!legs.length || budget <= 0) return []

  const probs = legs.map((o) => (o.impliedProbability > 0 ? o.impliedProbability : 0))
  const sum = probs.reduce((a, b) => a + b, 0)
  const weights = sum > 0 ? probs.map((p) => p / sum) : legs.map(() => 1 / legs.length)

  let out = legs.map((o, k) => ({ index: o.index, tokenId: o.tokenId, usdt: budget * weights[k] }))
  out = out.filter((l) => l.usdt >= minLegUsd)
  if (!out.length) return []

  const spent = out.reduce((a, b) => a + b.usdt, 0)
  if (spent > 0) out = out.map((l) => ({ ...l, usdt: (l.usdt / spent) * budget }))
  return out.map((l) => ({ ...l, usdt: Math.round(l.usdt * 100) / 100 }))
}

/** Combined implied probability of a set of basket indices. */
export function basketImpliedProb(
  outcomes: Array<{ index: number; impliedProbability: number }>,
  indices: number[],
): number {
  return indices.reduce((s, i) => {
    const o = outcomes.find((x) => x.index === i)
    return s + (o ? o.impliedProbability : 0)
  }, 0)
}

// ── Timing (pure) ─────────────────────────────────────────────────────────

/** Wall-clock ms of the ~halftime cutoff (no kickoff field exists; full-time
 *  settlement is timestampEnd, halftime ≈ that minus beforeEndMin). */
export function halftimeCutoffMs(timestampEndSec: number, beforeEndMin: number): number {
  return timestampEndSec * 1000 - beforeEndMin * 60_000
}

/** True while we may still open/adjust a position (before the cutoff). */
export function tradingWindowOpen(nowMs: number, timestampEndSec: number, beforeEndMin: number): boolean {
  if (!Number.isFinite(timestampEndSec) || timestampEndSec <= 0) return false
  return nowMs < halftimeCutoffMs(timestampEndSec, beforeEndMin)
}

/** Odds-stop: fire when the covered basket's implied prob has fallen by
 *  ≥dropPct relative to entry. dropPct<=0 disables the stop. */
export function oddsStopTriggered(entryProb: number, currentProb: number, dropPct: number): boolean {
  if (!(dropPct > 0) || !(entryProb > 0)) return false
  const drop = ((entryProb - currentProb) / entryProb) * 100
  return drop >= dropPct
}

// ── Team-vote aggregation (pure, fail-closed) ─────────────────────────────

export interface TeamSwarmVote {
  provider: Provider
  model: string
  team: string | null
  conviction: number
  thesis: string
  parsed: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

export interface TeamDecision {
  team: string | null
  avgConviction: number
  thesis: string
  reason: string
}

/**
 * Aggregate the swarm's team picks for a binary "which side to back" choice.
 * STRICT fail-closed (mirrors the sports brain): no consensus ⇒ no team ⇒
 * no trade. Team names are matched case-insensitively against the two GD
 * teams; votes for anything else are discarded.
 */
export function aggregateTeamVotes(
  votes: TeamSwarmVote[],
  teamNames: string[],
  providerCount = SWARM_PROVIDERS.length,
): TeamDecision {
  const canon = new Map<string, string>()
  for (const t of teamNames) canon.set(t.toLowerCase(), t)

  const parsed = votes.filter(
    (v) => v.parsed && v.team != null && canon.has(v.team.toLowerCase()),
  )

  const n = Math.max(1, providerCount)
  const minParsed = Math.max(1, n - 1)
  const majorityNeeded = Math.floor(n / 2) + 1
  const minPlurality = Math.min(2, n)

  if (parsed.length < minParsed) {
    return { team: null, avgConviction: 0, thesis: '', reason: `fail-closed: only ${parsed.length}/${votes.length} parsed` }
  }

  const tally = new Map<string, number>()
  for (const v of parsed) {
    const key = canon.get(v.team!.toLowerCase())!
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1])
  const topCount = sorted[0][1]
  const runnerUp = sorted[1]?.[1] ?? 0
  const hasMajority = topCount >= majorityNeeded
  const hasClearPlurality = topCount >= minPlurality && topCount > runnerUp

  if (!hasMajority && !hasClearPlurality) {
    return {
      team: null,
      avgConviction: 0,
      thesis: '',
      reason: `fail-closed: no consensus (${sorted.map(([t, c]) => `${c}×${t}`).join(', ')})`,
    }
  }

  const picked = sorted[0][0]
  const supporters = parsed.filter((v) => canon.get(v.team!.toLowerCase()) === picked)
  const avg = supporters.reduce((s, v) => s + v.conviction, 0) / supporters.length
  const champion = supporters.slice().sort((a, b) => b.conviction - a.conviction)[0]
  return {
    team: picked,
    avgConviction: Math.round(avg),
    thesis: champion?.thesis || `swarm consensus to back ${picked} (win or draw)`,
    reason: `consensus: ${topCount}/${parsed.length} for ${picked}`,
  }
}

// ── Live-market enumeration ───────────────────────────────────────────────

/** Cheap pre-filter from the REST list: a market whose taxonomy marks it as
 *  a Goal-Differential market (the on-chain structural check confirms it). */
export function looksLikeGdMarketMeta(m: Market42, tag = marketTag()): boolean {
  const taxonomy = [
    ...(m.categories ?? []),
    ...(m.topics ?? []),
    ...(m.tags ?? []),
  ].map((s) => String(s).toLowerCase())
  if (taxonomy.includes(tag)) return true
  // Defensive fallbacks: 42 sometimes varies the exact tag string.
  if (taxonomy.some((t) => t.endsWith('_gd') || t.includes('goal differential') || t.includes('goal-differential'))) {
    return true
  }
  const slug = String(m.slug ?? '').toLowerCase()
  return slug.includes('-gd') || slug.endsWith('gd')
}

// Default competition tokens. Kept narrow ('wc' alone is too noisy) so we only
// trade actual FIFA World Cup matches, not arbitrary soccer GD markets.
const DEFAULT_COMPETITION_TOKENS = ['world cup', 'world-cup', 'worldcup', 'fifa']

/** Comma-separated override of the competition match tokens (lower-cased). */
export function competitionTokens(): string[] {
  const raw = process.env.HOUSE_WC_COMPETITION
  if (raw && raw.trim()) {
    return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  }
  return DEFAULT_COMPETITION_TOKENS
}

/** Scope guard: only back GD markets that belong to the FIFA World Cup. Set
 *  HOUSE_WC_SCOPE_ANY_SOCCER=true to disable (back every live GD market). */
export function looksLikeWorldCupMarket(m: Market42, tokens = competitionTokens()): boolean {
  if (process.env.HOUSE_WC_SCOPE_ANY_SOCCER === 'true') return true
  const hay = [
    m.question ?? '',
    m.slug ?? '',
    (m as { description?: string }).description ?? '',
    ...(m.categories ?? []),
    ...(m.topics ?? []),
    ...(m.tags ?? []),
  ].join(' ').toLowerCase()
  return tokens.some((t) => hay.includes(t))
}

// ── Basket bookkeeping (for the odds-stop monitor) ────────────────────────

interface WcBasketRecord {
  team: string
  indices: number[]
  entryBasketProb: number
  legs: Array<{ index: number; tokenId: number; outcomeLabel: string }>
  contractVersion: number
}

/** Read back the most recent OPEN_WC summary row for a market (used by the
 *  odds-stop monitor to recover the entry basket + entry probability). */
async function findWcBasket(marketAddress: string): Promise<WcBasketRecord | null> {
  const addr = ethers.getAddress(marketAddress)
  const rows = await db.$queryRawUnsafe<Array<{ meta: any }>>(
    `SELECT meta
       FROM "HouseLog"
      WHERE dex = '42'
        AND decision = 'OPEN_WC'
        AND meta ? 'marketAddress'
        AND LOWER(meta->>'marketAddress') = LOWER($1)
        AND COALESCE((meta->>'dryRun')::boolean, false) = false
      ORDER BY "createdAt" DESC
      LIMIT 1`,
    addr,
  )
  const meta = rows[0]?.meta
  if (!meta || !Array.isArray(meta.indices) || !Array.isArray(meta.legs)) return null
  return {
    team: String(meta.team ?? ''),
    indices: meta.indices.map((n: any) => Number(n)),
    entryBasketProb: Number(meta.entryBasketProb ?? 0),
    legs: meta.legs,
    contractVersion: Number(meta.contractVersion ?? 2),
  }
}

// ── Swarm (team pick) ─────────────────────────────────────────────────────

function buildTeamPrompt(
  market: Market42,
  state: OnchainMarketState,
  parsed: GdParsed,
  news: NewsSignal[],
  x: XSignal | null,
): { system: string; user: string } {
  const teamLines = parsed.teams
    .map((t) => {
      const prob = basketImpliedProb(state.outcomes, [...t.indices, parsed.drawIndex])
      const mult = prob > 0 ? (1 / prob).toFixed(2) : '∞'
      return `  ${t.name.padEnd(28)} win-or-draw prob=${(prob * 100).toFixed(1).padStart(5)}%  payout=${mult}x`
    })
    .join('\n')

  const newsBlock = news.length
    ? news.map((n) => `  [${n.source}] ${n.title}${n.description ? ` — ${n.description.slice(0, 160)}` : ''}`).join('\n')
    : '  (no recent news available)'

  const xBlock = x && x.topTweets.length
    ? x.topTweets.map((t) => `  @${t.author} (${t.likes}♥ ${t.retweets}↺): ${t.text.replace(/\s+/g, ' ').slice(0, 180)}`).join('\n')
    : '  (no recent X / fan chatter available)'

  const system = [
    'You are a senior football (soccer) analyst on the BUILD4 House Agent.',
    'You bet "DOUBLE CHANCE" (a team to WIN OR DRAW) on a 42.space World Cup',
    'goal-differential market. You MUST pick exactly ONE of the two teams to back',
    '— never abstain. Choose the side whose win-or-draw outcome is the safest value,',
    'weighing ALL of: the on-chain crowd odds, the recent NEWS (injuries, suspensions,',
    'starting lineups, manager comments, form, head-to-head, motivation, venue), the live',
    'FAN/PUNDIT CHATTER from X, and your own football knowledge. Default to the higher',
    'win-or-draw probability side unless the news or chatter gives a clear reason to',
    'prefer the other. Your thesis MUST cite the concrete factors that drove the pick.',
    'Reply with strict JSON only — no prose, no code fences.',
  ].join(' ')

  const categories = (market.categories ?? []).concat(market.tags ?? []).filter(Boolean).join(', ') || '(none)'
  const teamNames = parsed.teams.map((t) => t.name)

  const user = [
    `MATCH:            ${market.question}`,
    `Settlement (FT):  ${market.endDate}`,
    `Categories/tags:  ${categories}`,
    '',
    'Win-or-draw (double chance) options:',
    teamLines,
    '',
    `Recent news (last 72h):`,
    newsBlock,
    '',
    `Live X / fan & pundit chatter:`,
    xBlock,
    '',
    'Reply with JSON exactly:',
    `{"team": "<one of: ${teamNames.join(' | ')}>", "conviction": <int 0..100>, "thesis": "<<= 240 chars, cite the key factors>"}`,
    'You MUST choose one of the two teams — do not reply "none". conviction is your confidence the chosen team will win OR draw.',
  ].join('\n')

  return { system, user }
}

function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

function parseTeamReply(raw: string, teamNames: string[]): { team: string | null; conviction: number; thesis: string } | null {
  if (!raw) return null
  const stripped = raw.replace(/```json\s*|\s*```/g, '').trim()
  // Try the whole string first (clean JSON-mode reply), then fall back to the
  // first balanced object embedded anywhere in the text.
  const candidates = [stripped]
  const extracted = extractJsonObject(stripped)
  if (extracted && extracted !== stripped) candidates.push(extracted)
  for (const candidate of candidates) {
    try {
      const j = JSON.parse(candidate)
      const rawTeam = String(j.team ?? '').trim()
      const conviction = Number(j.conviction)
      const thesis = String(j.thesis ?? '').slice(0, 240)
      if (!Number.isFinite(conviction) || conviction < 0 || conviction > 100) continue
      const match = teamNames.find((t) => t.toLowerCase() === rawTeam.toLowerCase())
      return { team: match ?? null, conviction, thesis }
    } catch {
      continue
    }
  }
  return null
}

async function runTeamSwarm(
  prompt: { system: string; user: string },
  teamNames: string[],
): Promise<TeamSwarmVote[]> {
  const calls = SWARM_PROVIDERS.map(async (provider): Promise<TeamSwarmVote> => {
    try {
      const r = await callLLM({
        provider,
        system: prompt.system,
        user: prompt.user,
        jsonMode: true,
        maxTokens: 400,
        temperature: 0.4,
        timeoutMs: 45_000,
      })
      const parsed = parseTeamReply(r.text, teamNames)
      return {
        provider,
        model: r.model,
        team: parsed?.team ?? null,
        conviction: parsed?.conviction ?? 0,
        thesis: parsed?.thesis ?? '',
        parsed: !!parsed,
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      }
    } catch (err) {
      console.warn(`[houseWorldCup] provider ${provider} failed:`, (err as Error).message)
      return {
        provider, model: '<error>', team: null, conviction: 0,
        thesis: `[${provider} unavailable]`, parsed: false, latencyMs: 0, inputTokens: 0, outputTokens: 0,
      }
    }
  })
  return Promise.all(calls)
}

// ── Per-market orchestration ──────────────────────────────────────────────

export interface WcMarketResult {
  marketAddress: string
  question: string
  action: 'entered' | 'skip' | 'exit' | 'error'
  reason: string
  team?: string
  legs?: BasketLeg[]
  basketProb?: number
}

export interface WcTickResult {
  ran: boolean
  reason?: string
  scanned: number
  candidates: number
  processed: number
  results: WcMarketResult[]
}

async function enterMarket(m: Market42, opts: { dryRun: boolean }): Promise<WcMarketResult> {
  const marketAddress = ethers.getAddress(m.address)
  const base: WcMarketResult = { marketAddress, question: m.question, action: 'skip', reason: '' }

  let state: OnchainMarketState
  try {
    state = await readMarketOnchain(m)
  } catch (err) {
    return { ...base, action: 'error', reason: `on-chain read failed: ${(err as Error).message}` }
  }
  if (state.isFinalised) return { ...base, reason: 'finalised' }
  if (!state.outcomes.length) return { ...base, reason: 'no outcomes' }

  const parsed = parseGdMarket(state.outcomes.map((o) => o.label))
  if (!parsed) return { ...base, reason: 'not a goal-differential market' }

  if (!tradingWindowOpen(Date.now(), state.timestampEnd, halftimeBeforeEndMin())) {
    return { ...base, reason: 'trading window closed (past ~halftime cutoff)' }
  }

  const teamNames = parsed.teams.map((t) => t.name)
  // Pull both online signals in parallel: GNews headlines + live X fan/pundit
  // chatter for THIS match. Both degrade to empty/null so a feed outage never
  // blocks a bet — the swarm then leans on crowd odds + its own knowledge.
  const matchQuery = deriveMatchQuery(m, teamNames)
  const [news, xSignal] = await Promise.all([
    fetchTrendingNews({ query: matchQuery, lookbackHours: 72, limit: 8 }).catch((err) => {
      console.warn(`[houseWorldCup] news fetch failed: ${(err as Error).message}`)
      return [] as NewsSignal[]
    }),
    fetchXSignal(deriveMatchSearchTerms(m, teamNames), { maxItems: 40, sortBy: 'Top', topN: 8 }).catch((err) => {
      console.warn(`[houseWorldCup] X fetch failed: ${(err as Error).message}`)
      return null
    }),
  ])

  const prompt = buildTeamPrompt(m, state, parsed, news, xSignal)
  const votes = await runTeamSwarm(prompt, teamNames)
  let decision = aggregateTeamVotes(votes, teamNames)

  // FORCE-BET: every open World Cup market must get a bet. When the swarm gives
  // no usable pick (abstain / unparseable / provider down / no consensus), fall
  // back to the market favorite — the side with the highest win-or-draw implied
  // probability — instead of skipping the match.
  if (!decision.team) {
    const fav = favoriteTeam(parsed, state)
    await logHouseBrain({
      dex: '42', kind: 'info', decision: 'FORCE_WC',
      reasoning: `house WC FORCE ${m.question.slice(0, 60)} → ${fav.team} (market favorite, win-or-draw ${(fav.prob * 100).toFixed(1)}%) — ${decision.reason}`,
      meta: { marketAddress, votes: votes.length, parsed: votes.filter((v) => v.parsed).length, fallback: true, team: fav.team, reason: decision.reason },
    })
    decision = {
      team: fav.team,
      avgConviction: Math.round(fav.prob * 100),
      thesis: `Force-bet fallback: no usable swarm pick (${decision.reason}); backing market favorite ${fav.team} at win-or-draw ${(fav.prob * 100).toFixed(1)}%.`,
      reason: `force-bet: market favorite (${decision.reason})`,
    }
  }

  // After force-bet, a side is always chosen; narrow to non-null for downstream use.
  const team = decision.team
  if (!team) return { ...base, action: 'error', reason: 'no team to back (empty parsed grid)' }

  const indices = winOrDrawBasketIndices(parsed, team)
  if (!indices) return { ...base, action: 'error', reason: `team "${team}" not found in parsed grid` }

  const legs = allocateBasket(state.outcomes, indices, budgetUsd())
  if (!legs.length) return { ...base, reason: 'allocation produced no fundable legs' }

  const entryBasketProb = basketImpliedProb(state.outcomes, indices)
  const labelFor = (idx: number) => state.outcomes.find((o) => o.index === idx)?.label ?? `Outcome ${idx}`

  // Buy each leg. Partial success is acceptable — a single reverted leg
  // should not strand the rest of the double-chance basket.
  const filled: Array<{ index: number; tokenId: number; outcomeLabel: string; usdt: number; txHash: string | null }> = []
  for (const leg of legs) {
    const outcomeLabel = labelFor(leg.index)
    try {
      const r = await houseOpenFortyTwoPosition({
        marketAddress,
        tokenId: leg.tokenId,
        outcomeLabel,
        usdtIn: leg.usdt.toFixed(2),
        contractVersion: m.contractVersion,
        dryRun: opts.dryRun,
        decision: 'OPEN_42',
        reasoning: `[HOUSE WC ${opts.dryRun ? 'DRY ' : ''}win-or-draw] ${m.question.slice(0, 50)} → back ${team} · leg "${outcomeLabel}" $${leg.usdt.toFixed(2)} — ${decision.thesis}`,
        meta: {
          campaign: 'world_cup_double_chance',
          team: team,
          basketIndices: indices,
          legIndex: leg.index,
          question: m.question,
          endDate: m.endDate,
          contractVersion: m.contractVersion,
        },
      })
      filled.push({ index: leg.index, tokenId: leg.tokenId, outcomeLabel, usdt: leg.usdt, txHash: r.txHash })
    } catch (err) {
      console.warn(`[houseWorldCup] leg buy failed market=${marketAddress.slice(0, 10)} idx=${leg.index}: ${(err as Error).message}`)
    }
  }

  if (!filled.length) {
    return { ...base, action: 'error', reason: 'all basket legs failed to fill' }
  }

  // One summary row per match — also the source the odds-stop monitor reads.
  await logHouseBrain({
    dex: '42', kind: 'trade', decision: 'OPEN_WC',
    reasoning: `🏆 HOUSE WC ${opts.dryRun ? '[DRY] ' : ''}win-or-draw on ${m.question.slice(0, 60)} → ${team} ($${legs.reduce((s, l) => s + l.usdt, 0).toFixed(2)} across ${filled.length} legs) — ${decision.thesis}`.slice(0, 2000),
    meta: {
      campaign: 'world_cup_double_chance',
      marketAddress,
      question: m.question,
      endDate: m.endDate,
      team: team,
      indices,
      entryBasketProb,
      contractVersion: m.contractVersion,
      budgetUsd: budgetUsd(),
      avgConviction: decision.avgConviction,
      legs: filled.map((f) => ({ index: f.index, tokenId: f.tokenId, outcomeLabel: f.outcomeLabel, usdt: f.usdt, txHash: f.txHash })),
      swarm: votes.map((v) => ({ provider: v.provider, model: v.model, team: v.team, conviction: v.conviction, parsed: v.parsed })),
      dryRun: opts.dryRun,
    },
  })

  await broadcastWcEntry(m, team, legs, entryBasketProb, decision.thesis, opts.dryRun).catch((err) =>
    console.warn('[houseWorldCup] broadcast failed:', (err as Error).message),
  )

  return {
    marketAddress,
    question: m.question,
    action: 'entered',
    reason: decision.reason,
    team: team,
    legs,
    basketProb: entryBasketProb,
  }
}

/** Odds-stop monitor for an already-entered market. Only acts when
 *  HOUSE_WC_STOP_DROP_PCT>0 and we are still inside the trading window. */
async function monitorMarket(m: Market42, opts: { dryRun: boolean }): Promise<WcMarketResult> {
  const marketAddress = ethers.getAddress(m.address)
  const base: WcMarketResult = { marketAddress, question: m.question, action: 'skip', reason: 'holding to settlement' }

  const dropPct = stopDropPct()
  if (dropPct <= 0) return base // odds-stop disabled → pure hold

  const record = await findWcBasket(marketAddress)
  if (!record || !record.indices.length) return { ...base, reason: 'no basket record to monitor' }

  let state: OnchainMarketState
  try {
    state = await readMarketOnchain(m)
  } catch (err) {
    return { ...base, action: 'error', reason: `on-chain read failed: ${(err as Error).message}` }
  }
  if (state.isFinalised) return { ...base, reason: 'finalised — claim sweep will settle' }
  if (!tradingWindowOpen(Date.now(), state.timestampEnd, halftimeBeforeEndMin())) {
    return { ...base, reason: 'window closed — holding to settlement' }
  }

  const currentProb = basketImpliedProb(state.outcomes, record.indices)
  if (!oddsStopTriggered(record.entryBasketProb, currentProb, dropPct)) {
    return { ...base, reason: `holding (prob ${(currentProb * 100).toFixed(1)}% vs entry ${(record.entryBasketProb * 100).toFixed(1)}%)` }
  }

  // Exit every leg. Track per-leg outcome: a leg is "cleared" when the sell
  // call returns ok (either it sold, or it proved a zero balance — nothing
  // left to claim). A leg that THROWS is "unclear" — we cannot prove the
  // position is gone, so we must NOT suppress the settlement claim sweep for
  // it, or stranded outcome tokens would never be redeemed.
  const legResults: Array<{ index: number; cleared: boolean; sold: boolean; txHash: string | null }> = []
  for (const leg of record.legs) {
    try {
      const r = await houseSellFortyTwoOutcome({
        marketAddress,
        tokenId: leg.tokenId,
        outcomeLabel: leg.outcomeLabel,
        contractVersion: record.contractVersion,
        dryRun: opts.dryRun,
        decision: 'CLOSE_42',
        reasoning: `[HOUSE WC odds-stop] exit ${record.team} leg "${leg.outcomeLabel}" — basket prob fell to ${(currentProb * 100).toFixed(1)}% (entry ${(record.entryBasketProb * 100).toFixed(1)}%, stop ${dropPct}%)`,
        meta: { campaign: 'world_cup_double_chance', reason: 'odds_stop', entryBasketProb: record.entryBasketProb, currentProb },
      })
      legResults.push({ index: leg.index, cleared: true, sold: r.sold, txHash: r.txHash })
    } catch (err) {
      legResults.push({ index: leg.index, cleared: false, sold: false, txHash: null })
      console.warn(`[houseWorldCup] odds-stop sell failed idx=${leg.index}: ${(err as Error).message}`)
    }
  }

  // Full liquidation = every leg cleared on a real (non-dry) run. Only then
  // is it safe to suppress the settlement claim sweep; otherwise we leave the
  // sweep active so any residual outcome tokens are still redeemed at FT.
  const fullyLiquidated = !opts.dryRun && legResults.every((r) => r.cleared)

  await logHouseBrain({
    dex: '42', kind: 'trade', decision: 'EXIT_WC',
    reasoning: `🛑 HOUSE WC odds-stop on ${m.question.slice(0, 60)} — ${record.team} basket prob ${(currentProb * 100).toFixed(1)}% < entry ${(record.entryBasketProb * 100).toFixed(1)}% (drop ≥ ${dropPct}%)${fullyLiquidated ? '' : ' [PARTIAL — sweep left active]'}`,
    meta: {
      campaign: 'world_cup_double_chance', marketAddress, team: record.team,
      entryBasketProb: record.entryBasketProb, currentProb, dryRun: opts.dryRun,
      fullyLiquidated, legResults,
    },
  })
  // Mark claim as resolved-by-exit ONLY when fully liquidated, so the sweep
  // skips a market we have provably emptied. On partial/failed exits we leave
  // no marker — the (idempotent) claim sweep then redeems any residual tokens
  // once the market finalises.
  if (fullyLiquidated) {
    await logHouseBrain({
      dex: '42', kind: 'info', decision: 'CLAIM_42',
      reasoning: `house WC market fully liquidated via odds-stop — no settlement claim needed (${marketAddress.slice(0, 10)}…)`,
      meta: { marketAddress, exited: true, reason: 'odds_stop' },
    })
  }

  return { marketAddress, question: m.question, action: 'exit', reason: `odds-stop (prob ${(currentProb * 100).toFixed(1)}%)`, team: record.team, basketProb: currentProb }
}

function deriveMatchQuery(m: Market42, teamNames: string[]): string {
  if (teamNames.length === 2) return `${teamNames[0]} vs ${teamNames[1]} World Cup`
  const q = m.question.replace(/\?+$/, '').trim()
  return q || 'World Cup football'
}

/** X/Twitter search terms for live fan & pundit chatter on a specific match. */
function deriveMatchSearchTerms(m: Market42, teamNames: string[]): string[] {
  if (teamNames.length === 2) {
    return [
      `${teamNames[0]} ${teamNames[1]}`,
      `${teamNames[0]} vs ${teamNames[1]}`,
      `${teamNames[0]} World Cup`,
      `${teamNames[1]} World Cup`,
    ]
  }
  const q = m.question.replace(/\?+$/, '').trim()
  return q ? [q] : ['World Cup football']
}

/** Deterministic force-bet pick: the side with the highest win-or-draw implied
 *  probability (the market favorite). Used when the swarm gives no usable pick. */
function favoriteTeam(parsed: GdParsed, state: OnchainMarketState): { team: string; prob: number } {
  let best: { team: string; prob: number } | null = null
  for (const t of parsed.teams) {
    const prob = basketImpliedProb(state.outcomes, [...t.indices, parsed.drawIndex])
    if (!best || prob > best.prob) best = { team: t.name, prob }
  }
  return best ?? { team: parsed.teams[0]?.name ?? '', prob: 0 }
}

// ── Public tick ───────────────────────────────────────────────────────────

export interface RunWcTickOptions {
  /** Force dry-run (no on-chain tx). Default false → LIVE + REAL. */
  dryRun?: boolean
  /** Bypass the HOUSE_WC_ENABLED gate (admin/manual runs). */
  force?: boolean
}

/**
 * One autonomous World-Cup campaign tick: enumerate live GD markets, enter
 * any un-entered match with a swarm-backed win-or-draw basket, and run the
 * odds-stop monitor on open positions. LIVE by default; gated via the House
 * Agent panel state (enabled + mode='campaign' + dex='42'), with a legacy
 * HOUSE_WC_ENABLED override and opts.force for admin/tests.
 */
export async function runHouseWorldCupTick(opts: RunWcTickOptions = {}): Promise<WcTickResult> {
  // UI-driven gate: the House Agent panel controls this campaign via the
  // singleton HouseAgent row (enabled + mode='campaign' + dex='42'). No env
  // var required. HOUSE_WC_ENABLED=true stays a legacy override, and
  // opts.force (admin/manual/tests) bypasses the gate entirely.
  const envOverride = process.env.HOUSE_WC_ENABLED === 'true'
  if (!opts.force && !envOverride) {
    const st = await getHouseAgent()
    if (!st.enabled)            return { ran: false, reason: 'house_disabled', scanned: 0, candidates: 0, processed: 0, results: [] }
    if (st.mode !== 'campaign') return { ran: false, reason: `mode!=campaign (${st.mode})`, scanned: 0, candidates: 0, processed: 0, results: [] }
    if (st.dex !== '42')        return { ran: false, reason: `dex!=42 (${st.dex})`, scanned: 0, candidates: 0, processed: 0, results: [] }
  }
  try {
    getHouseWalletAddress()
  } catch (err) {
    await recordHouseTick(`42:no_wallet:${(err as Error).message.slice(0, 80)}`)
    return { ran: false, reason: `house wallet unavailable: ${(err as Error).message}`, scanned: 0, candidates: 0, processed: 0, results: [] }
  }

  const dryRun = !!opts.dryRun

  let markets: Market42[]
  try {
    markets = await getAllMarkets({ status: 'live', limit: 100 })
  } catch (err) {
    await recordHouseTick(`42:market_list_failed:${(err as Error).message.slice(0, 60)}`)
    return { ran: true, reason: `market list failed: ${(err as Error).message}`, scanned: 0, candidates: 0, processed: 0, results: [] }
  }

  const candidates = markets.filter((m) => looksLikeGdMarketMeta(m) && looksLikeWorldCupMarket(m))
  const capped = candidates.slice(0, maxMarketsPerTick())
  const results: WcMarketResult[] = []

  for (const m of capped) {
    try {
      const existing = await findOpenHousePosition(m.address)
      if (existing) {
        results.push(await monitorMarket(m, { dryRun }))
      } else {
        results.push(await enterMarket(m, { dryRun }))
      }
    } catch (err) {
      results.push({
        marketAddress: m.address,
        question: m.question,
        action: 'error',
        reason: (err as Error).message,
      })
    }
  }

  const entered = results.filter((r) => r.action === 'entered').length
  const exited = results.filter((r) => r.action === 'exit').length
  console.log(
    `[houseWorldCup] tick done — scanned=${markets.length} candidates=${candidates.length} processed=${capped.length} entered=${entered} exited=${exited} dryRun=${dryRun}`,
  )

  await recordHouseTick(
    `42:scanned=${markets.length} candidates=${candidates.length} entered=${entered} exited=${exited}${dryRun ? ' (dry)' : ''}`,
  )

  return { ran: true, scanned: markets.length, candidates: candidates.length, processed: capped.length, results }
}

// ── Broadcast ─────────────────────────────────────────────────────────────

async function broadcastWcEntry(
  market: Market42,
  team: string,
  legs: BasketLeg[],
  basketProb: number,
  thesis: string,
  dryRun: boolean,
): Promise<void> {
  const channel = process.env.FT_CAMPAIGN_TG_CHANNEL
  if (!channel) return
  const bot = getBot()
  if (!bot) return
  const total = legs.reduce((s, l) => s + l.usdt, 0)
  const mult = basketProb > 0 ? (1 / basketProb).toFixed(2) : '∞'
  const username = bot.botInfo?.username
  const dryTag = dryRun ? '[DRY-RUN] ' : ''
  const text =
    `${dryTag}🏆 *BUILD4 House Agent — World Cup double chance*\n\n` +
    `Match: _${market.question}_\n` +
    `Bet: *${team} to win or draw*\n` +
    `Stake: $${total.toFixed(0)} · combined odds ${mult}x (${(basketProb * 100).toFixed(1)}% implied)\n\n` +
    `Thesis: ${thesis}`
  const reply_markup = username
    ? {
        inline_keyboard: [
          [{ text: '⚡ Open BUILD4 mini-app', url: `https://t.me/${username}/app?startapp=worldcup` }],
          [{ text: '📊 View on 42.space', url: `https://42.space/market/${market.address}` }],
        ],
      }
    : undefined
  await bot.api.sendMessage(channel, text, {
    parse_mode: 'Markdown',
    reply_markup,
    link_preview_options: { is_disabled: true },
  } as any)
}

// ── Test seam ─────────────────────────────────────────────────────────────

export const __testInternals = {
  parseTeamReply,
  buildTeamPrompt,
  deriveMatchQuery,
  deriveMatchSearchTerms,
  favoriteTeam,
  looksLikeGdMarketMeta,
  looksLikeWorldCupMarket,
  competitionTokens,
}

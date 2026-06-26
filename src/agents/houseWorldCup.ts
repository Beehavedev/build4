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
//   4. A single LLM picks which team to back (win-or-draw); fail-closed.
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
import { readMarketOnchain, type OnchainMarketState } from '../services/fortyTwoOnchain'
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

// SINGLE-LLM decision (product decision): ONE model decides each match — there
// is no swarm, no quorum, no consensus. anthropic/akash are out of credits and
// xai's key is disabled, so hyperbolic is the only live, funded provider. That
// one model reads the on-chain crowd odds (the favourite), the recent match
// news, and live X / fan chatter, and picks the win-or-draw side itself.
// Hard-pinned (not env-overridable) so a stale host env can't silently swap in a
// dead provider and fail-close every match again.
const HOUSE_LLM_PROVIDER: Provider = 'hyperbolic'

// How long to give the single model to answer. Hyperbolic's open-weight endpoint
// can be slow under load, so we allow a generous budget rather than fail-closing
// a match on a slow-but-valid reply.
const HOUSE_LLM_TIMEOUT_MS = 60_000

const DEFAULT_BUDGET_USD = 50
const DEFAULT_HALFTIME_BEFORE_END_MIN = 60
const DEFAULT_MARKET_TAG = 'soccer_match_gd'
const MIN_LEG_USD = 1
// Minutes between in-play reassessments and between entry re-runs of a market
// we previously skipped (bounds LLM cost without starving any match).
const DEFAULT_REASSESS_MIN = 15

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
export function stopDropPct(): number {
  // Default 0 = odds-stop disabled → hold to settlement.
  const v = Number(process.env.HOUSE_WC_STOP_DROP_PCT)
  return Number.isFinite(v) && v > 0 ? v : 0
}
export function marketTag(): string {
  return (process.env.HOUSE_WC_MARKET_TAG || DEFAULT_MARKET_TAG).toLowerCase()
}
/** Minutes between in-play reassessments / entry re-runs of a market. */
export function reassessMin(): number {
  return envNum('HOUSE_WC_REASSESS_MIN', DEFAULT_REASSESS_MIN)
}

/**
 * Conviction-tier position sizing within a per-match USD cap. A higher score
 * deploys more of the cap; a low score deploys only a base slice so headroom
 * remains for in-play top-ups as the read firms up. Fed the model's conviction
 * at ENTRY (pre-entry context) and the live on-chain win-or-draw probability
 * during in-play reassessment. Always clamped to [MIN_LEG_USD, cap].
 */
export function sizeForConviction(conviction: number, capUsd: number): number {
  const c = Number.isFinite(conviction) ? Math.max(0, Math.min(100, conviction)) : 0
  let frac: number
  if (c >= 80) frac = 1.0
  else if (c >= 65) frac = 0.75
  else if (c >= 50) frac = 0.5
  else frac = 0.3
  const sized = capUsd * frac
  return Math.max(MIN_LEG_USD, Math.min(capUsd, sized))
}

export type ReassessAction = 'add' | 'hold' | 'sell'

/**
 * Pure in-play decision for an already-open match: ADD (top up toward the
 * scaled target, never past the per-match cap), HOLD, or SELL — driven by
 * ON-CHAIN ODDS MOVEMENT ONLY. No LLM / news / sentiment is consulted in the
 * live loop: external signals are pre-entry context, never live add/exit drivers.
 *  - odds-stop (covered-side probability collapsed) always forces SELL.
 *  - otherwise the live target is sized off the covered side's CURRENT on-chain
 *    win-or-draw probability (sizeForConviction fed the live prob, not an LLM
 *    score): as the market firms in our favour the prob climbs into a higher
 *    tier and we top up toward that target while ≥$1 of cap headroom remains.
 *  - when the current target is already funded (flat/softening odds), HOLD.
 */
export function reassessAction(input: {
  currentProb: number
  spentUsd: number
  capUsd: number
  oddsStop: boolean
}): { action: ReassessAction; addUsd: number; reason: string } {
  const { currentProb, spentUsd, capUsd, oddsStop } = input
  if (oddsStop) {
    return { action: 'sell', addUsd: 0, reason: 'odds-stop: covered-side probability collapsed — exit' }
  }
  const probScore = Math.round(Math.max(0, Math.min(1, currentProb)) * 100)
  const target = sizeForConviction(probScore, capUsd)
  const remaining = Math.max(0, capUsd - spentUsd)
  const addUsd = Math.min(remaining, Math.max(0, target - spentUsd))
  if (addUsd >= MIN_LEG_USD) {
    return {
      action: 'add',
      addUsd: Math.round(addUsd * 100) / 100,
      reason: `reassess: on-chain win-or-draw ${probScore}% → target $${target.toFixed(0)} (spent $${spentUsd.toFixed(0)}/$${capUsd.toFixed(0)}) — top up $${addUsd.toFixed(0)}`,
    }
  }
  return { action: 'hold', addUsd: 0, reason: `reassess: target funded (spent $${spentUsd.toFixed(0)}/$${capUsd.toFixed(0)}, on-chain ${probScore}%) — hold` }
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

// ── Single-LLM team decision ──────────────────────────────────────────────

export interface TeamDecision {
  team: string | null   // canonical team to back (win-or-draw), or null ⇒ fail-closed (no bet)
  conviction: number    // 0..100 — the model's confidence the pick wins or draws
  thesis: string        // short rationale, surfaced in the brain feed
  reason: string        // human-readable decision / skip reason for the audit trail
  model: string         // model id that answered (audit trail)
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

/** Total REAL (non-dry) USD deployed on a market so far = sum of every OPEN_WC
 *  entry leg + every ADD_WC top-up leg. Used to enforce the per-match cap. */
async function marketSpentUsd(marketAddress: string): Promise<number> {
  const addr = ethers.getAddress(marketAddress)
  const rows = await db.$queryRawUnsafe<Array<{ spent: any }>>(
    `SELECT COALESCE(SUM((leg->>'usdt')::numeric), 0) AS spent
       FROM "HouseLog", jsonb_array_elements(meta->'legs') AS leg
      WHERE dex = '42'
        AND decision IN ('OPEN_WC','ADD_WC')
        AND meta ? 'marketAddress'
        AND LOWER(meta->>'marketAddress') = LOWER($1)
        AND COALESCE((meta->>'dryRun')::boolean, false) = false`,
    addr,
  )
  return Number(rows[0]?.spent ?? 0) || 0
}

/** True if an identical LIVE decision row for this market was logged within the
 *  window. Used both to de-spam the brain feed AND as the entry skip-cadence
 *  gate, so it MUST ignore dry-run rows — a dry-run admin tick must never
 *  suppress real live trading/logging on the next live tick. */
async function recentlyLoggedWcDecision(marketAddress: string, decision: string, withinMin: number): Promise<boolean> {
  const addr = ethers.getAddress(marketAddress)
  const rows = await db.$queryRawUnsafe<Array<{ n: any }>>(
    `SELECT COUNT(*)::int AS n
       FROM "HouseLog"
      WHERE dex = '42'
        AND decision = $2
        AND meta ? 'marketAddress'
        AND LOWER(meta->>'marketAddress') = LOWER($1)
        AND COALESCE((meta->>'dryRun')::boolean, false) = false
        AND "createdAt" > NOW() - make_interval(mins => $3::int)`,
    addr, decision, Math.max(1, Math.floor(withinMin)),
  )
  return Number(rows[0]?.n ?? 0) > 0
}

/** True once this match cycle has already been exited — i.e. there is an
 *  EXIT_WC row at/after the latest OPEN_WC entry for this market. A 42.space
 *  market address is unique per match, so an exit is terminal: we must NOT
 *  re-enter or top up a position we have already sold (the settlement claim
 *  sweep redeems any residual tokens from a partial liquidation). */
async function hasExitedWcMarket(marketAddress: string): Promise<boolean> {
  const addr = ethers.getAddress(marketAddress)
  const rows = await db.$queryRawUnsafe<Array<{ opened: Date | null; exited: Date | null }>>(
    `SELECT MAX("createdAt") FILTER (WHERE decision = 'OPEN_WC') AS opened,
            MAX("createdAt") FILTER (WHERE decision = 'EXIT_WC') AS exited
       FROM "HouseLog"
      WHERE dex = '42'
        AND decision IN ('OPEN_WC','EXIT_WC')
        AND meta ? 'marketAddress'
        AND LOWER(meta->>'marketAddress') = LOWER($1)
        AND COALESCE((meta->>'dryRun')::boolean, false) = false`,
    addr,
  )
  const opened = rows[0]?.opened
  const exited = rows[0]?.exited
  if (!exited) return false
  if (!opened) return true
  return new Date(exited).getTime() >= new Date(opened).getTime()
}

/** Persist a per-market SKIP decision to the brain feed (deduped within the
 *  reassess window so window-closed / non-GD markets don't flood the feed). The
 *  `dryRun` flag is stamped on the row so the live skip-cadence gate can ignore
 *  dry-run skips (recentlyLoggedWcDecision filters dryRun=false). */
async function logWcSkip(marketAddress: string, question: string, reason: string, dryRun: boolean, meta: Record<string, any> = {}): Promise<void> {
  try {
    if (await recentlyLoggedWcDecision(marketAddress, 'SKIP_WC', reassessMin())) return
    await logHouseBrain({
      dex: '42', kind: 'info', decision: 'SKIP_WC',
      reasoning: `house WC skip ${question.slice(0, 60)} — ${reason}`,
      meta: { marketAddress, reason, dryRun, ...meta },
    })
  } catch (e) {
    console.warn('[houseWorldCup] skip-log failed:', (e as Error).message)
  }
}

interface FilledLeg { index: number; tokenId: number; outcomeLabel: string; usdt: number; txHash: string | null }

/** Buy a win-or-draw basket across `indices` for `usd`, splitting stake ∝ price.
 *  Partial fills are acceptable (one reverted leg must not strand the rest).
 *  Shared by the initial entry and in-play top-ups. */
async function buyBasketLegs(args: {
  marketAddress: string
  m: Market42
  state: OnchainMarketState
  indices: number[]
  usd: number
  team: string
  thesis: string
  phase: 'entry' | 'topup'
  dryRun: boolean
}): Promise<{ legs: BasketLeg[]; filled: FilledLeg[] }> {
  const { marketAddress, m, state, indices, usd, team, thesis, phase, dryRun } = args
  const legs = allocateBasket(state.outcomes, indices, usd)
  const labelFor = (idx: number) => state.outcomes.find((o) => o.index === idx)?.label ?? `Outcome ${idx}`
  const filled: FilledLeg[] = []
  for (const leg of legs) {
    const outcomeLabel = labelFor(leg.index)
    try {
      const r = await houseOpenFortyTwoPosition({
        marketAddress,
        tokenId: leg.tokenId,
        outcomeLabel,
        usdtIn: leg.usdt.toFixed(2),
        contractVersion: m.contractVersion,
        dryRun,
        decision: 'OPEN_42',
        reasoning: `[HOUSE WC ${dryRun ? 'DRY ' : ''}${phase === 'topup' ? 'top-up ' : ''}win-or-draw] ${m.question.slice(0, 50)} → back ${team} · leg "${outcomeLabel}" $${leg.usdt.toFixed(2)} — ${thesis}`,
        meta: {
          campaign: 'world_cup_double_chance',
          phase,
          team,
          basketIndices: indices,
          legIndex: leg.index,
          question: m.question,
          endDate: m.endDate,
          contractVersion: m.contractVersion,
        },
      })
      filled.push({ index: leg.index, tokenId: leg.tokenId, outcomeLabel, usdt: leg.usdt, txHash: r.txHash })
    } catch (err) {
      console.warn(`[houseWorldCup] ${phase} leg buy failed market=${marketAddress.slice(0, 10)} idx=${leg.index}: ${(err as Error).message}`)
    }
  }
  return { legs, filled }
}

// ── Team pick (single-LLM prompt) ─────────────────────────────────────────

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

// Extract the first balanced top-level {...} object from a string. Smaller,
// open-weight models (e.g. Llama-3.3 via hyperbolic) frequently ignore JSON
// mode and wrap the object in prose ("Here's my pick: {...}. Hope that helps!"),
// which a whole-string JSON.parse rejects — that was surfacing as the
// "fail-closed: only 0/1 parsed" skip on every match. We scan brace depth so a
// trailing sentence (or a stray "}" in prose) doesn't over-capture.
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

/**
 * Ask the ONE funded model to pick a win-or-draw side. This is the whole brain —
 * no swarm, no quorum, no consensus. The model weighs the on-chain crowd odds, the recent
 * match news, and live X chatter (all baked into `prompt`) and decides itself.
 * STRICT fail-closed: any error, timeout, unparseable reply, or a team not on
 * the grid yields team=null (skip). We never bet real money on a failed or
 * garbage answer.
 */
async function decideTeam(
  prompt: { system: string; user: string },
  teamNames: string[],
): Promise<TeamDecision> {
  let model = '<error>'
  try {
    const r = await callLLM({
      provider: HOUSE_LLM_PROVIDER,
      system: prompt.system,
      user: prompt.user,
      jsonMode: true,
      maxTokens: 400,
      temperature: 0.4,
      timeoutMs: HOUSE_LLM_TIMEOUT_MS,
    })
    model = r.model
    const parsed = parseTeamReply(r.text, teamNames)
    if (!parsed) {
      return { team: null, conviction: 0, thesis: '', model, reason: `fail-closed: ${HOUSE_LLM_PROVIDER} reply unparseable` }
    }
    if (!parsed.team) {
      return { team: null, conviction: 0, thesis: parsed.thesis, model, reason: `fail-closed: ${HOUSE_LLM_PROVIDER} picked a team not on the grid` }
    }
    return {
      team: parsed.team,
      conviction: parsed.conviction,
      thesis: parsed.thesis || `back ${parsed.team} (win or draw)`,
      model,
      reason: `${HOUSE_LLM_PROVIDER} picked ${parsed.team} @ conviction ${parsed.conviction}`,
    }
  } catch (err) {
    console.warn(`[houseWorldCup] ${HOUSE_LLM_PROVIDER} decision failed:`, (err as Error).message)
    return { team: null, conviction: 0, thesis: '', model, reason: `fail-closed: ${HOUSE_LLM_PROVIDER} unavailable (${(err as Error).message})` }
  }
}

// ── Per-market orchestration ──────────────────────────────────────────────

export interface WcMarketResult {
  marketAddress: string
  question: string
  action: 'entered' | 'add' | 'hold' | 'skip' | 'exit' | 'error'
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

  // Bound entry LLM cost without starving any market: every candidate is
  // still evaluated each tick, but if we already logged a skip for this match
  // within the reassess window we don't re-read/re-decide it again so soon.
  if (await recentlyLoggedWcDecision(marketAddress, 'SKIP_WC', reassessMin())) {
    return { ...base, reason: 'recently skipped — within reassess window' }
  }

  let state: OnchainMarketState
  try {
    state = await readMarketOnchain(m)
  } catch (err) {
    return { ...base, action: 'error', reason: `on-chain read failed: ${(err as Error).message}` }
  }
  if (state.isFinalised) { await logWcSkip(marketAddress, m.question, 'finalised', opts.dryRun); return { ...base, reason: 'finalised' } }
  if (!state.outcomes.length) { await logWcSkip(marketAddress, m.question, 'no outcomes', opts.dryRun); return { ...base, reason: 'no outcomes' } }

  const parsed = parseGdMarket(state.outcomes.map((o) => o.label))
  if (!parsed) { await logWcSkip(marketAddress, m.question, 'not a goal-differential market', opts.dryRun); return { ...base, reason: 'not a goal-differential market' } }

  if (!tradingWindowOpen(Date.now(), state.timestampEnd, halftimeBeforeEndMin())) {
    await logWcSkip(marketAddress, m.question, 'trading window closed (past ~halftime cutoff)', opts.dryRun)
    return { ...base, reason: 'trading window closed (past ~halftime cutoff)' }
  }

  const teamNames = parsed.teams.map((t) => t.name)
  // Pull both online signals in parallel: GNews headlines + live X fan/pundit
  // chatter for THIS match. Both degrade to empty/null so a feed outage never
  // blocks a bet — the model then leans on crowd odds + its own knowledge.
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
  const decision = await decideTeam(prompt, teamNames)

  // STRICT FAIL-CLOSED: a single model decides. If it errors, times out, or
  // returns an unparseable / off-grid answer we sit the match out and persist
  // the skip to the brain feed for the audit trail — we never force-bet a market
  // favorite (or any other fallback) into a real-money position.
  const team = decision.team
  if (!team) {
    await logWcSkip(marketAddress, m.question, decision.reason, opts.dryRun, {
      provider: HOUSE_LLM_PROVIDER, model: decision.model, reason: decision.reason,
    })
    return { ...base, action: 'skip', reason: decision.reason }
  }

  const indices = winOrDrawBasketIndices(parsed, team)
  if (!indices) return { ...base, action: 'error', reason: `team "${team}" not found in parsed grid` }

  // Conviction-scaled initial stake within the per-match cap. A low-conviction
  // entry deploys only a base slice, leaving headroom for the in-play
  // reassessment loop to top up as the on-chain odds firm up in our favour.
  const cap = budgetUsd()
  const entryUsd = sizeForConviction(decision.conviction, cap)

  const entryBasketProb = basketImpliedProb(state.outcomes, indices)

  // Buy each leg. Partial success is acceptable — a single reverted leg
  // should not strand the rest of the double-chance basket.
  const { legs, filled } = await buyBasketLegs({
    marketAddress, m, state, indices, usd: entryUsd, team, thesis: decision.thesis, phase: 'entry', dryRun: opts.dryRun,
  })

  if (!legs.length) return { ...base, reason: 'allocation produced no fundable legs' }
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
      budgetUsd: cap,
      entryUsd,
      conviction: decision.conviction,
      legs: filled.map((f) => ({ index: f.index, tokenId: f.tokenId, outcomeLabel: f.outcomeLabel, usdt: f.usdt, txHash: f.txHash })),
      llm: { provider: HOUSE_LLM_PROVIDER, model: decision.model, team: decision.team, conviction: decision.conviction },
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

/** Liquidate every leg of an open WC basket on an odds-stop SELL. Logs EXIT_WC,
 *  and suppresses the settlement claim sweep ONLY on a fully-liquidated real run
 *  (a partial/throwing leg leaves the sweep active so residual tokens redeem). */
async function liquidateWcMarket(
  m: Market42,
  record: WcBasketRecord,
  currentProb: number,
  opts: { dryRun: boolean },
  cause: 'odds_stop',
  exitReason: string,
): Promise<WcMarketResult> {
  const marketAddress = ethers.getAddress(m.address)
  // Exit every leg. A leg is "cleared" when the sell call returns ok (sold, or
  // proved a zero balance). A leg that THROWS is "unclear" — we must NOT
  // suppress the settlement claim sweep for it, or stranded outcome tokens
  // would never be redeemed.
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
        reasoning: `[HOUSE WC odds-stop] exit ${record.team} leg "${leg.outcomeLabel}" — ${exitReason}`,
        meta: { campaign: 'world_cup_double_chance', reason: cause, entryBasketProb: record.entryBasketProb, currentProb },
      })
      legResults.push({ index: leg.index, cleared: true, sold: r.sold, txHash: r.txHash })
    } catch (err) {
      legResults.push({ index: leg.index, cleared: false, sold: false, txHash: null })
      console.warn(`[houseWorldCup] ${cause} sell failed idx=${leg.index}: ${(err as Error).message}`)
    }
  }

  // Full liquidation = every leg cleared on a real (non-dry) run. Only then is
  // it safe to suppress the settlement claim sweep; otherwise we leave the
  // sweep active so any residual outcome tokens are still redeemed at FT.
  const fullyLiquidated = !opts.dryRun && legResults.every((r) => r.cleared)

  await logHouseBrain({
    dex: '42', kind: 'trade', decision: 'EXIT_WC',
    reasoning: `🛑 HOUSE WC odds-stop exit on ${m.question.slice(0, 60)} — ${record.team} (prob ${(currentProb * 100).toFixed(1)}%, entry ${(record.entryBasketProb * 100).toFixed(1)}%)${fullyLiquidated ? '' : ' [PARTIAL — sweep left active]'} — ${exitReason}`.slice(0, 2000),
    meta: {
      campaign: 'world_cup_double_chance', marketAddress, team: record.team, cause,
      entryBasketProb: record.entryBasketProb, currentProb, dryRun: opts.dryRun,
      fullyLiquidated, legResults,
    },
  })
  if (fullyLiquidated) {
    await logHouseBrain({
      dex: '42', kind: 'info', decision: 'CLAIM_42',
      reasoning: `house WC market fully liquidated via ${cause} — no settlement claim needed (${marketAddress.slice(0, 10)}…)`,
      meta: { marketAddress, exited: true, reason: cause },
    })
  }

  return { marketAddress, question: m.question, action: 'exit', reason: exitReason, team: record.team, basketProb: currentProb }
}

/**
 * In-play reassessment of an already-entered market: ADD / HOLD / SELL — driven
 * by ON-CHAIN ODDS ONLY. No swarm / news / X is consulted here: external signals
 * are pre-entry context, never live add/exit drivers. odds-stop forces a SELL on
 * any tick; otherwise the position scales toward a target sized off the covered
 * side's CURRENT on-chain win-or-draw probability — never exceeding the per-match
 * cap — and persists its decision (ADD_WC / HOLD_WC / EXIT_WC) to the brain feed.
 */
async function reassessMarket(m: Market42, opts: { dryRun: boolean }): Promise<WcMarketResult> {
  const marketAddress = ethers.getAddress(m.address)
  const base: WcMarketResult = { marketAddress, question: m.question, action: 'hold', reason: 'holding to settlement' }

  const record = await findWcBasket(marketAddress)
  if (!record || !record.indices.length) return { ...base, action: 'skip', reason: 'no basket record to monitor' }

  // An exit is terminal for the match: once we have sold this market we must
  // never re-enter or top it up on a later tick (the routing probe only sees
  // the original OPEN_42 row, so it keeps routing here). Any residual tokens
  // from a partial liquidation are redeemed by the settlement claim sweep.
  if (await hasExitedWcMarket(marketAddress)) {
    return { ...base, action: 'skip', reason: 'already exited this match — holding to settlement' }
  }

  let state: OnchainMarketState
  try {
    state = await readMarketOnchain(m)
  } catch (err) {
    return { ...base, action: 'error', reason: `on-chain read failed: ${(err as Error).message}` }
  }
  if (state.isFinalised) return { ...base, action: 'skip', reason: 'finalised — claim sweep will settle' }
  if (!tradingWindowOpen(Date.now(), state.timestampEnd, halftimeBeforeEndMin())) {
    return { ...base, action: 'skip', reason: 'window closed — holding to settlement' }
  }

  const currentProb = basketImpliedProb(state.outcomes, record.indices)
  const dropPct = stopDropPct()
  const oddsStop = dropPct > 0 && oddsStopTriggered(record.entryBasketProb, currentProb, dropPct)

  const spentUsd = await marketSpentUsd(marketAddress)
  const cap = budgetUsd()

  // In-play decision is ON-CHAIN ODDS ONLY — no swarm / news / X is consulted
  // here (they are pre-entry context). odds-stop → sell; otherwise top up
  // toward the live on-chain win-or-draw target while cap headroom remains.
  const act = reassessAction({ currentProb, spentUsd, capUsd: cap, oddsStop })

  if (act.action === 'sell') {
    return await liquidateWcMarket(m, record, currentProb, opts, 'odds_stop', act.reason)
  }

  if (act.action === 'add') {
    const { filled } = await buyBasketLegs({
      marketAddress, m, state, indices: record.indices, usd: act.addUsd, team: record.team,
      thesis: act.reason, phase: 'topup', dryRun: opts.dryRun,
    })
    if (!filled.length) {
      // Top-up failed to fill — record a hold so we don't loop on the same add.
      await logHouseBrain({
        dex: '42', kind: 'info', decision: 'HOLD_WC',
        reasoning: `house WC top-up failed to fill on ${m.question.slice(0, 60)} — holding ${record.team} (spent $${spentUsd.toFixed(0)}/$${cap.toFixed(0)})`,
        meta: { campaign: 'world_cup_double_chance', marketAddress, team: record.team, spentUsd, budgetUsd: cap, currentProb, dryRun: opts.dryRun, addFailed: true },
      })
      return { ...base, action: 'hold', reason: 'top-up failed to fill — holding' }
    }
    const added = filled.reduce((s, f) => s + f.usdt, 0)
    await logHouseBrain({
      dex: '42', kind: 'trade', decision: 'ADD_WC',
      reasoning: `➕ HOUSE WC ${opts.dryRun ? '[DRY] ' : ''}top-up ${record.team} on ${m.question.slice(0, 60)} +$${added.toFixed(2)} (now ~$${(spentUsd + added).toFixed(0)}/$${cap.toFixed(0)}, on-chain ${(currentProb * 100).toFixed(1)}%) — ${act.reason}`.slice(0, 2000),
      meta: {
        campaign: 'world_cup_double_chance', marketAddress, question: m.question, team: record.team,
        indices: record.indices, budgetUsd: cap, spentUsd, addUsd: added, currentProb,
        legs: filled.map((f) => ({ index: f.index, tokenId: f.tokenId, outcomeLabel: f.outcomeLabel, usdt: f.usdt, txHash: f.txHash })),
        dryRun: opts.dryRun,
      },
    })
    return { marketAddress, question: m.question, action: 'add', reason: act.reason, team: record.team, basketProb: currentProb }
  }

  // HOLD — persist the (deduped) reassessment to the brain feed.
  if (!(await recentlyLoggedWcDecision(marketAddress, 'HOLD_WC', reassessMin()))) {
    await logHouseBrain({
      dex: '42', kind: 'info', decision: 'HOLD_WC',
      reasoning: `✋ HOUSE WC hold ${record.team} on ${m.question.slice(0, 60)} (spent $${spentUsd.toFixed(0)}/$${cap.toFixed(0)}, prob ${(currentProb * 100).toFixed(1)}%) — ${act.reason}`.slice(0, 2000),
      meta: {
        campaign: 'world_cup_double_chance', marketAddress, question: m.question, team: record.team,
        budgetUsd: cap, spentUsd, currentProb,
        dryRun: opts.dryRun,
      },
    })
  }
  return { marketAddress, question: m.question, action: 'hold', reason: act.reason, team: record.team, basketProb: currentProb }
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

// ── Public tick ───────────────────────────────────────────────────────────

export interface RunWcTickOptions {
  /** Force dry-run (no on-chain tx). Default false → LIVE + REAL. */
  dryRun?: boolean
  /** Bypass the HOUSE_WC_ENABLED gate (admin/manual runs). */
  force?: boolean
}

/**
 * One autonomous World-Cup campaign tick: enumerate live GD markets, enter
 * any un-entered match with an LLM-backed win-or-draw basket, and run the
 * odds-stop monitor on open positions. LIVE by default; gated via the House
 * Agent panel state (enabled + mode='campaign' + dex='42'), with a legacy
 * HOUSE_WC_ENABLED override and opts.force for admin/tests.
 */
let wcTickInFlight = false

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

  // Single-flight: the 2-min cron and the admin endpoint share cap accounting
  // (marketSpentUsd is read per market then spent against), so overlapping runs
  // could double-add past the per-match cap. Refuse a concurrent run.
  if (wcTickInFlight) {
    return { ran: false, reason: 'tick_in_flight', scanned: 0, candidates: 0, processed: 0, results: [] }
  }
  wcTickInFlight = true
  try {
    return await runWcTickBody(!!opts.dryRun)
  } finally {
    wcTickInFlight = false
  }
}

async function runWcTickBody(dryRun: boolean): Promise<WcTickResult> {
  let markets: Market42[]
  try {
    markets = await getAllMarkets({ status: 'live', limit: 100 })
  } catch (err) {
    await recordHouseTick(`42:market_list_failed:${(err as Error).message.slice(0, 60)}`)
    return { ran: true, reason: `market list failed: ${(err as Error).message}`, scanned: 0, candidates: 0, processed: 0, results: [] }
  }

  // Process EVERY eligible live match each tick — no per-tick slice cap. A cap
  // would perpetually starve lower-ranked markets (earlier ones keep getting
  // reassessed every tick), so every candidate is evaluated. Entry LLM cost
  // is bounded per-market by enterMarket's own skip-cadence gate, not by
  // dropping markets from the list.
  const candidates = markets.filter((m) => looksLikeGdMarketMeta(m) && looksLikeWorldCupMarket(m))
  const results: WcMarketResult[] = []

  for (const m of candidates) {
    try {
      const existing = await findOpenHousePosition(m.address)
      if (existing) {
        results.push(await reassessMarket(m, { dryRun }))
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
  const added = results.filter((r) => r.action === 'add').length
  const held = results.filter((r) => r.action === 'hold').length
  console.log(
    `[houseWorldCup] tick done — scanned=${markets.length} candidates=${candidates.length} processed=${candidates.length} entered=${entered} added=${added} held=${held} exited=${exited} dryRun=${dryRun}`,
  )

  await recordHouseTick(
    `42:scanned=${markets.length} candidates=${candidates.length} entered=${entered} added=${added} held=${held} exited=${exited}${dryRun ? ' (dry)' : ''}`,
  )

  return { ran: true, scanned: markets.length, candidates: candidates.length, processed: candidates.length, results }
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
  looksLikeGdMarketMeta,
  looksLikeWorldCupMarket,
  competitionTokens,
  sizeForConviction,
  reassessAction,
}

// =====================================================================
// houseFortyTwoSportsBrain — sports-aware 4-LLM swarm brain for the
// BUILD4 House Agent on a specific 42.space market (by address).
//
// Unlike fortyTwoCampaign (BTC TA hardcoded) and fortyTwoPrompt (keyword
// whitelist filters out sports), this brain is venue+topic agnostic:
//   - Caller supplies the market address (e.g. UCL Final).
//   - We pull market metadata + on-chain bucket prices.
//   - We fetch news with a market-derived query (title + categories/tags).
//   - We ask the 4-LLM swarm to pick a bucket.
//   - We aggregate via crowd-consensus tie-break (no spot price for sports).
//   - We size by conviction tier and open via houseFortyTwoExecutor.
//
// Public surface:
//   - runHouseFortyTwoPick({marketAddress, dryRun, force})
// =====================================================================

import { ethers } from 'ethers'
import { getMarketByAddress, type Market42 } from '../services/fortyTwo'
import { readMarketOnchain, type OnchainMarketState } from '../services/fortyTwoOnchain'
import { callLLM, resolveProviders, type Provider } from '../services/inference'
import { fetchTrendingNews, type NewsSignal } from '../services/newsService'
import {
  houseOpenFortyTwoPosition,
  findOpenHousePosition,
  type HouseFortyTwoOpenResult,
} from '../services/houseFortyTwoExecutor'
import { logHouseBrain, getHouseWalletAddress } from '../services/houseAgent'
import { getBot } from './runner'

// Default to xai only (cost). Override with HOUSE_SWARM_PROVIDERS (comma-separated)
// to restore the multi-LLM swarm; the vote thresholds below scale with this count.
const SWARM_PROVIDERS: Provider[] = resolveProviders('HOUSE_SWARM_PROVIDERS', ['xai'])

// Conviction → size tier (USDT). Each tier is capped by HOUSE_42SPACE_MAX_USD.
const SIZE_LOW = 25
const SIZE_MED = 75
const SIZE_HIGH = 150
const DEFAULT_HARD_CAP_USD = 200

function hardCapUsd(): number {
  const v = Number(process.env.HOUSE_42SPACE_MAX_USD)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_HARD_CAP_USD
}

export interface SportsSwarmVote {
  provider: Provider
  model: string
  bucketIndex: number | null
  conviction: number
  thesis: string
  parsed: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

export interface HouseFortyTwoPickInput {
  marketAddress: string
  /** When true, no on-chain tx — full LLM run + synthetic receipt + dry HouseLog row. */
  dryRun?: boolean
  /** When true, bypass the idempotency check that refuses a second entry. */
  force?: boolean
  /** Override the news query (default: derived from market title + categories). */
  newsQuery?: string
}

export interface HouseFortyTwoPickResult {
  ok: boolean
  reason?: string
  dryRun: boolean
  marketAddress: string
  market?: { question: string; address: string; endDate: string; categories?: string[] }
  swarm?: SportsSwarmVote[]
  bucketIndex?: number
  bucketLabel?: string
  bucketImpliedProbability?: number
  sizeUsdt?: number
  trade?: HouseFortyTwoOpenResult
  thesis?: string
  existing?: { txHash: string | null; outcomeLabel: string; usdtIn: number; createdAt: Date }
  /** Whether the Telegram broadcast to FT_CAMPAIGN_TG_CHANNEL succeeded. null = not attempted (e.g. SKIP path or env unset). */
  broadcast?: { attempted: boolean; ok: boolean; error?: string; channelConfigured: boolean }
}

/**
 * Run one swarm-driven pick on the supplied 42.space market from the
 * House Agent wallet. Side-effects (HouseLog rows, TG broadcast, on-chain
 * tx) only fire when the swarm produces a confident pick AND idempotency
 * allows it.
 */
export async function runHouseFortyTwoPick(
  input: HouseFortyTwoPickInput,
): Promise<HouseFortyTwoPickResult> {
  const marketAddress = ethers.getAddress(input.marketAddress)
  const dryRun = !!input.dryRun
  const baseResult: HouseFortyTwoPickResult = { ok: false, dryRun, marketAddress }

  // 1. Sanity: house key must be configured before we burn LLM credits.
  try { getHouseWalletAddress() } catch (err) {
    return { ...baseResult, reason: `house wallet unavailable: ${(err as Error).message}` }
  }

  // 2. Idempotency — refuse a duplicate non-dry entry on the same market.
  if (!input.force && !dryRun) {
    const existing = await findOpenHousePosition(marketAddress)
    if (existing) {
      return {
        ...baseResult,
        ok: true,
        reason: `house already opened position on this market (txHash=${existing.txHash ?? 'pending'})`,
        existing: {
          txHash: existing.txHash,
          outcomeLabel: existing.outcomeLabel,
          usdtIn: existing.usdtIn,
          createdAt: existing.createdAt,
        },
      }
    }
  }

  // 3. Fetch market metadata + on-chain state in parallel.
  let market: Market42
  let state: OnchainMarketState
  try {
    market = await getMarketByAddress(marketAddress)
  } catch (err) {
    return { ...baseResult, reason: `market lookup failed: ${(err as Error).message}` }
  }
  try {
    state = await readMarketOnchain(market)
  } catch (err) {
    return { ...baseResult, reason: `on-chain read failed: ${(err as Error).message}` }
  }
  if (!state.outcomes.length) {
    return { ...baseResult, reason: 'market has no outcomes' }
  }
  if (state.isFinalised) {
    return { ...baseResult, reason: 'market is already finalised — use claim, not open' }
  }

  // 4. Optional news context — best-effort, never blocks the pick.
  const newsQuery = input.newsQuery ?? deriveNewsQuery(market)
  let news: NewsSignal[] = []
  try {
    news = await fetchTrendingNews({ query: newsQuery, lookbackHours: 24, limit: 6 })
  } catch (err) {
    console.warn(`[houseFortyTwoSportsBrain] news fetch failed: ${(err as Error).message}`)
  }

  // 5. Run the swarm.
  const prompt = buildSportsPrompt(market, state, news)
  const votes = await runSwarm(prompt)

  // 6. Aggregate. Crowd-consensus tie-break (no spot price for sports).
  const decision = aggregateSportsVotes(votes, state)
  console.log(
    `[houseFortyTwoSportsBrain] market=${marketAddress.slice(0, 10)}… ` +
      `bucket=${decision.bucketIndex} (${state.outcomes[decision.bucketIndex]?.label}) ` +
      `tier=${decision.sizeUsdt} dryRun=${dryRun}`,
  )

  const outcome = state.outcomes[decision.bucketIndex]
  if (!outcome) {
    return { ...baseResult, reason: `bucket index ${decision.bucketIndex} out of range`, swarm: votes }
  }

  // 7. Size — clamp to hard cap.
  const sizeUsdt = Math.min(decision.sizeUsdt, hardCapUsd())
  if (sizeUsdt < 1) {
    await logHouseBrain({
      dex: '42',
      kind: 'info',
      decision: 'SKIP_42',
      reasoning: `house 42.space SKIP on market=${marketAddress.slice(0, 10)}… — swarm conviction too low (${decision.avgConviction})`,
      meta: { marketAddress, votes: votes.length, parsed: votes.filter((v) => v.parsed).length },
    })
    return {
      ...baseResult,
      ok: true,
      reason: `swarm conviction below entry tier (avg=${decision.avgConviction})`,
      swarm: votes,
      bucketIndex: decision.bucketIndex,
      bucketLabel: outcome.label,
      bucketImpliedProbability: outcome.impliedProbability,
      thesis: decision.thesis,
      market: { question: market.question, address: market.address, endDate: market.endDate, categories: market.categories },
    }
  }

  // 8. Execute. Dry-run paths take the same HouseLog row but no on-chain tx.
  let trade: HouseFortyTwoOpenResult
  try {
    trade = await houseOpenFortyTwoPosition({
      marketAddress,
      tokenId: outcome.tokenId,
      outcomeLabel: outcome.label,
      usdtIn: sizeUsdt.toFixed(2),
      reasoning: `[HOUSE 42 ${dryRun ? 'DRY ' : ''}PICK] ${market.question.slice(0, 60)} → "${outcome.label}" — ${decision.thesis}`,
      dryRun,
      decision: 'OPEN_42',
      meta: {
        question: market.question,
        endDate: market.endDate,
        impliedProbability: outcome.impliedProbability,
        swarmParsed: votes.filter((v) => v.parsed).length,
        swarmTotal: votes.length,
        avgConviction: decision.avgConviction,
        newsCount: news.length,
      },
    })
  } catch (err) {
    return {
      ...baseResult,
      reason: `executor failed: ${(err as Error).message}`,
      swarm: votes,
      bucketIndex: decision.bucketIndex,
      bucketLabel: outcome.label,
      bucketImpliedProbability: outcome.impliedProbability,
      sizeUsdt,
      thesis: decision.thesis,
      market: { question: market.question, address: market.address, endDate: market.endDate, categories: market.categories },
    }
  }

  // 9. Broadcast — TG channel + log to HouseLog as info row for the brain feed.
  // Best-effort: a failed channel post never voids the trade, but we surface
  // the outcome in the API response so admin can manually re-post on failure.
  const channelConfigured = !!process.env.FT_CAMPAIGN_TG_CHANNEL
  let broadcast: HouseFortyTwoPickResult['broadcast'] = {
    attempted: channelConfigured,
    ok: false,
    channelConfigured,
  }
  try {
    await broadcastHousePick({
      market,
      outcome,
      sizeUsdt,
      thesis: decision.thesis,
      swarm: votes,
      dryRun,
      txHash: trade.txHash,
    })
    broadcast = { attempted: channelConfigured, ok: true, channelConfigured }
  } catch (err) {
    const msg = (err as Error).message
    console.warn('[houseFortyTwoSportsBrain] broadcast failed:', msg)
    broadcast = { attempted: channelConfigured, ok: false, error: msg, channelConfigured }
  }

  return {
    ok: true,
    dryRun,
    marketAddress,
    market: { question: market.question, address: market.address, endDate: market.endDate, categories: market.categories },
    swarm: votes,
    bucketIndex: decision.bucketIndex,
    bucketLabel: outcome.label,
    bucketImpliedProbability: outcome.impliedProbability,
    sizeUsdt,
    trade,
    thesis: decision.thesis,
    broadcast,
  }
}

// ── Prompt ────────────────────────────────────────────────────────────────

function buildSportsPrompt(
  market: Market42,
  state: OnchainMarketState,
  news: NewsSignal[],
): { system: string; user: string } {
  const buckets = state.outcomes
    .map(
      (o) =>
        `  ${o.index.toString().padStart(2)}  ${o.label.padEnd(36)}  ` +
        `prob=${(o.impliedProbability * 100).toFixed(1).padStart(5)}%  ` +
        `mult=${o.impliedProbability > 0 ? (1 / o.impliedProbability).toFixed(2) : '∞'}x`,
    )
    .join('\n')

  const newsBlock = news.length
    ? news.map((n) => `  [${n.source}] ${n.title}${n.description ? ` — ${n.description.slice(0, 160)}` : ''}`).join('\n')
    : '  (no recent news available)'

  const crowd = state.outcomes.reduce((best, o) =>
    o.impliedProbability > best.impliedProbability ? o : best,
  )

  const system = [
    'You are a senior prediction-market analyst on the BUILD4 House Agent.',
    'Your job: pick the single most likely outcome bucket for a 42.space',
    'prediction market based on the market question, the on-chain bucket',
    'grid (with crowd-implied probabilities), and any provided news context.',
    'The market may be about sports, geopolitics, AI, crypto, weather, or',
    'anything else — adapt your reasoning to the domain. You MUST pick a',
    'bucket; abstaining is not allowed. Prefer high-conviction edges over',
    'tail bets unless the multiplier clearly justifies the risk.',
    'Reply with strict JSON only — no prose, no code fences.',
  ].join(' ')

  const categories = (market.categories ?? []).concat(market.tags ?? []).filter(Boolean).join(', ') || '(none)'

  const user = [
    `MARKET QUESTION:  ${market.question}`,
    `Resolution time:  ${market.endDate}`,
    `Categories/tags:  ${categories}`,
    market.description ? `Description:      ${market.description.slice(0, 400)}` : '',
    '',
    `Bucket grid (${state.outcomes.length} buckets — pick ONE by index):`,
    buckets,
    '',
    `Crowd consensus: bucket ${crowd.index} (${crowd.label}) at ${(crowd.impliedProbability * 100).toFixed(1)}%`,
    '',
    `Recent news (last 24h, filtered for relevance):`,
    newsBlock,
    '',
    'Reply with JSON exactly:',
    '{"bucketIndex": <int 0..N-1>, "conviction": <int 0..100>, "thesis": "<<= 240 chars>"}',
    'Conviction scale:  <60 = skip (no entry), 60-69 = low ($25), 70-84 = medium ($75), 85+ = high ($150).',
  ].filter(Boolean).join('\n')

  return { system, user }
}

function deriveNewsQuery(market: Market42): string {
  // Use the market title verbatim — sports markets ("Champions League Final")
  // give GNews enough signal on their own. Strip prediction-market boilerplate
  // ("Who will win", "What will be the score") so the query is mostly entities.
  const q = market.question
    .replace(/^(who|what|will|when|how)\s+/i, '')
    .replace(/\?+$/, '')
    .trim()
  return q || 'football'
}

// ── Swarm ─────────────────────────────────────────────────────────────────

async function runSwarm(prompt: { system: string; user: string }): Promise<SportsSwarmVote[]> {
  const calls = SWARM_PROVIDERS.map(async (provider): Promise<SportsSwarmVote> => {
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
      const parsed = parseReply(r.text)
      return {
        provider,
        model: r.model,
        bucketIndex: parsed?.bucketIndex ?? null,
        conviction: parsed?.conviction ?? 0,
        thesis: parsed?.thesis ?? '',
        parsed: !!parsed,
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      }
    } catch (err) {
      console.warn(`[houseFortyTwoSportsBrain] provider ${provider} failed:`, (err as Error).message)
      return {
        provider, model: '<error>',
        bucketIndex: null, conviction: 0,
        thesis: `[${provider} unavailable]`,
        parsed: false, latencyMs: 0, inputTokens: 0, outputTokens: 0,
      }
    }
  })
  return Promise.all(calls)
}

function parseReply(raw: string): { bucketIndex: number; conviction: number; thesis: string } | null {
  if (!raw) return null
  const stripped = raw.replace(/```json\s*|\s*```/g, '').trim()
  try {
    const j = JSON.parse(stripped)
    const bucketIndex = Number(j.bucketIndex)
    const conviction = Number(j.conviction)
    const thesis = String(j.thesis ?? '').slice(0, 240)
    if (!Number.isInteger(bucketIndex) || bucketIndex < 0) return null
    if (!Number.isFinite(conviction) || conviction < 0 || conviction > 100) return null
    return { bucketIndex, conviction, thesis }
  } catch {
    return null
  }
}

// ── Aggregator ────────────────────────────────────────────────────────────

interface SportsDecision {
  bucketIndex: number
  sizeUsdt: number
  avgConviction: number
  thesis: string
}

/**
 * Aggregate sports swarm picks. STRICT fail-closed: only trades on a
 * clear swarm consensus. Any disagreement pattern (1-1-1-1, 2-2, 2-1-1)
 * is treated as NO consensus and returns sizeUsdt=0 (no entry).
 *
 * Required for entry:
 *   - ≥3 parsed votes from the 4 providers (one tolerated failure)
 *   - Either strict majority (≥3 on the same bucket) OR
 *     clear plurality with ≥2 supporters AND ≥1-vote margin over runner-up
 *
 * Crowd-consensus tie-break is REMOVED from the funded path — if the
 * swarm can't reach a verdict, the house does not trade. Crowd bucket is
 * still surfaced for the SKIP log row so admins can see what was passed up.
 */
function aggregateSportsVotes(
  votes: SportsSwarmVote[],
  state: OnchainMarketState,
): SportsDecision {
  const parsed = votes.filter((v) => v.parsed && v.bucketIndex !== null)
  const crowdBucket = state.outcomes.reduce((best, o) =>
    o.impliedProbability > best.impliedProbability ? o : best,
  ).index

  // Thresholds scale with the configured provider count so the swarm degrades
  // correctly to a single LLM (n=1 ⇒ that one parsed vote decides) and still
  // demands a 3/4 parse + ≥2-vote agreement when run as the full 4-provider swarm.
  const n = SWARM_PROVIDERS.length
  const minParsed = Math.max(1, n - 1)
  const majorityNeeded = Math.floor(n / 2) + 1
  const minPlurality = Math.min(2, n)

  if (parsed.length < minParsed) {
    return {
      bucketIndex: crowdBucket,
      sizeUsdt: 0,
      avgConviction: 0,
      thesis: `swarm fail-closed: only ${parsed.length}/${votes.length} providers parsed — no entry`,
    }
  }

  const tally = new Map<number, number>()
  for (const v of parsed) tally.set(v.bucketIndex!, (tally.get(v.bucketIndex!) ?? 0) + 1)
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1])

  const topCount = sorted[0][1]
  const runnerUpCount = sorted[1]?.[1] ?? 0
  const hasMajority = topCount >= majorityNeeded
  const hasClearPlurality = topCount >= minPlurality && topCount > runnerUpCount

  if (!hasMajority && !hasClearPlurality) {
    return {
      bucketIndex: crowdBucket,
      sizeUsdt: 0,
      avgConviction: 0,
      thesis:
        `swarm fail-closed: no consensus (` +
        sorted.map(([b, c]) => `${c}×bucket${b}`).join(', ') +
        `) — no entry`,
    }
  }

  const picked = sorted[0][0]
  const supporters = parsed.filter((v) => v.bucketIndex === picked)
  const avgConv = supporters.reduce((s, v) => s + v.conviction, 0) / supporters.length
  const champion = supporters.sort((a, b) => b.conviction - a.conviction)[0]
  const sizeUsdt = convictionTierToSize(avgConv)
  return {
    bucketIndex: picked,
    sizeUsdt,
    avgConviction: Math.round(avgConv),
    thesis:
      champion?.thesis ||
      `swarm consensus on bucket ${picked} (${topCount}/${parsed.length} parsed, ${votes.length} total)`,
  }
}

function pickHighestCrowdProb(candidates: number[], state: OnchainMarketState): number {
  let best = candidates[0]
  let bestProb = -1
  for (const idx of candidates) {
    const o = state.outcomes.find((x) => x.index === idx)
    if (o && o.impliedProbability > bestProb) {
      bestProb = o.impliedProbability
      best = idx
    }
  }
  return best
}

function convictionTierToSize(conviction: number): number {
  if (conviction >= 85) return SIZE_HIGH
  if (conviction >= 70) return SIZE_MED
  if (conviction >= 60) return SIZE_LOW
  return 0
}

// ── Broadcast ─────────────────────────────────────────────────────────────

interface BroadcastInput {
  market: Market42
  outcome: OnchainMarketState['outcomes'][number]
  sizeUsdt: number
  thesis: string
  swarm: SportsSwarmVote[]
  dryRun: boolean
  txHash: string | null
}

async function broadcastHousePick(input: BroadcastInput): Promise<void> {
  const mult = input.outcome.impliedProbability > 0 ? (1 / input.outcome.impliedProbability).toFixed(2) : '∞'
  const dryTag = input.dryRun ? '[DRY-RUN] ' : ''
  const headline =
    `${dryTag}🏛️ BUILD4 House Agent picked "${input.outcome.label}" on 42.space — ` +
    `$${input.sizeUsdt.toFixed(0)} @ ${mult}x`

  await logHouseBrain({
    dex: '42',
    kind: 'info',
    decision: input.dryRun ? 'BROADCAST_42_DRY' : 'BROADCAST_42',
    reasoning: `${headline}\n${input.thesis}`.slice(0, 2000),
    txHash: input.txHash,
    meta: {
      marketAddress: input.market.address,
      tokenId: input.outcome.tokenId,
      outcomeLabel: input.outcome.label,
      sizeUsdt: input.sizeUsdt,
      multiplier: mult,
      swarm: input.swarm.map((v) => ({
        provider: v.provider,
        model: v.model,
        bucketIndex: v.bucketIndex,
        conviction: v.conviction,
        parsed: v.parsed,
      })),
    },
  })

  const channel = process.env.FT_CAMPAIGN_TG_CHANNEL
  if (!channel) return
  const bot = getBot()
  if (!bot) {
    throw new Error('FT_CAMPAIGN_TG_CHANNEL is set but Telegram bot is not initialised')
  }
  const username = bot.botInfo?.username
  const swarmLine = input.swarm.length
    ? `\n\n🧠 *Swarm verdict (${input.swarm.length} models):* ` +
      input.swarm
        .map((v) => `${v.provider}=${v.parsed ? 'bucket' + v.bucketIndex : 'err'}`)
        .join(' · ')
    : ''
  const txLine = input.txHash && !input.dryRun
    ? `\n\n🔗 [tx on BscScan](https://bscscan.com/tx/${input.txHash})`
    : ''
  const text =
    `🤖 *${headline}*\n\n` +
    `Market: _${input.market.question}_\n` +
    `Thesis: ${input.thesis}${swarmLine}${txLine}`
  const reply_markup = username
    ? {
        inline_keyboard: [
          [{ text: '⚡ Open BUILD4 mini-app', url: `https://t.me/${username}/app?startapp=house42` }],
          [
            { text: '💬 Start bot', url: `https://t.me/${username}?start=house42` },
            { text: '📊 View on 42.space', url: `https://42.space/market/${input.market.address}` },
          ],
        ],
      }
    : undefined
  // Let send errors propagate — the caller surfaces them in the API
  // response so failures are visible instead of silently swallowed.
  await bot.api.sendMessage(channel, text, {
    parse_mode: 'Markdown',
    reply_markup,
    link_preview_options: { is_disabled: true },
  } as any)
}

// ── Test seam ─────────────────────────────────────────────────────────────

export const __testInternals = {
  parseReply,
  aggregateSportsVotes,
  buildSportsPrompt,
  convictionTierToSize,
  deriveNewsQuery,
}

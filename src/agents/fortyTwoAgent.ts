// ─────────────────────────────────────────────────────────────────────────
// fortyTwoAgent — regular (non-campaign) 42.space scan tick.
//
// Mirrors tickAllPolymarketAgents in shape: shared markets fetch per
// sweep, per-agent loop, bounded LLM cost via crypto+price filter.
// Skips the campaign agent (FT_CAMPAIGN_AGENT_ID) — that one runs on
// its own +5m / +1h30m / +3h / +3h45m schedule with its own swarm.
//
// Trade execution dispatch is wired for telemetry only this iteration:
// the prediction-side BUY through fortyTwoExecutor is left to the
// follow-up tracked in task #93. Keeps the cost-reduction change
// risk-free for production.
// ─────────────────────────────────────────────────────────────────────────

import { db } from '../db'
import { getAllMarkets, type Market42 } from '../services/fortyTwo'
import { isTradingRelevant } from '../services/fortyTwoPrompt'
import { scorePredictionMarket, type PredictionDecision } from './predictionBrain'

const MAX_MARKETS_PER_TICK = 5

const FT_PRICE_KW = ['$', 'price', 'reach', 'close above', 'close below', ' above ', ' below ', 'high of', 'low of', 'all-time high', 'ath']

function isCryptoPriceMarket(m: Market42): boolean {
  if (!isTradingRelevant(m)) return false
  const hay = ((m.question ?? '') + ' ' + (m.categories ?? []).join(' ')).toLowerCase()
  return FT_PRICE_KW.some((k) => hay.includes(k))
}

interface FortyTwoSweepResult {
  scanned: number
  ticked: number
  ordersPlaced: number
  ordersSkipped: number
  errors: number
}

export async function tickAllFortyTwoAgents(): Promise<FortyTwoSweepResult> {
  const result: FortyTwoSweepResult = {
    scanned: 0, ticked: 0, ordersPlaced: 0, ordersSkipped: 0, errors: 0,
  }

  const campaignAgentId = process.env.FT_CAMPAIGN_AGENT_ID ?? ''

  let allMarkets: Market42[] = []
  try {
    allMarkets = await getAllMarkets()
  } catch (err) {
    console.warn('[fortyTwoAgent] getAllMarkets failed:', (err as Error).message)
    result.errors++
    return result
  }

  const candidates = allMarkets.filter(isCryptoPriceMarket).slice(0, MAX_MARKETS_PER_TICK)
  result.scanned = candidates.length
  if (candidates.length === 0) return result

  let agents: Array<{ id: string; userId: string; name: string }> = []
  try {
    agents = await db.agent.findMany({
      where: {
        isActive: true,
        ...(campaignAgentId ? { id: { not: campaignAgentId } } : {}),
        OR: [{ enabledVenues: { has: '42' } }, { enabledVenues: { has: 'fortytwo' } }],
      },
      select: { id: true, userId: true, name: true },
    })
  } catch (err) {
    console.warn('[fortyTwoAgent] agent fetch failed:', (err as Error).message)
    result.errors++
    return result
  }

  // Score the candidate markets ONCE per sweep, not per agent — every
  // agent sees the same edge call, so caching the verdict at sweep
  // scope keeps LLM cost O(MAX_MARKETS_PER_TICK), not O(agents × markets).
  const verdicts = new Map<string, PredictionDecision | null>()
  for (const m of candidates) {
    try {
      const decision = await scorePredictionMarket({
        venue: 'fortytwo',
        eventTitle: null,
        question: m.question,
        description: m.description ?? null,
        endDateIso: m.endDate ?? null,
        outcomes: ['Yes', 'No'],
        yesPrice: null,
        noPrice: null,
        category: (m.categories ?? []).join(', ') || null,
      })
      verdicts.set(m.address, decision)
    } catch (err) {
      verdicts.set(m.address, null)
      console.warn(`[fortyTwoAgent] score failed market=${m.address}: ${(err as Error).message.slice(0, 120)}`)
      result.errors++
    }
  }

  for (const _agent of agents) {
    result.ticked++
    for (const v of verdicts.values()) {
      if (v && v.action === 'BUY') {
        result.ordersSkipped++ // execution leg deferred to follow-up #93
      } else {
        result.ordersSkipped++
      }
    }
  }

  return result
}

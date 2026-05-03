// ─────────────────────────────────────────────────────────────────────────
// predictionBrain — shared LLM scorer for binary prediction markets.
//
// One brain, two callers:
//   • polymarketAgent.ts — Polymarket (Gamma API events, CLOB prices)
//   • tradingAgent.ts (fortytwo branch) — 42.space (REST markets, on-chain
//     marginal prices)
//
// Both venues are binary (or multi-binary) prediction markets sorted by
// 24h volume. Both deserve the SAME judgement: read the question, weigh
// the LLM's subjective probability against the market-implied price, emit
// {action, side, conviction, reasoning}. The Aster perp brain (ADX/RSI/
// funding-rate) is the wrong tool for either of them.
//
// Provider fallback mirrors polymarketAgent's original behaviour: anthropic
// first, then xai, then hyperbolic. One LLM round-trip per (agent × market)
// per tick — bounded by MAX_EVENTS_PER_TICK upstream.
// ─────────────────────────────────────────────────────────────────────────

import { callLLM, type Provider } from '../services/inference'

const PROVIDER_FALLBACK: Provider[] = ['anthropic', 'xai', 'hyperbolic']

export type PredictionVenue = 'polymarket' | 'fortytwo'

export interface PredictionMarketInput {
  venue:        PredictionVenue
  // Wrapper / event-level title (e.g. Polymarket event title). May equal
  // the market question on single-market events. Set to null on 42.space
  // where there is no separate event wrapper.
  eventTitle:   string | null
  // The actual binary question being priced ("Will BTC close above $100k
  // by 2026-12-31?"). Always required.
  question:     string
  description:  string | null
  // ISO date the market resolves; null when unknown.
  endDateIso:   string | null
  outcomes:     string[]        // e.g. ['Yes','No'] — first is YES
  // 0..1 implied probabilities. Pass null when the venue can't quote a
  // book price right now (42.space when on-chain reads fail). The prompt
  // adapts and asks the LLM for a base-rate guess instead.
  yesPrice:     number | null
  noPrice:      number | null
  volume24h?:   number | null
  liquidity?:   number | null
  category?:    string | null
}

export interface PredictionDecision {
  action:     'BUY' | 'SKIP'
  side:       'YES' | 'NO'
  conviction: number          // 0..1, our subjective P(side resolves true)
  reasoning:  string          // <= 280 chars
}

// ─────────────────────────────────────────────────────────────────────────
// Score one market. Tries providers in order until one returns parseable
// JSON or we exhaust the list. Throws the last error on full exhaustion
// so the caller can log a SKIP with the underlying cause (e.g. "no
// providers available" / "anthropic 401").
// ─────────────────────────────────────────────────────────────────────────
export async function scorePredictionMarket(
  input: PredictionMarketInput,
): Promise<PredictionDecision> {
  const venueName = input.venue === 'polymarket' ? 'Polymarket' : '42.space'
  const endLabel = input.endDateIso
    ? new Date(input.endDateIso).toISOString().slice(0, 10)
    : 'unspecified'

  const system = [
    `You are a disciplined prediction-market trader analyzing a ${venueName} binary outcome.`,
    'You only place a trade when you have a real informational edge versus the market price.',
    'When the market price already reflects the available evidence, the correct action is SKIP.',
    'Your conviction is your subjective probability the chosen side resolves TRUE (0.0-1.0).',
    'Reply with STRICT JSON only — no prose, no markdown.',
  ].join(' ')

  const lines: string[] = []
  if (input.eventTitle && input.eventTitle !== input.question) {
    lines.push(`Event: ${input.eventTitle}`)
  }
  lines.push(`Market: ${input.question}`)
  if (input.description) {
    lines.push(`Description: ${input.description.slice(0, 500)}`)
  }
  if (input.category) lines.push(`Category: ${input.category}`)
  lines.push(`Resolution date: ${endLabel}`)
  lines.push(`Outcomes: ${input.outcomes.join(' / ')}`)

  // Price line is conditional. When both prices are known we give the LLM
  // the executable book; when prices are missing (42.space on-chain read
  // failure) we tell it explicitly so it falls back to a base-rate guess
  // instead of hallucinating a price.
  if (input.yesPrice !== null && input.noPrice !== null) {
    lines.push(
      `YES priced at ${(input.yesPrice * 100).toFixed(1)}¢, ` +
      `NO priced at ${(input.noPrice * 100).toFixed(1)}¢`,
    )
  } else {
    lines.push('Live book price unavailable this tick — assume 50/50 and reason from the question text alone.')
  }

  if (typeof input.volume24h === 'number' || typeof input.liquidity === 'number') {
    const vol = Math.round(input.volume24h ?? 0)
    const liq = Math.round(input.liquidity ?? 0)
    lines.push(`24h vol: $${vol}, liq: $${liq}`)
  }

  lines.push('')
  lines.push(
    'Reply with JSON: {"action":"BUY"|"SKIP","side":"YES"|"NO","conviction":0.0-1.0,"reasoning":"<=240 chars"}',
  )

  const user = lines.join('\n')

  let lastErr: Error | null = null
  for (const provider of PROVIDER_FALLBACK) {
    try {
      const r = await callLLM({
        provider,
        system,
        user,
        jsonMode: true,
        maxTokens: 300,
        temperature: 0.2,
        timeoutMs: 30_000,
      })
      const parsed = parsePredictionDecision(r.text)
      if (parsed) return parsed
      lastErr = new Error(`unparseable JSON from ${provider}`)
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('no providers available')
}

export function parsePredictionDecision(raw: string): PredictionDecision | null {
  if (!raw) return null
  // Some providers wrap JSON in code-fences even with jsonMode set.
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let obj: any
  try { obj = JSON.parse(cleaned) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  const action = String(obj.action ?? '').toUpperCase()
  const side   = String(obj.side ?? '').toUpperCase()
  const conv   = Number(obj.conviction)
  if (action !== 'BUY' && action !== 'SKIP') return null
  if (side !== 'YES' && side !== 'NO') return null
  if (!Number.isFinite(conv) || conv < 0 || conv > 1) return null
  return {
    action: action as 'BUY' | 'SKIP',
    side:   side as 'YES' | 'NO',
    conviction: conv,
    reasoning:  String(obj.reasoning ?? '').slice(0, 280),
  }
}

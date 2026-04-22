/**
 * Claude system + user prompts for the market-creator agent's evaluation
 * step. Kept in its own file so we can iterate on copy without touching
 * the orchestrator.
 */

import type { DexToken } from '../services/dexScreener'
import type { NewsSignal } from '../services/newsService'
import type { ProposalScores } from '../services/marketProposalStore'

export interface ScoredCandidate {
  type: 'news' | 'token'
  title: string
  // One of these is populated based on `type`.
  newsSignal?: NewsSignal
  tokenSignal?: DexToken
  scores: ProposalScores
  totalScore: number
  // First-pass agent-generated proposal — Claude refines or rejects.
  proposedQuestion: string
  proposedOutcomes: string[]
  proposedResolutionDate: string  // YYYY-MM-DD
  proposedResolutionSource: string
}

export const SYSTEM_PROMPT = `You are a prediction-market curator for 42.space, an on-chain event-asset protocol on BNB Chain.
Your job: evaluate candidate markets and decide which ones to create.

A great 42.space market has:
- A clear, specific, time-bounded question
- Objective resolution criteria with a named source
- High current public interest (people are talking about it NOW)
- Real financial stakes or global significance
- Outcomes that are genuinely uncertain (not 95%+ obvious)
- Resolution within 7-90 days ideally

For EACH candidate you receive, output ONE JSON object inside an array. Wrap the
whole response in {"evaluations": [...]}. Each evaluation looks like:

{
  "candidateIndex": <number>,        // matches the candidate's index in the input
  "approved": <boolean>,
  "refinedQuestion": "<string>",     // rewrite the question for clarity if needed
  "outcomes": ["YES","NO"],          // or named outcomes — must be exhaustive + mutually exclusive
  "resolutionDate": "YYYY-MM-DD",    // 7-90 days out ideally
  "resolutionCriteria": "<string>",  // exact objective criteria
  "resolutionSource": "<string>",    // e.g. "CoinGecko price feed", "OpenAI official blog"
  "category": "ai|crypto|geopolitics|tech|finance",
  "reasoning": "<one line — why approved or rejected>",
  "estimatedInterest": "low|medium|high|viral"
}

REJECT (approved=false) if:
- the question is ambiguous or subjective
- there is no objective resolution source
- the topic is too niche
- the resolution date is unrealistic (under 7 days OR over 6 months)
- the candidate is essentially a duplicate of a recently-created market

Respond with ONLY the JSON object — no prose, no markdown fences.`

/**
 * Build the user-message body Claude sees: a numbered list of candidates
 * with their signal payload, the agent's first-pass proposal, and the
 * current set of existing market titles to avoid duplicating.
 */
export function buildUserPrompt(
  candidates: ScoredCandidate[],
  existingMarketTitles: string[],
): string {
  const existingBlock = existingMarketTitles.length > 0
    ? `EXISTING 42.SPACE MARKETS (do not duplicate):\n${existingMarketTitles.map((t) => `- ${t}`).join('\n')}\n\n`
    : ''
  const candidateBlock = candidates.map((c, i) => {
    const signalBlock = c.type === 'token'
      ? formatTokenSignal(c.tokenSignal!)
      : formatNewsSignal(c.newsSignal!)
    return `### Candidate ${i}
Type: ${c.type}
Total score: ${c.totalScore}/100 (newsAuthority=${c.scores.newsAuthority}, socialVolume=${c.scores.socialVolume}, financialStake=${c.scores.financialStake}, resolvability=${c.scores.resolvability})

${signalBlock}

Agent's first-pass proposal:
- Question: "${c.proposedQuestion}"
- Outcomes: ${JSON.stringify(c.proposedOutcomes)}
- Resolution date: ${c.proposedResolutionDate}
- Resolution source: ${c.proposedResolutionSource}`
  }).join('\n\n')
  return `${existingBlock}Today is ${new Date().toISOString().slice(0, 10)}.

Evaluate each candidate below. Output {"evaluations": [...]} with one entry per candidate.

${candidateBlock}`
}

function formatTokenSignal(t: DexToken): string {
  const ageHours = t.pairCreatedAt ? Math.floor((Date.now() - t.pairCreatedAt) / 3_600_000) : null
  return `Signal (BNB Chain token):
- Symbol: ${t.symbol} (${t.name})
- Address: ${t.address}
- Price USD: $${t.priceUsd.toFixed(8)}
- 24h change: ${t.priceChange24h.toFixed(2)}%
- 24h volume: $${formatBig(t.volume24hUsd)}
- Liquidity: $${formatBig(t.liquidityUsd)}
- FDV: ${t.fdvUsd ? `$${formatBig(t.fdvUsd)}` : 'unknown'}
- Pair age: ${ageHours !== null ? `${ageHours}h` : 'unknown'}`
}

function formatNewsSignal(n: NewsSignal): string {
  return `Signal (news):
- Headline: ${n.title}
- Source: ${n.source} (authority ${n.authority}/25)
- Published: ${n.publishedAt}
- Description: ${n.description.slice(0, 300)}${n.description.length > 300 ? '…' : ''}
- URL: ${n.url}`
}

function formatBig(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(0)
}

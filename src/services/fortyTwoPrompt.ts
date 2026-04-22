import { getAllMarkets, type Market42 } from './fortyTwo';
import { readMarketOnchain, type OnchainMarketState } from './fortyTwoOnchain';

interface EnrichedMarket {
  market: Market42;
  state: OnchainMarketState | null;
}

// Keyword-based topical filter. The /api/v1/markets endpoint's `categories`
// field is sparse + inconsistent in practice, so we also match on the question
// text. Keep keywords lower-case.
// Keep keywords specific. Avoid generic words like "price" — they over-match
// (every market description mentions price). Match against tokenised words +
// short phrases only.
const TRADING_RELEVANT_KEYWORDS = [
  'btc', 'bitcoin', 'eth', 'ethereum', 'sol', 'solana', 'bnb', 'xrp', 'doge',
  'crypto', 'tge', 'fdv', 'market cap', 'mcap', 'altcoin', 'defi',
  'rate cut', 'fed ', 'cpi', 'inflation', 'fomc', 'recession',
  ' ai ', 'anthropic', 'openai', 'gpt', 'claude', 'llm', 'agi',
  'polymarket', 'binance', 'coinbase', ' sec ', ' etf', 'spot etf',
];

export function isTradingRelevant(m: Market42): boolean {
  const haystack = (
    (m.question ?? '') + ' ' + (m.categories ?? []).join(' ')
  ).toLowerCase();
  return TRADING_RELEVANT_KEYWORDS.some((kw) => haystack.includes(kw));
}

async function enrichTopMarkets(limit: number, opts: { tradingRelevantOnly: boolean }): Promise<EnrichedMarket[]> {
  // Over-fetch then filter so we still get `limit` after dropping irrelevant ones.
  const fetchLimit = opts.tradingRelevantOnly ? limit * 4 : limit;
  let markets = await getAllMarkets({ status: 'live', limit: fetchLimit, order: 'volume', ascending: false });
  if (opts.tradingRelevantOnly) markets = markets.filter(isTradingRelevant).slice(0, limit);

  return Promise.all(
    markets.map(async (m) => {
      try {
        const state = await readMarketOnchain(m);
        return { market: m, state };
      } catch (err) {
        console.warn(`[fortyTwo] on-chain read failed for ${m.address}:`, (err as Error).message);
        return { market: m, state: null };
      }
    }),
  );
}

function formatOutcomeLine(o: { label: string; impliedProbability: number; priceFloat: number; tokenId: number }): string {
  const prob = (o.impliedProbability * 100).toFixed(1);
  return `${o.label} [tokenId=${o.tokenId}]: ${prob}% (px ${o.priceFloat.toFixed(4)})`;
}

export interface Build42ContextOptions {
  maxMarkets?: number;
  /** When true, only markets matching trading-relevant keywords (crypto/AI/macro) are included. Default true. */
  tradingRelevantOnly?: boolean;
}

// Module-level cache so concurrent agent ticks share one fetch.
let _cached: { content: string; fetchedAt: number; key: string } | null = null;
const CONTEXT_TTL_MS = 60_000;

export async function build42MarketContext(
  optsOrMax: Build42ContextOptions | number = {},
): Promise<string> {
  const opts: Build42ContextOptions = typeof optsOrMax === 'number' ? { maxMarkets: optsOrMax } : optsOrMax;
  const maxMarkets = opts.maxMarkets ?? 6;
  const tradingRelevantOnly = opts.tradingRelevantOnly ?? true;
  const cacheKey = `${maxMarkets}|${tradingRelevantOnly}`;

  if (_cached && _cached.key === cacheKey && Date.now() - _cached.fetchedAt < CONTEXT_TTL_MS) {
    return _cached.content;
  }

  let enriched: EnrichedMarket[];
  try {
    enriched = await enrichTopMarkets(maxMarkets, { tradingRelevantOnly });
  } catch (err) {
    console.warn('[fortyTwo] build42MarketContext failed:', (err as Error).message);
    return '';
  }
  if (enriched.length === 0) {
    _cached = { content: '', fetchedAt: Date.now(), key: cacheKey };
    return '';
  }

  const MAX_CONTEXT_CHARS = 4000; // hard cap on injected prompt size
  const blocks = enriched.map(({ market, state }) => {
    const header = `• [${(market.categories ?? [])[0] ?? 'general'}] ${market.question.trim()} — ends ${market.endDate}`;
    if (!state || state.outcomes.length === 0) {
      return `${header}\n   prices unavailable (market: ${market.address})`;
    }
    const top = [...state.outcomes]
      .sort((a, b) => b.impliedProbability - a.impliedProbability)
      .slice(0, 4)
      .map(formatOutcomeLine)
      .join(' | ');
    return `${header}\n   ${top}\n   market: ${market.address}`;
  });

  let body = blocks.join('\n\n');
  if (body.length > MAX_CONTEXT_CHARS) {
    body = body.slice(0, MAX_CONTEXT_CHARS) + '\n…(truncated)';
  }

  const content = `
## Live 42.space Prediction Markets (BSC, USDT collateral)
Implied probabilities are computed from live bonding-curve marginal prices on chain.
These are real-money signals — incorporate them when forming a thesis.

${body}
`;
  // Cache successful build so concurrent ticks within TTL window share one fetch.
  _cached = { content, fetchedAt: Date.now(), key: cacheKey };
  return content;
}

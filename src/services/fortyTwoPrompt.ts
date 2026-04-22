import { getAllMarkets, type Market42 } from './fortyTwo';
import { readMarketOnchain, type OnchainMarketState } from './fortyTwoOnchain';

interface EnrichedMarket {
  market: Market42;
  state: OnchainMarketState | null;
}

async function enrichTopMarkets(limit: number): Promise<EnrichedMarket[]> {
  const markets = await getAllMarkets({ status: 'live', limit, order: 'volume', ascending: false });
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

function formatOutcomeLine(o: { label: string; impliedProbability: number; priceFloat: number }): string {
  const prob = (o.impliedProbability * 100).toFixed(1);
  return `${o.label}: ${prob}% (px ${o.priceFloat.toFixed(4)})`;
}

export async function build42MarketContext(maxMarkets = 6): Promise<string> {
  let enriched: EnrichedMarket[];
  try {
    enriched = await enrichTopMarkets(maxMarkets);
  } catch (err) {
    console.warn('[fortyTwo] build42MarketContext failed:', (err as Error).message);
    return '';
  }
  if (enriched.length === 0) return '';

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

  return `
## Live 42.space Prediction Markets (BSC, USDT collateral)
Implied probabilities are computed from live bonding-curve marginal prices on chain.
These are real-money signals — incorporate them when forming a thesis.

${blocks.join('\n\n')}
`;
}

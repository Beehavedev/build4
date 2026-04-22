import { scanMarketLevelSignals } from './fortyTwo';

export async function build42MarketContext(): Promise<string> {
  let signals;
  try {
    signals = await scanMarketLevelSignals(8);
  } catch (err) {
    console.warn('[fortyTwo] scanMarketLevelSignals failed:', (err as Error).message);
    return '';
  }
  if (!signals || signals.length === 0) return '';

  const lines = signals.map(
    (s) => `• [${s.category}] ${s.title} — ${s.reasoning} (market: ${s.marketAddress})`,
  );

  return `
## Live 42.space Prediction Markets
The following live outcome markets exist on BSC right now (collateral: USDT).
Prices reflect real-money implied probabilities. Consider these as soft signals
when forming a thesis on AI / crypto / geopolitics:

${lines.join('\n')}

Per-outcome prices and OHLC candles are not yet exposed by 42's public API; if
that data would change your decision, surface it in your reasoning so we know
to wire up the on-chain price reader.
`;
}

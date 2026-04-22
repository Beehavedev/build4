import { scanAllSignals } from './fortyTwo';

export async function build42MarketContext(): Promise<string> {
  let signals;
  try {
    signals = await scanAllSignals();
  } catch (err) {
    console.warn('[fortyTwo] scanAllSignals failed:', (err as Error).message);
    return '';
  }
  if (!signals || signals.length === 0) return '';

  const top = signals.slice(0, 5);
  const lines = top.map(
    (s) =>
      `• [${s.marketTitle}] — "${s.outcomeLabel}" @ ${(s.impliedProbability * 100).toFixed(1)}% implied prob | momentum: ${s.momentum} | strength: ${s.signalStrength}/100 | ${s.reasoning}`,
  );

  return `
## Live 42.space Prediction Market Signals
The following AI/crypto/geopolitics outcome markets have active signals right now.
These are bonding-curve markets on BSC — prices reflect real-money implied probabilities.
Consider these when forming your market thesis:

${lines.join('\n')}

If any of these align with your current trading thesis, flag them in your reasoning.
Market address and tokenId are available if you decide to take a position.
`;
}

/**
 * Smoke test for the 42.space integration.
 * Run with: npx tsx scripts/test42.ts
 *
 * - Hits the live REST API and prints the top markets
 * - Reads on-chain marginal prices for each outcome of the first market
 * - Renders the agent prompt block that would be injected into Claude
 */

import { getAllMarkets, verifyEndpoints } from '../src/services/fortyTwo';
import { readMarketOnchain } from '../src/services/fortyTwoOnchain';
import { build42MarketContext } from '../src/services/fortyTwoPrompt';

async function main() {
  console.log('\n═══ 1. REST endpoint reachability ═══');
  console.log(await verifyEndpoints());

  console.log('\n═══ 2. Top 5 live markets (by volume) ═══');
  const markets = await getAllMarkets({ status: 'live', limit: 5, order: 'volume', ascending: false });
  for (const m of markets) {
    console.log(`  ${m.address}  ${m.question.trim().slice(0, 70)}`);
  }
  if (markets.length === 0) {
    console.log('  (no live markets returned)');
    return;
  }

  console.log('\n═══ 3. On-chain outcome prices for first market ═══');
  const state = await readMarketOnchain(markets[0]);
  console.log(`  market:        ${state.market}`);
  console.log(`  questionId:    ${state.questionId}`);
  console.log(`  numOutcomes:   ${state.numOutcomes}`);
  console.log(`  feeRate (raw): ${state.feeRate.toString()}`);
  console.log(`  finalised:     ${state.isFinalised}`);
  for (const o of state.outcomes) {
    console.log(
      `    [${o.index}] tokenId=${o.tokenId}  ${o.label.padEnd(30)}  px=${o.priceFloat.toFixed(6)}  impl=${(o.impliedProbability * 100).toFixed(2)}%`,
    );
  }

  console.log('\n═══ 4. Rendered Claude prompt block ═══');
  console.log(await build42MarketContext(3));
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});

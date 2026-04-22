/**
 * Validation harness: spin up three paper-trading 42.space agents with
 * different strategies, run them for N ticks, print PnL.
 *
 *   npx tsx scripts/runFortyTwoAgents.ts            # default 5 ticks, 15s apart
 *   TICKS=8 INTERVAL_MS=10000 npx tsx scripts/runFortyTwoAgents.ts
 *
 * Paper-trade mode is forced on — no real funds at risk, no broadcasts.
 */

import { FortyTwoAgent, type Strategy } from '../src/services/fortyTwoAgent';

// Default interval is 35s (>30s on-chain price cache TTL) so mark-to-market
// actually re-quotes between ticks instead of returning cached prices.
const TICKS = Number(process.env.TICKS ?? 4);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 35_000);

function fmtUSDT(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(4)} USDT`;
}

async function main() {
  console.log(`\n═══ 42.space paper-trade harness — ${TICKS} ticks × ${INTERVAL_MS}ms ═══\n`);

  const agents = [
    new FortyTwoAgent({ name: 'Momentum-Mira',  strategy: 'MOMENTUM',   bankrollUSDT: 50 }),
    new FortyTwoAgent({ name: 'Contrarian-Cal', strategy: 'CONTRARIAN', bankrollUSDT: 50 }),
    new FortyTwoAgent({ name: 'Edge-Eli',       strategy: 'EDGE',       bankrollUSDT: 50 }),
  ];

  for (let i = 1; i <= TICKS; i++) {
    console.log(`\n──── Tick ${i}/${TICKS} ────`);
    // Run agents serially within a tick so the first agent populates the
    // 30s on-chain price cache and the next two get free hits. Parallel here
    // would defeat the cache and trip BSC's batch rate limit.
    const reports = [];
    for (const a of agents) reports.push(await a.tick(5));

    for (const r of reports) {
      const buys = r.decisions.filter((d) => d.action === 'BUY').length;
      const skipCounts: Record<string, number> = {};
      for (const d of r.decisions.filter((d) => d.action === 'SKIP')) {
        skipCounts[d.reason] = (skipCounts[d.reason] ?? 0) + 1;
      }
      const skipLabel = Object.entries(skipCounts)
        .map(([k, v]) => `${v}× ${k}`)
        .join(', ');
      console.log(
        `  ${r.agent.padEnd(16)} [${r.strategy.padEnd(10)}]  buys=${buys}  open=${r.openPositions}  cash=$${r.cashUSDT.toFixed(2)}  unrealised=${fmtUSDT(r.unrealizedPnLUSDT)}` +
          (skipLabel ? `\n      └─ skips: ${skipLabel}` : ''),
      );
      for (const d of r.decisions.filter((x) => x.action === 'BUY')) {
        console.log(`      └─ BUY  ${d.market.slice(0, 10)}…  ${d.reason}`);
      }
    }
    if (i < TICKS) await new Promise((res) => setTimeout(res, INTERVAL_MS));
  }

  console.log(`\n═══ Final results ═══\n`);
  for (const a of agents) {
    const unrealized = await a.markToMarket();
    const total = a.realizedPnLUSDT + unrealized;
    const pct = (total / a.startingBankrollUSDT) * 100;
    console.log(`\n  ${a.name}  [${a.strategy}]`);
    console.log(`    bankroll: $${a.startingBankrollUSDT}   cash: $${a.cashUSDT.toFixed(2)}   trades: ${a.trades}`);
    console.log(`    realised: ${fmtUSDT(a.realizedPnLUSDT)}   unrealised: ${fmtUSDT(unrealized)}   total: ${fmtUSDT(total)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`);
    if (a.positions.length > 0) {
      console.log(`    open positions:`);
      const { getOutcomePrices } = await import('../src/services/fortyTwoOnchain');
      for (const p of a.positions) {
        let livePx = 0;
        try {
          const prices = await getOutcomePrices(p.market, p.curve, p.collateralDecimals);
          livePx = prices.find((o) => o.tokenId === p.tokenId)?.priceFloat ?? 0;
        } catch { /* leave 0 */ }
        const drift = livePx - p.entryPrice;
        const driftPct = p.entryPrice > 0 ? (drift / p.entryPrice) * 100 : 0;
        console.log(`      • "${p.outcomeLabel}" in "${p.question}"`);
        console.log(`        cost $${p.costUSDT}  entry ${p.entryPrice.toFixed(4)} → live ${livePx.toFixed(4)}  (${drift >= 0 ? '+' : ''}${driftPct.toFixed(2)}%)  ~${p.estimatedOT.toFixed(0)} OT`);
      }
    }
  }

  console.log(`\n═══ Done. No real funds were moved (paper-trade mode). ═══\n`);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});

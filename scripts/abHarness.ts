// CLI for the prediction-context A/B harness.
//
//   tsx scripts/abHarness.ts tick      # one paired tick across the pair list
//   tsx scripts/abHarness.ts loop      # run a tick every TICK_INTERVAL_MIN minutes
//   tsx scripts/abHarness.ts resolve   # attach simulated PnL to ripe decisions
//   tsx scripts/abHarness.ts report    # print markdown report to stdout
//
// Env:
//   AB_HARNESS_PAIRS         CSV, default "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT"
//   AB_HARNESS_LOG           override store path
//   AB_HARNESS_TICK_MIN      tick interval for `loop` (default 30)
//   AB_HARNESS_MAX_MIN       optional: stop `loop` after this many minutes
//                            (default: run forever). Useful for short sniffs.
//   ANTHROPIC_API_KEY        required

import { runAbTick } from '../src/abHarness/harness';
import { resolveAll } from '../src/abHarness/resolve';
import { renderReport } from '../src/abHarness/report';

function pairs(): string[] {
  const csv = process.env.AB_HARNESS_PAIRS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT';
  return csv
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
}

async function tickOnce(): Promise<void> {
  const list = pairs();
  console.log(`[ab-harness] tick across ${list.length} pair(s): ${list.join(', ')}`);
  for (const pair of list) {
    try {
      const r = await runAbTick({ pair });
      const a = r.withCtx.decision?.action ?? 'PARSE_FAIL';
      const b = r.withoutCtx.decision?.action ?? 'PARSE_FAIL';
      const flag = a !== b ? '⚡' : ' ';
      console.log(`  ${flag} ${pair}  px=$${r.priceAtDecision.toFixed(4)}  with_42=${a}  without_42=${b}`);
    } catch (err) {
      console.error(`  ✗ ${pair}: ${(err as Error).message}`);
    }
  }
}

async function loop(): Promise<void> {
  const min = Number(process.env.AB_HARNESS_TICK_MIN ?? 30);
  const intervalMs = Math.max(60_000, min * 60_000);
  const maxMin = Number(process.env.AB_HARNESS_MAX_MIN ?? 0);
  const deadline = maxMin > 0 ? Date.now() + maxMin * 60_000 : Infinity;
  console.log(
    `[ab-harness] loop mode: tick every ${min} minutes` +
      (maxMin > 0 ? `, stopping after ${maxMin} minutes` : ', forever'),
  );
  while (Date.now() < deadline) {
    const start = Date.now();
    try {
      await tickOnce();
      // Resolve mature decisions on each tick — keeps the report fresh.
      const r = await resolveAll();
      console.log(`[ab-harness] resolver: scanned=${r.scanned} newly_resolved=${r.resolved}`);
    } catch (err) {
      console.error('[ab-harness] tick failed:', (err as Error).message);
    }
    if (Date.now() >= deadline) break;
    const elapsed = Date.now() - start;
    const wait = Math.max(1000, Math.min(intervalMs - elapsed, deadline - Date.now()));
    await new Promise((res) => setTimeout(res, wait));
  }
  console.log('[ab-harness] loop deadline reached, exiting.');
}

async function main() {
  const cmd = process.argv[2] ?? 'tick';
  if (!process.env.ANTHROPIC_API_KEY && (cmd === 'tick' || cmd === 'loop')) {
    console.error('ANTHROPIC_API_KEY is required for tick/loop.');
    process.exit(2);
  }
  switch (cmd) {
    case 'tick':
      await tickOnce();
      break;
    case 'loop':
      await loop();
      break;
    case 'resolve': {
      const r = await resolveAll();
      console.log(`Scanned: ${r.scanned} | Newly resolved: ${r.resolved}`);
      break;
    }
    case 'report':
      console.log(await renderReport());
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Usage: tsx scripts/abHarness.ts [tick|loop|resolve|report]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

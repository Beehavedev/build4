// Resolver: walks the JSONL store, finds OPEN_LONG/OPEN_SHORT decisions
// whose holding window has elapsed, replays the forward 1m/5m candles from
// Aster and assigns each one a simulated PnL%.
//
// Simulation rules (intentionally simple — calibrated against the live
// agent's behaviour, not a research-grade backtester):
//   • Entry fill: assumed as a passive limit at the FAR edge of `entryZone`
//     (LONG fills at zone.low, SHORT fills at zone.high). The zone counts
//     as filled only once price actually trades to that edge — so this is
//     stricter than the old midpoint model and produces fewer but more
//     realistic fills. If the edge is never reached we mark NO_TRADE.
//   • Stop loss / take profit: walk the 1m candles after fill. First
//     intra-bar touch wins. SL takes precedence over TP within the same
//     bar (conservative).
//   • Timeout: if neither level is hit inside HOLDING_WINDOW_MS, exit at
//     close of the last bar. Counts as TIMEOUT exit.
//   • Costs: taker fee TAKER_FEE_RATE per side (in + out) and 8h funding
//     pro-rated over the holding window. Both are deducted from the gross
//     pnl and surfaced separately on the resolved record so the report can
//     break them out.
//   • PnL%: NET signed return on margin (size). For a price move dP:
//        gross% = dP/entry × leverage × 100 × (LONG?+1:-1)
//        fee%   = -2 × TAKER_FEE_RATE × leverage × 100
//        fund%  = -Σ(funding rates in window) × leverage × 100 × dirMult
//        pnl%   = gross + fee + fund
//   • HOLD / CLOSE / null decisions: skipped entirely. Decision divergence
//     is still scored in the report; PnL is only attributed to entries.

import { getFundingRateHistory, getKlines } from '../services/aster';
import { readAll, rewriteAll } from './store';
import { AbDecisionRecord } from './types';

// Aster perp taker fee — ~0.04% per side. Kept as a module-level constant
// so a future audit (or a fee-tier change) only has to touch one line.
export const TAKER_FEE_RATE = 0.0004;

export const HOLDING_WINDOW_MS = 4 * 60 * 60 * 1000; // 4h
const KLINE_INTERVAL = '1m';

interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function toCandles(k: { open: number[]; high: number[]; low: number[]; close: number[]; timestamps: number[] }): Candle[] {
  return k.timestamps.map((ts, i) => ({ ts, open: k.open[i], high: k.high[i], low: k.low[i], close: k.close[i] }));
}

// Far edge of the zone for a passive-limit fill. LONG limits sit at the low
// edge (you only buy if price drops to you); SHORT limits sit at the high
// edge. Returning the edge means the fill price is the worst you'd accept,
// which is the realistic "limit at zone edge" assumption.
function fillEdge(z: { low: number; high: number }, side: 'LONG' | 'SHORT'): number {
  return side === 'LONG' ? z.low : z.high;
}

function simulateExit(
  candles: Candle[],
  entryPrice: number,
  side: 'LONG' | 'SHORT',
  stopLoss: number,
  takeProfit: number,
  leverage: number,
): { exitPrice: number; exitReason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TIMEOUT'; grossPnlPct: number; lastTs: number } {
  let exitPrice = candles.length ? candles[candles.length - 1].close : entryPrice;
  let exitReason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TIMEOUT' = 'TIMEOUT';
  let lastTs = candles.length ? candles[candles.length - 1].ts : Date.now();

  for (const c of candles) {
    lastTs = c.ts;
    if (side === 'LONG') {
      // Pessimistic ordering: SL before TP if both touched in same bar.
      if (c.low <= stopLoss) {
        exitPrice = stopLoss;
        exitReason = 'STOP_LOSS';
        break;
      }
      if (c.high >= takeProfit) {
        exitPrice = takeProfit;
        exitReason = 'TAKE_PROFIT';
        break;
      }
    } else {
      if (c.high >= stopLoss) {
        exitPrice = stopLoss;
        exitReason = 'STOP_LOSS';
        break;
      }
      if (c.low <= takeProfit) {
        exitPrice = takeProfit;
        exitReason = 'TAKE_PROFIT';
        break;
      }
    }
  }

  const dirMult = side === 'LONG' ? 1 : -1;
  const grossPnlPct = ((exitPrice - entryPrice) / entryPrice) * (leverage || 1) * 100 * dirMult;
  return { exitPrice, exitReason, grossPnlPct, lastTs };
}

// Sum the funding payments that settled inside [fillTs, exitTs] and convert
// them to a signed % return on margin. Aster funding settles every 8h and
// is paid by the side with positive net OI exposure; for the trader, a
// positive funding rate means LONG pays / SHORT receives.
async function fundingPctOverWindow(
  pair: string,
  side: 'LONG' | 'SHORT',
  leverage: number,
  fillTs: number,
  exitTs: number,
): Promise<number> {
  if (exitTs <= fillTs) return 0;
  const dirMult = side === 'LONG' ? 1 : -1;
  // Pad both ends by 1ms — Aster's filter is inclusive but funding events
  // are usually anchored to the exact 8h boundary; tiny padding avoids
  // missing one that lands on the boundary.
  const events = await getFundingRateHistory(pair, fillTs - 1, exitTs + 1);
  const inWindow = events.filter((e) => e.fundingTime >= fillTs && e.fundingTime <= exitTs);
  const sumRate = inWindow.reduce((acc, e) => acc + e.fundingRate, 0);
  // Negative sign: positive funding rate is a COST to longs (subtract from PnL).
  return -dirMult * sumRate * (leverage || 1) * 100;
}

async function resolveOne(rec: AbDecisionRecord): Promise<AbDecisionRecord> {
  const d = rec.decision;
  if (!d) return rec;
  if (d.action !== 'OPEN_LONG' && d.action !== 'OPEN_SHORT') return rec;
  if (!d.entryZone || d.stopLoss == null || d.takeProfit == null) return rec;
  if (Date.now() - rec.decidedAt < HOLDING_WINDOW_MS) return rec; // not yet eligible

  const side: 'LONG' | 'SHORT' = d.action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
  const entry = fillEdge(d.entryZone, side);

  // Fetch enough 1m candles to span the holding window. Aster /klines hard
  // caps at 1500 — for a 4h window we need 240 bars, well inside the cap.
  // We grab a buffer (window+30m) so we can find the first bar after the
  // decision even if the exchange clock skews slightly.
  const limit = Math.min(1500, Math.ceil((HOLDING_WINDOW_MS + 30 * 60 * 1000) / 60_000));
  const k = await getKlines(rec.pair, KLINE_INTERVAL, limit);
  const allCandles = toCandles(k).filter((c) => c.ts >= rec.decidedAt && c.ts <= rec.decidedAt + HOLDING_WINDOW_MS);

  if (allCandles.length === 0) {
    // Klines window doesn't cover the decision time. Two cases:
    //   a) The recent klines start AFTER our holding window ended — the
    //      decision is genuinely orphaned (resolver was offline too long
    //      to recover the bars). Mark NO_TRADE so we stop retrying.
    //   b) The recent klines END before our decision time — should never
    //      happen for a ripe record, but skip to be safe.
    const allKlineCandles = toCandles(k);
    const earliestKlineTs = allKlineCandles[0]?.ts ?? 0;
    if (earliestKlineTs > rec.decidedAt + HOLDING_WINDOW_MS) {
      console.warn(
        `[ab-harness] resolver: ${rec.pair} decision @${new Date(rec.decidedAt).toISOString()} is older than available klines — marking NO_TRADE (resolver was offline >${Math.round((earliestKlineTs - rec.decidedAt) / 60_000)}min)`,
      );
      return {
        ...rec,
        resolved: {
          resolvedAt: Date.now(),
          exitPrice: entry,
          exitReason: 'NO_TRADE',
          pnlPct: 0,
          grossPnlPct: 0,
          feePct: 0,
          fundingPct: 0,
          holdingMinutes: 0,
        },
      };
    }
    // Otherwise leave it unresolved — try again next pass.
    return rec;
  }

  // Limit-at-edge fill: the order only triggers once price actually trades
  // through `entry` (zone.low for LONG, zone.high for SHORT). This is a
  // stricter condition than the old "zone touched anywhere" check and
  // matches how a resting limit on Aster would behave.
  const fillIdx = allCandles.findIndex((c) =>
    side === 'LONG' ? c.low <= entry : c.high >= entry,
  );
  if (fillIdx === -1) {
    return {
      ...rec,
      resolved: {
        resolvedAt: Date.now(),
        exitPrice: entry,
        exitReason: 'NO_TRADE',
        pnlPct: 0,
        grossPnlPct: 0,
        feePct: 0,
        fundingPct: 0,
        holdingMinutes: 0,
      },
    };
  }

  const forward = allCandles.slice(fillIdx + 1);
  const lev = d.leverage ?? 1;
  const sim = simulateExit(forward, entry, side, d.stopLoss, d.takeProfit, lev);
  const fillTs = allCandles[fillIdx].ts;

  // Costs. Both fee and funding are signed contributions to pnlPct.
  const feePct = -2 * TAKER_FEE_RATE * lev * 100;
  const fundingPct = await fundingPctOverWindow(rec.pair, side, lev, fillTs, sim.lastTs);
  const pnlPct = sim.grossPnlPct + feePct + fundingPct;

  return {
    ...rec,
    resolved: {
      resolvedAt: Date.now(),
      entryPrice: entry,
      exitPrice: sim.exitPrice,
      exitReason: sim.exitReason,
      pnlPct,
      grossPnlPct: sim.grossPnlPct,
      feePct,
      fundingPct,
      holdingMinutes: Math.max(1, Math.round((sim.lastTs - fillTs) / 60_000)),
    },
  };
}

export async function resolveAll(): Promise<{ scanned: number; resolved: number; skipped: number }> {
  const all = await readAll();
  let resolved = 0;
  const next: AbDecisionRecord[] = [];
  for (const rec of all) {
    if (rec.resolved) {
      next.push(rec);
      continue;
    }
    const updated = await resolveOne(rec);
    if (updated.resolved) resolved++;
    next.push(updated);
  }
  await rewriteAll(next);
  return { scanned: all.length, resolved, skipped: all.length - resolved - all.filter((r) => r.resolved).length };
}

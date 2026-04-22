// Resolver: walks the JSONL store, finds OPEN_LONG/OPEN_SHORT decisions
// whose holding window has elapsed, replays the forward 1m/5m candles from
// Aster and assigns each one a simulated PnL%.
//
// Simulation rules (intentionally simple — calibrated against the live
// agent's behaviour, not a research-grade backtester):
//   • Entry fill: assumed at midpoint of `entryZone`. If the zone never
//     traded after the decision, we mark the trade as NO_TRADE (no fill,
//     0% PnL — counts as a no-op for that variant).
//   • Stop loss / take profit: walk the 1m candles after fill. First
//     intra-bar touch wins. SL takes precedence over TP within the same
//     bar (conservative).
//   • Timeout: if neither level is hit inside HOLDING_WINDOW_MS, exit at
//     close of the last bar. Counts as TIMEOUT exit.
//   • PnL%: signed return on notional (size × leverage), pre-fees. Long =
//     (exit-entry)/entry × leverage; short flips the sign.
//   • HOLD / CLOSE / null decisions: skipped entirely. Decision divergence
//     is still scored in the report; PnL is only attributed to entries.

import { getKlines } from '../services/aster';
import { readAll, rewriteAll } from './store';
import { AbDecisionRecord } from './types';

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

function midOfZone(z: { low: number; high: number }): number {
  return (z.low + z.high) / 2;
}

function simulateExit(
  candles: Candle[],
  entryPrice: number,
  side: 'LONG' | 'SHORT',
  stopLoss: number,
  takeProfit: number,
  leverage: number,
): { exitPrice: number; exitReason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TIMEOUT'; pnlPct: number; lastTs: number } {
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
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * (leverage || 1) * 100 * dirMult;
  return { exitPrice, exitReason, pnlPct, lastTs };
}

async function resolveOne(rec: AbDecisionRecord): Promise<AbDecisionRecord> {
  const d = rec.decision;
  if (!d) return rec;
  if (d.action !== 'OPEN_LONG' && d.action !== 'OPEN_SHORT') return rec;
  if (!d.entryZone || d.stopLoss == null || d.takeProfit == null) return rec;
  if (Date.now() - rec.decidedAt < HOLDING_WINDOW_MS) return rec; // not yet eligible

  const side: 'LONG' | 'SHORT' = d.action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
  const entry = midOfZone(d.entryZone);

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
          holdingMinutes: 0,
        },
      };
    }
    // Otherwise leave it unresolved — try again next pass.
    return rec;
  }

  // Was the entry zone ever filled? Use intrabar high/low against the zone
  // bounds. If the zone never touched, the limit order would never have
  // filled — treat as NO_TRADE.
  const zoneHit = allCandles.some((c) => c.high >= d.entryZone!.low && c.low <= d.entryZone!.high);
  if (!zoneHit) {
    return {
      ...rec,
      resolved: {
        resolvedAt: Date.now(),
        exitPrice: entry,
        exitReason: 'NO_TRADE',
        pnlPct: 0,
        holdingMinutes: 0,
      },
    };
  }

  // Find the first bar that touched the zone — entry happens there. Then
  // simulate forward from the next bar onward.
  const fillIdx = allCandles.findIndex((c) => c.high >= d.entryZone!.low && c.low <= d.entryZone!.high);
  const forward = allCandles.slice(fillIdx + 1);
  const lev = d.leverage ?? 1;
  const sim = simulateExit(forward, entry, side, d.stopLoss, d.takeProfit, lev);
  const fillTs = allCandles[fillIdx].ts;

  return {
    ...rec,
    resolved: {
      resolvedAt: Date.now(),
      exitPrice: sim.exitPrice,
      exitReason: sim.exitReason,
      pnlPct: sim.pnlPct,
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

// Unit tests for the A/B PnL simulator (`resolveOne`).
//
// We feed `resolveOne` a synthetic 1m candle stream + funding history via
// the dependency-injection seam, so the tests are fully offline and the
// numbers come out deterministically. The cases cover the four exit
// outcomes the simulator can produce (win/loss/timeout/no-trade) for both
// LONG and SHORT, the pnlPct = grossPnlPct + feePct + fundingPct identity,
// and the funding-sign convention (positive rate = LONG cost, SHORT credit).

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  HOLDING_WINDOW_MS,
  TAKER_FEE_RATE,
  resolveOne,
  type ResolveDeps,
} from './resolve';
import type { AbDecisionRecord } from './types';

type Candle = [ts: number, open: number, high: number, low: number, close: number];

function makeKlines(candles: Candle[]) {
  return {
    open: candles.map((c) => c[1]),
    high: candles.map((c) => c[2]),
    low: candles.map((c) => c[3]),
    close: candles.map((c) => c[4]),
    volume: candles.map(() => 0),
    timestamps: candles.map((c) => c[0]),
  };
}

function makeDeps(candles: Candle[], funding: { fundingTime: number; fundingRate: number }[] = []): ResolveDeps {
  return {
    getKlines: async () => makeKlines(candles),
    getFundingRateHistory: async () => funding,
  };
}

// Anchor decisions in the past so the resolver doesn't bail on the
// "holding window not yet elapsed" guard. Add a generous safety margin.
function pastDecidedAt(): number {
  return Date.now() - HOLDING_WINDOW_MS - 60_000;
}

function makeRecord(opts: {
  side: 'LONG' | 'SHORT';
  decidedAt: number;
  entryZone: { low: number; high: number };
  stopLoss: number;
  takeProfit: number;
  leverage?: number;
}): AbDecisionRecord {
  return {
    pairTickId: 'tick-test',
    variant: 'with_42',
    pair: 'BTCUSDT',
    decidedAt: opts.decidedAt,
    priceAtDecision: (opts.entryZone.low + opts.entryZone.high) / 2,
    decision: {
      action: opts.side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
      confidence: 1,
      setupScore: 1,
      entryZone: opts.entryZone,
      stopLoss: opts.stopLoss,
      takeProfit: opts.takeProfit,
      size: 1,
      leverage: opts.leverage ?? 5,
      riskRewardRatio: 2,
      reasoning: 'test',
      holdReason: null,
    },
    rawResponse: '{}',
  };
}

const LEV = 5;
const FEE_PCT_AT_LEV5 = -2 * TAKER_FEE_RATE * LEV * 100; // -0.4

describe('resolveOne — A/B PnL simulator', () => {
  it('LONG win: limit fills at zone.low, then walks up to TP', async () => {
    const decidedAt = pastDecidedAt();
    const t = (i: number) => decidedAt + (i + 1) * 60_000;
    // Bar 0 dips to 100 (zone.low) — fill. Bar 1 holds. Bar 2 hits TP at 110.
    const candles: Candle[] = [
      [t(0), 102, 102, 100, 101],
      [t(1), 101, 103, 100.5, 102],
      [t(2), 102, 110, 102, 109],
    ];
    const rec = makeRecord({
      side: 'LONG',
      decidedAt,
      entryZone: { low: 100, high: 102 },
      stopLoss: 95,
      takeProfit: 110,
      leverage: LEV,
    });

    const out = await resolveOne(rec, makeDeps(candles));
    const r = out.resolved!;
    assert.equal(r.exitReason, 'TAKE_PROFIT');
    assert.equal(r.entryPrice, 100);
    assert.equal(r.exitPrice, 110);
    // gross = (110-100)/100 * 5 * 100 = +50
    assert.ok(Math.abs(r.grossPnlPct! - 50) < 1e-9, `gross=${r.grossPnlPct}`);
    assert.ok(Math.abs(r.feePct! - FEE_PCT_AT_LEV5) < 1e-9);
    assert.ok(Math.abs(r.fundingPct!) < 1e-9);
    assert.ok(Math.abs(r.pnlPct - (r.grossPnlPct! + r.feePct! + r.fundingPct!)) < 1e-9);
  });

  it('LONG loss: SL takes precedence over TP within the same bar', async () => {
    const decidedAt = pastDecidedAt();
    const t = (i: number) => decidedAt + (i + 1) * 60_000;
    // Bar 0: fills at 100. Bar 1: low=95 (SL) AND high=110 (TP) — SL must win.
    const candles: Candle[] = [
      [t(0), 102, 102, 100, 101],
      [t(1), 101, 110, 95, 96],
    ];
    const rec = makeRecord({
      side: 'LONG',
      decidedAt,
      entryZone: { low: 100, high: 102 },
      stopLoss: 95,
      takeProfit: 110,
      leverage: LEV,
    });

    const out = await resolveOne(rec, makeDeps(candles));
    const r = out.resolved!;
    assert.equal(r.exitReason, 'STOP_LOSS');
    assert.equal(r.exitPrice, 95);
    // gross = (95-100)/100 * 5 * 100 = -25
    assert.ok(Math.abs(r.grossPnlPct! - -25) < 1e-9, `gross=${r.grossPnlPct}`);
    assert.ok(Math.abs(r.pnlPct - (r.grossPnlPct! + r.feePct! + r.fundingPct!)) < 1e-9);
  });

  it('SHORT win: limit fills at zone.high, then walks down to TP', async () => {
    const decidedAt = pastDecidedAt();
    const t = (i: number) => decidedAt + (i + 1) * 60_000;
    // Bar 0 spikes to 100 (zone.high) — fill. Bar 2 dips to TP at 90.
    const candles: Candle[] = [
      [t(0), 99, 100, 98, 99],
      [t(1), 99, 99.5, 95, 96],
      [t(2), 96, 96, 90, 91],
    ];
    const rec = makeRecord({
      side: 'SHORT',
      decidedAt,
      entryZone: { low: 98, high: 100 },
      stopLoss: 105,
      takeProfit: 90,
      leverage: LEV,
    });

    const out = await resolveOne(rec, makeDeps(candles));
    const r = out.resolved!;
    assert.equal(r.exitReason, 'TAKE_PROFIT');
    assert.equal(r.entryPrice, 100);
    assert.equal(r.exitPrice, 90);
    // gross = (90-100)/100 * 5 * 100 * -1 = +50
    assert.ok(Math.abs(r.grossPnlPct! - 50) < 1e-9, `gross=${r.grossPnlPct}`);
    assert.ok(Math.abs(r.pnlPct - (r.grossPnlPct! + r.feePct! + r.fundingPct!)) < 1e-9);
  });

  it('SHORT loss: SL hit on the upside', async () => {
    const decidedAt = pastDecidedAt();
    const t = (i: number) => decidedAt + (i + 1) * 60_000;
    const candles: Candle[] = [
      [t(0), 99, 100, 98, 99],
      [t(1), 99, 105, 99, 104],
    ];
    const rec = makeRecord({
      side: 'SHORT',
      decidedAt,
      entryZone: { low: 98, high: 100 },
      stopLoss: 105,
      takeProfit: 90,
      leverage: LEV,
    });

    const out = await resolveOne(rec, makeDeps(candles));
    const r = out.resolved!;
    assert.equal(r.exitReason, 'STOP_LOSS');
    assert.equal(r.exitPrice, 105);
    // gross = (105-100)/100 * 5 * 100 * -1 = -25
    assert.ok(Math.abs(r.grossPnlPct! - -25) < 1e-9);
    assert.ok(Math.abs(r.pnlPct - (r.grossPnlPct! + r.feePct! + r.fundingPct!)) < 1e-9);
  });

  it('TIMEOUT exit: filled but never hits SL/TP — exits at last candle close', async () => {
    const decidedAt = pastDecidedAt();
    const t = (i: number) => decidedAt + (i + 1) * 60_000;
    const candles: Candle[] = [
      [t(0), 102, 102, 100, 101], // fill at 100
      [t(1), 101, 103, 100.5, 102],
      [t(2), 102, 104, 101, 103.5], // close (last bar)
    ];
    const rec = makeRecord({
      side: 'LONG',
      decidedAt,
      entryZone: { low: 100, high: 102 },
      stopLoss: 90,
      takeProfit: 120,
      leverage: LEV,
    });

    const out = await resolveOne(rec, makeDeps(candles));
    const r = out.resolved!;
    assert.equal(r.exitReason, 'TIMEOUT');
    assert.equal(r.exitPrice, 103.5);
    // gross = (103.5-100)/100 * 5 * 100 = +17.5
    assert.ok(Math.abs(r.grossPnlPct! - 17.5) < 1e-9, `gross=${r.grossPnlPct}`);
    assert.ok(Math.abs(r.pnlPct - (r.grossPnlPct! + r.feePct! + r.fundingPct!)) < 1e-9);
  });

  it('NO_TRADE: price never reaches the zone edge', async () => {
    const decidedAt = pastDecidedAt();
    const t = (i: number) => decidedAt + (i + 1) * 60_000;
    // LONG zone edge is 100, but price stays well above (lows >= 105).
    const candles: Candle[] = [
      [t(0), 110, 112, 108, 111],
      [t(1), 111, 113, 109, 112],
      [t(2), 112, 114, 110, 113],
    ];
    const rec = makeRecord({
      side: 'LONG',
      decidedAt,
      entryZone: { low: 100, high: 102 },
      stopLoss: 95,
      takeProfit: 120,
      leverage: LEV,
    });

    const out = await resolveOne(rec, makeDeps(candles));
    const r = out.resolved!;
    assert.equal(r.exitReason, 'NO_TRADE');
    assert.equal(r.pnlPct, 0);
    assert.equal(r.grossPnlPct, 0);
    assert.equal(r.feePct, 0);
    assert.equal(r.fundingPct, 0);
    assert.equal(r.holdingMinutes, 0);
  });

  it('funding sign: positive rate is a COST for LONG (negative fundingPct)', async () => {
    const decidedAt = pastDecidedAt();
    const t = (i: number) => decidedAt + (i + 1) * 60_000;
    const candles: Candle[] = [
      [t(0), 102, 102, 100, 101], // fill at 100
      [t(1), 101, 110, 100.5, 109], // hits TP
    ];
    const rec = makeRecord({
      side: 'LONG',
      decidedAt,
      entryZone: { low: 100, high: 102 },
      stopLoss: 95,
      takeProfit: 110,
      leverage: LEV,
    });
    // Single funding event inside the holding window with rate 0.0001 (1 bp).
    const funding = [{ fundingTime: t(0) + 30_000, fundingRate: 0.0001 }];

    const out = await resolveOne(rec, makeDeps(candles, funding));
    const r = out.resolved!;
    // fundingPct = -1 * sumRate * lev * 100 = -1 * 0.0001 * 5 * 100 = -0.05
    assert.ok(Math.abs(r.fundingPct! - -0.05) < 1e-9, `fundingPct=${r.fundingPct}`);
    assert.ok(r.fundingPct! < 0, 'positive funding rate must be a cost for LONG');
    assert.ok(Math.abs(r.pnlPct - (r.grossPnlPct! + r.feePct! + r.fundingPct!)) < 1e-9);
  });

  it('funding sign: positive rate is a CREDIT for SHORT (positive fundingPct)', async () => {
    const decidedAt = pastDecidedAt();
    const t = (i: number) => decidedAt + (i + 1) * 60_000;
    const candles: Candle[] = [
      [t(0), 99, 100, 98, 99], // fill at 100
      [t(1), 99, 99.5, 90, 91], // hits TP
    ];
    const rec = makeRecord({
      side: 'SHORT',
      decidedAt,
      entryZone: { low: 98, high: 100 },
      stopLoss: 105,
      takeProfit: 90,
      leverage: LEV,
    });
    const funding = [{ fundingTime: t(0) + 30_000, fundingRate: 0.0001 }];

    const out = await resolveOne(rec, makeDeps(candles, funding));
    const r = out.resolved!;
    // fundingPct = -(-1) * 0.0001 * 5 * 100 = +0.05
    assert.ok(Math.abs(r.fundingPct! - 0.05) < 1e-9, `fundingPct=${r.fundingPct}`);
    assert.ok(r.fundingPct! > 0, 'positive funding rate must be a credit for SHORT');
    assert.ok(Math.abs(r.pnlPct - (r.grossPnlPct! + r.feePct! + r.fundingPct!)) < 1e-9);
  });
});

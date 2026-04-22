// Core A/B harness: for a single (pair, tick) it asks Claude TWICE — once
// with the live 42.space prediction-market context block injected, once
// without. Everything else (system prompt, market data, agent state stub)
// is byte-identical between the two calls so the only independent variable
// is the prediction-market signal we're trying to validate.
//
// We intentionally do NOT pull in the production agent's news/funding/Kelly
// branches: they add noise and they're not what we're testing. The trading
// system prompt + multi-timeframe market context are reproduced inline so
// the harness stays a stable A/B substrate even if production logic shifts.

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { getKlines } from '../services/aster';
import { build42MarketContext } from '../services/fortyTwoPrompt';
import {
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateADX,
  calculateSMA,
  findRecentSwingHigh,
  findRecentSwingLow,
  formatRecentCandles,
  OHLCV,
} from '../agents/indicators';
import { appendDecision } from './store';
import { AbDecisionParsed, AbDecisionRecord, Variant } from './types';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Trimmed copy of the production prompt. It's reproduced here (rather than
// imported) so the harness keeps a stable baseline — if a future PR rewrites
// the live prompt, the A/B comparison stays apples-to-apples.
const HARNESS_SYSTEM_PROMPT = `You are BUILD4 — an elite quantitative crypto trading agent specialising in perpetual futures.

DECISION FRAMEWORK:
1. Identify regime from ADX (>25 trending, <20 ranging).
2. Require 2+ timeframe confirmations before any entry.
3. Score the setup 0-10. <5 = HOLD.
4. Place stops at structure (swing high/low), not arbitrary %. R/R must be ≥1.5:1.
5. Capital preservation first. HOLD is a valid action.

RESPOND WITH ONLY VALID JSON in exactly this schema:
{
  "action": "OPEN_LONG" | "OPEN_SHORT" | "CLOSE" | "HOLD",
  "confidence": 0.0-1.0,
  "setupScore": 0-10,
  "entryZone": { "low": number, "high": number } | null,
  "stopLoss": number | null,
  "takeProfit": number | null,
  "size": number | null,
  "leverage": number | null,
  "riskRewardRatio": number | null,
  "reasoning": "2-4 sentences",
  "holdReason": null | "string"
}

For HOLD: set entryZone/stopLoss/takeProfit/size/leverage/riskRewardRatio to null.`;

interface MarketSnapshot {
  context: string;
  price: number;
}

function buildMarketContext(o15: OHLCV, o1h: OHLCV, o4h: OHLCV, pair: string): MarketSnapshot {
  const price = o15.close[o15.close.length - 1];
  const ema9 = calculateEMA(o15.close, 9);
  const ema21 = calculateEMA(o15.close, 21);
  const ema50 = calculateEMA(o1h.close, 50);
  const ema200 = calculateEMA(o4h.close, 200);
  const rsi15 = calculateRSI(o15.close, 14);
  const rsi1h = calculateRSI(o1h.close, 14);
  const macd15 = calculateMACD(o15.close, 12, 26, 9);
  const bb15 = calculateBollingerBands(o15.close, 20, 2);
  const atr1h = calculateATR(o1h, 14);
  const adx = calculateADX(o1h, 14);
  const volSMA = calculateSMA(o1h.volume, 20);
  const volNow = o1h.volume[o1h.volume.length - 1];
  const volRatio = volSMA > 0 ? volNow / volSMA : 1;
  const resistance = findRecentSwingHigh(o4h, 20);
  const support = findRecentSwingLow(o4h, 20);
  const regime = adx > 25 ? (ema9 > ema200 ? 'TRENDING UP' : 'TRENDING DOWN') : 'RANGING';

  const context = `
PAIR: ${pair} | PRICE: $${price.toFixed(4)} | REGIME: ${regime} (ADX ${adx.toFixed(1)})

TREND:
- 15m EMA9 ${ema9 > ema21 ? 'ABOVE' : 'BELOW'} EMA21
- 1h price ${price > ema50 ? 'ABOVE' : 'BELOW'} EMA50 ($${ema50.toFixed(4)})
- 4h price ${price > ema200 ? 'ABOVE' : 'BELOW'} EMA200 ($${ema200.toFixed(4)})

MOMENTUM:
- RSI 15m: ${rsi15.toFixed(1)} | RSI 1h: ${rsi1h.toFixed(1)}
- MACD 15m hist: ${macd15.histogram.toFixed(6)} | recent cross: ${macd15.recentCross || 'NONE'}

VOLATILITY:
- BB width: ${(((bb15.upper - bb15.lower) / bb15.mid) * 100).toFixed(2)}%
- ATR(14) 1h: $${atr1h.toFixed(4)} (${((atr1h / price) * 100).toFixed(2)}%)

VOLUME:
- 1h vs 20-SMA: ${volRatio.toFixed(2)}x

KEY LEVELS:
- Resistance: $${resistance.toFixed(4)} (${(((resistance - price) / price) * 100).toFixed(2)}% away)
- Support:    $${support.toFixed(4)} (${(((price - support) / price) * 100).toFixed(2)}% away)

RECENT 15m CANDLES:
${formatRecentCandles(o15, 5)}`;
  return { context, price };
}

function buildUserMessage(marketContext: string, predictionContext: string, pair: string): string {
  return `=== MARKET DATA ===
${marketContext}

=== AGENT STATE ===
Max position: $100 USDT | Max leverage: 5x | SL setting: 2% | TP setting: 4%
No open positions. No recent trades.
${predictionContext}

=== YOUR TASK ===
Analyse the market data above for ${pair}. Apply your decision framework and return your decision as JSON. Be precise and honest about confidence. If you would not put real money in this trade right now, action = HOLD.`;
}

// Lightweight runtime validation for the Claude response. We don't pull in
// zod (avoids touching package.json) — just hand-check the fields the
// resolver and report depend on. Anything malformed is surfaced via
// parseError so it's still recorded but excluded from PnL stats.
function validateDecision(d: any): { ok: true; value: AbDecisionParsed } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  const validActions = ['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD'];
  if (!validActions.includes(d.action)) return { ok: false, reason: `bad action: ${d.action}` };
  if (typeof d.confidence !== 'number') return { ok: false, reason: 'confidence not a number' };
  if (typeof d.setupScore !== 'number') return { ok: false, reason: 'setupScore not a number' };
  // For entry actions, require valid SL/TP/zone so the resolver can simulate.
  if (d.action === 'OPEN_LONG' || d.action === 'OPEN_SHORT') {
    if (
      !d.entryZone ||
      typeof d.entryZone.low !== 'number' ||
      typeof d.entryZone.high !== 'number' ||
      d.entryZone.low <= 0 ||
      d.entryZone.high < d.entryZone.low
    ) {
      return { ok: false, reason: 'invalid entryZone for entry action' };
    }
    if (typeof d.stopLoss !== 'number' || d.stopLoss <= 0) return { ok: false, reason: 'stopLoss missing/invalid' };
    if (typeof d.takeProfit !== 'number' || d.takeProfit <= 0) return { ok: false, reason: 'takeProfit missing/invalid' };
    // Directional sanity: SL on wrong side of entry would simulate as instant win.
    const entryMid = (d.entryZone.low + d.entryZone.high) / 2;
    if (d.action === 'OPEN_LONG' && (d.stopLoss >= entryMid || d.takeProfit <= entryMid)) {
      return { ok: false, reason: 'LONG SL/TP on wrong side of entry' };
    }
    if (d.action === 'OPEN_SHORT' && (d.stopLoss <= entryMid || d.takeProfit >= entryMid)) {
      return { ok: false, reason: 'SHORT SL/TP on wrong side of entry' };
    }
    if (d.leverage != null && (typeof d.leverage !== 'number' || d.leverage <= 0)) {
      return { ok: false, reason: 'leverage invalid' };
    }
  }
  return { ok: true, value: d as AbDecisionParsed };
}

async function callClaude(userMessage: string): Promise<{ raw: string; parsed: AbDecisionParsed | null; parseError?: string }> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    system: HARNESS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });
  const raw = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    return { raw, parsed: null, parseError: 'JSON parse: ' + (err as Error).message };
  }
  const v = validateDecision(parsed);
  if (!v.ok) return { raw, parsed: null, parseError: 'validation: ' + v.reason };
  return { raw, parsed: v.value };
}

export interface RunAbTickOptions {
  pair: string;
  // When true, persist the paired decisions to the JSONL store. Default true.
  persist?: boolean;
}

export interface AbTickResult {
  pairTickId: string;
  pair: string;
  priceAtDecision: number;
  withCtx: AbDecisionRecord;
  withoutCtx: AbDecisionRecord;
}

export async function runAbTick({ pair, persist = true }: RunAbTickOptions): Promise<AbTickResult> {
  // 1. Fetch market data ONCE — both variants must reason over identical
  //    candles so the only delta is the prediction context.
  const [tf15, tf1h, tf4h] = await Promise.all([
    getKlines(pair, '15m', 200),
    getKlines(pair, '1h', 200),
    getKlines(pair, '4h', 200),
  ]);
  const snap = buildMarketContext(tf15, tf1h, tf4h, pair);

  // 2. Fetch prediction context (cached for 60s inside build42MarketContext,
  //    so two pairs in a row share one upstream call).
  let predictionBlock = '';
  try {
    const block = await Promise.race<string>([
      build42MarketContext({ maxMarkets: 5, tradingRelevantOnly: true }),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 3000)),
    ]);
    if (block.trim()) predictionBlock = '\n' + block;
  } catch (err) {
    console.warn('[ab-harness] 42.space context unavailable:', (err as Error).message);
  }

  // 3. Build the two prompts. The "without" variant gets ZERO 42 mention.
  const msgWith = buildUserMessage(snap.context, predictionBlock, pair);
  const msgWithout = buildUserMessage(snap.context, '', pair);

  // 4. Issue both Claude calls in parallel. Failures on one variant do not
  //    block the other — we still want to record what we got.
  const pairTickId = randomUUID();
  const decidedAt = Date.now();
  const [withRes, withoutRes] = await Promise.allSettled([callClaude(msgWith), callClaude(msgWithout)]);

  function toRecord(variant: Variant, result: PromiseSettledResult<Awaited<ReturnType<typeof callClaude>>>): AbDecisionRecord {
    if (result.status === 'fulfilled') {
      return {
        pairTickId,
        variant,
        pair,
        decidedAt,
        priceAtDecision: snap.price,
        decision: result.value.parsed,
        rawResponse: result.value.raw.slice(0, 4000),
        parseError: result.value.parseError,
      };
    }
    return {
      pairTickId,
      variant,
      pair,
      decidedAt,
      priceAtDecision: snap.price,
      decision: null,
      rawResponse: '',
      parseError: String((result as PromiseRejectedResult).reason).slice(0, 500),
    };
  }

  const withCtx = toRecord('with_42', withRes);
  const withoutCtx = toRecord('without_42', withoutRes);

  if (persist) {
    await appendDecision(withCtx);
    await appendDecision(withoutCtx);
  }

  return { pairTickId, pair, priceAtDecision: snap.price, withCtx, withoutCtx };
}

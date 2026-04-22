import axios from 'axios';

// TODO: Confirm with 42.space team — base URL not yet documented in their REST API alpha page.
// Trying api.42.space first; fallback candidates: api-alpha.42.space, app.42.space/api
const BASE_URL = process.env.FORTYTWO_API_BASE_URL || 'https://api.42.space';
export const FORTYTWO_CHAIN_ID = 56;

// ── Types ──────────────────────────────────────────────────────────────────

export interface Market42 {
  address: string;
  title: string;
  category: string;
  categorySlug: string;
  outcomes: Outcome[];
  expiresAt: string;
  resolved: boolean;
  resolvedOutcomeId?: number;
}

export interface Outcome {
  tokenId: number;
  label: string;
  currentPrice: number;
  priceChange24h: number;
  holders: number;
  volume24h: number;
}

export interface OHLCCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AgentSignal {
  marketAddress: string;
  marketTitle: string;
  outcomeLabel: string;
  tokenId: number;
  currentPrice: number;
  impliedProbability: number;
  momentum: 'strong_up' | 'up' | 'flat' | 'down' | 'strong_down';
  priceChange24h: number;
  signalStrength: number;
  reasoning: string;
}

// ── API Client ─────────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

// ── Market Fetching ────────────────────────────────────────────────────────
// NOTE: endpoint paths below are inferred from the REST API alpha sidebar
// (Get all markets, Get market by address, Get OHLC candlestick data, etc.).
// Confirm exact paths with 42.space before relying in production.

export async function getAllMarkets(category?: string): Promise<Market42[]> {
  const params: Record<string, unknown> = { resolved: false, limit: 100 };
  if (category) params.categorySlug = category;
  const { data } = await api.get('/markets', { params });
  return data.markets ?? data;
}

export const AGENT_CATEGORIES = ['ai', 'crypto', 'tech', 'geopolitics'];

export async function getAIRelevantMarkets(): Promise<Market42[]> {
  const results = await Promise.all(
    AGENT_CATEGORIES.map((slug) => getAllMarkets(slug).catch(() => [] as Market42[])),
  );
  return results.flat();
}

export async function getMarketByAddress(address: string): Promise<Market42> {
  const { data } = await api.get(`/markets/${address}`);
  return data;
}

export async function getOutcomeTokens(marketAddress: string): Promise<Outcome[]> {
  const { data } = await api.get(`/markets/${marketAddress}/outcomes`);
  return data.outcomes ?? data;
}

export async function getOHLC(
  marketAddress: string,
  tokenId: number,
  interval: '1m' | '5m' | '1h' | '1d' = '1h',
  limit = 48,
): Promise<OHLCCandle[]> {
  const { data } = await api.get(
    `/markets/${marketAddress}/outcomes/${tokenId}/ohlc`,
    { params: { interval, limit } },
  );
  return data.candles ?? data;
}

export async function getPriceHistory(
  marketAddress: string,
  tokenId: number,
  limit = 24,
): Promise<{ timestamp: number; price: number }[]> {
  const { data } = await api.get(
    `/markets/${marketAddress}/outcomes/${tokenId}/prices`,
    { params: { limit } },
  );
  return data.prices ?? data;
}

export async function getBatchStats(addresses: string[]): Promise<Record<string, unknown>> {
  const { data } = await api.post('/markets/batch', { addresses });
  return data;
}

// ── Signal Generation ──────────────────────────────────────────────────────

function computeMomentum(candles: OHLCCandle[]): AgentSignal['momentum'] {
  if (candles.length < 6) return 'flat';
  const recent = candles.slice(-6);
  const first = recent[0].close;
  const last = recent[recent.length - 1].close;
  if (!first) return 'flat';
  const change = (last - first) / first;
  if (change > 0.08) return 'strong_up';
  if (change > 0.03) return 'up';
  if (change < -0.08) return 'strong_down';
  if (change < -0.03) return 'down';
  return 'flat';
}

function computeSignalStrength(outcome: Outcome, momentum: AgentSignal['momentum']): number {
  let score = 0;
  if (outcome.currentPrice < 0.15 || outcome.currentPrice > 0.85) score += 30;
  if (momentum === 'strong_up' || momentum === 'strong_down') score += 35;
  else if (momentum === 'up' || momentum === 'down') score += 20;
  if (outcome.volume24h > 1000) score += 20;
  if (outcome.holders > 50) score += 15;
  return Math.min(score, 100);
}

function buildReasoning(outcome: Outcome, momentum: string): string {
  const parts: string[] = [];
  if (outcome.currentPrice < 0.2)
    parts.push(`low implied probability (${(outcome.currentPrice * 100).toFixed(1)}%) — possibly underpriced`);
  if (outcome.currentPrice > 0.8)
    parts.push(`high implied probability (${(outcome.currentPrice * 100).toFixed(1)}%) — near certainty`);
  if (momentum === 'strong_up') parts.push('strong upward momentum last 6h');
  if (momentum === 'strong_down') parts.push('strong downward pressure — possible exit signal');
  if (outcome.volume24h > 1000) parts.push(`solid 24h volume ($${outcome.volume24h.toFixed(0)})`);
  return parts.join('; ') || 'moderate signal';
}

export async function generateSignalsForMarket(market: Market42): Promise<AgentSignal[]> {
  const signals: AgentSignal[] = [];
  for (const outcome of market.outcomes ?? []) {
    try {
      const candles = await getOHLC(market.address, outcome.tokenId, '1h', 24);
      const momentum = computeMomentum(candles);
      const strength = computeSignalStrength(outcome, momentum);
      if (strength < 40) continue;
      signals.push({
        marketAddress: market.address,
        marketTitle: market.title,
        outcomeLabel: outcome.label,
        tokenId: outcome.tokenId,
        currentPrice: outcome.currentPrice,
        impliedProbability: outcome.currentPrice,
        momentum,
        priceChange24h: outcome.priceChange24h,
        signalStrength: strength,
        reasoning: buildReasoning(outcome, momentum),
      });
    } catch {
      // skip outcomes with missing OHLC data
    }
  }
  return signals;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function scanAllSignals(): Promise<AgentSignal[]> {
  const markets = await getAIRelevantMarkets();
  const allSignals: AgentSignal[] = [];
  for (let i = 0; i < markets.length; i += 5) {
    const batch = markets.slice(i, i + 5);
    const batchSignals = await Promise.all(
      batch.map((m) => generateSignalsForMarket(m).catch(() => [] as AgentSignal[])),
    );
    allSignals.push(...batchSignals.flat());
    if (i + 5 < markets.length) await sleep(500);
  }
  return allSignals.sort((a, b) => b.signalStrength - a.signalStrength);
}

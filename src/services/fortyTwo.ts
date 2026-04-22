import axios from 'axios';

// 42.space REST API — base URL confirmed live (Apr 22 2026)
// Source: https://docs.42.space/for-developers/rest-api-alpha/markets/get-all-markets
const BASE_URL = process.env.FORTYTWO_API_BASE_URL || 'https://rest.ft.42.space';
export const FORTYTWO_CHAIN_ID = 56;

// ── Types (mirror real API response shape) ─────────────────────────────────

export type MarketStatus = 'live' | 'ended' | 'resolved' | 'finalised' | 'all';

export interface Market42 {
  address: string;
  questionId: string;
  question: string; // human-readable title
  slug: string;
  collateralAddress: string;
  collateralSymbol: string;
  collateralDecimals: number;
  curve: string;
  startDate: string;
  endDate: string;
  status: MarketStatus;
  finalisedAt: string | null;
  elapsedPct: number;
  image: string | null;
  oracleAddress: string | null;
  creatorAddress: string | null;
  contractVersion: number;
  ancillaryData: unknown[];
  description: string;
  categories?: string[];
}

export interface MarketTimelineEvent {
  type: string;
  timestamp: number;
}

// Outcome / OHLC / price-history types kept for downstream code, but the matching
// REST endpoints are NOT live yet (see verifyEndpoints() below). Until 42 ships
// them we plan to fall back to on-chain reads via IFTCurve + IRegistry.
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

// ── HTTP client ────────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

// ── Confirmed-working endpoints ────────────────────────────────────────────

export interface ListMarketsParams {
  limit?: number;
  offset?: number;
  order?: 'created_at' | 'volume' | 'collateral' | 'start_timestamp';
  ascending?: boolean;
  status?: MarketStatus;
  question_id?: string;
  market_address?: string;
  collateral?: string;
  categories?: string;
}

/** GET /api/v1/markets — paginated list with rich filters. */
export async function getAllMarkets(params: ListMarketsParams = {}): Promise<Market42[]> {
  const { data } = await api.get('/api/v1/markets', {
    params: { status: 'live', limit: 100, ...params },
  });
  return (data?.data ?? []) as Market42[];
}

/** GET /api/v1/markets/{address} — single market detail. */
export async function getMarketByAddress(address: string): Promise<Market42> {
  const { data } = await api.get(`/api/v1/markets/${address}`);
  return data as Market42;
}

/** GET /api/v1/markets/{address}/timeline — lifecycle events. */
export async function getMarketTimeline(address: string): Promise<MarketTimelineEvent[]> {
  const { data } = await api.get(`/api/v1/markets/${address}/timeline`);
  return (data?.events ?? []) as MarketTimelineEvent[];
}

// ── Endpoints documented but NOT yet live (return 404 as of Apr 22 2026) ───
// Categories, outcome tokens, current outcome token prices, price history,
// OHLC candlestick, batch market stats, outcome token stats/holders, users,
// leaderboard. Re-enable + wire into scanAllSignals once 42 ships them.

/** Probe which sidebar-documented endpoints actually exist. Useful for cron-based monitoring of API readiness. */
export async function verifyEndpoints(): Promise<Record<string, number>> {
  const sample = await getAllMarkets({ limit: 1 });
  const addr = sample[0]?.address;
  const targets = [
    '/api/v1/markets',
    `/api/v1/markets/${addr}`,
    `/api/v1/markets/${addr}/timeline`,
    `/api/v1/markets/${addr}/outcome-tokens`,
    `/api/v1/markets/${addr}/ohlc`,
    '/api/v1/categories',
    '/api/v1/leaderboard',
  ];
  const results: Record<string, number> = {};
  await Promise.all(
    targets.map(async (path) => {
      try {
        const r = await api.get(path, { validateStatus: () => true });
        results[path] = r.status;
      } catch {
        results[path] = -1;
      }
    }),
  );
  return results;
}

// ── Signal generation (degraded mode) ──────────────────────────────────────
// Without the outcome/price endpoints, we can only surface market-level
// metadata to the agent (title, category, end date, time elapsed). Full
// per-outcome signals require either the missing REST endpoints or an
// on-chain reader against IFTCurve.calMintCostByOtDelta.

export interface MarketLevelSignal {
  marketAddress: string;
  title: string;
  category: string;
  endDate: string;
  elapsedPct: number;
  reasoning: string;
}

export async function scanMarketLevelSignals(limit = 25): Promise<MarketLevelSignal[]> {
  const markets = await getAllMarkets({ status: 'live', limit, order: 'volume', ascending: false });
  return markets.map((m) => ({
    marketAddress: m.address,
    title: m.question,
    category: (m.categories ?? [])[0] ?? 'uncategorized',
    endDate: m.endDate,
    elapsedPct: m.elapsedPct,
    reasoning: `live market, ${(m.elapsedPct * 100).toFixed(0)}% elapsed, ends ${m.endDate}`,
  }));
}

/** Backward-compatible stub: returns an empty array until per-outcome endpoints ship. */
export async function scanAllSignals(): Promise<AgentSignal[]> {
  return [];
}

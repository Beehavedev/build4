import { ethers } from 'ethers';
import {
  FTMARKET_CONTROLLER_ADDRESS,
  POWER_CURVE_ADDRESS,
} from './fortyTwoTrader';
import type { Market42 } from './fortyTwo';

const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org';

if (!process.env.BSC_RPC_URL) {
  // The public binance dataseed endpoint is heavily rate-limited and frequently
  // returns "missing response for request" under modest load. That breaks
  // 42.space prediction prices, which makes agents see 0% everywhere and never
  // trade prediction markets. Set BSC_RPC_URL to a paid endpoint (QuickNode,
  // Alchemy, Ankr, etc.) to fix.
  console.warn(
    '[fortyTwo] BSC_RPC_URL not set — using public bsc-dataseed.binance.org. ' +
    'This will rate-limit and break prediction-market price reads. ' +
    'Set BSC_RPC_URL to a paid RPC endpoint.'
  );
}

let _provider: ethers.JsonRpcProvider | null = null;
function provider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(BSC_RPC);
  return _provider;
}

// Retry helper for transient RPC failures. The public BSC RPC frequently
// returns "missing response for request" / connection-reset errors when
// hit with 5+ concurrent eth_call requests. One quick retry recovers the
// vast majority of these without slowing down the success path.
async function rpcWithRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const msg: string = err?.shortMessage ?? err?.message ?? String(err);
    const transient = /missing response|timeout|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(msg);
    if (retries > 0 && transient) {
      await new Promise((r) => setTimeout(r, 250));
      return rpcWithRetry(fn, retries - 1);
    }
    throw err;
  }
}

// ── ABIs (minimal, just what we need) ──────────────────────────────────────

const CONTROLLER_ABI = [
  'function getConfig(address market) view returns (address treasury, uint80 feeRate, uint256 numOutcomes, uint128 timestampEnd, uint256 answer, bool isFinalised)',
  'function getOutcomeNames(bytes32 questionId) view returns (string[])',
];

const MARKET_ABI = [
  'function questionId() view returns (bytes32)',
];

// IFTCurve.calMarginalPrice is a `view` function returning price in collateral decimals.
const CURVE_ABI = [
  'function calMarginalPrice(address market, uint256 tokenId) view returns (uint256)',
];

// ── Caching ────────────────────────────────────────────────────────────────

interface MarketMetaCache {
  questionId: string;
  numOutcomes: number;
  outcomeNames: string[];
  feeRate: bigint;
  isFinalised: boolean;
  answer: bigint;
  timestampEnd: number;
  fetchedAt: number;
}
const META_TTL_MS = 10 * 60_000;
const metaCache = new Map<string, MarketMetaCache>();

interface PriceCache {
  prices: OnchainOutcome[];
  fetchedAt: number;
}
const PRICE_TTL_MS = 30_000;
const priceCache = new Map<string, PriceCache>();

// Dedup set for the zero-price diagnostic. We log once per market per process
// to surface RPC reverts / wrong curve addresses without spamming logs every
// 30s when the price cache expires.
const _priceFailureLogged = new Set<string>();

// ── Public types ───────────────────────────────────────────────────────────

export interface OnchainOutcome {
  index: number;
  tokenId: number;        // = 2 ** index
  label: string;
  marginalPrice: bigint;  // raw, in collateral decimals (18 for USDT)
  priceFloat: number;     // marginalPrice / 10**decimals
  impliedProbability: number; // priceFloat normalised so all outcomes sum to 1
  isWinner: boolean;      // true once market is resolved
}

export interface OnchainMarketState {
  market: string;
  questionId: string;
  curve: string;
  collateralDecimals: number;
  numOutcomes: number;
  feeRate: bigint;
  isFinalised: boolean;
  resolvedAnswer: bigint;
  timestampEnd: number;
  outcomes: OnchainOutcome[];
}

// ── Encoding helper ────────────────────────────────────────────────────────

/** Outcome index → ERC-1155 tokenId. Per src/libraries/Market.sol: tokenId = 2^index. */
export function tokenIdForIndex(index: number): number {
  return 2 ** index;
}

/** Bitwise winner check: outcome wins iff (resolvedAnswer & tokenId) != 0. */
export function isWinningTokenId(answer: bigint, tokenId: number): boolean {
  return (answer & BigInt(tokenId)) !== 0n;
}

// ── Reads ──────────────────────────────────────────────────────────────────

async function loadMeta(marketAddress: string): Promise<MarketMetaCache> {
  const cached = metaCache.get(marketAddress);
  if (cached && Date.now() - cached.fetchedAt < META_TTL_MS) return cached;

  const p = provider();
  const controller = new ethers.Contract(FTMARKET_CONTROLLER_ADDRESS, CONTROLLER_ABI, p);
  const market = new ethers.Contract(marketAddress, MARKET_ABI, p);

  const [questionId, config] = await Promise.all([
    market.questionId() as Promise<string>,
    controller.getConfig(marketAddress) as Promise<[string, bigint, bigint, bigint, bigint, boolean]>,
  ]);
  const [, feeRate, numOutcomesBn, timestampEnd, answer, isFinalised] = config;

  const outcomeNames = (await controller.getOutcomeNames(questionId)) as string[];

  const meta: MarketMetaCache = {
    questionId,
    numOutcomes: Number(numOutcomesBn),
    outcomeNames,
    feeRate,
    isFinalised,
    answer,
    timestampEnd: Number(timestampEnd),
    fetchedAt: Date.now(),
  };
  metaCache.set(marketAddress, meta);
  return meta;
}

/**
 * Read marginal prices for every outcome in a market, normalised to implied
 * probabilities. Falls back to per-call try/catch so one bad outcome doesn't
 * sink the rest.
 */
export async function getOutcomePrices(
  marketAddress: string,
  curveAddress: string = POWER_CURVE_ADDRESS,
  collateralDecimals = 18,
): Promise<OnchainOutcome[]> {
  const cached = priceCache.get(marketAddress);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached.prices;

  const meta = await loadMeta(marketAddress);
  const curve = new ethers.Contract(curveAddress, CURVE_ABI, provider());
  const scale = 10 ** collateralDecimals;

  const raw: { index: number; tokenId: number; price: bigint | null; error?: string }[] = await Promise.all(
    Array.from({ length: meta.numOutcomes }, (_, i) => {
      const tokenId = tokenIdForIndex(i);
      return rpcWithRetry(() => curve.calMarginalPrice(marketAddress, tokenId) as Promise<bigint>)
        .then((p: bigint) => ({ index: i, tokenId, price: p }))
        .catch((e: any) => ({ index: i, tokenId, price: null, error: e?.shortMessage ?? e?.message ?? String(e) }));
    }),
  );

  const validSum = raw.reduce((s, r) => s + (r.price !== null ? Number(r.price) / scale : 0), 0);

  // Diagnostic: agents need real bonding-curve prices to trade prediction
  // markets. Distinguish RPC failure (every call threw -> price=null) from
  // a legitimate market state where the curve genuinely returns 0. Only the
  // failure case is actionable, so trigger on null-ratio rather than sum=0.
  // Logged once per market per process to avoid spam at the 30s cache TTL.
  const nullCount = raw.reduce((n, r) => n + (r.price === null ? 1 : 0), 0);
  if (nullCount > 0 && nullCount === raw.length && !_priceFailureLogged.has(marketAddress)) {
    _priceFailureLogged.add(marketAddress);
    const sample = raw.find((r) => r.error) ?? raw[0];
    console.warn(
      `[fortyTwo] all ${raw.length} on-chain price calls failed for market ${marketAddress} ` +
      `curve=${curveAddress} sampleErr="${sample?.error ?? 'unknown'}"`
    );
  }

  const outcomes: OnchainOutcome[] = raw.map((r) => {
    const priceFloat = r.price !== null ? Number(r.price) / scale : 0;
    return {
      index: r.index,
      tokenId: r.tokenId,
      label: meta.outcomeNames[r.index] ?? `Outcome ${r.index}`,
      marginalPrice: r.price ?? 0n,
      priceFloat,
      impliedProbability: validSum > 0 ? priceFloat / validSum : 0,
      isWinner: meta.isFinalised && isWinningTokenId(meta.answer, r.tokenId),
    };
  });

  priceCache.set(marketAddress, { prices: outcomes, fetchedAt: Date.now() });
  return outcomes;
}

/** Combined market state: metadata + live outcome prices. */
export async function readMarketOnchain(market: Market42): Promise<OnchainMarketState> {
  const [meta, outcomes] = await Promise.all([
    loadMeta(market.address),
    getOutcomePrices(market.address, market.curve, market.collateralDecimals),
  ]);
  return {
    market: market.address,
    questionId: meta.questionId,
    curve: market.curve,
    collateralDecimals: market.collateralDecimals,
    numOutcomes: meta.numOutcomes,
    feeRate: meta.feeRate,
    isFinalised: meta.isFinalised,
    resolvedAnswer: meta.answer,
    timestampEnd: meta.timestampEnd,
    outcomes,
  };
}

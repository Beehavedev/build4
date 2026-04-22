/**
 * Standalone test agent for 42.space outcome-token trading.
 *
 * Reads live on-chain marginal prices, picks an outcome per strategy, places
 * a paper-trade buy via FortyTwoTrader (dry-run mode), and tracks open
 * positions with mark-to-market PnL on subsequent ticks.
 *
 * Designed as a validation harness — wire it into the main trading agent
 * later once a strategy proves out.
 */

import { ethers } from 'ethers';
import { getAllMarkets } from './fortyTwo';
import { getOutcomePrices, readMarketOnchain, type OnchainOutcome } from './fortyTwoOnchain';
import { isTradingRelevant } from './fortyTwoPrompt';
import { FortyTwoTrader } from './fortyTwoTrader';

export type Strategy = 'MOMENTUM' | 'CONTRARIAN' | 'EDGE';

export interface PaperPosition {
  market: string;
  question: string;
  curve: string;               // curve address — needed for mark-to-market reads
  collateralDecimals: number;  // typically 18 (USDT on BSC)
  tokenId: number;
  outcomeLabel: string;
  costUSDT: number;
  entryPrice: number;          // marginal price at entry
  estimatedOT: number;         // costUSDT / entryPrice (small-trade approximation)
  openedAtTick: number;
}

export interface AgentTickReport {
  tick: number;
  agent: string;
  strategy: Strategy;
  decisions: { market: string; action: 'BUY' | 'SKIP'; reason: string }[];
  openPositions: number;
  cashUSDT: number;
  unrealizedPnLUSDT: number;
}

export interface AgentSummary {
  name: string;
  strategy: Strategy;
  startingBankrollUSDT: number;
  cashUSDT: number;
  openPositions: PaperPosition[];
  realizedPnLUSDT: number;
  unrealizedPnLUSDT: number;
  totalPnLUSDT: number;
  trades: number;
}

export interface FortyTwoAgentConfig {
  name: string;
  strategy: Strategy;
  bankrollUSDT?: number;       // default 50
  perTradeUSDT?: number;       // default 5
  maxOpenPositions?: number;   // default 5
  rpcUrl?: string;             // default BSC public
}

const DEFAULT_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org';

/**
 * Picks the outcome to trade per strategy. Returns null when nothing meets
 * the strategy's bar (so the agent SKIPs that market this tick).
 */
function pickOutcome(strategy: Strategy, outcomes: OnchainOutcome[]): OnchainOutcome | null {
  const live = outcomes.filter((o) => o.priceFloat > 0);
  if (live.length === 0) return null;

  switch (strategy) {
    case 'MOMENTUM': {
      // Always pick the highest-probability outcome unless it's already a
      // near-certainty (≥85%, no upside left). For multi-outcome markets the
      // favorite often sits at 12–25% — that's still a momentum bet on the
      // crowd's leading guess.
      const sorted = [...live].sort((a, b) => b.impliedProbability - a.impliedProbability);
      const top = sorted[0];
      if (!top || top.impliedProbability >= 0.85) return null;
      return top;
    }
    case 'CONTRARIAN':
      // Cheap longshots: probability between 3% and 15%. Skip if everything
      // is already a coin-flip.
      return (
        [...live]
          .sort((a, b) => a.impliedProbability - b.impliedProbability)
          .find((o) => o.impliedProbability >= 0.03 && o.impliedProbability <= 0.15) ?? null
      );
    case 'EDGE': {
      // Spread-aware: pick the median-probability outcome — the AMM curve
      // is steepest there, so small moves create the largest mark-to-market
      // swings (good signal for a validation harness).
      const sorted = [...live].sort((a, b) => a.impliedProbability - b.impliedProbability);
      return sorted[Math.floor(sorted.length / 2)] ?? null;
    }
  }
}

export class FortyTwoAgent {
  readonly name: string;
  readonly strategy: Strategy;
  readonly trader: FortyTwoTrader;
  readonly startingBankrollUSDT: number;
  readonly perTradeUSDT: number;
  readonly maxOpenPositions: number;

  cashUSDT: number;
  positions: PaperPosition[] = [];
  realizedPnLUSDT = 0;
  trades = 0;
  private tickCount = 0;

  constructor(cfg: FortyTwoAgentConfig) {
    this.name = cfg.name;
    this.strategy = cfg.strategy;
    this.startingBankrollUSDT = cfg.bankrollUSDT ?? 50;
    this.perTradeUSDT = cfg.perTradeUSDT ?? 5;
    this.maxOpenPositions = cfg.maxOpenPositions ?? 5;
    this.cashUSDT = this.startingBankrollUSDT;

    // Throwaway wallet — paper-trade mode never broadcasts so this is safe.
    const pk = ethers.Wallet.createRandom().privateKey;
    this.trader = new FortyTwoTrader(pk, cfg.rpcUrl ?? DEFAULT_RPC, { dryRun: true });
  }

  /** One scan + decide + (paper) execute pass over the top live markets. */
  async tick(maxMarkets = 5): Promise<AgentTickReport> {
    this.tickCount += 1;
    const decisions: AgentTickReport['decisions'] = [];

    // Pull more than we need so the keyword filter still leaves us with enough.
    const markets = (
      await getAllMarkets({ status: 'live', limit: maxMarkets * 4, order: 'volume', ascending: false })
    )
      .filter(isTradingRelevant)
      .slice(0, maxMarkets);

    for (const market of markets) {
      // Skip markets we already hold a position in — keep diversified.
      if (this.positions.some((p) => p.market === market.address)) {
        decisions.push({ market: market.address, action: 'SKIP', reason: 'already holding' });
        continue;
      }
      if (this.positions.length >= this.maxOpenPositions) {
        decisions.push({ market: market.address, action: 'SKIP', reason: 'max positions' });
        continue;
      }
      if (this.cashUSDT < this.perTradeUSDT) {
        decisions.push({ market: market.address, action: 'SKIP', reason: 'no cash' });
        continue;
      }

      let state;
      try {
        state = await readMarketOnchain(market);
      } catch {
        decisions.push({ market: market.address, action: 'SKIP', reason: 'price read failed' });
        continue;
      }
      if (state.isFinalised) {
        decisions.push({ market: market.address, action: 'SKIP', reason: 'finalised' });
        continue;
      }
      // Some markets return 0 for every outcome (paused / no liquidity / pre-trade).
      // Skip them — they'd produce useless paper trades and divide-by-zero PnL.
      if (state.outcomes.every((o) => o.priceFloat === 0)) {
        decisions.push({ market: market.address, action: 'SKIP', reason: 'all prices zero (no liquidity)' });
        continue;
      }

      const pick = pickOutcome(this.strategy, state.outcomes);
      if (!pick) {
        decisions.push({ market: market.address, action: 'SKIP', reason: 'no outcome matches strategy' });
        continue;
      }

      // Execute (paper). This logs a DryRunReceipt — no broadcast.
      await this.trader.buyOutcome(market.address, pick.tokenId, this.perTradeUSDT.toString());

      const pos: PaperPosition = {
        market: market.address,
        question: market.question.trim().slice(0, 80),
        curve: market.curve,
        collateralDecimals: market.collateralDecimals,
        tokenId: pick.tokenId,
        outcomeLabel: pick.label,
        costUSDT: this.perTradeUSDT,
        entryPrice: pick.priceFloat,
        estimatedOT: pick.priceFloat > 0 ? this.perTradeUSDT / pick.priceFloat : 0,
        openedAtTick: this.tickCount,
      };
      this.positions.push(pos);
      this.cashUSDT -= this.perTradeUSDT;
      this.trades += 1;
      decisions.push({
        market: market.address,
        action: 'BUY',
        reason: `${this.strategy} → "${pick.label}" @ ${pick.priceFloat.toFixed(4)} (${(pick.impliedProbability * 100).toFixed(1)}%)`,
      });
    }

    const unrealized = await this.markToMarket();

    return {
      tick: this.tickCount,
      agent: this.name,
      strategy: this.strategy,
      decisions,
      openPositions: this.positions.length,
      cashUSDT: this.cashUSDT,
      unrealizedPnLUSDT: unrealized,
    };
  }

  /** Re-quote every open position at the current marginal price. */
  async markToMarket(): Promise<number> {
    let total = 0;
    // Serialise re-quotes per market to share the 30s on-chain price cache
    // and stay friendly to public BSC RPC batch limits.
    const byMarket = new Map<string, PaperPosition[]>();
    for (const p of this.positions) {
      const arr = byMarket.get(p.market) ?? [];
      arr.push(p);
      byMarket.set(p.market, arr);
    }
    for (const [marketAddress, positions] of byMarket) {
      try {
        const sample = positions[0];
        const live = await getOutcomePrices(marketAddress, sample.curve, sample.collateralDecimals);
        for (const p of positions) {
          const tick = live.find((o) => o.tokenId === p.tokenId);
          if (!tick) continue;
          const currentValue = p.estimatedOT * tick.priceFloat;
          total += currentValue - p.costUSDT;
        }
      } catch {
        // Treat as flat if we can't quote — better than crashing the harness.
      }
    }
    return total;
  }

  summary(): AgentSummary {
    return {
      name: this.name,
      strategy: this.strategy,
      startingBankrollUSDT: this.startingBankrollUSDT,
      cashUSDT: this.cashUSDT,
      openPositions: this.positions,
      realizedPnLUSDT: this.realizedPnLUSDT,
      unrealizedPnLUSDT: 0, // recalculated by caller via markToMarket()
      totalPnLUSDT: 0,
      trades: this.trades,
    };
  }
}

// A/B harness types. Kept in their own module so the CLI, store, resolver,
// and report can all share the same record shape without circular imports.

export type Variant = 'with_42' | 'without_42';

export interface AbDecisionParsed {
  action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD';
  confidence: number;
  setupScore: number;
  entryZone: { low: number; high: number } | null;
  stopLoss: number | null;
  takeProfit: number | null;
  size: number | null;
  leverage: number | null;
  riskRewardRatio: number | null;
  reasoning: string;
  holdReason: string | null;
}

export interface AbDecisionRecord {
  // Stable id used to pair decisions across variants for the same tick.
  pairTickId: string;
  variant: Variant;
  pair: string;
  decidedAt: number; // ms epoch
  priceAtDecision: number;
  decision: AbDecisionParsed | null;
  rawResponse: string;
  parseError?: string;
  // Populated by the resolver after `holdingWindowMs` has elapsed.
  resolved?: {
    resolvedAt: number;
    exitPrice: number;
    exitReason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TIMEOUT' | 'NO_TRADE';
    pnlPct: number; // signed % return on notional (size * leverage), pre-fees
    holdingMinutes: number;
  };
}

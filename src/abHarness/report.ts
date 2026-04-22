// Report generator: pairs records by pairTickId, computes per-variant
// stats, and formats a markdown decision summary suitable for pasting into
// a PR or sharing with the team.

import { readAll } from './store';
import { AbDecisionRecord, Variant } from './types';

interface VariantStats {
  variant: Variant;
  totalDecisions: number;
  actionCounts: Record<string, number>;
  resolvedTrades: number;
  wins: number;
  losses: number;
  flat: number;
  winRatePct: number;
  avgPnlPct: number; // net of fees + funding
  totalPnlPct: number;
  bestPct: number;
  worstPct: number;
  // Cost breakdown — totals (sum across filled trades) so a reader can see
  // how much of the variant's PnL was eaten by frictions.
  totalGrossPnlPct: number;
  totalFeePct: number;
  totalFundingPct: number;
  noTradeFills: number; // entries that were never filled
}

function emptyStats(variant: Variant): VariantStats {
  return {
    variant,
    totalDecisions: 0,
    actionCounts: {},
    resolvedTrades: 0,
    wins: 0,
    losses: 0,
    flat: 0,
    winRatePct: 0,
    avgPnlPct: 0,
    totalPnlPct: 0,
    bestPct: 0,
    worstPct: 0,
    totalGrossPnlPct: 0,
    totalFeePct: 0,
    totalFundingPct: 0,
    noTradeFills: 0,
  };
}

function statsFor(records: AbDecisionRecord[], variant: Variant): VariantStats {
  const s = emptyStats(variant);
  const pnls: number[] = [];
  for (const r of records) {
    if (r.variant !== variant) continue;
    s.totalDecisions++;
    const action = r.decision?.action ?? 'PARSE_FAIL';
    s.actionCounts[action] = (s.actionCounts[action] ?? 0) + 1;
    if (r.resolved) {
      if (r.resolved.exitReason === 'NO_TRADE') {
        s.noTradeFills++;
      } else {
        s.resolvedTrades++;
        pnls.push(r.resolved.pnlPct);
        // Old records (pre-cost-breakdown) won't have these fields; treat
        // missing values as zero so the totals still add up to something
        // meaningful (gross will simply equal net for legacy rows).
        s.totalGrossPnlPct += r.resolved.grossPnlPct ?? r.resolved.pnlPct;
        s.totalFeePct += r.resolved.feePct ?? 0;
        s.totalFundingPct += r.resolved.fundingPct ?? 0;
        if (r.resolved.pnlPct > 0.001) s.wins++;
        else if (r.resolved.pnlPct < -0.001) s.losses++;
        else s.flat++;
      }
    }
  }
  if (pnls.length > 0) {
    s.avgPnlPct = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    s.totalPnlPct = pnls.reduce((a, b) => a + b, 0);
    s.bestPct = Math.max(...pnls);
    s.worstPct = Math.min(...pnls);
  }
  s.winRatePct = s.resolvedTrades > 0 ? (s.wins / s.resolvedTrades) * 100 : 0;
  return s;
}

interface Divergence {
  pairedTicks: number;
  agree: number;
  disagree: number;
  // breakdown of disagreement examples
  divergentPairs: { pair: string; decidedAt: number; with42: string; without42: string }[];
}

function divergence(records: AbDecisionRecord[]): Divergence {
  const byTick = new Map<string, { with_42?: AbDecisionRecord; without_42?: AbDecisionRecord }>();
  for (const r of records) {
    const slot = byTick.get(r.pairTickId) ?? {};
    slot[r.variant] = r;
    byTick.set(r.pairTickId, slot);
  }
  const d: Divergence = { pairedTicks: 0, agree: 0, disagree: 0, divergentPairs: [] };
  for (const slot of byTick.values()) {
    if (!slot.with_42 || !slot.without_42) continue;
    if (!slot.with_42.decision || !slot.without_42.decision) continue;
    d.pairedTicks++;
    const a = slot.with_42.decision.action;
    const b = slot.without_42.decision.action;
    if (a === b) {
      d.agree++;
    } else {
      d.disagree++;
      d.divergentPairs.push({
        pair: slot.with_42.pair,
        decidedAt: slot.with_42.decidedAt,
        with42: a,
        without42: b,
      });
    }
  }
  return d;
}

function formatStats(s: VariantStats): string {
  const actions = Object.entries(s.actionCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `${a}=${n}`)
    .join(' ');
  return [
    `### Variant: ${s.variant}`,
    `- Total decisions: ${s.totalDecisions}`,
    `- Action mix: ${actions || '(none)'}`,
    `- Filled trades: ${s.resolvedTrades} (no-fill entries: ${s.noTradeFills})`,
    `- Win / Loss / Flat: ${s.wins} / ${s.losses} / ${s.flat}`,
    `- Win rate: ${s.winRatePct.toFixed(1)}%`,
    `- Avg PnL per filled trade (net): ${s.avgPnlPct >= 0 ? '+' : ''}${s.avgPnlPct.toFixed(2)}%`,
    `- Total PnL net (sum of %): ${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(2)}%`,
    `- ↳ Gross (pre-costs): ${s.totalGrossPnlPct >= 0 ? '+' : ''}${s.totalGrossPnlPct.toFixed(2)}% | Fees: ${s.totalFeePct.toFixed(2)}% | Funding: ${s.totalFundingPct >= 0 ? '+' : ''}${s.totalFundingPct.toFixed(2)}%`,
    `- Best / Worst trade: ${s.bestPct >= 0 ? '+' : ''}${s.bestPct.toFixed(2)}% / ${s.worstPct.toFixed(2)}%`,
  ].join('\n');
}

function renderRecommendation(withCtx: VariantStats, withoutCtx: VariantStats, div: Divergence): string {
  // Heuristic decision rule. Intentionally conservative — a noisy edge over
  // a small sample is not enough to justify keeping the extra tokens/latency.
  const sampleOk = withCtx.resolvedTrades >= 20 && withoutCtx.resolvedTrades >= 20;
  const avgEdge = withCtx.avgPnlPct - withoutCtx.avgPnlPct;
  const winRateEdge = withCtx.winRatePct - withoutCtx.winRatePct;
  const divergencePct = div.pairedTicks > 0 ? (div.disagree / div.pairedTicks) * 100 : 0;

  if (!sampleOk) {
    return `**Verdict:** INCONCLUSIVE — need ≥20 filled trades per variant (currently ${withCtx.resolvedTrades} vs ${withoutCtx.resolvedTrades}). Keep harness running.`;
  }
  if (divergencePct < 5) {
    return `**Verdict:** DROP the prediction context — it changed only ${divergencePct.toFixed(1)}% of decisions. The signal is being ignored by the model.`;
  }
  if (avgEdge > 0.25 && winRateEdge >= 0) {
    return `**Verdict:** KEEP the prediction context — +${avgEdge.toFixed(2)}% avg PnL edge with non-negative win rate change.`;
  }
  if (avgEdge < -0.25) {
    return `**Verdict:** DROP the prediction context — it underperformed by ${avgEdge.toFixed(2)}% avg PnL.`;
  }
  return `**Verdict:** REFINE — context is changing decisions (${divergencePct.toFixed(1)}% divergence) but PnL edge is marginal (${avgEdge >= 0 ? '+' : ''}${avgEdge.toFixed(2)}%). Try filtering 42 markets to higher-confidence ones, or reweighting in the prompt.`;
}

export async function renderReport(): Promise<string> {
  const records = await readAll();
  if (records.length === 0) {
    return '# 42.space prediction-context A/B report\n\nNo decisions logged yet. Run the harness first.';
  }
  const withCtx = statsFor(records, 'with_42');
  const withoutCtx = statsFor(records, 'without_42');
  const div = divergence(records);

  const firstTs = Math.min(...records.map((r) => r.decidedAt));
  const lastTs = Math.max(...records.map((r) => r.decidedAt));
  const days = Math.max(0, (lastTs - firstTs) / (24 * 60 * 60 * 1000));

  const recentDivergent = div.divergentPairs
    .slice(-10)
    .map((d) => `- ${new Date(d.decidedAt).toISOString()} ${d.pair}: with_42=${d.with42} | without_42=${d.without42}`)
    .join('\n');

  return [
    '# 42.space prediction-context A/B report',
    '',
    `Window: ${new Date(firstTs).toISOString()} → ${new Date(lastTs).toISOString()} (${days.toFixed(2)} days)`,
    `Total records: ${records.length} | Paired ticks: ${div.pairedTicks}`,
    '',
    formatStats(withCtx),
    '',
    formatStats(withoutCtx),
    '',
    '### Decision divergence',
    `- Paired ticks where both variants returned valid JSON: ${div.pairedTicks}`,
    `- Same action: ${div.agree} (${div.pairedTicks ? ((div.agree / div.pairedTicks) * 100).toFixed(1) : '0.0'}%)`,
    `- Different action: ${div.disagree} (${div.pairedTicks ? ((div.disagree / div.pairedTicks) * 100).toFixed(1) : '0.0'}%)`,
    '',
    '### Recent divergent decisions',
    recentDivergent || '(none)',
    '',
    renderRecommendation(withCtx, withoutCtx, div),
    '',
  ].join('\n');
}

# Prediction-context A/B harness

A self-contained experiment to measure whether the live 42.space
prediction-market context block (injected into the trading agent prompt
in `src/agents/tradingAgent.ts`) actually improves PnL — or just adds
tokens.

## What it does

For every tick, for every pair, the harness:

1. Pulls one set of multi-timeframe candles from Aster.
2. Builds the prediction-market context once.
3. Calls Claude **twice** in parallel — once with the prediction context,
   once without. Everything else (system prompt, market data, agent state
   stub) is byte-identical. **Prediction context is the only independent
   variable.**
4. Persists both decisions to `.local/ab/decisions.jsonl`.

A separate resolver waits `HOLDING_WINDOW_MS` (4h), replays forward 1m
candles, and assigns each `OPEN_LONG` / `OPEN_SHORT` decision a simulated
PnL%:

- Entry fill = midpoint of the LLM's `entryZone`. If the zone never
  trades, decision is marked `NO_TRADE`.
- Exit = first SL/TP touch (SL wins ties, conservative). If neither hits,
  exit at the last candle's close (`TIMEOUT`).
- PnL% = signed return on notional × leverage, pre-fees.

A reporter aggregates wins, losses, avg PnL, and **decision divergence**
(how often the two variants disagreed on the action) into a markdown
summary.

## Usage

```bash
# One-shot tick across the default pair list
tsx scripts/abHarness.ts tick

# Long-running mode: tick every AB_HARNESS_TICK_MIN minutes (default 30).
# Each tick also runs the resolver so the report stays fresh.
tsx scripts/abHarness.ts loop

# Resolve any mature decisions ad-hoc
tsx scripts/abHarness.ts resolve

# Print the markdown report
tsx scripts/abHarness.ts report
```

### Env

| Var | Default | Notes |
|-----|---------|-------|
| `ANTHROPIC_API_KEY` | — | Required for tick/loop |
| `AB_HARNESS_PAIRS` | `BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT` | CSV |
| `AB_HARNESS_TICK_MIN` | `30` | `loop` interval (minutes) |
| `AB_HARNESS_MAX_MIN` | unset | If set, `loop` self-terminates after this many minutes |
| `AB_HARNESS_LOG` | `.local/ab/decisions.jsonl` | Override store path |

## Cost note

Each tick = 2 Claude calls × N pairs. With the default 4 pairs and a
30-minute interval, that's ~384 calls/day — stay aware of spend on
multi-day runs. For a quick sniff:

```bash
# 1-hour run, tick every 5 minutes (~96 paired calls total)
AB_HARNESS_TICK_MIN=5 AB_HARNESS_MAX_MIN=60 \
  npx tsx scripts/abHarness.ts loop
```

Note: PnL resolution requires a 4h holding window per decision. A
1-hour collection run will have ~zero resolved trades — use the
divergence-rate line in the report for a directional read, then come
back ≥4h after the last tick and run `resolve` + `report` for PnL.

## Decision rule (in the report)

The report ends with a `**Verdict:**` line:

- `INCONCLUSIVE` — fewer than 20 filled trades per variant.
- `DROP` — divergence < 5% (signal is being ignored), OR avg PnL edge < −0.25%.
- `KEEP` — avg PnL edge > +0.25% with non-negative win rate change.
- `REFINE` — meaningful divergence but PnL edge is marginal — try
  filtering 42 markets harder, or reweighting in the prompt.

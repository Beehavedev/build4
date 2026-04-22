# 42.space Prediction Market Integration

## What's wired in
`build42MarketContext()` in `src/services/fortyTwoPrompt.ts` fetches the top 5
AI/crypto/geopolitics signals from 42.space markets and injects them into the
Claude trading agent prompt on every decision cycle.

The full execution layer (`fortyTwoTrader.ts`) is built and ready —
`swapSimple` / `claimSimple` via FTRouter on BSC mainnet — but not yet
called in production. Agents read signals; they don't trade them yet.

## Why we're keeping it without a formal A/B test
1. **Active partnership.** 42.space is a live integration partner on BNB Chain.
   The context block keeps the code path warm and lets us demo agent reasoning
   that references their markets — that's a better story than "we'll add it later."
2. **Zero marginal cost at our current scale.** One extra API call + ~200 prompt
   tokens per agent decision cycle. Not worth optimising until volume justifies it.
3. **Markets will get richer.** 42.space is pre-v2. AI/tech market depth is thin
   today. Signal quality will improve as they grow — we want the pipe open when it does.

## When to revisit
- If agent decision latency becomes a problem → profile and consider caching signals
- If 42.space API goes down repeatedly → add a circuit breaker in `fortyTwoPrompt.ts`
- Once trading layer is activated → run the 7-day experiment properly with PnL tracking

## Contacts
- 42.space team: [add Discord/Telegram handle]
- Integration started: April 2026

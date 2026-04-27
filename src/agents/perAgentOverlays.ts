// Per-agent overlays applied AFTER the shared market scan resolves.
//
// Phase 1 centralises one LLM call per (pair, mode) per tick across
// every active agent. The shared scan is intentionally generic — it
// knows nothing about any specific agent's open positions, memory,
// recent PnL, or risk knobs. Those per-agent adjustments happen here,
// deterministically and without firing more LLM calls.
//
// Keeping these as pure helpers (no DB, no clock side effects beyond
// the injected `nowMs`) makes them trivial to unit-test and reason
// about. The runner threads them in at the right point in
// `runAgentTick` without dragging more state through the call chain.

// Local mirrors of just the fields we touch. Avoids a wide structural
// import from tradingAgent.ts that would create a cycle the moment
// tradingAgent imports this module back.
export type ProposedSide = 'LONG' | 'SHORT'

export interface MemoryRecord {
  type: string
  content: string
  createdAt: Date | string | number
}

// Pair canonicalisation — mirrors the same helper in marketScan.ts.
// Defined locally here to keep this module dependency-free.
function canonicalPair(pair: string): string {
  return (pair ?? '').replace(/[\/\s]/g, '').toUpperCase()
}

// ─── shouldVetoOnMemory ──────────────────────────────────────────────
// Returns true when there's a recent `correction` memory matching this
// pair AND side, written within the lookback window. A "correction"
// memory is what `saveMemory(agent.id, 'correction', ...)` writes when
// a trade closes at a loss, formatted like:
//   `LOSS on BTCUSDT LONG: closed at $X, entry was $Y, lost $Z USDT...`
//
// We intentionally do a permissive substring match against the canon-
// icalised pair AND the side string. Both must appear: a correction
// about a SHORT loss does not veto a fresh LONG attempt.
//
// The 48h default window is a balance — long enough that a single bad
// session puts you in cooldown, short enough that a stale lesson from
// last week doesn't permanently lock you out of a pair that has since
// moved on.
export interface VetoInputs {
  memories: MemoryRecord[]
  pair: string
  side: ProposedSide
  nowMs: number
  windowMs?: number
}

export function shouldVetoOnMemory(input: VetoInputs): boolean {
  const window = input.windowMs ?? 48 * 60 * 60 * 1000
  const cutoff = input.nowMs - window
  const sym = canonicalPair(input.pair)
  for (const m of input.memories) {
    if (m.type !== 'correction') continue
    const created = m.createdAt instanceof Date
      ? m.createdAt.getTime()
      : typeof m.createdAt === 'number'
        ? m.createdAt
        : Date.parse(String(m.createdAt))
    if (!Number.isFinite(created) || created <= cutoff) continue
    const upper = (m.content ?? '').toUpperCase()
    if (upper.includes(sym) && upper.includes(input.side)) return true
  }
  return false
}

// ─── applyDrawdownSizeCut ────────────────────────────────────────────
// When the agent's last two closed trades were both losses, halve the
// Kelly budget. Mirrors the previous LLM-instructed cut that was
// embedded in the per-agent prompt:
//   "Drawdown Mode: YES — last 2 trades were losses, apply 50% size
//    reduction"
// The shared scan no longer carries that instruction (it doesn't know
// which agent is asking), so we re-apply it deterministically here.
//
// Floor at $1 so we never propose a degenerate $0 trade. The existing
// downstream sizer at tradingAgent.ts L1619 will pick the smaller of
// (decision.size, kellySize), so mutating kellySize here cleanly
// flows through.
export interface DrawdownInputs {
  kellySize: number
  lastTwoLosses: boolean
}

export function applyDrawdownSizeCut(input: DrawdownInputs): number {
  if (!input.lastTwoLosses) return input.kellySize
  return Math.max(1, Math.round(input.kellySize * 0.5))
}

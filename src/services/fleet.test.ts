/**
 * Fleet safety gate — DAILY TRADE CAP + DAILY-LOSS BRAKE regression net.
 *
 * Each fleet agent carries two spend throttles enforced by `agentOpenGate()`:
 *   • dailyTradeLimit  — once today's filled BUYS reach it, no new opens.
 *   • maxDailyLossBnb  — once today's realized PnL is down by that much,
 *                        the loss breaker trips and blocks further opens.
 * Both read from the per-agent `getTodayStats()` rollup (today's buys + PnL
 * from `fleet_trades`). A regression in the gate — or in how those stats are
 * summed — could silently let an agent over-trade or keep trading after
 * blowing its daily loss budget, burning real BNB at fleet scale.
 *
 * `agentOpenGate` is a PURE function (stats fed in), so this needs no DB: we
 * feed crafted stats and assert the skip reason. We hold the earlier gates
 * (paused / cooldown / max_positions) open so each test isolates exactly the
 * throttle under test, and we pin the gate's check ORDER so a reordering that
 * masked one brake behind another would be caught.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentOpenGate } from './fleet'
import type { FleetAgent } from './fleet'

// A clean agent: active, no cooldown, room for positions — so the ONLY gate
// that can fire is whichever throttle the individual test is exercising.
function makeAgent(over: Partial<FleetAgent> = {}): FleetAgent {
  return {
    id: 'unit_fleet_agent',
    name: 'unit',
    strategy: 'momentum',
    walletAddress: '0x' + 'b'.repeat(40),
    encryptedPk: 'unused',
    riskLevel: 'medium',
    maxTradeSizeBnb: 0.01,
    dailyTradeLimit: 10,
    cooldownSec: 0,
    jitterSec: 0,
    maxPositions: 100,
    minTrust: 0,
    takeProfitPct: 50,
    stopLossPct: 35,
    exitFillPct: 90,
    maxDailyLossBnb: 0.04,
    slippageBps: 500,
    watchlist: null,
    status: 'active',
    assignedTo: null,
    lastTickAt: null,
    createdAt: new Date(),
    ...over,
  }
}

// ── Daily trade cap ────────────────────────────────────────────────────────

test('daily trade cap: allows opens below the limit', () => {
  const agent = makeAgent({ dailyTradeLimit: 10 })
  // Well below, and exactly one short of the cap — both must be clear.
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 0), null)
  assert.equal(agentOpenGate(agent, { buys: 9, pnl: 0 }, 0), null)
})

test('daily trade cap: blocks once today\'s buys reach the limit', () => {
  const agent = makeAgent({ dailyTradeLimit: 10 })
  // At the cap is a block (>=), and any amount over stays blocked.
  assert.equal(agentOpenGate(agent, { buys: 10, pnl: 0 }, 0), 'daily_limit')
  assert.equal(agentOpenGate(agent, { buys: 11, pnl: 0 }, 0), 'daily_limit')
})

test('daily trade cap: undefined stats (no trades today) never trips the cap', () => {
  const agent = makeAgent({ dailyTradeLimit: 10 })
  assert.equal(agentOpenGate(agent, undefined, 0), null)
})

// ── Daily-loss brake ───────────────────────────────────────────────────────

test('daily-loss brake: profit or small loss stays clear', () => {
  const agent = makeAgent({ maxDailyLossBnb: 0.04 })
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0.5 }, 0), null)
  // A loss strictly smaller than the cap must still allow trading.
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: -0.039 }, 0), null)
})

test('daily-loss brake: trips once today\'s realized loss reaches the cap', () => {
  const agent = makeAgent({ maxDailyLossBnb: 0.04 })
  // Exactly at the cap (<=) trips, and a deeper loss stays tripped.
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: -0.04 }, 0), 'daily_loss_breaker')
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: -0.05 }, 0), 'daily_loss_breaker')
})

test('daily-loss brake: undefined stats (no trades today) never trips the breaker', () => {
  const agent = makeAgent({ maxDailyLossBnb: 0.04 })
  assert.equal(agentOpenGate(agent, undefined, 0), null)
})

// ── Per-agent cooldown ─────────────────────────────────────────────────────
// After a tick the agent must wait `cooldownSec` (+ random jitter) before it
// may open again. The jitter uses Math.random, so we pin it: with jitterSec=0
// the window is deterministic, and we stub Math.random to exercise the jitter.

test('cooldown: blocks while lastTickAt is within cooldownSec', () => {
  // 100s since the last tick is well inside the 300s window → still cooling.
  const agent = makeAgent({ cooldownSec: 300, jitterSec: 0, lastTickAt: new Date(Date.now() - 100_000) })
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 0), 'cooldown')
})

test('cooldown: clears once cooldownSec has elapsed', () => {
  // 400s since the last tick is past the 300s window → free to open.
  const agent = makeAgent({ cooldownSec: 300, jitterSec: 0, lastTickAt: new Date(Date.now() - 400_000) })
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 0), null)
})

test('cooldown: never fires when the agent has no recorded tick', () => {
  // A brand-new agent (lastTickAt null) has no window to wait out.
  const agent = makeAgent({ cooldownSec: 300, jitterSec: 120, lastTickAt: null })
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 0), null)
})

test('cooldown: jitter extends the window (Math.random stubbed)', () => {
  const realRandom = Math.random
  try {
    // 310s elapsed: cooldownSec(300) alone would clear, but max jitter
    // (floor(0.999*120)=119) pushes the window to 419s → still cooling.
    const agent = makeAgent({ cooldownSec: 300, jitterSec: 120, lastTickAt: new Date(Date.now() - 310_000) })
    Math.random = () => 0.999
    assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 0), 'cooldown')
    // Zero jitter on the same agent leaves a 300s window → 310s clears it.
    Math.random = () => 0
    assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 0), null)
  } finally {
    Math.random = realRandom
  }
})

// ── Max open-position cap ──────────────────────────────────────────────────
// The agent may not hold more than `maxPositions` concurrent bags. A regression
// here would let a single agent pile on positions, multiplying BNB at risk.

test('max_positions: allows opens below the cap', () => {
  const agent = makeAgent({ maxPositions: 3 })
  // Zero open, and one short of the cap — both must be clear.
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 0), null)
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 2), null)
})

test('max_positions: blocks once openCount reaches the cap', () => {
  const agent = makeAgent({ maxPositions: 3 })
  // At the cap is a block (>=), and any amount over stays blocked.
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 3), 'max_positions')
  assert.equal(agentOpenGate(agent, { buys: 0, pnl: 0 }, 4), 'max_positions')
})

// ── Gate ordering: throttles sit behind the structural gates ───────────────
// If a refactor reordered these checks, a paused/at-capacity agent could leak
// a different reason — or a throttle could be masked. Pin the precedence.

test('gate order: paused beats every throttle', () => {
  const agent = makeAgent({ status: 'paused', dailyTradeLimit: 10, maxDailyLossBnb: 0.04 })
  // Even over the trade cap AND past the loss brake, paused wins first.
  assert.equal(agentOpenGate(agent, { buys: 99, pnl: -1 }, 0), 'paused')
})

test('gate order: max_positions beats both daily throttles', () => {
  const agent = makeAgent({ maxPositions: 3, dailyTradeLimit: 10, maxDailyLossBnb: 0.04 })
  // openCount at capacity short-circuits before the trade/loss throttles.
  assert.equal(agentOpenGate(agent, { buys: 99, pnl: -1 }, 3), 'max_positions')
})

test('gate order: daily trade cap is reported before the loss brake', () => {
  const agent = makeAgent({ dailyTradeLimit: 10, maxDailyLossBnb: 0.04 })
  // Both throttles tripped — the cap is checked first, so it must win.
  assert.equal(agentOpenGate(agent, { buys: 10, pnl: -1 }, 0), 'daily_limit')
})

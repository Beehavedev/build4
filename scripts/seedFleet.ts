/**
 * Seed the Community Trading Fleet — 50 agents (5 strategy groups × 10).
 *
 * Each agent gets:
 *   • a unique themed name (from the strategy's name pool)
 *   • a freshly-generated BSC wallet (encrypted under the agent's own id)
 *   • per-agent risk/safety knobs randomized *within* the strategy's range
 *     so the 10 agents in a group are diversified, not clones
 *   • status='paused' — nothing trades until an admin reviews + funds it
 *
 * Idempotent: re-running never duplicates (ON CONFLICT on name) and never
 * burns a fresh wallet for an already-seeded name.
 *
 * Requires MASTER_ENCRYPTION_KEY (or WALLET_ENCRYPTION_KEY) to be set —
 * wallet encryption is fail-closed. Run with:
 *
 *   npx tsx scripts/seedFleet.ts
 *
 * After seeding, the fundable wallet addresses are printed (grouped by
 * strategy) and also visible on the /fleet admin panel.
 */

import { ensureNewTables } from '../src/ensureTables'
import {
  FLEET_STRATEGIES,
  FLEET_STRATEGY_KEYS,
  createFleetAgent,
  listFleetAgents,
} from '../src/services/fleet'

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function main() {
  console.log('[seedFleet] ensuring tables…')
  await ensureNewTables()

  let created = 0
  let skipped = 0

  for (const key of FLEET_STRATEGY_KEYS) {
    const profile = FLEET_STRATEGIES[key]
    if (profile.names.length !== 10) {
      throw new Error(`Strategy ${key} must define exactly 10 names (has ${profile.names.length})`)
    }
    for (const name of profile.names) {
      // maxTradeSizeBnb ranges are stored ×1000 in the profile (integer
      // bps-of-BNB) so randomization stays integer; divide back to BNB.
      const maxTradeSizeBnb = randInt(profile.maxTradeSizeBnb.min, profile.maxTradeSizeBnb.max) / 1000
      const res = await createFleetAgent({
        name,
        strategy: key,
        riskLevel: profile.risk,
        maxTradeSizeBnb,
        dailyTradeLimit: randInt(profile.dailyTradeLimit.min, profile.dailyTradeLimit.max),
        cooldownSec: randInt(profile.cooldownSec.min, profile.cooldownSec.max),
        jitterSec: randInt(profile.jitterSec.min, profile.jitterSec.max),
        maxPositions: randInt(profile.maxPositions.min, profile.maxPositions.max),
        minTrust: randInt(profile.minTrust.min, profile.minTrust.max),
        takeProfitPct: randInt(profile.takeProfitPct.min, profile.takeProfitPct.max),
        stopLossPct: randInt(profile.stopLossPct.min, profile.stopLossPct.max),
        exitFillPct: randInt(profile.exitFillPct.min, profile.exitFillPct.max),
        maxDailyLossBnb: profile.maxDailyLossBnb,
        slippageBps: profile.slippageBps,
        watchlist: null,
        assignedTo: null,
      })
      if (res.created) created += 1
      else skipped += 1
    }
  }

  console.log(`[seedFleet] done — created=${created} skipped(existing)=${skipped}`)

  // Print fundable addresses grouped by strategy.
  const agents = await listFleetAgents()
  const byStrategy = new Map<string, typeof agents>()
  for (const a of agents) {
    const arr = byStrategy.get(a.strategy) ?? []
    arr.push(a)
    byStrategy.set(a.strategy, arr)
  }
  console.log('\n──────── FLEET WALLET ADDRESSES (fund these) ────────')
  for (const key of FLEET_STRATEGY_KEYS) {
    const arr = byStrategy.get(key) ?? []
    console.log(`\n## ${FLEET_STRATEGIES[key].label} (${arr.length})`)
    for (const a of arr) console.log(`  ${a.name.padEnd(22)} ${a.walletAddress}`)
  }
  console.log('\nTotal:', agents.length, 'agents')
  process.exit(0)
}

main().catch((err) => {
  console.error('[seedFleet] FAILED:', err)
  process.exit(1)
})

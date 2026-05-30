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
 * (Or use the "Seed 50 agents" button on the /fleet admin panel, which calls
 * the same shared seedFleetAgents() under the hood.)
 *
 * After seeding, the fundable wallet addresses are printed (grouped by
 * strategy) and also visible on the /fleet admin panel.
 */

import { ensureNewTables } from '../src/ensureTables'
import {
  FLEET_STRATEGIES,
  FLEET_STRATEGY_KEYS,
  seedFleetAgents,
  listFleetAgents,
} from '../src/services/fleet'

async function main() {
  console.log('[seedFleet] ensuring tables…')
  await ensureNewTables()

  const { created, skipped } = await seedFleetAgents()
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

/**
 * Fleet FULL backup / restore — funds-safety round-trip.
 *
 * A backup CSV carries every fleet agent's config AND its decrypted private key.
 * The whole point is that export → wipe → import restores the agents BYTE-FOR-
 * BYTE on the SAME bot: the key namespace is the agent `id`, so a re-encrypt
 * under the original id must still decrypt to the same private key, and that key
 * must still control the recorded wallet address (or the funds are stranded).
 * Two layers are tested:
 *   1. CSV fidelity (pure, no DB): serializeFleetBackupCsv ↔ parseFleetBackupCsv
 *      round-trips commas, quotes, embedded JSON, and the spreadsheet
 *      formula-injection guard — these are the same two functions the
 *      /backup and /restore routes use, so the wire format is proven reversible.
 *   2. Service round-trip (real Postgres): seed → export → serialize → parse →
 *      DELETE → importFleetBackup → assert wallet + decrypted key survive, the
 *      agent comes back PAUSED, and a re-import is additive (skips existing).
 *      Plus the funds-safety guard: a row whose key does NOT derive the recorded
 *      address is refused (nothing inserted).
 *
 * Skips cleanly when no DATABASE_URL is reachable so it never blocks CI in a
 * Postgres-less environment. Encryption is fail-closed (encrypt throws when no
 * master key is set), so the file installs a THROWAWAY master key — but only
 * when none is configured, so a real CI key is never clobbered. node's test
 * runner isolates each file in its own process, so this env write cannot leak
 * into suites (e.g. telegramAuth) that assert the key is unset.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!process.env.MASTER_ENCRYPTION_KEY && !process.env.WALLET_ENCRYPTION_KEY) {
  process.env.MASTER_ENCRYPTION_KEY = 'fleet-backup-roundtrip-throwaway-test-key-0123456789'
}

// Unique per run so concurrent/repeat runs never collide and cleanup is scoped.
const PREFIX = `zzbktest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

async function dbReachable(db: any): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  try {
    await db.$queryRawUnsafe('SELECT 1')
    return true
  } catch {
    return false
  }
}

// fleet_agents is created on app boot; in a fresh CI DB without that boot it may
// not exist. Treat "table missing" the same as "DB unreachable" → skip.
async function fleetAgentsTableExists(db: any): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "fleet_agents" LIMIT 1')
    return true
  } catch {
    return false
  }
}

test('CSV serialize ↔ parse round-trips tricky values and rejects empty input', async () => {
  const fleet = await import('./fleet')
  const row: any = {
    id: `${PREFIX}_csv`,
    name: 'Comma, "Quoted" Name',
    strategy: fleet.FLEET_STRATEGY_KEYS[0],
    walletAddress: '0x' + 'a'.repeat(40),
    privateKey: '0x' + 'b'.repeat(64),
    riskLevel: 'medium',
    maxTradeSizeBnb: 5, dailyTradeLimit: 8, cooldownSec: 600, jitterSec: 120,
    maxPositions: 2, minTrust: 70, takeProfitPct: 45, stopLossPct: 30, exitFillPct: 92,
    maxDailyLossBnb: 0.02, slippageBps: 400,
    watchlist: '["0xAAA","0xBBB,with,commas"]',
    status: 'paused',
    assignedTo: '=cmd|danger', // formula-injection trigger — guarded on write
    swarmEnabled: true,
  }
  const csv = fleet.serializeFleetBackupCsv([row])
  // Header present + the guarded value is escaped with a leading apostrophe.
  assert.ok(csv.startsWith(fleet.FLEET_BACKUP_COLUMNS.join(',') + '\n'), 'canonical header')

  const parsed = fleet.parseFleetBackupCsv(csv)
  assert.equal(parsed.length, 1)
  const p = parsed[0]
  assert.equal(p.name, 'Comma, "Quoted" Name', 'comma + quotes survive')
  assert.equal(p.watchlist, '["0xAAA","0xBBB,with,commas"]', 'embedded JSON with commas survives')
  assert.equal(p.assignedTo, '=cmd|danger', 'formula-injection guard is reversed on read')
  assert.equal(p.privateKey, '0x' + 'b'.repeat(64), 'private key survives unmangled')
  assert.equal(p.id, `${PREFIX}_csv`)

  // No data rows → empty (the route turns this into a 400).
  assert.equal(fleet.parseFleetBackupCsv('id,name\n').length, 0, 'header-only → no rows')
  assert.equal(fleet.parseFleetBackupCsv('').length, 0, 'empty → no rows')
  // A UTF-8 BOM on the header (Excel) must not break the first column name.
  const bom = '\uFEFF' + fleet.serializeFleetBackupCsv([row])
  assert.equal(fleet.parseFleetBackupCsv(bom)[0].id, `${PREFIX}_csv`, 'BOM stripped from header')
})

test('seed → backup → wipe → restore round-trips agents (key + address preserved, comes back paused)', async (t) => {
  const { db } = await import('../db')
  if (!(await dbReachable(db)) || !(await fleetAgentsTableExists(db))) {
    t.skip('no reachable fleet_agents table')
    return
  }
  const fleet = await import('./fleet')

  const mk = async (suffix: string) => {
    const r = await fleet.createFleetAgent({
      name: `${PREFIX}_${suffix}`,
      strategy: fleet.FLEET_STRATEGY_KEYS[0],
      riskLevel: 'medium',
      maxTradeSizeBnb: 5, dailyTradeLimit: 8, cooldownSec: 600, jitterSec: 120,
      maxPositions: 2, minTrust: 70, takeProfitPct: 45, stopLossPct: 30, exitFillPct: 92,
      maxDailyLossBnb: 0.02, slippageBps: 400,
      watchlist: ['0xAaA0000000000000000000000000000000000001'],
    })
    assert.ok(r.created && r.agent, `seeded agent ${suffix}`)
    return r.agent!
  }

  try {
    const a1 = await mk('one')
    const a2 = await mk('two')
    // Capture the truth we expect to survive the round-trip.
    const pk1 = fleet.decryptFleetAgentKey(a1)
    const pk2 = fleet.decryptFleetAgentKey(a2)
    assert.ok(pk1.startsWith('0x') && pk2.startsWith('0x'))

    const mine = (await fleet.exportFleetBackup()).filter((r) => r.name.startsWith(PREFIX))
    assert.equal(mine.length, 2, 'both agents in the backup')
    assert.ok(mine.every((r) => !r.error && /^0x[0-9a-fA-F]{64}$/.test(r.privateKey)), 'keys decrypted')

    // Go through the REAL wire format the routes use.
    const rows = fleet.parseFleetBackupCsv(fleet.serializeFleetBackupCsv(mine))
    assert.equal(rows.length, 2)

    // Wipe (the DB-going-empty scenario this whole feature defends against).
    await fleet.deleteFleetAgent(a1.id)
    await fleet.deleteFleetAgent(a2.id)
    assert.equal(await fleet.getFleetAgent(a1.id), null, 'agent 1 gone')

    const out = await fleet.importFleetBackup(rows)
    assert.equal(out.restored, 2, 'both restored')
    assert.equal(out.skippedExisting, 0)
    assert.equal(out.failed, 0, JSON.stringify(out.errors))

    const r1 = await fleet.getFleetAgent(a1.id)
    assert.ok(r1, 'agent 1 restored under same id')
    assert.equal(r1!.walletAddress, a1.walletAddress, 'wallet address identical')
    assert.equal(r1!.status, 'paused', 'restored agents come back PAUSED (no silent live resume)')
    assert.equal(fleet.decryptFleetAgentKey(r1!), pk1, 'private key still decrypts (namespace = id)')

    // Additive: a second import of the same rows clobbers nothing.
    const out2 = await fleet.importFleetBackup(rows)
    assert.equal(out2.restored, 0, 're-import restores nothing')
    assert.equal(out2.skippedExisting, 2, 're-import skips both existing')
  } finally {
    await db.$executeRawUnsafe(`DELETE FROM "fleet_agents" WHERE "name" LIKE $1`, `${PREFIX}%`)
  }
})

test('restore refuses a row whose private_key does not control the recorded wallet (funds-safety)', async (t) => {
  const { db } = await import('../db')
  if (!(await dbReachable(db)) || !(await fleetAgentsTableExists(db))) {
    t.skip('no reachable fleet_agents table')
    return
  }
  const fleet = await import('./fleet')
  const { ethers } = await import('ethers')

  const w = ethers.Wallet.createRandom()
  const badRow: Record<string, string> = {
    id: `${PREFIX}_bad`,
    name: `${PREFIX}_bad`,
    strategy: String(fleet.FLEET_STRATEGY_KEYS[0]),
    walletAddress: '0x' + 'c'.repeat(40), // does NOT match the key below
    privateKey: w.privateKey,
    riskLevel: 'medium',
    status: 'paused',
    swarmEnabled: 'false',
  }
  try {
    const out = await fleet.importFleetBackup([badRow])
    assert.equal(out.restored, 0, 'mismatched row not restored')
    assert.equal(out.failed, 1)
    assert.match(out.errors[0]?.error ?? '', /wallet_address/i, 'rejected for address mismatch')
    assert.equal(await fleet.getFleetAgent(badRow.id), null, 'nothing inserted for the bad row')
  } finally {
    await db.$executeRawUnsafe(`DELETE FROM "fleet_agents" WHERE "name" LIKE $1`, `${PREFIX}%`)
  }
})

/**
 * One-shot backfill: register every BUILD4 Agent that doesn't have an
 * ERC-8004 agentId yet.
 *
 * Runs on Render (where DATABASE_URL + REGISTRY_WALLET_PK + the encryption
 * key actually live). Reuses the exact same `registerAgentOnchain` service
 * that /newagent + the mini-app onboard path call, so behaviour is
 * identical to a fresh registration.
 *
 * Defaults are paranoid:
 *   - DRY_RUN (no env flag set)  → just prints what it WOULD do, no calls
 *   - EXECUTE=true               → actually registers
 *   - LIMIT=N                    → cap to N agents (defaults to ALL)
 *   - AGENT_ID=<id>              → single-agent mode (for spot-checks)
 *   - CHAIN=bsc|xlayer           → defaults to 'bsc' (preserves history)
 *
 * Serialized via `registerAgentOnchain`'s built-in registry-wallet lock —
 * we run sequentially here to avoid nonce races even though the lock would
 * also serialize concurrent callers. ~6s per agent (fund tx + register tx,
 * both wait for ≥1 confirmation), so 1,000 agents ≈ 1.5 hours.
 *
 * Writes a CSV at scripts/erc8004-backfill-<date>.csv with one row per agent.
 *
 * Usage on Render shell:
 *   tsx scripts/backfillErc8004.ts                 # dry-run, full count
 *   LIMIT=1  EXECUTE=true tsx scripts/backfillErc8004.ts   # one agent live
 *   LIMIT=20 EXECUTE=true tsx scripts/backfillErc8004.ts   # batch of 20
 *   EXECUTE=true tsx scripts/backfillErc8004.ts            # ALL remaining
 */

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { db, setAgentOnchainFields } from '../src/db'
import { decryptPrivateKey } from '../src/services/wallet'
import { buildAgentIdentity, type AgentChain } from '../src/services/agentIdentity'
import { registerAgentOnchain } from '../src/services/erc8004'

const EXECUTE = process.env.EXECUTE === 'true'
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity
const ONLY_AGENT_ID = process.env.AGENT_ID ?? null
const CHAIN = (process.env.CHAIN as AgentChain) ?? 'bsc'
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://build4-1.onrender.com'

const csvPath = path.join(
  process.cwd(),
  `scripts/erc8004-backfill-${new Date().toISOString().slice(0, 10)}.csv`,
)
const csvRows: string[] = ['agentId,name,address,userId,result,erc8004AgentId,txHash,note']

function csvEscape(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function pushRow(r: Record<string, unknown>) {
  csvRows.push(
    [r.agentId, r.name, r.address, r.userId, r.result, r.erc8004AgentId, r.txHash, r.note]
      .map(csvEscape)
      .join(','),
  )
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('ERC-8004 backfill')
  console.log(`Mode:    ${EXECUTE ? '🟢 EXECUTE (will mint on-chain)' : '🟡 DRY RUN (no on-chain calls)'}`)
  console.log(`Chain:   ${CHAIN}`)
  console.log(`Limit:   ${LIMIT === Infinity ? 'ALL' : LIMIT}`)
  if (ONLY_AGENT_ID) console.log(`Agent:   ${ONLY_AGENT_ID} (single)`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const where: any = { erc8004AgentId: null, walletId: { not: null } }
  if (ONLY_AGENT_ID) where.id = ONLY_AGENT_ID

  const candidates = await db.agent.findMany({
    where,
    take: Number.isFinite(LIMIT) ? LIMIT : undefined,
    orderBy: { createdAt: 'asc' },
  })
  console.log(`Found ${candidates.length} agent(s) to register.\n`)
  if (candidates.length === 0) {
    console.log('Nothing to do.')
    return
  }

  let okCount = 0, failCount = 0, skipCount = 0

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i]
    const tag = `[${i + 1}/${candidates.length}] ${a.id} (${a.name ?? '?'})`

    if (!a.walletId) {
      console.log(`${tag} — SKIP: no walletId`)
      pushRow({ agentId: a.id, name: a.name, userId: a.userId, result: 'SKIP', note: 'no walletId' })
      skipCount++; continue
    }

    const wallet = await db.wallet.findUnique({ where: { id: a.walletId } })
    if (!wallet?.encryptedPK || !wallet.address) {
      console.log(`${tag} — SKIP: wallet missing encryptedPK or address`)
      pushRow({ agentId: a.id, name: a.name, userId: a.userId, result: 'SKIP', note: 'wallet incomplete' })
      skipCount++; continue
    }

    // Resolve the user's address — needed for the identity payload's owner
    // field. Fall back to the agent's own wallet if no user wallet exists
    // (won't happen in prod, defensive only).
    const user = await db.user.findUnique({ where: { id: a.userId } })
    const ownerAddress =
      (user as any)?.walletAddress ??
      wallet.address // defensive fallback

    let privateKey: string
    try {
      privateKey = decryptPrivateKey(wallet.encryptedPK, a.userId)
    } catch (e: any) {
      console.log(`${tag} — FAIL: decrypt: ${e.message}`)
      pushRow({ agentId: a.id, name: a.name, address: wallet.address, userId: a.userId, result: 'FAIL', note: `decrypt: ${e.message}` })
      failCount++; continue
    }

    const identity = buildAgentIdentity({
      name: a.name ?? `Agent${a.id.slice(0, 6)}`,
      agentAddress: wallet.address,
      ownerAddress,
      publicBaseUrl: PUBLIC_BASE_URL,
      chain: CHAIN,
    })

    if (!EXECUTE) {
      console.log(`${tag} — DRY: would register ${wallet.address} → ${identity.metadataUri}`)
      pushRow({ agentId: a.id, name: a.name, address: wallet.address, userId: a.userId, result: 'DRY_RUN', note: identity.metadataUri })
      continue
    }

    console.log(`${tag} — registering ${wallet.address}...`)
    const reg = await registerAgentOnchain({
      agentWalletPK: privateKey,
      agentAddress: wallet.address,
      metadataURI: identity.metadataUri,
      chain: CHAIN,
      onAgentFunded: async (h) => { try { await setAgentOnchainFields(a.id, { erc8004FundTxHash: h }) } catch {} },
      onRegisterTxSent: async (h) => { try { await setAgentOnchainFields(a.id, { erc8004TxHash: h, onchainTxHash: h }) } catch {} },
    })

    if (reg.success && reg.agentId) {
      await setAgentOnchainFields(a.id, {
        erc8004AgentId: reg.agentId,
        erc8004TxHash: reg.txHash ?? null,
        onchainTxHash: reg.txHash ?? null,
        erc8004Verified: true,
      })
      console.log(`${tag} — ✅ agentId=${reg.agentId} tx=${reg.txHash}`)
      pushRow({ agentId: a.id, name: a.name, address: wallet.address, userId: a.userId, result: 'OK', erc8004AgentId: reg.agentId, txHash: reg.txHash, note: '' })
      okCount++
    } else {
      console.log(`${tag} — ❌ ${reg.reason}`)
      pushRow({ agentId: a.id, name: a.name, address: wallet.address, userId: a.userId, result: 'FAIL', note: reg.reason })
      failCount++
    }
  }

  fs.writeFileSync(csvPath, csvRows.join('\n'))
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`OK:   ${okCount}`)
  console.log(`FAIL: ${failCount}`)
  console.log(`SKIP: ${skipCount}`)
  console.log(`CSV:  ${csvPath}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
}

main()
  .catch((e) => { console.error('FATAL:', e); process.exit(1) })
  .finally(async () => { try { await db.$disconnect() } catch {} })

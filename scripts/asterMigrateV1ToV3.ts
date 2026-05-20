// ── 2026-05-19: Aster V1 → V3 user-asset migration ─────────────────────
//
// Aster's V1 API is deprecated on 2026-06-30. Aster Code Builders (us) must
// move every user's V1 balances → V3 accounts before that date. New V3
// accounts are auto-created at the same wallet address as the V1 account
// (because `asterCodeOnboard` in build4io-site/server/aster-code.ts already
// runs `/fapi/v3/approveAgent` for every user when they first link Aster).
//
// This script handles Step 3 of Aster's plan: the actual asset transfer
// via `POST /fapi/v3/asset/migrateUser`. Docs:
//   https://github.com/asterdex/api-docs/blob/master/V3(Recommended)/
//   中文/aster-finance-futures-api-v3_CN.md#用户资产迁移-withdraw
//
// PRECONDITIONS (enforced by Aster server, not us):
//   - Source (V1) account must have NO open positions
//   - Source account must have NO open orders
//   - Balance > 0 for at least one asset (else server returns empty no-op)
// Aster's server rejects with an error if positions/orders exist; we log
// the error and move on. No client-side close-positions logic is bundled
// here — that's a separate operator decision per user.
//
// AUTH MODEL:
//   The migrate endpoint is signed by the USER's master wallet PK (the
//   same secp256k1 EOA they connected — `Wallet.encryptedPK` where
//   `Wallet.chain = 'BSC'`). EIP-712 typed-data, primaryType="MigrateUser",
//   domain `AsterSignTransaction` / chainId 56. The agent PK
//   (asterAgentEncryptedPK) is NOT used for migration — only the owner's
//   signature is accepted.
//
// USAGE:
//   tsx scripts/asterMigrateV1ToV3.ts                # DRY RUN (default)
//   EXECUTE=true tsx scripts/asterMigrateV1ToV3.ts   # actually call API
//   LIMIT=10 EXECUTE=true tsx scripts/asterMigrateV1ToV3.ts
//                                                    # cap to first 10 users
//   USER_ID=cuid-xyz EXECUTE=true tsx scripts/...    # migrate one user
//
// OUTPUT:
//   Writes `scripts/aster-migration-YYYY-MM-DD.csv` with one row per user:
//     telegramId, walletAddress, status, batchId, error
//
// SAFETY:
//   - DRY RUN by default — no API calls, just prints who would migrate.
//   - Per-user try/catch — one failure doesn't stop the batch.
//   - 600 ms throttle between calls to stay under Aster's 50-weight rate.
//   - Idempotency: Aster's server-side nonce + the no-balance no-op means
//     re-running on an already-migrated user is safe (server returns empty).

import { PrismaClient } from '@prisma/client'
import { Wallet } from 'ethers'
import { decryptPrivateKey } from '../src/services/wallet'
import * as fs from 'fs'
import * as path from 'path'

const ASTER_BASE = process.env.ASTER_BASE_URL ?? 'https://fapi.asterdex.com'
const EXECUTE = process.env.EXECUTE === 'true'
const LIMIT = parseInt(process.env.LIMIT ?? '0', 10) || 0
const USER_ID = process.env.USER_ID ?? ''
const THROTTLE_MS = 600

const EIP712_DOMAIN = {
  name: 'AsterSignTransaction',
  version: '1',
  chainId: 56,
  verifyingContract: '0x0000000000000000000000000000000000000000',
}

let nonceCounter = 0
let lastSec = 0
function generateNonce(): number {
  // Microsecond-precision integer required by Aster V3.
  const nowSec = Math.trunc(Date.now() / 1000)
  if (nowSec === lastSec) { nonceCounter++ } else { lastSec = nowSec; nonceCounter = 0 }
  return nowSec * 1_000_000 + nonceCounter
}

async function signMigrateUser(pk: string, userAddress: string, nonce: number): Promise<string> {
  // Aster's EIP-712 convention (see build4io-site/server/aster-code.ts:226):
  // capitalize each field name; infer type from value. For MigrateUser the
  // message is just { User, Nonce } — the smallest possible payload.
  const types = {
    MigrateUser: [
      { name: 'User', type: 'string' },
      { name: 'Nonce', type: 'uint256' },
    ],
  }
  const message = { User: userAddress, Nonce: nonce }
  const w = new Wallet(pk)
  return w.signTypedData(EIP712_DOMAIN, types, message)
}

interface MigrateResult {
  telegramId: string
  walletAddress: string
  status: 'DRY_RUN' | 'SUCCESS' | 'EMPTY' | 'ERROR' | 'SKIP_NO_WALLET' | 'SKIP_DECRYPT'
  batchId: string
  error: string
}

async function migrateOne(prisma: PrismaClient, user: any): Promise<MigrateResult> {
  const result: MigrateResult = {
    telegramId: String(user.telegramId ?? ''),
    walletAddress: '',
    status: 'DRY_RUN',
    batchId: '',
    error: '',
  }

  // Pick the active EVM wallet — that's the address Aster knows the user by.
  const wallet = (user.wallets ?? []).find(
    (w: any) => w.chain === 'BSC' && w.address?.startsWith('0x'),
  )
  if (!wallet) { result.status = 'SKIP_NO_WALLET'; return result }
  result.walletAddress = wallet.address.toLowerCase()

  // Decrypt the master PK — this is what signs the EIP-712 owner sig.
  let pk: string
  try {
    pk = decryptPrivateKey(wallet.encryptedPK)
    if (!pk?.startsWith('0x')) pk = '0x' + pk
  } catch (e: any) {
    result.status = 'SKIP_DECRYPT'
    result.error = e.message?.substring(0, 200) ?? 'decrypt failed'
    return result
  }

  if (!EXECUTE) { result.status = 'DRY_RUN'; return result }

  // Build + sign + POST.
  try {
    const nonce = generateNonce()
    const signature = await signMigrateUser(pk, result.walletAddress, nonce)
    const body = new URLSearchParams({
      user: result.walletAddress,
      nonce: String(nonce),
      signature,
    }).toString()

    const resp = await fetch(`${ASTER_BASE}/fapi/v3/asset/migrateUser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'BUILD4/1.0',
      },
      body,
    })
    const text = await resp.text()
    if (!resp.ok) {
      result.status = 'ERROR'
      result.error = `HTTP ${resp.status}: ${text.substring(0, 200)}`
      return result
    }
    let json: any = {}
    try { json = JSON.parse(text) } catch {}
    if (json.batchId) {
      result.status = 'SUCCESS'
      result.batchId = json.batchId
    } else {
      // Empty response = source account had no migratable balance.
      result.status = 'EMPTY'
    }
  } catch (e: any) {
    result.status = 'ERROR'
    result.error = e.message?.substring(0, 200) ?? 'unknown'
  }
  return result
}

async function main() {
  console.log(`[asterMigrate] EXECUTE=${EXECUTE} LIMIT=${LIMIT || 'all'} USER_ID=${USER_ID || 'any'}`)
  if (!EXECUTE) {
    console.log('[asterMigrate] DRY RUN — no API calls will be made.')
    console.log('[asterMigrate] Re-run with EXECUTE=true once the dry-run list looks correct.')
  }

  const prisma = new PrismaClient()
  const where: any = { asterOnboarded: true }
  if (USER_ID) where.id = USER_ID
  const users = await prisma.user.findMany({
    where,
    include: { wallets: true },
    take: LIMIT > 0 ? LIMIT : undefined,
    orderBy: { createdAt: 'asc' },
  })
  console.log(`[asterMigrate] candidate users: ${users.length}`)

  const results: MigrateResult[] = []
  for (let i = 0; i < users.length; i++) {
    const u = users[i]
    process.stdout.write(`[${i + 1}/${users.length}] tg=${u.telegramId} ... `)
    const r = await migrateOne(prisma, u)
    results.push(r)
    console.log(`${r.status}${r.batchId ? ' batch=' + r.batchId : ''}${r.error ? ' err=' + r.error : ''}`)
    if (EXECUTE && i < users.length - 1) await new Promise((res) => setTimeout(res, THROTTLE_MS))
  }

  // Write CSV summary.
  const ts = new Date().toISOString().slice(0, 10)
  const outPath = path.join('scripts', `aster-migration-${ts}.csv`)
  const header = 'telegramId,walletAddress,status,batchId,error\n'
  const rows = results
    .map((r) =>
      [r.telegramId, r.walletAddress, r.status, r.batchId, (r.error ?? '').replace(/[\n,]/g, ' ')].join(','),
    )
    .join('\n')
  fs.writeFileSync(outPath, header + rows + '\n')

  const counts = results.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {})
  console.log('\n[asterMigrate] complete')
  console.log('  counts:', counts)
  console.log('  csv:', outPath)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('[asterMigrate] FATAL', e)
  process.exit(1)
})

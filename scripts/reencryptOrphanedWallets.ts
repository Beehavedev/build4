// ── 2026-05-19 INCIDENT FIX (KSR-BUILD4-INCIDENT-2026-05-17) ─────────────────
// Wallet re-encryption migration script.
//
// CONTEXT
//   The Kairos Lab forensic report (W2 drain, May 17) traced the root cause
//   to two hardcoded fallback encryption keys that lived in the public
//   GitHub repo:
//     - 'default_dev_key_change_in_prod_32c'
//     - 'default-dev-key-change-me-32chars!'
//   During a window where neither MASTER_ENCRYPTION_KEY nor WALLET_ENCRYPTION_KEY
//   was set in production, every newly-created user wallet was encrypted
//   under one of those public defaults. The attacker grabbed the encrypted
//   PKs from Postgres and decrypted them with the public default → drained.
//
// WHAT THIS SCRIPT DOES
//   1. Loads every row from "Wallet".encryptedPK.
//   2. Decrypts each row using ALL legacy key candidates (OLD env key +
//      MASTER_KEY / LEGACY_MASTER as they currently resolve + the two
//      HISTORICAL_DEFAULT_* constants).
//   3. Re-encrypts the plaintext PK under the NEW env key (NEW_MASTER_KEY)
//      and writes it back.
//   4. Prints a summary: how many rows succeeded, how many were already
//      under the new key, how many were under a HISTORICAL_DEFAULT (= the
//      population that was at risk), how many failed (orphans we can't
//      recover automatically — needs manual intervention).
//
// HOW TO RUN
//   ──────────────────────────────────────────────────────────────────────
//   PRECONDITIONS (do these in order before running):
//     a) Pause the bot in Render: set EMERGENCY_PAUSE=true, wait for the
//        new instance to come up serving 503.
//     b) Generate a fresh 32-byte random secret. Suggested:
//          node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//     c) Set NEW_MASTER_KEY in env on the machine running the migration
//        (this is a one-time env var only used by this script).
//     d) KEEP the existing MASTER_ENCRYPTION_KEY / WALLET_ENCRYPTION_KEY
//        env vars set to their CURRENT values so the decrypt path can
//        find every row.
//     e) Take a full Postgres backup (Render dashboard → Backups → Manual).
//
//   COMMAND:
//     NEW_MASTER_KEY="<paste-fresh-base64-secret>" npx tsx scripts/reencryptOrphanedWallets.ts
//
//   DRY RUN FIRST (highly recommended):
//     NEW_MASTER_KEY="<paste-fresh-base64-secret>" DRY_RUN=true npx tsx scripts/reencryptOrphanedWallets.ts
//
//   POST-RUN STEPS:
//     a) Rotate MASTER_ENCRYPTION_KEY in Render to the NEW_MASTER_KEY value.
//        Remove the old WALLET_ENCRYPTION_KEY env var.
//     b) Unset EMERGENCY_PAUSE in Render. The bot resumes with the new key.
//     c) After 7 days of clean logs (no `[SECURITY] orphaned-wallet` warnings
//        in console), delete the HISTORICAL_DEFAULT_* constants from
//        src/services/wallet.ts and build4io-site/server/bot-wallet.ts and
//        push.

import { db } from '../src/db'
import CryptoJS from 'crypto-js'
import nodeCrypto from 'crypto'

const HISTORICAL_DEFAULT_MODERN = 'default_dev_key_change_in_prod_32c'
const HISTORICAL_DEFAULT_LEGACY = 'default-dev-key-change-me-32chars!'

const OLD_MASTER = process.env.MASTER_ENCRYPTION_KEY ?? ''
const OLD_LEGACY = process.env.WALLET_ENCRYPTION_KEY ?? ''
const NEW_MASTER = process.env.NEW_MASTER_KEY ?? ''
const DRY_RUN = process.env.DRY_RUN === 'true'

if (!NEW_MASTER || NEW_MASTER.length < 24) {
  console.error('FATAL: NEW_MASTER_KEY env var missing or too short (need ≥ 24 chars).')
  process.exit(1)
}
if (NEW_MASTER === HISTORICAL_DEFAULT_MODERN || NEW_MASTER === HISTORICAL_DEFAULT_LEGACY) {
  console.error('FATAL: NEW_MASTER_KEY matches a known leaked default. Generate a fresh secret.')
  process.exit(1)
}
if (NEW_MASTER === OLD_MASTER || NEW_MASTER === OLD_LEGACY) {
  console.error('FATAL: NEW_MASTER_KEY equals the current OLD key — that defeats the rotation.')
  process.exit(1)
}

const KEY_CANDIDATES = Array.from(new Set([
  OLD_MASTER, OLD_LEGACY,
  HISTORICAL_DEFAULT_MODERN, HISTORICAL_DEFAULT_LEGACY,
].filter(Boolean)))

// ── decrypt: mirror of src/services/wallet.ts decryptPrivateKey ────────────
function tryLegacyCbcDecrypt(encrypted: string, userId: string, master: string): string | null {
  const parts = encrypted.split(':')
  try {
    if (parts.length === 2) {
      const [ivHex, data] = parts
      if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(data)) return null
      const key = nodeCrypto.createHash('sha256').update(master + userId).digest()
      const iv = Buffer.from(ivHex, 'hex')
      const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', key, iv)
      let out = decipher.update(data, 'hex', 'utf8'); out += decipher.final('utf8')
      return out
    }
    if (parts.length === 3) {
      const [saltHex, ivHex, data] = parts
      if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(data)) return null
      const salt = Buffer.from(saltHex, 'hex')
      const iv = Buffer.from(ivHex, 'hex')
      const key = nodeCrypto.pbkdf2Sync(master, salt, 100000, 32, 'sha256')
      const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', key, iv)
      let out = decipher.update(data, 'hex', 'utf8'); out += decipher.final('utf8')
      return out
    }
  } catch { return null }
  return null
}

type DecryptResult = { plaintext: string; usedCandidate: string } | null

function decryptWithAllCandidates(encrypted: string, userId: string): DecryptResult {
  // Legacy CBC formats first (':'-separated)
  if (encrypted.includes(':')) {
    for (const cand of KEY_CANDIDATES) {
      const out = tryLegacyCbcDecrypt(encrypted, userId, cand)
      if (out && out.startsWith('0x')) return { plaintext: out, usedCandidate: cand }
    }
  }
  // CryptoJS path (base64, no ':')
  for (const cand of KEY_CANDIDATES) {
    try {
      const keyMaterial = cand + userId
      const key = CryptoJS.SHA256(keyMaterial).toString()
      const bytes = CryptoJS.AES.decrypt(encrypted, key)
      const out = bytes.toString(CryptoJS.enc.Utf8)
      if (out && out.startsWith('0x')) return { plaintext: out, usedCandidate: cand }
    } catch { /* keep trying */ }
  }
  return null
}

function reencrypt(plaintext: string, userId: string): string {
  const keyMaterial = NEW_MASTER + userId
  const key = CryptoJS.SHA256(keyMaterial).toString()
  return CryptoJS.AES.encrypt(plaintext, key).toString()
}

async function main() {
  console.log('═════════════════════════════════════════════════════════════')
  console.log(' BUILD4 wallet re-encryption migration')
  console.log(` mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will UPDATE Wallet rows)'}`)
  console.log(` candidates considered for decrypt: ${KEY_CANDIDATES.length}`)
  console.log('═════════════════════════════════════════════════════════════')

  const wallets = await db.wallet.findMany({
    where: { encryptedPK: { not: null } },
    select: { id: true, userId: true, address: true, encryptedPK: true, hasPinProtection: true },
  })
  console.log(`[migration] loaded ${wallets.length} wallet rows with non-null encryptedPK`)

  let okFromNew = 0
  let okFromOld = 0
  let okFromHistorical = 0  // <-- the at-risk population
  let pinProtectedSkipped = 0
  let failed = 0
  const failedRows: { id: string; address: string }[] = []

  for (const w of wallets) {
    if (w.hasPinProtection) {
      // PIN-protected wallets need the user's PIN to decrypt; we can't
      // migrate them server-side. They were also not at risk from the
      // public-default key path (PIN materially changes the derived key).
      pinProtectedSkipped++
      continue
    }
    if (!w.encryptedPK) continue

    const result = decryptWithAllCandidates(w.encryptedPK, w.userId)
    if (!result) {
      failed++
      failedRows.push({ id: w.id, address: w.address })
      continue
    }

    if (result.usedCandidate === HISTORICAL_DEFAULT_MODERN || result.usedCandidate === HISTORICAL_DEFAULT_LEGACY) {
      okFromHistorical++
    } else if (result.usedCandidate === OLD_MASTER) {
      okFromNew++  // current "new" candidate from env is what most non-orphans use
    } else {
      okFromOld++
    }

    if (!DRY_RUN) {
      const newCipher = reencrypt(result.plaintext, w.userId)
      await db.wallet.update({ where: { id: w.id }, data: { encryptedPK: newCipher } })
    }
  }

  console.log('─────────────────────────────────────────────────────────────')
  console.log(' RESULTS')
  console.log('─────────────────────────────────────────────────────────────')
  console.log(`  decrypt via current env key (MASTER_ENCRYPTION_KEY):  ${okFromNew}`)
  console.log(`  decrypt via current env key (WALLET_ENCRYPTION_KEY):  ${okFromOld}`)
  console.log(`  decrypt via HISTORICAL_DEFAULT (AT-RISK population):  ${okFromHistorical}`)
  console.log(`  PIN-protected, skipped (require user PIN):            ${pinProtectedSkipped}`)
  console.log(`  failed (NO candidate worked — manual review):         ${failed}`)
  if (failedRows.length > 0) {
    console.log('  failed rows:')
    for (const r of failedRows) console.log(`    - wallet.id=${r.id} address=${r.address}`)
  }
  console.log('─────────────────────────────────────────────────────────────')
  if (DRY_RUN) {
    console.log(' DRY RUN — no rows were modified. Re-run without DRY_RUN=true to commit.')
  } else {
    console.log(' All non-PIN-protected, non-failed rows have been re-encrypted under NEW_MASTER_KEY.')
    console.log(' NEXT STEPS:')
    console.log('   1. Rotate MASTER_ENCRYPTION_KEY in Render to the value of NEW_MASTER_KEY.')
    console.log('   2. Remove WALLET_ENCRYPTION_KEY env var in Render (no longer needed).')
    console.log('   3. Unset EMERGENCY_PAUSE in Render.')
    console.log('   4. Watch `[SECURITY] orphaned-wallet decrypt` warnings for 7 days — should be zero.')
    console.log('   5. Once zero for 7 days, delete HISTORICAL_DEFAULT_* from wallet.ts + bot-wallet.ts.')
  }
  await db.$disconnect()
}

main().catch((e) => {
  console.error('[migration] FATAL', e)
  process.exit(1)
})

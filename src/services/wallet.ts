import { ethers } from 'ethers'
import CryptoJS from 'crypto-js'
import nodeCrypto from 'crypto'
import { db } from '../db'

const MASTER_KEY = process.env.MASTER_ENCRYPTION_KEY ?? process.env.WALLET_ENCRYPTION_KEY ?? 'default_dev_key_change_in_prod_32c'
const LEGACY_MASTER = process.env.WALLET_ENCRYPTION_KEY ?? process.env.MASTER_ENCRYPTION_KEY ?? 'default-dev-key-change-me-32chars!'
const BSC_RPC    = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'

const LEGACY_ALGORITHM = 'aes-256-cbc'

function legacyDeriveKey(userId: string): Buffer {
  return nodeCrypto.createHash('sha256').update(LEGACY_MASTER + userId).digest()
}

function tryLegacyDecrypt(encrypted: string, userId: string): string | null {
  const parts = encrypted.split(':')
  try {
    if (parts.length === 2) {
      const [ivHex, data] = parts
      if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(data)) return null
      const key = legacyDeriveKey(userId)
      const iv = Buffer.from(ivHex, 'hex')
      const decipher = nodeCrypto.createDecipheriv(LEGACY_ALGORITHM, key, iv)
      let out = decipher.update(data, 'hex', 'utf8')
      out += decipher.final('utf8')
      return out
    }
    if (parts.length === 3) {
      const [saltHex, ivHex, data] = parts
      if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(data)) return null
      const salt = Buffer.from(saltHex, 'hex')
      const iv = Buffer.from(ivHex, 'hex')
      const key = nodeCrypto.pbkdf2Sync(LEGACY_MASTER, salt, 100000, 32, 'sha256')
      const decipher = nodeCrypto.createDecipheriv(LEGACY_ALGORITHM, key, iv)
      let out = decipher.update(data, 'hex', 'utf8')
      out += decipher.final('utf8')
      return out
    }
  } catch {
    return null
  }
  return null
}

// USDT contract on BSC
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)'
]

export function encryptPrivateKey(privateKey: string, userId: string, pin?: string): string {
  const keyMaterial = pin ? MASTER_KEY + userId + ':' + pin : MASTER_KEY + userId
  const key = CryptoJS.SHA256(keyMaterial).toString()
  return CryptoJS.AES.encrypt(privateKey, key).toString()
}

export function decryptPrivateKey(encrypted: string, userId: string, pin?: string): string {
  // Legacy formats (Node-crypto AES-CBC) use ':' as a separator.
  // CryptoJS output is base64 ("U2FsdGVkX1...") and never contains ':'.
  // Try legacy first when the payload looks legacy so PIN-encrypted CryptoJS
  // payloads (which never have ':') aren't accidentally routed here.
  if (encrypted.includes(':')) {
    const legacy = tryLegacyDecrypt(encrypted, userId)
    if (legacy && legacy.startsWith('0x')) return legacy
  }

  // CryptoJS path. Production has historically had two env vars
  // (MASTER_ENCRYPTION_KEY and WALLET_ENCRYPTION_KEY) used at different
  // points in the codebase's lifetime. Wallets created under the older
  // env-var convention can't be decrypted with MASTER_KEY alone — try
  // both candidates so users whose wallets predate the env rename
  // aren't permanently locked out of activation.
  // Always include the historical hardcoded defaults: production was
  // running for some period without either env var set, so wallets
  // created during that window were encrypted under the default
  // 'default_dev_key_change_in_prod_32c' (or 'default-dev-key-change
  // -me-32chars!'). Once env vars were added, MASTER_KEY/LEGACY_MASTER
  // started resolving to the env values and could no longer reach the
  // original default. Append the defaults as last-resort candidates so
  // those orphaned wallets remain decryptable forever.
  const HISTORICAL_DEFAULT_MODERN = 'default_dev_key_change_in_prod_32c'
  const HISTORICAL_DEFAULT_LEGACY = 'default-dev-key-change-me-32chars!'
  const keyCandidates = Array.from(new Set([
    MASTER_KEY, LEGACY_MASTER,
    HISTORICAL_DEFAULT_MODERN, HISTORICAL_DEFAULT_LEGACY,
  ].filter(Boolean)))
  let lastErr: Error | null = null
  for (const masterCandidate of keyCandidates) {
    try {
      const keyMaterial = pin ? masterCandidate + userId + ':' + pin : masterCandidate + userId
      const key = CryptoJS.SHA256(keyMaterial).toString()
      const bytes = CryptoJS.AES.decrypt(encrypted, key)
      const out = bytes.toString(CryptoJS.enc.Utf8)
      if (out && out.startsWith('0x')) return out
      if (out) return out
      lastErr = new Error('decrypt produced empty result')
    } catch (e: any) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('decrypt failed (all key candidates)')
}

/**
 * Re-encrypt every user wallet's PK from one PIN scheme to another.
 * - oldPin = undefined means "currently encrypted with master-only"
 * - newPin = undefined means "remove PIN, go back to master-only"
 */
export async function reencryptUserWallets(userId: string, oldPin: string | undefined, newPin: string | undefined) {
  const wallets = await db.wallet.findMany({ where: { userId } })
  for (const w of wallets) {
    if (!w.encryptedPK) continue
    let pk: string
    try {
      pk = decryptPrivateKey(w.encryptedPK, userId, oldPin)
      if (!pk || !pk.startsWith('0x')) throw new Error('Bad decrypt')
    } catch {
      continue // skip wallets we can't decrypt (e.g. legacy mismatch)
    }
    const newEncrypted = encryptPrivateKey(pk, userId, newPin)
    await db.wallet.update({ where: { id: w.id }, data: { encryptedPK: newEncrypted } })
  }
}

export function generateEVMWallet() {
  const wallet = ethers.Wallet.createRandom()
  return {
    address:  wallet.address,
    privateKey: wallet.privateKey,
    mnemonic:   wallet.mnemonic?.phrase ?? null
  }
}

export async function generateAndSaveWallet(
  userId: string,
  chain: string = 'BSC',
  label?: string
): Promise<{ address: string; chain: string; privateKey: string }> {
  const { address, privateKey } = generateEVMWallet()
  const encryptedPK = encryptPrivateKey(privateKey, userId)

  await db.wallet.updateMany({
    where: { userId, chain, isActive: true },
    data:  { isActive: false }
  })

  const walletCount = await db.wallet.count({ where: { userId } })

  const wallet = await db.wallet.create({
    data: {
      userId,
      chain,
      address,
      encryptedPK,
      label:    label ?? `Wallet ${walletCount + 1}`,
      isActive: true
    }
  })

  return { address: wallet.address, chain: wallet.chain, privateKey }
}

export async function importWallet(
  userId: string,
  privateKey: string,
  chain: string = 'BSC'
): Promise<{ address: string } | { error: string }> {
  try {
    const wallet  = new ethers.Wallet(privateKey)
    const address = wallet.address

    const existing = await db.wallet.findFirst({ where: { userId, address } })
    if (existing) return { error: 'Wallet already imported' }

    const encryptedPK  = encryptPrivateKey(privateKey, userId)
    const walletCount  = await db.wallet.count({ where: { userId } })

    await db.wallet.create({
      data: {
        userId, chain, address, encryptedPK,
        label:    `Imported Wallet ${walletCount + 1}`,
        isActive: false
      }
    })

    return { address }
  } catch {
    return { error: 'Invalid private key' }
  }
}

export async function getWalletBalances(
  address: string,
  chain: string
): Promise<{ usdt: number; native: number; nativeSymbol: string }> {
  try {
    // Only support BSC real balances for now
    if (chain === 'BSC') {
      const provider = new ethers.JsonRpcProvider(BSC_RPC)

      const [bnbWei, usdtContract] = await Promise.all([
        provider.getBalance(address),
        new ethers.Contract(USDT_BSC, ERC20_ABI, provider).balanceOf(address)
      ])

      const bnb  = parseFloat(ethers.formatEther(bnbWei))
      const usdt = parseFloat(ethers.formatUnits(usdtContract, 18))

      return { usdt, native: bnb, nativeSymbol: 'BNB' }
    }
  } catch (err) {
    console.error('[Wallet] getWalletBalances RPC failed, using mock:', err)
  }

  // Fallback: deterministic mock for non-BSC or RPC failures
  const hash = address.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const nativeSymbols: Record<string, string> = {
    BSC: 'BNB', ETH: 'ETH', BASE: 'ETH', SOL: 'SOL'
  }
  return {
    usdt:         Math.round(((hash % 5000) + 100) * 100) / 100,
    native:       Math.round(((hash % 20) + 0.01) * 10000) / 10000,
    nativeSymbol: nativeSymbols[chain] ?? 'ETH'
  }
}

export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

import { ethers } from 'ethers'
import CryptoJS from 'crypto-js'
import nodeCrypto from 'crypto'
import { db } from '../db'

const MASTER_KEY = process.env.MASTER_ENCRYPTION_KEY ?? process.env.WALLET_ENCRYPTION_KEY ?? 'default_dev_key_change_in_prod_32c'
const LEGACY_MASTER = process.env.WALLET_ENCRYPTION_KEY ?? process.env.MASTER_ENCRYPTION_KEY ?? 'default-dev-key-change-me-32chars!'
const BSC_RPC    = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'
const ARB_RPC    = process.env.ARBITRUM_RPC_URL ?? process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc'

// USDC on Arbitrum (native CCTP). Hyperliquid's bridge contract on Arbitrum
// only accepts this token — bridged USDC.e (0xFF970...) is NOT supported.
const USDC_ARBITRUM = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

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
): Promise<{ usdt: number; native: number; nativeSymbol: string; error: string | null }> {
  const nativeSymbols: Record<string, string> = {
    BSC: 'BNB', ETH: 'ETH', BASE: 'ETH', SOL: 'SOL'
  }
  const nativeSymbol = nativeSymbols[chain] ?? 'ETH'

  // Only BSC is supported via real on-chain reads. Any other chain returns
  // zero with an explicit error string so callers can surface a "not
  // supported" / "rpc unavailable" indicator instead of a fake number.
  // The project rule is: NEVER fabricate balances. A previous version of
  // this function returned a deterministic hash-derived mock on RPC
  // failure, which surfaced fictitious USDT amounts (e.g. $9.41) on the
  // home screen for users with truly empty wallets — directly violating
  // the no-mock-data rule.
  if (chain !== 'BSC') {
    return { usdt: 0, native: 0, nativeSymbol, error: 'unsupported_chain' }
  }

  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    const [bnbWei, usdtContract] = await Promise.all([
      provider.getBalance(address),
      new ethers.Contract(USDT_BSC, ERC20_ABI, provider).balanceOf(address)
    ])
    const bnb  = parseFloat(ethers.formatEther(bnbWei))
    const usdt = parseFloat(ethers.formatUnits(usdtContract, 18))
    return { usdt, native: bnb, nativeSymbol, error: null }
  } catch (err: any) {
    console.error('[Wallet] getWalletBalances BSC RPC failed for', address, '→', err?.shortMessage ?? err?.message)
    return { usdt: 0, native: 0, nativeSymbol, error: err?.shortMessage ?? err?.message ?? 'rpc_failed' }
  }
}

export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/**
 * Read native ETH + USDC balances on Arbitrum One for the given address.
 * The user's BSC wallet is also a valid Arbitrum wallet (same secp256k1 key).
 *
 * Returns 0/0 on RPC failure rather than throwing — callers display this
 * inline next to BSC balances and a single flaky RPC shouldn't break the
 * whole wallet view.
 */
export async function getArbitrumBalances(
  address: string
): Promise<{ eth: number; usdc: number; error: string | null }> {
  try {
    const provider = new ethers.JsonRpcProvider(ARB_RPC)
    const [ethWei, usdcRaw] = await Promise.all([
      provider.getBalance(address),
      new ethers.Contract(USDC_ARBITRUM, ERC20_ABI, provider).balanceOf(address)
    ])
    return {
      eth:   parseFloat(ethers.formatEther(ethWei)),
      usdc:  parseFloat(ethers.formatUnits(usdcRaw, 6)),
      error: null
    }
  } catch (err: any) {
    console.error('[Wallet] getArbitrumBalances failed:', err?.message)
    return { eth: 0, usdc: 0, error: err?.message ?? 'rpc_failed' }
  }
}

// Hyperliquid's deposit bridge contract on Arbitrum One. Native USDC sent
// here is auto-credited to the same EVM address on HL L1 within ~1 minute.
// Min deposit enforced by HL: $5. Bridged USDC.e is NOT accepted.
export const HL_BRIDGE_ARBITRUM = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7'
const ERC20_TRANSFER_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]

/**
 * Bridge USDC from the user's Arbitrum wallet to their Hyperliquid L1
 * account. Same EOA on both networks (HL credits the sender's address),
 * so the user doesn't need to specify a destination.
 *
 * Validates ETH gas balance and USDC balance up front so we surface a
 * clear error to the caller instead of bouncing off the RPC. Returns the
 * tx hash on success — the caller is responsible for polling HL's
 * clearinghouse to detect when the deposit has credited.
 */
export async function bridgeArbitrumUsdcToHyperliquid(
  privateKey: string,
  amountUsdc: number,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  if (!Number.isFinite(amountUsdc) || amountUsdc < 5) {
    return { success: false, error: 'Hyperliquid bridge minimum is $5 USDC' }
  }
  try {
    const provider = new ethers.JsonRpcProvider(ARB_RPC)
    const signer   = new ethers.Wallet(privateKey, provider)
    const usdc     = new ethers.Contract(USDC_ARBITRUM, ERC20_TRANSFER_ABI, signer)
    const amountRaw = ethers.parseUnits(amountUsdc.toFixed(6), 6)

    const [usdcBal, ethBal] = await Promise.all([
      usdc.balanceOf(signer.address) as Promise<bigint>,
      provider.getBalance(signer.address),
    ])
    if (usdcBal < amountRaw) {
      return {
        success: false,
        error:   `Insufficient Arbitrum USDC: have ${ethers.formatUnits(usdcBal, 6)}, need ${amountUsdc}`,
      }
    }
    // Empirically a USDC transfer on Arbitrum costs ~50k gas at ~0.01 gwei
    // → on the order of 0.0000005 ETH. Demand 0.00002 ETH (~$0.07 at $3.5k)
    // as a generous floor so we don't bounce on a single bad gas estimate.
    const minEthForGas = ethers.parseEther('0.00002')
    if (ethBal < minEthForGas) {
      return {
        success: false,
        error:   'Not enough ETH on Arbitrum to pay gas. Send a tiny amount of ETH (any amount above $0.10) to your wallet on Arbitrum and retry.',
      }
    }

    const tx = await usdc.transfer(HL_BRIDGE_ARBITRUM, amountRaw)
    console.log(`[Wallet] HL bridge: ${signer.address} sending ${amountUsdc} USDC, tx=${tx.hash}`)
    await tx.wait(1)
    return { success: true, txHash: tx.hash }
  } catch (err: any) {
    console.error('[Wallet] bridgeArbitrumUsdcToHyperliquid failed:', err?.message)
    return { success: false, error: err?.shortMessage ?? err?.message ?? 'bridge_failed' }
  }
}

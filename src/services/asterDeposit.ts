// ─────────────────────────────────────────────────────────────────────────────
// On-chain deposit helper — bridges a user's BSC USDT into their Aster
// futures account by calling the AstherusVault.deposit() function directly.
//
// AstherusVault is an ERC1967 proxy at 0x128463A60784c4D3f46c23Af3f65Ed859Ba87974
// (impl: 0x1006511304aada32ea80a259dcf140a6ecbd30dc). Source verified on BscScan.
//
// The relevant write function is:
//   deposit(address currency, uint256 amount, uint256 broker)
//
// On success, the vault emits Deposit(account, currency, isNative, amount, broker)
// which Aster's matching engine indexes to credit the user's futures account.
// ONCE this lands, signed Aster API endpoints (incl. approveAgent) start
// recognising the wallet — that's what unblocks the chicken-and-egg.
//
// Flow per call:
//   1. Read current USDT allowance on the vault. If insufficient → approve.
//   2. Call vault.deposit(USDT, amount, broker).
//   3. Wait 1 confirmation each.
//   4. Return tx hashes.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from 'ethers'

export const BSC_RPC     = process.env.BSC_RPC ?? 'https://bsc-dataseed.binance.org'
export const USDT_BSC    = '0x55d398326f99059fF775485246999027B3197955'
export const ASTER_VAULT = '0x128463A60784c4D3f46c23Af3f65Ed859Ba87974'

// Minimum BNB required to cover both txs at ~3 gwei. Real cost is ~0.0005 BNB
// for approve + deposit, but we require 0.001 to leave a comfortable margin.
export const MIN_BNB_FOR_GAS_WEI = ethers.parseEther('0.001')

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)'
]

const VAULT_ABI = [
  'function deposit(address currency, uint256 amount, uint256 broker)'
]

export function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(BSC_RPC)
}

export interface DepositResult {
  success:    boolean
  approveTx?: string  // hash of the USDT.approve tx (if one was needed)
  depositTx?: string  // hash of the vault.deposit tx
  error?:     string
}

export async function ensureAndDepositUSDT(opts: {
  userPrivateKey: string
  amountWei:      bigint
  broker?:        bigint  // BUILD4 broker id; 0 = no broker
}): Promise<DepositResult> {
  const broker   = opts.broker ?? 0n
  const provider = getProvider()
  const wallet   = new ethers.Wallet(opts.userPrivateKey, provider)
  const usdt     = new ethers.Contract(USDT_BSC,   ERC20_ABI, wallet)
  const vault    = new ethers.Contract(ASTER_VAULT, VAULT_ABI, wallet)

  console.log('[Deposit] start', {
    user:   wallet.address,
    amount: ethers.formatUnits(opts.amountWei, 18),
    vault:  ASTER_VAULT
  })

  // Sanity: do we actually have the USDT we plan to deposit? (Belt-and-suspenders;
  // the caller should have already validated this from the wallet endpoint.)
  const usdtBal = await usdt.balanceOf(wallet.address) as bigint
  if (usdtBal < opts.amountWei) {
    return { success: false, error: `Wallet only holds ${ethers.formatUnits(usdtBal, 18)} USDT, cannot deposit ${ethers.formatUnits(opts.amountWei, 18)}` }
  }

  // BNB gas check.
  const bnbBal = await provider.getBalance(wallet.address)
  if (bnbBal < MIN_BNB_FOR_GAS_WEI) {
    return { success: false, error: `Wallet needs ~0.001 BNB for gas (currently ${ethers.formatEther(bnbBal)} BNB). Please send a small amount of BNB to your wallet and retry.` }
  }

  let approveTxHash: string | undefined

  try {
    // ── 1. USDT.approve(vault, amount) — only if current allowance is too low ──
    const currentAllowance = await usdt.allowance(wallet.address, ASTER_VAULT) as bigint
    if (currentAllowance < opts.amountWei) {
      console.log('[Deposit] approving USDT', {
        current: currentAllowance.toString(),
        needed:  opts.amountWei.toString()
      })
      const tx = await usdt.approve(ASTER_VAULT, opts.amountWei)
      approveTxHash = tx.hash
      const rcpt = await tx.wait(1)
      if (!rcpt || rcpt.status !== 1) {
        return { success: false, approveTx: approveTxHash, error: 'USDT approve tx reverted' }
      }
      console.log('[Deposit] approve confirmed:', approveTxHash)
    } else {
      console.log('[Deposit] allowance already sufficient, skipping approve')
    }

    // ── 2. vault.deposit(USDT, amount, broker) ──
    const tx = await vault.deposit(USDT_BSC, opts.amountWei, broker)
    const depositTxHash = tx.hash
    console.log('[Deposit] deposit tx submitted:', depositTxHash)
    const rcpt = await tx.wait(1)
    if (!rcpt || rcpt.status !== 1) {
      return { success: false, approveTx: approveTxHash, depositTx: depositTxHash, error: 'Vault deposit tx reverted' }
    }
    console.log('[Deposit] deposit confirmed:', depositTxHash)

    return { success: true, approveTx: approveTxHash, depositTx: depositTxHash }
  } catch (err: any) {
    // ethers wraps revert reasons in err.reason / err.shortMessage
    const reason = err?.shortMessage ?? err?.reason ?? err?.message ?? 'unknown_error'
    console.error('[Deposit] failed:', wallet.address, '→', reason)
    return { success: false, approveTx: approveTxHash, error: String(reason) }
  }
}

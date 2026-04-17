import { ethers } from 'ethers'

/**
 * ERC-8004 Trustless AI Agents — Identity Registry integration.
 *
 * Every BUILD4 agent is registered on-chain in the official ERC-8004
 * IdentityRegistry on BNB Smart Chain. No protocol fee — only BSC gas
 * (~0.0003 BNB ≈ $0.10), which is sponsored by BUILD4 from a single
 * dedicated registry wallet. End users pay nothing for ERC-8004.
 *
 * The registry wallet's private key lives in the REGISTRY_WALLET_PK
 * secret. It funds each new agent wallet with just enough BNB to call
 * `register()` once on the IdentityRegistry; the agent self-registers
 * so the contract correctly records the agent's own address as the
 * canonical signer.
 *
 * Source: https://github.com/erc-8004/erc-8004-contracts
 * BSC Mainnet: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 */

const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'

export const ERC8004_REGISTRY = (
  process.env.ERC8004_REGISTRY ?? '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
).trim()

// Measured gas budget for one register(string) call. Worst observed on
// BSC is ~225k gas; we round up and add a 2x safety multiplier so that a
// sudden gas-price spike between funding tx and register tx can't strand
// the agent wallet mid-flow. At typical BSC gas prices (0.05 gwei) this
// resolves to ~$0.01 of real spend per registration.
const REGISTER_GAS_LIMIT = 500_000n  // 2x measured (~225k) for headroom
const FUND_SAFETY_MULTIPLIER = 2n    // extra slack vs current gas price

function getRegistryWalletPK(): string {
  const pk = process.env.REGISTRY_WALLET_PK
  if (!pk) {
    throw new Error('REGISTRY_WALLET_PK secret is not set — cannot sponsor ERC-8004 registrations.')
  }
  return pk.startsWith('0x') ? pk : '0x' + pk
}

export function getRegistryWalletAddress(): string {
  return new ethers.Wallet(getRegistryWalletPK()).address
}

export async function getRegistryWalletBalance(): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(BSC_RPC)
  return provider.getBalance(getRegistryWalletAddress())
}

const ERC8004_ABI = [
  'function register() external returns (uint256 agentId)',
  'function register(string agentURI) external returns (uint256 agentId)',
  'function ownerOf(uint256) view returns (address)',
  'function tokenURI(uint256) view returns (string)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)'
]

export interface RegisterResult {
  success: boolean
  agentId?: string
  txHash?: string
  fundTxHash?: string
  reason?: string
}

/**
 * Mandatory ERC-8004 registration for a new agent.
 *
 * Funded entirely by BUILD4's dedicated registry wallet (REGISTRY_WALLET_PK).
 * End users pay zero — they only need a wallet to own the agent.
 *
 * Flow:
 *   1. The registry wallet sends a tiny BNB amount to the agent's fresh
 *      wallet (so it can pay gas for the register call).
 *   2. Agent's wallet self-calls register(agentURI) on the IdentityRegistry.
 *      Because msg.sender = agent's wallet, the contract auto-records the
 *      agent's wallet as the canonical agentWallet metadata key. The
 *      Registered event also marks the agent as the NFT owner.
 *   3. We persist the resulting agentId and tx hashes.
 */
export async function registerAgentOnchain(opts: {
  agentWalletPK: string        // agent's freshly generated wallet
  agentAddress: string         // matches agentWalletPK
  metadataURI: string
  onAgentFunded?: (txHash: string) => Promise<void> | void
  onRegisterTxSent?: (txHash: string) => Promise<void> | void
}): Promise<RegisterResult> {
  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    const registryPK = getRegistryWalletPK()
    const registryWallet = new ethers.Wallet(registryPK, provider)
    const agentWallet = new ethers.Wallet(opts.agentWalletPK, provider)

    // 1. Compute funding amount from current BSC gas price.
    const feeData = await provider.getFeeData()
    const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei')
    const fundAmount = gasPrice * REGISTER_GAS_LIMIT * FUND_SAFETY_MULTIPLIER
    // Registry wallet also pays for the funding tx itself (21000 gas).
    const registryReserve = gasPrice * 21_000n * FUND_SAFETY_MULTIPLIER
    const registryBal = await provider.getBalance(registryWallet.address)
    if (registryBal < fundAmount + registryReserve) {
      return {
        success: false,
        reason: `BUILD4 registry wallet is low on BNB (have ${ethers.formatEther(registryBal)} BNB, need ~${ethers.formatEther(fundAmount + registryReserve)}). Please contact support.`
      }
    }

    const fundTx = await registryWallet.sendTransaction({
      to: opts.agentAddress,
      value: fundAmount
    })
    if (opts.onAgentFunded) {
      try { await opts.onAgentFunded(fundTx.hash) } catch (e) { console.error('[ERC8004] onAgentFunded hook:', e) }
    }
    await fundTx.wait()

    // 2. Agent self-registers.
    const registry = new ethers.Contract(ERC8004_REGISTRY, ERC8004_ABI, agentWallet)
    const tx = await registry['register(string)'](opts.metadataURI)
    if (opts.onRegisterTxSent) {
      try { await opts.onRegisterTxSent(tx.hash) } catch (e) { console.error('[ERC8004] onRegisterTxSent hook:', e) }
    }

    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) {
      return { success: false, reason: 'ERC-8004 register tx reverted', fundTxHash: fundTx.hash }
    }

    // Parse Registered event for agentId.
    let agentId: string | undefined
    for (const log of receipt.logs) {
      try {
        const parsed = registry.interface.parseLog({ topics: log.topics as string[], data: log.data })
        if (parsed?.name === 'Registered') {
          agentId = parsed.args.agentId.toString()
          break
        }
      } catch {}
    }

    return { success: true, agentId, txHash: tx.hash, fundTxHash: fundTx.hash }
  } catch (err: any) {
    console.error('[ERC8004] register failed:', err.message)
    return { success: false, reason: err.shortMessage ?? err.message }
  }
}

export function erc8004ScanUrl(agentId: string): string {
  return `https://bscscan.com/token/${ERC8004_REGISTRY}?a=${agentId}`
}

export function erc8004TxUrl(txHash: string): string {
  return `https://bscscan.com/tx/${txHash}`
}

import { ethers } from 'ethers'

/**
 * ERC-8004 Trustless AI Agents — Identity Registry integration.
 *
 * Every BUILD4 agent is registered on-chain in the official ERC-8004
 * IdentityRegistry on BNB Smart Chain. No protocol fee — only BSC gas
 * (~0.0003 BNB ≈ $0.10). This is mandatory for every agent so they show
 * up as ERC-8004-verified on agent scanners and registries.
 *
 * Source: https://github.com/erc-8004/erc-8004-contracts
 * BSC Mainnet: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 */

const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'

export const ERC8004_REGISTRY = (
  process.env.ERC8004_REGISTRY ?? '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
).trim()

// Tiny BNB amount funded into the agent's wallet so it can self-register
// on-chain. Anything left over stays in the agent wallet for first trades.
export const AGENT_GAS_FUND_BNB = '0.001'

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
 * Flow:
 *   1. User's main wallet sends a tiny BNB amount to the agent's fresh wallet
 *      (so it can pay gas).
 *   2. Agent's wallet self-calls register(agentURI) on the IdentityRegistry.
 *      Because msg.sender = agent's wallet, the contract auto-records the
 *      agent's wallet as the canonical agentWallet metadata key. The
 *      Registered event also marks the agent as the NFT owner.
 *   3. We persist the resulting agentId and tx hashes.
 */
export async function registerAgentOnchain(opts: {
  userWalletPK: string         // user's main wallet (pays gas funding)
  agentWalletPK: string        // agent's freshly generated wallet
  agentAddress: string         // matches agentWalletPK
  metadataURI: string
  onAgentFunded?: (txHash: string) => Promise<void> | void
  onRegisterTxSent?: (txHash: string) => Promise<void> | void
}): Promise<RegisterResult> {
  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    const userWallet = new ethers.Wallet(opts.userWalletPK, provider)
    const agentWallet = new ethers.Wallet(opts.agentWalletPK, provider)

    // 1. Fund the agent wallet for gas.
    const fundAmount = ethers.parseEther(AGENT_GAS_FUND_BNB)
    const userBal = await provider.getBalance(userWallet.address)
    if (userBal < fundAmount + ethers.parseEther('0.0005')) {
      return {
        success: false,
        reason: `Insufficient BNB for gas funding. Need ~${AGENT_GAS_FUND_BNB} BNB, have ${ethers.formatEther(userBal)} BNB.`
      }
    }

    const fundTx = await userWallet.sendTransaction({
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

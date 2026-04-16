import { ethers } from 'ethers'
import { AgentIdentity, encodeIdentityPayload } from './agentIdentity'

const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'
const REGISTRY_PK = process.env.REGISTRY_WALLET_PK ?? process.env.ASTER_AGENT_PRIVATE_KEY

export interface RegistrationResult {
  success: boolean
  txHash?: string
  chain: string
  registered: boolean
  reason?: string
}

export async function registerAgentOnChain(
  identity: AgentIdentity
): Promise<RegistrationResult> {
  if (!REGISTRY_PK) {
    return {
      success: false,
      chain: 'BSC',
      registered: false,
      reason: 'Registry wallet not configured (REGISTRY_WALLET_PK missing)'
    }
  }

  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    const registryWallet = new ethers.Wallet(REGISTRY_PK, provider)

    const balance = await provider.getBalance(registryWallet.address)
    if (balance < ethers.parseEther('0.0005')) {
      return {
        success: false,
        chain: 'BSC',
        registered: false,
        reason: `Registry wallet ${registryWallet.address} needs BNB for gas`
      }
    }

    const data = encodeIdentityPayload(identity)

    const tx = await registryWallet.sendTransaction({
      to: identity.agent,
      value: 0,
      data
    })

    const receipt = await tx.wait()

    return {
      success: true,
      txHash: receipt?.hash ?? tx.hash,
      chain: 'BSC',
      registered: true
    }
  } catch (err: any) {
    console.error('[Registry] On-chain registration failed:', err.message)
    return {
      success: false,
      chain: 'BSC',
      registered: false,
      reason: err.message
    }
  }
}

export function bscscanTxUrl(txHash: string): string {
  return `https://bscscan.com/tx/${txHash}`
}

export function bscscanAddressUrl(address: string): string {
  return `https://bscscan.com/address/${address}`
}

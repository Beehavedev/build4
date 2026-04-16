import { ethers } from 'ethers'

/**
 * BAP-578 Non-Fungible Agent Standard integration on BSC.
 *
 * Mints a real on-chain NFA NFT for each agent so it shows up as
 * verified on NFAScan, the official BAP-578 explorer.
 *
 * Contract: https://bscscan.com/address/0xd7deb29ddbb13607375ce50405a574ac2f7d978d
 * Cost: 0.01 BNB per agent (paid from user's main wallet at mint time).
 */

const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'
export const BAP578_CONTRACT = '0xd7deb29ddbb13607375ce50405a574ac2f7d978d'
export const MINT_FEE_BNB = '0.01'

const BAP578_ABI = [
  'function createAgent(address to, address logicAddress, string metadataURI, (string persona, string experience, string voiceHash, string animationURI, string vaultURI, bytes32 vaultHash) extendedMetadata) payable returns (uint256)',
  'function MINT_FEE() view returns (uint256)',
  'function getFreeMints(address) view returns (uint256)',
  'function tokenURI(uint256) view returns (string)',
  'function ownerOf(uint256) view returns (address)',
  'event AgentCreated(uint256 indexed tokenId, address indexed owner, address logicAddress, string metadataURI)'
]

export interface MintResult {
  success: boolean
  tokenId?: string
  txHash?: string
  reason?: string
}

export async function getBap578MintFee(): Promise<bigint> {
  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    const c = new ethers.Contract(BAP578_CONTRACT, BAP578_ABI, provider)
    return await c.MINT_FEE()
  } catch {
    return ethers.parseEther(MINT_FEE_BNB)
  }
}

export async function getBnbBalance(address: string): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(BSC_RPC)
  return provider.getBalance(address)
}

/**
 * Mint a real BAP-578 NFA agent NFT. Must be called with the wallet
 * private key that will pay the fee — typically the user's main wallet.
 *
 * @param userWalletPK — user's main wallet private key (decrypted)
 * @param agentName    — agent's name (also persona)
 * @param agentAddress — agent's own EOA wallet address (used as logicAddress)
 * @param metadataURI  — public JSON URL the explorer fetches
 */
export async function mintBap578Agent(opts: {
  userWalletPK: string
  agentName: string
  agentAddress: string
  metadataURI: string
  metadataHash: string // bytes32 keccak256 of the canonical metadata JSON
  onTxSent?: (txHash: string) => Promise<void> | void
}): Promise<MintResult> {
  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    const wallet = new ethers.Wallet(opts.userWalletPK, provider)

    const fee = await getBap578MintFee()
    const balance = await provider.getBalance(wallet.address)
    const needed = fee + ethers.parseEther('0.001') // fee + small gas buffer
    if (balance < needed) {
      return {
        success: false,
        reason: `Insufficient BNB. Need ${ethers.formatEther(needed)} BNB, have ${ethers.formatEther(balance)} BNB.`
      }
    }

    const c = new ethers.Contract(BAP578_CONTRACT, BAP578_ABI, wallet)

    const extendedMetadata = {
      persona: `BUILD4 agent "${opts.agentName}"`,
      experience: 'Autonomous Aster DEX perp trader with risk-managed strategy execution',
      voiceHash: '',
      animationURI: '',
      vaultURI: opts.metadataURI,
      vaultHash: opts.metadataHash
    }

    const tx = await c.createAgent(
      wallet.address,           // mint NFT TO the user (owner)
      opts.agentAddress,        // logicAddress = the agent's own wallet
      opts.metadataURI,
      extendedMetadata,
      { value: fee }
    )

    // Persist tx hash IMMEDIATELY so a wait()-failure doesn't cause a double-spend on retry.
    if (opts.onTxSent) {
      try { await opts.onTxSent(tx.hash) } catch (e) { console.error('[BAP578] onTxSent hook failed:', e) }
    }

    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) {
      return { success: false, reason: 'Transaction reverted' }
    }

    // Parse AgentCreated event for tokenId
    let tokenId: string | undefined
    for (const log of receipt.logs) {
      try {
        const parsed = c.interface.parseLog({ topics: log.topics as string[], data: log.data })
        if (parsed?.name === 'AgentCreated') {
          tokenId = parsed.args.tokenId.toString()
          break
        }
      } catch {}
    }

    return { success: true, tokenId, txHash: tx.hash }
  } catch (err: any) {
    console.error('[BAP578] mint failed:', err.message)
    return { success: false, reason: err.shortMessage ?? err.message }
  }
}

export function nfaScanUrl(address: string): string {
  return `https://nfascan.net/agent/${address}`
}

export function bap578TokenUrl(tokenId: string): string {
  return `https://bscscan.com/token/${BAP578_CONTRACT}?a=${tokenId}`
}

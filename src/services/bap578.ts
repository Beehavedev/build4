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

// BAP-578 source (BAP578.sol L146-148):
//   require(logicAddress == address(0) || logicAddress.code.length > 0,
//           "Invalid logic address");
// We don't need a custom logic template — pass address(0). Operators who
// later want to wire a custom logic contract can override via env var.
export const BAP578_LOGIC_TEMPLATE = (
  process.env.BAP578_LOGIC_TEMPLATE ?? ethers.ZeroAddress
).trim()

// Protocol mint fee (paid to the BAP-578 team treasury 0xF029…F08d)
export const PROTOCOL_FEE_BNB = '0.01'
// BUILD4 service fee (paid to our revenue wallet)
export const BUILD4_FEE_BNB = '0.005'
// Total amount the user pays for one verified agent
export const TOTAL_USER_FEE_BNB = '0.015'

export const BUILD4_FEE_WALLET = (
  process.env.BUILD4_FEE_WALLET ?? '0x5Ff57464152c9285A8526a0665d996dA66e2def1'
).toLowerCase()

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

    // Validate logicAddress matches BAP-578's on-chain check:
    // accept address(0) OR a contract with code (no EOAs).
    if (BAP578_LOGIC_TEMPLATE !== ethers.ZeroAddress) {
      const code = await provider.getCode(BAP578_LOGIC_TEMPLATE)
      if (!code || code === '0x') {
        return {
          success: false,
          reason: `BAP578_LOGIC_TEMPLATE (${BAP578_LOGIC_TEMPLATE}) is not a deployed contract on BSC. Use 0x0 (default) or a real logic contract address.`
        }
      }
    }

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
      BAP578_LOGIC_TEMPLATE,    // logicAddress = canonical BAP-578 logic contract
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

    // BUILD4 service fee — separate transfer to our revenue wallet.
    // We do this AFTER the protocol mint succeeds, so a failed transfer can never
    // leave the user paying for verification they didn't get.
    try {
      const feeAmount = ethers.parseEther(BUILD4_FEE_BNB)
      const feeTx = await wallet.sendTransaction({ to: BUILD4_FEE_WALLET, value: feeAmount })
      await feeTx.wait()
      console.log('[BAP578] BUILD4 service fee collected:', feeTx.hash)
    } catch (e: any) {
      // Don't fail the whole mint — agent is already verified on-chain. Just log.
      console.error('[BAP578] BUILD4 fee transfer failed (agent still verified):', e.message)
    }

    return { success: true, tokenId, txHash: tx.hash }
  } catch (err: any) {
    console.error('[BAP578] mint failed:', err.message)
    return { success: false, reason: err.shortMessage ?? err.message }
  }
}

export function bscscanTxUrl(txHash: string): string {
  return `https://bscscan.com/tx/${txHash}`
}

export function bscscanAddressUrl(address: string): string {
  return `https://bscscan.com/address/${address}`
}

/**
 * Recover a BAP-578 tokenId from chain — first via a known mint-tx receipt,
 * then by scanning AgentCreated logs filtered by the owner address (the
 * user's main wallet) and matching the agent's wallet as logicAddress.
 */
export async function recoverBap578TokenId(opts: {
  ownerAddress: string       // user's main wallet (mint NFT recipient)
  agentAddress: string       // agent's wallet (logicAddress in mint call)
  txHash?: string | null
}): Promise<string | null> {
  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    // The BAP-578 contract is ERC-721 — the universal Transfer event
    // (from = ZeroAddress on mint) gives us tokenId reliably even though
    // the contract's custom AgentCreated event is shaped differently from
    // the ABI we have. topic[3] of Transfer is the indexed tokenId.
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const ZERO_TOPIC = ethers.zeroPadValue('0x0000000000000000000000000000000000000000', 32)

    if (opts.txHash) {
      const receipt = await provider.getTransactionReceipt(opts.txHash)
      if (receipt && receipt.status === 1) {
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== BAP578_CONTRACT.toLowerCase()) continue
          if (log.topics[0] === TRANSFER_TOPIC && log.topics[1] === ZERO_TOPIC && log.topics[3]) {
            return BigInt(log.topics[3]).toString()
          }
        }
      }
    }

    // Etherscan v2 historical lookup: find Transfer(0x0, ownerAddress, tokenId)
    // logs from the BAP-578 contract — that's a mint to this user.
    const apiKey = process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY
    if (apiKey) {
      const ownerTopic = ethers.zeroPadValue(opts.ownerAddress.toLowerCase(), 32)
      const url = `https://api.etherscan.io/v2/api?chainid=56&module=logs&action=getLogs` +
        `&address=${BAP578_CONTRACT}&topic0=${TRANSFER_TOPIC}&topic1=${ZERO_TOPIC}&topic2=${ownerTopic}` +
        `&topic0_1_opr=and&topic1_2_opr=and&fromBlock=0&toBlock=latest&apikey=${apiKey}`
      try {
        const res = await fetch(url)
        const data: any = await res.json()
        if (data.status === '1' && Array.isArray(data.result) && data.result.length > 0) {
          // Take the most recent mint to this owner.
          const last = data.result[data.result.length - 1]
          if (last.topics?.[3]) return BigInt(last.topics[3]).toString()
        }
      } catch (e: any) {
        console.error('[BAP578] Etherscan v2 lookup failed:', e.message)
      }
    }
    return null
  } catch (err: any) {
    console.error('[BAP578] recoverTokenId failed:', err.message)
    return null
  }
}

function slugifyAgentName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent'
}

/**
 * NFAScan public agent page. Format is `{slug}:{tokenId}` where slug is the
 * kebab-case agent name (e.g. "Smith" → "smith:55867").
 */
export function nfaScanUrl(name: string, tokenId: string | number | bigint): string {
  return `https://nfascan.net/agent/${slugifyAgentName(name)}:${tokenId}`
}

export function bap578TokenUrl(tokenId: string): string {
  return `https://bscscan.com/token/${BAP578_CONTRACT}?a=${tokenId}`
}

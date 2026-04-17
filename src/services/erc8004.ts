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

// Single-flight mutex on the shared registry wallet so concurrent
// registrations never race on the same nonce. The funding tx is the
// only operation we need to serialize (the agent self-register tx uses
// a per-agent fresh wallet with its own nonce space).
let registryFundQueue: Promise<unknown> = Promise.resolve()
function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = registryFundQueue.then(fn, fn)
  // Keep chain alive even if a step throws so subsequent calls still run.
  registryFundQueue = next.catch(() => {})
  return next
}

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

    // 1. Fund the agent wallet from the shared registry wallet.
    //    Serialized through withRegistryLock to avoid nonce races when many
    //    users register concurrently. We also wait for ≥1 confirmation
    //    inside the lock so the next call sees a settled nonce.
    type FundOk = { fundTxHash: string }
    type FundErr = { error: string }
    const fundResult: FundOk | FundErr = await withRegistryLock(async () => {
      const feeData = await provider.getFeeData()
      const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei')
      const fundAmount = gasPrice * REGISTER_GAS_LIMIT * FUND_SAFETY_MULTIPLIER
      // Registry wallet also pays for the funding tx itself (21000 gas).
      const registryReserve = gasPrice * 21_000n * FUND_SAFETY_MULTIPLIER
      const registryBal = await provider.getBalance(registryWallet.address)
      if (registryBal < fundAmount + registryReserve) {
        return { error: `BUILD4 registry wallet is low on BNB (have ${ethers.formatEther(registryBal)} BNB, need ~${ethers.formatEther(fundAmount + registryReserve)}). Please contact support.` }
      }
      const tx = await registryWallet.sendTransaction({
        to: opts.agentAddress,
        value: fundAmount
      })
      await tx.wait()
      return { fundTxHash: tx.hash }
    })
    if ('error' in fundResult) {
      return { success: false, reason: fundResult.error }
    }
    if (opts.onAgentFunded) {
      try { await opts.onAgentFunded(fundResult.fundTxHash) } catch (e) { console.error('[ERC8004] onAgentFunded hook:', e) }
    }
    const fundTx = { hash: fundResult.fundTxHash }

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

/**
 * Recover the ERC-8004 agentId for an agent from chain — either from a known
 * register-tx receipt or by scanning historical Registered logs filtered by
 * the agent's own wallet address (which is the indexed `owner` field, since
 * agents self-register). Returns null if nothing can be found on chain.
 */
export async function recoverErc8004AgentId(opts: {
  agentAddress: string
  txHash?: string | null
}): Promise<string | null> {
  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    const iface = new ethers.Interface(ERC8004_ABI)

    if (opts.txHash) {
      const receipt = await provider.getTransactionReceipt(opts.txHash)
      if (receipt && receipt.status === 1) {
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== ERC8004_REGISTRY.toLowerCase()) continue
          try {
            const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data })
            if (parsed?.name === 'Registered') return parsed.args.agentId.toString()
          } catch {}
        }
      }
    }

    // Fallback: query Etherscan v2 API for historical Registered logs
    // filtered by the indexed `owner` (= agent self-register tx sender).
    // Etherscan handles unbounded block ranges in a single call, unlike
    // public BSC RPCs which cap at ~10k blocks.
    const apiKey = process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY
    if (apiKey) {
      const registeredTopic = iface.getEvent('Registered')!.topicHash
      const ownerTopic = ethers.zeroPadValue(opts.agentAddress.toLowerCase(), 32)
      const url = `https://api.etherscan.io/v2/api?chainid=56&module=logs&action=getLogs` +
        `&address=${ERC8004_REGISTRY}&topic0=${registeredTopic}&topic2=${ownerTopic}` +
        `&topic0_2_opr=and&fromBlock=0&toBlock=latest&apikey=${apiKey}`
      try {
        const res = await fetch(url)
        const data: any = await res.json()
        if (data.status === '1' && Array.isArray(data.result) && data.result.length > 0) {
          // topics[1] is the indexed agentId
          const agentIdHex = data.result[0].topics[1]
          if (agentIdHex) return BigInt(agentIdHex).toString()
        }
      } catch (e: any) {
        console.error('[ERC8004] Etherscan v2 lookup failed:', e.message)
      }
    }
    return null
  } catch (err: any) {
    console.error('[ERC8004] recoverAgentId failed:', err.message)
    return null
  }
}

export function erc8004ScanUrl(agentId: string): string {
  return `https://bscscan.com/token/${ERC8004_REGISTRY}?a=${agentId}`
}

export function erc8004RegistryScanUrl(agentId: string): string {
  return `https://8004scan.io/agents/bsc/${agentId}`
}

export function erc8004TxUrl(txHash: string): string {
  return `https://bscscan.com/tx/${txHash}`
}

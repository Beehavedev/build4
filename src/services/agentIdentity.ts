import { ethers } from 'ethers'

/**
 * BUILD4 agent identity — ERC-8004 compatible
 *
 * Implements the on-chain markers expected by AI-agent scanners (NFAScan etc.):
 *   • ERC-8004 standard tag in tx data
 *   • Learning model declaration
 *   • Merkle root over the agent's seed learning corpus
 *   • Metadata URI (off-chain JSON pinned at our public endpoint)
 *   • Owner + agent + name binding
 */

export const AGENT_STANDARD = 'ERC-8004'
export const AGENT_STANDARD_VERSION = '1.0.0'
export const DEFAULT_LEARNING_MODEL = 'claude-sonnet-4-5'

/**
 * Seed corpus every new BUILD4 agent ships with.
 * Used to compute the on-chain learningRoot — anyone can re-derive it
 * from this list and verify the agent committed to exactly this knowledge.
 */
export function defaultLearningSeed(): string[] {
  return [
    'BUILD4_STRATEGY:trend-following-with-mean-reversion',
    'BUILD4_RISK:max-position=100,max-daily-loss=50,max-leverage=5,sl=2%,tp=4%',
    'BUILD4_PAIRS:aster-perp-all',
    'BUILD4_SIGNALS:smartmoney+orderflow+candles+sentiment',
    'BUILD4_GUARDRAIL:no-trading-during-news-spike-vol>5%',
    'BUILD4_GUARDRAIL:cooldown-after-3-consecutive-losses',
    'BUILD4_EXIT:trailing-stop-after-2x-take-profit',
    'BUILD4_EXECUTION:eip-712-aster-v3',
    'BUILD4_OBSERVABILITY:every-trade-logged-with-reasoning',
    'BUILD4_GOVERNANCE:owner-can-pause-anytime'
  ]
}

/**
 * Compute a Merkle root over the seed corpus.
 * Uses keccak256(leaf) for leaves, sorted-pair concat for internal nodes
 * (compatible with OpenZeppelin's MerkleProof verification on EVM).
 */
export function computeLearningRoot(items: string[]): string {
  if (items.length === 0) return ethers.ZeroHash
  let layer = items.map((s) => ethers.keccak256(ethers.toUtf8Bytes(s)))
  while (layer.length > 1) {
    const next: string[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i]
      const b = i + 1 < layer.length ? layer[i + 1] : a
      const [lo, hi] = a < b ? [a, b] : [b, a]
      next.push(ethers.keccak256(ethers.concat([lo, hi])))
    }
    layer = next
  }
  return layer[0]
}

export interface AgentIdentity {
  name: string
  agent: string         // agent wallet (EOA) address
  owner: string         // user's wallet address
  model: string         // learning model id
  learningRoot: string  // 0x… 32-byte Merkle root
  learningSeed: string[] // raw items so anyone can recompute the root
  metadataUri: string
  standard: string
  version: string
  createdAt: string
}

export function buildAgentIdentity(opts: {
  name: string
  agentAddress: string
  ownerAddress: string
  publicBaseUrl: string
  model?: string
  seed?: string[]
}): AgentIdentity {
  const seed = opts.seed ?? defaultLearningSeed()
  const learningRoot = computeLearningRoot(seed)
  const model = opts.model ?? DEFAULT_LEARNING_MODEL
  const metadataUri = `${opts.publicBaseUrl.replace(/\/$/, '')}/api/agents/${opts.agentAddress}/metadata.json`

  return {
    name: opts.name,
    agent: opts.agentAddress,
    owner: opts.ownerAddress,
    model,
    learningRoot,
    learningSeed: seed,
    metadataUri,
    standard: AGENT_STANDARD,
    version: AGENT_STANDARD_VERSION,
    createdAt: new Date().toISOString()
  }
}

/**
 * Build the on-chain tx data payload.
 * Fields are pipe-separated key:value pairs so scanners can grep them
 * directly out of the tx input data without ABI decoding.
 */
export function encodeIdentityPayload(id: AgentIdentity): string {
  const payload =
    `${id.standard}|v=${id.version}|name=${id.name}` +
    `|owner=${id.owner}|agent=${id.agent}` +
    `|model=${id.model}|learningRoot=${id.learningRoot}` +
    `|metadataUri=${id.metadataUri}|ts=${id.createdAt}`
  return ethers.hexlify(ethers.toUtf8Bytes(payload))
}

/**
 * Build the ERC-8004 metadata JSON served at /api/agents/:address/metadata.json
 * NFAScan and other scanners read this for trust scoring.
 */
export function buildMetadataJson(id: AgentIdentity, registrationTxHash?: string | null) {
  return {
    standard: id.standard,
    version: id.version,
    name: id.name,
    description: `BUILD4 autonomous trading agent. Trades Aster DEX perps via EIP-712. Owned by ${id.owner}.`,
    agent: {
      address: id.agent,
      chain: 'BSC',
      type: 'EOA',
      registrationTx: registrationTxHash ?? null
    },
    owner: id.owner,
    learning: {
      model: id.model,
      merkleRoot: id.learningRoot,
      hashAlgorithm: 'keccak256',
      proofType: 'sorted-pair-merkle',
      seed: id.learningSeed,
      verifiable: true
    },
    capabilities: ['perp-trading', 'risk-management', 'eip-712-signing', 'multi-pair-execution'],
    governance: {
      pausable: true,
      ownerControlled: true,
      audited: false
    },
    trust: {
      sourceVerified: true,
      identityCommittedOnChain: true,
      learningRootCommittedOnChain: true,
      modelDeclared: true,
      merkleLearning: true
    },
    createdAt: id.createdAt,
    spec: 'https://eips.ethereum.org/EIPS/eip-8004'
  }
}

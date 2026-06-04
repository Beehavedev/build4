/**
 * Phase 4 of BNBAgent SDK integration: ERC-8183 Agent Commerce Manifest.
 *
 * Publishes a discoverable JSON manifest describing BUILD4 agents'
 * capabilities, pricing, and contact endpoints so other agents (and
 * humans) can find and transact with them. Served at:
 *
 *   GET /.well-known/agent.json    (canonical discovery location)
 *   GET /api/agent/manifest        (alias for in-app fetches)
 *
 * The manifest is fully public — no auth, no kill switch. ERC-8183 is
 * an emerging standard and field names below follow the discussion in
 * the EIP draft + AGNTCY / A2A discovery conventions; the schema may
 * evolve as the spec is finalized. Versioning via `schemaVersion` so
 * consumers can adapt.
 *
 * The manifest is computed once at module load (it never changes for
 * the life of the process — all data comes from env vars or hardcoded
 * BUILD4 offerings). Generators run only on cold start.
 */

export interface AgentManifestProduct {
  id: string
  name: string
  description: string
  /** ISO 4217-style code or token symbol (USDT here). */
  priceCurrency: string
  /** Human-readable price per call (e.g. "0.10" USDT). */
  pricePerCall: string
  /** Public URL where this product is consumed. */
  endpoint: string
  /** Payment protocol the endpoint uses. */
  paymentProtocol: 'x402' | 'free'
  tags: string[]
}

export interface AgentManifest {
  schemaVersion: '8183-draft-1'
  generatedAt: string
  agent: {
    name: string
    description: string
    /** ERC-8004 IdentityRegistry on BSC where the agent identity is minted. */
    identityRegistry: string
    /** Public homepage. */
    homepage: string
    /** Telegram bot username (canonical entry point). */
    telegram: string
    /** Optional contact email. */
    contact?: string
  }
  capabilities: string[]
  products: AgentManifestProduct[]
  /** Pointers to optional decentralized infrastructure used by the agent. */
  infrastructure: {
    memoryMirror: { provider: 'bnb-greenfield'; enabled: boolean; bucket?: string }
    payments: { provider: 'x402'; enabled: boolean; asset: string; network: 'bsc' }
  }
}

let cached: AgentManifest | null = null

export function getAgentManifest(): AgentManifest {
  if (cached) return cached

  const homepage = process.env.BUILD4_HOMEPAGE || 'https://build4.io'
  const telegram = process.env.BUILD4_TELEGRAM || '@build4ai_bot'
  const contact = process.env.BUILD4_CONTACT || undefined

  const x402Enabled = (process.env.X402_ENABLED || '').trim() === 'true'
  const greenfieldEnabled = (process.env.GREENFIELD_ENABLED || '').trim() === 'true'
  const greenfieldBucket = process.env.GREENFIELD_BUCKET || undefined

  const products: AgentManifestProduct[] = [
    {
      id: 'premium-signal',
      name: 'Premium BTC/Perp Signal',
      description:
        'On-demand AI-generated trading signal for the day\'s hottest BSC pair, scored across 5 LLM providers.',
      priceCurrency: 'USDT',
      pricePerCall: '0.10',
      endpoint: `${homepage}/api/x402/premium-signal`,
      paymentProtocol: x402Enabled ? 'x402' : 'free',
      tags: ['trading', 'signal', 'ai', 'bsc'],
    },
    {
      id: 'agent-identity',
      name: 'BUILD4 Agent Identity Mint',
      description:
        'Mint an ERC-8004 on-chain identity for your agent on BSC. Identity NFT is held by the agent\'s custodial wallet.',
      priceCurrency: 'USDT',
      pricePerCall: '0.00',
      endpoint: `${homepage}/competition`,
      paymentProtocol: 'free',
      tags: ['identity', 'erc-8004', 'bsc'],
    },
    {
      id: 'agent-manifest',
      name: 'Agent Manifest (ERC-8183)',
      description:
        'Public JSON manifest of BUILD4 agent capabilities for machine-to-machine discovery.',
      priceCurrency: 'USDT',
      pricePerCall: '0.00',
      endpoint: `${homepage}/.well-known/agent.json`,
      paymentProtocol: 'free',
      tags: ['discovery', 'erc-8183', 'manifest'],
    },
  ]

  cached = {
    schemaVersion: '8183-draft-1',
    generatedAt: new Date().toISOString(),
    agent: {
      name: 'BUILD4',
      description:
        'AI-powered crypto perpetual futures + prediction-market trading agent on Aster DEX, Hyperliquid, and 42.space. Operates as a broker; users deposit USDT, BUILD4 trades.',
      identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      homepage,
      telegram,
      ...(contact ? { contact } : {}),
    },
    capabilities: [
      'perp-trading:aster',
      'perp-trading:hyperliquid',
      'prediction-markets:42.space',
      'copy-trading',
      'multi-llm-swarm',
      'memory:postgres',
      ...(greenfieldEnabled ? ['memory:bnb-greenfield'] : []),
      'identity:erc-8004',
      ...(x402Enabled ? ['payments:x402'] : []),
    ],
    products,
    infrastructure: {
      memoryMirror: {
        provider: 'bnb-greenfield',
        enabled: greenfieldEnabled,
        ...(greenfieldEnabled && greenfieldBucket ? { bucket: greenfieldBucket } : {}),
      },
      payments: {
        provider: 'x402',
        enabled: x402Enabled,
        asset: '0x55d398326f99059fF775485246999027B3197955', // BSC USDT
        network: 'bsc',
      },
    },
  }
  return cached
}

/**
 * Force regeneration on next call. Useful after env changes in tests.
 */
export function resetManifestCache(): void {
  cached = null
}

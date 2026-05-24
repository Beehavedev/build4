// ─────────────────────────────────────────────────────────────────────────
// Topaz DEX configuration — env-driven addresses + Goldsky subgraph URLs.
//
// Phase 1 (master-wallet only) reads every contract address from env so
// we can ship the integration before the user has pasted the exact
// values from github.com/topazdex/agent-skill. Trading entry points in
// src/services/topazTrading.ts fail-closed (throw with a specific
// `topaz_config_missing: <FIELD>` message) when a required address is
// missing — the agent then logs a SKIP with that reason in the brain
// feed instead of silently doing nothing.
//
// All addresses are validated as 0x-prefixed 20-byte EVM addresses at
// module load; an invalid value throws at boot rather than at first
// trade, surfacing the misconfig immediately.
// ─────────────────────────────────────────────────────────────────────────

import { ethers } from 'ethers'

// ─── BSC mainnet canonical addresses (from topazdex/agent-skill SKILL.md) ─
// These are baked in so the integration works out of the box. Env vars
// still take precedence — set TOPAZ_<NAME> to override any of these.
const BSC_DEFAULTS = {
  TOPAZ_ROUTER:        '0x1E98c8226e7d452e1888e3d3d2F929346321c6c3',
  TOPAZ_NPM:           '0xf8c30c3C362941C23025f2eA30B066A73C982f63',
  TOPAZ_VOTER:         '0x2F80F810a114223AC69E34E84E735CaD515dAD67',
  TOPAZ_MIXED_QUOTER:  '0x47c3570b90e7234FE695Ad5F1bE69E21fe1a9ee2',
  TOPAZ_TOKEN:         '0xdf002282C1474C9592780618Adda7EaA99998Abd',
  TOPAZ_USDT_TOKEN:    '0x55d398326f99059fF775485246999027B3197955',
  TOPAZ_USDC_TOKEN:    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  TOPAZ_WBNB:          '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
} as const
const SUBGRAPH_DEFAULTS = {
  TOPAZ_SUBGRAPH_V2_URL: 'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-v2/v0.0.3/gn',
  TOPAZ_SUBGRAPH_V3_URL: 'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-v3/v0.0.1/gn',
} as const

export interface TopazConfig {
  enabled: boolean
  // CSV of Agent.id values explicitly allow-listed for Topaz dispatch.
  // Empty = no agents (Phase-1 master-wallet-only requires explicit opt-in
  // even when TOPAZ_ENABLED=true).
  agentAllowlist: ReadonlySet<string>
  // Wallet.id of the dedicated Topaz master/treasury wallet. Required
  // in Phase 1 — every Topaz trade pulls keys from this single row
  // regardless of which agent triggered it.
  masterWalletId: string | null
  // BSC mainnet contract addresses. Each is optional at boot (so the
  // module loads on a dev machine without env), but trading functions
  // assert their presence at call time via requireAddress().
  router: string | null
  npm: string | null
  voter: string | null
  mixedQuoter: string | null
  // Optional — TOPAZ emissions token address. Used for read-only price
  // lookups when scoring claim value.
  topazToken: string | null
  // Goldsky subgraph endpoints (v2 + v3). Optional — when missing,
  // getTopGaugesByApr() returns an empty list and the agent decides
  // from the on-chain pool stats alone.
  subgraphV2Url: string | null
  subgraphV3Url: string | null
  // Phase-1 per-trade cap, USD. Independent of Agent.maxPositionSize so
  // we can clamp Topaz exposure separately while the venue proves out.
  maxTradeUsdt: number
  // Default slippage in bps (50 = 0.5%) — used when caller does not
  // specify a per-trade override.
  defaultSlippageBps: number
  // Hard upper-bound slippage cap in bps. Server-side clamp: callers
  // can NEVER specify a slippage greater than this (500 bps = 5%
  // default). This is the safety bound the reviewer flagged: a hostile
  // / buggy upstream cannot force adverse fills by raising tolerance.
  maxSlippageBps: number
  // Trade deadline (seconds from now). 20-min default matches Uniswap /
  // Velodrome convention. Never pass 0 — Router reverts.
  defaultDeadlineSec: number
  // Stablecoin addresses used to attribute USDT value to TopazPosition
  // close events. When one leg of a closing LP matches one of these,
  // we record the realized amount in USDT terms; otherwise we record
  // raw token amounts and leave exitValueUsdt NULL (no fake pricing).
  usdtToken: string | null
  usdcToken: string | null
}

function pickAddress(envName: keyof typeof BSC_DEFAULTS | string): string | null {
  const raw = (process.env[envName] ?? '').trim()
  if (raw) {
    if (!ethers.isAddress(raw)) {
      throw new Error(
        `[topaz] env ${envName}=${raw} is not a valid EVM address. ` +
          `Set it to the BSC mainnet contract address from the topazdex/agent-skill repo, or unset it entirely.`,
      )
    }
    return ethers.getAddress(raw)
  }
  const fallback = (BSC_DEFAULTS as Record<string, string>)[envName as string]
  return fallback ? ethers.getAddress(fallback) : null
}

function pickUrl(envName: keyof typeof SUBGRAPH_DEFAULTS): string | null {
  const raw = (process.env[envName] ?? '').trim()
  if (raw) return raw
  return SUBGRAPH_DEFAULTS[envName] ?? null
}

function parseCsvSet(envName: string): ReadonlySet<string> {
  const raw = (process.env[envName] ?? '').trim()
  if (!raw) return new Set()
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

function parsePositiveNumber(envName: string, defaultValue: number): number {
  const raw = (process.env[envName] ?? '').trim()
  if (!raw) return defaultValue
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[topaz] env ${envName}=${raw} must be a positive number`)
  }
  return n
}

let cached: TopazConfig | null = null

export function getTopazConfig(): TopazConfig {
  if (cached) return cached
  cached = Object.freeze({
    enabled: (process.env.TOPAZ_ENABLED ?? '').trim().toLowerCase() === 'true',
    agentAllowlist: parseCsvSet('TOPAZ_AGENT_ALLOWLIST'),
    masterWalletId: (process.env.TOPAZ_MASTER_WALLET_ID ?? '').trim() || null,
    router:        pickAddress('TOPAZ_ROUTER'),
    npm:           pickAddress('TOPAZ_NPM'),
    voter:         pickAddress('TOPAZ_VOTER'),
    mixedQuoter:   pickAddress('TOPAZ_MIXED_QUOTER'),
    topazToken:    pickAddress('TOPAZ_TOKEN'),
    subgraphV2Url: pickUrl('TOPAZ_SUBGRAPH_V2_URL'),
    subgraphV3Url: pickUrl('TOPAZ_SUBGRAPH_V3_URL'),
    maxTradeUsdt: parsePositiveNumber('TOPAZ_MAX_TRADE_USDT', 50),
    defaultSlippageBps: Math.max(
      10,
      Math.floor(parsePositiveNumber('TOPAZ_DEFAULT_SLIPPAGE_BPS', 50)),
    ),
    maxSlippageBps: Math.max(
      50,
      Math.min(2000, Math.floor(parsePositiveNumber('TOPAZ_MAX_SLIPPAGE_BPS', 500))),
    ),
    defaultDeadlineSec: Math.max(
      60,
      Math.floor(parsePositiveNumber('TOPAZ_DEFAULT_DEADLINE_SEC', 1200)),
    ),
    usdtToken: pickAddress('TOPAZ_USDT_TOKEN'),
    usdcToken: pickAddress('TOPAZ_USDC_TOKEN'),
  })
  return cached
}

/** Test-only hook for forcing a fresh config read after mutating env vars. */
export function __resetTopazConfigCache(): void {
  cached = null
}

/**
 * Assert an address field is configured. Throws with a fail-closed
 * `topaz_config_missing:<field>` message so callers (and the brain feed)
 * can render a precise reason.
 */
export function requireAddress(
  cfg: TopazConfig,
  field: 'router' | 'npm' | 'voter' | 'mixedQuoter' | 'topazToken',
): string {
  const v = cfg[field]
  if (!v) {
    throw new Error(`topaz_config_missing:${field} — set the TOPAZ_${field.toUpperCase()} env var to the BSC mainnet address from topazdex/agent-skill.`)
  }
  return v
}

export function isAgentAllowed(cfg: TopazConfig, agentId: string): boolean {
  if (!cfg.enabled) return false
  if (cfg.agentAllowlist.size === 0) return false
  return cfg.agentAllowlist.has(agentId)
}

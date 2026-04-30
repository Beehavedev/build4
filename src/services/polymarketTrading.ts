// =====================================================================
// Polymarket Phase 2.1 — gasless trading via the Builder Relayer Client.
//
// Architecture
// ─────────────
// The user's BUILD4 custodial wallet is a single secp256k1 keypair —
// the same EOA address that holds USDT on BSC also exists on Polygon.
// We DO NOT, however, fund or trade from that EOA directly. Instead, on
// first /setup the user's EOA acts as the *signing key* for a freshly
// deployed Gnosis Safe proxy (deployed gaslessly via Polymarket's
// relayer). All USDC.e and ERC-1155 outcome shares live in the Safe;
// the EOA only ever signs.
//
// signature_type
// ──────────────
// We use POLY_GNOSIS_SAFE (signature type 2). The CLOB order is signed
// by the EOA but its `funder` field references the Safe address; the
// CTF Exchange pulls collateral from the Safe at fill time. This is
// the same architecture polymarket.com uses for browser-wallet users.
//
// Why gasless
// ───────────
// On the EOA model the user needs MATIC for (a) the one-time USDC
// approve(), (b) any subsequent re-approval, (c) redeem() at market
// resolution. With the relayer client all three become Polymarket-paid
// gasless transactions, leaving USDC.e as the only asset the user must
// ever bring. Daily CLOB orders are off-chain EIP-712 signatures so
// they're free either way — but the on-chain bookkeeping was the bit
// requiring MATIC. That requirement is now eliminated.
//
// Builder attribution
// ───────────────────
// Two pieces of identity, unchanged from Phase 2:
//   1. POLY_BUILDER_CODE — bytes32 set on every order's `builder` field
//      (CLOB-side; this is what credits volume to BUILD4).
//   2. POLY_BUILDER_API_KEY/SECRET/PASSPHRASE — HMAC creds the
//      builder-signing-sdk uses to add `POLY_BUILDER_*` headers to BOTH
//      CLOB POSTs AND relayer POSTs (the relayer also enforces builder
//      auth on its endpoints — without these creds the relayer client
//      cannot deploy Safes or execute approvals on the user's behalf).
//
// Both are read lazily so the module loads without env vars being set
// (early dev deploys don't have these yet) and the file imports cleanly
// in tests.
// =====================================================================

import { ethers } from 'ethers'
import {
  ClobClient,
  Side,
  OrderType,
  SignatureType,
  type ApiKeyCreds,
} from '@polymarket/clob-client'
import { BuilderConfig } from '@polymarket/builder-signing-sdk'
import {
  RelayClient,
  RelayerTxType,
  type Transaction,
} from '@polymarket/builder-relayer-client'
import {
  createWalletClient,
  http as viemHttp,
  fallback as viemFallback,
  encodeFunctionData,
  maxUint256,
  zeroHash,
  type Hex,
  type Transport,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import { db } from '../db'
import { decryptPrivateKey, encryptPrivateKey } from './wallet'
import { polymarketConfig } from './polymarket'

const CLOB_HOST = 'https://clob.polymarket.com'
const POLYGON_CHAIN_ID = 137 as const

// We rotate across multiple public Polygon RPC endpoints because the
// official `polygon-rpc.com` aggressively rate-limits and frequently
// returns HTTP 401 for cloud egress IPs (Replit, Vercel, Fly, etc.) —
// which previously surfaced to users as a "401 Unauthorized" message
// in /wallet and as silent zeros in the mini-app's Polygon card.
//
// `POLYGON_RPC` env stays honored as the *first-priority* endpoint for
// users who have a paid endpoint configured (Alchemy, Infura, Ankr).
// The remaining endpoints fill in as fallbacks. ethers' FallbackProvider
// quorums across multiple providers; viem's fallback() picks a healthy
// transport per request and demotes failing ones automatically.
const POLYGON_RPC_ENV = (process.env.POLYGON_RPC ?? '').trim()
// Verified-healthy public Polygon endpoints from cloud egress IPs
// (Replit, Vercel, etc). Excluded: `polygon-rpc.com` (returns 401 from
// many cloud providers), `rpc.ankr.com/polygon` (requires API key),
// `polygon.llamarpc.com` (DNS frequently NXDOMAIN). Tested 2026-04-30.
const POLYGON_RPC_URLS: string[] = [
  ...(POLYGON_RPC_ENV ? [POLYGON_RPC_ENV] : []),
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.drpc.org',
  'https://1rpc.io/matic',
]
const RELAYER_URL =
  (process.env.POLYMARKET_RELAYER_URL ?? '').trim() ||
  'https://relayer-v2.polymarket.com'

// ── Polygon contract addresses ──────────────────────────────────────────
const USDC_E           = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // USDC.e (collateral)
const CTF              = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' // ConditionalTokens (ERC-1155)
const CTF_EXCHANGE     = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' // standard CLOB exchange
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a' // neg-risk CLOB exchange
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' // neg-risk adapter (redeems)

// Standard ERC-20 ABI subset, plus ERC-1155 setApprovalForAll for CTF
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const

const ERC1155_IS_APPROVED_FOR_ALL_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
] as const

// viem ABIs for the relayer-encoded calls — relayer needs raw calldata, so
// we keep these as JSON ABIs for encodeFunctionData rather than ethers
// human-readable strings.
const ERC20_APPROVE_VIEM_ABI = [{
  type: 'function',
  name: 'approve',
  stateMutability: 'nonpayable',
  inputs:  [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '',        type: 'bool' }],
}] as const

const ERC1155_SET_APPROVAL_FOR_ALL_VIEM_ABI = [{
  type: 'function',
  name: 'setApprovalForAll',
  stateMutability: 'nonpayable',
  inputs:  [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }],
  outputs: [],
}] as const

const CTF_REDEEM_VIEM_ABI = [{
  type: 'function',
  name: 'redeemPositions',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'collateralToken',   type: 'address' },
    { name: 'parentCollectionId', type: 'bytes32' },
    { name: 'conditionId',       type: 'bytes32' },
    { name: 'indexSets',         type: 'uint256[]' },
  ],
  outputs: [],
}] as const

const NEG_RISK_REDEEM_VIEM_ABI = [{
  type: 'function',
  name: 'redeemPositions',
  stateMutability: 'nonpayable',
  inputs: [
    { name: '_conditionId', type: 'bytes32' },
    { name: '_amounts',     type: 'uint256[]' },
  ],
  outputs: [],
}] as const

// ── Builder credentials (env-driven, lazy) ──────────────────────────────
function getBuilderConfig(): BuilderConfig | undefined {
  const key        = (process.env.POLY_BUILDER_API_KEY ?? '').trim()
  const secret     = (process.env.POLY_BUILDER_SECRET ?? '').trim()
  const passphrase = (process.env.POLY_BUILDER_PASSPHRASE ?? '').trim()
  if (!key || !secret || !passphrase) return undefined
  return new BuilderConfig({ localBuilderCreds: { key, secret, passphrase } })
}

export function getBuilderCode(): string | null {
  return polymarketConfig.builderCode
}

// Strict guard so we never send an order without builder attribution when
// we *think* we're attributing. Call sites use this to fail-closed: if
// POLY_BUILDER_CODE is configured but the API creds are missing, refuse
// the trade rather than silently miss the leaderboard credit.
//
// On the relayer path the same creds are *required* — the relayer rejects
// unauthenticated requests, so missing creds also block deploy/approve.
export function getBuilderAttribution(): {
  ok: boolean
  builderConfig?: BuilderConfig
  builderCode: string | null
  reason?: string
} {
  const code = getBuilderCode()
  const cfg  = getBuilderConfig()

  // Strict fail-closed for Builder Program attribution. The whole point of
  // this integration is to generate volume that accrues to *our* builder
  // profile on the Polymarket leaderboard. An order placed without a
  // builder code is volume we paid in fees + opportunity cost for that
  // counts toward NOTHING. Refuse the trade rather than leak unattributed
  // volume — the operator must set POLY_BUILDER_CODE.
  if (!code) {
    return {
      ok: false,
      builderCode: null,
      reason: 'POLY_BUILDER_CODE is not set — refusing to place unattributed orders (would not count toward Builder Program grant)',
    }
  }

  if (!cfg) {
    return {
      ok: false,
      builderCode: code,
      reason: 'POLY_BUILDER_CODE is set but POLY_BUILDER_API_KEY/SECRET/PASSPHRASE are missing — refusing to trade without attribution',
    }
  }
  return { ok: true, builderConfig: cfg, builderCode: code }
}

// ── Provider (singleton, multi-RPC fallback) ────────────────────────────
// FallbackProvider rotates calls across the configured RPCs and demotes
// endpoints that error or stall. quorum=1 means "any one healthy reply
// is good enough" — appropriate for read-only balance/allowance queries
// where consensus across providers isn't needed (and would only slow us
// down). Per-endpoint stallTimeout=2.5s caps per-RPC latency before the
// next is tried; weight=1 distributes load evenly.
let _provider: ethers.FallbackProvider | null = null
function getProvider(): ethers.FallbackProvider {
  if (_provider) return _provider
  const cfgs = POLYGON_RPC_URLS.map((url, i) => ({
    // staticNetwork avoids each child provider issuing its own
    // eth_chainId probe at construction (which would itself be subject
    // to the failing endpoint).
    provider: new ethers.JsonRpcProvider(url, POLYGON_CHAIN_ID, {
      staticNetwork: ethers.Network.from(POLYGON_CHAIN_ID),
    }),
    priority:     i + 1,
    stallTimeout: 2_500,
    weight:       1,
  }))
  _provider = new ethers.FallbackProvider(cfgs, POLYGON_CHAIN_ID, { quorum: 1 })
  return _provider
}

// Build a viem fallback transport over the same RPC list. Used by the
// relayer client (deploySafeIfNeeded, ensureUsdcAllowance, executeBatch)
// so that a single failing public RPC doesn't break Polymarket setup.
function buildPolygonViemTransport(): Transport {
  return viemFallback(
    POLYGON_RPC_URLS.map((url) => viemHttp(url, { timeout: 8_000 })),
    { rank: false, retryCount: 0 },
  )
}

// ── Custodial PK retrieval ──────────────────────────────────────────────
// The user's BSC wallet PK works on Polygon (same secp256k1). We never
// touch agent keys here — Polymarket trades come from the master custodial
// wallet, identical to 42.space's flow. We return BOTH an ethers v6 wallet
// (used by ClobClient's order signing) AND a raw PK hex (used to construct
// the viem WalletClient that the RelayClient requires — its abstract-signer
// factory does an `instanceof ethers.Wallet` check against its own bundled
// ethers v5, which our v6 wallets fail, so we fall through to viem).
async function getUserPolygonSigner(userId: string): Promise<{
  wallet: ethers.Wallet
  address: string
  pkHex: Hex
}> {
  const w = await db.wallet.findFirst({
    where: { userId, isActive: true, chain: 'BSC' },
  })
  if (!w?.encryptedPK) {
    throw new Error('No active custodial wallet for user; activate a BSC wallet first')
  }
  const pk = decryptPrivateKey(w.encryptedPK, userId)
  if (!pk?.startsWith('0x')) throw new Error('Failed to decrypt custodial PK')
  const wallet = new ethers.Wallet(pk, getProvider())
  return { wallet, address: wallet.address, pkHex: pk as Hex }
}

// ── viem wallet client (for the relayer) ────────────────────────────────
// Uses the multi-RPC fallback transport so a single down/rate-limited
// public RPC can't break Safe deployment or USDC allowance setup.
function buildViemWalletClient(pkHex: Hex) {
  const account = privateKeyToAccount(pkHex)
  return createWalletClient({
    account,
    chain:     polygon,
    transport: buildPolygonViemTransport(),
  })
}

// ── L2 API credentials (HMAC) ───────────────────────────────────────────
// Polymarket's CLOB needs HMAC-signed headers on most endpoints. The
// creds are derived from an L1 EIP-712 signature, so once derived they
// are stable for the lifetime of the wallet — we cache them per-user.
// Per-user in-process locks to serialize concurrent setup calls. The
// Replit runtime is single-process, so a Map<userId, Promise> is a
// sufficient mutex — concurrent /api/polymarket/setup hits from a
// double-tapping user will queue rather than racing into two L2 key
// derivations or two Safe deployments. (Cross-process safety is not a
// concern here; we run a single Node instance per Replit workflow.)
const credsLocks: Map<string, Promise<{ creds: ApiKeyCreds; walletAddress: string }>> = new Map()
const safeLocks:  Map<string, Promise<{ safeAddress: string; alreadyDeployed: boolean; txHash?: string }>> = new Map()
// One-tap fund is a value-moving on-chain transaction; serialize per user
// to make double-clicks / retries idempotent (the second caller observes
// the same in-flight promise instead of broadcasting a second transfer
// that would either revert on insufficient balance or — worse, with an
// explicit amount — actually move funds twice).
const fundLocks:  Map<string, Promise<{ txHash: string; fromAddress: string; toAddress: string; amountUsdc: number }>> = new Map()

export async function getOrCreateCreds(userId: string): Promise<{
  creds: ApiKeyCreds
  walletAddress: string
}> {
  // Fast path — already exists, no lock needed.
  const existing = await db.polymarketCreds.findUnique({ where: { userId } })
  if (existing) {
    return {
      creds: {
        key:        existing.apiKey,
        secret:     decryptPrivateKey(existing.encryptedApiSecret, userId),
        passphrase: decryptPrivateKey(existing.encryptedPassphrase, userId),
      },
      walletAddress: existing.walletAddress,
    }
  }

  // Slow path — gate behind the per-user lock so two concurrent first-time
  // setups don't both call createOrDeriveApiKey().
  const inflight = credsLocks.get(userId)
  if (inflight) return inflight

  const promise = (async () => {
    // Re-check after acquiring the lock — the prior holder may have just
    // created the row.
    const again = await db.polymarketCreds.findUnique({ where: { userId } })
    if (again) {
      return {
        creds: {
          key:        again.apiKey,
          secret:     decryptPrivateKey(again.encryptedApiSecret, userId),
          passphrase: decryptPrivateKey(again.encryptedPassphrase, userId),
        },
        walletAddress: again.walletAddress,
      }
    }

    const { wallet, address } = await getUserPolygonSigner(userId)

    // Bootstrap client without creds — only L1 endpoints (createOrDeriveApiKey)
    // need to work here.
    const bootstrap = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, wallet as any)
    const fresh = await bootstrap.createOrDeriveApiKey()

    try {
      await db.polymarketCreds.create({
        data: {
          userId,
          walletAddress:       address,
          apiKey:              fresh.key,
          encryptedApiSecret:  encryptPrivateKey(fresh.secret, userId),
          encryptedPassphrase: encryptPrivateKey(fresh.passphrase, userId),
        },
      })
    } catch (err: any) {
      // P2002 = Prisma unique-constraint violation. If a parallel instance
      // (e.g. test runner or a separate worker) raced us, fall back to the
      // existing row instead of failing the user.
      if (err?.code !== 'P2002') throw err
      const persisted = await db.polymarketCreds.findUnique({ where: { userId } })
      if (!persisted) throw err
      return {
        creds: {
          key:        persisted.apiKey,
          secret:     decryptPrivateKey(persisted.encryptedApiSecret, userId),
          passphrase: decryptPrivateKey(persisted.encryptedPassphrase, userId),
        },
        walletAddress: persisted.walletAddress,
      }
    }

    return { creds: fresh, walletAddress: address }
  })()
    .finally(() => credsLocks.delete(userId))

  credsLocks.set(userId, promise)
  return promise
}

// ── Relayer client ──────────────────────────────────────────────────────
// Construct a SAFE-mode RelayClient backed by the user's PK via viem.
// Builder config is REQUIRED — the relayer refuses unauthenticated
// requests, so missing builder creds is a hard fail here.
function getRelayClient(pkHex: Hex): RelayClient {
  const attribution = getBuilderAttribution()
  if (!attribution.ok || !attribution.builderConfig) {
    throw new Error(attribution.reason ?? 'Builder attribution required for relayer access')
  }
  const wallet = buildViemWalletClient(pkHex)
  // BuilderConfig type cast: builder-relayer-client ships a nested copy of
  // @polymarket/builder-signing-sdk (different patch version), so the
  // structural-typing equality check fails even though the runtime classes
  // are identical. Cast through unknown to bridge the duplicate types.
  return new RelayClient(
    RELAYER_URL,
    POLYGON_CHAIN_ID,
    wallet,
    attribution.builderConfig as unknown as any,
    RelayerTxType.SAFE,
  )
}

// ── Safe deployment ─────────────────────────────────────────────────────
// One-time per user. The Safe address is deterministic from the EOA, so
// we can compute it via getExpectedSafe before deployment too — but we
// don't expose that publicly because callers should always go through
// /setup first to get the persisted record.
export async function deploySafeIfNeeded(userId: string): Promise<{
  safeAddress: string
  alreadyDeployed: boolean
  txHash?: string
}> {
  // Fast path — already persisted, no lock needed.
  const existing = await db.polymarketCreds.findUnique({ where: { userId } })
  if (existing?.safeAddress && existing?.safeDeployedAt) {
    return { safeAddress: existing.safeAddress, alreadyDeployed: true }
  }

  // Serialize concurrent deploys per user. Without this, two parallel
  // /setup calls could both invoke relay.deploy() and burn relayer
  // credit on a doomed second tx (the Safe factory call is deterministic
  // per EOA so the second one would revert as "Safe already exists").
  const inflight = safeLocks.get(userId)
  if (inflight) return inflight

  const promise = (async () => {
    // Re-check inside the lock.
    const again = await db.polymarketCreds.findUnique({ where: { userId } })
    if (again?.safeAddress && again?.safeDeployedAt) {
      return { safeAddress: again.safeAddress, alreadyDeployed: true }
    }

    const { pkHex } = await getUserPolygonSigner(userId)
    const relay = getRelayClient(pkHex)

    // Best-effort: check whether a Safe at the expected address is already
    // deployed (e.g. user previously interacted with polymarket.com directly).
    // The deploy() call below is idempotent on the relayer side, but skipping
    // it when not needed saves a round-trip and gives us the address either way.
    let safeAddr: string | undefined
    try {
      // RelayClient exposes getExpectedSafe via private method; recreate it
      // here using the same deriveSafe helper exported by the package.
      const { deriveSafe } = await import('@polymarket/builder-relayer-client/dist/builder/derive')
      const factory = (relay as any).contractConfig?.SafeContracts?.SafeFactory
      if (factory) {
        const eoa = (await pkHexToAddress(pkHex)).toLowerCase()
        safeAddr = deriveSafe(eoa, factory)
        const isDeployed = await relay.getDeployed(safeAddr).catch(() => false)
        if (isDeployed) {
          await db.polymarketCreds.update({
            where: { userId },
            data:  { safeAddress: safeAddr, safeDeployedAt: new Date() },
          })
          return { safeAddress: safeAddr, alreadyDeployed: true }
        }
      }
    } catch (err) {
      // Non-fatal — fall through to deploy()
      console.warn('[poly] safe pre-check failed:', (err as Error).message)
    }

    const resp = await relay.deploy()
    const result = await resp.wait()
    if (!result || !result.proxyAddress) {
      throw new Error(
        `Relayer Safe deployment did not confirm (state=${(result as any)?.state ?? 'unknown'})`,
      )
    }

    await db.polymarketCreds.update({
      where: { userId },
      data:  {
        safeAddress:    result.proxyAddress,
        safeDeployedAt: new Date(),
      },
    })

    return {
      safeAddress:    result.proxyAddress,
      alreadyDeployed: false,
      txHash:         result.transactionHash,
    }
  })()
    .finally(() => safeLocks.delete(userId))

  safeLocks.set(userId, promise)
  return promise
}

async function pkHexToAddress(pkHex: Hex): Promise<string> {
  return privateKeyToAccount(pkHex).address
}

// ── Balances ────────────────────────────────────────────────────────────
// Reads at an arbitrary address. Callers pass `safeAddress` for the
// trading-relevant balances (USDC.e + allowances live there now); EOA
// reads are mostly informational since the EOA no longer needs MATIC.
export async function getPolygonBalances(address: string): Promise<{
  matic: number
  usdc:  number
  usdcRaw: string
  allowanceCtf: number
  allowanceNeg: number
  allowanceNegAdapter: number
  ctfApprovedCtfExchange: boolean
  ctfApprovedNegExchange: boolean
  ctfApprovedNegAdapter:  boolean
}> {
  const provider = getProvider()
  const usdc     = new ethers.Contract(USDC_E, ERC20_ABI, provider)
  const ctf      = new ethers.Contract(CTF, ERC1155_IS_APPROVED_FOR_ALL_ABI, provider)
  const [
    maticWei, usdcRaw,
    allowCtfRaw, allowNegRaw, allowNegAdapterRaw,
    ctfApprovedCtf, ctfApprovedNeg, ctfApprovedNegAdapter,
  ] = await Promise.all([
    provider.getBalance(address),
    usdc.balanceOf(address),
    usdc.allowance(address, CTF_EXCHANGE),
    usdc.allowance(address, NEG_RISK_EXCHANGE),
    usdc.allowance(address, NEG_RISK_ADAPTER),
    ctf.isApprovedForAll(address, CTF_EXCHANGE),
    ctf.isApprovedForAll(address, NEG_RISK_EXCHANGE),
    ctf.isApprovedForAll(address, NEG_RISK_ADAPTER),
  ])
  return {
    matic:                  parseFloat(ethers.formatEther(maticWei)),
    usdc:                   parseFloat(ethers.formatUnits(usdcRaw, 6)),
    usdcRaw:                usdcRaw.toString(),
    allowanceCtf:           parseFloat(ethers.formatUnits(allowCtfRaw, 6)),
    allowanceNeg:           parseFloat(ethers.formatUnits(allowNegRaw, 6)),
    allowanceNegAdapter:    parseFloat(ethers.formatUnits(allowNegAdapterRaw, 6)),
    ctfApprovedCtfExchange: Boolean(ctfApprovedCtf),
    ctfApprovedNegExchange: Boolean(ctfApprovedNeg),
    ctfApprovedNegAdapter:  Boolean(ctfApprovedNegAdapter),
  }
}

// ── Convenience: get the funding (Safe) address for a user ──────────────
export async function getFunderAddress(userId: string): Promise<string | null> {
  const c = await db.polymarketCreds.findUnique({ where: { userId } })
  return c?.safeAddress ?? null
}

// ── One-tap fund: sweep custodial EOA USDC.e → user's Polymarket Safe ──
// This is the only on-chain transaction the user themselves pays gas for.
// Polymarket's relayer covers every Safe-side action (deploy, approvals,
// orders, redemptions), but moving funds from the user's external custodial
// EOA into their Safe is a regular ERC-20 transfer — the relayer does not
// sponsor arbitrary EOAs. So we require ~$0.001 worth of MATIC at the EOA
// for that one tx, mirroring the same pattern as the Hyperliquid bridge
// flow (which needs Arbitrum ETH for the bridge transfer).
//
// `amountUsdc` is in human units (USDC.e has 6 decimals on-chain). When
// omitted, sweeps the entire EOA balance minus a tiny dust safety buffer
// (1 µUSDC) to dodge floating-point rounding.
//
// Returns enough information for the UI to show a meaningful success state
// and refresh balances. Throws with a descriptive message on any precondition
// failure so the API layer can surface a clean 4xx (e.g. NEED_MATIC).
export async function fundSafeFromEoa(opts: {
  userId: string
  amountUsdc?: number
}): Promise<{
  txHash: string
  fromAddress: string
  toAddress: string
  amountUsdc: number
}> {
  const { userId } = opts
  // Serialize per-user. A second concurrent caller (from a double-tapped
  // button or a retried API call) joins the in-flight promise — they see
  // the same tx hash rather than spawning a second value-moving transfer.
  const inflight = fundLocks.get(userId)
  if (inflight) return inflight
  const promise = doFundSafeFromEoa(opts)
    .finally(() => fundLocks.delete(userId))
  fundLocks.set(userId, promise)
  return promise
}

async function doFundSafeFromEoa(opts: {
  userId: string
  amountUsdc?: number
}): Promise<{
  txHash: string
  fromAddress: string
  toAddress: string
  amountUsdc: number
}> {
  const { userId } = opts

  // (1) Resolve EOA signer + Safe address. Both must be ready — the Safe
  //     is the only valid destination, and a user without a Safe should
  //     have hit /setup first.
  const { wallet, address: eoaAddress } = await getUserPolygonSigner(userId)
  const safeAddress = await getFunderAddress(userId)
  if (!safeAddress) {
    throw new Error('Polymarket Safe not deployed yet — run setup first')
  }

  // (2) Read on-chain balances at the EOA. We need both:
  //     - USDC.e to actually move
  //     - MATIC to pay for the transfer's gas
  const provider = getProvider()
  const usdc     = new ethers.Contract(USDC_E, ERC20_ABI, wallet)
  const [usdcRaw, maticWei] = await Promise.all([
    (usdc.balanceOf(eoaAddress) as Promise<bigint>),
    provider.getBalance(eoaAddress),
  ])

  // (3) Resolve the amount to move. If unspecified, sweep all but 1 µUSDC.
  //     If specified, clamp to balance — never attempt to move more than the
  //     EOA actually holds.
  const reqRaw = opts.amountUsdc !== undefined && Number.isFinite(opts.amountUsdc)
    ? ethers.parseUnits(opts.amountUsdc.toFixed(6), 6)
    : usdcRaw - 1n
  if (reqRaw <= 0n) {
    throw new Error('No USDC.e balance at custodial address to fund Polymarket')
  }
  if (reqRaw > usdcRaw) {
    const have = ethers.formatUnits(usdcRaw, 6)
    const want = ethers.formatUnits(reqRaw,  6)
    throw new Error(`Insufficient USDC.e — requested ${want}, have ${have}`)
  }

  // (4) Gas precondition. The transfer costs roughly ~50k gas; at ~30 gwei
  //     that's ~0.0015 MATIC. We require 0.005 MATIC as a comfortable
  //     headroom (~$0.005 at MATIC=$1) to absorb gas-price spikes during
  //     network busy periods. Distinct error string so the API layer can
  //     surface a NEED_MATIC code and the UI can show a "send a small
  //     amount of MATIC for gas" prompt with the EOA address.
  const minMaticWei = ethers.parseEther('0.005')
  if (maticWei < minMaticWei) {
    const have = ethers.formatEther(maticWei)
    throw new Error(
      `NEED_MATIC: custodial address has ${have} MATIC, ` +
      `need at least 0.005 MATIC for gas to fund Polymarket`,
    )
  }

  // (5) Execute the transfer. Single ERC-20 call, signed and broadcast by
  //     the user's own custodial key. We wait for confirmation so the
  //     UI can immediately refetch and show the new Safe balance.
  const tx      = await usdc.transfer(safeAddress, reqRaw)
  const receipt = await tx.wait(1)
  if (!receipt || receipt.status !== 1) {
    throw new Error('USDC.e transfer reverted on Polygon')
  }

  return {
    txHash:      tx.hash,
    fromAddress: eoaAddress,
    toAddress:   safeAddress,
    amountUsdc:  parseFloat(ethers.formatUnits(reqRaw, 6)),
  }
}

// ── One-time gasless approvals via the relayer ─────────────────────────
// Approves USDC.e to the three exchange contracts and the CTF (ERC-1155)
// to the same three operators, all in a single batched relayer execute.
// The Safe pays nothing on-chain — Polymarket's relayer covers gas in
// exchange for the builder credentials we authenticate the request with.
export async function ensureUsdcAllowance(userId: string): Promise<{
  alreadyApproved: boolean
  txHashes: string[]
}> {
  const creds = await db.polymarketCreds.findUnique({ where: { userId } })
  if (!creds?.safeAddress) {
    throw new Error('Safe not deployed yet — call deploySafeIfNeeded first')
  }
  const safe = creds.safeAddress

  // Skip the relayer round-trip if the Safe already has the full set.
  // Each check is a cheap eth_call; collectively cheaper than a needless
  // relayer execute.
  const bal = await getPolygonBalances(safe)
  const minUsdc = 1_000_000
  const fullySetup =
    bal.allowanceCtf        >= minUsdc &&
    bal.allowanceNeg        >= minUsdc &&
    bal.allowanceNegAdapter >= minUsdc &&
    bal.ctfApprovedCtfExchange &&
    bal.ctfApprovedNegExchange &&
    bal.ctfApprovedNegAdapter
  if (fullySetup) {
    await db.polymarketCreds.updateMany({
      where: { userId },
      data:  { allowanceVerifiedAt: new Date() },
    })
    return { alreadyApproved: true, txHashes: [] }
  }

  const { pkHex } = await getUserPolygonSigner(userId)
  const relay = getRelayClient(pkHex)

  const txns: Transaction[] = []
  const erc20Approve = (token: string, spender: string): Transaction => ({
    to:    token,
    data:  encodeFunctionData({
      abi: ERC20_APPROVE_VIEM_ABI,
      functionName: 'approve',
      args: [spender as Hex, maxUint256],
    }),
    value: '0',
  })
  const erc1155SetApprovalForAll = (token: string, operator: string): Transaction => ({
    to:    token,
    data:  encodeFunctionData({
      abi: ERC1155_SET_APPROVAL_FOR_ALL_VIEM_ABI,
      functionName: 'setApprovalForAll',
      args: [operator as Hex, true],
    }),
    value: '0',
  })

  if (bal.allowanceCtf        < minUsdc) txns.push(erc20Approve(USDC_E, CTF_EXCHANGE))
  if (bal.allowanceNeg        < minUsdc) txns.push(erc20Approve(USDC_E, NEG_RISK_EXCHANGE))
  if (bal.allowanceNegAdapter < minUsdc) txns.push(erc20Approve(USDC_E, NEG_RISK_ADAPTER))
  if (!bal.ctfApprovedCtfExchange) txns.push(erc1155SetApprovalForAll(CTF, CTF_EXCHANGE))
  if (!bal.ctfApprovedNegExchange) txns.push(erc1155SetApprovalForAll(CTF, NEG_RISK_EXCHANGE))
  if (!bal.ctfApprovedNegAdapter)  txns.push(erc1155SetApprovalForAll(CTF, NEG_RISK_ADAPTER))

  if (txns.length === 0) {
    // Race: balances changed between the read and now. Treat as approved.
    await db.polymarketCreds.updateMany({
      where: { userId },
      data:  { allowanceVerifiedAt: new Date() },
    })
    return { alreadyApproved: true, txHashes: [] }
  }

  const resp = await relay.execute(txns, 'usdc + ctf approvals (gasless setup)')
  const result = await resp.wait()
  if (!result || (result.state && result.state === 'STATE_FAILED')) {
    throw new Error(
      `Relayer execute failed (state=${(result as any)?.state ?? 'unknown'})`,
    )
  }

  await db.polymarketCreds.updateMany({
    where: { userId },
    data:  {
      allowanceTxHash:     result.transactionHash,
      allowanceVerifiedAt: new Date(),
    },
  })

  return { alreadyApproved: false, txHashes: [result.transactionHash] }
}

// ── Authenticated CLOB client (SAFE funder) ─────────────────────────────
async function getAuthedClient(userId: string, opts?: { requireAttribution?: boolean }): Promise<{
  client: ClobClient
  walletAddress: string  // EOA — signing key
  funderAddress: string  // Safe — actual order funder
  builderCode: string | null
  attributionOk: boolean
}> {
  const { wallet, address } = await getUserPolygonSigner(userId)
  const { creds }           = await getOrCreateCreds(userId)
  const attribution         = getBuilderAttribution()

  // requireAttribution = true on the trade path. Refuse to construct a
  // trading client when attribution is misconfigured so the order POST
  // never goes out unattributed.
  if (opts?.requireAttribution && !attribution.ok) {
    throw new Error(attribution.reason ?? 'Builder attribution unavailable')
  }

  const dbCreds = await db.polymarketCreds.findUnique({ where: { userId } })
  const funder  = dbCreds?.safeAddress
  if (!funder) {
    throw new Error('Safe not deployed yet — run /api/polymarket/setup first')
  }

  // ClobClient signature: (host, chainId, signer, creds, signatureType, funderAddress, ...)
  // funderAddress is the address the CLOB will pull collateral FROM — the
  // Safe — while signer is the EOA that authorizes the order.
  const client = new ClobClient(
    CLOB_HOST,
    POLYGON_CHAIN_ID,
    wallet as any,
    creds,
    SignatureType.POLY_GNOSIS_SAFE,
    funder,
    undefined,
    undefined,
    attribution.builderConfig,
  )
  return {
    client,
    walletAddress: address,
    funderAddress: funder,
    builderCode:   attribution.builderCode,
    attributionOk: attribution.ok,
  }
}

// ── Place a market order (buy or sell) ─────────────────────────────────
export interface PlaceOrderArgs {
  userId:     string
  agentId?:   string
  tokenId:    string
  side:       'BUY' | 'SELL'
  // BUY: USDC notional to spend. SELL: outcome-token quantity to sell.
  amount:     number
  marketCtx: {
    conditionId:  string
    marketTitle:  string
    marketSlug?:  string
    outcomeLabel: string
  }
  reasoning?: string
  providers?: any
  expectedPrice?:  number
  maxSlippageBps?: number
  skipAllowanceCheck?: boolean
}

export interface PlaceOrderResult {
  ok:         boolean
  positionId?: string
  orderId?:   string
  orderHash?: string
  fillPrice?: number
  error?:     string
}

export async function placeMarketOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
  const {
    userId, agentId, tokenId, side, amount, marketCtx, reasoning, providers,
    expectedPrice, maxSlippageBps, skipAllowanceCheck,
  } = args

  let positionId: string | undefined
  try {
    // 1. Build authed client (SAFE-funder) — REQUIRES builder attribution.
    //    Throws if either attribution is missing OR the user hasn't run
    //    setup yet (no Safe deployed).
    const { client, builderCode, funderAddress, attributionOk } = await getAuthedClient(userId, {
      requireAttribution: true,
    })

    // 2. Allowance pre-check. Without USDC + CTF approvals at the Safe
    //    the CLOB will reject the order. The agent path used to skip
    //    this — it now opts in by default.
    if (!skipAllowanceCheck) {
      await ensureUsdcAllowance(userId)
    }

    // 3. Read current best price for slippage check + telemetry.
    let entryEstimate = 0.5
    try {
      const mid = await client.getMidpoint(tokenId)
      const v = parseFloat(String((mid as any)?.mid ?? mid))
      if (Number.isFinite(v) && v > 0 && v < 1) entryEstimate = v
    } catch {}

    if (
      expectedPrice && Number.isFinite(expectedPrice) &&
      maxSlippageBps && maxSlippageBps > 0
    ) {
      const driftBps = Math.abs(entryEstimate - expectedPrice) / expectedPrice * 10_000
      if (driftBps > maxSlippageBps) {
        return {
          ok: false,
          error: `Price moved ${driftBps.toFixed(0)}bps (cap ${maxSlippageBps}bps): saw ${expectedPrice.toFixed(3)}, now ${entryEstimate.toFixed(3)}`,
        }
      }
    }

    const slipMul = maxSlippageBps ? maxSlippageBps / 10_000 : 0.05
    const ref     = expectedPrice && Number.isFinite(expectedPrice) ? expectedPrice : entryEstimate
    const capPrice = side === 'BUY'
      ? Math.min(0.999, ref * (1 + slipMul))
      : Math.max(0.001, ref * (1 - slipMul))

    // 4. Persist the position FIRST in 'placed' state so we have an
    //    audit trail even if the CLOB POST hangs.
    const position = await db.polymarketPosition.create({
      data: {
        userId,
        agentId:      agentId ?? null,
        conditionId:  marketCtx.conditionId,
        tokenId,
        marketSlug:   marketCtx.marketSlug ?? null,
        marketTitle:  marketCtx.marketTitle,
        outcomeLabel: marketCtx.outcomeLabel,
        side,
        sizeUsdc:     side === 'BUY' ? amount : amount * entryEstimate,
        entryPrice:   entryEstimate,
        status:       'placed',
        builderCode,
        reasoning:    reasoning ?? null,
        providers:    providers ?? null,
      },
    })
    positionId = position.id

    if (!attributionOk) {
      throw new Error('Refusing to place order without verified builder attribution')
    }
    const signed = await client.createMarketOrder({
      tokenID:  tokenId,
      side:     side === 'BUY' ? Side.BUY : Side.SELL,
      amount,
      price:    capPrice,
      orderType: OrderType.FAK,
    })

    const resp = await client.postOrder(signed, OrderType.FAK)

    if (!resp || resp.success === false) {
      const errMsg = (resp && (resp.errorMsg || resp.error || resp.message)) || 'CLOB rejected order'
      await db.polymarketPosition.update({
        where: { id: position.id },
        data:  { status: 'failed', errorMessage: String(errMsg).slice(0, 500) },
      })
      return { ok: false, positionId, error: String(errMsg) }
    }

    const orderId   = resp.orderID || resp.orderId || null
    const orderHash = resp.orderHash || (signed as any)?.hash || null
    const status    = (resp.status === 'matched' || resp.status === 'filled') ? resp.status : 'placed'

    const makingAmount = parseFloat(String((resp as any).makingAmount ?? '0'))
    const takingAmount = parseFloat(String((resp as any).takingAmount ?? '0'))
    const realShares =
      side === 'BUY'
        ? (Number.isFinite(takingAmount) && takingAmount > 0 ? takingAmount : amount / entryEstimate)
        : (Number.isFinite(makingAmount) && makingAmount > 0 ? makingAmount : amount)
    const realFillPrice =
      side === 'BUY' && Number.isFinite(makingAmount) && makingAmount > 0 && Number.isFinite(takingAmount) && takingAmount > 0
        ? makingAmount / takingAmount
        : side === 'SELL' && Number.isFinite(takingAmount) && takingAmount > 0 && Number.isFinite(makingAmount) && makingAmount > 0
          ? takingAmount / makingAmount
          : entryEstimate

    await db.polymarketPosition.update({
      where: { id: position.id },
      data:  {
        orderId,
        orderHash,
        status,
        fillSize:   realShares,
        entryPrice: realFillPrice,
        sizeUsdc:   side === 'BUY'
          ? (Number.isFinite(makingAmount) && makingAmount > 0 ? makingAmount : amount)
          : (Number.isFinite(takingAmount) && takingAmount > 0 ? takingAmount : amount * entryEstimate),
      },
    })

    // funderAddress is part of the order envelope — we don't persist
    // it separately on the position row (it's the user's Safe and is
    // the same for every order they place), but we annotate the log
    // so the brain feed can show the actual on-chain funder.
    void funderAddress

    return { ok: true, positionId, orderId: orderId ?? undefined, orderHash: orderHash ?? undefined, fillPrice: realFillPrice }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    if (positionId) {
      await db.polymarketPosition.update({
        where: { id: positionId },
        data:  { status: 'failed', errorMessage: msg.slice(0, 500) },
      }).catch(() => {})
    }
    return { ok: false, positionId, error: msg }
  }
}

// ── Read user's positions ───────────────────────────────────────────────
export async function getUserPositions(userId: string) {
  return db.polymarketPosition.findMany({
    where:   { userId },
    orderBy: { openedAt: 'desc' },
    take:    200,
  })
}

// ── Gasless redeem of resolved positions ───────────────────────────────
// Triggered by the user from the positions panel once a market resolves.
// Routes through CTF.redeemPositions for standard markets and
// NegRiskAdapter.redeemPositions for neg-risk markets — caller specifies.
export async function redeemPositions(args: {
  userId: string
  conditionId: string
  isNegRisk?: boolean
  // For neg-risk redeems we need the per-outcome share amounts (raw 6dp).
  // For CTF redeems we don't — the CTF reads the user's balance directly.
  negRiskAmounts?: bigint[]
}): Promise<{ txHash: string }> {
  const { userId, conditionId, isNegRisk, negRiskAmounts } = args
  if (!/^0x[0-9a-fA-F]{64}$/.test(conditionId)) {
    throw new Error(`Invalid conditionId: ${conditionId}`)
  }
  const creds = await db.polymarketCreds.findUnique({ where: { userId } })
  if (!creds?.safeAddress) throw new Error('Safe not deployed — run /setup first')

  const { pkHex } = await getUserPolygonSigner(userId)
  const relay = getRelayClient(pkHex)

  let tx: Transaction
  if (isNegRisk) {
    if (!negRiskAmounts || negRiskAmounts.length === 0) {
      throw new Error('negRiskAmounts required for neg-risk redeem')
    }
    tx = {
      to:    NEG_RISK_ADAPTER,
      data:  encodeFunctionData({
        abi: NEG_RISK_REDEEM_VIEM_ABI,
        functionName: 'redeemPositions',
        args: [conditionId as Hex, negRiskAmounts],
      }),
      value: '0',
    }
  } else {
    // Standard CTF binary market — indexSets [1, 2] redeems both YES and NO
    // positions. The CTF reads the user's actual balance from the Safe so
    // unowned outcomes contribute zero.
    tx = {
      to:    CTF,
      data:  encodeFunctionData({
        abi: CTF_REDEEM_VIEM_ABI,
        functionName: 'redeemPositions',
        args: [USDC_E as Hex, zeroHash, conditionId as Hex, [1n, 2n]],
      }),
      value: '0',
    }
  }

  const resp = await relay.execute([tx], `redeem ${conditionId.slice(0, 10)}…`)
  const result = await resp.wait()
  if (!result || (result.state && result.state === 'STATE_FAILED')) {
    throw new Error(
      `Relayer redeem failed (state=${(result as any)?.state ?? 'unknown'})`,
    )
  }

  // Best-effort: mark any matching open positions as resolved. Real PnL
  // accounting belongs in a separate reconciler; this just stops them
  // from showing as active.
  await db.polymarketPosition.updateMany({
    where: {
      userId,
      conditionId,
      status: { in: ['placed', 'matched', 'filled'] },
    },
    data: { status: 'resolved_win', closedAt: new Date() },
  }).catch(() => {})

  return { txHash: result.transactionHash }
}

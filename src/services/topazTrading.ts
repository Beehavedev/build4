// =====================================================================
// Topaz DEX — Phase 1 execution layer (master-wallet-only).
//
// Architecture
// ─────────────
// Pure execution: no LLM lives here. The Topaz agent brain
// (src/agents/topazAgent.ts) emits a {action, ...} JSON decision and
// hands it to this module, which:
//   1. Resolves the master wallet (TOPAZ_MASTER_WALLET_ID env), decrypts
//      the PK via the existing wallet.ts AES-256 flow, and constructs an
//      ethers.Wallet bound to a hardened BSC FallbackProvider.
//   2. Re-quotes the action on-chain (Router.getAmountsOut / CLPool /
//      MixedRouteQuoterV1) — never trusts the brain's input price.
//   3. Computes amountOutMin = quote × (1 - slippage_bps/10000) — every
//      write path enforces a non-zero minOut. We NEVER pass 0.
//   4. Stamps deadline = now + 20m (default; overridable). NEVER 0.
//   5. Fails closed on missing addresses / unknown pools / out-of-range
//      CL mints (when intendsToFarm=true).
//
// All on-chain calls go through ethers v6 against the multi-endpoint
// FallbackProvider (src/services/bscProvider.ts). Per-wallet serialization
// is enforced by the master-wallet model itself — there's only one
// active signer in Phase 1, no concurrent nonce contention possible.
//
// Operating-principle gotchas (from Topaz SKILL.md, repeated next to the
// call site that enforces them):
//   • Router.swapExactTokensForTokens: amountOutMin > 0 AND deadline > now.
//   • CLPool.swap: sqrtPriceLimitX96 must be a non-zero sentinel.
//   • NPM.mint: out-of-range tick window → position earns ZERO.
//   • CLGauge.deposit: NFT must be approved (setApprovalForAll) first.
//   • Voter.vote: once per epoch — out of scope for Phase 1.
// =====================================================================

import { AsyncLocalStorage } from 'async_hooks'
import { ethers } from 'ethers'
import { db } from '../db'
import { decryptPrivateKey } from './wallet'
import { buildBscProvider } from './bscProvider'
import {
  ERC20_ABI,
  TOPAZ_ROUTER_ABI,
  TOPAZ_V2_PAIR_ABI,
  TOPAZ_CL_POOL_ABI,
  TOPAZ_NPM_ABI,
  TOPAZ_GAUGE_ABI,
  TOPAZ_CL_GAUGE_ABI,
  TOPAZ_MIXED_QUOTER_ABI,
  TOPAZ_VOTER_ABI,
} from './topaz/abis'
import { getTopazConfig, requireAddress, type TopazConfig } from './topaz'

// ── Provider / signer ────────────────────────────────────────────────────

export interface TopazTradingDeps {
  buildProvider: () => ethers.AbstractProvider
  loadWallet: (walletId: string) => Promise<{ address: string; privateKey: string }>
  now: () => number
  // Broker-fee charger seam. Defaults to the real implementation in
  // brokerFees.ts (which builds its own BSC provider + broadcasts the
  // transfer). Overridable so the fee pre-deduction path can be unit
  // tested without a live RPC. Production behaviour is unchanged.
  chargeErc20Fee: typeof import('./brokerFees').chargeErc20Fee
}

const defaultDeps: TopazTradingDeps = {
  buildProvider: () => buildBscProvider(process.env.BSC_RPC_URL),
  loadWallet: defaultLoadWallet,
  now: () => Date.now(),
  chargeErc20Fee: (pk, token, gross, ctx, label) =>
    import('./brokerFees').then((m) => m.chargeErc20Fee(pk, token, gross, ctx, label)),
}

let activeDeps: TopazTradingDeps = defaultDeps

export function __setTopazTestDeps(deps: Partial<TopazTradingDeps>): void {
  activeDeps = { ...defaultDeps, ...deps }
}

export function __resetTopazTestDeps(): void {
  activeDeps = defaultDeps
}

async function defaultLoadWallet(walletId: string): Promise<{ address: string; privateKey: string }> {
  const w = await db.wallet.findUnique({ where: { id: walletId } })
  if (!w) throw new Error(`topaz_wallet_not_found:${walletId}`)
  if (w.chain !== 'BSC') {
    throw new Error(`topaz_wallet_wrong_chain:${w.chain} (expected BSC)`)
  }
  const pk = decryptPrivateKey(w.encryptedPK, w.userId)
  if (!pk || !pk.startsWith('0x')) {
    throw new Error(`topaz_wallet_decrypt_failed:${walletId}`)
  }
  return { address: w.address, privateKey: pk }
}

// ── House-mode signer override ────────────────────────────────────────────
// When code runs inside `runWithHouseSigner(fn)`, getMasterSigner() pulls
// keys from HOUSE_AGENT_PRIVATE_KEY instead of decrypting the Wallet row
// pointed to by TOPAZ_MASTER_WALLET_ID. This lets the /house admin panel
// reuse the entire Topaz execution layer against its own dedicated wallet
// without forcing the operator to import the house PK into the Wallet
// table. Concurrency-safe via AsyncLocalStorage — concurrent regular agent
// ticks running on the master wallet are unaffected.
const houseModeStore = new AsyncLocalStorage<{ pk: string }>()

export async function runWithHouseSigner<T>(fn: () => Promise<T>): Promise<T> {
  const pk = (process.env.HOUSE_AGENT_PRIVATE_KEY ?? '').trim()
  if (!pk || !pk.startsWith('0x')) {
    throw new Error('topaz_house_pk_missing — HOUSE_AGENT_PRIVATE_KEY not set')
  }
  return houseModeStore.run({ pk }, fn)
}

/**
 * Resolve and instantiate the Phase-1 master signer. Throws fail-closed
 * if TOPAZ_MASTER_WALLET_ID is unset or the row can't be decrypted.
 */
export async function getMasterSigner(): Promise<{
  signer: ethers.Wallet
  address: string
  cfg: TopazConfig
}> {
  const cfg = getTopazConfig()
  const provider = activeDeps.buildProvider()
  // House-mode override (set by runWithHouseSigner). Skips the Wallet
  // table entirely; pk comes from HOUSE_AGENT_PRIVATE_KEY env.
  const houseCtx = houseModeStore.getStore()
  if (houseCtx) {
    const signer = new ethers.Wallet(houseCtx.pk, provider)
    return { signer, address: signer.address, cfg }
  }
  if (!cfg.masterWalletId) {
    throw new Error('topaz_config_missing:masterWalletId — set TOPAZ_MASTER_WALLET_ID')
  }
  const { address, privateKey } = await activeDeps.loadWallet(cfg.masterWalletId)
  const signer = new ethers.Wallet(privateKey, provider)
  return { signer, address, cfg }
}

/**
 * Resolve a signer for a specific Telegram user's active BSC custodial
 * wallet. Phase 2: user-initiated mini-app trades flow through this
 * helper so each user funds and signs from their own custody, while the
 * autonomous agent path keeps using `getMasterSigner` (Phase 1).
 */
export async function getUserSigner(userId: string): Promise<{
  signer: ethers.Wallet
  address: string
  cfg: TopazConfig
}> {
  const cfg = getTopazConfig()
  const provider = activeDeps.buildProvider()
  const w = await db.wallet.findFirst({
    where: { userId, chain: 'BSC', isActive: true },
  })
  if (!w) throw new Error('topaz_user_wallet_not_found — no active BSC wallet for this user')
  const { privateKey } = await activeDeps.loadWallet(w.id)
  const signer = new ethers.Wallet(privateKey, provider)
  return { signer, address: signer.address, cfg }
}

/**
 * Unified signer resolver used by every write entry point. When the
 * caller passes a `userId`, we sign from that user's BSC wallet; when
 * omitted, we fall back to the master signer (autonomous agent path).
 */
export async function resolveSigner(
  opts?: { userId?: string },
): Promise<{ signer: ethers.Wallet; address: string; cfg: TopazConfig }> {
  if (opts?.userId) return getUserSigner(opts.userId)
  return getMasterSigner()
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function computeDeadline(cfg: TopazConfig, override?: number): number {
  const sec = override && override > 0 ? Math.floor(override) : cfg.defaultDeadlineSec
  // Mandatory: deadline must always be strictly in the future. We
  // assert here so a caller passing a stale value blows up early.
  const deadline = Math.floor(activeDeps.now() / 1000) + sec
  if (deadline <= Math.floor(activeDeps.now() / 1000)) {
    throw new Error('topaz_invalid_deadline')
  }
  return deadline
}

export function applySlippage(quoted: bigint, slippageBps: number): bigint {
  // amountOutMin = quoted × (1 - slippage/10000). We round DOWN
  // (integer division) so the minOut is conservative — never round
  // up, that would refuse fills that match our intended slippage.
  if (!Number.isFinite(slippageBps) || slippageBps < 0) {
    throw new Error(`topaz_invalid_slippage_bps:${slippageBps}`)
  }
  const num = 10_000n - BigInt(Math.floor(slippageBps))
  if (num <= 0n) {
    // 100% slippage = trade for free. Refuse fail-closed.
    throw new Error(`topaz_slippage_too_large:${slippageBps}bps`)
  }
  const minOut = (quoted * num) / 10_000n
  // Mandatory guardrail. The Topaz Router itself reverts on minOut==0,
  // but we surface a clearer error before sending the tx.
  if (minOut <= 0n) {
    throw new Error('topaz_min_out_zero — refusing to send a swap with amountOutMin=0')
  }
  return minOut
}

async function ensureAllowance(
  signer: ethers.Wallet,
  token: string,
  spender: string,
  minAmount: bigint,
): Promise<void> {
  const erc = new ethers.Contract(token, ERC20_ABI, signer)
  const current = (await erc.allowance(signer.address, spender)) as bigint
  if (current >= minAmount) return
  // Approve max — fewer txns over the lifetime of the master wallet.
  // Approving uint256 max is the standard ERC-20 allowance pattern.
  const tx = await erc.approve(spender, ethers.MaxUint256)
  await tx.wait(1)
}

// ── Pool-state cache (view valuation only) ─────────────────────────────────
//
// Building the Topaz page does per-pool on-chain reads (v2 reserves +
// totalSupply, v3 slot0) for every LP position. Under repeated refreshes that
// hammers the BSC RPC. We cache the raw read per pool address for a short TTL
// so successive page loads reuse the same snapshot. Only the read-only
// *valuation* paths (priceV2LpPositionsUsd / priceV3PositionsUsd) use this —
// trade-execution and brain paths still call getPoolStats() for a fresh read,
// since quoting/slippage must never run on a stale snapshot. We never cache
// failures: a throwing read falls through to a fresh read next time so the
// view self-heals.
const POOL_STATE_CACHE_TTL_MS = 20_000

interface V2PoolState {
  reserve0: bigint
  reserve1: bigint
  totalSupply: bigint
  dec0: number
  dec1: number
}
interface V3PoolState {
  sqrtPriceX96: bigint
  dec0: number
  dec1: number
}
const v2PoolStateCache = new Map<string, { state: V2PoolState; ts: number }>()
const v3PoolStateCache = new Map<string, { state: V3PoolState; ts: number }>()

/** Test/ops helper: clear the Topaz pool-state valuation cache. */
export function __resetTopazPoolStateCache(): void {
  v2PoolStateCache.clear()
  v3PoolStateCache.clear()
}

async function readV2PoolStateCached(
  poolAddr: string,
  token0: string,
  token1: string,
  provider: ethers.Provider,
): Promise<V2PoolState> {
  const key = poolAddr.toLowerCase()
  const now = Date.now()
  const cached = v2PoolStateCache.get(key)
  if (cached && now - cached.ts < POOL_STATE_CACHE_TTL_MS) return cached.state
  const pair = new ethers.Contract(poolAddr, TOPAZ_V2_PAIR_ABI, provider)
  const erc0 = new ethers.Contract(token0, ERC20_ABI, provider)
  const erc1 = new ethers.Contract(token1, ERC20_ABI, provider)
  const [reserve0, reserve1, totalSupply, dec0, dec1] = await Promise.all([
    pair.reserve0() as Promise<bigint>,
    pair.reserve1() as Promise<bigint>,
    pair.totalSupply() as Promise<bigint>,
    (erc0.decimals() as Promise<bigint>).then((d) => Number(d)).catch(() => 18),
    (erc1.decimals() as Promise<bigint>).then((d) => Number(d)).catch(() => 18),
  ])
  const state: V2PoolState = { reserve0, reserve1, totalSupply, dec0, dec1 }
  v2PoolStateCache.set(key, { state, ts: now })
  return state
}

async function readV3PoolStateCached(
  poolAddr: string,
  token0: string,
  token1: string,
  provider: ethers.Provider,
): Promise<V3PoolState> {
  const key = poolAddr.toLowerCase()
  const now = Date.now()
  const cached = v3PoolStateCache.get(key)
  if (cached && now - cached.ts < POOL_STATE_CACHE_TTL_MS) return cached.state
  const pool = new ethers.Contract(poolAddr, TOPAZ_CL_POOL_ABI, provider)
  const erc0 = new ethers.Contract(token0, ERC20_ABI, provider)
  const erc1 = new ethers.Contract(token1, ERC20_ABI, provider)
  const [slot0, dec0, dec1] = await Promise.all([
    pool.slot0() as Promise<[bigint, bigint, bigint, bigint, bigint, boolean]>,
    (erc0.decimals() as Promise<bigint>).then((d) => Number(d)).catch(() => 18),
    (erc1.decimals() as Promise<bigint>).then((d) => Number(d)).catch(() => 18),
  ])
  const state: V3PoolState = { sqrtPriceX96: slot0[0], dec0, dec1 }
  v3PoolStateCache.set(key, { state, ts: now })
  return state
}

// ── Read paths ───────────────────────────────────────────────────────────

export interface PoolStats {
  address: string
  type: 'v2' | 'v3'
  token0: string
  token1: string
  // v2 only
  reserve0?: bigint
  reserve1?: bigint
  stable?: boolean
  // v3 only
  tick?: number
  sqrtPriceX96?: bigint
  liquidity?: bigint
  fee?: number
  tickSpacing?: number
}

/**
 * Read on-chain stats for a pool. Auto-detects v2 vs v3 by attempting
 * the v3-only slot0() call first; if it reverts, falls back to v2's
 * reserve0/reserve1. Throws `topaz_pool_not_found` if neither path
 * succeeds — caller treats this as "refuse to trade against this pool".
 */
export async function getPoolStats(poolAddr: string): Promise<PoolStats> {
  if (!ethers.isAddress(poolAddr)) throw new Error(`topaz_invalid_pool_address:${poolAddr}`)
  const provider = activeDeps.buildProvider()
  const addr = ethers.getAddress(poolAddr)
  // Try v3 first.
  try {
    const v3 = new ethers.Contract(addr, TOPAZ_CL_POOL_ABI, provider)
    const [token0, token1, slot0, liquidity, fee, tickSpacing] = await Promise.all([
      v3.token0() as Promise<string>,
      v3.token1() as Promise<string>,
      v3.slot0() as Promise<[bigint, bigint, bigint, bigint, bigint, boolean]>,
      v3.liquidity() as Promise<bigint>,
      v3.fee() as Promise<bigint>,
      v3.tickSpacing() as Promise<bigint>,
    ])
    return {
      address: addr,
      type: 'v3',
      token0,
      token1,
      tick: Number(slot0[1]),
      sqrtPriceX96: slot0[0],
      liquidity,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
    }
  } catch {
    // fall through to v2 detection
  }
  try {
    const v2 = new ethers.Contract(addr, TOPAZ_V2_PAIR_ABI, provider)
    const [token0, token1, r0, r1, stable] = await Promise.all([
      v2.token0() as Promise<string>,
      v2.token1() as Promise<string>,
      v2.reserve0() as Promise<bigint>,
      v2.reserve1() as Promise<bigint>,
      v2.stable() as Promise<boolean>,
    ])
    return { address: addr, type: 'v2', token0, token1, reserve0: r0, reserve1: r1, stable }
  } catch {
    throw new Error(`topaz_pool_not_found:${addr}`)
  }
}

export interface SwapRoute {
  // 'v2' = single-pool Router.getAmountsOut/swapExactTokensForTokens.
  // 'mixed' = packed-path via MixedRouteQuoterV1 (off-chain quote only
  // in Phase 1; execution path is deferred).
  kind: 'v2' | 'mixed'
  // v2: hop list — each (from,to,stable).
  hops?: Array<{ from: string; to: string; stable: boolean }>
  // mixed: pre-packed bytes path (see TOPAZ_MIXED_QUOTER_ABI).
  path?: string
}

export interface SwapQuote {
  amountOut: bigint
  route: SwapRoute
}

/**
 * Quote a swap. Always uses an actual contract read (never an
 * off-chain price hint) so the brain can't trick the executor with a
 * fabricated number. Returns the raw bigint amountOut — caller is
 * responsible for applying slippage and decimal scaling.
 */
export async function quoteSwap(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  route: SwapRoute,
): Promise<SwapQuote> {
  if (amountIn <= 0n) throw new Error('topaz_invalid_amount_in')
  const cfg = getTopazConfig()
  const provider = activeDeps.buildProvider()

  if (route.kind === 'v2') {
    const router = requireAddress(cfg, 'router')
    const hops = route.hops ?? []
    if (hops.length === 0) throw new Error('topaz_route_missing_hops')
    if (hops[0].from.toLowerCase() !== tokenIn.toLowerCase()) {
      throw new Error('topaz_route_first_hop_mismatch')
    }
    if (hops[hops.length - 1].to.toLowerCase() !== tokenOut.toLowerCase()) {
      throw new Error('topaz_route_last_hop_mismatch')
    }
    const r = new ethers.Contract(router, TOPAZ_ROUTER_ABI, provider)
    const amounts = (await r.getAmountsOut(amountIn, hops)) as bigint[]
    const out = amounts[amounts.length - 1]
    if (out <= 0n) throw new Error('topaz_quote_zero')
    return { amountOut: out, route }
  }

  // mixed
  const quoter = requireAddress(cfg, 'mixedQuoter')
  if (!route.path) throw new Error('topaz_mixed_route_missing_path')
  const q = new ethers.Contract(quoter, TOPAZ_MIXED_QUOTER_ABI, provider)
  // quoteExactInput is a state-changing method on-paper but the quoter
  // contract is gas-only — callStatic via .staticCall in ethers v6.
  const res = (await q.quoteExactInput.staticCall(route.path, amountIn)) as [bigint, ...unknown[]]
  const out = res[0]
  if (out <= 0n) throw new Error('topaz_quote_zero')
  return { amountOut: out, route }
}

// ── Write paths ──────────────────────────────────────────────────────────

export interface SwapResult {
  ok: boolean
  txHash?: string
  amountOut?: bigint
  amountOutMin?: bigint
  error?: string
}

/**
 * Execute a v2 swap with mandatory pre-trade quote + slippage cap +
 * deadline. Mixed-route execution is not enabled in Phase 1 — quote
 * works, but executing through the v3 SwapRouter is deferred.
 */
export async function swap(
  args: {
    tokenIn: string
    tokenOut: string
    amountIn: bigint
    route: SwapRoute
    slippageBps?: number
    deadlineSec?: number
    // Phase 2: when set, the trade signs from this user's BSC wallet
    // instead of the master wallet. Omit for the autonomous agent path.
    userId?: string
    // Broker spread fee context. When set, fee is pre-deducted from
    // amountIn (in tokenIn) and the swap proceeds with the net. Skip
    // when called from the master-wallet-only Phase 1 agent path.
    feeCtx?: import('./brokerFees').FeeContext
  },
): Promise<SwapResult> {
  try {
    if (args.route.kind !== 'v2') {
      throw new Error('topaz_mixed_swap_not_enabled_phase1')
    }
    const { signer, address, cfg } = await resolveSigner({ userId: args.userId })
    const router = requireAddress(cfg, 'router')

    // Broker spread fee: pre-deduct from input token (fail-closed). The
    // private key is read from the resolved signer so we don't have to
    // re-do the wallet lookup. We do this BEFORE re-quoting so the
    // quote reflects the actual net amount that will be swapped.
    let netAmountIn = args.amountIn
    if (args.feeCtx && args.amountIn > 0n) {
      // signer.privateKey is available on ethers.Wallet — resolveSigner
      // always returns a Wallet (never a JsonRpcSigner) in this codebase.
      const pk = (signer as any).privateKey as string
      if (!pk) throw new Error('topaz_fee_unsupported_signer')
      const r = await activeDeps.chargeErc20Fee(pk, args.tokenIn, args.amountIn, {
        ...args.feeCtx, venue: 'topaz', side: 'swap',
      })
      netAmountIn = r.netWei
    }

    // Re-quote on-chain so the executor never trusts a stale price.
    const quote = await quoteSwap(args.tokenIn, args.tokenOut, netAmountIn, args.route)
    // Server-side slippage CAP (not floor): if caller specified an
    // override, clamp it to cfg.maxSlippageBps so a buggy/hostile
    // upstream can't force adverse fills. Default is used when caller
    // didn't specify anything.
    const slippageBps = Math.min(
      cfg.maxSlippageBps,
      args.slippageBps ?? cfg.defaultSlippageBps,
    )
    const minOut = applySlippage(quote.amountOut, slippageBps)
    const deadline = computeDeadline(cfg, args.deadlineSec)

    await ensureAllowance(signer, args.tokenIn, router, netAmountIn)

    const r = new ethers.Contract(router, TOPAZ_ROUTER_ABI, signer)
    const tx = await r.swapExactTokensForTokens(
      netAmountIn,
      minOut,
      args.route.hops,
      address,
      deadline,
    )
    const receipt = await tx.wait(1)
    return { ok: true, txHash: receipt?.hash ?? tx.hash, amountOut: quote.amountOut, amountOutMin: minOut }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface AddV2LiquidityArgs {
  tokenA: string
  tokenB: string
  stable: boolean
  amountADesired: bigint
  amountBDesired: bigint
  slippageBps?: number
  deadlineSec?: number
  userId?: string
}

export interface AddV2LiquidityResult {
  ok: boolean
  txHash?: string
  amountA?: bigint
  amountB?: bigint
  liquidity?: bigint
  error?: string
}

export async function addV2Liquidity(args: AddV2LiquidityArgs): Promise<AddV2LiquidityResult> {
  try {
    if (args.amountADesired <= 0n || args.amountBDesired <= 0n) {
      throw new Error('topaz_invalid_lp_amounts')
    }
    const { signer, address, cfg } = await resolveSigner({ userId: args.userId })
    const router = requireAddress(cfg, 'router')

    // Verify the pair exists. pairFor is deterministic — if the pair
    // hasn't been created on-chain yet we'd be funding a brand-new
    // pool and inheriting its initial-price risk; refuse fail-closed.
    const r = new ethers.Contract(router, TOPAZ_ROUTER_ABI, signer)
    const pair = (await r.pairFor(args.tokenA, args.tokenB, args.stable)) as string
    try {
      await getPoolStats(pair)
    } catch {
      throw new Error(`topaz_pool_not_found:${pair} (router.pairFor returned an address that doesn't expose v2 reserves)`)
    }

    // Server-side slippage CAP (see comment in swap()).
    const slip = Math.min(cfg.maxSlippageBps, args.slippageBps ?? cfg.defaultSlippageBps)
    const minA = applySlippage(args.amountADesired, slip)
    const minB = applySlippage(args.amountBDesired, slip)
    const deadline = computeDeadline(cfg, args.deadlineSec)

    await Promise.all([
      ensureAllowance(signer, args.tokenA, router, args.amountADesired),
      ensureAllowance(signer, args.tokenB, router, args.amountBDesired),
    ])

    const tx = await r.addLiquidity(
      args.tokenA,
      args.tokenB,
      args.stable,
      args.amountADesired,
      args.amountBDesired,
      minA,
      minB,
      address,
      deadline,
    )
    const receipt = await tx.wait(1)
    return { ok: true, txHash: receipt?.hash ?? tx.hash }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface RemoveV2LiquidityArgs {
  tokenA: string
  tokenB: string
  stable: boolean
  liquidity: bigint
  amountAMin: bigint
  amountBMin: bigint
  deadlineSec?: number
  userId?: string
}

export async function removeV2Liquidity(args: RemoveV2LiquidityArgs): Promise<SwapResult> {
  try {
    if (args.liquidity <= 0n) throw new Error('topaz_invalid_lp_burn_amount')
    if (args.amountAMin <= 0n || args.amountBMin <= 0n) {
      throw new Error('topaz_remove_lp_min_zero')
    }
    const { signer, address, cfg } = await resolveSigner({ userId: args.userId })
    const router = requireAddress(cfg, 'router')
    const deadline = computeDeadline(cfg, args.deadlineSec)
    const pair = (await new ethers.Contract(router, TOPAZ_ROUTER_ABI, signer)
      .pairFor(args.tokenA, args.tokenB, args.stable)) as string
    await ensureAllowance(signer, pair, router, args.liquidity)
    const r = new ethers.Contract(router, TOPAZ_ROUTER_ABI, signer)
    const tx = await r.removeLiquidity(
      args.tokenA,
      args.tokenB,
      args.stable,
      args.liquidity,
      args.amountAMin,
      args.amountBMin,
      address,
      deadline,
    )
    const receipt = await tx.wait(1)
    return { ok: true, txHash: receipt?.hash ?? tx.hash }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface MintV3PositionArgs {
  pool: string
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
  slippageBps?: number
  deadlineSec?: number
  // When true, refuse the mint if the current tick is outside
  // [tickLower, tickUpper] — an out-of-range CL position earns ZERO
  // fees and ZERO emissions until the price re-enters range.
  // The brain should set this to true for any farming position.
  intendsToFarm: boolean
  userId?: string
}

export interface MintV3PositionResult {
  ok: boolean
  txHash?: string
  tokenId?: bigint
  liquidity?: bigint
  error?: string
}

export async function mintV3Position(args: MintV3PositionArgs): Promise<MintV3PositionResult> {
  try {
    if (args.tickLower >= args.tickUpper) {
      throw new Error(`topaz_invalid_tick_range: ${args.tickLower} >= ${args.tickUpper}`)
    }
    if (args.amount0Desired <= 0n && args.amount1Desired <= 0n) {
      throw new Error('topaz_v3_mint_zero_amounts')
    }
    const { signer, address, cfg } = await resolveSigner({ userId: args.userId })
    const npm = requireAddress(cfg, 'npm')

    // Resolve pool stats + tickSpacing. getPoolStats throws if the pool
    // doesn't exist or isn't a v3 CLPool — fail closed.
    const stats = await getPoolStats(args.pool)
    if (stats.type !== 'v3' || stats.tick === undefined || stats.tickSpacing === undefined) {
      throw new Error(`topaz_pool_not_v3:${args.pool}`)
    }
    if (args.tickLower % stats.tickSpacing !== 0 || args.tickUpper % stats.tickSpacing !== 0) {
      throw new Error(`topaz_ticks_not_aligned_to_spacing:${stats.tickSpacing}`)
    }
    if (args.intendsToFarm) {
      if (stats.tick < args.tickLower || stats.tick > args.tickUpper) {
        throw new Error(
          `topaz_out_of_range_mint_refused: pool tick ${stats.tick} not in [${args.tickLower}, ${args.tickUpper}] — would earn ZERO emissions`,
        )
      }
    }

    // Server-side slippage CAP (see comment in swap()).
    const slip = Math.min(cfg.maxSlippageBps, args.slippageBps ?? cfg.defaultSlippageBps)
    const min0 = args.amount0Desired > 0n ? applySlippage(args.amount0Desired, slip) : 0n
    const min1 = args.amount1Desired > 0n ? applySlippage(args.amount1Desired, slip) : 0n
    const deadline = computeDeadline(cfg, args.deadlineSec)

    await Promise.all([
      args.amount0Desired > 0n ? ensureAllowance(signer, stats.token0, npm, args.amount0Desired) : Promise.resolve(),
      args.amount1Desired > 0n ? ensureAllowance(signer, stats.token1, npm, args.amount1Desired) : Promise.resolve(),
    ])

    const n = new ethers.Contract(npm, TOPAZ_NPM_ABI, signer)
    const tx = await n.mint({
      token0: stats.token0,
      token1: stats.token1,
      tickSpacing: stats.tickSpacing,
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      amount0Desired: args.amount0Desired,
      amount1Desired: args.amount1Desired,
      amount0Min: min0,
      amount1Min: min1,
      recipient: address,
      deadline,
      sqrtPriceX96: 0n,
    })
    const receipt = await tx.wait(1)
    return { ok: true, txHash: receipt?.hash ?? tx.hash }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function burnV3Position(
  tokenId: bigint,
  deadlineSec?: number,
  opts?: { userId?: string },
): Promise<SwapResult> {
  try {
    if (tokenId <= 0n) throw new Error('topaz_invalid_token_id')
    const { signer, address, cfg } = await resolveSigner({ userId: opts?.userId })
    const npm = requireAddress(cfg, 'npm')
    const n = new ethers.Contract(npm, TOPAZ_NPM_ABI, signer)

    // 1. Fetch the position to learn its liquidity.
    const pos = (await n.positions(tokenId)) as {
      liquidity: bigint
    }
    const deadline = computeDeadline(cfg, deadlineSec)

    // 2. Decrease liquidity. Use staticCall first to learn the
    // protocol-quoted amounts, then enforce a slippage-bounded min on
    // the real send. Removes the previous `amount0Min: 0n, amount1Min: 0n`
    // exposure (reviewer flagged) — a sandwich attacker could otherwise
    // skim the entire exit through frontrun + backrun on a single tx.
    if (pos.liquidity > 0n) {
      const cfg = getTopazConfig()
      let q0: bigint = 0n, q1: bigint = 0n
      try {
        const quoted = await n.decreaseLiquidity.staticCall({
          tokenId,
          liquidity: pos.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline,
        }) as { 0?: bigint; 1?: bigint } | [bigint, bigint]
        if (Array.isArray(quoted)) { q0 = quoted[0]; q1 = quoted[1] }
        else { q0 = (quoted as any).amount0 ?? quoted[0] ?? 0n; q1 = (quoted as any).amount1 ?? quoted[1] ?? 0n }
      } catch {
        // staticCall not supported on this NPM impl — refuse with a
        // fail-closed marker rather than send a 0-min tx.
        throw new Error('topaz_burn_static_call_unsupported — cannot derive safe minOut, refusing to burn unsafely')
      }
      const slipCap = cfg.maxSlippageBps
      const amount0Min = q0 > 0n ? applySlippage(q0, slipCap) : 0n
      const amount1Min = q1 > 0n ? applySlippage(q1, slipCap) : 0n
      const tx1 = await n.decreaseLiquidity({
        tokenId,
        liquidity: pos.liquidity,
        amount0Min,
        amount1Min,
        deadline,
      })
      await tx1.wait(1)
    }

    // 3. Collect accumulated fees + the removed liquidity output.
    const max128 = (1n << 128n) - 1n
    const tx2 = await n.collect({
      tokenId,
      recipient: address,
      amount0Max: max128,
      amount1Max: max128,
    })
    await tx2.wait(1)

    // 4. Burn the now-empty NFT.
    const tx3 = await n.burn(tokenId)
    const receipt = await tx3.wait(1)
    return { ok: true, txHash: receipt?.hash ?? tx3.hash }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── Gauge / emissions ────────────────────────────────────────────────────

export async function stakeInGauge(
  args: { gauge: string; kind: 'v2' | 'v3'; lpAmount?: bigint; tokenId?: bigint },
): Promise<SwapResult> {
  try {
    if (!ethers.isAddress(args.gauge)) throw new Error(`topaz_invalid_gauge:${args.gauge}`)
    const { signer, cfg } = await getMasterSigner()
    if (args.kind === 'v2') {
      if (!args.lpAmount || args.lpAmount <= 0n) throw new Error('topaz_v2_stake_zero_amount')
      // v2 Gauge.deposit pulls the LP token via transferFrom — must
      // approve the gauge for the LP amount first.
      // The LP token IS the pair address; the gauge contract itself is
      // the LP-holder when staked. We don't know the LP address here
      // without a Voter.gauges() lookup; require caller to resolve it.
      // Instead, take a permissive approach: the LP token must already
      // be approved (caller's responsibility — addV2Liquidity user can
      // approve the gauge separately, or we expose a helper later).
      const g = new ethers.Contract(args.gauge, TOPAZ_GAUGE_ABI, signer)
      const tx = await g.deposit(args.lpAmount)
      const receipt = await tx.wait(1)
      return { ok: true, txHash: receipt?.hash ?? tx.hash }
    }
    // v3 — CLGauge.deposit pulls the NFT via safeTransferFrom.
    if (!args.tokenId || args.tokenId <= 0n) throw new Error('topaz_v3_stake_no_token_id')
    const npm = requireAddress(cfg, 'npm')
    const npmCtr = new ethers.Contract(npm, TOPAZ_NPM_ABI, signer)
    const isApproved = (await npmCtr.isApprovedForAll(signer.address, args.gauge)) as boolean
    if (!isApproved) {
      const approve = await npmCtr.setApprovalForAll(args.gauge, true)
      await approve.wait(1)
    }
    const g = new ethers.Contract(args.gauge, TOPAZ_CL_GAUGE_ABI, signer)
    const tx = await g.deposit(args.tokenId)
    const receipt = await tx.wait(1)
    return { ok: true, txHash: receipt?.hash ?? tx.hash }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function unstakeFromGauge(
  args: { gauge: string; kind: 'v2' | 'v3'; lpAmount?: bigint; tokenId?: bigint },
): Promise<SwapResult> {
  try {
    const { signer } = await getMasterSigner()
    if (args.kind === 'v2') {
      if (!args.lpAmount || args.lpAmount <= 0n) throw new Error('topaz_v2_unstake_zero')
      const g = new ethers.Contract(args.gauge, TOPAZ_GAUGE_ABI, signer)
      const tx = await g.withdraw(args.lpAmount)
      const receipt = await tx.wait(1)
      return { ok: true, txHash: receipt?.hash ?? tx.hash }
    }
    if (!args.tokenId || args.tokenId <= 0n) throw new Error('topaz_v3_unstake_no_token_id')
    const g = new ethers.Contract(args.gauge, TOPAZ_CL_GAUGE_ABI, signer)
    const tx = await g.withdraw(args.tokenId)
    const receipt = await tx.wait(1)
    return { ok: true, txHash: receipt?.hash ?? tx.hash }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function claimGaugeRewards(
  args: { gauge: string; kind: 'v2' | 'v3'; tokenId?: bigint; userId?: string },
): Promise<SwapResult & { claimed?: bigint }> {
  try {
    if (!ethers.isAddress(args.gauge)) throw new Error(`topaz_invalid_gauge:${args.gauge}`)
    // userId set → sign from that user's BSC wallet (mini-app Claim
    // button); omitted → master wallet (autonomous agent path).
    const { signer, address } = await resolveSigner({ userId: args.userId })
    if (args.kind === 'v2') {
      const g = new ethers.Contract(args.gauge, TOPAZ_GAUGE_ABI, signer)
      const tx = await g.getReward(address)
      const receipt = await tx.wait(1)
      return { ok: true, txHash: receipt?.hash ?? tx.hash }
    }
    if (!args.tokenId || args.tokenId <= 0n) throw new Error('topaz_v3_claim_no_token_id')
    const g = new ethers.Contract(args.gauge, TOPAZ_CL_GAUGE_ABI, signer)
    const tx = await g.getReward(args.tokenId)
    const receipt = await tx.wait(1)
    return { ok: true, txHash: receipt?.hash ?? tx.hash }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── Claim-request validation (shared with POST /api/topaz/claim) ──────────

export interface ParsedClaimRequest {
  gauge: string
  kind: 'v2' | 'v3'
  tokenId?: bigint
}

export type ClaimRequestResult =
  | { ok: true; value: ParsedClaimRequest }
  | { ok: false; error: string }

/**
 * Validate + normalize a raw /api/topaz/claim request body. Centralized
 * so the HTTP endpoint stays thin and the rules are unit-testable without
 * booting the whole server. Mirrors the on-chain guards in
 * claimGaugeRewards: a malformed gauge address is rejected up-front
 * (fail-closed) rather than discovered downstream as a 500.
 */
export function parseClaimRequest(body: unknown): ClaimRequestResult {
  const b = (body ?? {}) as { gauge?: unknown; kind?: unknown; tokenId?: unknown }
  if (!b.gauge || typeof b.gauge !== 'string') {
    return { ok: false, error: 'gauge required' }
  }
  if (!ethers.isAddress(b.gauge)) {
    return { ok: false, error: `topaz_invalid_gauge:${b.gauge}` }
  }
  if (b.kind !== 'v2' && b.kind !== 'v3') {
    return { ok: false, error: "kind must be 'v2' or 'v3'" }
  }
  if (b.kind === 'v3' && !b.tokenId) {
    return { ok: false, error: 'tokenId required for v3 claim' }
  }
  let tokenId: bigint | undefined
  if (b.tokenId !== undefined && b.tokenId !== null && b.tokenId !== '') {
    try {
      tokenId = BigInt(b.tokenId as string | number | bigint)
    } catch {
      return { ok: false, error: 'tokenId must be an integer' }
    }
    if (tokenId <= 0n) return { ok: false, error: 'tokenId must be a positive integer' }
  }
  return { ok: true, value: { gauge: b.gauge, kind: b.kind, tokenId } }
}

export interface ClaimAllResultItem {
  gauge: string
  kind: 'v2' | 'v3'
  tokenId?: string
  label: string
  ok: boolean
  txHash?: string
  error?: string
}

export interface ClaimAllResult {
  ok: boolean
  claimedCount: number
  failedCount: number
  results: ClaimAllResultItem[]
  error?: string
}

// A single position the caller wants claimed, used to scope claimAllGaugeRewards
// to a subset (e.g. retrying only the gauges that failed a previous run).
export interface ClaimTarget {
  gauge: string
  kind: 'v2' | 'v3'
  tokenId?: string | bigint
}

// Stable identity for a claim position: (kind, lowercased gauge, tokenId). Used
// to match caller-supplied targets against discovered positions. v2 positions
// have no tokenId so it collapses to an empty segment.
function claimItemKey(kind: 'v2' | 'v3', gauge: string, tokenId?: bigint): string {
  return `${kind}:${gauge.toLowerCase()}:${tokenId !== undefined ? tokenId.toString() : ''}`
}

function claimTargetKey(t: ClaimTarget): string {
  const tokenId = t.tokenId !== undefined && t.tokenId !== null && `${t.tokenId}` !== ''
    ? BigInt(t.tokenId)
    : undefined
  return claimItemKey(t.kind, t.gauge, tokenId)
}

/**
 * Claim every open gauge with claimable > 0 for the caller's wallet in a
 * single action. Discovers both v3 NFT positions (CLGauge.getReward by
 * tokenId) and v2 LP positions (Gauge.getReward by address), then claims
 * each sequentially, reporting per-gauge success/failure. We claim
 * sequentially rather than via multicall because every gauge.getReward
 * pays out to the position owner directly — there's no router-level
 * batch-claim entrypoint on Topaz, and sequential txns keep nonce
 * handling simple on the user's single custodial wallet. A failure on one
 * gauge never aborts the rest; the caller surfaces the aggregate.
 */
export async function claimAllGaugeRewards(
  args: { userId?: string; targets?: ClaimTarget[] },
): Promise<ClaimAllResult> {
  try {
    // Resolve the signer once to learn which wallet to enumerate. This
    // also fails closed early if the user has no active BSC wallet.
    const { address } = await resolveSigner({ userId: args.userId })
    const [v3, v2] = await Promise.all([
      listOpenLpPositions(address, { withEmissions: true }),
      listV2LpPositions(address),
    ])
    let items: Array<{ gauge: string; kind: 'v2' | 'v3'; tokenId?: bigint; label: string }> = []
    for (const p of v3) {
      if (p.gauge && p.claimable !== undefined && p.claimable > 0n) {
        items.push({ gauge: p.gauge, kind: 'v3', tokenId: p.tokenId, label: `#${p.tokenId.toString()}` })
      }
    }
    for (const p of v2) {
      if (p.gauge && p.claimable > 0n) {
        items.push({ gauge: p.gauge, kind: 'v2', label: `${p.token0Symbol}/${p.token1Symbol}` })
      }
    }
    // Optional retry path: when the caller passes a target subset (e.g. only
    // the gauges that failed a previous claim-all), keep just those positions
    // and skip everything else. Targets are matched on (kind, gauge, tokenId)
    // — the same identity the mini-app keys rows by. A target that no longer
    // has claimable emissions simply won't appear in `items` and is dropped.
    if (args.targets && args.targets.length > 0) {
      const wanted = new Set(args.targets.map(claimTargetKey))
      items = items.filter((it) => wanted.has(claimItemKey(it.kind, it.gauge, it.tokenId)))
    }
    if (items.length === 0) {
      return { ok: true, claimedCount: 0, failedCount: 0, results: [] }
    }
    const results: ClaimAllResultItem[] = []
    let claimedCount = 0
    let failedCount = 0
    for (const item of items) {
      const r = await claimGaugeRewards({
        gauge: item.gauge,
        kind: item.kind,
        tokenId: item.tokenId,
        userId: args.userId,
      })
      if (r.ok) claimedCount++
      else failedCount++
      results.push({
        gauge: item.gauge,
        kind: item.kind,
        tokenId: item.tokenId?.toString(),
        label: item.label,
        ok: r.ok,
        txHash: r.txHash,
        error: r.error,
      })
    }
    return { ok: failedCount === 0, claimedCount, failedCount, results }
  } catch (err) {
    return { ok: false, claimedCount: 0, failedCount: 0, results: [], error: (err as Error).message }
  }
}

export async function getClaimableEmissions(
  gauge: string,
  walletAddr: string,
  tokenId?: bigint,
): Promise<bigint> {
  const provider = activeDeps.buildProvider()
  if (tokenId && tokenId > 0n) {
    const g = new ethers.Contract(gauge, TOPAZ_CL_GAUGE_ABI, provider)
    return (await g.earned(walletAddr, tokenId)) as bigint
  }
  const g = new ethers.Contract(gauge, TOPAZ_GAUGE_ABI, provider)
  return (await g.earned(walletAddr)) as bigint
}

// ── Wallet balances ──────────────────────────────────────────────────────

export interface WalletTokenBalance {
  symbol: string
  // null = native BNB (not an ERC-20).
  address: string | null
  decimals: number
  raw: bigint
  formatted: string
}

/**
 * Read the user's spendable balances for the headline Topaz tokens:
 * native BNB + USDT + TOPAZ. Each token is best-effort — a single
 * reverting balanceOf/decimals call is skipped rather than failing the
 * whole snapshot, so the mini-app always renders what it can. Tokens
 * that aren't configured (null address in TopazConfig) are omitted.
 */
export async function getUserWalletBalances(walletAddr: string): Promise<WalletTokenBalance[]> {
  if (!ethers.isAddress(walletAddr)) throw new Error(`topaz_invalid_wallet:${walletAddr}`)
  const cfg = getTopazConfig()
  const provider = activeDeps.buildProvider()
  const out: WalletTokenBalance[] = []

  // Native BNB first (always shown — it's the gas token).
  try {
    const raw = await provider.getBalance(walletAddr)
    out.push({ symbol: 'BNB', address: null, decimals: 18, raw, formatted: ethers.formatEther(raw) })
  } catch (e) {
    void e
  }

  const erc20s: Array<{ addr: string; fallbackSymbol: string }> = []
  if (cfg.usdtToken) erc20s.push({ addr: cfg.usdtToken, fallbackSymbol: 'USDT' })
  if (cfg.topazToken) erc20s.push({ addr: cfg.topazToken, fallbackSymbol: 'TOPAZ' })

  for (const t of erc20s) {
    try {
      const erc = new ethers.Contract(t.addr, ERC20_ABI, provider)
      const [raw, decimals, symbol] = await Promise.all([
        erc.balanceOf(walletAddr) as Promise<bigint>,
        (erc.decimals() as Promise<bigint>).then((d) => Number(d)).catch(() => 18),
        (erc.symbol() as Promise<string>).catch(() => t.fallbackSymbol),
      ])
      out.push({
        symbol: String(symbol),
        address: t.addr,
        decimals,
        raw,
        formatted: ethers.formatUnits(raw, decimals),
      })
    } catch (e) {
      void e
    }
  }
  return out
}

// ── LP-position discovery ────────────────────────────────────────────────

export interface OpenLpPosition {
  kind: 'v3-nft'
  tokenId: bigint
  token0: string
  token1: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
  tickSpacing: number
  // Enriched only when listOpenLpPositions is given a gauge list and the
  // position's pool maps to a live v3 gauge. Undefined = not resolvable
  // (no subgraph / unmatched) — the caller renders "—" rather than a fake 0.
  gauge?: string
  claimable?: bigint
  // The CL pool address backing this position, resolved during emissions
  // enrichment by matching (token0, token1, tickSpacing) against the
  // subgraph-ranked v3 gauges. Needed to read slot0 for USD valuation.
  pool?: string
}

export interface V2LpPosition {
  kind: 'v2-lp'
  pool: string
  gauge: string | null
  token0: string
  token1: string
  token0Symbol: string
  token1Symbol: string
  stable: boolean
  // Unstaked LP tokens sitting in the wallet.
  walletBalance: bigint
  // LP tokens staked in the gauge (earning emissions).
  stakedBalance: bigint
  // Claimable TOPAZ emissions on the staked balance.
  claimable: bigint
}

/**
 * Enumerate the wallet's v2 LP holdings across the known (subgraph-ranked)
 * pools. For each ranked v2 gauge we read the pair's balanceOf(wallet)
 * (unstaked LP) plus the gauge's balanceOf/earned (staked LP + claimable
 * emissions). Pools where the wallet holds nothing are dropped.
 *
 * This relies on the Goldsky subgraph to know which pools exist — without
 * it we have no on-chain way to enumerate every v2 pair the wallet ever
 * touched, so we return []. That degradation is intentional and matches
 * how getTopGaugesByApr already behaves.
 */
export async function listV2LpPositions(walletAddr: string): Promise<V2LpPosition[]> {
  if (!ethers.isAddress(walletAddr)) throw new Error(`topaz_invalid_wallet:${walletAddr}`)
  const provider = activeDeps.buildProvider()
  const gauges = await getTopGaugesByApr(50)
  const v2Gauges = gauges.filter((g) => !g.isV3 && ethers.isAddress(g.pool))
  const out: V2LpPosition[] = []
  for (const g of v2Gauges) {
    try {
      const pair = new ethers.Contract(g.pool, TOPAZ_V2_PAIR_ABI, provider)
      const [token0, token1, stable, walletBalance] = await Promise.all([
        pair.token0() as Promise<string>,
        pair.token1() as Promise<string>,
        (pair.stable() as Promise<boolean>).catch(() => false),
        pair.balanceOf(walletAddr) as Promise<bigint>,
      ])
      let stakedBalance = 0n
      let claimable = 0n
      const gaugeAddr = ethers.isAddress(g.gauge) ? ethers.getAddress(g.gauge) : null
      if (gaugeAddr) {
        const gc = new ethers.Contract(gaugeAddr, TOPAZ_GAUGE_ABI, provider)
        const [bal, earned] = await Promise.all([
          (gc.balanceOf(walletAddr) as Promise<bigint>).catch(() => 0n),
          (gc.earned(walletAddr) as Promise<bigint>).catch(() => 0n),
        ])
        stakedBalance = bal
        claimable = earned
      }
      // Drop pools the wallet has no stake in at all.
      if (walletBalance === 0n && stakedBalance === 0n && claimable === 0n) continue
      out.push({
        kind: 'v2-lp',
        pool: ethers.getAddress(g.pool),
        gauge: gaugeAddr,
        token0,
        token1,
        token0Symbol: g.token0Symbol,
        token1Symbol: g.token1Symbol,
        stable,
        walletBalance,
        stakedBalance,
        claimable,
      })
    } catch (e) {
      // One bad pool shouldn't poison the whole list.
      void e
    }
  }
  return out
}

/**
 * Enumerate the master wallet's v3 NFT positions via NPM.balanceOf +
 * tokenOfOwnerByIndex. v2 LP discovery is intentionally out-of-scope
 * here — the master wallet's v2 staked balance is read from the gauge
 * directly (single Gauge.balanceOf call) when needed.
 */
export async function listOpenLpPositions(
  walletAddr: string,
  opts?: { withEmissions?: boolean },
): Promise<OpenLpPosition[]> {
  const cfg = getTopazConfig()
  if (!cfg.npm) return []
  const provider = activeDeps.buildProvider()
  const n = new ethers.Contract(cfg.npm, TOPAZ_NPM_ABI, provider)
  const bal = Number((await n.balanceOf(walletAddr)) as bigint)
  if (bal === 0) return []
  const positions: OpenLpPosition[] = []
  for (let i = 0; i < bal; i++) {
    try {
      const tokenId = (await n.tokenOfOwnerByIndex(walletAddr, i)) as bigint
      const pos = (await n.positions(tokenId)) as {
        token0: string
        token1: string
        tickSpacing: bigint
        tickLower: bigint
        tickUpper: bigint
        liquidity: bigint
      }
      if (pos.liquidity === 0n) continue
      positions.push({
        kind: 'v3-nft',
        tokenId,
        token0: pos.token0,
        token1: pos.token1,
        tickLower: Number(pos.tickLower),
        tickUpper: Number(pos.tickUpper),
        liquidity: pos.liquidity,
        tickSpacing: Number(pos.tickSpacing),
      })
    } catch (e) {
      // skip enumeration errors silently — these are rare and we don't
      // want one bad NFT to poison the whole list.
      void e
    }
  }
  // Optional enrichment: resolve each position's CL gauge + claimable
  // TOPAZ emissions. Best-effort and gated behind a flag because it costs
  // one getPoolStats read per ranked v3 gauge — the autonomous agent path
  // doesn't need it, only the mini-app's "Claim" UI does.
  if (opts?.withEmissions && positions.length > 0) {
    try {
      await enrichV3Emissions(positions, walletAddr, provider)
    } catch (e) {
      // Enrichment never fails the core listing — emissions just stay "—".
      console.warn('[topazTrading] v3 emissions enrich failed:', (e as Error).message)
    }
  }
  return positions
}

/**
 * Resolve gauge + claimable emissions for each v3 position by matching
 * its (token0, token1, tickSpacing) against the subgraph-ranked v3
 * gauges' pools. Mutates `positions` in place. Silent per-gauge failures
 * — an unmatched position simply keeps `gauge`/`claimable` undefined.
 */
async function enrichV3Emissions(
  positions: OpenLpPosition[],
  walletAddr: string,
  provider: ethers.AbstractProvider,
): Promise<void> {
  const gauges = await getTopGaugesByApr(50)
  const v3Gauges = gauges.filter((g) => g.isV3 && ethers.isAddress(g.pool) && ethers.isAddress(g.gauge))
  if (v3Gauges.length === 0) return
  // Build pool-key → gauge/pool maps by reading each v3 pool's identity once.
  const keyToGauge = new Map<string, string>()
  const keyToPool = new Map<string, string>()
  for (const g of v3Gauges) {
    try {
      const stats = await getPoolStats(g.pool)
      if (stats.type !== 'v3' || stats.tickSpacing === undefined) continue
      const key = v3Key(stats.token0, stats.token1, stats.tickSpacing)
      keyToGauge.set(key, ethers.getAddress(g.gauge))
      keyToPool.set(key, ethers.getAddress(g.pool))
    } catch (e) {
      void e
    }
  }
  if (keyToGauge.size === 0) return
  for (const p of positions) {
    const key = v3Key(p.token0, p.token1, p.tickSpacing)
    // Record the backing pool even when the gauge match fails, so USD
    // valuation can still read slot0.
    const pool = keyToPool.get(key)
    if (pool) p.pool = pool
    const gauge = keyToGauge.get(key)
    if (!gauge) continue
    p.gauge = gauge
    try {
      const gc = new ethers.Contract(gauge, TOPAZ_CL_GAUGE_ABI, provider)
      p.claimable = (await gc.earned(walletAddr, p.tokenId)) as bigint
    } catch (e) {
      // Position not staked / gauge read failed → leave claimable unset.
      void e
    }
  }
}

function v3Key(token0: string, token1: string, tickSpacing: number): string {
  return `${token0.toLowerCase()}-${token1.toLowerCase()}-${tickSpacing}`
}

// ── USD valuation ────────────────────────────────────────────────────────
//
// Approximate USD figures for the mini-app's Topaz page. Every value is
// best-effort: any token DexScreener can't price, or any pool read that
// reverts, yields `null` so the UI shows "—" instead of a fabricated $0.

const Q96 = 2 ** 96

export interface PricedWalletBalance extends WalletTokenBalance {
  priceUsd: number | null
  usdValue: number | null
}

export interface PricedV2LpPosition extends V2LpPosition {
  // USD value of (wallet + staked) LP tokens.
  usdValue: number | null
  // USD value of claimable TOPAZ emissions.
  claimableUsd: number | null
}

export interface PricedV3Position extends OpenLpPosition {
  usdValue: number | null
  claimableUsd: number | null
}

function finiteOrNull(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null
  return n
}

/**
 * Compute the underlying token0/token1 amounts (in raw on-chain units, as
 * floats) for a concentrated-liquidity position given the pool's current
 * sqrtPriceX96 and the position's tick range + liquidity. Standard Uniswap
 * v3 math; floats are fine here because the figure is an approximation.
 */
export function v3UnderlyingAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: number; amount1: number } {
  const L = Number(liquidity)
  const sqrtP = Number(sqrtPriceX96) / Q96
  const sa = Math.pow(1.0001, tickLower / 2)
  const sb = Math.pow(1.0001, tickUpper / 2)
  if (!Number.isFinite(L) || L <= 0 || !Number.isFinite(sqrtP) || sqrtP <= 0 || sb <= sa) {
    return { amount0: 0, amount1: 0 }
  }
  let amount0 = 0
  let amount1 = 0
  if (sqrtP <= sa) {
    amount0 = L * (1 / sa - 1 / sb)
  } else if (sqrtP >= sb) {
    amount1 = L * (sb - sa)
  } else {
    amount0 = L * (1 / sqrtP - 1 / sb)
    amount1 = L * (sqrtP - sa)
  }
  return { amount0: Math.max(0, amount0), amount1: Math.max(0, amount1) }
}

/**
 * USD spot prices for a set of BSC token addresses via DexScreener, with
 * USDT pinned to $1 (it's the USD anchor — DexScreener occasionally returns
 * 0.999x which would make balances look slightly off).
 */
export async function getTopazTokenPrices(
  addresses: string[],
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Record<string, number>> {
  const { fetchBscTokenPricesUsd } = await import('./dexScreener')
  const prices = await fetchBscTokenPricesUsd(addresses, opts)
  const cfg = getTopazConfig()
  if (cfg.usdtToken) {
    const k = cfg.usdtToken.toLowerCase()
    if (prices[k] === undefined) prices[k] = 1
  }
  return prices
}

/**
 * Attach approximate USD prices + values to wallet balances. Native BNB is
 * priced via WBNB (cfg.wbnbToken). Pass a shared `prices` map to avoid an
 * extra DexScreener round-trip when the caller already fetched one.
 */
export async function priceWalletBalancesUsd(
  balances: WalletTokenBalance[],
  opts: { fetchImpl?: typeof fetch; prices?: Record<string, number> } = {},
): Promise<PricedWalletBalance[]> {
  const cfg = getTopazConfig()
  const wbnb = cfg.wbnbToken ? cfg.wbnbToken.toLowerCase() : null
  let prices = opts.prices
  if (!prices) {
    const addrs = balances
      .map((b) => (b.address ? b.address.toLowerCase() : wbnb))
      .filter((a): a is string => !!a)
    prices = await getTopazTokenPrices(addrs, opts)
  }
  return balances.map((b) => {
    const key = b.address ? b.address.toLowerCase() : wbnb
    const price = key ? prices![key] ?? null : null
    const usdValue = price != null ? Number(b.formatted) * price : null
    return { ...b, priceUsd: finiteOrNull(price), usdValue: finiteOrNull(usdValue) }
  })
}

/**
 * Attach approximate USD value to each v2 LP position. The LP share is
 * priced from the pool's reserves: value = (reserve0·p0 + reserve1·p1) ×
 * (heldLP / totalSupply). When only one side of the pair is priceable we
 * approximate the pool as 2× the priced side (valid for balanced pools).
 */
export async function priceV2LpPositionsUsd(
  positions: V2LpPosition[],
  opts: { fetchImpl?: typeof fetch; prices?: Record<string, number> } = {},
): Promise<PricedV2LpPosition[]> {
  if (positions.length === 0) return []
  const cfg = getTopazConfig()
  const provider = activeDeps.buildProvider()
  let prices = opts.prices
  if (!prices) {
    const addrs = new Set<string>()
    for (const p of positions) {
      addrs.add(p.token0.toLowerCase())
      addrs.add(p.token1.toLowerCase())
    }
    if (cfg.topazToken) addrs.add(cfg.topazToken.toLowerCase())
    prices = await getTopazTokenPrices([...addrs], opts)
  }
  const topazPrice = cfg.topazToken ? prices[cfg.topazToken.toLowerCase()] ?? null : null
  const out: PricedV2LpPosition[] = []
  for (const p of positions) {
    let usdValue: number | null = null
    try {
      const { reserve0, reserve1, totalSupply, dec0, dec1 } = await readV2PoolStateCached(
        p.pool,
        p.token0,
        p.token1,
        provider,
      )
      const price0 = prices[p.token0.toLowerCase()] ?? null
      const price1 = prices[p.token1.toLowerCase()] ?? null
      const side0 = price0 != null ? (Number(reserve0) / 10 ** dec0) * price0 : null
      const side1 = price1 != null ? (Number(reserve1) / 10 ** dec1) * price1 : null
      let reserveUsd: number | null = null
      if (side0 != null && side1 != null) reserveUsd = side0 + side1
      else if (side0 != null) reserveUsd = side0 * 2
      else if (side1 != null) reserveUsd = side1 * 2
      if (reserveUsd != null && totalSupply > 0n) {
        const share = Number(p.walletBalance + p.stakedBalance) / Number(totalSupply)
        usdValue = reserveUsd * share
      }
    } catch (e) {
      void e
    }
    const claimableUsd = topazPrice != null ? (Number(p.claimable) / 1e18) * topazPrice : null
    out.push({ ...p, usdValue: finiteOrNull(usdValue), claimableUsd: finiteOrNull(claimableUsd) })
  }
  return out
}

/**
 * Attach approximate USD value to each v3 NFT position. Requires the
 * position's backing pool (set during emissions enrichment) to read the
 * current sqrtPrice; positions whose pool couldn't be resolved get a null
 * value rather than a guess.
 */
export async function priceV3PositionsUsd(
  positions: OpenLpPosition[],
  opts: { fetchImpl?: typeof fetch; prices?: Record<string, number> } = {},
): Promise<PricedV3Position[]> {
  if (positions.length === 0) return []
  const cfg = getTopazConfig()
  const provider = activeDeps.buildProvider()
  let prices = opts.prices
  if (!prices) {
    const addrs = new Set<string>()
    for (const p of positions) {
      addrs.add(p.token0.toLowerCase())
      addrs.add(p.token1.toLowerCase())
    }
    if (cfg.topazToken) addrs.add(cfg.topazToken.toLowerCase())
    prices = await getTopazTokenPrices([...addrs], opts)
  }
  const topazPrice = cfg.topazToken ? prices[cfg.topazToken.toLowerCase()] ?? null : null
  const out: PricedV3Position[] = []
  for (const p of positions) {
    let usdValue: number | null = null
    try {
      if (p.pool && ethers.isAddress(p.pool)) {
        const { sqrtPriceX96, dec0, dec1 } = await readV3PoolStateCached(
          p.pool,
          p.token0,
          p.token1,
          provider,
        )
        const { amount0, amount1 } = v3UnderlyingAmounts(sqrtPriceX96, p.tickLower, p.tickUpper, p.liquidity)
        const price0 = prices[p.token0.toLowerCase()] ?? null
        const price1 = prices[p.token1.toLowerCase()] ?? null
        const usd0 = price0 != null ? (amount0 / 10 ** dec0) * price0 : 0
        const usd1 = price1 != null ? (amount1 / 10 ** dec1) * price1 : 0
        if (price0 != null || price1 != null) usdValue = usd0 + usd1
      }
    } catch (e) {
      void e
    }
    const claimableUsd =
      p.claimable !== undefined && topazPrice != null
        ? (Number(p.claimable) / 1e18) * topazPrice
        : null
    out.push({ ...p, usdValue: finiteOrNull(usdValue), claimableUsd: finiteOrNull(claimableUsd) })
  }
  return out
}

// ── Gauge ranking (subgraph) ─────────────────────────────────────────────

export interface RankedGauge {
  gauge: string
  pool: string
  token0Symbol: string
  token1Symbol: string
  aprPct: number
  tvlUsd: number
  isV3: boolean
}

/**
 * Pull the top-N gauges sorted by emissions APR from the Goldsky
 * subgraph. Returns [] if the subgraph isn't configured — the agent
 * brain then makes decisions from on-chain pool stats alone. We do
 * NOT throw here: ranking is informational, not load-bearing for the
 * trade itself.
 */
export async function getTopGaugesByApr(limit: number): Promise<RankedGauge[]> {
  const cfg = getTopazConfig()
  if (!cfg.subgraphV3Url && !cfg.subgraphV2Url) return []
  const urls = [cfg.subgraphV3Url, cfg.subgraphV2Url].filter((u): u is string => !!u)
  const out: RankedGauge[] = []
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `{ gauges(first: ${Math.max(1, Math.min(50, limit))}, orderBy: aprPct, orderDirection: desc, where: { isAlive: true }) { id pool { id token0 { symbol } token1 { symbol } } aprPct tvlUsd isV3 } }`,
        }),
      })
      if (!resp.ok) continue
      const json = (await resp.json()) as { data?: { gauges?: any[] } }
      const items = json?.data?.gauges ?? []
      for (const g of items) {
        out.push({
          gauge: String(g.id),
          pool: String(g.pool?.id ?? ''),
          token0Symbol: String(g.pool?.token0?.symbol ?? ''),
          token1Symbol: String(g.pool?.token1?.symbol ?? ''),
          aprPct: Number(g.aprPct ?? 0),
          tvlUsd: Number(g.tvlUsd ?? 0),
          isV3: !!g.isV3,
        })
      }
    } catch (e) {
      // Subgraph optional — never fail the agent for a subgraph hiccup.
      console.warn(`[topazTrading] subgraph fetch failed (${url}):`, (e as Error).message)
    }
  }
  return out
    .sort((a, b) => b.aprPct - a.aprPct)
    .slice(0, limit)
}

// ── Convenience: Voter introspection (read-only) ─────────────────────────

export async function resolveGaugeForPool(pool: string): Promise<string | null> {
  const cfg = getTopazConfig()
  if (!cfg.voter) return null
  try {
    const provider = activeDeps.buildProvider()
    const v = new ethers.Contract(cfg.voter, TOPAZ_VOTER_ABI, provider)
    const g = (await v.gauges(pool)) as string
    if (!g || g === ethers.ZeroAddress) return null
    return g
  } catch {
    return null
  }
}

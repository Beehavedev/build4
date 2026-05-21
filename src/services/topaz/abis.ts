// ─────────────────────────────────────────────────────────────────────────
// Topaz DEX ABI fragments — minimal selectors used by src/services/topazTrading.ts.
//
// Topaz is a ve(3,3) fork on BSC mainnet (chain 56) that exposes:
//   - Router (Velodrome-style) for v2 volatile/stable swaps and v2 LP ops.
//   - CLPool + NonfungiblePositionManager for v3 Slipstream-style
//     concentrated-liquidity LP positions.
//   - Gauge / CLGauge for staking the v2 LP token or v3 NFT and earning
//     TOPAZ emissions.
//   - MixedRouteQuoterV1 for off-chain quoting of v2+v3 mixed routes.
//
// We hand-write these fragments (instead of importing the full Topaz
// JSON ABIs) because (a) we only need ~10 selectors total, (b) the
// upstream `topazdex/agent-skill` repo isn't an npm package, and (c)
// human-readable ABI strings let the reviewer audit exactly what
// calldata leaves our wallets. Any signature drift between this file
// and the deployed contract surfaces as a `Function ... not found` or
// `decoded log mismatch` error — catchable in tests, never silent.
//
// Operating-principle gotchas (from Topaz SKILL.md, encoded next to
// the actual call sites in topazTrading.ts — repeated here so anyone
// reading the ABIs sees the contract-level invariants):
//   • Router.swapExactTokensForTokens REQUIRES `amountOutMin > 0` and
//     `deadline > block.timestamp` — never pass 0 for either.
//   • CLPool.swap REQUIRES a non-zero sqrtPriceLimitX96 sentinel
//     (MIN_SQRT_RATIO+1 / MAX_SQRT_RATIO-1) — never pass 0.
//   • NonfungiblePositionManager.mint with `tickLower==tickUpper` or
//     a range that doesn't straddle the current tick will succeed
//     but earn ZERO fees/emissions until the price re-enters range.
//     topazTrading.ts blocks the second case when intendsToFarm=true.
//   • CLGauge.deposit pulls the NFT via `safeTransferFrom`. The NFT
//     MUST be approved to the gauge (or `setApprovalForAll(gauge,true)`
//     called) before staking, else it reverts NOT_APPROVED.
//   • Voter.vote is once-per-epoch (weekly). Out of scope for Phase 1;
//     listed read-only for monitoring.
// ─────────────────────────────────────────────────────────────────────────

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const

// Velodrome-style v2 router. The `routes` tuple array carries the
// per-hop (from, to, stable) flag — `stable=true` routes through the
// constant-sum (stableswap) curve, `stable=false` through the constant-
// product (volatile) curve. Mixing v2+v3 hops is NOT supported by this
// router — for mixed routes, quote via MixedRouteQuoterV1 and execute
// via the v3 SwapRouter (separate ABI, deferred to Phase 2 until we
// need it).
export const TOPAZ_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, tuple(address from, address to, bool stable)[] routes) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, tuple(address from, address to, bool stable)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
  'function addLiquidity(address tokenA, address tokenB, bool stable, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, bool stable, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function pairFor(address tokenA, address tokenB, bool stable) view returns (address pair)',
] as const

// v2 pair (LP token) — Velodrome `Pool`.
export const TOPAZ_V2_PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function stable() view returns (bool)',
  'function reserve0() view returns (uint256)',
  'function reserve1() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
] as const

// v3 Slipstream-style concentrated-liquidity pool — readonly fields used
// for quoting + in-range checks.
export const TOPAZ_CL_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
] as const

// NonfungiblePositionManager — Uniswap V3 / Slipstream NPM.
export const TOPAZ_NPM_ABI = [
  'function mint(tuple(address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, uint160 sqrtPriceX96) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function approve(address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
] as const

// v2 Gauge — Velodrome-style staking + emissions.
export const TOPAZ_GAUGE_ABI = [
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function getReward(address account)',
  'function balanceOf(address account) view returns (uint256)',
  'function earned(address account) view returns (uint256)',
  'function rewardRate() view returns (uint256)',
  'function rewardToken() view returns (address)',
] as const

// v3 CLGauge — Slipstream-style NFT staking.
export const TOPAZ_CL_GAUGE_ABI = [
  'function deposit(uint256 tokenId)',
  'function withdraw(uint256 tokenId)',
  'function getReward(uint256 tokenId)',
  'function earned(address account, uint256 tokenId) view returns (uint256)',
  'function stakedContains(address account, uint256 tokenId) view returns (bool)',
  'function rewardToken() view returns (address)',
] as const

// MixedRouteQuoterV1 — off-chain (eth_call) quote across v2+v3 hops.
// `path` is a packed bytes blob: token(20) + flag(1) + token(20) + … where
// flag selects v2-stable / v2-volatile / v3-fee-tier. We expose it as
// `bytes` so the caller can build the packed path with ethers.solidityPacked.
export const TOPAZ_MIXED_QUOTER_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
] as const

// Voter — read-only in Phase 1 (treasury vote/bribe is a separate task).
// We include `gauges(pool)` so listOpenLpPositions can resolve which
// gauge an LP token / NFT belongs to without us having to maintain a
// static map.
export const TOPAZ_VOTER_ABI = [
  'function gauges(address pool) view returns (address)',
  'function isGauge(address gauge) view returns (bool)',
  'function isAlive(address gauge) view returns (bool)',
] as const

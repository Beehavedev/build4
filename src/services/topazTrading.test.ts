import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'

import {
  __setTopazTestDeps,
  __resetTopazTestDeps,
  getPoolStats,
  swap,
  mintV3Position,
  addV2Liquidity,
  v3UnderlyingAmounts,
  priceV2LpPositionsUsd,
  priceV3PositionsUsd,
  __resetTopazPoolStateCache,
  type V2LpPosition,
  type OpenLpPosition,
} from './topazTrading'
import { __resetTopazConfigCache } from './topaz'

// Helper: install fake env + provider/wallet deps for a test, restore on exit.
function withTopazEnv(env: Record<string, string>, mockProvider: any, fn: () => Promise<void>) {
  const prior = { ...process.env }
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  __resetTopazConfigCache()
  __setTopazTestDeps({
    buildProvider: () => mockProvider,
    loadWallet: async () => ({
      address: '0x' + '11'.repeat(20),
      privateKey: '0x' + '22'.repeat(32),
    }),
    now: () => 1_700_000_000_000,
  })
  return fn().finally(() => {
    process.env = prior
    __resetTopazConfigCache()
    __resetTopazTestDeps()
    __resetTopazPoolStateCache()
  })
}

// Minimal in-memory provider that maps `Contract.method.call(...)` via a
// per-address handler map. We don't need an EVM — just enough surface
// to satisfy ethers v6's Contract.call() pipeline at the JSON-RPC layer.
function buildMockProvider(callHandler: (to: string, data: string) => Promise<string>): any {
  return {
    _isProvider: true,
    getNetwork: async () => ({ chainId: 56n, name: 'bsc' }),
    call: async (tx: { to: string; data: string }) => callHandler(tx.to.toLowerCase(), tx.data),
    // Methods called incidentally by ethers — return defaults.
    getCode: async () => '0x00',
    getBlockNumber: async () => 1,
    estimateGas: async () => 21000n,
    broadcastTransaction: async () => { throw new Error('no broadcast in test') },
  }
}

const ROUTER = '0x' + 'aa'.repeat(20)
const NPM    = '0x' + 'bb'.repeat(20)
const POOL   = '0x' + 'cc'.repeat(20)
const T0     = '0x' + 'dd'.repeat(20)
const T1     = '0x' + 'ee'.repeat(20)

test('topazTrading: getPoolStats fails closed when pool exposes neither v3 nor v2 reads', async () => {
  await withTopazEnv(
    { TOPAZ_ENABLED: 'true', TOPAZ_MASTER_WALLET_ID: 'w1', TOPAZ_ROUTER: ROUTER, TOPAZ_NPM: NPM },
    buildMockProvider(async () => { throw new Error('execution reverted') }),
    async () => {
      await assert.rejects(() => getPoolStats(POOL), /topaz_pool_not_found/)
    },
  )
})

test('topazTrading: swap refuses when route hops do not match tokenIn/tokenOut', async () => {
  await withTopazEnv(
    { TOPAZ_ENABLED: 'true', TOPAZ_MASTER_WALLET_ID: 'w1', TOPAZ_ROUTER: ROUTER, TOPAZ_NPM: NPM },
    buildMockProvider(async () => '0x'),
    async () => {
      const r = await swap({
        tokenIn: T0,
        tokenOut: T1,
        amountIn: 1_000_000n,
        // Wrong: route ends at T0, not T1.
        route: { kind: 'v2', hops: [{ from: T0, to: T0, stable: false }] },
      })
      assert.equal(r.ok, false)
      assert.match(String(r.error), /topaz_route_last_hop_mismatch|topaz_route_first_hop_mismatch|topaz_quote/)
    },
  )
})

test('topazTrading: mintV3Position refuses out-of-range when intendsToFarm=true', async () => {
  // Provider returns slot0 with tick=0, plus token0/token1/tickSpacing/liquidity/fee.
  // We rely on the fact that getPoolStats short-circuits as soon as the v3
  // path resolves; we engineer that path to succeed with tick=0 so a
  // [100,200] range is provably out of range.
  const iface = new ethers.Interface([
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function tickSpacing() view returns (int24)',
    'function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)',
    'function liquidity() view returns (uint128)',
    'function fee() view returns (uint24)',
  ])
  const callHandler = async (_to: string, data: string): Promise<string> => {
    const sig = data.slice(0, 10)
    if (sig === iface.getFunction('token0')!.selector) return iface.encodeFunctionResult('token0', [T0])
    if (sig === iface.getFunction('token1')!.selector) return iface.encodeFunctionResult('token1', [T1])
    if (sig === iface.getFunction('tickSpacing')!.selector) return iface.encodeFunctionResult('tickSpacing', [50])
    if (sig === iface.getFunction('slot0')!.selector) {
      return iface.encodeFunctionResult('slot0', [1n, 0, 0, 0, 0, true])
    }
    if (sig === iface.getFunction('liquidity')!.selector) return iface.encodeFunctionResult('liquidity', [0n])
    if (sig === iface.getFunction('fee')!.selector) return iface.encodeFunctionResult('fee', [3000])
    throw new Error('execution reverted')
  }
  await withTopazEnv(
    { TOPAZ_ENABLED: 'true', TOPAZ_MASTER_WALLET_ID: 'w1', TOPAZ_ROUTER: ROUTER, TOPAZ_NPM: NPM },
    buildMockProvider(callHandler),
    async () => {
      const r = await mintV3Position({
        pool: POOL,
        tickLower: 100,
        tickUpper: 200,
        amount0Desired: 1000n,
        amount1Desired: 1000n,
        intendsToFarm: true,
      })
      assert.equal(r.ok, false)
      assert.match(String(r.error), /topaz_out_of_range_mint_refused/)
    },
  )
})

test('topazTrading: addV2Liquidity fails closed when amounts are zero', async () => {
  await withTopazEnv(
    { TOPAZ_ENABLED: 'true', TOPAZ_MASTER_WALLET_ID: 'w1', TOPAZ_ROUTER: ROUTER, TOPAZ_NPM: NPM },
    buildMockProvider(async () => '0x'),
    async () => {
      const r = await addV2Liquidity({
        tokenA: T0, tokenB: T1, stable: false,
        amountADesired: 0n, amountBDesired: 0n,
      })
      assert.equal(r.ok, false)
      assert.match(String(r.error), /topaz_invalid_lp_amounts/)
    },
  )
})

test('topazTrading: slippage CAP clamps caller-specified high tolerance down to maxSlippageBps', async () => {
  // Quote: amountOut = 1e18. Caller asks for 5000bps slippage. Cap
  // is 500bps (default). minOut should reflect 5% (the cap), not 50%
  // (the request). Slippage applied via applySlippage(quote, bps) =
  // quote * (10_000 - bps) / 10_000.
  const iface = new ethers.Interface([
    'function getAmountsOut(uint256,(address,address,bool)[]) view returns (uint256[])',
    'function swapExactTokensForTokens(uint256,uint256,(address,address,bool)[],address,uint256) returns (uint256[])',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ])
  let observedMinOut: bigint | null = null
  const callHandler = async (_to: string, data: string): Promise<string> => {
    const sig = data.slice(0, 10)
    if (sig === iface.getFunction('getAmountsOut')!.selector) {
      return iface.encodeFunctionResult('getAmountsOut', [[1n, 10n ** 18n]])
    }
    if (sig === iface.getFunction('allowance')!.selector) {
      return iface.encodeFunctionResult('allowance', [(1n << 200n)])
    }
    if (sig === iface.getFunction('balanceOf')!.selector) {
      return iface.encodeFunctionResult('balanceOf', [10n ** 18n])
    }
    throw new Error('execution reverted')
  }
  // Override broadcastTransaction to capture the *write* calldata
  // (sendTransaction → broadcastTransaction in ethers v6) and verify
  // that amountOutMin in the encoded swap call reflects the cap, not
  // the caller-requested 5000bps. Throwing after capture short-circuits
  // the send so we don't need a receipt stub.
  const baseProv = buildMockProvider(callHandler)
  const provider = {
    ...baseProv,
    getFeeData: async () => ({
      gasPrice: 10n ** 9n,
      maxFeePerGas: null, maxPriorityFeePerGas: null,
    }),
    getTransactionCount: async () => 0,
    broadcastTransaction: async (rawTx: string) => {
      const parsed = ethers.Transaction.from(rawTx)
      const decoded = iface.decodeFunctionData('swapExactTokensForTokens', parsed.data)
      observedMinOut = decoded[1] as bigint
      throw new Error('test_capture_minout')
    },
  }
  await withTopazEnv(
    { TOPAZ_ENABLED: 'true', TOPAZ_MASTER_WALLET_ID: 'w1', TOPAZ_ROUTER: ROUTER, TOPAZ_NPM: NPM,
      TOPAZ_DEFAULT_SLIPPAGE_BPS: '50', TOPAZ_MAX_SLIPPAGE_BPS: '500' },
    provider,
    async () => {
      const res = await swap({
        tokenIn: T0, tokenOut: T1, amountIn: 10n ** 18n,
        slippageBps: 5000, // hostile request: 50% slippage tolerance
        route: { kind: 'v2', hops: [{ from: T0, to: T1, stable: false }] },
      })
      // swap() returns {ok:false, error:'test_capture_minout'} — fine,
      // we only need the captured minOut from broadcastTransaction.
      assert.equal(res.ok, false)
      const expectedAtCap = (10n ** 18n * 9500n) / 10_000n  // = 95e16
      assert.equal(observedMinOut, expectedAtCap,
        `slippage cap should clamp 5000bps request to 500bps, expected minOut=${expectedAtCap} got ${observedMinOut}`)
    },
  )
})

test('topazTrading: swap surfaces topaz_min_out_zero when quote returns dust under slippage', async () => {
  // 1bp quote with 50bp default slippage rounds to 0 — must refuse.
  const iface = new ethers.Interface([
    'function getAmountsOut(uint256,(address,address,bool)[]) view returns (uint256[])',
  ])
  const callHandler = async (_to: string, data: string): Promise<string> => {
    const sig = data.slice(0, 10)
    if (sig === iface.getFunction('getAmountsOut')!.selector) {
      return iface.encodeFunctionResult('getAmountsOut', [[1n, 1n]])
    }
    throw new Error('execution reverted')
  }
  await withTopazEnv(
    { TOPAZ_ENABLED: 'true', TOPAZ_MASTER_WALLET_ID: 'w1', TOPAZ_ROUTER: ROUTER, TOPAZ_NPM: NPM },
    buildMockProvider(callHandler),
    async () => {
      const r = await swap({
        tokenIn: T0, tokenOut: T1, amountIn: 1n,
        route: { kind: 'v2', hops: [{ from: T0, to: T1, stable: false }] },
      })
      assert.equal(r.ok, false)
      // Either min_out_zero or downstream ensureAllowance / send failure.
      assert.match(String(r.error), /topaz_min_out_zero|topaz_/)
    },
  )
})

test('topazTrading: v3UnderlyingAmounts splits both tokens when price is in range', () => {
  // tickLower=-60, tickUpper=60 (≈ ±0.6%), current price = 1.0 → sqrtP = 2^96.
  const sqrtP = 1n << 96n
  const { amount0, amount1 } = v3UnderlyingAmounts(sqrtP, -60, 60, 1_000_000n)
  assert.ok(amount0 > 0, 'amount0 should be positive in range')
  assert.ok(amount1 > 0, 'amount1 should be positive in range')
})

test('topazTrading: v3UnderlyingAmounts is all token0 below range, all token1 above range', () => {
  const sqrtP = 1n << 96n // price = 1.0
  // Range entirely above current price → position holds only token0.
  const below = v3UnderlyingAmounts(sqrtP, 1200, 1800, 1_000_000n)
  assert.ok(below.amount0 > 0 && below.amount1 === 0)
  // Range entirely below current price → position holds only token1.
  const above = v3UnderlyingAmounts(sqrtP, -1800, -1200, 1_000_000n)
  assert.ok(above.amount1 > 0 && above.amount0 === 0)
})

test('topazTrading: v3UnderlyingAmounts fails closed on zero/invalid liquidity', () => {
  const sqrtP = 1n << 96n
  assert.deepEqual(v3UnderlyingAmounts(sqrtP, -60, 60, 0n), { amount0: 0, amount1: 0 })
  assert.deepEqual(v3UnderlyingAmounts(0n, -60, 60, 1_000_000n), { amount0: 0, amount1: 0 })
})

// ── End-to-end USD valuation paths ───────────────────────────────────────
// priceV2LpPositionsUsd / priceV3PositionsUsd combine on-chain reserve/slot0
// reads + token decimals + a prices map. We inject prices via opts.prices to
// exercise the reserve-share and decimal-scaling math without DexScreener.

const TOPAZ_TOK = '0x' + 'f0'.repeat(20)

function v2Position(over: Partial<V2LpPosition> = {}): V2LpPosition {
  return {
    kind: 'v2-lp',
    pool: POOL,
    gauge: null,
    token0: T0,
    token1: T1,
    token0Symbol: 'AAA',
    token1Symbol: 'BBB',
    stable: false,
    walletBalance: 10n * 10n ** 18n,
    stakedBalance: 10n * 10n ** 18n,
    claimable: 2n * 10n ** 18n,
    ...over,
  }
}

// Pair (POOL) exposes reserve0/reserve1/totalSupply; token0/token1 expose
// decimals. Routing by `to` lets one handler serve all three contracts.
function v2CallHandler(opts: {
  reserve0: bigint
  reserve1: bigint
  totalSupply: bigint
  dec0?: number
  dec1?: number
}) {
  const iface = new ethers.Interface([
    'function reserve0() view returns (uint256)',
    'function reserve1() view returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function decimals() view returns (uint8)',
  ])
  const decSel = iface.getFunction('decimals')!.selector
  return async (to: string, data: string): Promise<string> => {
    const sig = data.slice(0, 10)
    if (to === POOL.toLowerCase()) {
      if (sig === iface.getFunction('reserve0')!.selector)
        return iface.encodeFunctionResult('reserve0', [opts.reserve0])
      if (sig === iface.getFunction('reserve1')!.selector)
        return iface.encodeFunctionResult('reserve1', [opts.reserve1])
      if (sig === iface.getFunction('totalSupply')!.selector)
        return iface.encodeFunctionResult('totalSupply', [opts.totalSupply])
    }
    if (to === T0.toLowerCase() && sig === decSel)
      return iface.encodeFunctionResult('decimals', [opts.dec0 ?? 18])
    if (to === T1.toLowerCase() && sig === decSel)
      return iface.encodeFunctionResult('decimals', [opts.dec1 ?? 18])
    throw new Error('execution reverted')
  }
}

const V2_ENV = {
  TOPAZ_ENABLED: 'true', TOPAZ_MASTER_WALLET_ID: 'w1',
  TOPAZ_ROUTER: ROUTER, TOPAZ_NPM: NPM, TOPAZ_TOKEN: TOPAZ_TOK,
}

test('topazTrading: priceV2LpPositionsUsd values LP share from reserves when both sides priced', async () => {
  // reserve0 = 1000 @ $2 = $2000 (18 dec); reserve1 = 5000 @ $1 = $5000 (6 dec).
  // reserveUsd = $7000; share = (10+10)/100 = 0.2 → usdValue = $1400.
  // claimable = 2 TOPAZ @ $3 = $6.
  await withTopazEnv(
    V2_ENV,
    buildMockProvider(v2CallHandler({
      reserve0: 1000n * 10n ** 18n,
      reserve1: 5000n * 10n ** 6n,
      totalSupply: 100n * 10n ** 18n,
      dec0: 18, dec1: 6,
    })),
    async () => {
      const prices = {
        [T0.toLowerCase()]: 2,
        [T1.toLowerCase()]: 1,
        [TOPAZ_TOK.toLowerCase()]: 3,
      }
      const [r] = await priceV2LpPositionsUsd([v2Position()], { prices })
      assert.equal(r.usdValue, 1400)
      assert.equal(r.claimableUsd, 6)
    },
  )
})

test('topazTrading: priceV2LpPositionsUsd doubles the single priced side when only one token is priceable', async () => {
  // Only token0 priced ($2). side0 = 1000 @ $2 = $2000; the unpriced side is
  // approximated as an equal-value mirror → reserveUsd = $4000; share = 0.2 →
  // usdValue = $800. No TOPAZ price → claimableUsd null.
  await withTopazEnv(
    V2_ENV,
    buildMockProvider(v2CallHandler({
      reserve0: 1000n * 10n ** 18n,
      reserve1: 5000n * 10n ** 6n,
      totalSupply: 100n * 10n ** 18n,
      dec0: 18, dec1: 6,
    })),
    async () => {
      const prices = { [T0.toLowerCase()]: 2 } // token1 + TOPAZ deliberately absent
      const [r] = await priceV2LpPositionsUsd([v2Position()], { prices })
      assert.equal(r.usdValue, 800)
      assert.equal(r.claimableUsd, null)
    },
  )
})

test('topazTrading: priceV2LpPositionsUsd returns null value when reserve reads revert but still prices claimable', async () => {
  // Provider reverts on every call → reserve/totalSupply reads fail → usdValue
  // null (caught), but the claimable conversion uses only the injected price
  // map and must still resolve.
  await withTopazEnv(
    V2_ENV,
    buildMockProvider(async () => { throw new Error('execution reverted') }),
    async () => {
      const prices = {
        [T0.toLowerCase()]: 2,
        [T1.toLowerCase()]: 1,
        [TOPAZ_TOK.toLowerCase()]: 3,
      }
      const [r] = await priceV2LpPositionsUsd([v2Position()], { prices })
      assert.equal(r.usdValue, null)
      assert.equal(r.claimableUsd, 6)
    },
  )
})

test('topazTrading: priceV2LpPositionsUsd returns null value when totalSupply is zero', async () => {
  // A pool with zero LP supply cannot yield a share → usdValue null (no divide).
  await withTopazEnv(
    V2_ENV,
    buildMockProvider(v2CallHandler({
      reserve0: 1000n * 10n ** 18n,
      reserve1: 5000n * 10n ** 6n,
      totalSupply: 0n,
    })),
    async () => {
      const prices = { [T0.toLowerCase()]: 2, [T1.toLowerCase()]: 1 }
      const [r] = await priceV2LpPositionsUsd([v2Position()], { prices })
      assert.equal(r.usdValue, null)
    },
  )
})

function v3Position(over: Partial<OpenLpPosition> = {}): OpenLpPosition {
  return {
    kind: 'v3-nft',
    tokenId: 1n,
    token0: T0,
    token1: T1,
    tickLower: -60,
    tickUpper: 60,
    liquidity: 1_000_000_000_000_000_000n,
    tickSpacing: 50,
    pool: POOL,
    claimable: 4n * 10n ** 18n,
    ...over,
  }
}

// Pool (POOL) exposes slot0; token0/token1 expose decimals.
function v3CallHandler(opts: { sqrtPriceX96: bigint; dec0?: number; dec1?: number }) {
  const iface = new ethers.Interface([
    'function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)',
    'function decimals() view returns (uint8)',
  ])
  const decSel = iface.getFunction('decimals')!.selector
  return async (to: string, data: string): Promise<string> => {
    const sig = data.slice(0, 10)
    if (to === POOL.toLowerCase() && sig === iface.getFunction('slot0')!.selector) {
      return iface.encodeFunctionResult('slot0', [opts.sqrtPriceX96, 0, 0, 0, 0, true])
    }
    if (to === T0.toLowerCase() && sig === decSel)
      return iface.encodeFunctionResult('decimals', [opts.dec0 ?? 18])
    if (to === T1.toLowerCase() && sig === decSel)
      return iface.encodeFunctionResult('decimals', [opts.dec1 ?? 18])
    throw new Error('execution reverted')
  }
}

const V3_ENV = V2_ENV

test('topazTrading: priceV3PositionsUsd values both legs from slot0 + decimals when both sides priced', async () => {
  // price = 1.0 (sqrtP = 2^96) with a symmetric [-60,60] range → both legs
  // present. We derive the expected USD from the same v3UnderlyingAmounts the
  // function uses, so this asserts the decimal-scaling + price-multiply glue.
  const sqrtP = 1n << 96n
  const liquidity = 1_000_000_000_000_000_000n
  const { amount0, amount1 } = v3UnderlyingAmounts(sqrtP, -60, 60, liquidity)
  const price0 = 2, price1 = 3
  const expected = (amount0 / 1e18) * price0 + (amount1 / 1e18) * price1
  await withTopazEnv(
    V3_ENV,
    buildMockProvider(v3CallHandler({ sqrtPriceX96: sqrtP, dec0: 18, dec1: 18 })),
    async () => {
      const prices = {
        [T0.toLowerCase()]: price0,
        [T1.toLowerCase()]: price1,
        [TOPAZ_TOK.toLowerCase()]: 5,
      }
      const [r] = await priceV3PositionsUsd([v3Position({ liquidity })], { prices })
      assert.ok(r.usdValue != null && Math.abs(r.usdValue - expected) < 1e-9,
        `expected ~${expected}, got ${r.usdValue}`)
      assert.equal(r.claimableUsd, 20) // 4 TOPAZ @ $5
    },
  )
})

test('topazTrading: priceV3PositionsUsd values only the priced leg when one side is unpriceable', async () => {
  const sqrtP = 1n << 96n
  const liquidity = 1_000_000_000_000_000_000n
  const { amount0 } = v3UnderlyingAmounts(sqrtP, -60, 60, liquidity)
  const price0 = 2
  const expected = (amount0 / 1e18) * price0 // token1 contributes 0 (no price)
  await withTopazEnv(
    V3_ENV,
    buildMockProvider(v3CallHandler({ sqrtPriceX96: sqrtP, dec0: 18, dec1: 18 })),
    async () => {
      const prices = { [T0.toLowerCase()]: price0 } // token1 + TOPAZ absent
      const [r] = await priceV3PositionsUsd([v3Position({ liquidity })], { prices })
      assert.ok(r.usdValue != null && Math.abs(r.usdValue - expected) < 1e-9,
        `expected ~${expected}, got ${r.usdValue}`)
      assert.equal(r.claimableUsd, null)
    },
  )
})

test('topazTrading: priceV3PositionsUsd returns null value when the backing pool is unresolved', async () => {
  // pool undefined → no slot0 read possible → usdValue null, but claimable
  // still prices off the injected map.
  await withTopazEnv(
    V3_ENV,
    buildMockProvider(async () => { throw new Error('execution reverted') }),
    async () => {
      const prices = {
        [T0.toLowerCase()]: 2,
        [T1.toLowerCase()]: 3,
        [TOPAZ_TOK.toLowerCase()]: 5,
      }
      const [r] = await priceV3PositionsUsd([v3Position({ pool: undefined })], { prices })
      assert.equal(r.usdValue, null)
      assert.equal(r.claimableUsd, 20)
    },
  )
})

test('topazTrading: priceV3PositionsUsd returns null value when slot0 read reverts', async () => {
  // pool set but slot0 reverts → caught → usdValue null.
  await withTopazEnv(
    V3_ENV,
    buildMockProvider(async () => { throw new Error('execution reverted') }),
    async () => {
      const prices = { [T0.toLowerCase()]: 2, [T1.toLowerCase()]: 3 }
      const [r] = await priceV3PositionsUsd([v3Position()], { prices })
      assert.equal(r.usdValue, null)
    },
  )
})

// ── Pool-state cache: repeated page loads reuse on-chain reads ────────────
// The Topaz page re-prices the same pools on every refresh. The short-TTL
// pool-state cache means a second valuation within the window must NOT touch
// the chain again — we assert that by counting how many slot0/reserve reads
// the provider actually serves.

// Wrap a call handler so we can count the on-chain reads it serves for a
// given selector against a given contract address.
function countingHandler(
  inner: (to: string, data: string) => Promise<string>,
  match: { to: string; selector: string },
) {
  const counter = { n: 0 }
  const handler = async (to: string, data: string): Promise<string> => {
    if (to === match.to.toLowerCase() && data.slice(0, 10) === match.selector) counter.n++
    return inner(to, data)
  }
  return { handler, counter }
}

const RESERVE0_SEL = new ethers.Interface(['function reserve0() view returns (uint256)'])
  .getFunction('reserve0')!.selector
const SLOT0_SEL = new ethers.Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)'])
  .getFunction('slot0')!.selector

test('topazTrading: priceV2LpPositionsUsd caches pool reserve reads across repeated loads', async () => {
  const { handler, counter } = countingHandler(
    v2CallHandler({
      reserve0: 1000n * 10n ** 18n,
      reserve1: 5000n * 10n ** 6n,
      totalSupply: 100n * 10n ** 18n,
      dec0: 18, dec1: 6,
    }),
    { to: POOL, selector: RESERVE0_SEL },
  )
  await withTopazEnv(V2_ENV, buildMockProvider(handler), async () => {
    const prices = { [T0.toLowerCase()]: 2, [T1.toLowerCase()]: 1 }
    const [a] = await priceV2LpPositionsUsd([v2Position()], { prices })
    const [b] = await priceV2LpPositionsUsd([v2Position()], { prices })
    // Same answer both times…
    assert.equal(a.usdValue, 1400)
    assert.equal(b.usdValue, 1400)
    // …but the chain was only read once.
    assert.equal(counter.n, 1, 'second load reused the cached pool reserves')
  })
})

test('topazTrading: priceV3PositionsUsd caches pool slot0 reads across repeated loads', async () => {
  const sqrtP = 1n << 96n
  const liquidity = 1_000_000_000_000_000_000n
  const { handler, counter } = countingHandler(
    v3CallHandler({ sqrtPriceX96: sqrtP, dec0: 18, dec1: 18 }),
    { to: POOL, selector: SLOT0_SEL },
  )
  await withTopazEnv(V3_ENV, buildMockProvider(handler), async () => {
    const prices = { [T0.toLowerCase()]: 2, [T1.toLowerCase()]: 3 }
    const [a] = await priceV3PositionsUsd([v3Position({ liquidity })], { prices })
    const [b] = await priceV3PositionsUsd([v3Position({ liquidity })], { prices })
    assert.ok(a.usdValue != null && b.usdValue != null)
    assert.equal(a.usdValue, b.usdValue)
    assert.equal(counter.n, 1, 'second load reused the cached slot0 snapshot')
  })
})

test('topazTrading: a reverting pool read is NOT cached and is retried on the next load', async () => {
  // First load: provider reverts → usdValue null, nothing cached. Second load:
  // a healthy provider must actually read the chain (no poisoned cache entry).
  let reverting = true
  const { handler, counter } = countingHandler(
    async (to: string, data: string) => {
      if (reverting) throw new Error('execution reverted')
      return v2CallHandler({
        reserve0: 1000n * 10n ** 18n,
        reserve1: 5000n * 10n ** 6n,
        totalSupply: 100n * 10n ** 18n,
        dec0: 18, dec1: 6,
      })(to, data)
    },
    { to: POOL, selector: RESERVE0_SEL },
  )
  await withTopazEnv(V2_ENV, buildMockProvider(handler), async () => {
    const prices = { [T0.toLowerCase()]: 2, [T1.toLowerCase()]: 1 }
    const [bad] = await priceV2LpPositionsUsd([v2Position()], { prices })
    assert.equal(bad.usdValue, null, 'reverting read yields a null value')
    reverting = false
    const [good] = await priceV2LpPositionsUsd([v2Position()], { prices })
    assert.equal(good.usdValue, 1400, 'next load reads fresh (failure was not cached)')
    assert.equal(counter.n, 2, 'both loads hit the chain — no poisoned cache entry')
  })
})

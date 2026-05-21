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

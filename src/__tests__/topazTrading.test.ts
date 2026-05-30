import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import { db } from '../db'
import {
  __setTopazTestDeps,
  __resetTopazTestDeps,
  parseClaimRequest,
  claimGaugeRewards,
  getUserWalletBalances,
  listV2LpPositions,
  listOpenLpPositions,
  applySlippage,
  computeDeadline,
  swap,
  addV2Liquidity,
  removeV2Liquidity,
  mintV3Position,
  burnV3Position,
  stakeInGauge,
  unstakeFromGauge,
} from '../services/topazTrading'
import { getTopazConfig, __resetTopazConfigCache } from '../services/topaz'
import type { FeeContext, FeeResult } from '../services/brokerFees'
import {
  ERC20_ABI,
  TOPAZ_ROUTER_ABI,
  TOPAZ_V2_PAIR_ABI,
  TOPAZ_GAUGE_ABI,
  TOPAZ_NPM_ABI,
  TOPAZ_CL_POOL_ABI,
  TOPAZ_CL_GAUGE_ABI,
} from '../services/topaz/abis'

// ── Shared test plumbing ────────────────────────────────────────────────
// These tests exercise the on-chain READ paths (balances + LP discovery)
// and the user-signed claim ROUTING without touching a real RPC. Every
// ethers.Contract read inside topazTrading flows through
// `activeDeps.buildProvider().call(tx)`, so we inject a fake provider that
// decodes the calldata with the very same ABI fragments the production
// code uses and returns ABI-encoded results. That keeps the test honest:
// a signature drift between abis.ts and a call site surfaces here as a
// decode error, exactly as the ABI file's own comment promises.

const addr = (b: string) => '0x' + b.repeat(20)
const WALLET = addr('11')
const USDT = addr('22')
const TOPAZ = addr('33')
const NPM = addr('44')
const POOL_A = addr('a1')
const GAUGE_A = addr('a2')
const POOL_B = addr('b1')
const GAUGE_B = addr('b2')
const POOL_V3 = addr('c1')
const GAUGE_V3 = addr('c2')
const TKA = addr('d1')
const TKB = addr('d2')
const MASTER_WALLET_ID = 'master-wallet-id'
const VALID_PK = '0x' + '11'.repeat(32)

type Handlers = Record<string, (args: unknown[]) => unknown[]>
interface FakeContract {
  address: string
  abi: readonly string[]
  handlers: Handlers
}

/**
 * Build a provider stand-in whose `.call()` parses incoming calldata with
 * the matching ABI and returns the values produced by per-function
 * handlers. A missing contract or missing handler throws — that models a
 * revert, which the production best-effort paths must swallow.
 */
function fakeProvider(opts: { bnb?: bigint; contracts?: FakeContract[] }): ethers.AbstractProvider {
  const reg = new Map<string, { iface: ethers.Interface; handlers: Handlers }>()
  for (const c of opts.contracts ?? []) {
    reg.set(c.address.toLowerCase(), { iface: new ethers.Interface(c.abi), handlers: c.handlers })
  }
  return {
    getBalance: async () => opts.bnb ?? 0n,
    getNetwork: async () => new ethers.Network('bsc', 56n),
    resolveName: async (n: string) => n,
    call: async (tx: { to?: string; data?: string }) => {
      const entry = reg.get((tx.to ?? '').toLowerCase())
      if (!entry) throw new Error(`fake_no_contract:${tx.to}`)
      const parsed = entry.iface.parseTransaction({ data: tx.data ?? '0x' })
      if (!parsed) throw new Error('fake_unparseable')
      const handler = entry.handlers[parsed.name]
      if (!handler) throw new Error(`fake_revert:${parsed.name}`)
      return entry.iface.encodeFunctionResult(parsed.name, handler([...parsed.args]))
    },
  } as unknown as ethers.AbstractProvider
}

function withEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) prev[k] = process.env[k]
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetTopazConfigCache()
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    __resetTopazConfigCache()
  }
}

function withFetch(impl: (url: string) => unknown[]): () => void {
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string) => ({
    ok: true,
    json: async () => ({ data: { gauges: impl(String(url)) } }),
  })) as unknown as typeof fetch
  return () => {
    globalThis.fetch = orig
  }
}

function subgraphGauge(g: {
  gauge: string
  pool: string
  isV3: boolean
  apr?: number
  t0?: string
  t1?: string
}) {
  return {
    id: g.gauge,
    pool: { id: g.pool, token0: { symbol: g.t0 ?? 'WBNB' }, token1: { symbol: g.t1 ?? 'USDT' } },
    aprPct: g.apr ?? 10,
    tvlUsd: 1000,
    isV3: g.isV3,
  }
}

// ══════════════════════════════════════════════════════════════════════
// parseClaimRequest — the validation behind POST /api/topaz/claim.
// ══════════════════════════════════════════════════════════════════════
test('parseClaimRequest: rejects a missing gauge', () => {
  assert.deepEqual(parseClaimRequest({ kind: 'v2' }), { ok: false, error: 'gauge required' })
  assert.deepEqual(parseClaimRequest({}), { ok: false, error: 'gauge required' })
  assert.deepEqual(parseClaimRequest(undefined), { ok: false, error: 'gauge required' })
})

test('parseClaimRequest: rejects a non-string / malformed gauge address (fail-closed up-front)', () => {
  assert.deepEqual(parseClaimRequest({ gauge: 123, kind: 'v2' }), {
    ok: false,
    error: 'gauge required',
  })
  const r = parseClaimRequest({ gauge: '0xnotanaddress', kind: 'v2' })
  assert.equal(r.ok, false)
  assert.equal((r as { error: string }).error, 'topaz_invalid_gauge:0xnotanaddress')
})

test('parseClaimRequest: rejects an unknown kind', () => {
  assert.deepEqual(parseClaimRequest({ gauge: GAUGE_A, kind: 'v4' }), {
    ok: false,
    error: "kind must be 'v2' or 'v3'",
  })
  assert.deepEqual(parseClaimRequest({ gauge: GAUGE_A }), {
    ok: false,
    error: "kind must be 'v2' or 'v3'",
  })
})

test('parseClaimRequest: v3 requires a tokenId', () => {
  assert.deepEqual(parseClaimRequest({ gauge: GAUGE_A, kind: 'v3' }), {
    ok: false,
    error: 'tokenId required for v3 claim',
  })
})

test('parseClaimRequest: rejects a non-integer / non-positive tokenId', () => {
  const bad = parseClaimRequest({ gauge: GAUGE_A, kind: 'v3', tokenId: 'abc' })
  assert.equal(bad.ok, false)
  assert.equal((bad as { error: string }).error, 'tokenId must be an integer')
  const zero = parseClaimRequest({ gauge: GAUGE_A, kind: 'v3', tokenId: 0 })
  // 0 is falsy → caught by the "tokenId required" guard first.
  assert.equal(zero.ok, false)
  const neg = parseClaimRequest({ gauge: GAUGE_A, kind: 'v3', tokenId: '-5' })
  assert.equal(neg.ok, false)
  assert.equal((neg as { error: string }).error, 'tokenId must be a positive integer')
})

test('parseClaimRequest: accepts a valid v2 claim (no tokenId)', () => {
  const r = parseClaimRequest({ gauge: GAUGE_A, kind: 'v2' })
  assert.deepEqual(r, { ok: true, value: { gauge: GAUGE_A, kind: 'v2', tokenId: undefined } })
})

test('parseClaimRequest: accepts a valid v3 claim and coerces tokenId → bigint', () => {
  const r = parseClaimRequest({ gauge: GAUGE_A, kind: 'v3', tokenId: '42' })
  assert.equal(r.ok, true)
  const v = (r as { value: { gauge: string; kind: string; tokenId: bigint } }).value
  assert.equal(v.gauge, GAUGE_A)
  assert.equal(v.kind, 'v3')
  assert.equal(v.tokenId, 42n)
})

// ══════════════════════════════════════════════════════════════════════
// claimGaugeRewards — signer routing (userId → user wallet, omitted →
// master wallet). We mock the wallet-resolution seam and let the on-chain
// getReward fail fast (provider has no network) since we only assert WHICH
// wallet the signer was built from, not the broadcast itself.
// ══════════════════════════════════════════════════════════════════════
const failProvider = {
  getNetwork: async () => {
    throw new Error('topaz_test_no_chain')
  },
  estimateGas: async () => {
    throw new Error('topaz_test_no_chain')
  },
  getFeeData: async () => {
    throw new Error('topaz_test_no_chain')
  },
  getTransactionCount: async () => {
    throw new Error('topaz_test_no_chain')
  },
  call: async () => {
    throw new Error('topaz_test_no_chain')
  },
  broadcastTransaction: async () => {
    throw new Error('topaz_test_no_chain')
  },
} as unknown as ethers.AbstractProvider

test('claimGaugeRewards: with userId resolves the user\'s active BSC wallet (not the master)', async () => {
  const restoreEnv = withEnv({ TOPAZ_MASTER_WALLET_ID: MASTER_WALLET_ID })
  const loadCalls: string[] = []
  const findFirstCalls: unknown[] = []
  const origFindFirst = db.wallet.findFirst
  ;(db.wallet as { findFirst: unknown }).findFirst = async (arg: unknown) => {
    findFirstCalls.push(arg)
    return { id: 'user-wallet-id', address: WALLET, encryptedPK: 'enc', chain: 'BSC', userId: 'user-1', isActive: true }
  }
  __setTopazTestDeps({
    buildProvider: () => failProvider,
    loadWallet: async (walletId: string) => {
      loadCalls.push(walletId)
      return { address: WALLET, privateKey: VALID_PK }
    },
  })
  try {
    const r = await claimGaugeRewards({ gauge: GAUGE_A, kind: 'v2', userId: 'user-1' })
    // Chain broadcast is stubbed out → ok:false, but routing already happened.
    assert.equal(r.ok, false)
    assert.equal(findFirstCalls.length, 1, 'user path looks up the user wallet')
    const where = (findFirstCalls[0] as { where: Record<string, unknown> }).where
    assert.deepEqual(where, { userId: 'user-1', chain: 'BSC', isActive: true })
    assert.deepEqual(loadCalls, ['user-wallet-id'], 'signer built from the user wallet id, not the master')
  } finally {
    ;(db.wallet as { findFirst: typeof origFindFirst }).findFirst = origFindFirst
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('claimGaugeRewards: without userId resolves the master wallet (no user lookup)', async () => {
  const restoreEnv = withEnv({ TOPAZ_MASTER_WALLET_ID: MASTER_WALLET_ID })
  const loadCalls: string[] = []
  const findFirstCalls: unknown[] = []
  const origFindFirst = db.wallet.findFirst
  ;(db.wallet as { findFirst: unknown }).findFirst = async (arg: unknown) => {
    findFirstCalls.push(arg)
    return null
  }
  __setTopazTestDeps({
    buildProvider: () => failProvider,
    loadWallet: async (walletId: string) => {
      loadCalls.push(walletId)
      return { address: WALLET, privateKey: VALID_PK }
    },
  })
  try {
    const r = await claimGaugeRewards({ gauge: GAUGE_A, kind: 'v2' })
    assert.equal(r.ok, false)
    assert.equal(findFirstCalls.length, 0, 'agent path never looks up a user wallet')
    assert.deepEqual(loadCalls, [MASTER_WALLET_ID], 'signer built from the configured master wallet')
  } finally {
    ;(db.wallet as { findFirst: typeof origFindFirst }).findFirst = origFindFirst
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('claimGaugeRewards: rejects a malformed gauge address before any wallet work', async () => {
  const loadCalls: string[] = []
  __setTopazTestDeps({
    buildProvider: () => failProvider,
    loadWallet: async (walletId: string) => {
      loadCalls.push(walletId)
      return { address: WALLET, privateKey: VALID_PK }
    },
  })
  try {
    const r = await claimGaugeRewards({ gauge: '0xbad', kind: 'v2', userId: 'user-1' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'topaz_invalid_gauge:0xbad')
    assert.equal(loadCalls.length, 0, 'no wallet decryption on the invalid-gauge path')
  } finally {
    __resetTopazTestDeps()
  }
})

// ══════════════════════════════════════════════════════════════════════
// getUserWalletBalances — best-effort: always shows BNB, skips a token
// whose ERC-20 reads revert, omits unconfigured tokens.
// ══════════════════════════════════════════════════════════════════════
test('getUserWalletBalances: returns BNB + readable tokens and skips a reverting token', async () => {
  const restoreEnv = withEnv({ TOPAZ_USDT_TOKEN: USDT, TOPAZ_TOKEN: TOPAZ })
  __setTopazTestDeps({
    buildProvider: () =>
      fakeProvider({
        bnb: 2_000000000000000000n, // 2 BNB
        contracts: [
          {
            address: USDT,
            abi: ERC20_ABI,
            handlers: {
              balanceOf: () => [500n],
              decimals: () => [6],
              symbol: () => ['USDT'],
            },
          },
          // TOPAZ token is intentionally NOT registered → balanceOf reverts
          // → the whole token is skipped (best-effort), not fatal.
        ],
      }),
  })
  try {
    const out = await getUserWalletBalances(WALLET)
    assert.equal(out.length, 2, 'BNB + USDT only; reverting TOPAZ dropped')
    assert.equal(out[0].symbol, 'BNB')
    assert.equal(out[0].address, null)
    assert.equal(out[0].formatted, '2.0')
    assert.equal(out[1].symbol, 'USDT')
    assert.equal(out[1].address, USDT)
    assert.equal(out[1].decimals, 6)
    assert.equal(out[1].raw, 500n)
    assert.equal(out[1].formatted, '0.0005')
    assert.equal(
      out.find((b) => b.address === TOPAZ),
      undefined,
      'reverting token never appears',
    )
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('getUserWalletBalances: throws on an invalid wallet address', async () => {
  await assert.rejects(() => getUserWalletBalances('0xnope'), /topaz_invalid_wallet/)
})

// ══════════════════════════════════════════════════════════════════════
// listV2LpPositions — enumerate ranked v2 gauges, drop pools the wallet
// has zero stake in, skip v3 gauges entirely.
// ══════════════════════════════════════════════════════════════════════
test('listV2LpPositions: keeps pools with stake, drops zero-stake pools, ignores v3 gauges', async () => {
  const restoreEnv = withEnv({
    TOPAZ_SUBGRAPH_V2_URL: 'http://test/v2',
    TOPAZ_SUBGRAPH_V3_URL: 'http://test/v3',
  })
  const restoreFetch = withFetch((url) =>
    url.includes('/v3')
      ? []
      : [
          subgraphGauge({ gauge: GAUGE_A, pool: POOL_A, isV3: false, apr: 20 }),
          subgraphGauge({ gauge: GAUGE_B, pool: POOL_B, isV3: false, apr: 10 }),
          // A v3 gauge in the v2 feed must be filtered out by listV2LpPositions.
          subgraphGauge({ gauge: GAUGE_V3, pool: POOL_V3, isV3: true, apr: 30 }),
        ],
  )
  __setTopazTestDeps({
    buildProvider: () =>
      fakeProvider({
        contracts: [
          {
            address: POOL_A,
            abi: TOPAZ_V2_PAIR_ABI,
            handlers: {
              token0: () => [TKA],
              token1: () => [TKB],
              stable: () => [false],
              balanceOf: () => [100n], // unstaked LP in wallet
            },
          },
          {
            address: GAUGE_A,
            abi: TOPAZ_GAUGE_ABI,
            handlers: { balanceOf: () => [50n], earned: () => [7n] },
          },
          {
            address: POOL_B,
            abi: TOPAZ_V2_PAIR_ABI,
            handlers: {
              token0: () => [TKA],
              token1: () => [TKB],
              stable: () => [false],
              balanceOf: () => [0n],
            },
          },
          {
            address: GAUGE_B,
            abi: TOPAZ_GAUGE_ABI,
            handlers: { balanceOf: () => [0n], earned: () => [0n] },
          },
        ],
      }),
  })
  try {
    const out = await listV2LpPositions(WALLET)
    assert.equal(out.length, 1, 'only the pool with stake survives; v3 + zero-stake dropped')
    const p = out[0]
    assert.equal(p.kind, 'v2-lp')
    assert.equal(p.pool, ethers.getAddress(POOL_A))
    assert.equal(p.gauge, ethers.getAddress(GAUGE_A))
    assert.equal(p.walletBalance, 100n)
    assert.equal(p.stakedBalance, 50n)
    assert.equal(p.claimable, 7n)
    assert.equal(p.token0, ethers.getAddress(TKA))
    assert.equal(p.token1, ethers.getAddress(TKB))
  } finally {
    __resetTopazTestDeps()
    restoreFetch()
    restoreEnv()
  }
})

test('listV2LpPositions: returns [] when no subgraph is configured', async () => {
  const restoreEnv = withEnv({
    TOPAZ_SUBGRAPH_V2_URL: '',
    TOPAZ_SUBGRAPH_V3_URL: '',
  })
  // pickUrl falls back to baked-in defaults when env is empty, so this
  // test asserts the no-gauge degradation indirectly: stub fetch to
  // return nothing so getTopGaugesByApr yields an empty list.
  const restoreFetch = withFetch(() => [])
  __setTopazTestDeps({ buildProvider: () => fakeProvider({}) })
  try {
    const out = await listV2LpPositions(WALLET)
    assert.deepEqual(out, [])
  } finally {
    __resetTopazTestDeps()
    restoreFetch()
    restoreEnv()
  }
})

// ══════════════════════════════════════════════════════════════════════
// listOpenLpPositions (+ enrichV3Emissions) — enumerate v3 NFTs, skip
// zero-liquidity positions, and match each position to its gauge by
// (token0, token1, tickSpacing) for claimable enrichment.
// ══════════════════════════════════════════════════════════════════════
function positionsResult(o: {
  token0: string
  token1: string
  tickSpacing: number
  liquidity: bigint
}): unknown[] {
  // NPM.positions output order: nonce, operator, token0, token1, tickSpacing,
  // tickLower, tickUpper, liquidity, fg0, fg1, owed0, owed1.
  return [0n, ethers.ZeroAddress, o.token0, o.token1, o.tickSpacing, -100, 100, o.liquidity, 0n, 0n, 0n, 0n]
}

test('listOpenLpPositions: skips zero-liquidity NFTs and enriches by (token0,token1,tickSpacing)', async () => {
  const restoreEnv = withEnv({
    TOPAZ_NPM: NPM,
    TOPAZ_SUBGRAPH_V2_URL: 'http://test/v2',
    TOPAZ_SUBGRAPH_V3_URL: 'http://test/v3',
  })
  const restoreFetch = withFetch((url) =>
    url.includes('/v3') ? [subgraphGauge({ gauge: GAUGE_V3, pool: POOL_V3, isV3: true })] : [],
  )
  __setTopazTestDeps({
    buildProvider: () =>
      fakeProvider({
        contracts: [
          {
            address: NPM,
            abi: TOPAZ_NPM_ABI,
            handlers: {
              balanceOf: () => [3n],
              tokenOfOwnerByIndex: (args) => {
                const i = Number(args[1] as bigint)
                return [[100n, 200n, 300n][i]]
              },
              positions: (args) => {
                const id = args[0] as bigint
                if (id === 100n) return positionsResult({ token0: TKA, token1: TKB, tickSpacing: 200, liquidity: 5n })
                if (id === 200n) return positionsResult({ token0: TKA, token1: TKB, tickSpacing: 60, liquidity: 9n })
                return positionsResult({ token0: TKA, token1: TKB, tickSpacing: 200, liquidity: 0n }) // dropped
              },
            },
          },
          {
            address: POOL_V3,
            abi: TOPAZ_CL_POOL_ABI,
            handlers: {
              token0: () => [TKA],
              token1: () => [TKB],
              slot0: () => [79228162514264337593543950336n, 0, 0, 0, 0, false],
              liquidity: () => [1000n],
              fee: () => [500],
              tickSpacing: () => [200],
            },
          },
          {
            address: GAUGE_V3,
            abi: TOPAZ_CL_GAUGE_ABI,
            handlers: {
              earned: (args) => {
                assert.equal(args[1], 100n, 'only the matched position is queried for emissions')
                return [777n]
              },
            },
          },
        ],
      }),
  })
  try {
    const out = await listOpenLpPositions(WALLET, { withEmissions: true })
    assert.equal(out.length, 2, 'zero-liquidity NFT (300) dropped')
    const byId = new Map(out.map((p) => [p.tokenId, p]))
    const p100 = byId.get(100n)!
    const p200 = byId.get(200n)!
    // 100 matches the v3 gauge's (token0,token1,tickSpacing) → enriched.
    assert.equal(p100.tickSpacing, 200)
    assert.equal(p100.gauge, ethers.getAddress(GAUGE_V3))
    assert.equal(p100.claimable, 777n)
    // 200 differs only in tickSpacing → no gauge match → left unenriched.
    assert.equal(p200.tickSpacing, 60)
    assert.equal(p200.gauge, undefined)
    assert.equal(p200.claimable, undefined)
  } finally {
    __resetTopazTestDeps()
    restoreFetch()
    restoreEnv()
  }
})

test('listOpenLpPositions: returns [] when there are no NFTs', async () => {
  const restoreEnv = withEnv({ TOPAZ_NPM: NPM })
  __setTopazTestDeps({
    buildProvider: () =>
      fakeProvider({
        contracts: [{ address: NPM, abi: TOPAZ_NPM_ABI, handlers: { balanceOf: () => [0n] } }],
      }),
  })
  try {
    const out = await listOpenLpPositions(WALLET)
    assert.deepEqual(out, [])
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ══════════════════════════════════════════════════════════════════════
// WRITE MONEY-MOVING PATHS — swap / liquidity. These enforce the
// fail-closed invariants the brain can never be trusted to honour:
// amountOutMin > 0, deadline strictly in the future, server-side
// slippage CAP, broker-fee pre-deduction, and signer routing. We never
// touch a real RPC: a capture provider decodes the calldata leaving the
// wallet with the SAME router ABI production uses, records the on-the-
// wire args, then aborts at estimateGas so nothing broadcasts.
// ══════════════════════════════════════════════════════════════════════

const ROUTER = addr('e1')
const FIXED_NOW_MS = 1_700_000_000_000 // deterministic clock for deadlines
const SWAP_ENV = {
  TOPAZ_MASTER_WALLET_ID: MASTER_WALLET_ID,
  TOPAZ_ROUTER: ROUTER,
  TOPAZ_DEFAULT_SLIPPAGE_BPS: '50', // 0.5%
  TOPAZ_MAX_SLIPPAGE_BPS: '500', // 5% server-side cap
  TOPAZ_DEFAULT_DEADLINE_SEC: '1200', // 20 min
}

interface SwapCapture {
  quoteAmountIn?: bigint
  amountIn?: bigint
  minOut?: bigint
  hops?: unknown
  to?: string
  deadline?: bigint
}

/**
 * Provider stand-in for the swap WRITE path. `call` answers the on-chain
 * reads swap() performs before sending (getAmountsOut quote + ERC-20
 * allowance), and `estimateGas` decodes the swapExactTokensForTokens
 * calldata, records the args, then throws a sentinel so the tx is never
 * signed/broadcast. The sentinel surfaces as the SwapResult.error.
 */
function swapCaptureProvider(opts: {
  amountsOut: bigint[]
  allowance?: bigint
  capture: SwapCapture
}): ethers.AbstractProvider {
  const routerIface = new ethers.Interface(TOPAZ_ROUTER_ABI)
  const ercIface = new ethers.Interface(ERC20_ABI)
  return {
    getNetwork: async () => new ethers.Network('bsc', 56n),
    getBalance: async () => 0n,
    resolveName: async (n: string) => n,
    getTransactionCount: async () => 0,
    getFeeData: async () => new ethers.FeeData(0n, 1_000_000_000n, 1_000_000_000n),
    estimateGas: async (tx: { data?: string }) => {
      const parsed = routerIface.parseTransaction({ data: tx.data ?? '0x' })
      if (parsed?.name === 'swapExactTokensForTokens') {
        opts.capture.amountIn = parsed.args[0] as bigint
        opts.capture.minOut = parsed.args[1] as bigint
        opts.capture.hops = parsed.args[2]
        opts.capture.to = parsed.args[3] as string
        opts.capture.deadline = parsed.args[4] as bigint
        throw new Error('topaz_test_captured')
      }
      throw new Error(`unexpected_estimate_gas:${parsed?.name}`)
    },
    call: async (tx: { to?: string; data?: string }) => {
      const data = tx.data ?? '0x'
      // Router read: getAmountsOut (the on-chain re-quote).
      try {
        const parsed = routerIface.parseTransaction({ data })
        if (parsed?.name === 'getAmountsOut') {
          opts.capture.quoteAmountIn = parsed.args[0] as bigint
          return routerIface.encodeFunctionResult('getAmountsOut', [opts.amountsOut])
        }
      } catch {
        /* not a router call — fall through to ERC-20 */
      }
      // ERC-20 read: allowance (so ensureAllowance skips the approve tx).
      const parsedErc = ercIface.parseTransaction({ data })
      if (parsedErc?.name === 'allowance') {
        return ercIface.encodeFunctionResult('allowance', [opts.allowance ?? ethers.MaxUint256])
      }
      throw new Error(`unexpected_call:${tx.to}`)
    },
  } as unknown as ethers.AbstractProvider
}

const oneHopRoute = { kind: 'v2' as const, hops: [{ from: TKA, to: TKB, stable: false }] }

// ── swap: mixed routes refused in Phase 1 ─────────────────────────────
test('swap: refuses a mixed route in Phase 1 (topaz_mixed_swap_not_enabled_phase1)', async () => {
  const r = await swap({
    tokenIn: TKA,
    tokenOut: TKB,
    amountIn: 1000n,
    route: { kind: 'mixed', path: '0xdead' },
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'topaz_mixed_swap_not_enabled_phase1')
})

// ── swap: non-zero minOut + future deadline, no fee ───────────────────
test('swap: sends a non-zero amountOutMin and a future deadline (never 0)', async () => {
  const restoreEnv = withEnv(SWAP_ENV)
  const capture: SwapCapture = {}
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () => swapCaptureProvider({ amountsOut: [1000n, 1_000_000n], capture }),
  })
  try {
    const r = await swap({ tokenIn: TKA, tokenOut: TKB, amountIn: 1000n, route: oneHopRoute })
    // Sentinel from estimateGas: routing + arg-stamping already happened.
    assert.equal(r.ok, false)
    assert.equal(r.error, 'topaz_test_captured')
    // amountOutMin = 1_000_000 × (10000-50)/10000 = 995000, strictly > 0.
    assert.equal(capture.minOut, 995_000n)
    assert.ok((capture.minOut ?? 0n) > 0n, 'minOut must never be zero')
    // deadline = floor(now/1000) + 1200, strictly in the future.
    const nowSec = Math.floor(FIXED_NOW_MS / 1000)
    assert.equal(capture.deadline, BigInt(nowSec + 1200))
    assert.ok((capture.deadline ?? 0n) > BigInt(nowSec), 'deadline must be in the future')
    assert.notEqual(capture.deadline, 0n)
    // No fee → the full amountIn is both quoted and swapped.
    assert.equal(capture.quoteAmountIn, 1000n)
    assert.equal(capture.amountIn, 1000n)
    assert.equal((capture.to ?? '').toLowerCase(), WALLET.toLowerCase(), 'recipient is the signer wallet')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ── swap: server-side slippage CAP clamps a hostile override ───────────
test('swap: clamps an absurd slippage override to maxSlippageBps (no free trade)', async () => {
  const restoreEnv = withEnv(SWAP_ENV)
  const capture: SwapCapture = {}
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () => swapCaptureProvider({ amountsOut: [1000n, 1_000_000n], capture }),
  })
  try {
    // Caller asks for 100% slippage (10000 bps). The server caps it at
    // maxSlippageBps (500) → minOut = 1_000_000 × 9500/10000 = 950000.
    const r = await swap({
      tokenIn: TKA,
      tokenOut: TKB,
      amountIn: 1000n,
      route: oneHopRoute,
      slippageBps: 10_000,
    })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'topaz_test_captured')
    assert.equal(capture.minOut, 950_000n, 'clamped to 5% cap, not 100%')
    assert.ok((capture.minOut ?? 0n) > 0n, 'cap still yields a protective non-zero minOut')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ── swap: broker fee pre-deducted from amountIn BEFORE re-quoting ──────
test('swap: pre-deducts the broker fee from amountIn before re-quoting (feeCtx set)', async () => {
  const restoreEnv = withEnv(SWAP_ENV)
  const capture: SwapCapture = {}
  const feeCalls: Array<{ pk: string; token: string; gross: bigint; ctx: FeeContext }> = []
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () => swapCaptureProvider({ amountsOut: [970n, 1_000_000n], capture }),
    chargeErc20Fee: async (pk, token, gross, ctx): Promise<FeeResult> => {
      feeCalls.push({ pk, token, gross, ctx })
      // Simulate a 30 bps deduction: 1000 → 970 net.
      return { netWei: 970n, feeWei: 30n, feeTxHash: '0xfee', bps: 30 }
    },
  })
  try {
    const r = await swap({
      tokenIn: TKA,
      tokenOut: TKB,
      amountIn: 1000n,
      route: oneHopRoute,
      feeCtx: { userId: 'user-1' } as unknown as FeeContext,
    })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'topaz_test_captured')
    // Fee charged once, on the GROSS input token, stamped venue/side.
    assert.equal(feeCalls.length, 1)
    assert.equal(feeCalls[0].token, TKA)
    assert.equal(feeCalls[0].gross, 1000n)
    assert.equal(feeCalls[0].ctx.venue, 'topaz')
    assert.equal(feeCalls[0].ctx.side, 'swap')
    assert.equal(feeCalls[0].ctx.userId, 'user-1')
    // The NET (970), not the gross (1000), is what gets quoted + swapped.
    assert.equal(capture.quoteAmountIn, 970n, 'quote uses the post-fee net')
    assert.equal(capture.amountIn, 970n, 'swap sends the post-fee net')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ── swap: signer routing (userId → user wallet, omitted → master) ─────
test('swap: with userId signs from the user\'s active BSC wallet', async () => {
  const restoreEnv = withEnv(SWAP_ENV)
  const capture: SwapCapture = {}
  const loadCalls: string[] = []
  const findFirstCalls: unknown[] = []
  const origFindFirst = db.wallet.findFirst
  ;(db.wallet as { findFirst: unknown }).findFirst = async (arg: unknown) => {
    findFirstCalls.push(arg)
    return { id: 'user-wallet-id', address: WALLET, encryptedPK: 'enc', chain: 'BSC', userId: 'user-1', isActive: true }
  }
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async (walletId: string) => {
      loadCalls.push(walletId)
      return { address: WALLET, privateKey: VALID_PK }
    },
    buildProvider: () => swapCaptureProvider({ amountsOut: [1000n, 1_000_000n], capture }),
  })
  try {
    const r = await swap({ tokenIn: TKA, tokenOut: TKB, amountIn: 1000n, route: oneHopRoute, userId: 'user-1' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'topaz_test_captured')
    assert.equal(findFirstCalls.length, 1, 'user path looks up the user wallet')
    assert.deepEqual(
      (findFirstCalls[0] as { where: Record<string, unknown> }).where,
      { userId: 'user-1', chain: 'BSC', isActive: true },
    )
    assert.deepEqual(loadCalls, ['user-wallet-id'], 'signer built from the user wallet, not the master')
  } finally {
    ;(db.wallet as { findFirst: typeof origFindFirst }).findFirst = origFindFirst
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('swap: without userId signs from the configured master wallet (no user lookup)', async () => {
  const restoreEnv = withEnv(SWAP_ENV)
  const capture: SwapCapture = {}
  const loadCalls: string[] = []
  const findFirstCalls: unknown[] = []
  const origFindFirst = db.wallet.findFirst
  ;(db.wallet as { findFirst: unknown }).findFirst = async (arg: unknown) => {
    findFirstCalls.push(arg)
    return null
  }
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async (walletId: string) => {
      loadCalls.push(walletId)
      return { address: WALLET, privateKey: VALID_PK }
    },
    buildProvider: () => swapCaptureProvider({ amountsOut: [1000n, 1_000_000n], capture }),
  })
  try {
    const r = await swap({ tokenIn: TKA, tokenOut: TKB, amountIn: 1000n, route: oneHopRoute })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'topaz_test_captured')
    assert.equal(findFirstCalls.length, 0, 'agent path never looks up a user wallet')
    assert.deepEqual(loadCalls, [MASTER_WALLET_ID], 'signer built from the master wallet')
  } finally {
    ;(db.wallet as { findFirst: typeof origFindFirst }).findFirst = origFindFirst
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ══════════════════════════════════════════════════════════════════════
// applySlippage — pure guard. amountOutMin = quoted × (1 - bps/10000),
// rounded DOWN. Fails closed on a negative bps, a ≥100% slippage, or a
// minOut that rounds to zero.
// ══════════════════════════════════════════════════════════════════════
test('applySlippage: rounds DOWN and never returns a zero/negative minOut', () => {
  assert.equal(applySlippage(1_000_000n, 50), 995_000n) // 0.5%
  assert.equal(applySlippage(1_000_000n, 500), 950_000n) // 5%
  assert.equal(applySlippage(1_000_000n, 0), 1_000_000n) // 0% = no haircut
  // Rounds down (conservative): 9999 × 9950/10000 = 9949.005 → 9949.
  assert.equal(applySlippage(9999n, 50), 9949n)
})

test('applySlippage: refuses 100% slippage (topaz_slippage_too_large)', () => {
  assert.throws(() => applySlippage(1_000_000n, 10_000), /topaz_slippage_too_large/)
  assert.throws(() => applySlippage(1_000_000n, 20_000), /topaz_slippage_too_large/)
})

test('applySlippage: refuses a negative or non-finite bps (topaz_invalid_slippage_bps)', () => {
  assert.throws(() => applySlippage(1_000_000n, -1), /topaz_invalid_slippage_bps/)
  assert.throws(() => applySlippage(1_000_000n, Number.NaN), /topaz_invalid_slippage_bps/)
})

test('applySlippage: refuses a minOut that rounds to zero (topaz_min_out_zero)', () => {
  // 1 × 9950/10000 = 0.995 → 0 → fail-closed rather than send a 0-min swap.
  assert.throws(() => applySlippage(1n, 50), /topaz_min_out_zero/)
})

// ══════════════════════════════════════════════════════════════════════
// computeDeadline — always strictly in the future, honours a positive
// override, falls back to the config default otherwise. Never 0.
// ══════════════════════════════════════════════════════════════════════
test('computeDeadline: stamps now + default and is always in the future (never 0)', () => {
  const restoreEnv = withEnv({ TOPAZ_DEFAULT_DEADLINE_SEC: '1200' })
  __setTopazTestDeps({ now: () => FIXED_NOW_MS })
  try {
    const cfg = getTopazConfig()
    const nowSec = Math.floor(FIXED_NOW_MS / 1000)
    assert.equal(computeDeadline(cfg), nowSec + 1200)
    // A positive override wins; a 0/negative override falls back to default.
    assert.equal(computeDeadline(cfg, 60), nowSec + 60)
    assert.equal(computeDeadline(cfg, 0), nowSec + 1200)
    assert.equal(computeDeadline(cfg, -99), nowSec + 1200)
    assert.ok(computeDeadline(cfg) > nowSec, 'deadline strictly in the future')
    assert.notEqual(computeDeadline(cfg), 0)
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ══════════════════════════════════════════════════════════════════════
// addV2Liquidity / removeV2Liquidity — input guards fail closed BEFORE
// any signer/wallet work (no provider needed: they throw up-front).
// ══════════════════════════════════════════════════════════════════════
test('addV2Liquidity: refuses non-positive desired amounts (topaz_invalid_lp_amounts)', async () => {
  const loadCalls: string[] = []
  __setTopazTestDeps({ loadWallet: async (id) => { loadCalls.push(id); return { address: WALLET, privateKey: VALID_PK } } })
  try {
    const r = await addV2Liquidity({ tokenA: TKA, tokenB: TKB, stable: false, amountADesired: 0n, amountBDesired: 100n })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'topaz_invalid_lp_amounts')
    const r2 = await addV2Liquidity({ tokenA: TKA, tokenB: TKB, stable: false, amountADesired: 100n, amountBDesired: 0n })
    assert.equal(r2.error, 'topaz_invalid_lp_amounts')
    assert.equal(loadCalls.length, 0, 'no wallet decryption on the invalid-amounts path')
  } finally {
    __resetTopazTestDeps()
  }
})

test('addV2Liquidity: fails closed when the pair has no on-chain v2 reserves', async () => {
  const restoreEnv = withEnv(SWAP_ENV)
  const PAIR = addr('f1')
  const routerIface = new ethers.Interface(TOPAZ_ROUTER_ABI)
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () => ({
      getNetwork: async () => new ethers.Network('bsc', 56n),
      call: async (tx: { to?: string; data?: string }) => {
        const parsed = routerIface.parseTransaction({ data: tx.data ?? '0x' })
        if (parsed?.name === 'pairFor') return routerIface.encodeFunctionResult('pairFor', [PAIR])
        // getPoolStats(PAIR) reads revert → pool treated as nonexistent.
        throw new Error('fake_revert')
      },
    }) as unknown as ethers.AbstractProvider,
  })
  try {
    const r = await addV2Liquidity({ tokenA: TKA, tokenB: TKB, stable: false, amountADesired: 100n, amountBDesired: 100n })
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /topaz_pool_not_found/)
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('removeV2Liquidity: refuses a zero burn amount or zero min-outs (fail closed)', async () => {
  const loadCalls: string[] = []
  __setTopazTestDeps({ loadWallet: async (id) => { loadCalls.push(id); return { address: WALLET, privateKey: VALID_PK } } })
  try {
    const zeroBurn = await removeV2Liquidity({ tokenA: TKA, tokenB: TKB, stable: false, liquidity: 0n, amountAMin: 1n, amountBMin: 1n })
    assert.equal(zeroBurn.error, 'topaz_invalid_lp_burn_amount')
    const zeroMin = await removeV2Liquidity({ tokenA: TKA, tokenB: TKB, stable: false, liquidity: 10n, amountAMin: 0n, amountBMin: 1n })
    assert.equal(zeroMin.error, 'topaz_remove_lp_min_zero')
    const zeroMinB = await removeV2Liquidity({ tokenA: TKA, tokenB: TKB, stable: false, liquidity: 10n, amountAMin: 1n, amountBMin: 0n })
    assert.equal(zeroMinB.error, 'topaz_remove_lp_min_zero')
    assert.equal(loadCalls.length, 0, 'no wallet decryption on the invalid-args path')
  } finally {
    __resetTopazTestDeps()
  }
})

// ══════════════════════════════════════════════════════════════════════
// mintV3Position — input guards + the out-of-range / tick-alignment
// fail-closed invariants (an out-of-range farm position earns ZERO).
// ══════════════════════════════════════════════════════════════════════
test('mintV3Position: refuses an inverted tick range and zero amounts (up-front)', async () => {
  const loadCalls: string[] = []
  __setTopazTestDeps({ loadWallet: async (id) => { loadCalls.push(id); return { address: WALLET, privateKey: VALID_PK } } })
  try {
    const inverted = await mintV3Position({ pool: POOL_V3, tickLower: 100, tickUpper: 100, amount0Desired: 1n, amount1Desired: 1n, intendsToFarm: false })
    assert.match(inverted.error ?? '', /topaz_invalid_tick_range/)
    const zero = await mintV3Position({ pool: POOL_V3, tickLower: -100, tickUpper: 100, amount0Desired: 0n, amount1Desired: 0n, intendsToFarm: false })
    assert.equal(zero.error, 'topaz_v3_mint_zero_amounts')
    assert.equal(loadCalls.length, 0, 'no wallet work on the up-front-guard paths')
  } finally {
    __resetTopazTestDeps()
  }
})

function v3PoolContract(opts: { tick: number; tickSpacing: number }): FakeContract {
  return {
    address: POOL_V3,
    abi: TOPAZ_CL_POOL_ABI,
    handlers: {
      token0: () => [TKA],
      token1: () => [TKB],
      slot0: () => [79228162514264337593543950336n, opts.tick, 0, 0, 0, false],
      liquidity: () => [1000n],
      fee: () => [500],
      tickSpacing: () => [opts.tickSpacing],
    },
  }
}

test('mintV3Position: refuses ticks not aligned to the pool tickSpacing', async () => {
  const restoreEnv = withEnv(SWAP_ENV)
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () => fakeProvider({ contracts: [v3PoolContract({ tick: 0, tickSpacing: 200 })] }),
  })
  try {
    // 150 is not a multiple of 200 → refuse before any mint.
    const r = await mintV3Position({ pool: POOL_V3, tickLower: -150, tickUpper: 150, amount0Desired: 1n, amount1Desired: 1n, intendsToFarm: false })
    assert.match(r.error ?? '', /topaz_ticks_not_aligned_to_spacing/)
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('mintV3Position: refuses an out-of-range farm position (would earn ZERO)', async () => {
  const restoreEnv = withEnv(SWAP_ENV)
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    // Current tick 5000 sits ABOVE the [-200, 200] window.
    buildProvider: () => fakeProvider({ contracts: [v3PoolContract({ tick: 5000, tickSpacing: 200 })] }),
  })
  try {
    const r = await mintV3Position({ pool: POOL_V3, tickLower: -200, tickUpper: 200, amount0Desired: 1n, amount1Desired: 1n, intendsToFarm: true })
    assert.match(r.error ?? '', /topaz_out_of_range_mint_refused/)
    // Same out-of-range window is allowed when NOT farming (no emissions claim).
    // (still aborts later for lack of a write path, but never on the range guard)
    const r2 = await mintV3Position({ pool: POOL_V3, tickLower: -200, tickUpper: 200, amount0Desired: 1n, amount1Desired: 1n, intendsToFarm: false })
    assert.doesNotMatch(r2.error ?? '', /topaz_out_of_range_mint_refused/)
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ══════════════════════════════════════════════════════════════════════
// burnV3Position — closing a concentrated-LP position. The exit must NOT
// be sandwichable: decreaseLiquidity is first quoted via a staticCall,
// then sent with a slippage-bounded amount0Min/amount1Min derived from
// that quote. If the NPM impl can't staticCall, the burn fails closed
// rather than send a 0-min unwind (which a frontrun/backrun could skim).
// The provider answers `positions` + the decreaseLiquidity staticCall via
// `call`, captures the REAL decreaseLiquidity/collect/burn sends via
// `estimateGas` (recording order + min-outs), and lets each tx "broadcast"
// through a fake response so collect + burn are only reached after a
// successful decrease.
// ══════════════════════════════════════════════════════════════════════

interface BurnCapture {
  order: string[]
  decLiquidity?: bigint
  amount0Min?: bigint
  amount1Min?: bigint
  decDeadline?: bigint
  collectRecipient?: string
  burnTokenId?: bigint
}

function burnCaptureProvider(opts: {
  liquidity: bigint
  // staticCall decreaseLiquidity result; null ⇒ staticCall reverts (NPM
  // impl doesn't support it) so the burn must fail closed.
  quote: [bigint, bigint] | null
  capture: BurnCapture
}): ethers.AbstractProvider {
  const npmIface = new ethers.Interface(TOPAZ_NPM_ABI)
  let nonce = 0
  return {
    getNetwork: async () => new ethers.Network('bsc', 56n),
    getBalance: async () => 0n,
    resolveName: async (n: string) => n,
    getBlockNumber: async () => 1,
    getTransactionCount: async () => nonce++,
    getFeeData: async () => new ethers.FeeData(0n, 1_000_000_000n, 1_000_000_000n),
    // Real (non-static) sends land here first. We record the function +
    // its on-the-wire args, then return a gas estimate so the wallet goes
    // on to sign + "broadcast".
    estimateGas: async (tx: { data?: string }) => {
      const parsed = npmIface.parseTransaction({ data: tx.data ?? '0x' })
      if (!parsed) throw new Error('burn_unparseable_send')
      opts.capture.order.push(parsed.name)
      if (parsed.name === 'decreaseLiquidity') {
        const p = parsed.args[0] as {
          liquidity: bigint
          amount0Min: bigint
          amount1Min: bigint
          deadline: bigint
        }
        opts.capture.decLiquidity = p.liquidity
        opts.capture.amount0Min = p.amount0Min
        opts.capture.amount1Min = p.amount1Min
        opts.capture.decDeadline = p.deadline
      } else if (parsed.name === 'collect') {
        opts.capture.collectRecipient = (parsed.args[0] as { recipient: string }).recipient
      } else if (parsed.name === 'burn') {
        opts.capture.burnTokenId = parsed.args[0] as bigint
      }
      return 200_000n
    },
    broadcastTransaction: async (signedTx: string) => {
      const txObj = ethers.Transaction.from(signedTx)
      const hash = txObj.hash ?? '0xburnhash'
      return { hash, wait: async () => ({ hash, status: 1 }) }
    },
    // tx.wait(1) resolves through the provider's receipt lookup, not the
    // broadcast response itself — return a 1-confirmation success receipt.
    getTransactionReceipt: async (hash: string) => ({
      hash,
      status: 1,
      logs: [],
      confirmations: async () => 1,
    }),
    // Reads: positions() + the decreaseLiquidity staticCall (the quote).
    call: async (tx: { data?: string }) => {
      const parsed = npmIface.parseTransaction({ data: tx.data ?? '0x' })
      if (!parsed) throw new Error('burn_unparseable_call')
      if (parsed.name === 'positions') {
        return npmIface.encodeFunctionResult('positions', [
          0n, ethers.ZeroAddress, TKA, TKB, 200, -100, 100, opts.liquidity, 0n, 0n, 0n, 0n,
        ])
      }
      if (parsed.name === 'decreaseLiquidity') {
        // This is the .staticCall quote. null ⇒ unsupported → revert.
        if (!opts.quote) throw new Error('fake_static_call_unsupported')
        return npmIface.encodeFunctionResult('decreaseLiquidity', [opts.quote[0], opts.quote[1]])
      }
      throw new Error(`unexpected_burn_call:${parsed.name}`)
    },
  } as unknown as ethers.AbstractProvider
}

// ── burn: derives a non-zero, slippage-bounded min-out from the quote ──
test('burnV3Position: enforces a slippage-bounded min-out from the staticCall quote (no 0-min unwind)', async () => {
  const restoreEnv = withEnv({ ...SWAP_ENV, TOPAZ_NPM: NPM })
  const capture: BurnCapture = { order: [] }
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () => burnCaptureProvider({ liquidity: 5_000n, quote: [1_000_000n, 2_000_000n], capture }),
  })
  try {
    const r = await burnV3Position(7n)
    assert.equal(r.ok, true, 'full decrease → collect → burn succeeds')
    // maxSlippageBps = 500 (5%): 1_000_000 × 9500/10000 = 950_000,
    // 2_000_000 × 9500/10000 = 1_900_000. Both strictly > 0.
    assert.equal(capture.decLiquidity, 5_000n, 'unwinds the full position liquidity')
    assert.equal(capture.amount0Min, 950_000n)
    assert.equal(capture.amount1Min, 1_900_000n)
    assert.ok((capture.amount0Min ?? 0n) > 0n, 'amount0Min must never be zero')
    assert.ok((capture.amount1Min ?? 0n) > 0n, 'amount1Min must never be zero')
    // The min-out is exactly applySlippage(quote, cap), proving it is
    // derived from the quote rather than hard-coded.
    assert.equal(capture.amount0Min, applySlippage(1_000_000n, 500))
    assert.equal(capture.amount1Min, applySlippage(2_000_000n, 500))
    // deadline strictly in the future, never 0.
    const nowSec = Math.floor(FIXED_NOW_MS / 1000)
    assert.equal(capture.decDeadline, BigInt(nowSec + 1200))
    assert.ok((capture.decDeadline ?? 0n) > BigInt(nowSec))
    // collect + burn are reached, in order, only AFTER the decrease.
    assert.deepEqual(capture.order, ['decreaseLiquidity', 'collect', 'burn'])
    assert.equal((capture.collectRecipient ?? '').toLowerCase(), WALLET.toLowerCase(), 'output collected to the signer')
    assert.equal(capture.burnTokenId, 7n)
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ── burn: one-sided quote → that side bounded, the empty side 0n ───────
test('burnV3Position: bounds the non-zero quoted side and leaves a zero-quoted side at 0', async () => {
  const restoreEnv = withEnv({ ...SWAP_ENV, TOPAZ_NPM: NPM })
  const capture: BurnCapture = { order: [] }
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    // Position quotes out entirely as token0 (e.g. price moved out of range).
    buildProvider: () => burnCaptureProvider({ liquidity: 9n, quote: [1_000_000n, 0n], capture }),
  })
  try {
    const r = await burnV3Position(3n)
    assert.equal(r.ok, true)
    assert.equal(capture.amount0Min, 950_000n, 'quoted side is slippage-bounded')
    assert.equal(capture.amount1Min, 0n, 'a side that quotes 0 stays 0 (nothing to protect)')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ── burn: fails closed when the NPM impl can't staticCall ─────────────
test('burnV3Position: fails closed (topaz_burn_static_call_unsupported) and never sends a 0-min unwind', async () => {
  const restoreEnv = withEnv({ ...SWAP_ENV, TOPAZ_NPM: NPM })
  const capture: BurnCapture = { order: [] }
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    // quote: null ⇒ the decreaseLiquidity staticCall reverts.
    buildProvider: () => burnCaptureProvider({ liquidity: 5_000n, quote: null, capture }),
  })
  try {
    const r = await burnV3Position(7n)
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /topaz_burn_static_call_unsupported/)
    // Crucially: NO write tx was ever sent — not the unwind, not collect,
    // not burn. A failed quote must not degrade into a 0-min exit.
    assert.deepEqual(capture.order, [], 'no decreaseLiquidity/collect/burn after a failed quote')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ── burn: a zero / negative tokenId is rejected up front ──────────────
test('burnV3Position: rejects a zero or negative tokenId before any wallet work', async () => {
  const loadCalls: string[] = []
  __setTopazTestDeps({
    loadWallet: async (id) => {
      loadCalls.push(id)
      return { address: WALLET, privateKey: VALID_PK }
    },
  })
  try {
    const zero = await burnV3Position(0n)
    assert.equal(zero.ok, false)
    assert.equal(zero.error, 'topaz_invalid_token_id')
    const neg = await burnV3Position(-1n)
    assert.equal(neg.ok, false)
    assert.equal(neg.error, 'topaz_invalid_token_id')
    assert.equal(loadCalls.length, 0, 'no wallet decryption on the invalid-tokenId path')
  } finally {
    __resetTopazTestDeps()
  }
})

// ── burn: zero-liquidity position skips the decrease, still collects+burns ─
test('burnV3Position: skips the unwind (no staticCall) when the position has zero liquidity', async () => {
  const restoreEnv = withEnv({ ...SWAP_ENV, TOPAZ_NPM: NPM })
  const capture: BurnCapture = { order: [] }
  __setTopazTestDeps({
    now: () => FIXED_NOW_MS,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    // liquidity 0 → the `if (pos.liquidity > 0n)` branch is skipped, so the
    // staticCall (quote: null here) is never reached and can't blow up.
    buildProvider: () => burnCaptureProvider({ liquidity: 0n, quote: null, capture }),
  })
  try {
    const r = await burnV3Position(7n)
    assert.equal(r.ok, true)
    // Only collect + burn — the decrease (and its staticCall) is skipped.
    assert.deepEqual(capture.order, ['collect', 'burn'])
    assert.equal(capture.amount0Min, undefined, 'no decreaseLiquidity send at all')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})
// ══════════════════════════════════════════════════════════════════════
// stakeInGauge / unstakeFromGauge — the gauge WRITE paths. The single
// invariant that can silently strand funds: v3 CLGauge.deposit pulls the
// LP NFT via safeTransferFrom and REVERTS (NOT_APPROVED) unless the NFT
// is setApprovalForAll'd to the gauge FIRST. v2 deposit/withdraw must
// also refuse a zero/missing amount, and v3 a missing tokenId, before any
// chain work. We use a write-capture provider: reads (isApprovedForAll)
// answer via .call(), and every broadcast transaction is decoded with the
// same ABIs production uses and recorded IN ORDER, so the test asserts the
// exact on-chain sequence (approve THEN deposit) — not just that a write
// happened.
// ══════════════════════════════════════════════════════════════════════

const GAUGE_ENV = {
  TOPAZ_MASTER_WALLET_ID: MASTER_WALLET_ID,
  TOPAZ_NPM: NPM,
}

interface WriteCall {
  to: string
  name: string
  args: unknown[]
}

/**
 * Provider stand-in for the gauge WRITE paths. `.call()` answers the
 * isApprovedForAll read; every signed tx that ethers broadcasts is parsed
 * (against the NPM + v2-gauge + v3-gauge ABIs) and appended to `record`,
 * then acknowledged with a status:1 receipt so `tx.wait(1)` resolves and
 * the function continues to its NEXT write. That lets one test observe the
 * full ordered sequence the wallet actually emits.
 */
function writeCaptureProvider(opts: {
  record: WriteCall[]
  contracts?: FakeContract[]
}): ethers.AbstractProvider {
  const reg = new Map<string, { iface: ethers.Interface; handlers: Handlers }>()
  for (const c of opts.contracts ?? []) {
    reg.set(c.address.toLowerCase(), { iface: new ethers.Interface(c.abi), handlers: c.handlers })
  }
  const decoders = [
    new ethers.Interface(TOPAZ_NPM_ABI),
    new ethers.Interface(TOPAZ_GAUGE_ABI),
    new ethers.Interface(TOPAZ_CL_GAUGE_ABI),
  ]
  const ZERO_HASH = '0x' + '0'.repeat(64)
  return {
    getNetwork: async () => new ethers.Network('bsc', 56n),
    getBalance: async () => 0n,
    resolveName: async (n: string) => n,
    getTransactionCount: async () => 0,
    getFeeData: async () => new ethers.FeeData(0n, 1_000_000_000n, 1_000_000_000n),
    estimateGas: async () => 21_000n,
    call: async (tx: { to?: string; data?: string }) => {
      const entry = reg.get((tx.to ?? '').toLowerCase())
      if (!entry) throw new Error(`fake_no_contract:${tx.to}`)
      const parsed = entry.iface.parseTransaction({ data: tx.data ?? '0x' })
      if (!parsed) throw new Error('fake_unparseable')
      const handler = entry.handlers[parsed.name]
      if (!handler) throw new Error(`fake_revert:${parsed.name}`)
      return entry.iface.encodeFunctionResult(parsed.name, handler([...parsed.args]))
    },
    broadcastTransaction: async (signedTx: string) => {
      const t = ethers.Transaction.from(signedTx)
      let name = 'unknown'
      let args: unknown[] = []
      for (const iface of decoders) {
        try {
          const parsed = iface.parseTransaction({ data: t.data })
          if (parsed) {
            name = parsed.name
            args = [...parsed.args]
            break
          }
        } catch {
          /* try the next ABI */
        }
      }
      opts.record.push({ to: (t.to ?? '').toLowerCase(), name, args })
      return t
    },
    getTransactionReceipt: async (hash: string) => ({
      hash,
      status: 1,
      to: WALLET,
      from: WALLET,
      logs: [],
      index: 0,
      blockNumber: 1,
      blockHash: ZERO_HASH,
      gasUsed: 21_000n,
      cumulativeGasUsed: 21_000n,
      gasPrice: 0n,
      type: 2,
    }),
  } as unknown as ethers.AbstractProvider
}

// ── stakeInGauge: input guards fail closed (no chain work) ────────────
test('stakeInGauge: v2 refuses a zero/missing lpAmount (topaz_v2_stake_zero_amount)', async () => {
  const restoreEnv = withEnv(GAUGE_ENV)
  __setTopazTestDeps({
    buildProvider: () => failProvider,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
  })
  try {
    const missing = await stakeInGauge({ gauge: GAUGE_A, kind: 'v2' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'topaz_v2_stake_zero_amount')
    const zero = await stakeInGauge({ gauge: GAUGE_A, kind: 'v2', lpAmount: 0n })
    assert.equal(zero.ok, false)
    assert.equal(zero.error, 'topaz_v2_stake_zero_amount')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('stakeInGauge: v3 refuses a missing/zero tokenId (topaz_v3_stake_no_token_id)', async () => {
  const restoreEnv = withEnv(GAUGE_ENV)
  __setTopazTestDeps({
    buildProvider: () => failProvider,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
  })
  try {
    const missing = await stakeInGauge({ gauge: GAUGE_A, kind: 'v3' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'topaz_v3_stake_no_token_id')
    const zero = await stakeInGauge({ gauge: GAUGE_A, kind: 'v3', tokenId: 0n })
    assert.equal(zero.ok, false)
    assert.equal(zero.error, 'topaz_v3_stake_no_token_id')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('stakeInGauge: rejects a malformed gauge address before any chain work', async () => {
  const restoreEnv = withEnv(GAUGE_ENV)
  const loadCalls: string[] = []
  __setTopazTestDeps({
    buildProvider: () => failProvider,
    loadWallet: async (id) => {
      loadCalls.push(id)
      return { address: WALLET, privateKey: VALID_PK }
    },
  })
  try {
    const r = await stakeInGauge({ gauge: '0xbad', kind: 'v3', tokenId: 1n })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'topaz_invalid_gauge:0xbad')
    assert.equal(loadCalls.length, 0, 'no wallet decryption on the invalid-gauge path')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ── stakeInGauge v3: APPROVAL MUST HAPPEN FIRST ───────────────────────
test('stakeInGauge: v3 setApprovalForAll(gauge,true) THEN deposit(tokenId) when not yet approved', async () => {
  const restoreEnv = withEnv(GAUGE_ENV)
  const record: WriteCall[] = []
  __setTopazTestDeps({
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () =>
      writeCaptureProvider({
        record,
        // isApprovedForAll(owner, gauge) → false → approval is required.
        contracts: [
          { address: NPM, abi: TOPAZ_NPM_ABI, handlers: { isApprovedForAll: () => [false] } },
        ],
      }),
  })
  try {
    const r = await stakeInGauge({ gauge: GAUGE_V3, kind: 'v3', tokenId: 42n })
    assert.equal(r.ok, true, 'stake completes once approval + deposit both broadcast')
    assert.equal(record.length, 2, 'exactly two writes: approve then deposit')
    // 1. setApprovalForAll(gauge, true) on the NPM (the NFT contract).
    assert.equal(record[0].name, 'setApprovalForAll')
    assert.equal(record[0].to, NPM.toLowerCase(), 'approval targets the NFT manager')
    assert.equal((record[0].args[0] as string).toLowerCase(), GAUGE_V3.toLowerCase())
    assert.equal(record[0].args[1], true)
    // 2. deposit(tokenId) on the gauge — strictly AFTER the approval.
    assert.equal(record[1].name, 'deposit')
    assert.equal(record[1].to, GAUGE_V3.toLowerCase(), 'deposit targets the gauge')
    assert.equal(record[1].args[0], 42n)
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('stakeInGauge: v3 SKIPS setApprovalForAll when already approved, deposits straight away', async () => {
  const restoreEnv = withEnv(GAUGE_ENV)
  const record: WriteCall[] = []
  __setTopazTestDeps({
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () =>
      writeCaptureProvider({
        record,
        contracts: [
          { address: NPM, abi: TOPAZ_NPM_ABI, handlers: { isApprovedForAll: () => [true] } },
        ],
      }),
  })
  try {
    const r = await stakeInGauge({ gauge: GAUGE_V3, kind: 'v3', tokenId: 7n })
    assert.equal(r.ok, true)
    assert.equal(record.length, 1, 'no redundant approval — deposit only')
    assert.equal(
      record.find((w) => w.name === 'setApprovalForAll'),
      undefined,
      'already-approved NFT is never re-approved',
    )
    assert.equal(record[0].name, 'deposit')
    assert.equal(record[0].to, GAUGE_V3.toLowerCase())
    assert.equal(record[0].args[0], 7n)
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('stakeInGauge: v2 deposits the lpAmount on the gauge (no NFT approval path)', async () => {
  const restoreEnv = withEnv(GAUGE_ENV)
  const record: WriteCall[] = []
  __setTopazTestDeps({
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () => writeCaptureProvider({ record }),
  })
  try {
    const r = await stakeInGauge({ gauge: GAUGE_A, kind: 'v2', lpAmount: 250n })
    assert.equal(r.ok, true)
    assert.equal(record.length, 1, 'v2 stake is a single deposit — no setApprovalForAll')
    assert.equal(record[0].name, 'deposit')
    assert.equal(record[0].to, GAUGE_A.toLowerCase())
    assert.equal(record[0].args[0], 250n)
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

// ── unstakeFromGauge: same input guards + v2/v3 withdraw routing ──────
test('unstakeFromGauge: v2 refuses a zero/missing lpAmount (topaz_v2_unstake_zero)', async () => {
  const restoreEnv = withEnv(GAUGE_ENV)
  __setTopazTestDeps({
    buildProvider: () => failProvider,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
  })
  try {
    const missing = await unstakeFromGauge({ gauge: GAUGE_A, kind: 'v2' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'topaz_v2_unstake_zero')
    const zero = await unstakeFromGauge({ gauge: GAUGE_A, kind: 'v2', lpAmount: 0n })
    assert.equal(zero.ok, false)
    assert.equal(zero.error, 'topaz_v2_unstake_zero')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('unstakeFromGauge: v3 refuses a missing/zero tokenId (topaz_v3_unstake_no_token_id)', async () => {
  const restoreEnv = withEnv(GAUGE_ENV)
  __setTopazTestDeps({
    buildProvider: () => failProvider,
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
  })
  try {
    const missing = await unstakeFromGauge({ gauge: GAUGE_A, kind: 'v3' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'topaz_v3_unstake_no_token_id')
    const zero = await unstakeFromGauge({ gauge: GAUGE_A, kind: 'v3', tokenId: 0n })
    assert.equal(zero.ok, false)
    assert.equal(zero.error, 'topaz_v3_unstake_no_token_id')
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

test('unstakeFromGauge: routes v2 → withdraw(lpAmount) and v3 → withdraw(tokenId) on the gauge', async () => {
  const restoreEnv = withEnv(GAUGE_ENV)
  const record: WriteCall[] = []
  __setTopazTestDeps({
    loadWallet: async () => ({ address: WALLET, privateKey: VALID_PK }),
    buildProvider: () => writeCaptureProvider({ record }),
  })
  try {
    const v2 = await unstakeFromGauge({ gauge: GAUGE_A, kind: 'v2', lpAmount: 99n })
    assert.equal(v2.ok, true)
    const v3 = await unstakeFromGauge({ gauge: GAUGE_V3, kind: 'v3', tokenId: 5n })
    assert.equal(v3.ok, true)
    assert.equal(record.length, 2)
    // v2 withdraw burns the LP amount on the v2 gauge.
    assert.equal(record[0].name, 'withdraw')
    assert.equal(record[0].to, GAUGE_A.toLowerCase())
    assert.equal(record[0].args[0], 99n)
    // v3 withdraw returns the NFT by tokenId from the CL gauge.
    assert.equal(record[1].name, 'withdraw')
    assert.equal(record[1].to, GAUGE_V3.toLowerCase())
    assert.equal(record[1].args[0], 5n)
  } finally {
    __resetTopazTestDeps()
    restoreEnv()
  }
})

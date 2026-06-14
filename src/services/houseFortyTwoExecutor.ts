// =====================================================================
// houseFortyTwoExecutor — house-wallet 42.space trade + claim wrapper.
//
// Bypasses the user-bound openPredictionPosition (which requires a User
// row + custodial Wallet) and drives FortyTwoTrader directly with
// HOUSE_AGENT_PRIVATE_KEY. State is tracked in HouseLog (no
// OutcomePosition row for the house wallet).
//
// Public surface:
//   - houseOpenFortyTwoPosition(opts)     → buy outcome tokens
//   - houseClaimFortyTwoMarket(addr)      → claim winnings post-resolution
//   - findOpenHousePosition(marketAddr)   → idempotency probe via HouseLog
// =====================================================================

import { ethers } from 'ethers'
import { db } from '../db'
import { FortyTwoTrader, USDT_BSC } from './fortyTwoTrader'
import { readMarketOnchain, quoteRedeemValue } from './fortyTwoOnchain'
import { getMarketByAddress, type Market42 } from './fortyTwo'
import { getHouseSignerPk, getHouseWalletAddress, logHouseBrain } from './houseAgent'

const USDT_DEC = 18

export interface HouseFortyTwoOpenInput {
  marketAddress: string
  tokenId: number
  outcomeLabel: string
  /** Decimal USDT to spend (e.g. "150" = 150 USDT). */
  usdtIn: string
  /** Decision tag for HouseLog row; defaults to OPEN_42. */
  decision?: string
  /** Reasoning string; written to HouseLog.reasoning. */
  reasoning: string
  /** Extra metadata to merge into HouseLog.meta. */
  meta?: Record<string, unknown>
  /** Slippage on minOtOut (basis points of expected out); 0 = no protection. */
  slippageBps?: number
  /** When true, no on-chain calls — synthetic receipt + dry HouseLog row. */
  dryRun?: boolean
  /** 42.space market contract version. >=2 routes through FTRouterProxy (V2,
   *  e.g. World Cup). Defaults to 1 (deprecated V1 router) for back-compat. */
  contractVersion?: number
}

export interface HouseFortyTwoOpenResult {
  ok: true
  dryRun: boolean
  txHash: string | null
  marketAddress: string
  tokenId: number
  outcomeLabel: string
  usdtIn: string
  houseWallet: string
}

/**
 * Check the house USDT balance against an intended spend. Throws a
 * human-readable error when insufficient — better surfaced before the
 * router call than as an opaque revert.
 */
async function assertUsdtBalance(amountWei: bigint): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL ?? 'https://bsc-dataseed1.binance.org/')
  const erc = new ethers.Contract(
    USDT_BSC,
    ['function balanceOf(address) view returns (uint256)'],
    provider,
  )
  const bal: bigint = await erc.balanceOf(getHouseWalletAddress())
  if (bal < amountWei) {
    throw new Error(
      `house USDT balance ${ethers.formatUnits(bal, USDT_DEC)} < required ${ethers.formatUnits(amountWei, USDT_DEC)} (wallet=${getHouseWalletAddress()})`,
    )
  }
  return bal
}

/**
 * Idempotency probe: returns the most recent OPEN_42 HouseLog row for
 * this market (any outcome) if one exists. Caller uses this to refuse a
 * duplicate entry on the same market.
 */
export async function findOpenHousePosition(marketAddress: string): Promise<{
  id: string
  tokenId: number
  outcomeLabel: string
  usdtIn: number
  txHash: string | null
  createdAt: Date
} | null> {
  const addr = ethers.getAddress(marketAddress)
  const rows = await db.$queryRawUnsafe<Array<{
    id: string
    tokenId: number
    outcomeLabel: string
    usdtIn: number
    txHash: string | null
    createdAt: Date
  }>>(
    `SELECT id,
            (meta->>'tokenId')::int        AS "tokenId",
            (meta->>'outcomeLabel')        AS "outcomeLabel",
            (meta->>'usdtIn')::float       AS "usdtIn",
            "txHash",
            "createdAt"
       FROM "HouseLog"
      WHERE dex = '42'
        AND decision = 'OPEN_42'
        AND meta ? 'marketAddress'
        AND LOWER(meta->>'marketAddress') = LOWER($1)
        AND COALESCE((meta->>'dryRun')::boolean, false) = false
      ORDER BY "createdAt" DESC
      LIMIT 1`,
    addr,
  )
  return rows[0] ?? null
}

/**
 * Open a buy-outcome position on a 42.space market from the house wallet.
 * Logs to HouseLog regardless of dry-run. Throws on failure so callers
 * can branch the brain accordingly.
 */
export async function houseOpenFortyTwoPosition(
  input: HouseFortyTwoOpenInput,
): Promise<HouseFortyTwoOpenResult> {
  const market = ethers.getAddress(input.marketAddress)
  const usdtWei = ethers.parseUnits(input.usdtIn, USDT_DEC)
  if (usdtWei <= 0n) throw new Error('usdtIn must be > 0')

  const dryRun = !!input.dryRun
  const pk = getHouseSignerPk()
  const houseWallet = getHouseWalletAddress()
  const decision = input.decision ?? 'OPEN_42'

  if (!dryRun) await assertUsdtBalance(usdtWei)

  const trader = new FortyTwoTrader(pk, process.env.BSC_RPC_URL ?? '', {
    dryRun,
    contractVersion: input.contractVersion,
  })

  // Best-effort minOtOut from on-chain marginal price. We accept a wide
  // band (50% default) because outcome curves on sports markets are thin
  // and a tight bound triggers RouterSlippage on real fills.
  let minOtOut = 0n
  try {
    const m: Market42 = await getMarketByAddress(market)
    const state = await readMarketOnchain(m)
    const oc = state.outcomes.find((o) => o.tokenId === input.tokenId)
    if (oc && oc.marginalPrice > 0n) {
      const expectedTokens = (usdtWei * (10n ** BigInt(USDT_DEC))) / oc.marginalPrice
      const slipBps = BigInt(input.slippageBps ?? 5000) // 50% default
      minOtOut = (expectedTokens * (10000n - slipBps)) / 10000n
    }
  } catch (err) {
    console.warn(`[houseFortyTwoExecutor] minOtOut compute failed: ${(err as Error).message}`)
  }

  let txHash: string | null = null
  try {
    const receipt = await trader.buyOutcome(market, input.tokenId, input.usdtIn, minOtOut)
    txHash = receipt?.hash ?? null
  } catch (err) {
    await logHouseBrain({
      dex: '42',
      kind: 'error',
      decision: 'OPEN_42_FAILED',
      reasoning: `house 42.space buy FAILED on market=${market.slice(0, 10)}… outcome=${input.outcomeLabel}: ${(err as Error).message}`.slice(0, 2000),
      meta: {
        marketAddress: market,
        tokenId: input.tokenId,
        outcomeLabel: input.outcomeLabel,
        usdtIn: Number(input.usdtIn),
        dryRun,
        error: (err as Error).message,
        ...input.meta,
      },
    })
    throw err
  }

  await logHouseBrain({
    dex: '42',
    kind: 'trade',
    decision,
    reasoning: input.reasoning.slice(0, 2000),
    txHash,
    meta: {
      marketAddress: market,
      tokenId: input.tokenId,
      outcomeLabel: input.outcomeLabel,
      usdtIn: Number(input.usdtIn),
      minOtOut: minOtOut.toString(),
      dryRun,
      houseWallet,
      ...input.meta,
    },
  })

  return {
    ok: true,
    dryRun,
    txHash,
    marketAddress: market,
    tokenId: input.tokenId,
    outcomeLabel: input.outcomeLabel,
    usdtIn: input.usdtIn,
    houseWallet,
  }
}

/**
 * Sweep winnings on a resolved 42.space market via the router's
 * claimAllSimple path. Logs CLAIM_42 to HouseLog. Idempotent — re-calling
 * after a previous successful claim just no-ops at the contract level
 * (returns payout=0) and re-records an info row.
 */
export async function houseClaimFortyTwoMarket(
  marketAddress: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: true; txHash: string | null; dryRun: boolean; marketAddress: string }> {
  const market = ethers.getAddress(marketAddress)
  const dryRun = !!opts.dryRun
  const pk = getHouseSignerPk()

  // Sanity check via on-chain meta — if not finalised, surface a clear
  // error instead of letting the router revert with RouterNotClaimableYet.
  // We also harvest contractVersion here so the trader routes V2 (e.g. World
  // Cup) claims through the proxy rather than the deprecated V1 router.
  let mState: Awaited<ReturnType<typeof readMarketOnchain>> | null = null
  let contractVersion = 1
  try {
    const m = await getMarketByAddress(market)
    contractVersion = m.contractVersion ?? 1
    mState = await readMarketOnchain(m)
  } catch (err) {
    console.warn(`[houseFortyTwoExecutor] pre-claim meta load failed: ${(err as Error).message}`)
  }

  const trader = new FortyTwoTrader(pk, process.env.BSC_RPC_URL ?? '', { dryRun, contractVersion })
  if (!dryRun && mState && !mState.isFinalised) {
    throw new Error(`market ${market} is not yet finalised on-chain — claim refused`)
  }

  let txHash: string | null = null
  try {
    const receipt = await trader.claimAllResolved(market)
    txHash = receipt?.hash ?? null
  } catch (err) {
    await logHouseBrain({
      dex: '42',
      kind: 'error',
      decision: 'CLAIM_42_FAILED',
      reasoning: `house 42.space claim FAILED on market=${market.slice(0, 10)}…: ${(err as Error).message}`.slice(0, 2000),
      meta: { marketAddress: market, dryRun, error: (err as Error).message },
    })
    throw err
  }

  await logHouseBrain({
    dex: '42',
    kind: 'trade',
    decision: 'CLAIM_42',
    reasoning: `house 42.space claim swept market=${market.slice(0, 10)}… (finalised=${mState?.isFinalised ?? 'unknown'})`,
    txHash,
    meta: { marketAddress: market, dryRun, isFinalised: mState?.isFinalised ?? null },
  })

  return { ok: true, txHash, dryRun, marketAddress: market }
}

export interface HouseFortyTwoSellInput {
  marketAddress: string
  tokenId: number
  outcomeLabel: string
  /** Decision tag for the HouseLog row; defaults to CLOSE_42. */
  decision?: string
  reasoning: string
  meta?: Record<string, unknown>
  /** Slippage band on minUsdtOut (bps of quoted redeem value); default 50%. */
  slippageBps?: number
  dryRun?: boolean
  /** 42.space market contract version (>=2 → FTRouterProxy). */
  contractVersion?: number
}

/**
 * Sell the house wallet's ENTIRE balance of a single outcome token back to
 * USDT (used by the World Cup odds-stop exit). No-ops when the wallet holds
 * zero of the token. Logs CLOSE_42 to HouseLog. Throws on router failure so
 * callers can decide whether a partial-basket exit should continue.
 */
export async function houseSellFortyTwoOutcome(
  input: HouseFortyTwoSellInput,
): Promise<{ ok: true; txHash: string | null; dryRun: boolean; sold: boolean; tokenAmount: string }> {
  const market = ethers.getAddress(input.marketAddress)
  const dryRun = !!input.dryRun
  const pk = getHouseSignerPk()
  const decision = input.decision ?? 'CLOSE_42'
  const trader = new FortyTwoTrader(pk, process.env.BSC_RPC_URL ?? '', {
    dryRun,
    contractVersion: input.contractVersion,
  })

  // Read the live balance — selling more than we hold reverts, and a zero
  // balance (e.g. a reverted buy that never minted) means there is nothing
  // to exit, which is a no-op not an error.
  let bal = 0n
  try {
    bal = await trader.balanceOfOutcome(market, input.tokenId)
  } catch (err) {
    console.warn(`[houseFortyTwoExecutor] sell balance read failed: ${(err as Error).message}`)
  }
  if (!dryRun && bal <= 0n) {
    await logHouseBrain({
      dex: '42',
      kind: 'info',
      decision,
      reasoning: `house 42.space sell SKIPPED (zero balance) market=${market.slice(0, 10)}… outcome=${input.outcomeLabel}`,
      meta: { marketAddress: market, tokenId: input.tokenId, outcomeLabel: input.outcomeLabel, sold: false, dryRun, ...input.meta },
    })
    return { ok: true, txHash: null, dryRun, sold: false, tokenAmount: '0' }
  }

  // minUsdtOut from the exact curve redeem quote, with a wide default band —
  // thin sports curves make a tight bound revert with RouterSlippage.
  let minUsdtOut = 0n
  try {
    const quoted = await quoteRedeemValue(market, input.tokenId, bal)
    if (quoted && quoted > 0n) {
      const slipBps = BigInt(input.slippageBps ?? 5000)
      minUsdtOut = (quoted * (10000n - slipBps)) / 10000n
    }
  } catch (err) {
    console.warn(`[houseFortyTwoExecutor] sell minUsdtOut compute failed: ${(err as Error).message}`)
  }

  let txHash: string | null = null
  try {
    const receipt = await trader.sellOutcome(market, input.tokenId, bal, minUsdtOut)
    txHash = receipt?.hash ?? null
  } catch (err) {
    await logHouseBrain({
      dex: '42',
      kind: 'error',
      decision: 'CLOSE_42_FAILED',
      reasoning: `house 42.space sell FAILED market=${market.slice(0, 10)}… outcome=${input.outcomeLabel}: ${(err as Error).message}`.slice(0, 2000),
      meta: { marketAddress: market, tokenId: input.tokenId, outcomeLabel: input.outcomeLabel, dryRun, error: (err as Error).message, ...input.meta },
    })
    throw err
  }

  await logHouseBrain({
    dex: '42',
    kind: 'trade',
    decision,
    reasoning: input.reasoning.slice(0, 2000),
    txHash,
    meta: {
      marketAddress: market,
      tokenId: input.tokenId,
      outcomeLabel: input.outcomeLabel,
      tokenAmount: bal.toString(),
      minUsdtOut: minUsdtOut.toString(),
      sold: true,
      dryRun,
      ...input.meta,
    },
  })

  return { ok: true, txHash, dryRun, sold: true, tokenAmount: bal.toString() }
}

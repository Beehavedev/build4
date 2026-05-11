// =====================================================================
// four.meme — Module 1 (existing-token trading)
// ─────────────────────────────────────────────────────────────────────
// Lets BUILD4 users (and, in Module 2, agents) buy and sell tokens that
// already exist on the four.meme bonding curves on BSC. Token creation
// (Module 3) is deferred — four.meme exposes no public on-chain
// createToken method; creation flows through their authenticated
// /meme-api/v1/private/token/* backend, which they have not shared yet.
//
// ISOLATION CONTRACT
// ──────────────────
// Everything four.meme touches is contained in:
//   • this file
//   • src/abi/fourMeme/*.json
//   • src/bot/commands/fourMeme.ts
//   • a small set of /api/fourmeme/* endpoints in src/server.ts
//   • two idempotent ALTERs in src/ensureTables.ts (DEFAULT false)
//
// Nothing here imports from or calls into the campaign code, the
// Polymarket pipeline, the Aster trader, or the HL trader. The
// `FOUR_MEME_ENABLED` env flag is checked at every external entry
// (bot commands, REST endpoints) and defaults to OFF, so installing
// this module on Render produces zero behaviour change for users
// until the operator explicitly opts in.
//
// PROTOCOL OVERVIEW
// ─────────────────
// Two TokenManager contracts hold the bonding-curve state:
//   • V1 @ 0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC — tokens created
//     before 2024-09-05. Methods: purchaseTokenAMAP / saleToken.
//   • V2 @ 0x5c952063c7fc8610FFDB798152D69F0B9550762b — tokens created
//     after 2024-09-05. Methods: buyTokenAMAP / sellToken.
// One Helper3 contract @ 0xF251F83e40a78868FcfA3FA4599Dad6494E46034
// unifies the read path: getTokenInfo returns the right `tokenManager`
// address + `version` so callers don't have to hard-code which V to
// dispatch to. We also call tryBuy/trySell on Helper3 to get accurate
// pre-trade quotes (estimatedAmount / estimatedCost / amountMsgValue)
// without simulating the trade ourselves.
//
// SLIPPAGE
// ────────
// Every buy and sell enforces a server-side slippage cap. Default 500
// bps (5%) — generous enough to handle four.meme's curve volatility
// while still protecting the user from a sandwich. Caller can tighten
// via opts.slippageBps. We compute minAmount/minFunds from the V3
// quote, never trusting client-supplied minimums.
//
// QUOTE TOKEN
// ───────────
// Module 1 supports BNB-quoted tokens only (the vast majority of
// four.meme launches). BEP20-quoted tokens (`quote != address(0)`)
// would need an ERC20 approval flow before each buy and use of the
// `buyWithEth` Helper3 method — explicitly returned as
// QUOTE_NOT_SUPPORTED until Module 1.1.
// =====================================================================

import { ethers } from 'ethers'
import { buildBscProvider } from './bscProvider'
import { decryptPrivateKey } from './wallet'
import { db } from '../db'

import TokenManagerV1Abi from '../abi/fourMeme/TokenManager.lite.abi.json'
import TokenManagerV2Abi from '../abi/fourMeme/TokenManager2.lite.abi.json'
import TokenManagerHelper3Abi from '../abi/fourMeme/TokenManagerHelper3.abi.json'
import AgentIdentifierAbi from '../abi/fourMeme/AgentIdentifier.abi.json'

// ── Contract addresses on BSC ────────────────────────────────────────
export const FOUR_MEME_V1_TOKEN_MANAGER = '0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC'
export const FOUR_MEME_V2_TOKEN_MANAGER = '0x5c952063c7fc8610FFDB798152D69F0B9550762b'
export const FOUR_MEME_HELPER_V3        = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034'
export const FOUR_MEME_AGENT_IDENTIFIER = '0x09B44A633de9F9EBF6FB9Bdd5b5629d3DD2cef13'

// Default slippage cap (basis points). 500 = 5.00%.
const DEFAULT_SLIPPAGE_BPS = 500
// Hard upper bound on slippage callers can request — anything above
// this is almost certainly a misuse / runaway agent and we'd rather
// surface an error than execute. 20% feels right for four.meme curves.
const MAX_SLIPPAGE_BPS = 2000

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ── Public helpers ───────────────────────────────────────────────────

export function isFourMemeEnabled(): boolean {
  return process.env.FOUR_MEME_ENABLED === 'true'
}

/**
 * Throw a structured error if the feature flag is OFF. Use this at the
 * top of every external entry point (REST handler, bot command).
 */
export function requireFourMemeEnabled(): void {
  if (!isFourMemeEnabled()) {
    const err: any = new Error('four.meme integration is disabled (set FOUR_MEME_ENABLED=true to enable)')
    err.code = 'FOUR_MEME_DISABLED'
    throw err
  }
}

function provider(): ethers.AbstractProvider {
  return buildBscProvider(process.env.BSC_RPC_URL)
}

function helper(): ethers.Contract {
  return new ethers.Contract(FOUR_MEME_HELPER_V3, TokenManagerHelper3Abi as any, provider())
}

function agentIdentifier(): ethers.Contract {
  return new ethers.Contract(FOUR_MEME_AGENT_IDENTIFIER, AgentIdentifierAbi as any, provider())
}

function tokenManagerForVersion(version: bigint, address: string, signer: ethers.Signer): ethers.Contract {
  // Helper3.getTokenInfo returns the token's actual TokenManager
  // address — we trust that over our hardcoded constants (the docs
  // explicitly recommend this in case TokenManager addresses are
  // upgraded). The ABI we pick is dictated by `version`.
  //
  // Versions outside {1, 2} are explicitly refused — defaulting to V2
  // for an unknown version would invoke the wrong selector and at
  // best revert, at worst silently call something unexpected on a
  // future upgraded TokenManager.
  let abi: unknown
  if (version === 1n) abi = TokenManagerV1Abi
  else if (version === 2n) abi = TokenManagerV2Abi
  else {
    const err: any = new Error(`Unsupported four.meme TokenManager version ${version} — only V1 and V2 are wired up`)
    err.code = 'UNSUPPORTED_VERSION'
    throw err
  }
  return new ethers.Contract(address, abi as any, signer)
}

// ── Slippage math (pure, easy to unit test) ───────────────────────────

export function applySlippageDown(amount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps must be an integer in [0, ${MAX_SLIPPAGE_BPS}], got ${slippageBps}`)
  }
  // amount * (10000 - slippageBps) / 10000
  return (amount * BigInt(10000 - slippageBps)) / 10000n
}

export function resolveSlippageBps(opts?: { slippageBps?: number }): number {
  const bps = opts?.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps must be an integer in [0, ${MAX_SLIPPAGE_BPS}], got ${bps}`)
  }
  return bps
}

// ── Token info / quotes (read-only, no signing) ───────────────────────

export interface FourMemeTokenInfo {
  version: number              // 1 or 2 (which TokenManager owns it)
  tokenManager: string         // resolved TokenManager address
  quote: string                // 0x0 = BNB-quoted, else BEP20 address
  quoteIsBnb: boolean
  lastPriceWei: bigint         // last trade price (in quote per token, wei)
  tradingFeeRate: number       // bps (1 = 0.01%)
  minTradingFeeWei: bigint
  launchTime: number           // unix seconds
  offersWei: bigint            // tokens still on the curve
  maxOffersWei: bigint         // total tokens the curve will sell
  fundsWei: bigint             // quote raised so far
  maxFundsWei: bigint          // quote target before liquidity-graduation
  liquidityAdded: boolean      // true once Pancake pair is created
  graduatedToPancake: boolean  // alias for clarity
  fillPct: number              // 0..1 progress along the curve
}

export async function getTokenInfo(tokenAddress: string): Promise<FourMemeTokenInfo> {
  const addr = ethers.getAddress(tokenAddress)
  const [
    version, tokenManager, quote, lastPrice, tradingFeeRate, minTradingFee,
    launchTime, offers, maxOffers, funds, maxFunds, liquidityAdded,
  ] = await helper().getTokenInfo(addr)
  const maxFundsBI = BigInt(maxFunds)
  const fundsBI = BigInt(funds)
  return {
    version: Number(version),
    tokenManager,
    quote,
    quoteIsBnb: quote === ZERO_ADDRESS,
    lastPriceWei: BigInt(lastPrice),
    tradingFeeRate: Number(tradingFeeRate),
    minTradingFeeWei: BigInt(minTradingFee),
    launchTime: Number(launchTime),
    offersWei: BigInt(offers),
    maxOffersWei: BigInt(maxOffers),
    fundsWei: fundsBI,
    maxFundsWei: maxFundsBI,
    liquidityAdded: Boolean(liquidityAdded),
    graduatedToPancake: Boolean(liquidityAdded),
    fillPct: maxFundsBI === 0n ? 0 : Number((fundsBI * 10000n) / maxFundsBI) / 10000,
  }
}

export interface FourMemeBuyQuote {
  tokenManager: string
  quote: string
  estimatedAmountWei: bigint    // tokens you'd receive
  estimatedCostWei: bigint      // quote you'd spend (ex-fee)
  estimatedFeeWei: bigint       // protocol fee (in quote)
  amountMsgValueWei: bigint     // value to send as msg.value
  amountApprovalWei: bigint     // ERC20 approval needed (BEP20 quote only)
  amountFundsWei: bigint        // value to pass as `funds` arg
}

/**
 * Pre-trade quote for a BNB-amount buy. Calls Helper3.tryBuy with
 * amount=0 so it interprets `bnbWei` as funds-based. The returned
 * `amountMsgValue` and `amountFunds` are exactly what we'll pass to
 * the V1/V2 buyTokenAMAP call so the on-chain math matches.
 */
export async function quoteBuyByBnb(tokenAddress: string, bnbWei: bigint): Promise<FourMemeBuyQuote> {
  if (bnbWei <= 0n) throw new Error('bnbWei must be > 0')
  const addr = ethers.getAddress(tokenAddress)
  const [
    tokenManager, quote, estimatedAmount, estimatedCost, estimatedFee,
    amountMsgValue, amountApproval, amountFunds,
  ] = await helper().tryBuy(addr, 0n, bnbWei)
  return {
    tokenManager,
    quote,
    estimatedAmountWei: BigInt(estimatedAmount),
    estimatedCostWei:   BigInt(estimatedCost),
    estimatedFeeWei:    BigInt(estimatedFee),
    amountMsgValueWei:  BigInt(amountMsgValue),
    amountApprovalWei:  BigInt(amountApproval),
    amountFundsWei:     BigInt(amountFunds),
  }
}

export interface FourMemeSellQuote {
  tokenManager: string
  quote: string
  fundsWei: bigint  // quote you'd receive (post-fee)
  feeWei:   bigint
}

export async function quoteSell(tokenAddress: string, tokenAmountWei: bigint): Promise<FourMemeSellQuote> {
  if (tokenAmountWei <= 0n) throw new Error('tokenAmountWei must be > 0')
  const addr = ethers.getAddress(tokenAddress)
  const [tokenManager, quote, funds, fee] = await helper().trySell(addr, tokenAmountWei)
  return {
    tokenManager,
    quote,
    fundsWei: BigInt(funds),
    feeWei:   BigInt(fee),
  }
}

// ── Agent NFT identification ─────────────────────────────────────────

/**
 * Returns true if `walletAddress` holds any whitelisted four.meme
 * Agent NFT. Tokens created from such wallets get the official
 * "Agent Creator" badge. Used by Module 3 (token creation) to decide
 * whether a launch will be eligible for the badge — for Module 1 it's
 * informational only (surfaced in /fourmeme info).
 */
export async function isAgentWallet(walletAddress: string): Promise<boolean> {
  const addr = ethers.getAddress(walletAddress)
  return Boolean(await agentIdentifier().isAgent(addr))
}

// ── Trading (signing required) ───────────────────────────────────────

export interface FourMemeBuyResult {
  txHash: string
  tokenAddress: string
  bnbSpentWei: bigint
  estimatedTokensWei: bigint
  minTokensWei: bigint
  slippageBps: number
  blockNumber?: number
  gasUsedWei?: bigint
}

export interface FourMemeSellResult {
  txHash: string
  tokenAddress: string
  tokensSoldWei: bigint
  estimatedBnbWei: bigint
  minBnbWei: bigint
  slippageBps: number
  blockNumber?: number
  gasUsedWei?: bigint
}

interface BuyOpts {
  slippageBps?: number   // default 500 (5%)
  gasLimit?: bigint      // override gas limit
}

/**
 * Buy tokens on the four.meme curve using BNB.
 *
 * Looks up the token via Helper3 (tells us which TokenManager + ABI
 * to dispatch to and gives us a quote), enforces slippage, then
 * executes against the resolved TokenManager. BEP20-quoted tokens
 * (`quote != 0x0`) are explicitly refused in Module 1 — see the
 * QUOTE_NOT_SUPPORTED error.
 */
export async function buyTokenWithBnb(
  privateKey: string,
  tokenAddress: string,
  bnbWei: bigint,
  opts: BuyOpts = {},
): Promise<FourMemeBuyResult> {
  requireFourMemeEnabled()
  if (bnbWei <= 0n) throw new Error('bnbWei must be > 0')

  const slippageBps = resolveSlippageBps(opts)
  const addr = ethers.getAddress(tokenAddress)
  const signer = new ethers.Wallet(privateKey, provider())

  // Read first — we need to know which TokenManager to dispatch to
  // and the exact `funds` / `msg.value` / `minAmount` to send.
  const info = await getTokenInfo(addr)
  if (!info.quoteIsBnb) {
    const err: any = new Error(`Token ${addr} is BEP20-quoted (quote=${info.quote}); BEP20 quote not supported in Module 1`)
    err.code = 'QUOTE_NOT_SUPPORTED'
    throw err
  }
  if (info.graduatedToPancake) {
    const err: any = new Error(`Token ${addr} has graduated to PancakeSwap; trade it on the AMM, not the bonding curve`)
    err.code = 'GRADUATED'
    throw err
  }

  const quote = await quoteBuyByBnb(addr, bnbWei)
  const minAmount = applySlippageDown(quote.estimatedAmountWei, slippageBps)
  if (minAmount <= 0n) throw new Error('Computed minAmount <= 0; refusing to broadcast')

  const tm = tokenManagerForVersion(BigInt(info.version), info.tokenManager, signer)

  // V1 = purchaseTokenAMAP, V2 = buyTokenAMAP. Same parameter order.
  const fnName = info.version === 1 ? 'purchaseTokenAMAP' : 'buyTokenAMAP'
  const tx = await tm[fnName](addr, quote.amountFundsWei, minAmount, {
    value:   quote.amountMsgValueWei,
    gasLimit: opts.gasLimit,
  })
  const receipt = await tx.wait()

  return {
    txHash: tx.hash,
    tokenAddress: addr,
    bnbSpentWei: quote.amountMsgValueWei,
    estimatedTokensWei: quote.estimatedAmountWei,
    minTokensWei: minAmount,
    slippageBps,
    blockNumber: receipt?.blockNumber,
    gasUsedWei: receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined,
  }
}

interface SellOpts {
  slippageBps?: number   // default 500 (5%)
  gasLimit?: bigint
}

/**
 * Sell tokens back to the four.meme curve.
 *
 * Approval is handled internally: this function checks the user's
 * current ERC20 allowance toward the resolved TokenManager and, if
 * insufficient, broadcasts an `approve(MaxUint256)` and waits for it
 * to mine before placing the sell. The approval is idempotent — once
 * granted, future sells of the same token from the same wallet skip
 * straight to the sell tx. Callers that pre-approved (e.g. the
 * fourMemeLaunchAgent take-profit loop) are unaffected: the allowance
 * check sees max-uint and proceeds directly to sell.
 *
 * Slippage enforcement strategy by version:
 *
 *  • V2 (the vast majority of live tokens — anything created after
 *    2024-09-05): uses the 6-arg `sellToken(origin, token, amount,
 *    minFunds, feeRate, feeRecipient)` overload. `minFunds` is
 *    computed from Helper3.trySell and the configured slippage cap;
 *    the contract REVERTS the trade on-chain if proceeds would be
 *    below `minFunds`. We pass `feeRate=0` and `feeRecipient=0x0`
 *    because BUILD4 takes no router fee here.
 *
 *  • V1 (legacy tokens created before 2024-09-05): the only sell
 *    methods are 2-arg `saleToken(token, amount)` with no `minFunds`
 *    parameter. Since slippage cannot be enforced on-chain we
 *    refuse V1 sells entirely (`V1_SELL_UNSAFE`) — fail-closed,
 *    matching the same philosophy used by the Polymarket integration.
 *    V1 buys still work because `purchaseTokenAMAP` does take a
 *    `minAmount` arg.
 */
export async function sellTokenForBnb(
  privateKey: string,
  tokenAddress: string,
  tokenAmountWei: bigint,
  opts: SellOpts = {},
): Promise<FourMemeSellResult> {
  requireFourMemeEnabled()
  if (tokenAmountWei <= 0n) throw new Error('tokenAmountWei must be > 0')

  const slippageBps = resolveSlippageBps(opts)
  const addr = ethers.getAddress(tokenAddress)
  const signer = new ethers.Wallet(privateKey, provider())

  const info = await getTokenInfo(addr)
  if (!info.quoteIsBnb) {
    const err: any = new Error(`Token ${addr} is BEP20-quoted; BEP20 quote not supported in Module 1`)
    err.code = 'QUOTE_NOT_SUPPORTED'
    throw err
  }
  if (info.version !== 2) {
    const err: any = new Error(
      `Token ${addr} is on TokenManager V${info.version}; sells are refused on non-V2 ` +
      `because the legacy contract has no minFunds parameter and we can't enforce slippage on-chain.`,
    )
    err.code = 'V1_SELL_UNSAFE'
    throw err
  }

  const sq = await quoteSell(addr, tokenAmountWei)
  const minFunds = applySlippageDown(sq.fundsWei, slippageBps)
  if (minFunds <= 0n) throw new Error('Computed minFunds <= 0; refusing to broadcast')

  const tm = tokenManagerForVersion(BigInt(info.version), info.tokenManager, signer)

  // ── Approve-if-needed ──────────────────────────────────────────────
  // The V2 TokenManager.sellToken does an ERC20 transferFrom on the
  // user's tokens, which requires a prior approve() of >=
  // tokenAmountWei. Without this the trade reverts with the canonical
  // OpenZeppelin "ERC20: insufficient allowance". We grant MaxUint256
  // so the user pays for one approve tx ever per (wallet, token), then
  // every subsequent sell of that bag is a single sellToken call.
  const tmAddr = ethers.getAddress(info.tokenManager)
  const erc20 = new ethers.Contract(
    addr,
    [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
    ],
    signer,
  )
  const currentAllowance: bigint = await erc20.allowance(signer.address, tmAddr)
  if (currentAllowance < tokenAmountWei) {
    const approveTx = await erc20.approve(tmAddr, ethers.MaxUint256)
    await approveTx.wait()
  }

  // Disambiguate the overloaded sellToken — ethers v6 requires the
  // explicit signature when multiple overloads exist on one ABI.
  const sellFn = tm.getFunction('sellToken(uint256,address,uint256,uint256,uint256,address)')
  const tx = await sellFn(0n, addr, tokenAmountWei, minFunds, 0n, ZERO_ADDRESS, { gasLimit: opts.gasLimit })
  const receipt = await tx.wait()

  return {
    txHash: tx.hash,
    tokenAddress: addr,
    tokensSoldWei: tokenAmountWei,
    estimatedBnbWei: sq.fundsWei,
    minBnbWei: minFunds,
    slippageBps,
    blockNumber: receipt?.blockNumber,
    gasUsedWei: receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined,
  }
}

// ── Convenience: load a user's BSC wallet PK ─────────────────────────

/**
 * Load + decrypt a user's primary BSC wallet private key. Bot commands
 * and REST endpoints use this to sign on the user's behalf without
 * having to re-implement wallet lookup. Throws on any of: no user, no
 * BSC wallet, decryption failure (e.g. PIN-protected wallet).
 */
export async function loadUserBscPrivateKey(userId: string): Promise<{ address: string; privateKey: string }> {
  // Prefer the *active* BSC wallet so four.meme trades hit the same
  // wallet the user sees in /wallet, /trade, and the mini-app
  // PolygonCard. If somehow no wallet is flagged active (legacy
  // accounts, race during wallet swap), fall back to the oldest BSC
  // wallet — deterministic and at least gives a consistent answer
  // across calls instead of a random pick.
  const wallet =
    (await db.wallet.findFirst({
      where: { userId, chain: 'BSC', isActive: true },
    })) ??
    (await db.wallet.findFirst({
      where: { userId, chain: 'BSC' },
      orderBy: { createdAt: 'asc' },
    }))
  if (!wallet) {
    const err: any = new Error('No BSC wallet found for user')
    err.code = 'NO_WALLET'
    throw err
  }
  // PIN-protected wallets aren't supported in Module 1 — agent / bot
  // flows can't prompt for a PIN mid-trade. Surface clearly.
  if (!wallet.encryptedPK) {
    const err: any = new Error('Wallet has no encrypted PK on file')
    err.code = 'NO_PK'
    throw err
  }
  try {
    const privateKey = decryptPrivateKey(wallet.encryptedPK, userId)
    return { address: wallet.address, privateKey }
  } catch {
    const err: any = new Error('Failed to decrypt wallet (PIN-protected wallets are not supported in Module 1)')
    err.code = 'PK_LOCKED'
    throw err
  }
}

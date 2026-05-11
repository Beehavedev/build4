// ─── PancakeSwap V2 trading (post-migration four.meme tokens) ─────────
//
// Once a four.meme token graduates (liquidity is added on Pancake), the
// bonding-curve TokenManager refuses further trades — the only venue is
// the AMM. This module is the in-app router for that case so users can
// keep buying/selling from inside the mini-app instead of being kicked
// out to pancakeswap.finance.
//
// We use V2 (not V3) deliberately:
//   • four.meme deploys liquidity on PancakeSwap V2 at graduation
//   • V2 has a single canonical router and trivial path construction
//   • Fee-on-transfer-tolerant variants exist on V2 — important for any
//     four.meme token that ships with a transfer tax
//
// All four exposed functions (`pancakeQuoteBuy`, `pancakeQuoteSell`,
// `pancakeBuyTokenWithBnb`, `pancakeSellTokenForBnb`) mirror the
// signatures of their bonding-curve counterparts in fourMemeTrading.ts
// so the server-side dispatcher in src/server.ts can swap them in
// transparently when `info.graduatedToPancake === true`.

import { ethers } from 'ethers'
import { buildBscProvider } from './bscProvider'
import { applySlippageDown, resolveSlippageBps } from './fourMemeTrading'

const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
const WBNB_BSC          = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
]
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]

function provider() { return buildBscProvider(process.env.BSC_RPC_URL) }
function router(signerOrProvider: ethers.Signer | ethers.AbstractProvider) {
  return new ethers.Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, signerOrProvider)
}
function deadline(secondsFromNow = 600): number {
  return Math.floor(Date.now() / 1000) + secondsFromNow
}

// ── Quotes ────────────────────────────────────────────────────────────

export interface PancakeBuyQuote {
  estimatedAmountWei: bigint  // tokens you'd receive
  amountInWei:        bigint  // BNB you'd spend (= input)
  pathTokenAddress:   string
}

export async function pancakeQuoteBuy(
  tokenAddress: string,
  bnbWei: bigint,
): Promise<PancakeBuyQuote> {
  if (bnbWei <= 0n) throw new Error('bnbWei must be > 0')
  const addr = ethers.getAddress(tokenAddress)
  const path = [WBNB_BSC, addr]
  const amounts: bigint[] = await router(provider()).getAmountsOut(bnbWei, path)
  return {
    estimatedAmountWei: BigInt(amounts[amounts.length - 1]),
    amountInWei:        bnbWei,
    pathTokenAddress:   addr,
  }
}

export interface PancakeSellQuote {
  estimatedBnbWei: bigint  // BNB you'd receive
  amountInWei:     bigint
  pathTokenAddress: string
}

export async function pancakeQuoteSell(
  tokenAddress: string,
  tokenAmountWei: bigint,
): Promise<PancakeSellQuote> {
  if (tokenAmountWei <= 0n) throw new Error('tokenAmountWei must be > 0')
  const addr = ethers.getAddress(tokenAddress)
  const path = [addr, WBNB_BSC]
  const amounts: bigint[] = await router(provider()).getAmountsOut(tokenAmountWei, path)
  return {
    estimatedBnbWei: BigInt(amounts[amounts.length - 1]),
    amountInWei:     tokenAmountWei,
    pathTokenAddress: addr,
  }
}

// ── Trades (signing required) ─────────────────────────────────────────

export interface PancakeBuyResult {
  txHash: string
  tokenAddress: string
  bnbSpentWei: bigint
  estimatedTokensWei: bigint
  minTokensWei: bigint
  slippageBps: number
  blockNumber?: number
  gasUsedWei?: bigint
  venue: 'pancakeV2'
}

export async function pancakeBuyTokenWithBnb(
  privateKey: string,
  tokenAddress: string,
  bnbWei: bigint,
  opts: { slippageBps?: number; gasLimit?: bigint } = {},
): Promise<PancakeBuyResult> {
  if (bnbWei <= 0n) throw new Error('bnbWei must be > 0')
  const slippageBps = resolveSlippageBps(opts)
  const addr = ethers.getAddress(tokenAddress)
  const signer = new ethers.Wallet(privateKey, provider())

  const quote = await pancakeQuoteBuy(addr, bnbWei)
  const minOut = applySlippageDown(quote.estimatedAmountWei, slippageBps)
  if (minOut <= 0n) throw new Error('Computed minOut <= 0; refusing to broadcast')

  const path = [WBNB_BSC, addr]
  const tx = await router(signer).swapExactETHForTokensSupportingFeeOnTransferTokens(
    minOut, path, await signer.getAddress(), deadline(),
    { value: bnbWei, gasLimit: opts.gasLimit },
  )
  const receipt = await tx.wait()
  return {
    txHash: tx.hash,
    tokenAddress: addr,
    bnbSpentWei: bnbWei,
    estimatedTokensWei: quote.estimatedAmountWei,
    minTokensWei: minOut,
    slippageBps,
    blockNumber: receipt?.blockNumber,
    gasUsedWei: receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined,
    venue: 'pancakeV2',
  }
}

export interface PancakeSellResult {
  txHash: string
  tokenAddress: string
  tokensSoldWei: bigint
  estimatedBnbWei: bigint
  minBnbWei: bigint
  slippageBps: number
  approvalTxHash?: string
  blockNumber?: number
  gasUsedWei?: bigint
  venue: 'pancakeV2'
}

/**
 * Sells `tokenAmountWei` of `tokenAddress` for BNB on Pancake V2.
 *
 * Handles approval automatically: if the user's allowance to the
 * router is below `tokenAmountWei`, we send a single MaxUint256
 * approval first (one-shot — most users will trade the same token
 * multiple times). Approval tx hash is surfaced on the result for
 * UX/debugging. We use the FoT-tolerant swap variant since some
 * four.meme tokens ship with a transfer tax.
 */
export async function pancakeSellTokenForBnb(
  privateKey: string,
  tokenAddress: string,
  tokenAmountWei: bigint,
  opts: { slippageBps?: number; gasLimit?: bigint } = {},
): Promise<PancakeSellResult> {
  if (tokenAmountWei <= 0n) throw new Error('tokenAmountWei must be > 0')
  const slippageBps = resolveSlippageBps(opts)
  const addr = ethers.getAddress(tokenAddress)
  const signer = new ethers.Wallet(privateKey, provider())
  const owner = await signer.getAddress()

  const erc20 = new ethers.Contract(addr, ERC20_ABI, signer)
  const allowance: bigint = await erc20.allowance(owner, PANCAKE_V2_ROUTER)
  let approvalTxHash: string | undefined
  if (allowance < tokenAmountWei) {
    const aTx = await erc20.approve(PANCAKE_V2_ROUTER, ethers.MaxUint256)
    await aTx.wait()
    approvalTxHash = aTx.hash
  }

  const quote = await pancakeQuoteSell(addr, tokenAmountWei)
  const minOut = applySlippageDown(quote.estimatedBnbWei, slippageBps)
  if (minOut <= 0n) throw new Error('Computed minOut <= 0; refusing to broadcast')

  const path = [addr, WBNB_BSC]
  const tx = await router(signer).swapExactTokensForETHSupportingFeeOnTransferTokens(
    tokenAmountWei, minOut, path, owner, deadline(),
    { gasLimit: opts.gasLimit },
  )
  const receipt = await tx.wait()
  return {
    txHash: tx.hash,
    tokenAddress: addr,
    tokensSoldWei: tokenAmountWei,
    estimatedBnbWei: quote.estimatedBnbWei,
    minBnbWei: minOut,
    slippageBps,
    approvalTxHash,
    blockNumber: receipt?.blockNumber,
    gasUsedWei: receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined,
    venue: 'pancakeV2',
  }
}

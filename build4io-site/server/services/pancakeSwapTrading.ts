// PancakeSwap V2 trading service for the BUILD4 site server.
//
// Ported from the bot's `src/services/pancakeSwapTrading.ts` so the site
// (the /competition page in particular) can let users trade BSC tokens
// through the same V2 router without touching the bot codebase.
//
// Self-contained: provider + slippage helpers are inlined so we don't
// depend on bot internals. Public API mirrors the bot's exports.

import { ethers } from "ethers";

const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB_BSC = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
];
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const PUBLIC_BSC_RPCS = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed1.ninicoin.io",
  "https://bsc.publicnode.com",
  "https://bsc.drpc.org",
  "https://1rpc.io/bnb",
  "https://bsc.meowrpc.com",
];

function buildBscProvider(): ethers.AbstractProvider {
  const primary = process.env.BSC_RPC_URL;
  const network = new ethers.Network("bnb", 56n);
  const urls = primary
    ? [primary, ...PUBLIC_BSC_RPCS.filter((u) => u !== primary)]
    : PUBLIC_BSC_RPCS;
  if (urls.length === 1) {
    return new ethers.JsonRpcProvider(urls[0], network, { staticNetwork: network });
  }
  const configs = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, network, { staticNetwork: network }),
    priority: i + 1,
    weight: 1,
    stallTimeout: 2000,
  }));
  return new ethers.FallbackProvider(configs, network, { quorum: 1 });
}

const DEFAULT_SLIPPAGE_BPS = 500;
const MAX_SLIPPAGE_BPS = 2000;

function applySlippageDown(amount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps must be an integer in [0, ${MAX_SLIPPAGE_BPS}], got ${slippageBps}`);
  }
  return (amount * BigInt(10000 - slippageBps)) / 10000n;
}

function resolveSlippageBps(opts?: { slippageBps?: number }): number {
  const bps = opts?.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps must be an integer in [0, ${MAX_SLIPPAGE_BPS}], got ${bps}`);
  }
  return bps;
}

function provider() { return buildBscProvider(); }
function router(signerOrProvider: ethers.Signer | ethers.AbstractProvider) {
  return new ethers.Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, signerOrProvider);
}
function deadline(secondsFromNow = 600): number {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}

export interface PancakeTokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  lastPriceWei: bigint;
  graduatedToPancake: true;
  liquidityAdded: true;
  source: "pancakeV2";
}

export async function pancakeGetTokenInfo(tokenAddress: string): Promise<PancakeTokenInfo> {
  const addr = ethers.getAddress(tokenAddress);
  const erc20 = new ethers.Contract(addr, ERC20_ABI, provider());
  let name = "", symbol = "", decimals = 18;
  try { name = String(await erc20.name()); } catch {}
  try { symbol = String(await erc20.symbol()); } catch {}
  try { decimals = Number(await erc20.decimals()); } catch {}
  if (!symbol) symbol = addr.slice(0, 6);
  if (!name) name = symbol;
  const probeBnbWei = 10n ** 16n;
  let tokensOut: bigint;
  try {
    const q = await pancakeQuoteBuy(addr, probeBnbWei);
    tokensOut = q.estimatedAmountWei;
  } catch (e: any) {
    const err: any = new Error("No PancakeSwap V2 liquidity for this token (no WBNB pair).");
    err.code = "NO_PCS_LIQUIDITY";
    err.cause = e;
    throw err;
  }
  if (tokensOut <= 0n) {
    const err: any = new Error("PancakeSwap V2 pair has zero liquidity.");
    err.code = "NO_PCS_LIQUIDITY";
    throw err;
  }
  const wholeTokenUnit = 10n ** BigInt(decimals);
  const lastPriceWei = (probeBnbWei * wholeTokenUnit) / tokensOut;
  return { name, symbol, decimals, lastPriceWei, graduatedToPancake: true, liquidityAdded: true, source: "pancakeV2" };
}

export interface PancakeBuyQuote {
  estimatedAmountWei: bigint;
  amountInWei: bigint;
  pathTokenAddress: string;
}

export async function pancakeQuoteBuy(tokenAddress: string, bnbWei: bigint): Promise<PancakeBuyQuote> {
  if (bnbWei <= 0n) throw new Error("bnbWei must be > 0");
  const addr = ethers.getAddress(tokenAddress);
  const path = [WBNB_BSC, addr];
  const amounts: bigint[] = await router(provider()).getAmountsOut(bnbWei, path);
  return {
    estimatedAmountWei: BigInt(amounts[amounts.length - 1]),
    amountInWei: bnbWei,
    pathTokenAddress: addr,
  };
}

export interface PancakeSellQuote {
  estimatedBnbWei: bigint;
  amountInWei: bigint;
  pathTokenAddress: string;
}

export async function pancakeQuoteSell(tokenAddress: string, tokenAmountWei: bigint): Promise<PancakeSellQuote> {
  if (tokenAmountWei <= 0n) throw new Error("tokenAmountWei must be > 0");
  const addr = ethers.getAddress(tokenAddress);
  const path = [addr, WBNB_BSC];
  const amounts: bigint[] = await router(provider()).getAmountsOut(tokenAmountWei, path);
  return {
    estimatedBnbWei: BigInt(amounts[amounts.length - 1]),
    amountInWei: tokenAmountWei,
    pathTokenAddress: addr,
  };
}

export interface PancakeBuyResult {
  txHash: string;
  tokenAddress: string;
  bnbSpentWei: bigint;
  estimatedTokensWei: bigint;
  minTokensWei: bigint;
  slippageBps: number;
  blockNumber?: number;
  gasUsedWei?: bigint;
  venue: "pancakeV2";
}

export async function pancakeBuyTokenWithBnb(
  privateKey: string,
  tokenAddress: string,
  bnbWei: bigint,
  opts: { slippageBps?: number; gasLimit?: bigint } = {},
): Promise<PancakeBuyResult> {
  if (bnbWei <= 0n) throw new Error("bnbWei must be > 0");
  const slippageBps = resolveSlippageBps(opts);
  const addr = ethers.getAddress(tokenAddress);
  const signer = new ethers.Wallet(privateKey, provider());

  const quote = await pancakeQuoteBuy(addr, bnbWei);
  const minOut = applySlippageDown(quote.estimatedAmountWei, slippageBps);
  if (minOut <= 0n) throw new Error("Computed minOut <= 0; refusing to broadcast");

  const path = [WBNB_BSC, addr];
  const tx = await router(signer).swapExactETHForTokensSupportingFeeOnTransferTokens(
    minOut, path, await signer.getAddress(), deadline(),
    { value: bnbWei, gasLimit: opts.gasLimit },
  );
  const receipt = await tx.wait();
  return {
    txHash: tx.hash,
    tokenAddress: addr,
    bnbSpentWei: bnbWei,
    estimatedTokensWei: quote.estimatedAmountWei,
    minTokensWei: minOut,
    slippageBps,
    blockNumber: receipt?.blockNumber,
    gasUsedWei: receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined,
    venue: "pancakeV2",
  };
}

export interface PancakeSellResult {
  txHash: string;
  tokenAddress: string;
  tokensSoldWei: bigint;
  estimatedBnbWei: bigint;
  minBnbWei: bigint;
  slippageBps: number;
  approvalTxHash?: string;
  blockNumber?: number;
  gasUsedWei?: bigint;
  venue: "pancakeV2";
}

export async function pancakeSellTokenForBnb(
  privateKey: string,
  tokenAddress: string,
  tokenAmountWei: bigint,
  opts: { slippageBps?: number; gasLimit?: bigint } = {},
): Promise<PancakeSellResult> {
  if (tokenAmountWei <= 0n) throw new Error("tokenAmountWei must be > 0");
  const slippageBps = resolveSlippageBps(opts);
  const addr = ethers.getAddress(tokenAddress);
  const signer = new ethers.Wallet(privateKey, provider());
  const owner = await signer.getAddress();

  const erc20 = new ethers.Contract(addr, ERC20_ABI, signer);
  const allowance: bigint = await erc20.allowance(owner, PANCAKE_V2_ROUTER);
  let approvalTxHash: string | undefined;
  if (allowance < tokenAmountWei) {
    const aTx = await erc20.approve(PANCAKE_V2_ROUTER, ethers.MaxUint256);
    await aTx.wait();
    approvalTxHash = aTx.hash;
  }

  const quote = await pancakeQuoteSell(addr, tokenAmountWei);
  const minOut = applySlippageDown(quote.estimatedBnbWei, slippageBps);
  if (minOut <= 0n) throw new Error("Computed minOut <= 0; refusing to broadcast");

  const path = [addr, WBNB_BSC];
  const tx = await router(signer).swapExactTokensForETHSupportingFeeOnTransferTokens(
    tokenAmountWei, minOut, path, owner, deadline(),
    { gasLimit: opts.gasLimit },
  );
  const receipt = await tx.wait();
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
    venue: "pancakeV2",
  };
}

// ── Helpers used by the route layer ──────────────────────────────────

export async function getBscWalletBalance(walletAddress: string, tokenAddress: string): Promise<{
  bnbWei: bigint;
  tokenWei: bigint;
  tokenDecimals: number;
  errors: string[];
}> {
  const p = provider();
  const addr = ethers.getAddress(tokenAddress);
  const owner = ethers.getAddress(walletAddress);
  const erc20 = new ethers.Contract(addr, ERC20_ABI, p);
  let bnbWei = 0n, tokenWei = 0n, tokenDecimals = 18;
  const errors: string[] = [];
  try { bnbWei = await p.getBalance(owner); } catch (e: any) { errors.push(`bnb:${e?.shortMessage ?? e?.message}`); }
  try { tokenWei = await erc20.balanceOf(owner); } catch (e: any) { errors.push(`token:${e?.shortMessage ?? e?.message}`); }
  try { tokenDecimals = Number(await erc20.decimals()); } catch {}
  return { bnbWei, tokenWei, tokenDecimals, errors };
}

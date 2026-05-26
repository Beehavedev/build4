// four.meme bonding-curve trading service for the BUILD4 site server.
//
// Ported from the bot's `src/services/fourMemeTrading.ts` so the
// /competition page can quote, buy, and sell tokens that live on the
// four.meme V1/V2 TokenManager bonding curves on BSC. Once a token
// graduates (liquidityAdded=true) callers must fall back to
// pancakeSwapTrading — graduated tokens revert here.
//
// Self-contained: provider + slippage helpers are inlined so we don't
// depend on bot internals. No broker fee, no FOUR_MEME_ENABLED gate —
// the site doesn't share the bot's feature-flag plumbing.
//
// Auth/wallet model: identical to pancakeSwapTrading.ts — the route
// layer resolves the connected EVM wallet to the user's custodial PK
// via storage.getPrivateKeyByWalletAddress, then this module signs.

import { ethers } from "ethers";

import TokenManagerV1Abi from "../abi/fourMeme/TokenManager.lite.abi.json" with { type: "json" };
import TokenManagerV2Abi from "../abi/fourMeme/TokenManager2.lite.abi.json" with { type: "json" };
import TokenManagerHelper3Abi from "../abi/fourMeme/TokenManagerHelper3.abi.json" with { type: "json" };

// ── BSC contract addresses (mainnet) ─────────────────────────────────
const FOUR_MEME_HELPER_V3 = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── BSC provider (mirrors pancakeSwapTrading.ts pattern) ─────────────
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

function provider() { return buildBscProvider(); }
function helper() {
  return new ethers.Contract(FOUR_MEME_HELPER_V3, TokenManagerHelper3Abi as any, provider());
}

function tokenManagerForVersion(
  version: bigint, address: string, signer: ethers.Signer,
): ethers.Contract {
  let abi: unknown;
  if (version === 1n) abi = TokenManagerV1Abi;
  else if (version === 2n) abi = TokenManagerV2Abi;
  else {
    const err: any = new Error(`Unsupported four.meme TokenManager version ${version}`);
    err.code = "UNSUPPORTED_VERSION";
    throw err;
  }
  return new ethers.Contract(address, abi as any, signer);
}

// ── Slippage helpers ─────────────────────────────────────────────────
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

// ── Token info / quotes ──────────────────────────────────────────────

const ERC20_META_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export interface FourMemeTokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  version: number;
  tokenManager: string;
  quote: string;
  quoteIsBnb: boolean;
  lastPriceWei: bigint;
  offersWei: bigint;
  maxOffersWei: bigint;
  fundsWei: bigint;
  maxFundsWei: bigint;
  liquidityAdded: boolean;
  graduatedToPancake: boolean;
  fillPct: number;
  source: "fourMeme";
}

/**
 * Reads the four.meme curve state for `tokenAddress`. Throws
 * NOT_ON_FOUR_MEME if Helper3 doesn't recognize the token (caller
 * should then try PancakeSwap as a fallback for graduated tokens).
 */
export async function fourMemeGetTokenInfo(tokenAddress: string): Promise<FourMemeTokenInfo> {
  const addr = ethers.getAddress(tokenAddress);
  let raw: any;
  try {
    raw = await helper().getTokenInfo(addr);
  } catch (e: any) {
    const err: any = new Error("Token is not registered on four.meme bonding curves.");
    err.code = "NOT_ON_FOUR_MEME";
    err.cause = e;
    throw err;
  }
  const [
    version, tokenManager, quote, lastPrice, _tradingFeeRate, _minTradingFee,
    _launchTime, offers, maxOffers, funds, maxFunds, liquidityAdded,
  ] = raw;

  // Pull ERC20 metadata in parallel — name/symbol/decimals come from
  // the token itself, not from Helper3.
  const erc20 = new ethers.Contract(addr, ERC20_META_ABI, provider());
  let name = "", symbol = "", decimals = 18;
  const meta = await Promise.allSettled([erc20.name(), erc20.symbol(), erc20.decimals()]);
  if (meta[0].status === "fulfilled") name = String(meta[0].value);
  if (meta[1].status === "fulfilled") symbol = String(meta[1].value);
  if (meta[2].status === "fulfilled") decimals = Number(meta[2].value);
  if (!symbol) symbol = addr.slice(0, 6);
  if (!name) name = symbol;

  const maxFundsBI = BigInt(maxFunds);
  const fundsBI = BigInt(funds);

  return {
    name,
    symbol,
    decimals,
    version: Number(version),
    tokenManager,
    quote,
    quoteIsBnb: String(quote).toLowerCase() === ZERO_ADDRESS,
    lastPriceWei: BigInt(lastPrice),
    offersWei: BigInt(offers),
    maxOffersWei: BigInt(maxOffers),
    fundsWei: fundsBI,
    maxFundsWei: maxFundsBI,
    liquidityAdded: Boolean(liquidityAdded),
    graduatedToPancake: Boolean(liquidityAdded),
    fillPct: maxFundsBI === 0n ? 0 : Number((fundsBI * 10000n) / maxFundsBI) / 10000,
    source: "fourMeme",
  };
}

export interface FourMemeBuyQuote {
  tokenManager: string;
  quote: string;
  estimatedAmountWei: bigint;
  estimatedCostWei: bigint;
  estimatedFeeWei: bigint;
  amountMsgValueWei: bigint;
  amountApprovalWei: bigint;
  amountFundsWei: bigint;
}

export async function fourMemeQuoteBuy(tokenAddress: string, bnbWei: bigint): Promise<FourMemeBuyQuote> {
  if (bnbWei <= 0n) throw new Error("bnbWei must be > 0");
  const addr = ethers.getAddress(tokenAddress);
  const [
    tokenManager, quote, estimatedAmount, estimatedCost, estimatedFee,
    amountMsgValue, amountApproval, amountFunds,
  ] = await helper().tryBuy(addr, 0n, bnbWei);
  return {
    tokenManager,
    quote,
    estimatedAmountWei: BigInt(estimatedAmount),
    estimatedCostWei:   BigInt(estimatedCost),
    estimatedFeeWei:    BigInt(estimatedFee),
    amountMsgValueWei:  BigInt(amountMsgValue),
    amountApprovalWei:  BigInt(amountApproval),
    amountFundsWei:     BigInt(amountFunds),
  };
}

export interface FourMemeSellQuote {
  tokenManager: string;
  quote: string;
  fundsWei: bigint;
  feeWei: bigint;
}

export async function fourMemeQuoteSell(tokenAddress: string, tokenAmountWei: bigint): Promise<FourMemeSellQuote> {
  if (tokenAmountWei <= 0n) throw new Error("tokenAmountWei must be > 0");
  const addr = ethers.getAddress(tokenAddress);
  const [tokenManager, quote, funds, fee] = await helper().trySell(addr, tokenAmountWei);
  return {
    tokenManager,
    quote,
    fundsWei: BigInt(funds),
    feeWei:   BigInt(fee),
  };
}

// ── Trading (signing required) ───────────────────────────────────────

export interface FourMemeBuyResult {
  txHash: string;
  tokenAddress: string;
  bnbSpentWei: bigint;
  estimatedTokensWei: bigint;
  minTokensWei: bigint;
  slippageBps: number;
  blockNumber?: number;
  gasUsedWei?: bigint;
  venue: "fourMeme";
}

export async function fourMemeBuyTokenWithBnb(
  privateKey: string,
  tokenAddress: string,
  bnbWei: bigint,
  opts: { slippageBps?: number; gasLimit?: bigint } = {},
): Promise<FourMemeBuyResult> {
  if (bnbWei <= 0n) throw new Error("bnbWei must be > 0");
  const slippageBps = resolveSlippageBps(opts);
  const addr = ethers.getAddress(tokenAddress);
  const signer = new ethers.Wallet(privateKey, provider());

  // Read first — precondition checks BEFORE any signing.
  const info = await fourMemeGetTokenInfo(addr);
  if (!info.quoteIsBnb) {
    const err: any = new Error(`Token ${addr} is BEP20-quoted; only BNB-quoted four.meme tokens are supported.`);
    err.code = "QUOTE_NOT_SUPPORTED";
    throw err;
  }
  if (info.graduatedToPancake) {
    const err: any = new Error(`Token ${addr} has graduated to PancakeSwap; trade it on the AMM, not the bonding curve.`);
    err.code = "GRADUATED";
    throw err;
  }

  const quote = await fourMemeQuoteBuy(addr, bnbWei);
  const minAmount = applySlippageDown(quote.estimatedAmountWei, slippageBps);
  if (minAmount <= 0n) throw new Error("Computed minAmount <= 0; refusing to broadcast");

  const tm = tokenManagerForVersion(BigInt(info.version), info.tokenManager, signer);

  // V1 = purchaseTokenAMAP, V2 = buyTokenAMAP. Same parameter order.
  const fnName = info.version === 1 ? "purchaseTokenAMAP" : "buyTokenAMAP";
  const tx = await tm[fnName](addr, quote.amountFundsWei, minAmount, {
    value: quote.amountMsgValueWei,
    gasLimit: opts.gasLimit,
  });
  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    tokenAddress: addr,
    bnbSpentWei: quote.amountMsgValueWei,
    estimatedTokensWei: quote.estimatedAmountWei,
    minTokensWei: minAmount,
    slippageBps,
    blockNumber: receipt?.blockNumber,
    gasUsedWei: receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined,
    venue: "fourMeme",
  };
}

export interface FourMemeSellResult {
  txHash: string;
  approvalTxHash?: string;
  tokenAddress: string;
  tokensSoldWei: bigint;
  estimatedBnbWei: bigint;
  minBnbWei: bigint;
  slippageBps: number;
  blockNumber?: number;
  gasUsedWei?: bigint;
  venue: "fourMeme";
}

/**
 * Sell tokens back to the four.meme curve. V1 sells are refused
 * (V1_SELL_UNSAFE) because the legacy contract has no minFunds
 * parameter — no on-chain slippage enforcement = fail-closed.
 */
export async function fourMemeSellTokenForBnb(
  privateKey: string,
  tokenAddress: string,
  tokenAmountWei: bigint,
  opts: { slippageBps?: number; gasLimit?: bigint } = {},
): Promise<FourMemeSellResult> {
  if (tokenAmountWei <= 0n) throw new Error("tokenAmountWei must be > 0");
  const slippageBps = resolveSlippageBps(opts);
  const addr = ethers.getAddress(tokenAddress);
  const signer = new ethers.Wallet(privateKey, provider());

  const info = await fourMemeGetTokenInfo(addr);
  if (!info.quoteIsBnb) {
    const err: any = new Error(`Token ${addr} is BEP20-quoted; only BNB-quoted four.meme tokens are supported.`);
    err.code = "QUOTE_NOT_SUPPORTED";
    throw err;
  }
  if (info.graduatedToPancake) {
    const err: any = new Error(`Token ${addr} has graduated to PancakeSwap; sell it on the AMM, not the bonding curve.`);
    err.code = "GRADUATED";
    throw err;
  }
  if (info.version !== 2) {
    const err: any = new Error(
      `Token ${addr} is on TokenManager V${info.version}; sells refused on non-V2 ` +
      `because the legacy contract has no minFunds param and we can't enforce slippage on-chain.`,
    );
    err.code = "V1_SELL_UNSAFE";
    throw err;
  }

  const sq = await fourMemeQuoteSell(addr, tokenAmountWei);
  const minFunds = applySlippageDown(sq.fundsWei, slippageBps);
  if (minFunds <= 0n) throw new Error("Computed minFunds <= 0; refusing to broadcast");

  const tm = tokenManagerForVersion(BigInt(info.version), info.tokenManager, signer);

  // ── Approve-if-needed ──────────────────────────────────────────────
  // V2.sellToken does ERC20 transferFrom on the user's tokens.
  const tmAddr = ethers.getAddress(info.tokenManager);
  const erc20 = new ethers.Contract(addr, ERC20_META_ABI, signer);
  let approvalTxHash: string | undefined;
  const currentAllowance: bigint = await erc20.allowance(signer.address, tmAddr);
  if (currentAllowance < tokenAmountWei) {
    const approveTx = await erc20.approve(tmAddr, ethers.MaxUint256);
    await approveTx.wait();
    approvalTxHash = approveTx.hash;
  }

  // Disambiguate the overloaded sellToken — ethers v6 requires the
  // explicit signature when multiple overloads exist on one ABI.
  const sellFn = tm.getFunction("sellToken(uint256,address,uint256,uint256,uint256,address)");
  const tx = await sellFn(0n, addr, tokenAmountWei, minFunds, 0n, ZERO_ADDRESS, { gasLimit: opts.gasLimit });
  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    approvalTxHash,
    tokenAddress: addr,
    tokensSoldWei: tokenAmountWei,
    estimatedBnbWei: sq.fundsWei,
    minBnbWei: minFunds,
    slippageBps,
    blockNumber: receipt?.blockNumber,
    gasUsedWei: receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined,
    venue: "fourMeme",
  };
}

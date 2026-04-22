import { ethers } from 'ethers';
import { buildBscProvider } from './bscProvider';

// ── 42.space contract addresses (BNB Chain mainnet, chainId 56) ────────────
// Source: https://docs.42.space/for-developers/deployments
//
// FTROUTER_ADDRESS had three extra 8s in the vanity prefix for ages — the
// previous value '0x88888888888338e60bfB4657187169cFFa5c8640E42' is 43 hex
// chars (invalid). ethers.isAddress() returned false on it, which made the
// signer fall through to ENS resolution on contract.swapSimple(...) calls,
// throwing "network does not support ENS" on BSC. Verified the corrected
// value below has 23,888 bytes of bytecode at this address on BSC mainnet
// (i.e. it's the actual deployed router contract). Why this hadn't blown
// up earlier: previous symptom was BUFFER_OVERRUN on eth_chainId, which
// crashed the request BEFORE ethers got far enough to validate the address
// and try ENS resolution. Fixing the chainId issue exposed this latent typo.
export const FTROUTER_ADDRESS = '0x88888888338e60bfB4657187169cFFa5c8640E42';
export const FTMARKET_CONTROLLER_ADDRESS = '0xF21b2D4F8989b27f732e369907F25f0E8D95Fe62';
export const POWER_CURVE_ADDRESS = '0x0443E04e70E4285a6cA73eacaC5267f3B4cBb7Da';
// USDT_BSC previously had lowercase 'b' in '...027b3197955' — incorrect EIP-55
// checksum casing. ethers v6 strict-rejects mis-cased mixed-case addresses
// with INVALID_ARGUMENT bad-checksum, even though the bytes are correct,
// since a wrong checksum often means a transcription error. Canonicalised
// via ethers.getAddress(). Same masking dynamic as the FTROUTER typo: this
// only surfaced after the upstream BUFFER_OVERRUN was resolved.
export const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';

// SwapParams struct from src/libraries/Market.sol in fortytwo-protocol/ft-contracts-public
//   struct SwapParams {
//       bool isMint;          // true = collateral -> outcome (buy), false = outcome -> collateral (sell)
//       uint256 amount;
//       bool isExactIn;       // true = amount is the input, false = amount is the desired output
//       uint256 minOutOrMaxIn;// slippage bound
//   }
//
// CRITICAL — every state-changing entrypoint MUST be wrapped in multicall(...).
// FTRouter inherits from Multicallbackable. The router's `initiator` storage
// slot is only set inside multicall (it captures msg.sender there, then clears
// it at end). When swapSimple later triggers the market's onMint callback,
// the callback executes erc20TransferFromInitiator which pulls collateral
// from `initiator`. Without the multicall wrapper, initiator == address(0),
// and BEP20.transferFrom reverts with "transfer from the zero address" — the
// exact error we chased through five wrong-cause fixes (router typo, USDT
// checksum, eth_chainId BUFFER_OVERRUN, FallbackProvider, missing `from`
// override). The contract source confirms it explicitly:
//   ActionSimple.sol L41: "@dev Please wrap all calls in a multicall (to load initiator)"
// Wrapping is also harmless for claim paths (which use msg.sender, not
// initiator) since delegatecall preserves msg.sender, so we wrap everything
// for consistency.
const ROUTER_ABI = [
  'function multicall((bool allowFailure, bytes callData)[] calls) external returns ((bool success, bytes returnData)[] returnDatas)',
  'function swapSimple(address market, address receiver, uint256 tokenId, (bool isMint, uint256 amount, bool isExactIn, uint256 minOutOrMaxIn) params, bytes dataSwap, bytes dataGuess) external',
  'function claimSimple(address market, address receiver, uint256[] tokenIds, uint256[] otToBurn) external returns (uint256 payout)',
  'function claimAllSimple(address market, address receiver) external returns (uint256 payout)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address owner) external view returns (uint256)',
];

// 42.space outcome tokens are ERC-1155 issued by the market contract.
const ERC1155_ABI = [
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
];

/**
 * Synthetic receipt returned in dry-run (paper-trade) mode. Mimics enough of
 * `ethers.TransactionReceipt` for downstream loggers + makes intent inspectable.
 */
export interface DryRunReceipt {
  dryRun: true;
  hash: string;
  from: string;
  to: string;
  method: 'buyOutcome' | 'sellOutcome' | 'claimResolved' | 'claimAllResolved' | 'approve';
  args: Record<string, unknown>;
  status: 1;
}

function dryHash(seed: string): string {
  // Deterministic-ish 0x-prefixed 32-byte hex so logs look like real tx hashes.
  return '0xDR' + Buffer.from(`${seed}|${Date.now()}|${Math.random()}`).toString('hex').padEnd(62, '0').slice(0, 62);
}

/**
 * Best-effort revert reason extraction across the various error shapes
 * ethers v6 produces from a failed staticCall:
 *   - Custom errors:   err.revert.args[0] (or .signature)
 *   - Standard errors: err.shortMessage / err.reason
 *   - JSON-RPC layer:  err.info.error.message
 *   - Fallback:        err.message
 * Wide net by design — we'd rather surface anything than throw away signal.
 */
function extractRevertReason(err: unknown): string {
  const e = err as any;
  return (
    e?.revert?.args?.[0] ??
    e?.shortMessage ??
    e?.reason ??
    e?.info?.error?.message ??
    e?.message ??
    'unknown revert'
  );
}

export interface FortyTwoTraderOptions {
  /** When true, no on-chain calls are sent — every method returns a DryRunReceipt and logs intent. */
  dryRun?: boolean;
}

export class FortyTwoTrader {
  private router: ethers.Contract;
  private routerIface: ethers.Interface;
  private usdt: ethers.Contract;
  private wallet: ethers.Wallet;
  private dryRun: boolean;

  /**
   * Wrap an inner FTRouter call (e.g. swapSimple) into the multicall wrapper
   * that the router requires. See the big comment above ROUTER_ABI for why.
   * Returns a single-element Call[] array suitable for `multicall(...)`.
   */
  private buildMulticall(fn: string, args: unknown[]): Array<{ allowFailure: boolean; callData: string }> {
    const callData = this.routerIface.encodeFunctionData(fn, args);
    return [{ allowFailure: false, callData }];
  }

  constructor(privateKey: string, rpcUrl: string, opts: FortyTwoTraderOptions = {}) {
    // Use the shared multi-endpoint provider with staticNetwork so the signer
    // path gets the same resilience as read-only paths: no eth_chainId
    // round-trip (which was failing with BUFFER_OVERRUN on flaky public
    // dataseeds), and automatic failover across multiple BSC endpoints if
    // the primary returns nothing. Per-wallet trades are serialized via
    // the advisory lock in fortyTwoExecutor, so concurrent nonce queries
    // returning the same value across providers is not a risk in practice.
    const provider = buildBscProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, provider);
    this.router = new ethers.Contract(FTROUTER_ADDRESS, ROUTER_ABI, this.wallet);
    this.routerIface = new ethers.Interface(ROUTER_ABI);
    this.usdt = new ethers.Contract(USDT_BSC, ERC20_ABI, this.wallet);
    this.dryRun = opts.dryRun ?? process.env.FORTYTWO_PAPER_TRADE === '1';
    if (this.dryRun) {
      console.log(`[FortyTwoTrader] PAPER-TRADE mode active for ${this.wallet.address} — no transactions will be broadcast.`);
    }
  }

  get isPaperTrading(): boolean {
    return this.dryRun;
  }

  get address(): string {
    return this.wallet.address;
  }

  async ensureApproval(amount: bigint): Promise<void> {
    if (this.dryRun) {
      console.log(`[FortyTwoTrader:DRY] approve(USDT → router, MaxUint256) for ${ethers.formatUnits(amount, 18)} USDT`);
      return;
    }
    const allowance: bigint = await this.usdt.allowance(this.wallet.address, FTROUTER_ADDRESS);
    if (allowance < amount) {
      const tx = await this.usdt.approve(FTROUTER_ADDRESS, ethers.MaxUint256);
      await tx.wait();
    }
  }

  /**
   * Buy outcome tokens with USDT (mint).
   * @param usdtAmountIn human-readable USDT amount, e.g. "10" = 10 USDT
   * @param minOtOut minimum outcome tokens to receive (slippage protection); 0n = no protection
   */
  async buyOutcome(
    marketAddress: string,
    tokenId: number,
    usdtAmountIn: string,
    minOtOut: bigint = 0n,
  ): Promise<ethers.TransactionReceipt | null> {
    const amountIn = ethers.parseUnits(usdtAmountIn, 18);
    await this.ensureApproval(amountIn);

    const params = {
      isMint: true,
      amount: amountIn,
      isExactIn: true,
      minOutOrMaxIn: minOtOut,
    };

    if (this.dryRun) {
      const args = { marketAddress, tokenId, usdtAmountIn, minOtOut: minOtOut.toString() };
      console.log(`[FortyTwoTrader:DRY] buyOutcome ${JSON.stringify(args)}`);
      return { dryRun: true, hash: dryHash('buy'), from: this.wallet.address, to: FTROUTER_ADDRESS, method: 'buyOutcome', args, status: 1 } as unknown as ethers.TransactionReceipt;
    }

    // Wrap swapSimple in the router's multicall(...) — this is what sets
    // `initiator = msg.sender` so that the market's onMint callback can pull
    // USDT from the user's wallet via erc20TransferFromInitiator. See the
    // big comment on ROUTER_ABI for the full story.
    const calls = this.buildMulticall('swapSimple', [
      marketAddress,
      this.wallet.address,
      BigInt(tokenId),
      params,
      '0x', // dataSwap — not the callback selector; this is curve calc data
      '0x', // dataGuess — required for exact-collateral; PowerCurve accepts empty
    ]);

    // Preflight via staticCall on the multicall wrapper — surfaces real
    // revert reasons (slippage, allowance, market closed, etc.) before we
    // spend gas. We pass `from` explicitly so the eth_call uses the wallet's
    // address as msg.sender; otherwise it defaults to 0x0 and we get a
    // misleading initiator-related revert from the preflight even though
    // the real signed tx would succeed.
    try {
      await this.router.multicall.staticCall(calls, { from: this.wallet.address });
    } catch (simErr) {
      throw new Error(`[42] buyOutcome would revert: ${extractRevertReason(simErr)}`);
    }

    const tx = await this.router.multicall(calls);
    return tx.wait();
  }

  /**
   * Sell outcome tokens back to USDT (redeem).
   * @param tokenAmountIn raw outcome-token units (ERC-1155, typically 18 decimals)
   * @param minUsdtOut minimum USDT to receive (slippage protection)
   */
  async sellOutcome(
    marketAddress: string,
    tokenId: number,
    tokenAmountIn: bigint,
    minUsdtOut: bigint = 0n,
  ): Promise<ethers.TransactionReceipt | null> {
    const params = {
      isMint: false,
      amount: tokenAmountIn,
      isExactIn: true,
      minOutOrMaxIn: minUsdtOut,
    };

    if (this.dryRun) {
      const args = { marketAddress, tokenId, tokenAmountIn: tokenAmountIn.toString(), minUsdtOut: minUsdtOut.toString() };
      console.log(`[FortyTwoTrader:DRY] sellOutcome ${JSON.stringify(args)}`);
      return { dryRun: true, hash: dryHash('sell'), from: this.wallet.address, to: FTROUTER_ADDRESS, method: 'sellOutcome', args, status: 1 } as unknown as ethers.TransactionReceipt;
    }

    // Multicall-wrapped swapSimple — see buyOutcome / ROUTER_ABI comment for
    // the full rationale on why direct swapSimple calls revert with
    // "transfer from the zero address".
    const calls = this.buildMulticall('swapSimple', [
      marketAddress,
      this.wallet.address,
      BigInt(tokenId),
      params,
      '0x',
      '0x',
    ]);

    try {
      await this.router.multicall.staticCall(calls, { from: this.wallet.address });
    } catch (simErr) {
      throw new Error(`[42] sellOutcome would revert: ${extractRevertReason(simErr)}`);
    }

    const tx = await this.router.multicall(calls);
    return tx.wait();
  }

  /**
   * Read the wallet's current ERC-1155 balance for a specific outcome token.
   * Returns 0n in dry-run (paper-trade) mode — callers should fall back to
   * their stored estimate when paper-trading.
   */
  async balanceOfOutcome(marketAddress: string, tokenId: number): Promise<bigint> {
    if (this.dryRun) return 0n;
    const market = new ethers.Contract(marketAddress, ERC1155_ABI, this.wallet);
    const bal: bigint = await market.balanceOf(this.wallet.address, tokenId);
    return bal;
  }

  /** Claim payout on resolved markets for the given winning outcome tokens. */
  async claimResolved(
    marketAddress: string,
    tokenIds: number[],
    otToBurn: bigint[],
  ): Promise<ethers.TransactionReceipt | null> {
    if (this.dryRun) {
      const args = { marketAddress, tokenIds, otToBurn: otToBurn.map((b) => b.toString()) };
      console.log(`[FortyTwoTrader:DRY] claimResolved ${JSON.stringify(args)}`);
      return { dryRun: true, hash: dryHash('claim'), from: this.wallet.address, to: FTROUTER_ADDRESS, method: 'claimResolved', args, status: 1 } as unknown as ethers.TransactionReceipt;
    }
    const tx = await this.router.claimSimple(
      marketAddress,
      this.wallet.address,
      tokenIds,
      otToBurn,
    );
    return tx.wait();
  }

  /** Claim every winning outcome the wallet holds for a resolved market in one call. */
  async claimAllResolved(marketAddress: string): Promise<ethers.TransactionReceipt | null> {
    if (this.dryRun) {
      const args = { marketAddress };
      console.log(`[FortyTwoTrader:DRY] claimAllResolved ${JSON.stringify(args)}`);
      return { dryRun: true, hash: dryHash('claimAll'), from: this.wallet.address, to: FTROUTER_ADDRESS, method: 'claimAllResolved', args, status: 1 } as unknown as ethers.TransactionReceipt;
    }
    const tx = await this.router.claimAllSimple(marketAddress, this.wallet.address);
    return tx.wait();
  }
}

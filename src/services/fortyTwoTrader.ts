import { ethers } from 'ethers';

// ── 42.space contract addresses (BNB Chain mainnet, chainId 56) ────────────
// Source: https://docs.42.space/for-developers/deployments
export const FTROUTER_ADDRESS = '0x88888888888338e60bfB4657187169cFFa5c8640E42';
export const FTMARKET_CONTROLLER_ADDRESS = '0xF21b2D4F8989b27f732e369907F25f0E8D95Fe62';
export const POWER_CURVE_ADDRESS = '0x0443E04e70E4285a6cA73eacaC5267f3B4cBb7Da';
export const USDT_BSC = '0x55d398326f99059fF775485246999027b3197955';

// SwapParams struct from src/libraries/Market.sol in fortytwo-protocol/ft-contracts-public
//   struct SwapParams {
//       bool isMint;          // true = collateral -> outcome (buy), false = outcome -> collateral (sell)
//       uint256 amount;
//       bool isExactIn;       // true = amount is the input, false = amount is the desired output
//       uint256 minOutOrMaxIn;// slippage bound
//   }
const ROUTER_ABI = [
  'function swapSimple(address market, address receiver, uint256 tokenId, (bool isMint, uint256 amount, bool isExactIn, uint256 minOutOrMaxIn) params, bytes dataSwap, bytes dataGuess) external',
  'function claimSimple(address market, address receiver, uint256[] tokenIds, uint256[] otToBurn) external returns (uint256 payout)',
  'function claimAllSimple(address market, address receiver) external returns (uint256 payout)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address owner) external view returns (uint256)',
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

export interface FortyTwoTraderOptions {
  /** When true, no on-chain calls are sent — every method returns a DryRunReceipt and logs intent. */
  dryRun?: boolean;
}

export class FortyTwoTrader {
  private router: ethers.Contract;
  private usdt: ethers.Contract;
  private wallet: ethers.Wallet;
  private dryRun: boolean;

  constructor(privateKey: string, rpcUrl: string, opts: FortyTwoTraderOptions = {}) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, provider);
    this.router = new ethers.Contract(FTROUTER_ADDRESS, ROUTER_ABI, this.wallet);
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

    const tx = await this.router.swapSimple(
      marketAddress,
      this.wallet.address,
      tokenId,
      params,
      '0x',
      '0x',
    );
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

    const tx = await this.router.swapSimple(
      marketAddress,
      this.wallet.address,
      tokenId,
      params,
      '0x',
      '0x',
    );
    return tx.wait();
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

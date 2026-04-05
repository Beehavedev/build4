import * as ethers from "ethers";
import { log } from "./index";

const BASE_RPC = "https://mainnet.base.org";
const BASE_CHAIN_ID = "8453";
const BASE_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

interface StealthWallet {
  address: string;
  privateKey: string;
  index: number;
}

interface StealthBuyConfig {
  tokenAddress: string;
  mainWalletPk: string;
  mainBuyPercent: number;
  stealthWalletCount: number;
  totalEthBudget: string;
  mainBuyEth: string;
  stealthBuyEthPerWallet: string;
  slippage?: string;
}

interface StealthBuyResult {
  success: boolean;
  mainBuyTxHash?: string;
  stealthResults: Array<{
    walletIndex: number;
    address: string;
    txHash?: string;
    error?: string;
    success: boolean;
  }>;
  stealthWallets: StealthWallet[];
  error?: string;
}

function generateStealthWallets(count: number): StealthWallet[] {
  const wallets: StealthWallet[] = [];
  for (let i = 0; i < count; i++) {
    const w = ethers.Wallet.createRandom();
    wallets.push({
      address: w.address,
      privateKey: w.privateKey,
      index: i,
    });
  }
  log(`[StealthBuy] Generated ${count} stealth wallets`, "stealth-buy");
  return wallets;
}

async function fundStealthWallets(
  mainWallet: ethers.Wallet,
  stealthWallets: StealthWallet[],
  ethPerWallet: string,
  provider: ethers.JsonRpcProvider,
): Promise<{ funded: number; errors: string[] }> {
  const errors: string[] = [];
  let funded = 0;
  const fundAmount = ethers.parseEther(ethPerWallet);
  const gasBuffer = ethers.parseEther("0.0005");
  const totalPerWallet = fundAmount + gasBuffer;

  let nonce = await provider.getTransactionCount(mainWallet.address, "latest");

  const txPromises = stealthWallets.map(async (sw, i) => {
    try {
      const tx = await mainWallet.sendTransaction({
        to: sw.address,
        value: totalPerWallet,
        nonce: nonce + i,
        gasLimit: 21000n,
      });
      log(`[StealthBuy] Funded wallet #${i} (${sw.address.substring(0, 10)}...) — TX: ${tx.hash.substring(0, 14)}`, "stealth-buy");
      await tx.wait();
      funded++;
    } catch (e: any) {
      const msg = `Wallet #${i} funding failed: ${e.message?.substring(0, 80)}`;
      log(`[StealthBuy] ${msg}`, "stealth-buy");
      errors.push(msg);
    }
  });

  await Promise.all(txPromises);
  log(`[StealthBuy] Funded ${funded}/${stealthWallets.length} wallets`, "stealth-buy");
  return { funded, errors };
}

async function executeSwapOnBase(
  wallet: ethers.Wallet,
  tokenAddress: string,
  ethAmount: string,
  slippage: string,
  provider: ethers.JsonRpcProvider,
): Promise<{ txHash?: string; error?: string }> {
  try {
    const rawAmount = ethers.parseEther(ethAmount).toString();
    const { getSwapData } = await import("./okx-onchainos");

    const swapResult = await getSwapData({
      chainId: BASE_CHAIN_ID,
      fromTokenAddress: BASE_NATIVE_TOKEN,
      toTokenAddress: tokenAddress,
      amount: rawAmount,
      slippage,
      userWalletAddress: wallet.address,
    });

    const txData = swapResult?.data?.[0]?.tx;
    if (!txData) {
      return { error: "No swap route found — token may not have liquidity yet" };
    }

    const tx = await wallet.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: txData.value ? BigInt(txData.value) : 0n,
      gasLimit: txData.gasLimit ? BigInt(txData.gasLimit) : 500000n,
    });

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      return { error: `Transaction reverted: ${tx.hash.substring(0, 14)}` };
    }

    return { txHash: receipt.hash };
  } catch (e: any) {
    return { error: e.message?.substring(0, 150) || "Swap execution failed" };
  }
}

export async function executeStealthBuy(config: StealthBuyConfig): Promise<StealthBuyResult> {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const mainWallet = new ethers.Wallet(config.mainWalletPk, provider);
  const slippage = config.slippage || "5";

  log(`[StealthBuy] Starting stealth buy operation`, "stealth-buy");
  log(`[StealthBuy] Token: ${config.tokenAddress}`, "stealth-buy");
  log(`[StealthBuy] Main wallet: ${mainWallet.address.substring(0, 10)}...`, "stealth-buy");
  log(`[StealthBuy] Main buy: ${config.mainBuyEth} ETH (${config.mainBuyPercent}%)`, "stealth-buy");
  log(`[StealthBuy] Stealth wallets: ${config.stealthWalletCount} x ${config.stealthBuyEthPerWallet} ETH each`, "stealth-buy");

  const balance = await provider.getBalance(mainWallet.address);
  const totalNeeded = ethers.parseEther(config.totalEthBudget);
  if (balance < totalNeeded) {
    return {
      success: false,
      stealthResults: [],
      stealthWallets: [],
      error: `Insufficient ETH on Base. Have: ${ethers.formatEther(balance)} ETH, Need: ${config.totalEthBudget} ETH`,
    };
  }

  log(`[StealthBuy] Phase 1: Main wallet buying ${config.mainBuyEth} ETH worth...`, "stealth-buy");
  const mainResult = await executeSwapOnBase(mainWallet, config.tokenAddress, config.mainBuyEth, slippage, provider);

  if (mainResult.error) {
    log(`[StealthBuy] Main buy failed: ${mainResult.error}`, "stealth-buy");
    return {
      success: false,
      stealthResults: [],
      stealthWallets: [],
      error: `Main wallet buy failed: ${mainResult.error}`,
    };
  }

  log(`[StealthBuy] Phase 1 complete. TX: ${mainResult.txHash}`, "stealth-buy");

  log(`[StealthBuy] Phase 2: Generating ${config.stealthWalletCount} stealth wallets...`, "stealth-buy");
  const stealthWallets = generateStealthWallets(config.stealthWalletCount);

  log(`[StealthBuy] Phase 3: Funding stealth wallets...`, "stealth-buy");
  const fundResult = await fundStealthWallets(mainWallet, stealthWallets, config.stealthBuyEthPerWallet, provider);

  if (fundResult.funded === 0) {
    return {
      success: false,
      mainBuyTxHash: mainResult.txHash,
      stealthResults: [],
      stealthWallets,
      error: `Main buy succeeded but could not fund any stealth wallets: ${fundResult.errors.join("; ")}`,
    };
  }

  log(`[StealthBuy] Phase 4: Executing ${fundResult.funded} parallel stealth buys...`, "stealth-buy");

  const stealthBuyPromises = stealthWallets.slice(0, fundResult.funded).map(async (sw) => {
    const swWallet = new ethers.Wallet(sw.privateKey, provider);
    const result = await executeSwapOnBase(swWallet, config.tokenAddress, config.stealthBuyEthPerWallet, slippage, provider);
    const logStatus = result.txHash ? `OK (${result.txHash.substring(0, 14)})` : `FAIL (${result.error?.substring(0, 60)})`;
    log(`[StealthBuy] Wallet #${sw.index} ${sw.address.substring(0, 10)}... — ${logStatus}`, "stealth-buy");
    return {
      walletIndex: sw.index,
      address: sw.address,
      txHash: result.txHash,
      error: result.error,
      success: !!result.txHash,
    };
  });

  const stealthResults = await Promise.all(stealthBuyPromises);
  const successCount = stealthResults.filter(r => r.success).length;

  log(`[StealthBuy] Complete! Main: ✅ | Stealth: ${successCount}/${stealthResults.length} succeeded`, "stealth-buy");

  return {
    success: true,
    mainBuyTxHash: mainResult.txHash,
    stealthResults,
    stealthWallets,
  };
}

export async function consolidateTokens(
  stealthWallets: StealthWallet[],
  tokenAddress: string,
  destinationWallet: string,
): Promise<{ consolidated: number; errors: string[] }> {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const errors: string[] = [];
  let consolidated = 0;

  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
  ];

  const transferPromises = stealthWallets.map(async (sw) => {
    try {
      const wallet = new ethers.Wallet(sw.privateKey, provider);
      const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
      const balance = await token.balanceOf(sw.address);

      if (balance === 0n) {
        log(`[StealthBuy] Wallet #${sw.index} has 0 tokens, skipping`, "stealth-buy");
        return;
      }

      const tx = await token.transfer(destinationWallet, balance);
      await tx.wait();
      consolidated++;
      log(`[StealthBuy] Consolidated wallet #${sw.index} → ${destinationWallet.substring(0, 10)}... (${ethers.formatUnits(balance, 18)} tokens)`, "stealth-buy");
    } catch (e: any) {
      const msg = `Wallet #${sw.index} consolidation failed: ${e.message?.substring(0, 80)}`;
      log(`[StealthBuy] ${msg}`, "stealth-buy");
      errors.push(msg);
    }
  });

  await Promise.all(transferPromises);
  log(`[StealthBuy] Consolidation complete: ${consolidated}/${stealthWallets.length}`, "stealth-buy");
  return { consolidated, errors };
}

export async function drainEthFromStealthWallets(
  stealthWallets: StealthWallet[],
  destinationWallet: string,
): Promise<{ drained: number }> {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  let drained = 0;

  const drainPromises = stealthWallets.map(async (sw) => {
    try {
      const wallet = new ethers.Wallet(sw.privateKey, provider);
      const balance = await provider.getBalance(sw.address);
      const gasPrice = (await provider.getFeeData()).gasPrice || ethers.parseUnits("0.1", "gwei");
      const gasCost = gasPrice * 21000n;

      if (balance <= gasCost) return;

      const sendAmount = balance - gasCost;
      const tx = await wallet.sendTransaction({
        to: destinationWallet,
        value: sendAmount,
        gasLimit: 21000n,
        gasPrice,
      });
      await tx.wait();
      drained++;
      log(`[StealthBuy] Drained ${ethers.formatEther(sendAmount)} ETH from wallet #${sw.index}`, "stealth-buy");
    } catch (e: any) {
      log(`[StealthBuy] Drain wallet #${sw.index} failed: ${e.message?.substring(0, 60)}`, "stealth-buy");
    }
  });

  await Promise.all(drainPromises);
  return { drained };
}

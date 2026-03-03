import { ethers } from "ethers";
import { storage } from "./storage";
import { log } from "./index";
import type { TokenLaunch, InsertTokenLaunch } from "@shared/schema";

const FOUR_MEME_TOKEN_MANAGER = "0x5b1f874d0b0C5ee17a495CbB70AB8bf64107A3BD";
const FOUR_MEME_TOKEN_MANAGER_V3 = "0x9eC02756A559700d8D9e79ECe56809f7bcC5dC27";
const FOUR_MEME_API = "https://four.meme";

const FOUR_MEME_ABI = [
  "function createToken(bytes args, bytes signature) external payable",
  "function createToken(string name, string symbol, uint256 totalSupply, uint256 maxOffer, uint256 presale, uint256 launchTime) external payable",
];

const FLAP_API = "https://flap.sh";

function sanitizeError(rawError: string): string {
  if (!rawError) return "Unknown error";

  if (rawError.includes("CALL_EXCEPTION") || rawError.includes("transaction execution reverted")) {
    if (rawError.includes("insufficient funds") || rawError.includes("insufficient balance")) {
      return "Insufficient balance — wallet needs more BNB/ETH for gas + liquidity";
    }
    if (rawError.includes("exceeds balance")) {
      return "Insufficient balance to cover transaction cost";
    }
    return "Transaction reverted by the contract — this may be due to insufficient balance, invalid parameters, or the platform rejecting the launch";
  }

  if (rawError.includes("insufficient funds")) {
    return "Insufficient balance — wallet needs more BNB/ETH for gas + liquidity";
  }

  if (rawError.includes("nonce")) {
    return "Transaction nonce conflict — try again in a moment";
  }

  if (rawError.includes("timeout") || rawError.includes("TIMEOUT")) {
    return "Network timeout — the blockchain may be congested, try again";
  }

  if (rawError.includes("network") || rawError.includes("NETWORK_ERROR")) {
    return "Network error — could not connect to the blockchain";
  }

  if (rawError.includes("user rejected") || rawError.includes("ACTION_REJECTED")) {
    return "Transaction was rejected";
  }

  if (rawError.length > 150) {
    const shortMsg = rawError.substring(0, 100).split(",")[0].split("{")[0].trim();
    return shortMsg || "Transaction failed — check your wallet balance and try again";
  }

  return rawError;
}

interface LaunchParams {
  tokenName: string;
  tokenSymbol: string;
  tokenDescription: string;
  imageUrl?: string;
  platform: "four_meme" | "flap_sh";
  initialLiquidityBnb?: string;
  agentId?: string;
  creatorWallet?: string;
  userPrivateKey?: string;
}

interface LaunchResult {
  success: boolean;
  tokenAddress?: string;
  txHash?: string;
  launchUrl?: string;
  error?: string;
  launchId?: string;
}

function getBscProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
}

function getBaseProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider("https://mainnet.base.org");
}

function getDeployerWallet(provider: ethers.JsonRpcProvider): ethers.Wallet | null {
  const pk = process.env.BOUNTY_WALLET_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) return null;
  return new ethers.Wallet(pk, provider);
}

async function launchOnFourMeme(params: LaunchParams): Promise<LaunchResult> {
  const provider = getBscProvider();
  let wallet: ethers.Wallet | null = null;
  if (params.userPrivateKey) {
    wallet = new ethers.Wallet(params.userPrivateKey, provider);
    log(`[TokenLauncher] Using user wallet ${wallet.address.substring(0, 10)}... for Four.meme launch`, "token-launcher");
  } else {
    wallet = getDeployerWallet(provider);
  }
  if (!wallet) {
    return { success: false, error: "No wallet available — generate or import a wallet with a private key first" };
  }

  const launchRecord = await storage.createTokenLaunch({
    agentId: params.agentId || null,
    creatorWallet: params.creatorWallet || wallet.address,
    platform: "four_meme",
    chainId: 56,
    tokenName: params.tokenName,
    tokenSymbol: params.tokenSymbol,
    tokenDescription: params.tokenDescription,
    imageUrl: params.imageUrl || null,
    initialLiquidityBnb: params.initialLiquidityBnb || "0.01",
    status: "pending",
    tokenAddress: null,
    txHash: null,
    launchUrl: null,
    errorMessage: null,
    metadata: null,
  });

  try {
    const liquidity = ethers.parseEther(params.initialLiquidityBnb || "0.01");

    const balance = await provider.getBalance(wallet.address);
    const balFormatted = ethers.formatEther(balance);
    log(`[TokenLauncher] Deployer balance: ${balFormatted} BNB`, "token-launcher");

    if (balance < liquidity + ethers.parseEther("0.005")) {
      const needed = ethers.formatEther(liquidity + ethers.parseEther("0.005"));
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: `Insufficient BNB balance: ${balFormatted} BNB (need ${needed} BNB)`,
      });
      return { success: false, error: `Insufficient BNB — your wallet has ${balFormatted} BNB but needs at least ${needed} BNB (${ethers.formatEther(liquidity)} liquidity + gas). Fund your wallet and try again.`, launchId: launchRecord.id };
    }

    let signatureResponse: any = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const signRes = await fetch(`${FOUR_MEME_API}/mapi/defi/v3/public/wallet-direct/wallet/address/sign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "BUILD4/1.0",
          "Origin": "https://four.meme",
          "Referer": "https://four.meme/",
        },
        body: JSON.stringify({ address: wallet.address, chainId: 56 }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const contentType = signRes.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        log(`[TokenLauncher] four.meme sign API returned non-JSON (${signRes.status} ${contentType})`, "token-launcher");
      } else {
        signatureResponse = await signRes.json();
        log(`[TokenLauncher] four.meme sign response: ${JSON.stringify(signatureResponse).substring(0, 200)}`, "token-launcher");
      }
    } catch (e: any) {
      log(`[TokenLauncher] four.meme API sign failed: ${e.message}`, "token-launcher");
    }

    const totalSupply = ethers.parseUnits("1000000000", 18);
    const launchTime = BigInt(Math.floor(Date.now() / 1000) + 60);

    let tx;
    try {
      if (signatureResponse?.data?.signature) {
        log(`[TokenLauncher] Using V3 signed path`, "token-launcher");
        const contract = new ethers.Contract(FOUR_MEME_TOKEN_MANAGER_V3, FOUR_MEME_ABI, wallet);
        const args = ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "string", "string", "string", "uint256", "uint256"],
          [params.tokenName, params.tokenSymbol, params.tokenDescription || "", params.imageUrl || "", totalSupply, launchTime]
        );
        tx = await contract["createToken(bytes,bytes)"](args, signatureResponse.data.signature, { value: liquidity, gasLimit: 800000 });
      } else {
        log(`[TokenLauncher] V3 sign unavailable, using V1 unsigned fallback`, "token-launcher");
        const contractV1 = new ethers.Contract(FOUR_MEME_TOKEN_MANAGER, FOUR_MEME_ABI, wallet);
        const maxOffer = ethers.parseUnits("500000000", 18);
        const presale = BigInt(0);
        tx = await contractV1["createToken(string,string,uint256,uint256,uint256,uint256)"](
          params.tokenName,
          params.tokenSymbol,
          totalSupply,
          maxOffer,
          presale,
          launchTime,
          { value: liquidity, gasLimit: 800000 }
        );
      }
    } catch (txError: any) {
      const rawMsg = txError.message || String(txError);
      log(`[TokenLauncher] four.meme TX error: ${rawMsg.substring(0, 500)}`, "token-launcher");
      if (txError.info) log(`[TokenLauncher] TX error info: ${JSON.stringify(txError.info).substring(0, 300)}`, "token-launcher");
      if (txError.reason) log(`[TokenLauncher] TX revert reason: ${txError.reason}`, "token-launcher");

      let userError: string;
      if (rawMsg.includes("insufficient funds") || rawMsg.includes("exceeds balance")) {
        userError = `Insufficient BNB — your wallet has ${balFormatted} BNB but needs at least ${ethers.formatEther(liquidity)} BNB + gas fees. Fund your wallet and try again.`;
      } else if (rawMsg.includes("CALL_EXCEPTION") || rawMsg.includes("reverted")) {
        const revertReason = txError.reason || "";
        userError = `Four.meme contract rejected the launch${revertReason ? ` (${revertReason})` : ""}. The token name/symbol may already be taken, or the contract requires a different parameter format. Try a different name.`;
      } else {
        userError = sanitizeError(rawMsg);
      }

      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: rawMsg.substring(0, 500),
      });
      return { success: false, error: userError, launchId: launchRecord.id };
    }

    log(`[TokenLauncher] four.meme TX sent: ${tx.hash}`, "token-launcher");

    await storage.updateTokenLaunch(launchRecord.id, {
      txHash: tx.hash,
      status: "confirming",
    });

    const receipt = await Promise.race([
      tx.wait(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("TX timeout (120s)")), 120000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: "Transaction reverted",
      });
      return { success: false, error: "Transaction reverted", txHash: tx.hash, launchId: launchRecord.id };
    }

    let tokenAddress: string | undefined;
    for (const eventLog of receipt.logs) {
      if (eventLog.topics.length >= 2) {
        const possibleAddress = "0x" + eventLog.topics[1]?.slice(26);
        if (possibleAddress && possibleAddress.length === 42 && possibleAddress !== ethers.ZeroAddress) {
          tokenAddress = possibleAddress;
          break;
        }
      }
    }

    if (!tokenAddress) {
      for (const eventLog of receipt.logs) {
        if (eventLog.data && eventLog.data.length >= 66) {
          const possibleAddr = "0x" + eventLog.data.slice(26, 66);
          if (ethers.isAddress(possibleAddr) && possibleAddr !== ethers.ZeroAddress) {
            tokenAddress = possibleAddr;
            break;
          }
        }
      }
    }

    const launchUrl = tokenAddress
      ? `https://four.meme/token/${tokenAddress}`
      : `https://bscscan.com/tx/${tx.hash}`;

    await storage.updateTokenLaunch(launchRecord.id, {
      status: "launched",
      tokenAddress: tokenAddress || null,
      txHash: receipt.hash,
      launchUrl,
    });

    log(`[TokenLauncher] four.meme launch success! Token: ${tokenAddress || "parsing..."}, TX: ${receipt.hash}`, "token-launcher");

    return {
      success: true,
      tokenAddress,
      txHash: receipt.hash,
      launchUrl,
      launchId: launchRecord.id,
    };
  } catch (e: any) {
    log(`[TokenLauncher] four.meme launch failed: ${e.message}`, "token-launcher");
    const cleanError = sanitizeError(e.message || "");
    await storage.updateTokenLaunch(launchRecord.id, {
      status: "failed",
      errorMessage: e.message?.substring(0, 500),
    });
    return { success: false, error: cleanError, launchId: launchRecord.id };
  }
}

async function launchOnFlapSh(params: LaunchParams): Promise<LaunchResult> {
  const provider = getBaseProvider();
  let wallet: ethers.Wallet | null = null;
  if (params.userPrivateKey) {
    wallet = new ethers.Wallet(params.userPrivateKey, provider);
    log(`[TokenLauncher] Using user wallet ${wallet.address.substring(0, 10)}... for Flap.sh launch`, "token-launcher");
  } else {
    wallet = getDeployerWallet(provider);
  }
  if (!wallet) {
    return { success: false, error: "No wallet available — generate or import a wallet with a private key first" };
  }

  const launchRecord = await storage.createTokenLaunch({
    agentId: params.agentId || null,
    creatorWallet: params.creatorWallet || wallet.address,
    platform: "flap_sh",
    chainId: 8453,
    tokenName: params.tokenName,
    tokenSymbol: params.tokenSymbol,
    tokenDescription: params.tokenDescription,
    imageUrl: params.imageUrl || null,
    initialLiquidityBnb: params.initialLiquidityBnb || "0.001",
    status: "pending",
    tokenAddress: null,
    txHash: null,
    launchUrl: null,
    errorMessage: null,
    metadata: null,
  });

  try {
    const balance = await provider.getBalance(wallet.address);
    const liquidity = ethers.parseEther(params.initialLiquidityBnb || "0.001");

    if (balance < liquidity + ethers.parseEther("0.0005")) {
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: `Insufficient ETH on Base: ${ethers.formatEther(balance)} ETH`,
      });
      return { success: false, error: `Insufficient ETH on Base: ${ethers.formatEther(balance)}`, launchId: launchRecord.id };
    }

    let apiResult;
    try {
      const res = await fetch(`${FLAP_API}/api/tokens/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: params.tokenName,
          symbol: params.tokenSymbol,
          description: params.tokenDescription,
          image: params.imageUrl || "",
          chain: "base",
          creator: wallet.address,
        }),
      });

      if (res.ok) {
        apiResult = await res.json();
      }
    } catch (e: any) {
      log(`[TokenLauncher] flap.sh API failed: ${e.message}`, "token-launcher");
    }

    if (apiResult?.contractAddress && apiResult?.data) {
      const tx = await wallet.sendTransaction({
        to: apiResult.contractAddress,
        data: apiResult.data,
        value: liquidity,
        gasLimit: 500000,
      });

      await storage.updateTokenLaunch(launchRecord.id, {
        txHash: tx.hash,
        status: "confirming",
      });

      const receipt = await Promise.race([
        tx.wait(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("TX timeout (120s)")), 120000)),
      ]);

      if (!receipt || receipt.status !== 1) {
        await storage.updateTokenLaunch(launchRecord.id, { status: "failed", errorMessage: "Transaction reverted" });
        return { success: false, error: "Transaction reverted", launchId: launchRecord.id };
      }

      let tokenAddress: string | undefined;
      for (const eventLog of receipt.logs) {
        if (eventLog.topics.length >= 2) {
          const possibleAddress = "0x" + eventLog.topics[1]?.slice(26);
          if (possibleAddress && possibleAddress.length === 42 && ethers.isAddress(possibleAddress) && possibleAddress !== ethers.ZeroAddress) {
            tokenAddress = possibleAddress;
            break;
          }
        }
      }

      const launchUrl = tokenAddress
        ? `https://flap.sh/token/${tokenAddress}`
        : `https://basescan.org/tx/${tx.hash}`;

      await storage.updateTokenLaunch(launchRecord.id, {
        status: "launched",
        tokenAddress: tokenAddress || null,
        txHash: receipt.hash,
        launchUrl,
      });

      return { success: true, tokenAddress, txHash: receipt.hash, launchUrl, launchId: launchRecord.id };
    }

    await storage.updateTokenLaunch(launchRecord.id, {
      status: "failed",
      errorMessage: "flap.sh API unavailable — direct contract interaction requires API signature",
    });

    return { success: false, error: "flap.sh API currently unavailable for programmatic launches", launchId: launchRecord.id };
  } catch (e: any) {
    log(`[TokenLauncher] flap.sh launch failed: ${e.message}`, "token-launcher");
    const cleanError = sanitizeError(e.message || "");
    await storage.updateTokenLaunch(launchRecord.id, {
      status: "failed",
      errorMessage: e.message?.substring(0, 500),
    });
    return { success: false, error: cleanError, launchId: launchRecord.id };
  }
}

export async function launchToken(params: LaunchParams): Promise<LaunchResult> {
  log(`[TokenLauncher] Launching ${params.tokenName} ($${params.tokenSymbol}) on ${params.platform}`, "token-launcher");

  if (params.platform === "four_meme") {
    return launchOnFourMeme(params);
  } else if (params.platform === "flap_sh") {
    return launchOnFlapSh(params);
  }

  return { success: false, error: `Unknown platform: ${params.platform}` };
}

export async function getTokenLaunches(agentId?: string, limit = 50): Promise<TokenLaunch[]> {
  return storage.getTokenLaunches(agentId, limit);
}

export async function getTokenLaunch(id: string): Promise<TokenLaunch | undefined> {
  return storage.getTokenLaunch(id);
}

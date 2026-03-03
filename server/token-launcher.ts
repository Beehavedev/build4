import { ethers } from "ethers";
import { storage } from "./storage";
import { log } from "./index";
import type { TokenLaunch, InsertTokenLaunch } from "@shared/schema";

const FOUR_MEME_CONTRACT = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
const FOUR_MEME_API = "https://four.meme";

const FOUR_MEME_ABI = [
  {
    inputs: [
      { internalType: "bytes", name: "args", type: "bytes" },
      { internalType: "bytes", name: "signature", type: "bytes" },
    ],
    name: "createToken",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
];

const TOKEN_CREATE_EVENT = "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20";

const FLAP_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
const FLAP_PORTAL_ABI = [
  {
    inputs: [
      { internalType: "string", name: "name", type: "string" },
      { internalType: "string", name: "symbol", type: "string" },
      { internalType: "string", name: "meta", type: "string" },
    ],
    name: "newToken",
    outputs: [{ internalType: "address", name: "token", type: "address" }],
    stateMutability: "payable",
    type: "function",
  },
];
const FLAP_TOKEN_CREATED_TOPIC = "0x"; // parsed from logs generically

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

async function fourMemeLogin(wallet: ethers.Wallet): Promise<string> {
  const nonceRes = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/user/nonce/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountAddress: wallet.address,
      verifyType: "LOGIN",
      networkCode: "BSC",
    }),
  });
  if (nonceRes.status !== 200) {
    throw new Error(`four.meme nonce API returned ${nonceRes.status}`);
  }
  const nonceJson = await nonceRes.json();
  if (!nonceJson.data) {
    throw new Error(`four.meme nonce failed: ${nonceJson.msg || JSON.stringify(nonceJson).substring(0, 100)}`);
  }

  const message = `You are sign in Meme ${nonceJson.data}`;
  const signature = await wallet.signMessage(message);

  const loginRes = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/user/login/dex`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      region: "WEB",
      langType: "EN",
      loginIp: "",
      inviteCode: "",
      verifyInfo: {
        address: wallet.address,
        networkCode: "BSC",
        signature,
        verifyType: "LOGIN",
      },
      walletName: "MetaMask",
    }),
  });
  if (loginRes.status !== 200) {
    throw new Error(`four.meme login API returned ${loginRes.status}`);
  }
  const loginJson = await loginRes.json();
  if (!loginJson.data) {
    throw new Error(`four.meme login failed: ${loginJson.msg || JSON.stringify(loginJson).substring(0, 100)}`);
  }
  return loginJson.data;
}

async function fourMemeCreateTokenData(
  params: LaunchParams,
  accessToken: string,
  preSaleEth: string,
): Promise<{ createArg: string; signature: string; value: bigint }> {
  const createRes = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "meme-web-access": accessToken,
    },
    body: JSON.stringify({
      name: params.tokenName,
      shortName: params.tokenSymbol,
      desc: params.tokenDescription || "",
      imgUrl: params.imageUrl || "",
      totalSupply: 1000000000,
      raisedAmount: 24,
      saleRate: 0.8,
      reserveRate: 0,
      raisedToken: {
        symbol: "BNB",
        nativeSymbol: "BNB",
        symbolAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        deployCost: "0",
        buyFee: "0.01",
        sellFee: "0.01",
        minTradeFee: "0",
        b0Amount: "8",
        totalBAmount: "24",
        totalAmount: "1000000000",
        logoUrl: "https://static.four.meme/market/68b871b6-96f7-408c-b8d0-388d804b34275092658264263839640.png",
        tradeLevel: ["0.1", "0.5", "1"],
        status: "PUBLISH",
        buyTokenLink: "https://pancakeswap.finance/swap",
        reservedNumber: 10,
        saleRate: "0.8",
        networkCode: "BSC",
        platform: "MEME",
      },
      launchTime: Date.now(),
      funGroup: false,
      clickFun: false,
      symbol: "BNB",
      label: "Meme",
      lpTradingFee: 0.0025,
    }),
  });

  const createJson = await createRes.json();
  if (createJson.msg !== "success" || !createJson.data?.createArg || !createJson.data?.signature) {
    throw new Error(`four.meme create API failed: ${createJson.msg || JSON.stringify(createJson).substring(0, 200)}`);
  }

  const preSaleWei = (ethers.parseEther(preSaleEth) * BigInt(101)) / BigInt(100);

  return {
    createArg: createJson.data.createArg,
    signature: createJson.data.signature,
    value: preSaleWei,
  };
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
    const preSaleEth = params.initialLiquidityBnb || "0.01";
    const preSaleWei = (ethers.parseEther(preSaleEth) * BigInt(101)) / BigInt(100);

    const balance = await provider.getBalance(wallet.address);
    const balFormatted = ethers.formatEther(balance);
    log(`[TokenLauncher] Deployer balance: ${balFormatted} BNB`, "token-launcher");

    if (balance < preSaleWei + ethers.parseEther("0.005")) {
      const needed = ethers.formatEther(preSaleWei + ethers.parseEther("0.005"));
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: `Insufficient BNB balance: ${balFormatted} BNB (need ${needed} BNB)`,
      });
      return { success: false, error: `Insufficient BNB — your wallet has ${balFormatted} BNB but needs at least ${needed} BNB. Fund your wallet and try again.`, launchId: launchRecord.id };
    }

    log(`[TokenLauncher] Step 1: Logging into four.meme...`, "token-launcher");
    const accessToken = await fourMemeLogin(wallet);
    log(`[TokenLauncher] Step 1 OK: logged in`, "token-launcher");

    log(`[TokenLauncher] Step 2: Creating token via four.meme API...`, "token-launcher");
    const txData = await fourMemeCreateTokenData(params, accessToken, preSaleEth);
    log(`[TokenLauncher] Step 2 OK: got createArg (${txData.createArg.length} chars) + signature`, "token-launcher");

    log(`[TokenLauncher] Step 3: Sending on-chain TX to ${FOUR_MEME_CONTRACT}...`, "token-launcher");
    const contract = new ethers.Contract(FOUR_MEME_CONTRACT, FOUR_MEME_ABI, wallet);

    let tx;
    try {
      tx = await contract.createToken(txData.createArg, txData.signature, {
        value: txData.value,
        gasLimit: 1000000,
      });
    } catch (txError: any) {
      const rawMsg = txError.message || String(txError);
      log(`[TokenLauncher] four.meme TX error: ${rawMsg.substring(0, 500)}`, "token-launcher");
      if (txError.info) log(`[TokenLauncher] TX error info: ${JSON.stringify(txError.info).substring(0, 300)}`, "token-launcher");
      if (txError.reason) log(`[TokenLauncher] TX revert reason: ${txError.reason}`, "token-launcher");

      let userError: string;
      if (rawMsg.includes("insufficient funds") || rawMsg.includes("exceeds balance")) {
        userError = `Insufficient BNB — your wallet has ${balFormatted} BNB but needs more for gas fees. Fund your wallet and try again.`;
      } else if (rawMsg.includes("CALL_EXCEPTION") || rawMsg.includes("reverted")) {
        const revertReason = txError.reason || "";
        userError = `Four.meme contract rejected the launch${revertReason ? ` (${revertReason})` : ""}. The token name/symbol may already be taken — try a different name.`;
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
        errorMessage: "Transaction reverted on-chain",
      });
      return { success: false, error: "Transaction reverted on-chain", txHash: tx.hash, launchId: launchRecord.id };
    }

    let tokenAddress: string | undefined;
    const tokenCreateLog = receipt.logs.find(
      (l: any) => l.topics?.length > 0 && l.topics[0] === TOKEN_CREATE_EVENT
    );
    if (tokenCreateLog && tokenCreateLog.data) {
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "address", "uint256", "string", "string", "uint256", "uint256", "uint256"],
          tokenCreateLog.data
        );
        tokenAddress = decoded[1];
      } catch {
        // fallback
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
  const provider = getBscProvider();
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
    const initialBuy = ethers.parseEther(params.initialLiquidityBnb || "0.01");

    const balance = await provider.getBalance(wallet.address);
    const balFormatted = ethers.formatEther(balance);
    log(`[TokenLauncher] Deployer balance: ${balFormatted} BNB`, "token-launcher");

    if (balance < initialBuy + ethers.parseEther("0.005")) {
      const needed = ethers.formatEther(initialBuy + ethers.parseEther("0.005"));
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: `Insufficient BNB: ${balFormatted} BNB (need ${needed} BNB)`,
      });
      return { success: false, error: `Insufficient BNB — your wallet has ${balFormatted} BNB but needs at least ${needed} BNB. Fund your wallet and try again.`, launchId: launchRecord.id };
    }

    log(`[TokenLauncher] Calling Flap Portal newToken(${params.tokenName}, ${params.tokenSymbol}) with ${ethers.formatEther(initialBuy)} BNB...`, "token-launcher");
    const portal = new ethers.Contract(FLAP_PORTAL, FLAP_PORTAL_ABI, wallet);

    const meta = params.tokenDescription || "";

    let tx;
    try {
      tx = await portal.newToken(params.tokenName, params.tokenSymbol, meta, {
        value: initialBuy,
        gasLimit: 1500000,
      });
    } catch (txError: any) {
      const rawMsg = txError.message || String(txError);
      log(`[TokenLauncher] flap.sh TX error: ${rawMsg.substring(0, 500)}`, "token-launcher");
      if (txError.reason) log(`[TokenLauncher] TX revert reason: ${txError.reason}`, "token-launcher");

      let userError: string;
      if (rawMsg.includes("insufficient funds") || rawMsg.includes("exceeds balance")) {
        userError = `Insufficient BNB — your wallet has ${balFormatted} BNB. Fund your wallet and try again.`;
      } else if (rawMsg.includes("CALL_EXCEPTION") || rawMsg.includes("reverted")) {
        userError = `Flap.sh contract rejected the launch${txError.reason ? ` (${txError.reason})` : ""}. Try a different token name/symbol.`;
      } else {
        userError = sanitizeError(rawMsg);
      }

      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: rawMsg.substring(0, 500),
      });
      return { success: false, error: userError, launchId: launchRecord.id };
    }

    log(`[TokenLauncher] flap.sh TX sent: ${tx.hash}`, "token-launcher");

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
        errorMessage: "Transaction reverted on-chain",
      });
      return { success: false, error: "Transaction reverted on-chain", txHash: tx.hash, launchId: launchRecord.id };
    }

    let tokenAddress: string | undefined;
    for (const eventLog of receipt.logs) {
      if (eventLog.data && eventLog.data.length >= 66) {
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address"], "0x" + eventLog.data.slice(2, 66));
          if (decoded[0] && ethers.isAddress(decoded[0]) && decoded[0] !== ethers.ZeroAddress) {
            tokenAddress = decoded[0];
            break;
          }
        } catch {}
      }
    }

    if (!tokenAddress) {
      for (const eventLog of receipt.logs) {
        if (eventLog.topics && eventLog.topics.length >= 2) {
          const possibleAddr = "0x" + eventLog.topics[1]?.slice(26);
          if (possibleAddr.length === 42 && ethers.isAddress(possibleAddr) && possibleAddr !== ethers.ZeroAddress) {
            tokenAddress = possibleAddr;
            break;
          }
        }
      }
    }

    const launchUrl = tokenAddress
      ? `https://flap.sh/token/${tokenAddress}`
      : `https://bscscan.com/tx/${tx.hash}`;

    await storage.updateTokenLaunch(launchRecord.id, {
      status: "launched",
      tokenAddress: tokenAddress || null,
      txHash: receipt.hash,
      launchUrl,
    });

    log(`[TokenLauncher] flap.sh launch success! Token: ${tokenAddress || "parsing..."}, TX: ${receipt.hash}`, "token-launcher");

    return {
      success: true,
      tokenAddress,
      txHash: receipt.hash,
      launchUrl,
      launchId: launchRecord.id,
    };
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

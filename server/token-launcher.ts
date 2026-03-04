import { ethers } from "ethers";
import { storage } from "./storage";
import { log } from "./index";
import type { TokenLaunch, InsertTokenLaunch } from "@shared/schema";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const TOKEN_IMAGE_DIR = path.resolve(process.cwd(), "public/uploads/token-images");

function hashToColors(input: string): { bg1: string; bg2: string; fg: string; accent: string } {
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  const hue1 = parseInt(hash.substring(0, 4), 16) % 360;
  const hue2 = (hue1 + 40 + (parseInt(hash.substring(4, 6), 16) % 60)) % 360;
  const sat = 65 + (parseInt(hash.substring(6, 8), 16) % 25);
  return {
    bg1: `hsl(${hue1}, ${sat}%, 45%)`,
    bg2: `hsl(${hue2}, ${sat}%, 30%)`,
    fg: "#ffffff",
    accent: `hsl(${hue1}, ${sat}%, 65%)`,
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function generateTokenSvg(tokenName: string, tokenSymbol: string): string {
  const colors = hashToColors(`${tokenName}-${tokenSymbol}`);
  const displaySymbol = escapeXml(tokenSymbol.substring(0, 4).replace(/[^a-zA-Z0-9]/g, ""));
  const fontSize = displaySymbol.length <= 2 ? 180 : displaySymbol.length === 3 ? 150 : 120;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="35%" cy="35%" r="65%">
      <stop offset="0%" stop-color="${colors.bg1}"/>
      <stop offset="100%" stop-color="${colors.bg2}"/>
    </radialGradient>
    <radialGradient id="shine" cx="30%" cy="25%" r="50%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.25)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
    <filter id="shadow">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="rgba(0,0,0,0.3)"/>
    </filter>
  </defs>
  <circle cx="256" cy="256" r="250" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="220" fill="none" stroke="${colors.accent}" stroke-width="3" opacity="0.4"/>
  <circle cx="256" cy="256" r="250" fill="url(#shine)"/>
  <text x="256" y="${268 + (fontSize > 140 ? 10 : 0)}" text-anchor="middle" dominant-baseline="central" font-family="Arial,Helvetica,sans-serif" font-weight="bold" font-size="${fontSize}" fill="${colors.fg}" filter="url(#shadow)">${displaySymbol}</text>
  <circle cx="256" cy="256" r="248" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="4"/>
</svg>`;
}

async function generateTokenImagePng(tokenName: string, tokenSymbol: string): Promise<Buffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    const svg = generateTokenSvg(tokenName, tokenSymbol);
    const pngBuffer = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();
    log(`[TokenLauncher] Generated PNG image for ${tokenSymbol} (${pngBuffer.length} bytes)`, "token-launcher");
    return pngBuffer;
  } catch (e: any) {
    log(`[TokenLauncher] PNG generation failed: ${e.message?.substring(0, 100)}`, "token-launcher");
    return null;
  }
}

async function fourMemeUploadImage(pngBuffer: Buffer, accessToken: string): Promise<string | null> {
  try {
    const boundary = `----FormBoundary${crypto.randomBytes(8).toString("hex")}`;
    const filename = `token-${Date.now()}.png`;

    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([Buffer.from(header), pngBuffer, Buffer.from(footer)]);

    const uploadRes = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/upload`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "meme-web-access": accessToken,
      },
      body,
    });

    const uploadJson = await uploadRes.json() as any;
    if (uploadJson.code === 0 && uploadJson.data) {
      const imgUrl = typeof uploadJson.data === "string" ? uploadJson.data : uploadJson.data.url || uploadJson.data.imgUrl;
      log(`[TokenLauncher] Image uploaded to four.meme CDN: ${imgUrl}`, "token-launcher");
      return imgUrl;
    }

    log(`[TokenLauncher] four.meme upload response: ${JSON.stringify(uploadJson).substring(0, 200)}`, "token-launcher");
    return null;
  } catch (e: any) {
    log(`[TokenLauncher] four.meme image upload failed: ${e.message?.substring(0, 100)}`, "token-launcher");
    return null;
  }
}

const FOUR_MEME_CONTRACT = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
const FOUR_MEME_HELPER3 = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";
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
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "funds", type: "uint256" },
      { internalType: "uint256", name: "minAmount", type: "uint256" },
    ],
    name: "buyTokenAMAP",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "maxFunds", type: "uint256" },
    ],
    name: "buyToken",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "sellToken",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

const FOUR_MEME_HELPER3_ABI = [
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
    ],
    name: "getTokenInfo",
    outputs: [
      { internalType: "uint256", name: "version", type: "uint256" },
      { internalType: "address", name: "tokenManager", type: "address" },
      { internalType: "address", name: "quote", type: "address" },
      { internalType: "uint256", name: "lastPrice", type: "uint256" },
      { internalType: "uint256", name: "tradingFeeRate", type: "uint256" },
      { internalType: "uint256", name: "minTradingFee", type: "uint256" },
      { internalType: "uint256", name: "launchTime", type: "uint256" },
      { internalType: "uint256", name: "offers", type: "uint256" },
      { internalType: "uint256", name: "maxOffers", type: "uint256" },
      { internalType: "uint256", name: "funds", type: "uint256" },
      { internalType: "uint256", name: "maxFunds", type: "uint256" },
      { internalType: "bool", name: "liquidityAdded", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "funds", type: "uint256" },
    ],
    name: "tryBuy",
    outputs: [
      { internalType: "address", name: "tokenManager", type: "address" },
      { internalType: "address", name: "quote", type: "address" },
      { internalType: "uint256", name: "estimatedAmount", type: "uint256" },
      { internalType: "uint256", name: "estimatedCost", type: "uint256" },
      { internalType: "uint256", name: "estimatedFee", type: "uint256" },
      { internalType: "uint256", name: "amountMsgValue", type: "uint256" },
      { internalType: "uint256", name: "amountApproval", type: "uint256" },
      { internalType: "uint256", name: "amountFunds", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "trySell",
    outputs: [
      { internalType: "address", name: "tokenManager", type: "address" },
      { internalType: "address", name: "quote", type: "address" },
      { internalType: "uint256", name: "funds", type: "uint256" },
      { internalType: "uint256", name: "fee", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const ERC20_ABI = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

const FOUR_MEME_V1_CONTRACT = "0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC";

const FOUR_MEME_V1_ABI = [
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "funds", type: "uint256" },
      { internalType: "uint256", name: "minAmount", type: "uint256" },
    ],
    name: "purchaseTokenAMAP",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "saleToken",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

const TOKEN_CREATE_EVENT = "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20";

const FLAP_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
const FLAP_NO_TAX_IMPL = "0x8B4329947e34B6d56D71A3385caC122BaDe7d78D";
const FLAP_TAX_IMPL = "0x5dd913731C12aD8DF3E574859FDe45412bF4aaD9";

function mineVanitySalt(portal: string, tokenImpl: string, suffix: string): { salt: string; address: string } {
  const bytecode = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" + tokenImpl.slice(2).toLowerCase() + "5af43d82803e903d91602b57fd5bf3";
  const bytecodeHash = ethers.keccak256(bytecode);
  let salt = ethers.keccak256(ethers.randomBytes(32));
  const maxIterations = 10_000_000;
  for (let i = 0; i < maxIterations; i++) {
    const addr = ethers.getCreate2Address(portal, salt, bytecodeHash);
    if (addr.toLowerCase().endsWith(suffix)) {
      return { salt, address: addr };
    }
    salt = ethers.keccak256(salt);
  }
  throw new Error(`Failed to mine vanity salt ending in ${suffix} after ${maxIterations} iterations`);
}

const FLAP_PORTAL_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "meta", type: "string" },
          { name: "dexThresh", type: "uint8" },
          { name: "salt", type: "bytes32" },
          { name: "taxRate", type: "uint16" },
          { name: "migratorType", type: "uint8" },
          { name: "quoteToken", type: "address" },
          { name: "quoteAmt", type: "uint256" },
          { name: "beneficiary", type: "address" },
          { name: "permitData", type: "bytes" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "newTokenV2",
    outputs: [{ name: "token", type: "address" }],
    stateMutability: "payable",
    type: "function",
  },
];

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
      imgUrl: params.imageUrl || "https://static.four.meme/market/68b871b6-96f7-408c-b8d0-388d804b34275092658264263839640.png",
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

    if (!params.imageUrl) {
      log(`[TokenLauncher] Step 1.5: Generating + uploading token image...`, "token-launcher");
      const pngBuffer = await generateTokenImagePng(params.tokenName, params.tokenSymbol);
      if (pngBuffer) {
        const cdnUrl = await fourMemeUploadImage(pngBuffer, accessToken);
        if (cdnUrl) {
          params.imageUrl = cdnUrl;
          log(`[TokenLauncher] Step 1.5 OK: image uploaded to ${cdnUrl}`, "token-launcher");
        }
      }
    }

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

    log(`[TokenLauncher] Calling Flap Portal newTokenV2(${params.tokenName}, ${params.tokenSymbol}) with ${ethers.formatEther(initialBuy)} BNB...`, "token-launcher");
    const portal = new ethers.Contract(FLAP_PORTAL, FLAP_PORTAL_ABI, wallet);

    const meta = params.tokenDescription || "";

    log(`[TokenLauncher] Mining vanity salt for flap.sh token (suffix 8888)...`, "token-launcher");
    const minedSalt = mineVanitySalt(FLAP_PORTAL, FLAP_NO_TAX_IMPL, "8888");
    log(`[TokenLauncher] Vanity salt found: ${minedSalt.salt.substring(0, 18)}... -> ${minedSalt.address}`, "token-launcher");

    const tokenParams = {
      name: params.tokenName,
      symbol: params.tokenSymbol,
      meta,
      dexThresh: 1,
      salt: minedSalt.salt,
      taxRate: 0,
      migratorType: 0,
      quoteToken: ethers.ZeroAddress,
      quoteAmt: initialBuy,
      beneficiary: wallet.address,
      permitData: "0x",
    };

    let tx;
    try {
      tx = await portal.newTokenV2(tokenParams, {
        value: initialBuy,
        gasLimit: 2000000,
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
      if (eventLog.address?.toLowerCase().endsWith("7777") || eventLog.address?.toLowerCase().endsWith("8888")) {
        tokenAddress = eventLog.address;
        break;
      }
    }
    if (!tokenAddress) {
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
    }
    if (!tokenAddress) {
      tokenAddress = minedSalt.address;
      log(`[TokenLauncher] Could not extract token address from logs, using mined vanity address: ${tokenAddress}`, "token-launcher");
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

export interface FourMemeTokenInfo {
  version: number;
  tokenManager: string;
  quote: string;
  lastPrice: string;
  tradingFeeRate: number;
  minTradingFee: string;
  launchTime: number;
  offers: string;
  maxOffers: string;
  funds: string;
  maxFunds: string;
  liquidityAdded: boolean;
  progressPercent: number;
}

export async function fourMemeGetTokenInfo(tokenAddress: string): Promise<FourMemeTokenInfo> {
  const provider = getBscProvider();
  const helper = new ethers.Contract(FOUR_MEME_HELPER3, FOUR_MEME_HELPER3_ABI, provider);

  const info = await helper.getTokenInfo(tokenAddress);

  const fundsNum = parseFloat(ethers.formatEther(info.funds));
  const maxFundsNum = parseFloat(ethers.formatEther(info.maxFunds));
  const progressPercent = maxFundsNum > 0 ? Math.min(100, (fundsNum / maxFundsNum) * 100) : 0;

  return {
    version: Number(info.version),
    tokenManager: info.tokenManager,
    quote: info.quote,
    lastPrice: ethers.formatEther(info.lastPrice),
    tradingFeeRate: Number(info.tradingFeeRate) / 10000,
    minTradingFee: ethers.formatEther(info.minTradingFee),
    launchTime: Number(info.launchTime),
    offers: ethers.formatEther(info.offers),
    maxOffers: ethers.formatEther(info.maxOffers),
    funds: ethers.formatEther(info.funds),
    maxFunds: ethers.formatEther(info.maxFunds),
    liquidityAdded: info.liquidityAdded,
    progressPercent: Math.round(progressPercent * 100) / 100,
  };
}

export interface FourMemeBuyEstimate {
  tokenManager: string;
  quote: string;
  estimatedAmount: string;
  estimatedCost: string;
  estimatedFee: string;
  msgValue: string;
}

export async function fourMemeEstimateBuy(
  tokenAddress: string,
  bnbAmount: string,
): Promise<FourMemeBuyEstimate> {
  const provider = getBscProvider();
  const helper = new ethers.Contract(FOUR_MEME_HELPER3, FOUR_MEME_HELPER3_ABI, provider);

  const fundsWei = ethers.parseEther(bnbAmount);
  const result = await helper.tryBuy(tokenAddress, 0, fundsWei);

  return {
    tokenManager: result.tokenManager,
    quote: result.quote,
    estimatedAmount: ethers.formatEther(result.estimatedAmount),
    estimatedCost: ethers.formatEther(result.estimatedCost),
    estimatedFee: ethers.formatEther(result.estimatedFee),
    msgValue: ethers.formatEther(result.amountMsgValue),
  };
}

export interface FourMemeSellEstimate {
  tokenManager: string;
  quote: string;
  fundsReceived: string;
  fee: string;
}

export async function fourMemeEstimateSell(
  tokenAddress: string,
  tokenAmount: string,
): Promise<FourMemeSellEstimate> {
  const provider = getBscProvider();
  const helper = new ethers.Contract(FOUR_MEME_HELPER3, FOUR_MEME_HELPER3_ABI, provider);

  const amountWei = ethers.parseEther(tokenAmount);
  const result = await helper.trySell(tokenAddress, amountWei);

  return {
    tokenManager: result.tokenManager,
    quote: result.quote,
    fundsReceived: ethers.formatEther(result.funds),
    fee: ethers.formatEther(result.fee),
  };
}

export interface FourMemeTradeResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export async function fourMemeBuyToken(
  tokenAddress: string,
  bnbAmount: string,
  slippagePct: number,
  userPrivateKey: string,
): Promise<FourMemeTradeResult> {
  try {
    const provider = getBscProvider();
    const wallet = new ethers.Wallet(userPrivateKey, provider);

    log(`[FourMeme] Estimating buy for ${bnbAmount} BNB on token ${tokenAddress.substring(0, 10)}...`, "token-launcher");

    const helper = new ethers.Contract(FOUR_MEME_HELPER3, FOUR_MEME_HELPER3_ABI, provider);
    const fundsWei = ethers.parseEther(bnbAmount);

    const [estimate, info] = await Promise.all([
      helper.tryBuy(tokenAddress, 0, fundsWei),
      helper.getTokenInfo(tokenAddress),
    ]);

    const version = Number(info.version);
    const quote = info.quote;
    const isNativeQuote = quote === ethers.ZeroAddress;

    if (!isNativeQuote) {
      return { success: false, error: "This token uses a BEP20 quote (not BNB). BEP20-quoted token trading is not yet supported." };
    }

    const minAmount = (estimate.estimatedAmount * BigInt(Math.floor((100 - slippagePct) * 100))) / BigInt(10000);
    const tokenManager = estimate.tokenManager;

    log(`[FourMeme] V${version} token — buying ~${ethers.formatEther(estimate.estimatedAmount)} tokens for ${bnbAmount} BNB (slippage ${slippagePct}%)`, "token-launcher");

    let tx;
    if (version === 1) {
      const tm = new ethers.Contract(tokenManager, FOUR_MEME_V1_ABI, wallet);
      tx = await tm.purchaseTokenAMAP(tokenAddress, fundsWei, minAmount, {
        value: estimate.amountMsgValue,
        gasLimit: 500000,
      });
    } else {
      const tm = new ethers.Contract(tokenManager, FOUR_MEME_ABI, wallet);
      tx = await tm.buyTokenAMAP(tokenAddress, fundsWei, minAmount, {
        value: estimate.amountMsgValue,
        gasLimit: 500000,
      });
    }

    log(`[FourMeme] Buy TX sent: ${tx.hash}`, "token-launcher");

    const receipt = await Promise.race([
      tx.wait(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("TX timeout (90s)")), 90000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      return { success: false, error: "Buy transaction reverted on-chain" };
    }

    log(`[FourMeme] Buy confirmed: ${receipt.hash}`, "token-launcher");
    return { success: true, txHash: receipt.hash };
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("error code=\"A\"") || msg.includes("\"A\"")) {
      return { success: false, error: "This is an X Mode exclusive token — cannot buy via standard method. Trade it directly on four.meme." };
    }
    log(`[FourMeme] Buy failed: ${msg.substring(0, 300)}`, "token-launcher");
    return { success: false, error: sanitizeError(msg) };
  }
}

export async function fourMemeSellToken(
  tokenAddress: string,
  tokenAmount: string,
  userPrivateKey: string,
): Promise<FourMemeTradeResult> {
  try {
    const provider = getBscProvider();
    const wallet = new ethers.Wallet(userPrivateKey, provider);

    const helper = new ethers.Contract(FOUR_MEME_HELPER3, FOUR_MEME_HELPER3_ABI, provider);
    const amountWei = ethers.parseEther(tokenAmount);

    const info = await helper.getTokenInfo(tokenAddress);
    const version = Number(info.version);
    const tokenManager = info.tokenManager;

    log(`[FourMeme] V${version} token — approving ${tokenAmount} tokens for TokenManager ${tokenManager.substring(0, 10)}...`, "token-launcher");
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const approveTx = await token.approve(tokenManager, amountWei, { gasLimit: 100000 });
    await approveTx.wait();
    log(`[FourMeme] Approval confirmed`, "token-launcher");

    let tx;
    if (version === 1) {
      const tm = new ethers.Contract(tokenManager, FOUR_MEME_V1_ABI, wallet);
      log(`[FourMeme] Selling ${tokenAmount} tokens via V1 saleToken...`, "token-launcher");
      tx = await tm.saleToken(tokenAddress, amountWei, { gasLimit: 500000 });
    } else {
      const tm = new ethers.Contract(tokenManager, FOUR_MEME_ABI, wallet);
      log(`[FourMeme] Selling ${tokenAmount} tokens via V2 sellToken...`, "token-launcher");
      tx = await tm.sellToken(tokenAddress, amountWei, { gasLimit: 500000 });
    }

    log(`[FourMeme] Sell TX sent: ${tx.hash}`, "token-launcher");

    const receipt = await Promise.race([
      tx.wait(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("TX timeout (90s)")), 90000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      return { success: false, error: "Sell transaction reverted on-chain" };
    }

    log(`[FourMeme] Sell confirmed: ${receipt.hash}`, "token-launcher");
    return { success: true, txHash: receipt.hash };
  } catch (e: any) {
    log(`[FourMeme] Sell failed: ${e.message?.substring(0, 300)}`, "token-launcher");
    return { success: false, error: sanitizeError(e.message || "") };
  }
}

export async function fourMemeGetTokenBalance(
  tokenAddress: string,
  walletAddress: string,
): Promise<{ balance: string; symbol: string; decimals: number }> {
  const provider = getBscProvider();
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [balance, symbol, decimals] = await Promise.all([
    token.balanceOf(walletAddress),
    token.symbol().catch(() => "???"),
    token.decimals().catch(() => 18),
  ]);
  return {
    balance: ethers.formatUnits(balance, decimals),
    symbol,
    decimals: Number(decimals),
  };
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

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

const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const PANCAKE_ROUTER_ABI = [
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
];

const ERC8004_IDENTITY_REGISTRY_BSC = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const registeredAgentWallets = new Set<string>();

let erc8004BscDisabled = false;

async function isAgentRegistered(walletAddress: string): Promise<boolean> {
  if (registeredAgentWallets.has(walletAddress.toLowerCase())) return true;
  if (erc8004BscDisabled) return false;
  try {
    const provider = getBscProvider();
    const registry = new ethers.Contract(ERC8004_IDENTITY_REGISTRY_BSC, [
      "function balanceOf(address owner) view returns (uint256)",
    ], provider);
    const balance = await registry.balanceOf(walletAddress);
    const hasNft = BigInt(balance) > 0n;
    if (hasNft) registeredAgentWallets.add(walletAddress.toLowerCase());
    return hasNft;
  } catch (e: any) {
    log(`[ERC-8004] balanceOf check failed on BSC — disabling further checks: ${e.message?.substring(0, 80)}`, "token-launcher");
    erc8004BscDisabled = true;
    return false;
  }
}

async function ensureAgentRegisteredBSC(
  wallet: ethers.Wallet,
  agentName?: string,
  agentDescription?: string,
  agentDbId?: string,
): Promise<{ registered: boolean; txHash?: string; error?: string }> {
  try {
    const already = await isAgentRegistered(wallet.address);
    if (already) {
      log(`[ERC-8004] Wallet ${wallet.address.substring(0, 10)}... already registered as agent on BSC`, "token-launcher");
      return { registered: true };
    }

    const { registerAgentERC8004 } = await import("./onchain");
    const result = await registerAgentERC8004(
      agentName || "BUILD4 Agent",
      agentDescription || "Autonomous AI agent on BUILD4",
      agentDbId || "telegram-user",
      "bsc",
      wallet.privateKey,
    );

    if (result.success) {
      registeredAgentWallets.add(wallet.address.toLowerCase());
      log(`[ERC-8004] Agent registered on BSC! TX: ${result.txHash}`, "token-launcher");
      return { registered: true, txHash: result.txHash };
    } else {
      return { registered: false, error: result.error };
    }
  } catch (e: any) {
    const msg = e.message?.substring(0, 150) || "Unknown error";
    log(`[ERC-8004] BSC registration failed: ${msg}`, "token-launcher");
    return { registered: false, error: msg };
  }
}

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
  platform: "four_meme" | "flap_sh" | "bankr" | "xlayer";
  initialLiquidityBnb?: string;
  agentId?: string;
  creatorWallet?: string;
  userPrivateKey?: string;
  webUrl?: string;
  twitterUrl?: string;
  telegramUrl?: string;
  taxRate?: number;
  bankrChain?: "base" | "solana";
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

function getTreasuryAddress(): string | null {
  const pk = process.env.BOUNTY_WALLET_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) return null;
  try {
    return new ethers.Wallet(pk).address;
  } catch {
    return null;
  }
}

const TOKEN_LAUNCH_FEE = BigInt("10000000000000000");

async function collectLaunchFee(
  userWallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const treasury = getTreasuryAddress();
  if (!treasury) {
    log(`[LaunchFee] No treasury wallet configured — skipping fee`, "token-launcher");
    return { success: true };
  }

  if (userWallet.address.toLowerCase() === treasury.toLowerCase()) {
    return { success: true };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const balance = await provider.getBalance(userWallet.address);
      if (balance < TOKEN_LAUNCH_FEE) {
        const balBnb = ethers.formatEther(balance);
        const feeBnb = ethers.formatEther(TOKEN_LAUNCH_FEE);
        return { success: false, error: `Insufficient balance for launch fee. Your wallet has ${balBnb} BNB but the launch fee is ${feeBnb} BNB (~$7). Fund your wallet and try again.` };
      }

      log(`[LaunchFee] Collecting ${ethers.formatEther(TOKEN_LAUNCH_FEE)} BNB launch fee (attempt ${attempt}/3) from ${userWallet.address.substring(0, 10)}...`, "token-launcher");

      const feeData = await provider.getFeeData();
      const tx = await userWallet.sendTransaction({
        to: treasury,
        value: TOKEN_LAUNCH_FEE,
        gasLimit: 21000,
        gasPrice: feeData.gasPrice ? feeData.gasPrice * 12n / 10n : undefined,
      });

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        if (attempt < 3) { await new Promise(r => setTimeout(r, 3000)); continue; }
        return { success: false, error: "Launch fee transaction failed on-chain" };
      }

      log(`[LaunchFee] Fee collected: ${tx.hash}`, "token-launcher");
      return { success: true, txHash: tx.hash };
    } catch (e: any) {
      const msg = e.message || "";
      if (msg.includes("insufficient funds")) {
        return { success: false, error: `Insufficient BNB for launch fee (${ethers.formatEther(TOKEN_LAUNCH_FEE)} BNB). Fund your wallet and try again.` };
      }
      log(`[LaunchFee] Fee attempt ${attempt}/3 failed: ${msg.substring(0, 200)}`, "token-launcher");
      if (attempt < 3) { await new Promise(r => setTimeout(r, 3000)); continue; }
      return { success: false, error: `Launch fee failed: ${msg.substring(0, 100)}` };
    }
  }
  return { success: false, error: "Launch fee failed after 3 attempts" };
}

export async function collectTradeFee(
  userPrivateKey: string,
  tradeAmountBnb: string,
  feePercent: number = 1.0,
): Promise<{ success: boolean; txHash?: string; feeAmount?: string; error?: string }> {
  const treasury = getTreasuryAddress();
  if (!treasury) {
    log(`[TradeFee] No treasury wallet configured — skipping fee`, "token-launcher");
    return { success: true, feeAmount: "0" };
  }

  try {
    const provider = getBscProvider();
    const wallet = new ethers.Wallet(userPrivateKey, provider);

    if (wallet.address.toLowerCase() === treasury.toLowerCase()) {
      return { success: true, feeAmount: "0" };
    }

    const tradeWei = ethers.parseEther(tradeAmountBnb);
    const feeWei = (tradeWei * BigInt(Math.floor(feePercent * 100))) / 10000n;

    if (feeWei === 0n) {
      return { success: true, feeAmount: "0" };
    }

    const balance = await provider.getBalance(wallet.address);
    if (balance < feeWei + ethers.parseEther("0.0005")) {
      log(`[TradeFee] Insufficient balance for fee — skipping (balance: ${ethers.formatEther(balance)} BNB, fee: ${ethers.formatEther(feeWei)} BNB)`, "token-launcher");
      return { success: true, feeAmount: "0" };
    }

    const feeData = await provider.getFeeData();
    const tx = await wallet.sendTransaction({
      to: treasury,
      value: feeWei,
      gasLimit: 21000,
      gasPrice: feeData.gasPrice ? feeData.gasPrice * 12n / 10n : undefined,
    });

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      log(`[TradeFee] Fee tx reverted`, "token-launcher");
      return { success: true, feeAmount: "0" };
    }

    const feeAmountStr = ethers.formatEther(feeWei);
    log(`[TradeFee] Fee collected: ${feeAmountStr} BNB → treasury (tx: ${tx.hash})`, "token-launcher");
    return { success: true, txHash: tx.hash, feeAmount: feeAmountStr };
  } catch (e: any) {
    log(`[TradeFee] Fee collection failed (non-blocking): ${e.message?.substring(0, 200)}`, "token-launcher");
    return { success: true, feeAmount: "0" };
  }
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

async function fourMemeFetchRaisedConfig(accessToken: string): Promise<any> {
  try {
    const res = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/raise`, {
      headers: {
        "Accept": "application/json",
        "meme-web-access": accessToken,
      },
    });
    const json = await res.json();
    log(`[TokenLauncher] four.meme raise config: ${JSON.stringify(json).substring(0, 800)}`, "token-launcher");
    if (json.code === 0 && json.data) {
      const configs = Array.isArray(json.data) ? json.data : [json.data];
      const bnbConfig = configs.find((c: any) => c.symbol === "BNB" && c.status === "PUBLISH" && c.platform === "MEME");
      if (bnbConfig) {
        log(`[TokenLauncher] Using dynamic BNB config: b0=${bnbConfig.b0Amount}, totalB=${bnbConfig.totalBAmount}, total=${bnbConfig.totalAmount}, saleRate=${bnbConfig.saleRate}`, "token-launcher");
        return bnbConfig;
      }
    }
  } catch (e: any) {
    log(`[TokenLauncher] Failed to fetch raise config: ${e.message?.substring(0, 100)}`, "token-launcher");
  }
  return null;
}

async function fourMemeCreateTokenData(
  params: LaunchParams,
  accessToken: string,
  preSaleEth: string,
): Promise<{ createArg: string; signature: string; value: bigint }> {
  const launchTime = Date.now();

  const dynamicConfig = await fourMemeFetchRaisedConfig(accessToken);

  const raisedToken: Record<string, any> = dynamicConfig ? {
    symbol: dynamicConfig.symbol || "BNB",
    nativeSymbol: dynamicConfig.nativeSymbol || "BNB",
    symbolAddress: dynamicConfig.symbolAddress || "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    deployCost: dynamicConfig.deployCost || "0",
    buyFee: dynamicConfig.buyFee || "0.01",
    sellFee: dynamicConfig.sellFee || "0.01",
    minTradeFee: dynamicConfig.minTradeFee || "0",
    b0Amount: dynamicConfig.b0Amount || "8",
    totalBAmount: dynamicConfig.totalBAmount || "18",
    totalAmount: dynamicConfig.totalAmount || "1000000000",
    logoUrl: dynamicConfig.logoUrl || "https://static.four.meme/market/fc6c4c92-63a3-4034-bc27-355ea380a6795959172881106751506.png",
    status: dynamicConfig.status || "PUBLISH",
  } : {
    symbol: "BNB",
    nativeSymbol: "BNB",
    symbolAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    deployCost: "0",
    buyFee: "0.01",
    sellFee: "0.01",
    minTradeFee: "0",
    b0Amount: "8",
    totalBAmount: "18",
    totalAmount: "1000000000",
    logoUrl: "https://static.four.meme/market/fc6c4c92-63a3-4034-bc27-355ea380a6795959172881106751506.png",
    status: "PUBLISH",
  };

  const saleRate = dynamicConfig?.saleRate ? parseFloat(dynamicConfig.saleRate) : 0.8;
  const totalBAmount = parseFloat(raisedToken.totalBAmount);
  const b0Amount = parseFloat(raisedToken.b0Amount);
  const raisedAmount = totalBAmount + b0Amount;

  const requestBody: Record<string, any> = {
    name: params.tokenName,
    shortName: params.tokenSymbol,
    desc: params.tokenDescription || "",
    totalSupply: 1000000000,
    raisedAmount,
    saleRate,
    reserveRate: 0,
    imgUrl: params.imageUrl || "https://static.four.meme/market/68b871b6-96f7-408c-b8d0-388d804b34275092658264263839640.png",
    raisedToken,
    launchTime,
    funGroup: false,
    preSale: preSaleEth,
    clickFun: false,
    symbol: "BNB",
    label: "Meme",
  };

  if (params.webUrl) requestBody.webUrl = params.webUrl;
  if (params.twitterUrl) requestBody.twitterUrl = params.twitterUrl;
  if (params.telegramUrl) requestBody.telegramUrl = params.telegramUrl;

  log(`[TokenLauncher] four.meme create body: ${JSON.stringify(requestBody).substring(0, 500)}`, "token-launcher");

  const createRes = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "meme-web-access": accessToken,
    },
    body: JSON.stringify(requestBody),
  });

  const createJson = await createRes.json();
  log(`[TokenLauncher] four.meme create API response: ${JSON.stringify(createJson).substring(0, 1000)}`, "token-launcher");
  if ((createJson.code !== 0 && createJson.msg !== "success") || !createJson.data?.createArg || !createJson.data?.signature) {
    throw new Error(`four.meme create API failed: ${createJson.msg || JSON.stringify(createJson).substring(0, 300)}`);
  }

  const preSaleWei = ethers.parseEther(preSaleEth);
  const txValue = createJson.data.value ? BigInt(createJson.data.value) : preSaleWei;

  return {
    createArg: createJson.data.createArg,
    signature: createJson.data.signature,
    value: txValue,
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
    initialLiquidityBnb: params.initialLiquidityBnb || "0",
    status: "pending",
    tokenAddress: null,
    txHash: null,
    launchUrl: null,
    errorMessage: null,
    metadata: null,
  });

  try {
    const preSaleEth = params.initialLiquidityBnb || "0";
    const preSaleWei = ethers.parseEther(preSaleEth);
    const totalLaunchCost = preSaleWei + ethers.parseEther("0.005");

    const balance = await provider.getBalance(wallet.address);
    const balFormatted = ethers.formatEther(balance);
    log(`[TokenLauncher] Deployer balance: ${balFormatted} BNB`, "token-launcher");

    if (balance < totalLaunchCost + TOKEN_LAUNCH_FEE) {
      const needed = ethers.formatEther(totalLaunchCost + TOKEN_LAUNCH_FEE);
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: `Insufficient BNB balance: ${balFormatted} BNB (need ${needed} BNB including ${ethers.formatEther(TOKEN_LAUNCH_FEE)} BNB launch fee)`,
      });
      return { success: false, error: `Insufficient BNB — your wallet has ${balFormatted} BNB but needs at least ${needed} BNB (includes ${ethers.formatEther(TOKEN_LAUNCH_FEE)} BNB launch fee). Fund your wallet and try again.`, launchId: launchRecord.id };
    }

    const feeResult = await collectLaunchFee(wallet, provider);
    if (!feeResult.success) {
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: feeResult.error || "Launch fee collection failed",
      });
      return { success: false, error: feeResult.error || "Launch fee collection failed", launchId: launchRecord.id };
    }
    if (feeResult.txHash) {
      log(`[TokenLauncher] Launch fee paid: ${feeResult.txHash}`, "token-launcher");
    }

    const agentRegStatus = await isAgentRegistered(wallet.address);
    if (agentRegStatus) {
      log(`[TokenLauncher] Step 0 OK: Agent wallet already registered on ERC-8004 (AI badge enabled)`, "token-launcher");
    } else {
      log(`[TokenLauncher] Step 0: ERC-8004 BSC registration — skipping (contract not yet functional on BSC mainnet). AI badge will be available once ERC-8004 BSC deployment is active.`, "token-launcher");
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

    try {
      const searchRes = await fetch(`${FOUR_MEME_API}/meme-api/v1/public/token/search?keyword=${encodeURIComponent(params.tokenName)}&pageNo=1&pageSize=5`);
      const searchJson = await searchRes.json() as any;
      const existing = searchJson?.data?.records?.find((t: any) =>
        t.name?.toLowerCase() === params.tokenName.toLowerCase() ||
        t.shortName?.toLowerCase() === params.tokenSymbol.toLowerCase()
      );
      if (existing) {
        const existingAddr = existing.contractAddress || existing.address || "";
        log(`[TokenLauncher] Token name/symbol already exists on four.meme: ${existing.name} (${existingAddr})`, "token-launcher");
        await storage.updateTokenLaunch(launchRecord.id, {
          status: "failed",
          errorMessage: `Token "${existing.name}" already exists on four.meme`,
        });
        return {
          success: false,
          error: `A token named "${existing.name}" ($${existing.shortName || params.tokenSymbol}) already exists on four.meme. Choose a different, unique name.`,
          launchId: launchRecord.id,
        };
      }
    } catch (searchErr: any) {
      log(`[TokenLauncher] Token search check skipped: ${searchErr.message?.substring(0, 60)}`, "token-launcher");
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
        gasLimit: 2000000,
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
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("TX timeout (180s)")), 180000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      const revertMsg = `Transaction reverted — the token name or symbol may already be taken on four.meme. Try a different, unique name. TX: ${tx.hash.substring(0, 14)}...`;
      log(`[TokenLauncher] four.meme launch reverted on-chain. TX: ${tx.hash}`, "token-launcher");
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        txHash: tx.hash,
        errorMessage: revertMsg,
      });
      return { success: false, error: revertMsg, txHash: tx.hash, launchId: launchRecord.id };
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
    initialLiquidityBnb: params.initialLiquidityBnb || "0.001",
    status: "pending",
    tokenAddress: null,
    txHash: null,
    launchUrl: null,
    errorMessage: null,
    metadata: null,
  });

  try {
    const initialBuy = ethers.parseEther(params.initialLiquidityBnb || "0.001");

    const balance = await provider.getBalance(wallet.address);
    const balFormatted = ethers.formatEther(balance);
    log(`[TokenLauncher] Deployer balance: ${balFormatted} BNB`, "token-launcher");

    if (balance < initialBuy + ethers.parseEther("0.005") + TOKEN_LAUNCH_FEE) {
      const needed = ethers.formatEther(initialBuy + ethers.parseEther("0.005") + TOKEN_LAUNCH_FEE);
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: `Insufficient BNB: ${balFormatted} BNB (need ${needed} BNB including ${ethers.formatEther(TOKEN_LAUNCH_FEE)} BNB launch fee)`,
      });
      return { success: false, error: `Insufficient BNB — your wallet has ${balFormatted} BNB but needs at least ${needed} BNB (includes ${ethers.formatEther(TOKEN_LAUNCH_FEE)} BNB launch fee). Fund your wallet and try again.`, launchId: launchRecord.id };
    }

    const feeResult = await collectLaunchFee(wallet, provider);
    if (!feeResult.success) {
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: feeResult.error || "Launch fee collection failed",
      });
      return { success: false, error: feeResult.error || "Launch fee collection failed", launchId: launchRecord.id };
    }
    if (feeResult.txHash) {
      log(`[TokenLauncher] Launch fee paid: ${feeResult.txHash}`, "token-launcher");
    }

    log(`[TokenLauncher] Calling Flap Portal newTokenV2(${params.tokenName}, ${params.tokenSymbol}) with ${ethers.formatEther(initialBuy)} BNB...`, "token-launcher");
    const portal = new ethers.Contract(FLAP_PORTAL, FLAP_PORTAL_ABI, wallet);

    const meta = params.tokenDescription || "";

    const useTax = (params.taxRate ?? 0) > 0;
    const taxImpl = useTax ? FLAP_TAX_IMPL : FLAP_NO_TAX_IMPL;
    const vanitySuffix = useTax ? "7777" : "8888";
    const taxBps = Math.round((params.taxRate ?? 0) * 100);

    log(`[TokenLauncher] Mining vanity salt for flap.sh token (suffix ${vanitySuffix}, tax ${taxBps}bps)...`, "token-launcher");
    const minedSalt = mineVanitySalt(FLAP_PORTAL, taxImpl, vanitySuffix);
    log(`[TokenLauncher] Vanity salt found: ${minedSalt.salt.substring(0, 18)}... -> ${minedSalt.address}`, "token-launcher");

    const tokenParams = {
      name: params.tokenName,
      symbol: params.tokenSymbol,
      meta,
      dexThresh: 1,
      salt: minedSalt.salt,
      taxRate: taxBps,
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
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("TX timeout (180s)")), 180000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      const revertMsg = `Flap.sh transaction reverted on-chain — try a different token name/symbol. TX: ${tx.hash.substring(0, 14)}...`;
      log(`[TokenLauncher] flap.sh launch reverted on-chain. TX: ${tx.hash}`, "token-launcher");
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        txHash: tx.hash,
        errorMessage: revertMsg,
      });
      return { success: false, error: revertMsg, txHash: tx.hash, launchId: launchRecord.id };
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

const XLAYER_RPC = "https://rpc.xlayer.tech";
const XLAYER_CHAIN_ID = 196;
const XLAYER_EXPLORER = "https://www.oklink.com/xlayer";

let compiledErc20Cache: { abi: any[]; bytecode: string } | null = null;

async function compileSimpleERC20(): Promise<{ abi: any[]; bytecode: string }> {
  if (compiledErc20Cache) return compiledErc20Cache;

  const solc = require("solc");

  const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract SimpleToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, address _recipient) {
        name = _name;
        symbol = _symbol;
        uint256 supply = 1000000000 * 10**18;
        totalSupply = supply;
        balanceOf[_recipient] = supply;
        emit Transfer(address(0), _recipient, supply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(to != address(0), "zero address");
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(to != address(0), "zero address");
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}`;

  const input = JSON.stringify({
    language: "Solidity",
    sources: { "SimpleToken.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  });

  const output = JSON.parse(solc.compile(input));
  if (output.errors?.some((e: any) => e.severity === "error")) {
    throw new Error("Solidity compilation failed: " + output.errors.map((e: any) => e.message).join("; "));
  }

  const contract = output.contracts["SimpleToken.sol"]["SimpleToken"];
  compiledErc20Cache = {
    abi: contract.abi,
    bytecode: "0x" + contract.evm.bytecode.object,
  };
  return compiledErc20Cache;
}

function getXLayerProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(XLAYER_RPC);
}

async function launchOnXLayer(params: LaunchParams): Promise<LaunchResult> {
  const provider = getXLayerProvider();
  let wallet: ethers.Wallet | null = null;
  if (params.userPrivateKey) {
    wallet = new ethers.Wallet(params.userPrivateKey, provider);
    log(`[TokenLauncher] Using user wallet ${wallet.address.substring(0, 10)}... for XLayer launch`, "token-launcher");
  } else {
    const pk = process.env.BOUNTY_WALLET_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
    if (pk) wallet = new ethers.Wallet(pk, provider);
  }
  if (!wallet) {
    return { success: false, error: "No wallet available — generate or import a wallet first" };
  }

  const launchRecord = await storage.createTokenLaunch({
    agentId: params.agentId || null,
    creatorWallet: params.creatorWallet || wallet.address,
    platform: "xlayer",
    chainId: XLAYER_CHAIN_ID,
    tokenName: params.tokenName,
    tokenSymbol: params.tokenSymbol,
    tokenDescription: params.tokenDescription,
    imageUrl: params.imageUrl || null,
    initialLiquidityBnb: "0",
    status: "pending",
    tokenAddress: null,
    txHash: null,
    launchUrl: null,
    errorMessage: null,
    metadata: null,
  });

  try {
    const balance = await provider.getBalance(wallet.address);
    const balFormatted = ethers.formatEther(balance);
    log(`[TokenLauncher] XLayer wallet balance: ${balFormatted} OKB`, "token-launcher");

    const minBalance = ethers.parseEther("0.005");
    if (balance < minBalance) {
      const needed = ethers.formatEther(minBalance);
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: `Insufficient OKB: ${balFormatted} OKB (need at least ${needed} OKB for gas)`,
      });
      return { success: false, error: `Insufficient OKB — your wallet has ${balFormatted} OKB but needs at least ${needed} OKB for gas. Fund your wallet with OKB on XLayer and try again.`, launchId: launchRecord.id };
    }

    log(`[TokenLauncher] Compiling & deploying ERC-20 token ${params.tokenName} ($${params.tokenSymbol}) on XLayer...`, "token-launcher");

    const { abi, bytecode } = await compileSimpleERC20();
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);

    let deployTx;
    try {
      deployTx = await factory.deploy(params.tokenName, params.tokenSymbol, wallet.address, {
        gasLimit: 2000000,
      });
    } catch (txError: any) {
      const rawMsg = txError.message || String(txError);
      log(`[TokenLauncher] XLayer deploy TX error: ${rawMsg.substring(0, 500)}`, "token-launcher");
      const userError = sanitizeError(rawMsg);
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: rawMsg.substring(0, 500),
      });
      return { success: false, error: userError, launchId: launchRecord.id };
    }

    const deployedContract = deployTx as ethers.BaseContract;
    const txResponse = deployedContract.deploymentTransaction();
    if (txResponse) {
      log(`[TokenLauncher] XLayer deploy TX sent: ${txResponse.hash}`, "token-launcher");
      await storage.updateTokenLaunch(launchRecord.id, {
        txHash: txResponse.hash,
        status: "confirming",
      });
    }

    await deployedContract.waitForDeployment();
    const tokenAddress = await deployedContract.getAddress();

    const txHash = txResponse?.hash || "";
    const launchUrl = `${XLAYER_EXPLORER}/address/${tokenAddress}`;

    await storage.updateTokenLaunch(launchRecord.id, {
      status: "launched",
      tokenAddress,
      txHash: txHash || null,
      launchUrl,
    });

    log(`[TokenLauncher] XLayer launch success! Token: ${tokenAddress}, TX: ${txHash}`, "token-launcher");

    return {
      success: true,
      tokenAddress,
      txHash,
      launchUrl,
      launchId: launchRecord.id,
    };
  } catch (e: any) {
    log(`[TokenLauncher] XLayer launch failed: ${e.message}`, "token-launcher");
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

  const info = await helper.getTokenInfo(tokenAddress);
  if (info.liquidityAdded) {
    try {
      const router = new ethers.Contract(PANCAKE_V2_ROUTER, PANCAKE_ROUTER_ABI, provider);
      const amounts = await router.getAmountsOut(amountWei, [tokenAddress, WBNB_ADDRESS]);
      return {
        tokenManager: PANCAKE_V2_ROUTER,
        quote: WBNB_ADDRESS,
        fundsReceived: ethers.formatEther(amounts[1]),
        fee: "0",
      };
    } catch {
      return {
        tokenManager: PANCAKE_V2_ROUTER,
        quote: WBNB_ADDRESS,
        fundsReceived: "0",
        fee: "0",
      };
    }
  }

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
  priorityGas: boolean = false,
): Promise<FourMemeTradeResult> {
  try {
    const provider = getBscProvider();
    const wallet = new ethers.Wallet(userPrivateKey, provider);

    log(`[FourMeme] ${priorityGas ? "⚡ SNIPER " : ""}Estimating buy for ${bnbAmount} BNB on token ${tokenAddress.substring(0, 10)}...`, "token-launcher");

    const helper = new ethers.Contract(FOUR_MEME_HELPER3, FOUR_MEME_HELPER3_ABI, provider);
    const fundsWei = ethers.parseEther(bnbAmount);

    const [estimate, info, feeData] = await Promise.all([
      helper.tryBuy(tokenAddress, 0, fundsWei),
      helper.getTokenInfo(tokenAddress),
      priorityGas ? provider.getFeeData() : Promise.resolve(null),
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

    const txOverrides: any = {
      value: estimate.amountMsgValue,
      gasLimit: 500000,
    };

    if (priorityGas && feeData?.gasPrice) {
      txOverrides.gasPrice = (feeData.gasPrice * 130n) / 100n;
      log(`[FourMeme] ⚡ Priority gas: ${ethers.formatUnits(txOverrides.gasPrice, "gwei")} gwei (+30%)`, "token-launcher");
    }

    let tx;
    if (version === 1) {
      const tm = new ethers.Contract(tokenManager, FOUR_MEME_V1_ABI, wallet);
      tx = await tm.purchaseTokenAMAP(tokenAddress, fundsWei, minAmount, txOverrides);
    } else {
      const tm = new ethers.Contract(tokenManager, FOUR_MEME_ABI, wallet);
      tx = await tm.buyTokenAMAP(tokenAddress, fundsWei, minAmount, txOverrides);
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

    const info = await Promise.race([
      helper.getTokenInfo(tokenAddress),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("getTokenInfo timeout (15s)")), 15000)),
    ]);
    const version = Number(info.version);
    const tokenManager = info.tokenManager;
    const liquidityAdded = info.liquidityAdded;

    if (liquidityAdded) {
      log(`[FourMeme] Token ${tokenAddress.substring(0, 10)} has graduated to DEX — routing sell via PancakeSwap`, "token-launcher");
      return await sellViaPancakeSwap(tokenAddress, tokenAmount, amountWei, wallet);
    }

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

async function sellViaPancakeSwap(
  tokenAddress: string,
  tokenAmount: string,
  amountWei: bigint,
  wallet: ethers.Wallet,
): Promise<FourMemeTradeResult> {
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    log(`[PancakeSwap] Approving ${tokenAmount} tokens for PancakeSwap Router...`, "token-launcher");
    const approveTx = await token.approve(PANCAKE_V2_ROUTER, amountWei, { gasLimit: 100000 });
    await approveTx.wait();
    log(`[PancakeSwap] Approval confirmed`, "token-launcher");

    const router = new ethers.Contract(PANCAKE_V2_ROUTER, PANCAKE_ROUTER_ABI, wallet);
    const path = [tokenAddress, WBNB_ADDRESS];
    const deadline = Math.floor(Date.now() / 1000) + 300;

    let amountOutMin = BigInt(0);
    try {
      const amounts = await router.getAmountsOut(amountWei, path);
      amountOutMin = (amounts[1] * BigInt(85)) / BigInt(100);
      log(`[PancakeSwap] Estimated output: ${ethers.formatEther(amounts[1])} BNB (min: ${ethers.formatEther(amountOutMin)})`, "token-launcher");
    } catch {
      log(`[PancakeSwap] Could not estimate output — using 0 min (max slippage)`, "token-launcher");
    }

    log(`[PancakeSwap] Selling ${tokenAmount} tokens via swapExactTokensForETH...`, "token-launcher");
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      amountWei,
      amountOutMin,
      path,
      wallet.address,
      deadline,
      { gasLimit: 500000 }
    );

    log(`[PancakeSwap] Sell TX sent: ${tx.hash}`, "token-launcher");

    const receipt = await Promise.race([
      tx.wait(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("TX timeout (90s)")), 90000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      return { success: false, error: "PancakeSwap sell transaction reverted on-chain" };
    }

    log(`[PancakeSwap] Sell confirmed: ${receipt.hash}`, "token-launcher");
    return { success: true, txHash: receipt.hash };
  } catch (e: any) {
    log(`[PancakeSwap] Sell failed: ${e.message?.substring(0, 300)}`, "token-launcher");
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

const BANKR_API_BASE = "https://api.bankr.bot";

async function bankrPrompt(prompt: string): Promise<{ jobId: string; threadId: string } | { error: string }> {
  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) return { error: "BANKR_API_KEY not configured" };

  const res = await fetch(`${BANKR_API_BASE}/agent/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ prompt }),
  });

  if (res.status === 401) return { error: "Bankr API key is invalid or expired" };
  if (res.status === 403) return { error: "Bankr API key does not have Agent API access enabled. Enable it at bankr.bot/api" };
  if (res.status === 429) return { error: "Bankr daily API limit reached. Try again later or upgrade to Bankr Club." };

  const json = await res.json() as any;
  if (!json.success || !json.jobId) {
    return { error: json.message || json.error || `Bankr API returned status ${res.status}` };
  }
  return { jobId: json.jobId, threadId: json.threadId };
}

async function bankrPollJob(jobId: string, timeoutMs = 120000): Promise<{ status: string; response?: string; error?: string }> {
  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) return { status: "failed", error: "BANKR_API_KEY not configured" };

  const start = Date.now();
  const pollInterval = 3000;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BANKR_API_BASE}/agent/job/${jobId}`, {
        headers: { "X-API-Key": apiKey },
      });

      if (!res.ok && res.status !== 200) {
        log(`[Bankr] Poll HTTP ${res.status} for job ${jobId}`, "token-launcher");
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      let json: any;
      try {
        json = await res.json();
      } catch {
        log(`[Bankr] Poll non-JSON response for job ${jobId}`, "token-launcher");
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      if (json.status === "completed") {
        return { status: "completed", response: json.response || "" };
      }
      if (json.status === "failed") {
        return { status: "failed", error: json.response || json.error || "Bankr job failed" };
      }
      if (json.status === "cancelled") {
        return { status: "cancelled", error: "Bankr job was cancelled" };
      }
    } catch (e: any) {
      log(`[Bankr] Poll error: ${e.message?.substring(0, 100)}`, "token-launcher");
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  return { status: "timeout", error: "Bankr job timed out after 120 seconds" };
}

async function launchOnBankr(params: LaunchParams): Promise<LaunchResult> {
  if (!params.tokenName || !params.tokenSymbol) {
    return { success: false, error: "Token name and symbol are required" };
  }
  if (!process.env.BANKR_API_KEY) {
    return { success: false, error: "BANKR_API_KEY not configured — set it in environment secrets" };
  }

  const chain = params.bankrChain || "base";
  const chainLabel = chain === "solana" ? "Solana" : "Base";

  const launchRecord = await storage.createTokenLaunch({
    agentId: params.agentId || null,
    creatorWallet: params.creatorWallet || "bankr-custodial",
    platform: "bankr",
    chainId: chain === "solana" ? 0 : 8453,
    tokenName: params.tokenName,
    tokenSymbol: params.tokenSymbol,
    tokenDescription: params.tokenDescription,
    imageUrl: params.imageUrl || null,
    initialLiquidityBnb: "0",
    status: "pending",
    tokenAddress: null,
    txHash: null,
    launchUrl: null,
    errorMessage: null,
    metadata: JSON.stringify({ bankrChain: chain }),
  });

  try {
    let prompt = `deploy a token called ${params.tokenName} with symbol ${params.tokenSymbol} on ${chain}`;
    if (params.tokenDescription) {
      prompt += `. Description: ${params.tokenDescription}`;
    }

    log(`[Bankr] Submitting prompt: "${prompt}"`, "token-launcher");

    const promptResult = await bankrPrompt(prompt);
    if ("error" in promptResult) {
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: promptResult.error,
      });
      return { success: false, error: promptResult.error, launchId: launchRecord.id };
    }

    log(`[Bankr] Job created: ${promptResult.jobId} (thread: ${promptResult.threadId})`, "token-launcher");

    await storage.updateTokenLaunch(launchRecord.id, {
      status: "confirming",
      metadata: JSON.stringify({ bankrChain: chain, jobId: promptResult.jobId, threadId: promptResult.threadId }),
    });

    const jobResult = await bankrPollJob(promptResult.jobId);

    if (jobResult.status !== "completed") {
      const errMsg = jobResult.error || `Bankr job ${jobResult.status}`;
      log(`[Bankr] Job failed: ${errMsg}`, "token-launcher");
      await storage.updateTokenLaunch(launchRecord.id, {
        status: "failed",
        errorMessage: errMsg.substring(0, 500),
      });
      return { success: false, error: errMsg, launchId: launchRecord.id };
    }

    const response = jobResult.response || "";
    log(`[Bankr] Job completed. Response: ${response.substring(0, 500)}`, "token-launcher");

    let tokenAddress: string | undefined;
    if (chain === "solana") {
      const solAddrMatch = response.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      if (solAddrMatch) tokenAddress = solAddrMatch[0];
    } else {
      const evmAddrMatch = response.match(/0x[a-fA-F0-9]{40}/);
      if (evmAddrMatch) tokenAddress = evmAddrMatch[0];
    }

    let launchUrl: string | undefined;
    const urlMatch = response.match(/https?:\/\/[^\s)]+/);
    if (urlMatch) launchUrl = urlMatch[0];

    if (!launchUrl && tokenAddress) {
      launchUrl = chain === "solana"
        ? `https://solscan.io/token/${tokenAddress}`
        : `https://basescan.org/token/${tokenAddress}`;
    }

    await storage.updateTokenLaunch(launchRecord.id, {
      status: "launched",
      tokenAddress: tokenAddress || null,
      launchUrl: launchUrl || null,
      metadata: JSON.stringify({
        bankrChain: chain,
        jobId: promptResult.jobId,
        threadId: promptResult.threadId,
        bankrResponse: response.substring(0, 1000),
      }),
    });

    log(`[Bankr] Launch success! Token: ${tokenAddress || "see response"}, Chain: ${chainLabel}`, "token-launcher");

    return {
      success: true,
      tokenAddress,
      launchUrl,
      launchId: launchRecord.id,
    };
  } catch (e: any) {
    log(`[Bankr] Launch failed: ${e.message}`, "token-launcher");
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
  } else if (params.platform === "bankr") {
    return launchOnBankr(params);
  } else if (params.platform === "xlayer") {
    return launchOnXLayer(params);
  }

  return { success: false, error: `Unknown platform: ${params.platform}` };
}

export async function getTokenLaunches(agentId?: string, limit = 50): Promise<TokenLaunch[]> {
  return storage.getTokenLaunches(agentId, limit);
}

export async function getTokenLaunch(id: string): Promise<TokenLaunch | undefined> {
  return storage.getTokenLaunch(id);
}

export { ensureAgentRegisteredBSC, isAgentRegistered, ERC8004_IDENTITY_REGISTRY_BSC };

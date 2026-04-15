import { ethers } from "ethers";
import crypto from "crypto";

const ALGORITHM = "aes-256-cbc";

function deriveKey(userId: string): Buffer {
  const master = process.env.WALLET_ENCRYPTION_KEY || process.env.MASTER_ENCRYPTION_KEY || "default-dev-key-change-me-32chars!";
  return crypto.createHash("sha256").update(master + userId).digest();
}

export function encryptPrivateKey(pk: string, userId: string): string {
  const key = deriveKey(userId);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(pk, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

export function decryptPrivateKey(encrypted: string, userId: string): string {
  const key = deriveKey(userId);
  const [ivHex, data] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function generateEVMWallet(): { address: string; privateKey: string } {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

export async function getBalance(address: string, chain: string): Promise<{ native: string; usdt: string }> {
  try {
    const rpcUrl = chain === "BSC"
      ? "https://bsc-dataseed1.binance.org"
      : chain === "ETH"
        ? "https://eth.llamarpc.com"
        : "https://bsc-dataseed1.binance.org";

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const balance = await provider.getBalance(address);
    const nativeBalance = ethers.formatEther(balance);

    const usdtContracts: Record<string, string> = {
      BSC: "0x55d398326f99059fF775485246999027B3197955",
      ETH: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    };

    let usdtBalance = "0";
    const usdtAddr = usdtContracts[chain];
    if (usdtAddr) {
      const erc20 = new ethers.Contract(
        usdtAddr,
        ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"],
        provider
      );
      try {
        const [bal, dec] = await Promise.all([erc20.balanceOf(address), erc20.decimals()]);
        usdtBalance = ethers.formatUnits(bal, dec);
      } catch {}
    }

    return { native: nativeBalance, usdt: usdtBalance };
  } catch {
    return { native: "0", usdt: "0" };
  }
}

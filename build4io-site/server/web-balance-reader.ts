import * as ethers from "ethers";

const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const POLYGON_USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const BSC_RPCS = [
  process.env.BSC_RPC_URL,
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc-dataseed3.binance.org",
].filter((s): s is string => !!s && s.length > 0);

const POLYGON_RPCS = [
  process.env.POLYGON_RPC,
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
  "https://1rpc.io/matic",
].filter((s): s is string => !!s && s.length > 0);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

let bscProvider: ethers.FallbackProvider | null = null;
let polygonProvider: ethers.FallbackProvider | null = null;

function getBscProvider(): ethers.FallbackProvider {
  if (bscProvider) return bscProvider;
  const configs = BSC_RPCS.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, 56, { staticNetwork: ethers.Network.from(56) }),
    priority: i,
    stallTimeout: 2500,
    weight: 1,
  }));
  bscProvider = new ethers.FallbackProvider(configs, 56, { quorum: 1 });
  return bscProvider;
}

function getPolygonProvider(): ethers.FallbackProvider {
  if (polygonProvider) return polygonProvider;
  const configs = POLYGON_RPCS.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, 137, { staticNetwork: ethers.Network.from(137) }),
    priority: i,
    stallTimeout: 2500,
    weight: 1,
  }));
  polygonProvider = new ethers.FallbackProvider(configs, 137, { quorum: 1 });
  return polygonProvider;
}

export type BalanceResult = {
  ok: boolean;
  amount: number;
  raw: string;
  error?: string;
};

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; result: BalanceResult }>();

async function readErc20(
  provider: ethers.FallbackProvider,
  token: string,
  decimals: number,
  owner: string,
): Promise<BalanceResult> {
  const key = `${token}:${owner.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  try {
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    const raw: bigint = await c.balanceOf(owner);
    const amount = Number(ethers.formatUnits(raw, decimals));
    const result: BalanceResult = { ok: true, amount, raw: raw.toString() };
    cache.set(key, { at: Date.now(), result });
    return result;
  } catch (e: any) {
    const result: BalanceResult = {
      ok: false,
      amount: 0,
      raw: "0",
      error: e?.shortMessage || e?.message || "RPC failed",
    };
    return result;
  }
}

export async function readBscUsdtBalance(address: string): Promise<BalanceResult> {
  if (!address || !ethers.isAddress(address)) {
    return { ok: false, amount: 0, raw: "0", error: "Invalid address" };
  }
  return readErc20(getBscProvider(), BSC_USDT, 18, address);
}

export async function readPolygonUsdceBalance(safeAddress: string): Promise<BalanceResult> {
  if (!safeAddress || !ethers.isAddress(safeAddress)) {
    return { ok: false, amount: 0, raw: "0", error: "Invalid address" };
  }
  return readErc20(getPolygonProvider(), POLYGON_USDCE, 6, safeAddress);
}

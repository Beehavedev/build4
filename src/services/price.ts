import axios from "axios";

const cache = new Map<string, { price: number; ts: number }>();
const CACHE_TTL = 60_000;

export async function getPrice(symbol: string): Promise<number> {
  const key = symbol.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.price;

  try {
    const ids: Record<string, string> = {
      btc: "bitcoin",
      eth: "ethereum",
      bnb: "binancecoin",
      sol: "solana",
      usdt: "tether",
    };

    const cgId = ids[key] || key;
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`,
      { timeout: 10000 }
    );

    const price = data[cgId]?.usd;
    if (price) {
      cache.set(key, { price, ts: Date.now() });
      return price;
    }
  } catch (err: any) {
    console.error(`[PRICE] Error fetching ${symbol}:`, err.message);
  }

  const fallbacks: Record<string, number> = {
    btc: 65000,
    eth: 3200,
    bnb: 600,
    sol: 150,
    usdt: 1,
  };
  return fallbacks[key] || 0;
}

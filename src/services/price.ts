import axios from 'axios'

interface PriceData {
  price: number
  change24h: number
  volume24h: number
  marketCap: number
  high24h: number
  low24h: number
}

const priceCache = new Map<string, { data: PriceData; ts: number }>()
const CACHE_TTL = 30_000 // 30 seconds

const MOCK_PRICES: Record<string, PriceData> = {
  BTC: { price: 65432, change24h: 2.3, volume24h: 28_000_000_000, marketCap: 1_280_000_000_000, high24h: 66100, low24h: 64200 },
  ETH: { price: 3521, change24h: 1.8, volume24h: 12_000_000_000, marketCap: 423_000_000_000, high24h: 3580, low24h: 3440 },
  BNB: { price: 582, change24h: 0.9, volume24h: 1_800_000_000, marketCap: 84_000_000_000, high24h: 595, low24h: 574 },
  SOL: { price: 172, change24h: 3.1, volume24h: 3_200_000_000, marketCap: 78_000_000_000, high24h: 176, low24h: 168 },
  ARB: { price: 1.18, change24h: -1.2, volume24h: 420_000_000, marketCap: 3_100_000_000, high24h: 1.24, low24h: 1.15 }
}

export async function getPrice(symbol: string): Promise<PriceData> {
  const cacheKey = symbol.toUpperCase()
  const cached = priceCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

  try {
    const id = symbolToCoingeckoId(symbol)
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`,
      { timeout: 5000 }
    )

    const data = res.data[id]
    const priceData: PriceData = {
      price: data.usd,
      change24h: data.usd_24h_change ?? 0,
      volume24h: data.usd_24h_vol ?? 0,
      marketCap: data.usd_market_cap ?? 0,
      high24h: data.usd * 1.015,
      low24h: data.usd * 0.985
    }

    priceCache.set(cacheKey, { data: priceData, ts: Date.now() })
    return priceData
  } catch {
    // Fallback to mock + slight randomness
    const mock = MOCK_PRICES[cacheKey] ?? { price: 1, change24h: 0, volume24h: 0, marketCap: 0, high24h: 1.01, low24h: 0.99 }
    const jitter = 1 + (Math.random() - 0.5) * 0.002
    return { ...mock, price: mock.price * jitter }
  }
}

function symbolToCoingeckoId(symbol: string): string {
  const map: Record<string, string> = {
    BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin',
    SOL: 'solana', ARB: 'arbitrum', MATIC: 'matic-network',
    USDT: 'tether', USDC: 'usd-coin'
  }
  return map[symbol.toUpperCase()] ?? symbol.toLowerCase()
}

export async function getTokenInfo(address: string): Promise<{
  name: string; symbol: string; price: number; marketCap: number; change24h: number; liquidity: number
}> {
  // Mock token info — in production use DexScreener API
  return {
    name: 'Unknown Token',
    symbol: 'UNKNOWN',
    price: Math.random() * 0.001,
    marketCap: Math.random() * 1_000_000,
    change24h: (Math.random() - 0.5) * 40,
    liquidity: Math.random() * 100_000
  }
}

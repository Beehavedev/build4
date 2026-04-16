export interface Signal {
  id: string
  type: 'WHALE_MOVE' | 'ACCUMULATION' | 'UNUSUAL_OI' | 'SMART_MONEY'
  token: string
  pair: string
  description: string
  amount: number
  amountUsd: number
  walletAccuracy: number
  signalStrength: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'
  priceChange1h: number
  volumeMultiplier: number
  timestamp: Date
  contractAddress: string
}

const MOCK_TOKENS = [
  { symbol: 'BTC', name: 'Bitcoin', contract: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c' },
  { symbol: 'ETH', name: 'Ethereum', contract: '0x2170ed0880ac9a755fd29b2688956bd959f933f8' },
  { symbol: 'PEPE', name: 'Pepe', contract: '0x25d887ce7a35172c62febfd67a1856f20faebb00' },
  { symbol: 'ARB', name: 'Arbitrum', contract: '0xa050ffb3eeb8200eeb7f61e7a9c76c7a3a0f74de' },
  { symbol: 'WIF', name: 'Dogwifhat', contract: '0xb1547683DA678f2e1c8b78A4f6Bde5df9b6A9A0' }
]

export async function getLatestSignals(limit: number = 5): Promise<Signal[]> {
  // In production: aggregate from on-chain data, Hyperliquid OI, social APIs
  // Mock realistic signals for demo
  const signals: Signal[] = []

  for (let i = 0; i < limit; i++) {
    const token = MOCK_TOKENS[i % MOCK_TOKENS.length]
    const types: Signal['type'][] = ['WHALE_MOVE', 'ACCUMULATION', 'UNUSUAL_OI', 'SMART_MONEY']
    const type = types[Math.floor(Math.random() * types.length)]
    const amount = Math.round(Math.random() * 5000 + 500)
    const price = token.symbol === 'BTC' ? 65000 : token.symbol === 'ETH' ? 3500 : Math.random() * 10

    signals.push({
      id: `sig_${Date.now()}_${i}`,
      type,
      token: token.symbol,
      pair: `${token.symbol}/USDT`,
      description: generateSignalDescription(type, token.symbol, amount),
      amount,
      amountUsd: amount * price,
      walletAccuracy: Math.round(50 + Math.random() * 45),
      signalStrength: amount > 3000 ? 'EXTREME' : amount > 2000 ? 'HIGH' : amount > 1000 ? 'MEDIUM' : 'LOW',
      priceChange1h: (Math.random() - 0.4) * 8,
      volumeMultiplier: 1 + Math.random() * 4,
      timestamp: new Date(Date.now() - Math.random() * 3600000),
      contractAddress: token.contract
    })
  }

  return signals.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
}

function generateSignalDescription(type: Signal['type'], token: string, amount: number): string {
  switch (type) {
    case 'WHALE_MOVE':
      return `A tracked wallet moved ${amount.toLocaleString()} ${token} to a major exchange. This wallet has made 7 profitable calls in the past 30 days.`
    case 'ACCUMULATION':
      return `5 smart money wallets accumulated ${token} over the last 2 hours. Combined position: $${(amount * 1000).toLocaleString()}.`
    case 'UNUSUAL_OI':
      return `Open interest on ${token} perpetuals spiked ${Math.round(amount / 100)}% in the last hour. Unusual positioning detected.`
    case 'SMART_MONEY':
      return `A DeFi whale with 82% win rate opened a large ${token} position. They have $${(amount * 500).toLocaleString()} in tracked profits.`
  }
}

export function formatSignalMessage(signal: Signal): string {
  const strengthEmoji = {
    LOW: '🟡',
    MEDIUM: '🟠',
    HIGH: '🔴',
    EXTREME: '💥'
  }[signal.signalStrength]

  const typeLabel = {
    WHALE_MOVE: '🐋 WHALE MOVE',
    ACCUMULATION: '📦 ACCUMULATION',
    UNUSUAL_OI: '📊 UNUSUAL OI',
    SMART_MONEY: '🧠 SMART MONEY'
  }[signal.type]

  return `${strengthEmoji} *${typeLabel} — ${signal.token}*

${signal.description}

📈 Price (1h): ${signal.priceChange1h >= 0 ? '+' : ''}${signal.priceChange1h.toFixed(2)}%
📊 Volume: ${signal.volumeMultiplier.toFixed(1)}x average
🎯 Wallet accuracy: ${signal.walletAccuracy}% (last 30d)
⚡ Signal strength: *${signal.signalStrength}*

_${signal.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} UTC_`
}

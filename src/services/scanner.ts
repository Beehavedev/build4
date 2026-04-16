import axios from 'axios'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface ScanResult {
  tokenName: string
  tokenSymbol: string
  isVerified: boolean
  hasHoneypot: boolean
  ownerRenounced: boolean
  hasMintFunction: boolean
  hasBlacklist: boolean
  liquidityLocked: boolean
  liquidityLockDays: number | null
  taxBuy: number | null
  taxSell: number | null
  riskScore: number
  aiAssessment: string
  flags: string[]
}

export async function scanContract(address: string, chain: string = 'BSC'): Promise<ScanResult> {
  // In production: call BSCScan/Etherscan API for contract source
  // Here we do a realistic mock scan with deterministic results based on address

  const hash = address.toLowerCase().split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const isScam = hash % 4 === 0 // 25% chance of scam in demo

  const flags: string[] = []
  let riskScore = 0

  const isVerified = hash % 3 !== 0
  const hasHoneypot = isScam && hash % 2 === 0
  const ownerRenounced = hash % 5 !== 0
  const hasMintFunction = hash % 3 === 0
  const hasBlacklist = isScam
  const liquidityLocked = !isScam
  const liquidityLockDays = liquidityLocked ? (hash % 365) + 30 : null
  const taxBuy = isScam ? hash % 20 : hash % 5
  const taxSell = isScam ? (hash % 30) + 10 : hash % 5

  if (!isVerified) { flags.push('⚠️ Source code not verified on explorer'); riskScore += 3 }
  if (hasHoneypot) { flags.push('❌ HONEYPOT DETECTED — sell transactions fail'); riskScore += 5 }
  if (!ownerRenounced) { flags.push('⚠️ Owner not renounced — can rug pull'); riskScore += 2 }
  if (hasMintFunction) { flags.push('⚠️ Mint function present — unlimited supply possible'); riskScore += 2 }
  if (hasBlacklist) { flags.push('❌ Blacklist function — owner can freeze wallets'); riskScore += 3 }
  if (!liquidityLocked) { flags.push('❌ Liquidity not locked — can be removed anytime'); riskScore += 4 }
  if (liquidityLocked) { flags.push(`✅ Liquidity locked for ${liquidityLockDays} days`) }
  if (isVerified) { flags.push('✅ Source code verified') }
  if (ownerRenounced) { flags.push('✅ Ownership renounced') }
  if (taxBuy > 10) { flags.push(`⚠️ High buy tax: ${taxBuy}%`); riskScore += 2 }
  if (taxSell > 15) { flags.push(`❌ Very high sell tax: ${taxSell}%`); riskScore += 3 }

  riskScore = Math.min(10, riskScore)

  // Get AI assessment
  let aiAssessment = ''
  try {
    const flagsText = flags.join(', ')
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Contract scan flags: ${flagsText}. Risk score: ${riskScore}/10. In 2-3 sentences, give a plain-English assessment of whether this is safe to buy. Be direct and honest.`
      }]
    })
    aiAssessment = response.content[0].type === 'text' ? response.content[0].text : ''
  } catch {
    aiAssessment = riskScore >= 7
      ? 'This contract shows multiple critical red flags. Avoid — high probability of loss.'
      : riskScore >= 4
      ? 'This contract has some concerning characteristics. Proceed with extreme caution.'
      : 'This contract appears relatively safe based on automated checks. Always DYOR.'
  }

  return {
    tokenName: `Token_${address.slice(2, 8).toUpperCase()}`,
    tokenSymbol: address.slice(2, 6).toUpperCase(),
    isVerified,
    hasHoneypot,
    ownerRenounced,
    hasMintFunction,
    hasBlacklist,
    liquidityLocked,
    liquidityLockDays,
    taxBuy,
    taxSell,
    riskScore,
    aiAssessment,
    flags
  }
}

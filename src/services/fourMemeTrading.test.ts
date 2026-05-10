import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import {
  applySlippageDown,
  resolveSlippageBps,
  isFourMemeEnabled,
  requireFourMemeEnabled,
  FOUR_MEME_V1_TOKEN_MANAGER,
  FOUR_MEME_V2_TOKEN_MANAGER,
  FOUR_MEME_HELPER_V3,
  FOUR_MEME_AGENT_IDENTIFIER,
} from './fourMemeTrading'

import TokenManagerV1Abi from '../abi/fourMeme/TokenManager.lite.abi.json'
import TokenManagerV2Abi from '../abi/fourMeme/TokenManager2.lite.abi.json'
import TokenManagerHelper3Abi from '../abi/fourMeme/TokenManagerHelper3.abi.json'
import AgentIdentifierAbi from '../abi/fourMeme/AgentIdentifier.abi.json'

// All tests in this file are pure (no network, no DB) so the suite
// stays fast and the existing 169-test baseline doesn't get flaky.

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const original = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try { fn() } finally {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
}

test('feature flag defaults OFF when env unset', () => {
  withEnv('FOUR_MEME_ENABLED', undefined, () => {
    assert.equal(isFourMemeEnabled(), false)
    assert.throws(() => requireFourMemeEnabled(), /disabled/)
  })
})

test('feature flag treats only the literal string "true" as enabled', () => {
  withEnv('FOUR_MEME_ENABLED', 'TRUE', () => assert.equal(isFourMemeEnabled(), false))
  withEnv('FOUR_MEME_ENABLED', '1',    () => assert.equal(isFourMemeEnabled(), false))
  withEnv('FOUR_MEME_ENABLED', 'true', () => {
    assert.equal(isFourMemeEnabled(), true)
    assert.doesNotThrow(() => requireFourMemeEnabled())
  })
})

test('requireFourMemeEnabled throws with structured FOUR_MEME_DISABLED code', () => {
  withEnv('FOUR_MEME_ENABLED', undefined, () => {
    try {
      requireFourMemeEnabled()
      assert.fail('should have thrown')
    } catch (e: any) {
      assert.equal(e.code, 'FOUR_MEME_DISABLED')
    }
  })
})

test('applySlippageDown applies slippage correctly for round numbers', () => {
  // 1000 wei * 95% = 950 wei (500 bps = 5%)
  assert.equal(applySlippageDown(1000n, 500), 950n)
  assert.equal(applySlippageDown(1000n, 0), 1000n)
  assert.equal(applySlippageDown(1000n, 100), 990n)   // 1%
  assert.equal(applySlippageDown(1000n, 2000), 800n)  // 20% (max)
})

test('applySlippageDown handles huge bigints without precision loss', () => {
  const oneEth = 10n ** 18n
  assert.equal(applySlippageDown(oneEth, 500), 950000000000000000n)
  const huge = 123456789012345678901234567890n
  assert.equal(applySlippageDown(huge, 100), (huge * 9900n) / 10000n)
})

test('applySlippageDown rejects out-of-range slippage', () => {
  assert.throws(() => applySlippageDown(100n, -1))
  assert.throws(() => applySlippageDown(100n, 2001))
  assert.throws(() => applySlippageDown(100n, 1.5 as any))
  assert.throws(() => resolveSlippageBps({ slippageBps: -1 }))
  assert.throws(() => resolveSlippageBps({ slippageBps: 9999 }))
})

test('resolveSlippageBps defaults to 500 bps when no opts passed', () => {
  assert.equal(resolveSlippageBps(), 500)
  assert.equal(resolveSlippageBps({}), 500)
  assert.equal(resolveSlippageBps({ slippageBps: 100 }), 100)
})

test('V1 TokenManager ABI exposes purchaseTokenAMAP + saleToken', () => {
  const iface = new ethers.Interface(TokenManagerV1Abi as any)
  assert.ok(iface.getFunction('purchaseTokenAMAP'))
  assert.ok(iface.getFunction('saleToken'))
})

test('V2 TokenManager2 ABI exposes buyTokenAMAP + both sellToken overloads (minFunds-enforced)', () => {
  const iface = new ethers.Interface(TokenManagerV2Abi as any)
  assert.ok(iface.getFunction('buyTokenAMAP'))
  // 2-arg overload (no slippage) — kept on the ABI for completeness,
  // but the service refuses to call it.
  assert.ok(iface.getFunction('sellToken(address,uint256)'))
  // 6-arg overload with minFunds — what sellTokenForBnb actually uses
  // for V2 to enforce slippage on-chain.
  assert.ok(iface.getFunction('sellToken(uint256,address,uint256,uint256,uint256,address)'))
})

test('Helper3 ABI exposes getTokenInfo + tryBuy + trySell', () => {
  const iface = new ethers.Interface(TokenManagerHelper3Abi as any)
  assert.ok(iface.getFunction('getTokenInfo'))
  assert.ok(iface.getFunction('tryBuy'))
  assert.ok(iface.getFunction('trySell'))
})

test('AgentIdentifier ABI exposes isAgent', () => {
  const iface = new ethers.Interface(AgentIdentifierAbi as any)
  assert.ok(iface.getFunction('isAgent'))
})

test('all official BSC addresses are well-formed checksummed', () => {
  assert.equal(ethers.isAddress(FOUR_MEME_V1_TOKEN_MANAGER), true)
  assert.equal(ethers.isAddress(FOUR_MEME_V2_TOKEN_MANAGER), true)
  assert.equal(ethers.isAddress(FOUR_MEME_HELPER_V3), true)
  assert.equal(ethers.isAddress(FOUR_MEME_AGENT_IDENTIFIER), true)
})

test('addresses match the protocol spec verbatim', () => {
  // Sourced from API-Documents.03-03-2026 (md5 e11052df49d89c463bad0adbb12a754d)
  assert.equal(FOUR_MEME_V1_TOKEN_MANAGER.toLowerCase(), '0xec4549cadce5da21df6e6422d448034b5233bfbc')
  assert.equal(FOUR_MEME_V2_TOKEN_MANAGER.toLowerCase(), '0x5c952063c7fc8610ffdb798152d69f0b9550762b')
  assert.equal(FOUR_MEME_HELPER_V3.toLowerCase(), '0xf251f83e40a78868fcfa3fa4599dad6494e46034')
  assert.equal(FOUR_MEME_AGENT_IDENTIFIER.toLowerCase(), '0x09b44a633de9f9ebf6fb9bdd5b5629d3dd2cef13')
})

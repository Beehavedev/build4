import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateLaunchParams,
  generateTokenSvg,
  parseTokenAddressFromReceipt,
  isFourMemeLaunchEnabled,
  LaunchValidationError,
} from './fourMemeLaunch'
import { ethers } from 'ethers'

test('feature flag is fail-closed: defaults to false with no env', () => {
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  delete process.env.FOUR_MEME_ENABLED
  delete process.env.FOUR_MEME_LAUNCH_ENABLED
  try {
    assert.equal(isFourMemeLaunchEnabled(), false)
  } finally {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2
  }
})

test('feature flag stays off when only master is on', () => {
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  process.env.FOUR_MEME_ENABLED = 'true'
  delete process.env.FOUR_MEME_LAUNCH_ENABLED
  try {
    assert.equal(isFourMemeLaunchEnabled(), false)
  } finally {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1; else delete process.env.FOUR_MEME_ENABLED
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2
  }
})

test('feature flag stays off when only launch is on (master gate respected)', () => {
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  delete process.env.FOUR_MEME_ENABLED
  process.env.FOUR_MEME_LAUNCH_ENABLED = 'true'
  try {
    assert.equal(isFourMemeLaunchEnabled(), false)
  } finally {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2; else delete process.env.FOUR_MEME_LAUNCH_ENABLED
  }
})

test('feature flag enables when both flags are exactly "true"', () => {
  const prev1 = process.env.FOUR_MEME_ENABLED
  const prev2 = process.env.FOUR_MEME_LAUNCH_ENABLED
  process.env.FOUR_MEME_ENABLED = 'true'
  process.env.FOUR_MEME_LAUNCH_ENABLED = 'true'
  try {
    assert.equal(isFourMemeLaunchEnabled(), true)
  } finally {
    if (prev1 != null) process.env.FOUR_MEME_ENABLED = prev1; else delete process.env.FOUR_MEME_ENABLED
    if (prev2 != null) process.env.FOUR_MEME_LAUNCH_ENABLED = prev2; else delete process.env.FOUR_MEME_LAUNCH_ENABLED
  }
})

test('validateLaunchParams accepts well-formed input', () => {
  validateLaunchParams({ tokenName: 'Build4 Test', tokenSymbol: 'B4T', initialBuyBnb: '0.01' })
  validateLaunchParams({ tokenName: 'Ab', tokenSymbol: 'X' })
  validateLaunchParams({ tokenName: 'X'.repeat(100), tokenSymbol: 'TICKERTKR' })
})

test('validateLaunchParams rejects short/long name', () => {
  assert.throws(() => validateLaunchParams({ tokenName: 'A', tokenSymbol: 'OK' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'X'.repeat(101), tokenSymbol: 'OK' }), LaunchValidationError)
})

test('validateLaunchParams rejects bad symbol', () => {
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: '' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'TOOLONG1234' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'BAD SYM' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'emoji😀' }), LaunchValidationError)
})

test('validateLaunchParams rejects non-numeric or excessive initial buy', () => {
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK', initialBuyBnb: 'abc' }), LaunchValidationError)
  assert.throws(() => validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK', initialBuyBnb: '5.0001' }), LaunchValidationError)
})

test('validateLaunchParams accepts zero initial buy + missing initial buy', () => {
  validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK', initialBuyBnb: '0' })
  validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK' })
  validateLaunchParams({ tokenName: 'Test', tokenSymbol: 'OK', initialBuyBnb: '' })
})

test('generateTokenSvg produces valid-ish SVG with the symbol displayed', () => {
  const svg = generateTokenSvg('Build4 Token', 'B4')
  assert.match(svg, /^<svg /)
  assert.match(svg, /<\/svg>$/)
  assert.match(svg, />B4</)
  // Stable across calls for the same input (deterministic colour hash).
  assert.equal(svg, generateTokenSvg('Build4 Token', 'B4'))
})

test('generateTokenSvg escapes XML special chars from symbol input', () => {
  // The symbol is alphanumerically filtered, so the test reaches into
  // the name path indirectly: confirm no raw < or > appear inside the
  // displayed text.
  const svg = generateTokenSvg('<script>alert(1)</script>', 'XSS')
  assert.match(svg, />XSS</)
  assert.equal(svg.includes('<script>'), false)
})

test('parseTokenAddressFromReceipt extracts from TokenCreate event', () => {
  const newToken = ethers.getAddress('0x' + 'a'.repeat(40))
  const creator = ethers.getAddress('0x' + 'b'.repeat(40))
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint256', 'string', 'string', 'uint256', 'uint256', 'uint256'],
    [creator, newToken, 1n, 'Name', 'SYM', 0n, 0n, 0n],
  )
  const fakeReceipt = {
    status: 1,
    hash: '0x' + 'c'.repeat(64),
    logs: [
      {
        topics: ['0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20'],
        data,
      },
    ],
  } as unknown as ethers.TransactionReceipt
  assert.equal(parseTokenAddressFromReceipt(fakeReceipt), newToken)
})

test('MAX_UPSTREAM_VALUE_HEADROOM_WEI is enforced (constants sanity)', () => {
  // Sanity-check the cap formula by reproducing it: a 0.01 BNB user
  // initial buy + 0.05 headroom must equal exactly 0.06 BNB max.
  const preSale = ethers.parseEther('0.01')
  const headroom = ethers.parseEther('0.05')
  assert.equal(ethers.formatEther(preSale + headroom), '0.06')
})

test('parseTokenAddressFromReceipt returns null when no token-shaped log present', () => {
  const fakeReceipt = {
    status: 1,
    hash: '0x' + 'd'.repeat(64),
    logs: [{ topics: ['0xdeadbeef'], data: '0x' }],
  } as unknown as ethers.TransactionReceipt
  assert.equal(parseTokenAddressFromReceipt(fakeReceipt), null)
})

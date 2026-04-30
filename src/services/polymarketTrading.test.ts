import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import { ERC20_ABI } from './polymarketTrading'

// Regression coverage for the "usdc.transfer is not a function" runtime
// failure that hit users on the Polymarket "Fund Polymarket" button. The
// root cause was that ERC20_ABI declared only balanceOf/allowance/approve
// — `transfer` was missing, so ethers.Contract(...).transfer at the
// EOA→Safe sweep call site (fundSafeFromEoa in polymarketTrading.ts) was
// undefined and threw at run-time on the first user click.
//
// These tests assert the four selectors fundSafeFromEoa + ensureUsdc-
// Allowance actually call are present, and that an ethers.Contract built
// from the ABI exposes them as callable methods (i.e. the same path the
// production code takes — not a structural-only check).

test('ERC20_ABI declares the four selectors required by the funding flow', () => {
  const required = ['balanceOf', 'allowance', 'approve', 'transfer'] as const
  for (const fn of required) {
    assert.ok(
      ERC20_ABI.some((sig) => sig.startsWith(`function ${fn}(`)),
      `ERC20_ABI is missing 'function ${fn}(...)' — production callers in ` +
        `polymarketTrading.ts will throw "${fn} is not a function" at run-time.`,
    )
  }
})

test('ethers.Contract built from ERC20_ABI exposes transfer (mirrors production call site)', () => {
  // Same construction shape as fundSafeFromEoa(): new ethers.Contract(addr, ERC20_ABI, runner).
  // We use a no-op provider since we only inspect the method surface, not the network.
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:0')
  const usdc = new ethers.Contract(
    '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    ERC20_ABI,
    provider,
  )
  assert.equal(typeof usdc.transfer, 'function', 'usdc.transfer must be a callable method')
  assert.equal(typeof usdc.approve, 'function')
  assert.equal(typeof usdc.balanceOf, 'function')
  assert.equal(typeof usdc.allowance, 'function')
})

test('transfer signature uses the canonical ERC-20 selector transfer(address,uint256)', () => {
  // Selector is the first 4 bytes of keccak256("transfer(address,uint256)") = 0xa9059cbb.
  // If anyone "fixes" the ABI by changing the param shape (e.g. dropping `to`'s type),
  // the selector changes and USDC.e on Polygon will revert. Lock it down.
  const iface = new ethers.Interface(ERC20_ABI as unknown as string[])
  const frag = iface.getFunction('transfer')!
  assert.equal(frag.selector, '0xa9059cbb', 'transfer selector must be the canonical 0xa9059cbb')
})

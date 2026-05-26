import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import {
  applySpreadFee,
  brokerFeeBps,
  brokerFeeWallet,
  BROKER_FEE_BPS_DEFAULT,
  BROKER_FEE_WALLET_DEFAULT,
} from './brokerFees'

describe('brokerFees', () => {
  const ORIG_BPS = process.env.BROKER_FEE_BPS
  const ORIG_WALLET = process.env.BROKER_FEE_WALLET
  beforeEach(() => {
    delete process.env.BROKER_FEE_BPS
    delete process.env.BROKER_FEE_WALLET
  })
  afterEach(() => {
    if (ORIG_BPS != null) process.env.BROKER_FEE_BPS = ORIG_BPS
    else delete process.env.BROKER_FEE_BPS
    if (ORIG_WALLET != null) process.env.BROKER_FEE_WALLET = ORIG_WALLET
    else delete process.env.BROKER_FEE_WALLET
  })

  describe('brokerFeeBps', () => {
    it('defaults to 30 bps when unset', () => {
      assert.equal(brokerFeeBps(), BROKER_FEE_BPS_DEFAULT)
      assert.equal(BROKER_FEE_BPS_DEFAULT, 30)
    })
    it('reads valid override', () => {
      process.env.BROKER_FEE_BPS = '50'
      assert.equal(brokerFeeBps(), 50)
    })
    it('rejects negative', () => {
      process.env.BROKER_FEE_BPS = '-1'
      assert.throws(() => brokerFeeBps(), /out of range/)
    })
    it('rejects above 10% hard cap', () => {
      process.env.BROKER_FEE_BPS = '1001'
      assert.throws(() => brokerFeeBps(), /out of range/)
    })
    it('rejects non-numeric', () => {
      process.env.BROKER_FEE_BPS = 'abc'
      assert.throws(() => brokerFeeBps(), /out of range/)
    })
    it('floors fractional inputs', () => {
      process.env.BROKER_FEE_BPS = '30.7'
      assert.equal(brokerFeeBps(), 30)
    })
  })

  describe('brokerFeeWallet', () => {
    it('defaults to the production fee wallet', () => {
      assert.equal(brokerFeeWallet().toLowerCase(), BROKER_FEE_WALLET_DEFAULT.toLowerCase())
    })
    it('reads checksummed override', () => {
      const a = ethers.Wallet.createRandom().address
      process.env.BROKER_FEE_WALLET = a
      assert.equal(brokerFeeWallet().toLowerCase(), a.toLowerCase())
    })
    it('rejects malformed addresses', () => {
      process.env.BROKER_FEE_WALLET = 'not-an-address'
      assert.throws(() => brokerFeeWallet(), /not a valid address/)
    })
  })

  describe('applySpreadFee', () => {
    it('30 bps of 1 BNB = 0.003 BNB', () => {
      const gross = ethers.parseEther('1')
      const { fee, net, bps } = applySpreadFee(gross)
      assert.equal(bps, 30)
      assert.equal(fee, ethers.parseEther('0.003'))
      assert.equal(net, gross - fee)
      assert.equal(fee + net, gross) // no rounding loss
    })
    it('30 bps of $100 USDT (18-dec on BSC) = $0.30', () => {
      const gross = ethers.parseUnits('100', 18)
      const { fee, net } = applySpreadFee(gross)
      assert.equal(fee, ethers.parseUnits('0.3', 18))
      assert.equal(net, ethers.parseUnits('99.7', 18))
    })
    it('respects override bps', () => {
      const gross = ethers.parseEther('1')
      const { fee, bps } = applySpreadFee(gross, 100) // 1%
      assert.equal(bps, 100)
      assert.equal(fee, ethers.parseEther('0.01'))
    })
    it('handles zero gross', () => {
      const { fee, net } = applySpreadFee(0n)
      assert.equal(fee, 0n)
      assert.equal(net, 0n)
    })
    it('handles tiny gross (rounds fee down — favours user)', () => {
      // 100 wei × 30 / 10000 = 0 (integer div), so fee=0 net=100
      const { fee, net } = applySpreadFee(100n)
      assert.equal(fee, 0n)
      assert.equal(net, 100n)
    })
    it('handles negative gross as no-op (defensive)', () => {
      const { fee, net } = applySpreadFee(-5n)
      assert.equal(fee, 0n)
      assert.equal(net, 0n)
    })
  })
})

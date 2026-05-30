import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { walkBidDepth, type OrderbookLevel } from './walkBidDepth'

// ─────────────────────────────────────────────────────────────────────────
// Guard for the depth-aware Polymarket sell-proceeds estimate.
//
// walkBidDepth walks the live bid stack (price high → low) to estimate what a
// market sell of `qty` shares would actually realise. The bug it exists to
// prevent: estimating proceeds from the *top* bid alone, which overstates what
// a large position fetches on a thin book (you eat into worse prices as you
// consume depth). The mini-app and the web terminal both rely on this exact
// logic, so these tests pin the weighted-average + partial-fill behaviour so a
// future edit can't silently regress to top-bid overstatement.
// ─────────────────────────────────────────────────────────────────────────

const lvl = (price: number, size: number): OrderbookLevel => ({ price, size })

describe('walkBidDepth', () => {
  it('fills fully across multiple levels with a weighted-average price', () => {
    // Sell 150 shares into: 100 @ 0.60, 100 @ 0.50.
    // Takes 100 @ 0.60 (=60) + 50 @ 0.50 (=25) = 85 proceeds over 150 shares.
    const r = walkBidDepth([lvl(0.6, 100), lvl(0.5, 100)], 150)
    assert.ok(r, 'expected a result')
    assert.equal(r!.partial, false)
    assert.equal(r!.filledQty, 150)
    assert.equal(r!.proceeds, 85)
    assert.equal(r!.avgPrice, 85 / 150) // weighted avg, NOT the top bid 0.60
    assert.ok(r!.avgPrice < 0.6, 'avg must be below the best bid')
  })

  it('returns a partial fill when the book is too thin to cover qty', () => {
    // Only 80 shares of depth exist but we want to sell 200.
    const r = walkBidDepth([lvl(0.7, 50), lvl(0.65, 30)], 200)
    assert.ok(r, 'expected a result')
    assert.equal(r!.partial, true)
    assert.equal(r!.filledQty, 80)
    // 50*0.7 + 30*0.65 = 35 + 19.5 = 54.5
    assert.ok(Math.abs(r!.proceeds - 54.5) < 1e-9)
    assert.ok(Math.abs(r!.avgPrice - 54.5 / 80) < 1e-9)
  })

  it('fills exactly at a single level without flagging partial', () => {
    const r = walkBidDepth([lvl(0.42, 100)], 100)
    assert.ok(r)
    assert.equal(r!.partial, false)
    assert.equal(r!.filledQty, 100)
    assert.ok(Math.abs(r!.proceeds - 42) < 1e-9)
    assert.equal(r!.avgPrice, 0.42)
  })

  it('stops walking once qty is satisfied at the first level', () => {
    // Want 40 of a 100-deep top level — should not touch the second level.
    const r = walkBidDepth([lvl(0.55, 100), lvl(0.10, 100)], 40)
    assert.ok(r)
    assert.equal(r!.partial, false)
    assert.equal(r!.filledQty, 40)
    assert.ok(Math.abs(r!.proceeds - 22) < 1e-9) // 40 * 0.55
    assert.equal(r!.avgPrice, 0.55)
  })

  it('returns null for empty or null bids', () => {
    assert.equal(walkBidDepth(null, 100), null)
    assert.equal(walkBidDepth([], 100), null)
  })

  it('returns null for non-positive quantity', () => {
    assert.equal(walkBidDepth([lvl(0.5, 100)], 0), null)
    assert.equal(walkBidDepth([lvl(0.5, 100)], -10), null)
  })

  it('skips junk levels: price <= 0, price >= 1, and size <= 0', () => {
    // Only the 0.50 @ 100 level is usable. The 0/1.2/-5 prices and 0/-3 sizes
    // are junk that must be filtered, not summed.
    const bids = [
      lvl(0, 100),     // price <= 0 → skip
      lvl(1.2, 100),   // price >= 1 → skip
      lvl(-0.5, 100),  // negative price → skip
      lvl(0.5, 0),     // size <= 0 → skip
      lvl(0.5, -3),    // negative size → skip
      lvl(0.5, 100),   // the only valid level
    ]
    const r = walkBidDepth(bids, 60)
    assert.ok(r)
    assert.equal(r!.partial, false)
    assert.equal(r!.filledQty, 60)
    assert.ok(Math.abs(r!.proceeds - 30) < 1e-9) // 60 * 0.50
    assert.equal(r!.avgPrice, 0.5)
  })

  it('returns null when every level is junk', () => {
    const bids = [lvl(0, 100), lvl(1, 100), lvl(0.5, 0)]
    assert.equal(walkBidDepth(bids, 50), null)
  })

  it('partial fill when junk filtering leaves insufficient depth', () => {
    // 40 valid + 30 valid usable; a junk level in the middle is ignored.
    const bids = [lvl(0.8, 40), lvl(1.5, 1000), lvl(0.6, 30)]
    const r = walkBidDepth(bids, 100)
    assert.ok(r)
    assert.equal(r!.partial, true)
    assert.equal(r!.filledQty, 70)
    // 40*0.8 + 30*0.6 = 32 + 18 = 50
    assert.ok(Math.abs(r!.proceeds - 50) < 1e-9)
    assert.ok(Math.abs(r!.avgPrice - 50 / 70) < 1e-9)
  })
})

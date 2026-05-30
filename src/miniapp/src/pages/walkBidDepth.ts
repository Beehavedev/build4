// Depth-aware Polymarket sell-proceeds estimator.
//
// Walk the bid side (price high → low) up to `qty` shares to estimate what a
// market sell would actually realise. Returns the weighted-average fill price,
// the quantity the book can absorb, the total proceeds, and whether the book is
// too thin to fully cover the order. Returns null when no usable depth exists.
//
// Ported from the web terminal (build4io-site terminal-preview) so both the
// mini-app and the web surface show the same depth-aware sell estimate instead
// of overstating proceeds from the top bid alone. This logic is exercised by
// walkBidDepth.test.ts — keep them in lockstep so a future edit can't silently
// reintroduce the top-bid overstatement bug on thin books.

export interface OrderbookLevel { price: number; size: number }

export interface BidWalk {
  avgPrice: number
  filledQty: number
  proceeds: number
  partial: boolean
}

export function walkBidDepth(
  bids: OrderbookLevel[] | null,
  qty: number,
): BidWalk | null {
  if (!Array.isArray(bids) || bids.length === 0 || !(qty > 0)) return null
  let remaining = qty
  let filledQty = 0
  let proceeds = 0
  for (const lvl of bids) {
    if (remaining <= 1e-9) break
    if (!(lvl.price > 0 && lvl.price < 1 && lvl.size > 0)) continue
    const take = Math.min(remaining, lvl.size)
    filledQty += take
    proceeds += take * lvl.price
    remaining -= take
  }
  if (filledQty <= 0) return null
  const avgPrice = proceeds / filledQty
  return { avgPrice, filledQty, proceeds, partial: remaining > 1e-9 }
}

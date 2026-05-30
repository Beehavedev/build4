import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchBscTokenPricesUsd, __resetBscPriceCache } from './dexScreener'

// ── Why this test file exists ───────────────────────────────────────────────
// `fetchBscTokenPricesUsd` gained a 30s in-memory price cache so the Topaz
// page (which re-fetches token prices on every load) stops hammering
// DexScreener's public endpoint and tripping its rate limit. The cache has
// three behaviours that must not silently regress:
//   1. a repeat call inside the TTL serves from cache (no second fetch),
//   2. only the stale/missing addresses are re-fetched — already-cached
//      addresses are excluded from the next network call,
//   3. misses (tokens DexScreener can't price) are cached as such, so they
//      aren't re-queried on every load either.
// We drive the function with a fake `fetchImpl` so no real network is hit.

const ADDR_A = '0xAAa0000000000000000000000000000000000001'
const ADDR_B = '0xBbB0000000000000000000000000000000000002'
const ADDR_C = '0xCcC0000000000000000000000000000000000003'

/** Build a fake fetch that records the addresses requested per call and
 * returns DexScreener-shaped pairs for whichever addresses have a price. */
function makeFetchMock(priceByAddr: Record<string, number>) {
  const calls: string[][] = []
  const fetchImpl = (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString()
    // URL form: .../tokens/v1/bsc/<addr1,addr2,...>
    const tail = u.split('/tokens/v1/bsc/')[1] ?? ''
    const requested = tail.split(',').filter(Boolean)
    calls.push(requested)
    const pairs = requested
      .filter((a) => priceByAddr[a.toLowerCase()] !== undefined)
      .map((a) => ({
        baseToken: { address: a, symbol: 'TKN', name: 'Token' },
        priceUsd: String(priceByAddr[a.toLowerCase()]),
        liquidity: { usd: 100_000 },
      }))
    return {
      ok: true,
      status: 200,
      json: async () => pairs,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

test('price cache: a second call within the TTL serves from cache (no re-fetch)', async () => {
  __resetBscPriceCache()
  const { fetchImpl, calls } = makeFetchMock({
    [ADDR_A.toLowerCase()]: 1.5,
    [ADDR_B.toLowerCase()]: 2.5,
  })

  const first = await fetchBscTokenPricesUsd([ADDR_A, ADDR_B], { fetchImpl })
  assert.equal(first[ADDR_A.toLowerCase()], 1.5)
  assert.equal(first[ADDR_B.toLowerCase()], 2.5)
  assert.equal(calls.length, 1, 'first call must hit the network once')

  const second = await fetchBscTokenPricesUsd([ADDR_A, ADDR_B], { fetchImpl })
  assert.equal(second[ADDR_A.toLowerCase()], 1.5)
  assert.equal(second[ADDR_B.toLowerCase()], 2.5)
  assert.equal(calls.length, 1, 'second call within TTL must serve from cache, not re-fetch')
})

test('price cache: only stale/missing addresses are re-fetched', async () => {
  __resetBscPriceCache()
  const { fetchImpl, calls } = makeFetchMock({
    [ADDR_A.toLowerCase()]: 1.5,
    [ADDR_B.toLowerCase()]: 2.5,
    [ADDR_C.toLowerCase()]: 3.5,
  })

  // Prime the cache with A only.
  await fetchBscTokenPricesUsd([ADDR_A], { fetchImpl })
  assert.deepEqual(calls[0].map((a) => a.toLowerCase()), [ADDR_A.toLowerCase()])

  // Asking for A (cached) + B + C (new) must only fetch B and C.
  const out = await fetchBscTokenPricesUsd([ADDR_A, ADDR_B, ADDR_C], { fetchImpl })
  assert.equal(out[ADDR_A.toLowerCase()], 1.5, 'cached A still served')
  assert.equal(out[ADDR_B.toLowerCase()], 2.5)
  assert.equal(out[ADDR_C.toLowerCase()], 3.5)
  assert.equal(calls.length, 2, 'a second network call should happen for the uncached addresses')
  const secondCall = calls[1].map((a) => a.toLowerCase())
  assert.ok(!secondCall.includes(ADDR_A.toLowerCase()), 'cached address must not be re-fetched')
  assert.deepEqual(
    secondCall.sort(),
    [ADDR_B.toLowerCase(), ADDR_C.toLowerCase()].sort(),
    'only the stale/missing addresses are re-fetched',
  )
})

test('price cache: entries expire after the 30s TTL and are re-fetched', async () => {
  __resetBscPriceCache()
  const { fetchImpl, calls } = makeFetchMock({
    [ADDR_A.toLowerCase()]: 1.5,
  })

  // Pin time so we can deterministically push the cache past its TTL. The TTL
  // is 30_000ms; advancing the clock by more than that must invalidate the
  // entry and force a fresh fetch (this is the "cache never expires" guard).
  const realNow = Date.now
  const t0 = 1_000_000_000_000
  let clock = t0
  Date.now = () => clock
  try {
    const first = await fetchBscTokenPricesUsd([ADDR_A], { fetchImpl })
    assert.equal(first[ADDR_A.toLowerCase()], 1.5)
    assert.equal(calls.length, 1)

    // Still within TTL — served from cache.
    clock = t0 + 29_999
    await fetchBscTokenPricesUsd([ADDR_A], { fetchImpl })
    assert.equal(calls.length, 1, 'within TTL must not re-fetch')

    // Past TTL — must re-fetch.
    clock = t0 + 30_001
    const stale = await fetchBscTokenPricesUsd([ADDR_A], { fetchImpl })
    assert.equal(stale[ADDR_A.toLowerCase()], 1.5)
    assert.equal(calls.length, 2, 'expired entry must be re-fetched after the TTL elapses')
  } finally {
    Date.now = realNow
  }
})

test('price cache: a single call fetches only stale + missing, serving fresh from cache', async () => {
  __resetBscPriceCache()
  const { fetchImpl, calls } = makeFetchMock({
    [ADDR_A.toLowerCase()]: 1.5, // will be allowed to go stale
    [ADDR_B.toLowerCase()]: 2.5, // stays fresh
    [ADDR_C.toLowerCase()]: 3.5, // never cached (missing)
  })

  const realNow = Date.now
  const t0 = 2_000_000_000_000
  let clock = t0
  Date.now = () => clock
  try {
    // Prime A at t0.
    await fetchBscTokenPricesUsd([ADDR_A], { fetchImpl })
    // Prime B just before the combined call so it stays fresh.
    clock = t0 + 25_000
    await fetchBscTokenPricesUsd([ADDR_B], { fetchImpl })
    assert.equal(calls.length, 2)

    // Advance so A is stale (>30s old) but B is still fresh (<30s old), and
    // request A + B + C together. Only A (stale) and C (missing) should be
    // fetched; B is served from cache.
    clock = t0 + 31_000
    const out = await fetchBscTokenPricesUsd([ADDR_A, ADDR_B, ADDR_C], { fetchImpl })
    assert.equal(out[ADDR_A.toLowerCase()], 1.5)
    assert.equal(out[ADDR_B.toLowerCase()], 2.5)
    assert.equal(out[ADDR_C.toLowerCase()], 3.5)
    assert.equal(calls.length, 3, 'one more network call for the stale + missing addresses')
    const lastCall = calls[2].map((a) => a.toLowerCase())
    assert.ok(!lastCall.includes(ADDR_B.toLowerCase()), 'fresh address must be served from cache')
    assert.deepEqual(
      lastCall.sort(),
      [ADDR_A.toLowerCase(), ADDR_C.toLowerCase()].sort(),
      'only the stale and missing addresses are fetched',
    )
  } finally {
    Date.now = realNow
  }
})

test('price cache: misses are cached and not re-queried within the TTL', async () => {
  __resetBscPriceCache()
  // ADDR_A is priceable; ADDR_B is unpriceable (DexScreener returns no pair).
  const { fetchImpl, calls } = makeFetchMock({
    [ADDR_A.toLowerCase()]: 1.5,
  })

  const first = await fetchBscTokenPricesUsd([ADDR_A, ADDR_B], { fetchImpl })
  assert.equal(first[ADDR_A.toLowerCase()], 1.5)
  assert.equal(first[ADDR_B.toLowerCase()], undefined, 'unpriceable token is absent from the result')
  assert.equal(calls.length, 1)

  // Re-asking for the miss must NOT trigger another fetch — the null is cached.
  const second = await fetchBscTokenPricesUsd([ADDR_B], { fetchImpl })
  assert.equal(second[ADDR_B.toLowerCase()], undefined)
  assert.equal(calls.length, 1, 'cached miss must not be re-queried within the TTL')
})

test('price cache: __resetBscPriceCache() clears the cache', async () => {
  __resetBscPriceCache()
  const { fetchImpl, calls } = makeFetchMock({
    [ADDR_A.toLowerCase()]: 1.5,
  })

  await fetchBscTokenPricesUsd([ADDR_A], { fetchImpl })
  assert.equal(calls.length, 1)

  // Without a reset this would serve from cache; after a reset it must re-fetch.
  __resetBscPriceCache()
  await fetchBscTokenPricesUsd([ADDR_A], { fetchImpl })
  assert.equal(calls.length, 2, 'after reset the address must be fetched again')
})

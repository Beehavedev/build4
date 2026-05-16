import { ethers } from 'ethers';

// Public BSC RPC endpoints used as fallback when BSC_RPC_URL is unset OR
// when the configured primary fails. These are all officially-blessed
// public dataseed nodes; none require a key. They're rate-limited and
// occasionally drop responses (which is exactly why we keep multiple).
//
// Order matters: FallbackProvider tries higher-priority entries first.
// We deliberately avoid `rpc.ankr.com/bsc` (no key) here because Ankr's
// keyless endpoint is more aggressive about throttling than the
// dataseeds and tends to return empty 0x responses, which is the exact
// failure mode we're trying to escape.
// Probed 2026-05-09 from Replit cloud egress: all return 200 + valid
// chainId in <250ms. Excluded after probe: `binance.llamarpc.com` (NXDOMAIN
// from us, same as the Polygon llamarpc), `rpc.ankr.com/bsc` (returns
// "Unauthorized: You must…" on the keyless tier from cloud IPs).
const PUBLIC_BSC_RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc.publicnode.com',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
  'https://bsc.meowrpc.com',
];

/**
 * Build a BSC provider that survives single-endpoint outages.
 *
 * Two robustness tricks are critical here:
 *
 *  1. `staticNetwork`. By default ethers v6 calls `eth_chainId` before
 *     EVERY contract call to "verify" the network hasn't changed under it.
 *     When the upstream RPC returns an empty `0x` response (which the
 *     public dataseeds DO under load), ethers tries to ABI-decode `0x`
 *     and throws BUFFER_OVERRUN — the cryptic error users were seeing in
 *     the mini-app. The chain ID never changes; tell ethers to trust it
 *     and skip the round-trip entirely.
 *
 *  2. FallbackProvider. If the primary endpoint stalls or errors, we
 *     transparently retry against the next. Quorum=1 means a single
 *     success is enough; we're not trying to consensus-verify reads,
 *     just survive a flaky RPC. stallTimeout 2s prevents one slow node
 *     from blocking the whole call chain.
 *
 * Used by both read-only callers (fortyTwoOnchain) AND the signer in
 * FortyTwoTrader. Multi-endpoint with a signer is safe ONLY because
 * per-wallet trades are serialized (advisory lock in fortyTwoExecutor),
 * so we can't get concurrent nonce queries returning the same value
 * across providers in practice.
 */
export function buildBscProvider(primaryRpcUrl?: string): ethers.AbstractProvider {
  const network = new ethers.Network('bnb', 56n);
  const urls = primaryRpcUrl
    ? [primaryRpcUrl, ...PUBLIC_BSC_RPCS.filter((u) => u !== primaryRpcUrl)]
    : PUBLIC_BSC_RPCS;

  // Single-endpoint case: a bare JsonRpcProvider is lighter and avoids
  // FallbackProvider's quorum/scoring overhead. Still apply staticNetwork.
  if (urls.length === 1) {
    return new ethers.JsonRpcProvider(urls[0], network, { staticNetwork: network });
  }

  // stallTimeout=800ms (was 2000). FallbackProvider only opens the NEXT
  // provider in line after the current one has stalled for this long. With
  // a 7-endpoint list under a ~12s section budget, 800ms means up to ~10
  // endpoints get a real shot before the caller times out — vs the prior
  // 2000ms which only let us reach ~2 endpoints inside a 5s budget. The
  // previous setup was responsible for the production "bsc_bnb_timeout_5000ms"
  // banners users were seeing even though their deposit was on-chain.
  const configs = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, network, { staticNetwork: network }),
    priority: i + 1,
    weight: 1,
    stallTimeout: 800,
  }));
  return new ethers.FallbackProvider(configs, network, { quorum: 1 });
}

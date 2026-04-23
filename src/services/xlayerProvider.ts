import { ethers } from 'ethers';

/**
 * XLayer (OKX zkEVM, chain id 196) provider.
 *
 * Mirrors `bscProvider.ts` — same FallbackProvider + staticNetwork
 * pattern. See bscProvider.ts for the rationale on why both tricks
 * are non-negotiable when talking to public dataseeds.
 *
 * Native gas token is OKB (18 decimals). Block explorer is OKLink
 * (https://www.oklink.com/xlayer). Bridge:
 *   https://www.okx.com/web3/bridge — supports BNB↔XLayer and
 *   Arbitrum↔XLayer with native USDC + OKB.
 *
 * Public RPCs are operated by OKX directly. We list two so a single
 * endpoint outage doesn't black-hole the registry path.
 */
const PUBLIC_XLAYER_RPCS = [
  'https://rpc.xlayer.tech',
  'https://xlayerrpc.okx.com',
];

export const XLAYER_CHAIN_ID = 196n;
export const XLAYER_NETWORK_NAME = 'xlayer';

export function buildXLayerProvider(primaryRpcUrl?: string): ethers.AbstractProvider {
  const network = new ethers.Network(XLAYER_NETWORK_NAME, XLAYER_CHAIN_ID);
  const urls = primaryRpcUrl
    ? [primaryRpcUrl, ...PUBLIC_XLAYER_RPCS.filter((u) => u !== primaryRpcUrl)]
    : PUBLIC_XLAYER_RPCS;

  if (urls.length === 1) {
    return new ethers.JsonRpcProvider(urls[0], network, { staticNetwork: network });
  }

  const configs = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, network, { staticNetwork: network }),
    priority: i + 1,
    weight: 1,
    stallTimeout: 2000,
  }));
  return new ethers.FallbackProvider(configs, network, { quorum: 1 });
}

export function xlayerScanUrl(addressOrTx: string): string {
  const isTx = addressOrTx.length === 66;
  return `https://www.oklink.com/xlayer/${isTx ? 'tx' : 'address'}/${addressOrTx}`;
}

export function xlayerTokenScanUrl(token: string, addressOrId?: string): string {
  return addressOrId
    ? `https://www.oklink.com/xlayer/token/${token}?a=${addressOrId}`
    : `https://www.oklink.com/xlayer/token/${token}`;
}

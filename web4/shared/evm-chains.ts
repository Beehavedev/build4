export interface EVMChainInfo {
  chainId: number;
  name: string;
  shortName: string;
  currency: string;
  decimals: number;
  rpcUrls: string[];
  explorerUrl: string;
  explorerApiUrl?: string;
  isTestnet?: boolean;
}

export const EVM_CHAINS: Record<number, EVMChainInfo> = {
  1: { chainId: 1, name: "Ethereum", shortName: "ETH", currency: "ETH", decimals: 18, rpcUrls: ["https://eth.llamarpc.com", "https://rpc.ankr.com/eth"], explorerUrl: "https://etherscan.io" },
  10: { chainId: 10, name: "Optimism", shortName: "OP", currency: "ETH", decimals: 18, rpcUrls: ["https://mainnet.optimism.io", "https://rpc.ankr.com/optimism"], explorerUrl: "https://optimistic.etherscan.io" },
  25: { chainId: 25, name: "Cronos", shortName: "CRO", currency: "CRO", decimals: 18, rpcUrls: ["https://evm.cronos.org"], explorerUrl: "https://cronoscan.com" },
  56: { chainId: 56, name: "BNB Chain", shortName: "BNB", currency: "BNB", decimals: 18, rpcUrls: ["https://bsc-dataseed1.binance.org", "https://rpc.ankr.com/bsc"], explorerUrl: "https://bscscan.com" },
  100: { chainId: 100, name: "Gnosis", shortName: "GNO", currency: "xDAI", decimals: 18, rpcUrls: ["https://rpc.gnosischain.com"], explorerUrl: "https://gnosisscan.io" },
  137: { chainId: 137, name: "Polygon", shortName: "MATIC", currency: "POL", decimals: 18, rpcUrls: ["https://polygon-rpc.com", "https://rpc.ankr.com/polygon"], explorerUrl: "https://polygonscan.com" },
  196: { chainId: 196, name: "XLayer", shortName: "XLayer", currency: "OKB", decimals: 18, rpcUrls: ["https://rpc.xlayer.tech"], explorerUrl: "https://www.oklink.com/xlayer" },
  250: { chainId: 250, name: "Fantom", shortName: "FTM", currency: "FTM", decimals: 18, rpcUrls: ["https://rpc.ftm.tools", "https://rpc.ankr.com/fantom"], explorerUrl: "https://ftmscan.com" },
  324: { chainId: 324, name: "zkSync Era", shortName: "zkSync", currency: "ETH", decimals: 18, rpcUrls: ["https://mainnet.era.zksync.io", "https://zksync.drpc.org"], explorerUrl: "https://explorer.zksync.io" },
  369: { chainId: 369, name: "PulseChain", shortName: "PLS", currency: "PLS", decimals: 18, rpcUrls: ["https://rpc.pulsechain.com"], explorerUrl: "https://scan.pulsechain.com" },
  42161: { chainId: 42161, name: "Arbitrum One", shortName: "ARB", currency: "ETH", decimals: 18, rpcUrls: ["https://arb1.arbitrum.io/rpc", "https://rpc.ankr.com/arbitrum"], explorerUrl: "https://arbiscan.io" },
  42170: { chainId: 42170, name: "Arbitrum Nova", shortName: "ARBNOVA", currency: "ETH", decimals: 18, rpcUrls: ["https://nova.arbitrum.io/rpc"], explorerUrl: "https://nova.arbiscan.io" },
  43114: { chainId: 43114, name: "Avalanche", shortName: "AVAX", currency: "AVAX", decimals: 18, rpcUrls: ["https://api.avax.network/ext/bc/C/rpc", "https://rpc.ankr.com/avalanche"], explorerUrl: "https://snowtrace.io" },
  59144: { chainId: 59144, name: "Linea", shortName: "LINEA", currency: "ETH", decimals: 18, rpcUrls: ["https://rpc.linea.build"], explorerUrl: "https://lineascan.build" },
  8453: { chainId: 8453, name: "Base", shortName: "BASE", currency: "ETH", decimals: 18, rpcUrls: ["https://mainnet.base.org", "https://rpc.ankr.com/base"], explorerUrl: "https://basescan.org" },
  534352: { chainId: 534352, name: "Scroll", shortName: "SCROLL", currency: "ETH", decimals: 18, rpcUrls: ["https://rpc.scroll.io"], explorerUrl: "https://scrollscan.com" },
  5000: { chainId: 5000, name: "Mantle", shortName: "MNT", currency: "MNT", decimals: 18, rpcUrls: ["https://rpc.mantle.xyz"], explorerUrl: "https://mantlescan.xyz" },
  7777777: { chainId: 7777777, name: "Zora", shortName: "ZORA", currency: "ETH", decimals: 18, rpcUrls: ["https://rpc.zora.energy"], explorerUrl: "https://explorer.zora.energy" },
  81457: { chainId: 81457, name: "Blast", shortName: "BLAST", currency: "ETH", decimals: 18, rpcUrls: ["https://rpc.blast.io"], explorerUrl: "https://blastscan.io" },
  34443: { chainId: 34443, name: "Mode", shortName: "MODE", currency: "ETH", decimals: 18, rpcUrls: ["https://mainnet.mode.network"], explorerUrl: "https://modescan.io" },
  1101: { chainId: 1101, name: "Polygon zkEVM", shortName: "zkPOL", currency: "ETH", decimals: 18, rpcUrls: ["https://zkevm-rpc.com"], explorerUrl: "https://zkevm.polygonscan.com" },
  1088: { chainId: 1088, name: "Metis", shortName: "METIS", currency: "METIS", decimals: 18, rpcUrls: ["https://andromeda.metis.io/?owner=1088"], explorerUrl: "https://andromeda-explorer.metis.io" },
  666666666: { chainId: 666666666, name: "Degen Chain", shortName: "DEGEN", currency: "DEGEN", decimals: 18, rpcUrls: ["https://rpc.degen.tips"], explorerUrl: "https://explorer.degen.tips" },
  2222: { chainId: 2222, name: "Kava", shortName: "KAVA", currency: "KAVA", decimals: 18, rpcUrls: ["https://evm.kava.io"], explorerUrl: "https://kavascan.com" },
  1284: { chainId: 1284, name: "Moonbeam", shortName: "GLMR", currency: "GLMR", decimals: 18, rpcUrls: ["https://rpc.api.moonbeam.network"], explorerUrl: "https://moonbeam.moonscan.io" },
  1285: { chainId: 1285, name: "Moonriver", shortName: "MOVR", currency: "MOVR", decimals: 18, rpcUrls: ["https://rpc.api.moonriver.moonbeam.network"], explorerUrl: "https://moonriver.moonscan.io" },
  42220: { chainId: 42220, name: "Celo", shortName: "CELO", currency: "CELO", decimals: 18, rpcUrls: ["https://forno.celo.org"], explorerUrl: "https://celoscan.io" },
  1666600000: { chainId: 1666600000, name: "Harmony", shortName: "ONE", currency: "ONE", decimals: 18, rpcUrls: ["https://api.harmony.one"], explorerUrl: "https://explorer.harmony.one" },
  288: { chainId: 288, name: "Boba Network", shortName: "BOBA", currency: "ETH", decimals: 18, rpcUrls: ["https://mainnet.boba.network"], explorerUrl: "https://bobascan.com" },
  167000: { chainId: 167000, name: "Taiko", shortName: "TAIKO", currency: "ETH", decimals: 18, rpcUrls: ["https://rpc.mainnet.taiko.xyz"], explorerUrl: "https://taikoscan.io" },
};

export const CONTRACT_CHAINS = [56, 8453, 196];

export function getChainInfo(chainId: number): EVMChainInfo | null {
  return EVM_CHAINS[chainId] || null;
}

export function getChainName(chainId: number): string {
  return EVM_CHAINS[chainId]?.name || `Chain ${chainId}`;
}

export function getChainCurrency(chainId: number): string {
  return EVM_CHAINS[chainId]?.currency || "ETH";
}

export function getExplorerTxUrl(chainId: number, txHash: string): string | null {
  const chain = EVM_CHAINS[chainId];
  if (!chain) return null;
  return `${chain.explorerUrl}/tx/${txHash}`;
}

export function getExplorerAddressUrl(chainId: number, address: string): string | null {
  const chain = EVM_CHAINS[chainId];
  if (!chain) return null;
  return `${chain.explorerUrl}/address/${address}`;
}

export function isContractChain(chainId: number): boolean {
  return CONTRACT_CHAINS.includes(chainId);
}

export function getRpcUrl(chainId: number): string | null {
  const chain = EVM_CHAINS[chainId];
  if (!chain || chain.rpcUrls.length === 0) return null;
  return chain.rpcUrls[0];
}

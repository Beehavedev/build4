// ERC-8004 Identity Registry mint for competition agents.
//
// Official EIP: https://eips.ethereum.org/EIPS/eip-8004
// BSC mainnet registry: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 (vanity prefix 0x8004…)
// Contract is ERC-721 + URIStorage. Method: register(string agentURI) -> uint256 agentId.
// Cost: ~0.0003 BNB gas (~$0.10). Paid by the user's custodial trading wallet
// (which must already hold BNB to trade PancakeSwap anyway).
//
// This is a website-only port of the pattern in src/services/erc8004.ts. The
// bot uses a sponsor wallet to fund mints; here we let the custodial pay its
// own gas because it's already funded for trading. Keeps build4io-site/
// fully isolated from the bot codebase.

import { ethers } from "ethers";

const BSC_RPC = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org";

export const ERC8004_REGISTRY_BSC = (
  process.env.ERC8004_REGISTRY ?? "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
).trim();

const ABI = [
  "function register(string agentURI) external returns (uint256)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

export function getBscScanTokenUrl(tokenId: string): string {
  return `https://bscscan.com/token/${ERC8004_REGISTRY_BSC}?a=${tokenId}`;
}

export function getBscScanTxUrl(txHash: string): string {
  return `https://bscscan.com/tx/${txHash}`;
}

function buildAgentURI(opts: {
  agentName: string;
  persona: string;
  mode: string;
  ownerAddress: string;
  agentAddress: string;
}): string {
  const meta = {
    name: opts.agentName,
    description: "BUILD4 × PancakeSwap AI Agent Championship · Season 1",
    image: "https://build4.io/og/agent-card.png",
    external_url: "https://build4.io/competition",
    standard: "ERC-8004",
    version: "1.0.0",
    persona: opts.persona,
    mode: opts.mode,
    owner: opts.ownerAddress,
    agent: opts.agentAddress,
    venue: "PancakeSwap V2 (BSC)",
    createdAt: new Date().toISOString(),
    attributes: [
      { trait_type: "Persona", value: opts.persona },
      { trait_type: "Mode", value: opts.mode },
      { trait_type: "Venue", value: "PancakeSwap" },
      { trait_type: "Standard", value: "ERC-8004" },
      { trait_type: "Competition", value: "BUILD4 × PancakeSwap S1" },
    ],
  };
  // Inline data: URI — read directly by BscScan / NFAScan / 8004scan, no
  // IPFS pin or hosting required. URL-encoded to keep raw JSON readable in
  // the chain explorer when someone clicks "tokenURI".
  return `data:application/json;utf8,${encodeURIComponent(JSON.stringify(meta))}`;
}

export interface MintResult {
  tokenId: string;
  txHash: string;
  agentURI: string;
}

/**
 * Mint an ERC-8004 identity for the given custodial agent wallet.
 * Throws on any failure — caller wraps in try/catch and persists status.
 */
export async function mintAgentIdentity(opts: {
  custodialPk: string;
  ownerAddress: string;
  agentName: string;
  persona: string;
  mode: string;
}): Promise<MintResult> {
  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const wallet = new ethers.Wallet(opts.custodialPk, provider);

  // Pre-flight: must hold enough BNB to land the tx. Measured worst case
  // for register(string) is ~225k gas. We require 0.0005 BNB (~$0.15) of
  // headroom so a gas-price spike between estimation and mining can't
  // strand the tx.
  const bal = await provider.getBalance(wallet.address);
  const MIN_GAS_WEI = ethers.parseEther("0.0005");
  if (bal < MIN_GAS_WEI) {
    throw new Error(
      `Trading wallet needs ≥0.0005 BNB for ERC-8004 mint (has ${ethers.formatEther(bal)} BNB). Send BNB then click "Retry identity mint".`,
    );
  }

  const registry = new ethers.Contract(ERC8004_REGISTRY_BSC, ABI, wallet);
  const agentURI = buildAgentURI({
    agentName: opts.agentName,
    persona: opts.persona,
    mode: opts.mode,
    ownerAddress: opts.ownerAddress,
    agentAddress: wallet.address,
  });

  // Estimate gas with a 30% buffer; fall back to 500k (2x measured) if the
  // estimate reverts (e.g. contract paused, agent name conflict, etc.).
  let gasLimit: bigint;
  try {
    const est = await registry.register.estimateGas(agentURI);
    gasLimit = (est * 130n) / 100n;
  } catch {
    gasLimit = 500_000n;
  }

  const tx = await registry.register(agentURI, { gasLimit });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`ERC-8004 register tx reverted (hash=${tx.hash})`);
  }

  // Parse Transfer(from=0, to=agentAddr, tokenId) to extract the assigned ID.
  let tokenId: string | null = null;
  const iface = new ethers.Interface(ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ERC8004_REGISTRY_BSC.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed && parsed.name === "Transfer") {
        tokenId = String(parsed.args.tokenId);
        break;
      }
    } catch {
      /* not a Transfer log */
    }
  }
  if (!tokenId) {
    throw new Error(`ERC-8004 mint succeeded but no Transfer event found in tx ${tx.hash}`);
  }
  return { tokenId, txHash: tx.hash, agentURI };
}

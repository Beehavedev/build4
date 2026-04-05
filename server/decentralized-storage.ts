import * as ethers from "ethers";
import { log } from "./index";

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud/ipfs";
const DEPLOYER_KEY = process.env.ONCHAIN_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;

const BSC_RPC = "https://bsc-dataseed1.binance.org";
const BASE_RPC = "https://mainnet.base.org";

const ANCHOR_CHAINS: Record<string, { rpc: string; chainId: number; name: string; explorer: string }> = {
  "56": { rpc: BSC_RPC, chainId: 56, name: "BNB Chain", explorer: "https://bscscan.com/tx/" },
  "8453": { rpc: BASE_RPC, chainId: 8453, name: "Base", explorer: "https://basescan.org/tx/" },
};

export async function pinToIPFS(data: object, name?: string): Promise<{ success: boolean; cid?: string; url?: string; error?: string }> {
  if (!PINATA_JWT) {
    return { success: false, error: "IPFS pinning not configured (no PINATA_JWT)" };
  }

  try {
    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PINATA_JWT}`,
      },
      body: JSON.stringify({
        pinataContent: data,
        pinataMetadata: { name: name || `build4-memory-${Date.now()}` },
        pinataOptions: { cidVersion: 1 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Pinata error ${response.status}: ${errText.substring(0, 100)}` };
    }

    const result = await response.json() as any;
    const cid = result.IpfsHash;
    log(`[IPFS] Pinned: ${cid} (${name || "unnamed"})`, "onchain");
    return { success: true, cid, url: `${PINATA_GATEWAY}/${cid}` };
  } catch (e: any) {
    return { success: false, error: e.message?.substring(0, 100) };
  }
}

export async function pinMemoryEntry(entry: {
  agentId: string;
  entryId: string;
  entry: string;
  entryType: string;
  source: string;
  integrityHash: string;
  previousHash: string;
  createdAt: string;
}): Promise<{ success: boolean; cid?: string; url?: string; error?: string }> {
  const ipfsPayload = {
    "@context": "https://build4.io/schemas/agent-memory/v1",
    type: "AgentMemoryEntry",
    agentId: entry.agentId,
    entryId: entry.entryId,
    content: entry.entry,
    entryType: entry.entryType,
    source: entry.source,
    integrity: {
      hash: entry.integrityHash,
      previousHash: entry.previousHash,
      algorithm: "SHA-256",
      chainType: "linked-hash-chain",
    },
    timestamp: entry.createdAt,
    platform: "BUILD4",
    version: "1.0",
  };

  return pinToIPFS(ipfsPayload, `build4-memory-${entry.agentId}-${entry.entryId}`);
}

export async function pinMemoryMerkleRoot(agentId: string, entries: Array<{
  integrityHash: string | null;
  entryType: string;
  createdAt: Date | null;
}>): Promise<{ success: boolean; cid?: string; merkleRoot?: string; error?: string }> {
  const crypto = await import("crypto");

  const hashes = entries
    .filter(e => e.integrityHash)
    .map(e => e.integrityHash!);

  if (hashes.length === 0) {
    return { success: false, error: "No hashed entries to create Merkle root" };
  }

  let level = hashes.map(h => h);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(crypto.createHash("sha256").update(left + right).digest("hex"));
    }
    level = next;
  }
  const merkleRoot = level[0];

  const ipfsPayload = {
    "@context": "https://build4.io/schemas/agent-memory-root/v1",
    type: "AgentMemoryMerkleRoot",
    agentId,
    merkleRoot,
    algorithm: "SHA-256",
    totalEntries: entries.length,
    hashedEntries: hashes.length,
    leafHashes: hashes,
    timestamp: new Date().toISOString(),
    platform: "BUILD4",
    version: "1.0",
  };

  const result = await pinToIPFS(ipfsPayload, `build4-merkle-${agentId}-${Date.now()}`);
  return { ...result, merkleRoot };
}

export async function anchorHashOnChain(
  hash: string,
  agentId: string,
  chainId: string = "56"
): Promise<{ success: boolean; txHash?: string; chainId?: number; explorer?: string; error?: string }> {
  if (!DEPLOYER_KEY) {
    return { success: false, error: "No deployer key for on-chain anchoring" };
  }

  const chainConfig = ANCHOR_CHAINS[chainId];
  if (!chainConfig) {
    return { success: false, error: `Unsupported anchor chain: ${chainId}` };
  }

  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
    const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);

    const anchorData = ethers.hexlify(
      ethers.toUtf8Bytes(JSON.stringify({
        protocol: "BUILD4-MEMORY-ANCHOR",
        version: "1.0",
        agentId,
        hash,
        timestamp: Date.now(),
      }))
    );

    const tx = await wallet.sendTransaction({
      to: wallet.address,
      value: 0,
      data: anchorData,
      gasLimit: 50000,
    });

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      return { success: false, error: "Anchor transaction reverted" };
    }

    log(`[ANCHOR] Memory hash anchored on ${chainConfig.name}: ${receipt.hash}`, "onchain");
    return {
      success: true,
      txHash: receipt.hash,
      chainId: chainConfig.chainId,
      explorer: `${chainConfig.explorer}${receipt.hash}`,
    };
  } catch (e: any) {
    log(`[ANCHOR] Failed: ${e.message?.substring(0, 100)}`, "onchain");
    return { success: false, error: e.message?.substring(0, 100) };
  }
}

export async function anchorMerkleRoot(
  agentId: string,
  merkleRoot: string,
  ipfsCid?: string,
  chainId: string = "56"
): Promise<{ success: boolean; txHash?: string; chainId?: number; explorer?: string; error?: string }> {
  if (!DEPLOYER_KEY) {
    return { success: false, error: "No deployer key for on-chain anchoring" };
  }

  const chainConfig = ANCHOR_CHAINS[chainId];
  if (!chainConfig) {
    return { success: false, error: `Unsupported anchor chain: ${chainId}` };
  }

  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
    const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);

    const anchorData = ethers.hexlify(
      ethers.toUtf8Bytes(JSON.stringify({
        protocol: "BUILD4-MERKLE-ANCHOR",
        version: "1.0",
        agentId,
        merkleRoot,
        ipfsCid: ipfsCid || null,
        timestamp: Date.now(),
      }))
    );

    const tx = await wallet.sendTransaction({
      to: wallet.address,
      value: 0,
      data: anchorData,
      gasLimit: 60000,
    });

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      return { success: false, error: "Merkle anchor transaction reverted" };
    }

    log(`[ANCHOR] Merkle root anchored on ${chainConfig.name} for agent ${agentId}: ${receipt.hash}`, "onchain");
    return {
      success: true,
      txHash: receipt.hash,
      chainId: chainConfig.chainId,
      explorer: `${chainConfig.explorer}${receipt.hash}`,
    };
  } catch (e: any) {
    log(`[ANCHOR] Merkle anchor failed: ${e.message?.substring(0, 100)}`, "onchain");
    return { success: false, error: e.message?.substring(0, 100) };
  }
}

export function isIPFSConfigured(): boolean {
  return !!PINATA_JWT;
}

export function isAnchoringConfigured(): boolean {
  return !!DEPLOYER_KEY;
}

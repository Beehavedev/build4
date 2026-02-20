import { ethers } from "ethers";
import { log } from "./index";
import * as fs from "fs";
import * as path from "path";

const HUB_ABI = [
  "function registerAgent(uint256 agentId) external",
  "function deposit(uint256 agentId) external payable",
  "function withdraw(uint256 agentId, uint256 amount, address to) external",
  "function transfer(uint256 fromAgentId, uint256 toAgentId, uint256 amount) external",
  "function getBalance(uint256 agentId) view returns (uint256)",
  "function isAgentRegistered(uint256 agentId) view returns (bool)",
  "function authorizedModules(address) view returns (bool)",
];

const MARKETPLACE_ABI = [
  "function listSkill(uint256 agentId, string name, string uri, uint256 price) external returns (uint256)",
  "function purchaseSkill(uint256 buyerAgentId, uint256 skillId) external",
  "function agentOwnsSkill(uint256 agentId, uint256 skillId) view returns (bool)",
  "function nextSkillId() view returns (uint256)",
];

const REPLICATION_ABI = [
  "function replicate(uint256 parentId, uint256 childId, uint256 revenueShareBps, uint256 fundingAmount) external",
  "function getParent(uint256 childId) view returns (uint256, uint256, bool)",
  "function agentGeneration(uint256 agentId) view returns (uint256)",
];

const CONSTITUTION_ABI = [
  "function addLaw(uint256 agentId, bytes32 lawHash, bool immutable_) external returns (uint256)",
  "function sealConstitution(uint256 agentId) external",
  "function getLawCount(uint256 agentId) view returns (uint256)",
  "function isSealed(uint256 agentId) view returns (bool)",
];

interface ContractAddresses {
  AgentEconomyHub: string;
  SkillMarketplace: string;
  AgentReplication: string;
  ConstitutionRegistry: string;
}

interface OnchainResult {
  success: boolean;
  txHash?: string;
  error?: string;
  chainId: number;
}

let provider: ethers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;
let contracts: {
  hub: ethers.Contract;
  marketplace: ethers.Contract;
  replication: ethers.Contract;
  constitution: ethers.Contract;
} | null = null;
let addresses: ContractAddresses | null = null;
let initialized = false;
let chainId = 97;

export function initOnchain(): boolean {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    log("[onchain] No DEPLOYER_PRIVATE_KEY - on-chain disabled", "onchain");
    return false;
  }

  try {
    const deploymentPath = path.resolve("contracts/deployments/bnbTestnet.json");
    if (!fs.existsSync(deploymentPath)) {
      log("[onchain] No BNB Testnet deployment found", "onchain");
      return false;
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
    addresses = deployment.contracts as ContractAddresses;
    chainId = deployment.chainId || 97;

    provider = new ethers.JsonRpcProvider("https://data-seed-prebsc-1-s1.binance.org:8545");
    wallet = new ethers.Wallet(privateKey, provider);

    contracts = {
      hub: new ethers.Contract(addresses.AgentEconomyHub, HUB_ABI, wallet),
      marketplace: new ethers.Contract(addresses.SkillMarketplace, MARKETPLACE_ABI, wallet),
      replication: new ethers.Contract(addresses.AgentReplication, REPLICATION_ABI, wallet),
      constitution: new ethers.Contract(addresses.ConstitutionRegistry, CONSTITUTION_ABI, wallet),
    };

    initialized = true;
    log(`[onchain] Connected to BNB Testnet (chain ${chainId}). Hub: ${addresses.AgentEconomyHub}`, "onchain");
    return true;
  } catch (e: any) {
    log(`[onchain] Init failed: ${e.message}`, "onchain");
    return false;
  }
}

export function isOnchainReady(): boolean {
  return initialized && !!contracts;
}

export function getChainId(): number {
  return chainId;
}

function uuidToNumericId(uuid: string): bigint {
  const hex = uuid.replace(/-/g, "");
  const truncated = hex.substring(0, 16);
  return BigInt("0x" + truncated);
}

export function getOnchainId(agentDbId: string): string {
  return uuidToNumericId(agentDbId).toString();
}

async function sendTx(contract: ethers.Contract, method: string, args: any[], overrides: any = {}): Promise<OnchainResult> {
  if (!initialized || !contracts) {
    return { success: false, error: "On-chain not initialized", chainId };
  }

  try {
    const gasLimit = overrides.gasLimit || 300000;
    const txOverrides = { ...overrides, gasLimit };

    const tx = await contract[method](...args, txOverrides);
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      return { success: false, error: "Transaction reverted", chainId, txHash: receipt.hash };
    }

    log(`[onchain] ${method} tx: ${receipt.hash}`, "onchain");
    return { success: true, txHash: receipt.hash, chainId };
  } catch (e: any) {
    const msg = e.message?.substring(0, 200) || "Unknown error";
    log(`[onchain] ${method} failed: ${msg}`, "onchain");
    return { success: false, error: msg, chainId };
  }
}

export async function registerAgentOnchain(agentDbId: string): Promise<OnchainResult> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const numId = uuidToNumericId(agentDbId);

  try {
    const isRegistered = await contracts.hub.isAgentRegistered(numId);
    if (isRegistered) {
      return { success: true, txHash: "already-registered", chainId };
    }
  } catch {}

  return sendTx(contracts.hub, "registerAgent", [numId]);
}

export async function depositOnchain(agentDbId: string, amountWei: string): Promise<OnchainResult> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const numId = uuidToNumericId(agentDbId);

  try {
    const isRegistered = await contracts.hub.isAgentRegistered(numId);
    if (!isRegistered) {
      const regResult = await sendTx(contracts.hub, "registerAgent", [numId]);
      if (!regResult.success) return regResult;
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch {}

  const depositAmount = BigInt(amountWei) > BigInt("10000000000000000")
    ? BigInt("10000000000000000")
    : BigInt(amountWei);

  return sendTx(contracts.hub, "deposit", [numId], { value: depositAmount });
}

export async function transferOnchain(fromAgentId: string, toAgentId: string, amountWei: string): Promise<OnchainResult> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const fromNum = uuidToNumericId(fromAgentId);
  const toNum = uuidToNumericId(toAgentId);

  try {
    const fromBal = await contracts.hub.getBalance(fromNum);
    if (fromBal === 0n) {
      return { success: false, error: "No on-chain balance to transfer", chainId };
    }
    const transferAmt = fromBal < BigInt(amountWei) ? fromBal / 2n : BigInt(amountWei);
    if (transferAmt === 0n) {
      return { success: false, error: "Zero transfer amount", chainId };
    }

    const toRegistered = await contracts.hub.isAgentRegistered(toNum);
    if (!toRegistered) {
      const regResult = await sendTx(contracts.hub, "registerAgent", [toNum]);
      if (!regResult.success) return regResult;
      await new Promise(r => setTimeout(r, 2000));
    }

    return sendTx(contracts.hub, "transfer", [fromNum, toNum, transferAmt]);
  } catch (e: any) {
    return { success: false, error: e.message?.substring(0, 200), chainId };
  }
}

export async function listSkillOnchain(agentDbId: string, skillName: string, price: string): Promise<OnchainResult & { skillId?: string }> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const numId = uuidToNumericId(agentDbId);
  const skillPrice = BigInt(price) > BigInt("100000000000000000")
    ? BigInt("1000000000000000")
    : BigInt(price);

  try {
    const nextId = await contracts.marketplace.nextSkillId();
    const result = await sendTx(contracts.marketplace, "listSkill", [
      numId,
      skillName.substring(0, 50),
      `ipfs://build4-skill-${Date.now()}`,
      skillPrice,
    ]);
    return { ...result, skillId: nextId.toString() };
  } catch (e: any) {
    return { success: false, error: e.message?.substring(0, 200), chainId };
  }
}

export async function purchaseSkillOnchain(buyerAgentId: string, onchainSkillId: string): Promise<OnchainResult> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const buyerNum = uuidToNumericId(buyerAgentId);
  return sendTx(contracts.marketplace, "purchaseSkill", [buyerNum, BigInt(onchainSkillId)]);
}

export async function replicateOnchain(parentAgentId: string, childAgentId: string, revenueShareBps: number, fundingWei: string): Promise<OnchainResult> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const parentNum = uuidToNumericId(parentAgentId);
  const childNum = uuidToNumericId(childAgentId);

  const fundingAmt = BigInt(fundingWei) > BigInt("10000000000000000")
    ? BigInt("5000000000000000")
    : BigInt(fundingWei);

  try {
    const parentBal = await contracts.hub.getBalance(parentNum);
    if (parentBal < fundingAmt) {
      return { success: false, error: "Insufficient on-chain balance for replication", chainId };
    }
  } catch {}

  return sendTx(contracts.replication, "replicate", [parentNum, childNum, revenueShareBps, fundingAmt]);
}

export async function addConstitutionLawOnchain(agentDbId: string, lawText: string, isImmutable: boolean): Promise<OnchainResult> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const numId = uuidToNumericId(agentDbId);
  const lawHash = ethers.keccak256(ethers.toUtf8Bytes(lawText));

  try {
    const isSealed = await contracts.constitution.isSealed(numId);
    if (isSealed) {
      return { success: false, error: "Constitution already sealed", chainId };
    }
  } catch {}

  return sendTx(contracts.constitution, "addLaw", [numId, lawHash, isImmutable]);
}

export async function getOnchainBalance(agentDbId: string): Promise<string> {
  if (!contracts) return "0";
  const numId = uuidToNumericId(agentDbId);
  try {
    const bal = await contracts.hub.getBalance(numId);
    return bal.toString();
  } catch {
    return "0";
  }
}

export async function getDeployerBalance(): Promise<string> {
  if (!provider || !wallet) return "0";
  try {
    const bal = await provider.getBalance(wallet.address);
    return ethers.formatEther(bal);
  } catch {
    return "0";
  }
}

export function getContractAddresses(): ContractAddresses | null {
  return addresses;
}

export function getExplorerUrl(txHash: string): string {
  return `https://testnet.bscscan.com/tx/${txHash}`;
}

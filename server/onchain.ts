import { ethers } from "ethers";
import { log } from "./index";
import * as fs from "fs";
import * as path from "path";

const PLATFORM_REVENUE_WALLET = "0x5Ff57464152c9285A8526a0665d996dA66e2def1";

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
  gasCostWei?: string;
}

interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerBase: string;
  deploymentFile: string;
  isMainnet: boolean;
}

const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  bnbTestnet: {
    name: "BNB Testnet",
    chainId: 97,
    rpcUrl: "https://data-seed-prebsc-1-s1.binance.org:8545",
    explorerBase: "https://testnet.bscscan.com",
    deploymentFile: "contracts/deployments/bnbTestnet.json",
    isMainnet: false,
  },
  bnbMainnet: {
    name: "BNB Chain",
    chainId: 56,
    rpcUrl: "https://bsc-dataseed1.binance.org",
    explorerBase: "https://bscscan.com",
    deploymentFile: "contracts/deployments/bnbMainnet.json",
    isMainnet: true,
  },
  baseMainnet: {
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    explorerBase: "https://basescan.org",
    deploymentFile: "contracts/deployments/baseMainnet.json",
    isMainnet: true,
  },
  baseTestnet: {
    name: "Base Sepolia",
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    explorerBase: "https://sepolia.basescan.org",
    deploymentFile: "contracts/deployments/baseTestnet.json",
    isMainnet: false,
  },
  xlayerMainnet: {
    name: "XLayer",
    chainId: 196,
    rpcUrl: "https://rpc.xlayer.tech",
    explorerBase: "https://www.okx.com/web3/explorer/xlayer",
    deploymentFile: "contracts/deployments/xlayerMainnet.json",
    isMainnet: true,
  },
  xlayerTestnet: {
    name: "XLayer Testnet",
    chainId: 195,
    rpcUrl: "https://testrpc.xlayer.tech",
    explorerBase: "https://www.okx.com/web3/explorer/xlayer-test",
    deploymentFile: "contracts/deployments/xlayerTestnet.json",
    isMainnet: false,
  },
};

const MAINNET_SAFETY = {
  maxSpendPerHourWei: BigInt("50000000000000000"),
  maxDepositPerAgentWei: BigInt("5000000000000000"),
  minDeployerBalanceWei: BigInt("10000000000000000"),
  maxTxPerHour: 60,
  maxConcurrentPending: 3,
};

const TESTNET_SAFETY = {
  maxSpendPerHourWei: BigInt("500000000000000000"),
  maxDepositPerAgentWei: BigInt("10000000000000000"),
  minDeployerBalanceWei: BigInt("1000000000000000"),
  maxTxPerHour: 200,
  maxConcurrentPending: 5,
};

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
let activeChainConfig: ChainConfig | null = null;

let spendThisHour = BigInt(0);
let txCountThisHour = 0;
let hourResetTime = Date.now() + 3600_000;
let circuitBreakerTripped = false;
let pendingTxCount = 0;

let nonceLock = false;
let managedNonce = -1;

function getSafetyLimits() {
  return activeChainConfig?.isMainnet ? MAINNET_SAFETY : TESTNET_SAFETY;
}

function resetHourlyCounters() {
  if (Date.now() > hourResetTime) {
    spendThisHour = BigInt(0);
    txCountThisHour = 0;
    hourResetTime = Date.now() + 3600_000;
    if (circuitBreakerTripped) {
      log("[onchain] Circuit breaker reset after hourly window", "onchain");
      circuitBreakerTripped = false;
    }
  }
}

function checkSpendingLimits(additionalSpendWei: bigint): string | null {
  resetHourlyCounters();
  const limits = getSafetyLimits();

  if (circuitBreakerTripped) {
    return "Circuit breaker tripped - spending paused until next hour";
  }

  if (txCountThisHour >= limits.maxTxPerHour) {
    return `Hourly tx limit reached (${limits.maxTxPerHour})`;
  }

  if (spendThisHour + additionalSpendWei > limits.maxSpendPerHourWei) {
    circuitBreakerTripped = true;
    const spentStr = ethers.formatEther(spendThisHour);
    const limitStr = ethers.formatEther(limits.maxSpendPerHourWei);
    log(`[onchain] CIRCUIT BREAKER: Hourly spend ${spentStr} would exceed limit ${limitStr}`, "onchain");
    return `Hourly spending limit would be exceeded (${spentStr}/${limitStr})`;
  }

  if (pendingTxCount >= limits.maxConcurrentPending) {
    return `Too many pending transactions (${pendingTxCount})`;
  }

  return null;
}

function recordSpend(weiAmount: bigint) {
  spendThisHour += weiAmount;
  txCountThisHour++;
}

export function initOnchain(): boolean {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    log("[onchain] No DEPLOYER_PRIVATE_KEY - on-chain disabled", "onchain");
    return false;
  }

  const targetChain = process.env.ONCHAIN_NETWORK || "bnbMainnet";
  const config = CHAIN_CONFIGS[targetChain];
  if (!config) {
    log(`[onchain] Unknown network: ${targetChain}`, "onchain");
    return false;
  }

  try {
    const deploymentPath = path.resolve(config.deploymentFile);
    if (!fs.existsSync(deploymentPath)) {
      log(`[onchain] No deployment found at ${config.deploymentFile}`, "onchain");
      return false;
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
    addresses = deployment.contracts as ContractAddresses;
    chainId = deployment.chainId || config.chainId;
    activeChainConfig = config;

    provider = new ethers.JsonRpcProvider(config.rpcUrl);
    wallet = new ethers.Wallet(privateKey, provider);

    contracts = {
      hub: new ethers.Contract(addresses.AgentEconomyHub, HUB_ABI, wallet),
      marketplace: new ethers.Contract(addresses.SkillMarketplace, MARKETPLACE_ABI, wallet),
      replication: new ethers.Contract(addresses.AgentReplication, REPLICATION_ABI, wallet),
      constitution: new ethers.Contract(addresses.ConstitutionRegistry, CONSTITUTION_ABI, wallet),
    };

    initialized = true;
    const modeLabel = config.isMainnet ? "MAINNET" : "TESTNET";
    log(`[onchain] Connected to ${config.name} (chain ${chainId}) [${modeLabel}]. Hub: ${addresses.AgentEconomyHub}`, "onchain");

    if (config.isMainnet) {
      const limits = MAINNET_SAFETY;
      log(`[onchain] MAINNET SAFETY: max ${ethers.formatEther(limits.maxSpendPerHourWei)} BNB/hr, ${limits.maxTxPerHour} tx/hr, min deployer balance ${ethers.formatEther(limits.minDeployerBalanceWei)} BNB`, "onchain");
    }

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

export function getNetworkName(): string {
  return activeChainConfig?.name || "Unknown";
}

export function isMainnet(): boolean {
  return activeChainConfig?.isMainnet || false;
}

function uuidToNumericId(uuid: string): bigint {
  const hex = uuid.replace(/-/g, "");
  const truncated = hex.substring(0, 16);
  return BigInt("0x" + truncated);
}

export function getOnchainId(agentDbId: string): string {
  return uuidToNumericId(agentDbId).toString();
}

async function acquireNonce(): Promise<number> {
  while (nonceLock) {
    await new Promise(r => setTimeout(r, 100));
  }
  nonceLock = true;
  try {
    if (managedNonce === -1) {
      managedNonce = await provider!.getTransactionCount(wallet!.address, "pending");
    }
    const nonce = managedNonce;
    managedNonce++;
    return nonce;
  } finally {
    nonceLock = false;
  }
}

function resetNonce() {
  managedNonce = -1;
}

async function checkDeployerBalance(): Promise<boolean> {
  if (!provider || !wallet) return false;
  try {
    const bal = await provider.getBalance(wallet.address);
    const limits = getSafetyLimits();
    if (bal < limits.minDeployerBalanceWei) {
      const balStr = ethers.formatEther(bal);
      const minStr = ethers.formatEther(limits.minDeployerBalanceWei);
      log(`[onchain] DEPLOYER BALANCE LOW: ${balStr} BNB (minimum: ${minStr} BNB)`, "onchain");
      if (activeChainConfig?.isMainnet) {
        circuitBreakerTripped = true;
        log("[onchain] CIRCUIT BREAKER TRIPPED: Deployer balance below minimum on mainnet", "onchain");
        return false;
      }
    }
    return true;
  } catch (e: any) {
    log(`[onchain] Balance check RPC error: ${e.message?.substring(0, 100)}`, "onchain");
    if (activeChainConfig?.isMainnet) {
      log("[onchain] Failing safe on mainnet - blocking tx due to RPC error", "onchain");
      return false;
    }
    return true;
  }
}

async function estimateRealGasCost(gasLimit: number): Promise<bigint> {
  if (!provider) return BigInt(gasLimit) * BigInt("100000000");
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || BigInt("100000000");
    return BigInt(gasLimit) * gasPrice;
  } catch {
    return BigInt(gasLimit) * BigInt("5000000000");
  }
}

async function sendTx(contract: ethers.Contract, method: string, args: any[], overrides: any = {}): Promise<OnchainResult> {
  if (!initialized || !contracts || !provider || !wallet) {
    return { success: false, error: "On-chain not initialized", chainId };
  }

  const gasLimit = overrides.gasLimit || 300000;
  const valueWei = overrides.value ? BigInt(overrides.value.toString()) : BigInt(0);
  const estimatedGas = await estimateRealGasCost(gasLimit);
  const totalCost = valueWei + estimatedGas;

  recordSpend(totalCost);

  const limitError = checkSpendingLimits(BigInt(0));
  if (limitError) {
    spendThisHour -= totalCost;
    txCountThisHour--;
    log(`[onchain] ${method} blocked: ${limitError}`, "onchain");
    return { success: false, error: limitError, chainId };
  }

  const balanceOk = await checkDeployerBalance();
  if (!balanceOk) {
    spendThisHour -= totalCost;
    txCountThisHour--;
    return { success: false, error: "Deployer balance too low", chainId };
  }

  pendingTxCount++;
  try {
    const nonce = await acquireNonce();
    const txOverrides = { ...overrides, gasLimit, nonce };

    const tx = await contract[method](...args, txOverrides);

    const receiptPromise = tx.wait();
    const timeoutPromise = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error("Transaction confirmation timeout (90s)")), 90_000)
    );

    const receipt = await Promise.race([receiptPromise, timeoutPromise]);

    if (!receipt || receipt.status !== 1) {
      resetNonce();
      return { success: false, error: "Transaction reverted", chainId, txHash: receipt?.hash };
    }

    const gasCostWei = (receipt.gasUsed * (receipt.gasPrice || BigInt("5000000000"))).toString();
    log(`[onchain] ${method} tx: ${receipt.hash} (gas: ${gasCostWei} wei)`, "onchain");
    return { success: true, txHash: receipt.hash, chainId, gasCostWei };
  } catch (e: any) {
    resetNonce();
    const msg = e.message?.substring(0, 200) || "Unknown error";
    log(`[onchain] ${method} failed: ${msg}`, "onchain");

    if (msg.includes("nonce") || msg.includes("replacement")) {
      log("[onchain] Nonce conflict detected, resetting managed nonce", "onchain");
    }

    return { success: false, error: msg, chainId };
  } finally {
    pendingTxCount--;
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
  } catch (e: any) {
    log(`[onchain] isAgentRegistered check failed: ${e.message?.substring(0, 100)}`, "onchain");
  }

  return sendTx(contracts.hub, "registerAgent", [numId]);
}

export async function depositOnchain(agentDbId: string, amountWei: string): Promise<OnchainResult> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const numId = uuidToNumericId(agentDbId);
  const limits = getSafetyLimits();

  try {
    const isRegistered = await contracts.hub.isAgentRegistered(numId);
    if (!isRegistered) {
      const regResult = await sendTx(contracts.hub, "registerAgent", [numId]);
      if (!regResult.success) return regResult;
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e: any) {
    log(`[onchain] deposit registration check failed: ${e.message?.substring(0, 100)}`, "onchain");
  }

  let depositAmount = BigInt(amountWei);
  if (depositAmount > limits.maxDepositPerAgentWei) {
    depositAmount = limits.maxDepositPerAgentWei;
  }

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
    const requestedAmt = BigInt(amountWei);
    if (fromBal < requestedAmt) {
      return { success: false, error: `Insufficient on-chain balance: has ${ethers.formatEther(fromBal)}, needs ${ethers.formatEther(requestedAmt)}`, chainId };
    }
    if (requestedAmt === 0n) {
      return { success: false, error: "Zero transfer amount", chainId };
    }

    const toRegistered = await contracts.hub.isAgentRegistered(toNum);
    if (!toRegistered) {
      const regResult = await sendTx(contracts.hub, "registerAgent", [toNum]);
      if (!regResult.success) return regResult;
      await new Promise(r => setTimeout(r, 2000));
    }

    return sendTx(contracts.hub, "transfer", [fromNum, toNum, requestedAmt]);
  } catch (e: any) {
    return { success: false, error: e.message?.substring(0, 200), chainId };
  }
}

export async function withdrawOnchain(agentDbId: string, amountWei: string, toAddress: string): Promise<OnchainResult> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const numId = uuidToNumericId(agentDbId);

  try {
    const onchainBal = await contracts.hub.getBalance(numId);
    if (onchainBal === 0n) {
      return { success: false, error: "No on-chain balance to withdraw", chainId };
    }
    const requestedAmt = BigInt(amountWei);
    if (requestedAmt === 0n) {
      return { success: false, error: "Zero withdrawal amount", chainId };
    }
    if (onchainBal < requestedAmt) {
      return { success: false, error: `Insufficient on-chain balance: has ${ethers.formatEther(onchainBal)}, needs ${ethers.formatEther(requestedAmt)}`, chainId };
    }

    return sendTx(contracts.hub, "withdraw", [numId, requestedAmt, toAddress], { gasLimit: 150000 });
  } catch (e: any) {
    return { success: false, error: e.message?.substring(0, 200), chainId };
  }
}

export async function listSkillOnchain(agentDbId: string, skillName: string, price: string): Promise<OnchainResult & { skillId?: string }> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const numId = uuidToNumericId(agentDbId);
  const skillPrice = BigInt(price);

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

  const limits = getSafetyLimits();
  let fundingAmt = BigInt(fundingWei);
  if (fundingAmt > limits.maxDepositPerAgentWei) {
    fundingAmt = limits.maxDepositPerAgentWei;
  }

  try {
    const parentBal = await contracts.hub.getBalance(parentNum);
    if (parentBal < fundingAmt) {
      return { success: false, error: "Insufficient on-chain balance for replication", chainId };
    }
  } catch (e: any) {
    log(`[onchain] replicate balance check failed: ${e.message?.substring(0, 100)}`, "onchain");
  }

  return sendTx(contracts.replication, "replicate", [parentNum, childNum, revenueShareBps, fundingAmt]);
}

export async function addConstitutionLawOnchain(agentDbId: string, lawText: string, isImmutable: boolean): Promise<OnchainResult> {
  if (!contracts) return { success: false, error: "Not initialized", chainId };

  const numId = uuidToNumericId(agentDbId);
  const lawHash = ethers.keccak256(ethers.toUtf8Bytes(lawText));

  try {
    const sealed = await contracts.constitution.isSealed(numId);
    if (sealed) {
      return { success: false, error: "Constitution already sealed", chainId };
    }
  } catch (e: any) {
    log(`[onchain] constitution seal check failed: ${e.message?.substring(0, 100)}`, "onchain");
  }

  return sendTx(contracts.constitution, "addLaw", [numId, lawHash, isImmutable]);
}

export async function collectFeeOnchain(agentDbId: string, feeAmountWei: string, feeType: string): Promise<OnchainResult> {
  if (!contracts || !wallet) return { success: false, error: "Not initialized", chainId };

  const numId = uuidToNumericId(agentDbId);
  const feeAmount = BigInt(feeAmountWei);

  if (feeAmount === 0n) {
    return { success: false, error: "Zero fee amount", chainId };
  }

  try {
    const onchainBal = await contracts.hub.getBalance(numId);
    if (onchainBal < feeAmount) {
      log(`[onchain] collectFee(${feeType}): Agent on-chain balance ${onchainBal.toString()} < fee ${feeAmountWei}`, "onchain");
      return { success: false, error: `Insufficient on-chain balance for ${feeType} fee`, chainId };
    }
  } catch (e: any) {
    log(`[onchain] collectFee balance check failed: ${e.message?.substring(0, 100)}`, "onchain");
    return { success: false, error: `Balance check failed: ${e.message?.substring(0, 80)}`, chainId };
  }

  const result = await sendTx(contracts.hub, "withdraw", [numId, feeAmount, PLATFORM_REVENUE_WALLET], { gasLimit: 150000 });
  if (result.success) {
    log(`[onchain] Fee collected (${feeType}): ${feeAmountWei} wei from agent ${agentDbId.substring(0, 8)} -> revenue wallet ${PLATFORM_REVENUE_WALLET.substring(0, 10)}. TX: ${result.txHash}`, "onchain");
  }
  return result;
}

export async function collectFeeOnchainMultiChain(agentDbId: string, chainKey: string, feeAmountWei: string, feeType: string): Promise<OnchainResult> {
  if (multiChainConnections.size === 0) initMultiChain();
  const conn = multiChainConnections.get(chainKey);
  if (!conn) return { success: false, error: `Chain ${chainKey} not available`, chainId: 0 };

  const numId = uuidToNumericId(agentDbId);
  const feeAmount = BigInt(feeAmountWei);

  if (feeAmount === 0n) {
    return { success: false, error: "Zero fee amount", chainId: conn.chainId };
  }

  try {
    const onchainBal = await conn.hub.getBalance(numId);
    if (onchainBal < feeAmount) {
      return { success: false, error: `Insufficient balance on ${conn.name}`, chainId: conn.chainId };
    }
  } catch (e: any) {
    return { success: false, error: `Balance check failed on ${conn.name}`, chainId: conn.chainId };
  }

  const result = await multiChainSendTx(conn, conn.hub, "withdraw", [numId, feeAmount, PLATFORM_REVENUE_WALLET], { gasLimit: 150000 });
  if (result.success) {
    log(`[onchain] ${conn.name} fee collected (${feeType}): ${feeAmountWei} wei from agent ${agentDbId.substring(0, 8)} -> revenue wallet. TX: ${result.txHash}`, "onchain");
  }
  return result;
}

export async function collectFeeAcrossAllChains(agentDbId: string, feeAmountWei: string, feeType: string, preferredChain?: string): Promise<OnchainResult> {
  if (multiChainConnections.size === 0) initMultiChain();

  if (preferredChain && preferredChain !== "bnbMainnet") {
    const preferredResult = await collectFeeOnchainMultiChain(agentDbId, preferredChain, feeAmountWei, feeType);
    if (preferredResult.success) return preferredResult;
  }

  const primaryResult = await collectFeeOnchain(agentDbId, feeAmountWei, feeType);
  if (primaryResult.success) return primaryResult;

  for (const [chainKey] of multiChainConnections) {
    if (chainKey === preferredChain) continue;
    const result = await collectFeeOnchainMultiChain(agentDbId, chainKey, feeAmountWei, feeType);
    if (result.success) return result;
  }

  return primaryResult;
}

const pendingGasReimbursements = new Map<string, { total: bigint; actions: string[] }>();
const MIN_BATCH_REIMBURSE_WEI = BigInt("10000000000000");

export function accumulateGasReimbursement(agentDbId: string, gasCostWei: string, actionType: string): void {
  const gasCost = BigInt(gasCostWei);
  if (gasCost === 0n) return;

  const existing = pendingGasReimbursements.get(agentDbId);
  if (existing) {
    existing.total += gasCost;
    existing.actions.push(actionType);
  } else {
    pendingGasReimbursements.set(agentDbId, { total: gasCost, actions: [actionType] });
  }
}

export function getPendingReimbursementCount(): number {
  return pendingGasReimbursements.size;
}

export function getPendingReimbursementTotal(): bigint {
  let total = 0n;
  for (const entry of pendingGasReimbursements.values()) {
    total += entry.total;
  }
  return total;
}

export interface BatchReimbursementEntry {
  agentId: string;
  amountWei: bigint;
  txHash: string;
  chainId: number;
  actionCount: number;
  actions: string[];
}

export async function flushGasReimbursements(): Promise<{ settled: number; totalWei: bigint; entries: BatchReimbursementEntry[] }> {
  if (!contracts || !wallet) return { settled: 0, totalWei: 0n, entries: [] };
  if (pendingGasReimbursements.size === 0) return { settled: 0, totalWei: 0n, entries: [] };

  const snapshot = Array.from(pendingGasReimbursements.entries());
  pendingGasReimbursements.clear();

  let settled = 0;
  let totalSettled = 0n;
  const settledEntries: BatchReimbursementEntry[] = [];
  const activeChainId = chainId;

  for (const [agentDbId, { total, actions }] of snapshot) {
    if (total < MIN_BATCH_REIMBURSE_WEI) {
      pendingGasReimbursements.set(agentDbId, { total, actions });
      continue;
    }

    const numId = uuidToNumericId(agentDbId);
    let withdrawAmount = total;

    try {
      const onchainBal = await contracts.hub.getBalance(numId);
      if (onchainBal === 0n) {
        log(`[onchain] Batch reimburse skipped: Agent ${agentDbId.substring(0, 8)} has zero balance (owed ${total.toString()} wei for ${actions.length} actions)`, "onchain");
        continue;
      }
      if (onchainBal < total) {
        withdrawAmount = onchainBal;
      }
    } catch (e: any) {
      pendingGasReimbursements.set(agentDbId, { total, actions });
      continue;
    }

    const result = await sendTx(contracts.hub, "withdraw", [numId, withdrawAmount, wallet.address], { gasLimit: 150000 });
    if (result.success && result.txHash) {
      const bnbAmount = (Number(withdrawAmount) / 1e18).toFixed(8);
      log(`[onchain] Batch gas reimbursed: ${bnbAmount} BNB from agent ${agentDbId.substring(0, 8)} (${actions.length} actions: ${actions.join(", ")}). TX: ${result.txHash}`, "onchain");
      settled++;
      totalSettled += withdrawAmount;
      settledEntries.push({
        agentId: agentDbId,
        amountWei: withdrawAmount,
        txHash: result.txHash,
        chainId: activeChainId,
        actionCount: actions.length,
        actions,
      });
    } else {
      pendingGasReimbursements.set(agentDbId, { total, actions });
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (settled > 0) {
    const totalBnb = (Number(totalSettled) / 1e18).toFixed(8);
    log(`[onchain] Batch reimbursement complete: ${settled} agents settled, ${totalBnb} BNB recovered`, "onchain");
  }

  return { settled, totalWei: totalSettled, entries: settledEntries };
}

export async function reimburseGasCost(agentDbId: string, gasCostWei: string, actionType: string): Promise<OnchainResult> {
  accumulateGasReimbursement(agentDbId, gasCostWei, actionType);
  return { success: true, txHash: "batched", chainId, gasCostWei };
}

export async function reimburseGasCostMultiChain(agentDbId: string, _chainKey: string, gasCostWei: string, actionType: string): Promise<OnchainResult> {
  accumulateGasReimbursement(agentDbId, gasCostWei, actionType);
  return { success: true, txHash: "batched", chainId, gasCostWei };
}

export async function verifyOnchainBalance(agentDbId: string): Promise<{ balance: string; registered: boolean }> {
  if (!contracts) return { balance: "0", registered: false };
  const numId = uuidToNumericId(agentDbId);
  try {
    const registered = await contracts.hub.isAgentRegistered(numId);
    if (!registered) return { balance: "0", registered: false };
    const bal = await contracts.hub.getBalance(numId);
    return { balance: bal.toString(), registered: true };
  } catch {
    return { balance: "0", registered: false };
  }
}

export function getDeployerAddress(): string {
  return wallet?.address || "";
}

export function getRevenueWalletAddress(): string {
  return PLATFORM_REVENUE_WALLET;
}

export async function verifyPaymentTransaction(txHash: string, expectedMinAmountWei: string, chainId?: number): Promise<{ verified: boolean; amount: string; from: string; error?: string }> {
  try {
    let prov = provider;
    if (chainId) {
      for (const [, conn] of multiChainConnections) {
        if (conn.chainId === chainId) {
          prov = conn.provider;
          break;
        }
      }
    }
    if (!prov) {
      return { verified: false, amount: "0", from: "", error: "No provider available for chain" };
    }

    const tx = await prov.getTransaction(txHash);
    if (!tx) {
      return { verified: false, amount: "0", from: "", error: "Transaction not found" };
    }

    const receipt = await prov.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      return { verified: false, amount: "0", from: tx.from, error: "Transaction failed or not confirmed" };
    }

    const toAddress = tx.to?.toLowerCase();
    if (toAddress !== PLATFORM_REVENUE_WALLET.toLowerCase()) {
      return { verified: false, amount: tx.value.toString(), from: tx.from, error: `Payment sent to wrong address: ${tx.to}` };
    }

    if (BigInt(tx.value) < BigInt(expectedMinAmountWei)) {
      return { verified: false, amount: tx.value.toString(), from: tx.from, error: `Insufficient payment: sent ${tx.value}, required ${expectedMinAmountWei}` };
    }

    return { verified: true, amount: tx.value.toString(), from: tx.from };
  } catch (e: any) {
    return { verified: false, amount: "0", from: "", error: e.message?.substring(0, 200) };
  }
}

export function getSupportedChains(): Array<{ chainId: number; name: string }> {
  const chains: Array<{ chainId: number; name: string }> = [];
  if (chainId) chains.push({ chainId, name: getNetworkName() });
  for (const [, conn] of multiChainConnections) {
    if (!chains.some(c => c.chainId === conn.chainId)) {
      chains.push({ chainId: conn.chainId, name: conn.name });
    }
  }
  return chains;
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
  const base = activeChainConfig?.explorerBase || "https://bscscan.com";
  return `${base}/tx/${txHash}`;
}

export function getSpendingStatus() {
  resetHourlyCounters();
  const limits = getSafetyLimits();
  return {
    spentThisHour: ethers.formatEther(spendThisHour),
    maxPerHour: ethers.formatEther(limits.maxSpendPerHourWei),
    txThisHour: txCountThisHour,
    maxTxPerHour: limits.maxTxPerHour,
    circuitBreakerTripped,
    isMainnet: activeChainConfig?.isMainnet || false,
    pendingTxCount,
  };
}

interface MultiChainConnection {
  name: string;
  chainId: number;
  explorerBase: string;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  hub: ethers.Contract;
  marketplace: ethers.Contract;
  replication: ethers.Contract;
  managedNonce: number;
  nonceLock: boolean;
}

const multiChainConnections: Map<string, MultiChainConnection> = new Map();

const MAINNET_CHAIN_KEYS = ["bnbMainnet", "baseMainnet", "xlayerMainnet"] as const;

export function initMultiChain(): string[] {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) return [];

  const initialized: string[] = [];

  for (const key of MAINNET_CHAIN_KEYS) {
    if (multiChainConnections.has(key)) {
      initialized.push(key);
      continue;
    }

    const config = CHAIN_CONFIGS[key];
    if (!config) continue;

    try {
      const deploymentPath = path.resolve(config.deploymentFile);
      if (!fs.existsSync(deploymentPath)) continue;

      const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
      const addrs = deployment.contracts as ContractAddresses;

      const prov = new ethers.JsonRpcProvider(config.rpcUrl);
      const w = new ethers.Wallet(privateKey, prov);
      const hub = new ethers.Contract(addrs.AgentEconomyHub, HUB_ABI, w);
      const marketplace = new ethers.Contract(addrs.SkillMarketplace, MARKETPLACE_ABI, w);
      const replication = new ethers.Contract(addrs.AgentReplication, REPLICATION_ABI, w);

      multiChainConnections.set(key, {
        name: config.name,
        chainId: config.chainId,
        explorerBase: config.explorerBase,
        provider: prov,
        wallet: w,
        hub,
        marketplace,
        replication,
        managedNonce: -1,
        nonceLock: false,
      });

      initialized.push(key);
      log(`[onchain] Multi-chain: connected to ${config.name} (${config.chainId}). Hub: ${addrs.AgentEconomyHub}`, "onchain");
    } catch (e: any) {
      log(`[onchain] Multi-chain: failed to connect ${config.name}: ${e.message?.substring(0, 100)}`, "onchain");
    }
  }

  return initialized;
}

async function multiChainAcquireNonce(conn: MultiChainConnection): Promise<number> {
  while (conn.nonceLock) {
    await new Promise(r => setTimeout(r, 100));
  }
  conn.nonceLock = true;
  try {
    if (conn.managedNonce === -1) {
      conn.managedNonce = await conn.provider.getTransactionCount(conn.wallet.address, "pending");
    }
    const nonce = conn.managedNonce;
    conn.managedNonce++;
    return nonce;
  } finally {
    conn.nonceLock = false;
  }
}

async function multiChainSendTx(
  conn: MultiChainConnection,
  contract: ethers.Contract,
  method: string,
  args: any[],
  overrides: any = {}
): Promise<OnchainResult> {
  const gasLimit = overrides.gasLimit || 300000;

  const limitError = checkSpendingLimits(BigInt(0));
  if (limitError) {
    return { success: false, error: limitError, chainId: conn.chainId };
  }

  try {
    const nonce = await multiChainAcquireNonce(conn);
    const txOverrides = { ...overrides, gasLimit, nonce };

    const tx = await contract[method](...args, txOverrides);
    const receipt = await Promise.race([
      tx.wait(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Timeout (90s)")), 90_000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      conn.managedNonce = -1;
      return { success: false, error: "Transaction reverted", chainId: conn.chainId, txHash: receipt?.hash };
    }

    const valueWei = overrides.value ? BigInt(overrides.value.toString()) : BigInt(0);
    const actualGasCost = receipt.gasUsed * (receipt.gasPrice || BigInt("5000000000"));
    recordSpend(valueWei + actualGasCost);
    txCountThisHour++;

    const gasCostWei = actualGasCost.toString();
    log(`[onchain] ${conn.name} ${method} tx: ${receipt.hash} (gas: ${gasCostWei} wei)`, "onchain");
    return { success: true, txHash: receipt.hash, chainId: conn.chainId, gasCostWei };
  } catch (e: any) {
    conn.managedNonce = -1;
    const msg = e.message?.substring(0, 200) || "Unknown error";
    log(`[onchain] ${conn.name} ${method} failed: ${msg}`, "onchain");
    return { success: false, error: msg, chainId: conn.chainId };
  }
}

export interface MultiChainResult {
  chainKey: string;
  chainName: string;
  chainId: number;
  registration: OnchainResult;
  deposit: OnchainResult | null;
  explorerUrl?: string;
}

export async function registerAndDepositOnChain(agentDbId: string, chainKey: string, depositAmountWei: string = "10000000000000000"): Promise<MultiChainResult> {
  if (multiChainConnections.size === 0) {
    initMultiChain();
  }

  const conn = multiChainConnections.get(chainKey);
  if (!conn) {
    return {
      chainKey,
      chainName: chainKey,
      chainId: 0,
      registration: { success: false, error: `Chain ${chainKey} not available`, chainId: 0 },
      deposit: null,
    };
  }

  const numId = uuidToNumericId(agentDbId);
  const result: MultiChainResult = {
    chainKey,
    chainName: conn.name,
    chainId: conn.chainId,
    registration: { success: false, error: "Not attempted", chainId: conn.chainId },
    deposit: null,
  };

  try {
    let isRegistered = false;
    try {
      isRegistered = await conn.hub.isAgentRegistered(numId);
    } catch (e: any) {
      log(`[onchain] ${conn.name}: registration check failed: ${e.message?.substring(0, 80)}`, "onchain");
    }

    if (isRegistered) {
      result.registration = { success: true, txHash: "already-registered", chainId: conn.chainId };
    } else {
      result.registration = await multiChainSendTx(conn, conn.hub, "registerAgent", [numId]);
      if (result.registration.success) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (result.registration.success) {
      let depositAmt = BigInt(depositAmountWei);
      if (depositAmt > MAINNET_SAFETY.maxDepositPerAgentWei) {
        depositAmt = MAINNET_SAFETY.maxDepositPerAgentWei;
      }

      result.deposit = await multiChainSendTx(conn, conn.hub, "deposit", [numId], { value: depositAmt });

      if (result.deposit?.success && result.deposit.txHash) {
        result.explorerUrl = `${conn.explorerBase}/tx/${result.deposit.txHash}`;
        log(`[onchain] ${conn.name}: Agent ${agentDbId.substring(0, 8)} deposited. TX: ${result.deposit.txHash}`, "onchain");
      }
    }
  } catch (e: any) {
    log(`[onchain] ${conn.name}: error for agent ${agentDbId.substring(0, 8)}: ${e.message?.substring(0, 100)}`, "onchain");
  }

  return result;
}

export async function registerAndDepositAllChains(agentDbId: string, depositAmountWei: string = "10000000000000000"): Promise<MultiChainResult[]> {
  if (multiChainConnections.size === 0) {
    initMultiChain();
  }

  const numId = uuidToNumericId(agentDbId);
  const results: MultiChainResult[] = [];

  for (const [key, conn] of multiChainConnections) {
    const result: MultiChainResult = {
      chainKey: key,
      chainName: conn.name,
      chainId: conn.chainId,
      registration: { success: false, error: "Not attempted", chainId: conn.chainId },
      deposit: null,
    };

    try {
      let isRegistered = false;
      try {
        isRegistered = await conn.hub.isAgentRegistered(numId);
      } catch (e: any) {
        log(`[onchain] ${conn.name}: registration check failed: ${e.message?.substring(0, 80)}`, "onchain");
      }

      if (isRegistered) {
        result.registration = { success: true, txHash: "already-registered", chainId: conn.chainId };
      } else {
        result.registration = await multiChainSendTx(conn, conn.hub, "registerAgent", [numId]);
        if (result.registration.success) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (result.registration.success) {
        let depositAmt = BigInt(depositAmountWei);
        if (depositAmt > MAINNET_SAFETY.maxDepositPerAgentWei) {
          depositAmt = MAINNET_SAFETY.maxDepositPerAgentWei;
        }

        result.deposit = await multiChainSendTx(conn, conn.hub, "deposit", [numId], { value: depositAmt });

        if (result.deposit?.success && result.deposit.txHash) {
          result.explorerUrl = `${conn.explorerBase}/tx/${result.deposit.txHash}`;
          log(`[onchain] ${conn.name}: Agent ${agentDbId.substring(0, 8)} deposited. TX: ${result.deposit.txHash}`, "onchain");
        }
      }
    } catch (e: any) {
      log(`[onchain] ${conn.name}: multi-chain error for agent ${agentDbId.substring(0, 8)}: ${e.message?.substring(0, 100)}`, "onchain");
    }

    results.push(result);
    await new Promise(r => setTimeout(r, 1000));
  }

  return results;
}

export async function registerAgentOnChain(agentDbId: string, chainKey: string): Promise<OnchainResult> {
  const conn = getMultiChainConn(chainKey);
  if (!conn) return registerAgentOnchain(agentDbId);

  const numId = uuidToNumericId(agentDbId);

  try {
    let isRegistered = false;
    try {
      isRegistered = await conn.hub.isAgentRegistered(numId);
    } catch {}
    if (isRegistered) {
      return { success: true, txHash: "already-registered", chainId: conn.chainId };
    }
    const result = await multiChainSendTx(conn, conn.hub, "registerAgent", [numId]);
    if (result.success) {
      log(`[onchain] ${conn.name}: Agent ${agentDbId.substring(0, 8)} registered. TX: ${result.txHash}`, "onchain");
    }
    return result;
  } catch (e: any) {
    log(`[onchain] ${conn.name}: registration failed for ${agentDbId.substring(0, 8)}: ${e.message?.substring(0, 100)}`, "onchain");
    return { success: false, error: e.message?.substring(0, 200), chainId: conn.chainId };
  }
}

export async function getMultiChainBalances(agentDbId: string): Promise<{ chainKey: string; chainName: string; chainId: number; balance: string; registered: boolean }[]> {
  if (multiChainConnections.size === 0) {
    initMultiChain();
  }

  const numId = uuidToNumericId(agentDbId);
  const balances: { chainKey: string; chainName: string; chainId: number; balance: string; registered: boolean }[] = [];

  for (const [key, conn] of multiChainConnections) {
    try {
      const registered = await conn.hub.isAgentRegistered(numId);
      if (!registered) {
        balances.push({ chainKey: key, chainName: conn.name, chainId: conn.chainId, balance: "0", registered: false });
        continue;
      }
      const bal = await conn.hub.getBalance(numId);
      balances.push({ chainKey: key, chainName: conn.name, chainId: conn.chainId, balance: bal.toString(), registered: true });
    } catch {
      balances.push({ chainKey: key, chainName: conn.name, chainId: conn.chainId, balance: "0", registered: false });
    }
  }

  return balances;
}

export function getMultiChainExplorerUrl(chainKey: string, txHash: string): string {
  const conn = multiChainConnections.get(chainKey);
  if (conn) return `${conn.explorerBase}/tx/${txHash}`;
  return `https://bscscan.com/tx/${txHash}`;
}

function getMultiChainConn(chainKey: string): MultiChainConnection | null {
  if (multiChainConnections.size === 0) initMultiChain();
  return multiChainConnections.get(chainKey) || null;
}

export function getChainCurrency(chainKey?: string): string {
  const key = chainKey || process.env.ONCHAIN_NETWORK || "bnbMainnet";
  if (key.startsWith("base")) return "ETH";
  if (key.startsWith("xlayer")) return "OKB";
  return "BNB";
}

export function getChainExplorerBase(chainKey?: string): string {
  const key = chainKey || process.env.ONCHAIN_NETWORK || "bnbMainnet";
  const conn = multiChainConnections.get(key);
  if (conn) return conn.explorerBase;
  const config = CHAIN_CONFIGS[key];
  return config?.explorerBase || "https://bscscan.com";
}

export async function transferOnChainRouted(fromAgentId: string, toAgentId: string, amountWei: string, chainKey: string): Promise<OnchainResult> {
  const conn = getMultiChainConn(chainKey);
  if (!conn) return transferOnchain(fromAgentId, toAgentId, amountWei);

  const fromNum = uuidToNumericId(fromAgentId);
  const toNum = uuidToNumericId(toAgentId);

  try {
    const fromBal = await conn.hub.getBalance(fromNum);
    if (fromBal === 0n) {
      return transferOnchain(fromAgentId, toAgentId, amountWei);
    }
    const requestedAmt = BigInt(amountWei);
    if (fromBal < requestedAmt) {
      return { success: false, error: `Insufficient on-chain balance on ${getChainLabel(chainKey)}: has ${ethers.formatEther(fromBal)}, needs ${ethers.formatEther(requestedAmt)}`, chainId: conn.chainId };
    }
    if (requestedAmt === 0n) {
      return { success: false, error: "Zero transfer amount", chainId: conn.chainId };
    }

    const toRegistered = await conn.hub.isAgentRegistered(toNum);
    if (!toRegistered) {
      const regResult = await multiChainSendTx(conn, conn.hub, "registerAgent", [toNum]);
      if (!regResult.success) return regResult;
      await new Promise(r => setTimeout(r, 2000));
    }

    return multiChainSendTx(conn, conn.hub, "transfer", [fromNum, toNum, requestedAmt]);
  } catch (e: any) {
    return transferOnchain(fromAgentId, toAgentId, amountWei);
  }
}

export async function listSkillOnChainRouted(agentDbId: string, skillName: string, price: string, chainKey: string): Promise<OnchainResult & { skillId?: string }> {
  const conn = getMultiChainConn(chainKey);
  if (!conn) return listSkillOnchain(agentDbId, skillName, price);

  const numId = uuidToNumericId(agentDbId);
  const skillPrice = BigInt(price);

  try {
    let isRegistered = false;
    try {
      isRegistered = await conn.hub.isAgentRegistered(numId);
    } catch {}
    if (!isRegistered) {
      const regResult = await multiChainSendTx(conn, conn.hub, "registerAgent", [numId]);
      if (!regResult.success) {
        log(`[onchain] ${getChainLabel(chainKey)} agent registration failed for listSkill: ${regResult.error}`, "onchain");
        return listSkillOnchain(agentDbId, skillName, price);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    const nextId = await conn.marketplace.nextSkillId();
    const result = await multiChainSendTx(conn, conn.marketplace, "listSkill", [
      numId,
      skillName.substring(0, 50),
      `ipfs://build4-skill-${Date.now()}`,
      skillPrice,
    ]);
    return { ...result, skillId: nextId.toString() };
  } catch (e: any) {
    return listSkillOnchain(agentDbId, skillName, price);
  }
}

export async function replicateOnChainRouted(parentAgentId: string, childAgentId: string, revenueShareBps: number, fundingWei: string, chainKey: string): Promise<OnchainResult> {
  const conn = getMultiChainConn(chainKey);
  if (!conn) return replicateOnchain(parentAgentId, childAgentId, revenueShareBps, fundingWei);

  const parentNum = uuidToNumericId(parentAgentId);
  const childNum = uuidToNumericId(childAgentId);

  const limits = getSafetyLimits();
  let fundingAmt = BigInt(fundingWei);
  if (fundingAmt > limits.maxDepositPerAgentWei) {
    fundingAmt = limits.maxDepositPerAgentWei;
  }

  try {
    const parentBal = await conn.hub.getBalance(parentNum);
    if (parentBal < fundingAmt) {
      return { success: false, error: "Insufficient on-chain balance for replication", chainId: conn.chainId };
    }
  } catch (e: any) {
    log(`[onchain] ${conn.name} replicate balance check failed: ${e.message?.substring(0, 100)}`, "onchain");
  }

  return multiChainSendTx(conn, conn.replication, "replicate", [parentNum, childNum, revenueShareBps, fundingAmt]);
}

export async function nativeTransferOnChain(toAddress: string, amountWei: string, chainKey: string): Promise<OnchainResult> {
  const conn = getMultiChainConn(chainKey);
  if (!conn) {
    if (!wallet) return { success: false, error: "Not initialized", chainId };
    try {
      const tx = await wallet.sendTransaction({ to: toAddress, value: BigInt(amountWei) });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) return { success: false, error: "Reverted", chainId };
      return { success: true, txHash: receipt.hash, chainId };
    } catch (e: any) {
      return { success: false, error: e.message?.substring(0, 200), chainId };
    }
  }

  try {
    const nonce = await multiChainAcquireNonce(conn);
    const tx = await conn.wallet.sendTransaction({ to: toAddress, value: BigInt(amountWei), nonce });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      conn.managedNonce = -1;
      return { success: false, error: "Reverted", chainId: conn.chainId };
    }
    return { success: true, txHash: receipt.hash, chainId: conn.chainId };
  } catch (e: any) {
    conn.managedNonce = -1;
    return { success: false, error: e.message?.substring(0, 200), chainId: conn.chainId };
  }
}

export async function getDeployerBalanceOnChain(chainKey: string): Promise<string> {
  const conn = getMultiChainConn(chainKey);
  if (!conn) return "0";
  try {
    const bal = await conn.provider.getBalance(conn.wallet.address);
    return ethers.formatEther(bal);
  } catch {
    return "0";
  }
}

const ERC8004_IDENTITY_REGISTRY_ABI = [
  "function register(string agentURI) external returns (uint256 agentId)",
  "function register() external returns (uint256 agentId)",
  "function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external",
  "function setAgentURI(uint256 agentId, string newURI) external",
  "function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes)",
  "function getAgentWallet(uint256 agentId) external view returns (address)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
];

const BAP578_NFA_ABI = [
  "function createAgent(address to, address logicAddress, string metadataURI, tuple(string persona, string experience, string voiceHash, string animationURI, string vaultURI, bytes32 vaultHash) extendedMetadata) external payable returns (uint256)",
  "function getAgentState(uint256 tokenId) external view returns (uint256 balance, bool active, address logicAddress, uint256 createdAt, address owner)",
  "function getAgentMetadata(uint256 tokenId) external view returns (tuple(string persona, string experience, string voiceHash, string animationURI, string vaultURI, bytes32 vaultHash) metadata, string metadataURI)",
  "function getFreeMints(address user) external view returns (uint256)",
  "function getTotalSupply() external view returns (uint256)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function MINT_FEE() external view returns (uint256)",
  "event AgentCreated(uint256 indexed tokenId, address indexed owner, address logicAddress, string metadataURI)",
];

const ERC8004_CONTRACTS: Record<string, { identityRegistry: string; reputationRegistry: string }> = {
  ethereum: {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
  base: {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
  bsc: {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
  sepolia: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
  baseSepolia: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
};

const ERC8004_CHAIN_CONFIGS: Record<string, { rpc: string; chainId: number; name: string }> = {
  ethereum: { rpc: "https://eth.llamarpc.com", chainId: 1, name: "Ethereum" },
  base: { rpc: "https://mainnet.base.org", chainId: 8453, name: "Base" },
  bsc: { rpc: "https://bsc-dataseed1.binance.org", chainId: 56, name: "BNB Chain" },
  sepolia: { rpc: "https://rpc.sepolia.org", chainId: 11155111, name: "Sepolia" },
  baseSepolia: { rpc: "https://sepolia.base.org", chainId: 84532, name: "Base Sepolia" },
};

export interface StandardsRegistrationResult {
  standard: "erc8004" | "bap578";
  success: boolean;
  txHash?: string;
  tokenId?: string;
  chainId?: number;
  chainName?: string;
  error?: string;
}

export async function registerAgentERC8004(
  agentName: string,
  agentBio: string | undefined,
  agentDbId: string,
  network: string = "base",
  userPrivateKey?: string
): Promise<StandardsRegistrationResult> {
  const privateKey = userPrivateKey || process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    return { standard: "erc8004", success: false, error: "No wallet available for registration. Fund your wallet with ETH for gas." };
  }

  const contractAddrs = ERC8004_CONTRACTS[network];
  const chainConfig = ERC8004_CHAIN_CONFIGS[network];
  if (!contractAddrs || !chainConfig) {
    return { standard: "erc8004", success: false, error: `Unknown ERC-8004 network: ${network}` };
  }

  try {
    const prov = new ethers.JsonRpcProvider(chainConfig.rpc);
    const w = new ethers.Wallet(privateKey, prov);

    const balance = await prov.getBalance(w.address);
    const minGas = network === "bsc" ? ethers.parseEther("0.002") : ethers.parseEther("0.0005");
    const gasUnit = network === "bsc" ? "BNB" : "ETH";
    if (balance < minGas) {
      return {
        standard: "erc8004",
        success: false,
        error: `Insufficient ${chainConfig.name} balance for gas. Have ${ethers.formatEther(balance)}, need ~${ethers.formatEther(minGas)} ${gasUnit}. Fund wallet: ${w.address}`,
        chainId: chainConfig.chainId,
        chainName: chainConfig.name,
      };
    }
    const registry = new ethers.Contract(contractAddrs.identityRegistry, ERC8004_IDENTITY_REGISTRY_ABI, w);

    const baseUrl = "https://build4.io";

    const agentURI = `${baseUrl}/api/standards/erc8004/agent-card/${agentDbId}`;

    log(`[ERC-8004] Registering agent "${agentName}" on ${chainConfig.name} IdentityRegistry...`, "onchain");

    const tx = await registry["register(string)"](agentURI, { gasLimit: 350000 });
    const receipt = await Promise.race([
      tx.wait(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Timeout (90s)")), 90_000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      return { standard: "erc8004", success: false, error: "Transaction reverted", chainId: chainConfig.chainId };
    }

    let tokenId: string | undefined;
    for (const eventLog of receipt.logs) {
      try {
        const parsed = registry.interface.parseLog({ topics: [...eventLog.topics], data: eventLog.data });
        if (parsed && parsed.name === "Registered") {
          tokenId = parsed.args.agentId.toString();
          break;
        }
      } catch {}
    }

    log(`[ERC-8004] Agent "${agentName}" registered on ${chainConfig.name}! Token ID: ${tokenId}, TX: ${receipt.hash}`, "onchain");

    return {
      standard: "erc8004",
      success: true,
      txHash: receipt.hash,
      tokenId,
      chainId: chainConfig.chainId,
      chainName: chainConfig.name,
    };
  } catch (e: any) {
    const msg = e.message?.substring(0, 300) || "Unknown error";
    log(`[ERC-8004] Registration failed for "${agentName}": ${msg}`, "onchain");
    return { standard: "erc8004", success: false, error: msg, chainId: chainConfig.chainId, chainName: chainConfig.name };
  }
}

export async function registerAgentBAP578(
  agentName: string,
  agentBio: string | undefined,
  agentDbId: string,
  contractAddress?: string,
  userPrivateKey?: string
): Promise<StandardsRegistrationResult> {
  const privateKey = userPrivateKey || process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    return { standard: "bap578", success: false, error: "No wallet available for registration. Fund your wallet with BNB for gas + mint fee." };
  }

  const bap578Address = contractAddress || process.env.BAP578_CONTRACT_ADDRESS;
  if (!bap578Address) {
    return { standard: "bap578", success: false, error: "No BAP578_CONTRACT_ADDRESS configured. Set the deployed BAP-578 contract address." };
  }

  try {
    const bscRpc = "https://bsc-dataseed1.binance.org";
    const prov = new ethers.JsonRpcProvider(bscRpc);
    const w = new ethers.Wallet(privateKey, prov);
    const nfaContract = new ethers.Contract(bap578Address, BAP578_NFA_ABI, w);

    const baseUrl = "https://build4.io";

    const metadataURI = `${baseUrl}/api/standards/bap578/agent-metadata/${agentDbId}`;

    const { generateNfaPersonality } = await import("./nfa-personality");
    let personalityTraits = ["autonomous", "decentralized"];
    let voiceHashVal = "";
    try {
      const personality = await generateNfaPersonality(agentName, agentBio);
      personalityTraits = personality.traits;
      voiceHashVal = personality.personalityHash;
      log(`[BAP-578] Personality generated for "${agentName}": ${personalityTraits.join(", ")}`, "onchain");
    } catch (pErr: any) {
      log(`[BAP-578] Personality generation skipped for "${agentName}": ${pErr.message}`, "onchain");
    }

    const persona = JSON.stringify({
      name: agentName,
      platform: "BUILD4",
      traits: personalityTraits,
    });

    const extendedMetadata = {
      persona,
      experience: agentBio || `Autonomous AI agent on BUILD4 platform`,
      voiceHash: voiceHashVal,
      animationURI: "",
      vaultURI: `${baseUrl}/api/web4/agents/${agentDbId}`,
      vaultHash: ethers.zeroPadValue("0x00", 32),
    };

    let freeMints = BigInt(0);
    try {
      freeMints = await nfaContract.getFreeMints(w.address);
    } catch {}

    let mintFee = ethers.parseEther("0.01");
    try {
      mintFee = await nfaContract.MINT_FEE();
    } catch {}

    const walletBalance = await prov.getBalance(w.address);
    const gasReserve = ethers.parseEther("0.002");

    let mintValue: bigint;
    if (freeMints > 0n) {
      mintValue = BigInt(0);
      log(`[BAP-578] Using free mint for "${agentName}" (${freeMints} remaining)`, "onchain");
    } else if (walletBalance >= mintFee + gasReserve) {
      mintValue = mintFee;
      log(`[BAP-578] Paying mint fee ${ethers.formatEther(mintFee)} BNB for "${agentName}"`, "onchain");
    } else {
      const needed = ethers.formatEther(mintFee + gasReserve);
      const have = ethers.formatEther(walletBalance);
      log(`[BAP-578] Insufficient BNB for mint: have ${have}, need ${needed}`, "onchain");
      return {
        standard: "bap578",
        success: false,
        error: `Insufficient BNB for BAP-578 mint. Need ~${needed} BNB (${ethers.formatEther(mintFee)} fee + gas), have ${have} BNB. Fund wallet: ${w.address}`,
        chainId: 56,
        chainName: "BNB Chain",
      };
    }

    log(`[BAP-578] Minting NFA for agent "${agentName}" on BNB Chain...`, "onchain");

    const freshBalance = await prov.getBalance(w.address);
    if (freshBalance < mintValue + gasReserve) {
      const needed = ethers.formatEther(mintValue + gasReserve);
      const have = ethers.formatEther(freshBalance);
      return {
        standard: "bap578",
        success: false,
        error: `Insufficient BNB for BAP-578 mint. Need ~${needed} BNB (${ethers.formatEther(mintValue)} fee + gas), have ${have} BNB. Fund wallet: ${w.address}`,
        chainId: 56,
        chainName: "BNB Chain",
      };
    }

    let tx;
    try {
      tx = await nfaContract.createAgent(
        w.address,
        ethers.ZeroAddress,
        metadataURI,
        extendedMetadata,
        { value: mintValue, gasLimit: 500000 }
      );
    } catch (mintErr: any) {
      const errMsg = mintErr.message || "";
      if (errMsg.includes("insufficient funds") || errMsg.includes("exceeds balance")) {
        const currentBal = await prov.getBalance(w.address).catch(() => 0n);
        return {
          standard: "bap578",
          success: false,
          error: `Insufficient BNB balance. Need ~0.012 BNB, have ${ethers.formatEther(currentBal)} BNB. Fund wallet: ${w.address}`,
          chainId: 56,
          chainName: "BNB Chain",
        };
      }
      throw mintErr;
    }

    const receipt = await Promise.race([
      tx.wait(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Timeout (90s)")), 90_000)),
    ]);

    if (!receipt || receipt.status !== 1) {
      return { standard: "bap578", success: false, error: "Transaction reverted", chainId: 56 };
    }

    let tokenId: string | undefined;
    for (const eventLog of receipt.logs) {
      try {
        const parsed = nfaContract.interface.parseLog({ topics: [...eventLog.topics], data: eventLog.data });
        if (parsed && parsed.name === "AgentCreated") {
          tokenId = parsed.args.tokenId.toString();
          break;
        }
      } catch {}
    }

    log(`[BAP-578] NFA minted for "${agentName}" on BNB Chain! Token ID: ${tokenId}, TX: ${receipt.hash}`, "onchain");

    return {
      standard: "bap578",
      success: true,
      txHash: receipt.hash,
      tokenId,
      chainId: 56,
      chainName: "BNB Chain",
    };
  } catch (e: any) {
    const msg = e.message?.substring(0, 300) || "Unknown error";
    log(`[BAP-578] NFA minting failed for "${agentName}": ${msg}`, "onchain");
    return { standard: "bap578", success: false, error: msg, chainId: 56, chainName: "BNB Chain" };
  }
}

export function getERC8004ContractAddress(network: string = "base"): string | null {
  return ERC8004_CONTRACTS[network]?.identityRegistry || null;
}

export function getERC8004Networks(): Array<{ network: string; identityRegistry: string; reputationRegistry: string }> {
  return Object.entries(ERC8004_CONTRACTS).map(([net, addrs]) => ({
    network: net,
    identityRegistry: addrs.identityRegistry,
    reputationRegistry: addrs.reputationRegistry,
  }));
}

export function getBAP578ContractAddress(): string | null {
  return process.env.BAP578_CONTRACT_ADDRESS || null;
}


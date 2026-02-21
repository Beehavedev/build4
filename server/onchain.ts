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

    log(`[onchain] ${method} tx: ${receipt.hash}`, "onchain");
    return { success: true, txHash: receipt.hash, chainId };
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

  const result = await sendTx(contracts.hub, "withdraw", [numId, feeAmount, wallet.address], { gasLimit: 150000 });
  if (result.success) {
    log(`[onchain] Fee collected (${feeType}): ${feeAmountWei} wei from agent ${agentDbId.substring(0, 8)} -> treasury. TX: ${result.txHash}`, "onchain");
  }
  return result;
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

      multiChainConnections.set(key, {
        name: config.name,
        chainId: config.chainId,
        explorerBase: config.explorerBase,
        provider: prov,
        wallet: w,
        hub,
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
    const estimatedGas = BigInt(gasLimit) * BigInt("5000000000");
    recordSpend(valueWei + estimatedGas);
    txCountThisHour++;

    log(`[onchain] ${conn.name} ${method} tx: ${receipt.hash}`, "onchain");
    return { success: true, txHash: receipt.hash, chainId: conn.chainId };
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

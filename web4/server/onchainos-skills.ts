import { execFile } from "child_process";
import path from "path";
import { log } from "./index";
import {
  getSmartMoneySignalsAPI,
  getLeaderboardAPI,
  securityTokenScanAPI,
  getGasPriceAPI,
  getTrendingTokensAPI,
  getHotTokensAPI,
  getMemeTokensAPI,
  getTokenPriceAPI,
  isOKXConfigured,
} from "./okx-onchainos";

const ONCHAINOS_BIN = path.join(process.env.HOME || "/home/runner", ".local/bin/onchainos");

export interface OnchainOSSkillDef {
  id: string;
  name: string;
  icon: string;
  category: "onchain-swap" | "onchain-market" | "onchain-signal" | "onchain-security" | "onchain-wallet" | "onchain-infra";
  description: string;
  commands: OnchainOSCommand[];
}

export interface OnchainOSCommand {
  name: string;
  description: string;
  args: string[];
  example: string;
}

function execOnchainos(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const passphrase = process.env.OKX_PASSPHRASE || process.env.OKX_API_PASSPHRASE || "";
  return new Promise((resolve) => {
    execFile(ONCHAINOS_BIN, args, {
      timeout: timeoutMs,
      env: {
        ...process.env,
        ONCHAINOS_HOME: path.join(process.env.HOME || "/home/runner", ".onchainos"),
        OKX_PASSPHRASE: passphrase,
      },
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() || "",
        stderr: stderr?.toString() || "",
        exitCode: error ? (error as any).code || 1 : 0,
      });
    });
  });
}

export function validateOnchainOSCommand(skill: string, command: string): boolean {
  const skillDef = ONCHAINOS_SKILLS.find(s => s.id === skill);
  if (!skillDef) return false;
  return skillDef.commands.some(c => c.name === command);
}

const DANGEROUS_COMMANDS = new Set([
  "wallet send",
  "wallet contract-call",
  "gateway broadcast",
  "payment x402-pay",
  "swap swap",
  "swap approve",
]);

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.has(command);
}

async function tryRESTApiFallback(skill: string, command: string, params: Record<string, string>): Promise<{ success: boolean; data: any; error?: string } | null> {
  if (!isOKXConfigured()) return null;

  try {
    let result: any = null;
    const key = `${skill}/${command}`;

    switch (key) {
      case "okx_dex_signal/signal list":
        result = await getSmartMoneySignalsAPI(params.chain || params.chainIndex || "56", params["wallet-type"] || params.walletType);
        break;
      case "okx_dex_signal/leaderboard list":
        result = await getLeaderboardAPI(params.chain || params.chainIndex || "56", params["time-frame"] || params.timeFrame, params["sort-by"] || params.orderBy);
        break;
      case "okx_security/security token-scan":
        result = await securityTokenScanAPI(params.address || params.tokenContractAddress || "", params.chain || params.chainIndex || "1");
        break;
      case "okx_onchain_gateway/gateway gas":
        result = await getGasPriceAPI(params.chain || params.chainIndex || "1");
        break;
      case "okx_dex_token/token trending":
        result = await getTrendingTokensAPI(params.chains || params.chain || params.chainIndex);
        break;
      case "okx_dex_token/token hot-tokens":
        result = await getHotTokensAPI(params["ranking-type"] || params.orderBy || "1", params.chain || params.chainIndex);
        break;
      case "okx_dex_trenches/memepump tokens":
        result = await getMemeTokensAPI(params.chain || params.chainIndex || "56", params.stage);
        break;
      case "okx_dex_market/market price":
        result = await getTokenPriceAPI(params.address || params.tokenContractAddress || "", params.chain || params.chainIndex || "1");
        break;
      default:
        return null;
    }

    if (result) {
      const data = Array.isArray(result.data) ? result.data : result.data?.data || result.data || [];
      return { success: true, data: { code: result.code || "0", data, msg: result.msg || "" } };
    }
    return null;
  } catch (err: any) {
    log(`[OnchainOS] REST API fallback for ${skill}/${command} failed: ${err.message}`, "onchainos");
    return null;
  }
}

const SAFE_PARAM_PATTERN = /^[a-zA-Z0-9._\-:\/=@,\s]+$/;

export async function runOnchainOSCommand(skill: string, command: string, params: Record<string, string> = {}): Promise<{ success: boolean; data: any; error?: string }> {
  if (!SAFE_PARAM_PATTERN.test(skill) || !SAFE_PARAM_PATTERN.test(command)) {
    return { success: false, data: null, error: "Invalid skill or command name" };
  }
  const commandParts = command.split(" ");
  const args = [...commandParts];

  for (const [key, value] of Object.entries(params)) {
    if (key === "subcommand") continue;
    if (value !== undefined && value !== "") {
      if (!SAFE_PARAM_PATTERN.test(key)) {
        return { success: false, data: null, error: `Invalid parameter key: ${key.substring(0, 20)}` };
      }
      const sanitizedValue = String(value).substring(0, 500);
      if (sanitizedValue.includes('\0') || sanitizedValue.includes('\n') || sanitizedValue.includes('\r')) {
        return { success: false, data: null, error: `Invalid parameter value for ${key}` };
      }
      if (sanitizedValue.startsWith('-')) {
        return { success: false, data: null, error: `Invalid parameter value for ${key}: cannot start with dash` };
      }
      args.push(`--${key}`, sanitizedValue);
    }
  }

  try {
    const result = await execOnchainos(args);

    if (result.exitCode !== 0) {
      log(`[OnchainOS] CLI ${skill}/${command} failed, trying REST API fallback...`, "onchainos");
      const apiFallback = await tryRESTApiFallback(skill, command, params);
      if (apiFallback) return apiFallback;
      return { success: false, data: null, error: result.stderr || result.stdout || "Command failed" };
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = result.stdout.trim();
    }

    return { success: true, data: parsed };
  } catch (err: any) {
    log(`[OnchainOS] CLI ${skill}/${command} error: ${err.message}, trying REST API fallback...`, "onchainos");
    const apiFallback = await tryRESTApiFallback(skill, command, params);
    if (apiFallback) return apiFallback;
    return { success: false, data: null, error: err.message };
  }
}

export async function isOnchainOSInstalled(): Promise<boolean> {
  try {
    const result = await execOnchainos(["--version"], 5000);
    return result.exitCode === 0 && result.stdout.includes("onchainos");
  } catch {
    return false;
  }
}

export async function getOnchainOSVersion(): Promise<string> {
  const result = await execOnchainos(["--version"], 5000);
  return result.stdout.trim();
}

export const ONCHAINOS_SKILLS: OnchainOSSkillDef[] = [
  {
    id: "okx_dex_swap",
    name: "OKX DEX Swap",
    icon: "🔄",
    category: "onchain-swap",
    description: "Multi-chain token swapping across 500+ DEXs. MEV protection, smart slippage, trade-specific presets. Supports 20+ chains including XLayer.",
    commands: [
      { name: "swap chains", description: "Get supported chains for DEX aggregator", args: [], example: "onchainos swap chains" },
      { name: "swap liquidity", description: "Get available liquidity sources on a chain", args: ["chain"], example: "onchainos swap liquidity --chain 196" },
      { name: "swap quote", description: "Get swap quote (price estimate)", args: ["from", "to", "amount", "chain"], example: "onchainos swap quote --from 0xeee... --to 0x74b... --amount 1000000000000000000 --chain 196" },
      { name: "swap approve", description: "Get ERC-20 approval transaction data", args: ["token", "amount", "chain"], example: "onchainos swap approve --token 0x74b... --amount 1000000 --chain 196" },
      { name: "swap swap", description: "Execute swap with full routing", args: ["from", "to", "amount", "chain", "slippage"], example: "onchainos swap swap --from 0xeee... --to 0x74b... --amount 1000000000000000000 --chain 196 --slippage 0.5" },
    ],
  },
  {
    id: "okx_dex_market",
    name: "OKX Market Data",
    icon: "📊",
    category: "onchain-market",
    description: "Real-time on-chain market data: token prices, K-line charts, index prices, wallet PnL analysis, and DEX transaction feeds.",
    commands: [
      { name: "market price", description: "Get current token price", args: ["address", "chain"], example: "onchainos market price --address 0xeee... --chain xlayer" },
      { name: "market kline", description: "Get K-line/OHLC data", args: ["address", "chain", "bar", "limit"], example: "onchainos market kline --address 0xeee... --chain xlayer --bar 1H --limit 24" },
      { name: "market prices", description: "Get batch token prices", args: ["tokens"], example: 'onchainos market prices --tokens "196:0xeee..."' },
      { name: "market portfolio-overview", description: "Get wallet portfolio overview", args: ["address", "chain", "time-frame"], example: "onchainos market portfolio-overview --address 0xd8d... --chain ethereum --time-frame 3" },
      { name: "market portfolio-dex-history", description: "Get wallet DEX trade history", args: ["address", "chain"], example: "onchainos market portfolio-dex-history --address 0xd8d... --chain ethereum" },
    ],
  },
  {
    id: "okx_dex_signal",
    name: "OKX Smart Money Signals",
    icon: "🐋",
    category: "onchain-signal",
    description: "Real-time aggregated buy signals from smart money wallets, KOLs, and whales. Leaderboard rankings for top on-chain traders.",
    commands: [
      { name: "signal chains", description: "Get supported chains for signals", args: [], example: "onchainos signal chains" },
      { name: "signal list", description: "Get aggregated buy signals", args: ["chain", "wallet-type", "min-amount-usd"], example: "onchainos signal list --chain solana --wallet-type 1" },
      { name: "leaderboard supported-chains", description: "Get supported chains for leaderboard", args: [], example: "onchainos leaderboard supported-chains" },
      { name: "leaderboard list", description: "Get top trader leaderboard", args: ["chain", "time-frame", "sort-by", "wallet-type"], example: "onchainos leaderboard list --chain solana --time-frame 3 --sort-by 1" },
    ],
  },
  {
    id: "okx_dex_trenches",
    name: "OKX Meme Scanner",
    icon: "🐸",
    category: "onchain-market",
    description: "Meme/alpha token research on pump.fun and launchpads. Dev reputation, bundle/sniper detection, bonding curve status, social filtering.",
    commands: [
      { name: "memepump tokens", description: "Scan new meme token launches", args: ["chain", "stage", "protocol-id-list", "has-x", "has-telegram"], example: "onchainos memepump tokens --chain solana --stage NEW" },
      { name: "memepump token-dev-info", description: "Check developer reputation", args: ["address", "chain"], example: "onchainos memepump token-dev-info --address ... --chain solana" },
      { name: "memepump token-bundle-info", description: "Detect bundlers/snipers", args: ["address", "chain"], example: "onchainos memepump token-bundle-info --address ... --chain solana" },
      { name: "memepump token-details", description: "Get detailed meme token info", args: ["address", "chain"], example: "onchainos memepump token-details --address ... --chain solana" },
      { name: "memepump aped-wallet", description: "Check co-investors of a token", args: ["address", "chain"], example: "onchainos memepump aped-wallet --address ... --chain solana" },
    ],
  },
  {
    id: "okx_dex_token",
    name: "OKX Token Info",
    icon: "🪙",
    category: "onchain-market",
    description: "Token search, liquidity info, trending tokens, holder analysis, and advanced token data across all supported chains.",
    commands: [
      { name: "token search", description: "Search tokens by name/symbol", args: ["query", "chains"], example: 'onchainos token search --query xETH --chains "ethereum,solana"' },
      { name: "token hot-tokens", description: "Get hot/trending tokens", args: ["ranking-type", "chain"], example: "onchainos token hot-tokens --ranking-type 4" },
      { name: "token trending", description: "Get trending tokens with filters", args: ["chains", "sort-by", "time-frame"], example: "onchainos token trending --chains solana --sort-by 5 --time-frame 4" },
      { name: "token holders", description: "Get token holder distribution", args: ["address", "chain", "tag-filter"], example: "onchainos token holders --address 0xeee... --chain xlayer" },
      { name: "token liquidity", description: "Get token liquidity info", args: ["address", "chain"], example: "onchainos token liquidity --address ... --chain base" },
      { name: "token price-info", description: "Get detailed price info", args: ["address", "chain"], example: "onchainos token price-info --address ... --chain xlayer" },
      { name: "token advanced-info", description: "Get advanced token analytics", args: ["address", "chain"], example: "onchainos token advanced-info --address ... --chain solana" },
      { name: "token top-trader", description: "Get top traders for a token", args: ["address", "chain"], example: "onchainos token top-trader --address ... --chain solana" },
    ],
  },
  {
    id: "okx_agentic_wallet",
    name: "OKX Agentic Wallet",
    icon: "👛",
    category: "onchain-wallet",
    description: "Wallet lifecycle management: authentication, balance queries, token transfers (native & ERC-20/SPL), transaction history, and smart contract calls.",
    commands: [
      { name: "wallet chains", description: "Get supported wallet chains", args: [], example: "onchainos wallet chains" },
      { name: "wallet balance", description: "Get wallet balance on a chain", args: ["chain"], example: "onchainos wallet balance --chain 196" },
      { name: "wallet send", description: "Send tokens to an address", args: ["chain", "to", "amount", "token"], example: "onchainos wallet send --chain 196 --to 0x... --amount 0.01" },
      { name: "wallet contract-call", description: "Call a smart contract", args: ["to", "chain", "input-data", "value"], example: "onchainos wallet contract-call --to 0x... --chain 196 --input-data 0x..." },
      { name: "wallet status", description: "Check wallet login status", args: [], example: "onchainos wallet status" },
    ],
  },
  {
    id: "okx_wallet_portfolio",
    name: "OKX Wallet Portfolio",
    icon: "💼",
    category: "onchain-wallet",
    description: "Read any wallet on-chain: total asset value, all token balances, specific token balances, and DeFi position tracking.",
    commands: [
      { name: "portfolio chains", description: "Get supported chains for balance queries", args: [], example: "onchainos portfolio chains" },
      { name: "portfolio total-value", description: "Get total wallet value", args: ["address", "chains"], example: 'onchainos portfolio total-value --address 0x... --chains "xlayer,solana"' },
      { name: "portfolio all-balances", description: "Get all token balances", args: ["address", "chains"], example: 'onchainos portfolio all-balances --address 0x... --chains "xlayer,solana,ethereum"' },
      { name: "portfolio token-balances", description: "Get specific token balances", args: ["address", "tokens"], example: 'onchainos portfolio token-balances --address 0x... --tokens "196:,196:0x74b..."' },
    ],
  },
  {
    id: "okx_onchain_gateway",
    name: "OKX Onchain Gateway",
    icon: "🌐",
    category: "onchain-infra",
    description: "Transaction infrastructure: gas estimation, transaction simulation, broadcasting signed transactions, and order tracking.",
    commands: [
      { name: "gateway chains", description: "Get supported chains for gateway", args: [], example: "onchainos gateway chains" },
      { name: "gateway gas", description: "Get current gas prices", args: ["chain"], example: "onchainos gateway gas --chain xlayer" },
      { name: "gateway gas-limit", description: "Estimate gas limit", args: ["from", "to", "chain"], example: "onchainos gateway gas-limit --from 0x... --to 0x... --chain xlayer" },
      { name: "gateway simulate", description: "Simulate a transaction (dry-run)", args: ["from", "to", "data", "chain"], example: "onchainos gateway simulate --from 0x... --to 0x... --data 0x... --chain xlayer" },
      { name: "gateway broadcast", description: "Broadcast signed transaction", args: ["signed-tx", "address", "chain"], example: "onchainos gateway broadcast --signed-tx 0xf86c... --address 0x... --chain xlayer" },
      { name: "gateway orders", description: "Get order/transaction status", args: ["address", "chain", "order-id"], example: "onchainos gateway orders --address 0x... --chain xlayer --order-id 123" },
    ],
  },
  {
    id: "okx_security",
    name: "OKX Security Scanner",
    icon: "🔒",
    category: "onchain-security",
    description: "Security scanning: token risk/honeypot detection, DApp phishing detection, transaction pre-execution safety, signature scanning, approval auditing.",
    commands: [
      { name: "security token-scan", description: "Scan token for risks/honeypots", args: ["address", "chain"], example: "onchainos security token-scan --address 0x... --chain 196" },
      { name: "security dapp-scan", description: "Scan DApp/URL for phishing", args: ["url"], example: "onchainos security dapp-scan --url https://..." },
      { name: "security tx-scan", description: "Pre-execution transaction scan", args: ["from", "to", "data", "chain"], example: "onchainos security tx-scan --from 0x... --to 0x... --data 0x... --chain 196" },
      { name: "security sig-scan", description: "Scan message signature safety", args: ["message", "chain"], example: "onchainos security sig-scan --message 0x... --chain 196" },
      { name: "security approvals", description: "Query token approvals/Permit2", args: ["address", "chain"], example: "onchainos security approvals --address 0x... --chain 196" },
    ],
  },
  {
    id: "okx_x402_payment",
    name: "OKX x402 Payment",
    icon: "💳",
    category: "onchain-infra",
    description: "Sign and send x402 (HTTP 402) payment proofs for payment-gated APIs. Gas-free stablecoin payments on XLayer.",
    commands: [
      { name: "payment x402-pay", description: "Sign an x402 payment proof", args: ["url", "network", "max-amount"], example: "onchainos payment x402-pay --url https://... --network eip155:196 --max-amount 1000000" },
    ],
  },
];

export function getOnchainOSSkillDefs(): OnchainOSSkillDef[] {
  return ONCHAINOS_SKILLS;
}

export function getOnchainOSSkillById(id: string): OnchainOSSkillDef | undefined {
  return ONCHAINOS_SKILLS.find(s => s.id === id);
}

export async function executeSwapQuote(params: { fromToken: string; toToken: string; amount: string; chain: string; slippage?: string }): Promise<any> {
  return runOnchainOSCommand("okx_dex_swap", "swap quote", {
    from: params.fromToken,
    to: params.toToken,
    amount: params.amount,
    chain: params.chain,
  });
}

export async function executeTokenSearch(query: string, chains?: string): Promise<any> {
  const params: Record<string, string> = { query };
  if (chains) params.chains = chains;
  return runOnchainOSCommand("okx_dex_token", "token search", params);
}

async function cliAvailable(): Promise<boolean> {
  try {
    const result = await execOnchainos(["--version"], 3000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function getRemoteApiUrl(): string | null {
  if (process.env.BUILD4_API_URL) return process.env.BUILD4_API_URL;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return null;
}

async function callRemoteOnchainOS(skill: string, command: string, params: Record<string, string>): Promise<{ success: boolean; data: any; error?: string } | null> {
  const baseUrl = getRemoteApiUrl();
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl}/api/okx/onchainos/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill, command, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function withFallbacks(
  skill: string,
  command: string,
  params: Record<string, string>,
  apiFn?: () => Promise<any>,
): Promise<any> {
  if (apiFn && isOKXConfigured()) {
    try {
      const result = await apiFn();
      const data = result?.data;
      if (data && ((Array.isArray(data) && data.length > 0) || (typeof data === "object" && !Array.isArray(data)))) {
        return { success: true, data: result };
      }
    } catch (err: any) {
      log(`[OnchainOS] REST API ${skill}/${command} failed: ${err.message}`, "onchainos");
    }
  }

  const cliResult = await runOnchainOSCommand(skill, command, params);
  if (cliResult.success) return cliResult;

  const remote = await callRemoteOnchainOS(skill, command, params);
  if (remote?.success) return remote;

  return cliResult;
}

export async function executeSecurityScan(address: string, chain: string): Promise<any> {
  const directResult = await securityTokenScanAPI(address, chain);
  if (directResult?.success && directResult?.data) return directResult;
  return withFallbacks("okx_security", "security token-scan", { address, chain });
}

export async function getSmartMoneySignals(chain: string, walletType?: string): Promise<any> {
  const params: Record<string, string> = { chain };
  if (walletType) params["wallet-type"] = walletType;
  return withFallbacks("okx_dex_signal", "signal list", params,
    () => getSmartMoneySignalsAPI(chain, walletType));
}

export async function getLeaderboard(chain: string, timeFrame?: string, sortBy?: string): Promise<any> {
  const params: Record<string, string> = { chain };
  if (timeFrame) params["time-frame"] = timeFrame;
  if (sortBy) params["sort-by"] = sortBy;
  return withFallbacks("okx_dex_signal", "leaderboard list", params,
    () => getLeaderboardAPI(chain, timeFrame, sortBy));
}

export async function getTokenPrice(address: string, chain: string): Promise<any> {
  return withFallbacks("okx_dex_market", "market price", { address, chain },
    () => getTokenPriceAPI(address, chain));
}

export async function getGasPrice(chain: string): Promise<any> {
  return withFallbacks("okx_onchain_gateway", "gateway gas", { chain },
    () => getGasPriceAPI(chain));
}

export async function getPortfolioValue(address: string, chains: string): Promise<any> {
  return withFallbacks("okx_wallet_portfolio", "portfolio total-value", { address, chains });
}

export async function getTrendingTokens(chains: string, sortBy?: string, timeFrame?: string): Promise<any> {
  const params: Record<string, string> = { chains };
  if (sortBy) params["sort-by"] = sortBy;
  if (timeFrame) params["time-frame"] = timeFrame;
  return withFallbacks("okx_dex_token", "token trending", params,
    () => getTrendingTokensAPI(chains));
}

export async function getMemeTokens(chain: string, stage?: string): Promise<any> {
  const params: Record<string, string> = { chain };
  if (stage) params.stage = stage;
  return withFallbacks("okx_dex_trenches", "memepump tokens", params,
    () => getMemeTokensAPI(chain, stage));
}

export async function getHotTokens(rankingType: string, chain?: string): Promise<any> {
  const params: Record<string, string> = { "ranking-type": rankingType };
  if (chain) params.chain = chain;
  return withFallbacks("okx_dex_token", "token hot-tokens", params,
    () => getHotTokensAPI(rankingType, chain));
}

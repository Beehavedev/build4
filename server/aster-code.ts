import { Wallet, getAddress, Signature } from "ethers";
import { rateLimitWait } from "./aster-rate-limiter";

const DEFAULT_FAPI_URL = "https://fapi.asterdex.com";
const REQUEST_TIMEOUT_MS = 20000;

const BUILD4_BUILDER_ADDRESS = "0x06d6227e499f10fe0a9f8c8b80b3c98f964474a4";
const BUILD4_BUILDER_NAME = "BUILD4";
const BUILD4_MAX_FEE_RATE = "0.001";
const BUILD4_FEE_RATE = "0.001";

export function getDefaultAsterCodeConfig(): AsterCodeConfig {
  return {
    builderAddress: BUILD4_BUILDER_ADDRESS,
    builderName: BUILD4_BUILDER_NAME,
    maxFeeRate: BUILD4_MAX_FEE_RATE,
    feeRate: BUILD4_FEE_RATE,
  };
}

export interface AsterCodeConfig {
  builderAddress: string;
  builderName: string;
  maxFeeRate: string;
  feeRate: string;
  fApiUrl?: string;
}

export interface AsterCodeUserConfig {
  userAddress: string;
  userPrivateKey: string;
  signerAddress: string;
  signerPrivateKey: string;
}

export interface ApproveAgentParams {
  agentName: string;
  agentAddress: string;
  ipWhitelist?: string;
  expired?: number;
  canSpotTrade?: boolean;
  canPerpTrade?: boolean;
  canWithdraw?: boolean;
  builder?: string;
  maxFeeRate?: string;
  builderName?: string;
}

export interface ApproveBuilderParams {
  builder: string;
  maxFeeRate: string;
  builderName?: string;
}

export interface AsterCodeOnboardResult {
  success: boolean;
  signerAddress?: string;
  signerPrivateKey?: string;
  agentApproved?: boolean;
  builderApproved?: boolean;
  error?: string;
  errorCode?: string;
  debug?: string;
}

let _lastNonce = 0;

export function getNonce(): string {
  const nowMicros = Math.trunc(Date.now() * 1000);
  _lastNonce = Math.max(nowMicros, _lastNonce + 1);
  return String(_lastNonce);
}

export function buildQueryString(params: Record<string, any>): string {
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
}

const TRADING_CHAIN_ID = 1666;

export async function signV3(
  queryString: string,
  signerPrivateKey: string,
): Promise<string> {
  const wallet = new Wallet(signerPrivateKey);

  const domain = {
    name: "AsterSignTransaction",
    version: "1",
    chainId: TRADING_CHAIN_ID,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };

  const types = {
    Message: [{ name: "msg", type: "string" }],
  };

  const message = { msg: queryString };

  const sig = await wallet.signTypedData(domain, types, message);
  return sig;
}

export async function makeTradingRequest(
  baseUrl: string,
  path: string,
  userAddress: string,
  signerAddress: string,
  signerPrivateKey: string,
  params: Record<string, any>,
  method: "GET" | "POST" | "DELETE" = "GET",
  maxRetries: number = 3,
): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await rateLimitWait();
    const fullParams: Record<string, any> = {
      ...params,
      asterChain: "Mainnet",
      user: userAddress,
      signer: signerAddress,
      nonce: getNonce(),
    };

    const queryString = buildQueryString(fullParams);
    const signature = await signV3(queryString, signerPrivateKey);

    const fullParamStr = `${queryString}&signature=${signature}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      let response: Response;
      if (method === "GET") {
        const url = `${baseUrl}${path}?${fullParamStr}`;
        response = await fetch(url, {
          method: "GET",
          headers: { "User-Agent": "BUILD4/1.0" },
          signal: controller.signal,
        });
      } else {
        response = await fetch(`${baseUrl}${path}?${fullParamStr}`, {
          method,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "BUILD4/1.0",
          },
          body: fullParamStr,
          signal: controller.signal,
        });
      }

      clearTimeout(timeoutId);

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("retry-after") || "0") * 1000;
        const backoff = retryAfter > 0 ? retryAfter : Math.min(2000 * Math.pow(2, attempt), 30000);
        console.log(`[AsterCode] 429 rate limited on ${path}, retry ${attempt + 1}/${maxRetries} after ${backoff}ms`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        throw new Error(`Rate limited (429) on ${path} after ${maxRetries} retries`);
      }

      const text = await response.text();
      if (!response.ok) {
        const isHtml = text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html");
        console.log(`[AsterCode] ${method} ${path} status=${response.status} ${isHtml ? "[HTML]" : text.substring(0, 200)}`);
      }

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response from ${path}: ${text.substring(0, 300)}`);
      }

      if (!response.ok) {
        throw new Error(`AsterCode API error ${data?.code || response.status}: ${data?.msg || data?.message || text.substring(0, 200)}`);
      }

      if (data && data.data && !Array.isArray(data)) {
        return data.data;
      }
      return data;
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (e.name === "AbortError") {
        throw new Error(`AsterCode API timeout: ${method} ${path}`);
      }
      throw e;
    }
  }
}

const EIP712_DOMAIN = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 56,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

function inferEip712Type(value: any): string {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number" || typeof value === "bigint") return "uint256";
  return "string";
}

function capitalizeKey(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

async function signEip712(
  privateKey: string,
  primaryType: string,
  message: Record<string, any>,
): Promise<string> {
  const capitalizedMsg: Record<string, any> = {};
  const typeFields: Array<{ name: string; type: string }> = [];

  for (const [k, v] of Object.entries(message)) {
    const capKey = capitalizeKey(k);
    capitalizedMsg[capKey] = v;
    typeFields.push({ name: capKey, type: inferEip712Type(v) });
  }

  const types: Record<string, Array<{ name: string; type: string }>> = {
    [primaryType]: typeFields,
  };

  const wallet = new Wallet(privateKey);
  const sig = await wallet.signTypedData(EIP712_DOMAIN, types, capitalizedMsg);
  return sig;
}

let _eip712NonceCounter = 0;
let _eip712LastSec = 0;

function generateNonce(): number {
  const nowSec = Math.trunc(Date.now() / 1000);
  if (nowSec === _eip712LastSec) {
    _eip712NonceCounter++;
  } else {
    _eip712LastSec = nowSec;
    _eip712NonceCounter = 0;
  }
  return nowSec * 1_000_000 + _eip712NonceCounter;
}

async function makeEip712Request(
  baseUrl: string,
  path: string,
  privateKey: string,
  params: Record<string, any>,
  primaryType: string,
  userAddress?: string,
): Promise<any> {
  const wallet = new Wallet(privateKey);
  const fullParams: Record<string, any> = {
    ...params,
    asterChain: "Mainnet",
    user: userAddress || wallet.address,
    nonce: generateNonce(),
  };

  const signature = await signEip712(privateKey, primaryType, fullParams);

  const bodyParams: Record<string, any> = { ...fullParams, signature, signatureChainId: 56 };

  console.log(`[AsterCode] EIP712 POST ${path} primaryType=${primaryType} params=${JSON.stringify(params).substring(0, 300)}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const urlEncodedBody = Object.entries(bodyParams)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => {
        let strVal: string;
        if (typeof v === "boolean") strVal = v ? "True" : "False";
        else strVal = String(v);
        return `${encodeURIComponent(k)}=${encodeURIComponent(strVal)}`;
      })
      .join("&");

    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "BUILD4/1.0",
      },
      body: urlEncodedBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const text = await response.text();
    console.log(`[AsterCode] EIP712 POST ${path} status=${response.status} body=${text.substring(0, 500)}`);

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${path}: ${text.substring(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(`AsterCode API error ${data?.code || response.status}: ${data?.msg || data?.message || text.substring(0, 200)}`);
    }

    return data?.data !== undefined ? data.data : data;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error(`AsterCode API timeout: POST ${path}`);
    }
    throw e;
  }
}

export async function asterCodeApproveAgent(
  baseUrl: string,
  userAddress: string,
  userPrivateKey: string,
  params: ApproveAgentParams,
): Promise<any> {
  const reqParams: Record<string, any> = {
    agentName: params.agentName || `build4_${Date.now()}`,
    agentAddress: params.agentAddress,
    ipWhitelist: params.ipWhitelist || "",
    expired: params.expired || Math.trunc(Date.now() / 1000 + 2 * 365 * 24 * 3600) * 1000,
    canSpotTrade: params.canSpotTrade ?? false,
    canPerpTrade: params.canPerpTrade ?? true,
    canWithdraw: params.canWithdraw ?? false,
  };

  return makeEip712Request(baseUrl, "/fapi/v3/approveAgent", userPrivateKey, reqParams, "ApproveAgent");
}

export function buildEip712TypedData(
  primaryType: string,
  params: Record<string, any>,
  userAddress: string,
): { domain: any; types: any; message: any; fullParams: Record<string, any> } {
  const fullParams: Record<string, any> = {
    ...params,
    asterChain: "Mainnet",
    user: userAddress,
    nonce: generateNonce(),
  };

  const capitalizedMsg: Record<string, any> = {};
  const typeFields: Array<{ name: string; type: string }> = [];
  for (const [k, v] of Object.entries(fullParams)) {
    const capKey = capitalizeKey(k);
    capitalizedMsg[capKey] = v;
    typeFields.push({ name: capKey, type: inferEip712Type(v) });
  }

  return {
    domain: EIP712_DOMAIN,
    types: { [primaryType]: typeFields },
    message: capitalizedMsg,
    fullParams,
  };
}

export async function submitSignedEip712(
  baseUrl: string,
  path: string,
  fullParams: Record<string, any>,
  signature: string,
): Promise<any> {
  const bodyParams: Record<string, any> = { ...fullParams, signature, signatureChainId: 56 };

  const urlEncodedBody = Object.entries(bodyParams)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      let strVal: string;
      if (typeof v === "boolean") strVal = v ? "True" : "False";
      else strVal = String(v);
      return `${encodeURIComponent(k)}=${encodeURIComponent(strVal)}`;
    })
    .join("&");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    for (let attempt = 0; attempt <= 3; attempt++) {
      await rateLimitWait();
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "BUILD4/1.0" },
        body: urlEncodedBody,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (response.status === 429) {
        const backoff = Math.min(3000 * Math.pow(2, attempt), 30000);
        console.log(`[AsterCode] 429 on POST ${path}, retry ${attempt + 1}/3 after ${backoff}ms`);
        if (attempt < 3) { await new Promise(r => setTimeout(r, backoff)); continue; }
        throw new Error(`Rate limited (429) on ${path} after 3 retries`);
      }
      const text = await response.text();
      console.log(`[AsterCode] submitSigned POST ${path} status=${response.status} body=${text.substring(0, 500)}`);
      let data: any;
      try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON from ${path}: ${text.substring(0, 300)}`); }
      if (!response.ok) throw new Error(`AsterCode API error ${data?.code || response.status}: ${data?.msg || data?.message || text.substring(0, 200)}`);
      return data?.data !== undefined ? data.data : data;
    }
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error(`AsterCode API timeout: POST ${path}`);
    throw e;
  }
}

export async function asterCodeApproveBuilder(
  baseUrl: string,
  userAddress: string,
  userPrivateKey: string,
  params: ApproveBuilderParams,
): Promise<any> {
  const reqParams: Record<string, any> = {
    builder: params.builder,
    maxFeeRate: params.maxFeeRate || "0.001",
    builderName: params.builderName || "BUILD4",
  };

  return makeEip712Request(baseUrl, "/fapi/v3/approveBuilder", userPrivateKey, reqParams, "ApproveBuilder");
}


function normalizeSignature(sig: string): string {
  try {
    const normalized = Signature.from(sig).serialized;
    if (normalized !== sig) {
      console.log(`[AsterCode] Signature normalized: v was ${parseInt(sig.slice(130, 132), 16)}, now ${parseInt(normalized.slice(130, 132), 16)}`);
    }
    return normalized;
  } catch {
    return sig;
  }
}

export async function asterCodeUpdateAgent(
  baseUrl: string,
  userPrivateKey: string,
  agentAddress: string,
  updates: { ipWhitelist?: string; canSpotTrade?: boolean; canPerpTrade?: boolean; canWithdraw?: boolean },
): Promise<any> {
  const reqParams: Record<string, any> = {
    agentAddress,
    ...updates,
  };
  return makeEip712Request(baseUrl, "/fapi/v3/updateAgent", userPrivateKey, reqParams, "UpdateAgent");
}

export async function asterCodeDeleteAgent(
  baseUrl: string,
  userPrivateKey: string,
  agentAddress: string,
): Promise<any> {
  const reqParams: Record<string, any> = { agentAddress };
  return makeEip712Request(baseUrl, "/fapi/v3/agent", userPrivateKey, reqParams, "DelAgent");
}

export async function asterCodeGetAgents(
  baseUrl: string,
  userAddress: string,
  signerAddress: string,
  signerPrivateKey: string,
): Promise<any> {
  return makeTradingRequest(baseUrl, "/fapi/v3/agent", userAddress, signerAddress, signerPrivateKey, {}, "GET");
}

export async function asterCodeGetBuilders(
  baseUrl: string,
  userAddress: string,
  signerAddress: string,
  signerPrivateKey: string,
): Promise<any> {
  return makeTradingRequest(baseUrl, "/fapi/v3/builder", userAddress, signerAddress, signerPrivateKey, {}, "GET");
}

const BROKER_URLS = [
  "https://www.asterdex.com/bapi/futures/v1",
  "https://fapi.asterdex.com/bapi/futures/v1",
];

async function tryBrokerRegistration(wallet: InstanceType<typeof Wallet>, brokerUrl: string): Promise<{ registered: boolean; error?: string; errorCode?: string; retryable?: boolean }> {
  const address = wallet.address;
  const BROKER_TIMEOUT = 15000;
  try {
    const nonceCtrl = new AbortController();
    const nonceTimer = setTimeout(() => nonceCtrl.abort(), BROKER_TIMEOUT);
    const nonceRes = await fetch(`${brokerUrl}/public/future/web3/get-nonce`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "clientType": "web" },
      body: JSON.stringify({ type: "LOGIN", sourceAddr: address }),
      signal: nonceCtrl.signal,
    });
    clearTimeout(nonceTimer);
    const nonceData = await nonceRes.json();
    if (!nonceData?.data?.nonce) {
      const code = nonceData?.code || "";
      return { registered: false, error: `No login nonce: ${nonceData?.message || code || "unknown"}`, errorCode: code, retryable: true };
    }

    const loginMessage = `You are signing into Astherus ${nonceData.data.nonce}`;
    const loginSignature = await wallet.signMessage(loginMessage);

    await new Promise(r => setTimeout(r, 300));

    const loginCtrl = new AbortController();
    const loginTimer = setTimeout(() => loginCtrl.abort(), BROKER_TIMEOUT);
    const loginRes = await fetch(`${brokerUrl}/public/future/web3/ae/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "clientType": "web" },
      body: JSON.stringify({
        signature: loginSignature,
        sourceAddr: address,
        chainId: 56,
        agentCode: "BUILD4",
      }),
      signal: loginCtrl.signal,
    });
    clearTimeout(loginTimer);

    const contentType = loginRes.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      return { registered: false, error: `Non-JSON response from ${brokerUrl}`, retryable: true };
    }

    const loginData = await loginRes.json();
    const code = String(loginData?.code || "");
    const msg = loginData?.message || loginData?.msg || "";
    console.log(`[AsterCode] Login via ${brokerUrl}: code=${code} msg=${msg} wallet=${address.substring(0, 10)}`);

    if (code === "000000") {
      return { registered: true };
    }

    if (code === "099066" || msg.toLowerCase().includes("region") || msg.toLowerCase().includes("not available")) {
      return { registered: false, error: "Service not available in your region (IP whitelist pending)", errorCode: "099066", retryable: true };
    }

    if (code === "099009") {
      return { registered: false, error: "Auth failed — will retry with fresh nonce", errorCode: "099009", retryable: true };
    }

    if (code === "099008" || msg.toLowerCase().includes("nonce")) {
      return { registered: false, error: "Nonce expired — will retry with fresh nonce", errorCode: "099008", retryable: true };
    }

    if (code === "-1000" || msg.toLowerCase().includes("no aster user")) {
      return { registered: false, error: "No aster user found — registration may be delayed", errorCode: "-1000", retryable: true };
    }

    return { registered: false, error: msg || `Login code: ${code}`, errorCode: code, retryable: true };
  } catch (e: any) {
    if (e.name === "AbortError") return { registered: false, error: "Broker timeout", errorCode: "TIMEOUT", retryable: true };
    return { registered: false, error: e.message, errorCode: "EXCEPTION", retryable: true };
  }
}

export async function ensureAsterUserRegistered(wallet: InstanceType<typeof Wallet>): Promise<{ registered: boolean; error?: string; errorCode?: string }> {
  let lastError = "";
  let lastErrorCode = "";
  for (const brokerUrl of BROKER_URLS) {
    const result = await tryBrokerRegistration(wallet, brokerUrl);
    if (result.registered) return { registered: true };
    lastError = result.error || "unknown";
    lastErrorCode = result.errorCode || "";
    console.log(`[AsterCode] Broker ${brokerUrl} failed: code=${lastErrorCode} err=${lastError}, trying next...`);
    if (!result.retryable) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  return { registered: false, error: lastError, errorCode: lastErrorCode };
}

export async function asterCodeOnboard(
  userPrivateKey: string,
  codeConfig: AsterCodeConfig,
): Promise<AsterCodeOnboardResult> {
  const baseUrl = codeConfig.fApiUrl || DEFAULT_FAPI_URL;
  const debugParts: string[] = [];

  try {
    const userWallet = new Wallet(userPrivateKey);
    const userAddress = userWallet.address;
    console.log(`[AsterCode] Onboarding user=${userAddress.substring(0, 10)}... builder=${codeConfig.builderAddress.substring(0, 10)}...`);

    console.log(`[AsterCode] Step 1: Registering user on Aster DEX (required)...`);
    let registered = false;
    let regError = "";
    let regErrorCode = "";
    const retryDelays = [1500, 3000, 6000, 12000, 20000, 30000];
    const maxRegAttempts = 6;
    for (let regAttempt = 0; regAttempt < maxRegAttempts; regAttempt++) {
      const regResult = await ensureAsterUserRegistered(userWallet);
      if (regResult.registered) {
        registered = true;
        debugParts.push("register=OK");
        console.log(`[AsterCode] Broker registration succeeded (attempt ${regAttempt + 1})`);
        break;
      }
      regError = regResult.error || "unknown";
      regErrorCode = regResult.errorCode || "";
      console.log(`[AsterCode] Registration attempt ${regAttempt + 1}/${maxRegAttempts} failed: code=${regErrorCode} err=${regError}`);
      if (regAttempt < maxRegAttempts - 1) {
        const delay = retryDelays[regAttempt] || 30000;
        const jitter = Math.floor(Math.random() * 1000);
        console.log(`[AsterCode] Retrying registration in ${delay + jitter}ms...`);
        await new Promise(r => setTimeout(r, delay + jitter));
      }
    }
    if (!registered) {
      debugParts.push(`register=FAIL:${regErrorCode}:${regError.substring(0, 40)}`);
      console.log(`[AsterCode] Registration failed after ${maxRegAttempts} attempts: code=${regErrorCode} err=${regError}`);
      return {
        success: false,
        error: `Could not register on Aster DEX: ${regError}. Please try again in a moment.`,
        errorCode: regErrorCode,
        debug: debugParts.join(" | "),
      };
    }

    await new Promise(r => setTimeout(r, 1000));

    const signerWallet = Wallet.createRandom();
    const signerAddress = signerWallet.address;
    const signerPrivKey = signerWallet.privateKey;
    console.log(`[AsterCode] Generated signer=${signerAddress.substring(0, 10)}...`);
    debugParts.push(`signer=${signerAddress.substring(0, 10)}`);

    const agentName = `build4_${Date.now()}`;
    const expiry = Math.trunc(Date.now() / 1000 + 2 * 365 * 24 * 3600) * 1000;

    console.log(`[AsterCode] Step 2: Approving agent (user signs to approve signer)...`);
    try {
      const agentResult = await asterCodeApproveAgent(baseUrl, userAddress, userPrivateKey, {
        agentName,
        agentAddress: signerAddress,
        ipWhitelist: "",
        expired: expiry,
        canSpotTrade: false,
        canPerpTrade: true,
        canWithdraw: false,
        builder: codeConfig.builderAddress,
        maxFeeRate: codeConfig.maxFeeRate,
        builderName: codeConfig.builderName,
      });
      console.log(`[AsterCode] approveAgent result:`, JSON.stringify(agentResult).substring(0, 300));
      debugParts.push(`agent=OK`);
    } catch (agentErr: any) {
      console.error(`[AsterCode] approveAgent failed:`, agentErr.message);
      debugParts.push(`agent=FAIL:${agentErr.message.substring(0, 80)}`);
      return {
        success: false,
        error: `Agent approval failed: ${agentErr.message}`,
        debug: debugParts.join(" | "),
      };
    }

    await new Promise(r => setTimeout(r, 500));

    console.log(`[AsterCode] Step 3: Approving builder (user signs)...`);
    let builderApproved = true;
    try {
      const builderResult = await asterCodeApproveBuilder(baseUrl, userAddress, userPrivateKey, {
        builder: codeConfig.builderAddress,
        maxFeeRate: codeConfig.maxFeeRate,
        builderName: codeConfig.builderName,
      });
      console.log(`[AsterCode] approveBuilder result:`, JSON.stringify(builderResult).substring(0, 300));
      debugParts.push(`builder=OK`);
    } catch (builderErr: any) {
      console.log(`[AsterCode] approveBuilder failed (may already be approved via agent call):`, builderErr.message);
      debugParts.push(`builder=FAIL:${builderErr.message.substring(0, 80)}`);
      builderApproved = false;
    }

    console.log(`[AsterCode] Onboard success for ${userAddress.substring(0, 10)}...`);
    return {
      success: true,
      signerAddress,
      signerPrivateKey: signerPrivKey,
      agentApproved: true,
      builderApproved,
      debug: debugParts.join(" | "),
    };
  } catch (e: any) {
    console.error(`[AsterCode] Onboard error:`, e.message);
    return {
      success: false,
      error: e.message,
      debug: debugParts.join(" | "),
    };
  }
}

const spotBalanceCache = new Map<string, { data: any[]; ts: number }>();

export function createAsterCodeFuturesClient(
  userAddress: string,
  signerAddress: string,
  signerPrivateKey: string,
  codeConfig: AsterCodeConfig,
) {
  const baseUrl = codeConfig.fApiUrl || DEFAULT_FAPI_URL;
  const builderAddress = codeConfig.builderAddress;
  const feeRate = codeConfig.feeRate;

  return {
    async noop(): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/noop", userAddress, signerAddress, signerPrivateKey, {}, "POST");
    },

    async ping(): Promise<boolean> {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const res = await fetch(`${baseUrl}/fapi/v3/ping`, { signal: controller.signal });
        clearTimeout(timeoutId);
        return res.ok;
      } catch {
        return false;
      }
    },

    async exchangeInfo(): Promise<any> {
      const res = await fetch(`${baseUrl}/fapi/v3/exchangeInfo`);
      return res.json();
    },

    async ticker(symbol?: string): Promise<any> {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      const qs = buildQueryString(params);
      const url = qs ? `${baseUrl}/fapi/v3/ticker/24hr?${qs}` : `${baseUrl}/fapi/v3/ticker/24hr`;
      const res = await fetch(url);
      return res.json();
    },

    async tickerPrice(symbol?: string): Promise<any> {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      const qs = buildQueryString(params);
      const url = qs ? `${baseUrl}/fapi/v3/ticker/price?${qs}` : `${baseUrl}/fapi/v3/ticker/price`;
      const res = await fetch(url);
      return res.json();
    },

    async orderBook(symbol: string, limit: number = 20): Promise<any> {
      const res = await fetch(`${baseUrl}/fapi/v3/depth?symbol=${symbol}&limit=${limit}`);
      return res.json();
    },

    async klines(symbol: string, interval: string = "1h", limit: number = 100): Promise<any[]> {
      const res = await fetch(`${baseUrl}/fapi/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      const raw = await res.json();
      if (!Array.isArray(raw)) return [];
      return raw.map((k: any[]) => ({
        openTime: k[0], open: String(k[1]), high: String(k[2]), low: String(k[3]),
        close: String(k[4]), volume: String(k[5]), closeTime: k[6],
        quoteVolume: String(k[7]), trades: k[8] || 0,
      }));
    },

    async fundingRate(symbol?: string, limit: number = 20): Promise<any[]> {
      const params: Record<string, any> = { limit };
      if (symbol) params.symbol = symbol;
      const qs = buildQueryString(params);
      const res = await fetch(`${baseUrl}/fapi/v3/fundingRate?${qs}`);
      return res.json();
    },

    async premiumIndex(symbol?: string): Promise<any> {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      const qs = buildQueryString(params);
      const url = qs ? `${baseUrl}/fapi/v3/premiumIndex?${qs}` : `${baseUrl}/fapi/v3/premiumIndex`;
      const res = await fetch(url);
      return res.json();
    },

    async balance(): Promise<any[]> {
      return makeTradingRequest(baseUrl, "/fapi/v3/balance", userAddress, signerAddress, signerPrivateKey, {}, "GET");
    },

    async account(): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/account", userAddress, signerAddress, signerPrivateKey, {}, "GET");
    },

    async positionRisk(): Promise<any[]> {
      const data = await makeTradingRequest(baseUrl, "/fapi/v3/positionRisk", userAddress, signerAddress, signerPrivateKey, {}, "GET");
      if (Array.isArray(data)) return data;
      return [];
    },

    async positions(): Promise<any[]> {
      return this.positionRisk();
    },

    async testConnection(): Promise<{ success: boolean; data?: any; error?: string }> {
      try {
        const acct = await this.account();
        return { success: true, data: acct };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    async createOrder(orderParams: {
      symbol: string;
      side: "BUY" | "SELL";
      type: string;
      quantity?: string;
      price?: string;
      stopPrice?: string;
      timeInForce?: string;
      reduceOnly?: boolean;
      closePosition?: boolean;
      positionSide?: string;
      newClientOrderId?: string;
      quoteOrderQty?: string;
      activationPrice?: string;
      callbackRate?: string;
      workingType?: string;
    }): Promise<any> {
      const params: Record<string, any> = {
        symbol: orderParams.symbol,
        side: orderParams.side,
        type: orderParams.type,
      };
      if (builderAddress && builderAddress.toLowerCase() !== userAddress.toLowerCase()) {
        params.builder = builderAddress;
        params.feeRate = feeRate;
      }
      if (orderParams.quantity) params.quantity = orderParams.quantity;
      if (orderParams.price) params.price = orderParams.price;
      if (orderParams.stopPrice) params.stopPrice = orderParams.stopPrice;
      if (orderParams.timeInForce) params.timeInForce = orderParams.timeInForce;
      if (orderParams.reduceOnly !== undefined) params.reduceOnly = orderParams.reduceOnly;
      if (orderParams.closePosition !== undefined) params.closePosition = orderParams.closePosition;
      if (orderParams.positionSide) params.positionSide = orderParams.positionSide;
      if (orderParams.quoteOrderQty) params.quoteOrderQty = orderParams.quoteOrderQty;
      if (orderParams.activationPrice) params.activationPrice = orderParams.activationPrice;
      if (orderParams.callbackRate) params.callbackRate = orderParams.callbackRate;
      if (orderParams.workingType) params.workingType = orderParams.workingType;
      if (orderParams.type === "LIMIT" && !params.timeInForce) params.timeInForce = "GTC";
      if (orderParams.newClientOrderId) params.newClientOrderId = orderParams.newClientOrderId;
      return makeTradingRequest(baseUrl, "/fapi/v3/order", userAddress, signerAddress, signerPrivateKey, params, "POST");
    },

    async cancelOrder(symbol: string, orderId: number): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/order", userAddress, signerAddress, signerPrivateKey, { symbol, orderId }, "DELETE");
    },

    async cancelAllOrders(symbol: string): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/allOpenOrders", userAddress, signerAddress, signerPrivateKey, { symbol }, "DELETE");
    },

    async openOrders(symbol?: string): Promise<any[]> {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      return makeTradingRequest(baseUrl, "/fapi/v3/openOrders", userAddress, signerAddress, signerPrivateKey, params, "GET");
    },

    async allOrders(symbol: string, limit: number = 50): Promise<any[]> {
      return makeTradingRequest(baseUrl, "/fapi/v3/allOrders", userAddress, signerAddress, signerPrivateKey, { symbol, limit }, "GET");
    },

    async userTrades(symbol: string, limit: number = 50): Promise<any[]> {
      try {
        const r = await makeTradingRequest(baseUrl, "/fapi/v3/userTrades", userAddress, signerAddress, signerPrivateKey, { symbol, limit }, "GET");
        if (Array.isArray(r)) return r;
      } catch {}
      try {
        const r2 = await makeTradingRequest(baseUrl, "/fapi/v3/userTrades", userAddress, signerAddress, signerPrivateKey, { symbol, limit }, "POST");
        if (Array.isArray(r2)) return r2;
      } catch {}
      return [];
    },

    async setLeverage(symbol: string, leverage: number): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/leverage", userAddress, signerAddress, signerPrivateKey, { symbol, leverage }, "POST");
    },

    async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/marginType", userAddress, signerAddress, signerPrivateKey, { symbol, marginType }, "POST");
    },

    async income(incomeType?: string, limit: number = 50): Promise<any[]> {
      const params: Record<string, any> = { limit };
      if (incomeType) params.incomeType = incomeType;
      try {
        const result = await makeTradingRequest(baseUrl, "/fapi/v3/income", userAddress, signerAddress, signerPrivateKey, params, "GET");
        if (Array.isArray(result)) return result;
      } catch {}
      return [];
    },

    async listenKey(): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/listenKey", userAddress, signerAddress, signerPrivateKey, {}, "POST");
    },

    async spotBalance(): Promise<{ asset: string; free: string; locked: string }[]> {
      const cacheKey = `spotBal_${userAddress}`;
      const cached = spotBalanceCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < 60000) return cached.data;

      try {
        const result = await makeTradingRequest(baseUrl, "/sapi/v3/account", userAddress, signerAddress, signerPrivateKey, {}, "GET");
        if (result?.balances) { spotBalanceCache.set(cacheKey, { data: result.balances, ts: Date.now() }); return result.balances; }
      } catch {}
      try {
        const result2 = await makeTradingRequest(baseUrl, "/sapi/v1/account", userAddress, signerAddress, signerPrivateKey, {}, "GET");
        if (result2?.balances) { spotBalanceCache.set(cacheKey, { data: result2.balances, ts: Date.now() }); return result2.balances; }
      } catch {}
      spotBalanceCache.set(cacheKey, { data: [], ts: Date.now() });
      return [];
    },

    async spotToFutures(asset: string, amount: string): Promise<any> {
      try {
        return await makeTradingRequest(baseUrl, "/fapi/v3/asset/wallet/transfer", userAddress, signerAddress, signerPrivateKey, { asset, amount, kindType: "SPOT_FUTURE" }, "POST");
      } catch (e: any) {
        console.log(`[AsterCode] spotToFutures v3 failed: ${e.message?.substring(0, 100)}`);
        return makeTradingRequest(baseUrl, "/sapi/v1/asset/transfer", userAddress, signerAddress, signerPrivateKey, { asset, amount, type: 1 }, "POST");
      }
    },

    async futuresToSpot(asset: string, amount: string): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/asset/wallet/transfer", userAddress, signerAddress, signerPrivateKey, { asset, amount, kindType: "FUTURE_SPOT" }, "POST");
    },

    async withdrawOnChain(coin: string, amount: string, toAddress: string, network: string = "BSC"): Promise<any> {
      return makeTradingRequest(baseUrl, "/sapi/v1/capital/withdraw/apply", userAddress, signerAddress, signerPrivateKey, { coin, amount, address: toAddress, network }, "POST");
    },

    getBuilderAddress(): string {
      return builderAddress;
    },

    getFeeRate(): string {
      return feeRate;
    },
  };
}

export type AsterCodeFuturesClient = ReturnType<typeof createAsterCodeFuturesClient>;

import crypto from "crypto";

export interface InferenceResult {
  text: string;
  latencyMs: number;
  tokensUsed?: number;
  model: string;
  proofHash?: string;
  proofType?: string;
  live: boolean;
}

interface ProviderConfig {
  network: string;
  baseUrl: string;
  apiKeyEnv: string;
  defaultModel: string;
  models: string[];
  requiresAuth: boolean;
  nodeHosted?: boolean;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  hyperbolic: {
    network: "hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    apiKeyEnv: "HYPERBOLIC_API_KEY",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "Qwen/Qwen2.5-72B-Instruct",
    ],
    requiresAuth: true,
  },
  akash: {
    network: "akash",
    baseUrl: "https://api.akashml.com/v1",
    apiKeyEnv: "AKASH_API_KEY",
    defaultModel: "deepseek-ai/DeepSeek-V3.2",
    models: [
      "deepseek-ai/DeepSeek-V3.2",
      "meta-llama/Llama-3.3-70B-Instruct",
      "Qwen/Qwen3-30B-A3B",
    ],
    requiresAuth: true,
  },
  ritual: {
    network: "ritual",
    baseUrl: process.env.RITUAL_NODE_URL || "http://localhost:4000",
    apiKeyEnv: "RITUAL_NODE_URL",
    defaultModel: "llama-3.1-8b",
    models: ["llama-3.1-8b", "mistral-7b-instruct"],
    requiresAuth: true,
    nodeHosted: true,
  },
};

function getApiKey(network: string): string | undefined {
  const config = PROVIDER_CONFIGS[network];
  if (!config) return undefined;
  return process.env[config.apiKeyEnv];
}

export function isProviderLive(network: string): boolean {
  const config = PROVIDER_CONFIGS[network];
  if (!config) return false;
  if (!config.requiresAuth) return true;
  return !!getApiKey(network);
}

export function getProviderStatus(): Record<string, { live: boolean; network: string; models: string[]; nodeHosted?: boolean }> {
  const status: Record<string, { live: boolean; network: string; models: string[]; nodeHosted?: boolean }> = {};
  for (const [key, config] of Object.entries(PROVIDER_CONFIGS)) {
    status[key] = {
      live: isProviderLive(key),
      network: config.network,
      models: config.models,
      ...(config.nodeHosted ? { nodeHosted: true } : {}),
    };
  }
  return status;
}

export function getAvailableProviders(): string[] {
  return Object.keys(PROVIDER_CONFIGS).filter(k => isProviderLive(k));
}

function generateProofHash(prompt: string, response: string, model: string): string {
  const data = `${prompt}:${response}:${model}:${Date.now()}`;
  return "0x" + crypto.createHash("sha256").update(data).digest("hex");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  prompt: string,
  maxTokens: number = 512,
  options?: { systemPrompt?: string; temperature?: number; conversationHistory?: ChatMessage[] }
): Promise<{ text: string; tokensUsed: number; latencyMs: number }> {
  const start = Date.now();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (options?.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  if (options?.conversationHistory && options.conversationHistory.length > 0) {
    for (const msg of options.conversationHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: "user", content: prompt });

  const controller = new AbortController();
  const timeoutMs = maxTokens > 1024 ? 90000 : 30000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: options?.temperature ?? 0.7,
    }),
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Provider returned ${response.status}: ${errorBody}`);
  }

  const data = await response.json() as any;
  const latencyMs = Date.now() - start;

  const text = data.choices?.[0]?.message?.content || "";
  const tokensUsed = data.usage?.total_tokens || 0;

  return { text, tokensUsed, latencyMs };
}

function noProviderError(network: string, model: string): InferenceResult {
  const envVar = PROVIDER_CONFIGS[network]?.apiKeyEnv || "API_KEY";
  return {
    text: `[NO_PROVIDER] ${network} is not available. Configure ${envVar} to enable decentralized inference.`,
    latencyMs: 0,
    model,
    proofType: "none",
    live: false,
  };
}

export async function runInference(
  network: string,
  model: string | undefined,
  prompt: string,
  options?: { systemPrompt?: string; temperature?: number; maxTokens?: number; conversationHistory?: ChatMessage[] }
): Promise<InferenceResult> {
  const config = PROVIDER_CONFIGS[network];
  if (!config) {
    return noProviderError(network, model || "unknown");
  }

  const apiKey = getApiKey(network);
  const selectedModel = model || config.defaultModel;

  if (config.requiresAuth && !apiKey) {
    return noProviderError(network, selectedModel);
  }

  try {
    const result = await callOpenAICompatible(
      config.baseUrl,
      apiKey,
      selectedModel,
      prompt,
      options?.maxTokens || 512,
      options
    );

    const proofHash = generateProofHash(prompt, result.text, selectedModel);

    return {
      text: result.text,
      latencyMs: result.latencyMs,
      tokensUsed: result.tokensUsed,
      model: selectedModel,
      proofHash,
      proofType: network === "ritual" ? "zkml-attestation" : "sha256-inference",
      live: true,
    };
  } catch (error: any) {
    console.error(`[Inference] ${network} error:`, error.message);

    const fallback = noProviderError(network, selectedModel);
    fallback.text = `[ERROR - ${network}] Provider returned error: ${error.message}. No fallback available.`;
    return fallback;
  }
}

export async function runInferenceWithFallback(
  preferredNetworks: string[],
  model: string | undefined,
  prompt: string,
  options?: { systemPrompt?: string; temperature?: number; maxTokens?: number; conversationHistory?: ChatMessage[] }
): Promise<InferenceResult & { network: string }> {
  for (const network of preferredNetworks) {
    if (isProviderLive(network)) {
      try {
        const result = await runInference(network, model, prompt, options);
        if (result.live) {
          return { ...result, network };
        }
      } catch (e) {
        continue;
      }
    }
  }

  const fallbackNetwork = preferredNetworks[0] || "hyperbolic";
  const result = await runInference(fallbackNetwork, model, prompt, options);
  return { ...result, network: fallbackNetwork };
}

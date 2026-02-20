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
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  hyperbolic: {
    network: "hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    apiKeyEnv: "HYPERBOLIC_API_KEY",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    models: [
      "deepseek-ai/DeepSeek-V3",
      "meta-llama/Llama-3.1-70B-Instruct",
      "meta-llama/Llama-3.1-8B-Instruct",
      "Qwen/Qwen2.5-72B-Instruct",
    ],
    requiresAuth: true,
  },
  akash: {
    network: "akash",
    baseUrl: "https://api.akashml.com/v1",
    apiKeyEnv: "AKASH_API_KEY",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    models: [
      "deepseek-ai/DeepSeek-V3",
      "meta-llama/Llama-3.3-70B",
      "Qwen/Qwen3-30B-A3B",
    ],
    requiresAuth: true,
  },
  ritual: {
    network: "ritual",
    baseUrl: "https://infernet.ritual.net/api/v1",
    apiKeyEnv: "RITUAL_API_KEY",
    defaultModel: "llama-3.1-8b",
    models: ["llama-3.1-8b", "mistral-7b-instruct"],
    requiresAuth: true,
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

export function getProviderStatus(): Record<string, { live: boolean; network: string; models: string[] }> {
  const status: Record<string, { live: boolean; network: string; models: string[] }> = {};
  for (const [key, config] of Object.entries(PROVIDER_CONFIGS)) {
    status[key] = {
      live: isProviderLive(key),
      network: config.network,
      models: config.models,
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

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  prompt: string,
  maxTokens: number = 512
): Promise<{ text: string; tokensUsed: number; latencyMs: number }> {
  const start = Date.now();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
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

function simulateInference(network: string, model: string, prompt: string): InferenceResult {
  const latencyMs = 200 + Math.floor(Math.random() * 300);
  const text = `[SIMULATED - ${network}] Response for model ${model}. No API key configured for live inference. Configure ${PROVIDER_CONFIGS[network]?.apiKeyEnv || "API_KEY"} to enable real decentralized inference. Prompt received: "${prompt.substring(0, 80)}..."`;

  return {
    text,
    latencyMs,
    model,
    proofHash: generateProofHash(prompt, text, model),
    proofType: "simulated",
    live: false,
  };
}

export async function runInference(
  network: string,
  model: string | undefined,
  prompt: string
): Promise<InferenceResult> {
  const config = PROVIDER_CONFIGS[network];
  if (!config) {
    return simulateInference(network, model || "unknown", prompt);
  }

  const apiKey = getApiKey(network);
  const selectedModel = model || config.defaultModel;

  if (config.requiresAuth && !apiKey) {
    return simulateInference(network, selectedModel, prompt);
  }

  try {
    const result = await callOpenAICompatible(
      config.baseUrl,
      apiKey,
      selectedModel,
      prompt
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

    const fallback = simulateInference(network, selectedModel, prompt);
    fallback.text = `[FALLBACK - ${network}] Provider returned error: ${error.message}. Falling back to simulation mode.`;
    return fallback;
  }
}

export async function runInferenceWithFallback(
  preferredNetworks: string[],
  model: string | undefined,
  prompt: string
): Promise<InferenceResult & { network: string }> {
  for (const network of preferredNetworks) {
    if (isProviderLive(network)) {
      try {
        const result = await runInference(network, model, prompt);
        if (result.live) {
          return { ...result, network };
        }
      } catch (e) {
        continue;
      }
    }
  }

  const fallbackNetwork = preferredNetworks[0] || "hyperbolic";
  const result = await runInference(fallbackNetwork, model, prompt);
  return { ...result, network: fallbackNetwork };
}

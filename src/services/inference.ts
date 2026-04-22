import Anthropic from '@anthropic-ai/sdk'

export type Provider = 'anthropic' | 'xai' | 'hyperbolic' | 'akash'

export interface CallLLMArgs {
  provider: Provider
  model?: string
  system?: string
  user: string
  jsonMode?: boolean
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
}

export interface CallLLMResult {
  text: string
  model: string
  provider: Provider
  latencyMs: number
  tokensUsed: number
}

export class InferenceError extends Error {
  provider: Provider
  status: number
  body: string
  constructor(provider: Provider, status: number, body: string, message?: string) {
    super(message ?? `[inference:${provider}] ${status}: ${body.slice(0, 200)}`)
    this.name = 'InferenceError'
    this.provider = provider
    this.status = status
    this.body = body
  }
}

interface ProviderConfig {
  apiKeyEnv: string
  baseUrl: string
  defaultModel: string
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5-20250514',
  },
  xai: {
    apiKeyEnv: 'XAI_API_KEY',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3-mini',
  },
  hyperbolic: {
    apiKeyEnv: 'HYPERBOLIC_API_KEY',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  akash: {
    apiKeyEnv: 'AKASH_API_KEY',
    baseUrl: 'https://api.akashml.com/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3.2',
  },
}

export function getProviderConfig(provider: Provider): ProviderConfig {
  return PROVIDERS[provider]
}

export function getProviderStatus(): Record<Provider, { live: boolean; envVar: string; defaultModel: string }> {
  const out = {} as Record<Provider, { live: boolean; envVar: string; defaultModel: string }>
  for (const [key, cfg] of Object.entries(PROVIDERS) as [Provider, ProviderConfig][]) {
    out[key] = {
      live: !!process.env[cfg.apiKeyEnv],
      envVar: cfg.apiKeyEnv,
      defaultModel: cfg.defaultModel,
    }
  }
  return out
}

export interface InferenceDeps {
  fetch: typeof fetch
  anthropicFactory: (apiKey: string) => Pick<Anthropic, 'messages'>
}

const defaultDeps: InferenceDeps = {
  fetch: (...args) => fetch(...(args as Parameters<typeof fetch>)),
  anthropicFactory: (apiKey: string) => new Anthropic({ apiKey }),
}

let activeDeps: InferenceDeps = defaultDeps

export function __setTestDeps(deps: Partial<InferenceDeps>): void {
  activeDeps = { ...defaultDeps, ...deps }
}

export function __resetTestDeps(): void {
  activeDeps = defaultDeps
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 1024

export async function callLLM(args: CallLLMArgs): Promise<CallLLMResult> {
  const cfg = PROVIDERS[args.provider]
  if (!cfg) throw new Error(`[inference] unknown provider: ${args.provider}`)
  const apiKey = process.env[cfg.apiKeyEnv]
  if (!apiKey) {
    throw new InferenceError(args.provider, 0, '', `[inference:${args.provider}] missing ${cfg.apiKeyEnv}`)
  }
  const model = args.model ?? cfg.defaultModel
  const maxTokens = args.maxTokens ?? DEFAULT_MAX_TOKENS
  const temperature = args.temperature ?? 0.7
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (args.provider === 'anthropic') {
    return callAnthropic({ apiKey, model, args, maxTokens, temperature, timeoutMs })
  }
  return callOpenAICompat({ apiKey, model, baseUrl: cfg.baseUrl, args, maxTokens, temperature, timeoutMs })
}

async function callAnthropic(opts: {
  apiKey: string
  model: string
  args: CallLLMArgs
  maxTokens: number
  temperature: number
  timeoutMs: number
}): Promise<CallLLMResult> {
  const { apiKey, model, args, maxTokens, temperature, timeoutMs } = opts
  const client = activeDeps.anthropicFactory(apiKey)
  const start = Date.now()

  const system = args.jsonMode
    ? `${args.system ?? ''}\n\nRespond with valid JSON only. No prose, no markdown fences.`.trim()
    : args.system

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp: any = await (client.messages.create as any)(
      {
        model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: args.user }],
      },
      { signal: controller.signal },
    )
    const text = (resp?.content ?? [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim()
    const tokensUsed = (resp?.usage?.input_tokens ?? 0) + (resp?.usage?.output_tokens ?? 0)
    return {
      text,
      model: resp?.model ?? model,
      provider: 'anthropic',
      latencyMs: Date.now() - start,
      tokensUsed,
    }
  } catch (err: any) {
    if (err instanceof InferenceError) throw err
    const status = typeof err?.status === 'number' ? err.status : 0
    const body = typeof err?.error === 'object' ? JSON.stringify(err.error) : String(err?.message ?? err)
    throw new InferenceError('anthropic', status, body)
  } finally {
    clearTimeout(timer)
  }
}

async function callOpenAICompat(opts: {
  apiKey: string
  model: string
  baseUrl: string
  args: CallLLMArgs
  maxTokens: number
  temperature: number
  timeoutMs: number
}): Promise<CallLLMResult> {
  const { apiKey, model, baseUrl, args, maxTokens, temperature, timeoutMs } = opts
  const messages: Array<{ role: string; content: string }> = []
  if (args.system) messages.push({ role: 'system', content: args.system })
  messages.push({ role: 'user', content: args.user })

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  }
  if (args.jsonMode) body.response_format = { type: 'json_object' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = Date.now()
  try {
    const resp = await activeDeps.fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const rawBody = await resp.text()
    if (!resp.ok) {
      throw new InferenceError(args.provider, resp.status, rawBody)
    }
    let data: any
    try {
      data = JSON.parse(rawBody)
    } catch {
      throw new InferenceError(args.provider, resp.status, rawBody, `[inference:${args.provider}] malformed JSON response`)
    }
    const text = (data?.choices?.[0]?.message?.content ?? '').trim()
    const tokensUsed = data?.usage?.total_tokens ?? 0
    return {
      text,
      model: data?.model ?? model,
      provider: args.provider,
      latencyMs: Date.now() - start,
      tokensUsed,
    }
  } catch (err: any) {
    if (err instanceof InferenceError) throw err
    const msg = err?.name === 'AbortError' ? `request timed out after ${timeoutMs}ms` : String(err?.message ?? err)
    throw new InferenceError(args.provider, 0, msg)
  } finally {
    clearTimeout(timer)
  }
}

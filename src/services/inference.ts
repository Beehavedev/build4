import Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages'

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
  /** Prompt/input tokens billed by the provider. 0 if the provider did not return a breakdown. */
  inputTokens: number
  /** Completion/output tokens billed by the provider. 0 if the provider did not return a breakdown. */
  outputTokens: number
  /** Sum of input + output. Kept for back-compat with telemetry rows written before the split. */
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

export interface AnthropicMessagesClient {
  create(
    params: MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Message>
}

export interface AnthropicLike {
  messages: AnthropicMessagesClient
}

export interface OpenAICompatChoice {
  message?: { content?: string | null }
}

export interface OpenAICompatResponse {
  model?: string
  choices?: OpenAICompatChoice[]
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
}

export interface InferenceDeps {
  fetch: typeof fetch
  anthropicFactory: (apiKey: string) => AnthropicLike
}

const defaultDeps: InferenceDeps = {
  fetch: (input, init) => fetch(input, init),
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

// ---- Circuit breaker for fatal auth/billing errors ------------------------
// When a provider returns 401/402/403 or a body matching billing-exhausted
// language ("insufficient credits", "credit balance is too low"), we park it
// for CIRCUIT_COOLOFF_MS so the agent runner stops hammering a known-dead key
// every tick. The first call after the cool-off retries the real provider
// (so the breaker self-heals once credits are topped up). Per-tick logs stay
// quiet during the park window — we emit one "tripped" line per provider per
// park and that's it.
const CIRCUIT_COOLOFF_MS = 10 * 60_000
const FATAL_STATUS = new Set([401, 402, 403])
const FATAL_BODY_PATTERNS = [
  /insufficient[_\s-]*credits?/i,
  /credit[_\s]*balance[_\s]*(is[_\s]*)?too[_\s]*low/i,
  /quota[_\s]*exceeded/i,
  /billing/i,
  /does not have permission/i,
]
const circuitParkedUntil: Partial<Record<Provider, number>> = {}

function isFatalError(status: number, body: string): boolean {
  if (FATAL_STATUS.has(status)) return true
  if (!body) return false
  return FATAL_BODY_PATTERNS.some((re) => re.test(body))
}

function tripCircuit(provider: Provider, status: number, body: string): void {
  const now = Date.now()
  const until = now + CIRCUIT_COOLOFF_MS
  if ((circuitParkedUntil[provider] ?? 0) > now) return // already parked, no log spam
  circuitParkedUntil[provider] = until
  const snippet = body.slice(0, 120).replace(/\s+/g, ' ')
  console.warn(
    `[inference:${provider}] circuit tripped — status=${status} parked for ${Math.round(
      CIRCUIT_COOLOFF_MS / 60_000,
    )}m. body=${snippet}`,
  )
}

function checkCircuit(provider: Provider): void {
  const until = circuitParkedUntil[provider]
  if (!until) return
  if (Date.now() < until) {
    throw new InferenceError(
      provider,
      503,
      'circuit-open',
      `[inference:${provider}] circuit open — provider had a fatal error recently, parked until ${new Date(
        until,
      ).toISOString()}`,
    )
  }
  // window elapsed; clear and allow the next call to probe the provider
  delete circuitParkedUntil[provider]
}

/** Test/admin helper — clear all parked providers immediately. */
export function __resetCircuits(): void {
  for (const k of Object.keys(circuitParkedUntil) as Provider[]) {
    delete circuitParkedUntil[k]
  }
}

/** Snapshot of currently parked providers and their unpark time (ms epoch). */
export function getCircuitState(): Partial<Record<Provider, number>> {
  return { ...circuitParkedUntil }
}

interface ResolvedCall {
  apiKey: string
  model: string
  maxTokens: number
  temperature: number
  timeoutMs: number
}

function resolveCall(args: CallLLMArgs, cfg: ProviderConfig): ResolvedCall {
  const apiKey = process.env[cfg.apiKeyEnv]
  if (!apiKey) {
    throw new InferenceError(args.provider, 0, '', `[inference:${args.provider}] missing ${cfg.apiKeyEnv}`)
  }
  return {
    apiKey,
    model: args.model ?? cfg.defaultModel,
    maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: args.temperature ?? 0.7,
    timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}


export async function callLLM(args: CallLLMArgs): Promise<CallLLMResult> {
  const cfg = PROVIDERS[args.provider]
  if (!cfg) throw new Error(`[inference] unknown provider: ${args.provider}`)
  checkCircuit(args.provider)
  const resolved = resolveCall(args, cfg)
  try {
    if (args.provider === 'anthropic') {
      return await callAnthropic(args, resolved)
    }
    return await callOpenAICompat(args, resolved, cfg.baseUrl)
  } catch (err) {
    if (err instanceof InferenceError && isFatalError(err.status, err.body)) {
      tripCircuit(args.provider, err.status, err.body)
    }
    throw err
  }
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text'
}

async function callAnthropic(args: CallLLMArgs, r: ResolvedCall): Promise<CallLLMResult> {
  const client = activeDeps.anthropicFactory(r.apiKey)
  const start = Date.now()

  const system = args.jsonMode
    ? `${args.system ?? ''}\n\nRespond with valid JSON only. No prose, no markdown fences.`.trim()
    : args.system

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), r.timeoutMs)
  try {
    const params: MessageCreateParamsNonStreaming = {
      model: r.model,
      max_tokens: r.maxTokens,
      temperature: r.temperature,
      messages: [{ role: 'user', content: args.user }],
      ...(system ? { system } : {}),
    }
    const resp: Message = await client.messages.create(params, { signal: controller.signal })
    const text = resp.content
      .filter(isTextBlock)
      .map((b) => b.text)
      .join('\n')
      .trim()
    const inputTokens = resp.usage?.input_tokens ?? 0
    const outputTokens = resp.usage?.output_tokens ?? 0
    return {
      text,
      model: resp.model ?? r.model,
      provider: 'anthropic',
      latencyMs: Date.now() - start,
      inputTokens,
      outputTokens,
      tokensUsed: inputTokens + outputTokens,
    }
  } catch (err: unknown) {
    if (err instanceof InferenceError) throw err
    const e = err as { status?: number; error?: unknown; message?: string; name?: string }
    const status = typeof e?.status === 'number' ? e.status : 0
    const body =
      typeof e?.error === 'object' && e.error !== null
        ? JSON.stringify(e.error)
        : String(e?.message ?? err)
    throw new InferenceError('anthropic', status, body)
  } finally {
    clearTimeout(timer)
  }
}

interface OpenAICompatRequestBody {
  model: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  max_tokens: number
  temperature: number
  response_format?: { type: 'json_object' }
}

async function callOpenAICompat(
  args: CallLLMArgs,
  r: ResolvedCall,
  baseUrl: string,
): Promise<CallLLMResult> {
  const messages: OpenAICompatRequestBody['messages'] = []
  if (args.system) messages.push({ role: 'system', content: args.system })
  messages.push({ role: 'user', content: args.user })

  const body: OpenAICompatRequestBody = {
    model: r.model,
    messages,
    max_tokens: r.maxTokens,
    temperature: r.temperature,
  }
  if (args.jsonMode) body.response_format = { type: 'json_object' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), r.timeoutMs)
  const start = Date.now()
  try {
    const resp = await activeDeps.fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${r.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const rawBody = await resp.text()
    if (!resp.ok) {
      throw new InferenceError(args.provider, resp.status, rawBody)
    }
    let data: OpenAICompatResponse
    try {
      data = JSON.parse(rawBody) as OpenAICompatResponse
    } catch {
      throw new InferenceError(args.provider, resp.status, rawBody, `[inference:${args.provider}] malformed JSON response`)
    }
    const text = (data.choices?.[0]?.message?.content ?? '').trim()
    // OpenAI-compatible providers expose prompt_tokens / completion_tokens.
    // When only total_tokens is returned (older or stripped-down providers),
    // we cannot recover the split, so we attribute the whole total to
    // outputTokens — that's the conservative choice for cost estimation
    // because output is the more expensive rate.
    const promptTokens = data.usage?.prompt_tokens
    const completionTokens = data.usage?.completion_tokens
    const totalTokens = data.usage?.total_tokens ?? 0
    const hasSplit = typeof promptTokens === 'number' && typeof completionTokens === 'number'
    const inputTokens = hasSplit ? promptTokens : 0
    const outputTokens = hasSplit ? completionTokens : totalTokens
    return {
      text,
      model: data.model ?? r.model,
      provider: args.provider,
      latencyMs: Date.now() - start,
      inputTokens,
      outputTokens,
      tokensUsed: hasSplit ? inputTokens + outputTokens : totalTokens,
    }
  } catch (err: unknown) {
    if (err instanceof InferenceError) throw err
    const e = err as { name?: string; message?: string }
    const msg = e?.name === 'AbortError' ? `request timed out after ${r.timeoutMs}ms` : String(e?.message ?? err)
    throw new InferenceError(args.provider, 0, msg)
  } finally {
    clearTimeout(timer)
  }
}

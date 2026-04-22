import { callLLM, type CallLLMArgs, type CallLLMResult, type Provider } from '../services/inference'

export interface SwarmCall<T> {
  provider: Provider
  ok: boolean
  decision: T | null
  rawText: string
  latencyMs: number
  tokensUsed: number
  error: string | null
}

export interface SwarmAgreementEntry {
  provider: Provider
  action: string | null
  prediction: string | null
}

export interface SwarmDivergence {
  actionHistogram: Record<string, number>
  predictionHistogram: Record<string, number>
  agreement: SwarmAgreementEntry[]
  successCount: number
  totalCount: number
  actionConsensus: string | null
  predictionConsensus: string | null
}

export interface SwarmResult<T> {
  decisions: SwarmCall<T>[]
  quorumDecision: T | null
  divergence: SwarmDivergence
  error: string | null
}

export interface RunSwarmArgs<T extends Record<string, unknown>> {
  providers: Provider[]
  system?: string
  user: string
  parse: (text: string) => T
  getAction: (decision: T) => string
  getPredictionKey?: (decision: T) => string | null
  predictionField?: keyof T & string
  quorum?: number
  timeoutMs?: number
  maxTokens?: number
  temperature?: number
  jsonMode?: boolean
  rawTextMaxChars?: number
  callLLMFn?: (args: CallLLMArgs) => Promise<CallLLMResult>
}

const DEFAULT_QUORUM = 2
const DEFAULT_RAW_TEXT_MAX = 4000
const DEFAULT_PREDICTION_FIELD = 'predictionTrade'

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

function pickWinner(histogram: Record<string, number>, threshold: number): string | null {
  let winner: string | null = null
  let best = 0
  for (const [key, count] of Object.entries(histogram)) {
    if (count > best) {
      winner = key
      best = count
    } else if (count === best) {
      winner = null
    }
  }
  return winner !== null && best >= threshold ? winner : null
}

export async function runSwarmDecision<T extends Record<string, unknown>>(
  args: RunSwarmArgs<T>,
): Promise<SwarmResult<T>> {
  const {
    providers,
    system,
    user,
    parse,
    getAction,
    getPredictionKey,
    predictionField = DEFAULT_PREDICTION_FIELD as keyof T & string,
    quorum = DEFAULT_QUORUM,
    timeoutMs,
    maxTokens,
    temperature,
    jsonMode,
    rawTextMaxChars = DEFAULT_RAW_TEXT_MAX,
    callLLMFn = callLLM,
  } = args

  if (providers.length === 0) {
    return {
      decisions: [],
      quorumDecision: null,
      divergence: emptyDivergence(),
      error: 'no providers configured',
    }
  }

  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const start = Date.now()
      try {
        const res = await callLLMFn({
          provider,
          system,
          user,
          jsonMode,
          maxTokens,
          temperature,
          timeoutMs,
        })
        return { provider, res, latencyMs: Date.now() - start }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { provider, error: msg, latencyMs: Date.now() - start }
      }
    }),
  )

  const calls: SwarmCall<T>[] = settled.map((s, i) => {
    const provider = providers[i]
    if (s.status === 'rejected') {
      return blankCall(provider, 0, String(s.reason))
    }
    const v = s.value
    if ('error' in v) {
      return blankCall(provider, v.latencyMs, v.error)
    }
    const rawText = truncate(v.res.text, rawTextMaxChars)
    try {
      const decision = parse(v.res.text)
      return {
        provider,
        ok: true,
        decision,
        rawText,
        latencyMs: v.latencyMs,
        tokensUsed: v.res.tokensUsed,
        error: null,
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        provider,
        ok: false,
        decision: null,
        rawText,
        latencyMs: v.latencyMs,
        tokensUsed: v.res.tokensUsed,
        error: `parse failed: ${msg}`,
      }
    }
  })

  const successes = calls.filter((c): c is SwarmCall<T> & { decision: T } => c.ok && c.decision !== null)

  const actionHistogram: Record<string, number> = {}
  const predictionHistogram: Record<string, number> = {}
  const agreement: SwarmAgreementEntry[] = calls.map((c) => {
    if (!c.ok || !c.decision) return { provider: c.provider, action: null, prediction: null }
    const action = safeGet(() => getAction(c.decision as T), null)
    const prediction = getPredictionKey ? safeGet(() => getPredictionKey(c.decision as T), null) : null
    return { provider: c.provider, action, prediction }
  })

  for (const entry of agreement) {
    if (entry.action) actionHistogram[entry.action] = (actionHistogram[entry.action] ?? 0) + 1
    if (entry.prediction) predictionHistogram[entry.prediction] = (predictionHistogram[entry.prediction] ?? 0) + 1
  }

  const actionConsensus = pickWinner(actionHistogram, quorum)
  const predictionConsensus = pickWinner(predictionHistogram, quorum)

  const divergence: SwarmDivergence = {
    actionHistogram,
    predictionHistogram,
    agreement,
    successCount: successes.length,
    totalCount: calls.length,
    actionConsensus,
    predictionConsensus,
  }

  if (successes.length === 0) {
    return {
      decisions: calls,
      quorumDecision: null,
      divergence,
      error: 'all providers failed',
    }
  }

  if (!actionConsensus) {
    return { decisions: calls, quorumDecision: null, divergence, error: null }
  }

  const winningCall = successes.find((c) => safeGet(() => getAction(c.decision), null) === actionConsensus)
  if (!winningCall) {
    return { decisions: calls, quorumDecision: null, divergence, error: null }
  }

  let quorumDecision: T = winningCall.decision
  if (predictionField in quorumDecision) {
    const predKey = getPredictionKey
      ? safeGet(() => getPredictionKey(quorumDecision), null)
      : null
    const keep = predictionConsensus !== null && predKey === predictionConsensus
    if (!keep) {
      quorumDecision = { ...quorumDecision, [predictionField]: null } as T
    }
  }

  return { decisions: calls, quorumDecision, divergence, error: null }
}

function blankCall<T>(provider: Provider, latencyMs: number, error: string): SwarmCall<T> {
  return {
    provider,
    ok: false,
    decision: null,
    rawText: '',
    latencyMs,
    tokensUsed: 0,
    error,
  }
}

function emptyDivergence(): SwarmDivergence {
  return {
    actionHistogram: {},
    predictionHistogram: {},
    agreement: [],
    successCount: 0,
    totalCount: 0,
    actionConsensus: null,
    predictionConsensus: null,
  }
}

function safeGet<R>(fn: () => R, fallback: R): R {
  try {
    return fn()
  } catch {
    return fallback
  }
}

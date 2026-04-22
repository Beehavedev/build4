import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callLLM, getProviderStatus, InferenceError, __setTestDeps, __resetTestDeps } from './inference'

function mockFetch(captured: { url?: string; init?: RequestInit }, body: any, status = 200) {
  return async (url: any, init: any) => {
    captured.url = String(url)
    captured.init = init
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response
  }
}

test('xai builds correct OpenAI-compatible request', async () => {
  process.env.XAI_API_KEY = 'xai-test-key'
  const captured: { url?: string; init?: RequestInit } = {}
  __setTestDeps({
    fetch: mockFetch(captured, {
      model: 'grok-3-mini',
      choices: [{ message: { content: ' hello world ' } }],
      usage: { total_tokens: 42, prompt_tokens: 30, completion_tokens: 12 },
    }) as any,
  })
  try {
    const res = await callLLM({ provider: 'xai', system: 'sys', user: 'hi', maxTokens: 100, temperature: 0.2 })
    assert.equal(captured.url, 'https://api.x.ai/v1/chat/completions')
    const headers = captured.init!.headers as Record<string, string>
    assert.equal(headers['Authorization'], 'Bearer xai-test-key')
    assert.equal(headers['Content-Type'], 'application/json')
    const sent = JSON.parse(captured.init!.body as string)
    assert.equal(sent.model, 'grok-3-mini')
    assert.equal(sent.max_tokens, 100)
    assert.equal(sent.temperature, 0.2)
    assert.deepEqual(sent.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    assert.equal(sent.response_format, undefined)
    assert.equal(res.text, 'hello world')
    assert.equal(res.tokensUsed, 42)
    assert.equal(res.inputTokens, 30)
    assert.equal(res.outputTokens, 12)
    assert.equal(res.provider, 'xai')
    assert.equal(res.model, 'grok-3-mini')
  } finally {
    __resetTestDeps()
    delete process.env.XAI_API_KEY
  }
})

test('hyperbolic uses correct base URL and default model', async () => {
  process.env.HYPERBOLIC_API_KEY = 'hyp-key'
  const captured: { url?: string; init?: RequestInit } = {}
  __setTestDeps({
    fetch: mockFetch(captured, { choices: [{ message: { content: 'ok' } }], usage: {} }) as any,
  })
  try {
    await callLLM({ provider: 'hyperbolic', user: 'q' })
    assert.equal(captured.url, 'https://api.hyperbolic.xyz/v1/chat/completions')
    const sent = JSON.parse(captured.init!.body as string)
    assert.equal(sent.model, 'meta-llama/Llama-3.3-70B-Instruct')
    assert.deepEqual(sent.messages, [{ role: 'user', content: 'q' }])
  } finally {
    __resetTestDeps()
    delete process.env.HYPERBOLIC_API_KEY
  }
})

test('akash uses correct base URL and forwards jsonMode', async () => {
  process.env.AKASH_API_KEY = 'ak-key'
  const captured: { url?: string; init?: RequestInit } = {}
  __setTestDeps({
    fetch: mockFetch(captured, { choices: [{ message: { content: '{}' } }], usage: {} }) as any,
  })
  try {
    await callLLM({ provider: 'akash', user: 'q', jsonMode: true })
    assert.equal(captured.url, 'https://api.akashml.com/v1/chat/completions')
    const sent = JSON.parse(captured.init!.body as string)
    assert.deepEqual(sent.response_format, { type: 'json_object' })
  } finally {
    __resetTestDeps()
    delete process.env.AKASH_API_KEY
  }
})

test('non-2xx response surfaces InferenceError with status and body', async () => {
  process.env.XAI_API_KEY = 'xai-key'
  __setTestDeps({
    fetch: mockFetch({}, 'rate limited', 429) as any,
  })
  try {
    await assert.rejects(
      () => callLLM({ provider: 'xai', user: 'q' }),
      (err: any) => {
        assert.ok(err instanceof InferenceError)
        assert.equal(err.provider, 'xai')
        assert.equal(err.status, 429)
        assert.equal(err.body, 'rate limited')
        return true
      },
    )
  } finally {
    __resetTestDeps()
    delete process.env.XAI_API_KEY
  }
})

test('missing API key throws InferenceError before any network call', async () => {
  delete process.env.XAI_API_KEY
  let fetchCalls = 0
  __setTestDeps({
    fetch: (async () => {
      fetchCalls++
      return new Response('{}')
    }) as any,
  })
  try {
    await assert.rejects(() => callLLM({ provider: 'xai', user: 'q' }), InferenceError)
    assert.equal(fetchCalls, 0)
  } finally {
    __resetTestDeps()
  }
})

test('anthropic routes through SDK with correct shape', async () => {
  process.env.ANTHROPIC_API_KEY = 'anthropic-key'
  let captured: any
  let receivedKey = ''
  __setTestDeps({
    anthropicFactory: (apiKey: string) => {
      receivedKey = apiKey
      return {
        messages: {
          create: async (params: any) => {
            captured = params
            return {
              model: 'claude-sonnet-4-5-20250514',
              content: [{ type: 'text', text: 'hi from claude' }],
              usage: { input_tokens: 10, output_tokens: 7 },
            }
          },
        },
      } as any
    },
  })
  try {
    const res = await callLLM({
      provider: 'anthropic',
      system: 'be brief',
      user: 'hello',
      maxTokens: 50,
      temperature: 0.1,
    })
    assert.equal(receivedKey, 'anthropic-key')
    assert.equal(captured.model, 'claude-sonnet-4-5-20250514')
    assert.equal(captured.max_tokens, 50)
    assert.equal(captured.temperature, 0.1)
    assert.equal(captured.system, 'be brief')
    assert.deepEqual(captured.messages, [{ role: 'user', content: 'hello' }])
    assert.equal(res.text, 'hi from claude')
    assert.equal(res.provider, 'anthropic')
    assert.equal(res.tokensUsed, 17)
    assert.equal(res.inputTokens, 10)
    assert.equal(res.outputTokens, 7)
  } finally {
    __resetTestDeps()
    delete process.env.ANTHROPIC_API_KEY
  }
})

test('anthropic jsonMode appends JSON-only system instruction', async () => {
  process.env.ANTHROPIC_API_KEY = 'anthropic-key'
  let captured: any
  __setTestDeps({
    anthropicFactory: () =>
      ({
        messages: {
          create: async (params: any) => {
            captured = params
            return { content: [{ type: 'text', text: '{}' }], usage: {} }
          },
        },
      }) as any,
  })
  try {
    await callLLM({ provider: 'anthropic', system: 'base', user: 'q', jsonMode: true })
    assert.match(captured.system, /base/)
    assert.match(captured.system, /JSON/i)
  } finally {
    __resetTestDeps()
    delete process.env.ANTHROPIC_API_KEY
  }
})

test('malformed JSON success body surfaces InferenceError', async () => {
  process.env.XAI_API_KEY = 'xai-key'
  __setTestDeps({
    fetch: (async () => ({
      ok: true,
      status: 200,
      text: async () => 'not-json{{',
    })) as any,
  })
  try {
    await assert.rejects(
      () => callLLM({ provider: 'xai', user: 'q' }),
      (err: any) => {
        assert.ok(err instanceof InferenceError)
        assert.equal(err.provider, 'xai')
        assert.equal(err.body, 'not-json{{')
        return true
      },
    )
  } finally {
    __resetTestDeps()
    delete process.env.XAI_API_KEY
  }
})

test('aborted fetch surfaces InferenceError with timeout message', async () => {
  process.env.XAI_API_KEY = 'xai-key'
  __setTestDeps({
    fetch: (async () => {
      const err: any = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }) as any,
  })
  try {
    await assert.rejects(
      () => callLLM({ provider: 'xai', user: 'q', timeoutMs: 25 }),
      (err: any) => {
        assert.ok(err instanceof InferenceError)
        assert.equal(err.provider, 'xai')
        assert.equal(err.status, 0)
        assert.match(err.body, /timed out/)
        return true
      },
    )
  } finally {
    __resetTestDeps()
    delete process.env.XAI_API_KEY
  }
})

test('getProviderStatus reflects env var presence', () => {
  delete process.env.XAI_API_KEY
  delete process.env.HYPERBOLIC_API_KEY
  delete process.env.AKASH_API_KEY
  process.env.ANTHROPIC_API_KEY = 'a'
  const before = getProviderStatus()
  assert.equal(before.anthropic.live, true)
  assert.equal(before.xai.live, false)
  process.env.XAI_API_KEY = 'x'
  const after = getProviderStatus()
  assert.equal(after.xai.live, true)
  assert.equal(after.xai.envVar, 'XAI_API_KEY')
  delete process.env.XAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
})

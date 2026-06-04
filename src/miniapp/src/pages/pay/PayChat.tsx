// Pay Agent — conversational interface. Sends messages to /api/pay/chat where
// a deterministic intent router answers from real data (LLM only rephrases).
import { useEffect, useRef, useState } from 'react'
import { payApi } from './payApi'
import { Btn, input } from './payUi'

interface Msg {
  role: 'user' | 'agent'
  text: string
}

const SUGGESTIONS = [
  "What's due this week?",
  'How much do I spend on subscriptions?',
  'Where can I save money?',
  'Pay my Netflix bill',
]

export default function PayChat() {
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: 'agent',
      text: "Hi — I'm your Pay Agent. Ask me what's due, what you spend, where you can save, or tell me to pay a bill. (Everything here is a simulation — no real money moves.)",
    },
  ])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs])

  async function send(message: string) {
    const m = message.trim()
    if (!m || busy) return
    setMsgs((prev) => [...prev, { role: 'user', text: m }])
    setText('')
    setBusy(true)
    try {
      const res = await payApi.chat(m)
      setMsgs((prev) => [...prev, { role: 'agent', text: res.reply }])
    } catch (e: any) {
      setMsgs((prev) => [...prev, { role: 'agent', text: e?.message ?? 'Something went wrong.' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ paddingTop: 6, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 220px)', minHeight: 360 }}>
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 8 }}>
        {msgs.map((m, i) => (
          <div
            key={i}
            data-testid={`chat-${m.role}-${i}`}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              background: m.role === 'user' ? 'var(--purple)' : 'var(--bg-card)',
              border: m.role === 'user' ? 'none' : '1px solid var(--border)',
              color: m.role === 'user' ? '#fff' : 'var(--text-primary)',
              borderRadius: 14,
              padding: '9px 13px',
              fontSize: 14,
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
            }}
          >
            {m.text}
          </div>
        ))}
        {busy && (
          <div style={{ alignSelf: 'flex-start', color: 'var(--text-secondary)', fontSize: 13, padding: '0 6px' }}>
            thinking…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {msgs.length <= 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              data-testid={`chat-suggestion-${s}`}
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 999,
                padding: '6px 11px',
                fontSize: 12,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(text)
          }}
          placeholder="Ask your Pay Agent…"
          data-testid="input-chat"
        />
        <Btn onClick={() => send(text)} disabled={busy || !text.trim()} testId="button-send-chat">
          Send
        </Btn>
      </div>
    </div>
  )
}

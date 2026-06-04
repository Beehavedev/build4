// Pay Agent — manage agent personas (name, avatar, role, personality).
import { useEffect, useState } from 'react'
import { payApi, type PayAgent } from './payApi'
import { Btn, Card, Empty, Loading, SectionTitle, input, label } from './payUi'

interface Form {
  id?: string
  name: string
  avatar: string
  role: string
  personality: string
}
const empty = (): Form => ({ name: '', avatar: '💸', role: 'Bills & Subscriptions Agent', personality: '' })

export default function PayAgents() {
  const [agents, setAgents] = useState<PayAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      setAgents(await payApi.agents())
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  async function save() {
    if (!form) return
    if (!form.name.trim()) {
      setMsg('Enter a name.')
      return
    }
    setBusy(true)
    try {
      const body = {
        name: form.name.trim(),
        avatar: form.avatar || '💸',
        role: form.role,
        personality: form.personality,
      }
      if (form.id) await payApi.updateAgent(form.id, body)
      else await payApi.createAgent(body)
      setForm(null)
      setMsg(null)
      await load()
    } catch (e: any) {
      setMsg(e?.message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    try {
      await payApi.deleteAgent(id)
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />

  if (form) {
    return (
      <div style={{ paddingTop: 6 }}>
        <SectionTitle>{form.id ? 'Edit agent' : 'New agent'}</SectionTitle>
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ width: 70 }}>
                <label style={label}>Icon</label>
                <input style={{ ...input, textAlign: 'center' }} value={form.avatar} maxLength={2} onChange={(e) => setForm({ ...form, avatar: e.target.value })} data-testid="input-agent-avatar" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>Name</label>
                <input style={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="input-agent-name" />
              </div>
            </div>
            <div>
              <label style={label}>Role</label>
              <input style={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} data-testid="input-agent-role" />
            </div>
            <div>
              <label style={label}>Personality</label>
              <textarea
                style={{ ...input, minHeight: 70, resize: 'vertical' }}
                value={form.personality}
                onChange={(e) => setForm({ ...form, personality: e.target.value })}
                placeholder="How should this agent talk to you?"
                data-testid="input-agent-personality"
              />
            </div>
            {msg && <div style={{ color: 'var(--red)', fontSize: 12 }}>{msg}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn onClick={save} disabled={busy} testId="button-save-agent">
                {busy ? 'Saving…' : 'Save'}
              </Btn>
              <Btn tone="ghost" onClick={() => { setForm(null); setMsg(null) }} testId="button-cancel-agent">
                Cancel
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 6 }}>
      <SectionTitle action={<Btn onClick={() => setForm(empty())} testId="button-add-agent">+ New</Btn>}>
        Agents ({agents.length})
      </SectionTitle>
      {agents.length === 0 ? (
        <Empty icon="🤖" title="No agents" hint="Create an agent persona to manage your bills." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agents.map((a) => (
            <Card key={a.id} testId={`agent-${a.id}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 28 }}>{a.avatar}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{a.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{a.role}</div>
                  {a.personality && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.4 }}>
                      {a.personality}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <Btn tone="ghost" onClick={() => setForm({ id: a.id, name: a.name, avatar: a.avatar, role: a.role, personality: a.personality })} testId={`button-edit-agent-${a.id}`}>
                  Edit
                </Btn>
                {agents.length > 1 && (
                  <Btn tone="danger" onClick={() => remove(a.id)} disabled={busy} testId={`button-delete-agent-${a.id}`} style={{ marginLeft: 'auto' }}>
                    Delete
                  </Btn>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

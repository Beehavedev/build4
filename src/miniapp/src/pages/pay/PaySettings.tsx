// Pay Agent — settings: payment methods (simulated), demo data, daily check,
// activity log and the full safety disclaimer.
import { useEffect, useState } from 'react'
import { payApi, type AgentAction, type PaymentMethod, type PaymentMethodType } from './payApi'
import { Btn, Card, Empty, Loading, Pill, SectionTitle, SimDisclaimer, input, label } from './payUi'

const TYPES: { value: PaymentMethodType; label: string }[] = [
  { value: 'build4', label: 'Build4 Wallet' },
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank' },
  { value: 'crypto', label: 'Crypto' },
  { value: 'stablecoin', label: 'Stablecoin' },
]

export default function PaySettings({ onReseed }: { onReseed: () => void }) {
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [actions, setActions] = useState<AgentAction[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [mType, setMType] = useState<PaymentMethodType>('card')
  const [mLabel, setMLabel] = useState('')
  const [mLast4, setMLast4] = useState('')

  async function load() {
    setLoading(true)
    try {
      const [m, a] = await Promise.all([payApi.methods(), payApi.actions()])
      setMethods(m)
      setActions(a)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  async function addMethod() {
    if (!mLabel.trim()) {
      setMsg('Enter a label.')
      return
    }
    setBusy('add')
    try {
      await payApi.createMethod({ type: mType, label: mLabel.trim(), last4: mLast4 || undefined })
      setAdding(false)
      setMLabel('')
      setMLast4('')
      setMsg(null)
      await load()
    } catch (e: any) {
      setMsg(e?.message ?? 'Failed')
    } finally {
      setBusy(null)
    }
  }

  async function runCheck() {
    setBusy('check')
    try {
      const r = await payApi.runCheck()
      setMsg(
        `Daily check complete: ${r.processed ?? 0} processed, ${r.approvalsRequested ?? 0} approvals, ${
          r.overdueMarked ?? 0
        } overdue.`,
      )
      await load()
    } catch (e: any) {
      setMsg(e?.message ?? 'Check failed')
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <Loading />

  return (
    <div style={{ paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <SimDisclaimer />

      <SectionTitle action={<Btn onClick={() => setAdding((v) => !v)} testId="button-add-method">{adding ? 'Close' : '+ Add'}</Btn>}>
        Payment methods
      </SectionTitle>
      {adding && (
        <Card style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={label}>Type</label>
              <select style={input as any} value={mType} onChange={(e) => setMType(e.target.value as PaymentMethodType)} data-testid="select-method-type">
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>Label</label>
                <input style={input} value={mLabel} onChange={(e) => setMLabel(e.target.value)} placeholder="e.g. Visa" data-testid="input-method-label" />
              </div>
              <div style={{ width: 90 }}>
                <label style={label}>Last 4</label>
                <input style={input} value={mLast4} maxLength={4} onChange={(e) => setMLast4(e.target.value)} placeholder="4242" data-testid="input-method-last4" />
              </div>
            </div>
            <Btn onClick={addMethod} disabled={busy === 'add'} testId="button-save-method">
              {busy === 'add' ? 'Adding…' : 'Add method'}
            </Btn>
          </div>
        </Card>
      )}
      {methods.length === 0 ? (
        <Empty icon="💳" title="No payment methods" hint="These are simulated — no real card details are stored." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {methods.map((m) => (
            <Card key={m.id} testId={`method-${m.id}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {m.label} {m.last4 && <span style={{ color: 'var(--text-secondary)' }}>•••• {m.last4}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{m.type}</div>
                </div>
                <Btn tone="ghost" onClick={() => { setBusy(m.id); payApi.deleteMethod(m.id).then(load).finally(() => setBusy(null)) }} disabled={busy === m.id} testId={`button-delete-method-${m.id}`}>
                  Remove
                </Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      <SectionTitle>Maintenance</SectionTitle>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <Btn tone="ghost" onClick={runCheck} disabled={busy === 'check'} testId="button-run-check">
            {busy === 'check' ? 'Running…' : 'Run daily check'}
          </Btn>
          <Btn tone="ghost" onClick={() => { payApi.seed().then(onReseed) }} testId="button-reseed">
            Load demo bills
          </Btn>
        </div>
        {msg && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10 }}>{msg}</div>}
      </Card>

      <SectionTitle>Activity log</SectionTitle>
      {actions.length === 0 ? (
        <Empty icon="📜" title="No activity yet" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {actions.slice(0, 30).map((a) => (
            <Card key={a.id} testId={`action-${a.id}`} style={{ padding: 11 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <Pill tone="purple">{a.actionType}</Pill>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{a.createdAt.slice(0, 16).replace('T', ' ')}</span>
              </div>
              {a.reasoning && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.4 }}>{a.reasoning}</div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

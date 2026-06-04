// Pay Agent — bills CRUD + per-bill actions (pay, mark paid, auto-pay toggle).
import { useEffect, useState } from 'react'
import {
  payApi,
  money,
  dueLabel,
  daysUntil,
  type Bill,
  type PaymentMethod,
  type BillFrequency,
} from './payApi'
import { Btn, Card, Empty, Loading, Pill, SectionTitle, input, label } from './payUi'

type Mode = 'manual' | 'approval' | 'auto'
function modeOf(b: Bill): Mode {
  if (b.autoPayEnabled) return 'auto'
  if (b.approvalRequired) return 'approval'
  return 'manual'
}
const modeTone = { manual: 'neutral', approval: 'amber', auto: 'green' } as const

interface FormState {
  id?: string
  name: string
  category: string
  amount: string
  frequency: BillFrequency
  dueDate: string
  autoPayEnabled: boolean
  approvalRequired: boolean
  maxAutoPayAmount: string
  paymentMethodId: string
}

const empty = (): FormState => ({
  name: '',
  category: 'Streaming',
  amount: '',
  frequency: 'monthly',
  dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
  autoPayEnabled: false,
  approvalRequired: true,
  maxAutoPayAmount: '',
  paymentMethodId: '',
})

export default function PayBills() {
  const [bills, setBills] = useState<Bill[]>([])
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [b, m] = await Promise.all([payApi.bills(), payApi.methods()])
      setBills(b.sort((x, y) => x.nextDueDate.localeCompare(y.nextDueDate)))
      setMethods(m)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  function openNew() {
    const f = empty()
    if (methods[0]) f.paymentMethodId = methods[0].id
    setForm(f)
  }
  function openEdit(b: Bill) {
    setForm({
      id: b.id,
      name: b.name,
      category: b.category,
      amount: String(b.amount),
      frequency: b.frequency,
      dueDate: b.nextDueDate,
      autoPayEnabled: b.autoPayEnabled,
      approvalRequired: b.approvalRequired,
      maxAutoPayAmount: b.maxAutoPayAmount != null ? String(b.maxAutoPayAmount) : '',
      paymentMethodId: b.paymentMethodId ?? '',
    })
  }

  async function save() {
    if (!form) return
    const amount = parseFloat(form.amount)
    if (!form.name.trim() || !(amount > 0)) {
      setMsg('Enter a name and a positive amount.')
      return
    }
    setBusy('save')
    try {
      const body: any = {
        name: form.name.trim(),
        category: form.category.trim() || 'Other',
        amount,
        frequency: form.frequency,
        dueDate: form.dueDate,
        autoPayEnabled: form.autoPayEnabled,
        approvalRequired: form.approvalRequired,
        maxAutoPayAmount: form.maxAutoPayAmount ? parseFloat(form.maxAutoPayAmount) : null,
        paymentMethodId: form.paymentMethodId || null,
      }
      if (form.id) await payApi.updateBill(form.id, body)
      else await payApi.createBill(body)
      setForm(null)
      setMsg(null)
      await load()
    } catch (e: any) {
      setMsg(e?.message ?? 'Save failed')
    } finally {
      setBusy(null)
    }
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id)
    try {
      await fn()
      await load()
    } catch (e: any) {
      setMsg(e?.message ?? 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <Loading />

  if (form) {
    return (
      <div style={{ paddingTop: 6 }}>
        <SectionTitle>{form.id ? 'Edit bill' : 'Add bill'}</SectionTitle>
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={label}>Name</label>
              <input
                style={input}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Netflix"
                data-testid="input-bill-name"
              />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>Category</label>
                <input
                  style={input}
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  data-testid="input-bill-category"
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>Amount</label>
                <input
                  style={input}
                  type="number"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  placeholder="0.00"
                  data-testid="input-bill-amount"
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>Frequency</label>
                <select
                  style={input as any}
                  value={form.frequency}
                  onChange={(e) => setForm({ ...form, frequency: e.target.value as BillFrequency })}
                  data-testid="select-bill-frequency"
                >
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>Next due</label>
                <input
                  style={input}
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                  data-testid="input-bill-due"
                />
              </div>
            </div>
            <div>
              <label style={label}>Payment method</label>
              <select
                style={input as any}
                value={form.paymentMethodId}
                onChange={(e) => setForm({ ...form, paymentMethodId: e.target.value })}
                data-testid="select-bill-method"
              >
                <option value="">None</option>
                {methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)' }}>
              <input
                type="checkbox"
                checked={form.autoPayEnabled}
                onChange={(e) => setForm({ ...form, autoPayEnabled: e.target.checked })}
                data-testid="check-autopay"
              />
              Enable auto-pay (within limit; first payment still needs approval)
            </label>
            {form.autoPayEnabled && (
              <div>
                <label style={label}>Max auto-pay amount (optional)</label>
                <input
                  style={input}
                  type="number"
                  inputMode="decimal"
                  value={form.maxAutoPayAmount}
                  onChange={(e) => setForm({ ...form, maxAutoPayAmount: e.target.value })}
                  placeholder="e.g. 50"
                  data-testid="input-max-autopay"
                />
              </div>
            )}
            {!form.autoPayEnabled && (
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)' }}
              >
                <input
                  type="checkbox"
                  checked={form.approvalRequired}
                  onChange={(e) => setForm({ ...form, approvalRequired: e.target.checked })}
                  data-testid="check-approval"
                />
                Require my approval before paying
              </label>
            )}
            {msg && <div style={{ color: 'var(--red)', fontSize: 12 }}>{msg}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn onClick={save} disabled={busy === 'save'} testId="button-save-bill">
                {busy === 'save' ? 'Saving…' : 'Save bill'}
              </Btn>
              <Btn tone="ghost" onClick={() => { setForm(null); setMsg(null) }} testId="button-cancel-bill">
                Cancel
              </Btn>
              {form.id && (
                <Btn
                  tone="danger"
                  onClick={() => act(form.id!, () => payApi.deleteBill(form.id!)).then(() => setForm(null))}
                  testId="button-delete-bill"
                  style={{ marginLeft: 'auto' }}
                >
                  Delete
                </Btn>
              )}
            </div>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 6 }}>
      <SectionTitle action={<Btn onClick={openNew} testId="button-add-bill">+ Add</Btn>}>
        Your bills ({bills.length})
      </SectionTitle>
      {msg && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      {bills.length === 0 ? (
        <Empty icon="🧾" title="No bills yet" hint="Add your first bill and the agent will track it for you." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {bills.map((b) => {
            const mode = modeOf(b)
            const d = daysUntil(b.nextDueDate)
            const overdue = b.status === 'overdue' || d < 0
            return (
              <Card key={b.id} testId={`bill-${b.id}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{b.name}</span>
                      <Pill tone={modeTone[mode] as any}>{mode}</Pill>
                      {b.status === 'cancelled' && <Pill tone="red">cancelled</Pill>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>
                      {b.category} · {b.frequency}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{money(b.amount, b.currency)}</div>
                    <Pill tone={overdue ? 'red' : d <= 3 ? 'amber' : 'neutral'}>{dueLabel(b.nextDueDate)}</Pill>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <Btn
                    tone="purple"
                    onClick={() => act(b.id, () => payApi.payBill(b.id))}
                    disabled={busy === b.id}
                    testId={`button-pay-${b.id}`}
                  >
                    Pay now
                  </Btn>
                  <Btn
                    tone="ghost"
                    onClick={() => act(b.id, () => payApi.markPaid(b.id))}
                    disabled={busy === b.id}
                    testId={`button-markpaid-${b.id}`}
                  >
                    Mark paid
                  </Btn>
                  <Btn
                    tone="ghost"
                    onClick={() => act(b.id, () => payApi.setAutoPay(b.id, !b.autoPayEnabled))}
                    disabled={busy === b.id}
                    testId={`button-autopay-${b.id}`}
                  >
                    Auto-pay {b.autoPayEnabled ? 'off' : 'on'}
                  </Btn>
                  <Btn tone="ghost" onClick={() => openEdit(b)} testId={`button-edit-${b.id}`} style={{ marginLeft: 'auto' }}>
                    Edit
                  </Btn>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

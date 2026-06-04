// Pay Agent — payment history + approve/cancel pending payments.
import { useEffect, useState } from 'react'
import { payApi, money, type Bill, type Payment } from './payApi'
import { Btn, Card, Empty, Loading, Pill, SectionTitle } from './payUi'

const STATUS_TONE: Record<string, 'green' | 'red' | 'amber' | 'neutral' | 'purple'> = {
  succeeded: 'green',
  failed: 'red',
  cancelled: 'neutral',
  awaiting_approval: 'amber',
  processing: 'purple',
  pending: 'neutral',
}

export default function PayPayments() {
  const [payments, setPayments] = useState<Payment[]>([])
  const [bills, setBills] = useState<Record<string, Bill>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [p, b] = await Promise.all([payApi.payments(), payApi.bills()])
      setPayments(p)
      setBills(Object.fromEntries(b.map((x) => [x.id, x])))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id)
    try {
      await fn()
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <Loading />

  const pending = payments.filter((p) => p.status === 'awaiting_approval')
  const history = payments.filter((p) => p.status !== 'awaiting_approval')

  function row(p: Payment) {
    const bill = bills[p.billId]
    return (
      <Card key={p.id} testId={`payment-${p.id}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{bill?.name ?? 'Bill'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {(p.paidAt ?? p.createdAt).slice(0, 10)} · {p.mode}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{money(p.amount, p.currency)}</div>
            <Pill tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status.replace('_', ' ')}</Pill>
          </div>
        </div>
        {p.status === 'awaiting_approval' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Btn tone="green" onClick={() => act(p.id, () => payApi.approve(p.id))} disabled={busy === p.id} testId={`button-approve-${p.id}`}>
              {busy === p.id ? '…' : 'Approve'}
            </Btn>
            <Btn tone="ghost" onClick={() => act(p.id, () => payApi.cancel(p.id))} disabled={busy === p.id} testId={`button-cancel-${p.id}`}>
              Cancel
            </Btn>
          </div>
        )}
      </Card>
    )
  }

  return (
    <div style={{ paddingTop: 6 }}>
      {pending.length > 0 && (
        <>
          <SectionTitle>Pending approval ({pending.length})</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{pending.map(row)}</div>
        </>
      )}
      <SectionTitle>History</SectionTitle>
      {history.length === 0 ? (
        <Empty icon="💸" title="No payments yet" hint="Payments you make or approve will appear here." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{history.map(row)}</div>
      )}
    </div>
  )
}

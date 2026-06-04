// Pay Agent — dashboard. At-a-glance: simulated balance, monthly/yearly spend,
// upcoming bills, pending approvals and top savings recommendations.
import { useEffect, useState } from 'react'
import { payApi, money, dueLabel, daysUntil, type Overview } from './payApi'
import { Btn, Card, Empty, Loading, Pill, SectionTitle, SimDisclaimer } from './payUi'

export default function PayDashboard({ onGoto }: { onGoto: (t: any) => void }) {
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      setData(await payApi.overview())
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  async function approve(id: string) {
    setBusy(id)
    try {
      await payApi.approve(id)
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <Loading />
  if (!data) return <Empty icon="💳" title="No data yet" />

  const { insights, upcoming, pendingApprovals, recommendations, balance } = data

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SimDisclaimer compact />

      {/* Top stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        <Card testId="card-balance">
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Simulated balance</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>
            {money(balance.available, balance.currency)}
          </div>
        </Card>
        <Card testId="card-monthly">
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Monthly bills</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>
            {money(insights.monthlyTotal)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            {money(insights.yearlyTotal)}/yr · {insights.activeBillCount} active
          </div>
        </Card>
      </div>

      {insights.potentialMonthlySavings > 0 && (
        <Card testId="card-savings" style={{ marginTop: 10, borderColor: 'rgba(22,199,132,0.4)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Potential savings</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--green)' }}>
                {money(insights.potentialMonthlySavings)}/mo
              </div>
            </div>
            <Btn tone="ghost" onClick={() => onGoto('insights')} testId="button-view-savings">
              Review
            </Btn>
          </div>
        </Card>
      )}

      {/* Pending approvals */}
      {pendingApprovals.length > 0 && (
        <>
          <SectionTitle>Needs your approval</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingApprovals.map((p) => (
              <Card key={p.id} testId={`approval-${p.id}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{money(p.amount, p.currency)}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Awaiting approval</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Btn tone="ghost" onClick={() => payApi.cancel(p.id).then(load)} testId={`button-cancel-${p.id}`}>
                      Cancel
                    </Btn>
                    <Btn
                      tone="green"
                      onClick={() => approve(p.id)}
                      disabled={busy === p.id}
                      testId={`button-approve-${p.id}`}
                    >
                      {busy === p.id ? '…' : 'Approve'}
                    </Btn>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Upcoming bills */}
      <SectionTitle action={<Btn tone="ghost" onClick={() => onGoto('bills')} testId="button-all-bills">All bills</Btn>}>
        Upcoming
      </SectionTitle>
      {upcoming.length === 0 ? (
        <Empty icon="✅" title="Nothing due soon" hint="No bills due in the next two weeks." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {upcoming.map((b) => {
            const d = daysUntil(b.nextDueDate)
            const tone = d < 0 ? 'red' : d <= 3 ? 'amber' : 'neutral'
            return (
              <Card key={b.id} testId={`upcoming-${b.id}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{b.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {b.category} · {b.frequency}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{money(b.amount, b.currency)}</div>
                    <Pill tone={tone as any}>{dueLabel(b.nextDueDate)}</Pill>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* Recommendations preview */}
      {recommendations.length > 0 && (
        <>
          <SectionTitle
            action={<Btn tone="ghost" onClick={() => onGoto('insights')} testId="button-all-recs">More</Btn>}
          >
            Agent suggestions
          </SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recommendations.slice(0, 3).map((r) => (
              <Card key={r.id} testId={`rec-${r.id}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>{r.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                      {r.description}
                    </div>
                  </div>
                  {r.potentialSaving > 0 && <Pill tone="green">save {money(r.potentialSaving)}/mo</Pill>}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

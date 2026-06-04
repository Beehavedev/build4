// Pay Agent — insights & recommendations. Spend breakdown by category plus
// accept/dismiss for the agent's savings suggestions.
import { useEffect, useState } from 'react'
import { payApi, money, type InsightsSummary, type Recommendation } from './payApi'
import { Btn, Card, Empty, Loading, Pill, SectionTitle } from './payUi'

export default function PayInsights() {
  const [ins, setIns] = useState<InsightsSummary | null>(null)
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [i, r] = await Promise.all([payApi.insights(), payApi.recommendations('open')])
      setIns(i)
      setRecs(r)
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
  if (!ins) return <Empty icon="📊" title="No insights yet" />

  const max = Math.max(1, ...ins.byCategory.map((c) => c.monthly))

  return (
    <div style={{ paddingTop: 6 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Card>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Monthly</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' }}>{money(ins.monthlyTotal)}</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Yearly</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' }}>{money(ins.yearlyTotal)}</div>
        </Card>
      </div>

      <SectionTitle>Spend by category</SectionTitle>
      {ins.byCategory.length === 0 ? (
        <Empty icon="📂" title="No active bills" />
      ) : (
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {ins.byCategory.map((c) => (
              <div key={c.category} data-testid={`cat-${c.category}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-primary)' }}>
                    {c.category} <span style={{ color: 'var(--text-secondary)' }}>· {c.count}</span>
                  </span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{money(c.monthly)}</span>
                </div>
                <div style={{ height: 6, background: 'var(--bg-elevated)', borderRadius: 999 }}>
                  <div
                    style={{
                      width: `${(c.monthly / max) * 100}%`,
                      height: '100%',
                      background: 'var(--purple)',
                      borderRadius: 999,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <SectionTitle
        action={
          <Btn tone="ghost" onClick={() => act('gen', () => payApi.generateRecommendations())} testId="button-regen-recs">
            Refresh
          </Btn>
        }
      >
        Suggestions {ins.potentialMonthlySavings > 0 && <span style={{ color: 'var(--green)' }}>· save {money(ins.potentialMonthlySavings)}/mo</span>}
      </SectionTitle>
      {recs.length === 0 ? (
        <Empty icon="✨" title="No suggestions" hint="The agent found no obvious waste. Nice and lean." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {recs.map((r) => (
            <Card key={r.id} testId={`recommendation-${r.id}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>{r.title}</div>
                {r.potentialSaving > 0 && <Pill tone="green">save {money(r.potentialSaving)}/mo</Pill>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.45 }}>
                {r.description}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Btn tone="green" onClick={() => act(r.id, () => payApi.acceptRecommendation(r.id))} disabled={busy === r.id} testId={`button-accept-${r.id}`}>
                  Accept
                </Btn>
                <Btn tone="ghost" onClick={() => act(r.id, () => payApi.dismissRecommendation(r.id))} disabled={busy === r.id} testId={`button-dismiss-${r.id}`}>
                  Dismiss
                </Btn>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

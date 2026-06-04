// Build4 Pay Agent — section shell mounted inside the Build4 mini-app.
// Owns the horizontal sub-tab nav and mounts one view at a time. On first
// open it resolves the user (auto-creating the default agent server-side) and,
// if the user has no bills yet, offers a one-tap demo seed so every tab has
// something to show.
import { useEffect, useState } from 'react'
import { payApi } from './payApi'
import { Btn, Card, Loading, SimDisclaimer } from './payUi'
import PayDashboard from './PayDashboard'
import PayBills from './PayBills'
import PayPayments from './PayPayments'
import PayInsights from './PayInsights'
import PayAgents from './PayAgents'
import PayChat from './PayChat'
import PaySettings from './PaySettings'

type Tab = 'home' | 'bills' | 'pay' | 'insights' | 'agents' | 'chat' | 'settings'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'bills', label: 'Bills', icon: '🧾' },
  { id: 'pay', label: 'Payments', icon: '💸' },
  { id: 'insights', label: 'Insights', icon: '📊' },
  { id: 'agents', label: 'Agents', icon: '🤖' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
]

export default function PayAgent() {
  const [tab, setTab] = useState<Tab>('home')
  const [loading, setLoading] = useState(true)
  const [agentName, setAgentName] = useState('Pay Agent')
  const [needsSeed, setNeedsSeed] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function boot() {
    setLoading(true)
    setErr(null)
    try {
      const me = await payApi.me()
      setAgentName(me.agent?.name ?? 'Pay Agent')
      const bills = await payApi.bills()
      setNeedsSeed(bills.length === 0)
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load Pay Agent')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    boot()
  }, [])

  async function seed() {
    setSeeding(true)
    try {
      await payApi.seed()
      setNeedsSeed(false)
      setTab('home')
    } catch (e: any) {
      setErr(e?.message ?? 'Seeding failed')
    } finally {
      setSeeding(false)
    }
  }

  if (loading) return <Loading label="Loading Pay Agent…" />

  if (err) {
    return (
      <div style={{ paddingTop: 48 }}>
        <Card testId="pay-error">
          <div style={{ color: 'var(--red)', fontWeight: 600, marginBottom: 8 }}>Pay Agent unavailable</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>{err}</div>
          <Btn onClick={boot} testId="button-pay-retry">
            Retry
          </Btn>
        </Card>
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 44 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 22 }}>💳</span>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1 }}>
            Pay Agent
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{agentName} · bills &amp; subscriptions</div>
        </div>
      </div>

      {needsSeed ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 8 }}>
          <SimDisclaimer />
          <Card testId="pay-seed-card">
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, color: 'var(--text-primary)' }}>
              Welcome to your Pay Agent 👋
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 16 }}>
              I track your bills and subscriptions, flag overspend, and can pay bills for you — manually, with your
              approval, or automatically within limits you set. Load a set of demo bills to explore, or jump straight to
              the Bills tab to add your own.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn onClick={seed} disabled={seeding} testId="button-seed-demo">
                {seeding ? 'Loading…' : 'Load demo bills'}
              </Btn>
              <Btn tone="ghost" onClick={() => setNeedsSeed(false)} testId="button-skip-seed">
                Start empty
              </Btn>
            </div>
          </Card>
        </div>
      ) : (
        <>
          {/* Horizontal sub-tab strip */}
          <div
            style={{
              display: 'flex',
              gap: 6,
              overflowX: 'auto',
              paddingBottom: 8,
              marginBottom: 4,
              scrollbarWidth: 'none',
            }}
          >
            {TABS.map((t) => {
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  data-testid={`paytab-${t.id}`}
                  style={{
                    flex: '0 0 auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 13px',
                    borderRadius: 999,
                    border: '1px solid',
                    borderColor: active ? 'var(--purple)' : 'var(--border)',
                    background: active ? 'rgba(124,77,255,0.15)' : 'var(--bg-card)',
                    color: active ? 'var(--purple)' : 'var(--text-secondary)',
                    fontSize: 13,
                    fontWeight: active ? 700 : 500,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>{t.icon}</span>
                  {t.label}
                </button>
              )
            })}
          </div>

          <div style={{ paddingBottom: 8 }}>
            {tab === 'home' && <PayDashboard onGoto={(t) => setTab(t)} />}
            {tab === 'bills' && <PayBills />}
            {tab === 'pay' && <PayPayments />}
            {tab === 'insights' && <PayInsights />}
            {tab === 'agents' && <PayAgents />}
            {tab === 'chat' && <PayChat />}
            {tab === 'settings' && <PaySettings onReseed={boot} />}
          </div>
        </>
      )}
    </div>
  )
}

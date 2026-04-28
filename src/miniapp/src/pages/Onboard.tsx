import { useState } from 'react'
import { apiFetch, ApiError, type AgentData } from '../api'

interface OnboardProps {
  // Whether the user has Aster onboarded already. We chain /api/aster/approve
  // after agent creation when this is false so the user is fully onboarded
  // and trading-ready in one Deploy tap. Passed in from App.tsx so we don't
  // re-fetch /api/me/wallet here.
  asterOnboarded: boolean
  // Called once the agent is live and (if needed) Aster is approved. Parent
  // refreshes the agent list and routes back to the dashboard. We pass an
  // optional `asterFailed` flag so the parent can surface a banner — the
  // agent is on-chain regardless, but the user still needs to fund/activate
  // Aster before the agent can place trades.
  onDone: (agent: AgentData, opts?: { asterFailed?: boolean }) => void
}

type Preset = 'safe' | 'balanced' | 'aggressive'

interface PresetMeta {
  id: Preset
  label: string
  blurb: string
  leverage: string
  sl: string
  tp: string
  accent: string
}

// Mirror of services/agentCreation.ts PRESETS — kept in sync by hand. The
// numbers shown here are display-only; the server is authoritative for what
// gets persisted on the agent row, so a drift in copy never produces wrong
// risk values, only mismatched marketing.
const PRESETS: PresetMeta[] = [
  {
    id: 'safe',
    label: 'Safe',
    blurb: 'Slow & steady. Tight stops, smaller targets.',
    leverage: '3×',
    sl: '1.5%',
    tp: '2.5%',
    accent: 'var(--green)',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Default. Moderate risk, room to compound.',
    leverage: '10×',
    sl: '2%',
    tp: '4%',
    accent: 'var(--purple)',
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    blurb: 'High conviction trades. Drawdowns expected.',
    leverage: '25×',
    sl: '3%',
    tp: '6%',
    accent: 'var(--red)',
  },
]

export default function Onboard({ asterOnboarded, onDone }: OnboardProps) {
  const [preset, setPreset] = useState<Preset>('balanced')
  // $25 default — large enough to clear Aster's $5.50 min notional with a
  // sensible buffer, small enough that a brand-new user doesn't feel they're
  // committing serious money on the first tap. They can tune this in Studio.
  const [capital, setCapital] = useState('25')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // After deploy succeeds we hold the user on a success screen for a beat
  // so the "agent is live" feedback isn't a flash-and-redirect. If Aster
  // activation also failed we surface that explicitly here — the user
  // taps Continue → Dashboard once they've read the message.
  const [success, setSuccess] = useState<{ agent: AgentData; asterFailed: boolean } | null>(null)

  const capitalNum = Number(capital)
  const capitalValid = Number.isFinite(capitalNum) && capitalNum >= 5.5
  const canDeploy = !busy && capitalValid

  async function handleDeploy() {
    if (!canDeploy) return
    setBusy(true)
    setError(null)
    try {
      setStep('Registering on-chain identity (~30s)…')
      const created = await apiFetch<{ success: true; agent: AgentData }>(
        '/api/me/agents/onboard',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preset, startingCapital: capitalNum }),
        },
      )

      // Chain Aster activation when the user isn't already onboarded.
      // The agent is registered on-chain regardless of what happens here
      // — Aster onboarding can be retried from the dashboard's Aster
      // card — but we want to TELL the user when activation didn't
      // happen so they don't believe they're trade-ready when they
      // aren't. We pass an asterFailed flag through onDone so the
      // dashboard can surface a clear "agent is live, Aster still needs
      // activation" banner instead of silently swallowing the error.
      let asterFailed = false
      if (!asterOnboarded) {
        setStep('Activating Aster trading…')
        try {
          await apiFetch<{ success: true }>('/api/aster/approve', { method: 'POST' })
        } catch (asterErr: any) {
          asterFailed = true
          console.warn('[Onboard] Aster approve failed (non-fatal):', asterErr)
        }
      }

      setSuccess({ agent: created.agent, asterFailed })
    } catch (e: any) {
      const apiMsg = e instanceof ApiError ? (e.body?.error ?? e.message) : e?.message
      setError(apiMsg ?? 'Deploy failed. Please try again.')
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  if (success) {
    return (
      <div style={{ paddingTop: 20, paddingBottom: 16 }} data-testid="page-onboard-success">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
            Agent {success.agent.name} is live
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>
            First market scan in ~60 seconds. You'll get a Telegram DM the moment it places its first trade.
          </div>
        </div>

        {success.asterFailed && (
          <div
            className="card"
            data-testid="text-onboard-aster-warning"
            style={{
              marginBottom: 16,
              padding: 12,
              border: '1px solid var(--yellow, #f5a623)',
              fontSize: 13,
              color: 'var(--text-primary)',
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠️ Aster activation didn't complete</div>
            Your agent is registered on-chain, but Aster trading isn't activated yet. Open the Aster card on the dashboard and tap Activate to finish — your agent will start trading right after.
          </div>
        )}

        <button
          onClick={() => onDone(success.agent, { asterFailed: success.asterFailed })}
          data-testid="button-onboard-continue"
          style={{
            width: '100%',
            background: 'var(--purple)',
            color: '#fff',
            border: 'none',
            borderRadius: 14,
            padding: '14px 16px',
            fontSize: 16,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Open Dashboard →
        </button>
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 20, paddingBottom: 16 }} data-testid="page-onboard">
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
          🤖 Deploy your agent
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          Three taps. We register a fresh ERC-8004 identity on-chain, set risk limits, and start trading on Aster within 60 seconds.
        </div>
      </div>

      {/* Preset chips — radio-style. Tapping switches the active card. */}
      <div className="section-label">Risk Preset</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
        {PRESETS.map(p => {
          const active = preset === p.id
          return (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              data-testid={`button-preset-${p.id}`}
              disabled={busy}
              style={{
                background: active ? 'var(--bg-elevated)' : 'var(--bg-card)',
                border: `2px solid ${active ? p.accent : 'var(--border)'}`,
                borderRadius: 14,
                padding: '12px 8px',
                color: 'var(--text-primary)',
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.6 : 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                textAlign: 'center',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700 }}>{p.label}</span>
              <span style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.2 }}>
                {p.leverage} · SL {p.sl} · TP {p.tp}
              </span>
            </button>
          )
        })}
      </div>

      {/* Selected preset blurb — full sentence so the user understands what
          they just picked beyond the risk numbers on the chip itself. */}
      <div className="card" style={{ marginBottom: 16, padding: 12 }}>
        <div
          style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.4 }}
          data-testid={`text-preset-blurb-${preset}`}
        >
          {PRESETS.find(p => p.id === preset)!.blurb}
        </div>
      </div>

      {/* Starting capital — single input, USDT. Validated server-side too. */}
      <div className="section-label">Starting Capital (USDT per trade)</div>
      <div className="card" style={{ marginBottom: 16, padding: 12 }}>
        <input
          type="number"
          inputMode="decimal"
          min={5.5}
          step={0.5}
          value={capital}
          onChange={e => setCapital(e.target.value)}
          disabled={busy}
          data-testid="input-starting-capital"
          style={{
            width: '100%',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            color: 'var(--text-primary)',
            padding: '10px 12px',
            fontSize: 18,
            fontWeight: 600,
            outline: 'none',
          }}
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
          Minimum $5.50 (Aster floor). Daily loss cap auto-scales with this number.
        </div>
      </div>

      {error && (
        <div
          className="card"
          data-testid="text-onboard-error"
          style={{
            marginBottom: 12,
            padding: 12,
            border: '1px solid var(--red)',
            color: 'var(--red)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {step && (
        <div
          className="card"
          data-testid="text-onboard-step"
          style={{ marginBottom: 12, padding: 12, fontSize: 13, color: 'var(--text-secondary)' }}
        >
          ⏳ {step}
        </div>
      )}

      <button
        onClick={handleDeploy}
        disabled={!canDeploy}
        data-testid="button-deploy-agent"
        style={{
          width: '100%',
          background: canDeploy ? 'var(--purple)' : 'var(--bg-elevated)',
          color: canDeploy ? '#fff' : 'var(--text-muted)',
          border: 'none',
          borderRadius: 14,
          padding: '14px 16px',
          fontSize: 16,
          fontWeight: 700,
          cursor: canDeploy ? 'pointer' : 'not-allowed',
          transition: 'all 0.15s',
        }}
      >
        {busy ? 'Deploying…' : '🚀 Deploy Agent'}
      </button>

      <div
        style={{
          marginTop: 12,
          fontSize: 11,
          color: 'var(--text-muted)',
          textAlign: 'center',
          lineHeight: 1.5,
        }}
      >
        Free to deploy — BUILD4 covers on-chain gas. You can pause or tune the agent anytime.
      </div>
    </div>
  )
}

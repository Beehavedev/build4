// Build4 Pay Agent — small shared UI primitives styled with the mini-app's
// CSS-variable design tokens (--bg-card, --border, --purple, etc). Kept
// dependency-free (no shadcn here — this mini-app uses inline styles).
import type { CSSProperties, ReactNode } from 'react'

export function Card({
  children,
  style,
  testId,
  onClick,
}: {
  children: ReactNode
  style?: CSSProperties
  testId?: string
  onClick?: () => void
}) {
  return (
    <div
      data-testid={testId}
      onClick={onClick}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: 16,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '18px 2px 10px' }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{children}</div>
      {action}
    </div>
  )
}

type Tone = 'purple' | 'green' | 'red' | 'amber' | 'neutral'
const TONE: Record<Tone, { bg: string; fg: string }> = {
  purple: { bg: 'rgba(124,77,255,0.15)', fg: 'var(--purple)' },
  green: { bg: 'rgba(22,199,132,0.15)', fg: 'var(--green)' },
  red: { bg: 'rgba(234,57,67,0.15)', fg: 'var(--red)' },
  amber: { bg: 'rgba(255,176,32,0.15)', fg: '#ffb020' },
  neutral: { bg: 'var(--bg-elevated)', fg: 'var(--text-secondary)' },
}

export function Pill({ children, tone = 'neutral', testId }: { children: ReactNode; tone?: Tone; testId?: string }) {
  const t = TONE[tone]
  return (
    <span
      data-testid={testId}
      style={{
        background: t.bg,
        color: t.fg,
        borderRadius: 999,
        padding: '2px 9px',
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

export function Btn({
  children,
  onClick,
  tone = 'purple',
  disabled,
  testId,
  style,
}: {
  children: ReactNode
  onClick?: () => void
  tone?: 'purple' | 'ghost' | 'danger' | 'green'
  disabled?: boolean
  testId?: string
  style?: CSSProperties
}) {
  const bg =
    tone === 'purple' ? 'var(--purple)' : tone === 'green' ? 'var(--green)' : tone === 'danger' ? 'var(--red)' : 'transparent'
  const fg = tone === 'ghost' ? 'var(--text-primary)' : '#fff'
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: bg,
        color: fg,
        border: tone === 'ghost' ? '1px solid var(--border)' : 'none',
        borderRadius: 9,
        padding: '8px 13px',
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

export function Empty({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)' }}>
      <div style={{ fontSize: 40, marginBottom: 10 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 280, margin: '0 auto' }}>{hint}</div>}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)', fontSize: 13 }}>{label}</div>
  )
}

export function SimDisclaimer({ compact }: { compact?: boolean }) {
  return (
    <div
      data-testid="pay-disclaimer"
      style={{
        background: 'rgba(255,176,32,0.10)',
        border: '1px solid rgba(255,176,32,0.35)',
        borderRadius: 10,
        padding: compact ? '8px 11px' : '10px 13px',
        fontSize: compact ? 11 : 12,
        lineHeight: 1.45,
        color: '#ffce80',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
      }}
    >
      <span style={{ fontSize: 14 }}>⚠️</span>
      <span>
        <b>Simulation only.</b> Build4 Pay Agent moves <b>no real money</b>, pays no real bills, and stores no real
        payment credentials. All balances, bills and payments here are mock data for demonstration.
      </span>
    </div>
  )
}

export const input: CSSProperties = {
  width: '100%',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 9,
  padding: '9px 11px',
  fontSize: 14,
  color: 'var(--text-primary)',
  boxSizing: 'border-box',
}

export const label: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: 5,
  display: 'block',
}

import { useState, useEffect } from 'react'
import Dashboard from './pages/Dashboard'
import AgentStudio from './pages/AgentStudio'
import CopyTrade from './pages/CopyTrade'
import Portfolio from './pages/Portfolio'
import Wallet from './pages/Wallet'
import Predictions, { CrosshairIcon } from './pages/Predictions'
import { Trade } from './pages/Trade'
import Hyperliquid from './pages/Hyperliquid'
import Admin from './pages/Admin'
import Onboard from './pages/Onboard'
import { apiFetch, type AgentData } from './api'

declare global {
  interface Window {
    Telegram?: { WebApp: any }
  }
}

type Page = 'dashboard' | 'agents' | 'wallet' | 'trade' | 'copy' | 'portfolio' | 'predictions' | 'hyperliquid' | 'admin' | 'onboard'

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [userId, setUserId] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  // Top-right overflow menu — houses Admin (when allow-listed) and any
  // future low-traffic destinations. Keeps the bottom nav at six tabs.
  const [menuOpen, setMenuOpen] = useState(false)

  // Aster onboarding flag is needed by the Onboard page so it knows whether
  // to chain /api/aster/approve after the agent is registered. We resolve it
  // once via /api/me/wallet on first paint and pass it down — re-fetched
  // whenever the user lands on Onboard via the auto-route below.
  const [asterOnboarded, setAsterOnboarded] = useState(false)

  useEffect(() => {
    // Init Telegram WebApp
    const tg = window.Telegram?.WebApp
    if (tg) {
      tg.ready()
      tg.expand()
      const telegramId = tg.initDataUnsafe?.user?.id
      if (telegramId) setUserId(telegramId.toString())
    }

    // First-paint routing logic — three sources, evaluated in order:
    //  1. ?onboard=1 query param (set by the Telegram bot's webApp button
    //     when the user taps "Deploy in BUILD4") → jump straight to onboard.
    //  2. start_param via Telegram WebApp init (e.g. when the bot uses
    //     ?startapp=onboard deep-links) → same destination.
    //  3. zero agents → onboard (so first-time users never land on a
    //     dashboard full of "$0 / fund to start" cards with nothing to do).
    // Otherwise we fall through to the dashboard as before.
    const params = new URLSearchParams(window.location.search)
    const wantOnboard = params.get('onboard') === '1'
      || tg?.initDataUnsafe?.start_param === 'onboard'
    if (wantOnboard) setPage('onboard')

    // Probe admin status — only show the Admin tab to allow-listed telegram IDs.
    apiFetch<{ isAdmin: boolean }>('/api/me/admin')
      .then((r) => setIsAdmin(!!r.isAdmin))
      .catch(() => setIsAdmin(false))

    // Resolve aster onboarding state + agent count for first-paint routing.
    // We don't block the rest of the app on this — if the wallet endpoint
    // is slow the user lands on the dashboard and the Onboard auto-route
    // fires once data arrives. Skipped if the URL already chose onboard.
    apiFetch<{ aster?: { onboarded?: boolean } }>('/api/me/wallet')
      .then(w => setAsterOnboarded(!!w?.aster?.onboarded))
      .catch(() => { /* assume not onboarded */ })

    if (!wantOnboard) {
      // Auto-route first-time users (zero agents) to Onboard. Fetch is
      // best-effort — failure leaves them on the dashboard, which still
      // works.
      const tgId = tg?.initDataUnsafe?.user?.id
      if (tgId) {
        fetch(`/api/agents/${tgId}`).then(r => r.json()).then((agents: AgentData[]) => {
          if (Array.isArray(agents) && agents.length === 0) setPage('onboard')
        }).catch(() => { /* leave on dashboard */ })
      }
    }

    // Cross-page navigation hook — pages can dispatch a CustomEvent('b4-nav',
    // { detail: 'hyperliquid' }) to switch tabs (e.g. the Trade page's venue
    // switcher uses this to jump into the HL view, or the Dashboard's empty
    // state CTA uses 'onboard' to send first-time users into the new flow).
    const onNav = (e: Event) => {
      const dest = (e as CustomEvent).detail as Page
      if (dest) setPage(dest)
    }
    window.addEventListener('b4-nav', onNav as EventListener)
    return () => window.removeEventListener('b4-nav', onNav as EventListener)
  }, [])

  // Six-tab bottom nav — every label is one word so they all fit on a
  // 360-px-wide handset without wrapping. Admin is intentionally NOT here
  // (operator-only) and lives behind the top-right ⋯ menu instead.
  const navItems: { id: Page; label: string; icon: string | 'crosshair' }[] = [
    { id: 'dashboard',   label: 'Home',      icon: '⚡' },
    { id: 'agents',      label: 'Agents',    icon: '🤖' },
    { id: 'trade',       label: 'Trade',     icon: '📈' },
    { id: 'wallet',      label: 'Wallet',    icon: '💳' },
    { id: 'portfolio',   label: 'Portfolio', icon: '📊' },
    { id: 'predictions', label: 'Predict',   icon: 'crosshair' },
    // Copy trading hidden for now — coming back to it later.
    // { id: 'copy', label: 'Copy', icon: '📋' },
  ]

  // Items shown inside the top-right overflow menu. Right now Admin is the
  // only entry, but routing it through a list keeps the door open for low-
  // traffic destinations later (e.g. Activity log, Help, Sign out) without
  // having to add another bottom-nav slot for each.
  const overflowItems: { id: Page; label: string; icon: string }[] = [
    ...(isAdmin ? [{ id: 'admin' as Page, label: 'Admin', icon: '🛠' }] : [])
  ]
  const hasOverflow = overflowItems.length > 0

  return (
    <div style={{ minHeight: '100vh', paddingBottom: '72px' }}>
      {/* Top-right overflow menu — only renders if there's something inside.
          Sits above page content as a small floating affordance so it never
          competes with each screen's own header text. Tap-outside closes. */}
      {hasOverflow && (
        <div style={{ position: 'fixed', top: 8, right: 12, zIndex: 200 }}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            data-testid="button-overflow-menu"
            aria-label="More"
            style={{
              width: 32, height: 32, borderRadius: 16,
              background: menuOpen ? 'var(--bg-elevated)' : 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, lineHeight: 1, padding: 0,
            }}
          >
            ⋯
          </button>
          {menuOpen && (
            <>
              {/* Tap-outside catcher */}
              <div
                onClick={() => setMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 199 }}
              />
              <div
                data-testid="menu-overflow"
                style={{
                  position: 'absolute', top: 38, right: 0, zIndex: 201,
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 10, padding: 4, minWidth: 160,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                }}
              >
                {overflowItems.map(item => (
                  <button
                    key={item.id}
                    onClick={() => { setPage(item.id); setMenuOpen(false) }}
                    data-testid={`menu-item-${item.id}`}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 6,
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--text-primary)', textAlign: 'left',
                      display: 'flex', alignItems: 'center', gap: 10,
                      fontSize: 13, fontWeight: 500,
                    }}
                  >
                    <span style={{ fontSize: 16 }}>{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Page content */}
      <div style={{ padding: '0 16px' }}>
        {page === 'dashboard' && <Dashboard userId={userId} onNavigate={setPage} />}
        {page === 'agents' && <AgentStudio userId={userId} />}
        {page === 'trade' && <Trade />}
        {page === 'wallet' && <Wallet />}
        {page === 'copy' && <CopyTrade />}
        {page === 'portfolio' && <Portfolio userId={userId} />}
        {page === 'predictions' && <Predictions />}
        {page === 'hyperliquid' && <Hyperliquid />}
        {page === 'admin' && <Admin />}
        {page === 'onboard' && (
          <Onboard
            asterOnboarded={asterOnboarded}
            onDone={() => {
              // After deploy, drop the user on the dashboard so they see
              // their fresh agent + balances. Refresh aster onboarding
              // since the deploy flow may have flipped it.
              setAsterOnboarded(true)
              setPage('dashboard')
            }}
          />
        )}
      </div>

      {/* Bottom nav */}
      <nav style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'var(--bg-card)',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        zIndex: 100,
        paddingBottom: 'env(safe-area-inset-bottom)'
      }}>
        {navItems.map((item) => {
          const active = page === item.id
          return (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              data-testid={`nav-${item.id}`}
              style={{
                flex: 1,
                padding: '10px 0 8px',
                background: 'none',
                border: 'none',
                borderTop: active ? '2px solid var(--purple)' : '2px solid transparent',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
                color: active ? 'var(--purple)' : 'var(--text-secondary)',
                transition: 'color 0.15s, border-color 0.15s'
              }}
            >
              {item.icon === 'crosshair' ? (
                <span style={{ height: 20, display: 'flex', alignItems: 'center' }}>
                  <CrosshairIcon active={active} />
                </span>
              ) : (
                <span style={{ fontSize: '20px', filter: active ? 'none' : 'grayscale(0.6)' }}>
                  {item.icon}
                </span>
              )}
              <span style={{ fontSize: '11px', fontWeight: active ? 600 : 400 }}>
                {item.label}
              </span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

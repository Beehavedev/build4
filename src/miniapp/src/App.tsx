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
import { apiFetch } from './api'

declare global {
  interface Window {
    Telegram?: { WebApp: any }
  }
}

type Page = 'dashboard' | 'agents' | 'wallet' | 'trade' | 'copy' | 'portfolio' | 'predictions' | 'hyperliquid' | 'admin'

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [userId, setUserId] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    // Init Telegram WebApp
    const tg = window.Telegram?.WebApp
    if (tg) {
      tg.ready()
      tg.expand()
      const telegramId = tg.initDataUnsafe?.user?.id
      if (telegramId) setUserId(telegramId.toString())
    }
    // Probe admin status — only show the Admin tab to allow-listed telegram IDs.
    apiFetch<{ isAdmin: boolean }>('/api/me/admin')
      .then((r) => setIsAdmin(!!r.isAdmin))
      .catch(() => setIsAdmin(false))

    // Cross-page navigation hook — pages can dispatch a CustomEvent('b4-nav',
    // { detail: 'hyperliquid' }) to switch tabs (e.g. the Trade page's venue
    // switcher uses this to jump into the HL view).
    const onNav = (e: Event) => {
      const dest = (e as CustomEvent).detail as Page
      if (dest) setPage(dest)
    }
    window.addEventListener('b4-nav', onNav as EventListener)
    return () => window.removeEventListener('b4-nav', onNav as EventListener)
  }, [])

  const navItems: { id: Page; label: string; icon: string | 'crosshair' }[] = [
    { id: 'dashboard', label: 'Home', icon: '⚡' },
    { id: 'agents', label: 'Agents', icon: '🤖' },
    { id: 'trade', label: 'Trade', icon: '📈' },
    { id: 'wallet', label: 'Wallet', icon: '💳' },
    // Copy trading hidden for now — coming back to it later.
    // { id: 'copy', label: 'Copy', icon: '📋' },
    { id: 'portfolio', label: 'Portfolio', icon: '📊' },
    { id: 'predictions', label: 'Predict', icon: 'crosshair' },
    ...(isAdmin ? [{ id: 'admin' as Page, label: 'Admin', icon: '🛠' }] : [])
  ]

  return (
    <div style={{ minHeight: '100vh', paddingBottom: '72px' }}>
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

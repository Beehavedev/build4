import { useState, useEffect } from 'react'
import Dashboard from './pages/Dashboard'
import AgentStudio from './pages/AgentStudio'
import CopyTrade from './pages/CopyTrade'
import Portfolio from './pages/Portfolio'
import Wallet from './pages/Wallet'
import Predictions, { CrosshairIcon } from './pages/Predictions'

declare global {
  interface Window {
    Telegram?: { WebApp: any }
  }
}

type Page = 'dashboard' | 'agents' | 'wallet' | 'copy' | 'portfolio' | 'predictions'

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    // Init Telegram WebApp
    const tg = window.Telegram?.WebApp
    if (tg) {
      tg.ready()
      tg.expand()
      const telegramId = tg.initDataUnsafe?.user?.id
      if (telegramId) setUserId(telegramId.toString())
    }
  }, [])

  const navItems: { id: Page; label: string; icon: string | 'crosshair' }[] = [
    { id: 'dashboard', label: 'Home', icon: '⚡' },
    { id: 'agents', label: 'Agents', icon: '🤖' },
    { id: 'wallet', label: 'Wallet', icon: '💳' },
    // Copy trading hidden for now — coming back to it later.
    // { id: 'copy', label: 'Copy', icon: '📋' },
    { id: 'portfolio', label: 'Portfolio', icon: '📊' },
    { id: 'predictions', label: 'Predictions', icon: 'crosshair' }
  ]

  return (
    <div style={{ minHeight: '100vh', paddingBottom: '72px' }}>
      {/* Page content */}
      <div style={{ padding: '0 16px' }}>
        {page === 'dashboard' && <Dashboard userId={userId} />}
        {page === 'agents' && <AgentStudio userId={userId} />}
        {page === 'wallet' && <Wallet />}
        {page === 'copy' && <CopyTrade />}
        {page === 'portfolio' && <Portfolio userId={userId} />}
        {page === 'predictions' && <Predictions />}
      </div>

      {/* Bottom nav */}
      <nav style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: '#12121a',
        borderTop: '1px solid #1e1e2e',
        display: 'flex',
        zIndex: 100
      }}>
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setPage(item.id)}
            style={{
              flex: 1,
              padding: '10px 0',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '2px',
              color: page === item.id ? '#7c3aed' : '#64748b',
              transition: 'color 0.15s'
            }}
          >
            {item.icon === 'crosshair' ? (
              <span style={{ height: 20, display: 'flex', alignItems: 'center' }}>
                <CrosshairIcon active={page === item.id} />
              </span>
            ) : (
              <span style={{ fontSize: '20px' }}>{item.icon}</span>
            )}
            <span style={{ fontSize: '11px', fontWeight: page === item.id ? 600 : 400 }}>
              {item.label}
            </span>
          </button>
        ))}
      </nav>
    </div>
  )
}

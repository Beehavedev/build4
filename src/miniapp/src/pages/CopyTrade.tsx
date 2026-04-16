import { useState, useEffect } from 'react'

export default function CopyTrade() {
  const [leaderboard, setLeaderboard] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/leaderboard')
      .then(r => r.json())
      .then(data => { setLeaderboard(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const medals = ['🥇', '🥈', '🥉']

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>📋 Copy Trading</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
          Follow top traders automatically
        </div>
      </div>

      {/* Info card */}
      <div style={{
        background: '#7c3aed15', border: '1px solid #7c3aed40',
        borderRadius: 12, padding: 14, marginBottom: 16
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>How it works</div>
        <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
          When you follow a trader, every trade they open is automatically mirrored in your account proportionally. PnL is verified on-chain when possible.
        </div>
      </div>

      {/* Leaderboard */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
        Top Traders — 30d PnL
      </div>

      {loading ? (
        <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center', padding: 24 }}>
          Loading leaderboard...
        </div>
      ) : leaderboard.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 13, color: '#64748b' }}>
            No traders with history yet. Start trading to appear here!
          </div>
        </div>
      ) : (
        leaderboard.map((trader, i) => (
          <div key={trader.id} className="card" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 20, width: 28 }}>{medals[i] ?? `${i + 1}.`}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>@{trader.username}</span>
                  {trader.verified && (
                    <span style={{ fontSize: 10, background: '#10b98120', color: '#10b981', padding: '1px 6px', borderRadius: 10 }}>
                      ✓ Verified
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  {trader.totalTrades} trades · {trader.winRate?.toFixed(0)}% WR
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontSize: 15, fontWeight: 700,
                  color: trader.pnl30d >= 0 ? '#10b981' : '#ef4444'
                }}>
                  {trader.pnl30d >= 0 ? '+' : ''}${trader.pnl30d?.toFixed(0)}
                </div>
                <div style={{ fontSize: 10, color: '#64748b' }}>30d PnL</div>
              </div>
            </div>
            <button style={{
              marginTop: 10, width: '100%', padding: '8px',
              background: '#7c3aed20', border: '1px solid #7c3aed40',
              borderRadius: 8, color: '#a78bfa', fontSize: 13,
              cursor: 'pointer', fontWeight: 500
            }}>
              Follow @{trader.username}
            </button>
          </div>
        ))
      )}

      <div style={{ marginTop: 8, fontSize: 12, color: '#64748b', textAlign: 'center' }}>
        Use /copytrade in the bot to follow traders
      </div>
    </div>
  )
}

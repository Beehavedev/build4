import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { apiFetch } from '../api'

interface PortfolioProps {
  userId: string | null
}

type Range = '7d' | '30d' | 'all'

interface WalletInfo {
  address: string
  balances:    { usdt: number; bnb: number; error: string | null }
  aster:       { usdt: number; availableMargin: number; onboarded: boolean; error: string | null }
  hyperliquid?: { usdc: number; accountValue: number; onboarded: boolean; error: string | null }
}

interface PredictionPosition {
  id: string
  marketTitle: string
  marketAddress: string
  outcomeLabel: string | null
  usdtIn: number | null
  payoutUsdt: number | null
  pnl: number | null
  status: string
  paperTrade?: boolean | null
  openedAt: string
  closedAt: string | null
  currentValueUsdt: number | null
}

export default function Portfolio({ userId }: PortfolioProps) {
  const [data, setData] = useState<any>(null)
  const [range, setRange] = useState<Range>('30d')
  const [loading, setLoading] = useState(true)
  const [wallet, setWallet] = useState<WalletInfo | null>(null)
  const [predictions, setPredictions] = useState<PredictionPosition[]>([])

  useEffect(() => {
    if (!userId) { setLoading(false); return }
    fetch(`/api/portfolio/${userId}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [userId])

  useEffect(() => {
    apiFetch<WalletInfo>('/api/me/wallet')
      .then(setWallet)
      .catch(() => { /* silent — balance strip just hides */ })
  }, [])

  // Pull 42.space prediction positions so Trade History reflects holdings
  // across ALL platforms — perps (Aster, HL) AND prediction markets — in
  // a single list. Without this, users had to bounce to the Predict tab
  // to see their parimutuel exposure, which broke the "single portfolio"
  // promise of this page.
  useEffect(() => {
    apiFetch<{ ok: boolean; positions: PredictionPosition[] }>('/api/me/positions')
      .then((r) => setPredictions(r?.positions ?? []))
      .catch(() => { /* silent — predictions section just stays empty */ })
  }, [])

  const trades: any[] = data?.trades ?? []
  // Lifetime stats (Total PnL, Win Rate, Best Trade) only count CLOSED
  // trades. Open positions carry unrealized PnL that fluctuates with the
  // market — including them here would make "lifetime" numbers move
  // tick-to-tick, which isn't what users expect from a performance card.
  const realized = trades.filter((t: any) => t.status !== 'open')
  const totalPnl = realized.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0)
  const wins = realized.filter((t: any) => (t.pnl ?? 0) > 0).length
  const winRate = realized.length > 0 ? (wins / realized.length) * 100 : 0

  // Build cumulative PnL chart data
  const now = Date.now()
  const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : 365
  const cutoff = now - rangeDays * 86400000

  const closedTrades = trades
    .filter((t: any) => t.closedAt && new Date(t.closedAt).getTime() > cutoff)
    .sort((a: any, b: any) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime())

  let cumulative = 0
  const chartData = closedTrades.map((t: any) => {
    cumulative += t.pnl ?? 0
    return {
      date: new Date(t.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      pnl: parseFloat(cumulative.toFixed(2))
    }
  })

  if (chartData.length === 0) {
    chartData.push({ date: 'Start', pnl: 0 })
  }

  const chartColor = totalPnl >= 0 ? '#10b981' : '#ef4444'

  // 42.space exposure = sum of live mark-to-market value across every
  // OPEN prediction. We deliberately exclude resolved/claimed rows here
  // because those funds either already paid out (now sitting in the BSC
  // wallet, which we count separately) or were lost. Falls back to
  // usdtIn when on-chain quote isn't available so a fresh-bought ticket
  // still contributes its principal instead of vanishing from equity.
  const fortyTwoEquity = predictions
    .filter((p) => p.status === 'open' || p.status === 'resolved_win')
    .reduce((s, p) => s + (p.currentValueUsdt ?? p.usdtIn ?? 0), 0)

  // Total equity now spans every venue the user can trade from: Aster
  // perps, Hyperliquid clearinghouse, 42.space prediction holdings, and
  // BSC wallet USDT (funding capacity for any venue). Without each of
  // these in the sum, users with funds parked on a single venue saw a
  // misleadingly low "TOTAL EQUITY" headline.
  const hlEquity = wallet?.hyperliquid?.accountValue ?? 0
  const totalEquity =
    (wallet?.aster.usdt ?? 0) +
    hlEquity +
    fortyTwoEquity +
    (wallet?.balances.usdt ?? 0)

  // Merge prediction-market positions into the unified Trade History so
  // every open holding (perp + parimutuel) shows in one place. We tag
  // each row with its venue so the user can tell at a glance whether a
  // line is a Hyperliquid perp, an Aster perp, or a 42.space prediction.
  const predTrades = predictions.map((p) => {
    const isOpen = p.status === 'open' || p.status === 'resolved_win'
    // Use payoutUsdt when claimed, currentValueUsdt for live PnL, or
    // realized pnl on closed/loss rows. Falls back to null so the row
    // still renders even with incomplete on-chain data.
    const realizedOrLive =
      p.status === 'claimed' || p.status === 'closed' || p.status === 'resolved_loss'
        ? (p.pnl ?? null)
        : (p.currentValueUsdt != null && p.usdtIn != null
            ? p.currentValueUsdt - p.usdtIn
            : null)
    return {
      id: `pred_${p.id}`,
      pair: p.marketTitle.length > 28 ? p.marketTitle.slice(0, 28) + '…' : p.marketTitle,
      side: p.outcomeLabel ?? '—',
      pnl: realizedOrLive,
      status: isOpen ? 'open' : 'closed',
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      exchange: '42space',
      paperTrade: !!p.paperTrade,
    }
  })

  // Open positions float to the top, then closed by recency.
  const allTrades = [...trades, ...predTrades].sort((a, b) => {
    const aOpen = a.status === 'open' ? 1 : 0
    const bOpen = b.status === 'open' ? 1 : 0
    if (aOpen !== bOpen) return bOpen - aOpen
    const ta = a.closedAt ? new Date(a.closedAt).getTime() : new Date(a.openedAt ?? 0).getTime()
    const tb = b.closedAt ? new Date(b.closedAt).getTime() : new Date(b.openedAt ?? 0).getTime()
    return tb - ta
  })

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>📊 Portfolio</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
          Your trading performance
        </div>
      </div>

      {/* Hero — Lead with dominant value (total equity) + lifetime PnL.
          Adds:
          - "Trading active" pill when the user is onboarded on Aster, so
            an empty equity card still feels like a live account, not a
            broken page.
          - "% of equity" alongside lifetime PnL so an absolute number like
            "+$4.12" has scale (4.12 on $50 reads very differently from
            4.12 on $5,000).
          - Neutral muted colour when both PnL and trade count are zero so
            a fresh account doesn't paint a hopeful green or alarming red.
       */}
      {(() => {
        const isFresh = totalPnl === 0 && trades.length === 0
        const pnlColor = isFresh
          ? 'var(--text-secondary)'
          : totalPnl > 0 ? 'var(--green)' : totalPnl < 0 ? 'var(--red)' : 'var(--text-secondary)'
        // % of equity context only kicks in once we actually have equity to
        // measure against; otherwise dividing by ~0 throws huge percentages.
        const pctOfEquity = totalEquity > 0.01 ? (totalPnl / totalEquity) * 100 : null
        return (
      <div className="card" style={{ marginBottom: 14 }} data-testid="card-portfolio-hero">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{
            fontSize: 11, color: 'var(--text-secondary)', letterSpacing: 0.6,
            textTransform: 'uppercase', fontWeight: 600,
          }}>
            Total Equity
          </div>
          {wallet?.aster.onboarded && wallet.aster.usdt > 0 && (
            <span
              data-testid="badge-trading-active"
              style={{
                fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                padding: '3px 8px', borderRadius: 999,
                background: 'rgba(16, 185, 129, 0.12)',
                color: '#10b981',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 3, background: '#10b981' }} />
              TRADING ACTIVE
            </span>
          )}
        </div>
        <div style={{
          fontSize: 'var(--text-2xl)', fontWeight: 800,
          letterSpacing: '-1px', lineHeight: 1.05, color: 'var(--text-primary)'
        }} data-testid="text-portfolio-total">
          ${totalEquity.toFixed(2)}
        </div>
        <div style={{ marginTop: 6, fontSize: 13, color: pnlColor }}>
          {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} lifetime
          {pctOfEquity !== null && totalPnl !== 0 && (
            <span style={{ marginLeft: 6, color: pnlColor, opacity: 0.85 }}>
              ({pctOfEquity >= 0 ? '+' : ''}{pctOfEquity.toFixed(2)}% of equity)
            </span>
          )}
          <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
            · {trades.length} trades
          </span>
        </div>
      </div>
        )
      })()}

      {/* Soft amber nudge when Aster is negative — agents pause but the
          page still leads with the headline number, not the warning. */}
      {wallet?.aster.onboarded && wallet.aster.usdt <= 0 && (
        <div
          data-testid="banner-negative-balance"
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 10,
            background: 'rgba(245, 158, 11, 0.10)',
            border: '1px solid rgba(245, 158, 11, 0.40)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8
          }}>
          <div style={{ fontSize: 16, lineHeight: 1 }}>⛽</div>
          <div style={{ fontSize: 12, color: 'var(--amber)', lineHeight: 1.4 }}>
            <div style={{ fontWeight: 600 }}>Aster needs a top-up — agents paused</div>
            <div style={{ marginTop: 2, color: 'var(--text-secondary)' }}>
              Add USDT to your Aster account to resume trading. Open the Wallet tab and tap Transfer.
            </div>
          </div>
        </div>
      )}

      {/* Balances — same data as the Wallet tab, condensed for a glance */}
      {wallet && (
        <div className="card" style={{ marginBottom: 16 }} data-testid="card-portfolio-balances">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: '#64748b', letterSpacing: 0.4 }}>BALANCES</div>
            <div style={{ fontSize: 10, color:
              !wallet.aster.onboarded ? '#64748b'
              : wallet.aster.usdt <= 0 ? '#ef4444'
              : '#10b981'
            }}>
              {!wallet.aster.onboarded
                ? '○ Not activated'
                : wallet.aster.usdt <= 0
                  ? '● Paused — fund to resume'
                  : '● Trading active'}
            </div>
          </div>

          {/* 2x2 grid for the three trading venues (Aster, HL, 42.space)
              plus BSC wallet capacity. Each venue gets equal visual weight
              so users can see at a glance where every dollar lives.
              Without 42.space on this card, users running prediction
              strategies had no way to see their parimutuel exposure from
              Portfolio at all. */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            marginBottom: 10,
          }}>
            {/* Aster card — primary if onboarded; red if negative */}
            {(() => {
              const isNegative = wallet.aster.onboarded && wallet.aster.usdt <= 0
              const accentColor = isNegative
                ? '#ef4444'
                : (wallet.aster.onboarded ? '#10b981' : '#e2e8f0')
              const cardBg = isNegative
                ? 'linear-gradient(135deg, #ef444422, #ef444408)'
                : (wallet.aster.onboarded
                    ? 'linear-gradient(135deg, #10b98122, #10b98108)'
                    : '#0f0f17')
              const cardBorder = isNegative
                ? '#ef444466'
                : (wallet.aster.onboarded ? '#10b98144' : '#1e1e2e')
              return (
                <div style={{
                  padding: 10,
                  borderRadius: 8,
                  background: cardBg,
                  border: `1px solid ${cardBorder}`
                }}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {isNegative && <span>⚠️</span>}
                    <span>ASTER · USDT</span>
                  </div>
                  <div style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: accentColor
                  }} data-testid="text-portfolio-aster-usdt">
                    {wallet.aster.usdt < 0 ? '-' : ''}${Math.abs(wallet.aster.usdt).toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                    Avail {wallet.aster.availableMargin < 0 ? '-' : ''}${Math.abs(wallet.aster.availableMargin).toFixed(2)}
                  </div>
                </div>
              )
            })()}

            {/* Hyperliquid card — mirrors the Aster card layout so users
                can compare equity across the two perp venues at a glance.
                Renders a muted "Not activated" state when the user hasn't
                completed HL onboarding yet — same affordance as Aster. */}
            {(() => {
              const hl = wallet.hyperliquid
              const onboarded = !!hl?.onboarded
              const accountValue = hl?.accountValue ?? 0
              const usdc = hl?.usdc ?? 0
              const accentColor = onboarded
                ? (accountValue > 0 ? '#06b6d4' : '#64748b')
                : '#e2e8f0'
              const cardBg = onboarded && accountValue > 0
                ? 'linear-gradient(135deg, #06b6d422, #06b6d408)'
                : '#0f0f17'
              const cardBorder = onboarded && accountValue > 0
                ? '#06b6d444'
                : '#1e1e2e'
              return (
                <div style={{
                  padding: 10,
                  borderRadius: 8,
                  background: cardBg,
                  border: `1px solid ${cardBorder}`
                }}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4 }}>
                    HYPERLIQUID · USDC
                  </div>
                  <div style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: accentColor
                  }} data-testid="text-portfolio-hl-usdc">
                    ${accountValue.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                    {onboarded ? `Avail $${usdc.toFixed(2)}` : 'Not activated'}
                  </div>
                </div>
              )
            })()}

            {/* 42.space card — third trading venue. Mirrors the Aster/HL
                layout for visual symmetry and uses the same purple accent
                that 42.space gets in the live feed and venue badges so
                users get a consistent colour-to-venue mapping across the
                app. Counts open positions only; the sub-line shows the
                count of live tickets so a $0 card with positions still
                tells a story (e.g. "2 open" while resolution pending). */}
            {(() => {
              const openCount = predictions.filter(
                (p) => p.status === 'open' || p.status === 'resolved_win',
              ).length
              const hasExposure = fortyTwoEquity > 0.01 || openCount > 0
              const accentColor = hasExposure ? '#a855f7' : '#e2e8f0'
              const cardBg = hasExposure
                ? 'linear-gradient(135deg, #a855f722, #a855f708)'
                : '#0f0f17'
              const cardBorder = hasExposure ? '#a855f744' : '#1e1e2e'
              return (
                <div style={{
                  padding: 10,
                  borderRadius: 8,
                  background: cardBg,
                  border: `1px solid ${cardBorder}`,
                }}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4 }}>
                    42.SPACE · USDT
                  </div>
                  <div
                    style={{ fontSize: 18, fontWeight: 700, color: accentColor }}
                    data-testid="text-portfolio-42space-usdt"
                  >
                    ${fortyTwoEquity.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                    {openCount > 0
                      ? `${openCount} open position${openCount === 1 ? '' : 's'}`
                      : 'No open positions'}
                  </div>
                </div>
              )
            })()}

            {/* BSC card — funding capacity (USDT for both Aster + HL
                bridges and 42.space ticket buys). Now lives inside the
                grid as the 4th tile so the four venues read as one
                balanced 2x2 block instead of "two cards + a wide
                outlier". */}
            <div style={{
              padding: 10,
              borderRadius: 8,
              background: '#0f0f17',
              border: '1px solid #1e1e2e',
            }}>
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4 }}>BSC · USDT (wallet)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}
                   data-testid="text-portfolio-bsc-usdt">
                ${wallet.balances.usdt.toFixed(2)}
              </div>
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                BNB {wallet.balances.bnb.toFixed(5)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'Total PnL', value: `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`, color: totalPnl >= 0 ? '#10b981' : '#ef4444' },
          { label: 'Win Rate', value: `${winRate.toFixed(1)}%`, color: '#e2e8f0' },
          { label: 'Total Trades', value: trades.length, color: '#e2e8f0' },
          { label: 'Best Trade', value: `+$${Math.max(0, ...realized.map((t: any) => t.pnl ?? 0)).toFixed(2)}`, color: '#10b981' }
        ].map(stat => (
          <div key={stat.label} className="card">
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{stat.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Cumulative PnL</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['7d', '30d', 'all'] as Range[]).map(r => (
              <button key={r} onClick={() => setRange(r)} style={{
                padding: '3px 10px', borderRadius: 6, fontSize: 11,
                background: range === r ? '#7c3aed' : 'transparent',
                border: `1px solid ${range === r ? '#7c3aed' : '#1e1e2e'}`,
                color: range === r ? 'white' : '#64748b',
                cursor: 'pointer'
              }}>{r}</button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={chartData}>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} width={50} tickFormatter={v => `$${v}`} />
            <Tooltip
              contentStyle={{ background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 8, fontSize: 12 }}
              formatter={(v: any) => [`$${v}`, 'PnL']}
            />
            <Line type="monotone" dataKey="pnl" stroke={chartColor} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Trade history — every open holding + closed trade across every
          venue (Aster perps, Hyperliquid perps, 42.space predictions),
          sorted with open positions on top and closed trades by recency.
          Each row carries a venue badge so the user can tell at a glance
          where each trade sits. */}
      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Trade History</div>
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>Loading...</div>
        ) : allTrades.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>No trades yet.</div>
        ) : (
          allTrades.slice(0, 12).map((t: any) => {
            // Map exchange → display badge. Colours match each venue's
            // accent elsewhere in the app: orange Aster, cyan HL, purple 42.
            const venue = (() => {
              const ex = String(t.exchange ?? '').toLowerCase()
              if (ex === 'hyperliquid' || ex === 'hl')
                return { label: 'HL',    bg: '#06b6d422', fg: '#06b6d4' }
              if (ex === '42space' || ex === '42' || ex === 'fortytwo')
                return { label: '42',    bg: '#a855f722', fg: '#a855f7' }
              if (ex === 'mock')
                return { label: 'PAPER', bg: '#64748b22', fg: '#94a3b8' }
              return     { label: 'ASTER', bg: '#f59e0b22', fg: '#f59e0b' }
            })()
            // LONG/SHORT colouring stays for perps; predictions show their
            // outcome label (YES/NO) in neutral blue.
            const isPerpSide = t.side === 'LONG' || t.side === 'SHORT'
            const sideStyle = isPerpSide
              ? {
                  bg: t.side === 'LONG' ? '#10b98115' : '#ef444415',
                  fg: t.side === 'LONG' ? '#10b981'   : '#ef4444',
                }
              : { bg: '#3b82f615', fg: '#60a5fa' }
            return (
              <div key={t.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 0', borderBottom: '1px solid #1e1e2e'
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{t.pair}</span>
                    <span style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 4,
                      background: sideStyle.bg, color: sideStyle.fg,
                    }}>{t.side}</span>
                    <span
                      style={{
                        fontSize: 9, padding: '1px 6px', borderRadius: 4,
                        background: venue.bg, color: venue.fg, fontWeight: 600,
                        letterSpacing: 0.4,
                      }}
                      data-testid={`badge-venue-${t.id}`}
                    >
                      {venue.label}
                    </span>
                    {t.paperTrade && (
                      <span style={{
                        fontSize: 9, padding: '1px 6px', borderRadius: 4,
                        background: '#64748b22', color: '#94a3b8',
                      }}>PAPER</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
                    {t.closedAt ? new Date(t.closedAt).toLocaleDateString() : 'Open'}
                    {t.aiReasoning && (
                      <span style={{ marginLeft: 6, color: '#7c3aed' }}>· AI</span>
                    )}
                  </div>
                </div>
                {/* Round near-zero PnL (anything within $0.005 of zero, i.e.
                    pure rounding noise) to a calm muted "$0.00" instead of
                    painting a green +$0.00 / red -$0.00. */}
                {(() => {
                  const pnl = t.pnl ?? 0
                  const isNearZero = Math.abs(pnl) < 0.005
                  const color = t.status === 'open'
                    ? (pnl > 0 ? '#10b981' : pnl < 0 ? '#ef4444' : '#64748b')
                    : isNearZero ? 'var(--text-secondary)'
                    : pnl > 0 ? '#10b981' : '#ef4444'
                  return (
                    <div style={{ fontSize: 14, fontWeight: 600, color, textAlign: 'right' }} data-testid={`text-trade-pnl-${t.id}`}>
                      {t.status === 'open' ? (
                        // For open positions show live unrealized PnL when
                        // we have it (HL fills, 42.space curve quote);
                        // otherwise the calm "Open" pill.
                        t.pnl != null ? (
                          <>
                            <span style={{ fontSize: 14 }}>
                              {pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(2)}
                            </span>
                            <div style={{ fontSize: 10, color: '#64748b', fontWeight: 400 }}>open</div>
                          </>
                        ) : (
                          <span style={{ color: '#64748b', fontSize: 12 }}>Open</span>
                        )
                      ) : isNearZero ? (
                        '$0.00'
                      ) : (
                        `${pnl > 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../api'

interface DashboardProps {
  userId: string | null
  onNavigate?: (page: 'dashboard' | 'agents' | 'wallet' | 'trade' | 'copy' | 'portfolio' | 'predictions' | 'hyperliquid' | 'admin' | 'onboard' | 'launchToken') => void
  launchEnabled?: boolean
}

interface WalletInfo {
  address: string
  balances: { usdt: number; bnb: number; error: string | null }
  aster: { usdt: number; availableMargin: number; onboarded: boolean; error: string | null }
  hyperliquid?: { usdc: number; accountValue: number; onboarded: boolean; error: string | null }
}

interface RecentTrade {
  id: string
  pair?: string
  side?: string
  pnl?: number
  status?: string
  closedAt?: string
  openedAt?: string
}

function timeAgo(iso?: string): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function tradeIcon(t: RecentTrade): string {
  if (t.status === 'open') return '⏳'
  if ((t.pnl ?? 0) > 0) return '✅'
  if ((t.pnl ?? 0) < 0) return '❌'
  return '·'
}

export default function Dashboard({ userId, onNavigate, launchEnabled }: DashboardProps) {
  const [portfolio, setPortfolio] = useState<any>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [trades, setTrades] = useState<RecentTrade[]>([])
  const [wallet, setWallet] = useState<WalletInfo | null>(null)
  // Polymarket wallet block — fetched separately from /api/me/wallet because
  // it requires hitting Polygon RPC and we don't want to slow the main
  // wallet refresh down. Soft-fails to null if creds aren't set up yet.
  const [polyWallet, setPolyWallet] = useState<{
    walletAddress: string | null
    hasCreds: boolean
    ready: boolean
    balances: { matic: number; usdc: number; allowanceCtf: number; allowanceNeg: number } | null
  } | null>(null)
  const [loading, setLoading] = useState(true)
  // Sticky-onboarded latches — once we have ever seen the venue as
  // onboarded with funds, we refuse to demote the card back to "not
  // activated" on subsequent ticks. The /api/me/wallet endpoint can
  // briefly return `onboarded:false` / `accountValue:0` whenever the
  // upstream venue API rate-limits or times out (HL's `/info` 429s
  // intermittently because Render gives us a single shared egress IP),
  // and without these latches the user sees their HL/Aster cards
  // visibly toggle LIVE → "not activated" → LIVE every second. The
  // server-side fix in getAccountState() now serves stale-on-error so
  // this is mostly belt-and-braces — but the latch also covers the
  // first-load edge where the server hasn't seen this user yet, plus
  // any non-HL venue that doesn't have its own stale cache.
  const hlEverOnboardedRef    = useRef(false)
  const asterEverOnboardedRef = useRef(false)
  const polyEverReadyRef      = useRef(false)
  // Mirror the latch into state so the render reads it (refs don't
  // trigger re-render). Single boolean per venue to keep the diff
  // minimal — derived `*Onboarded` consts below OR with these.
  const [hlEverOnboarded,    setHlEverOnboarded]    = useState(false)
  const [asterEverOnboarded, setAsterEverOnboarded] = useState(false)
  const [polyEverReady,      setPolyEverReady]      = useState(false)

  useEffect(() => {
    if (!userId) { setLoading(false); return }
    let cancelled = false

    // Reset the sticky-onboarded latches when the userId changes.
    // The Dashboard component normally lives for the entire mini-app
    // session (one Telegram WebApp = one user) so this is mostly
    // belt-and-braces, but if a wallet/account ever swapped under us
    // we'd otherwise keep showing the previous user's HL/Aster/Poly
    // venues as LIVE — strictly worse than a one-frame re-evaluation.
    // Refs + state both reset so the next data tick re-latches from
    // a clean slate against the new user's actual venue status.
    hlEverOnboardedRef.current    = false
    asterEverOnboardedRef.current = false
    polyEverReadyRef.current      = false
    setHlEverOnboarded(false)
    setAsterEverOnboarded(false)
    setPolyEverReady(false)

    // First-paint fetch — render the dashboard as soon as we have user +
    // agents, even if the wallet (and especially the HL leg of it) is
    // still resolving. This kept the loading skeleton from getting stuck
    // behind a slow Hyperliquid clearinghouse read.
    // Polymarket refresh helper — used by all three trigger points
    // (initial fetch, 5s interval, visibility change). Soft-fail rules:
    //  - hard fetch error (network blip) → keep last good state
    //  - parsed response with ok===false → reset to null so the card
    //    falls back to "not activated" instead of showing a stale LIVE
    //    balance after the user logs out / loses creds.
    const refreshPoly = () => {
      if (cancelled) return
      apiFetch<any>('/api/polymarket/wallet')
        .then((p) => {
          if (cancelled) return
          if (p?.ok) {
            setPolyWallet(p)
            // Latch the "ever ready" flag so a subsequent flaky Polygon
            // RPC read can't downgrade the card to "not activated".
            if (p.ready && !polyEverReadyRef.current) {
              polyEverReadyRef.current = true
              setPolyEverReady(true)
            }
          } else setPolyWallet(null)
        })
        .catch(() => { /* network blip — keep last good state */ })
    }
    // Helper: apply the same "latch on first-true" pattern to wallet
    // venues. Pulled out so the first-paint fetch and the 1s polling
    // loop stay in sync.
    const latchWalletFlags = (w: WalletInfo | null | undefined) => {
      if (!w) return
      if (w.hyperliquid?.onboarded && !hlEverOnboardedRef.current) {
        hlEverOnboardedRef.current = true
        setHlEverOnboarded(true)
      }
      if (w.aster?.onboarded && !asterEverOnboardedRef.current) {
        asterEverOnboardedRef.current = true
        setAsterEverOnboarded(true)
      }
    }

    // First-paint fetch — only the three calls that the dashboard
    // skeleton actually depends on are gated here. Polymarket is
    // intentionally fired independently below so a slow Polygon RPC
    // never delays the dashboard from rendering.
    Promise.all([
      fetch(`/api/user/${userId}`).then(r => r.json()).catch(() => null),
      fetch(`/api/agents/${userId}`).then(r => r.json()).catch(() => []),
      apiFetch<WalletInfo>('/api/me/wallet').catch(() => null),
    ]).then(([user, agentData, walletData]) => {
      if (cancelled) return
      if (user?.portfolio) setPortfolio(user.portfolio)
      if (Array.isArray(agentData)) setAgents(agentData)
      // Filter out paper + mock-exchange rows so Recent Activity only
      // ever shows real, venue-confirmed trades. Per "no fakes ever".
      if (Array.isArray(user?.recentTrades)) {
        setTrades(user.recentTrades.filter((t: any) => !t?.paperTrade && t?.exchange !== 'mock'))
      }
      if (walletData) {
        setWallet(walletData)
        latchWalletFlags(walletData)
      }
      setLoading(false)
    })

    // Polymarket wallet — fire-and-forget independent of the gating
    // Promise.all so a slow Polygon RPC never blocks first paint.
    refreshPoly()

    // 1s wallet refresh — every venue balance (Aster USDT, HL
    // clearinghouse account value, BSC USDT) is re-pulled live so the
    // dashboard always shows real-time numbers. Self-heals if the
    // first /api/me/wallet call returned a stale Hyperliquid read.
    const id = setInterval(() => {
      if (cancelled) return
      apiFetch<WalletInfo>('/api/me/wallet')
        .then((w) => {
          if (cancelled || !w) return
          setWallet(w)
          latchWalletFlags(w)
        })
        .catch(() => { /* keep last good state */ })
    }, 1000)

    // Polymarket wallet refresh on a slower 5s cadence — Polygon RPC is
    // slower + more rate-limited than the BSC reads behind /api/me/wallet
    // and the user's USDC balance doesn't change every second anyway.
    const polyId = setInterval(refreshPoly, 5000)

    // Also refetch whenever the tab becomes visible again — switching
    // to wallet/portfolio and back already triggers the user's mental
    // model that "balances should be fresh now", so honour that. We
    // refresh BOTH the BSC/HL wallet and the Polymarket wallet because
    // the user may have funded their Polygon address while away.
    const onVis = () => {
      if (document.visibilityState === 'visible' && !cancelled) {
        apiFetch<WalletInfo>('/api/me/wallet')
          .then((w) => { if (!cancelled && w) setWallet(w) })
          .catch(() => { /* keep last good state */ })
        refreshPoly()
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      cancelled = true
      clearInterval(id)
      clearInterval(polyId)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [userId])

  if (loading) {
    return (
      <div style={{ paddingTop: 60, textAlign: 'center', color: 'var(--text-secondary)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
        Loading BUILD4…
      </div>
    )
  }

  const asterUsdt = wallet?.aster?.usdt ?? 0
  // OR with the sticky latch so a single flaky tick (Aster API blip,
  // BSC RPC timeout) can never demote the card from LIVE → "not
  // activated". Once we have ever seen onboarded:true for this session
  // we keep showing the venue as activated. See ref declaration above.
  const asterOnboarded = !!wallet?.aster?.onboarded || asterEverOnboarded
  const bscUsdt = wallet?.balances?.usdt ?? 0
  // Hyperliquid clearinghouse equity (USDC). Falls through to 0 if the
  // server didn't return the hyperliquid block (older clients) or if HL
  // is temporarily unreachable — better than hiding the venue entirely.
  const hlValue = wallet?.hyperliquid?.accountValue ?? 0
  // Same sticky-onboarded latch as Aster. The server-side stale-on-
  // error fallback in getAccountState() handles this for users who've
  // been read at least once, but the latch also covers the case where
  // a brand-new mount races against an in-flight 429 before the
  // server-side cache is populated.
  const hlOnboarded = !!wallet?.hyperliquid?.onboarded || hlEverOnboarded
  // 42.space "value" — for now we surface BSC USDT here since 42.space
  // positions live on BSC and the mini-app's open-position MTM lives in
  // the Predictions tab. This card is the user's BSC pocket / dry powder
  // available for prediction trades.
  const predValue = bscUsdt
  // Polymarket dry powder = Polygon USDC the user holds at the custodial
  // address. We treat "ready" (creds exist + allowance approved) as
  // onboarded so the pill mirrors the other venues' onboarded/funded
  // logic. If the wallet endpoint hasn't returned yet we soft-fall to
  // 0 / not-activated rather than hiding the card.
  const polyUsdc = polyWallet?.balances?.usdc ?? 0
  // OR with the sticky latch so a transient Polygon RPC blip can't
  // demote a known-ready Polymarket card to "not activated".
  const polyOnboarded = !!polyWallet?.ready || polyEverReady
  const totalValue = asterUsdt + bscUsdt + hlValue + polyUsdc
  const todayPnl = portfolio?.dayPnl ?? 0
  const todayPct = totalValue > 0 ? (todayPnl / totalValue) * 100 : 0

  const activeAgents = agents.filter(a => a.isActive).length
  const fmtUsd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
  const fmtPnl = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`

  // All three quick-action buttons jump straight to the venue's TRADE
  // surface (manual perp ticket / prediction picker), keeping behaviour
  // parallel across Aster, 42.space, and Hyperliquid. Aster previously
  // routed to 'agents' (the agent management screen) which broke parity
  // with HL — users tapping "Aster · Perps" expected the trade ticket,
  // not an agent list.
  // Helper used by the Polymarket card + quick-action: write the venue
  // preference before navigating to the Predictions page so the user
  // lands directly on the Polymarket sub-tab. Without this, tapping
  // "Polymarket" from the dashboard would dump them on 42.space (which
  // is the saved default) and force a second tap on the venue selector.
  const goPolymarket = () => {
    try { window.localStorage.setItem('build4.predict.venue', 'poly') } catch {}
    onNavigate?.('predictions')
  }

  const quickActions: Array<{ label: string; sub: string; testId: string; onClick: () => void; disabled?: boolean }> = [
    {
      label: 'Aster',
      sub: 'Perps',
      testId: 'button-venue-aster',
      onClick: () => onNavigate?.('trade'),
    },
    {
      label: '42.space',
      sub: 'Predict',
      testId: 'button-venue-42',
      onClick: () => onNavigate?.('predictions'),
    },
    {
      label: 'Hyperliquid',
      sub: 'Perps',
      testId: 'button-venue-hyperliquid',
      onClick: () => onNavigate?.('hyperliquid'),
    },
    {
      label: 'Polymarket',
      sub: 'Predict',
      testId: 'button-venue-polymarket',
      onClick: goPolymarket,
    },
    ...(launchEnabled ? [{
      label: '🚀 Launch Token',
      sub: 'four.meme',
      testId: 'button-venue-fourmeme-launch',
      onClick: () => onNavigate?.('launchToken'),
    }] : []),
  ]

  return (
    <div style={{ paddingTop: 20 }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
          ⚡ BUILD4
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
          AI Trading & Predictions
        </div>
      </div>

      {/* Hero — Total Portfolio Value */}
      <div className="card" style={{ marginBottom: 16 }} data-testid="card-total-portfolio">
        <div style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--text-secondary)',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          fontWeight: 600,
          marginBottom: 8
        }}>
          Total Portfolio Value
        </div>
        <div style={{
          fontSize: 'var(--text-2xl)',
          fontWeight: 800,
          letterSpacing: '-1px',
          lineHeight: 1.05,
          color: 'var(--text-primary)'
        }} data-testid="text-total-value">
          {fmtUsd(totalValue)}
        </div>
        <div style={{
          marginTop: 6,
          fontSize: 'var(--text-sm)',
          color: todayPnl > 0 ? 'var(--green)' : todayPnl < 0 ? 'var(--red)' : 'var(--text-secondary)',
        }} data-testid="text-today-pnl">
          {fmtPnl(todayPnl)} today ({todayPct >= 0 ? '+' : ''}{todayPct.toFixed(1)}%)
        </div>
      </div>

      {/* System split — Aster + Hyperliquid + 42.space + Polymarket.
          Four venues now that Polymarket is live (Builder Program). Three
          columns made the cards comfortable on mobile width but adding a
          fourth in one row would overflow, so we drop to a 2×2 grid which
          keeps every card readable while showing all venues at a glance. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <div className="card" data-testid="card-aster" style={{ padding: 12 }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: 0.4 }}>
            ASTER
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>Futures · BSC</div>
          <div style={{ fontSize: 'var(--text-md)', fontWeight: 700 }} data-testid="text-aster-balance">
            {fmtUsd(asterUsdt)}
          </div>
          {/* Sub-line is the venue's trading-mode summary, kept identical
              across all three venue cards so users get one consistent
              "what can I do here?" hint. Previously this was an agent
              count which read as a different concept (org chart, not
              capability) and broke parity with HL / 42.space. */}
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
            {asterOnboarded ? 'manual & AI' : 'not activated'}
          </div>
          <div style={{ marginTop: 6 }}>
            {/* Pill must agree with the sub-line text above. We previously
                drove "LIVE" off `activeAgents > 0` while the sub-line used
                `asterOnboarded`, which produced the contradictory state
                "not activated · LIVE" for users who had an agent record
                but had never run /aster/approve. Now both surfaces are
                derived from the same onboarded + funded state. */}
            <span className={`pill ${asterOnboarded && activeAgents > 0 ? 'pill-live' : asterOnboarded ? 'pill-muted' : 'pill-amber'}`}>
              <span className={asterOnboarded && activeAgents > 0 ? 'dot-live' : 'dot-muted'} />
              {asterOnboarded
                ? (activeAgents > 0 ? 'LIVE' : asterUsdt > 0 ? 'idle' : 'fund to start')
                : 'not activated'}
            </span>
          </div>
        </div>

        <div className="card" data-testid="card-hyperliquid" style={{ padding: 12 }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: 0.4 }}>
            HYPERLIQUID
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>Perps · USDC</div>
          <div style={{ fontSize: 'var(--text-md)', fontWeight: 700 }} data-testid="text-hl-balance">
            {fmtUsd(hlValue)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
            {hlOnboarded ? 'manual & AI' : 'not activated'}
          </div>
          <div style={{ marginTop: 6 }}>
            {/* Same onboarded-first logic as the Aster pill above. The
                previous version drove "fund to start" off `!hlOnboarded`,
                which contradicted the sub-line ("not activated") and let
                the pill claim "idle" for users who had finished agent
                approval but had no funds. Now: not onboarded → "not
                activated"; onboarded but empty → "fund to start";
                onboarded with funds → "LIVE". */}
            <span className={`pill ${hlOnboarded && hlValue > 0 ? 'pill-live' : hlOnboarded ? 'pill-muted' : 'pill-amber'}`}>
              <span className={hlOnboarded && hlValue > 0 ? 'dot-live' : 'dot-muted'} />
              {hlOnboarded
                ? (hlValue > 0 ? 'LIVE' : 'fund to start')
                : 'not activated'}
            </span>
          </div>
        </div>

        <div className="card" data-testid="card-predictions" style={{ padding: 12 }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: 0.4 }}>
            42.SPACE
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>Predict · BSC</div>
          <div style={{ fontSize: 'var(--text-md)', fontWeight: 700 }} data-testid="text-predictions-balance">
            {fmtUsd(predValue)}
          </div>
          {/* Same trading-mode sub-line as Aster + HL. 42.space requires
              no separate clearinghouse onboarding (it spends BSC USDT
              directly), so it is "manual & AI" capable as soon as the
              wallet exists. The "BSC dry powder" wording previously
              here was a different concept (capital description, not
              capability) and broke parity with the other two cards. */}
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
            manual & AI
          </div>
          <div style={{ marginTop: 6 }}>
            <span className={`pill ${predValue > 0 ? 'pill-live' : 'pill-muted'}`}>
              <span className={predValue > 0 ? 'dot-live' : 'dot-muted'} />
              {predValue > 0 ? 'watching' : 'fund to start'}
            </span>
          </div>
        </div>

        {/* Polymarket — fourth venue. Mirrors the other cards' shape so
            the user gets one consistent "balance · capability · status"
            read across all four venues. Tapping the card jumps to the
            Predictions tab with the venue selector already pinned to
            Polymarket (see goPolymarket()). Pill mirrors HL/Aster: not
            onboarded → "not activated"; onboarded but no USDC → "fund to
            start"; onboarded with USDC → "LIVE". */}
        {/* Rendered as role=button + tabIndex=0 + keyboard handler so
            keyboard / screen-reader users can activate the card the
            same way mouse users can. We keep the <div className="card">
            shell so the visual style stays in lockstep with the other
            three venue cards rather than fighting <button> defaults. */}
        <div
          className="card"
          data-testid="card-polymarket"
          role="button"
          tabIndex={0}
          aria-label="Open Polymarket predictions"
          style={{ padding: 12, cursor: 'pointer' }}
          onClick={goPolymarket}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              goPolymarket()
            }
          }}
        >
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: 0.4 }}>
            POLYMARKET
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>Predict · Polygon</div>
          <div style={{ fontSize: 'var(--text-md)', fontWeight: 700 }} data-testid="text-polymarket-balance">
            {fmtUsd(polyUsdc)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
            {polyOnboarded ? 'manual & AI' : 'not activated'}
          </div>
          <div style={{ marginTop: 6 }}>
            <span className={`pill ${polyOnboarded && polyUsdc > 0 ? 'pill-live' : polyOnboarded ? 'pill-muted' : 'pill-amber'}`}>
              <span className={polyOnboarded && polyUsdc > 0 ? 'dot-live' : 'dot-muted'} />
              {polyOnboarded
                ? (polyUsdc > 0 ? 'LIVE' : 'fund to start')
                : 'not activated'}
            </span>
          </div>
        </div>
      </div>

      {/* Empty-state hero CTA. First-time users (no agents yet) land on
          a dashboard full of "$0 / fund to start" cards with nothing to
          do — friction point #3. The hero CTA gives them one obvious
          next action that goes straight to the new Onboard flow, which
          deploys an agent end-to-end in one tap. Hidden once they have
          at least one agent so returning users never see it. */}
      {agents.length === 0 && (
        <div
          className="card"
          data-testid="card-empty-state"
          style={{
            marginBottom: 16,
            padding: 16,
            border: '2px solid var(--purple)',
            background: 'var(--bg-elevated)',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
            🚀 Deploy your first AI agent
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.4 }}>
            Pick a risk preset, set your starting capital, and watch your agent trade Aster perps within 60 seconds. Free — BUILD4 covers the gas.
          </div>
          <button
            onClick={() => onNavigate?.('onboard')}
            data-testid="button-deploy-first-agent"
            style={{
              width: '100%',
              background: 'var(--purple)',
              color: '#fff',
              border: 'none',
              borderRadius: 12,
              padding: '12px 16px',
              fontSize: 15,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Deploy Agent
          </button>
        </div>
      )}

      {/* Quick actions — same 2×2 layout as the venue cards above so the
          fourth (Polymarket) button doesn't overflow the row on mobile. */}
      <div className="section-label">Quick Actions</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        {quickActions.map(a => (
          <button
            key={a.label + a.sub}
            onClick={a.onClick}
            disabled={a.disabled}
            data-testid={a.testId}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 14,
              padding: '14px 8px',
              color: a.disabled ? 'var(--text-muted)' : 'var(--text-primary)',
              cursor: a.disabled ? 'not-allowed' : 'pointer',
              opacity: a.disabled ? 0.55 : 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              textAlign: 'center'
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{a.label}</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{a.sub}</span>
          </button>
        ))}
      </div>

      {/* $B4 Buybacks — public, no auth. Lazy-mounted so a slow buyback
          query never blocks the rest of the dashboard. */}
      <BuybackSection />

      {/* four.meme launch history — caller-scoped. Hidden entirely when
          the user has no launches yet so it never adds noise for users
          who haven't touched the launcher. */}
      <FourMemePendingApprovalsSection />
      <FourMemeLaunchesSection />

      {/* Recent Activity */}
      <div className="section-label">Recent Activity</div>
      <div className="card" style={{ padding: 0 }} data-testid="card-recent-activity">
        {trades.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
            No activity yet. Fund Aster or browse 42.space markets to get started.
          </div>
        ) : (
          trades.slice(0, 5).map((t, i) => {
            const pnl = t.pnl ?? 0
            const isOpen = t.status === 'open'
            return (
              <div
                key={t.id ?? i}
                data-testid={`row-activity-${t.id ?? i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  borderBottom: i < trades.slice(0, 5).length - 1 ? '1px solid var(--border)' : 'none',
                  fontSize: 13,
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: 14 }}>{tradeIcon(t)}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.side ?? ''} {t.pair ?? ''}
                  </span>
                </div>
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: isOpen ? 'var(--text-secondary)' : pnl >= 0 ? 'var(--green)' : 'var(--red)'
                }}>
                  {isOpen ? 'Open' : fmtPnl(pnl)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 28, textAlign: 'right' }}>
                  {timeAgo(t.closedAt ?? t.openedAt)}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─── $B4 Buybacks (Task #9) ────────────────────────────────────────────────
// Public read-only card. Reads /api/buybacks once on mount and renders
// running totals + the most recent transactions.

interface BuybackTx {
  id: string
  txHash: string
  chain: string
  amountB4: number
  amountUsdt: number
  note: string | null
  createdAt: string
}

interface BuybackResponse {
  totals: { count: number; amountB4: number; amountUsdt: number }
  recent: BuybackTx[]
}

function buybackTxUrl(chain: string, txHash: string): string {
  const c = (chain ?? '').toUpperCase()
  if (c === 'XLAYER')   return `https://www.oklink.com/xlayer/tx/${txHash}`
  if (c === 'ARBITRUM') return `https://arbiscan.io/tx/${txHash}`
  return `https://bscscan.com/tx/${txHash}`
}

function fmtNum(n: number, digits = 2): string {
  return (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: digits })
}

function BuybackSection() {
  const [data, setData] = useState<BuybackResponse | null>(null)
  const [err, setErr]   = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/buybacks')
      .then((r) => r.json())
      .then((j: BuybackResponse) => setData(j))
      .catch((e) => setErr(e?.message ?? 'failed'))
  }, [])

  if (err) return null  // Silent failure — never break the dashboard.
  if (!data) {
    return (
      <>
        <div className="section-label">$B4 Buybacks</div>
        <div className="card" style={{ padding: 14, marginBottom: 16 }} data-testid="card-buybacks-loading">
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</div>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="section-label">$B4 Buybacks</div>
      <div className="card" style={{ padding: 0, marginBottom: 16 }} data-testid="card-buybacks">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          <div style={{ padding: 14, borderRight: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', letterSpacing: 0.4, fontWeight: 600 }}>
              $B4 BOUGHT BACK
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }} data-testid="text-buyback-total-b4">
              {fmtNum(data.totals.amountB4)}
            </div>
          </div>
          <div style={{ padding: 14 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', letterSpacing: 0.4, fontWeight: 600 }}>
              USDT SPENT
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }} data-testid="text-buyback-total-usdt">
              ${fmtNum(data.totals.amountUsdt)}
            </div>
          </div>
        </div>
        {data.recent.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            {data.recent.slice(0, 5).map((b, i, arr) => (
              <a
                key={b.id}
                href={buybackTxUrl(b.chain, b.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`row-buyback-${b.id}`}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
                  textDecoration: 'none', color: 'var(--text-primary)', fontSize: 13,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span style={{ fontSize: 14 }}>🔥</span>
                  <span style={{ fontWeight: 600 }}>{fmtNum(b.amountB4)}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>$B4</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {b.chain}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>${fmtNum(b.amountUsdt)}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{timeAgo(b.createdAt)}</span>
                </div>
              </a>
            ))}
          </div>
        )}
        {data.recent.length === 0 && (
          <div style={{ padding: 14, fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            First buyback coming soon.
          </div>
        )}
      </div>
    </>
  )
}

// ─── four.meme launch history ──────────────────────────────────────────
// Renders the caller's last ~20 launches from /api/fourmeme/launches.
// Self-hides when the user has no launches OR the endpoint soft-fails
// (404/disabled/network) so it never adds noise for users who haven't
// used the launcher.

interface LaunchRow {
  id: string
  tokenName: string
  tokenSymbol: string
  tokenAddress: string | null
  txHash: string | null
  launchUrl: string | null
  bscScanUrl: string | null
  imageUrl: string | null
  initialBuyBnb: string | null
  status: string
  errorMessage: string | null
  createdAt: string
}

function statusPill(status: string): { color: string; bg: string; label: string } {
  if (status === 'launched') return { color: 'var(--green)', bg: 'rgba(16,185,129,0.12)', label: '✅ launched' }
  if (status === 'failed')   return { color: 'var(--red)',   bg: 'rgba(239,68,68,0.12)',  label: '❌ failed' }
  if (status === 'stale')    return { color: 'var(--yellow, #f59e0b)', bg: 'rgba(245,158,11,0.12)', label: '⚠️ stale' }
  if (status === 'expired')  return { color: 'var(--text-muted, #9ca3af)', bg: 'rgba(156,163,175,0.12)', label: '⌛ expired' }
  if (status === 'rejected') return { color: 'var(--red)', bg: 'rgba(239,68,68,0.12)', label: '✋ rejected' }
  if (status === 'pending_user_approval') return { color: 'var(--text-secondary)', bg: 'var(--bg-elevated)', label: '👤 awaiting approval' }
  return { color: 'var(--text-secondary)', bg: 'var(--bg-elevated)', label: '⏳ pending' }
}

interface LiveLaunchInfo {
  lastPriceWei?: string
  quoteIsBnb?: boolean
  fillPct?: number
  graduatedToPancake?: boolean
  pnlPct?: number | null
  currentValueBnb?: string | null
  error?: string
}

// Format an 18-decimal BNB-wei-per-token-wei price into a readable
// "BNB per token" number. Curve prices are tiny so we lean on
// scientific notation for anything below 1e-6.
function formatBnbPrice(weiStr: string | undefined): string | null {
  if (!weiStr) return null
  try {
    const n = Number(weiStr) / 1e18
    if (!Number.isFinite(n) || n <= 0) return null
    if (n >= 1) return `${n.toFixed(4)} BNB`
    if (n >= 1e-6) return `${n.toFixed(8)} BNB`
    return `${n.toExponential(2)} BNB`
  } catch { return null }
}

// Task #64 — pending HITL approvals. Lists every 'pending_user_approval'
// row owned by the caller with one-tap Approve/Reject. Self-hides when
// the list is empty so it adds no noise for users without an approval-
// gated agent. Approve fires an on-chain launch (30-60s), so we lock
// both buttons during the in-flight request to prevent double-clicks.
interface PendingApprovalRow {
  id: string
  agentId: string | null
  tokenName: string
  tokenSymbol: string
  tokenDescription: string | null
  initialBuyBnb: string | null
  conviction: number | null
  reasoning: string | null
  createdAt: string
}

function FourMemePendingApprovalsSection() {
  const [rows, setRows] = useState<PendingApprovalRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    try {
      const j = await apiFetch<{ ok: boolean; pending: PendingApprovalRow[] }>(
        '/api/fourmeme/pending-approvals',
      )
      setRows(j?.ok ? j.pending : [])
    } catch {
      setRows([])
    }
  }
  useEffect(() => { void reload() }, [])

  const act = async (launchId: string, kind: 'approve' | 'reject') => {
    setBusy(launchId)
    setErr(null)
    try {
      await apiFetch<{ ok: true }>(`/api/fourmeme/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchId }),
      })
      await reload()
    } catch (e: any) {
      setErr(e?.message ?? `${kind} failed`)
    } finally {
      setBusy(null)
    }
  }

  if (!rows || rows.length === 0) return null
  return (
    <>
      <div className="section-label">Launch Approvals</div>
      <div className="card" style={{ padding: 0, marginBottom: 16 }} data-testid="card-fourmeme-pending-approvals">
        {err && (
          <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--red)' }} data-testid="text-approval-error">
            {err}
          </div>
        )}
        {rows.map((r, i) => (
          <div
            key={r.id}
            data-testid={`row-pending-approval-${r.id}`}
            style={{
              padding: '12px 14px',
              borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
              fontSize: 13, color: 'var(--text-primary)',
            }}
          >
            <div style={{ fontWeight: 600 }} data-testid={`text-approval-name-${r.id}`}>
              {r.tokenName} <span style={{ color: 'var(--text-muted)' }}>· ${r.tokenSymbol}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              {timeAgo(r.createdAt)} ago
              {r.initialBuyBnb ? ` · buy ${r.initialBuyBnb} BNB` : ''}
              {typeof r.conviction === 'number' ? ` · ${(r.conviction * 100).toFixed(0)}% conviction` : ''}
            </div>
            {r.reasoning && (
              <div style={{
                fontSize: 12, color: 'var(--text-secondary)', marginTop: 6,
                fontStyle: 'italic', lineHeight: 1.4,
              }}>
                {r.reasoning.slice(0, 200)}{r.reasoning.length > 200 ? '…' : ''}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                onClick={() => void act(r.id, 'approve')}
                disabled={busy !== null}
                data-testid={`button-approve-${r.id}`}
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 8, border: 'none',
                  background: 'var(--green)', color: '#fff', fontWeight: 600,
                  fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer',
                  opacity: busy === r.id ? 0.6 : 1,
                }}
              >
                {busy === r.id ? 'Launching…' : 'Approve & Launch'}
              </button>
              <button
                type="button"
                onClick={() => void act(r.id, 'reject')}
                disabled={busy !== null}
                data-testid={`button-reject-${r.id}`}
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--text-primary)',
                  fontWeight: 600, fontSize: 13,
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function FourMemeLaunchesSection() {
  const [rows, setRows] = useState<LaunchRow[] | null>(null)
  // Per-row retry state: id -> 'pending' | error string | null. We
  // intentionally keep this in component state (not React Query) so the
  // section stays self-contained.
  const [retrying, setRetrying] = useState<Record<string, 'pending' | string | null>>({})
  // Live curve data per launched row, fetched lazily after the row
  // list renders so the section paints instantly even when RPC is slow.
  const [live, setLive] = useState<Record<string, LiveLaunchInfo>>({})
  // Active trade modal: which row is open + which side + venue. Closed when null.
  const [tradeModal, setTradeModal] = useState<{ row: LaunchRow; side: 'buy' | 'sell'; graduated: boolean } | null>(null)
  const refresh = () => apiFetch<{ ok: boolean; launches: LaunchRow[] }>('/api/fourmeme/launches')
    .then((j) => setRows(j?.ok ? j.launches : []))
    .catch(() => setRows([]))
  useEffect(() => {
    let cancelled = false
    apiFetch<{ ok: boolean; launches: LaunchRow[] }>('/api/fourmeme/launches')
      .then((j) => { if (!cancelled) setRows(j?.ok ? j.launches : []) })
      .catch(() => { if (!cancelled) setRows([]) })
    return () => { cancelled = true }
  }, [])

  async function handleRetry(launchId: string) {
    setRetrying((s) => ({ ...s, [launchId]: 'pending' }))
    try {
      const j = await apiFetch<{ ok: boolean; error?: string }>('/api/fourmeme/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchId }),
      })
      if (!j?.ok) {
        setRetrying((s) => ({ ...s, [launchId]: j?.error ?? 'retry failed' }))
        return
      }
      setRetrying((s) => ({ ...s, [launchId]: null }))
      await refresh()
    } catch (err: any) {
      setRetrying((s) => ({ ...s, [launchId]: err?.message ?? 'retry failed' }))
    }
  }

  // Lazily fetch curve state for each launched row.
  useEffect(() => {
    if (!rows || rows.length === 0) return
    const hasLaunched = rows.some((r) => r.status === 'launched' && r.tokenAddress)
    if (!hasLaunched) return
    let cancelled = false
    apiFetch<{ ok: boolean; live: Record<string, LiveLaunchInfo> }>(
      '/api/fourmeme/launches/live',
    )
      .then((j) => { if (!cancelled && j?.ok) setLive(j.live ?? {}) })
      .catch(() => { /* silent — row still renders with status only */ })
    return () => { cancelled = true }
  }, [rows])
  if (!rows || rows.length === 0) return null
  return (
    <>
      <div className="section-label">Token Launches</div>
      <div className="card" style={{ padding: 0, marginBottom: 16 }} data-testid="card-fourmeme-launches">
        {rows.map((r, i) => {
          const pill = statusPill(r.status)
          const primaryUrl = r.launchUrl ?? r.bscScanUrl
          const isRetryable = r.status === 'failed' || r.status === 'stale'
          const retryState = retrying[r.id] ?? null
          const isRetryPending = retryState === 'pending'
          const retryError = retryState && retryState !== 'pending' ? retryState : null
          const subtitle = isRetryable && r.errorMessage
            ? ` · ${r.errorMessage.slice(0, 80)}`
            : r.tokenAddress
              ? ` · ${r.tokenAddress.slice(0, 6)}…${r.tokenAddress.slice(-4)}`
              : ''
          const liveInfo = live[r.id]
          const priceLabel = liveInfo && liveInfo.quoteIsBnb
            ? formatBnbPrice(liveInfo.lastPriceWei)
            : null
          const pnl = liveInfo?.pnlPct
          const hasPnl = typeof pnl === 'number' && Number.isFinite(pnl)
          const pnlColor = hasPnl
            ? (pnl >= 0 ? 'var(--green)' : 'var(--red)')
            : 'var(--text-secondary)'
          const pnlLabel = hasPnl
            ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(pnl >= 100 || pnl <= -100 ? 0 : 1)}%`
            : null
          const headerInner = (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 14px',
              fontSize: 13, color: 'var(--text-primary)', minWidth: 0,
            }}>
              {r.imageUrl ? (
                <img
                  src={r.imageUrl}
                  alt=""
                  style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, objectFit: 'cover' }}
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                />
              ) : (
                <div style={{
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                  background: 'var(--bg-elevated)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
                }}>
                  ${r.tokenSymbol.slice(0, 3).toUpperCase()}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center', gap: 6,
                }} data-testid={`text-launch-name-${r.id}`}>
                  <span style={{
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {r.tokenName} <span style={{ color: 'var(--text-muted)' }}>· ${r.tokenSymbol}</span>
                  </span>
                  {liveInfo?.graduatedToPancake ? (
                    <span
                      className="pill"
                      style={{
                        fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 999,
                        color: 'var(--green)', background: 'rgba(16,185,129,0.12)', flexShrink: 0,
                      }}
                      data-testid={`badge-launch-graduated-${r.id}`}
                    >
                      🎓 PancakeSwap
                    </span>
                  ) : null}
                </div>
                <div style={{
                  fontSize: 11, color: 'var(--text-secondary)', marginTop: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {timeAgo(r.createdAt)} ago{subtitle}
                </div>
                {priceLabel || pnlLabel || typeof liveInfo?.fillPct === 'number' ? (
                  <div style={{
                    fontSize: 11, marginTop: 3, display: 'flex', gap: 8,
                    alignItems: 'center', flexWrap: 'wrap',
                  }}>
                    {priceLabel ? (
                      <span
                        style={{ color: 'var(--text-secondary)' }}
                        data-testid={`text-launch-price-${r.id}`}
                      >
                        {priceLabel}
                      </span>
                    ) : null}
                    {pnlLabel ? (
                      <span
                        style={{ color: pnlColor, fontWeight: 600 }}
                        data-testid={`text-launch-pnl-${r.id}`}
                        title="Estimated from average curve fill price — exact tokens-received not stored"
                      >
                        {pnlLabel}
                        <span style={{
                          marginLeft: 3, fontSize: 9, fontWeight: 500,
                          color: 'var(--text-muted)',
                        }}>est.</span>
                      </span>
                    ) : null}
                    {typeof liveInfo?.fillPct === 'number' && !liveInfo.graduatedToPancake ? (
                      <span
                        style={{ color: 'var(--text-muted)' }}
                        data-testid={`text-launch-fill-${r.id}`}
                      >
                        curve {(liveInfo.fillPct * 100).toFixed(1)}%
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <span
                className="pill"
                style={{
                  fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 999,
                  color: pill.color, background: pill.bg, flexShrink: 0,
                }}
                data-testid={`status-launch-${r.id}`}
              >
                {pill.label}
              </span>
            </div>
          )
          // The clickable header is wrapped in <a> for launched rows
          // (so the whole row links to four.meme / BscScan) and a plain
          // <div> for failed/stale/pending rows, where we'd rather not
          // ship a partial link. The Retry button is rendered OUTSIDE
          // any anchor so clicking it never accidentally opens a tab.
          const clickableHeader = primaryUrl ? (
            <a
              href={primaryUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
            >
              {headerInner}
            </a>
          ) : (
            headerInner
          )
          // Trading actions: shown on every launched row with an address.
          // Backend auto-routes to four.meme bonding curve pre-migration
          // and to PancakeSwap V2 post-migration — same endpoints either
          // way, so the mini-app stays venue-agnostic.
          const canTrade = r.status === 'launched' && !!r.tokenAddress
          const graduated = !!liveInfo?.graduatedToPancake
          return (
            <div
              key={r.id}
              style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none' }}
              data-testid={`row-launch-${r.id}`}
            >
              {clickableHeader}
              {canTrade && (
                <div style={{
                  padding: '0 14px 12px 14px',
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 12,
                }}>
                  <button
                    type="button"
                    onClick={() => setTradeModal({ row: r, side: 'buy', graduated })}
                    data-testid={`button-buy-${r.id}`}
                    style={{
                      flex: 1, fontSize: 12, fontWeight: 700,
                      padding: '8px 12px', borderRadius: 8,
                      border: 'none',
                      background: 'var(--green, #10b981)',
                      color: 'white', cursor: 'pointer',
                    }}
                  >
                    Buy
                  </button>
                  <button
                    type="button"
                    onClick={() => setTradeModal({ row: r, side: 'sell', graduated })}
                    data-testid={`button-sell-${r.id}`}
                    style={{
                      flex: 1, fontSize: 12, fontWeight: 700,
                      padding: '8px 12px', borderRadius: 8,
                      border: 'none',
                      background: 'var(--red, #ef4444)',
                      color: 'white', cursor: 'pointer',
                    }}
                  >
                    Sell
                  </button>
                </div>
              )}
              {isRetryable && (
                <div style={{
                  padding: '0 14px 12px 14px',
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 11,
                }}>
                  <button
                    type="button"
                    onClick={() => handleRetry(r.id)}
                    disabled={isRetryPending}
                    data-testid={`button-retry-launch-${r.id}`}
                    style={{
                      fontSize: 11, fontWeight: 600,
                      padding: '6px 12px', borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: isRetryPending ? 'var(--bg-elevated)' : 'var(--bg-elevated)',
                      color: 'var(--text-primary)',
                      cursor: isRetryPending ? 'wait' : 'pointer',
                      opacity: isRetryPending ? 0.7 : 1,
                    }}
                  >
                    {isRetryPending ? 'Retrying…' : '↻ Retry'}
                  </button>
                  {retryError && (
                    <span
                      style={{ color: 'var(--red)', fontSize: 11 }}
                      data-testid={`text-retry-error-${r.id}`}
                    >
                      {retryError.slice(0, 80)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {tradeModal && (
        <FourMemeTradeModal
          row={tradeModal.row}
          side={tradeModal.side}
          graduated={tradeModal.graduated}
          onClose={() => setTradeModal(null)}
          onSuccess={() => { setTradeModal(null); refresh() }}
        />
      )}
    </>
  )
}

// ─── four.meme trade modal (in-app Buy/Sell on the bonding curve) ─────
// Minimal modal that wraps POST /api/fourmeme/buy and /api/fourmeme/sell
// (Module 1). Shows a quote refresh on input change so users see the
// price impact + min-out before they confirm. After a successful tx the
// modal closes and the parent refreshes the launches list so the row's
// live PnL re-fetches against the new on-chain state.
function FourMemeTradeModal(props: {
  row: LaunchRow
  side: 'buy' | 'sell'
  graduated: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const { row, side, graduated, onClose, onSuccess } = props
  const venueLabel = graduated ? 'PancakeSwap V2' : 'four.meme bonding curve'
  const [amount, setAmount] = useState('')
  // Slippage stored as a STRING so the user can type freely (incl. '.').
  // Parsed to a number on submit. Default 1% — user can adjust 0.1–20%.
  const [slippagePct, setSlippagePct] = useState('1')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [balance, setBalance] = useState<{ bnbBalance: string; tokenBalance: string } | null>(null)
  const [quote, setQuote] = useState<{
    estimatedAmountWei?: string
    estimatedCostWei?: string
    fundsWei?: string
  } | null>(null)
  const [quoteErr, setQuoteErr] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ txHash: string } | null>(null)

  // Fetch BNB + token balance once on open so the Max button works
  // instantly without a round-trip when the user taps it.
  useEffect(() => {
    if (!row.tokenAddress) return
    let cancelled = false
    apiFetch<any>(`/api/fourmeme/wallet-balance/${row.tokenAddress}`)
      .then((j) => { if (!cancelled && j?.ok) setBalance({ bnbBalance: j.bnbBalance, tokenBalance: j.tokenBalance }) })
      .catch(() => { /* silent — Max button just won't appear */ })
    return () => { cancelled = true }
  }, [row.tokenAddress])

  // Reserve a small BNB buffer for gas when the user taps Max on a buy.
  // Pancake swap on BSC costs ~0.0008 BNB; we keep 0.002 BNB to be safe.
  const GAS_RESERVE_BNB = 0.002
  function handleMax() {
    if (!balance) return
    if (side === 'buy') {
      const max = Math.max(0, Number(balance.bnbBalance) - GAS_RESERVE_BNB)
      setAmount(max > 0 ? max.toFixed(6) : '0')
    } else {
      // For sells we use the full token balance — gas is paid in BNB.
      setAmount(balance.tokenBalance)
    }
  }

  // Debounced quote fetch on amount change. We bail if the input isn't a
  // positive number so we don't ping the RPC for every keystroke.
  useEffect(() => {
    const v = Number(amount)
    if (!row.tokenAddress || !Number.isFinite(v) || v <= 0) {
      setQuote(null); setQuoteErr(null); return
    }
    let cancelled = false
    const t = setTimeout(() => {
      const params = new URLSearchParams()
      if (side === 'buy') params.set('bnb', amount)
      else params.set('sell', amount)
      apiFetch<any>(`/api/fourmeme/token/${row.tokenAddress}?${params}`)
        .then((j) => {
          if (cancelled) return
          if (j?.ok && side === 'buy' && j.buyQuote) setQuote(j.buyQuote)
          else if (j?.ok && side === 'sell' && j.sellQuote) setQuote(j.sellQuote)
          else { setQuote(null); setQuoteErr(j?.error ?? 'no quote') }
        })
        .catch((e) => { if (!cancelled) { setQuote(null); setQuoteErr(e?.message ?? 'quote failed') } })
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [amount, side, row.tokenAddress])

  // Validate slippage: must be a number in (0, 20]. Out-of-range values
  // are blocked at submit (server also enforces 0..2000 bps).
  function validatedSlippageBps(): number | null {
    const pct = Number(slippagePct)
    if (!Number.isFinite(pct) || pct <= 0 || pct > 20) return null
    return Math.round(pct * 100)
  }

  async function submit() {
    if (!row.tokenAddress) return
    const v = Number(amount)
    if (!Number.isFinite(v) || v <= 0) { setSubmitErr('Enter an amount'); return }
    const bps = validatedSlippageBps()
    if (bps == null) { setSubmitErr('Slippage must be between 0.1% and 20%'); return }
    setSubmitting(true); setSubmitErr(null)
    try {
      const path = side === 'buy' ? '/api/fourmeme/buy' : '/api/fourmeme/sell'
      const body = side === 'buy'
        ? { tokenAddress: row.tokenAddress, bnbAmount: amount, slippageBps: bps }
        : { tokenAddress: row.tokenAddress, tokenAmount: amount, slippageBps: bps }
      const j = await apiFetch<any>(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!j?.ok) { setSubmitErr(j?.error ?? 'trade failed'); return }
      setSuccess({ txHash: j.txHash })
      // Auto-close after 2.5s so the user sees the success toast.
      setTimeout(onSuccess, 2500)
    } catch (err: any) {
      setSubmitErr(err?.message ?? 'trade failed')
    } finally {
      setSubmitting(false)
    }
  }

  const fmt18 = (wei?: string) => {
    if (!wei) return '—'
    try {
      const n = Number(wei) / 1e18
      if (!Number.isFinite(n)) return '—'
      if (n >= 1) return n.toFixed(4)
      if (n >= 0.0001) return n.toFixed(6)
      return n.toExponential(3)
    } catch { return '—' }
  }
  const estTokens = side === 'buy' ? fmt18(quote?.estimatedAmountWei) : null
  const estBnb = side === 'sell' ? fmt18(quote?.fundsWei) : null
  const inputLabel = side === 'buy' ? 'BNB to spend' : `${row.tokenSymbol} to sell`
  const ctaColor = side === 'buy' ? 'var(--green, #10b981)' : 'var(--red, #ef4444)'
  const titleVerb = side === 'buy' ? 'Buy' : 'Sell'

  return (
    <div
      onClick={onClose}
      data-testid={`modal-trade-${row.id}`}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 520,
          background: 'var(--bg-card)', borderRadius: '16px 16px 0 0',
          padding: 20, color: 'var(--text-primary)',
          maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>
            {titleVerb} {row.tokenSymbol}
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="button-trade-close"
            style={{
              background: 'transparent', border: 'none', color: 'var(--text-secondary)',
              fontSize: 22, cursor: 'pointer', padding: 0, lineHeight: 1,
            }}
          >×</button>
        </div>

        {success ? (
          <div data-testid="text-trade-success" style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
              {titleVerb} sent
            </div>
            <a
              href={`https://bscscan.com/tx/${success.txHash}`}
              target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, color: 'var(--accent-primary, #6c5ce7)' }}
            >
              View on BscScan ↗
            </a>
          </div>
        ) : (
          <>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              marginBottom: 6,
            }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {inputLabel}
              </label>
              {balance && (
                <span
                  style={{ fontSize: 11, color: 'var(--text-muted)' }}
                  data-testid="text-trade-balance"
                >
                  Bal: {side === 'buy'
                    ? `${Number(balance.bnbBalance).toFixed(4)} BNB`
                    : `${Number(balance.tokenBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${row.tokenSymbol}`}
                </span>
              )}
            </div>
            <div style={{ position: 'relative', marginBottom: 12 }}>
              <input
                type="number"
                inputMode="decimal"
                autoFocus
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="input-trade-amount"
                style={{
                  width: '100%', padding: '12px 60px 12px 14px', fontSize: 18,
                  borderRadius: 10, border: '1px solid var(--border)',
                  background: 'var(--bg-elevated)', color: 'var(--text-primary)',
                  boxSizing: 'border-box',
                }}
              />
              {balance && (
                <button
                  type="button"
                  onClick={handleMax}
                  data-testid="button-trade-max"
                  style={{
                    position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    padding: '5px 10px', fontSize: 11, fontWeight: 700,
                    borderRadius: 6, border: '1px solid var(--border)',
                    background: 'var(--bg-card)', color: 'var(--accent-primary, #6c5ce7)',
                    cursor: 'pointer',
                  }}
                >MAX</button>
              )}
            </div>

            <div style={{
              padding: '12px 14px', borderRadius: 10,
              background: 'var(--bg-elevated)', marginBottom: 12,
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              {side === 'buy' ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span>Est. tokens</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }} data-testid="text-trade-est">
                    {estTokens ?? '—'} {row.tokenSymbol}
                  </span>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span>Est. BNB out</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }} data-testid="text-trade-est">
                    {estBnb ?? '—'} BNB
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span>Slippage tolerance</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }} data-testid="text-trade-slippage">
                  {slippagePct}%
                </span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                Routed via {venueLabel}.
                {graduated && side === 'sell' ? ' One-time token approval may be required on first sell.' : ''}
              </div>
              {quoteErr && (
                <div style={{ color: 'var(--red)', marginTop: 6 }} data-testid="text-quote-error">
                  {quoteErr.slice(0, 100)}
                </div>
              )}
            </div>

            {/* Advanced settings: slippage. Collapsed by default so the
                modal stays clean for the 90% of users who keep 1%. */}
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              data-testid="button-trade-advanced"
              style={{
                width: '100%', padding: '8px 12px',
                background: 'transparent', border: 'none',
                color: 'var(--text-secondary)', fontSize: 11,
                cursor: 'pointer', textAlign: 'left',
                marginBottom: showAdvanced ? 8 : 12,
              }}
            >
              {showAdvanced ? '▼' : '▶'} Advanced settings
            </button>
            {showAdvanced && (
              <div style={{
                padding: '12px 14px', borderRadius: 10,
                background: 'var(--bg-elevated)', marginBottom: 12,
              }}>
                <label style={{
                  fontSize: 12, color: 'var(--text-secondary)',
                  display: 'block', marginBottom: 6,
                }}>
                  Slippage tolerance
                </label>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {['0.5', '1', '3', '5'].map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setSlippagePct(p)}
                      data-testid={`button-slippage-${p}`}
                      style={{
                        flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 600,
                        borderRadius: 6,
                        border: slippagePct === p ? '1px solid var(--accent-primary, #6c5ce7)' : '1px solid var(--border)',
                        background: slippagePct === p ? 'rgba(108,92,231,0.12)' : 'var(--bg-card)',
                        color: slippagePct === p ? 'var(--accent-primary, #6c5ce7)' : 'var(--text-primary)',
                        cursor: 'pointer',
                      }}
                    >{p}%</button>
                  ))}
                </div>
                <div style={{ position: 'relative' }}>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min="0.1"
                    max="20"
                    placeholder="Custom"
                    value={slippagePct}
                    onChange={(e) => setSlippagePct(e.target.value)}
                    data-testid="input-trade-slippage"
                    style={{
                      width: '100%', padding: '10px 30px 10px 12px', fontSize: 13,
                      borderRadius: 8, border: '1px solid var(--border)',
                      background: 'var(--bg-card)', color: 'var(--text-primary)',
                      boxSizing: 'border-box',
                    }}
                  />
                  <span style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    fontSize: 13, color: 'var(--text-secondary)', pointerEvents: 'none',
                  }}>%</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                  Higher slippage = more likely to fill on volatile tokens, but you may receive less. Range: 0.1–20%.
                </div>
              </div>
            )}

            {submitErr && (
              <div
                data-testid="text-trade-error"
                style={{
                  padding: '10px 12px', borderRadius: 8,
                  background: 'rgba(239,68,68,0.12)', color: 'var(--red)',
                  fontSize: 12, marginBottom: 12,
                }}
              >
                {submitErr.slice(0, 200)}
              </div>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={submitting || !amount || Number(amount) <= 0}
              data-testid="button-trade-submit"
              style={{
                width: '100%', padding: '14px', borderRadius: 10,
                border: 'none', background: ctaColor, color: 'white',
                fontSize: 15, fontWeight: 700,
                cursor: submitting ? 'wait' : 'pointer',
                opacity: submitting || !amount || Number(amount) <= 0 ? 0.6 : 1,
              }}
            >
              {submitting ? 'Submitting…' : `${titleVerb} ${row.tokenSymbol}`}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

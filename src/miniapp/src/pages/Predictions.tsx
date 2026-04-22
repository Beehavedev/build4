import { useState, useEffect, useRef } from 'react'

interface AgentVerdict {
  name: string
  model: string | null
  verdict: 'YES' | 'NO'
  probability: number
  reasoning: string
  latencyMs: number
  tokens: number
  inputTokens: number
  outputTokens: number
  matchesConsensus: boolean
  error: string | null
}

interface SwarmCard {
  marketTitle: string
  marketAddress: string
  outcomeLabel: string
  consensus: 'YES' | 'NO'
  impliedProbability: number
  confidenceScore: number
  agentCount: number
  avgLatencyMs: number
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  usdtIn: number
  reasoning: string
  txHash: string | null
  openedAt: string
  agents: AgentVerdict[]
}

interface PositionRow {
  marketTitle: string
  marketAddress: string
  tokenId: number
  outcome: string
  entryPrice: number
  currentPrice: number
  pnlUsdt: number
  usdtIn: number
  openedAt: string
  txHash: string | null
  status: 'open' | 'resolved' | 'claimable' | 'claimed'
}

interface ScannerRow {
  marketTitle: string
  marketAddress: string
  category: string
  endDate: string
  elapsedPct: number
}

interface MarketDetailOutcome {
  tokenId: number
  label: string
  priceFloat: number
  impliedProbability: number
  isWinner: boolean
}

interface MarketDetailResponse {
  market: { address: string; question: string; status: string; endDate: string; category: string }
  outcomes: MarketDetailOutcome[]
  cached?: boolean
}

type MarketDetailState =
  | { state: 'loading' }
  | { state: 'ready'; data: MarketDetailResponse }
  | { state: 'error'; message: string }

interface PredictionsResponse {
  swarm: SwarmCard | null
  positions: PositionRow[]
  scanner: ScannerRow[]
  meta: {
    apiStatus: 'live' | 'stale' | 'down'
    lastFetchedAt: string
    marketsTracked: number
    responseTimeMs: number
  }
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#a855f7',
  claude: '#a855f7',
  grok: '#3b82f6',
  xai: '#3b82f6',
  hyperbolic: '#10b981',
  llama: '#10b981',
  akash: '#f59e0b',
  openai: '#06b6d4',
}

function providerColor(name: string): string {
  const key = name.toLowerCase()
  for (const k of Object.keys(PROVIDER_COLORS)) {
    if (key.includes(k)) return PROVIDER_COLORS[k]
  }
  return '#7c3aed'
}

function shortHash(h: string | null): string {
  if (!h) return '—'
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h
}

function relativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (diffSec < 60) return `${diffSec} seconds ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h ago`
  return `${Math.floor(diffSec / 86400)} d ago`
}

function expiryCountdown(iso: string): { label: string; color: string } {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return { label: 'expired', color: '#64748b' }
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  let color = '#94a3b8'
  if (ms < 86400000) color = '#ef4444'
  else if (ms < 7 * 86400000) color = '#f59e0b'
  if (days > 0) return { label: `${days}d ${hours}h`, color }
  return { label: `${hours}h`, color }
}

function CrosshairIcon({ active }: { active: boolean }) {
  const c = active ? '#7c3aed' : '#64748b'
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <circle cx="12" cy="12" r="2" fill={c} />
    </svg>
  )
}

function StatusDot({ status }: { status: 'live' | 'stale' | 'down' }) {
  const color = status === 'live' ? '#10b981' : status === 'stale' ? '#f59e0b' : '#ef4444'
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, marginRight: 6,
      boxShadow: status === 'live' ? `0 0 8px ${color}` : 'none',
      animation: status === 'live' ? 'predPulse 1.6s ease-in-out infinite' : 'none',
    }} />
  )
}

function Skeleton({ height = 14, width = '100%', mb = 6 }: { height?: number; width?: string | number; mb?: number }) {
  return (
    <div style={{
      height, width, marginBottom: mb, borderRadius: 4,
      background: 'linear-gradient(90deg, #1a1a26 0%, #22222e 50%, #1a1a26 100%)',
      backgroundSize: '200% 100%',
      animation: 'predShimmer 1.4s ease-in-out infinite',
    }} />
  )
}

const STYLE = `
@keyframes predPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
@keyframes predShimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
`

export default function Predictions() {
  const [data, setData] = useState<PredictionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [, setNowTick] = useState(0)
  const inFlight = useRef(false)
  // On-demand market detail (only fetched when a scanner row is tapped).
  const [expandedMarket, setExpandedMarket] = useState<string | null>(null)
  const [detailCache, setDetailCache] = useState<Record<string, MarketDetailState>>({})

  // Live-vs-paper opt-in. `null` while we don't yet know (initial fetch
  // pending OR the user opened the mini-app outside of Telegram and the
  // /api/me endpoint 401'd) — in that case we hide the toggle entirely
  // rather than showing a misleading default.
  const [liveOptIn, setLiveOptIn] = useState<boolean | null>(null)
  const [modeBusy, setModeBusy] = useState(false)
  async function loadMode() {
    try {
      const r = await fetch('/api/me/predictions-mode')
      if (!r.ok) { setLiveOptIn(null); return }
      const j = await r.json()
      setLiveOptIn(typeof j.liveOptIn === 'boolean' ? j.liveOptIn : null)
    } catch { setLiveOptIn(null) }
  }
  async function toggleMode(next: boolean) {
    setModeBusy(true)
    try {
      const r = await fetch('/api/me/predictions-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const j = await r.json()
      if (j?.ok) setLiveOptIn(j.liveOptIn === true)
    } finally { setModeBusy(false) }
  }

  async function onToggleMarket(address: string) {
    if (expandedMarket === address) {
      setExpandedMarket(null)
      return
    }
    setExpandedMarket(address)
    // Re-fetch only if we don't already have a successful result.
    const existing = detailCache[address]
    if (existing && existing.state === 'ready') return
    setDetailCache((c) => ({ ...c, [address]: { state: 'loading' } }))
    try {
      const res = await fetch(`/api/predictions/market/${address}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: MarketDetailResponse = await res.json()
      setDetailCache((c) => ({ ...c, [address]: { state: 'ready', data: json } }))
    } catch (e) {
      setDetailCache((c) => ({
        ...c,
        [address]: { state: 'error', message: (e as Error).message },
      }))
    }
  }

  async function load(silent = false) {
    if (inFlight.current) return
    inFlight.current = true
    if (!silent) setRefreshing(true)
    try {
      const res = await fetch('/api/predictions/latest')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: PredictionsResponse = await res.json()
      setData(json)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
      setRefreshing(false)
      inFlight.current = false
    }
  }

  useEffect(() => {
    load()
    loadMode()
    const poll = setInterval(() => load(true), 30_000)
    const tick = setInterval(() => setNowTick((n) => n + 1), 1000)
    return () => { clearInterval(poll); clearInterval(tick) }
  }, [])

  const apiStatus = error ? 'down' : data?.meta.apiStatus ?? 'live'
  const lastFetched = data?.meta.lastFetchedAt
  const totalPnl = (data?.positions ?? []).reduce((s, p) => s + p.pnlUsdt, 0)
  const openPositions = (data?.positions ?? []).filter((p) => p.status === 'open' || p.status === 'claimable')

  return (
    <div style={{ paddingTop: 16, paddingBottom: 8 }}>
      <style>{STYLE}</style>

      {/* ── Header bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14, padding: '10px 12px', borderRadius: 8,
        background: '#0f0f17', border: '1px solid #1e1e2e',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.3 }}>42.space</span>
          <span style={{ fontSize: 10, color: '#64748b' }}>×</span>
          <span style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
            <StatusDot status={apiStatus as 'live' | 'stale' | 'down'} />
            {apiStatus === 'live' ? 'LIVE' : apiStatus === 'stale' ? 'STALE' : 'API DOWN'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontSize: 10, color: '#64748b', fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          }}>
            {lastFetched ? `Updated ${relativeTime(lastFetched)}` : 'Never'}
          </span>
          <button
            onClick={() => load(false)}
            disabled={refreshing}
            data-testid="button-predictions-refresh"
            style={{
              padding: '4px 10px', borderRadius: 6, fontSize: 11,
              background: refreshing ? '#1e1e2e' : '#7c3aed',
              border: '1px solid #7c3aed', color: 'white',
              cursor: refreshing ? 'wait' : 'pointer',
            }}>
            {refreshing ? '…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Trading-mode toggle ──
          Mirrors the Telegram /predictions command's live/paper buttons so
          users can flip the User.fortyTwoLiveTrade flag without leaving
          the mini-app. Hidden when liveOptIn === null (the /api/me endpoint
          401'd — almost certainly the user opened the mini-app outside of
          Telegram, in which case we can't authenticate them anyway). */}
      {liveOptIn !== null && (
        <div data-testid="card-trading-mode" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 14, padding: '10px 12px', borderRadius: 8,
          background: liveOptIn ? '#10b98110' : '#0f0f17',
          border: `1px solid ${liveOptIn ? '#10b98144' : '#1e1e2e'}`,
          gap: 10,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600,
                          color: liveOptIn ? '#10b981' : '#e2e8f0' }}
                 data-testid="text-mode-status">
              {liveOptIn ? '🔴 LIVE mode — real USDT' : '📝 Paper mode — simulated'}
            </div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
              {liveOptIn
                ? 'Trades execute on-chain on BSC. Caps: ≤$2/agent, ≤$25/manual.'
                : 'No on-chain transactions. Positions tracked for paper PnL only.'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => toggleMode(!liveOptIn)}
            disabled={modeBusy}
            data-testid="button-toggle-mode"
            style={{
              padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
              background: modeBusy ? '#1e1e2e' : (liveOptIn ? '#1e1e2e' : '#10b981'),
              border: `1px solid ${liveOptIn ? '#1e1e2e' : '#10b981'}`,
              color: liveOptIn ? '#94a3b8' : 'white',
              cursor: modeBusy ? 'wait' : 'pointer',
              whiteSpace: 'nowrap',
            }}>
            {modeBusy ? '…' : (liveOptIn ? 'Switch to paper' : 'Enable LIVE')}
          </button>
        </div>
      )}

      {/* ── Section 1: Swarm Consensus ── */}
      <div style={{ marginBottom: 16 }}>
        {loading && !data ? (
          <div className="card">
            <Skeleton width="70%" height={16} />
            <Skeleton width="40%" height={12} />
            <Skeleton width="100%" height={48} mb={10} />
            <Skeleton width="100%" height={6} />
          </div>
        ) : !data?.swarm ? (
          <EmptyState
            title="No live swarm-driven trade yet"
            body="Once a swarm-enabled agent opens an on-chain position on a 42.space market, the consensus + each model's verdict will appear here, with the matching BscScan transaction."
            testId="empty-swarm"
          />
        ) : (
          <SwarmHero swarm={data.swarm} />
        )}
      </div>

      {/* ── Section 2: Agent Verdicts ── */}
      {data?.swarm && data.swarm.agents.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SectionTitle
            title="Agent Verdicts"
            right={`${data.swarm.agents.filter((a) => !a.error).length}/${data.swarm.agents.length} responded`}
          />
          {data.swarm.agents.map((a) => (
            <AgentCard key={a.name} agent={a} />
          ))}
        </div>
      )}

      {/* ── Section 3: Open Positions ── */}
      <div style={{ marginBottom: 16 }}>
        <SectionTitle
          title="Open Positions"
          right={
            <span style={{ color: totalPnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </span>
          }
        />
        {loading && !data ? (
          <div className="card"><Skeleton /><Skeleton /><Skeleton /></div>
        ) : openPositions.length === 0 ? (
          <EmptyState
            title="No open positions"
            body="The swarm is watching 42.space markets for opportunities. Positions appear here once an agent opens one on-chain."
            testId="empty-positions"
          />
        ) : (
          <PositionsTable rows={data?.positions ?? []} />
        )}
      </div>

      {/* ── Section 4: Market Scanner ── */}
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => setScannerOpen((v) => !v)}
          data-testid="button-scanner-toggle"
          style={{
            width: '100%', padding: '10px 12px', borderRadius: 8,
            background: '#0f0f17', border: '1px solid #1e1e2e',
            color: '#e2e8f0', fontSize: 13, fontWeight: 600, textAlign: 'left',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            cursor: 'pointer',
          }}>
          <span>42.space Market Scanner — {data?.meta.marketsTracked ?? 0} markets tracked</span>
          <span style={{ color: '#64748b', fontSize: 16 }}>{scannerOpen ? '▾' : '▸'}</span>
        </button>
        {scannerOpen && (
          <div className="card" style={{ marginTop: 8, padding: 0, overflow: 'hidden' }}>
            {(data?.scanner ?? []).length === 0 ? (
              <div style={{ padding: 16, fontSize: 12, color: '#64748b' }}>
                No live markets returned by the 42.space API.
              </div>
            ) : (
              data?.scanner.map((m) => (
                <ScannerRowItem
                  key={m.marketAddress}
                  row={m}
                  expanded={expandedMarket === m.marketAddress}
                  detail={detailCache[m.marketAddress]}
                  onToggle={() => onToggleMarket(m.marketAddress)}
                  onTraded={() => load(true)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionTitle({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      marginBottom: 8, padding: '0 4px',
    }}>
      <div style={{ fontSize: 11, color: '#94a3b8', letterSpacing: 0.6, textTransform: 'uppercase', fontWeight: 600 }}>
        {title}
      </div>
      <div style={{ fontSize: 11, color: '#64748b' }}>{right}</div>
    </div>
  )
}

function EmptyState({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div className="card" data-testid={testId} style={{ textAlign: 'center', padding: '20px 16px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>{body}</div>
    </div>
  )
}

function CategoryPill({ cat }: { cat: string }) {
  const lower = cat.toLowerCase()
  let bg = '#7c3aed22', fg = '#a855f7'
  if (lower.includes('crypto')) { bg = '#f59e0b22'; fg = '#f59e0b' }
  else if (lower.includes('ai')) { bg = '#3b82f622'; fg = '#3b82f6' }
  else if (lower.includes('geo') || lower.includes('politic')) { bg = '#10b98122'; fg = '#10b981' }
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 4,
      background: bg, color: fg, fontSize: 9, fontWeight: 600,
      textTransform: 'uppercase', letterSpacing: 0.3,
    }}>{cat}</span>
  )
}

function ScannerRowItem({
  row, expanded, detail, onToggle, onTraded,
}: {
  row: ScannerRow
  expanded: boolean
  detail: MarketDetailState | undefined
  onToggle: () => void
  onTraded: () => void
}) {
  const cd = expiryCountdown(row.endDate)
  return (
    <div data-testid={`row-scanner-${row.marketAddress}`}
         style={{ borderBottom: '1px solid #1e1e2e' }}>
      <button
        type="button"
        onClick={onToggle}
        data-testid={`button-scanner-${row.marketAddress}`}
        style={{
          width: '100%', padding: '10px 12px',
          background: 'transparent', border: 'none', textAlign: 'left',
          display: 'flex', justifyContent: 'space-between', gap: 10,
          alignItems: 'center', cursor: 'pointer', color: 'inherit',
        }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.marketTitle}
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
            <CategoryPill cat={row.category} /> · {(row.elapsedPct * 100).toFixed(0)}% elapsed
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: cd.color,
                         fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
            {cd.label}
          </span>
          <span style={{ color: '#64748b', fontSize: 14 }}>{expanded ? '▾' : '▸'}</span>
        </div>
      </button>
      {expanded && (
        <div data-testid={`detail-scanner-${row.marketAddress}`}
             style={{ padding: '0 12px 12px 12px' }}>
          {!detail || detail.state === 'loading' ? (
            <div style={{ fontSize: 11, color: '#64748b', padding: '6px 0' }}>
              Reading bonding curve…
            </div>
          ) : detail.state === 'error' ? (
            <div style={{ fontSize: 11, color: '#ef4444', padding: '6px 0' }}>
              On-chain read failed: {detail.message}
            </div>
          ) : (
            <>
              <OutcomeBars outcomes={detail.data.outcomes} />
              <TradeForm
                marketAddress={row.marketAddress}
                outcomes={detail.data.outcomes}
                onTraded={onTraded}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface TradeResult {
  ok: boolean
  paperTrade?: boolean
  txHash?: string | null
  outcomeLabel?: string
  usdtIn?: number
  entryPrice?: number
  positionId?: string
  reason?: string
  error?: string
}

function TradeForm({
  marketAddress, outcomes, onTraded,
}: {
  marketAddress: string
  outcomes: MarketDetailOutcome[]
  onTraded: () => void
}) {
  // Pre-select the leading outcome (highest implied probability) so a user
  // who just taps "Place trade" without changing anything gets the most-
  // liquid side rather than a random tokenId.
  const sorted = [...outcomes].sort((a, b) => b.impliedProbability - a.impliedProbability)
  const tradable = sorted.filter((o) => !o.isWinner)
  const [tokenId, setTokenId] = useState<number | null>(tradable[0]?.tokenId ?? null)
  const [amount, setAmount] = useState<string>('1.00')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<TradeResult | null>(null)

  // Resolved markets show only the winner — no trade possible. The scanner
  // is meant for live markets but defend in case a stale row leaks through.
  if (tradable.length === 0) {
    return (
      <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6,
                    background: '#0a0a12', border: '1px solid #1e1e2e',
                    fontSize: 11, color: '#64748b' }}>
        Market resolved — no trades available.
      </div>
    )
  }

  const selected = tradable.find((o) => o.tokenId === tokenId) ?? tradable[0]
  const amountNum = Number(amount)
  const amountValid = Number.isFinite(amountNum) && amountNum >= 0.5 && amountNum <= 25
  const expectedTokens = amountValid ? amountNum / Math.max(0.001, selected.impliedProbability) : 0

  async function handleSubmit() {
    if (!amountValid || !selected) return
    setSubmitting(true)
    setResult(null)
    try {
      const res = await fetch('/api/predictions/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketAddress,
          tokenId: selected.tokenId,
          usdtAmount: amountNum,
        }),
      })
      const json: TradeResult = await res.json()
      setResult(json)
      if (json.ok) onTraded()
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div data-testid={`trade-form-${marketAddress}`}
         style={{ marginTop: 12, padding: 10, borderRadius: 6,
                  background: '#0a0a12', border: '1px solid #1e1e2e' }}>
      <div style={{ fontSize: 10, color: '#64748b', letterSpacing: 0.4,
                    marginBottom: 8, textTransform: 'uppercase' }}>
        Trade this market
      </div>

      {/* Outcome selector — render as compact chips, one per outcome. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {tradable.map((o) => {
          const active = o.tokenId === selected.tokenId
          const pct = (o.impliedProbability * 100).toFixed(0)
          return (
            <button
              key={o.tokenId}
              type="button"
              onClick={() => { setTokenId(o.tokenId); setResult(null) }}
              data-testid={`button-outcome-${marketAddress}-${o.tokenId}`}
              style={{
                padding: '5px 9px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                background: active ? '#7c3aed' : '#12121a',
                border: `1px solid ${active ? '#7c3aed' : '#1e1e2e'}`,
                color: active ? 'white' : '#94a3b8',
                cursor: 'pointer',
              }}>
              {o.label} <span style={{ opacity: 0.7, marginLeft: 3 }}>{pct}%</span>
            </button>
          )
        })}
      </div>

      {/* Amount input + Place trade button on one row. */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <span style={{ position: 'absolute', left: 9, top: '50%',
                         transform: 'translateY(-50%)',
                         fontSize: 12, color: '#64748b' }}>$</span>
          <input
            type="number"
            inputMode="decimal"
            min="0.5"
            max="25"
            step="0.5"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setResult(null) }}
            data-testid={`input-amount-${marketAddress}`}
            style={{
              width: '100%', padding: '7px 9px 7px 18px', borderRadius: 4,
              background: '#12121a', border: '1px solid #1e1e2e',
              color: '#e2e8f0', fontSize: 13,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            }}
          />
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!amountValid || submitting}
          data-testid={`button-place-trade-${marketAddress}`}
          style={{
            padding: '7px 14px', borderRadius: 4, fontSize: 12, fontWeight: 600,
            background: amountValid && !submitting ? '#10b981' : '#1e1e2e',
            border: `1px solid ${amountValid && !submitting ? '#10b981' : '#1e1e2e'}`,
            color: 'white',
            cursor: amountValid && !submitting ? 'pointer' : 'not-allowed',
            whiteSpace: 'nowrap',
          }}>
          {submitting ? 'Placing…' : `Place trade`}
        </button>
      </div>

      {/* Helper hint: shows what the user is about to commit to before tap. */}
      <div style={{ marginTop: 6, fontSize: 10, color: '#64748b',
                    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
        {amountValid
          ? `~${expectedTokens.toFixed(2)} tokens of "${selected.label}" @ ${(selected.impliedProbability * 100).toFixed(1)}%`
          : 'Amount must be $0.50–$25'}
      </div>

      {/* Result panel: BscScan link on success, plain reason on failure.
          Lives inside the row so users see outcome without leaving context. */}
      {result && (
        <div data-testid={`trade-result-${marketAddress}`}
             style={{ marginTop: 10, padding: '8px 10px', borderRadius: 4,
                      background: result.ok ? '#10b98115' : '#ef444415',
                      border: `1px solid ${result.ok ? '#10b98144' : '#ef444444'}`,
                      fontSize: 11, color: result.ok ? '#10b981' : '#ef4444' }}>
          {result.ok ? (
            <>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>
                {result.paperTrade ? 'Paper trade recorded' : 'Trade placed on-chain'}
                {' · '}${result.usdtIn?.toFixed(2)} on {result.outcomeLabel}
              </div>
              {!result.paperTrade && result.txHash && (
                <a
                  href={`https://bscscan.com/tx/${result.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`link-bscscan-${marketAddress}`}
                  style={{ color: '#10b981', textDecoration: 'underline',
                           fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
                  View on BscScan
                </a>
              )}
              {result.paperTrade && (
                <div style={{ color: '#94a3b8', fontSize: 10 }}>
                  Toggle live mode in the Telegram /predictions command to use real USDT.
                </div>
              )}
            </>
          ) : (
            <div>{result.reason ?? result.error ?? 'Trade failed'}</div>
          )}
        </div>
      )}
    </div>
  )
}

function OutcomeBars({ outcomes }: { outcomes: MarketDetailOutcome[] }) {
  if (outcomes.length === 0) {
    return <div style={{ fontSize: 11, color: '#64748b' }}>No outcomes returned.</div>
  }
  // Sort by probability descending so the leading outcome is on top.
  const sorted = [...outcomes].sort((a, b) => b.impliedProbability - a.impliedProbability)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
      {sorted.map((o) => {
        const pct = o.impliedProbability * 100
        const barColor = o.isWinner ? '#10b981'
          : pct >= 60 ? '#10b981'
          : pct >= 40 ? '#3b82f6'
          : pct >= 20 ? '#f59e0b' : '#ef4444'
        return (
          <div key={o.tokenId} data-testid={`outcome-${o.tokenId}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
                          fontSize: 11, marginBottom: 3 }}>
              <span style={{ color: '#e2e8f0', fontWeight: 500 }}>
                {o.label}{o.isWinner && (
                  <span style={{ marginLeft: 6, fontSize: 9, color: '#10b981',
                                 background: '#10b98122', padding: '1px 5px', borderRadius: 3,
                                 textTransform: 'uppercase', letterSpacing: 0.3 }}>
                    Won
                  </span>
                )}
              </span>
              <span style={{ color: '#94a3b8',
                             fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
                {pct.toFixed(1)}% · ${o.priceFloat.toFixed(3)}
              </span>
            </div>
            <div style={{ height: 4, background: '#1e1e2e', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                width: `${Math.max(2, Math.min(100, pct))}%`,
                height: '100%', background: barColor, transition: 'width 200ms',
              }} />
            </div>
          </div>
        )
      })}
      <div style={{ fontSize: 9, color: '#475569', marginTop: 2,
                    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
        Live from on-chain bonding curve
      </div>
    </div>
  )
}

function SwarmHero({ swarm }: { swarm: SwarmCard }) {
  const consensusColor = swarm.consensus === 'YES' ? '#10b981' : '#ef4444'
  const pct = (swarm.impliedProbability * 100).toFixed(1)
  const confColor =
    swarm.confidenceScore > 0.6 ? '#10b981'
    : swarm.confidenceScore < 0.4 ? '#ef4444' : '#3b82f6'

  return (
    <div className="card" data-testid="card-swarm-hero" style={{
      borderLeft: `3px solid ${consensusColor}`,
      background: 'linear-gradient(135deg, #12121a 0%, #0f0f17 100%)',
    }}>
      {/* Title row */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: '#e2e8f0', lineHeight: 1.4 }}
             data-testid="text-swarm-market">
          {swarm.marketTitle}
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
          Outcome: <span style={{ color: '#94a3b8' }}>{swarm.outcomeLabel}</span>
          {' · '}Allocation: <span style={{ color: '#94a3b8' }}>${swarm.usdtIn.toFixed(2)} USDT</span>
        </div>
      </div>

      {/* Consensus + stats */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
        padding: '12px 0', borderTop: '1px solid #1e1e2e', borderBottom: '1px solid #1e1e2e',
      }}>
        <div>
          <div style={{ fontSize: 10, color: '#64748b', letterSpacing: 0.4, marginBottom: 4 }}>CONSENSUS</div>
          <div style={{ fontSize: 36, fontWeight: 800, color: consensusColor, lineHeight: 1 }}
               data-testid="text-swarm-consensus">
            {swarm.consensus}
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: '#94a3b8', marginTop: 2 }}>
            {pct}%
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 4 }}>
          <StatLine label="Agents" value={`${swarm.agentCount}`} />
          <StatLine label="Avg latency" value={`${(swarm.avgLatencyMs / 1000).toFixed(2)}s`} />
          <StatLine
            label="Tokens (in/out)"
            value={`${(swarm.totalInputTokens ?? 0).toLocaleString()} / ${(swarm.totalOutputTokens ?? swarm.totalTokens).toLocaleString()}`}
          />
        </div>
      </div>

      {/* Confidence bar */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b', marginBottom: 4 }}>
          <span>SWARM AGREEMENT</span>
          <span>{(swarm.confidenceScore * 100).toFixed(0)}%</span>
        </div>
        <div style={{ height: 4, background: '#1e1e2e', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            width: `${swarm.confidenceScore * 100}%`, height: '100%', background: confColor,
            transition: 'width 0.3s ease',
          }} />
        </div>
      </div>

      {/* Per-agent badges */}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        {swarm.agents.map((a) => (
          <div key={a.name} title={a.name} style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '3px 7px', borderRadius: 4,
            background: a.matchesConsensus ? '#10b98115' : '#f59e0b15',
            border: `1px solid ${a.matchesConsensus ? '#10b98144' : '#f59e0b44'}`,
            fontSize: 10, fontWeight: 600, color: '#e2e8f0',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: providerColor(a.name),
            }} />
            <span>{a.name}</span>
            <span style={{ color: a.matchesConsensus ? '#10b981' : '#f59e0b' }}>
              {a.matchesConsensus ? '✓' : '✗'}
            </span>
          </div>
        ))}
      </div>

      {/* Tx link */}
      {swarm.txHash && (
        <div style={{
          marginTop: 12, paddingTop: 10, borderTop: '1px solid #1e1e2e',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        }}>
          <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
            tx {shortHash(swarm.txHash)}
          </div>
          <a
            href={`https://bscscan.com/tx/${swarm.txHash}`}
            target="_blank" rel="noopener noreferrer"
            data-testid="link-bscscan-tx"
            style={{
              fontSize: 10, color: '#7c3aed', textDecoration: 'none',
              padding: '3px 8px', borderRadius: 4,
              border: '1px solid #7c3aed44', background: '#7c3aed15',
            }}>
            BscScan ↗
          </a>
        </div>
      )}
    </div>
  )
}

function StatLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11 }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ color: '#e2e8f0', fontWeight: 600,
                     fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>{value}</span>
    </div>
  )
}

function AgentCard({ agent }: { agent: AgentVerdict }) {
  const verdictColor = agent.verdict === 'YES' ? '#10b981' : '#ef4444'
  const borderLeft = agent.error ? '#64748b' : agent.matchesConsensus ? '#10b981' : '#f59e0b'
  const tint = agent.error ? '#0f0f17' : agent.matchesConsensus ? '#12121a' : '#1a1408'
  return (
    <div data-testid={`card-agent-${agent.name}`} style={{
      marginBottom: 8, padding: 12, borderRadius: 8,
      background: tint,
      border: '1px solid #1e1e2e',
      borderLeft: `3px solid ${borderLeft}`,
      display: 'flex', gap: 10, alignItems: 'flex-start',
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
        background: providerColor(agent.name),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, fontWeight: 700, color: 'white',
      }}>
        {agent.name.charAt(0).toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{agent.name}</div>
            {agent.model && (
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{agent.model}</div>
            )}
          </div>
          <div style={{
            padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
            background: `${verdictColor}22`, color: verdictColor, flexShrink: 0,
          }}>
            {agent.verdict} {(agent.probability * 100).toFixed(0)}%
          </div>
        </div>
        {agent.error ? (
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
            ⚠ No response: {agent.error}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6, lineHeight: 1.5 }}>
            {agent.reasoning || <span style={{ color: '#64748b', fontStyle: 'italic' }}>No reasoning recorded.</span>}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, fontSize: 10, color: '#64748b',
                      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
          <span>{agent.latencyMs}ms</span>
          <span>·</span>
          <span data-testid={`text-agent-tokens-${agent.name}`}>
            <span style={{ color: '#7dd3fc' }}>{(agent.inputTokens ?? 0).toLocaleString()} in</span>
            {' / '}
            <span style={{ color: '#fda4af' }}>
              {(agent.outputTokens ?? agent.tokens ?? 0).toLocaleString()} out
            </span>
            {' tok'}
          </span>
        </div>
      </div>
    </div>
  )
}

function PositionsTable({ rows }: { rows: PositionRow[] }) {
  const totalIn = rows.reduce((s, r) => s + r.usdtIn, 0)
  const totalCurrent = rows.reduce((s, r) => s + r.usdtIn + r.pnlUsdt, 0)
  const totalPnl = totalCurrent - totalIn
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: '#0a0a12' }}>
              {['Market', 'Outcome', 'Entry', 'Current', 'PnL', 'Status'].map((h) => (
                <th key={h} style={{
                  padding: '8px 10px', textAlign: 'left', color: '#64748b',
                  fontWeight: 600, letterSpacing: 0.3, fontSize: 10, textTransform: 'uppercase',
                  borderBottom: '1px solid #1e1e2e', whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pnlColor = r.pnlUsdt >= 0 ? '#10b981' : '#ef4444'
              const statusColor =
                r.status === 'open' ? '#3b82f6' :
                r.status === 'claimable' ? '#10b981' :
                r.status === 'claimed' ? '#64748b' : '#94a3b8'
              const titleShort = r.marketTitle.length > 28 ? r.marketTitle.slice(0, 26) + '…' : r.marketTitle
              return (
                <tr key={`${r.marketAddress}-${r.tokenId}`}
                    data-testid={`row-position-${r.marketAddress}-${r.tokenId}`}
                    style={{ borderBottom: '1px solid #1e1e2e' }}>
                  <td style={{ padding: '8px 10px', color: '#e2e8f0', maxWidth: 140 }}>
                    {titleShort}
                  </td>
                  <td style={{ padding: '8px 10px', color: '#94a3b8', whiteSpace: 'nowrap' }}>{r.outcome}</td>
                  <td style={{ padding: '8px 10px', color: '#94a3b8',
                               fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                    ${r.entryPrice.toFixed(2)}
                  </td>
                  <td style={{ padding: '8px 10px', color: '#94a3b8',
                               fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                    ${r.currentPrice.toFixed(2)}
                  </td>
                  <td style={{ padding: '8px 10px', color: pnlColor, fontWeight: 700,
                               fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                    {r.pnlUsdt >= 0 ? '+' : ''}${r.pnlUsdt.toFixed(2)}
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <span style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700,
                      background: `${statusColor}22`, color: statusColor,
                      textTransform: 'uppercase', letterSpacing: 0.3,
                    }}>{r.status}</span>
                  </td>
                </tr>
              )
            })}
            <tr style={{ background: '#0a0a12' }}>
              <td style={{ padding: '8px 10px', color: '#64748b', fontSize: 10, fontWeight: 600 }} colSpan={2}>TOTALS</td>
              <td style={{ padding: '8px 10px', color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>${totalIn.toFixed(2)}</td>
              <td style={{ padding: '8px 10px', color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>${totalCurrent.toFixed(2)}</td>
              <td style={{ padding: '8px 10px', color: totalPnl >= 0 ? '#10b981' : '#ef4444',
                           fontWeight: 700, fontFamily: 'ui-monospace, monospace' }}>
                {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

export { CrosshairIcon }

import { useState, useEffect } from 'react'
import { apiFetch, deleteAgent, getMyFeed, updateAgentSettings, type FeedEntry } from '../api'
import { TradingChart } from '../components/TradingChart'
import { MarketTicker } from '../components/MarketTicker'

// One open position attributed to an agent. `markPrice` and
// `unrealizedPnl` are null when the live Aster overlay couldn't be
// fetched (e.g. user not onboarded yet, or the API call failed).
// `liveOnVenue` flags rows the venue actually still has open — false
// means the DB row is stale (closed on the venue, not yet reconciled
// in our DB) and the UI dims it accordingly.
interface AgentPositionRow {
  id: string
  pair: string
  side: 'LONG' | 'SHORT'
  size: number
  leverage: number
  entryPrice: number
  exchange: string
  openedAt: string
  markPrice: number | null
  unrealizedPnl: number | null
  liveOnVenue: boolean
}

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  return n.toFixed(6)
}

// Self-contained per-agent positions panel.
//
// Polls every 3 s while mounted so PnL ticks live alongside the Trade
// page (which polls 1s mark + 2s positions). Stale DB rows that aren't
// present on the venue are auto-reconciled server-side now, so anything
// shown here IS truly open on Aster.
//
// Each row gets a manual Close button — same UX as the Trade page so a
// user watching their agent can intervene without bouncing tabs.
function AgentPositions({ agentId }: { agentId: string }) {
  const [positions, setPositions] = useState<AgentPositionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [closingKey, setClosingKey] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = async () => {
    try {
      const res = await apiFetch<{ positions: AgentPositionRow[] }>(
        `/api/agents/${agentId}/positions`,
      )
      setPositions(res.positions)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? 'load failed')
    }
  }

  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (!alive) return
      await load()
    }
    tick()
    // 1s real-time refresh — user wants every venue surface to feel as
    // live as the Trade page mark. Aster's positionRisk endpoint is
    // cheap; one user = one client, so polling load is bounded.
    const t = setInterval(tick, 1000)
    return () => { alive = false; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  const onClose = async (p: AgentPositionRow) => {
    const key = `${p.pair}|${p.side}`
    setClosingKey(key)
    setActionMsg(null)
    try {
      await apiFetch('/api/aster/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair: p.pair, side: p.side, size: p.size }),
      })
      setActionMsg({ kind: 'ok', text: `Closed ${p.pair} ${p.side}` })
      // Optimistically drop the row so the user sees the action take
      // effect before the next poll tick lands.
      setPositions((prev) => prev?.filter((x) => x.id !== p.id) ?? null)
      // And kick a refresh right away so any other panel state catches up.
      load()
    } catch (e: any) {
      setActionMsg({ kind: 'err', text: e?.message ?? 'Close failed' })
    } finally {
      setClosingKey(null)
    }
  }

  if (positions == null && !error) {
    return (
      <div style={{ marginTop: 12, fontSize: 11, color: '#64748b' }}>
        Loading positions…
      </div>
    )
  }
  if (error) {
    return (
      <div
        style={{ marginTop: 12, fontSize: 11, color: '#ef4444' }}
        data-testid={`text-agent-positions-error-${agentId}`}
      >
        Couldn't load positions: {error}
      </div>
    )
  }
  if (!positions || positions.length === 0) {
    return (
      <div
        style={{ marginTop: 12, fontSize: 11, color: '#64748b' }}
        data-testid={`text-agent-positions-empty-${agentId}`}
      >
        No open positions for this agent.
      </div>
    )
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{
        fontSize: 11, color: '#94a3b8', marginBottom: 6, fontWeight: 600,
        letterSpacing: 0.3, textTransform: 'uppercase',
      }}>
        Open positions ({positions.length})
      </div>
      {actionMsg && (
        <div
          data-testid={`text-agent-positions-actionmsg-${agentId}`}
          style={{
            marginBottom: 6, fontSize: 11,
            color: actionMsg.kind === 'ok' ? '#10b981' : '#ef4444',
          }}
        >
          {actionMsg.text}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {positions.map((p) => {
          const sideColor = p.side === 'LONG' ? '#10b981' : '#ef4444'
          const pnl = p.unrealizedPnl
          const pnlColor = pnl == null ? '#64748b' : pnl >= 0 ? '#10b981' : '#ef4444'
          const key = `${p.pair}|${p.side}`
          const isClosing = closingKey === key
          // Close button is Aster-only for now — HL/42space close paths
          // live behind different endpoints and aren't wired into this
          // panel yet.
          const canClose = (p.exchange ?? 'aster') === 'aster'
          return (
            <div
              key={p.id}
              data-testid={`row-agent-position-${agentId}-${p.pair}-${p.side}`}
              style={{
                padding: 8, borderRadius: 8, background: '#0a0a0f',
                display: 'flex', flexDirection: 'column', gap: 3,
                fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>{p.pair}</span>
                <span style={{ color: sideColor, fontWeight: 600 }}>
                  {p.side} · {p.leverage}x
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: 11 }}>
                <span>{p.size} @ ${fmtPrice(p.entryPrice)}</span>
                <span>mark {p.markPrice != null ? `$${fmtPrice(p.markPrice)}` : '—'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ color: pnlColor, fontWeight: 600 }}
                  data-testid={`text-agent-pnl-${agentId}-${p.pair}-${p.side}`}>
                  {pnl == null
                    ? 'PnL —'
                    : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDT`}
                </span>
                {canClose && (
                  <button
                    type="button"
                    onClick={() => onClose(p)}
                    disabled={isClosing}
                    data-testid={`button-agent-close-${agentId}-${p.pair}-${p.side}`}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 6,
                      border: '1px solid #ef4444', background: 'transparent',
                      color: '#ef4444', cursor: isClosing ? 'wait' : 'pointer',
                      opacity: isClosing ? 0.6 : 1, fontWeight: 600,
                    }}
                  >
                    {isClosing ? 'Closing…' : 'Close'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface AgentStudioProps {
  userId: string | null
}

// Three first-class venues. Their toggles act as a per-user allow-list:
// every agent the user owns is gated on whether the user has enabled the
// venue. Same agent can therefore trade on Aster today and (once the user
// flips Hyperliquid on + finishes onboarding) Hyperliquid tomorrow without
// having to be re-created.
type VenueId = 'aster' | 'hyperliquid' | 'fortytwo'
interface VenueConfig {
  id: VenueId
  label: string
  sub: string
  accent: string
}
const VENUES: VenueConfig[] = [
  { id: 'aster',       label: 'Aster',       sub: 'Perp DEX · BSC',     accent: '#f97316' },
  { id: 'hyperliquid', label: 'Hyperliquid', sub: 'L1 perps',           accent: '#22d3ee' },
  { id: 'fortytwo',    label: '42.space',    sub: 'Prediction markets', accent: '#a78bfa' },
]

interface VenuePermissions { aster: boolean; hyperliquid: boolean; fortytwo: boolean }
interface VenueOnboarded   { aster: boolean; hyperliquid: boolean; fortytwo: boolean }

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function actionMeta(a: string): { emoji: string; label: string; color: string } {
  if (a === 'OPEN_LONG') return { emoji: '🚀', label: 'LONG', color: '#10b981' }
  if (a === 'OPEN_SHORT') return { emoji: '🔻', label: 'SHORT', color: '#ef4444' }
  if (a === 'CLOSE') return { emoji: '✋', label: 'CLOSE', color: '#f59e0b' }
  return { emoji: '🤔', label: 'HOLD', color: '#64748b' }
}

// Map a feed row's `exchange` to a compact venue chip (label + colour)
// shown next to the agent name. Returns null when the venue is unknown
// or absent so the chip is simply omitted rather than rendered blank.
export function venueChip(ex: string | null | undefined): { label: string; color: string } | null {
  const x = (ex ?? '').toLowerCase()
  if (x === 'aster')       return { label: 'ASTER', color: '#f97316' }
  if (x === 'hyperliquid') return { label: 'HL',    color: '#22d3ee' }
  if (x === 'fortytwo')    return { label: '42',    color: '#a78bfa' }
  return null
}

// Per-venue onboarding flags as returned by /api/me/wallet (subset).
// We don't import the full type to avoid circular dep — both feed
// renderers consume only these three booleans.
export interface FeedOnboardedFlags { aster: boolean; hyperliquid: boolean; fortytwo: boolean }

// True when a feed entry's venue is one the user has NOT yet activated
// for trading. This is the basis for the "SCOUT" badge: the agent is
// scanning these venues read-only (public market data) and surfacing
// decisions in the brain feed, but no orders are placed because the
// per-venue activation flow (Aster /approve, HL /approve-builder, 42
// liveTrade toggle) has not run yet. Returns false when the flags are
// still loading (`null`) so we never falsely mark an entry as "scout"
// before we know the truth — and false for unknown venues so a missing
// `exchange` field doesn't get a misleading badge.
export function isVenueScouting(
  ex: string | null | undefined,
  onb: FeedOnboardedFlags | null,
): boolean {
  if (!onb) return false
  const x = (ex ?? '').toLowerCase()
  if (x === 'aster')       return !onb.aster
  if (x === 'hyperliquid') return !onb.hyperliquid
  if (x === 'fortytwo')    return !onb.fortytwo
  return false
}

// Inline pill that visually flags a feed row as "the agent is just
// scouting this venue, no trades will execute until you activate it."
// Used next to the venue chip in both feed renderers (Agents + Studio).
// Muted/outline styling so it reads as a status hint rather than a
// second venue chip — the venue chip itself stays its normal colour so
// the user still sees which venue produced the decision.
export function ScoutBadge({ id }: { id: string }) {
  return (
    <span
      title="Agent is scanning this venue but won't trade until you activate it."
      data-testid={`feed-scout-${id}`}
      style={{
        fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
        background: 'transparent', color: 'var(--text-muted, #94a3b8)',
        border: '1px solid var(--border, #334155)', letterSpacing: 0.3,
      }}
    >
      SCOUT
    </span>
  )
}

// Map an agent's `exchange` value to a known venue. Lowercased defensively
// so a stray "Aster"/"HyperLiquid" doesn't fall through to "other".
function venueOf(exchange: string | undefined): VenueId | 'other' {
  const x = (exchange ?? '').toLowerCase()
  if (x === 'aster' || x === 'hyperliquid' || x === 'fortytwo') return x as VenueId
  return 'other'
}

export default function AgentStudio(_props: AgentStudioProps) {
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [feed, setFeed] = useState<FeedEntry[]>([])
  const [feedError, setFeedError] = useState(false)
  // "Load older" pagination state. `loadingMore` drives the spinner on
  // the button; `noMoreOlder` flips true the first time a paginated
  // fetch returns zero new rows so we can swap the button for a "no
  // more activity" hint instead of letting the user keep tapping a
  // button that will never produce anything.
  const [loadingMore, setLoadingMore] = useState(false)
  const [noMoreOlder, setNoMoreOlder] = useState(false)
  // Per-agent expand state: which agent's full chart is currently shown.
  // Only one chart visible at a time so we don't mount many TradingView
  // iframes for users with lots of agents (memory + scroll cost).
  const [openChartAgentId, setOpenChartAgentId] = useState<string | null>(null)
  // Per-agent currently-selected pair for the in-card ticker/chart.
  const [agentPairSel, setAgentPairSel] = useState<Record<string, string>>({})
  // Per-user venue allow-list. `null` while in flight so toggles stay
  // disabled until we know the real server state — never silently flip
  // a user into LIVE mode (especially for 42.space) on a first paint.
  const [perms, setPerms] = useState<VenuePermissions | null>(null)
  const [onboarded, setOnboarded] = useState<VenueOnboarded | null>(null)
  // Per-venue busy flag for the platform toggle so a fast double-tap can't
  // race the optimistic update against the server.
  const [busyVenue, setBusyVenue] = useState<VenueId | null>(null)

  // Per-agent draft of the editable risk settings. Keyed by agentId so
  // multiple agent cards can be edited independently. Only the field the
  // user actually touched is patched on blur — any field left as `undefined`
  // here is sent as-is by the input's defaultValue (so the agent's saved
  // values stay untouched if the user never focuses that input).
  const [riskDraft, setRiskDraft] = useState<Record<string, {
    maxPositionSize?: string
    maxDailyLoss?: string
    maxLeverage?: string
  }>>({})
  const [riskSaving, setRiskSaving] = useState<Record<string, boolean>>({})

  // Clear the per-agent draft for one field so the input falls back to
  // showing the persisted value from `agents`. We always do this after a
  // blur (success, failure, or no-op) so the input visibly reverts to
  // truth — no more "blank field that's actually saved as 25" confusion
  // when the user clears a field then tabs away.
  const clearDraftField = (agentId: string, field: 'maxPositionSize' | 'maxDailyLoss' | 'maxLeverage') => {
    setRiskDraft(d => {
      const cur = d[agentId]
      if (!cur || cur[field] === undefined) return d
      const nextAgent = { ...cur }
      delete nextAgent[field]
      const next = { ...d }
      if (Object.keys(nextAgent).length === 0) delete next[agentId]
      else next[agentId] = nextAgent
      return next
    })
  }

  const saveRiskField = async (
    agentId: string,
    field: 'maxPositionSize' | 'maxDailyLoss' | 'maxLeverage',
    raw: string,
  ) => {
    const trimmed = raw.trim()
    const current = agents.find(a => a.id === agentId)
    if (!current) { clearDraftField(agentId, field); return }

    const parsed = Number(trimmed)
    const valid = trimmed !== '' && Number.isFinite(parsed) && parsed > 0
    if (!valid || Number(current[field]) === parsed) {
      // Nothing to do (empty / invalid / unchanged). Clear the draft so
      // the input visibly reverts to the persisted value instead of
      // sitting on a blank/invalid string.
      clearDraftField(agentId, field)
      return
    }

    const prev = agents
    setRiskSaving(s => ({ ...s, [`${agentId}:${field}`]: true }))
    setAgents(curr => curr.map(a => a.id === agentId ? { ...a, [field]: parsed } : a))
    try {
      await updateAgentSettings(agentId, { [field]: parsed } as any)
    } catch {
      // Rollback on rejection so the displayed value matches what's actually
      // persisted (validation rejection bodies surface in the network tab
      // for power users; non-blocking for the common edit-too-small case).
      setAgents(prev)
    } finally {
      setRiskSaving(s => {
        const next = { ...s }; delete next[`${agentId}:${field}`]; return next
      })
      // Always clear the draft after the round-trip so the input shows the
      // authoritative value from `agents` (which is now either the new
      // saved value, or the pre-edit value after rollback).
      clearDraftField(agentId, field)
    }
  }

  const fetchAgents = () => {
    return apiFetch<any[]>('/api/me/agents')
      .then(data => { setAgents(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => { setLoading(false) })
  }

  // Default refresh: pulls the latest 20 entries and merges them with
  // any older entries the user has already loaded via "Load older". We
  // dedupe by entry id so the 30s poll never duplicates a row the user
  // is already looking at, and we keep older loaded entries appended at
  // the tail so they don't disappear on every poll. Without this the
  // poll would clobber pagination state every 30 seconds.
  const fetchFeed = () => {
    return getMyFeed(20)
      .then(f => {
        const fresh = Array.isArray(f) ? f : []
        setFeed(prev => {
          if (prev.length === 0) return fresh
          const seen = new Set(fresh.map(x => x.id))
          // Keep older loaded entries that the latest poll didn't return
          // (i.e. anything strictly older than the newest fresh entry's
          // timestamp, OR anything fresh-window-shaped but missed by the
          // server's de-jittered ordering — both safe to keep).
          const tail = prev.filter(x => !seen.has(x.id))
          return [...fresh, ...tail].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          )
        })
        setFeedError(false)
      })
      .catch(() => setFeedError(true))
  }

  // "Load older entries" cursor pagination. Uses the oldest entry's
  // createdAt as the cursor so the server returns the next 20 rows
  // strictly older than what the user is currently looking at. Stops
  // showing the button (renders an end-marker instead) once the server
  // returns an empty page so the user knows they've reached the bottom.
  const loadOlder = async () => {
    if (loadingMore || noMoreOlder || feed.length === 0) return
    setLoadingMore(true)
    try {
      const oldest = feed[feed.length - 1]
      const older = await getMyFeed(20, oldest.createdAt)
      const olderArr = Array.isArray(older) ? older : []
      if (olderArr.length === 0) { setNoMoreOlder(true); return }
      // Dedupe: a tick that landed exactly on the cursor boundary could in
      // rare cases come back again here. Filter by id and append.
      // Trades virtualise into two entries (`trade-open-*`, `trade-close-*`);
      // the CLOSE side may belong chronologically NEWER than the cursor but
      // gets re-emitted by the older-page query (we filter trades by
      // openedAt). Dedupe by id catches that case too. We sort the merged
      // result so the CLOSE entry slots into its correct chronological
      // position rather than appearing at the bottom of the list.
      const seen = new Set(feed.map(x => x.id))
      const novel = olderArr.filter(x => !seen.has(x.id))
      if (novel.length === 0) { setNoMoreOlder(true); return }
      setFeed(prev => [...prev, ...novel].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ))
    } catch {
      // Soft fail — leave the button enabled so the user can retry.
    } finally {
      setLoadingMore(false)
    }
  }

  const fetchPermissions = () => {
    return apiFetch<{
      ok: boolean
      permissions: VenuePermissions
      onboarded: VenueOnboarded
    }>('/api/me/venue-permissions')
      .then(r => {
        setPerms(r?.permissions ?? { aster: false, hyperliquid: false, fortytwo: false })
        setOnboarded(r?.onboarded ?? { aster: false, hyperliquid: false, fortytwo: true })
      })
      // On lookup failure default conservatively: assume Aster is allowed
      // (matches the schema default and what existing users have today)
      // but 42.space LIVE stays OFF so we never auto-enable real-money
      // prediction trading because of a transient network error.
      .catch(() => {
        setPerms({ aster: true, hyperliquid: true, fortytwo: false })
        setOnboarded({ aster: false, hyperliquid: false, fortytwo: true })
      })
  }

  useEffect(() => {
    fetchAgents()
    fetchFeed()
    fetchPermissions()
    // 1s polling — user wants the brain feed to stream new decisions
    // in near-real time, matching every other live surface in the app.
    const t = setInterval(fetchFeed, 1000)
    return () => clearInterval(t)
  }, [])

  const toggleAgent = async (agentId: string) => {
    await apiFetch(`/api/agents/${agentId}/toggle`, { method: 'POST' })
    fetchAgents()
  }

  // Per-agent venue chip toggle. Optimistic so the chip flips on tap with
  // zero perceived latency; reverts to the previous state on server error.
  // Concurrency is keyed by `${agentId}:${venue}` so the user can flip
  // multiple chips on different agents in parallel without one tap
  // freezing another.
  const [busyAgentVenue, setBusyAgentVenue] = useState<Set<string>>(new Set())

  // Hard-delete confirm modal — keyed by agentId so the user always sees
  // the agent's name in the dialog and we can't accidentally delete the
  // wrong row if state shifts between tapping Remove and tapping Confirm.
  // `deleting` tracks the in-flight DELETE so the Confirm button can show
  // a busy state and we suppress duplicate taps.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const handleDeleteAgent = async (agentId: string) => {
    if (deletingId) return
    setDeletingId(agentId)
    setDeleteError(null)
    try {
      await deleteAgent(agentId)
      setConfirmDeleteId(null)
      // Re-fetch so the deleted card disappears immediately and any
      // dependent UI (Brain feed empty state, "no agents yet" hero)
      // re-evaluates against the new list.
      await fetchAgents()
    } catch (e: any) {
      setDeleteError(e?.body?.error ?? e?.message ?? 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  // "+ New Agent" — sets ?onboard=1 on the URL and dispatches the
  // existing b4-nav event so App.tsx swaps to the Onboard page. The URL
  // change is purely cosmetic for refresh-friendliness; the page swap
  // happens via state, not a hard navigation.
  const goToOnboard = () => {
    try {
      const u = new URL(window.location.href)
      u.searchParams.set('onboard', '1')
      window.history.replaceState({}, '', u.toString())
    } catch { /* sandboxed envs without URL — fine to skip */ }
    window.dispatchEvent(new CustomEvent('b4-nav', { detail: 'onboard' }))
  }
  const toggleAgentVenue = async (agentId: string, venue: VenueId, nextEnabled: boolean) => {
    const key = `${agentId}:${venue}`
    if (busyAgentVenue.has(key)) return
    setBusyAgentVenue(prev => { const n = new Set(prev); n.add(key); return n })

    // Optimistic mutate of the local agents state. We compute the next
    // enabledVenues array from the previous one (not from the chip's
    // intended boolean directly) so a stale render can't accidentally
    // wipe a venue the user just turned on in another chip.
    const prev = agents
    setAgents(curr => curr.map(a => {
      if (a.id !== agentId) return a
      const cur: string[] = Array.isArray(a.enabledVenues) ? a.enabledVenues : []
      const set = new Set(cur)
      if (nextEnabled) set.add(venue); else set.delete(venue)
      const next = Array.from(set)
      return { ...a, enabledVenues: next, isActive: next.length > 0 }
    }))

    try {
      await apiFetch(`/api/agents/${agentId}/venues/${venue}/toggle`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled: nextEnabled }),
      })
      // Refetch in the background to converge any server-side normalisation
      // (e.g. the master isActive flag flipping when the last venue dropped).
      fetchAgents()
    } catch {
      setAgents(prev)
    } finally {
      setBusyAgentVenue(curr => { const n = new Set(curr); n.delete(key); return n })
    }
  }

  // Flip a single platform allow-flag. Optimistic UI + revert on error so
  // the toggle never lies about the server state.
  const setVenuePermission = async (venue: VenueId, enabled: boolean) => {
    if (busyVenue) return
    setBusyVenue(venue)
    const previous = perms
    setPerms(p => p ? { ...p, [venue]: enabled } : p)
    try {
      const res = await apiFetch<{ ok: boolean; venue: VenueId; enabled: boolean }>(
        '/api/me/venue-permissions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ venue, enabled }),
        }
      )
      // Trust the server's echo so we converge to truth even if it
      // refused or normalised the input somehow.
      setPerms(p => p ? { ...p, [venue]: !!res?.enabled } : p)
    } catch {
      setPerms(previous)
    } finally {
      setBusyVenue(null)
    }
  }

  const hasActive = agents.some(a => a.isActive)

  if (loading) {
    return <div style={{ paddingTop: 60, textAlign: 'center', color: '#64748b' }}>Loading agents...</div>
  }

  // Set of venues the user already has at least one agent on. Used to
  // suppress the "connect in Wallet" hint for venues that already have
  // a working agent — the onboarded flag in the DB lags reality for some
  // legacy users, so the presence of a real agent row is a stronger
  // signal that setup is effectively done.
  const venuesWithAgent = new Set<string>(agents.map(a => venueOf(a.exchange)))

  // Render a single platform allow-list row. Toggling a venue enables /
  // disables agent trading on it for THIS user, regardless of how many
  // agents the user has — toggles are permissions, not per-agent groups.
  const renderVenueRow = (v: VenueConfig) => {
    const enabled = perms ? perms[v.id] : false
    const isOnboarded = onboarded ? onboarded[v.id] : false
    const hasAgentHere = venuesWithAgent.has(v.id)
    const busy = busyVenue === v.id
    // Always interactive once permissions have loaded — even if not yet
    // onboarded. Flipping ON without onboarding is harmless (the runner
    // will still skip dispatch until creds are present); the user sees a
    // hint below the row telling them to finish setup.
    const disabled = perms === null || busy

    // ON/OFF across every venue. We don't surface a "PAPER" state in
    // the UI any more — the user's directive is "no fakes ever",
    // venues are either live-traded or off entirely.
    const stateLabel = enabled ? 'ON' : 'OFF'

    return (
      <div
        key={v.id}
        data-testid={`venue-row-${v.id}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 14px', marginBottom: 8,
          background: '#0a0a0f', border: '1px solid #1f1f2e',
          borderLeft: `3px solid ${v.accent}`, borderRadius: 8,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }} data-testid={`text-venue-label-${v.id}`}>
              {v.label}
            </div>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
              background: enabled ? `${v.accent}22` : '#1e1e2e',
              color: enabled ? v.accent : '#64748b',
              letterSpacing: 0.4,
            }} data-testid={`text-venue-state-${v.id}`}>
              {stateLabel}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {v.sub}
            {/* Hint suppressed when the user already has an agent on this
                venue — a working agent is a stronger signal than the DB
                flag, which can lag for legacy users. Only nudge truly
                unconnected venues. */}
            {!isOnboarded && !hasAgentHere && v.id !== 'fortytwo' && (
              <span style={{ color: '#f59e0b' }}>
                {' · '}open <span style={{ fontWeight: 600 }}>Wallet</span> tab and connect {v.label} to start
              </span>
            )}
          </div>
        </div>

        <button
          onClick={() => { if (!disabled) setVenuePermission(v.id, !enabled) }}
          disabled={disabled}
          data-testid={`button-venue-toggle-${v.id}`}
          aria-label={`${enabled ? 'Disable' : 'Enable'} ${v.label} agent trading`}
          style={{
            width: 52, height: 28, borderRadius: 14,
            background: enabled ? v.accent : '#1e1e2e',
            border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            position: 'relative',
            transition: 'background 0.2s, opacity 0.2s',
            flexShrink: 0,
          }}
        >
          <div style={{
            width: 22, height: 22, borderRadius: '50%', background: 'white',
            position: 'absolute', top: 3,
            left: enabled ? 27 : 3,
            transition: 'left 0.2s',
          }} />
        </button>
      </div>
    )
  }

  // Render a single agent card. Each agent has one primary venue (its
  // `exchange` field) but the per-user platform allow-list above governs
  // whether the runner actually dispatches its decisions to that venue.
  const renderAgentCard = (agent: any) => {
    const isAuto = Array.isArray(agent.pairs) && agent.pairs.includes('AUTO')
    const watched: string[] = Array.isArray(agent.pairs) ? agent.pairs.filter((p: string) => p !== 'AUTO') : []
    const pnlValue = agent.totalPnl ?? 0
    const pnlColor = pnlValue > 0 ? '#10b981' : pnlValue < 0 ? '#ef4444' : 'var(--text-secondary)'

    // The agent's primary venue & whether the user has currently enabled
    // it. If they've turned off the platform, surface a clear "Platform
    // paused" badge so the user understands why the agent isn't ticking
    // even though its own toggle reads ON.
    const v = venueOf(agent.exchange)
    const venueAccent =
      v === 'aster' ? '#f97316' :
      v === 'hyperliquid' ? '#22d3ee' :
      v === 'fortytwo' ? '#a78bfa' : '#64748b'
    const venueLabel =
      v === 'aster' ? 'Aster' :
      v === 'hyperliquid' ? 'Hyperliquid' :
      v === 'fortytwo' ? '42.space' :
      (agent.exchange ?? 'unknown')
    const platformAllowed = perms == null
      ? true
      : (v === 'other' ? true : perms[v])

    return (
      <div key={agent.id} className="card" style={{ marginBottom: 10 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }} data-testid={`text-agent-name-${agent.id}`}>
                {agent.name}
              </div>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
                background: `${venueAccent}22`, color: venueAccent, letterSpacing: 0.3,
              }} data-testid={`text-agent-venue-${agent.id}`}>
                {venueLabel}
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
              {isAuto
                ? 'AUTO — scanning the market'
                : (agent.pairs?.join(', ') ?? '')}
            </div>
          </div>
        </div>

        {/* Per-agent venue chips (Phase 1, 2026-04-28). Replaces the
            single Activate toggle. Each chip is an independent on/off
            for that venue — the agent can run on any subset (e.g. only
            HL, or Aster + 42.space). Empty = dormant. The chip is
            disabled (and dimmed) when the user's platform allow-list
            has that venue paused, so the per-agent UI never lies about
            why a venue isn't ticking. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}
             data-testid={`group-agent-venues-${agent.id}`}>
          {VENUES.map(v => {
            const enabledHere = Array.isArray(agent.enabledVenues)
              ? agent.enabledVenues.includes(v.id)
              : agent.exchange === v.id  // legacy fallback if backfill hasn't run yet
            const platformOff = perms != null && perms[v.id] === false
            const busy = busyAgentVenue.has(`${agent.id}:${v.id}`)
            const disabled = platformOff || busy
            const tip = platformOff
              ? `Enable ${v.label} at the top of this page first`
              : (enabledHere ? `Pause ${v.label} for this agent` : `Run this agent on ${v.label}`)
            return (
              <button
                key={v.id}
                disabled={disabled}
                onClick={() => toggleAgentVenue(agent.id, v.id, !enabledHere)}
                data-testid={`chip-agent-venue-${v.id}-${agent.id}`}
                aria-pressed={enabledHere}
                title={tip}
                style={{
                  fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
                  padding: '5px 10px', borderRadius: 999,
                  border: `1px solid ${enabledHere ? v.accent : '#2a2a3a'}`,
                  background: enabledHere ? `${v.accent}22` : 'transparent',
                  color: enabledHere ? v.accent : (platformOff ? '#475569' : '#94a3b8'),
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: platformOff ? 0.55 : (busy ? 0.7 : 1),
                  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                }}
              >
                {v.label.toUpperCase()}
              </button>
            )
          })}
        </div>

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          {[
            { label: 'Total PnL', value: `${pnlValue > 0 ? '+' : pnlValue < 0 ? '-' : ''}$${Math.abs(pnlValue).toFixed(2)}`, color: pnlColor },
            { label: 'Win Rate', value: `${agent.winRate?.toFixed(0) ?? 0}%`, color: '#e2e8f0' },
            { label: 'Trades', value: agent.totalTrades ?? 0, color: '#e2e8f0' }
          ].map(stat => (
            <div key={stat.label} style={{ background: '#0a0a0f', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 2 }}>{stat.label}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: stat.color }}>{stat.value}</div>
            </div>
          ))}
        </div>

        {/* Risk settings — editable inline. Each field commits on blur via
            saveRiskField(); leaving a field untouched preserves the saved
            value because we only PATCH fields the user actually changed.
            Aster minimum notional is $5.50; we surface that as a hint on
            Max position so users sizing down know the floor up front. */}
        <div style={{ fontSize: 11, color: '#64748b' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
          }}>
            {([
              { key: 'maxPositionSize', label: 'Max position', prefix: '$',  suffix: '',  step: '1',   min: '5.5', hint: 'Aster min $5.50' },
              { key: 'maxDailyLoss',    label: 'Max loss/day', prefix: '$',  suffix: '',  step: '1',   min: '1',   hint: '' },
              { key: 'maxLeverage',     label: 'Max leverage', prefix: '',   suffix: 'x', step: '1',   min: '1',   hint: '' },
            ] as const).map(field => {
              const draftKey = `${agent.id}:${field.key}`
              const saving = !!riskSaving[draftKey]
              const draft  = riskDraft[agent.id]?.[field.key]
              const live   = draft !== undefined ? draft : String((agent as any)[field.key] ?? '')
              return (
                // minWidth: 0 + overflow: hidden are essential here.
                // CSS Grid items default to `min-width: auto`, which uses the
                // child's intrinsic content width — and a number <input>
                // refuses to shrink below ~3ch by default. On narrow phones
                // (≤ 360px) that pushed the third cell ("Max leverage")
                // past the agent card's right edge. Letting the cell shrink
                // and clipping the inner row to the cell width keeps all
                // three boxes flush inside the card on every viewport.
                <label key={field.key} style={{ display: 'block', minWidth: 0, overflow: 'hidden' }}>
                  <div style={{
                    fontSize: 10, color: '#64748b', marginBottom: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{field.label}</div>
                  <div style={{
                    display: 'flex', alignItems: 'center',
                    background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6,
                    padding: '4px 6px',
                    width: '100%', boxSizing: 'border-box', minWidth: 0,
                  }}>
                    {field.prefix && <span style={{ color: '#64748b', marginRight: 2 }}>{field.prefix}</span>}
                    <input
                      type="number"
                      inputMode="decimal"
                      step={field.step}
                      min={field.min}
                      value={live}
                      disabled={saving}
                      onChange={e => setRiskDraft(d => ({
                        ...d,
                        [agent.id]: { ...(d[agent.id] ?? {}), [field.key]: e.target.value },
                      }))}
                      onBlur={e => saveRiskField(agent.id, field.key, e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                      }}
                      data-testid={`input-agent-${agent.id}-${field.key}`}
                      style={{
                        flex: 1, minWidth: 0,
                        background: 'transparent', border: 'none', outline: 'none',
                        color: '#e2e8f0', fontSize: 13, fontWeight: 600,
                        padding: 0, WebkitAppearance: 'none', MozAppearance: 'textfield',
                      }}
                    />
                    {field.suffix && <span style={{ color: '#64748b', marginLeft: 2 }}>{field.suffix}</span>}
                  </div>
                  {field.hint && (
                    <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>{field.hint}</div>
                  )}
                </label>
              )
            })}
          </div>
        </div>

        {/* Status badge + Remove on the same row — Remove sits to the
            right so it's discoverable without dominating the card. We
            confirm before deleting to avoid an accidental tap nuking
            the user's only agent. */}
        <div style={{
          marginTop: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <div style={{
            display: 'inline-block',
            fontSize: 11, padding: '3px 10px', borderRadius: 20,
            background:
              !agent.isActive   ? '#1e1e2e' :
              !platformAllowed  ? '#f59e0b15' :
                                  '#10b98115',
            color:
              !agent.isActive   ? '#64748b' :
              !platformAllowed  ? '#f59e0b' :
                                  '#10b981',
          }} data-testid={`text-agent-status-${agent.id}`}>
            {!agent.isActive
              ? '○ Inactive'
              : !platformAllowed
                ? `⏸ ${venueLabel} paused — enable above`
                : '● Active — next tick in ~60s'}
          </div>

          <button
            onClick={() => { setDeleteError(null); setConfirmDeleteId(agent.id) }}
            data-testid={`button-remove-agent-${agent.id}`}
            aria-label={`Remove ${agent.name}`}
            style={{
              fontSize: 11, fontWeight: 600, padding: '4px 10px',
              borderRadius: 6, cursor: 'pointer',
              background: 'transparent',
              border: '1px solid #3a1e22',
              color: '#ef4444',
            }}
          >
            🗑 Remove
          </button>
        </div>

        {/* Live market block — only renders for single-ticker agents.
            AUTO-mode agents scan many pairs each tick, so there is no
            single chart to embed. */}
        {!isAuto && watched.length > 0 && (() => {
          const selected = agentPairSel[agent.id] ?? watched[0]
          const isOpen = openChartAgentId === agent.id
          return (
            <div style={{ marginTop: 12 }}>
              {watched.length > 1 && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                  {watched.map(p => (
                    <button
                      key={p}
                      onClick={() => setAgentPairSel(s => ({ ...s, [agent.id]: p }))}
                      data-testid={`button-agent-${agent.id}-pair-${p}`}
                      style={{
                        padding: '4px 8px', fontSize: 11, fontWeight: 600,
                        borderRadius: 6, border: 'none', cursor: 'pointer',
                        background: selected === p ? '#7c3aed' : '#1f2937',
                        color: selected === p ? '#fff' : '#9ca3af',
                      }}
                    >{p}</button>
                  ))}
                </div>
              )}
              <MarketTicker
                symbol={selected}
                testIdPrefix={`agent-${agent.id}-ticker`}
                pollMs={8000}
              />
              <button
                onClick={() => setOpenChartAgentId(isOpen ? null : agent.id)}
                data-testid={`button-agent-${agent.id}-toggle-chart`}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 8,
                  background: isOpen ? '#1f2937' : '#0f1117',
                  border: '1px solid #2a2a3e', color: '#a78bfa',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {isOpen ? '▴ Hide chart' : `▾ Open chart · ${selected}`}
              </button>
              {isOpen && (
                <div style={{ marginTop: 8 }}>
                  <TradingChart
                    symbol={selected}
                    defaultInterval="15"
                    height={280}
                    testIdPrefix={`agent-${agent.id}-chart`}
                  />
                </div>
              )}
            </div>
          )
        })()}

        {/* Per-agent open positions with live PnL. The user reported
            being unable to see what each agent currently holds — Trade
            page shows everything pooled, Studio used to show nothing.
            This panel scopes to the agent's own DB rows so each card
            tells its own story. */}
        <AgentPositions agentId={agent.id} />
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>🤖 Agent Studio</div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
            Choose where your agents are allowed to trade — same agent, any platform.
          </div>
        </div>
        {/* "+ New Agent" — primary affordance for adding more agents from
            inside Studio (rather than going back to /newagent in the bot
            or hunting for the empty-state CTA on the Dashboard). Always
            visible at the top so the action is one tap from anywhere
            inside Studio. */}
        <button
          onClick={goToOnboard}
          data-testid="button-new-agent"
          style={{
            background: 'var(--purple)',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            padding: '8px 12px',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          + New Agent
        </button>
      </div>

      {/* Per-user platform allow-list. Sits above the agents list so the
          relationship is unmistakable: "these toggles control whether my
          agents below can place trades on each platform." */}
      <div style={{ marginBottom: 18 }} data-testid="section-platform-allowlist">
        <div style={{
          fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.5,
          textTransform: 'uppercase', marginBottom: 8, paddingLeft: 2,
        }}>
          Allowed Trading Platforms
        </div>
        {VENUES.map(renderVenueRow)}
      </div>

      {/* Flat list of every agent the user owns. No per-venue grouping —
          each card just badges the agent's primary venue and the per-user
          platform toggle above governs whether it can act. */}
      <div style={{
        fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.5,
        textTransform: 'uppercase', marginBottom: 8, paddingLeft: 2,
      }}>
        Your Agents
      </div>
      {agents.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🤖</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No agents yet</div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>
            Tap <span style={{ color: '#a78bfa', fontWeight: 600 }}>+ New Agent</span> above to deploy
            your first agent. It will trade on every platform you allow.
          </div>
          <button
            onClick={goToOnboard}
            data-testid="button-new-agent-empty-state"
            style={{
              background: 'var(--purple)', color: '#fff', border: 'none',
              borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            🚀 Deploy your first agent
          </button>
        </div>
      ) : (
        agents.map(renderAgentCard)
      )}

      {/* Live Brain Feed — shows what the agents are actually doing */}
      <div style={{ marginTop: 24, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-brain-feed-title">
          🧠 Live Agent Brain
        </div>
        {hasActive && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: '#10b981',
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', background: '#10b981',
              animation: 'pulse 1.6s ease-in-out infinite',
            }} />
            Scanning markets every ~60s
          </div>
        )}
      </div>

      {feedError && (
        <div className="card" style={{ padding: 14, fontSize: 12, color: '#ef4444' }}>
          Couldn't load the brain feed. The agent is still running in the background.
        </div>
      )}

      {!feedError && feed.length === 0 && (
        <div className="card" style={{ padding: 14, fontSize: 12, color: '#64748b' }}>
          {hasActive
            ? 'No decisions logged yet. The next analysis cycle will appear here within ~60s.'
            : 'Activate an agent above and its trade decisions will stream in here.'}
        </div>
      )}

      {!feedError && feed.map((e) => {
        const meta = actionMeta(e.action)
        return (
          <div
            key={e.id}
            className="card"
            data-testid={`feed-${e.id}`}
            style={{ marginBottom: 8, borderLeft: `3px solid ${meta.color}`, padding: 12 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>🤖 {e.agentName}</div>
                {(() => {
                  const v = venueChip(e.exchange)
                  return v ? (
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                      background: `${v.color}22`, color: v.color, letterSpacing: 0.3,
                    }} data-testid={`feed-venue-${e.id}`}>{v.label}</span>
                  ) : null
                })()}
                {/* SCOUT badge — agent scanned this venue but no order
                    fired because the user hasn't completed activation
                    for it. Reuses the page-level `onboarded` state
                    (already loaded for the venue toggles), so no extra
                    fetch needed here. */}
                {isVenueScouting(e.exchange, onboarded) && <ScoutBadge id={e.id} />}
              </div>
              <div style={{ fontSize: 11, color: '#64748b' }}>{timeAgo(e.createdAt)}</div>
            </div>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              {meta.emoji}{' '}
              <span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span>
              {e.pair ? ` — ${e.pair}` : ''}
              {e.price != null ? ` @ $${e.price.toFixed(e.price > 100 ? 2 : 4)}` : ''}
            </div>
            {(() => {
              // Hide indicator chips when ADX/RSI are 0 — they're set to 0
              // as a sentinel for "no usable history" (fresh listings, first
              // candles), not as a real reading. Showing "ADX 0.0 · RSI 0"
              // looked broken; we just omit them in that case.
              const hasAdx = e.adx != null && e.adx > 0
              const hasRsi = e.rsi != null && e.rsi > 0
              const hasScore = e.score != null
              if (!e.regime && !hasAdx && !hasRsi && !hasScore) return null
              return (
                <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8' }}>
                  {e.regime ? `${e.regime}` : ''}
                  {hasAdx ? ` · ADX ${e.adx!.toFixed(1)}` : ''}
                  {hasRsi ? ` · RSI ${e.rsi!.toFixed(0)}` : ''}
                  {hasScore ? ` · Score ${e.score}/10` : ''}
                </div>
              )
            })()}
            {e.reason && (
              <div
                style={{ marginTop: 6, fontSize: 12, color: '#cbd5e1', fontStyle: 'italic' }}
                data-testid={`feed-reason-${e.id}`}
              >
                "{e.reason}"
              </div>
            )}
          </div>
        )
      })}

      {/* "Load older entries" pager. Hidden when the feed is empty (the
          empty-state hint above already covers that case) or errored.
          Once the server returns no more rows we swap the button for an
          end-of-feed marker so users know they've reached the bottom and
          aren't left tapping a dead button. */}
      {!feedError && feed.length > 0 && !noMoreOlder && (
        <button
          type="button"
          onClick={loadOlder}
          disabled={loadingMore}
          data-testid="button-feed-load-older"
          style={{
            width: '100%',
            marginTop: 8,
            padding: '10px 14px',
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 8,
            color: loadingMore ? '#64748b' : '#e2e8f0',
            fontSize: 13,
            fontWeight: 500,
            cursor: loadingMore ? 'wait' : 'pointer',
          }}
        >
          {loadingMore ? 'Loading…' : '↓ Load older entries'}
        </button>
      )}
      {!feedError && feed.length > 0 && noMoreOlder && (
        <div
          data-testid="text-feed-end-marker"
          style={{
            textAlign: 'center',
            marginTop: 8,
            padding: '10px 14px',
            fontSize: 12,
            color: '#64748b',
            fontStyle: 'italic',
          }}
        >
          — no older activity —
        </div>
      )}

      {/* Confirm-delete modal — keyed to the agent the user just tapped
          Remove on. Always shows the agent's name (defensively re-looked-
          up from the latest state) so the user knows exactly what they're
          deleting, and the Confirm button shows in-flight state during
          the DELETE round-trip. Tapping the backdrop or Cancel closes. */}
      {confirmDeleteId && (() => {
        const target = agents.find(a => a.id === confirmDeleteId)
        if (!target) {
          // Agent disappeared mid-flow (e.g. another tab deleted it).
          // Just close — there's nothing to confirm.
          setConfirmDeleteId(null)
          return null
        }
        const busy = deletingId === confirmDeleteId
        return (
          <div
            data-testid="modal-confirm-delete"
            onClick={() => { if (!busy) setConfirmDeleteId(null) }}
            style={{
              position: 'fixed', inset: 0, zIndex: 300,
              background: 'rgba(0,0,0,0.65)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 16,
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 14,
                padding: 20,
                maxWidth: 360, width: '100%',
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
                Remove agent {target.name}?
              </div>
              <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5, marginBottom: 16 }}>
                The agent will stop trading immediately. Its on-chain identity
                stays on record but the agent will be removed from your
                Studio. You can always create a fresh agent from the same
                page. This cannot be undone.
              </div>
              {deleteError && (
                <div style={{
                  fontSize: 12, color: '#ef4444', marginBottom: 12,
                  padding: 8, border: '1px solid #3a1e22', borderRadius: 6,
                }} data-testid="text-delete-error">
                  {deleteError}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  disabled={busy}
                  data-testid="button-cancel-delete"
                  style={{
                    padding: '8px 14px', borderRadius: 8,
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.5 : 1,
                    fontWeight: 600, fontSize: 13,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteAgent(confirmDeleteId)}
                  disabled={busy}
                  data-testid="button-confirm-delete"
                  style={{
                    padding: '8px 14px', borderRadius: 8,
                    background: '#ef4444',
                    border: 'none',
                    color: '#fff',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.6 : 1,
                    fontWeight: 700, fontSize: 13,
                  }}
                >
                  {busy ? 'Removing…' : 'Remove agent'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.85); }
        }
      `}</style>
    </div>
  )
}

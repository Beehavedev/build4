// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid page — first-pass landing.
//
// Shows the user's HL clearinghouse state (USDC withdrawable, account value,
// open positions) plus live mids for the major perp pairs. If the user
// hasn't approved an agent yet, a "Coming soon" CTA is shown for the
// onboarding flow (handled in a follow-up — needs approveAgent on-chain
// signature with the user's BSC PK).
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api'
import { NativeChart } from '../components/NativeChart'
import { MarketTicker, fmtUsd, fmtUsdRaw } from '../components/MarketTicker'

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'HYPE', 'DOGE']

interface HlPosition {
  coin:           string
  szi:            number    // signed size — positive=long, negative=short
  entryPx:        number
  unrealizedPnl:  number
  positionValue:  number    // signed USDC notional; markPx = positionValue/szi
  leverage:       number
  leverageType:   'cross' | 'isolated'
  maxLeverage:    number
  liquidationPx:  number    // 0 when unavailable
  marginUsed:     number
  returnOnEquity: number
}

interface HlFill {
  coin:      string
  px:        number
  sz:        number
  side:      'B' | 'A'   // B = buy, A = ask/sell
  dir:       string      // "Open Long", "Close Long", "Open Short", "Close Short", "Liquidated …"
  closedPnl: number      // realized PnL on closing fills; "0" for opens
  fee:       number      // taker fee in USDC
  time:      number      // ms epoch
  hash:      string
  oid:       number
  tid:       number
}

interface AccountState {
  walletAddress:    string
  onboarded:        boolean
  withdrawableUsdc: number
  accountValue:     number
  // USDC sitting on the user's HL *spot* sub-account. Funds bridged into HL
  // land here first; perps trading needs them moved to the perps wallet via
  // usdClassTransfer. Surfaced so we can show a one-tap "Move to perps"
  // button instead of telling users to leave for app.hyperliquid.xyz.
  spotUsdc:         number
  // True when the user has HL Unified Account enabled. In unified mode the
  // spot↔perps `usdClassTransfer` is forbidden (HL rejects with "Action
  // disabled when unified account is active") AND unnecessary, because the
  // two sub-accounts share margin. We use this flag to:
  //   1. suppress both move CTAs entirely (the buttons would always fail)
  //   2. swap the "Account value" row to show the unified equity
  //      (spot USDC + perps account value) so the displayed balance lines
  //      up with what the user can actually trade with.
  // Optional because older deploys won't have the flag set on the User row.
  unifiedAccount?:  boolean
  positions:        HlPosition[]
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card, #12121a)', border: '1px solid var(--border, #2a2a3e)',
  borderRadius: 12, padding: 14, marginBottom: 12,
}

export default function Hyperliquid() {
  const [account, setAccount] = useState<AccountState | null>(null)
  const [mids, setMids] = useState<Record<string, number>>({})
  const [arb, setArb] = useState<{ usdc: number; eth: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activating, setActivating] = useState(false)
  const [activateMsg, setActivateMsg] = useState<string | null>(null)
  // Spot → perps in-app transfer state. See moveSpotToPerps below — keeps
  // users from having to leave for app.hyperliquid.xyz when their bridged
  // USDC landed on the spot sub-account instead of perps.
  const [movingSpot, setMovingSpot] = useState(false)
  const [spotMsg, setSpotMsg]       = useState<string | null>(null)
  // Per-coin close-position state. Tracks which row is currently submitting
  //   a reduce-only market close so we can disable that row's button +
  //   show a spinner without freezing the whole positions card. `closeMsg`
  //   surfaces a transient success/error banner under the positions list.
  const [closingCoin, setClosingCoin] = useState<string | null>(null)
  const [closeMsg, setCloseMsg]       = useState<string | null>(null)
  // Perps → spot in-app transfer state. Mirror of the above. Needed before
  // a user can withdraw to Arbitrum, because HL withdrawals are only
  // possible from the spot sub-account.
  const [movingPerps, setMovingPerps] = useState(false)
  const [perpsMsg, setPerpsMsg]       = useState<string | null>(null)

  // Live mark prices for OPEN POSITIONS, polled every second so PnL ticks
  // visibly while you stare at the page (instead of being stuck at the
  // last full-account refresh value). Keyed by coin so a closed position
  // automatically drops out of the polling set on the next account
  // refresh. Mirrors the Aster Trade.tsx pattern.
  const [livePxByCoin, setLivePxByCoin] = useState<Record<string, number>>({})

  // Recent fills feed — pulled from HL's userFills via /api/hyperliquid/trades.
  // Mirrors the Aster Trade.tsx fills panel so users can audit per-fill fees
  // (the ground truth for builder-fee verification on HL too) and see realized
  // PnL on close fills without leaving for app.hyperliquid.xyz.
  const [fills, setFills]       = useState<HlFill[]>([])
  const [fillsErr, setFillsErr] = useState<string | null>(null)

  // Compact relative-time formatter for the fills feed. Matches the
  // formatter on the Aster Trade page so both venues read identically.
  const ago = (ms: number): string => {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
    if (s < 60)    return `${s}s ago`
    if (s < 3600)  return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  }

  // Order ticket state
  const [orderCoin, setOrderCoin]         = useState('BTC')
  const [orderSide, setOrderSide]         = useState<'LONG' | 'SHORT'>('LONG')
  const [orderType, setOrderType]         = useState<'MARKET' | 'LIMIT'>('MARKET')
  const [orderNotional, setOrderNotional] = useState('25')
  const [orderLeverage, setOrderLeverage] = useState('5')
  const [orderLimitPx, setOrderLimitPx]   = useState('')
  // Optional stop-loss attached to the user's manual entry. Empty string
  // means "no SL". Server places a reduce-only stop-MARKET trigger order
  // (with builder fee attribution) after the entry fills.
  const [orderStopLoss, setOrderStopLoss] = useState('')
  const [placing, setPlacing]             = useState(false)
  const [orderMsg, setOrderMsg]           = useState<string | null>(null)
  // Explicit success/error tag for orderMsg styling. Using regex on the
  // message text was fragile — HL's "Builder has insufficient balance to
  // be approved." error contains the word "approved" and was being styled
  // as a success (green box). Tagging at the call site removes that class
  // of bug entirely. Default true (most setOrderMsg calls are errors).
  const [orderMsgIsErr, setOrderMsgIsErr] = useState<boolean>(true)
  // Set when the backend's order endpoint reports a builder-fee rejection
  // it couldn't auto-heal. Surfaces a manual "Approve builder fee" button.
  const [needsBuilderApproval, setNeedsBuilderApproval] = useState(false)
  const [approvingBuilder, setApprovingBuilder]         = useState(false)
  // Set when the backend says the user isn't onboarded but our cached
  // account state still says they are (server reboot, DB reset, agent
  // creds invalidated, etc). When true, we override the gating so the
  // purple "Activate Hyperliquid Trading" button shows even though
  // account.onboarded === true. Without this, users get permanently
  // stuck staring at an order form that always rejects with no way out.
  const [forceActivateUi, setForceActivateUi] = useState(false)

  const placeOrder = async () => {
    setPlacing(true)
    setOrderMsg(null)
    setOrderMsgIsErr(true)
    setNeedsBuilderApproval(false)
    try {
      const body: any = {
        coin:         orderCoin,
        side:         orderSide,
        type:         orderType,
        notionalUsdc: Number(orderNotional),
        leverage:     Number(orderLeverage),
      }
      if (orderType === 'LIMIT') {
        const px = Number(orderLimitPx)
        if (!Number.isFinite(px) || px <= 0) {
          setOrderMsg('Enter a valid limit price.')
          setOrderMsgIsErr(true)
          setPlacing(false)
          return
        }
        body.limitPx = px
      }
      // Optional stop-loss. Only sent when > 0; server treats undefined
      // as "no SL" and places a reduce-only stop-MARKET trigger when set.
      const slNum = Number(orderStopLoss)
      if (Number.isFinite(slNum) && slNum > 0) {
        body.stopLoss = slNum
      }
      const r = await apiFetch<{
        success: boolean; error?: string; sz?: number; markPrice?: number;
        needsBuilderApproval?: boolean; needsApprove?: boolean;
        stopLoss?: { status: 'placed' | 'skipped' | 'failed'; price?: number; error?: string };
      }>(
        '/api/hyperliquid/order',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
      if (r.success) {
        const px = orderType === 'LIMIT' ? Number(orderLimitPx) : (r.markPrice ?? 0)
        // Surface the SL leg outcome alongside the entry. Failure is non-
        // fatal for the entry but critical for the user to know — silent
        // failure would leave them thinking they're protected when they
        // aren't. Style as an error if the SL leg failed.
        const slBit =
          r.stopLoss?.status === 'placed'
            ? ` Stop loss set at $${fmtUsdRaw(r.stopLoss.price ?? 0)}.`
            : r.stopLoss?.status === 'failed'
              ? ` Stop loss didn't land — ${r.stopLoss.error ?? 'please add it manually'}.`
              : ''
        setOrderMsg(
          `${orderSide} ${r.sz?.toFixed(4) ?? '?'} ${orderCoin} ${orderType} @ $${fmtUsdRaw(px)} ${
            orderType === 'LIMIT' ? 'resting' : 'placed'
          }.${slBit}`,
        )
        setOrderMsgIsErr(r.stopLoss?.status === 'failed')
        if (r.stopLoss?.status !== 'failed') setOrderStopLoss('')
        await load()
      } else {
        setOrderMsg(r.error ?? 'Order failed')
        setOrderMsgIsErr(true)
        // Defense in depth: surface the manual approve button whenever the
        // backend flag OR the raw error text indicates a builder rejection.
        // The flag should always be set by the server, but if a future code
        // path forgets to set it (or HL changes its error wording slightly),
        // matching the message text directly keeps users from getting stuck
        // staring at "Builder fee has not been approved" with no way out.
        const isBuilderReject =
          r.needsBuilderApproval ||
          /(builder|must approve)/i.test(r.error ?? '')
        if (isBuilderReject) setNeedsBuilderApproval(true)
        // Server says we're not onboarded but our cached account.onboarded
        // is true — force the activate UI to show so the user has a path
        // forward instead of an order form that always rejects.
        const needsActivation =
          r.needsApprove ||
          /activate hyperliquid|re-activate/i.test(r.error ?? '')
        if (needsActivation) {
          setForceActivateUi(true)
          load() // re-sync account state from the server
        }
      }
    } catch (e: any) {
      // CRITICAL: the backend returns HTTP 400 for builder rejections (so
      // the success branch above NEVER runs for this case). apiFetch then
      // throws an ApiError, dropping us here. Without inspecting the error
      // for the builder pattern in this catch block, the purple "Approve
      // builder fee" button can never appear — users stare at "Builder fee
      // has not been approved" with no recovery path. We check both the
      // structured body (preferred — it carries the explicit
      // needsBuilderApproval flag) AND the message text (fallback for any
      // future error-shape drift). This was the actual bug behind multiple
      // user reports of the button never showing despite all upstream
      // fixes being in production.
      const msg = e?.message ?? 'Order failed'
      setOrderMsg(msg)
      setOrderMsgIsErr(true)
      const body = e?.body
      const isBuilderReject =
        body?.needsBuilderApproval ||
        /(builder|must approve)/i.test(msg) ||
        /(builder|must approve)/i.test(body?.error ?? '')
      if (isBuilderReject) setNeedsBuilderApproval(true)
      // Same self-heal as the success branch: server says we're not
      // onboarded → flip to activate UI even if cached account says we
      // are. The server returns HTTP 400 for this so we land here, not
      // in the success branch above.
      const needsActivation =
        body?.needsApprove ||
        /activate hyperliquid|re-activate/i.test(msg) ||
        /activate hyperliquid|re-activate/i.test(body?.error ?? '')
      if (needsActivation) {
        setForceActivateUi(true)
        load()
      }
    } finally {
      setPlacing(false)
    }
  }

  const approveBuilder = async () => {
    setApprovingBuilder(true)
    try {
      const r = await apiFetch<{ success: boolean; error?: string }>(
        '/api/hyperliquid/approve-builder',
        { method: 'POST' },
      )
      if (r.success) {
        setNeedsBuilderApproval(false)
        setOrderMsg('Builder fee approved — placing order...')
        setOrderMsgIsErr(false)
        await placeOrder()
      } else {
        setOrderMsg(r.error ?? 'Builder approval failed')
        setOrderMsgIsErr(true)
      }
    } catch (e: any) {
      setOrderMsg(e?.message ?? 'Builder approval failed')
      setOrderMsgIsErr(true)
    } finally {
      setApprovingBuilder(false)
    }
  }

  // Standalone "Re-sign builder approval" — same call as approveBuilder above
  // but does NOT auto-place an order on success. Surfaced as a small always-
  // visible link in the trade panel footer so users whose approval has gone
  // stale (e.g. operator rotated the builder treasury wallet) can refresh it
  // themselves without having to wait for an order to fail and surface the
  // reactive button. One-shot, idempotent, safe to tap repeatedly.
  const [resigning, setResigning] = useState(false)
  const [resignMsg, setResignMsg] = useState<string | null>(null)
  const [resignMsgIsErr, setResignMsgIsErr] = useState(false)
  const resignBuilder = async () => {
    setResigning(true)
    setResignMsg(null)
    try {
      const r = await apiFetch<{ success: boolean; error?: string }>(
        '/api/hyperliquid/approve-builder',
        { method: 'POST' },
      )
      if (r.success) {
        setResignMsg('Builder approval refreshed — your next order will route through BUILD4.')
        setResignMsgIsErr(false)
      } else {
        setResignMsg(r.error ?? 'Approval refresh failed — please try again in a moment.')
        setResignMsgIsErr(true)
      }
    } catch (e: any) {
      setResignMsg(e?.message ?? 'Approval refresh failed — please try again in a moment.')
      setResignMsgIsErr(true)
    } finally {
      setResigning(false)
    }
  }

  // Prefill the limit input with the live mark the moment the user toggles
  // into LIMIT mode — but ONLY once per toggle. After the first prefill the
  // field is "user-owned" so they can clear, edit, or wait for a target
  // price without us re-filling on every mark tick. Resets on toggling
  // back to MARKET so the next LIMIT switch re-prefills with fresh data.
  const [hlLimitPrefilled, setHlLimitPrefilled] = useState(false)
  useEffect(() => {
    if (orderType !== 'LIMIT') {
      if (hlLimitPrefilled) setHlLimitPrefilled(false)
      return
    }
    if (!hlLimitPrefilled && !orderLimitPx && mids[orderCoin] > 0) {
      setOrderLimitPx(mids[orderCoin].toString())
      setHlLimitPrefilled(true)
    }
  }, [orderType, orderCoin, mids, orderLimitPx, hlLimitPrefilled])

  // Distance of the LIMIT price from the live mark + maker/taker heuristic.
  // Identical math to the Aster Trade page so both venues feel the same:
  //   LONG  with limit > mark  → likely crosses immediately as taker
  //   SHORT with limit < mark  → likely crosses immediately as taker
  // Without orderbook depth this is an approximation, but it catches the
  // common error of typing a price on the wrong side of the market.
  const hlLimitMeta = useMemo(() => {
    if (orderType !== 'LIMIT') return null
    const px = Number(orderLimitPx)
    const m  = mids[orderCoin] ?? 0
    if (!Number.isFinite(px) || px <= 0 || m <= 0) return null
    const pct       = ((px - m) / m) * 100
    const above     = pct > 0
    const crossable = (orderSide === 'LONG' && pct > 0) || (orderSide === 'SHORT' && pct < 0)
    return { pct, above, crossable }
  }, [orderType, orderLimitPx, mids, orderCoin, orderSide])

  const activate = async () => {
    setActivating(true)
    setActivateMsg(null)
    try {
      const r = await apiFetch<{ success: boolean; agentAddress?: string; error?: string }>(
        '/api/hyperliquid/approve',
        { method: 'POST' },
      )
      if (r.success) {
        setActivateMsg('Activated! You can now trade Hyperliquid from BUILD4.')
        setForceActivateUi(false) // clear self-heal flag — server should now agree
        await load()
      } else {
        setActivateMsg(r.error ?? 'Activation failed')
      }
    } catch (e: any) {
      setActivateMsg(e?.message ?? 'Activation failed')
    } finally {
      setActivating(false)
    }
  }

  // Close a single open perp position with one tap. Server fetches the live
  // szi, computes the opposite side, and submits a reduce-only IoC market
  // order — see /api/hyperliquid/close. We optimistically lock the row,
  // then refetch the account to reflect the new state (position gone, USDC
  // reflects realized PnL minus taker fee).
  const closePosition = async (coin: string) => {
    if (closingCoin) return
    setClosingCoin(coin)
    setCloseMsg(null)
    try {
      const r = await apiFetch<{ success: boolean; sz?: number; side?: string; error?: string }>(
        '/api/hyperliquid/close',
        // Content-Type MUST be explicit — apiFetch does not set it, and
        // without it express.json() silently drops the body, so the server
        // sees coin=undefined and returns "coin required". (Same reason
        // /order sets it explicitly above.)
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coin }) },
      )
      if (r.success) {
        setCloseMsg(`Closed ${coin} (${r.side ?? ''} ${r.sz ?? ''}). Refreshing…`)
        // Same 1.5s settle pad we use after spot↔perps moves — HL's
        // clearinghouse occasionally lags the fill ack by a beat, and
        // refetching too quickly leaves the position visibly stuck on
        // the card for a confusing extra second.
        await new Promise((res) => setTimeout(res, 1500))
        await load()
      } else {
        setCloseMsg(r.error ?? 'Close failed')
      }
    } catch (e: any) {
      setCloseMsg(e?.message ?? 'Close failed')
    } finally {
      setClosingCoin(null)
    }
  }

  // Spot → perps internal transfer. POSTs to /api/hyperliquid/spot-to-perps
  // which signs a usdClassTransfer EIP-712 with the user's master key (NOT
  // the agent — HL forbids agents from moving funds across sub-accounts).
  // Empty body = move full available balance, which is what the user wants
  // 99% of the time after a fresh deposit.
  const moveSpotToPerps = async () => {
    setMovingSpot(true)
    setSpotMsg(null)
    try {
      const r = await apiFetch<{ success: boolean; amount?: number; error?: string }>(
        '/api/hyperliquid/spot-to-perps',
        { method: 'POST', body: JSON.stringify({}) },
      )
      if (r.success) {
        setSpotMsg(`Moved $${(r.amount ?? 0).toFixed(2)} to perps. Reloading…`)
        // Give HL a beat to settle then refresh — the perps clearinghouse
        // sometimes lags the transfer ack by a second or two.
        await new Promise((res) => setTimeout(res, 1500))
        await load()
      } else {
        setSpotMsg(r.error ?? 'Transfer failed')
      }
    } catch (e: any) {
      setSpotMsg(e?.message ?? 'Transfer failed')
    } finally {
      setMovingSpot(false)
    }
  }

  // Perps → spot internal transfer. Counterpart to moveSpotToPerps. POSTs
  // to /api/hyperliquid/perps-to-spot which signs a usdClassTransfer with
  // toPerp=false using the user's master key. Needed because HL only
  // permits withdrawals to Arbitrum from the spot sub-account, so users
  // who want to take profits have to move free margin off perps first.
  const movePerpsToSpot = async () => {
    setMovingPerps(true)
    setPerpsMsg(null)
    try {
      const r = await apiFetch<{ success: boolean; amount?: number; error?: string }>(
        '/api/hyperliquid/perps-to-spot',
        { method: 'POST', body: JSON.stringify({}) },
      )
      if (r.success) {
        setPerpsMsg(`Moved $${(r.amount ?? 0).toFixed(2)} to spot. Reloading…`)
        await new Promise((res) => setTimeout(res, 1500))
        await load()
      } else {
        setPerpsMsg(r.error ?? 'Transfer failed')
      }
    } catch (e: any) {
      setPerpsMsg(e?.message ?? 'Transfer failed')
    } finally {
      setMovingPerps(false)
    }
  }

  const loadFills = async () => {
    try {
      const r = await apiFetch<{ trades: HlFill[] }>('/api/hyperliquid/trades?limit=10')
      setFills(r.trades); setFillsErr(null)
    } catch (e: any) {
      // Distinguish "couldn't reach HL" from "no fills yet" — silent
      // fallbacks make outages indistinguishable from a clean account.
      // Suppress the not-onboarded case (handled by the activate UI).
      const msg = e?.message ?? 'Could not load fills'
      if (typeof msg === 'string' && /activate hyperliquid/i.test(msg)) return
      setFillsErr(msg)
    }
  }

  const load = async () => {
    setError(null)
    try {
      const acc = await apiFetch<AccountState>('/api/hyperliquid/account')
      setAccount(acc)
      // Only fetch fills after we know the account exists; pulling without
      // an active wallet would just produce a confusing 404 in the panel.
      if (acc.onboarded) loadFills()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load account')
    }
    // Pull arbitrum balance from the wallet endpoint so we can detect when
    // the user has USDC parked on Arbitrum and prompt them to bridge it
    // into Hyperliquid (the most common confusion: depositing USDC to the
    // wallet on Arbitrum does NOT credit HL — it must go to the bridge).
    try {
      const w = await apiFetch<{ arbitrum?: { eth: number; usdc: number } }>('/api/me/wallet')
      if (w.arbitrum) setArb({ usdc: w.arbitrum.usdc, eth: w.arbitrum.eth })
    } catch { /* ignore — bridge card just won't render */ }
    const next: Record<string, number> = {}
    await Promise.all(COINS.map(async c => {
      try {
        const r = await apiFetch<{ markPrice: number }>(`/api/hyperliquid/markprice/${c}`)
        next[c] = r.markPrice
      } catch { next[c] = 0 }
    }))
    setMids(next)
    setLoading(false)
  }

  // Three-tier polling so the screen feels truly "live":
  //   - load() (account + all mids + arbitrum): every 2s — picks up new
  //     positions, balance changes, leverage adjustments quickly
  //   - selected-coin mid: every 1s — keeps the headline price next to
  //     the order ticket alive while sizing
  //   - per-position mark prices: every 1s — so PnL on every open
  //     position ticks in real time
  useEffect(() => { load(); const t = setInterval(load, 1000); return () => clearInterval(t) }, [])
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const r = await apiFetch<{ markPrice: number }>(`/api/hyperliquid/markprice/${orderCoin}`)
        if (!cancelled) setMids(prev => ({ ...prev, [orderCoin]: r.markPrice }))
      } catch { /* keep last value */ }
    }
    poll()
    const t = setInterval(poll, 1000)
    return () => { cancelled = true; clearInterval(t) }
  }, [orderCoin])

  // Live mark-price poll for open positions. Pulls /markprice/:coin for
  // every coin currently in `account.positions` once per second so the
  // detail card's mark + computed PnL tick visibly. Re-subscribes when
  // the set of open coins changes (close → drops, open → adds).
  // isFinite guard: a malformed HL payload that produced NaN szi must
  // not be treated as an open position (NaN !== 0 is true). Backend
  // already coerces in safeNum, but defense-in-depth — a future caller
  // populating account.positions from a different source can't break us.
  const positionCoins = (account?.positions ?? [])
    .filter(p => Number.isFinite(p.szi) && p.szi !== 0)
    .map(p => p.coin)
  useEffect(() => {
    if (positionCoins.length === 0) {
      setLivePxByCoin({})
      return
    }
    let cancelled = false
    const tick = async () => {
      const updates = await Promise.all(positionCoins.map(async (c) => {
        try {
          const r = await apiFetch<{ markPrice: number }>(`/api/hyperliquid/markprice/${c}`)
          return [c, r.markPrice] as const
        } catch { return null }
      }))
      if (cancelled) return
      setLivePxByCoin(prev => {
        const next: Record<string, number> = {}
        // Only carry coins that are still open this tick — drop stale
        // entries from positions the user just closed.
        for (const c of positionCoins) next[c] = prev[c] ?? 0
        for (const u of updates) if (u) next[u[0]] = u[1]
        return next
      })
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => { cancelled = true; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionCoins.join(',')])

  return (
    <div style={{ paddingTop: 20 }} data-testid="page-hyperliquid">
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Hyperliquid</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #9ca3af)', marginTop: 2 }}>
          Perps · USDC · L1 DEX
        </div>
      </div>

      {/* Venue switcher — symmetric to the one on the Trade page so the
          user can hop back to Aster from the same top bar. Without this
          card, landing on /hyperliquid was a one-way trip and the only
          way back to Aster was the bottom-nav Trade tab, which is not
          obvious. HL is the active chip here; Aster is the link. */}
      <div className="card" style={{ padding: 10, marginBottom: 10 }} data-testid="card-venue-switcher">
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>VENUE</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <a
            href="#trade"
            data-testid="link-venue-aster"
            onClick={(e) => {
              e.preventDefault()
              window.dispatchEvent(new CustomEvent('b4-nav', { detail: 'trade' }))
            }}
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: '#1f2937', color: '#cbd5e1', textAlign: 'center',
              textDecoration: 'none', boxSizing: 'border-box',
            }}
          >← Aster · BSC</a>
          <div
            data-testid="venue-hyperliquid-active"
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: '#7c3aed', color: '#fff', textAlign: 'center',
            }}
          >Hyperliquid · USDC</div>
        </div>
      </div>

      {error && (
        <div style={{ ...cardStyle, borderColor: '#ef4444', color: '#ef4444' }} data-testid="text-hl-error">
          {error}
        </div>
      )}

      {/* Terminal block — 24h ticker + chart for the order-ticket coin.
          Lives at the top so the chart is the dominant visual the
          moment you land on the page, just like a serious perp UI.
          Re-renders when `orderCoin` changes via the chip row below. */}
      <MarketTicker symbol={orderCoin} testIdPrefix="hl-ticker" />
      <NativeChart venue="hl" symbol={orderCoin} defaultInterval="15m" height={300} testIdPrefix="hl-chart" />

      {/* Order ticket — only when onboarded AND we haven't been told
          by the server that activation is needed (forceActivateUi). */}
      {account?.onboarded && !forceActivateUi && (
        <div style={cardStyle} data-testid="card-hl-order">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Place order</div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, color: '#9ca3af', letterSpacing: 0.4 }}>{orderCoin} MARK · LIVE</div>
              <div
                data-testid="text-hl-selected-mark"
                style={{ fontSize: 18, fontWeight: 700, color: mids[orderCoin] > 0 ? '#a7f3d0' : '#6b7280', fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}
              >
                {fmtUsd(mids[orderCoin])}
              </div>
            </div>
          </div>

          {/* Coin selector */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {COINS.map(c => (
              <button
                key={c}
                onClick={() => setOrderCoin(c)}
                data-testid={`button-hl-coin-${c}`}
                style={{
                  padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  background: orderCoin === c ? '#7c3aed' : '#1f2937',
                  color: '#fff', border: 'none', cursor: 'pointer',
                }}
              >
                {c}
              </button>
            ))}
          </div>

          {/* LONG / SHORT */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button
              onClick={() => setOrderSide('LONG')}
              data-testid="button-hl-side-long"
              style={{
                flex: 1, padding: '10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: orderSide === 'LONG' ? '#22c55e' : '#1f2937',
                color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              LONG
            </button>
            <button
              onClick={() => setOrderSide('SHORT')}
              data-testid="button-hl-side-short"
              style={{
                flex: 1, padding: '10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: orderSide === 'SHORT' ? '#ef4444' : '#1f2937',
                color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              SHORT
            </button>
          </div>

          {/* MARKET / LIMIT order type */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button
              onClick={() => setOrderType('MARKET')}
              data-testid="button-hl-type-market"
              style={{
                flex: 1, padding: '8px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: orderType === 'MARKET' ? '#8b5cf6' : '#1f2937',
                color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              MARKET
            </button>
            <button
              onClick={() => setOrderType('LIMIT')}
              data-testid="button-hl-type-limit"
              style={{
                flex: 1, padding: '8px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: orderType === 'LIMIT' ? '#8b5cf6' : '#1f2937',
                color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              LIMIT
            </button>
          </div>

          {/* Limit price — only when LIMIT. Lives above size so the user
              can see it ticks as the live mark moves (next to the LIVE
              header readout above). One-tap "Use mark" snaps it to the
              current mid in case they nudged off and want to reset. */}
          {orderType === 'LIMIT' && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                <span>Limit price (USDC)</span>
                {mids[orderCoin] > 0 && (
                  <button
                    onClick={() => setOrderLimitPx(mids[orderCoin].toString())}
                    data-testid="button-hl-limit-use-mark"
                    style={{
                      padding: '0 6px', fontSize: 10, color: '#a78bfa',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                    }}
                  >
                    use mark ${fmtUsdRaw(mids[orderCoin])}
                  </button>
                )}
              </div>
              <input
                type="number"
                value={orderLimitPx}
                onChange={(e) => setOrderLimitPx(e.target.value)}
                placeholder={mids[orderCoin] > 0 ? mids[orderCoin].toString() : '0.00'}
                data-testid="input-hl-limit-px"
                style={{
                  width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
                  background: '#0f172a', border: '1px solid #334155', color: '#fff',
                  boxSizing: 'border-box',
                }}
              />
              {hlLimitMeta && (
                <div
                  style={{
                    fontSize: 11,
                    color: hlLimitMeta.crossable ? '#f59e0b' : '#9ca3af',
                    marginTop: 4,
                    lineHeight: 1.4,
                  }}
                  data-testid="text-hl-limit-distance"
                >
                  {Math.abs(hlLimitMeta.pct).toFixed(2)}% {hlLimitMeta.above ? 'above' : 'below'} mark
                  {hlLimitMeta.crossable
                    ? ' · this side of the book — your order will likely fill immediately as a taker'
                    : ' · should rest as a maker until price reaches it'}
                </div>
              )}
            </div>
          )}

          {/* Stop loss (optional). Placed as a reduce-only stop-MARKET
              trigger after the entry fills. Distance vs mark shown so
              users see what they're risking before submitting. */}
          <div style={{ marginBottom: 10 }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontSize: 11, color: '#9ca3af', marginBottom: 4,
            }}>
              <span>Stop loss <span style={{ color: '#6b7280' }}>· optional</span></span>
              {mids[orderCoin] > 0 && Number(orderStopLoss) > 0 && (() => {
                const m   = mids[orderCoin]
                const sl  = Number(orderStopLoss)
                const pct = ((sl - m) / m) * 100
                const wrongSide =
                  (orderSide === 'LONG'  && sl >= m) ||
                  (orderSide === 'SHORT' && sl <= m)
                return (
                  <span
                    style={{ color: wrongSide ? '#ef4444' : '#9ca3af', fontWeight: 500 }}
                    data-testid="text-hl-sl-distance"
                  >
                    {wrongSide
                      ? (orderSide === 'LONG' ? 'must be below mark' : 'must be above mark')
                      : `${Math.abs(pct).toFixed(2)}% ${pct > 0 ? 'above' : 'below'} mark`}
                  </span>
                )
              })()}
            </div>
            <input
              type="number"
              inputMode="decimal"
              value={orderStopLoss}
              onChange={(e) => setOrderStopLoss(e.target.value)}
              placeholder={
                mids[orderCoin] > 0
                  ? (orderSide === 'LONG'
                      ? `< ${fmtUsdRaw(mids[orderCoin])} (closes if price falls)`
                      : `> ${fmtUsdRaw(mids[orderCoin])} (closes if price rises)`)
                  : 'Trigger price'
              }
              data-testid="input-hl-stop-loss"
              style={{
                width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
                background: '#0f172a', border: '1px solid #334155', color: '#fff',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Notional + leverage */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 2 }}>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Size (USDC)</div>
              <input
                type="number"
                value={orderNotional}
                onChange={(e) => setOrderNotional(e.target.value)}
                data-testid="input-hl-notional"
                style={{
                  width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
                  background: '#0f172a', border: '1px solid #334155', color: '#fff',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Leverage</div>
              <input
                type="number"
                value={orderLeverage}
                onChange={(e) => setOrderLeverage(e.target.value)}
                min="1"
                max="50"
                data-testid="input-hl-leverage"
                style={{
                  width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
                  background: '#0f172a', border: '1px solid #334155', color: '#fff',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          {/* Quick size buttons */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {['10', '25', '100', '500'].map(amt => (
              <button
                key={amt}
                onClick={() => setOrderNotional(amt)}
                data-testid={`button-hl-quick-${amt}`}
                style={{
                  flex: 1, padding: '6px', borderRadius: 6, fontSize: 11,
                  background: '#1f2937', color: '#9ca3af', border: 'none', cursor: 'pointer',
                }}
              >
                ${amt}
              </button>
            ))}
          </div>

          <button
            onClick={placeOrder}
            disabled={placing || !orderNotional || Number(orderNotional) <= 0}
            data-testid="button-hl-place-order"
            style={{
              width: '100%', padding: '12px', borderRadius: 10, fontSize: 14, fontWeight: 600,
              background: placing ? '#4c1d95'
                : orderSide === 'LONG' ? 'linear-gradient(90deg,#16a34a,#22c55e)'
                : 'linear-gradient(90deg,#dc2626,#ef4444)',
              color: '#fff', border: 'none', cursor: placing ? 'wait' : 'pointer',
            }}
          >
            {placing
              ? 'Placing…'
              : `${orderSide} $${orderNotional || '0'} ${orderCoin} ${orderType} @ ${orderLeverage}x`}
          </button>

          {orderMsg && (
            <div
              style={{
                marginTop: 8, padding: 8, borderRadius: 6, fontSize: 11,
                background: orderMsgIsErr ? '#7f1d1d' : '#064e3b',
                color: orderMsgIsErr ? '#fecaca' : '#a7f3d0',
              }}
              data-testid="text-hl-order-msg"
            >
              {orderMsg}
            </div>
          )}

          {needsBuilderApproval && (
            <button
              onClick={approveBuilder}
              disabled={approvingBuilder}
              data-testid="button-hl-approve-builder"
              style={{
                marginTop: 8, width: '100%', padding: '10px', borderRadius: 8,
                fontSize: 13, fontWeight: 600,
                background: approvingBuilder ? '#4c1d95' : 'linear-gradient(90deg,#7c3aed,#a78bfa)',
                color: '#fff', border: 'none', cursor: approvingBuilder ? 'wait' : 'pointer',
              }}
            >
              {approvingBuilder ? 'Approving…' : 'Approve builder fee & retry'}
            </button>
          )}

          <div style={{ fontSize: 10, color: '#64748b', marginTop: 10, lineHeight: 1.4 }}>
            {orderType === 'MARKET'
              ? 'Market orders execute immediately at best available price (5% slippage cap).'
              : 'Limit orders rest on the orderbook (GTC) until filled or cancelled.'}{' '}
            BUILD4 takes a 0.1% builder fee on every fill.{' '}
            <span
              onClick={resigning ? undefined : resignBuilder}
              data-testid="link-hl-resign-builder"
              style={{
                color: resigning ? '#475569' : '#a78bfa',
                cursor: resigning ? 'wait' : 'pointer',
                textDecoration: 'underline',
                whiteSpace: 'nowrap',
              }}
            >
              {resigning ? 'Refreshing approval…' : 'Refresh approval'}
            </span>
          </div>

          {resignMsg && (
            <div
              style={{
                marginTop: 8, padding: 8, borderRadius: 6, fontSize: 11,
                background: resignMsgIsErr ? '#7f1d1d' : '#064e3b',
                color: resignMsgIsErr ? '#fecaca' : '#a7f3d0',
              }}
              data-testid="text-hl-resign-msg"
            >
              {resignMsg}
            </div>
          )}
        </div>
      )}

      {/* Positions — rich detail card per position, mirrors the Aster
          Trade.tsx layout so HL doesn't feel like a downgraded venue.
          Each position shows: coin, side+leverage, size @ entry, mark
          (live, ticks every second), unrealized PnL (live + ROE %),
          margin used, and liquidation price when HL provides one
          (cross-at-full-equity reports liq=0 → we hide that row). */}
      {account && account.positions.filter(p => p.szi !== 0).length > 0 && (
        <div style={cardStyle} data-testid="card-hl-positions">
          <div style={{
            fontSize: 13, fontWeight: 600, marginBottom: 10,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Open positions</span>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 400 }}>
              {account.positions.filter(p => p.szi !== 0).length} open
            </span>
          </div>
          {account.positions.filter(p => p.szi !== 0).map((p) => {
            const isClosingThis = closingCoin === p.coin
            const anyClosing    = closingCoin !== null
            const isLong        = p.szi > 0
            const sideColor     = isLong ? '#22c55e' : '#ef4444'

            // Live mark: fall back to derived (positionValue / szi) from the
            // last full account snapshot if the per-coin poll hasn't landed
            // yet. Avoids a flash of "—" on the first render.
            const snapshotMark = p.szi !== 0 ? Math.abs(p.positionValue / p.szi) : 0
            const liveMark     = livePxByCoin[p.coin] || snapshotMark

            // Recompute PnL on every render against the live mark so the
            // number updates each second instead of being stuck at the
            // last 6s account snapshot. Sign convention: long profits as
            // mark rises, short profits as mark falls.
            const sz       = Math.abs(p.szi)
            const dir      = isLong ? 1 : -1
            const livePnl  = (liveMark - p.entryPx) * sz * dir
            const liveRoe  = p.marginUsed > 0 ? livePnl / p.marginUsed : 0
            const pnlColor = livePnl >= 0 ? '#22c55e' : '#ef4444'

            return (
              <div key={p.coin}
                   data-testid={`row-hl-position-${p.coin}`}
                   style={{
                     padding: 10, borderRadius: 8, marginTop: 8,
                     background: '#0f0f17', border: '1px solid #1f2937',
                     display: 'flex', flexDirection: 'column', gap: 4,
                   }}>
                {/* Header row: coin + side · leverage */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{p.coin}</span>
                  <span style={{ color: sideColor, fontWeight: 600, fontSize: 13 }}>
                    {isLong ? 'LONG' : 'SHORT'} · {p.leverage}x
                    <span style={{ color: '#64748b', fontWeight: 400, fontSize: 11, marginLeft: 4 }}>
                      {p.leverageType}
                    </span>
                  </span>
                </div>

                {/* Size @ entry · mark (live) — both prices with full precision
                    so users can sanity-check their entry against the current
                    market without leaving for a chart. */}
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 12, color: '#94a3b8',
                  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                }}>
                  <span data-testid={`text-hl-position-entry-${p.coin}`}>
                    {fmtUsdRaw(sz)} @ {fmtUsd(p.entryPx)}
                  </span>
                  <span data-testid={`text-hl-position-mark-${p.coin}`}>
                    mark {fmtUsd(liveMark)}
                  </span>
                </div>

                {/* Margin · liquidation. Liq is hidden when HL doesn't compute
                    one (cross at full equity → 0). Margin used is shown so the
                    user knows what's locked behind the position. */}
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 11, color: '#64748b',
                }}>
                  <span data-testid={`text-hl-position-margin-${p.coin}`}>
                    margin {fmtUsd(p.marginUsed)}
                  </span>
                  {p.liquidationPx > 0 && (
                    <span data-testid={`text-hl-position-liq-${p.coin}`}>
                      liq {fmtUsd(p.liquidationPx)}
                    </span>
                  )}
                </div>

                {/* PnL row + Close button. PnL ticks live, ROE shown for
                    quick sanity ("am I 1% up or 30%?" matters more than
                    the dollar amount when sizing varies). */}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  marginTop: 4,
                }}>
                  <span style={{ color: pnlColor, fontWeight: 700, fontSize: 14 }}
                        data-testid={`text-hl-position-pnl-${p.coin}`}>
                    {livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)} USDC
                    <span style={{
                      marginLeft: 6, fontSize: 11, fontWeight: 500,
                      color: pnlColor, opacity: 0.85,
                    }}>
                      ({liveRoe >= 0 ? '+' : ''}{(liveRoe * 100).toFixed(2)}%)
                    </span>
                  </span>
                  <button
                    onClick={() => closePosition(p.coin)}
                    disabled={anyClosing}
                    data-testid={`button-hl-close-${p.coin}`}
                    style={{
                      padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                      background: isClosingThis ? '#374151' : '#ef4444',
                      color: '#fff', border: 'none',
                      cursor: anyClosing ? 'not-allowed' : 'pointer',
                      opacity: anyClosing && !isClosingThis ? 0.5 : 1,
                    }}>
                    {isClosingThis ? 'Closing…' : 'Close'}
                  </button>
                </div>
              </div>
            )
          })}
          {closeMsg && (
            <div data-testid="text-hl-close-msg"
                 style={{
                   marginTop: 10, padding: '8px 10px', borderRadius: 6, fontSize: 12,
                   background: closeMsg.toLowerCase().startsWith('closed')
                     ? '#14532d' : '#7f1d1d',
                   color: '#fff',
                 }}>
              {closeMsg}
            </div>
          )}
        </div>
      )}

      {/* Recent fills — pulled from HL's userFills endpoint via
          /api/hyperliquid/trades. Each row shows the actual fee HL
          charged on the fill (USDC), which is the ground truth for fee
          accounting. Mirror of the Aster Trade.tsx panel so users have
          a single mental model across both venues. */}
      {account?.onboarded && !forceActivateUi && (
        <div style={cardStyle} data-testid="card-hl-fills">
          <div style={{
            fontSize: 13, fontWeight: 600, marginBottom: 10,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Recent fills</span>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 400 }}>
              last {fills.length}
            </span>
          </div>
          {fillsErr ? (
            <div style={{ fontSize: 13, color: '#ef4444' }} data-testid="text-hl-fills-error">
              Could not load fills: {fillsErr}
            </div>
          ) : fills.length === 0 ? (
            <div style={{ fontSize: 13, color: '#64748b' }} data-testid="text-hl-no-fills">
              No fills yet on this account.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {fills.map((f) => {
                const notional = f.px * f.sz
                // bps math: HL fees are always quoted in USDC and notional is
                // px*sz in USDC, so the denominations always match. No need
                // for the commissionAsset guard we use on Aster.
                const feeBps = notional > 0 ? (f.fee / notional) * 10000 : 0
                const isBuy  = f.side === 'B'
                const sideColor = isBuy ? '#22c55e' : '#ef4444'
                // HL's `dir` is the canonical "what did this trade do" label.
                // Falls back to BUY/SELL when missing (older fills).
                const label = f.dir || (isBuy ? 'BUY' : 'SELL')
                return (
                  <div
                    key={`${f.tid}-${f.time}`}
                    data-testid={`row-hl-fill-${f.tid}`}
                    style={{
                      padding: 10, borderRadius: 8,
                      background: '#0f0f17', border: '1px solid #1f2937',
                      display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 600 }}>
                        <span style={{ color: sideColor }}>{label}</span>
                        <span style={{ marginLeft: 6 }}>{f.coin}</span>
                      </span>
                      <span style={{ color: '#64748b' }}>{ago(f.time)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                      <span>{f.sz} @ {fmtUsd(f.px)}</span>
                      <span>${notional.toFixed(2)} notional</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                      <span>
                        fee {f.fee.toFixed(6)} USDC
                        {feeBps > 0 && (
                          <span style={{ color: '#64748b', marginLeft: 6 }}>
                            ({feeBps.toFixed(2)} bps)
                          </span>
                        )}
                      </span>
                      {f.closedPnl !== 0 && (
                        <span style={{ color: f.closedPnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                          {f.closedPnl >= 0 ? '+' : ''}{f.closedPnl.toFixed(4)} PnL
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Account state */}
      <div style={cardStyle} data-testid="card-hl-account">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Your account</div>
        {loading && !account ? (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div>
        ) : account ? (
          <div>
            {/* Surface the wallet address we're querying so the user can
                verify it matches where they actually deposited. Silent
                $0.00 + wrong-address mismatch was a real source of
                confusion. Click-to-copy + open-on-hyperliquid.xyz. */}
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
                padding: '6px 8px', background: '#0a0a12',
                border: '1px solid #1e1e2e', borderRadius: 6,
              }}
              data-testid="text-hl-wallet-address"
            >
              <span style={{ fontSize: 11, color: '#94a3b8' }}>Address</span>
              <code
                style={{
                  flex: 1, color: '#e5e7eb', fontSize: 11,
                  fontFamily: 'ui-monospace, Menlo, monospace',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                title={account.walletAddress}
              >
                {account.walletAddress}
              </code>
              <button
                data-testid="button-hl-copy-address"
                onClick={() => navigator.clipboard?.writeText(account.walletAddress)}
                style={{
                  padding: '2px 6px', background: 'transparent',
                  border: '1px solid #1e1e2e', color: '#a78bfa',
                  borderRadius: 4, fontSize: 10, cursor: 'pointer',
                }}
              >
                Copy
              </button>
              <a
                data-testid="link-hl-explorer"
                href={`https://app.hyperliquid.xyz/explorer/address/${account.walletAddress}`}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: '2px 6px', background: 'transparent',
                  border: '1px solid #1e1e2e', color: '#a78bfa',
                  borderRadius: 4, fontSize: 10, textDecoration: 'none',
                }}
              >
                View on HL ↗
              </a>
            </div>
            {/* Helpful hint when perps balance is empty.
                Two distinct cases, two distinct fixes:

                A) Funds already on HL but parked on the SPOT sub-account
                   (the most common confusion: bridges land on spot, perps
                   shows $0). One-tap fix in-app via /spot-to-perps. We
                   keep the user inside the mini-app — no detour to
                   app.hyperliquid.xyz.

                B) No funds on HL at all but USDC on Arbitrum — handled
                   by the existing Activate flow further down. */}
            {/* Unified-account hint — shown instead of the move-to-perps
                CTA when HL has merged this user's spot+perps margin. The
                button would always fail (HL rejects with "Action disabled
                when unified account is active") AND it's pointless because
                spot USDC is already usable for perps in unified mode. We
                simply tell the user that and surface the combined balance. */}
            {account.unifiedAccount && account.spotUsdc > 0 && (
              <div
                data-testid="card-hl-unified-hint"
                style={{
                  marginBottom: 8, padding: 10, borderRadius: 8,
                  background: '#0f1d33', color: '#bfdbfe', fontSize: 12,
                  lineHeight: 1.45, border: '1px solid #1e3a8a',
                }}
              >
                <b>HL Unified Account active.</b> Your{' '}
                ${(account.spotUsdc + account.accountValue).toFixed(2)} is
                already usable for perps trading — no transfer needed. Tap{' '}
                <b>Activate Hyperliquid Trading</b> below if you haven't yet,
                then place an order.
              </div>
            )}
            {!account.unifiedAccount && account.accountValue === 0 && account.spotUsdc > 0 && (
              <div
                data-testid="card-hl-spot-hint"
                style={{
                  marginBottom: 8, padding: 10, borderRadius: 8,
                  background: '#1e1b4b', color: '#ddd6fe', fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                <div style={{ marginBottom: 8 }}>
                  You have <b>${account.spotUsdc.toFixed(2)} USDC on your HL spot account</b>{' '}
                  but $0 on perps. HL keeps spot and perps as separate sub-accounts —
                  move it across to start trading.
                </div>
                <button
                  onClick={moveSpotToPerps}
                  disabled={movingSpot}
                  data-testid="button-hl-spot-to-perps"
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: 8,
                    background: movingSpot ? '#4c1d95' : 'linear-gradient(90deg,#7c3aed,#a78bfa)',
                    color: '#fff', border: 'none', fontSize: 13, fontWeight: 600,
                    cursor: movingSpot ? 'wait' : 'pointer',
                  }}
                >
                  {movingSpot
                    ? 'Moving…'
                    : `Move $${account.spotUsdc.toFixed(2)} to Perps`}
                </button>
                {spotMsg && (
                  <div
                    data-testid="text-hl-spot-msg"
                    style={{
                      marginTop: 8, padding: 6, borderRadius: 4, fontSize: 11,
                      background: spotMsg.startsWith('Moved') ? '#064e3b' : '#7f1d1d',
                      color: spotMsg.startsWith('Moved') ? '#a7f3d0' : '#fecaca',
                    }}
                  >
                    {spotMsg}
                  </div>
                )}
              </div>
            )}
            {account.accountValue === 0 && account.spotUsdc === 0 && (arb?.usdc ?? 0) > 0 && (
              <div
                data-testid="text-hl-bridge-hint"
                style={{
                  marginBottom: 8, padding: 8, borderRadius: 6,
                  background: '#1e1b4b', color: '#c4b5fd', fontSize: 11,
                  lineHeight: 1.4,
                }}
              >
                You have <b>${arb!.usdc.toFixed(2)} USDC on Arbitrum</b> but $0 on Hyperliquid.
                USDC must be bridged into HL before it can be traded. Tap Activate
                below to bridge it automatically.
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>Withdrawable USDC</span>
              <span style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-hl-withdrawable">
                ${account.withdrawableUsdc.toFixed(2)}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>
                {account.unifiedAccount ? 'Perps account value' : 'Account value'}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-hl-account-value">
                ${account.accountValue.toFixed(2)}
              </span>
            </div>
            {/* Unified accounts share collateral between spot and perps. Show
                the spot USDC explicitly so the $0 / $0 perps rows above don't
                look contradictory next to the "$X usable" hint. Without this
                a user with $105 on spot sees three zero rows and thinks the
                page is broken. */}
            {account.unifiedAccount && account.spotUsdc > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>Spot USDC (usable for perps)</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#a7f3d0' }} data-testid="text-hl-spot-usdc">
                  ${account.spotUsdc.toFixed(2)}
                </span>
              </div>
            )}
            {/* Perps → spot move. HL withdrawals to Arbitrum are only
                possible from the spot sub-account, so users who want to
                take profits need a one-tap way to sweep free margin
                across without leaving for app.hyperliquid.xyz. Only
                surfaces when there's actually free margin to move and
                the user is onboarded (avoids cluttering empty/onboard
                states). Mirrors the spot→perps button above. */}
            {!account.unifiedAccount && account.onboarded && account.withdrawableUsdc >= 0.01 && (
              <div style={{ marginTop: 10 }} data-testid="card-hl-perps-to-spot">
                <button
                  onClick={movePerpsToSpot}
                  disabled={movingPerps}
                  data-testid="button-hl-perps-to-spot"
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: 8,
                    background: movingPerps ? '#1e3a8a' : 'linear-gradient(90deg,#2563eb,#60a5fa)',
                    color: '#fff', border: 'none', fontSize: 13, fontWeight: 600,
                    cursor: movingPerps ? 'wait' : 'pointer',
                  }}
                >
                  {movingPerps
                    ? 'Moving…'
                    : `Move $${account.withdrawableUsdc.toFixed(2)} to Spot (for withdrawal)`}
                </button>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 6, lineHeight: 1.4 }}>
                  HL withdrawals to Arbitrum can only be made from the spot account.
                  Move free margin here first, then withdraw from your wallet.
                </div>
                {perpsMsg && (
                  <div
                    data-testid="text-hl-perps-msg"
                    style={{
                      marginTop: 8, padding: 6, borderRadius: 4, fontSize: 11,
                      background: perpsMsg.startsWith('Moved') ? '#064e3b' : '#7f1d1d',
                      color: perpsMsg.startsWith('Moved') ? '#a7f3d0' : '#fecaca',
                    }}
                  >
                    {perpsMsg}
                  </div>
                )}
              </div>
            )}
            {(!account.onboarded || forceActivateUi) && (
              <div style={{ marginTop: 12 }} data-testid="card-hl-onboard">
                <button
                  onClick={activate}
                  disabled={activating}
                  data-testid="button-hl-activate"
                  style={{
                    width: '100%', padding: '12px 16px', borderRadius: 10,
                    background: activating ? '#4c1d95' : 'linear-gradient(90deg,#7c3aed,#a78bfa)',
                    color: '#fff', border: 'none', fontSize: 14, fontWeight: 600,
                    cursor: activating ? 'wait' : 'pointer',
                  }}
                >
                  {activating ? 'Activating…' : 'Activate Hyperliquid Trading'}
                </button>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8, lineHeight: 1.4 }}>
                  {/* Unified-account users with spot USDC don't need any
                      bridging — HL already treats their spot funds as perps
                      collateral. Showing them the "needs $5 on Arbitrum"
                      warning was the bug ("$105 already usable" vs "$0 on
                      Arb, needs $5"): the backend used to gate on perps
                      accountValue alone and would reject the call. Now both
                      the backend gate and this copy treat spot USDC as
                      sufficient funding when unified is on. */}
                  {account.unifiedAccount && account.spotUsdc >= 1 ? (
                    <>
                      One tap. We authorise a BUILD4 agent wallet to place orders
                      on your behalf — no bridging needed, your{' '}
                      <b style={{ color: '#a7f3d0' }}>
                        ${account.spotUsdc.toFixed(2)} USDC on HL spot
                      </b>{' '}
                      already collateralises perps in unified-account mode. Your
                      master key never leaves the server.
                    </>
                  ) : (
                    <>
                      One tap. We bridge your Arbitrum USDC into Hyperliquid automatically
                      (~1 minute) and authorise a BUILD4 agent wallet to place orders for
                      you. You stay in custody — your master key never leaves the server.
                      {(arb?.usdc ?? 0) >= 5 && (
                        <>
                          {' '}<b style={{ color: '#a7f3d0' }}>
                            ${arb!.usdc.toFixed(2)} USDC on Arbitrum will be bridged.
                          </b>
                        </>
                      )}
                      {(arb?.usdc ?? 0) > 0 && (arb?.usdc ?? 0) < 5 && (
                        <>
                          {' '}<b style={{ color: '#fecaca' }}>
                            You have ${arb!.usdc.toFixed(2)} USDC — Hyperliquid needs at least $5 to start.
                          </b>
                        </>
                      )}
                      {(arb?.usdc ?? 0) === 0 && (
                        <>
                          {' '}<b style={{ color: '#fecaca' }}>
                            Send native USDC on Arbitrum to your wallet first, then tap Activate.
                          </b>
                        </>
                      )}
                    </>
                  )}
                </div>
                {activateMsg && (
                  <div
                    style={{
                      marginTop: 8, padding: 8, borderRadius: 6, fontSize: 11,
                      background: activateMsg.startsWith('Activated') ? '#064e3b' : '#7f1d1d',
                      color: activateMsg.startsWith('Activated') ? '#a7f3d0' : '#fecaca',
                    }}
                    data-testid="text-hl-activate-msg"
                  >
                    {activateMsg}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>No account yet.</div>
        )}
      </div>

      {/* Live mids */}
      <div style={cardStyle} data-testid="card-hl-mids">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Live prices</div>
        {COINS.map(c => (
          <div key={c}
               style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid #1f2937' }}
               data-testid={`row-hl-mid-${c}`}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{c}</span>
            <span style={{ fontSize: 13, color: mids[c] > 0 ? '#fff' : '#6b7280' }}>
              {fmtUsd(mids[c])}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

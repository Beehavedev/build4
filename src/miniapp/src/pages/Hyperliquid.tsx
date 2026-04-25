// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid page — first-pass landing.
//
// Shows the user's HL clearinghouse state (USDC withdrawable, account value,
// open positions) plus live mids for the major perp pairs. If the user
// hasn't approved an agent yet, a "Coming soon" CTA is shown for the
// onboarding flow (handled in a follow-up — needs approveAgent on-chain
// signature with the user's BSC PK).
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react'
import { apiFetch } from '../api'
import { TradingChart } from '../components/TradingChart'
import { MarketTicker } from '../components/MarketTicker'

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'HYPE', 'DOGE']

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
  positions:        Array<{ coin: string; szi: number; entryPx: number; unrealizedPnl: number }>
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

  // Order ticket state
  const [orderCoin, setOrderCoin]         = useState('BTC')
  const [orderSide, setOrderSide]         = useState<'LONG' | 'SHORT'>('LONG')
  const [orderType, setOrderType]         = useState<'MARKET' | 'LIMIT'>('MARKET')
  const [orderNotional, setOrderNotional] = useState('25')
  const [orderLeverage, setOrderLeverage] = useState('5')
  const [orderLimitPx, setOrderLimitPx]   = useState('')
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
      const r = await apiFetch<{
        success: boolean; error?: string; sz?: number; markPrice?: number;
        needsBuilderApproval?: boolean; needsApprove?: boolean
      }>(
        '/api/hyperliquid/order',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
      if (r.success) {
        const px = orderType === 'LIMIT' ? Number(orderLimitPx) : (r.markPrice ?? 0)
        setOrderMsg(
          `${orderSide} ${r.sz?.toFixed(4) ?? '?'} ${orderCoin} ${orderType} @ $${px.toFixed(2)} ${
            orderType === 'LIMIT' ? 'resting' : 'placed'
          }.`,
        )
        setOrderMsgIsErr(false)
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

  // When the user flips MARKET → LIMIT for the first time, prefill with the
  // live mark so they can nudge from a sensible starting point. We only
  // prefill if the field is empty — never clobber a price they already typed.
  useEffect(() => {
    if (orderType === 'LIMIT' && !orderLimitPx && mids[orderCoin] > 0) {
      setOrderLimitPx(mids[orderCoin].toString())
    }
  }, [orderType, orderCoin, mids, orderLimitPx])

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

  const load = async () => {
    setError(null)
    try {
      const acc = await apiFetch<AccountState>('/api/hyperliquid/account')
      setAccount(acc)
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

  // Two-tier polling so users see a "live" mark price without us hammering
  // the public allMids endpoint with full account-state fetches every second.
  //   - load() (account + all mids + arbitrum): every 8s
  //   - selected-coin mid only: every 1s, so the headline price next to the
  //     order ticket actually feels alive while you're sizing your trade.
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t) }, [])
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

  return (
    <div style={{ paddingTop: 20 }} data-testid="page-hyperliquid">
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Hyperliquid</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #9ca3af)', marginTop: 2 }}>
          Perps · USDC · L1 DEX
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
      <TradingChart symbol={orderCoin} defaultInterval="15" height={300} testIdPrefix="hl-chart" />

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
            {account.accountValue === 0 && account.spotUsdc > 0 && (
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
              <span style={{ fontSize: 12, color: '#9ca3af' }}>Account value</span>
              <span style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-hl-account-value">
                ${account.accountValue.toFixed(2)}
              </span>
            </div>
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

      {/* Positions */}
      {account && account.positions.length > 0 && (
        <div style={cardStyle} data-testid="card-hl-positions">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Open positions</div>
          {account.positions.map((p) => (
            <div key={p.coin}
                 style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid #1f2937' }}
                 data-testid={`row-hl-position-${p.coin}`}>
              <span style={{ fontSize: 13 }}>
                <b>{p.coin}</b>{' '}
                <span style={{ color: p.szi > 0 ? '#22c55e' : '#ef4444' }}>
                  {p.szi > 0 ? 'LONG' : 'SHORT'}
                </span>
              </span>
              <span style={{ fontSize: 12, color: p.unrealizedPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                {p.unrealizedPnl >= 0 ? '+' : ''}${p.unrealizedPnl.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}

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
                {mids[orderCoin] > 0
                  ? `$${mids[orderCoin].toLocaleString(undefined, { maximumFractionDigits: mids[orderCoin] < 1 ? 5 : 2 })}`
                  : '—'}
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
                    use mark ${mids[orderCoin].toLocaleString(undefined, { maximumFractionDigits: mids[orderCoin] < 1 ? 5 : 2 })}
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
            </div>
          )}

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
            BUILD4 takes a 0.1% builder fee on every fill.
          </div>
        </div>
      )}

      {/* Live mids */}
      <div style={cardStyle} data-testid="card-hl-mids">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Live prices</div>
        {COINS.map(c => (
          <div key={c}
               style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid #1f2937' }}
               data-testid={`row-hl-mid-${c}`}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{c}</span>
            <span style={{ fontSize: 13, color: mids[c] > 0 ? '#fff' : '#6b7280' }}>
              {mids[c] > 0 ? `$${mids[c].toLocaleString(undefined, { maximumFractionDigits: mids[c] < 1 ? 5 : 2 })}` : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { apiFetch } from '../api'

interface WalletInfo {
  address: string
  chain: string
  label: string
  pinProtected: boolean
  balances: { usdt: number; bnb: number; error: string | null }
  arbitrum?: { eth: number; usdc: number; error: string | null }
  aster: { usdt: number; availableMargin: number; onboarded: boolean; error: string | null }
  hyperliquid?: { usdc: number; accountValue: number; onboarded: boolean; error: string | null }
  xlayer?: { okb: number; error: string | null }
  polygon?: {
    eoa:  { address: string; usdcE: number; matic: number; error: string | null }
    safe: { address: string | null; usdcE: number; deployed: boolean; ready: boolean; error: string | null }
    hasCreds: boolean
  }
  qrDataUrl: string
}

// Wallet state machine — derived from server response, not stored.
//   A: not onboarded, BSC empty       → fund-only
//   B: not onboarded, BSC has USDT    → "Activate Trading Account" CTA
//   C: onboarded, Aster empty         → "Transfer to Aster" CTA
//   D: onboarded, Aster has balance   → full trading-ready UI
type WalletState = 'A' | 'B' | 'C' | 'D'

function deriveState(w: WalletInfo): WalletState {
  if (!w.aster.onboarded) {
    return w.balances.usdt > 0 ? 'B' : 'A'
  }
  return w.aster.usdt > 0 ? 'D' : 'C'
}

export default function Wallet() {
  const [w, setW] = useState<WalletInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async () => {
    setLoading(true); setErr(null)
    try {
      const data = await apiFetch<WalletInfo>('/api/me/wallet')
      setW(data)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load wallet')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      const tg = (window as any).Telegram?.WebApp
      if (tg?.showAlert) tg.showAlert(text)
    }
  }

  if (loading) {
    return (
      <div style={{ paddingTop: 60, textAlign: 'center', color: 'var(--b4-muted)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>💳</div>
        Loading wallet…
      </div>
    )
  }
  if (err || !w) {
    return (
      <div style={{ paddingTop: 60, textAlign: 'center' }}>
        <div style={{ color: 'var(--b4-red)', marginBottom: 12 }}>{err ?? 'No wallet'}</div>
        <button className="btn-primary" onClick={load} data-testid="button-wallet-retry">Retry</button>
      </div>
    )
  }

  const state = deriveState(w)

  const short = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`

  return (
    <div style={{ paddingTop: 20 }} data-testid={`wallet-state-${state}`}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>💳 Wallet</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{w.label}</div>
      </div>

      {/* Address strip — always visible at the top so users can fund from
          any state without hunting for the QR card. One-tap copy. */}
      <div
        className="card"
        data-testid="card-address-strip"
        style={{
          marginBottom: 14,
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 0.4, fontWeight: 600 }}>
            DEPOSIT ADDRESS · BSC
          </div>
          <div
            data-testid="text-address-short"
            style={{
              fontSize: 13,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              color: 'var(--text-primary)',
              marginTop: 2,
            }}
          >
            {short}
          </div>
        </div>
        <button
          onClick={() => copy(w.address)}
          data-testid="button-copy-address-strip"
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: copied ? 'rgba(0,192,118,0.16)' : 'var(--bg-elevated)',
            color: copied ? 'var(--green)' : 'var(--text-primary)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {copied ? '✓ Copied' : '📋 Copy'}
        </button>
      </div>

      {/* Balance cards — Aster on top in onboarded states (D especially) so
          users see their tradeable equity first. */}
      {state === 'D' ? (
        <>
          <AsterPrimaryCard w={w} />
          <HyperliquidCard w={w} />
          <BscSecondaryCard w={w} onChange={load} copy={copy} copied={copied} />
        </>
      ) : (
        <>
          <BscPrimaryCard w={w} onChange={load} copy={copy} copied={copied} />
          {w.aster.onboarded && <AsterSecondaryCard w={w} onReactivated={load} />}
          <HyperliquidCard w={w} />
        </>
      )}

      {/* State-specific CTA */}
      {state === 'A' && <FundFlow w={w} copy={copy} copied={copied} onRefresh={load} />}
      {state === 'B' && <ActivateFlow onActivated={load} />}
      {state === 'C' && <TransferFlow w={w} onDone={load} initialDirection="to_aster" />}
      {state === 'D' && <TradingReadyFlow w={w} onDone={load} copy={copy} copied={copied} />}

      {/* Secondary actions — collapsed by default to keep the wallet
          screen focused on funding/trading. Most users hit Wallet for
          balances and deposits, not for airdrop linking or cross-chain
          bridging. The header summarises both behind a single tap. */}
      <SecondaryActions copy={copy} recipient={w.address} />
    </div>
  )
}

// Collapsible wrapper around the airdrop link card and the bridge card.
// Both children are mounted lazily (only when expanded) — that means
// LinkB4HolderCard's /api/me/link-wallet fetch fires on first open, not
// on page mount, which matches the "secondary, opt-in" framing of this
// section. If we ever want to surface a "Linked ✓" badge in the
// collapsed summary line, hoist that one query up to this component.
function SecondaryActions({ copy, recipient }: { copy: (s: string) => Promise<void>; recipient: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="card"
      style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}
      data-testid="card-secondary-actions"
    >
      <button
        onClick={() => setOpen(o => !o)}
        data-testid="button-toggle-secondary"
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', background: 'transparent', border: 'none',
          color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>More options</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            Link a $B4 holder wallet · Bridge from another chain
          </div>
        </div>
        <span
          aria-hidden
          style={{
            fontSize: 16, color: 'var(--text-secondary)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
          }}
        >›</span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border)' }}>
          <div style={{ marginTop: 12 }}>
            <LinkB4HolderCard copy={copy} />
          </div>
          <BridgeCard recipient={recipient} />
        </div>
      )}
    </div>
  )
}

// ─── $B4 holder wallet link ─────────────────────────────────────────────────
// Telegram WebApp doesn't inject window.ethereum, so we run a manual
// copy-message → sign in external wallet → paste signature flow. The
// backend (already wired) verifies the signature, reads the user's $B4
// balance from BSC, and stores it on the User row. Airdrop allocations
// are computed against that linked address.

interface LinkWalletState {
  linked: boolean
  address: string | null
  balance: number
  linkedAt: string | null
  challenge: { issuedAt: string; tokenAddress: string }
}

declare global {
  interface Window {
    Telegram?: { WebApp: any }
  }
}

function buildLinkChallengeText(opts: { telegramId: string; address: string; issuedAt: string }): string {
  return [
    'Sign to link your wallet to BUILD4.',
    '',
    `Telegram ID: ${opts.telegramId}`,
    `Wallet: ${opts.address.toLowerCase()}`,
    `Issued: ${opts.issuedAt}`,
    '',
    'Only sign this if you initiated this action in @Build4ai_bot.',
  ].join('\n')
}

function LinkB4HolderCard({ copy }: { copy: (s: string) => Promise<void> }) {
  const [state, setState]   = useState<LinkWalletState | null>(null)
  const [loading, setLoading] = useState(true)
  const [addr, setAddr]     = useState('')
  const [sig, setSig]       = useState('')
  const [busy, setBusy]     = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const r = await apiFetch<LinkWalletState>('/api/me/link-wallet')
      setState(r)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load link state')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const telegramId = (window as any).Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString?.() ?? ''
  // No telegramId = no auth context = the BE can't tie the signature to
  // a user. Block the flow here with a clear message rather than letting
  // the user sign a message that the server will reject after the fact.
  const hasTelegramCtx = telegramId.length > 0
  const challengeText = state && hasTelegramCtx && addr.match(/^0x[0-9a-fA-F]{40}$/)
    ? buildLinkChallengeText({ telegramId, address: addr, issuedAt: state.challenge.issuedAt })
    : null

  const submit = async () => {
    setErr(null)
    if (!hasTelegramCtx) {
      setErr('This page must be opened from inside Telegram so we can verify your account.')
      return
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setErr('Address must be a 0x-prefixed 40-hex EVM address.')
      return
    }
    if (!sig.trim().startsWith('0x')) {
      setErr('Signature must be the 0x-prefixed hex blob from your wallet.')
      return
    }
    if (!state) return
    setBusy(true)
    try {
      const r = await apiFetch<{ success: boolean; error?: string; address?: string; balance?: number }>(
        '/api/me/link-wallet',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: addr, signature: sig.trim(), issuedAt: state.challenge.issuedAt }),
        },
      )
      if (!r.success) {
        setErr(r.error ?? 'Link failed.')
      } else {
        setAddr(''); setSig('')
        await load()
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Link failed.')
    } finally {
      setBusy(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true); setErr(null)
    try {
      await apiFetch<{ success: boolean; balance?: number; error?: string }>(
        '/api/me/link-wallet/refresh', { method: 'POST' },
      )
      await load()
    } catch (e: any) {
      setErr(e?.message ?? 'Refresh failed.')
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) {
    return (
      <div className="card" style={{ marginTop: 14, padding: 14 }} data-testid="card-link-b4-loading">
        <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 6 }}>$B4 HOLDER LINK</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</div>
      </div>
    )
  }

  if (state?.linked && state.address) {
    return (
      <div className="card" style={{ marginTop: 14, padding: 14 }} data-testid="card-link-b4-linked">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>$B4 HOLDER WALLET ✓</div>
          <button
            onClick={refresh}
            disabled={refreshing}
            data-testid="button-refresh-b4-balance"
            style={{
              padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--bg-elevated)', color: 'var(--text-primary)',
              fontSize: 11, fontWeight: 600, cursor: refreshing ? 'wait' : 'pointer',
            }}
          >
            {refreshing ? '…' : '↻ Refresh'}
          </button>
        </div>
        <div style={{
          fontSize: 13, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          color: 'var(--text-primary)', wordBreak: 'break-all', marginBottom: 6,
        }} data-testid="text-linked-b4-address">
          {state.address}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }} data-testid="text-linked-b4-balance">
            {(state.balance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
          <div style={{ fontSize: 12, color: 'var(--b4-muted)' }}>$B4 (BSC)</div>
        </div>
        {state.linkedAt && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
            Verified {new Date(state.linkedAt).toLocaleString()}
          </div>
        )}
        {err && <div style={{ color: 'var(--b4-red)', fontSize: 12, marginTop: 8 }}>{err}</div>}
      </div>
    )
  }

  // Unlinked — manual paste flow.
  return (
    <div className="card" style={{ marginTop: 14, padding: 14 }} data-testid="card-link-b4-unlinked">
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 6 }}>$B4 HOLDER LINK</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
        Prove you own an external wallet that holds $B4 to be included in the
        snapshot + airdrop. No tokens move.
      </div>

      <label style={{ fontSize: 11, color: 'var(--b4-muted)', display: 'block', marginBottom: 4 }}>
        1. Your wallet address
      </label>
      <input
        type="text"
        placeholder="0x…"
        value={addr}
        onChange={(e) => setAddr(e.target.value.trim())}
        data-testid="input-link-b4-address"
        spellCheck={false}
        autoCapitalize="off"
        style={{
          width: '100%', padding: '8px 10px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-primary)', fontSize: 13,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', marginBottom: 10,
        }}
      />

      {challengeText && (
        <>
          <label style={{ fontSize: 11, color: 'var(--b4-muted)', display: 'block', marginBottom: 4 }}>
            2. Sign this exact message in your wallet
          </label>
          <div style={{
            padding: 10, borderRadius: 6, background: 'var(--bg-elevated)',
            border: '1px solid var(--border)', fontSize: 11,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
            marginBottom: 6, maxHeight: 140, overflow: 'auto',
          }}>{challengeText}</div>
          <button
            onClick={() => copy(challengeText)}
            data-testid="button-copy-link-challenge"
            style={{
              padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--bg-elevated)', color: 'var(--text-primary)',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', marginBottom: 12,
            }}
          >
            📋 Copy message
          </button>
        </>
      )}

      <label style={{ fontSize: 11, color: 'var(--b4-muted)', display: 'block', marginBottom: 4 }}>
        3. Paste the signature
      </label>
      <textarea
        placeholder="0x…"
        value={sig}
        onChange={(e) => setSig(e.target.value)}
        data-testid="input-link-b4-signature"
        spellCheck={false}
        autoCapitalize="off"
        rows={3}
        style={{
          width: '100%', padding: '8px 10px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-primary)', fontSize: 12,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          marginBottom: 10, resize: 'vertical',
        }}
      />

      {err && <div style={{ color: 'var(--b4-red)', fontSize: 12, marginBottom: 8 }} data-testid="text-link-b4-error">{err}</div>}

      <button
        className="btn-primary"
        disabled={busy || !addr || !sig || !challengeText}
        onClick={submit}
        data-testid="button-link-b4-submit"
        style={{ width: '100%' }}
      >
        {busy ? 'Verifying…' : 'Link wallet'}
      </button>
    </div>
  )
}

// ─── Cross-chain bridges ────────────────────────────────────────────────────
// Pure deeplinks — opens the partner's bridge UI in a new tab with the
// destination chain + recipient prefilled. No custody, no contract.

function BridgeCard({ recipient }: { recipient: string }) {
  const links: Array<{ id: string; label: string; sub: string; href: string }> = [
    {
      id:    'okx-bsc-xlayer',
      label: 'BNB Smart Chain → XLayer',
      sub:   'OKX Bridge · OKB gas',
      href:  `https://www.okx.com/web3/bridge?fromChainId=56&toChainId=196&toAddress=${recipient}`,
    },
    {
      id:    'stargate-bsc-arb',
      label: 'BNB Smart Chain → Arbitrum',
      sub:   'Stargate · USDC/USDT',
      href:  `https://stargate.finance/bridge?srcChain=bnb&dstChain=arbitrum&dstAddress=${recipient}`,
    },
    {
      id:    'okx-arb-xlayer',
      label: 'Arbitrum → XLayer',
      sub:   'OKX Bridge · USDC',
      href:  `https://www.okx.com/web3/bridge?fromChainId=42161&toChainId=196&toAddress=${recipient}`,
    },
  ]

  return (
    <div className="card" style={{ marginTop: 14, padding: 14 }} data-testid="card-bridge">
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>BRIDGE</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
        Move funds between chains. Destination is pre-filled with your BUILD4 wallet.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {links.map((l) => (
          <a
            key={l.id}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`link-bridge-${l.id}`}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 12px', borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--bg-elevated)',
              textDecoration: 'none', color: 'var(--text-primary)',
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{l.label}</div>
              <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginTop: 2 }}>{l.sub}</div>
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>↗</div>
          </a>
        ))}
      </div>
    </div>
  )
}

// ─── Balance cards ───────────────────────────────────────────────────────────

function BscPrimaryCard({ w, onChange, copy, copied }: { w: WalletInfo; onChange: () => void; copy: (t: string) => void; copied: boolean }) {
  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>ON-CHAIN (BSC)</div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>USDT</div>
            <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-balance-usdt">
              {w.balances.usdt.toFixed(2)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>BNB (gas)</div>
            <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-balance-bnb">
              {w.balances.bnb.toFixed(5)}
            </div>
          </div>
        </div>
        {/* Funding-model footnote — this BSC USDT is the SAME pool that
            funds 42.space prediction buys (42 has no separate
            clearinghouse, the trader signs directly from this wallet's
            PK). Without this hint users top up here and then look for a
            separate "42.space wallet" to fund — there isn't one. */}
        <div style={{
          fontSize: 10, color: 'var(--b4-muted)', marginTop: 8,
          paddingTop: 8, borderTop: '1px solid var(--b4-border, #1e1e2e)',
          lineHeight: 1.4,
        }}>
          Used directly by 42.space — predictions are bought straight from this wallet, no separate top-up needed.
          Use Transfer to move USDT into Aster or Hyperliquid for perps.
        </div>
      </div>
      <ArbitrumCard w={w} />
      <PolygonCard w={w} onChange={onChange} copy={copy} copied={copied} />
    </>
  )
}

function BscSecondaryCard({ w, onChange, copy, copied }: { w: WalletInfo; onChange: () => void; copy: (t: string) => void; copied: boolean }) {
  return (
    <>
      <div className="card" style={{ marginBottom: 10, opacity: 0.85 }}>
        <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 6 }}>ON-CHAIN (BSC)</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span data-testid="text-balance-usdt">USDT {w.balances.usdt.toFixed(2)}</span>
          <span data-testid="text-balance-bnb">BNB {w.balances.bnb.toFixed(5)}</span>
        </div>
      </div>
      <ArbitrumCard w={w} compact />
      <PolygonCard w={w} compact onChange={onChange} copy={copy} copied={copied} />
    </>
  )
}

// Arbitrum card — same wallet address, different network. Funds parked here
// usually mean the user is mid-bridge to Hyperliquid (HL deposits go through
// the HL bridge contract on Arbitrum, not directly to the HL L1).
function ArbitrumCard({ w, compact }: { w: WalletInfo; compact?: boolean }) {
  const arb = w.arbitrum
  if (!arb) return null
  const hasFunds = arb.usdc > 0 || arb.eth > 0
  if (compact) {
    return (
      <div className="card" style={{ marginBottom: 14, opacity: 0.85 }} data-testid="card-arbitrum-balance">
        <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 6 }}>ON-CHAIN (ARBITRUM)</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span data-testid="text-balance-arb-usdc">USDC {arb.usdc.toFixed(2)}</span>
          <span data-testid="text-balance-arb-eth">ETH {arb.eth.toFixed(5)}</span>
        </div>
      </div>
    )
  }
  return (
    <div
      className="card"
      style={{
        marginBottom: 14,
        ...(hasFunds ? { borderLeft: '3px solid #2962ef' } : {}),
      }}
      data-testid="card-arbitrum-balance"
    >
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>ON-CHAIN (ARBITRUM)</div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>USDC</div>
          <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-balance-arb-usdc">
            {arb.usdc.toFixed(2)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>ETH (gas)</div>
          <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-balance-arb-eth">
            {arb.eth.toFixed(5)}
          </div>
        </div>
      </div>
      {arb.usdc >= 5 && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--b4-muted)', lineHeight: 1.45 }}>
          💡 USDC on Arbitrum doesn't trade directly. Open the <b>Hyperliquid</b> tab to bridge it into HL perps.
        </div>
      )}
    </div>
  )
}

// Polygon card — surfaces the user's USDC.e + MATIC at their custodial EOA
// and (if they've onboarded to Polymarket) the USDC.e at their Polymarket
// Safe. Includes a one-tap "Fund Polymarket" button that calls
// POST /api/polymarket/fund to sweep EOA → Safe. The flow mirrors the
// Hyperliquid bridge UX: user must hold a tiny amount of MATIC for the
// EOA→Safe transfer gas (Polymarket's relayer only sponsors Safe-side tx).
//
// USDC.e is the bridged USDC at 0x2791…4174 — the only collateral
// Polymarket's CTF Exchange accepts. Native USDC (0x3c49…3359) is NOT
// useful here, which is why we label the balance specifically as USDC.e.
function PolygonCard({
  w, compact, onChange, copy, copied,
}: {
  w: WalletInfo
  compact?: boolean
  onChange: () => void
  copy: (t: string) => void
  copied: boolean
}) {
  const poly = w.polygon
  const [funding, setFunding] = useState(false)
  const [fundMsg, setFundMsg] = useState<string | null>(null)
  const [fundErr, setFundErr] = useState<{ code: string; eoa?: string | null; msg: string } | null>(null)

  // If the server didn't return a polygon block (older server) silently
  // hide rather than show a confusing empty card. The Predictions tab
  // will surface any setup errors directly.
  if (!poly) return null
  const eoa  = poly.eoa
  const safe = poly.safe
  // When Polygon RPC errored server-side the balances default to 0 — a
  // misleading "you have nothing here" reading. Treat any non-null
  // eoa.error as authoritative: render the card in error mode instead
  // of pretending the user has $0.
  const rpcError   = eoa.error || null
  const hasEoaUsdc = !rpcError && eoa.usdcE > 0
  const hasMatic   = eoa.matic >= 0.005
  const safeReady  = safe.deployed && !!safe.address

  async function fund() {
    setFunding(true); setFundMsg(null); setFundErr(null)
    try {
      const res = await apiFetch<any>('/api/polymarket/fund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      setFundMsg(`✓ Sent ${Number(res.amountUsdc ?? 0).toFixed(2)} USDC.e to your Safe`)
      onChange()
    } catch (e: any) {
      // ApiError stashes the parsed JSON body on .body — that's where the
      // structured `code: 'NEED_MATIC'` lives. Fall back to message string
      // for older errors / non-JSON failures.
      const body = e?.body ?? null
      const code = body?.code ?? (String(e?.message ?? '').includes('NEED_MATIC') ? 'NEED_MATIC' : null)
      if (code === 'NEED_MATIC') {
        setFundErr({ code, eoa: body?.eoaAddress ?? eoa.address, msg: 'Add POL (formerly MATIC) for gas (~$0.01)' })
      } else {
        setFundErr({ code: 'ERR', msg: body?.details ?? body?.error ?? String(e?.message ?? 'Failed').slice(0, 140) })
      }
    } finally {
      setFunding(false)
    }
  }

  if (compact) {
    return (
      <div className="card" style={{ marginBottom: 14, opacity: 0.85 }} data-testid="card-polygon-balance">
        <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 6 }}>ON-CHAIN (POLYGON · POLYMARKET)</div>
        {rpcError ? (
          <div style={{ fontSize: 12, color: 'var(--b4-muted)' }} data-testid="text-poly-rpc-error">
            <i>balance unavailable — Polygon RPC is busy</i>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span data-testid="text-balance-poly-usdce">USDC.e {eoa.usdcE.toFixed(2)}</span>
            <span data-testid="text-balance-poly-matic" title="POL is the new ticker for MATIC on Polygon (renamed Sept 2024)">POL {eoa.matic.toFixed(4)}</span>
          </div>
        )}
        {safeReady && safe.usdcE > 0 && (
          <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginTop: 4 }} data-testid="text-balance-poly-safe">
            Safe: {safe.usdcE.toFixed(2)} USDC.e
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="card"
      style={{
        marginBottom: 14,
        ...(hasEoaUsdc || (safe.usdcE ?? 0) > 0 ? { borderLeft: '3px solid #8247e5' } : {}),
      }}
      data-testid="card-polygon-balance"
    >
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>
        ON-CHAIN (POLYGON · POLYMARKET)
      </div>
      {rpcError ? (
        // Surface RPC failures explicitly. Showing 0.00 here would
        // mislead users who actually have USDC.e at this address into
        // thinking their funds are missing.
        <div
          style={{
            padding: '10px 12px', borderRadius: 6,
            background: 'var(--b4-bg-elevated, #181822)',
            border: '1px solid var(--b4-border, #2a2a3a)',
            fontSize: 12, color: 'var(--b4-muted)', lineHeight: 1.5,
          }}
          data-testid="text-poly-rpc-error"
        >
          <div style={{ color: 'var(--b4-red)', fontWeight: 600, marginBottom: 4 }}>
            ⚠ Couldn't read Polygon balance
          </div>
          <div>
            Public Polygon RPC is rate-limited right now. Tap <b>Refresh</b> in
            a moment, or check your address directly on{' '}
            <a
              href={`https://polygonscan.com/address/${eoa.address}`}
              target="_blank" rel="noreferrer"
              style={{ color: 'var(--b4-purple, #8247e5)' }}
            >
              Polygonscan
            </a>
            .
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>USDC.e</div>
            <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-balance-poly-usdce">
              {eoa.usdcE.toFixed(2)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }} title="POL is the new ticker for MATIC on Polygon (renamed Sept 2024)">POL (gas)</div>
            <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-balance-poly-matic">
              {eoa.matic.toFixed(4)}
            </div>
          </div>
        </div>
      )}

      {safeReady && (
        <div style={{
          marginTop: 10, paddingTop: 10,
          borderTop: '1px solid var(--b4-border, #1e1e2e)',
          display: 'flex', justifyContent: 'space-between', fontSize: 12,
        }}>
          <span style={{ color: 'var(--b4-muted)' }}>Polymarket Safe</span>
          <span data-testid="text-balance-poly-safe">{safe.usdcE.toFixed(2)} USDC.e</span>
        </div>
      )}

      {/* Fund CTA: only meaningful when Safe is ready *and* EOA has USDC.e
          to send. Without a Safe we route the user to the Predictions tab
          so they can complete onboarding (which deploys the Safe). */}
      {hasEoaUsdc && safeReady && hasMatic && (
        <button
          className="btn-primary"
          style={{ marginTop: 12, width: '100%' }}
          disabled={funding}
          onClick={fund}
          data-testid="button-fund-polymarket"
        >
          {funding ? 'Sending…' : `Fund Polymarket ($${eoa.usdcE.toFixed(2)})`}
        </button>
      )}
      {/* Show the MATIC-prompt either when the on-chain balance says we
          don't have enough OR when the server actually rejected the fund
          attempt with NEED_MATIC (covers the race where balances looked
          fine client-side but the chain disagreed at tx time). */}
      {hasEoaUsdc && safeReady && (!hasMatic || fundErr?.code === 'NEED_MATIC') && (
        <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5 }}>
          <div style={{ color: 'var(--b4-red)', marginBottom: 6 }}>
            ⚠ Need a tiny amount of <strong>POL</strong> (the new name for MATIC on Polygon) for gas (~$0.01) at:
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <code style={{
              flex: 1, fontSize: 10, wordBreak: 'break-all',
              background: 'var(--b4-bg-elevated, #181822)', padding: '4px 6px', borderRadius: 4,
            }} data-testid="text-poly-eoa-address">
              {eoa.address}
            </code>
            <button
              onClick={() => copy(eoa.address)}
              style={{
                padding: '4px 8px', borderRadius: 4, border: '1px solid var(--b4-border)',
                background: 'transparent', color: 'var(--b4-text)', fontSize: 11, cursor: 'pointer',
              }}
              data-testid="button-copy-poly-eoa"
            >
              {copied ? '✓' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      {!hasEoaUsdc && !safeReady && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--b4-muted)', lineHeight: 1.45 }}>
          Open the <b>Predictions → Polymarket</b> tab to set up your trading Safe and start funding.
        </div>
      )}
      {!hasEoaUsdc && safeReady && (safe.usdcE ?? 0) === 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--b4-muted)', lineHeight: 1.45 }}>
          Send USDC.e on Polygon to your Safe address (shown on the Polymarket tab) to start trading.
        </div>
      )}

      {fundMsg && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--b4-green, #00c076)' }} data-testid="text-fund-success">
          {fundMsg}
        </div>
      )}
      {fundErr && fundErr.code !== 'NEED_MATIC' && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--b4-red)' }} data-testid="text-fund-error">
          ⚠ {fundErr.msg}
        </div>
      )}
    </div>
  )
}

// Hyperliquid live equity card — mirrors AsterPrimaryCard but in HL's
// purple. Hidden silently if the server didn't return HL data (older
// server, or HL temporarily unreachable). When the user hasn't activated
// HL yet (no clearinghouse account) we show the empty state but make
// clear it's not an error — they just haven't onboarded.
function HyperliquidCard({ w }: { w: WalletInfo }) {
  const hl = w.hyperliquid
  if (!hl) return null
  const isError = hl.error && hl.error !== 'not_onboarded'
  // Defense-in-depth: if the user has a non-zero account value, they are
  // demonstrably onboarded — never hide a real balance behind the empty
  // state regardless of what the onboarded flag says. (We hit a bug where
  // the server returned onboarded=undefined → treated as false → wallet
  // showed "Not activated" with $58.77 sitting in the HL clearinghouse.)
  const hasFunds = (hl.accountValue ?? 0) > 0 || (hl.usdc ?? 0) > 0
  const notOnboarded = !hasFunds && (hl.error === 'not_onboarded' || !hl.onboarded)
  return (
    <div className="card" style={{
      marginBottom: 10,
      background: notOnboarded
        ? undefined
        : 'linear-gradient(135deg, #7c3aed22, #7c3aed08)',
      border: notOnboarded ? undefined : '1px solid #7c3aed44',
    }}>
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>
        HYPERLIQUID TRADING {!notOnboarded && !isError && '(LIVE)'}
      </div>
      {isError ? (
        <div data-testid="text-hl-wallet-error" style={{ fontSize: 12, color: 'var(--b4-red)', lineHeight: 1.45 }}>
          ⚠️ {hl.error}
        </div>
      ) : notOnboarded ? (
        <div data-testid="text-hl-wallet-not-onboarded" style={{ fontSize: 12, color: 'var(--b4-muted)', lineHeight: 1.45 }}>
          Not activated yet. Open the <b>Hyperliquid</b> tab to activate trading (needs USDC on Arbitrum to bridge).
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Account value</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#a78bfa' }} data-testid="text-hl-account-value">
              ${hl.accountValue.toFixed(2)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Withdrawable</div>
            <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-hl-withdrawable">
              ${hl.usdc.toFixed(2)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AsterPrimaryCard({ w }: { w: WalletInfo }) {
  return (
    <div className="card" style={{
      marginBottom: 10,
      background: 'linear-gradient(135deg, #10b98122, #10b98108)',
      border: '1px solid #10b98144'
    }}>
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>ASTER TRADING (LIVE)</div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Equity</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#10b981' }} data-testid="text-aster-usdt">
            ${w.aster.usdt.toFixed(2)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Available margin</div>
          <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-aster-margin">
            ${w.aster.availableMargin.toFixed(2)}
          </div>
        </div>
      </div>
    </div>
  )
}

function AsterSecondaryCard({ w, onReactivated }: { w: WalletInfo; onReactivated?: () => void }) {
  // For users whose per-user agent PK can't be decrypted (legacy
  // encryption mismatch, env-key rotation, etc.) the only recovery
  // path is re-running /api/aster/approve. The Home tab's Activate
  // button is hidden once asterOnboarded=true, so we surface a
  // Re-activate button here whenever we detect 'no_agent_credentials'.
  const [reactivating, setReactivating] = useState(false)
  const [reactivateMsg, setReactivateMsg] = useState<string | null>(null)
  const reactivate = async () => {
    if (reactivating) return
    setReactivating(true); setReactivateMsg(null)
    const fmtDebug = (d: any): string =>
      d ? ` [fmt=${d.fmt} len=${d.totalLen} parts=${d.partLens} head=${d.head} tried=${d.tried}${d.reason ? ' reason=' + d.reason : ''}]` : ''
    try {
      const r = await apiFetch<{
        success: boolean
        error?: string
        debug?: { fmt?: string; totalLen?: number; partLens?: string; head?: string; tried?: number; reason?: string }
      }>(
        '/api/aster/approve',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      )
      if (r.success) {
        setReactivateMsg('Re-activated. Refreshing balance…')
        setTimeout(() => onReactivated?.(), 600)
      } else {
        setReactivateMsg((r.error ?? 'Re-activation failed') + fmtDebug(r.debug))
      }
    } catch (e: any) {
      // apiFetch throws ApiError with body attached on non-2xx responses.
      // The /api/aster/approve handler returns rich diagnostics in `debug`
      // when wallet decryption fails — surface them so the user (and we)
      // can triage why their wallet PK can't be decrypted.
      const base = e?.message ?? 'Re-activation failed'
      const dbg  = fmtDebug(e?.body?.debug)
      setReactivateMsg(base + dbg)
    } finally {
      setReactivating(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>ASTER TRADING</div>
      {w.aster.error ? (
        <div data-testid="text-aster-error">
          <div style={{ fontSize: 12, color: 'var(--b4-red)', lineHeight: 1.45 }}>
            ⚠️ {
              w.aster.error === 'no_agent_credentials'
                ? 'Aster trading agent needs to be re-authorised. Tap below to re-activate — your USDT in Aster is safe and stays put.'
                : w.aster.error === 'not_onboarded'
                  ? 'No Aster account found. Deposit USDT to get started.'
                  : w.aster.error === 'aster_unavailable' || w.aster.error.includes('rpc')
                    ? 'Aster temporarily unavailable. Refreshing in a moment.'
                    : `Aster error: ${w.aster.error}`
            }
          </div>
          {w.aster.error === 'no_agent_credentials' && (
            <>
              <button
                onClick={reactivate}
                disabled={reactivating}
                data-testid="button-aster-reactivate"
                style={{
                  marginTop: 10, width: '100%', padding: '10px 14px',
                  background: '#7c3aed', color: 'white', border: 0, borderRadius: 8,
                  fontSize: 13, fontWeight: 600,
                  cursor: reactivating ? 'wait' : 'pointer', opacity: reactivating ? 0.7 : 1
                }}
              >
                {reactivating ? 'Re-activating…' : '🔄 Re-activate Aster'}
              </button>
              {reactivateMsg && (
                <div
                  data-testid="text-aster-reactivate-msg"
                  style={{ marginTop: 8, fontSize: 11, color: 'var(--b4-muted)' }}
                >
                  {reactivateMsg}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Equity</div>
            <div style={{ fontSize: 18, fontWeight: 700 }} data-testid="text-aster-usdt">
              ${w.aster.usdt.toFixed(2)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Available</div>
            <div style={{ fontSize: 18, fontWeight: 700 }} data-testid="text-aster-margin">
              ${w.aster.availableMargin.toFixed(2)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── State A: not onboarded, BSC empty — show fund only ──────────────────────

function FundFlow({ w, copy, copied, onRefresh }:
  { w: WalletInfo; copy: (s: string) => void; copied: boolean; onRefresh: () => void }) {
  return (
    <div data-testid="flow-fund">
      <div style={{
        background: '#3f1d1d', border: '1px solid #7f1d1d',
        borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 12, lineHeight: 1.5
      }}>
        ⚠️ Send <b>USDT (BEP-20)</b> on <b>BNB Smart Chain only</b>.<br />
        Wrong network = lost funds. No exceptions.
      </div>

      <div style={{ fontSize: 13, color: 'var(--b4-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Send USDT to your wallet to get started. Once it lands, you'll be able to activate
        your Aster trading account in one tap — no leaving the app.
      </div>

      <div className="card" style={{ textAlign: 'center', marginBottom: 14 }}>
        <img
          src={w.qrDataUrl} alt="Deposit QR"
          style={{ width: 220, height: 220, borderRadius: 8, background: 'white', padding: 6 }}
          data-testid="img-qr"
        />
        <div style={{
          marginTop: 14, padding: 10, background: '#0a0a0f',
          borderRadius: 8, fontSize: 12, fontFamily: 'monospace',
          wordBreak: 'break-all', color: 'var(--b4-text)'
        }} data-testid="text-address">
          {w.address}
        </div>
        <button
          className="btn-primary"
          style={{ marginTop: 10 }}
          onClick={() => copy(w.address)}
          data-testid="button-copy-address"
        >
          {copied ? '✓ Copied' : '📋 Copy Address'}
        </button>
      </div>

      <button
        onClick={onRefresh}
        data-testid="button-check-balance"
        style={{
          width: '100%', padding: 12, borderRadius: 8,
          background: 'var(--b4-surface)', border: '1px solid var(--b4-border)',
          color: 'var(--b4-text)', fontSize: 14, cursor: 'pointer'
        }}
      >
        🔄 Check Balance
      </button>
    </div>
  )
}

// ─── State B: BSC has USDT, not onboarded — Activate Trading Account ─────────

function ActivateFlow({ onActivated }: { onActivated: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [needsBnb, setNeedsBnb] = useState(false)
  const [depositTx, setDepositTx] = useState<string | null>(null)

  const activate = async () => {
    if (submitting) return
    setSubmitting(true); setErr(null); setNeedsBnb(false); setDepositTx(null)
    try {
      const r = await apiFetch<{
        success: boolean; error?: string; message?: string;
        needsBnb?: boolean; needsAsterAccount?: boolean;
        depositTx?: string; approveTx?: string
      }>('/api/aster/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      })
      if (r.success) {
        setTimeout(onActivated, 250)
      } else {
        setErr(r.error ?? 'Activation failed')
        setNeedsBnb(!!r.needsBnb)
        if (r.depositTx) setDepositTx(r.depositTx)
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Activation failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div data-testid="flow-activate">
      <div style={{
        background: 'linear-gradient(135deg, #7c3aed22, #7c3aed11)',
        border: '1px solid #7c3aed44', borderRadius: 12, padding: 16, marginBottom: 14
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
          🚀 One-tap activation
        </div>
        <div style={{ fontSize: 12, color: 'var(--b4-muted)', marginBottom: 14, lineHeight: 1.5 }}>
          This will deposit your full USDT balance into your Aster trading
          account and authorise BUILD4 to trade on your behalf. Takes ~15
          seconds. Requires a small amount of BNB for gas (~0.001 BNB).
          You can withdraw any time.
        </div>
        <button
          onClick={activate}
          disabled={submitting}
          data-testid="button-activate-aster"
          style={{
            width: '100%', padding: 14, borderRadius: 8, border: 'none',
            background: submitting ? '#5b21b6' : '#7c3aed',
            color: 'white', fontSize: 15, fontWeight: 600,
            cursor: submitting ? 'wait' : 'pointer'
          }}
        >
          {submitting ? 'Depositing & activating…' : '⚡ Deposit & Activate'}
        </button>
      </div>

      {err && (
        <div data-testid="text-activate-error" style={{
          padding: 12, borderRadius: 10, fontSize: 12, lineHeight: 1.5,
          background: needsBnb ? 'rgba(245, 158, 11, 0.10)' : '#ef444415',
          border: needsBnb ? '1px solid rgba(245, 158, 11, 0.40)' : '1px solid #ef444444',
          color: needsBnb ? 'var(--amber)' : '#fca5a5'
        }}>
          {needsBnb ? (
            <>
              ⛽ <b>Needs a tiny bit of BNB for gas.</b> Send ~0.001 BNB
              (≈ $0.50) to your wallet address above, then tap Activate again.
              Any BSC wallet or exchange withdrawal works.
            </>
          ) : depositTx ? (
            <>
              ⚠️ Your deposit landed but activation is still indexing on Aster.
              <br /><br />
              Deposit tx: <a
                href={`https://bscscan.com/tx/${depositTx}`}
                target="_blank" rel="noreferrer"
                style={{ color: '#a78bfa', textDecoration: 'underline' }}
              >{depositTx.slice(0, 10)}…{depositTx.slice(-8)}</a>
              <br /><br />
              Wait ~30 seconds and tap Activate again. Your USDT is safely on
              Aster — only the agent authorisation needs to retry.
            </>
          ) : (
            <>❌ {err}</>
          )}
        </div>
      )}
    </div>
  )
}

// ─── State C: onboarded, Aster empty — Transfer to Aster ─────────────────────
// ─── State D shares this same TransferFlow for the Fund button ──────────────

function TransferFlow(
  { w, onDone, initialDirection }:
  { w: WalletInfo; onDone: () => void; initialDirection: 'to_aster' | 'to_bsc' }
) {
  const [direction, setDirection] = useState<'to_aster' | 'to_bsc'>(initialDirection)
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const sourceBal = direction === 'to_aster' ? w.balances.usdt : w.aster.availableMargin
  const valid = Number(amount) > 0 && Number(amount) <= sourceBal

  const send = async () => {
    if (!valid || submitting) return
    setSubmitting(true); setResult(null)
    try {
      const r = await apiFetch<{ success: boolean; tranId?: string; error?: string }>(
        '/api/aster/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, direction })
        }
      )
      if (r.success) {
        setResult({ ok: true, msg: `Transferred ${amount} USDT. Refreshing balance…` })
        setAmount('')
        setTimeout(onDone, 1500)
      } else {
        setResult({ ok: false, msg: r.error ?? 'Transfer failed' })
      }
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message ?? 'Transfer failed' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div data-testid="flow-transfer">
      <div style={{
        background: '#1e293b', border: '1px solid #334155',
        borderRadius: 12, padding: 14, marginBottom: 14
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
          🔁 Move USDT
        </div>

        {/* Direction toggle. The "Aster → BSC" path is temporarily disabled:
            the previous implementation called Aster's internal FUTURE_SPOT
            book transfer (which only moves between Aster's futures and
            Aster's spot wallet, never on-chain to BSC). A real on-chain
            withdrawal requires Aster's signed withdraw endpoint which
            is not yet wired up. Until then we route the user to
            asterdex.com so funds aren't stranded in their Aster spot
            wallet. */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button
            onClick={() => { setDirection('to_aster'); setAmount(''); setResult(null) }}
            data-testid="button-direction-to_aster"
            style={{
              flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 600,
              borderRadius: 6, cursor: 'pointer',
              border: direction === 'to_aster' ? '1px solid #7c3aed' : '1px solid var(--b4-border)',
              background: direction === 'to_aster' ? '#7c3aed22' : 'transparent',
              color: 'var(--b4-text)'
            }}
          >BSC → Aster</button>
          <button
            data-testid="button-direction-to_bsc-disabled"
            disabled
            title="Withdraw to BSC via asterdex.com — coming soon in-app"
            style={{
              flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 600,
              borderRadius: 6, cursor: 'not-allowed',
              border: '1px solid var(--b4-border)',
              background: 'transparent', color: 'var(--b4-muted)', opacity: 0.55,
            }}
          >Aster → BSC ⓘ</button>
        </div>
        {direction === 'to_aster' && (
          <div style={{
            fontSize: 11, color: 'var(--b4-muted)', marginBottom: 10,
            padding: '8px 10px', background: '#1e293b', borderRadius: 6,
            border: '1px solid #334155',
          }}>
            To withdraw <b>from</b> Aster <b>to BSC</b>, use{' '}
            <a href="https://asterdex.com" target="_blank" rel="noreferrer"
               style={{ color: '#a78bfa', textDecoration: 'underline' }}>
              asterdex.com
            </a>{' '}→ Wallet → Withdraw. In-app withdraw landing soon.
          </div>
        )}

        <label style={{ fontSize: 11, color: 'var(--b4-muted)', display: 'block', marginBottom: 6 }}>
          Amount (USDT) · Available: {sourceBal.toFixed(2)}
        </label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.00"
            inputMode="decimal"
            data-testid="input-transfer-amount"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={() => setAmount((Math.floor(Math.max(0, sourceBal) * 100) / 100).toFixed(2))}
            data-testid="button-transfer-max"
            style={{
              padding: '0 14px', borderRadius: 8, border: '1px solid var(--b4-border)',
              background: 'var(--b4-surface)', color: 'var(--b4-text)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer'
            }}
          >MAX</button>
        </div>

        <button
          onClick={send}
          disabled={!valid || submitting}
          data-testid="button-transfer-send"
          style={{
            width: '100%', padding: 13, borderRadius: 8, border: 'none',
            background: valid && !submitting ? 'var(--b4-accent)' : '#1e1e2e',
            color: 'white', fontSize: 14, fontWeight: 600,
            cursor: valid && !submitting ? 'pointer' : 'not-allowed'
          }}
        >
          {submitting ? 'Transferring…' : (direction === 'to_aster' ? '⚡ Transfer to Aster' : '↩ Transfer to BSC')}
        </button>

        {result && (
          <div
            data-testid={result.ok ? 'text-transfer-success' : 'text-transfer-error'}
            style={{
              marginTop: 12, padding: 10, borderRadius: 8, fontSize: 12,
              background: result.ok ? '#10b98120' : '#ef444420',
              border: `1px solid ${result.ok ? '#10b981' : '#ef4444'}`,
              color: result.ok ? '#10b981' : '#ef4444'
            }}>
            {result.msg}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── State D: trading-ready — Transfer + Withdraw tabs ───────────────────────

function TradingReadyFlow(
  { w, onDone, copy, copied }:
  { w: WalletInfo; onDone: () => void; copy: (s: string) => void; copied: boolean }
) {
  const [tab, setTab] = useState<'transfer' | 'fund' | 'withdraw'>('transfer')

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {([
          { v: 'transfer' as const, label: '🔁 Transfer' },
          { v: 'fund'     as const, label: '⬇ Fund (BSC)' },
          { v: 'withdraw' as const, label: '⬆ Withdraw' }
        ]).map(t => (
          <button
            key={t.v}
            onClick={() => setTab(t.v)}
            data-testid={`tab-${t.v}`}
            style={{
              flex: 1, padding: '10px 0',
              borderRadius: 8, border: '1px solid var(--b4-border)',
              background: tab === t.v ? 'var(--b4-accent)' : 'var(--b4-surface)',
              color: tab === t.v ? 'white' : 'var(--b4-text)',
              fontWeight: 600, fontSize: 12, cursor: 'pointer'
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'transfer' && <TransferFlow w={w} onDone={onDone} initialDirection="to_aster" />}
      {tab === 'fund'     && <FundFlow w={w} copy={copy} copied={copied} onRefresh={onDone} />}
      {tab === 'withdraw' && <WithdrawView w={w} onSent={onDone} />}
    </div>
  )
}

// ─── On-chain BSC withdraw (unchanged from previous version) ─────────────────

function WithdrawView({ w, onSent }: { w: WalletInfo; onSent: () => void }) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [pin, setPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string; url?: string } | null>(null)

  const valid = /^0x[a-fA-F0-9]{40}$/.test(to) &&
    Number(amount) >= 1 && Number(amount) <= w.balances.usdt &&
    (!w.pinProtected || /^\d{4,8}$/.test(pin))

  const send = async () => {
    if (!valid || submitting) return
    const tg = (window as any).Telegram?.WebApp
    const confirmMsg = `Send ${amount} USDT to\n${to}\n\nThis cannot be undone. Continue?`
    const confirmed = await new Promise<boolean>(resolve => {
      if (tg?.showConfirm) tg.showConfirm(confirmMsg, (ok: boolean) => resolve(ok))
      else resolve(window.confirm(confirmMsg))
    })
    if (!confirmed) return

    setSubmitting(true); setResult(null)
    try {
      const r = await apiFetch<{ success: boolean; txHash: string; explorerUrl: string }>(
        '/api/me/withdraw',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, amount: Number(amount), pin: pin || undefined })
        }
      )
      setResult({
        ok: true,
        msg: `Sent! Tx: ${r.txHash.slice(0, 10)}…${r.txHash.slice(-8)}`,
        url: r.explorerUrl
      })
      setAmount(''); setTo(''); setPin('')
      setTimeout(onSent, 2000)
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message ?? 'Withdrawal failed' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {w.balances.bnb < 0.0003 && (
        <div data-testid="banner-needs-gas" style={{
          background: 'rgba(245, 158, 11, 0.10)',
          border: '1px solid rgba(245, 158, 11, 0.40)',
          borderRadius: 10, padding: 12, marginBottom: 14,
          fontSize: 12, lineHeight: 1.5, color: 'var(--amber)'
        }}>
          ⛽ Needs a tiny bit of <b>BNB for gas</b>. Send ~0.001 BNB
          (≈ $0.50) to your deposit address before withdrawing.
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--b4-muted)', display: 'block', marginBottom: 6 }}>
          Destination address (BSC)
        </label>
        <input
          value={to}
          onChange={e => setTo(e.target.value.trim())}
          placeholder="0x..."
          data-testid="input-to-address"
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--b4-muted)', display: 'block', marginBottom: 6 }}>
          Amount (USDT) · Available: {w.balances.usdt.toFixed(2)}
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.00"
            inputMode="decimal"
            data-testid="input-amount"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={() => setAmount((Math.floor(Math.max(0, w.balances.usdt) * 100) / 100).toFixed(2))}
            data-testid="button-max"
            style={{
              padding: '0 14px', borderRadius: 8, border: '1px solid var(--b4-border)',
              background: 'var(--b4-surface)', color: 'var(--b4-text)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer'
            }}
          >MAX</button>
        </div>
      </div>

      {w.pinProtected && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--b4-muted)', display: 'block', marginBottom: 6 }}>
            Wallet PIN
          </label>
          <input
            type="password"
            value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="••••"
            inputMode="numeric"
            data-testid="input-pin"
            style={inputStyle}
          />
        </div>
      )}

      <button
        onClick={send}
        disabled={!valid || submitting}
        data-testid="button-send"
        style={{
          width: '100%', padding: 14, borderRadius: 8, border: 'none',
          background: valid && !submitting ? 'var(--b4-accent)' : '#1e1e2e',
          color: 'white', fontSize: 15, fontWeight: 600,
          cursor: valid && !submitting ? 'pointer' : 'not-allowed'
        }}
      >
        {submitting ? 'Sending…' : `Send ${amount || '0'} USDT`}
      </button>

      {result && (
        <div
          data-testid={result.ok ? 'text-success' : 'text-error'}
          style={{
            marginTop: 14, padding: 12, borderRadius: 10, fontSize: 13,
            background: result.ok ? '#10b98120' : '#ef444420',
            border: `1px solid ${result.ok ? '#10b981' : '#ef4444'}`,
            color: result.ok ? '#10b981' : '#ef4444',
            wordBreak: 'break-all'
          }}>
          {result.msg}
          {result.url && (
            <div style={{ marginTop: 6 }}>
              <a href={result.url} target="_blank" rel="noreferrer"
                 style={{ color: '#7c3aed', textDecoration: 'underline' }}>
                View on BscScan →
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px', borderRadius: 8,
  background: 'var(--b4-surface)', border: '1px solid var(--b4-border)',
  color: 'var(--b4-text)', fontSize: 14, fontFamily: 'monospace',
  boxSizing: 'border-box', outline: 'none'
}

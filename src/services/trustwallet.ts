/**
 * Trust Wallet Agent Kit (TWAK) integration.
 *
 * Wraps the official `@trustwallet/cli` (`twak` binary) and exposes a small,
 * typed surface used by:
 *   - the /trustwallet bot command (read-only demo)
 *   - the AI trading agent's optional risk/price enrichment hook
 *
 * Auth: requires TWAK_ACCESS_ID and TWAK_HMAC_SECRET in the process env.
 * Both come from portal.trustwallet.com. If either is missing, every call
 * returns { ok:false } and never throws — the rest of BUILD4 keeps working.
 */
import { spawn } from 'child_process'
import path from 'path'

const TWAK_BIN = path.join(process.cwd(), 'node_modules', '@trustwallet', 'cli', 'dist', 'index.js')
const DEFAULT_CHAIN = 'bsc'
const TIMEOUT_MS = 15_000

export type TwakResult<T> =
  | { ok: true; data: T; raw: string }
  | { ok: false; reason: string; raw?: string }

export function isTwakConfigured(): boolean {
  return !!(process.env.TWAK_ACCESS_ID && process.env.TWAK_HMAC_SECRET)
}

/**
 * Run a `twak` subcommand non-interactively and parse JSON output.
 * Always uses --json + --no-analytics. Times out at 15s.
 */
async function runTwak<T = any>(args: string[]): Promise<TwakResult<T>> {
  if (!isTwakConfigured()) {
    return { ok: false, reason: 'TWAK_ACCESS_ID / TWAK_HMAC_SECRET not set' }
  }
  const fullArgs = [TWAK_BIN, ...args, '--json', '--no-analytics']
  return new Promise<TwakResult<T>>((resolve) => {
    let stdout = ''
    let stderr = ''
    const proc = spawn(process.execPath, fullArgs, {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ ok: false, reason: `twak ${args[0]} timed out after ${TIMEOUT_MS}ms` })
    }, TIMEOUT_MS)
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => {
      clearTimeout(killTimer)
      resolve({ ok: false, reason: `twak spawn failed: ${err.message}` })
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      const trimmed = stdout.trim()
      if (code !== 0 && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return resolve({
          ok: false,
          reason: (stderr.trim() || `twak exited ${code}`).slice(0, 300),
          raw: stdout
        })
      }
      try {
        const data = JSON.parse(trimmed) as T
        resolve({ ok: true, data, raw: trimmed })
      } catch (e: any) {
        resolve({ ok: false, reason: `twak JSON parse failed: ${e.message}`, raw: stdout })
      }
    })
  })
}

// ── Public API ────────────────────────────────────────────────────────────

export interface TwakPrice {
  token: string
  chain: string
  priceUsd: number
}
export async function getPrice(token: string, chain = DEFAULT_CHAIN): Promise<TwakResult<TwakPrice>> {
  return runTwak<TwakPrice>(['price', token, '--chain', chain])
}

export interface TwakBalance {
  address: string
  chain: string
  balance: string
  symbol?: string
  decimals?: number
}
export async function getBalance(opts: {
  address: string
  chain?: string
  tokenAddress?: string
}): Promise<TwakResult<TwakBalance>> {
  const args = ['balance', '--address', opts.address, '--chain', opts.chain ?? DEFAULT_CHAIN]
  if (opts.tokenAddress) args.push('--token', opts.tokenAddress)
  return runTwak<TwakBalance>(args)
}

export interface TwakRisk {
  assetId: string
  riskScore: number          // 0..10 — higher is riskier
  flags?: string[]
  details?: Record<string, unknown>
}
export async function getRisk(assetId: string): Promise<TwakResult<TwakRisk>> {
  return runTwak<TwakRisk>(['risk', assetId])
}

export interface TwakSwapQuote {
  from: string
  to: string
  amount: string
  expectedOut: string
  priceImpactPct?: number
  route?: unknown
}
/**
 * Quote a swap (read-only). To actually execute, pass `execute: true` AND
 * supply a wallet password — but auto-execute is intentionally NOT enabled
 * by the AI trading agent here; BUILD4 trades go through Aster DEX EIP-712.
 */
export async function quoteSwap(opts: {
  from: string
  to: string
  amount: number | string
  chain?: string
  slippagePct?: number
  execute?: boolean
  password?: string
}): Promise<TwakResult<TwakSwapQuote>> {
  const args = [
    'swap',
    String(opts.amount),
    opts.from,
    opts.to,
    '--chain', opts.chain ?? DEFAULT_CHAIN,
    '--slippage', String(opts.slippagePct ?? 1)
  ]
  if (!opts.execute) args.push('--quote-only')
  if (opts.execute && opts.password) args.push('--password', opts.password)
  return runTwak<TwakSwapQuote>(args)
}

export interface TwakAutomation {
  id: string
  type: 'dca' | 'limit'
  from: string
  to: string
  amount: string
  intervalSeconds?: number
  status: string
}
/**
 * Create a DCA automation (`twak automate add --interval ...`).
 * The TWAK background watcher (`twak watch`) executes them — that runs
 * separately from the BUILD4 process.
 */
export async function createDca(opts: {
  from: string
  to: string
  amount: number | string
  interval: string           // e.g. "1h", "30m"
  chain?: string
  maxRuns?: number
}): Promise<TwakResult<TwakAutomation>> {
  const args = [
    'automate', 'add',
    '--from', opts.from,
    '--to', opts.to,
    '--amount', String(opts.amount),
    '--interval', opts.interval,
    '--chain', opts.chain ?? DEFAULT_CHAIN
  ]
  if (opts.maxRuns) args.push('--max-runs', String(opts.maxRuns))
  return runTwak<TwakAutomation>(args)
}

export async function listAutomations(): Promise<TwakResult<TwakAutomation[]>> {
  return runTwak<TwakAutomation[]>(['automate', 'list'])
}

// ── Trading-agent enrichment (feature-flagged) ─────────────────────────────

/**
 * Maximum allowed token risk score for the AI trading agent. Trades on
 * tokens scoring above this are skipped when TWAK_TRADING_INTEGRATION=true.
 */
export const TWAK_RISK_THRESHOLD = Number(process.env.TWAK_RISK_THRESHOLD ?? 7)

export function isTradingIntegrationEnabled(): boolean {
  return isTwakConfigured() && process.env.TWAK_TRADING_INTEGRATION === 'true'
}

/**
 * Optional pre-trade gate. Returns `{ allowed: true }` when TWAK is disabled
 * or unreachable — never blocks a trade because of an integration outage.
 */
export async function checkTradeRisk(assetId: string): Promise<{
  allowed: boolean
  riskScore?: number
  reason?: string
}> {
  if (!isTradingIntegrationEnabled()) return { allowed: true }
  const res = await getRisk(assetId)
  if (!res.ok) return { allowed: true, reason: `TWAK risk check skipped: ${res.reason}` }
  const score = Number(res.data.riskScore ?? 0)
  if (score > TWAK_RISK_THRESHOLD) {
    return {
      allowed: false,
      riskScore: score,
      reason: `TWAK risk ${score}/10 exceeds threshold ${TWAK_RISK_THRESHOLD}/10`
    }
  }
  return { allowed: true, riskScore: score }
}

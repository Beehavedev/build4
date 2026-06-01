/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fund the Community Fleet BSC wallets with BNB.
 *
 * Sends BNB from ONE funder wallet (the FLEET_FUNDER_PK secret) to each fleet
 * wallet. Each wallet receives a RANDOM USD amount in [--min,--max] chosen so
 * the amounts sum EXACTLY to --total. Defaults: $1000 total, $15–$30 each,
 * 50 wallets (50 × ~$20 avg).
 *
 * ─────────────────────────── SAFETY ───────────────────────────
 *  • DRY-RUN BY DEFAULT. It prints the full plan and broadcasts NOTHING.
 *    Add --execute to actually send on-chain.
 *  • TARGETS come from a file, not this environment's DB. The Replit dev DB has
 *    0 fleet agents; the real 50 live in the Render prod DB. Funding is purely
 *    on-chain (addresses + funder key + RPC), so you can run this from anywhere
 *    as long as you feed it the REAL prod wallet addresses:
 *       --csv <fleet-backup.csv>   (a fleet backup export; reads wallet_address)
 *       --addresses <file.txt>     (one address per line, or "name,address")
 *       --db                       (read fleet_agents from the connected DB —
 *                                   only meaningful when run ON the prod bot)
 *  • IDEMPOTENT: skips wallets already holding ≥ --skip-threshold-usd worth of
 *    BNB, so it is safe to re-run after a partial failure (--force disables).
 *  • Verifies the funder holds enough BNB (transfers + gas) before sending.
 *  • Sequential sends with explicit nonce management; one tx failing does not
 *    abort the rest. A results CSV is written at the end.
 *
 * Usage:
 *   npx tsx scripts/fundFleet.ts --csv fleet-backup.csv --bnb-price 600
 *   npx tsx scripts/fundFleet.ts --csv fleet-backup.csv --bnb-price 600 --execute
 *   npx tsx scripts/fundFleet.ts --addresses addrs.txt --execute
 *   npx tsx scripts/fundFleet.ts --db --execute        # only on the prod bot
 *
 * Flags:
 *   --total <usd>            total to distribute (default 1000)
 *   --min <usd>              min per wallet (default 15)
 *   --max <usd>              max per wallet (default 30)
 *   --bnb-price <usd>        pin BNB/USD price (recommended; skips price API)
 *   --skip-threshold-usd <n> skip wallets already holding ≥ this (default = min)
 *   --force                  do not skip already-funded wallets
 *   --seed <int>            deterministic allocation (reproducible dry-run)
 *   --out <path>            results CSV path (default fund-results-<ts>.csv)
 *   --execute               actually broadcast (omit for dry-run)
 */

import { promises as fs } from 'fs'
import { ethers } from 'ethers'
import { buildBscProvider } from '../src/services/bscProvider'

// ───────────────────────── arg parsing ─────────────────────────
function parseArgs(argv: string[]) {
  const a: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const key = t.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      a[key] = true
    } else {
      a[key] = next
      i++
    }
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
const EXECUTE = args.execute === true
const FORCE = args.force === true
const TOTAL_USD = Number(args.total ?? 1000)
const MIN_USD = Number(args.min ?? 15)
const MAX_USD = Number(args.max ?? 30)
const PRICE_OVERRIDE = args['bnb-price'] !== undefined ? Number(args['bnb-price']) : null
const SKIP_THRESHOLD_USD = args['skip-threshold-usd'] !== undefined ? Number(args['skip-threshold-usd']) : MIN_USD
const SEED = args.seed !== undefined ? Number(args.seed) : null
const OUT = typeof args.out === 'string' ? args.out : `fund-results-${Date.now()}.csv`

// ───────────────────────── rng (seedable) ─────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng: () => number = SEED !== null ? mulberry32(SEED) : Math.random

// ───────────────────────── target loading ─────────────────────────
type Target = { name: string; address: string }

async function loadTargets(): Promise<Target[]> {
  if (typeof args.csv === 'string') return loadFromCsv(args.csv)
  if (typeof args.addresses === 'string') return loadFromAddressFile(args.addresses)
  if (args.db === true) return loadFromDb()
  throw new Error(
    'No target source. Pass --csv <fleet-backup.csv>, --addresses <file>, or --db (prod bot only).'
  )
}

async function loadFromCsv(path: string): Promise<Target[]> {
  const csv = await fs.readFile(path, 'utf8')
  const { parseFleetBackupCsv } = await import('../src/services/fleet')
  const rows = parseFleetBackupCsv(csv)
  return rows.map((r) => ({
    name: (r.name ?? '').trim() || '(unnamed)',
    address: (r.wallet_address ?? r.walletAddress ?? '').trim()
  }))
}

async function loadFromAddressFile(path: string): Promise<Target[]> {
  const txt = await fs.readFile(path, 'utf8')
  const out: Target[] = []
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // Accept "name,0x.." or "0x.." or "0x..,name"
    const parts = line.split(',').map((p) => p.trim())
    const addr = parts.find((p) => /^0x[0-9a-fA-F]{40}$/.test(p))
    if (!addr) continue
    const name = parts.find((p) => p !== addr) ?? '(unnamed)'
    out.push({ name, address: addr })
  }
  return out
}

async function loadFromDb(): Promise<Target[]> {
  const { listFleetAgents } = await import('../src/services/fleet')
  const agents = await listFleetAgents()
  return agents.map((a) => ({ name: a.name, address: a.walletAddress }))
}

// dedupe + checksum-validate
function normalizeTargets(raw: Target[]): Target[] {
  const seen = new Set<string>()
  const out: Target[] = []
  for (const t of raw) {
    let checksummed: string
    try {
      checksummed = ethers.getAddress(t.address)
    } catch {
      throw new Error(`Invalid address for "${t.name}": ${t.address}`)
    }
    const key = checksummed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: t.name, address: checksummed })
  }
  return out
}

// ───────────────────────── allocation ─────────────────────────
// Integer-cent allocation guaranteeing each ∈ [min,max] and sum === total.
function allocateCents(n: number, totalC: number, minC: number, maxC: number): number[] {
  if (minC * n > totalC) {
    throw new Error(
      `Infeasible: ${n} wallets × $${(minC / 100).toFixed(2)} min = $${((minC * n) / 100).toFixed(2)} > total $${(totalC / 100).toFixed(2)}`
    )
  }
  if (maxC * n < totalC) {
    throw new Error(
      `Infeasible: ${n} wallets × $${(maxC / 100).toFixed(2)} max = $${((maxC * n) / 100).toFixed(2)} < total $${(totalC / 100).toFixed(2)}`
    )
  }
  const amts = new Array(n).fill(minC)
  let rem = totalC - minC * n
  const cap = maxC - minC
  for (let i = 0; i < n; i++) {
    const slotsLeft = n - 1 - i
    const lo = Math.max(0, rem - slotsLeft * cap)
    const hi = Math.min(cap, rem)
    const extra = lo + Math.floor(rng() * (hi - lo + 1))
    amts[i] += extra
    rem -= extra
  }
  // shuffle so position doesn't correlate with size
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[amts[i], amts[j]] = [amts[j], amts[i]]
  }
  return amts
}

// ───────────────────────── price ─────────────────────────
async function fetchBnbPriceUsd(): Promise<number> {
  if (PRICE_OVERRIDE !== null) {
    if (!(PRICE_OVERRIDE > 0)) throw new Error('--bnb-price must be > 0')
    return PRICE_OVERRIDE
  }
  // Primary: CoinGecko
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd',
      { signal: AbortSignal.timeout(8000) }
    )
    const j: any = await r.json()
    const p = Number(j?.binancecoin?.usd)
    if (p > 0) return p
  } catch {
    /* fall through */
  }
  // Fallback: DexScreener WBNB
  try {
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WBNB}`, {
      signal: AbortSignal.timeout(8000)
    })
    const j: any = await r.json()
    const pairs: any[] = j?.pairs ?? []
    const prices = pairs
      .map((p) => Number(p?.priceUsd))
      .filter((x) => x > 0)
      .sort((a, b) => a - b)
    if (prices.length) return prices[Math.floor(prices.length / 2)]
  } catch {
    /* fall through */
  }
  throw new Error('Could not resolve BNB/USD price. Pass --bnb-price <usd> explicitly.')
}

// ───────────────────────── helpers ─────────────────────────
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const usd = (n: number) => `$${n.toFixed(2)}`

type PlanRow = {
  name: string
  address: string
  usd: number
  bnb: number
  valueWei: bigint
}

// ───────────────────────── main ─────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  FLEET FUNDING  ${EXECUTE ? '🟢 EXECUTE (BROADCASTING)' : '🟡 DRY-RUN (no broadcast)'}`)
  console.log('═══════════════════════════════════════════════════════════\n')

  const targets = normalizeTargets(await loadTargets())
  const n = targets.length
  if (n === 0) throw new Error('No target wallets resolved. Check your --csv/--addresses/--db source.')
  console.log(`Targets: ${n} wallets`)

  // price + allocation
  const price = await fetchBnbPriceUsd()
  console.log(`BNB price: ${usd(price)}${PRICE_OVERRIDE !== null ? ' (override)' : ' (live)'}`)

  const totalC = Math.round(TOTAL_USD * 100)
  const minC = Math.round(MIN_USD * 100)
  const maxC = Math.round(MAX_USD * 100)
  const cents = allocateCents(n, totalC, minC, maxC)

  const plan: PlanRow[] = targets.map((t, i) => {
    const u = cents[i] / 100
    const bnb = u / price
    return {
      name: t.name,
      address: t.address,
      usd: u,
      bnb,
      valueWei: ethers.parseEther(bnb.toFixed(8))
    }
  })

  const sumUsd = plan.reduce((s, r) => s + r.usd, 0)
  const sumWei = plan.reduce((s, r) => s + r.valueWei, 0n)
  console.log(
    `Allocation: ${usd(sumUsd)} total, per-wallet ${usd(Math.min(...plan.map((p) => p.usd)))}–${usd(
      Math.max(...plan.map((p) => p.usd))
    )} (≈ ${ethers.formatEther(sumWei)} BNB)\n`
  )

  // provider + funder
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const funderPk = (process.env.FLEET_FUNDER_PK ?? '').trim()
  let signer: ethers.Wallet | null = null
  let funderAddr = '(FLEET_FUNDER_PK not set)'
  let funderBalWei = 0n
  if (funderPk) {
    signer = new ethers.Wallet(funderPk, provider)
    funderAddr = signer.address
    funderBalWei = await provider.getBalance(funderAddr)
  }

  // gas estimate
  const feeData = await provider.getFeeData()
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei')
  const gasLimit = 21_000n
  const gasTotal = gasPrice * gasLimit * BigInt(n)
  const needWei = sumWei + gasTotal

  console.log(`Funder: ${funderAddr}`)
  if (funderPk) {
    console.log(`Funder balance: ${ethers.formatEther(funderBalWei)} BNB (${usd(Number(ethers.formatEther(funderBalWei)) * price)})`)
  }
  console.log(
    `Need: ${ethers.formatEther(sumWei)} BNB transfers + ${ethers.formatEther(gasTotal)} BNB gas = ${ethers.formatEther(needWei)} BNB\n`
  )

  // skip already-funded
  const skipWei = ethers.parseEther((SKIP_THRESHOLD_USD / price).toFixed(8))
  const decision: Array<PlanRow & { skip: boolean; curWei: bigint }> = []
  console.log(`Checking current balances (skip ≥ ${usd(SKIP_THRESHOLD_USD)})…`)
  for (const r of plan) {
    let curWei = 0n
    try {
      curWei = await provider.getBalance(r.address)
    } catch {
      /* treat as 0; will attempt to fund */
    }
    const skip = !FORCE && curWei >= skipWei
    decision.push({ ...r, skip, curWei })
  }

  const toFund = decision.filter((d) => !d.skip)
  const skipped = decision.filter((d) => d.skip)
  const fundWei = toFund.reduce((s, r) => s + r.valueWei, 0n)
  const fundGas = gasPrice * gasLimit * BigInt(toFund.length)

  // ── plan table ──
  console.log('\n──────── PLAN ────────')
  console.log('  #  name                    address           assigned    current      action')
  decision.forEach((d, i) => {
    const cur = `${Number(ethers.formatEther(d.curWei)).toFixed(4)}BNB`
    const action = d.skip ? 'SKIP (funded)' : 'FUND'
    console.log(
      `  ${String(i + 1).padStart(2)} ${d.name.padEnd(22).slice(0, 22)} ${short(d.address)}  ${usd(d.usd).padStart(7)}  ${cur.padStart(11)}  ${action}`
    )
  })
  console.log('──────────────────────')
  console.log(`To fund: ${toFund.length}   Skipping: ${skipped.length}`)
  console.log(`Will send: ${ethers.formatEther(fundWei)} BNB + ${ethers.formatEther(fundGas)} gas\n`)

  // preflight
  if (funderPk && funderBalWei < fundWei + fundGas) {
    console.error(
      `❌ Funder balance ${ethers.formatEther(funderBalWei)} BNB < required ${ethers.formatEther(fundWei + fundGas)} BNB. Top up the funder and re-run.`
    )
    process.exit(1)
  }

  // results CSV writer
  const results: string[] = ['name,address,usd,bnb,status,tx_hash,reason']
  const writeResults = async () => {
    await fs.writeFile(OUT, results.join('\n') + '\n', 'utf8')
    console.log(`\nResults written → ${OUT}`)
  }

  if (!EXECUTE) {
    for (const d of decision) {
      results.push(
        [d.name, d.address, d.usd.toFixed(2), d.bnb.toFixed(8), d.skip ? 'would-skip' : 'would-fund', '', ''].join(',')
      )
    }
    await writeResults()
    console.log('\n🟡 DRY-RUN complete. No transactions were sent. Re-run with --execute to broadcast.')
    process.exit(0)
  }

  if (!signer) {
    console.error('❌ --execute requires FLEET_FUNDER_PK to be set as a secret.')
    process.exit(1)
  }

  // ── execute: sequential, explicit nonce ──
  let nonce = await provider.getTransactionCount(funderAddr, 'latest')
  let sent = 0
  let failed = 0
  let sentWei = 0n
  console.log(`\n🟢 Broadcasting ${toFund.length} transfers (nonce start ${nonce})…\n`)

  for (const d of decision) {
    if (d.skip) {
      results.push([d.name, d.address, d.usd.toFixed(2), d.bnb.toFixed(8), 'skipped', '', 'already funded'].join(','))
      continue
    }
    try {
      const tx = await signer.sendTransaction({
        to: d.address,
        value: d.valueWei,
        gasLimit,
        gasPrice,
        nonce
      })
      nonce++
      await tx.wait(1)
      sent++
      sentWei += d.valueWei
      console.log(`  ✅ ${d.name.padEnd(22).slice(0, 22)} ${short(d.address)}  ${usd(d.usd)}  ${tx.hash}`)
      results.push([d.name, d.address, d.usd.toFixed(2), d.bnb.toFixed(8), 'sent', tx.hash, ''].join(','))
    } catch (e: any) {
      failed++
      const reason = (e?.shortMessage ?? e?.message ?? String(e)).replace(/[\r\n,]+/g, ' ').slice(0, 200)
      console.error(`  ❌ ${d.name.padEnd(22).slice(0, 22)} ${short(d.address)}  ${usd(d.usd)}  FAILED: ${reason}`)
      results.push([d.name, d.address, d.usd.toFixed(2), d.bnb.toFixed(8), 'failed', '', reason].join(','))
      // refresh nonce in case the failure was a nonce gap
      try {
        nonce = await provider.getTransactionCount(funderAddr, 'latest')
      } catch {
        /* keep going */
      }
    }
  }

  await writeResults()
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log(`  DONE — sent ${sent}, failed ${failed}, skipped ${skipped.length}`)
  console.log(`  Total sent: ${ethers.formatEther(sentWei)} BNB (${usd(Number(ethers.formatEther(sentWei)) * price)})`)
  console.log('═══════════════════════════════════════════════════════════')
  process.exit(failed > 0 ? 2 : 0)
}

main().catch((e) => {
  console.error('[fundFleet] FAILED:', e?.message ?? e)
  process.exit(1)
})

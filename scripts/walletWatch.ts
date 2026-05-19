// ── 2026-05-19 INCIDENT FIX (KSR-BUILD4-INCIDENT-2026-05-17 Phase 4 #22) ────
// Wallet-watch monitoring script.
//
// PURPOSE
//   Every 5 minutes, scan every active user wallet on BSC for outflows
//   to addresses NOT on our allowlist. Alerts to a Telegram channel
//   (env WALLET_WATCH_TG_CHAT) if anything matches. Intended to run as
//   a cron on Render (`*/5 * * * * tsx scripts/walletWatch.ts`) or as
//   a one-shot to backfill the last N hours.
//
// USAGE
//   tsx scripts/walletWatch.ts              # scan last 5 min
//   LOOKBACK_MIN=60 tsx scripts/walletWatch.ts   # scan last 60 min
//   DRY_RUN=true tsx scripts/walletWatch.ts      # don't send alerts
//
// REQUIRED ENV
//   BSC_RPC_URL                — RPC for archive queries
//   WALLET_WATCH_TG_CHAT       — Telegram channel id for alerts
//   TELEGRAM_BOT_TOKEN         — to send alerts
//
// ALLOWLIST
//   Hardcoded below. Whitelisted destinations are:
//   - The user's own custodial wallet (self-transfers OK)
//   - Aster Bridge contract (0x128463a6…)
//   - Hyperliquid Arbitrum bridge
//   - Known stablecoin contracts (USDT, USDC, BUSD) — token contracts
//     receive `transfer` calls; we look at the Transfer-event `to` arg.

import { db } from '../src/db'
import { ethers } from 'ethers'

const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const TG_CHAT = process.env.WALLET_WATCH_TG_CHAT ?? ''
const LOOKBACK_MIN = parseInt(process.env.LOOKBACK_MIN ?? '5', 10)
const DRY_RUN = process.env.DRY_RUN === 'true'

// Allowlisted destinations — outflows here are NORMAL operations, not alerts.
const ALLOWLIST = new Set<string>([
  '0x128463a60784c4d3f46c23af3f65ed859ba87974',  // Aster Bridge (BSC)
  // Add Hyperliquid bridge, PancakeSwap router etc as needed
].map(a => a.toLowerCase()))

// ERC-20 tokens we watch outflows of
const WATCHED_TOKENS = [
  { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  { symbol: 'ASTER', address: '0x000000', decimals: 18 },   // TODO: fill the real BEP-20 contract
  { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
]

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

async function sendAlert(msg: string) {
  if (DRY_RUN || !TG_TOKEN || !TG_CHAT) {
    console.log('[walletWatch] would alert:', msg)
    return
  }
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
    })
  } catch (e: any) {
    console.error('[walletWatch] alert send failed:', e.message)
  }
}

async function main() {
  console.log(`[walletWatch] lookback=${LOOKBACK_MIN}min dry_run=${DRY_RUN}`)
  const provider = new ethers.JsonRpcProvider(BSC_RPC)
  const head = await provider.getBlockNumber()
  // BSC blocks ~3s — LOOKBACK_MIN * 60 / 3 = LOOKBACK_MIN * 20 blocks
  const fromBlock = Math.max(0, head - LOOKBACK_MIN * 20)
  console.log(`[walletWatch] scanning BSC blocks ${fromBlock} → ${head}`)

  const wallets = await db.wallet.findMany({
    where: { chain: 'BSC', isActive: true },
    select: { userId: true, address: true },
  })
  console.log(`[walletWatch] loaded ${wallets.length} active BSC wallets`)
  if (wallets.length === 0) { await db.$disconnect(); return }

  const walletByAddr = new Map(wallets.map(w => [w.address.toLowerCase(), w.userId]))
  // Each wallet is allowed to transfer to itself (consolidation / change addrs)
  const perWalletAllow = new Map<string, Set<string>>()
  for (const w of wallets) {
    perWalletAllow.set(w.address.toLowerCase(), new Set([w.address.toLowerCase()]))
  }

  let alertCount = 0
  for (const tok of WATCHED_TOKENS) {
    if (tok.address.startsWith('0x000000')) continue  // placeholder, skip
    // Query Transfer events FROM any of our wallets in the range. Topic[1]
    // is the indexed `from` address. We can't filter by 800 wallets in
    // one call (RPC topic limit ~500), so we fetch the whole range and
    // filter in-memory. For ~5 min on BSC this is fine; for large
    // backfills, batch the wallet list.
    let logs: any[] = []
    try {
      logs = await provider.getLogs({
        address: tok.address,
        topics: [TRANSFER_TOPIC],
        fromBlock,
        toBlock: head,
      })
    } catch (e: any) {
      console.warn(`[walletWatch] getLogs failed for ${tok.symbol}: ${e.message?.substring(0, 100)}`)
      continue
    }
    for (const log of logs) {
      const fromAddr = '0x' + (log.topics[1] as string).slice(26).toLowerCase()
      if (!walletByAddr.has(fromAddr)) continue
      const toAddr = '0x' + (log.topics[2] as string).slice(26).toLowerCase()
      if (ALLOWLIST.has(toAddr)) continue
      if (perWalletAllow.get(fromAddr)?.has(toAddr)) continue
      const amount = ethers.formatUnits(log.data, tok.decimals)
      const userId = walletByAddr.get(fromAddr)
      const msg =
        `🚨 <b>WALLET-WATCH ALERT</b>\n` +
        `User: <code>${userId?.slice(0, 8)}…</code>\n` +
        `From: <code>${fromAddr}</code>\n` +
        `To:   <code>${toAddr}</code> (NOT on allowlist)\n` +
        `Amount: ${amount} ${tok.symbol}\n` +
        `Tx: https://bscscan.com/tx/${log.transactionHash}\n` +
        `Block: ${log.blockNumber}`
      console.warn(msg.replace(/<[^>]+>/g, ''))
      await sendAlert(msg)
      alertCount++
    }
  }

  console.log(`[walletWatch] scan complete — ${alertCount} alert(s)`)
  await db.$disconnect()
}

main().catch((e) => {
  console.error('[walletWatch] FATAL', e)
  process.exit(1)
})

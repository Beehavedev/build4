import { Bot } from 'grammy'
import { db } from '../../db'
import {
  isTwakConfigured,
  isTradingIntegrationEnabled,
  getPrice,
  getBalance,
  getRisk,
  TWAK_RISK_THRESHOLD
} from '../../services/trustwallet'

const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'

function fmtUsd(n: number | string | undefined): string {
  if (n === undefined || n === null) return 'n/a'
  const v = typeof n === 'string' ? Number(n) : n
  if (!Number.isFinite(v)) return String(n)
  if (v >= 1) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 6 })}`
}

export function registerTrustWallet(bot: Bot) {
  bot.command('trustwallet', async (ctx) => {
    if (!isTwakConfigured()) {
      await ctx.reply(
        '🔵 *Trust Wallet Agent Kit*\n\n' +
        '⚪ Status: Not configured\n\n' +
        'TWAK_ACCESS_ID and TWAK_HMAC_SECRET need to be set on the server. ' +
        'Get keys from portal.trustwallet.com.',
        { parse_mode: 'Markdown' }
      )
      return
    }

    await ctx.reply('🔵 Querying Trust Wallet…')

    // Resolve user wallet for the live balance lookup.
    const user = (ctx as any).dbUser
    const wallet = user
      ? await db.wallet.findFirst({ where: { userId: user.id } })
      : null
    const userAddress = wallet?.address

    // Three calls in parallel — read-only, safe.
    const [btcPrice, bnbPrice, riskWbnb, balance] = await Promise.all([
      getPrice('BTC', 'bsc'),
      getPrice('BNB', 'bsc'),
      getRisk('WBNB'),
      userAddress
        ? getBalance({ address: userAddress, chain: 'bsc', tokenAddress: USDT_BSC })
        : Promise.resolve(null)
    ])

    const lines: string[] = ['🔵 *Powered by Trust Wallet Agent Kit*', '']

    if (btcPrice.ok) lines.push(`₿  BTC: ${fmtUsd(btcPrice.data.priceUsd)} (via TWAK)`)
    else lines.push(`₿  BTC: _unavailable — ${btcPrice.reason.slice(0, 60)}_`)

    if (bnbPrice.ok) lines.push(`🟡 BNB: ${fmtUsd(bnbPrice.data.priceUsd)} (via TWAK)`)
    else lines.push(`🟡 BNB: _unavailable_`)

    lines.push('')
    if (!userAddress) {
      lines.push(`💼 Your USDT balance: _create a wallet to see live balance_`)
    } else if (balance && balance.ok) {
      lines.push(`💼 Your USDT balance: ${balance.data.balance ?? '0'} USDT`)
      lines.push(`   addr: \`${userAddress.slice(0, 6)}…${userAddress.slice(-4)}\``)
    } else {
      lines.push(`💼 Your USDT balance: _lookup failed${balance && !balance.ok ? `: ${balance.reason.slice(0, 50)}` : ''}_`)
    }

    lines.push('')
    if (riskWbnb.ok) {
      const score = Number(riskWbnb.data.riskScore ?? 0)
      const verdict = score <= 3 ? '🟢 Low' : score <= 6 ? '🟡 Medium' : '🔴 High'
      lines.push(`🛡 WBNB Risk Score: ${score}/10 ${verdict}`)
      if (riskWbnb.data.flags?.length) {
        lines.push(`   flags: ${riskWbnb.data.flags.slice(0, 3).join(', ')}`)
      }
    } else {
      lines.push(`🛡 Risk: _unavailable_`)
    }

    lines.push('')
    const trading = isTradingIntegrationEnabled()
    lines.push(`⚙️  Trading-loop integration: ${trading ? '✅ Enabled' : '⚪ Off'}`)
    if (trading) {
      lines.push(`   Trades on tokens scoring above ${TWAK_RISK_THRESHOLD}/10 are auto-skipped.`)
    }
    lines.push('')
    lines.push('✅ Status: Connected')
    lines.push('')
    lines.push('_Get your own keys at portal.trustwallet.com_')

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true }
    })
  })
}

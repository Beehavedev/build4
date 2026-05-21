import { Bot, Context } from 'grammy'
import { isAdminTelegramId } from '../../services/telegramAuth'

// /topazstatus — admin-only env+config snapshot for the Phase 1 Topaz
// DEX integration. Mirrors /campaignstatus shape. Silent no-op for
// non-admins so a non-admin spamming the command can't fingerprint
// that the integration exists.

function isAdmin(ctx: Context): boolean {
  const tg = ctx.from?.id
  if (!tg) return false
  return isAdminTelegramId(BigInt(tg))
}

export function registerTopaz(bot: Bot) {
  bot.command('topazstatus', async (ctx) => {
    if (!isAdmin(ctx)) return
    const { getTopazConfig } = await import('../../services/topaz')
    const cfg = getTopazConfig()
    let masterLine = ''
    if (cfg.enabled && cfg.masterWalletId) {
      try {
        const { getMasterSigner } = await import('../../services/topazTrading')
        const m = await getMasterSigner()
        masterLine = `\nMaster wallet: \`${m.address}\``
      } catch (e) {
        masterLine = `\nMaster wallet: ❌ ${(e as Error).message.slice(0, 200)}`
      }
    }
    const allow = [...cfg.agentAllowlist]
    await ctx.reply(
      `🔷 *Topaz status*\n\n` +
        `TOPAZ_ENABLED: ${cfg.enabled ? '✅ on' : '❌ off'}\n` +
        `TOPAZ_AGENT_ALLOWLIST: ${allow.length === 0 ? '<empty>' : allow.length + ' agent(s)'}\n` +
        `TOPAZ_MASTER_WALLET_ID: \`${cfg.masterWalletId ?? '<unset>'}\`\n` +
        `Router: \`${cfg.router ?? '<unset>'}\`\n` +
        `NPM: \`${cfg.npm ?? '<unset>'}\`\n` +
        `Voter: \`${cfg.voter ?? '<unset>'}\`\n` +
        `MixedQuoter: \`${cfg.mixedQuoter ?? '<unset>'}\`\n` +
        `MaxTradeUsdt: $${cfg.maxTradeUsdt}\n` +
        `DefaultSlippage: ${cfg.defaultSlippageBps} bps\n` +
        `DefaultDeadline: ${cfg.defaultDeadlineSec}s` +
        masterLine,
      { parse_mode: 'Markdown' },
    )
  })
}

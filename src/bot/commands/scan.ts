import { Bot, Context, InlineKeyboard } from 'grammy'
import { scanContract } from '../../services/scanner'

export async function handleScanCommand(ctx: Context, address?: string) {
  const user = (ctx as any).dbUser
  if (!user) return

  const target = address ?? (ctx as any).match?.[1]

  if (!target || target.length < 10) {
    await ctx.reply(
      '🔍 *Contract Scanner*\n\nUsage: `/scan 0xContractAddress`\n\nPaste any BSC/ETH contract address to check for:\n• Honeypot detection\n• Liquidity lock status\n• Owner renounce\n• Mint/blacklist functions\n• Buy/sell tax\n• AI risk assessment',
      { parse_mode: 'Markdown' }
    )
    return
  }

  const scanning = await ctx.reply(`🔍 Scanning \`${target.slice(0, 10)}...\`\n\nRunning honeypot simulation, checking liquidity, analyzing source code...`, { parse_mode: 'Markdown' })

  try {
    const result = await scanContract(target)

    const riskEmoji =
      result.riskScore >= 7 ? '🔴' : result.riskScore >= 4 ? '🟡' : '🟢'
    const riskLabel =
      result.riskScore >= 7
        ? 'HIGH RISK'
        : result.riskScore >= 4
        ? 'MEDIUM RISK'
        : 'LOW RISK'

    let text = `🔍 *Contract Scan — ${result.tokenSymbol}*\n`
    text += `${riskEmoji} Risk Score: *${result.riskScore}/10 (${riskLabel})*\n\n`

    text += `*Findings:*\n`
    result.flags.forEach((flag) => {
      text += `${flag}\n`
    })

    if (result.taxBuy !== null || result.taxSell !== null) {
      text += `\n*Taxes:*\n`
      text += `Buy: ${result.taxBuy}% | Sell: ${result.taxSell}%\n`
    }

    text += `\n🤖 *AI Assessment:*\n${result.aiAssessment}`

    const keyboard = new InlineKeyboard()
      .url('View on BSCScan', `https://bscscan.com/address/${target}`)
      .row()
      .text('🔄 Re-scan', `scan_${target}`)

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    })

    // Update quest progress
    try {
      const quest = await (await import('../../db')).db.quest.findFirst({
        where: { id: 'safe_scanner' }
      })
      if (quest) {
        const { db } = await import('../../db')
        const uq = await db.userQuest.findFirst({
          where: { userId: user.id, questId: quest.id }
        })
        if (uq && !uq.completed) {
          await db.userQuest.update({
            where: { id: uq.id },
            data: { progress: uq.progress + 1, completed: uq.progress + 1 >= 10 }
          })
        }
      }
    } catch {}
  } catch (err) {
    await ctx.reply('❌ Scan failed. Please check the address and try again.')
  }
}

export function registerScan(bot: Bot) {
  bot.command('scan', async (ctx) => {
    const args = ctx.message?.text?.split(' ')
    const address = args?.[1]
    await handleScanCommand(ctx, address)
  })
}

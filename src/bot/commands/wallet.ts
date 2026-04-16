import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'
import { generateAndSaveWallet, importWallet, getWalletBalances, truncateAddress, decryptPrivateKey } from '../../services/wallet'

export async function handleWalletCommand(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  const wallets = await db.wallet.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' }
  })

  if (wallets.length === 0) {
    await ctx.reply('No wallets found. Generating one now...')
    const w = await generateAndSaveWallet(user.id, 'BSC')
    await ctx.reply(`✅ BSC wallet created: \`${w.address}\``, { parse_mode: 'Markdown' })
    return
  }

  const activeWallet = wallets.find((w) => w.isActive) ?? wallets[0]
  const balances = await getWalletBalances(activeWallet.address, activeWallet.chain)

  let text = `💳 *Your Wallets*\n\n`
  text += `*Active: ${activeWallet.label}* (${activeWallet.chain})\n`
  text += `Address: \`${truncateAddress(activeWallet.address)}\`\n`
  text += `USDT: $${balances.usdt.toFixed(2)}\n`
  text += `${balances.nativeSymbol}: ${balances.native.toFixed(4)}\n\n`

  if (wallets.length > 1) {
    text += `*Other wallets:*\n`
    wallets
      .filter((w) => w.id !== activeWallet.id)
      .forEach((w) => {
        text += `• ${w.label} (${w.chain}) — \`${truncateAddress(w.address)}\`\n`
      })
  }

  const keyboard = new InlineKeyboard()
    .text('📋 Copy Address', `copy_addr_${activeWallet.id}`)
    .text('🔄 Refresh', 'wallet_refresh')
    .row()
    .text('🔑 Export Private Key', `export_pk_${activeWallet.id}`)
    .row()
    .text('➕ New Wallet', 'wallet_new')
    .text('🔗 Import', 'wallet_import')

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
}

export function registerWallet(bot: Bot) {
  bot.command('wallet', async (ctx) => {
    await handleWalletCommand(ctx)
  })

  bot.command('linkwallet', async (ctx) => {
    await ctx.reply(
      '🔗 *Import Wallet*\n\nPlease send your private key.\n\n⚠️ Your key is encrypted with AES-256 and never stored in plain text. Delete your message after sending.\n\nType /cancel to abort.',
      { parse_mode: 'Markdown' }
    )
    // In production use Grammy conversations for this flow
  })

  bot.callbackQuery(/^copy_addr_(.+)$/, async (ctx) => {
    const walletId = ctx.match[1]
    const wallet = await db.wallet.findUnique({ where: { id: walletId } })
    if (!wallet) return ctx.answerCallbackQuery('Wallet not found')
    await ctx.answerCallbackQuery({ text: wallet.address, show_alert: true })
  })

  bot.callbackQuery('wallet_refresh', async (ctx) => {
    await ctx.answerCallbackQuery('Refreshing...')
    await handleWalletCommand(ctx)
  })

  bot.callbackQuery('wallet_new', async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return
    const w = await generateAndSaveWallet(user.id, 'BSC')
    await ctx.reply(
      `✅ *New BSC Wallet Generated*\n\nAddress: \`${w.address}\`\n\nThis is now your active wallet.`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.callbackQuery(/^export_pk_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return
    const walletId = ctx.match[1]
    const wallet = await db.wallet.findUnique({ where: { id: walletId } })
    if (!wallet || wallet.userId !== user.id) {
      await ctx.reply('Wallet not found.')
      return
    }
    if (!wallet.encryptedPK) {
      await ctx.reply('No private key available for this wallet (it was imported as read-only).')
      return
    }
    try {
      const pk = decryptPrivateKey(wallet.encryptedPK, user.id)
      await ctx.reply(
        `🔑 *Private Key for ${wallet.label}*

*Address:*
\`${wallet.address}\`

*Private Key:*
\`${pk}\`

⚠️ *Anyone with this key controls your funds.*
• Save it in a password manager.
• Never share it or paste it into any website.
• Delete this message after saving.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err: any) {
      console.error('[Wallet] export PK failed:', err)
      await ctx.reply('❌ Could not decrypt private key.')
    }
  })

  bot.callbackQuery('wallet_import', async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.reply(
      '🔗 Send your private key as the next message.\n\n⚠️ It will be AES-256 encrypted immediately. Delete the message after.\n\n/cancel to abort.'
    )
  })
}

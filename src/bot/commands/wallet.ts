import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'
import {
  generateAndSaveWallet,
  importWallet,
  getWalletBalances,
  getArbitrumBalances,
  truncateAddress,
  decryptPrivateKey,
  reencryptUserWallets
} from '../../services/wallet'
import {
  hashPin,
  verifyPin,
  logSecurityEvent,
  checkExportRateLimit,
  checkPinFailLimit,
  setPendingPinPrompt,
  consumePendingPinPrompt,
  peekPendingPinPrompt,
  PK_EXPORT_LIMIT_PER_24H
} from '../../services/security'

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
  // Same address works on every EVM chain — pull both BSC and Arbitrum
  // balances in parallel so users can see funds on either network.
  const [balances, arb] = await Promise.all([
    getWalletBalances(activeWallet.address, activeWallet.chain),
    getArbitrumBalances(activeWallet.address)
  ])
  const pinSet = !!user.pinHash

  let text = `💳 *Your Wallets*\n\n`
  text += `*Active: ${activeWallet.label}*\n`
  text += `Address: \`${truncateAddress(activeWallet.address)}\`\n\n`
  text += `*BSC*\n`
  text += `• USDT: $${balances.usdt.toFixed(2)}\n`
  text += `• ${balances.nativeSymbol}: ${balances.native.toFixed(4)}\n\n`
  text += `*Arbitrum*\n`
  text += `• USDC: $${arb.usdc.toFixed(2)}\n`
  text += `• ETH: ${arb.eth.toFixed(5)}\n`
  if (arb.usdc >= 5) {
    text += `\n💡 You have USDC on Arbitrum — you can bridge it to *Hyperliquid* from the mini app to trade perps.\n\n`
  } else {
    text += `\n`
  }
  text += `🔒 PIN protection: *${pinSet ? 'ON' : 'OFF'}*${pinSet ? '' : ' — use /setpin to enable'}\n\n`

  if (wallets.length > 1) {
    text += `*Other wallets:* (tap *Switch* below to make active)\n`
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

  wallets
    .filter((w) => w.id !== activeWallet.id)
    .slice(0, 5)
    .forEach((w) => {
      keyboard.text(`✅ Switch to ${w.label}`, `wallet_switch_${w.id}`).row()
    })

  keyboard
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
  })

  /* ────────── PIN management commands ────────── */

  bot.command('setpin', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return
    if (user.pinHash) {
      await ctx.reply('🔒 You already have a PIN set. Use /changepin to change it or /removepin to disable.')
      return
    }
    setPendingPinPrompt(ctx.from!.id, { walletId: '', userId: user.id, purpose: 'set' })
    await ctx.reply(
      '🔒 *Set Wallet PIN*\n\nReply with a 4–8 digit PIN.\n\nThis PIN will be required to export any private key, and is mixed into the encryption of your wallet keys (so even a database leak cannot expose your funds without the PIN).\n\n⚠️ *If you forget your PIN, your wallets cannot be recovered.* Save it somewhere safe.\n\n/cancel to abort.',
      { parse_mode: 'Markdown' }
    )
  })

  bot.command('changepin', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return
    if (!user.pinHash) {
      await ctx.reply('You don\'t have a PIN yet. Use /setpin first.')
      return
    }
    setPendingPinPrompt(ctx.from!.id, { walletId: '', userId: user.id, purpose: 'change_old' })
    await ctx.reply('🔒 Reply with your *current* PIN. /cancel to abort.', { parse_mode: 'Markdown' })
  })

  bot.command('removepin', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return
    if (!user.pinHash) {
      await ctx.reply('You don\'t have a PIN set.')
      return
    }
    setPendingPinPrompt(ctx.from!.id, { walletId: '', userId: user.id, purpose: 'remove' })
    await ctx.reply('🔒 Reply with your current PIN to disable PIN protection. /cancel to abort.', { parse_mode: 'Markdown' })
  })

  /* ────────── Wallet display callbacks ────────── */

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

  bot.callbackQuery(/^wallet_switch_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return
    const walletId = ctx.match[1]
    const wallet = await db.wallet.findUnique({ where: { id: walletId } })
    if (!wallet || wallet.userId !== user.id) {
      await ctx.reply('Wallet not found.')
      return
    }
    await db.wallet.updateMany({
      where: { userId: user.id, chain: wallet.chain, isActive: true },
      data: { isActive: false }
    })
    await db.wallet.update({ where: { id: wallet.id }, data: { isActive: true } })
    await logSecurityEvent({ userId: user.id, telegramId: ctx.from!.id, action: 'wallet_switched', walletId: wallet.id })
    await ctx.reply(`✅ *${wallet.label}* is now your active ${wallet.chain} wallet.`, { parse_mode: 'Markdown' })
    await handleWalletCommand(ctx)
  })

  /* ────────── Export PK with rate limit + PIN gate ────────── */

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
      await ctx.reply('No private key available for this wallet (read-only import).')
      return
    }

    // Rate limit check
    const rl = await checkExportRateLimit(user.id)
    if (!rl.allowed) {
      await logSecurityEvent({ userId: user.id, telegramId: ctx.from!.id, action: 'pk_export_denied_rate_limit', walletId })
      await ctx.reply(`🛑 *Rate limit reached.*\n\nYou can export at most ${PK_EXPORT_LIMIT_PER_24H} private keys per 24 hours. Try again later.\n\nThis limit exists to protect you if your Telegram account is ever compromised.`, { parse_mode: 'Markdown' })
      return
    }

    // PIN gate
    if (user.pinHash) {
      const lock = await checkPinFailLimit(user.id)
      if (!lock.allowed) {
        await ctx.reply('🛑 Too many failed PIN attempts. Try again in 1 hour.')
        return
      }
      setPendingPinPrompt(ctx.from!.id, { walletId, userId: user.id, purpose: 'export' })
      await ctx.reply(`🔒 Reply with your PIN to export *${wallet.label}*.\n\n${rl.remaining} export(s) remaining today. /cancel to abort.`, { parse_mode: 'Markdown' })
      return
    }

    // No PIN — export directly (with audit + warning)
    try {
      const pk = decryptPrivateKey(wallet.encryptedPK, user.id)
      await logSecurityEvent({ userId: user.id, telegramId: ctx.from!.id, action: 'pk_export_success', walletId, meta: { pinProtected: false } })
      await ctx.reply(
        `🔑 *Private Key for ${wallet.label}*\n\n*Address:*\n\`${wallet.address}\`\n\n*Private Key:*\n\`${pk}\`\n\n⚠️ *Anyone with this key controls your funds.*\n• Save it in a password manager.\n• Never paste it into any website.\n• Delete this message after saving.\n• Use /setpin to add PIN protection (recommended).\n\n_${rl.remaining - 1} export(s) remaining today._`,
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

/* ────────── PIN reply handler — wired into bot text-message middleware ────────── */

export async function handlePinReply(ctx: Context): Promise<boolean> {
  if (!ctx.from || !ctx.message?.text) return false
  const pending = peekPendingPinPrompt(ctx.from.id)
  if (!pending) return false

  const text = ctx.message.text.trim()
  if (text === '/cancel') {
    consumePendingPinPrompt(ctx.from.id)
    await ctx.reply('Cancelled.')
    return true
  }
  if (!/^\d{4,8}$/.test(text)) {
    await ctx.reply('PIN must be 4–8 digits. Try again or /cancel.')
    return true
  }

  // Try to delete the user's PIN message immediately for safety
  try { await ctx.deleteMessage() } catch {}

  const user = await db.user.findUnique({ where: { id: pending.userId } })
  if (!user) { consumePendingPinPrompt(ctx.from.id); return true }

  /* ───── SET PIN (first time) ───── */
  if (pending.purpose === 'set') {
    consumePendingPinPrompt(ctx.from.id)
    const { hash, salt } = hashPin(text)
    await reencryptUserWallets(user.id, undefined, text)
    await db.user.update({ where: { id: user.id }, data: { pinHash: hash, pinSalt: salt } })
    await logSecurityEvent({ userId: user.id, telegramId: ctx.from.id, action: 'pin_set' })
    await ctx.reply('✅ PIN set. All your wallets are now PIN-protected. You\'ll need this PIN to export any private key.\n\n⚠️ *If you lose this PIN, your wallets cannot be recovered.*', { parse_mode: 'Markdown' })
    return true
  }

  /* ───── CHANGE PIN — verify old, then ask for new ───── */
  if (pending.purpose === 'change_old') {
    if (!user.pinHash || !user.pinSalt || !verifyPin(text, user.pinHash, user.pinSalt)) {
      await logSecurityEvent({ userId: user.id, telegramId: ctx.from.id, action: 'pin_failed', meta: { context: 'change_old' } })
      consumePendingPinPrompt(ctx.from.id)
      await ctx.reply('❌ Wrong PIN. /changepin to retry.')
      return true
    }
    setPendingPinPrompt(ctx.from.id, { walletId: '', userId: user.id, purpose: 'change_new', oldPin: text })
    await ctx.reply('✅ Verified. Now reply with your *new* 4–8 digit PIN.', { parse_mode: 'Markdown' })
    return true
  }
  if (pending.purpose === 'change_new') {
    consumePendingPinPrompt(ctx.from.id)
    const { hash, salt } = hashPin(text)
    await reencryptUserWallets(user.id, pending.oldPin, text)
    await db.user.update({ where: { id: user.id }, data: { pinHash: hash, pinSalt: salt } })
    await logSecurityEvent({ userId: user.id, telegramId: ctx.from.id, action: 'pin_changed' })
    await ctx.reply('✅ PIN changed. All wallets re-encrypted with the new PIN.')
    return true
  }

  /* ───── REMOVE PIN ───── */
  if (pending.purpose === 'remove') {
    consumePendingPinPrompt(ctx.from.id)
    if (!user.pinHash || !user.pinSalt || !verifyPin(text, user.pinHash, user.pinSalt)) {
      await logSecurityEvent({ userId: user.id, telegramId: ctx.from.id, action: 'pin_failed', meta: { context: 'remove' } })
      await ctx.reply('❌ Wrong PIN. /removepin to retry.')
      return true
    }
    await reencryptUserWallets(user.id, text, undefined)
    await db.user.update({ where: { id: user.id }, data: { pinHash: null, pinSalt: null } })
    await logSecurityEvent({ userId: user.id, telegramId: ctx.from.id, action: 'pin_removed' })
    await ctx.reply('🔓 PIN removed. Wallets re-encrypted without PIN. Consider /setpin again — PIN protection is recommended.')
    return true
  }

  /* ───── EXPORT PK ───── */
  if (pending.purpose === 'export') {
    consumePendingPinPrompt(ctx.from.id)
    const wallet = await db.wallet.findUnique({ where: { id: pending.walletId } })
    if (!wallet || wallet.userId !== user.id || !wallet.encryptedPK) {
      await ctx.reply('Wallet not found.')
      return true
    }
    if (!user.pinHash || !user.pinSalt || !verifyPin(text, user.pinHash, user.pinSalt)) {
      await logSecurityEvent({ userId: user.id, telegramId: ctx.from.id, action: 'pk_export_denied_bad_pin', walletId: wallet.id })
      await ctx.reply('❌ Wrong PIN. Click *Export Private Key* in /wallet to retry.', { parse_mode: 'Markdown' })
      return true
    }
    try {
      const pk = decryptPrivateKey(wallet.encryptedPK, user.id, text)
      if (!pk || !pk.startsWith('0x')) throw new Error('decrypt produced invalid PK')
      await logSecurityEvent({ userId: user.id, telegramId: ctx.from.id, action: 'pk_export_success', walletId: wallet.id, meta: { pinProtected: true } })
      const rl = await checkExportRateLimit(user.id)
      await ctx.reply(
        `🔑 *Private Key for ${wallet.label}*\n\n*Address:*\n\`${wallet.address}\`\n\n*Private Key:*\n\`${pk}\`\n\n⚠️ Anyone with this key controls your funds.\n• Save in a password manager.\n• Delete this message after saving.\n\n_${rl.remaining} export(s) remaining today._`,
        { parse_mode: 'Markdown' }
      )
    } catch (err: any) {
      console.error('[Wallet] PIN export failed:', err)
      await ctx.reply('❌ Could not decrypt with this PIN.')
    }
    return true
  }

  return false
}

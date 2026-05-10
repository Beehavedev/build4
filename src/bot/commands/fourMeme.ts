import { Bot, Context } from 'grammy'
import { ethers } from 'ethers'
import {
  isFourMemeEnabled,
  getTokenInfo,
  quoteBuyByBnb,
  quoteSell,
  buyTokenWithBnb,
  sellTokenForBnb,
  isAgentWallet,
  loadUserBscPrivateKey,
} from '../../services/fourMemeTrading'
import {
  isFourMemeLaunchEnabled,
  launchFourMemeTokenForUser,
  LaunchValidationError,
} from '../../services/fourMemeLaunch'

// ── /fourmeme — manual buy/sell of existing four.meme tokens ──────────
//
// All commands are gated behind FOUR_MEME_ENABLED=true. With the flag
// unset (the default), every command silently no-ops so users can't
// even discover the feature exists — we don't want partial rollouts
// surfacing in production while we still finalise the partnership.
//
// Reuses the user's primary BSC wallet (same one used for /wallet,
// /trade, etc.). Module 1 supports BNB-quoted tokens only; BEP20 quote
// surfaces a clear error.
//
// Subcommands:
//   /fourmeme info <token>            — read-only info + AI Creator flag
//   /fourmeme buy  <token> <bnb>      — market buy with 5% slippage
//   /fourmeme sell <token> <amount>   — market sell with 5% slippage

function helpText(): string {
  const launchLine = isFourMemeLaunchEnabled()
    ? `\`/fourmeme launch <NAME> <TICKER> [bnb]\` _\\(attach a photo for the logo, or one is auto\\-generated\\)_\n`
    : ''
  return (
    `🎰 *four\\.meme*\n\n` +
    `Trade existing four\\.meme tokens on BSC \\(BNB\\-quoted only\\)\\.\n\n` +
    `*Usage:*\n` +
    `\`/fourmeme info <token>\`\n` +
    `\`/fourmeme buy <token> <bnb>\`\n` +
    `\`/fourmeme sell <token> <tokenAmount>\`\n` +
    launchLine +
    `\nSlippage cap: 5% \\(server\\-enforced\\)\\.`
  )
}

function fmtBnb(wei: bigint): string {
  return ethers.formatEther(wei).slice(0, 10)
}

function fmtToken(wei: bigint): string {
  // four.meme tokens are 18-dec; truncate for readability
  return ethers.formatUnits(wei, 18).slice(0, 14)
}

function parseSubcommand(text: string): { sub: string; args: string[] } {
  const parts = text.trim().split(/\s+/).slice(1) // drop "/fourmeme"
  return { sub: (parts[0] ?? '').toLowerCase(), args: parts.slice(1) }
}

async function handleInfo(ctx: Context, args: string[]) {
  const token = args[0]
  if (!token || !ethers.isAddress(token)) {
    await ctx.reply('Usage: `/fourmeme info <token>`', { parse_mode: 'Markdown' })
    return
  }
  try {
    const info = await getTokenInfo(token)
    const lines: string[] = []
    lines.push(`*four\\.meme info — \`${token}\`*`)
    lines.push(`Manager: V${info.version} \\(\`${info.tokenManager.slice(0, 10)}…\`\\)`)
    lines.push(`Quote: ${info.quoteIsBnb ? 'BNB' : `BEP20 \`${info.quote.slice(0, 10)}…\``}`)
    if (!info.quoteIsBnb) lines.push('⚠️ BEP20\\-quoted tokens are not supported in Module 1\\.')
    lines.push(`Last price: ${info.lastPriceWei.toString()} wei`)
    lines.push(`Curve: ${(info.fillPct * 100).toFixed(2)}% filled \\(${fmtBnb(info.fundsWei)}/${fmtBnb(info.maxFundsWei)} BNB\\)`)
    lines.push(`Trading fee: ${(info.tradingFeeRate / 100).toFixed(2)}%`)
    if (info.graduatedToPancake) {
      lines.push(`✅ *Graduated to PancakeSwap* — trade on AMM\\.`)
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' })
  } catch (err: any) {
    await ctx.reply(`info failed: ${err?.message ?? err}`)
  }
}

async function handleBuy(ctx: Context, args: string[]) {
  const user = (ctx as any).dbUser
  if (!user) { await ctx.reply('No user record found.'); return }

  const token = args[0]
  const bnbStr = args[1]
  if (!token || !ethers.isAddress(token) || !bnbStr) {
    await ctx.reply('Usage: `/fourmeme buy <token> <bnbAmount>`', { parse_mode: 'Markdown' })
    return
  }
  let bnbWei: bigint
  try { bnbWei = ethers.parseEther(bnbStr) } catch { await ctx.reply('Invalid BNB amount.'); return }
  if (bnbWei <= 0n) { await ctx.reply('BNB amount must be > 0.'); return }

  try {
    const quote = await quoteBuyByBnb(token, bnbWei)
    const { privateKey } = await loadUserBscPrivateKey(user.id)
    const result = await buyTokenWithBnb(privateKey, token, bnbWei)
    await ctx.reply(
      `✅ *four\\.meme buy filled*\n\n` +
        `Token: \`${token}\`\n` +
        `Spent: ${fmtBnb(result.bnbSpentWei)} BNB\n` +
        `Estimated received: ${fmtToken(quote.estimatedAmountWei)} tokens \\(min ${fmtToken(result.minTokensWei)}\\)\n` +
        `Slippage cap: ${result.slippageBps / 100}%\n` +
        `Tx: \`${result.txHash}\``,
      { parse_mode: 'MarkdownV2' },
    )
  } catch (err: any) {
    await ctx.reply(`buy failed: ${err?.message ?? err}`)
  }
}

async function handleSell(ctx: Context, args: string[]) {
  const user = (ctx as any).dbUser
  if (!user) { await ctx.reply('No user record found.'); return }

  const token = args[0]
  const amountStr = args[1]
  if (!token || !ethers.isAddress(token) || !amountStr) {
    await ctx.reply('Usage: `/fourmeme sell <token> <tokenAmount>`', { parse_mode: 'Markdown' })
    return
  }
  let tokenWei: bigint
  try { tokenWei = ethers.parseUnits(amountStr, 18) } catch { await ctx.reply('Invalid token amount.'); return }
  if (tokenWei <= 0n) { await ctx.reply('Token amount must be > 0.'); return }

  try {
    const sq = await quoteSell(token, tokenWei)
    const { privateKey } = await loadUserBscPrivateKey(user.id)
    const result = await sellTokenForBnb(privateKey, token, tokenWei)
    await ctx.reply(
      `✅ *four\\.meme sell filled*\n\n` +
        `Token: \`${token}\`\n` +
        `Sold: ${fmtToken(result.tokensSoldWei)} tokens\n` +
        `Estimated proceeds: ${fmtBnb(sq.fundsWei)} BNB \\(min ${fmtBnb(result.minBnbWei)}\\)\n` +
        `Slippage cap: ${result.slippageBps / 100}%\n` +
        `Tx: \`${result.txHash}\``,
      { parse_mode: 'MarkdownV2' },
    )
  } catch (err: any) {
    await ctx.reply(`sell failed: ${err?.message ?? err}`)
  }
}

// Pull a photo from the current Telegram message (or its caption-bearing
// reply target) and download it from Telegram's CDN. Returns null when
// no photo is attached or download fails — caller falls back to the
// auto-generated SVG/PNG.
async function tryGetTelegramPhoto(ctx: Context): Promise<Buffer | null> {
  const msg: any = ctx.message
  const photoArr = msg?.photo ?? msg?.reply_to_message?.photo
  if (!Array.isArray(photoArr) || photoArr.length === 0) return null
  // Largest photo size is the final element.
  const largest = photoArr[photoArr.length - 1]
  if (!largest?.file_id) return null
  try {
    const file = await ctx.api.getFile(largest.file_id)
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token || !file.file_path) return null
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch (err: any) {
    console.warn('[fourMemeLaunch] photo fetch failed:', err?.message ?? err)
    return null
  }
}

async function handleLaunch(ctx: Context, args: string[]) {
  if (!isFourMemeLaunchEnabled()) {
    await ctx.reply('Token launches are not enabled on this deployment.')
    return
  }
  const user = (ctx as any).dbUser
  if (!user) { await ctx.reply('No user record found.'); return }

  const name = args[0]
  const ticker = args[1]
  const bnb = args[2] ?? '0'
  if (!name || !ticker) {
    await ctx.reply(
      'Usage: `/fourmeme launch <NAME> <TICKER> [bnbInitialBuy]`\n' +
        'Optionally attach a photo as the logo (otherwise one is auto-generated).',
      { parse_mode: 'Markdown' },
    )
    return
  }

  await ctx.reply(`Launching $${ticker}… this can take 30–90s on-chain.`)
  const imageBuffer = await tryGetTelegramPhoto(ctx)

  try {
    const result = await launchFourMemeTokenForUser(user.id, {
      tokenName: name,
      tokenSymbol: ticker,
      initialBuyBnb: bnb,
      imageBuffer: imageBuffer ?? undefined,
    })
    await ctx.reply(
      `✅ *four\\.meme launch confirmed*\n\n` +
        `Name: ${escapeMd(name)}\n` +
        `Ticker: ${escapeMd(ticker)}\n` +
        `Initial buy: ${escapeMd(result.initialBuyBnb)} BNB\n` +
        (result.tokenAddress ? `Token: \`${result.tokenAddress}\`\n` : '') +
        `TX: \`${result.txHash}\`\n` +
        `Page: ${escapeMd(result.launchUrl)}`,
      { parse_mode: 'MarkdownV2' },
    )
  } catch (err: any) {
    if (err instanceof LaunchValidationError) {
      await ctx.reply(`launch invalid: ${err.message}`)
    } else {
      await ctx.reply(`launch failed: ${err?.message ?? err}`)
    }
  }
}

function escapeMd(s: string): string {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c)
}

async function handleAgentStatus(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) { await ctx.reply('No user record found.'); return }
  try {
    const { address } = await loadUserBscPrivateKey(user.id)
    const isAgent = await isAgentWallet(address)
    await ctx.reply(
      `Wallet: \`${address}\`\n` +
        `four\\.meme Agent Creator status: ${isAgent ? '✅ recognised' : '❌ not whitelisted'}\n\n` +
        (isAgent
          ? `Tokens you launch will get the official Agent Creator badge\\.`
          : `Token launches won't carry the badge until your wallet holds an official four\\.meme Agent NFT\\.`),
      { parse_mode: 'MarkdownV2' },
    )
  } catch (err: any) {
    await ctx.reply(`agent-status failed: ${err?.message ?? err}`)
  }
}

export function registerFourMeme(bot: Bot) {
  bot.command('fourmeme', async (ctx) => {
    // Silent no-op when feature flag is off — don't even acknowledge
    // the command exists. Users who pass through here in production
    // before we're ready get nothing back, same as a typo.
    if (!isFourMemeEnabled()) return

    const text = ctx.message?.text ?? ''
    const { sub, args } = parseSubcommand(text)

    switch (sub) {
      case '':
      case 'help':
        await ctx.reply(helpText(), { parse_mode: 'MarkdownV2' })
        return
      case 'info':
        await handleInfo(ctx, args)
        return
      case 'buy':
        await handleBuy(ctx, args)
        return
      case 'sell':
        await handleSell(ctx, args)
        return
      case 'launch':
      case 'create':
        await handleLaunch(ctx, args)
        return
      case 'status':
      case 'agent':
        await handleAgentStatus(ctx)
        return
      default:
        await ctx.reply(`Unknown subcommand "${sub}". Try \`/fourmeme help\`.`, { parse_mode: 'Markdown' })
    }
  })
}

import crypto from 'crypto'
import { Request, Response, NextFunction } from 'express'
import { db } from '../db'
import { generateAndSaveWallet } from './wallet'

export interface TelegramAuthUser {
  id: number
  username?: string
  first_name?: string
}

export function parseInitData(initData: string, botToken: string): TelegramAuthUser | null {
  try {
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash) return null
    params.delete('hash')

    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n')

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

    if (computed !== hash) return null

    const userJson = params.get('user')
    if (!userJson) return null
    return JSON.parse(userJson) as TelegramAuthUser
  } catch {
    return null
  }
}

export async function requireTgUser(req: Request, res: Response, next: NextFunction) {
  const initData = (req.header('x-telegram-init-data') ?? '').trim()
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? ''
  // Split the two failure modes so logs + clients can tell them apart.
  // Before, both surfaced as "Missing Telegram auth" which left us unable
  // to tell whether the bot was misconfigured (operator error, affects
  // ALL users) or the request just came from outside a WebApp (user
  // error, affects one user). The client error string for the
  // user-error case stays "Missing Telegram auth" so the mini-app's
  // initData-empty detector still triggers; the bot-token case gets a
  // distinct string + a loud server log so operators can grep for it.
  if (!botToken) {
    console.error('[tgAuth] TELEGRAM_BOT_TOKEN is not set — every authed request will 401. Set the env var on this deployment.')
    return res.status(500).json({ error: 'Server misconfigured: TELEGRAM_BOT_TOKEN missing' })
  }
  if (!initData) {
    return res.status(401).json({ error: 'Missing Telegram auth' })
  }

  const tgUser = parseInitData(initData, botToken)
  if (!tgUser) return res.status(401).json({ error: 'Invalid Telegram auth' })

  let user = await db.user.findUnique({ where: { telegramId: BigInt(tgUser.id) } })
  if (!user) {
    // First-touch from the mini-app (user reached the WebApp without ever
    // hitting /start in the bot — e.g. opened a t.me/...?startapp=... link
    // or clicked the menu button on a fresh chat). Mirror what the bot's
    // authMiddleware does on /start so the user lands on a usable account
    // instead of a 404 dead-end on every /api/me/* call:
    //   1. Create the User row.
    //   2. Silently provision a BSC wallet (PK never returned anywhere —
    //      it's only ever exportable from /wallet → 🔑 Export, behind
    //      PIN + rate limit. This is the same custodial model the bot
    //      uses today, just reached from the mini-app entry point.)
    //   3. Create the Portfolio row so /api/me/portfolio doesn't 500.
    //   4. Seed UserQuest rows so the Quests tab isn't empty.
    // Any failure inside provisioning is logged but non-fatal — we still
    // attach the user and let downstream endpoints fail loudly with their
    // own error surface rather than blocking the whole request here.
    user = await db.user.create({
      data: {
        telegramId: BigInt(tgUser.id),
        username: tgUser.username,
        firstName: tgUser.first_name
      }
    })

    try {
      await generateAndSaveWallet(user.id, 'BSC', 'Main Wallet')
      await db.portfolio.create({ data: { userId: user.id } })

      const quests = await db.quest.findMany({ where: { isActive: true } })
      for (const quest of quests) {
        await db.userQuest.upsert({
          where: { userId_questId: { userId: user.id, questId: quest.id } },
          update: {},
          create: { userId: user.id, questId: quest.id }
        })
      }

      console.log(`[tgAuth] First-touch provision: ${tgUser.username ?? tgUser.id}`)
    } catch (e) {
      console.error('[tgAuth] First-touch provisioning failed:', e)
    }
  }
  ;(req as any).user = user
  next()
}

/**
 * Returns the set of telegramIds (as strings) allowed to access admin
 * endpoints. Configured via either ADMIN_TELEGRAM_IDS (preferred,
 * comma-separated) or ADMIN_CHAT_ID (legacy single-id alias). Both env
 * vars are merged so deployments using the older name keep working.
 */
export function getAdminTelegramIds(): Set<string> {
  const sources = [
    process.env.ADMIN_TELEGRAM_IDS ?? '',
    process.env.ADMIN_CHAT_ID ?? '',
  ]
  const ids = new Set<string>()
  for (const raw of sources) {
    for (const part of raw.split(',')) {
      const id = part.trim()
      if (id) ids.add(id)
    }
  }
  return ids
}

export function isAdminTelegramId(telegramId: bigint | string | number): boolean {
  return getAdminTelegramIds().has(String(telegramId))
}

/**
 * Express middleware: gates a route to admins only.
 *
 * Two ways to pass:
 *  1. Shared-secret header/query: if `ADMIN_TOKEN` is set in the env, a
 *     request supplying it via the `x-admin-token` header or `?token=` query
 *     param is allowed through (no Telegram user is attached). This path is
 *     intended for CLI/cron/dashboards that can't carry Telegram initData.
 *  2. Telegram admin allowlist: a valid `x-telegram-init-data` header whose
 *     resolved telegramId is listed in `ADMIN_TELEGRAM_IDS`.
 *
 * If neither `ADMIN_TOKEN` nor `ADMIN_TELEGRAM_IDS` is configured the route
 * is effectively closed (returns 401), so admin endpoints are never silently
 * public.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminToken = process.env.ADMIN_TOKEN
  if (adminToken) {
    const supplied = (req.headers['x-admin-token'] as string | undefined)
      ?? (typeof req.query.token === 'string' ? req.query.token : undefined)
    if (supplied && supplied === adminToken) return next()
  }

  const initData = (req.header('x-telegram-init-data') ?? '').trim()
  if (!initData) {
    return res.status(401).json({ error: 'Admin access required' })
  }

  requireTgUser(req, res, (err?: any) => {
    if (err) return next(err)
    const user = (req as any).user
    if (!user || !isAdminTelegramId(user.telegramId)) {
      return res.status(403).json({ error: 'Admin access required' })
    }
    next()
  })
}

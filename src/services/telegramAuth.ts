import crypto from 'crypto'
import { Request, Response, NextFunction } from 'express'
import { db } from '../db'

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
  if (!initData || !botToken) {
    return res.status(401).json({ error: 'Missing Telegram auth' })
  }

  const tgUser = parseInitData(initData, botToken)
  if (!tgUser) return res.status(401).json({ error: 'Invalid Telegram auth' })

  let user = await db.user.findUnique({ where: { telegramId: BigInt(tgUser.id) } })
  if (!user) {
    user = await db.user.create({
      data: {
        telegramId: BigInt(tgUser.id),
        username: tgUser.username,
        firstName: tgUser.first_name
      }
    })
  }
  ;(req as any).user = user
  next()
}

/**
 * Returns the set of telegramIds (as strings) allowed to access admin
 * endpoints. Configured via the comma-separated ADMIN_TELEGRAM_IDS env var.
 */
export function getAdminTelegramIds(): Set<string> {
  const raw = process.env.ADMIN_TELEGRAM_IDS ?? ''
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
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

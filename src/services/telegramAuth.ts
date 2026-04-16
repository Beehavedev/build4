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

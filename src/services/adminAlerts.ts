import type { Bot } from 'grammy'

/**
 * adminAlerts.ts — minimal helper for pushing operational notifications to a
 * fixed set of admin Telegram accounts (separate from end-user alerts).
 *
 * Configure with the comma-separated env var ADMIN_TELEGRAM_IDS, e.g.
 *   ADMIN_TELEGRAM_IDS=12345678,87654321
 *
 * If the env var is empty or unset, sendAdminAlert() is a no-op (with a log
 * line) so dev environments don't crash when something tries to alert.
 */

function parseAdminIds(): string[] {
  const raw = process.env.ADMIN_TELEGRAM_IDS ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
}

export interface AdminAlertResult {
  attempted: number
  sent: number
  failed: number
}

export async function sendAdminAlert(
  bot: Bot | null,
  text: string,
  opts: { parseMode?: 'Markdown' | 'HTML' } = {},
): Promise<AdminAlertResult> {
  const ids = parseAdminIds()
  if (!bot || ids.length === 0) {
    if (ids.length === 0) console.log('[AdminAlert] No ADMIN_TELEGRAM_IDS configured; skipping alert.')
    return { attempted: 0, sent: 0, failed: 0 }
  }

  let sent = 0
  let failed = 0
  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text, {
        parse_mode: opts.parseMode ?? 'Markdown',
      })
      sent++
    } catch (err: any) {
      failed++
      console.error(`[AdminAlert] Failed to send to ${id}:`, err?.message ?? err)
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  return { attempted: ids.length, sent, failed }
}

export function hasAdminTargets(): boolean {
  return parseAdminIds().length > 0
}

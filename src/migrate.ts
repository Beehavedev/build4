import { db } from './db'

interface OldWallet {
  chat_id: string
  wallet_address: string
  is_active: boolean
  encrypted_private_key: string | null
}

interface OldCreds {
  chat_id: string
  encrypted_api_key: string
  encrypted_api_secret: string
}

interface OldPoolUser {
  chat_id: string
  telegram_username: string | null
  total_deposited: number
  current_share: number
  total_pnl: number
}

interface OldReward {
  chat_id: string
  reward_type: string
  amount: string
  claimed: boolean
}

interface OldTradingPrefs {
  chat_id: string
  enabled: boolean
  buy_amount_bnb: string
  take_profit_multiple: number
  stop_loss_multiple: number
  max_positions: number
}

interface OldReferral {
  referrer_chat_id: string
  referred_chat_id: string
  referral_code: string
  status: string
}

export async function migrateOldUsers(): Promise<void> {
  console.log('[Migration] Checking for old user data to migrate...')

  try {
    const existingCount = await db.user.count()
    if (existingCount > 100) {
      console.log(`[Migration] Already have ${existingCount} users in new tables, skipping migration`)
      return
    }

    const hasOldTable = await db.$queryRawUnsafe<any[]>(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'telegram_wallets') as exists`
    )
    if (!hasOldTable?.[0]?.exists) {
      console.log('[Migration] No old telegram_wallets table found, skipping')
      return
    }

    const oldWallets = await db.$queryRawUnsafe<OldWallet[]>(
      `SELECT chat_id, wallet_address, is_active, encrypted_private_key FROM telegram_wallets ORDER BY created_at ASC`
    )
    console.log(`[Migration] Found ${oldWallets.length} old wallets to migrate`)

    const oldCreds = await db.$queryRawUnsafe<OldCreds[]>(
      `SELECT chat_id, encrypted_api_key, encrypted_api_secret FROM aster_credentials`
    ).catch(() => [] as OldCreds[])

    const oldPoolUsers = await db.$queryRawUnsafe<OldPoolUser[]>(
      `SELECT chat_id, telegram_username, total_deposited, current_share, total_pnl FROM pool_users`
    ).catch(() => [] as OldPoolUser[])

    const oldRewards = await db.$queryRawUnsafe<OldReward[]>(
      `SELECT chat_id, reward_type, amount, claimed FROM user_rewards WHERE claimed = false`
    ).catch(() => [] as OldReward[])

    const oldReferrals = await db.$queryRawUnsafe<OldReferral[]>(
      `SELECT referrer_chat_id, referred_chat_id, referral_code, status FROM telegram_bot_referrals`
    ).catch(() => [] as OldReferral[])

    const credsMap = new Map(oldCreds.map(c => [c.chat_id, c]))
    const poolMap = new Map(oldPoolUsers.map(p => [p.chat_id, p]))
    const rewardsMap = new Map<string, number>()
    for (const r of oldRewards) {
      const prev = rewardsMap.get(r.chat_id) || 0
      rewardsMap.set(r.chat_id, prev + parseFloat(r.amount || '0'))
    }
    const referralMap = new Map(oldReferrals.map(r => [r.referred_chat_id, r.referral_code]))

    const chatIds = [...new Set(oldWallets.map(w => w.chat_id))]
    let migrated = 0
    let skipped = 0

    for (const chatId of chatIds) {
      const telegramId = BigInt(chatId)

      const exists = await db.user.findUnique({ where: { telegramId } })
      if (exists) {
        skipped++
        continue
      }

      const pool = poolMap.get(chatId)
      const creds = credsMap.get(chatId)
      const b4Balance = rewardsMap.get(chatId) || 0
      const referralCode = referralMap.get(chatId)

      const user = await db.user.create({
        data: {
          telegramId,
          username: pool?.telegram_username || null,
          firstName: null,
          referredBy: referralCode || null,
          subscriptionTier: 'free',
          totalFeesSpent: 0,
          b4Balance,
          asterApiKey: creds?.encrypted_api_key || null,
          asterApiSecret: creds?.encrypted_api_secret || null,
          asterOnboarded: !!creds,
        }
      })

      const wallets = oldWallets.filter(w => w.chat_id === chatId)
      for (const w of wallets) {
        await db.wallet.create({
          data: {
            userId: user.id,
            chain: 'BSC',
            address: w.wallet_address,
            encryptedPK: w.encrypted_private_key || '',
            label: 'Wallet 1',
            isActive: w.is_active,
          }
        })
      }

      if (pool && pool.total_pnl !== 0) {
        await db.portfolio.create({
          data: {
            userId: user.id,
            totalValue: pool.current_share,
            totalPnl: pool.total_pnl,
            totalPnlPct: 0,
            dayPnl: 0,
          }
        })
      }

      migrated++
      if (migrated % 500 === 0) {
        console.log(`[Migration] Migrated ${migrated}/${chatIds.length} users...`)
      }
    }

    console.log(`[Migration] Complete: ${migrated} migrated, ${skipped} already existed`)
  } catch (err: any) {
    console.error('[Migration] Error:', err.message)
    console.log('[Migration] Continuing with startup — old users will auto-register on next /start')
  }
}

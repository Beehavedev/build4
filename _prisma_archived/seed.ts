import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  console.log('Seeding quests...')

  const quests = [
    {
      title: 'First Trade',
      description: 'Execute your first trade with any agent',
      reward: 50,
      type: 'milestone',
      requirement: { action: 'trade', count: 1 }
    },
    {
      title: 'Signal Hunter',
      description: 'Act on 3 whale signals',
      reward: 100,
      type: 'weekly',
      requirement: { action: 'signal_act', count: 3 }
    },
    {
      title: 'Consistent Trader',
      description: 'Trade 7 days in a row',
      reward: 200,
      type: 'milestone',
      requirement: { action: 'daily_trade', count: 7 }
    },
    {
      title: 'Token Creator',
      description: 'Launch your first token',
      reward: 500,
      type: 'milestone',
      requirement: { action: 'launch_token', count: 1 }
    },
    {
      title: 'Copy Leader',
      description: 'Get 5 people copying your trades',
      reward: 300,
      type: 'milestone',
      requirement: { action: 'copy_followers', count: 5 }
    },
    {
      title: 'Safe Scanner',
      description: 'Scan 10 contracts for safety',
      reward: 75,
      type: 'weekly',
      requirement: { action: 'scan_contract', count: 10 }
    },
    {
      title: 'Agent Builder',
      description: 'Run an agent for 7 consecutive days',
      reward: 250,
      type: 'milestone',
      requirement: { action: 'agent_days', count: 7 }
    },
    {
      title: 'Whale Watcher',
      description: 'Check signals 5 days in a row',
      reward: 80,
      type: 'weekly',
      requirement: { action: 'check_signals', count: 5 }
    },
    {
      title: 'Portfolio Builder',
      description: 'Reach $1000 total portfolio value',
      reward: 500,
      type: 'milestone',
      requirement: { action: 'portfolio_value', count: 1000 }
    }
  ]

  for (const quest of quests) {
    await db.quest.upsert({
      where: { id: quest.title.toLowerCase().replace(/ /g, '_') },
      update: quest,
      create: { id: quest.title.toLowerCase().replace(/ /g, '_'), ...quest }
    })
  }

  console.log('✅ Seeded', quests.length, 'quests')
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect())

/**
 * Manual trigger for the market-creator agent — useful for demos and for
 * smoke-testing the pipeline outside the cron schedule.
 *
 * Usage:
 *   npx tsx scripts/runMarketCreator.ts
 *
 * No bot is passed, so admin alerts are skipped (proposals still land in
 * the DB and are visible via GET /api/admin/market-proposals).
 */

import { runMarketCreator } from '../src/agents/marketCreator'

async function main() {
  console.log('Running market-creator agent…\n')
  const result = await runMarketCreator()
  console.log('\n=== RESULT ===')
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})

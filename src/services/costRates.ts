import { db } from '../db'
import { DEFAULT_COST_USD_PER_MTOKENS } from './swarmStats'

/**
 * CRUD for the ProviderCostRate table (Task #23). Used by the admin
 * cost-rates screen to override the hardcoded defaults in swarmStats without
 * a redeploy. Read order in getSwarmStats: defaults → env → DB rows.
 */

export interface CostRateRow {
  provider: string
  usdPer1MTokens: number
  updatedAt: string | null
  updatedBy: string | null
  isDefault: boolean
  defaultUsdPer1MTokens: number | null
}

interface RawRow {
  provider: string
  usdPer1MTokens: number | string
  updatedAt: Date | string | null
  updatedBy: string | null
}

export async function listCostRates(): Promise<CostRateRow[]> {
  const rows = await db.$queryRawUnsafe<RawRow[]>(
    'SELECT "provider", "usdPer1MTokens", "updatedAt", "updatedBy" FROM "ProviderCostRate"',
  )
  const overridden = new Map<string, RawRow>(rows.map((r) => [r.provider, r]))
  const providers = new Set<string>([
    ...Object.keys(DEFAULT_COST_USD_PER_MTOKENS),
    ...overridden.keys(),
  ])

  return [...providers]
    .sort()
    .map<CostRateRow>((provider) => {
      const row = overridden.get(provider)
      // Defaults are now split into input/output rates (Task #24). The
      // ProviderCostRate table only stores a single number, so we surface
      // the output-side default — that's the dominant cost factor and the
      // most useful comparison for the admin UI.
      const defRate = DEFAULT_COST_USD_PER_MTOKENS[provider]
      const def = defRate ? defRate.output : null
      if (row) {
        const updatedAt =
          row.updatedAt instanceof Date
            ? row.updatedAt.toISOString()
            : row.updatedAt
              ? new Date(row.updatedAt).toISOString()
              : null
        return {
          provider,
          usdPer1MTokens: Number(row.usdPer1MTokens),
          updatedAt,
          updatedBy: row.updatedBy,
          isDefault: false,
          defaultUsdPer1MTokens: def,
        }
      }
      return {
        provider,
        usdPer1MTokens: def ?? 0,
        updatedAt: null,
        updatedBy: null,
        isDefault: true,
        defaultUsdPer1MTokens: def,
      }
    })
}

export async function upsertCostRate(
  provider: string,
  usdPer1MTokens: number,
  updatedBy: string | null,
): Promise<void> {
  if (!/^[a-z0-9_-]{1,64}$/i.test(provider)) {
    throw new Error('Invalid provider name')
  }
  if (!Number.isFinite(usdPer1MTokens) || usdPer1MTokens < 0 || usdPer1MTokens > 10_000) {
    throw new Error('Rate must be a finite number between 0 and 10000')
  }
  await db.$executeRawUnsafe(
    `INSERT INTO "ProviderCostRate" ("provider", "usdPer1MTokens", "updatedAt", "updatedBy")
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT ("provider") DO UPDATE
       SET "usdPer1MTokens" = EXCLUDED."usdPer1MTokens",
           "updatedAt"      = NOW(),
           "updatedBy"      = EXCLUDED."updatedBy"`,
    provider,
    usdPer1MTokens,
    updatedBy,
  )
}

export async function deleteCostRate(provider: string): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM "ProviderCostRate" WHERE "provider" = $1', provider)
}

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────
// Schema drift guard.
//
// Render's deploy runs `prisma db push --accept-data-loss` against
// src/_prisma_bot/schema.prisma. That command DROPS any column not declared
// in the schema, and ALTERS any column whose type/default disagrees with the
// schema. Several columns are created at runtime via
// `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in src/ensureTables.ts and read
// via raw SQL, so it's easy to forget to also declare them in the Prisma
// schema — or to declare them with a mismatched type/default. When that
// happens the column is dropped+re-added (or altered) on every deploy and
// reset to its DEFAULT, silently wiping every user's setting (this is exactly
// how the four.meme launch toggle reset to false for everyone).
//
// This test parses every `ALTER TABLE "Agent"/"User" ADD COLUMN` in
// ensureTables.ts (capturing its SQL type + DEFAULT) and the matching field
// in the Agent/User models of src/_prisma_bot/schema.prisma (its Prisma type
// + @default). It fails loudly when a column is:
//   1. present in ensureTables but absent from the schema, OR
//   2. declared in both but with a non-equivalent TYPE or DEFAULT.
// ─────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const ensureTablesPath = join(__dirname, 'ensureTables.ts')
const schemaPath = join(__dirname, '_prisma_bot', 'schema.prisma')

const TABLES = ['Agent', 'User'] as const
type Table = (typeof TABLES)[number]

interface SqlColumn {
  sqlType: string
  sqlDefault: string | null
}
interface PrismaField {
  prismaType: string
  prismaDefault: string | null
}

/**
 * Equivalence map: normalized SQL type -> expected Prisma scalar type.
 * TIMESTAMP(n)/TIMESTAMPTZ are handled separately (precision varies) and all
 * map to DateTime. Extend this table when ensureTables.ts starts using a new
 * SQL type.
 */
const SQL_TO_PRISMA_TYPE: Record<string, string> = {
  BOOLEAN: 'Boolean',
  INTEGER: 'Int',
  TEXT: 'String',
  'DOUBLE PRECISION': 'Float',
  'TEXT[]': 'String[]',
}

/** Resolve a raw SQL type string to the Prisma type it should map to, or null if unknown. */
function sqlTypeToPrisma(sqlType: string): string | null {
  const t = sqlType.trim().replace(/\s+/g, ' ').toUpperCase()
  if (/^TIMESTAMP(\(\d+\))?$/.test(t) || t === 'TIMESTAMPTZ') return 'DateTime'
  return SQL_TO_PRISMA_TYPE[t] ?? null
}

/**
 * Reduce a default expression (from either side) to a canonical token so the
 * two sides can be compared directly. Returns null for "no default".
 *   - empty array:  ARRAY[]::TEXT[]  and  []        -> "[]"
 *   - boolean:      true/false                       -> "true"/"false"
 *   - string:       'BSC'  and  "BSC"                -> "str:BSC"
 *   - number:       0.10 / 5 / 14                     -> "num:0.1" / "num:5" / "num:14"
 */
function canonicalDefault(raw: string | null): string | null {
  if (raw == null) return null
  const v = raw.trim()
  if (v === '') return null
  if (/^ARRAY\s*\[\s*\]\s*::\s*\w+\[\]$/i.test(v) || v === '[]') return '[]'
  if (/^(true|false)$/i.test(v)) return v.toLowerCase()
  const sq = v.match(/^'(.*)'$/)
  if (sq) return 'str:' + sq[1]
  const dq = v.match(/^"(.*)"$/)
  if (dq) return 'str:' + dq[1]
  const n = Number(v)
  if (!Number.isNaN(n)) return 'num:' + n
  return 'raw:' + v
}

/**
 * Extract every column added per table via
 * `ALTER TABLE "<table>" ADD COLUMN [IF NOT EXISTS] "<col>" <definition>` in
 * ensureTables.ts, parsing the SQL type and DEFAULT out of <definition>.
 */
function ensureTablesColumns(source: string): Record<Table, Map<string, SqlColumn>> {
  const out: Record<Table, Map<string, SqlColumn>> = { Agent: new Map(), User: new Map() }
  const re =
    /ALTER\s+TABLE\s+"(Agent|User)"\s+ADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+"([^"]+)"\s+([^`]+)`/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const table = m[1] as Table
    const col = m[2]
    const def = m[3].trim()
    // Type = everything before the first "NOT NULL" or "DEFAULT" keyword.
    const sqlType = def.split(/\s+(?:NOT\s+NULL|DEFAULT)\b/i)[0].trim()
    const defMatch = def.match(/\bDEFAULT\s+(.+?)\s*$/i)
    out[table].set(col, { sqlType, sqlDefault: defMatch ? defMatch[1].trim() : null })
  }
  return out
}

/**
 * Extract the scalar field declarations inside a Prisma `model <name> { ... }`
 * block, capturing each field's type (with any trailing `?`/`[]`) and its
 * @default(...) value. Comments (//), block attributes (@@) and blank lines
 * are skipped.
 */
function schemaModelFields(schema: string, model: string): Map<string, PrismaField> {
  const re = new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`)
  const match = schema.match(re)
  assert.ok(match, `Could not find "model ${model}" block in schema.prisma`)
  const fields = new Map<string, PrismaField>()
  for (const raw of match![1].split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('@@')) continue
    const fm = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9_]*(?:\[\])?\??)/)
    if (!fm) continue
    const defMatch = line.match(/@default\(([^)]*)\)/)
    fields.set(fm[1], { prismaType: fm[2], prismaDefault: defMatch ? defMatch[1].trim() : null })
  }
  return fields
}

describe('schema drift: ensureTables.ts ↔ src/_prisma_bot/schema.prisma', () => {
  const ensureSource = readFileSync(ensureTablesPath, 'utf8')
  const schemaSource = readFileSync(schemaPath, 'utf8')
  const altered = ensureTablesColumns(ensureSource)

  it('parsed a non-trivial number of ALTER columns (parser sanity check)', () => {
    const total = altered.Agent.size + altered.User.size
    assert.ok(
      total >= 10,
      `Expected to parse many ALTER TABLE ADD COLUMN statements, found ${total}. ` +
        'The parser may be broken or ensureTables.ts moved.',
    )
  })

  for (const table of TABLES) {
    it(`every ALTER-added "${table}" column is declared in schema.prisma`, () => {
      const declared = schemaModelFields(schemaSource, table)
      const missing = [...altered[table].keys()].filter((c) => !declared.has(c)).sort()
      assert.deepEqual(
        missing,
        [],
        `\n\n${missing.length} column(s) are added via ALTER TABLE in ` +
          `src/ensureTables.ts but are MISSING from the "${table}" model in ` +
          `src/_prisma_bot/schema.prisma:\n` +
          missing.map((c) => `  - ${c}`).join('\n') +
          `\n\nDeploys run \`prisma db push --accept-data-loss\` against that ` +
          `schema, which DROPS any column not declared there — silently ` +
          `wiping these values on every deploy. Add each column above to the ` +
          `"${table}" model in src/_prisma_bot/schema.prisma (matching the ` +
          `ensureTables.ts type/default) to fix.\n`,
      )
    })

    it(`every ALTER-added "${table}" column has a matching TYPE and DEFAULT in schema.prisma`, () => {
      const declared = schemaModelFields(schemaSource, table)
      const mismatches: string[] = []

      for (const [col, sql] of altered[table]) {
        const field = declared.get(col)
        if (!field) continue // missing-column case handled by the test above

        // ── TYPE ────────────────────────────────────────────────────────
        const expectedPrismaType = sqlTypeToPrisma(sql.sqlType)
        if (expectedPrismaType == null) {
          mismatches.push(
            `  - ${col}: unknown SQL type "${sql.sqlType}" in ensureTables.ts. ` +
              `Add it to SQL_TO_PRISMA_TYPE in this test.`,
          )
        } else {
          const actualPrismaType = field.prismaType.replace(/\?$/, '') // nullability ignored
          if (actualPrismaType !== expectedPrismaType) {
            mismatches.push(
              `  - ${col}: TYPE mismatch — ensureTables.ts says "${sql.sqlType}" ` +
                `(expects Prisma "${expectedPrismaType}") but schema.prisma declares ` +
                `"${field.prismaType}".`,
            )
          }
        }

        // ── DEFAULT ─────────────────────────────────────────────────────
        const sqlDef = canonicalDefault(sql.sqlDefault)
        const prismaDef = canonicalDefault(field.prismaDefault)
        if (sqlDef !== prismaDef) {
          mismatches.push(
            `  - ${col}: DEFAULT mismatch — ensureTables.ts says ` +
              `${sql.sqlDefault == null ? '(no default)' : `"${sql.sqlDefault}"`} ` +
              `but schema.prisma says ` +
              `${field.prismaDefault == null ? '(no default)' : `"${field.prismaDefault}"`}.`,
          )
        }
      }

      assert.deepEqual(
        mismatches,
        [],
        `\n\n${mismatches.length} column(s) added via ALTER TABLE in ` +
          `src/ensureTables.ts have a TYPE or DEFAULT that disagrees with the ` +
          `"${table}" model in src/_prisma_bot/schema.prisma:\n` +
          mismatches.join('\n') +
          `\n\nDeploys run \`prisma db push --accept-data-loss\` against that ` +
          `schema, which ALTERS any column whose type/default differs — this can ` +
          `silently reset user values on every deploy. Make the ensureTables.ts ` +
          `ALTER and the schema.prisma field agree to fix.\n`,
      )
    })
  }
})

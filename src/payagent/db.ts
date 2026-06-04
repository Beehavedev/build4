// Build4 Pay Agent — dedicated, isolated database connection.
//
// WHY a separate pool + schema: the bot's production database runs
// `prisma db push --accept-data-loss` on every deploy, which DROPS any table
// in the `public` schema that isn't in the bot's Prisma model. To keep Pay
// Agent data safe we (a) connect via PAYAGENT_DATABASE_URL when set (a fully
// separate database in prod) and (b) put EVERY table in a dedicated
// `payagent` Postgres schema so even when we fall back to DATABASE_URL in dev
// the bot's public-schema push can never touch us.
import { Pool, types } from 'pg'

// Return DATE (oid 1082) columns as raw 'YYYY-MM-DD' strings instead of JS
// Date objects, which would otherwise shift by a day across timezones.
types.setTypeParser(1082, (v) => v)

const SCHEMA = 'payagent'

function resolveUrl(): string {
  const url = process.env.PAYAGENT_DATABASE_URL || process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      '[payagent] No database URL. Set PAYAGENT_DATABASE_URL (preferred, a dedicated DB) or DATABASE_URL.',
    )
  }
  return url
}

function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  // Local/dev Replit DBs use sslmode=disable. Anything else (managed prod DBs)
  // we connect over TLS without pinning the CA (Neon/Render style).
  if (/sslmode=disable/.test(url)) return false
  return { rejectUnauthorized: false }
}

let pool: Pool | null = null

export function payPool(): Pool {
  if (!pool) {
    const url = resolveUrl()
    pool = new Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    pool.on('error', (err) => {
      console.error('[payagent] idle pool error:', err.message)
    })
  }
  return pool
}

export async function payQuery<T = any>(text: string, params: any[] = []): Promise<{ rows: T[] }> {
  const res = await payPool().query(text, params)
  return { rows: res.rows as T[] }
}

let ensured = false

// Idempotent schema + table creation. Safe to call on every boot — uses
// CREATE ... IF NOT EXISTS throughout (the Pay Agent equivalent of the bot's
// ensureTables). Never drops anything.
export async function ensurePayAgentSchema(): Promise<void> {
  if (ensured) return
  const p = payPool()

  // gen_random_uuid() is core in PG13+. pgcrypto is a belt-and-braces fallback
  // for older servers; ignore failure (insufficient privilege on some hosts).
  try {
    await p.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  } catch {
    /* ignore — gen_random_uuid is in pg_catalog on modern Postgres */
  }

  await p.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)

  await p.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.pay_users (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      telegram_id text UNIQUE NOT NULL,
      name        text,
      email       text,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.pay_agents (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL REFERENCES ${SCHEMA}.pay_users(id) ON DELETE CASCADE,
      name        text NOT NULL,
      avatar      text NOT NULL DEFAULT '🤖',
      personality text NOT NULL DEFAULT 'Sharp, protective, and a little degen.',
      role        text NOT NULL DEFAULT 'Bills Agent',
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.pay_payment_methods (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL REFERENCES ${SCHEMA}.pay_users(id) ON DELETE CASCADE,
      type        text NOT NULL,
      provider    text NOT NULL DEFAULT 'mock',
      label       text NOT NULL,
      last4       text,
      status      text NOT NULL DEFAULT 'active',
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.pay_bills (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             uuid NOT NULL REFERENCES ${SCHEMA}.pay_users(id) ON DELETE CASCADE,
      agent_id            uuid REFERENCES ${SCHEMA}.pay_agents(id) ON DELETE SET NULL,
      name                text NOT NULL,
      category            text NOT NULL DEFAULT 'Other',
      amount              numeric(18,2) NOT NULL DEFAULT 0,
      currency            text NOT NULL DEFAULT 'USD',
      frequency           text NOT NULL DEFAULT 'monthly',
      due_date            date NOT NULL DEFAULT CURRENT_DATE,
      next_due_date       date NOT NULL DEFAULT CURRENT_DATE,
      payment_method_id   uuid REFERENCES ${SCHEMA}.pay_payment_methods(id) ON DELETE SET NULL,
      status              text NOT NULL DEFAULT 'active',
      auto_pay_enabled    boolean NOT NULL DEFAULT false,
      approval_required   boolean NOT NULL DEFAULT true,
      max_auto_pay_amount numeric(18,2),
      trusted             boolean NOT NULL DEFAULT false,
      last_amount         numeric(18,2),
      last_used_at        timestamptz,
      notes               text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.pay_payments (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             uuid NOT NULL REFERENCES ${SCHEMA}.pay_users(id) ON DELETE CASCADE,
      bill_id             uuid NOT NULL REFERENCES ${SCHEMA}.pay_bills(id) ON DELETE CASCADE,
      amount              numeric(18,2) NOT NULL,
      currency            text NOT NULL DEFAULT 'USD',
      status              text NOT NULL DEFAULT 'pending',
      provider            text NOT NULL DEFAULT 'mock',
      provider_reference  text,
      approved_by_user    boolean NOT NULL DEFAULT false,
      mode                text NOT NULL DEFAULT 'approval',
      paid_at             timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now()
    )
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.pay_agent_actions (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid NOT NULL REFERENCES ${SCHEMA}.pay_users(id) ON DELETE CASCADE,
      agent_id      uuid REFERENCES ${SCHEMA}.pay_agents(id) ON DELETE SET NULL,
      bill_id       uuid REFERENCES ${SCHEMA}.pay_bills(id) ON DELETE SET NULL,
      action_type   text NOT NULL,
      action_status text NOT NULL DEFAULT 'done',
      reasoning     text,
      metadata      jsonb,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.pay_recommendations (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          uuid NOT NULL REFERENCES ${SCHEMA}.pay_users(id) ON DELETE CASCADE,
      agent_id         uuid REFERENCES ${SCHEMA}.pay_agents(id) ON DELETE SET NULL,
      type             text NOT NULL DEFAULT 'general',
      title            text NOT NULL,
      description      text NOT NULL DEFAULT '',
      potential_saving numeric(18,2) NOT NULL DEFAULT 0,
      status           text NOT NULL DEFAULT 'open',
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `)

  await p.query(`CREATE INDEX IF NOT EXISTS pay_bills_user_idx ON ${SCHEMA}.pay_bills(user_id)`)
  await p.query(`CREATE INDEX IF NOT EXISTS pay_payments_user_idx ON ${SCHEMA}.pay_payments(user_id)`)
  await p.query(`CREATE INDEX IF NOT EXISTS pay_payments_bill_idx ON ${SCHEMA}.pay_payments(bill_id)`)
  await p.query(`CREATE INDEX IF NOT EXISTS pay_recs_user_idx ON ${SCHEMA}.pay_recommendations(user_id)`)
  await p.query(`CREATE INDEX IF NOT EXISTS pay_actions_user_idx ON ${SCHEMA}.pay_agent_actions(user_id)`)
  await p.query(`CREATE INDEX IF NOT EXISTS pay_methods_user_idx ON ${SCHEMA}.pay_payment_methods(user_id)`)

  ensured = true
  console.log(`[payagent] schema "${SCHEMA}" ready`)
}

export const PAY_SCHEMA = SCHEMA

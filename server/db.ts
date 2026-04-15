import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const isSSL = process.env.DATABASE_URL?.includes("render.com") ||
  process.env.DATABASE_URL?.includes("neon.tech") ||
  process.env.RENDER === "true";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isSSL ? { rejectUnauthorized: false } : false,
  max: 20,
  min: 2,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  statement_timeout: 30000,
  query_timeout: 30000,
} as any);

pool.on('error', (err) => {
  console.error('[DB Pool] Idle client error:', err.message?.substring(0, 150));
});

pool.on('connect', (client: any) => {
  client.on('error', (err: any) => {
    console.error('[DB Pool] Client error:', err.message?.substring(0, 150));
  });
});

setInterval(async () => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
  } catch (err: any) {
    console.error('[DB Pool] Health check failed:', err.message?.substring(0, 100));
  }
}, 60000);

export { pool };
export const db = drizzle(pool, { schema });

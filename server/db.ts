import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const isSSL = process.env.DATABASE_URL?.includes("render.com") ||
  process.env.DATABASE_URL?.includes("neon.tech") ||
  process.env.RENDER === "true";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isSSL ? { rejectUnauthorized: false } : false,
  keepAlive: true,
  max: 5,
  min: 1,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 15000,
  allowExitOnIdle: false,
});

pool.on('error', (err) => {
  console.error('[DB Pool] Idle client error:', err.message?.substring(0, 150));
});

export { pool };
export const db = drizzle(pool, { schema });

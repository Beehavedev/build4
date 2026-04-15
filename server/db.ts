import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const dbUrl = process.env.DATABASE_URL || "";
const isInternal = dbUrl.includes(".internal");
const isSSL = !isInternal && (
  dbUrl.includes("render.com") ||
  dbUrl.includes("neon.tech") ||
  process.env.RENDER === "true"
);
console.log(`[DB] Pool config: ssl=${isSSL}, internal=${isInternal}, url=${dbUrl.substring(0, 40)}...`);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isSSL ? { rejectUnauthorized: false } : false,
  keepAlive: true,
  max: 5,
  min: 0,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  allowExitOnIdle: true,
});

pool.on('error', (err) => {
  console.error('[DB Pool] Idle client error (will reconnect):', err.message?.substring(0, 150));
});

export { pool };
export const db = drizzle(pool, { schema });

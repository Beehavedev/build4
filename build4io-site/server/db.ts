import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

// Replit Publish blocks deploys when a secret literally named DATABASE_URL
// points at an external DB. We read SITE_DATABASE_URL first so the user can
// rename the Replit secret and unblock publishing. Falls back to DATABASE_URL
// for local dev and the Render bot service (which still uses the canonical name).
const DB_URL = process.env.SITE_DATABASE_URL || process.env.DATABASE_URL;
const isSSL = DB_URL?.includes("render.com") ||
  DB_URL?.includes("neon.tech") ||
  process.env.RENDER === "true";

const pool = new pg.Pool({
  connectionString: DB_URL,
  ssl: isSSL ? { rejectUnauthorized: false } : false,
  keepAlive: true,
});

pool.on('error', (err) => {
  console.error('[DB Pool] Idle client error:', err.message?.substring(0, 150));
});

export { pool };
export const db = drizzle(pool, { schema });

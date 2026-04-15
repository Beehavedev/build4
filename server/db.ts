import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const isSSL = process.env.DATABASE_URL?.includes("render.com") ||
  process.env.DATABASE_URL?.includes("neon.tech") ||
  process.env.RENDER === "true";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isSSL ? { rejectUnauthorized: false } : false,
  max: 15,
  min: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,
  allowExitOnIdle: true,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  statement_timeout: 15000,
  query_timeout: 15000,
} as any);

pool.on('error', (err) => {
  console.error('[DB Pool] Idle client error:', err.message?.substring(0, 150));
});

pool.on('connect', (client: any) => {
  client.on('error', (err: any) => {
    console.error('[DB Pool] Client error:', err.message?.substring(0, 150));
  });
});

let dedicatedClient: pg.Client | null = null;
let dedicatedClientReady = false;

async function ensureDedicatedClient(): Promise<pg.Client> {
  if (dedicatedClient && dedicatedClientReady) return dedicatedClient;
  if (dedicatedClient) {
    try { await dedicatedClient.end(); } catch {}
  }
  dedicatedClient = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isSSL ? { rejectUnauthorized: false } : false,
    statement_timeout: 10000,
    query_timeout: 10000,
  } as any);
  dedicatedClient.on('error', (err) => {
    console.error('[DB Dedicated] Client error:', err.message?.substring(0, 100));
    dedicatedClientReady = false;
  });
  await dedicatedClient.connect();
  dedicatedClientReady = true;
  console.log('[DB Dedicated] Connected');
  return dedicatedClient;
}

async function directQuery(sql: string, params: any[] = []): Promise<any> {
  try {
    const client = await ensureDedicatedClient();
    const result = await client.query(sql, params);
    return result;
  } catch (e: any) {
    console.error('[DB Dedicated] Query failed:', e.message?.substring(0, 100));
    dedicatedClientReady = false;
    throw e;
  }
}

setInterval(async () => {
  try {
    if (dedicatedClientReady && dedicatedClient) {
      await dedicatedClient.query('SELECT 1');
    }
  } catch (err: any) {
    console.error('[DB Dedicated] Health check failed, will reconnect:', err.message?.substring(0, 80));
    dedicatedClientReady = false;
  }
}, 45000);

export { pool, directQuery };
export const db = drizzle(pool, { schema });

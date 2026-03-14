import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const isSSL = process.env.DATABASE_URL?.includes("render.com") ||
  process.env.DATABASE_URL?.includes("neon.tech") ||
  process.env.RENDER === "true";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isSSL ? { rejectUnauthorized: false } : false,
});

export const db = drizzle(pool, { schema });

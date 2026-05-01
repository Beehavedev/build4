// Renamed from `drizzle.config.ts` to `drizzle-local.config.ts` on
// purpose: Replit Deployments has an auto-provisioning step that scans
// for files matching `drizzle.config.*` and, if found together with a
// DATABASE_URL env var, runs `drizzle-kit push` against the production
// DB during the "Provision" stage of publish. Because `DATABASE_URL` in
// this Replit is wired to the live BUILD4 bot Postgres on Render, that
// auto-migration would compare `web4/shared/schema.ts` (subset) against
// the bot DB (superset) and offer to DELETE every table not in the
// subset (322k transactions, 461 agents, 538k audit logs, ...). One
// click would wipe BUILD4. See commit history around 2026-05-01.
//
// Renaming the file removes it from Replit's scanner. This file is now
// only used for manual local runs, e.g.:
//   npx drizzle-kit push --config=web4/drizzle-local.config.ts
//
// DO NOT rename back to `drizzle.config.ts` without first severing
// `DATABASE_URL` from the bot's production database.
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

const isSSL = process.env.DATABASE_URL?.includes("render.com") ||
  process.env.DATABASE_URL?.includes("neon.tech") ||
  process.env.RENDER === "true";

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
    ssl: isSSL ? { rejectUnauthorized: false } : false,
  },
});

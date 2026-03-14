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

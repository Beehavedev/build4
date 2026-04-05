import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";

const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildForRender() {
  console.log("Render detected — building bot server only (no frontend)");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];

  await rm("dist", { recursive: true, force: true });
  const bundleInline = new Set(["ethers"]);
  const externals = allDeps.filter((dep) => !bundleInline.has(dep));

  await esbuild({
    entryPoints: ["server/bot-server.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    external: externals,
    alias: {
      "@shared": "./shared",
    },
    logLevel: "info",
  });
  console.log("Bot server built successfully → dist/index.cjs");

  const { copyFile } = await import("fs/promises");
  try {
    await copyFile("server/schema-init.sql", "dist/schema-init.sql");
    console.log("Copied schema-init.sql → dist/schema-init.sql");
  } catch {}


  console.log("Running database schema migration...");
  const { execSync } = await import("child_process");
  try {
    execSync("npx drizzle-kit push --force", { stdio: "inherit" });
    console.log("Database schema migrated successfully");
  } catch (e: any) {
    console.warn("Schema migration warning (may already be up to date):", e.message?.substring(0, 100));
  }
}

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

const buildFn = process.env.RENDER === "true" ? buildForRender : buildAll;

buildFn().catch((err) => {
  console.error(err);
  process.exit(1);
});

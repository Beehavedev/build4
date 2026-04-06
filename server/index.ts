import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startAgentRunner } from "./agent-runner";
import { checkAndExecuteMilestones } from "./chaos-launch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

process.on("uncaughtException", (err) => {
  console.error("[CRASH] Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH] Unhandled rejection:", reason);
});
process.on("SIGTERM", () => console.log("[SIGNAL] SIGTERM received"));
process.on("SIGINT", () => console.log("[SIGNAL] SIGINT received"));
process.on("exit", (code) => console.log(`[EXIT] Process exiting with code ${code}`));

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.set("trust proxy", 1);

const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];

function ipToLong(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isInCIDR(ip: string, cidr: string): boolean {
  const [rangeIp, bits] = cidr.split("/");
  const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(rangeIp) & mask);
}

function isCloudflareIP(ip: string): boolean {
  const cleanIp = ip.replace("::ffff:", "");
  return CLOUDFLARE_IPV4.some(cidr => isInCIDR(cleanIp, cidr));
}

const IS_RENDER = process.env.RENDER === "true";
const IS_PRODUCTION = IS_RENDER || (process.env.NODE_ENV === "production" && !process.env.REPL_SLUG);
const ENFORCE_CLOUDFLARE = IS_PRODUCTION && process.env.DISABLE_CF_CHECK !== "true";

if (ENFORCE_CLOUDFLARE) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/api/telegram/webhook") return next();
    if (req.headers["user-agent"]?.includes("health") || req.headers["x-healthcheck"]) return next();
    if (req.path === "/_health" || req.path === "/healthz") return next();
    if (req.headers["x-replit-cluster"]) return next();

    const realIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket.remoteAddress || "";

    if (!isCloudflareIP(realIp)) {
      console.warn(`[Security] Blocked non-Cloudflare request from ${realIp} to ${req.path}`);
      return res.status(403).json({ error: "Access denied" });
    }

    next();
  });
  console.log("[Security] Cloudflare IP enforcement ACTIVE — origin protected");
}

app.get("/", (_req, res, next) => {
  if (_req.headers["user-agent"]?.includes("health") || _req.headers["x-healthcheck"]) {
    return res.status(200).send("OK");
  }
  next();
});

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
    limit: "1mb",
  }),
);

app.use(express.urlencoded({ extended: false, limit: "1mb" }));

const ALLOWED_ORIGINS = [
  process.env.APP_URL,
  process.env.RENDER_EXTERNAL_URL,
  "https://build4.world",
  "https://www.build4.world",
].filter(Boolean) as string[];

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (origin) {
    try {
      const hostname = new URL(origin).hostname;
      if (hostname === "bridge.walletconnect.org" || hostname === "verify.walletconnect.com" || hostname === "relay.walletconnect.com" || hostname.endsWith(".walletconnect.com") || hostname.endsWith(".walletconnect.org")) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }
    } catch {}
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, x-api-key");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === "production" ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https:", "wss:", "wss://relay.walletconnect.com", "wss://relay.walletconnect.org", "https://verify.walletconnect.com", "https://rpc.walletconnect.com"],
      frameSrc: ["'self'", "https://verify.walletconnect.com"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  } : false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: process.env.NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => req.path === "/" || req.path === "/health" || req.path.startsWith("/assets"),
});
app.use("/api", globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts, please try again later." },
});
app.use("/api/web4/link-wallet", authLimiter);
app.use("/api/web4/api-keys", authLimiter);
app.use("/api/analytics/login", authLimiter);

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/telegram/webhook", webhookLimiter);

app.use((req: Request, res: Response, next: NextFunction) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Download-Options", "noopen");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  }
  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

const BLOCKED_PATHS = [
  "/wp-admin", "/wp-login", "/xmlrpc.php", "/.env", "/.git",
  "/phpmyadmin", "/admin/config", "/cgi-bin", "/shell", "/eval",
  "/.well-known/security.txt", "/debug", "/actuator", "/solr",
  "/manager/html", "/jmx-console", "/web-console",
  "/server-status", "/server-info", "/.DS_Store",
  "/config.json", "/database.yml", "/credentials",
];
const suspiciousPatterns = /(\.\.|%2e%2e|%00|<script|javascript:|data:text\/html)/i;

app.use((req: Request, res: Response, next: NextFunction) => {
  const p = req.path.toLowerCase();
  if (BLOCKED_PATHS.some(bp => p.startsWith(bp)) || suspiciousPatterns.test(req.url)) {
    return res.status(404).end();
  }
  next();
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    log(`${req.method} ${req.path} ${res.statusCode} in ${duration}ms`);
  });
  next();
});

async function ensureSchema() {
  if (!process.env.DATABASE_URL) return;
  const thisDir = typeof __dirname !== 'undefined' ? __dirname : new URL(".", import.meta.url).pathname;
  const candidates = [
    join(process.cwd(), "dist", "schema-init.sql"),
    join(process.cwd(), "server", "schema-init.sql"),
    join(thisDir, "schema-init.sql"),
    join(thisDir, "..", "server", "schema-init.sql"),
  ];
  let sqlContent = "";
  for (const p of candidates) {
    try { sqlContent = readFileSync(p, "utf-8"); break; } catch {}
  }
  const isSSL = process.env.DATABASE_URL.includes("render.com") ||
    process.env.DATABASE_URL.includes("neon.tech") ||
    process.env.RENDER === "true";
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isSSL ? { rejectUnauthorized: false } : false,
  });
  try {
    const criticalAlters = [
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "owner_telegram_chat_id" TEXT`,
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "preferred_model" TEXT`,
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP DEFAULT now()`,
    ];
    for (const stmt of criticalAlters) {
      try { await pool.query(stmt); } catch (e: any) {
        log(`Critical ALTER warning: ${e.message?.substring(0, 100)}`);
      }
    }
    log("Critical agent columns ensured (v2)");

    if (sqlContent) {
      const statements = sqlContent.split(/;\s*\n/).filter((s: string) => s.trim().length > 5);
      let ok = 0, skip = 0;
      for (const stmt of statements) {
        try { await pool.query(stmt); ok++; } catch { skip++; }
      }
      log(`Schema init: ${ok} succeeded, ${skip} skipped`);
    }
  } catch (e: any) {
    log(`Schema setup error: ${e.message?.substring(0, 200)}`);
  } finally {
    await pool.end();
  }
}

(async () => {
  await ensureSchema();
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      if (process.env.NODE_ENV === "production" && process.env.AGENT_RUNNER_ENABLED === "true") {
        setTimeout(() => startAgentRunner(), 3000);
      } else if (process.env.NODE_ENV !== "production") {
        log("Agent runner skipped in development to save memory. Runs in production.");
      } else {
        log("Agent runner disabled — only real user-initiated actions allowed. Set AGENT_RUNNER_ENABLED=true to enable autonomous mode.");
      }

      const CHAOS_CHECK_INTERVAL = 60_000;
      setInterval(async () => {
        try {
          await checkAndExecuteMilestones();
        } catch (e: any) {
          log(`[ChaosLaunch] Milestone check error: ${e.message}`, "chaos");
        }
      }, CHAOS_CHECK_INTERVAL);
      log("Chaos milestone auto-executor started (checks every 60s)");
    },
  );
})();

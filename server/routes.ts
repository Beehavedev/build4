import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { registerWeb4Routes } from "./web4-routes";
import { registerServicesRoutes } from "./services-routes";
import { startBountyEngine } from "./bounty-engine";
import { visitorTrackingMiddleware } from "./visitor-tracking";
import crypto from "crypto";

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

function getTokenSecret(): string {
  return process.env.SESSION_SECRET || process.env.ANALYTICS_PASSWORD || "build4-analytics-fallback";
}

function generateAnalyticsToken(): string {
  const expiry = Date.now() + TOKEN_EXPIRY_MS;
  const payload = `analytics:${expiry}`;
  const hmac = crypto.createHmac("sha256", getTokenSecret()).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ exp: expiry, sig: hmac })).toString("base64");
}

function isValidToken(token: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    if (!decoded.exp || !decoded.sig) return false;
    if (Date.now() > decoded.exp) return false;
    const payload = `analytics:${decoded.exp}`;
    const expected = crypto.createHmac("sha256", getTokenSecret()).update(payload).digest("hex");
    return constantTimeCompare(decoded.sig, expected);
  } catch {
    return false;
  }
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

function analyticsAuth(req: Request, res: Response, next: NextFunction) {
  const adminPassword = process.env.ANALYTICS_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Analytics password not configured" });
    return;
  }
  const token = req.headers["x-analytics-token"] as string;
  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(visitorTrackingMiddleware());

  registerWeb4Routes(app);
  registerServicesRoutes(app);

  app.post("/api/analytics/auth", (req: Request, res: Response) => {
    const adminPassword = process.env.ANALYTICS_PASSWORD;
    if (!adminPassword) {
      res.status(503).json({ error: "Analytics password not configured" });
      return;
    }
    const { password } = req.body || {};
    if (!password || typeof password !== "string" || !constantTimeCompare(password, adminPassword)) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }
    const token = generateAnalyticsToken();
    res.json({ token });
  });

  app.get("/api/analytics/stats", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const period = (req.query.period as string) || "24h";
      let since: Date | undefined;
      const now = new Date();
      if (period === "1h") since = new Date(now.getTime() - 60 * 60 * 1000);
      else if (period === "24h") since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      else if (period === "7d") since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "30d") since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const stats = await storage.getVisitorStats(since);
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/analytics/logs", analyticsAuth, async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = await storage.getVisitorLogs(Math.min(limit, 500));
      const redacted = logs.map(log => ({
        ...log,
        ip: log.ip ? log.ip.replace(/\d+$/, "***") : null,
        fingerprint: undefined,
        walletAddress: log.walletAddress ? log.walletAddress.slice(0, 10) + "..." : null,
      }));
      res.json(redacted);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/analytics/live", analyticsAuth, async (_req: Request, res: Response) => {
    try {
      const now = new Date();
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const stats = await storage.getVisitorStats(fiveMinAgo);
      res.json({
        activeVisitors: stats.uniqueIps,
        humans: stats.humans,
        agents: stats.agents,
        unknown: stats.unknown,
        recentPaths: stats.topPaths.slice(0, 5),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  await storage.cleanFakeData();
  await storage.seedInferenceProviders();
  await storage.seedSubscriptionPlans();

  startBountyEngine().catch(err => {
    console.error("[BountyEngine] Failed to start:", err.message);
  });

  return httpServer;
}

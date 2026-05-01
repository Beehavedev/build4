import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

function getTokenSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.ANALYTICS_PASSWORD;
  if (!secret) {
    throw new Error("No SESSION_SECRET or ANALYTICS_PASSWORD configured");
  }
  return secret;
}

export function generateAnalyticsToken(): string {
  const expiry = Date.now() + TOKEN_EXPIRY_MS;
  const payload = `analytics:${expiry}`;
  const hmac = crypto.createHmac("sha256", getTokenSecret()).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ exp: expiry, sig: hmac })).toString("base64");
}

export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
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

export function analyticsAuth(req: Request, res: Response, next: NextFunction) {
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

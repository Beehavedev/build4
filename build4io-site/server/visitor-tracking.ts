import type { Request, Response, NextFunction } from "express";
import { storage } from "./storage";

const KNOWN_BOT_PATTERNS = [
  /bot/i, /crawl/i, /spider/i, /slurp/i, /fetch/i,
  /curl/i, /wget/i, /python-requests/i, /python-urllib/i,
  /httpx/i, /axios/i, /node-fetch/i, /got\//i,
  /scrapy/i, /phantom/i, /headless/i, /puppeteer/i,
  /selenium/i, /playwright/i, /lighthouse/i,
  /chatgpt/i, /gpt/i, /openai/i, /claude/i, /anthropic/i,
  /bingbot/i, /googlebot/i, /yandex/i, /baiduspider/i,
  /duckduckbot/i, /facebookexternalhit/i, /twitterbot/i,
  /linkedinbot/i, /whatsapp/i, /telegrambot/i,
  /applebot/i, /semrush/i, /ahrefs/i, /mj12bot/i,
  /dotbot/i, /petalbot/i, /bytespider/i,
  /langchain/i, /autogpt/i, /babyagi/i, /agentgpt/i,
  /swarm/i, /crewai/i, /superagi/i,
  /eliza/i, /virtuals/i, /morpheus/i, /autonolas/i,
  /fetch\.ai/i, /singularitynet/i, /bittensor/i,
];

const KNOWN_BROWSER_PATTERNS = [
  /mozilla/i, /chrome/i, /safari/i, /firefox/i, /edge/i, /opera/i, /vivaldi/i, /brave/i,
];

const SKIP_PATHS = [
  /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/,
  /^\/assets\//,
  /^\/@/,
  /^\/node_modules\//,
  /^\/src\//,
  /^\/favicon/,
  /^\/api\/analytics/,
];

function classifyVisitor(req: Request): "human" | "agent" | "unknown" {
  const ua = req.headers["user-agent"] || "";

  if (req.path.startsWith("/.well-known/")) return "agent";
  if (req.path.startsWith("/api/protocol")) return "agent";
  if (req.path.startsWith("/api/marketplace") && !ua) return "agent";

  if (req.headers["x-agent-id"] || req.headers["x-agent-wallet"] || req.headers["x-build4-agent"]) {
    return "agent";
  }

  if (!ua) return "unknown";

  for (const pattern of KNOWN_BOT_PATTERNS) {
    if (pattern.test(ua)) return "agent";
  }

  for (const pattern of KNOWN_BROWSER_PATTERNS) {
    if (pattern.test(ua)) {
      if (/bot|crawl|spider/i.test(ua)) return "agent";
      return "human";
    }
  }

  return "unknown";
}

function shouldSkip(path: string): boolean {
  return SKIP_PATHS.some(p => p.test(path));
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function getFingerprint(req: Request): string {
  const ua = req.headers["user-agent"] || "";
  const ip = getClientIp(req);
  const accept = req.headers["accept-language"] || "";
  return Buffer.from(`${ip}:${ua}:${accept}`).toString("base64").slice(0, 32);
}

interface VisitorEntry {
  visitorType: "human" | "agent" | "unknown";
  path: string;
  method: string;
  userAgent: string | null;
  ip: string;
  referer: string | null;
  country: string | null;
  fingerprint: string;
  walletAddress: string | null;
  sessionId: string | null;
  statusCode: number;
}

const visitorBuffer: VisitorEntry[] = [];
const FLUSH_INTERVAL = 10_000;
const FLUSH_SIZE = 50;

function flushVisitorBuffer(): void {
  if (visitorBuffer.length === 0) return;
  const batch = visitorBuffer.splice(0, visitorBuffer.length);
  for (const entry of batch) {
    storage.logVisitor(entry).catch(() => {});
  }
}

setInterval(flushVisitorBuffer, FLUSH_INTERVAL);
process.on("beforeExit", flushVisitorBuffer);

export function visitorTrackingMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (shouldSkip(req.path)) {
      next();
      return;
    }

    const visitorType = classifyVisitor(req);
    const ip = getClientIp(req);
    const fingerprint = getFingerprint(req);
    const walletAddress = (req.headers["x-agent-wallet"] as string) || (req.body?.callerWallet as string) || undefined;

    res.on("finish", () => {
      visitorBuffer.push({
        visitorType,
        path: req.path,
        method: req.method,
        userAgent: (req.headers["user-agent"] as string) || null,
        ip,
        referer: (req.headers["referer"] as string) || null,
        country: (req.headers["cf-ipcountry"] as string) || (req.headers["x-vercel-ip-country"] as string) || null,
        fingerprint,
        walletAddress: walletAddress || null,
        sessionId: null,
        statusCode: res.statusCode,
      });
      if (visitorBuffer.length >= FLUSH_SIZE) {
        flushVisitorBuffer();
      }
    });

    next();
  };
}

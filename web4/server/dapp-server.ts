import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import { verifyMessage } from "ethers";
import { SignJWT, jwtVerify } from "jose";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATIC_DIR = path.join(ROOT, "dist", "public");

const PORT = Number(process.env.DAPP_PORT || process.env.PORT || 8080);
const SESSION_SECRET = new TextEncoder().encode(
  process.env.DAPP_SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
);
const COOKIE_NAME = "build4_dapp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const nonces = new Map<string, { nonce: string; expiresAt: number }>();
function pruneNonces() {
  const now = Date.now();
  for (const [k, v] of nonces.entries()) if (v.expiresAt < now) nonces.delete(k);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: [
          "'self'",
          "https://*.walletconnect.com",
          "wss://*.walletconnect.com",
          "https://*.walletconnect.org",
          "wss://*.walletconnect.org",
          "https://rpc.walletconnect.com",
          "https://relay.walletconnect.com",
          "wss://relay.walletconnect.com",
          "https://*.replit.dev",
          "wss://*.replit.dev",
          "https://*.replit.app",
        ],
        frameSrc: ["'self'", "https://verify.walletconnect.com", "https://verify.walletconnect.org"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

async function getSession(req: Request): Promise<{ address: string } | null> {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SESSION_SECRET);
    if (typeof payload.sub === "string") return { address: payload.sub };
  } catch {
    return null;
  }
  return null;
}

app.get("/api/web4/walletconnect-config", (_req, res) => {
  const projectId = process.env.WALLETCONNECT_PROJECT_ID || process.env.VITE_WALLETCONNECT_PROJECT_ID;
  if (!projectId) return res.status(404).json({ error: "WalletConnect not configured" });
  res.json({ projectId });
});

app.get("/api/web4/contracts", (_req, res) => {
  res.json({ deployments: {} });
});

app.get("/api/web4/nonce", (req, res) => {
  pruneNonces();
  const addr = String(req.query.address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: "invalid address" });
  const nonce = crypto.randomBytes(16).toString("hex");
  nonces.set(addr, { nonce, expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({ nonce });
});

type SiweFields = {
  domain: string;
  address: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expirationTime: Date | null;
};

function parseSiweMessage(message: string): SiweFields {
  const lines = message.split("\n");
  if (lines.length < 8) throw new Error("malformed message (too few lines)");
  const m1 = lines[0].match(/^(\S+) wants you to sign in with your Ethereum account:$/);
  if (!m1) throw new Error("missing or malformed domain header");
  const domain = m1[1];
  const address = lines[1].trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("invalid address line");

  const getField = (key: string): string | null => {
    const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
    const m = message.match(re);
    return m ? m[1].trim() : null;
  };

  const uri = getField("URI");
  const version = getField("Version");
  const chainIdStr = getField("Chain ID");
  const nonce = getField("Nonce");
  const issuedAtStr = getField("Issued At");
  const expirationTimeStr = getField("Expiration Time");

  if (!uri || !version || !chainIdStr || !nonce || !issuedAtStr) {
    throw new Error("missing required SIWE field");
  }
  const chainId = Number(chainIdStr);
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error("invalid chain id");
  const issuedAt = new Date(issuedAtStr);
  if (Number.isNaN(issuedAt.getTime())) throw new Error("invalid issuedAt");
  let expirationTime: Date | null = null;
  if (expirationTimeStr) {
    expirationTime = new Date(expirationTimeStr);
    if (Number.isNaN(expirationTime.getTime())) throw new Error("invalid expirationTime");
  }
  return { domain, address, uri, version, chainId, nonce, issuedAt, expirationTime };
}

function getAllowedHosts(req: Request): string[] {
  const fromEnv = (process.env.DAPP_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  const reqHost = (req.get("host") || "").toLowerCase();
  return reqHost ? [reqHost] : [];
}

app.post("/api/web4/siwe", async (req: Request, res: Response) => {
  pruneNonces();
  const { message, signature, address } = (req.body || {}) as {
    message?: string;
    signature?: string;
    address?: string;
  };
  if (!message || !signature || !address) return res.status(400).json({ error: "missing fields" });
  if (typeof message !== "string" || message.length > 4000) return res.status(400).json({ error: "invalid message" });
  if (typeof signature !== "string" || signature.length > 200) return res.status(400).json({ error: "invalid signature" });
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid address" });

  const lowered = address.toLowerCase();
  const stored = nonces.get(lowered);
  // Nonce is one-time-use: drop it now whether we succeed or fail
  nonces.delete(lowered);
  if (!stored) return res.status(400).json({ error: "no nonce — request /api/web4/nonce first" });
  if (stored.expiresAt < Date.now()) return res.status(400).json({ error: "nonce expired" });

  try {
    const allowedHosts = getAllowedHosts(req);
    if (allowedHosts.length === 0) {
      console.error("[dapp-server] no allowed hosts; refusing SIWE");
      return res.status(500).json({ error: "server misconfigured (no host)" });
    }

    // Origin/Referer check (defense in depth against cross-site POSTs)
    const origin = req.get("origin");
    if (origin) {
      let originHost: string;
      try { originHost = new URL(origin).host.toLowerCase(); } catch { return res.status(400).json({ error: "invalid origin" }); }
      if (!allowedHosts.includes(originHost)) return res.status(403).json({ error: `origin ${originHost} not allowed` });
    }

    const fields = parseSiweMessage(message);

    if (!allowedHosts.includes(fields.domain.toLowerCase())) {
      return res.status(401).json({ error: `domain ${fields.domain} not allowed` });
    }
    let uriHost: string;
    try { uriHost = new URL(fields.uri).host.toLowerCase(); } catch { return res.status(401).json({ error: "invalid URI in message" }); }
    if (!allowedHosts.includes(uriHost)) return res.status(401).json({ error: `URI host ${uriHost} not allowed` });

    if (fields.version !== "1") return res.status(401).json({ error: "unsupported SIWE version" });
    if (fields.address.toLowerCase() !== lowered) return res.status(401).json({ error: "address mismatch" });
    if (fields.nonce !== stored.nonce) return res.status(401).json({ error: "nonce mismatch" });

    const now = Date.now();
    const issuedMs = fields.issuedAt.getTime();
    if (issuedMs > now + 60_000) return res.status(401).json({ error: "issuedAt is in the future" });
    if (issuedMs < now - 10 * 60_000) return res.status(401).json({ error: "issuedAt too old" });
    if (fields.expirationTime) {
      const expMs = fields.expirationTime.getTime();
      if (expMs <= now) return res.status(401).json({ error: "message expired" });
      if (expMs > issuedMs + 60 * 60_000) return res.status(401).json({ error: "expiration too far in future" });
    }

    let recovered: string;
    try { recovered = verifyMessage(message, signature); } catch { return res.status(401).json({ error: "invalid signature" }); }
    if (recovered.toLowerCase() !== lowered) return res.status(401).json({ error: "signature does not match address" });

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(lowered)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
      .sign(SESSION_SECRET);

    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${encodeURIComponent(jwt)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    res.json({ ok: true, address: lowered });
  } catch (err: any) {
    console.error("[dapp-server] /api/web4/siwe error:", err?.message || err);
    res.status(401).json({ error: err?.message || "verification failed" });
  }
});

app.get("/api/web4/me", async (req, res) => {
  const session = await getSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, address: session.address });
});

app.post("/api/web4/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "build4-dapp" }));

app.use(express.static(STATIC_DIR, { index: false, maxAge: "1h" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[dapp-server] uncaught:", err);
  res.status(500).json({ error: "internal error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[dapp-server] listening on http://0.0.0.0:${PORT}`);
  console.log(`[dapp-server] static: ${STATIC_DIR}`);
  console.log(`[dapp-server] WalletConnect projectId: ${process.env.WALLETCONNECT_PROJECT_ID ? "set" : "MISSING"}`);
});

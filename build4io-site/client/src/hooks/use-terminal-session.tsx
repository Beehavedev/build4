import { useEffect, useState, useCallback, useMemo } from "react";
import { useWallet } from "@/hooks/use-wallet";

const CHAT_ID_KEY = "build4_terminal_chat_id";
const CHAT_ID_FOR_ADDR_KEY = "build4_terminal_chat_id_addr";

type RegisterState = "idle" | "registering" | "signing" | "ready" | "error";

// Build & POST a strict EIP-4361 sign-in message, then receive an
// HTTP-only HMAC session cookie (b4_sess) from /api/auth/siwe. The
// cookie binds the connected wallet to the bot-bridge endpoints
// (Polymarket / fourmeme / 42.space write paths) so they can no
// longer be impersonated by spoofing the x-wallet-address header.
async function ensureSiweSession(wallet: {
  address: string | null;
  signMessage: (m: string) => Promise<string>;
}): Promise<void> {
  // Already authed for this wallet? skip the prompt.
  try {
    const r0 = await fetch("/api/auth/session", { credentials: "include" });
    const j0 = await r0.json().catch(() => ({}));
    if (j0?.authenticated && j0?.wallet?.toLowerCase() === wallet.address?.toLowerCase()) return;
  } catch {}

  if (!wallet.address) throw new Error("Connect a wallet first");

  const nonceRes = await fetch("/api/auth/nonce", { credentials: "include" });
  const nonceBody = await nonceRes.json().catch(() => ({}));
  const nonce: string | undefined = nonceBody?.nonce;
  if (!nonce) throw new Error("Failed to fetch sign-in nonce");

  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const domain = window.location.host;
  const message =
    `${domain} wants you to sign in with your Ethereum account:\n` +
    `${wallet.address}\n\n` +
    `Sign in to BUILD4 terminal. This will not trigger any transaction.\n\n` +
    `URI: ${window.location.origin}\n` +
    `Version: 1\n` +
    `Chain ID: 1\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}\n` +
    `Expiration Time: ${expirationTime}`;

  const signature = await wallet.signMessage(message);

  const r = await fetch("/api/auth/siwe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ message, signature, wallet: wallet.address }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.ok) throw new Error(j?.error || `Sign-in failed (HTTP ${r.status})`);
}

export function useTerminalSession() {
  const wallet = useWallet();
  const [chatId, setChatId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CHAT_ID_KEY);
    } catch {
      return null;
    }
  });
  const [registerState, setRegisterState] = useState<RegisterState>("idle");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [siweReady, setSiweReady] = useState(false);

  useEffect(() => {
    if (!wallet.connected || !wallet.address) {
      setRegisterState("idle");
      setRegisterError(null);
      setSiweReady(false);
      return;
    }

    let cancelled = false;
    const addr = wallet.address;

    // Address may have changed since the last run while still connected.
    // Reset siweReady FIRST so any in-flight apiFetch sees ready=false
    // and doesn't fire writes against the previous wallet's b4_sess cookie
    // before we've re-signed for the new address.
    setSiweReady(false);
    setRegisterState("registering");

    let cached: string | null = null;
    let cachedAddr: string | null = null;
    try {
      cached = localStorage.getItem(CHAT_ID_KEY);
      cachedAddr = localStorage.getItem(CHAT_ID_FOR_ADDR_KEY);
    } catch {}

    const haveCachedChatId =
      cached && cachedAddr && cachedAddr.toLowerCase() === addr.toLowerCase();

    if (!haveCachedChatId) {
      // Address changed (or no cache yet): clear stale chatId before re-registering.
      setChatId(null);
      try {
        localStorage.removeItem(CHAT_ID_KEY);
        localStorage.removeItem(CHAT_ID_FOR_ADDR_KEY);
      } catch {}
    }

    (async () => {
      try {
        setRegisterError(null);
        // 1. Register wallet → chatId (for legacy /api/miniapp/* routes).
        let resolvedChatId = haveCachedChatId ? cached! : null;
        if (!resolvedChatId) {
          const r = await fetch("/api/miniapp/web-register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ walletAddress: addr }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body?.error || `register HTTP ${r.status}`);
          if (!body?.chatId) throw new Error("No chatId returned");
          resolvedChatId = body.chatId as string;
          if (cancelled) return;
          try {
            localStorage.setItem(CHAT_ID_KEY, resolvedChatId);
            localStorage.setItem(CHAT_ID_FOR_ADDR_KEY, addr);
          } catch {}
        }
        if (cancelled) return;
        setChatId(resolvedChatId);

        // 2. SIWE handshake → HMAC session cookie. Required by the
        //    bot-bridge endpoints (Polymarket / fourmeme / 42.space).
        setRegisterState("signing");
        await ensureSiweSession(wallet as any);
        if (cancelled) return;

        setSiweReady(true);
        setRegisterState("ready");
      } catch (e: any) {
        if (cancelled) return;
        setRegisterError(e?.message || "Failed to sign in");
        setRegisterState("error");
        setSiweReady(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wallet.connected, wallet.address]);

  const apiFetch = useCallback(
    async <T = any,>(path: string, opts: RequestInit = {}): Promise<T> => {
      if (!wallet.connected || !wallet.address) {
        throw new Error("Wallet not connected");
      }
      // Block writes until SIWE has completed for the *current* wallet,
      // so we never POST a bot-bridge mutation against a stale b4_sess
      // cookie issued for a previous address (or before sign-in finished).
      const method = (opts.method || "GET").toUpperCase();
      const isWrite = method !== "GET" && method !== "HEAD";
      if (isWrite && !siweReady) {
        throw new Error("Sign in to your wallet to continue");
      }
      const headers: Record<string, string> = {
        ...(opts.headers as Record<string, string> | undefined),
      };
      // Legacy miniapp auth still reads x-wallet-address. The newly-
      // hardened bot-bridge endpoints ignore it and require the SIWE
      // cookie (sent automatically via credentials: "include").
      headers["x-wallet-address"] = wallet.address;

      let body = opts.body;
      if (
        body &&
        typeof body === "object" &&
        !(body instanceof FormData) &&
        !(body instanceof Blob) &&
        !(body instanceof ArrayBuffer)
      ) {
        body = JSON.stringify(body);
        if (!headers["content-type"]) headers["content-type"] = "application/json";
      } else if (body && !headers["content-type"] && typeof body === "string") {
        headers["content-type"] = "application/json";
      }

      const res = await fetch(path, {
        ...opts,
        headers,
        body: body as BodyInit | null | undefined,
        credentials: "include",
      });
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (!res.ok) {
        const msg = (parsed && (parsed.error || parsed.message)) || `HTTP ${res.status}`;
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      return parsed as T;
    },
    [wallet.connected, wallet.address, siweReady],
  );

  const disconnect = useCallback(async () => {
    try {
      localStorage.removeItem(CHAT_ID_KEY);
      localStorage.removeItem(CHAT_ID_FOR_ADDR_KEY);
    } catch {}
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {}
    setChatId(null);
    setSiweReady(false);
    setRegisterState("idle");
    await wallet.disconnect();
  }, [wallet]);

  const ready = wallet.connected && registerState === "ready" && !!chatId && siweReady;

  return useMemo(
    () => ({
      wallet,
      chatId,
      ready,
      registerState,
      registerError,
      apiFetch,
      disconnect,
    }),
    [wallet, chatId, ready, registerState, registerError, apiFetch, disconnect],
  );
}

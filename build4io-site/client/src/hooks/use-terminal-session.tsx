import { useEffect, useState, useCallback, useMemo } from "react";
import { useWallet } from "@/hooks/use-wallet";

const CHAT_ID_KEY = "build4_terminal_chat_id";
const CHAT_ID_FOR_ADDR_KEY = "build4_terminal_chat_id_addr";

type RegisterState = "idle" | "registering" | "ready" | "error";

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

  useEffect(() => {
    if (!wallet.connected || !wallet.address) {
      setRegisterState("idle");
      setRegisterError(null);
      return;
    }

    let cached: string | null = null;
    let cachedAddr: string | null = null;
    try {
      cached = localStorage.getItem(CHAT_ID_KEY);
      cachedAddr = localStorage.getItem(CHAT_ID_FOR_ADDR_KEY);
    } catch {}

    if (cached && cachedAddr && cachedAddr.toLowerCase() === wallet.address.toLowerCase()) {
      setChatId(cached);
      setRegisterState("ready");
      return;
    }

    // Address changed (or no cache yet): clear any stale chatId before re-registering
    setChatId(null);
    try {
      localStorage.removeItem(CHAT_ID_KEY);
      localStorage.removeItem(CHAT_ID_FOR_ADDR_KEY);
    } catch {}

    let cancelled = false;
    setRegisterState("registering");
    setRegisterError(null);
    fetch("/api/miniapp/web-register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet.address }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
        if (!body?.chatId) throw new Error("No chatId returned");
        return body.chatId as string;
      })
      .then((newChatId) => {
        if (cancelled) return;
        try {
          localStorage.setItem(CHAT_ID_KEY, newChatId);
          localStorage.setItem(CHAT_ID_FOR_ADDR_KEY, wallet.address!);
        } catch {}
        setChatId(newChatId);
        setRegisterState("ready");
      })
      .catch((e: any) => {
        if (cancelled) return;
        setRegisterError(e?.message || "Failed to register wallet");
        setRegisterState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [wallet.connected, wallet.address]);

  const apiFetch = useCallback(
    async <T = any,>(path: string, opts: RequestInit = {}): Promise<T> => {
      // Only authenticate via wallet address — the server resolves chatId from the
      // wallet via DB lookup. We intentionally do NOT forward a client-supplied
      // x-telegram-chat-id header because the server's miniAppAuth would otherwise
      // trust it without proof-of-ownership.
      if (!wallet.connected || !wallet.address) {
        throw new Error("Wallet not connected");
      }
      const headers: Record<string, string> = {
        ...(opts.headers as Record<string, string> | undefined),
      };
      headers["x-wallet-address"] = wallet.address;

      let body = opts.body;
      if (body && typeof body === "object" && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
        body = JSON.stringify(body);
        if (!headers["content-type"]) headers["content-type"] = "application/json";
      } else if (body && !headers["content-type"] && typeof body === "string") {
        headers["content-type"] = "application/json";
      }

      const res = await fetch(path, { ...opts, headers, body: body as BodyInit | null | undefined });
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
    [wallet.connected, wallet.address],
  );

  const disconnect = useCallback(async () => {
    try {
      localStorage.removeItem(CHAT_ID_KEY);
      localStorage.removeItem(CHAT_ID_FOR_ADDR_KEY);
    } catch {}
    setChatId(null);
    setRegisterState("idle");
    await wallet.disconnect();
  }, [wallet]);

  const ready = wallet.connected && registerState === "ready" && !!chatId;

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

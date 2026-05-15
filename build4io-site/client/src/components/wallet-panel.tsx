// Custodial wallet management modal for the BUILD4 terminal.
// Three tabs: Deposit (cross-chain address + QR), Withdraw (server-signed
// transfer from custodial → recipient), Backup (private key reveal).
//
// Sensitive actions (reveal, withdraw) require a SIWE session cookie
// issued by /api/auth/siwe. We prompt the user to sign once on first
// sensitive use; the cookie is good for 1 hour.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Wallet as WalletIcon, Copy, ArrowDownToLine, ArrowUpFromLine, KeyRound, Shield, ExternalLink, Loader2, X, AlertCircle, CheckCircle2, EyeOff, Eye } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";

type ChainKey = "bsc" | "polygon" | "arbitrum" | "xlayer";

const CHAIN_META: Record<ChainKey, { id: number; name: string; native: string; explorer: string; tokens: string[] }> = {
  bsc:      { id: 56,    name: "BNB Smart Chain", native: "BNB", explorer: "https://bscscan.com",        tokens: ["BNB", "USDT", "USDC"] },
  polygon:  { id: 137,   name: "Polygon",         native: "POL", explorer: "https://polygonscan.com",    tokens: ["POL", "USDT", "USDC", "USDC.e"] },
  arbitrum: { id: 42161, name: "Arbitrum One",    native: "ETH", explorer: "https://arbiscan.io",        tokens: ["ETH", "USDT", "USDC"] },
  xlayer:   { id: 196,   name: "X Layer",         native: "OKB", explorer: "https://www.oklink.com/xlayer", tokens: ["OKB", "USDT", "USDC"] },
};
const CHAIN_KEYS = Object.keys(CHAIN_META) as ChainKey[];

async function ensureSiweSession(wallet: { address: string | null; signMessage: (m: string) => Promise<string> }): Promise<void> {
  const r0 = await fetch("/api/auth/session", { credentials: "include" });
  const j0 = await r0.json();
  if (j0.authenticated && j0.wallet?.toLowerCase() === wallet.address?.toLowerCase()) return;
  if (!wallet.address) throw new Error("Connect a wallet first");

  const nonceRes = await fetch("/api/auth/nonce");
  const { nonce } = await nonceRes.json();
  const issuedAt = new Date().toISOString();
  const domain = window.location.host;
  const message =
    `${domain} wants you to sign in with your Ethereum account:\n` +
    `${wallet.address}\n\n` +
    `Sign in to BUILD4 terminal. This will not trigger any transaction.\n\n` +
    `URI: ${window.location.origin}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
  const signature = await wallet.signMessage(message);
  const r = await fetch("/api/auth/siwe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ message, signature, wallet: wallet.address }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "SIWE failed");
}

export function WalletPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useWallet();
  const [tab, setTab] = useState<"deposit" | "withdraw" | "backup">("deposit");
  const [chain, setChain] = useState<ChainKey>("bsc");
  const [siweBusy, setSiweBusy] = useState(false);
  const [siweError, setSiweError] = useState<string | null>(null);

  if (!open) return null;
  const addr = wallet.address || "";
  const short = addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";

  const ensureSiwe = useCallback(async () => {
    setSiweError(null); setSiweBusy(true);
    try { await ensureSiweSession(wallet as any); }
    catch (e: any) { setSiweError(e?.message || "Sign-in failed"); throw e; }
    finally { setSiweBusy(false); }
  }, [wallet]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="wallet-panel">
      <div className="w-full max-w-xl rounded-md border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <WalletIcon className="w-4 h-4 text-emerald-400" />
            <span className="font-mono text-sm tracking-widest uppercase text-zinc-100">Custodial Wallet</span>
            <span className="font-mono text-[10px] text-zinc-500" data-testid="text-wallet-short">{short}</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" data-testid="button-wallet-close"><X className="w-4 h-4" /></button>
        </div>

        {!wallet.connected ? (
          <div className="p-6 text-center font-mono text-sm text-zinc-400">Connect a wallet first to view this panel.</div>
        ) : (
          <>
            <div className="flex border-b border-zinc-800">
              {[
                { id: "deposit",  label: "Deposit",  icon: ArrowDownToLine },
                { id: "withdraw", label: "Withdraw", icon: ArrowUpFromLine },
                { id: "backup",   label: "Backup",   icon: KeyRound },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id as any)}
                  className={`flex-1 px-4 py-2.5 font-mono text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 ${tab === t.id ? "text-emerald-400 border-b-2 border-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
                  data-testid={`tab-wallet-${t.id}`}
                >
                  <t.icon className="w-3 h-3" /> {t.label}
                </button>
              ))}
            </div>

            <div className="p-5">
              {tab === "deposit"  && <DepositTab connectedAddress={addr} chain={chain} setChain={setChain} ensureSiwe={ensureSiwe} siweBusy={siweBusy} siweError={siweError} />}
              {tab === "withdraw" && <WithdrawTab connectedAddress={addr} chain={chain} setChain={setChain} ensureSiwe={ensureSiwe} siweBusy={siweBusy} siweError={siweError} />}
              {tab === "backup"   && <BackupTab ensureSiwe={ensureSiwe} siweBusy={siweBusy} siweError={siweError} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChainPicker({ chain, setChain }: { chain: ChainKey; setChain: (c: ChainKey) => void }) {
  return (
    <div className="grid grid-cols-4 gap-2 mb-4">
      {CHAIN_KEYS.map((k) => (
        <button
          key={k}
          onClick={() => setChain(k)}
          className={`px-2 py-2 rounded font-mono text-[10px] uppercase tracking-widest border transition-colors ${chain === k ? "border-emerald-400 bg-emerald-400/10 text-emerald-300" : "border-zinc-800 text-zinc-400 hover:border-zinc-600"}`}
          data-testid={`chain-${k}`}
        >
          {CHAIN_META[k].name.split(" ")[0]}
        </button>
      ))}
    </div>
  );
}

function DepositTab({ connectedAddress, chain, setChain, ensureSiwe, siweBusy, siweError }: { connectedAddress: string; chain: ChainKey; setChain: (c: ChainKey) => void; ensureSiwe: () => Promise<void>; siweBusy: boolean; siweError: string | null }) {
  const [copied, setCopied] = useState(false);
  const [depositAddr, setDepositAddr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const meta = CHAIN_META[chain];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr(null); setLoading(true);
      try {
        await ensureSiwe();
        const r = await fetch("/api/wallet/deposit-info", { credentials: "include" });
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) throw new Error(j.error || "Failed to load deposit info");
        setDepositAddr(j.address);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Failed to load deposit info");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ensureSiwe, connectedAddress]);

  const copy = useCallback(() => {
    if (!depositAddr) return;
    navigator.clipboard.writeText(depositAddr).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }, [depositAddr]);
  const qrUrl = useMemo(() => depositAddr ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(depositAddr)}&bgcolor=09090b&color=10b981&qzone=2` : "", [depositAddr]);

  return (
    <div>
      <ChainPicker chain={chain} setChain={setChain} />
      {(loading || siweBusy) && <div className="p-4 text-center font-mono text-xs text-zinc-400 inline-flex items-center justify-center gap-2 w-full"><Loader2 className="w-3 h-3 animate-spin" /> Loading custodial address…</div>}
      {(err || siweError) && !loading && <div className="p-2 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-300 font-mono flex items-start gap-2"><AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />{err || siweError}</div>}
      {depositAddr && !loading && (
        <>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4 flex items-center gap-4">
            <img src={qrUrl} alt="address QR" width={120} height={120} className="rounded bg-zinc-950 p-1" data-testid="img-deposit-qr" />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Your custodial address on {meta.name}</div>
              <div className="font-mono text-xs text-zinc-100 break-all mt-1" data-testid="text-deposit-address">{depositAddr}</div>
              <button onClick={copy} className="mt-2 font-mono text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:border-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1.5" data-testid="button-copy-address">
                <Copy className="w-3 h-3" /> {copied ? "Copied" : "Copy address"}
              </button>
            </div>
          </div>
          <div className="mt-3 font-mono text-[11px] text-zinc-400 leading-relaxed">
            Send any of these tokens on <span className="text-emerald-300">{meta.name}</span>:{" "}
            <span className="text-zinc-200">{meta.tokens.join(" · ")}</span>
          </div>
          <div className="mt-3 p-2 rounded border border-amber-500/30 bg-amber-500/5 text-[11px] font-mono text-amber-200 flex items-start gap-2">
            <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
            <span>This is your BUILD4 trading wallet — different from your connected wallet ({connectedAddress.slice(0, 6)}…{connectedAddress.slice(-4)}). Send only on the selected chain.</span>
          </div>
        </>
      )}
    </div>
  );
}

function WithdrawTab({ connectedAddress, chain, setChain, ensureSiwe, siweBusy, siweError }: { connectedAddress: string; chain: ChainKey; setChain: (c: ChainKey) => void; ensureSiwe: () => Promise<void>; siweBusy: boolean; siweError: string | null }) {
  const address = connectedAddress;
  const meta = CHAIN_META[chain];
  const [token, setToken] = useState<string>(meta.tokens[1] || meta.native);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState(address);
  const [bal, setBal] = useState<{ native: string; tokens: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<{ hash: string; explorer: string } | null>(null);

  useEffect(() => { setToken(meta.tokens[1] || meta.native); }, [chain]);
  useEffect(() => { setTo(address); }, [address]);

  const loadBalance = useCallback(async () => {
    try {
      await ensureSiwe();
      const r = await fetch(`/api/wallet/balance?chain=${chain}`, { credentials: "include" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Balance failed");
      const tokenMap: Record<string, string> = {};
      for (const t of j.tokens || []) tokenMap[t.symbol] = t.balance;
      setBal({ native: j.native?.balance || "0", tokens: tokenMap });
    } catch (e: any) { setErr(e?.message || "Balance failed"); }
  }, [chain, ensureSiwe]);

  useEffect(() => { setBal(null); setErr(null); setTx(null); }, [chain]);

  const onWithdraw = useCallback(async () => {
    setErr(null); setTx(null); setBusy(true);
    try {
      await ensureSiwe();
      const tokenPayload = token === meta.native ? "native" : token;
      const r = await fetch("/api/wallet/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ chain, token: tokenPayload, amount, toAddress: to }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Withdraw failed");
      setTx({ hash: j.txHash, explorer: j.explorer });
      setAmount("");
      loadBalance();
    } catch (e: any) { setErr(e?.message || "Withdraw failed"); }
    finally { setBusy(false); }
  }, [chain, token, amount, to, meta.native, ensureSiwe, loadBalance]);

  const currentBal = token === meta.native ? bal?.native : bal?.tokens[token];

  return (
    <div>
      <ChainPicker chain={chain} setChain={setChain} />
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Token</label>
          <select value={token} onChange={(e) => setToken(e.target.value)} className="w-full mt-1 px-2 py-2 rounded bg-zinc-900 border border-zinc-800 font-mono text-sm text-zinc-100" data-testid="select-withdraw-token">
            {meta.tokens.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Amount</label>
          <div className="flex gap-1.5 mt-1">
            <input type="number" min="0" step="0.0001" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" className="flex-1 px-2 py-2 rounded bg-zinc-900 border border-zinc-800 font-mono text-sm text-zinc-100" data-testid="input-withdraw-amount" />
            <button onClick={() => currentBal && setAmount(currentBal)} className="px-2 rounded border border-zinc-800 font-mono text-[10px] text-zinc-400 hover:text-emerald-300 hover:border-emerald-400" data-testid="button-withdraw-max">MAX</button>
          </div>
        </div>
      </div>
      <label className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Recipient address</label>
      <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x… (defaults to your connected wallet)" className="w-full mt-1 px-2 py-2 rounded bg-zinc-900 border border-zinc-800 font-mono text-xs text-zinc-100" data-testid="input-withdraw-recipient" />

      <div className="mt-3 flex items-center justify-between font-mono text-[11px]">
        <button onClick={loadBalance} className="text-zinc-400 hover:text-emerald-300 inline-flex items-center gap-1" data-testid="button-refresh-balance">
          {bal ? `${currentBal ?? "0"} ${token} available` : "Load balance"}
        </button>
        <button onClick={onWithdraw} disabled={busy || siweBusy || !amount || Number(amount) <= 0} className="px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-black font-mono text-[11px] uppercase tracking-widest disabled:opacity-50 inline-flex items-center gap-1.5" data-testid="button-withdraw-submit">
          {busy ? <><Loader2 className="w-3 h-3 animate-spin" /> Sending…</> : <>Withdraw <ArrowUpFromLine className="w-3 h-3" /></>}
        </button>
      </div>

      {(err || siweError) && <div className="mt-3 p-2 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-300 font-mono flex items-start gap-2"><AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />{err || siweError}</div>}
      {tx && (
        <div className="mt-3 p-3 rounded border border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-200 font-mono">
          <div className="flex items-center gap-2 mb-1"><CheckCircle2 className="w-3 h-3" /> Withdraw broadcast</div>
          <a href={tx.explorer} target="_blank" rel="noopener noreferrer" className="text-emerald-300 hover:underline truncate block" data-testid="link-withdraw-tx">{tx.hash} <ExternalLink className="inline w-3 h-3" /></a>
        </div>
      )}
    </div>
  );
}

function BackupTab({ ensureSiwe, siweBusy, siweError }: { ensureSiwe: () => Promise<void>; siweBusy: boolean; siweError: string | null }) {
  const [pk, setPk] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reveal = useCallback(async () => {
    setErr(null); setBusy(true);
    try {
      await ensureSiwe();
      const r = await fetch("/api/wallet/reveal-pk", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Reveal failed");
      setPk(j.privateKey);
    } catch (e: any) { setErr(e?.message || "Reveal failed"); }
    finally { setBusy(false); }
  }, [ensureSiwe]);

  const copy = useCallback(() => {
    if (!pk) return;
    navigator.clipboard.writeText(pk).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }, [pk]);

  if (!pk) {
    return (
      <div>
        <div className="p-3 rounded border border-amber-500/30 bg-amber-500/5 text-xs font-mono text-amber-200 flex items-start gap-2 mb-4">
          <Shield className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-bold mb-1">Read this before revealing.</div>
            <ul className="list-disc list-inside space-y-1 text-[11px] text-amber-100/80">
              <li>This key controls every chain's funds in your custodial wallet.</li>
              <li>Anyone with this key can drain your account — store it offline.</li>
              <li>Pasting it into another wallet (e.g. MetaMask) gives that wallet full control.</li>
              <li>BUILD4 will never ask you for this key. Treat any DM that does as a phishing attempt.</li>
            </ul>
          </div>
        </div>
        <label className="flex items-start gap-2 font-mono text-[11px] text-zinc-300 mb-4 cursor-pointer">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" data-testid="checkbox-pk-ack" />
          I understand the risks and want to back up my private key.
        </label>
        <button onClick={reveal} disabled={!acknowledged || busy || siweBusy} className="w-full px-3 py-2 rounded bg-red-600 hover:bg-red-500 text-white font-mono text-xs uppercase tracking-widest disabled:opacity-50 inline-flex items-center justify-center gap-2" data-testid="button-reveal-pk">
          {busy || siweBusy ? <><Loader2 className="w-4 h-4 animate-spin" /> {siweBusy ? "Sign in your wallet…" : "Decrypting…"}</> : <><KeyRound className="w-4 h-4" /> Sign and reveal private key</>}
        </button>
        {(err || siweError) && <div className="mt-3 p-2 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-300 font-mono flex items-start gap-2"><AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />{err || siweError}</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Custodial private key</div>
      <div className="rounded border border-red-500/40 bg-zinc-900 p-3 font-mono text-xs break-all text-zinc-100 select-all" data-testid="text-pk-revealed">
        {show ? pk : "•".repeat(Math.min(64, pk.length))}
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={() => setShow(!show)} className="flex-1 px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 font-mono text-[11px] inline-flex items-center justify-center gap-1.5" data-testid="button-toggle-pk-visibility">
          {show ? <><EyeOff className="w-3 h-3" /> Hide</> : <><Eye className="w-3 h-3" /> Show</>}
        </button>
        <button onClick={copy} className="flex-1 px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:border-emerald-400 hover:text-emerald-300 font-mono text-[11px] inline-flex items-center justify-center gap-1.5" data-testid="button-copy-pk">
          <Copy className="w-3 h-3" /> {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={() => { setPk(null); setShow(false); setAcknowledged(false); }} className="flex-1 px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-mono text-[11px]" data-testid="button-pk-done">Done</button>
      </div>
      <div className="mt-3 text-[11px] font-mono text-zinc-500">Wipe your clipboard after pasting it somewhere safe.</div>
    </div>
  );
}

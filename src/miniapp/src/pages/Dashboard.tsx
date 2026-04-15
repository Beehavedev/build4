import { useState, useEffect } from "react";
import { getTelegramUser, getUser, getUserAgents, type UserData, type AgentData } from "../api";

interface AsterBalance {
  accountValue: number;
  availableBalance: number;
  marginUsed: number;
  unrealizedPnl: number;
  coin: string;
}

interface BalanceData {
  native: string;
  usdt: string;
  address: string | null;
  chain?: string;
  aster: AsterBalance | null;
}

export function Dashboard() {
  const [user, setUser] = useState<UserData | null>(null);
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [walletAddress, setWalletAddress] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    async function load() {
      const tgUser = getTelegramUser();
      if (!tgUser) {
        setLoading(false);
        return;
      }
      try {
        const u = await getUser(tgUser.id);
        setUser(u);
        const [a, balRes] = await Promise.all([
          getUserAgents(u.id),
          fetch(`/api/balance/${tgUser.id}`).then(r => r.ok ? r.json() : null),
        ]);
        setAgents(a);
        if (balRes) {
          setBalance(balRes);
          if (balRes.address) setWalletAddress(balRes.address);
        }
      } catch (err) {
        console.error("Failed to load:", err);
      }
      setLoading(false);
    }
    load();
  }, []);

  async function handleConnect() {
    const tgUser = getTelegramUser();
    if (!tgUser || !apiKey.trim() || !apiSecret.trim()) return;

    setImporting(true);
    setImportError("");

    try {
      const res = await fetch("/api/connect-aster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramId: tgUser.id, apiKey: apiKey.trim(), apiSecret: apiSecret.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setImportError(data.error || "Connection failed");
        setImporting(false);
        return;
      }

      setBalance({
        native: data.native,
        usdt: data.usdt,
        address: data.address,
        chain: data.chain,
        aster: data.aster,
      });
      if (data.address) setWalletAddress(data.address);
      setShowImport(false);
      setApiKey("");
      setApiSecret("");

      try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success"); } catch {}
    } catch (err: any) {
      setImportError("Connection error. Try again.");
    }
    setImporting(false);
  }

  if (loading) return <div className="loading">Loading...</div>;

  const totalPnl = agents.reduce((s, a) => s + a.totalPnl, 0);
  const totalTrades = agents.reduce((s, a) => s + a.totalTrades, 0);
  const activeAgents = agents.filter(a => a.isActive && !a.isPaused).length;

  return (
    <div className="page">
      <div className="card">
        <div className="card-title">Portfolio Value</div>
        <div className="balance-large">
          ${balance ? parseFloat(balance.usdt).toFixed(2) : "0.00"}
        </div>
        {balance && parseFloat(balance.native) > 0 && (
          <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "4px" }}>
            {parseFloat(balance.native).toFixed(6)} {balance.chain === "BSC" ? "BNB" : "ETH"}
          </div>
        )}
        <div className={totalPnl >= 0 ? "pnl-positive" : "pnl-negative"}>
          {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)} USD all time
        </div>
        <div className="stats-row">
          <div className="stat-item">
            <div className="stat-value">{agents.length}</div>
            <div className="stat-label">Agents</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{activeAgents}</div>
            <div className="stat-label">Active</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{totalTrades}</div>
            <div className="stat-label">Trades</div>
          </div>
        </div>
      </div>

      <div className="card" data-testid="aster-balance-card">
        <div className="card-header">
          <div className="card-title">Aster DEX Account</div>
          {balance?.aster ? (
            <span className="badge badge-active">⭐ Connected</span>
          ) : (
            <span className="badge badge-stopped">○ Not connected</span>
          )}
        </div>
        {balance?.aster ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px" }}>
              <div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Account Value</div>
                <div style={{ fontSize: "24px", fontWeight: 700 }}>
                  ${balance.aster.accountValue.toFixed(2)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Unrealized PnL</div>
                <div className={balance.aster.unrealizedPnl >= 0 ? "pnl-positive" : "pnl-negative"} style={{ fontSize: "16px", fontWeight: 600 }}>
                  {balance.aster.unrealizedPnl >= 0 ? "+" : ""}{balance.aster.unrealizedPnl.toFixed(2)}
                </div>
              </div>
            </div>
            <div className="stats-row" style={{ marginTop: "4px" }}>
              <div className="stat-item">
                <div className="stat-value" style={{ fontSize: "14px" }}>${balance.aster.availableBalance.toFixed(2)}</div>
                <div className="stat-label">Available</div>
              </div>
              <div className="stat-item">
                <div className="stat-value" style={{ fontSize: "14px" }}>${balance.aster.marginUsed.toFixed(2)}</div>
                <div className="stat-label">Margin Used</div>
              </div>
              <div className="stat-item">
                <div className="stat-value" style={{ fontSize: "14px" }}>{balance.aster.coin}</div>
                <div className="stat-label">Currency</div>
              </div>
            </div>
          </>
        ) : (
          <div style={{ padding: "8px 0" }}>
            {!showImport ? (
              <div style={{ textAlign: "center" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "12px" }}>
                  Link your Aster DEX wallet to see balances and trade
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => setShowImport(true)}
                  data-testid="btn-connect-aster"
                >
                  🔗 Connect Wallet
                </button>
              </div>
            ) : (
              <div className="trade-form">
                <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                  Enter your Aster DEX API credentials:
                </div>
                <div className="input-group">
                  <label className="input-label">API Key</label>
                  <input
                    className="input-field"
                    type="text"
                    placeholder="Your Aster API key"
                    value={apiKey}
                    onChange={e => { setApiKey(e.target.value); setImportError(""); }}
                    data-testid="input-api-key"
                    autoComplete="off"
                  />
                </div>
                <div className="input-group">
                  <label className="input-label">API Secret</label>
                  <input
                    className="input-field"
                    type="password"
                    placeholder="Your Aster API secret"
                    value={apiSecret}
                    onChange={e => { setApiSecret(e.target.value); setImportError(""); }}
                    data-testid="input-api-secret"
                    autoComplete="off"
                  />
                </div>
                {importError && (
                  <div style={{ color: "var(--red)", fontSize: "12px" }}>{importError}</div>
                )}
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                  🔒 Get your API key from asterdex.com → Account → API Management
                </div>
                <div className="btn-row">
                  <button
                    className="btn btn-primary"
                    onClick={handleConnect}
                    disabled={importing || !apiKey.trim() || !apiSecret.trim()}
                    data-testid="btn-connect-submit"
                    style={{ opacity: importing || !apiKey.trim() || !apiSecret.trim() ? 0.5 : 1 }}
                  >
                    {importing ? "Connecting..." : "⭐ Connect to Aster"}
                  </button>
                  <button
                    className="btn btn-outline"
                    onClick={() => { setShowImport(false); setApiKey(""); setApiSecret(""); setImportError(""); }}
                    data-testid="btn-connect-cancel"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {walletAddress && (
        <div className="card">
          <div className="card-title">BSC Wallet</div>
          <div className="wallet-address" data-testid="wallet-address">{walletAddress}</div>
          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Deposit USDT (BEP-20) to start trading
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">Quick Actions</div>
        <div className="btn-row">
          <button className="btn btn-primary btn-sm" data-testid="btn-quick-trade">⚡ Trade</button>
          <button className="btn btn-outline btn-sm" data-testid="btn-quick-agent">🤖 New Agent</button>
          <button className="btn btn-outline btn-sm" data-testid="btn-quick-signals">📊 Signals</button>
        </div>
      </div>

      {agents.length > 0 && (
        <div>
          <div className="section-title">🤖 Your Agents</div>
          {agents.slice(0, 3).map(a => (
            <div className="agent-card" key={a.id} data-testid={`agent-card-${a.id}`}>
              <div className="agent-header">
                <div className="agent-name">{a.name}</div>
                <span className={`badge ${a.isActive && !a.isPaused ? "badge-active" : a.isPaused ? "badge-paused" : "badge-stopped"}`}>
                  {a.isActive && !a.isPaused ? "▶ Active" : a.isPaused ? "⏸ Paused" : "⏹ Stopped"}
                </span>
              </div>
              {a.description && <div className="agent-desc">{a.description}</div>}
              <div className="stats-row" style={{ marginTop: 0 }}>
                <div className="stat-item">
                  <div className="stat-value">{a.totalTrades}</div>
                  <div className="stat-label">Trades</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{(a.winRate * 100).toFixed(0)}%</div>
                  <div className="stat-label">Win Rate</div>
                </div>
                <div className="stat-item">
                  <div className={a.totalPnl >= 0 ? "stat-value pnl-positive" : "stat-value pnl-negative"}>
                    ${a.totalPnl.toFixed(2)}
                  </div>
                  <div className="stat-label">PnL</div>
                </div>
              </div>
              {(a.erc8004Registered || a.onchainRegistered) && (
                <div className="registry-info">
                  {a.erc8004Registered && (
                    <span className="badge badge-registry">🔗 ERC-8004 #{a.erc8004TokenId}</span>
                  )}
                  {a.onchainRegistered && (
                    <span className="badge badge-registry">⛓ On-chain</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

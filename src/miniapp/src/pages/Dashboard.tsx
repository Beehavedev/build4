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
  const [copied, setCopied] = useState(false);

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

  function copyAddress() {
    if (!walletAddress) return;
    navigator.clipboard.writeText(walletAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success"); } catch {}
    });
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
          <div className="card-title">Aster DEX (Broker)</div>
          {balance?.aster && balance.aster.accountValue > 0 ? (
            <span className="badge badge-active" data-testid="badge-broker-connected">⭐ Active</span>
          ) : (
            <span className="badge badge-stopped" data-testid="badge-broker-status">○ Standby</span>
          )}
        </div>
        {balance?.aster ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px" }}>
              <div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Broker Account</div>
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
          <div style={{ padding: "8px 0", textAlign: "center" }}>
            <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>
              Build4 trades on Aster DEX for you. Deposit USDT to get started.
            </div>
          </div>
        )}
      </div>

      {walletAddress && (
        <div className="card">
          <div className="card-title">Deposit Wallet</div>
          <div
            className="wallet-address"
            data-testid="wallet-address"
            onClick={copyAddress}
            style={{ cursor: "pointer" }}
          >
            {walletAddress}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "8px" }}>
            <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              Send USDT (BEP-20) to this address
            </div>
            <button
              className="btn btn-outline btn-sm"
              onClick={copyAddress}
              data-testid="btn-copy-address"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
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

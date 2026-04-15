import { useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { Trade } from "./pages/Trade";
import { Agents } from "./pages/Agents";
import { Positions } from "./pages/Positions";
import { Leaderboard } from "./pages/Leaderboard";

type Tab = "dashboard" | "trade" | "agents" | "positions" | "leaderboard";

const tabs: { id: Tab; icon: string; label: string }[] = [
  { id: "dashboard", icon: "🏠", label: "Home" },
  { id: "trade", icon: "⚡", label: "Trade" },
  { id: "positions", icon: "📊", label: "Positions" },
  { id: "agents", icon: "🤖", label: "Agents" },
  { id: "leaderboard", icon: "🏆", label: "Top" },
];

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  return (
    <div className="app">
      <div className="header">
        <div>
          <div className="header-title">
            ⭐ Build4 × Aster DEX
          </div>
          <div className="header-subtitle">AI-Powered Perpetual Trading</div>
        </div>
      </div>

      {activeTab === "dashboard" && <Dashboard />}
      {activeTab === "trade" && <Trade />}
      {activeTab === "agents" && <Agents />}
      {activeTab === "positions" && <Positions />}
      {activeTab === "leaderboard" && <Leaderboard />}

      <div className="tab-bar" data-testid="tab-bar">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`tab-item ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
            data-testid={`tab-${t.id}`}
          >
            <span className="tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

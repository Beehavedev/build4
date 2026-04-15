import { createRoot } from "react-dom/client";

function App() {
  return (
    <div style={{ padding: "20px", fontFamily: "system-ui", background: "#0a0a0a", color: "#fff", minHeight: "100vh" }}>
      <h1 style={{ fontSize: "24px", marginBottom: "16px" }}>🚀 Build4 Trading Bot</h1>
      <p style={{ color: "#888" }}>Mini App coming soon. Use the Telegram bot for all features.</p>
      <div style={{ marginTop: "24px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ background: "#1a1a2e", padding: "16px", borderRadius: "12px" }}>
          <h3 style={{ margin: "0 0 8px 0" }}>📊 Dashboard</h3>
          <p style={{ margin: 0, color: "#888", fontSize: "14px" }}>Portfolio overview and PnL charts</p>
        </div>
        <div style={{ background: "#1a1a2e", padding: "16px", borderRadius: "12px" }}>
          <h3 style={{ margin: "0 0 8px 0" }}>🤖 Agent Studio</h3>
          <p style={{ margin: 0, color: "#888", fontSize: "14px" }}>Manage your AI trading agents</p>
        </div>
        <div style={{ background: "#1a1a2e", padding: "16px", borderRadius: "12px" }}>
          <h3 style={{ margin: "0 0 8px 0" }}>🏆 Copy Trading</h3>
          <p style={{ margin: 0, color: "#888", fontSize: "14px" }}>Follow top traders</p>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

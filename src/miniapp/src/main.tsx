// ─────────────────────────────────────────────────────────────────────────────
// LEGACY / UNUSED ENTRY — NOT THE LIVE PATH.
// The vite build is driven by ../index.html which resolves
// <script src="/main.tsx"> to src/miniapp/main.tsx. That file imports
// ./src/App and ./src/index.css, which are the production source of truth.
// Keep this file's Telegram chrome init loosely in sync as a hedge in case
// the build is ever pointed back here, but do NOT add new behavior here
// without first redirecting index.html or you will ship dead code.
// ─────────────────────────────────────────────────────────────────────────────
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  // Lock the WebApp chrome to the same colour as our --bg-primary so the
  // joint between Telegram's native header and our React content is
  // seamless. Previously these were #0a0a0f vs #0D0D0F (--bg-primary),
  // which produced a thin lighter band at the top during scroll bounce.
  try { tg.setHeaderColor("#0D0D0F"); } catch {}
  try { tg.setBackgroundColor("#0D0D0F"); } catch {}
  try { tg.setBottomBarColor?.("#0D0D0F"); } catch {}
  // Bot API 7.7+: stop the user's vertical swipe from collapsing the
  // sheet — that's what reveals the chat behind the WebApp ("oracle test
  // markets on BSC" peeking through above our header in the wild).
  try { tg.disableVerticalSwipes?.(); } catch {}
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

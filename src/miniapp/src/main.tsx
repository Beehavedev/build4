import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor("#0a0a0f");
    tg.setBackgroundColor("#0a0a0f");
  } catch {}
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

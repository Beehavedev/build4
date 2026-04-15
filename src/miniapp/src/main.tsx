import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        initDataUnsafe: {
          user?: { id: number; first_name: string; username?: string };
        };
        ready: () => void;
        expand: () => void;
        close: () => void;
        MainButton: {
          text: string;
          show: () => void;
          hide: () => void;
          onClick: (cb: () => void) => void;
        };
        themeParams: Record<string, string>;
        colorScheme: "dark" | "light";
        setHeaderColor: (color: string) => void;
        setBackgroundColor: (color: string) => void;
      };
    };
  }
}

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

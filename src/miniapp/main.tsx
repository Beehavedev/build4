import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './src/App'
import './src/index.css'

// ── Telegram WebApp chrome init ─────────────────────────────────────────────
// Lock Telegram's native header / background / bottom-bar to the same colour
// our --bg-primary uses (see index.css). Any drift here re-opens the bug
// where a thin lighter band of the Telegram chat thread bleeds in above
// our React content on iOS scroll bounce. We also try disableVerticalSwipes
// (Bot API 7.7+) so the user's downward drag doesn't collapse the WebApp
// sheet — that's the other path through which the parent chat peeks in.
const tg = (window as any)?.Telegram?.WebApp
if (tg) {
  try { tg.ready?.() } catch {}
  try { tg.expand?.() } catch {}
  try { tg.setHeaderColor?.('#0D0D0F') } catch {}
  try { tg.setBackgroundColor?.('#0D0D0F') } catch {}
  try { tg.setBottomBarColor?.('#0D0D0F') } catch {}
  try { tg.disableVerticalSwipes?.() } catch {}
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

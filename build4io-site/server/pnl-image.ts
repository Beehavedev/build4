import * as path from "path";
import * as fs from "fs";

const CARD_W = 1200;
const CARD_H = 630;

let sharpModule: any = null;

async function getSharp() {
  if (!sharpModule) {
    sharpModule = (await import("sharp")).default;
  }
  return sharpModule;
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface PnlCardParams {
  pnlPercent: number;
  pnlUsd: number;
  symbol: string;
  side: string;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  name: string;
  ref: string;
}

export async function generatePnlCardImage(p: PnlCardParams): Promise<Buffer> {
  const isProfit = p.pnlPercent >= 0;
  const pctText = `${isProfit ? "+" : ""}${p.pnlPercent.toFixed(2)}%`;
  const pnlColor = isProfit ? "#0ecb81" : "#f6465d";
  const accentRgb = isProfit ? "14,203,129" : "246,70,93";
  const sideColor = p.side === "LONG" ? "#0ecb81" : "#f6465d";
  const refCode = p.ref || "build4";
  const refLink = `t.me/build4_bot?start=${refCode}`;

  const pnlSign = p.pnlUsd >= 0 ? "+" : "";
  const hasTrade = p.symbol && p.symbol !== "BTCUSDT" || p.entryPrice > 0;
  const showPrices = p.entryPrice > 0 && p.markPrice > 0;

  const svgOverlay = `<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b0e11"/>
      <stop offset="100%" stop-color="#0b0e11"/>
    </linearGradient>
    <radialGradient id="glow1" cx="20%" cy="30%" r="50%">
      <stop offset="0%" stop-color="rgba(${accentRgb},0.12)"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <radialGradient id="glow2" cx="80%" cy="80%" r="40%">
      <stop offset="0%" stop-color="rgba(${accentRgb},0.06)"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <linearGradient id="barGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${pnlColor}"/>
      <stop offset="100%" stop-color="rgba(${accentRgb},0.3)"/>
    </linearGradient>
  </defs>

  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#glow1)"/>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#glow2)"/>

  <!-- Top border accent -->
  <rect x="0" y="0" width="${CARD_W}" height="4" fill="${pnlColor}" opacity="0.8"/>

  <!-- Header -->
  <text x="60" y="58" font-family="SF Mono,Consolas,monospace" font-size="32" font-weight="900" fill="#ffffff" letter-spacing="3">BUILD4</text>
  <text x="255" y="58" font-family="Arial,sans-serif" font-size="14" fill="#555" letter-spacing="1">ASTER DEX FUTURES</text>

  <!-- Powered by badge -->
  <rect x="${CARD_W - 220}" y="20" width="190" height="42" rx="8" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="${CARD_W - 210}" y="38" font-family="Arial,sans-serif" font-size="9" fill="#555" letter-spacing="1.5">POWERED BY</text>
  <text x="${CARD_W - 210}" y="54" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#8a919e">Aster DEX</text>

  <!-- Divider -->
  <line x1="60" y1="80" x2="${CARD_W - 60}" y2="80" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  ${hasTrade ? `
  <!-- Trade badges -->
  <rect x="60" y="100" width="${p.side.length * 14 + 24}" height="32" rx="6" fill="${sideColor}" opacity="0.15"/>
  <text x="72" y="122" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="${sideColor}">${escXml(p.side)}</text>
  <rect x="${84 + p.side.length * 14}" y="100" width="${String(p.leverage).length * 12 + 36}" height="32" rx="6" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <text x="${96 + p.side.length * 14}" y="122" font-family="SF Mono,Consolas,monospace" font-size="14" font-weight="600" fill="#ccc">${p.leverage}x</text>
  <text x="${148 + p.side.length * 14 + String(p.leverage).length * 12}" y="122" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="#ffffff">${escXml(p.symbol)}</text>
  ` : `
  <text x="60" y="122" font-family="Arial,sans-serif" font-size="18" font-weight="600" fill="#8a919e">Overall Performance</text>
  `}

  <!-- Main PnL percentage -->
  <text x="60" y="230" font-family="SF Mono,Consolas,monospace" font-size="96" font-weight="900" fill="${pnlColor}" letter-spacing="-4">${escXml(pctText)}</text>

  <!-- PnL USD -->
  <text x="60" y="275" font-family="SF Mono,Consolas,monospace" font-size="24" fill="${pnlColor}" opacity="0.85">${pnlSign}$${Math.abs(p.pnlUsd).toFixed(2)} USDT</text>

  ${showPrices ? `
  <!-- Price section -->
  <line x1="60" y1="305" x2="600" y2="305" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>

  <rect x="60" y="320" width="240" height="70" rx="10" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <text x="80" y="345" font-family="Arial,sans-serif" font-size="11" fill="#555" letter-spacing="1.5">ENTRY PRICE</text>
  <text x="80" y="374" font-family="SF Mono,Consolas,monospace" font-size="22" font-weight="700" fill="#ffffff">$${p.entryPrice.toFixed(p.entryPrice < 1 ? 6 : 2)}</text>

  <rect x="320" y="320" width="240" height="70" rx="10" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <text x="340" y="345" font-family="Arial,sans-serif" font-size="11" fill="#555" letter-spacing="1.5">MARK PRICE</text>
  <text x="340" y="374" font-family="SF Mono,Consolas,monospace" font-size="22" font-weight="700" fill="#ffffff">$${p.markPrice.toFixed(p.markPrice < 1 ? 6 : 2)}</text>
  ` : ''}

  <!-- Stats row removed -->

  <!-- Referral section -->
  <rect x="60" y="${CARD_H - 120}" width="${CARD_W - 120}" height="60" rx="12" fill="rgba(${accentRgb},0.05)" stroke="rgba(${accentRgb},0.15)" stroke-width="1"/>
  <text x="85" y="${CARD_H - 92}" font-family="Arial,sans-serif" font-size="10" fill="#555" letter-spacing="1.5">JOIN</text>
  <text x="85" y="${CARD_H - 72}" font-family="SF Mono,Consolas,monospace" font-size="16" font-weight="700" fill="rgba(${accentRgb},0.9)">${escXml(refLink)}</text>

  <!-- Footer -->
  <line x1="60" y1="${CARD_H - 45}" x2="${CARD_W - 60}" y2="${CARD_H - 45}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
  <text x="60" y="${CARD_H - 20}" font-family="Arial,sans-serif" font-size="12" fill="#444">${escXml(p.name)} • Autonomous AI Futures Trading on Telegram</text>

  <!-- Right side decorative chart lines -->
  ${isProfit ? `
  <polyline points="700,${CARD_H - 180} 780,${CARD_H - 220} 860,${CARD_H - 200} 940,${CARD_H - 280} 1020,${CARD_H - 260} 1100,${CARD_H - 340} 1160,${CARD_H - 380}" fill="none" stroke="rgba(${accentRgb},0.15)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="700,${CARD_H - 160} 780,${CARD_H - 190} 860,${CARD_H - 175} 940,${CARD_H - 240} 1020,${CARD_H - 225} 1100,${CARD_H - 300} 1160,${CARD_H - 340}" fill="none" stroke="rgba(${accentRgb},0.07)" stroke-width="1.5" stroke-linecap="round"/>
  ` : `
  <polyline points="700,${CARD_H - 380} 780,${CARD_H - 340} 860,${CARD_H - 360} 940,${CARD_H - 280} 1020,${CARD_H - 300} 1100,${CARD_H - 220} 1160,${CARD_H - 180}" fill="none" stroke="rgba(${accentRgb},0.15)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="700,${CARD_H - 360} 780,${CARD_H - 320} 860,${CARD_H - 340} 940,${CARD_H - 260} 1020,${CARD_H - 280} 1100,${CARD_H - 200} 1160,${CARD_H - 170}" fill="none" stroke="rgba(${accentRgb},0.07)" stroke-width="1.5" stroke-linecap="round"/>
  `}

  <!-- Large decorative PnL icon -->
  <text x="${CARD_W - 180}" y="200" font-family="Arial,sans-serif" font-size="120" fill="rgba(${accentRgb},0.06)">${isProfit ? '↗' : '↘'}</text>

</svg>`;

  const sharp = await getSharp();
  const svgBuf = Buffer.from(svgOverlay);

  const base = sharp({
    create: {
      width: CARD_W,
      height: CARD_H,
      channels: 4,
      background: { r: 11, g: 14, b: 17, alpha: 255 },
    },
  });

  const result = await base
    .composite([
      { input: svgBuf, top: 0, left: 0 },
    ])
    .png({ quality: 90 })
    .toBuffer();

  return result;
}

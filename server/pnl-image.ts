import * as path from "path";
import * as fs from "fs";

const CARD_W = 1200;
const CARD_H = 630;

const assetsDir = path.join(process.cwd(), "server", "assets");

let imageCache: Record<string, Buffer> = {};
let sharpModule: any = null;

async function getSharp() {
  if (!sharpModule) {
    sharpModule = (await import("sharp")).default;
  }
  return sharpModule;
}

async function loadAsset(filename: string): Promise<Buffer> {
  if (imageCache[filename]) return imageCache[filename];
  const buf = fs.readFileSync(path.join(assetsDir, filename));
  imageCache[filename] = buf;
  return buf;
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
  wins: number;
  losses: number;
  ref: string;
}

export async function generatePnlCardImage(p: PnlCardParams): Promise<Buffer> {
  const isProfit = p.pnlPercent >= 0;
  const pctText = `${isProfit ? "+" : ""}${p.pnlPercent.toFixed(2)}%`;
  const pnlColor = isProfit ? "#0ecb81" : "#f6465d";
  const bgGrad1 = isProfit ? "#0a1f12" : "#1f0a0a";
  const bgGrad2 = isProfit ? "#0b0e11" : "#0b0e11";
  const accentRgb = isProfit ? "14,203,129" : "246,70,93";
  const sideColor = p.side === "LONG" ? "#0ecb81" : "#f6465d";
  const refCode = p.ref || "build4";
  const refLink = `t.me/build4bot?start=${refCode}`;

  const mascotFile = isProfit
    ? (p.pnlPercent > 50 ? "chad-profit.png" : "pepe-profit.jpg")
    : "pepe-loss.jpg";

  const sharp = await getSharp();
  const mascotBuf = await loadAsset(mascotFile);
  const mascotMeta = await sharp(mascotBuf).metadata();
  const mW = mascotMeta.width || 400;
  const mH = mascotMeta.height || 400;

  const targetH = 420;
  const scale = targetH / mH;
  const resizedW = Math.round(mW * scale);
  const resizedH = targetH;

  const mascotResized = await sharp(mascotBuf)
    .resize(resizedW, resizedH, { fit: "cover" })
    .toBuffer();

  const mascotX = CARD_W - resizedW + 30;
  const mascotY = CARD_H - resizedH + 10;

  const winRate = p.wins + p.losses > 0 ? Math.round(p.wins / (p.wins + p.losses) * 100) : 0;
  const pnlSign = p.pnlUsd >= 0 ? "+" : "";

  const hasTrade = p.symbol && p.symbol !== "BTCUSDT" || p.entryPrice > 0;
  const showPrices = p.entryPrice > 0 && p.markPrice > 0;

  const svgOverlay = `<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bgGrad1}"/>
      <stop offset="100%" stop-color="${bgGrad2}"/>
    </linearGradient>
    <radialGradient id="glow1" cx="80%" cy="20%" r="40%">
      <stop offset="0%" stop-color="rgba(${accentRgb},0.15)"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <radialGradient id="glow2" cx="10%" cy="90%" r="35%">
      <stop offset="0%" stop-color="rgba(${accentRgb},0.08)"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#glow1)"/>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#glow2)"/>

  ${isProfit ? `
  <polyline points="0,450 100,420 200,380 300,340 400,360 500,300 600,260 700,220 800,180" fill="none" stroke="rgba(${accentRgb},0.12)" stroke-width="2"/>
  <polyline points="0,480 150,450 300,410 400,430 500,380 600,340 700,300 800,250" fill="none" stroke="rgba(${accentRgb},0.06)" stroke-width="1.5"/>
  ` : `
  <polyline points="0,180 100,220 200,260 300,300 400,280 500,340 600,380 700,420 800,450" fill="none" stroke="rgba(${accentRgb},0.12)" stroke-width="2"/>
  <polyline points="0,200 150,250 300,310 400,290 500,350 600,390 700,410 800,460" fill="none" stroke="rgba(${accentRgb},0.06)" stroke-width="1.5"/>
  `}

  <text x="60" y="55" font-family="SF Mono,Consolas,monospace" font-size="28" font-weight="800" fill="#ffffff" letter-spacing="2">BUILD4</text>
  <text x="60" y="78" font-family="Arial,sans-serif" font-size="13" fill="#8a919e">Aster DEX Futures</text>

  ${hasTrade ? `
  <rect x="60" y="100" width="${p.side.length * 14 + 24}" height="30" rx="6" fill="${sideColor}" opacity="0.15"/>
  <text x="72" y="121" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="${sideColor}">${escXml(p.side)}</text>
  <rect x="${72 + p.side.length * 14 + 24}" y="100" width="${String(p.leverage).length * 12 + 36}" height="30" rx="6" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <text x="${84 + p.side.length * 14 + 24}" y="121" font-family="Arial,sans-serif" font-size="14" font-weight="600" fill="#ccc">${p.leverage}x</text>
  <rect x="${84 + p.side.length * 14 + 24 + String(p.leverage).length * 12 + 36}" y="100" width="${p.symbol.length * 10 + 24}" height="30" rx="6" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <text x="${96 + p.side.length * 14 + 24 + String(p.leverage).length * 12 + 36}" y="121" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#fff">${escXml(p.symbol)}</text>
  ` : `
  <text x="60" y="121" font-family="Arial,sans-serif" font-size="16" font-weight="600" fill="#8a919e">Overall Performance</text>
  `}

  <text x="60" y="220" font-family="SF Mono,Consolas,monospace" font-size="90" font-weight="900" fill="${pnlColor}" letter-spacing="-3">${escXml(pctText)}</text>

  <text x="60" y="265" font-family="SF Mono,Consolas,monospace" font-size="22" fill="${pnlColor}" opacity="0.8">${pnlSign}$${Math.abs(p.pnlUsd).toFixed(2)} USDT</text>

  ${showPrices ? `
  <text x="60" y="320" font-family="Arial,sans-serif" font-size="12" fill="#8a919e" letter-spacing="1">ENTRY PRICE</text>
  <text x="60" y="345" font-family="SF Mono,Consolas,monospace" font-size="20" font-weight="700" fill="#ffffff">$${p.entryPrice.toFixed(p.entryPrice < 1 ? 6 : 2)}</text>

  <text x="300" y="320" font-family="Arial,sans-serif" font-size="12" fill="#8a919e" letter-spacing="1">MARK PRICE</text>
  <text x="300" y="345" font-family="SF Mono,Consolas,monospace" font-size="20" font-weight="700" fill="#ffffff">$${p.markPrice.toFixed(p.markPrice < 1 ? 6 : 2)}</text>
  ` : ''}

  <line x1="60" y1="380" x2="550" y2="380" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <text x="60" y="415" font-family="Arial,sans-serif" font-size="12" fill="#8a919e" letter-spacing="1">WIN RATE</text>
  <text x="60" y="440" font-family="SF Mono,Consolas,monospace" font-size="20" font-weight="700" fill="${winRate >= 50 ? '#0ecb81' : '#f6465d'}">${winRate}%</text>

  <text x="220" y="415" font-family="Arial,sans-serif" font-size="12" fill="#8a919e" letter-spacing="1">W / L</text>
  <text x="220" y="440" font-family="SF Mono,Consolas,monospace" font-size="20" font-weight="700" fill="#ffffff">${p.wins} / ${p.losses}</text>

  <rect x="40" y="475" width="560" height="70" rx="14" fill="rgba(${accentRgb},0.06)" stroke="rgba(${accentRgb},0.2)" stroke-width="1"/>
  <text x="60" y="505" font-family="Arial,sans-serif" font-size="11" fill="#8a919e" letter-spacing="1">REFERRAL CODE</text>
  <text x="60" y="530" font-family="SF Mono,Consolas,monospace" font-size="18" font-weight="800" fill="rgba(${accentRgb},0.9)">${escXml(refCode.toUpperCase())}</text>
  <text x="250" y="530" font-family="Arial,sans-serif" font-size="13" fill="#8a919e">${escXml(refLink)}</text>

  <rect x="40" y="${CARD_H - 40}" width="400" height="25" rx="0" fill="transparent"/>
  <text x="60" y="${CARD_H - 22}" font-family="Arial,sans-serif" font-size="11" fill="#555">🤖 ${escXml(p.name)} • Trade futures on Telegram</text>

  <rect x="${CARD_W - 200}" y="15" width="180" height="45" rx="10" fill="rgba(${accentRgb},0.1)" stroke="rgba(${accentRgb},0.3)" stroke-width="1"/>
  <text x="${CARD_W - 190}" y="33" font-family="Arial,sans-serif" font-size="10" fill="#8a919e" letter-spacing="1">POWERED BY</text>
  <text x="${CARD_W - 190}" y="51" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#ffffff">Aster DEX</text>
</svg>`;

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
      { input: mascotResized, top: mascotY, left: mascotX, blend: "over" },
    ])
    .png({ quality: 90 })
    .toBuffer();

  return result;
}

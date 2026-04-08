import express from "express";
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { startTelegramBot, processWebhookUpdate, stopTelegramBot } from "./telegram-bot";
import { restoreTradingPreferences, startTradingAgent, isTradingAgentRunning } from "./trading-agent";
import { registerMiniAppRoutes } from "./miniapp-routes";
import { registerWeb4Routes } from "./web4-routes";
import pg from "pg";

process.on("uncaughtException", (err) => {
  console.error("[BOT-SERVER] Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[BOT-SERVER] Unhandled rejection:", reason);
});
process.on("SIGTERM", () => {
  console.log("[BOT-SERVER] SIGTERM — shutting down");
  stopTelegramBot();
  process.exit(0);
});

function findSchemaSQL(): string {
  const candidates = [
    join(process.cwd(), "dist", "schema-init.sql"),
    join(process.cwd(), "server", "schema-init.sql"),
    join(__dirname, "schema-init.sql"),
    join(__dirname, "..", "server", "schema-init.sql"),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf-8");
    } catch {}
  }
  return "";
}

const CRITICAL_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS "telegram_bot_subscriptions" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, wallet_address TEXT NOT NULL, chat_id TEXT NOT NULL, status TEXT DEFAULT 'trial'::text NOT NULL, trial_started_at TIMESTAMP DEFAULT now(), paid_at TIMESTAMP, expires_at TIMESTAMP, tx_hash TEXT, chain_id INTEGER, amount_paid TEXT, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "telegram_bot_referrals" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, referrer_chat_id TEXT NOT NULL, referred_chat_id TEXT NOT NULL, referral_code TEXT NOT NULL, status TEXT DEFAULT 'pending' NOT NULL, commission_percent INTEGER DEFAULT 30, commission_amount TEXT, commission_paid BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "telegram_wallets" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, chat_id TEXT NOT NULL, wallet_address TEXT NOT NULL, encrypted_key TEXT, created_at TIMESTAMP DEFAULT now(), is_active BOOLEAN DEFAULT true)`,
  `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "owner_telegram_chat_id" TEXT`,
  `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "preferred_model" TEXT`,
  `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP DEFAULT now()`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "agent_id" VARCHAR`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "creator_wallet" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "chain_id" INTEGER DEFAULT 56`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "platform" TEXT DEFAULT 'four_meme'`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "token_name" TEXT DEFAULT ''`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "token_symbol" TEXT DEFAULT ''`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "token_description" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "image_url" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "token_address" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "tx_hash" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "launch_url" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "initial_liquidity_bnb" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'pending'`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "error_message" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "metadata" TEXT`,
  `ALTER TABLE "token_launches" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP DEFAULT now()`,
  `CREATE TABLE IF NOT EXISTS "sniper_wallet_keys" (id VARCHAR DEFAULT gen_random_uuid() NOT NULL, launch_id VARCHAR, chat_id TEXT NOT NULL, agent_id VARCHAR NOT NULL, token_address TEXT, wallet_index INTEGER NOT NULL, wallet_address TEXT NOT NULL, encrypted_private_key TEXT NOT NULL, bnb_amount TEXT, status TEXT DEFAULT 'funded'::text NOT NULL, tx_hash TEXT, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "user_rewards" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, chat_id TEXT NOT NULL, reward_type TEXT NOT NULL, amount TEXT NOT NULL, description TEXT, reference_id TEXT, claimed BOOLEAN DEFAULT false NOT NULL, claimed_at TIMESTAMP, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "user_quests" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, chat_id TEXT NOT NULL, quest_id TEXT NOT NULL, completed BOOLEAN DEFAULT false NOT NULL, completed_at TIMESTAMP, reward_granted BOOLEAN DEFAULT false NOT NULL, created_at TIMESTAMP DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "user_quests_chat_quest_idx" ON "user_quests" (chat_id, quest_id)`,
  `CREATE TABLE IF NOT EXISTS "trading_challenges" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, name TEXT NOT NULL, description TEXT, start_date TIMESTAMP NOT NULL, end_date TIMESTAMP NOT NULL, prize_pool_b4 TEXT DEFAULT '0' NOT NULL, status TEXT DEFAULT 'upcoming' NOT NULL, max_entries INTEGER DEFAULT 100, min_balance_bnb TEXT DEFAULT '0.01', prize_distribution TEXT, created_by TEXT, created_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "challenge_entries" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, challenge_id VARCHAR NOT NULL, agent_id VARCHAR NOT NULL, owner_chat_id TEXT NOT NULL, wallet_address TEXT NOT NULL, starting_balance_bnb TEXT DEFAULT '0' NOT NULL, current_balance_bnb TEXT DEFAULT '0' NOT NULL, pnl_percent TEXT DEFAULT '0' NOT NULL, pnl_bnb TEXT DEFAULT '0' NOT NULL, trade_count INTEGER DEFAULT 0 NOT NULL, rank INTEGER, reward_amount TEXT, reward_paid BOOLEAN DEFAULT false, joined_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "agent_pnl_snapshots" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, agent_id VARCHAR NOT NULL, challenge_id VARCHAR, wallet_address TEXT NOT NULL, balance_bnb TEXT NOT NULL, token_value_bnb TEXT DEFAULT '0', total_value_bnb TEXT NOT NULL, pnl_percent TEXT DEFAULT '0' NOT NULL, snapshot_at TIMESTAMP DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "copy_trades" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, follower_chat_id TEXT NOT NULL, follower_wallet TEXT NOT NULL, agent_id VARCHAR NOT NULL, agent_name TEXT, max_amount_bnb TEXT DEFAULT '0.1' NOT NULL, total_copied INTEGER DEFAULT 0 NOT NULL, total_pnl_bnb TEXT DEFAULT '0' NOT NULL, active BOOLEAN DEFAULT true NOT NULL, created_at TIMESTAMP DEFAULT now())`,
];

async function ensureSchema() {
  if (!process.env.DATABASE_URL) return;
  console.log("[BOT-SERVER] Ensuring database schema exists...");
  const isSSL = process.env.DATABASE_URL.includes("render.com") ||
    process.env.DATABASE_URL.includes("neon.tech") ||
    process.env.RENDER === "true";
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isSSL ? { rejectUnauthorized: false } : false,
  });
  try {
    for (const stmt of CRITICAL_TABLES_SQL) {
      try {
        await pool.query(stmt);
      } catch (e: any) {
        console.warn("[BOT-SERVER] Table create warning:", e.message?.substring(0, 100));
      }
    }
    console.log("[BOT-SERVER] Critical tables ensured");

    try {
      await pool.query(`ALTER TABLE "trading_challenges" ADD COLUMN IF NOT EXISTS "prize_distribution" TEXT`);
    } catch (e: any) {
      console.warn("[BOT-SERVER] prize_distribution column:", e.message?.substring(0, 80));
    }

    const sql = findSchemaSQL();
    if (sql) {
      const statements = sql.split(/;\s*\n/).filter((s: string) => s.trim().length > 5);
      let ok = 0, skip = 0;
      for (const stmt of statements) {
        try {
          await pool.query(stmt);
          ok++;
        } catch {
          skip++;
        }
      }
      console.log(`[BOT-SERVER] Schema init: ${ok} succeeded, ${skip} skipped`);
    } else {
      console.warn("[BOT-SERVER] schema-init.sql not found — using embedded critical tables only");
    }
  } catch (e: any) {
    console.error("[BOT-SERVER] Schema setup error:", e.message?.substring(0, 200));
  } finally {
    await pool.end();
  }
}

const app = express();
const httpServer = createServer(app);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: Date.now() });
});

registerMiniAppRoutes(app);

try {
  registerWeb4Routes(app);
  console.log("[BOT-SERVER] Web4 routes registered");
} catch (e: any) {
  console.warn("[BOT-SERVER] Web4 routes failed to register:", e.message?.substring(0, 100));
}

/* Dead old inline HTML removed — miniapp HTML now served from miniapp-routes.ts via getMiniAppHTML() */
if (false) { const html = `<!DOCTYPE html><html><head><title>OLD</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0f0d;--card:#111916;--border:#1a2620;--text:#d1d5db;--text-dim:#6b7280;--green:#22c55e;--green-dim:#22c55e33;--red:#ef4444;--red-dim:#ef444433;--blue:#3b82f6}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased}
.header{position:sticky;top:0;z-index:50;background:var(--bg);border-bottom:1px solid var(--border);padding:12px 16px;display:flex;align-items:center;gap:12px}
.header-icon{width:32px;height:32px;border-radius:8px;background:var(--green-dim);display:flex;align-items:center;justify-content:center;font-size:18px}
.header-text{font-size:14px;font-weight:700;color:#fff}
.header-sub{font-size:10px;color:var(--text-dim)}
.tabs{position:fixed;bottom:0;left:0;right:0;z-index:50;background:var(--bg);border-top:1px solid var(--border);display:grid;grid-template-columns:repeat(4,1fr);height:56px}
.tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:10px;color:var(--text-dim);cursor:pointer;border:none;background:none;transition:color .2s}
.tab.active{color:var(--green)}
.tab svg{width:20px;height:20px}
.content{padding:16px;padding-bottom:80px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px}
.card-green{border-color:#22c55e33;background:linear-gradient(135deg,#22c55e0d,transparent)}
.label{font-size:11px;color:var(--text-dim);margin-bottom:4px}
.value{font-size:28px;font-weight:700;color:#fff;font-family:'SF Mono',monospace}
.value-sm{font-size:14px;font-weight:600;color:#fff;font-family:'SF Mono',monospace}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.pnl-pos{color:var(--green);font-family:'SF Mono',monospace;font-weight:600}
.pnl-neg{color:var(--red);font-family:'SF Mono',monospace;font-weight:600}
.badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600}
.badge-long{background:var(--green-dim);color:var(--green)}
.badge-short{background:var(--red-dim);color:var(--red)}
.btn{width:100%;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn:disabled{opacity:.5}
.btn-green{background:var(--green);color:#000}
.btn-red{background:var(--red);color:#fff}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-sm{padding:8px 12px;font-size:12px}
.input{width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:#fff;font-size:14px;font-family:'SF Mono',monospace;outline:none}
.input:focus{border-color:var(--green)}
.row{display:flex;align-items:center;justify-content:space-between}
.flex-gap{display:flex;gap:8px;align-items:center}
.mt-2{margin-top:8px}.mt-3{margin-top:12px}.mt-4{margin-top:16px}.mb-2{margin-bottom:8px}
.text-xs{font-size:11px}.text-sm{font-size:13px}
.text-dim{color:var(--text-dim)}
.text-white{color:#fff}
.mono{font-family:'SF Mono',monospace}
.spin{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.pulse{animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.hidden{display:none}
.vault-addr{font-size:10px;color:var(--green);font-family:'SF Mono',monospace;word-break:break-all;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;cursor:pointer}
.pos-row{padding:10px 0;border-bottom:1px solid var(--border)}
.pos-row:last-child{border:none}
.switch{position:relative;width:48px;height:26px;background:var(--border);border-radius:13px;cursor:pointer;transition:background .2s}
.switch.on{background:var(--green)}
.switch::after{content:'';position:absolute;width:22px;height:22px;background:#fff;border-radius:50%;top:2px;left:2px;transition:transform .2s}
.switch.on::after{transform:translateX(22px)}
.slider-wrap{position:relative;height:4px;background:var(--border);border-radius:2px;margin:12px 0}
.slider-fill{height:100%;background:var(--green);border-radius:2px;transition:width .1s}
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.status-on{background:var(--green)}
.status-off{background:var(--text-dim)}
.alert{padding:12px;border-radius:8px;font-size:12px}
.alert-info{background:#3b82f61a;border:1px solid #3b82f633;color:#93c5fd}
.alert-ok{background:var(--green-dim);border:1px solid #22c55e33;color:#86efac}
.alert-err{background:var(--red-dim);border:1px solid #ef444433;color:#fca5a5}
</style>
</head>
<body>
<div class="header">
  <div class="header-icon">⚡</div>
  <div><div class="header-text">Aster Agent AI</div><div class="header-sub">Autonomous Trading</div></div>
</div>

<div id="dashboard" class="content"></div>
<div id="deposit" class="content hidden"></div>
<div id="agent" class="content hidden"></div>
<div id="trade" class="content hidden"></div>

<div class="tabs">
  <button class="tab active" onclick="switchTab('dashboard')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>Dashboard</button>
  <button class="tab" onclick="switchTab('deposit')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/></svg>Deposit</button>
  <button class="tab" onclick="switchTab('agent')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><path d="m8 15 1.5 1.5"/><path d="M14.5 16.5 16 15"/></svg>Agent</button>
  <button class="tab" onclick="switchTab('trade')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>Trade</button>
</div>

<script>
const TG=window.Telegram?.WebApp;
if(TG){TG.ready();TG.expand();try{TG.setHeaderColor('#0a0f0d');TG.setBackgroundColor('#0a0f0d')}catch(e){}}
const chatId=new URLSearchParams(location.search).get('chatId')||TG?.initDataUnsafe?.user?.id||'';
const VAULT='0xaac5f84303ee5cdbd19c265cee295cd5a36a26ee';
let acct=null,mkts=null,agentData=null;

function fmt(n){return(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
function pnl(v){const p=v>=0;return '<span class="'+(p?'pnl-pos':'pnl-neg')+'">'+(p?'+':'')+'\$'+fmt(v)+'</span>'}
function api(path,opts={}){return fetch(path,{...opts,headers:{'x-telegram-chat-id':chatId,...(opts.headers||{})}}).then(r=>r.json())}

function switchTab(id){
  document.querySelectorAll('.content').forEach(e=>e.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));
  document.getElementById(id).classList.remove('hidden');
  document.querySelectorAll('.tab')[['dashboard','deposit','agent','trade'].indexOf(id)].classList.add('active');
  if(id==='dashboard')loadDashboard();
  if(id==='deposit')loadDeposit();
  if(id==='agent')loadAgent();
  if(id==='trade')loadTrade();
}

async function loadDashboard(){
  const el=document.getElementById('dashboard');
  el.innerHTML='<div class="card" style="text-align:center;padding:40px"><div class="spin" style="font-size:24px">⏳</div><div class="mt-2 text-dim text-sm">Loading...</div></div>';
  try{
    [acct,mkts]=await Promise.all([api('/api/miniapp/account'),api('/api/miniapp/markets')]);
    if(!acct.connected){el.innerHTML='<div class="card" style="text-align:center;padding:40px"><div style="font-size:40px;margin-bottom:12px">⚠️</div><div class="text-white" style="font-weight:600">Not Connected</div><div class="text-dim text-sm mt-2">Connect Aster in the bot first.</div></div>';return}
    let h='<div class="card card-green"><div class="label">Available Futures Margin</div><div class="value">\$'+fmt(acct.availableMargin)+'</div><div class="row mt-3"><div class="flex-gap text-xs"><span class="text-dim">BSC:</span><span class="mono text-white">\$'+fmt(acct.bscBalance)+'</span></div><div class="flex-gap text-xs"><span class="text-dim">Wallet:</span><span class="mono text-white">\$'+fmt(acct.walletBalance)+'</span></div></div></div>';
    h+='<div class="grid2"><div class="card"><div class="label">Unrealized PnL</div><div class="value-sm">'+pnl(acct.unrealizedPnl)+'</div></div><div class="card"><div class="label">Realized PnL</div><div class="value-sm">'+pnl(acct.realizedPnl)+'</div>'+(acct.wins+acct.losses>0?'<div class="text-xs text-dim mt-2">'+acct.wins+'W / '+acct.losses+'L ('+Math.round(acct.wins/(acct.wins+acct.losses)*100)+'%)</div>':'')+'</div></div>';
    if(acct.positions.length>0){h+='<div class="card"><div class="row mb-2"><span class="text-white text-sm" style="font-weight:600">Open Positions ('+acct.positions.length+')</span></div>';acct.positions.forEach(p=>{h+='<div class="pos-row"><div class="row"><div><span class="badge '+(p.side==='LONG'?'badge-long':'badge-short')+'">'+p.side+'</span> <span class="text-white" style="font-weight:600;font-size:13px">'+p.symbol+'</span> <span class="text-xs text-dim">'+p.leverage+'x</span></div>'+pnl(p.unrealizedPnl)+'</div><div class="text-xs text-dim mt-2">'+p.size+' @ \$'+fmt(p.entryPrice)+' → \$'+fmt(p.markPrice)+'</div></div>'});h+='</div>'}
    if(mkts?.markets?.length>0){h+='<div class="card"><div class="text-sm text-white mb-2" style="font-weight:600">Markets</div><div class="grid2">';mkts.markets.forEach(m=>{h+='<div class="row" style="padding:6px 8px;background:var(--bg);border-radius:6px"><span class="text-xs text-dim">'+m.symbol.replace('USDT','')+'</span><span class="text-xs mono text-white">\$'+fmt(m.price)+'</span></div>'});h+='</div></div>'}
    h+='<button class="btn btn-outline" onclick="loadDashboard()">🔄 Refresh</button>';
    el.innerHTML=h;
  }catch(e){el.innerHTML='<div class="alert alert-err">'+e.message+'</div>'}
}

async function loadDeposit(){
  const el=document.getElementById('deposit');
  if(!acct)try{acct=await api('/api/miniapp/account')}catch(e){}
  let h='<h2 class="text-white mb-2" style="font-size:18px;font-weight:700">Deposit USDT</h2>';
  h+='<div class="card"><div class="label">Balances</div><div class="grid3 mt-2"><div style="text-align:center;padding:6px;background:var(--bg);border-radius:6px"><div class="text-xs text-dim">BSC</div><div class="value-sm">\$'+fmt(acct?.bscBalance||0)+'</div></div><div style="text-align:center;padding:6px;background:var(--bg);border-radius:6px"><div class="text-xs text-dim">Spot</div><div class="value-sm">\$'+fmt(acct?.walletBalance||0)+'</div></div><div style="text-align:center;padding:6px;background:var(--green-dim);border-radius:6px"><div class="text-xs" style="color:#86efac">Futures</div><div class="value-sm">\$'+fmt(acct?.availableMargin||0)+'</div></div></div></div>';
  h+='<div class="card card-green"><div class="text-sm text-white mb-2" style="font-weight:600">Quick Deposit (Auto)</div><div class="text-xs text-dim mb-3">Bot signs the BSC transaction and auto-transfers to Futures.</div><div class="grid4" id="dep-presets">';
  [10,25,50,100].forEach(v=>{h+='<button class="btn btn-outline btn-sm" onclick="doDeposit('+v+')">\$'+v+'</button>'});
  h+='</div><div class="flex-gap mt-3"><input id="dep-custom" class="input" type="number" placeholder="Custom"><button class="btn btn-green btn-sm" style="width:auto;padding:8px 20px" onclick="doDeposit(parseFloat(document.getElementById(\\'dep-custom\\').value))">Deposit</button></div><div id="dep-status"></div></div>';
  h+='<div class="card"><div class="text-sm text-white mb-2" style="font-weight:600">Manual Deposit</div><div class="text-xs text-dim mb-2">Send USDT (BEP-20) on BSC to:</div><div class="vault-addr" onclick="navigator.clipboard.writeText(\\''+VAULT+'\\');this.style.borderColor=\\'var(--green)\\';setTimeout(()=>this.style.borderColor=\\'\\',1500)">'+VAULT+'<span class="text-xs text-dim" style="display:block;margin-top:4px">Tap to copy</span></div><div class="flex-gap mt-2 text-xs" style="color:#eab308">⚠️ Only USDT on BSC. Wrong network = lost funds.</div></div>';
  el.innerHTML=h;
}

async function doDeposit(amount){
  if(!amount||amount<1)return;
  const st=document.getElementById('dep-status');
  st.innerHTML='<div class="alert alert-info mt-3"><span class="spin" style="display:inline-block">⏳</span> Signing BSC transaction...</div>';
  try{
    const r=await api('/api/miniapp/deposit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3">✅ Deposit successful!'+(r.txHash?'<br><a href="https://bscscan.com/tx/'+r.txHash+'" target="_blank" style="color:#86efac;text-decoration:underline;font-size:11px">View on BscScan ↗</a>':'')+(r.spotToFuturesTransferred?'<br><span class="text-xs">Auto-transferred to Futures ✅</span>':'')+'</div>';
      setTimeout(()=>api('/api/miniapp/account').then(d=>{acct=d}),3000);
    }else{st.innerHTML='<div class="alert alert-err mt-3">❌ '+(r.error||'Failed')+'</div>'}
  }catch(e){st.innerHTML='<div class="alert alert-err mt-3">❌ '+e.message+'</div>'}
}

async function loadAgent(){
  const el=document.getElementById('agent');
  el.innerHTML='<div class="card" style="text-align:center;padding:30px"><div class="spin" style="font-size:24px">⏳</div></div>';
  try{
    agentData=await api('/api/miniapp/agent');
    const r=agentData.running,s=agentData.stats,c=agentData.config;
    let h='<h2 class="text-white mb-2" style="font-size:18px;font-weight:700">AI Trading Agent</h2>';
    h+='<div class="card'+(r?' card-green':'')+'"><div class="row"><div class="flex-gap"><div style="width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:22px;background:'+(r?'var(--green-dim)':'var(--border)')+'">🤖</div><div><div class="text-white" style="font-weight:600">Autonomous Agent</div><div class="flex-gap"><span class="status-dot '+(r?'status-on pulse':'status-off')+'"></span><span class="text-xs '+(r?'pnl-pos':'text-dim')+'">'+(r?'Running':'Stopped')+'</span></div></div></div><div class="switch'+(r?' on':'')+'" onclick="toggleAgent()"></div></div>';
    if(r&&c){h+='<div class="flex-gap mt-3"><span class="badge badge-long">'+c.symbol+'</span><span class="badge" style="background:var(--border);color:var(--text)">'+c.maxLeverage+'x max</span><span class="badge" style="background:var(--border);color:var(--text)">'+c.riskPercent+'% risk</span></div>'}
    h+='</div>';
    h+='<div class="card"><div class="text-sm text-white mb-2" style="font-weight:600">⚙️ Risk Settings</div><div class="row text-sm"><span class="text-dim">Risk per Trade</span><span class="mono text-white">'+(c?.riskPercent||1)+'%</span></div><div class="slider-wrap"><div class="slider-fill" style="width:'+((c?.riskPercent||1)/3*100)+'%"></div></div><div class="row text-xs text-dim"><span>0.5%</span><span>3%</span></div><div class="row text-sm mt-3"><span class="text-dim">Max Leverage</span><span class="mono text-white">'+(c?.maxLeverage||10)+'x</span></div><div class="row text-sm mt-3"><span class="text-dim">Trading Pair</span><span class="text-white">'+(c?.symbol||'BTCUSDT')+'</span></div></div>';
    if(s){const wr=s.winCount+s.lossCount>0?Math.round(s.winCount/(s.winCount+s.lossCount)*100):0;h+='<div class="card"><div class="text-sm text-white mb-2" style="font-weight:600">📊 Performance</div><div class="grid2"><div style="padding:10px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim">Trades</div><div class="value-sm">'+s.tradeCount+'</div></div><div style="padding:10px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim">Win Rate</div><div class="value-sm">'+wr+'%</div></div><div style="padding:10px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim">Total PnL</div><div class="value-sm">'+pnl(s.totalPnl)+'</div></div><div style="padding:10px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim">W / L</div><div class="value-sm"><span class="pnl-pos">'+s.winCount+'</span> / <span class="pnl-neg">'+s.lossCount+'</span></div></div></div>';if(s.lastAction){h+='<div class="alert alert-info mt-3"><div class="text-xs" style="color:#93c5fd;margin-bottom:2px">Last Action</div><div class="text-sm text-white">'+s.lastAction+'</div>'+(s.lastReason?'<div class="text-xs text-dim mt-2">'+s.lastReason+'</div>':'')+'</div>'}h+='</div>'}
    el.innerHTML=h;
  }catch(e){el.innerHTML='<div class="alert alert-err">'+e.message+'</div>'}
}

async function toggleAgent(){
  try{await api('/api/miniapp/agent/toggle',{method:'POST',headers:{'Content-Type':'application/json'}});loadAgent()}catch(e){alert(e.message)}
}

async function loadTrade(){
  const el=document.getElementById('trade');
  if(!mkts)try{mkts=await api('/api/miniapp/markets')}catch(e){}
  if(!acct)try{acct=await api('/api/miniapp/account')}catch(e){}
  const pairs=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT'];
  let sel=pairs[0],lev=10;
  const getPrice=()=>(mkts?.markets?.find(m=>m.symbol===sel)?.price)||0;
  function render(){
    const price=getPrice();
    let h='<h2 class="text-white mb-2" style="font-size:18px;font-weight:700">Quick Trade</h2>';
    h+='<div class="card"><div class="label">Trading Pair</div><div class="grid4 mt-2" style="grid-template-columns:repeat(5,1fr)">';
    pairs.forEach(p=>{h+='<button class="btn btn-sm '+(sel===p?'btn-green':'btn-outline')+'" style="font-size:11px;padding:6px 2px" onclick="window._selPair(\\''+p+'\\')">'+p.replace('USDT','')+'</button>'});
    h+='</div>';
    if(price>0)h+='<div style="text-align:center;padding:16px 0"><div class="text-xs text-dim">'+sel+'</div><div class="value">\$'+fmt(price)+'</div></div>';
    h+='<hr style="border-color:var(--border);margin:12px 0"><div class="row text-sm"><span class="text-dim">Leverage</span><span class="mono text-white" style="font-weight:700">'+lev+'x</span></div><div class="slider-wrap" style="cursor:pointer" onclick="var r=this.getBoundingClientRect();var x=(event.clientX-r.left)/r.width;window._setLev(Math.max(1,Math.min(50,Math.round(x*50))))"><div class="slider-fill" style="width:'+(lev/50*100)+'%"></div></div><div class="row text-xs text-dim"><span>1x</span><span>50x</span></div>';
    h+='<div class="label mt-3">Amount (USDT margin)</div><input id="trade-amt" class="input" type="number" placeholder="Enter margin amount">'+(acct?'<div class="text-xs text-dim mt-2">Available: \$'+fmt(acct.availableMargin)+'</div>':'');
    if(price>0){h+='<div class="card mt-3" style="padding:10px 12px;background:var(--bg)"><div class="row text-xs"><span class="text-dim">Est. Position Size</span><span class="mono text-white" id="est-size">—</span></div><div class="row text-xs mt-2"><span class="text-dim">Notional Value</span><span class="mono text-white" id="est-notional">—</span></div></div>'}
    h+='<div class="grid2 mt-4"><button class="btn btn-green" style="height:48px;font-size:15px" onclick="executeTrade(\\'BUY\\')">📈 Long</button><button class="btn btn-red" style="height:48px;font-size:15px" onclick="executeTrade(\\'SELL\\')">📉 Short</button></div>';
    h+='<div id="trade-status"></div>';
    if(acct&&acct.positions&&acct.positions.length>0){h+='<div class="card mt-3"><div class="text-sm text-white mb-2" style="font-weight:600">Open Positions</div>';acct.positions.forEach(p=>{h+='<div class="pos-row"><div class="row"><div><span class="badge '+(p.side==='LONG'?'badge-long':'badge-short')+'">'+p.side+'</span> <span class="text-white" style="font-weight:600;font-size:13px">'+p.symbol+'</span></div>'+pnl(p.unrealizedPnl)+'</div><div class="row mt-2"><span class="text-xs text-dim">'+p.size+' @ \$'+fmt(p.entryPrice)+'</span><button class="btn btn-outline btn-sm" style="width:auto;padding:4px 12px;font-size:11px" onclick="closePosition(\\''+p.symbol+'\\')">Close</button></div></div>'});h+='</div>'}
    h+='<div class="text-xs text-dim mt-3" style="text-align:center">Market orders via Aster DEX V3 Pro API</div></div>';
    el.innerHTML=h;
    const amtInput=document.getElementById('trade-amt');
    if(amtInput){amtInput.addEventListener('input',()=>{const a=parseFloat(amtInput.value)||0;const n=a*lev;const q=price>0?(n/price):0;const es=document.getElementById('est-size');const en=document.getElementById('est-notional');if(es)es.textContent=q>0?q.toFixed(4)+' '+sel.replace('USDT',''):'—';if(en)en.textContent=n>0?'\$'+fmt(n):'—'})}
  }
  window._selPair=(p)=>{sel=p;_tradeSel=p;render()};
  window._setLev=(v)=>{lev=v;_tradeLev=v;render()};
  _tradeSel=sel;_tradeLev=lev;
  render();
}

let _tradeSel='BTCUSDT',_tradeLev=10;
async function executeTrade(side){
  const amtEl=document.getElementById('trade-amt');
  const amount=parseFloat(amtEl?.value||'0');
  if(!amount||amount<=0){alert('Enter a margin amount');return}
  const symbol=_tradeSel;
  const lev=_tradeLev;
  const st=document.getElementById('trade-status');
  const price=(mkts?.markets?.find(m=>m.symbol===symbol)?.price)||0;
  const dir=side==='BUY'?'LONG':'SHORT';
  if(!confirm('Open '+dir+' '+symbol+' with \$'+amount+' margin at '+lev+'x leverage?'))return;
  st.innerHTML='<div class="alert alert-info mt-3"><span class="spin" style="display:inline-block">⏳</span> Placing '+dir+' order...</div>';
  try{
    const r=await api('/api/miniapp/trade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol,side,amount,leverage:lev})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3">✅ '+dir+' '+r.symbol+' filled!<br><span class="text-xs">Qty: '+r.quantity+' @ \$'+fmt(r.price)+'</span><br><span class="text-xs text-dim">Order ID: '+r.orderId+'</span></div>';
      setTimeout(()=>{api('/api/miniapp/account').then(d=>{acct=d});api('/api/miniapp/markets').then(d=>{mkts=d})},2000);
    }else{st.innerHTML='<div class="alert alert-err mt-3">❌ '+(r.error||'Order failed')+'</div>'}
  }catch(e){st.innerHTML='<div class="alert alert-err mt-3">❌ '+e.message+'</div>'}
}

async function closePosition(symbol){
  if(!confirm('Close entire '+symbol+' position?'))return;
  const st=document.getElementById('trade-status');
  st.innerHTML='<div class="alert alert-info mt-3"><span class="spin" style="display:inline-block">⏳</span> Closing '+symbol+'...</div>';
  try{
    const r=await api('/api/miniapp/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3">✅ '+symbol+' position closed<br><span class="text-xs">'+r.side+' '+r.quantity+' | Order ID: '+r.orderId+'</span></div>';
      setTimeout(()=>{api('/api/miniapp/account').then(d=>{acct=d;loadTrade()})},2000);
    }else{st.innerHTML='<div class="alert alert-err mt-3">❌ '+(r.error||'Close failed')+'</div>'}
  }catch(e){st.innerHTML='<div class="alert alert-err mt-3">❌ '+e.message+'</div>'}
}

x`; }

app.post("/api/telegram/webhook/:token", (req, res) => {
  const token = req.params.token;
  if (token !== process.env.TELEGRAM_BOT_TOKEN) {
    res.sendStatus(403);
    return;
  }
  res.sendStatus(200);
  processWebhookUpdate(req.body);
});

const frontendDistPath = join(__dirname, "public");
try {
  const fs = require("fs");
  if (fs.existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath));
    app.use("/{*path}", (req: any, res: any, next: any) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/webhook")) {
        return next();
      }
      res.sendFile(join(frontendDistPath, "index.html"));
    });
    console.log(`[BOT-SERVER] Serving frontend from ${frontendDistPath}`);
  } else {
    app.get("/", (_req, res) => {
      res.status(200).send("BUILD4 Bot Server OK");
    });
    console.log("[BOT-SERVER] No frontend build found, serving API only");
  }
} catch {
  app.get("/", (_req, res) => {
    res.status(200).send("BUILD4 Bot Server OK");
  });
}

(async () => {
  await ensureSchema();

  const port = parseInt(process.env.PORT || "3000", 10);
  httpServer.listen({ port, host: "0.0.0.0" }, () => {
    console.log(`[BOT-SERVER] Listening on port ${port}`);

    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
    if (!webhookUrl) {
      console.error("[BOT-SERVER] No TELEGRAM_WEBHOOK_URL or RENDER_EXTERNAL_URL set — bot may not receive updates");
    }

    setTimeout(() => {
      startTelegramBot(webhookUrl).then(() => {
        console.log("[BOT-SERVER] Telegram bot started");
      }).catch((err) => {
        console.error("[BOT-SERVER] Telegram bot failed to start:", err.message);
      });
    }, 1000);

    setTimeout(async () => {
      try {
        const { getBotInstance } = await import("./telegram-bot");
        const notifyFn = (cid: number, msg: string) => {
          getBotInstance()?.sendMessage(cid, msg, { parse_mode: "Markdown" }).catch(() => {});
        };

        if (!isTradingAgentRunning()) {
          startTradingAgent(notifyFn);
          console.log("[BOT-SERVER] Trading agent started");
        }

        try {
          const { startPnlTracker, getActiveChallenges, createChallenge } = await import("./trading-challenge");
          startPnlTracker(5 * 60 * 1000);
          console.log("[BOT-SERVER] PnL tracker started (5 min interval)");

          const existing = await getActiveChallenges();
          const hasTraderChallenge = existing.some(c => c.name === "Trading Bot Challenge #1");
          if (!hasTraderChallenge) {
            const now = new Date();
            const endDate = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
            await createChallenge({
              name: "Trading Bot Challenge #1",
              description: "Create a trading bot. If your bot trades and makes profit, you're in! Top 3 win $B4 prizes.",
              startDate: now,
              endDate,
              prizePoolB4: "950000",
              maxEntries: 100,
              prizeDistribution: ["500000", "300000", "150000"],
            });
            console.log("[BOT-SERVER] Created 'Trading Bot Challenge #1' — 4 days, 950K $B4 pool");
          }
        } catch (pnlErr: any) {
          console.error("[BOT-SERVER] PnL tracker/challenge start failed:", pnlErr.message);
        }

        let restored = 0;
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            restored = await restoreTradingPreferences();
            console.log(`[BOT-SERVER] Restored ${restored} trading preferences (attempt ${attempt})`);
            break;
          } catch (e: any) {
            console.error(`[BOT-SERVER] Preference restore attempt ${attempt}/5 failed: ${e.message?.substring(0, 80)}`);
            if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 3000));
          }
        }
      } catch (err: any) {
        console.error("[BOT-SERVER] Trading agent start failed:", err.message);
      }
    }, 5000);
  });
})();

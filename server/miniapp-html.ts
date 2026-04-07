export function getMiniAppHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Aster Agent AI</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0b0e11;--bg2:#12161c;--card:#161b22;--card2:#1c2128;
  --border:#21262d;--border2:#30363d;
  --text:#c9d1d9;--text2:#8b949e;--text3:#484f58;
  --green:#3fb950;--green2:#238636;--green-bg:rgba(63,185,80,.1);
  --red:#f85149;--red-bg:rgba(248,81,73,.1);
  --blue:#58a6ff;--blue-bg:rgba(88,166,255,.1);
  --yellow:#d29922;--yellow-bg:rgba(210,153,34,.1);
  --purple:#bc8cff;
}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased;overflow-x:hidden}
.header{position:sticky;top:0;z-index:50;background:rgba(11,14,17,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:10px 16px;display:flex;align-items:center;gap:10px}
.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--green2),var(--green));display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 0 20px rgba(63,185,80,.3)}
.hdr-title{font-size:15px;font-weight:700;color:#fff;letter-spacing:-.3px}
.hdr-sub{font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(63,185,80,.4)}50%{opacity:.7;box-shadow:0 0 0 6px rgba(63,185,80,0)}}
.tabs{position:fixed;bottom:0;left:0;right:0;z-index:50;background:rgba(11,14,17,.95);backdrop-filter:blur(12px);border-top:1px solid var(--border);display:grid;grid-template-columns:repeat(4,1fr);height:60px;padding-bottom:env(safe-area-inset-bottom)}
.tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:10px;font-weight:500;color:var(--text3);cursor:pointer;border:none;background:none;transition:all .2s;position:relative}
.tab.active{color:var(--green)}
.tab.active::before{content:'';position:absolute;top:-1px;left:25%;right:25%;height:2px;background:var(--green);border-radius:0 0 2px 2px}
.tab svg{width:20px;height:20px}
.page{padding:12px 16px 80px;display:none;animation:fadeIn .2s ease}
.page.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:10px;transition:border-color .2s}
.card-accent{border-color:var(--green2);background:linear-gradient(135deg,rgba(35,134,54,.08),transparent)}
.section-title{font-size:13px;font-weight:600;color:#fff;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.label{font-size:11px;color:var(--text2);margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px;font-weight:500}
.val{font-size:24px;font-weight:700;color:#fff;font-family:'SF Mono',SFMono-Regular,Consolas,monospace;letter-spacing:-.5px}
.val-sm{font-size:14px;font-weight:600;color:#fff;font-family:'SF Mono',SFMono-Regular,Consolas,monospace}
.val-xs{font-size:12px;font-weight:600;font-family:'SF Mono',SFMono-Regular,Consolas,monospace}
.g+{color:var(--green)}.r-{color:var(--red)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.row{display:flex;align-items:center;justify-content:space-between}
.gap{display:flex;align-items:center;gap:6px}
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:600;letter-spacing:.3px}
.badge-long{background:var(--green-bg);color:var(--green)}
.badge-short{background:var(--red-bg);color:var(--red)}
.badge-info{background:var(--blue-bg);color:var(--blue)}
.badge-warn{background:var(--yellow-bg);color:var(--yellow)}
.btn{width:100%;padding:12px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:6px}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.4;pointer-events:none}
.btn-green{background:var(--green2);color:#fff}
.btn-green:hover{background:var(--green)}
.btn-red{background:#da3633;color:#fff}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-sm{padding:8px 14px;font-size:12px;width:auto;border-radius:8px}
.input{width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:#fff;font-size:14px;font-family:'SF Mono',monospace;outline:none;transition:border-color .2s}
.input:focus{border-color:var(--green)}
.input::placeholder{color:var(--text3)}
.toast{position:fixed;top:70px;left:16px;right:16px;z-index:999;padding:12px 16px;border-radius:10px;font-size:13px;font-weight:500;animation:slideDown .3s ease;display:none}
.toast.show{display:flex;align-items:center;gap:8px}
@keyframes slideDown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
.toast-ok{background:var(--green-bg);border:1px solid var(--green2);color:var(--green)}
.toast-err{background:var(--red-bg);border:1px solid #da3633;color:var(--red)}
.toast-info{background:var(--blue-bg);border:1px solid #1f6feb;color:var(--blue)}
.skeleton{background:linear-gradient(90deg,var(--card2) 25%,var(--border) 50%,var(--card2) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:6px;height:20px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.switch{position:relative;width:52px;height:28px;background:var(--border);border-radius:14px;cursor:pointer;transition:background .3s;flex-shrink:0}
.switch.on{background:var(--green2)}
.switch::after{content:'';position:absolute;width:24px;height:24px;background:#fff;border-radius:50%;top:2px;left:2px;transition:transform .3s cubic-bezier(.4,0,.2,1);box-shadow:0 1px 3px rgba(0,0,0,.3)}
.switch.on::after{transform:translateX(24px)}
.pos-item{padding:10px 0;border-bottom:1px solid var(--border)}
.pos-item:last-child{border:none}
.vault-box{font-size:11px;color:var(--green);font-family:'SF Mono',monospace;word-break:break-all;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:all .2s;text-align:center;line-height:1.6}
.vault-box:active{border-color:var(--green);background:var(--green-bg)}
.copied{border-color:var(--green)!important;background:var(--green-bg)!important}
.slider-track{position:relative;height:6px;background:var(--border);border-radius:3px;margin:14px 0;cursor:pointer}
.slider-fill{height:100%;background:linear-gradient(90deg,var(--green2),var(--green));border-radius:3px;transition:width .1s}
.slider-thumb{position:absolute;top:50%;width:18px;height:18px;background:#fff;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 1px 4px rgba(0,0,0,.3);transition:left .1s}
.timestamp{font-size:10px;color:var(--text3);text-align:right;margin-top:6px}
.alert{padding:12px;border-radius:10px;font-size:12px;line-height:1.5;display:flex;gap:8px;align-items:flex-start}
.alert-info{background:var(--blue-bg);border:1px solid rgba(88,166,255,.2);color:var(--blue)}
.alert-warn{background:var(--yellow-bg);border:1px solid rgba(210,153,34,.2);color:var(--yellow)}
.alert-ok{background:var(--green-bg);border:1px solid rgba(63,185,80,.2);color:var(--green)}
.alert-err{background:var(--red-bg);border:1px solid rgba(248,81,73,.2);color:var(--red)}
.mt-1{margin-top:4px}.mt-2{margin-top:8px}.mt-3{margin-top:12px}.mt-4{margin-top:16px}.mb-2{margin-bottom:8px}.mb-3{margin-bottom:12px}
.text-xs{font-size:11px}.text-sm{font-size:13px}.text-dim{color:var(--text2)}.text-dim2{color:var(--text3)}.text-w{color:#fff}.fw-600{font-weight:600}
.mono{font-family:'SF Mono',SFMono-Regular,Consolas,monospace}
.hidden{display:none!important}
</style>
</head>
<body>

<div id="toast" class="toast"></div>

<div class="header">
  <div class="logo">⚡</div>
  <div>
    <div class="hdr-title">Aster Agent AI</div>
    <div class="hdr-sub"><span class="live-dot"></span> Autonomous Trading</div>
  </div>
  <div style="margin-left:auto;text-align:right">
    <div class="text-xs text-dim" id="hdr-updated"></div>
  </div>
</div>

<div id="p-dash" class="page active"></div>
<div id="p-trade" class="page"></div>
<div id="p-positions" class="page"></div>
<div id="p-orders" class="page"></div>
<div id="p-markets" class="page"></div>
<div id="p-history" class="page"></div>
<div id="p-deposit" class="page"></div>
<div id="p-agent" class="page"></div>

<div class="tabs" style="overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none">
  <button class="tab active" data-tab="p-dash"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>Home</button>
  <button class="tab" data-tab="p-trade"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg>Trade</button>
  <button class="tab" data-tab="p-positions"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>Positions</button>
  <button class="tab" data-tab="p-orders"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/></svg>Orders</button>
  <button class="tab" data-tab="p-markets"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>Markets</button>
  <button class="tab" data-tab="p-history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>History</button>
  <button class="tab" data-tab="p-deposit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8m-4-4h8"/></svg>Deposit</button>
  <button class="tab" data-tab="p-agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>Agent</button>
</div>

<script>
const TG=window.Telegram?.WebApp;
if(TG){TG.ready();TG.expand();try{TG.setHeaderColor('#0b0e11');TG.setBackgroundColor('#0b0e11')}catch(e){}}
const chatId=new URLSearchParams(location.search).get('chatId')||TG?.initDataUnsafe?.user?.id||'';
let D={connected:false,availableMargin:0,walletBalance:0,bscBalance:0,bnbBalance:0,bscWalletAddress:'',unrealizedPnl:0,realizedPnl:0,wins:0,losses:0,positions:[],recentIncome:[],spotBalance:0,openOrders:[]};
let M={markets:[]};
let AG=null;
let tradeHistory=[];
let lastUpdate=0;
let refreshTimer=null;

function $(id){return document.getElementById(id)}
function fmt(n,d=2){return(n||0).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})}
function pnlHtml(v){const p=v>=0;return '<span class="val-xs '+(p?'g+':'r-')+'">'+(p?'+':'-')+'$'+fmt(Math.abs(v))+'</span>'}
function pnlClass(v){return v>=0?'g+':'r-'}
function api(path,opts={}){return fetch(path,{...opts,headers:{'x-telegram-chat-id':String(chatId),...(opts.headers||{})}}).then(r=>r.json())}
function toast(msg,type='info'){const t=$('toast');t.className='toast show toast-'+type;t.innerHTML=msg;setTimeout(()=>t.classList.remove('show'),3500)}
function customConfirm(html){return new Promise(function(resolve){var ov=document.createElement('div');ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';var box=document.createElement('div');box.style.cssText='background:#1a1d21;border:1px solid #333;border-radius:12px;padding:20px;max-width:340px;width:100%;color:#e0e0e0;font-size:14px;line-height:1.6';box.innerHTML=html+'<div style="display:flex;gap:10px;margin-top:16px"><button id="cc-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid #555;background:transparent;color:#e0e0e0;cursor:pointer;font-size:14px">Cancel</button><button id="cc-ok" style="flex:1;padding:10px;border-radius:8px;border:none;background:#0ecb81;color:#0b0e11;cursor:pointer;font-weight:600;font-size:14px">Confirm</button></div>';ov.appendChild(box);document.body.appendChild(ov);$('cc-ok').onclick=function(){document.body.removeChild(ov);resolve(true)};$('cc-cancel').onclick=function(){document.body.removeChild(ov);resolve(false)};ov.onclick=function(e){if(e.target===ov){document.body.removeChild(ov);resolve(false)}}})}
function copyAddr(el){var a=el.dataset.addr;if(a)navigator.clipboard.writeText(a).then(function(){toast('Copied!','ok')}).catch(function(){toast('Copy failed','err')})}
function timeAgo(){if(!lastUpdate)return'';const s=Math.floor((Date.now()-lastUpdate)/1000);if(s<5)return'Just now';if(s<60)return s+'s ago';return Math.floor(s/60)+'m ago'}

function switchTab(tabId){
  var targetId=tabId;
  if(!targetId.startsWith('p-'))targetId='p-'+targetId;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  var targetTab=document.querySelector('.tab[data-tab="'+targetId+'"]');
  if(targetTab)targetTab.classList.add('active');
  var targetPage=$(targetId);
  if(targetPage)targetPage.classList.add('active');
  if(targetId==='p-dash')loadDash();
  if(targetId==='p-trade')loadTrade();
  if(targetId==='p-positions')loadPositions();
  if(targetId==='p-orders')loadOrders();
  if(targetId==='p-markets')loadMarkets();
  if(targetId==='p-history')loadHistory();
  if(targetId==='p-deposit')loadDeposit();
  if(targetId==='p-agent')loadAgent();
}
document.querySelectorAll('.tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    switchTab(tab.dataset.tab);
  });
});

function startAutoRefresh(){
  if(refreshTimer)clearInterval(refreshTimer);
  refreshTimer=setInterval(async()=>{
    try{
      const a=await api('/api/miniapp/account');
      if(a.connected){D=a;lastUpdate=Date.now();try{$('hdr-updated').textContent=timeAgo()}catch(e){}
        const activePage=document.querySelector('.page.active');
        if(activePage?.id==='p-dash')renderDash();
        if(activePage?.id==='p-deposit')renderDeposit();
      }
    }catch(e){}
  },10000);
}

async function fetchAll(){
  try{
    const [a,m]=await Promise.all([
      api('/api/miniapp/account').catch(e=>{console.error('account err',e);return null}),
      api('/api/miniapp/markets').catch(e=>{console.error('markets err',e);return null}),
    ]);
    if(a&&a.connected!==undefined){D={...D,...a}}
    if(m&&m.markets)M=m;
    lastUpdate=Date.now();
    try{$('hdr-updated').textContent='Updated'}catch(e){}
  }catch(e){console.error('fetchAll error',e)}
}

function skeletonCard(lines=3){
  let h='<div class="card">';
  for(let i=0;i<lines;i++)h+='<div class="skeleton mt-2" style="width:'+(60+Math.random()*40)+'%;height:'+(i===0?28:16)+'px"></div>';
  return h+'</div>';
}

async function loadDash(){
  const el=$('p-dash');
  el.innerHTML=skeletonCard(4)+skeletonCard(2);
  try{await fetchAll()}catch(e){console.error('loadDash fetch error',e)}
  renderDash();
  startAutoRefresh();
}

function renderDash(){
  const el=$('p-dash');
  if(!D.connected){
    var h2='<div class="card" style="text-align:center;padding:36px 24px">';
    h2+='<div style="font-size:48px;margin-bottom:16px">🔗</div>';
    h2+='<div class="text-w fw-600" style="font-size:16px">Connect Your Wallet</div>';
    h2+='<div class="text-dim text-sm mt-2">Import your wallet to see your Aster balance and start trading.</div>';
    if(D.bscWalletAddress){
      h2+='<div class="text-xs text-dim mt-3">Wallet found: <span class="mono" style="color:var(--blue)">'+D.bscWalletAddress.substring(0,8)+'...'+D.bscWalletAddress.slice(-4)+'</span></div>';
      h2+='<button class="btn btn-green mt-3" style="width:100%" data-tab="deposit" onclick="switchTab(this.dataset.tab)">🔗 Connect to Aster</button>';
    } else {
      h2+='<button class="btn btn-green mt-3" style="width:100%" onclick="showDashImport()">Import Wallet</button>';
      h2+='<div id="dash-import" style="display:none;margin-top:16px;text-align:left">';
      h2+='<input id="dash-import-pk" type="password" class="input" placeholder="Paste wallet private key (0x...)" autocomplete="off">';
      h2+='<button class="btn btn-green mt-2" style="width:100%" onclick="doDashImport()">Import & Connect</button>';
      h2+='<div id="dash-import-status"></div>';
      h2+='</div>';
    }
    h2+='<button class="btn btn-outline mt-2" onclick="loadDash()">↻ Retry</button>';
    h2+='</div>';
    el.innerHTML=h2;
    return;
  }
  let h='';

  if(!D.asterApiWallet){
    h+='<div class="card" style="border:1px solid var(--yellow);background:rgba(243,186,47,0.05)">';
    h+='<div style="display:flex;align-items:center;gap:8px"><span style="font-size:20px">⚠️</span><div>';
    h+='<div class="text-sm fw-600" style="color:var(--yellow)">Not Connected to Aster</div>';
    h+='<div class="text-xs text-dim mt-1">Connect to see your futures balance and start trading.</div>';
    h+='</div></div>';
    h+='<button class="btn btn-green mt-2" style="width:100%" data-tab="deposit" onclick="switchTab(this.dataset.tab)">🔗 Connect Now</button>';
    h+='</div>';
  }

  var totalBal=(D.walletBalance||0)+(D.bscBalance||0)+(D.spotBalance||0);
  var totalPnl=(D.unrealizedPnl||0)+(D.realizedPnl||0);

  h+='<div class="card card-accent" style="position:relative;overflow:hidden">';
  h+='<div style="position:absolute;top:-20px;right:-20px;width:120px;height:120px;background:radial-gradient(circle,rgba(14,203,129,0.15),transparent);border-radius:50%"></div>';
  h+='<div class="label" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--text2)">Your Account Balance</div>';
  h+='<div class="val" style="font-size:32px;margin:4px 0">$'+fmt(totalBal)+'</div>';
  h+='<div style="display:flex;gap:12px;margin-top:8px">';
  h+='<div><span class="text-xs text-dim">Futures</span><div class="val-xs text-w">$'+fmt(D.walletBalance)+'</div></div>';
  h+='<div><span class="text-xs text-dim">BSC Wallet</span><div class="val-xs text-w">$'+fmt(D.bscBalance)+'</div></div>';
  h+='<div><span class="text-xs text-dim">Total PnL</span><div class="val-xs '+pnlClass(totalPnl)+'">'+(totalPnl>=0?'+':'')+' $'+fmt(Math.abs(totalPnl))+'</div></div>';
  h+='</div></div>';

  h+='<div class="card" style="background:linear-gradient(135deg,rgba(14,203,129,0.08),rgba(14,203,129,0.02))">';
  h+='<div class="section-title">Trading Account</div>';
  h+='<div class="grid3 mt-2">';
  h+='<div style="text-align:center;padding:8px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">Available Margin</div><div class="val-xs text-w mt-1">$'+fmt(D.availableMargin)+'</div></div>';
  h+='<div style="text-align:center;padding:8px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">Unrealized PnL</div><div class="val-xs '+pnlClass(D.unrealizedPnl)+' mt-1">'+(D.unrealizedPnl>=0?'+':'')+' $'+fmt(Math.abs(D.unrealizedPnl))+'</div></div>';
  h+='<div style="text-align:center;padding:8px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">Realized PnL</div><div class="val-xs '+pnlClass(D.realizedPnl)+' mt-1">'+(D.realizedPnl>=0?'+':'')+' $'+fmt(Math.abs(D.realizedPnl))+'</div></div>';
  h+='</div>';
  if(D.wins+D.losses>0){h+='<div class="text-xs text-dim mt-2" style="text-align:center">Win Rate: '+D.wins+'W / '+D.losses+'L ('+Math.round(D.wins/(D.wins+D.losses)*100)+'%)</div>'}
  h+='</div>';

  if(D.positions&&D.positions.length>0){
    h+='<div class="card"><div class="section-title">Open Positions <span class="badge badge-info">'+D.positions.length+'</span></div>';
    D.positions.forEach(p=>{
      h+='<div class="pos-item"><div class="row"><div class="gap"><span class="badge '+(p.side==='LONG'?'badge-long':'badge-short')+'">'+p.side+'</span><span class="text-w fw-600 text-sm">'+p.symbol+'</span><span class="text-xs text-dim">'+p.leverage+'x</span></div>'+pnlHtml(p.unrealizedPnl)+'</div>';
      h+='<div class="row mt-1"><span class="text-xs text-dim mono">'+p.size+' @ $'+fmt(p.entryPrice)+'</span><span class="text-xs text-dim mono">Mark: $'+fmt(p.markPrice)+'</span></div></div>';
    });
    h+='</div>';
  }

  if(M.markets&&M.markets.length>0){
    h+='<div class="card"><div class="section-title">Markets</div><div class="grid2">';
    M.markets.forEach(m=>{
      if(m.price>0)h+='<div class="row" style="padding:6px 10px;background:var(--bg);border-radius:8px"><span class="text-xs text-dim">'+m.symbol.replace('USDT','')+'</span><span class="val-xs text-w">$'+fmt(m.price)+'</span></div>';
    });
    h+='</div></div>';
  }

  h+='<div class="card" style="border:1px solid rgba(255,255,255,0.06)">';
  h+='<div class="section-title">Switch Wallet</div>';
  h+='<div class="text-xs text-dim">Have a different wallet with funds on Aster? Import it here.</div>';
  h+='<button class="btn btn-outline mt-2" style="width:100%;font-size:12px" onclick="showDashImport()">Import Different Wallet</button>';
  h+='<div id="dash-import" style="display:none;margin-top:12px">';
  h+='<input id="dash-import-pk" type="password" class="input" placeholder="Paste wallet private key (0x...)" autocomplete="off">';
  h+='<button class="btn btn-green mt-2" style="width:100%" onclick="doDashImport()">Import & Reconnect</button>';
  h+='<div id="dash-import-status"></div>';
  h+='</div>';
  h+='</div>';

  h+='<div style="display:flex;gap:8px;margin-top:8px">';
  h+='<button class="btn btn-outline" style="flex:1" onclick="forceRefresh()">↻ Force Refresh</button>';
  h+='<button class="btn btn-outline" style="flex:0;font-size:10px;padding:8px" onclick="debugBalance()">🔍 Debug</button>';
  h+='</div>';
  h+='<pre id="debug-out" style="display:none;font-size:9px;background:var(--bg);padding:8px;border-radius:8px;overflow-x:auto;max-height:300px;margin-top:8px"></pre>';
  h+='<div class="timestamp">Updated '+timeAgo()+'</div>';
  el.innerHTML=h;
}

async function loadDeposit(){
  const el=$('p-deposit');
  el.innerHTML=skeletonCard(3)+skeletonCard(2);
  if(!D.connected)await fetchAll();
  renderDeposit();
}

function shortAddr(a){return a?(a.slice(0,6)+'...'+a.slice(-4)):'-'}

function renderDeposit(){
  const el=$('p-deposit');
  let h='';
  var walletAddr=D.bscWalletAddress||'';

  h+='<div class="card card-accent" style="text-align:center;padding:20px">';
  h+='<div class="label" style="font-size:13px;letter-spacing:0.5px">Fund Your Trading Account</div>';
  h+='<div style="font-size:11px;color:var(--text2);margin:8px 0 16px">Send <strong style="color:#fff">USDT (BEP-20)</strong> to your personal wallet below</div>';
  if(walletAddr){
    h+='<div style="background:var(--bg);border-radius:12px;padding:16px;margin:0 auto;max-width:280px">';
    h+='<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data='+walletAddr+'&bgcolor=1a1d21&color=ffffff&margin=8" style="width:180px;height:180px;border-radius:8px;margin:0 auto;display:block" alt="Wallet QR">';
    h+='</div>';
    h+='<div class="vault-box mt-3" style="font-size:11px;word-break:break-all;cursor:pointer" data-addr="'+walletAddr+'" onclick="copyAddr(this)">'+walletAddr+'<div class="text-xs mt-1" style="color:var(--green)">Tap to copy</div></div>';
  }else{
    h+='<div class="text-sm text-dim" style="padding:20px">No wallet connected yet.</div>';
    h+='<button class="btn btn-outline mt-2" style="width:80%" onclick="showImportWallet()">Import Existing Wallet</button>';
    h+='<div id="import-wallet-flow" style="display:none;margin-top:12px;text-align:left">';
    h+='<input id="import-pk" type="password" class="input" placeholder="Paste wallet private key (0x...)" autocomplete="off">';
    h+='<button class="btn btn-green mt-2" style="width:100%" onclick="importWallet()">Import & Connect</button>';
    h+='<div id="import-status"></div>';
    h+='</div>';
  }
  h+='<div class="alert alert-warn mt-3" style="text-align:left"><span>⚠️</span><span>Only send USDT on <strong>BSC (BNB Smart Chain)</strong>. Other networks will be lost.</span></div>';
  h+='</div>';

  if(D.asterApiWallet){
    h+='<div class="card" style="border:1px solid var(--green)">';
    h+='<div class="section-title" style="color:var(--green)">✅ Aster Trading Connected</div>';
    h+='<div class="text-xs text-dim">Your wallet is linked to Aster Futures and ready to trade.</div>';
    h+='<div class="text-xs text-dim mt-3" style="cursor:pointer;text-decoration:underline" onclick="showReconnectFlow()">Change API Wallet / Reconnect</div>';
    h+='<div id="reconnect-flow" style="display:none;margin-top:12px">';
    h+='<div class="text-xs text-dim mb-2" style="line-height:1.5">To reconnect, you need your <strong style="color:#fff">API Wallet private key</strong> from Aster:</div>';
    h+='<div style="background:var(--bg);border-radius:8px;padding:10px;margin-bottom:12px">';
    h+='<div class="text-xs" style="color:var(--text2);line-height:1.6">';
    h+='1. Go to <a href="https://asterdex.com/en/api-wallet" target="_blank" style="color:var(--green)">asterdex.com/en/api-wallet</a><br>';
    h+='2. Log in with your wallet<br>';
    h+='3. Create or view your API Wallet<br>';
    h+='4. Enable <strong style="color:#fff">Perps Trading</strong><br>';
    h+='5. Copy the <strong style="color:#fff">private key</strong> and paste below</div>';
    h+='</div>';
    h+='<div class="label mt-2">Your Aster Account Address</div>';
    h+='<input id="api-wallet-parent" class="input" placeholder="Your main wallet address (0x06d6...)" autocomplete="off">';
    h+='<div class="label mt-2">API Wallet Private Key</div>';
    h+='<input id="api-wallet-pk" type="password" class="input" placeholder="API Wallet private key (0x...)" autocomplete="off">';
    h+='<button class="btn btn-green mt-2" style="width:100%" onclick="linkAsterApi()">🔗 Link API Wallet</button>';
    h+='<div id="link-status"></div>';
    h+='<div id="manual-link-status"></div>';
    h+='</div>';
    h+='</div>';
  } else if(walletAddr) {
    h+='<div class="card card-accent" style="border:1px solid var(--yellow)">';
    h+='<div class="section-title" style="color:var(--yellow)">🔗 Connect to Aster DEX</div>';
    h+='<div class="text-xs" style="color:var(--text2);margin-bottom:12px;line-height:1.5">To trade futures, you need to link your Aster <strong style="color:#fff">API Wallet</strong>. This is NOT your main wallet key — it is a separate key created on the Aster website.</div>';
    h+='<div style="background:var(--bg);border-radius:8px;padding:12px;margin-bottom:12px">';
    h+='<div class="text-xs" style="color:var(--green);font-weight:600;margin-bottom:6px">How to get your API Wallet key:</div>';
    h+='<div class="text-xs" style="color:var(--text2);line-height:1.7">';
    h+='<strong style="color:#fff">Step 1:</strong> Open <a href="https://asterdex.com/en/api-wallet" target="_blank" style="color:var(--green);text-decoration:underline">asterdex.com/en/api-wallet</a><br>';
    h+='<strong style="color:#fff">Step 2:</strong> Log in with your wallet (0x06d6...)<br>';
    h+='<strong style="color:#fff">Step 3:</strong> Click <strong style="color:#fff">"Create API Wallet"</strong><br>';
    h+='<strong style="color:#fff">Step 4:</strong> Enable <strong style="color:var(--green)">Perps Trading</strong> permission<br>';
    h+='<strong style="color:#fff">Step 5:</strong> Copy the <strong style="color:var(--yellow)">private key</strong> it shows you</div>';
    h+='</div>';
    h+='<div class="label mt-2">Your Aster Account Address</div>';
    h+='<div class="text-xs text-dim" style="margin-bottom:4px">The wallet you used to log in to Aster (your parent/main wallet)</div>';
    h+='<input id="api-wallet-parent" class="input" placeholder="0x... (your main wallet address)" autocomplete="off">';
    h+='<div class="label mt-2">API Wallet Private Key</div>';
    h+='<input id="api-wallet-pk" type="password" class="input" placeholder="Paste your API Wallet private key here (0x...)" autocomplete="off">';
    h+='<button class="btn btn-green mt-2" style="width:100%" onclick="linkAsterApi()">🔗 Connect to Aster</button>';
    h+='<div id="link-status"></div>';
    h+='<div id="manual-link-status"></div>';
    h+='<div class="text-xs text-dim mt-3" style="line-height:1.4">⚠️ This is NOT your main wallet key. It is a separate API Wallet key from <a href="https://asterdex.com/en/api-wallet" target="_blank" style="color:var(--blue)">the Aster API Wallet page</a>.</div>';
    h+='</div>';
  }

  h+='<div class="card" style="background:linear-gradient(135deg,rgba(14,203,129,0.05),transparent)">';
  h+='<div class="section-title">Your Balances</div>';
  h+='<div class="grid3 mt-2">';
  h+='<div style="text-align:center;padding:12px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">BSC Wallet</div><div class="val-sm text-w mt-1">$'+fmt(D.bscBalance)+'</div></div>';
  h+='<div style="text-align:center;padding:12px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">Spot</div><div class="val-sm text-w mt-1">$'+fmt(D.spotBalance)+'</div></div>';
  h+='<div style="text-align:center;padding:12px;background:var(--green-bg);border-radius:8px"><div class="text-xs" style="color:var(--green)">Futures</div><div class="val-sm text-w mt-1">$'+fmt(D.walletBalance)+'</div></div>';
  h+='</div></div>';

  if(D.bscWalletAddress){
    h+='<div class="card"><div class="section-title">Deposit to Aster Futures</div>';
    h+='<div class="text-xs text-dim mb-2">Your wallet: <span class="mono" style="color:var(--blue);cursor:pointer" data-addr="'+D.bscWalletAddress+'" onclick="copyAddr(this)">'+shortAddr(D.bscWalletAddress)+' 📋</span> · $'+fmt(D.bscBalance)+' USDT</div>';
    if(D.bnbBalance<0.001){h+='<div class="alert alert-warn mt-0 mb-2"><span>⚠️</span><span>Low BNB! Send at least 0.001 BNB to your wallet for gas fees.</span></div>'}
    h+='<div class="text-xs text-dim mb-3">Transfer USDT from your wallet into Aster Futures to start trading.</div>';
    var transferAmts=[1,5,10,25];
    h+='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">';
    transferAmts.forEach(function(a){
      var dis=D.bscBalance<a?'disabled style="opacity:.4;cursor:not-allowed"':'onclick="doTransfer('+a+')"';
      h+='<button class="btn btn-outline" '+dis+'>$'+a+'</button>';
    });
    h+='</div>';
    if(D.bscBalance>0){
      h+='<button class="btn btn-green mt-3" style="width:100%" onclick="doTransfer('+Math.floor(D.bscBalance*100)/100+')">Deposit All ($'+fmt(D.bscBalance)+') to Aster</button>';
    }
    h+='<div id="transfer-status"></div>';
    h+='</div>';
  }

  if((D.spotBalance||0)>0){
    h+='<div class="card card-accent"><div class="section-title">Transfer Spot → Futures</div>';
    h+='<div class="text-xs text-dim mb-2">You have $'+fmt(D.spotBalance)+' in Spot. Transfer to Futures to start trading.</div>';
    h+='<button class="btn btn-green" style="width:100%" onclick="spotToFutures()">Transfer $'+fmt(D.spotBalance)+' to Futures</button>';
    h+='<div id="stf-status"></div></div>';
  }
  h+='<button class="btn btn-outline mt-2" style="width:100%" onclick="spotToFutures()">🔄 Move Spot → Futures</button>';

  h+='<div class="card mt-3"><div class="section-title">Withdraw USDT</div>';
  h+='<div class="text-xs text-dim mb-2">Withdraw from Aster Futures to your BSC wallet. Min $1.</div>';
  h+='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">';
  var wAmts=[5,10,25,50];
  wAmts.forEach(function(w){h+='<button class="btn btn-outline" onclick="doWithdraw('+w+')">$'+w+'</button>'});
  h+='</div>';
  h+='<div style="display:flex;gap:8px;margin-top:8px">';
  h+='<input id="withdraw-amount" type="number" placeholder="Amount" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--card-bg);color:var(--text)">';
  h+='<button class="btn btn-outline" onclick="doWithdrawCustom()">Withdraw</button>';
  h+='</div>';
  h+='<input id="withdraw-addr" type="text" placeholder="To address (default: your bot wallet)" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--card-bg);color:var(--text);font-size:11px;margin-top:8px">';
  h+='<div id="withdraw-status"></div>';
  h+='</div>';

  h+='<button class="btn btn-outline mt-2" style="width:100%" onclick="loadDeposit()">↻ Refresh</button>';
  h+='<div class="timestamp mt-2">Updated '+timeAgo()+'</div>';
  el.innerHTML=h;
}

async function doTransfer(amount){
  const st=$('transfer-status');
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Depositing $'+fmt(amount)+' to Aster... This may take 15-20 seconds.</span></div>';
  try{
    const r=await api('/api/miniapp/deposit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})});
    if(r.success){
      var msg=r.message||'Deposit complete!';
      var txLink=r.txHash?'<br><a href="https://bscscan.com/tx/'+r.txHash+'" target="_blank" style="color:var(--green);text-decoration:underline;font-size:11px">View TX on BscScan ↗</a>':'';
      var icon=r.futuresTransferred?'🎉':'✅';
      st.innerHTML='<div class="alert alert-ok mt-3"><span>'+icon+'</span><div><strong>'+msg+'</strong>'+txLink+'<br><span style="font-size:11px;color:var(--text2)">Deposit detected on BSC ✓ — Waiting for Aster to credit to Futures margin (usually 2–10 minutes)</span></div></div>';
      toast(icon+' '+msg,'ok');
      var pollCount=0;
      var pollTimer=setInterval(async function(){
        pollCount++;
        try{
          var pa=await api('/api/miniapp/account');
          if(pa.connected){D=pa;lastUpdate=Date.now();}
          if(D.walletBalance>0||D.availableMargin>0){
            clearInterval(pollTimer);
            st.innerHTML='<div class="alert alert-ok mt-3" style="border-color:var(--green)"><span>🎉</span><div><strong>Funds now available in Futures!</strong><br><span style="color:var(--green)">$'+fmt(D.walletBalance)+' ready to trade</span>'+txLink+'</div></div>';
            toast('🎉 Funds now available in Futures!','ok');
            renderDeposit();
          }
        }catch(e){}
        if(pollCount>=40)clearInterval(pollTimer);
      },8000);
      setTimeout(function(){fetchAll().then(function(){renderDeposit()})},3000);
    }else{
      st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Transfer failed')+'</span></div>';
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+e.message+'</span></div>';
  }
}


async function forceRefresh(){
  toast('Refreshing...','info');
  try{
    const a=await api('/api/miniapp/account');
    if(a&&a.connected!==undefined){D={...D,...a};lastUpdate=Date.now()}
    const activePage=document.querySelector('.page.active');
    if(activePage?.id==='p-dash')renderDash();
    if(activePage?.id==='p-deposit')renderDeposit();
    toast('Updated!','ok');
  }catch(e){toast('Refresh failed','err')}
}

async function debugBalance(){
  var el=document.getElementById('debug-out');
  if(!el)return;
  el.style.display='block';
  el.textContent='Loading...';
  try{
    var r=await api('/api/miniapp/debug-balance');
    el.textContent=JSON.stringify(r,null,2);
  }catch(e){
    el.textContent='Error: '+e.message;
  }
}

function doWithdrawCustom(){
  var el=document.getElementById('withdraw-amount');
  var amt=el?parseFloat(el.value):0;
  if(!amt||amt<1){toast('Enter amount ($1 minimum)','err');return}
  doWithdraw(amt);
}

async function doWithdraw(amount){
  if(!amount||amount<1){toast('Minimum withdrawal is $1','err');return}
  var st=document.getElementById('withdraw-status');
  if(!st){st={innerHTML:''}}
  var addrEl=document.getElementById('withdraw-addr');
  var toAddr=addrEl?addrEl.value.trim():'';
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Withdrawing $'+amount+' USDT... Moving Futures→Spot→BSC</span></div>';
  try{
    var body={amount:amount};
    if(toAddr)body.toAddress=toAddr;
    var r=await api('/api/miniapp/withdraw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3"><span>✅</span><span>'+(r.message||'Withdrawal initiated!')+'</span></div>';
      toast('Withdrawal submitted!','ok');
      setTimeout(function(){fetchAll().then(function(){renderDeposit()})},5000);
    }else{
      st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Withdrawal failed')+'</span></div>';
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+e.message+'</span></div>';
  }
}

async function spotToFutures(){
  var st=document.getElementById('stf-status');
  if(!st){toast('Transferring Spot to Futures...','info');st={innerHTML:''}}
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Transferring Spot → Futures...</span></div>';
  try{
    var r=await api('/api/miniapp/spot-to-futures',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3"><span>🎉</span><span>'+(r.message||'Transferred!')+'</span></div>';
      toast('🎉 Funds moved to Futures!','ok');
      setTimeout(function(){fetchAll().then(function(){renderDeposit()})},3000);
    }else{
      st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Transfer failed')+'</span></div>';
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+e.message+'</span></div>';
  }
}

function showLinkFlow(){
  var el=$('link-flow');
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

function showReconnectFlow(){
  var el=$('reconnect-flow');
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

function showDashImport(){
  var el=$('dash-import');
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

async function doDashImport(){
  var pkInput=$('dash-import-pk');
  var st=$('dash-import-status');
  if(!pkInput||!st)return;
  var pk=pkInput.value.trim();
  if(!pk){toast('Enter your wallet private key','err');return}
  if(!pk.startsWith('0x'))pk='0x'+pk;
  if(pk.length!==66){toast('Invalid key length','err');return}
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Importing wallet & connecting to Aster... 15-20 seconds.</span></div>';
  try{
    var r=await api('/api/miniapp/import-wallet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({privateKey:pk})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3"><span>✅</span><span><strong>Wallet imported!</strong> '+(r.asterLinked?'Aster connected!':'')+'</span></div>';
      toast('✅ Wallet imported!','ok');
      pkInput.value='';
      D.bscWalletAddress=r.walletAddress;
      if(r.asterLinked)D.asterApiWallet='auto';
      setTimeout(function(){fetchAll().then(function(){renderDash();renderDeposit()})},2000);
    }else{
      st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Import failed')+'</span></div>';
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+e.message+'</span></div>';
  }
}

function showImportWallet(){
  var el=$('import-wallet-flow');
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

async function importWallet(){
  var pkInput=$('import-pk');
  var st=$('import-status');
  if(!pkInput||!st)return;
  var pk=pkInput.value.trim();
  if(!pk){toast('Enter your wallet private key','err');return}
  if(!pk.startsWith('0x'))pk='0x'+pk;
  if(pk.length!==66){toast('Invalid key length','err');return}
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Importing wallet & connecting to Aster... This may take 15-20 seconds.</span></div>';
  try{
    var r=await api('/api/miniapp/import-wallet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({privateKey:pk})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3"><span>✅</span><span><strong>Wallet imported!</strong> '+(r.asterLinked?'Aster connected.':'Aster linking may take a moment.')+'</span></div>';
      toast('✅ Wallet imported!','ok');
      pkInput.value='';
      D.bscWalletAddress=r.walletAddress;
      if(r.asterLinked)D.asterApiWallet='auto';
      setTimeout(function(){fetchAll().then(function(){renderDeposit();renderDash()})},2000);
    }else{
      st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Import failed')+'</span></div>';
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+e.message+'</span></div>';
  }
}

async function autoLinkAster(){
  var st=$('link-status');
  if(!st)return;
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Connecting to Aster... This may take 10-15 seconds.</span></div>';
  try{
    var r=await api('/api/miniapp/link-aster',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3"><span>✅</span><span><strong>Connected to Aster!</strong> Your account is ready.</span></div>';
      toast('✅ Connected to Aster!','ok');
      D.asterApiWallet=r.apiWalletAddress||'auto';
      setTimeout(function(){fetchAll().then(function(){renderDeposit();renderDash()})},2000);
    }else{
      st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Auto-connect failed.')+'<br>Try the manual option below.</span></div>';
      showLinkFlow();
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+e.message+'</span></div>';
    showLinkFlow();
  }
}

async function linkAsterApi(){
  var pkInput=$('api-wallet-pk');
  var parentInput=$('api-wallet-parent');
  var st=$('manual-link-status');
  if(!pkInput||!st)return;
  var pk=pkInput.value.trim();
  var parentAddr=(parentInput?parentInput.value.trim():'');
  if(!parentAddr){toast('Enter your Aster account address (the wallet you logged in with)','err');return}
  if(!parentAddr.startsWith('0x')||parentAddr.length!==42){toast('Invalid Aster account address — must be 0x followed by 40 hex characters','err');return}
  if(!pk){toast('Enter your API Wallet private key','err');return}
  if(!pk.startsWith('0x'))pk='0x'+pk;
  if(pk.length!==66){toast('Invalid key length','err');return}
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Linking...</span></div>';
  try{
    var r=await api('/api/miniapp/link-aster',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiWalletPrivateKey:pk,parentAddress:parentAddr})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3"><span>✅</span><span>API Wallet linked!</span></div>';
      toast('✅ Linked!','ok');
      pkInput.value='';
      D.asterApiWallet=r.apiWalletAddress;
      setTimeout(function(){fetchAll().then(function(){renderDeposit();renderDash()})},2000);
    }else{
      st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Failed')+'</span></div>';
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+e.message+'</span></div>';
  }
}

function validateTxHash(){
  const v=$('txhash').value.trim();
  const err=$('txhash-err');
  const btn=$('verify-btn');
  if(!v){err.style.display='none';btn.disabled=true;return}
  if(!v.startsWith('0x')){err.textContent='Must start with 0x';err.style.display='block';btn.disabled=true;return}
  if(v.length!==66){err.textContent='Must be 66 characters (currently '+v.length+')';err.style.display='block';btn.disabled=true;return}
  if(!/^0x[a-fA-F0-9]{64}$/.test(v)){err.textContent='Invalid characters in hash';err.style.display='block';btn.disabled=true;return}
  err.style.display='none';
  btn.disabled=false;
}

async function verifyDeposit(){
  const tx=$('txhash').value.trim();
  const st=$('verify-status');
  $('verify-btn').disabled=true;
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Checking transaction on BSC...</span></div>';
  try{
    const r=await fetch('https://api.bscscan.com/api?module=proxy&action=eth_getTransactionByHash&txhash='+tx+'&apikey=YourApiKeyToken');
    const d=await r.json();
    if(d.result&&d.result.to){
      const to=d.result.to.toLowerCase();
      const vault=VAULT.toLowerCase();
      if(to===vault||d.result.input?.toLowerCase().includes(vault.slice(2))){
        st.innerHTML='<div class="alert alert-ok mt-3"><span>✅</span><div><strong>Transaction verified!</strong><br><span class="text-xs">TX sent to Aster vault. Funds should appear in your Spot account within 1-5 minutes.</span><br><a href="https://bscscan.com/tx/'+tx+'" target="_blank" style="color:var(--green);text-decoration:underline;font-size:11px">View on BscScan ↗</a></div></div>';
        toast('✅ Deposit TX verified!','ok');
        setTimeout(()=>fetchAll().then(()=>{renderDash()}),10000);
      }else{
        st.innerHTML='<div class="alert alert-warn mt-3"><span>⚠️</span><div><strong>Transaction found but sent to a different address.</strong><br><span class="text-xs">This TX was not sent to the Aster vault. Make sure you sent to the correct address.</span><br><a href="https://bscscan.com/tx/'+tx+'" target="_blank" style="color:var(--yellow);text-decoration:underline;font-size:11px">Check on BscScan ↗</a></div></div>';
      }
    }else{
      st.innerHTML='<div class="alert alert-warn mt-3"><span>🔍</span><div><strong>Transaction not found yet.</strong><br><span class="text-xs">It may still be pending. Try again in a minute.</span></div></div>';
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>Failed to check transaction: '+e.message+'</span></div>';
  }
  $('verify-btn').disabled=false;
}

async function loadAgent(){
  const el=$('p-agent');
  el.innerHTML=skeletonCard(3);
  try{
    AG=await api('/api/miniapp/agent');
    renderAgent();
  }catch(e){el.innerHTML='<div class="alert alert-err">'+e.message+'</div>'}
}

function renderAgent(){
  const el=$('p-agent');
  if(!AG)return;
  const r=AG.running,c=AG.config,s=AG.stats;
  let h='<div class="section-title" style="font-size:16px">🤖 AI Trading Agent</div>';

  h+='<div class="card '+(r?'card-accent':'')+'"><div class="row"><div class="gap"><div style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;background:'+(r?'var(--green-bg)':'var(--bg)')+'">🤖</div><div><div class="text-w fw-600">Autonomous Agent</div><div class="gap mt-1"><div class="live-dot" style="'+(r?'':'animation:none;background:var(--text3)')+'"></div><span class="text-xs '+(r?'g+':'text-dim')+'">'+(r?'Active — Trading':'Stopped')+'</span></div></div></div><div class="switch'+(r?' on':'')+'" onclick="toggleAgent()"></div></div>';
  if(r&&c){h+='<div class="gap mt-3" style="flex-wrap:wrap"><span class="badge badge-long">'+c.symbol+'</span><span class="badge badge-info">'+c.maxLeverage+'x max</span><span class="badge badge-warn">'+c.riskPercent+'% risk</span></div>'}
  h+='</div>';

  h+='<div class="card"><div class="section-title">⚙️ Configuration</div>';
  h+='<div class="row text-sm"><span class="text-dim">Risk Per Trade</span><span class="mono text-w fw-600">'+(c?.riskPercent||1)+'%</span></div>';
  h+='<div class="slider-track" onclick="setRisk(event)"><div class="slider-fill" style="width:'+((c?.riskPercent||1)/3*100)+'%"></div><div class="slider-thumb" style="left:'+((c?.riskPercent||1)/3*100)+'%"></div></div>';
  h+='<div class="row text-xs text-dim2"><span>0.5% (Safe)</span><span>3% (Aggressive)</span></div>';
  h+='<div class="row text-sm mt-3"><span class="text-dim">Max Leverage</span><span class="mono text-w fw-600">'+(c?.maxLeverage||10)+'x</span></div>';
  h+='<div class="row text-sm mt-3"><span class="text-dim">Trading Pair</span><span class="text-w fw-600">'+(c?.symbol||'BTCUSDT')+'</span></div>';
  if(D.availableMargin>0){h+='<div class="row text-sm mt-3"><span class="text-dim">Max Position</span><span class="mono text-w fw-600">$'+fmt(D.availableMargin*(c?.riskPercent||1)/100*(c?.maxLeverage||10))+'</span></div>'}
  h+='</div>';

  if(D.availableMargin>0&&D.availableMargin<10){h+='<div class="alert alert-warn mb-3"><span>⚠️</span><span>Futures margin is below $10. The agent will not trade until margin is at least $10 for safety.</span></div>'}

  if(s){
    const wr=s.winCount+s.lossCount>0?Math.round(s.winCount/(s.winCount+s.lossCount)*100):0;
    h+='<div class="card"><div class="section-title">📊 Performance</div><div class="grid2">';
    h+='<div style="padding:10px;background:var(--bg);border-radius:8px;text-align:center"><div class="text-xs text-dim2">Total Trades</div><div class="val-sm text-w mt-1">'+s.tradeCount+'</div></div>';
    h+='<div style="padding:10px;background:var(--bg);border-radius:8px;text-align:center"><div class="text-xs text-dim2">Win Rate</div><div class="val-sm '+(wr>=50?'g+':'r-')+' mt-1">'+wr+'%</div></div>';
    h+='<div style="padding:10px;background:var(--bg);border-radius:8px;text-align:center"><div class="text-xs text-dim2">Total PnL</div><div class="val-sm '+pnlClass(s.totalPnl)+' mt-1">'+(s.totalPnl>=0?'+':'')+' $'+fmt(Math.abs(s.totalPnl))+'</div></div>';
    h+='<div style="padding:10px;background:var(--bg);border-radius:8px;text-align:center"><div class="text-xs text-dim2">W / L</div><div class="val-sm text-w mt-1"><span class="g+">'+s.winCount+'</span> / <span class="r-">'+s.lossCount+'</span></div></div>';
    h+='</div>';
    if(s.lastAction){h+='<div class="alert alert-info mt-3"><span>🧠</span><div><div class="text-xs fw-600" style="color:var(--blue)">Last Action</div><div class="text-sm text-w mt-1">'+s.lastAction+'</div>'+(s.lastReason?'<div class="text-xs text-dim mt-1">'+s.lastReason+'</div>':'')+'</div></div>'}
    h+='</div>';
  }
  el.innerHTML=h;
}

function setRisk(e){
  const r=e.currentTarget.getBoundingClientRect();
  const pct=Math.max(0.5,Math.min(3,((e.clientX-r.left)/r.width)*3));
  const rounded=Math.round(pct*10)/10;
  if(AG&&AG.config)AG.config.riskPercent=rounded;
  renderAgent();
}

async function toggleAgent(){
  try{
    const r=await api('/api/miniapp/agent/toggle',{method:'POST',headers:{'Content-Type':'application/json'}});
    toast(r.running?'🤖 Agent activated':'⏸ Agent stopped',r.running?'ok':'info');
    AG.running=r.running;
    renderAgent();
  }catch(e){toast('❌ '+e.message,'err')}
}

let tradeSel='BTCUSDT',tradeLev=10;
async function loadTrade(){
  const el=$('p-trade');
  if(!M.markets.length){el.innerHTML=skeletonCard(3);await fetchAll()}
  renderTrade();
}

function renderTrade(){
  const el=$('p-trade');
  const pairs=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT'];
  const price=(M.markets.find(m=>m.symbol===tradeSel)?.price)||0;

  let h='<div class="section-title" style="font-size:16px">⚡ Quick Trade</div>';
  h+='<div class="card"><div class="label">Trading Pair</div><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">';
  pairs.forEach(p=>{h+='<button class="btn btn-sm '+(tradeSel===p?'btn-green':'btn-outline')+'" onclick="tradeSel=\\''+p+'\\';renderTrade()">'+p.replace('USDT','')+'</button>'});
  h+='</div>';

  if(price>0){h+='<div style="text-align:center;padding:20px 0"><div class="text-xs text-dim">'+tradeSel+'</div><div class="val" style="font-size:28px">$'+fmt(price)+'</div></div>'}

  h+='<div class="row text-sm"><span class="text-dim">Leverage</span><span class="mono text-w fw-600" id="lev-val">'+tradeLev+'x</span></div>';
  h+='<div class="slider-track" onclick="var r=this.getBoundingClientRect();tradeLev=Math.max(1,Math.min(50,Math.round(((event.clientX-r.left)/r.width)*50)));renderTrade()"><div class="slider-fill" style="width:'+(tradeLev/50*100)+'%"></div><div class="slider-thumb" style="left:'+(tradeLev/50*100)+'%"></div></div>';
  h+='<div class="row text-xs text-dim2"><span>1x</span><span>25x</span><span>50x</span></div>';

  h+='<div class="label mt-3">Margin Amount (USDT)</div>';
  h+='<input id="trade-amt" class="input mt-1" type="number" placeholder="Enter margin amount" oninput="updatePreview()">';
  if(D.connected&&D.availableMargin>0){h+='<div class="text-xs text-dim mt-1">Available: $'+fmt(D.availableMargin)+' · <span style="color:var(--blue);cursor:pointer" onclick="document.getElementById(\\'trade-amt\\').value='+Math.floor(D.availableMargin*100)/100+';updatePreview()">Max</span></div>'}

  h+='<div id="trade-preview" class="mt-3"></div>';

  h+='<div class="grid2 mt-3"><button class="btn btn-green" style="height:50px;font-size:15px" onclick="execTrade(\\'BUY\\')">📈 Long</button><button class="btn btn-red" style="height:50px;font-size:15px" onclick="execTrade(\\'SELL\\')">📉 Short</button></div>';
  h+='<div id="trade-status" class="mt-2"></div>';
  h+='</div>';

  if(D.positions&&D.positions.length>0){
    h+='<div class="card"><div class="section-title">📊 Open Positions</div>';
    D.positions.forEach(p=>{
      h+='<div class="pos-item"><div class="row"><div class="gap"><span class="badge '+(p.side==='LONG'?'badge-long':'badge-short')+'">'+p.side+'</span><span class="text-w fw-600 text-sm">'+p.symbol+'</span></div>'+pnlHtml(p.unrealizedPnl)+'</div>';
      h+='<div class="row mt-2"><span class="text-xs text-dim mono">'+p.size+' @ $'+fmt(p.entryPrice)+'</span><button class="btn btn-outline btn-sm" style="font-size:11px" onclick="closePos(\\''+p.symbol+'\\')">Close</button></div></div>';
    });
    h+='</div>';
  }

  h+='<div class="text-xs text-dim2 mt-2" style="text-align:center">Market orders via Aster DEX V3 Pro API</div>';
  el.innerHTML=h;
}

function updatePreview(){
  const amt=parseFloat($('trade-amt')?.value||'0');
  const price=(M.markets.find(m=>m.symbol===tradeSel)?.price)||0;
  const prev=$('trade-preview');
  if(!prev)return;
  if(!amt||amt<=0||price<=0){prev.innerHTML='';return}
  const notional=amt*tradeLev;
  const qty=notional/price;
  prev.innerHTML='<div style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px"><div class="row text-xs"><span class="text-dim">Position Size</span><span class="mono text-w">'+qty.toFixed(4)+' '+tradeSel.replace('USDT','')+'</span></div><div class="row text-xs mt-2"><span class="text-dim">Notional Value</span><span class="mono text-w">$'+fmt(notional)+'</span></div><div class="row text-xs mt-2"><span class="text-dim">Leverage</span><span class="mono text-w">'+tradeLev+'x</span></div></div>';
}

async function execTrade(side){
  const amt=parseFloat($('trade-amt')?.value||'0');
  if(!amt||amt<=0){toast('Enter a margin amount','err');return}
  const dir=side==='BUY'?'LONG':'SHORT';
  const ok=await customConfirm('<div style="font-weight:600;font-size:16px;margin-bottom:12px">Open '+dir+' '+tradeSel+'</div><div style="font-size:13px;color:#aaa">Margin: <strong style="color:#fff">$'+fmt(amt)+'</strong><br>Leverage: <strong style="color:#fff">'+tradeLev+'x</strong><br>Notional: <strong style="color:#fff">$'+fmt(amt*tradeLev)+'</strong></div>');
  if(!ok)return;
  const st=$('trade-status');
  st.innerHTML='<div class="alert alert-info"><span>⏳</span><span>Placing '+dir+' order on '+tradeSel+'...</span></div>';
  try{
    const r=await api('/api/miniapp/trade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:tradeSel,side,amount:amt,leverage:tradeLev})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok"><span>✅</span><div><strong>'+dir+' '+r.symbol+' filled!</strong><br><span class="text-xs mono">Qty: '+r.quantity+' @ $'+fmt(r.price)+'</span></div></div>';
      toast('✅ '+dir+' order filled!','ok');
      setTimeout(()=>{fetchAll().then(()=>{renderTrade()})},2000);
    }else{
      st.innerHTML='<div class="alert alert-err"><span>❌</span><span>'+(r.error||'Order failed')+'</span></div>';
      toast('❌ '+(r.error||'Order failed'),'err');
    }
  }catch(e){st.innerHTML='<div class="alert alert-err"><span>❌</span><span>'+e.message+'</span></div>';toast('❌ '+e.message,'err')}
}

async function closePos(symbol){
  const ok=await customConfirm('<div style="font-weight:600;font-size:16px;margin-bottom:12px">Close Position</div><div style="font-size:13px;color:#aaa">Close entire <strong style="color:#fff">'+symbol+'</strong> position?</div>');
  if(!ok)return;
  const st=$('trade-status');
  st.innerHTML='<div class="alert alert-info"><span>⏳</span><span>Closing '+symbol+'...</span></div>';
  try{
    const r=await api('/api/miniapp/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol})});
    if(r.success){
      toast('✅ '+symbol+' closed','ok');
      setTimeout(()=>{fetchAll().then(()=>{renderTrade()})},2000);
    }else{toast('❌ '+(r.error||'Close failed'),'err')}
  }catch(e){toast('❌ '+e.message,'err')}
}

loadDash();
<\/script>
</body>
</html>`;
}

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
.tabs{position:fixed;bottom:0;left:0;right:0;z-index:50;background:rgba(11,14,17,.95);backdrop-filter:blur(12px);border-top:1px solid var(--border);display:flex;height:52px;padding-bottom:env(safe-area-inset-bottom);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:9px;font-weight:500;color:var(--text3);cursor:pointer;border:none;background:none;transition:all .2s;position:relative;min-width:0;flex:1 0 auto;padding:4px 10px;white-space:nowrap}
.tab.active{color:var(--green)}
.tab.active::before{content:'';position:absolute;top:-1px;left:20%;right:20%;height:2px;background:var(--green);border-radius:0 0 2px 2px}
.tab svg{width:18px;height:18px}
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
.gv{color:var(--green)}.r-{color:var(--red)}
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
    <div class="hdr-title">Aster Agent AI <span style="font-size:9px;font-weight:600;color:#0b0e11;background:#f3ba2f;border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle;letter-spacing:0.5px">BETA</span></div>
    <div class="hdr-sub"><span class="live-dot"></span> Autonomous Trading</div>
  </div>
  <div style="margin-left:auto;text-align:right">
    <div class="text-xs text-dim" id="hdr-updated"></div>
  </div>
</div>

<div id="p-dash" class="page active"></div>
<div id="p-portfolio" class="page"></div>
<div id="p-trade" class="page"></div>
<div id="p-deposit" class="page"></div>
<div id="p-agent" class="page"></div>

<div class="tabs">
  <button class="tab active" data-tab="p-dash"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>Home</button>
  <button class="tab" data-tab="p-portfolio"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg>Portfolio</button>
  <button class="tab" data-tab="p-trade"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg>Trade</button>
  <button class="tab" data-tab="p-deposit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8m-4-4h8"/></svg>Deposit</button>
  <button class="tab" data-tab="p-agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>Agent</button>
</div>

<script>
const TG=window.Telegram?.WebApp;
if(TG){TG.ready();TG.expand();try{TG.setHeaderColor('#0b0e11');TG.setBackgroundColor('#0b0e11')}catch(e){}}
const chatId=new URLSearchParams(location.search).get('chatId')||TG?.initDataUnsafe?.user?.id||'';
const MINIAPP_VERSION='v48d-apr12';
console.log('[MiniApp] version='+MINIAPP_VERSION+' chatId='+chatId);
let D={connected:false,availableMargin:0,walletBalance:0,marginBalance:0,bscBalance:0,bnbBalance:0,bscWalletAddress:'',unrealizedPnl:0,realizedPnl:0,wins:0,losses:0,positions:[],recentIncome:[],spotBalance:0,openOrders:[]};
let M={markets:[]};
let AG=null;
let tradeHistory=[];
let HIS=null;
let lastUpdate=0;
let refreshTimer=null;
let portfolioSubTab='positions';
let ordersSubTab='open';

function $(id){return document.getElementById(id)}
function fmt(n,d=2){return(n||0).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})}
function fmtPrice(n){if(!n||n===0)return'$0.00';var a=Math.abs(n);if(a>=100)return'$'+fmt(n,2);if(a>=1)return'$'+fmt(n,4);if(a>=0.01)return'$'+fmt(n,6);return'$'+fmt(n,8)}
function fmtDuration(ms){if(!ms||ms<=0)return'';var s=Math.floor(ms/1000);var d=Math.floor(s/86400);s%=86400;var h=Math.floor(s/3600);s%=3600;var m=Math.floor(s/60);s%=60;var parts=[];if(d>0)parts.push(d+'d');if(h>0)parts.push(h+'h');if(m>0)parts.push(m+'m');parts.push(s+'s');return parts.join(' ')}
function pnlHtml(v){const p=v>=0;return '<span class="val-xs '+(p?'gv':'r-')+'">'+(p?'+':'-')+'$'+fmt(Math.abs(v))+'</span>'}
function pnlClass(v){return v>=0?'gv':'r-'}
function api(path,opts={}){
  var ctrl=new AbortController();
  var tm=setTimeout(function(){ctrl.abort()},15000);
  return fetch(path,{...opts,signal:ctrl.signal,headers:{'x-telegram-chat-id':String(chatId),...(opts.headers||{})}}).then(function(r){clearTimeout(tm);if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).catch(function(e){clearTimeout(tm);throw e})
}
function toast(msg,type='info'){const t=$('toast');t.className='toast show toast-'+type;t.innerHTML=msg;setTimeout(()=>t.classList.remove('show'),3500)}
function customConfirm(html){return new Promise(function(resolve){var ov=document.createElement('div');ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';var box=document.createElement('div');box.style.cssText='background:#1a1d21;border:1px solid #333;border-radius:12px;padding:20px;max-width:340px;width:100%;color:#e0e0e0;font-size:14px;line-height:1.6';box.innerHTML=html+'<div style="display:flex;gap:10px;margin-top:16px"><button id="cc-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid #555;background:transparent;color:#e0e0e0;cursor:pointer;font-size:14px">Cancel</button><button id="cc-ok" style="flex:1;padding:10px;border-radius:8px;border:none;background:#0ecb81;color:#0b0e11;cursor:pointer;font-weight:600;font-size:14px">Confirm</button></div>';ov.appendChild(box);document.body.appendChild(ov);$('cc-ok').onclick=function(){document.body.removeChild(ov);resolve(true)};$('cc-cancel').onclick=function(){document.body.removeChild(ov);resolve(false)};ov.onclick=function(e){if(e.target===ov){document.body.removeChild(ov);resolve(false)}}})}
function copyAddr(el){var a=el.dataset.addr;if(a)navigator.clipboard.writeText(a).then(function(){toast('Copied!','ok')}).catch(function(){toast('Copy failed','err')})}
function timeAgo(){if(!lastUpdate)return'';const s=Math.floor((Date.now()-lastUpdate)/1000);if(s<5)return'Just now';if(s<60)return s+'s ago';return Math.floor(s/60)+'m ago'}

function switchTab(tabId){
  var targetId=tabId;
  if(!targetId.startsWith('p-'))targetId='p-'+targetId;
  if(targetId==='p-positions'){targetId='p-portfolio';portfolioSubTab='positions'}
  if(targetId==='p-orders'){targetId='p-portfolio';portfolioSubTab='orders'}
  if(targetId==='p-history'){targetId='p-portfolio';portfolioSubTab='history'}
  if(targetId==='p-markets'){targetId='p-trade'}
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  var targetTab=document.querySelector('.tab[data-tab="'+targetId+'"]');
  if(targetTab)targetTab.classList.add('active');
  var targetPage=$(targetId);
  if(targetPage)targetPage.classList.add('active');
  if(targetId==='p-dash')loadDash();
  if(targetId==='p-trade')loadTrade();
  if(targetId==='p-portfolio')loadPortfolio();
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
  var interval=D.connected?10000:5000;
  refreshTimer=setInterval(async()=>{
    try{
      const a=await api('/api/miniapp/account');
      if(a&&a.connected!==undefined){
        var wasDisconnected=!D.connected;
        var hadBalance=(D.availableMargin||0)>0||(D.portfolioValue||0)>0;
        var newHasBalance=(a.availableMargin||0)>0||(a.portfolioValue||0)>0;
        if(hadBalance&&!newHasBalance){fetchErrors++;return}
        D={...D,...a};lastUpdate=Date.now();fetchErrors=0;lastFetchErr='';
        try{$('hdr-updated').textContent=timeAgo()}catch(e){}
        const activePage=document.querySelector('.page.active');
        if(activePage?.id==='p-dash')renderDash();
        if(activePage?.id==='p-deposit')renderDeposit();
        if(activePage?.id==='p-portfolio'&&portfolioSubTab==='positions')renderPortfolio();
        if(wasDisconnected&&D.connected){clearInterval(refreshTimer);startAutoRefresh()}
      }
    }catch(e){fetchErrors++}
  },interval);
}

var fetchErrors=0;
var lastFetchErr='';
async function fetchAll(){
  try{
    const [a,m,his]=await Promise.all([
      api('/api/miniapp/account').catch(e=>{console.error('account err',e);lastFetchErr='account: '+e.message;return null}),
      api('/api/miniapp/markets').catch(e=>{console.error('markets err',e);return null}),
      api('/api/miniapp/history').catch(e=>{console.error('history err',e);return null}),
    ]);
    if(a&&a.connected!==undefined){
      console.log('[MiniApp] fetchAll got: _v='+a._v+' connected='+a.connected+' wallet='+a.walletBalance+' avail='+a.availableMargin+' portfolio='+a.portfolioValue+' bsc='+a.bscBalance);
      var hadBal=(D.availableMargin||0)>0||(D.portfolioValue||0)>0;
      var newBal=(a.availableMargin||0)>0||(a.portfolioValue||0)>0;
      if(!hadBal||newBal){D={...D,...a};fetchErrors=0;lastFetchErr=''}
      else{fetchErrors++;console.log('[MiniApp] BLOCKED zero overwrite: hadBal='+hadBal+' newBal='+newBal)}
    }
    else if(a===null){fetchErrors++}
    if(m&&m.markets)M=m;
    if(his&&his.pnlSummary)HIS=his;
    lastUpdate=Date.now();
    try{$('hdr-updated').textContent='Updated'}catch(e){}
  }catch(e){console.error('fetchAll error',e);fetchErrors++;lastFetchErr=e.message}
}

function skeletonCard(lines=3){
  let h='<div class="card">';
  for(let i=0;i<lines;i++)h+='<div class="skeleton mt-2" style="width:'+(60+Math.random()*40)+'%;height:'+(i===0?28:16)+'px"></div>';
  return h+'</div>';
}

async function loadPortfolio(){
  const el=$('p-portfolio');
  el.innerHTML=skeletonCard(3)+skeletonCard(3);
  if(!D.connected){await fetchAll()}
  if(portfolioSubTab==='orders'){
    try{
      const [r1,r2]=await Promise.all([api('/api/miniapp/orders'),api('/api/miniapp/trades?symbol=BTCUSDT')]);
      D.openOrders=r1.openOrders||[];
      tradeHistory=r2.trades||[];
      D.recentIncome=r2.income||[];
    }catch(e){D.openOrders=[];tradeHistory=[];D.recentIncome=[]}
  }
  if(portfolioSubTab==='history'){
    try{HIS=await api('/api/miniapp/history')}catch(e){HIS={openPositions:[],closedTrades:[],pnlSummary:{day1:{pnl:0,wins:0,losses:0,total:0},day7:{pnl:0,wins:0,losses:0,total:0},allTime:{pnl:0,wins:0,losses:0,total:0}}}}
  }
  renderPortfolio();
}
function renderPortfolio(){
  const el=$('p-portfolio');
  if(!D.connected){el.innerHTML='<div class="card" style="text-align:center;padding:30px"><div style="font-size:40px;margin-bottom:12px">📊</div><div class="text-w fw-600">Connect to view portfolio</div><div class="text-dim text-xs mt-2">Link your Aster account first</div></div>';return}
  let h='<div style="display:flex;gap:0;margin-bottom:12px;background:var(--card);border-radius:10px;padding:3px;border:1px solid var(--border)">';
  h+='<button class="btn btn-sm" style="flex:1;border-radius:8px;font-size:11px;padding:8px 4px;'+(portfolioSubTab==='positions'?'background:var(--green);color:#0b0e11;font-weight:700':'background:transparent;color:var(--text2);border:none')+'" onclick="portfolioSubTab=\\'positions\\';loadPortfolio()">Positions</button>';
  h+='<button class="btn btn-sm" style="flex:1;border-radius:8px;font-size:11px;padding:8px 4px;'+(portfolioSubTab==='orders'?'background:var(--green);color:#0b0e11;font-weight:700':'background:transparent;color:var(--text2);border:none')+'" onclick="portfolioSubTab=\\'orders\\';loadPortfolio()">Orders</button>';
  h+='<button class="btn btn-sm" style="flex:1;border-radius:8px;font-size:11px;padding:8px 4px;'+(portfolioSubTab==='history'?'background:var(--green);color:#0b0e11;font-weight:700':'background:transparent;color:var(--text2);border:none')+'" onclick="portfolioSubTab=\\'history\\';loadPortfolio()">History</button>';
  h+='</div>';
  if(portfolioSubTab==='positions'){h+=renderPositionsHTML()}
  if(portfolioSubTab==='orders'){h+=renderOrdersHTML()}
  if(portfolioSubTab==='history'){h+=renderHistoryHTML()}
  el.innerHTML=h;
  if(portfolioSubTab==='positions'){startPositionTimers()}
}
async function loadPositions(){portfolioSubTab='positions';loadPortfolio()}
function renderPositions(){renderPortfolio()}
function renderPositionsHTML(){
  let h='<div class="section-title">Open Positions</div>';
  const pos=D.positions||[];
  if(pos.length===0){
    h+='<div class="card" style="text-align:center;padding:24px"><div style="font-size:32px;margin-bottom:8px">🎯</div><div class="text-dim text-sm">No open positions</div><div class="text-xs text-dim2 mt-1">Place a trade to get started</div></div>';
  }else{
    pos.forEach(function(p,idx){
      var side=p.side||(parseFloat(p.positionAmt||'0')>0?'LONG':(parseFloat(p.positionAmt||'0')<0?'SHORT':'LONG'));
      var amt=Math.abs(parseFloat(p.positionAmt||p.size||'0'));
      var entry=parseFloat(p.entryPrice||'0');
      var mark=parseFloat(p.markPrice||'0');
      var upnl=parseFloat(p.unrealizedPnl||p.unRealizedProfit||'0');
      var lev=p.leverage||'-';
      var liq=parseFloat(p.liquidationPrice||'0');
      var roe=p.roe||( entry>0?(((mark-entry)/entry)*(side==='LONG'?1:-1)*parseFloat(String(lev)||'1')*100):0 );
      var notional=p.notional||(amt*mark);
      var margin=p.margin||(parseFloat(String(lev)||'1')>0?notional/parseFloat(String(lev)||'1'):0);
      var marginType=(p.marginType||'cross').toUpperCase();
      var cardBorder=upnl>=0?'rgba(63,185,80,0.3)':'rgba(248,81,73,0.3)';
      var openTs=p.updateTime||0;
      h+='<div class="card" style="border:1px solid '+cardBorder+'">';
      h+='<div class="row"><div class="gap"><span class="badge '+(side==='LONG'?'badge-long':'badge-short')+'">'+side+'</span><span class="text-w fw-600">'+p.symbol+'</span><span class="badge badge-info">'+lev+'x</span><span class="badge" style="background:rgba(59,130,246,0.1);color:var(--blue);font-size:10px">'+marginType+'</span></div>'+pnlHtml(upnl)+'</div>';
      if(openTs>0){h+='<div class="mt-2" style="display:flex;align-items:center;gap:6px"><span class="text-xs text-dim">⏱ Open since</span><span class="text-xs mono gv" id="pos-timer-'+idx+'" data-open-ts="'+openTs+'">'+fmtDuration(Date.now()-openTs)+'</span></div>'}
      h+='<div class="grid2 mt-3"><div><div class="label">Size</div><div class="val-sm mono gv">'+amt+'</div></div><div><div class="label">Notional</div><div class="val-sm mono gv">$'+fmt(notional)+'</div></div></div>';
      h+='<div class="grid2 mt-2"><div><div class="label">Entry Price</div><div class="val-sm mono gv">'+fmtPrice(entry)+'</div></div><div><div class="label">Mark Price</div><div class="val-sm mono gv">'+fmtPrice(mark)+'</div></div></div>';
      h+='<div class="grid2 mt-2"><div><div class="label">ROE</div><div class="val-sm mono '+pnlClass(roe)+'">'+(roe>=0?'+':'')+fmt(roe,1)+'%</div></div><div><div class="label">Margin</div><div class="val-sm mono gv">$'+fmt(margin)+'</div></div></div>';
      if(liq>0){h+='<div class="mt-2" style="padding:8px;background:rgba(248,81,73,0.08);border-radius:8px;border:1px solid rgba(248,81,73,0.2)"><div class="row"><div><div class="label" style="color:var(--red)">⚠ Liquidation Price</div><div class="val-sm mono" style="color:var(--red)">'+fmtPrice(liq)+'</div></div><div style="text-align:right"><div class="label">Distance</div><div class="val-xs mono '+(Math.abs((mark-liq)/mark*100)>20?'gv':'r-')+'">'+fmt(Math.abs((mark-liq)/mark*100),1)+'%</div></div></div></div>'}
      h+='<div class="mt-3"><button class="btn btn-red btn-sm" style="width:100%" onclick="closePosFromTab(\\''+p.symbol+'\\')">Close Position</button></div></div>';
    });
  }
  h+='<div class="card mt-2"><div class="row"><span class="label">Total Unrealized PnL</span>'+pnlHtml(D.unrealizedPnl||0)+'</div></div>';
  return h;
}
function startPositionTimers(){startPosTimers()}
var posTimerInterval=null;
function startPosTimers(){
  if(posTimerInterval)clearInterval(posTimerInterval);
  posTimerInterval=setInterval(function(){
    var activePage=document.querySelector('.page.active');
    if(!activePage||activePage.id!=='p-portfolio'||portfolioSubTab!=='positions'){clearInterval(posTimerInterval);posTimerInterval=null;return}
    for(var i=0;i<20;i++){
      var el=document.getElementById('pos-timer-'+i);
      if(!el)break;
      var ts=parseInt(el.dataset.openTs||'0');
      if(ts>0)el.textContent=fmtDuration(Date.now()-ts);
    }
  },1000);
}
async function closePosFromTab(symbol){
  const ok=await customConfirm('<div style="font-weight:600;font-size:16px;margin-bottom:12px">Close Position</div><div style="font-size:13px;color:#aaa">Close entire <strong style="color:#fff">'+symbol+'</strong> position?</div>');
  if(!ok)return;
  toast('⏳ Closing '+symbol+'...','info');
  try{
    const r=await api('/api/miniapp/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol})});
    if(r.success){
      toast('✅ '+symbol+' closed'+(r.realizedPnl!==undefined?' | PnL: '+(r.realizedPnl>=0?'+':'')+fmt(r.realizedPnl)+' USDT':''),'ok');
      await fetchAll();renderPositions();
    }else{toast('❌ '+(r.error||'Close failed'),'err')}
  }catch(e){toast('❌ '+e.message,'err')}
}

function renderOrdersHTML(){
  let h='<div class="section-title">Open Orders</div>';
  const orders=D.openOrders||[];
  if(orders.length===0){
    h+='<div class="card" style="text-align:center;padding:24px"><div style="font-size:32px;margin-bottom:8px">✅</div><div class="text-dim text-sm">No open orders</div><div class="text-xs text-dim2 mt-1">All orders have been filled or cancelled</div></div>';
  }else{
    orders.forEach(function(o){
      var isBuy=o.side==='BUY';
      h+='<div class="card"><div class="row"><div class="gap"><span class="badge '+(isBuy?'badge-long':'badge-short')+'">'+o.side+'</span><span class="text-w fw-600">'+o.symbol+'</span></div><span class="badge badge-info">'+o.type+'</span></div>';
      h+='<div class="grid2 mt-3"><div><div class="label">Price</div><div class="val-sm mono">$'+fmt(o.price)+'</div></div><div><div class="label">Quantity</div><div class="val-sm mono">'+o.origQty+'</div></div></div>';
      if(o.executedQty>0){h+='<div class="mt-2"><div class="label">Filled</div><div class="val-xs mono">'+o.executedQty+' / '+o.origQty+'</div></div>'}
      if(o.time){h+='<div class="timestamp">'+new Date(o.time).toLocaleString()+'</div>'}
      h+='<div class="mt-2"><button class="btn btn-outline btn-sm" style="width:100%" onclick="cancelOrder(\\''+o.symbol+'\\','+o.orderId+')">Cancel Order</button></div></div>';
    });
  }
  return h;
}
function loadOrders(){portfolioSubTab='orders';loadPortfolio()}
function renderOrders(){renderPortfolio()}
async function cancelOrder(symbol,orderId){
  const ok=await customConfirm('<div style="font-weight:600;font-size:16px;margin-bottom:12px">Cancel Order</div><div style="font-size:13px;color:#aaa">Cancel order <strong style="color:#fff">#'+orderId+'</strong> on '+symbol+'?</div>');
  if(!ok)return;
  toast('⏳ Cancelling order...','info');
  try{
    const r=await api('/api/miniapp/cancel-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol,orderId})});
    if(r.success){toast('✅ Order cancelled','ok');setTimeout(loadOrders,1500)}
    else{toast('❌ '+(r.error||'Cancel failed'),'err')}
  }catch(e){toast('❌ '+e.message,'err')}
}

function loadMarkets(){switchTab('p-trade')}
function renderMarkets(){}


async function loadDash(){
  const el=$('p-dash');
  el.innerHTML=skeletonCard(4)+skeletonCard(2);
  try{await fetchAll()}catch(e){console.error('loadDash fetch error',e)}
  if(!D.connected&&!D.bscWalletAddress){
    for(var retry=0;retry<3;retry++){
      try{await new Promise(r=>setTimeout(r,2000));await fetchAll();if(D.connected)break}catch(e){}
    }
  }
  if(!D.connected&&fetchErrors>0&&lastFetchErr){
    el.innerHTML='<div class="card" style="text-align:center;padding:30px"><div style="font-size:40px;margin-bottom:12px">⚠️</div><div class="text-w fw-600">Connection Error</div><div class="text-dim text-sm mt-2">'+lastFetchErr+'</div><button class="btn btn-green mt-3" style="width:100%" onclick="loadDash()">↻ Retry</button></div>';
    startAutoRefresh();
    return;
  }
  renderDash();
  startAutoRefresh();
}

function renderDash(){
  const el=$('p-dash');
  if(!D.connected){
    var h2='<div class="card" style="text-align:center;padding:36px 24px">';
    h2+='<div style="font-size:48px;margin-bottom:16px">🔗</div>';
    h2+='<div class="text-w fw-600" style="font-size:16px">Activate Trading</div>';
    h2+='<div class="text-dim text-sm mt-2">One tap to connect and start trading futures.</div>';
    if(D.bscWalletAddress){
      h2+='<div class="text-xs text-dim mt-3">Wallet: <span class="mono" style="color:var(--blue)">'+D.bscWalletAddress.substring(0,8)+'...'+D.bscWalletAddress.slice(-4)+'</span></div>';
      if(D.bscBalance>0||D.bnbBalance>0){
        h2+='<div style="display:flex;gap:12px;justify-content:center;margin-top:8px">';
        h2+='<div><span class="text-xs text-dim">USDT</span><div class="val-xs gv">$'+fmt(D.bscBalance)+'</div></div>';
        h2+='<div><span class="text-xs text-dim">BNB</span><div class="val-xs">'+D.bnbBalance.toFixed(4)+'</div></div>';
        h2+='</div>';
      }
      h2+='<div id="dash-link-status"></div>';
      h2+='<button class="btn btn-green mt-3" style="width:100%" onclick="quickActivateFromDash()">⚡ Quick Connect</button>';
    } else {
      h2+='<div id="dash-link-status"></div>';
      h2+='<button class="btn btn-green mt-3" style="width:100%" onclick="quickActivateFromDash()">⚡ Quick Connect</button>';
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

  var perpAccount=(D.portfolioValue||D.availableMargin||0)+(D.positionMargin||0)+(D.unrealizedPnl||0);
  var totalPnl=(D.unrealizedPnl||0)+(D.realizedPnl||0);

  var accentColor=totalPnl>=0?'14,203,129':'248,81,73';
  h+='<div class="card" style="position:relative;overflow:hidden;border:1px solid '+(totalPnl>=0?'var(--green2)':'rgba(248,81,73,0.3)')+';background:linear-gradient(135deg,rgba('+accentColor+',0.08),transparent)">';
  h+='<div style="position:absolute;top:-20px;right:-20px;width:120px;height:120px;background:radial-gradient(circle,rgba('+accentColor+',0.15),transparent);border-radius:50%"></div>';
  h+='<div class="label" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--text2)">Perpetual Account <span style="font-size:9px;color:#555">'+(D._v||'?')+'</span></div>';
  h+='<div class="val gv" style="font-size:32px;margin:4px 0">$'+fmt(perpAccount)+'</div>';
  h+='<div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap">';
  h+='<div><span class="text-xs text-dim">Available</span><div class="val-xs gv">$'+fmt(D.availableMargin)+'</div></div>';
  h+='<div><span class="text-xs text-dim">In Positions</span><div class="val-xs" style="color:var(--blue)">$'+fmt(D.positionMargin||0)+'</div></div>';
  h+='<div><span class="text-xs text-dim">BSC Wallet</span><div class="val-xs gv">$'+fmt(D.bscBalance)+'</div></div>';
  h+='<div><span class="text-xs text-dim">Unrealized PnL</span><div class="val-xs '+pnlClass(D.unrealizedPnl)+'">'+(D.unrealizedPnl>=0?'+':'')+' $'+fmt(Math.abs(D.unrealizedPnl))+'</div></div>';
  h+='</div></div>';

  var tradingAccentColor=(D.unrealizedPnl||0)>=0?'14,203,129':'248,81,73';
  h+='<div class="card" style="background:linear-gradient(135deg,rgba('+tradingAccentColor+',0.08),rgba('+tradingAccentColor+',0.02))">';
  h+='<div class="section-title">Trading Account</div>';
  h+='<div class="grid3 mt-2">';
  h+='<div style="text-align:center;padding:8px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">Available Margin</div><div class="val-xs gv mt-1">$'+fmt(D.availableMargin)+'</div></div>';
  h+='<div style="text-align:center;padding:8px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">Unrealized PnL</div><div class="val-xs '+pnlClass(D.unrealizedPnl)+' mt-1">'+(D.unrealizedPnl>=0?'+':'')+' $'+fmt(Math.abs(D.unrealizedPnl))+'</div></div>';
  h+='<div style="text-align:center;padding:8px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">Realized PnL</div><div class="val-xs '+pnlClass(D.realizedPnl)+' mt-1">'+(D.realizedPnl>=0?'+':'')+' $'+fmt(Math.abs(D.realizedPnl))+'</div></div>';
  h+='</div>';
  h+='</div>';

  if(HIS&&HIS.pnlSummary){
    var ps=HIS.pnlSummary;
    h+='<div class="card" onclick="switchTab(\\\'p-history\\\')" style="cursor:pointer">';
    h+='<div class="section-title">📊 PnL Summary <span class="text-xs text-dim" style="float:right">tap for details →</span></div>';
    h+='<div class="grid3 mt-2">';
    h+='<div style="text-align:center;padding:8px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">24h</div><div class="val-xs '+pnlClass(ps.day1.pnl)+' mt-1">'+(ps.day1.pnl>=0?'+':'')+' $'+fmt(Math.abs(ps.day1.pnl))+'</div><div class="text-xs text-dim">'+ps.day1.total+' trades</div></div>';
    h+='<div style="text-align:center;padding:8px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">7 Days</div><div class="val-xs '+pnlClass(ps.day7.pnl)+' mt-1">'+(ps.day7.pnl>=0?'+':'')+' $'+fmt(Math.abs(ps.day7.pnl))+'</div><div class="text-xs text-dim">'+ps.day7.total+' trades</div></div>';
    h+='<div style="text-align:center;padding:8px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">All Time</div><div class="val-xs '+pnlClass(ps.allTime.pnl)+' mt-1">'+(ps.allTime.pnl>=0?'+':'')+' $'+fmt(Math.abs(ps.allTime.pnl))+'</div><div class="text-xs text-dim">'+ps.allTime.total+' trades</div></div>';
    h+='</div></div>';
  }

  if(D.positions&&D.positions.length>0){
    h+='<div class="card"><div class="section-title">Open Positions <span class="badge badge-info">'+D.positions.length+'</span></div>';
    D.positions.forEach((p,idx)=>{
      var roe=p.roe||0;
      var liq=parseFloat(p.liquidationPrice||'0');
      var notional=p.notional||(p.size*p.markPrice);
      var margin=p.margin||(parseFloat(p.leverage||'1')>0?notional/parseFloat(p.leverage||'1'):0);
      h+='<div class="pos-item" style="border-left:3px solid '+((p.unrealizedPnl||0)>=0?'var(--green)':'var(--red)')+';padding-left:10px">';
      h+='<div class="row"><div class="gap"><span class="badge '+(p.side==='LONG'?'badge-long':'badge-short')+'">'+p.side+'</span><span class="text-w fw-600 text-sm">'+p.symbol+'</span><span class="text-xs text-dim">'+p.leverage+'x</span></div><div class="gap">'+pnlHtml(p.unrealizedPnl)+'<button onclick="sharePnl('+idx+')" style="background:none;border:1px solid rgba(29,155,240,0.3);border-radius:6px;padding:3px 6px;cursor:pointer;display:flex;align-items:center" title="Share on X"><svg width="12" height="12" viewBox="0 0 24 24" fill="#1d9bf0"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></button></div></div>';
      h+='<div class="row mt-1"><span class="text-xs gv mono">'+p.size+' @ '+fmtPrice(p.entryPrice)+'</span><span class="text-xs mono '+pnlClass(roe)+'">'+(roe>=0?'+':'')+fmt(roe,1)+'% ROE</span></div>';
      h+='<div class="row mt-1"><span class="text-xs gv mono">Mark: '+fmtPrice(p.markPrice)+'</span><span class="text-xs gv mono">Margin: $'+fmt(margin)+'</span></div>';
      if(liq>0){h+='<div class="row mt-1"><span class="text-xs mono" style="color:var(--red)">Liq: $'+fmt(liq)+'</span><span class="text-xs gv mono">'+fmt(Math.abs((p.markPrice-liq)/p.markPrice*100),1)+'% away</span></div>'}
      h+='</div>';
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

  h+='<div class="card" style="text-align:center;border:1px solid rgba(29,155,240,0.2);background:linear-gradient(135deg,rgba(29,155,240,0.06),transparent)">';
  h+='<div class="text-sm fw-600 text-w">Your PnL Card</div>';
  h+='<div class="text-xs text-dim mt-1">Preview your card, then share on X</div>';
  h+='<div id="pnl-card-preview" style="margin:12px auto;max-width:100%;border-radius:10px;overflow:hidden;background:#0b0e11;min-height:120px;position:relative"></div>';
  h+='<div style="display:flex;gap:8px;margin-top:8px">';
  h+='<button class="btn" style="flex:1;background:#1d9bf0;color:#fff;font-weight:700;height:44px;font-size:13px;border-radius:10px;display:flex;align-items:center;justify-content:center;gap:6px" onclick="shareToX()" data-testid="button-share-x"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> Share on X</button>';
  h+='<button class="btn" style="flex:1;background:#2AABEE;color:#fff;font-weight:700;height:44px;font-size:13px;border-radius:10px;display:flex;align-items:center;justify-content:center;gap:6px" onclick="shareToTelegram()" data-testid="button-share-tg"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg> Share on TG</button>';
  h+='</div>';
  h+='<button class="btn btn-outline mt-2" style="width:100%;height:38px;font-size:13px" onclick="downloadPnlCard()" data-testid="button-download-pnl">⬇ Download Image</button>';
  h+='</div>';

  h+='<div style="display:flex;gap:8px;margin-top:8px">';
  h+='<button class="btn btn-outline" style="flex:1" onclick="forceRefresh()">↻ Force Refresh</button>';
  h+='<button class="btn btn-outline" style="flex:0;font-size:10px;padding:8px" onclick="debugBalance()">🔍 Debug</button>';
  h+='</div>';
  h+='<pre id="debug-out" style="display:none;font-size:9px;background:var(--bg);padding:8px;border-radius:8px;overflow-x:auto;max-height:300px;margin-top:8px"></pre>';
  h+='<div class="timestamp">Updated '+timeAgo()+'</div>';
  el.innerHTML=h;
  setTimeout(loadPnlPreview,100);
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
    h+='<div class="text-sm text-dim" style="padding:20px">No wallet yet. Use /start in the bot to create one.</div>';
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
    h+='<div class="text-xs" style="color:var(--text2);line-height:1.7">';
    h+='1. Go to <a href="https://asterdex.com/en/api-wallet" target="_blank" style="color:var(--green)">asterdex.com/en/api-wallet</a><br>';
    h+='2. Log in with your wallet<br>';
    h+='3. Create or view your API Wallet<br>';
    h+='4. Enable <strong style="color:#fff">Perps Trading</strong><br>';
    h+='5. Click <strong style="color:var(--yellow)">"Export Private Key"</strong> to reveal your key<br>';
    h+='6. Copy the private key (starts with <code style="color:var(--yellow)">0x...</code>) and paste below</div>';
    h+='</div>';
    h+='<div class="label mt-2">Your Aster Account Address</div>';
    h+='<div class="text-xs text-dim" style="margin-bottom:4px">The wallet you used to log in to Aster</div>';
    h+='<input id="api-wallet-parent" class="input" placeholder="Your main wallet address (0x06d6...)" autocomplete="off">';
    h+='<div class="label mt-2">API Wallet Private Key</div>';
    h+='<div class="text-xs text-dim" style="margin-bottom:4px">From Aster → API Wallet → Export Private Key</div>';
    h+='<input id="api-wallet-pk" type="password" class="input" placeholder="API Wallet private key (0x...)" autocomplete="off">';
    h+='<button class="btn btn-green mt-2" style="width:100%" onclick="linkAsterApi()">🔗 Link API Wallet</button>';
    h+='<div id="link-status"></div>';
    h+='<div id="manual-link-status"></div>';
    h+='</div>';
    h+='</div>';
  } else if(walletAddr) {
    h+='<div class="card card-accent" style="border:1px solid var(--green);background:linear-gradient(145deg,rgba(14,203,129,0.06),transparent)">';
    h+='<div style="text-align:center;padding:8px 0 16px">';
    h+='<div style="font-size:36px;margin-bottom:8px">🚀</div>';
    h+='<div class="text-w fw-600" style="font-size:16px;margin-bottom:6px">Connect to Aster DEX</div>';
    h+='<div class="text-xs text-dim" style="line-height:1.5;max-width:280px;margin:0 auto">One tap to connect your wallet and start trading futures</div>';
    h+='</div>';
    h+='<button class="btn btn-green" style="width:100%;padding:14px;font-size:15px;font-weight:700;border-radius:12px" onclick="autoLinkAster()">⚡ Quick Connect (1-Click)</button>';
    h+='<div id="link-status"></div>';
    h+='<div class="text-xs text-dim mt-3" style="text-align:center;line-height:1.5">Uses your bot wallet to connect directly to Aster.<br>No external setup needed.</div>';
    h+='</div>';

    h+='<div style="text-align:center;margin-top:8px">';
    h+='<div class="text-xs text-dim" style="cursor:pointer;padding:4px" onclick="showManualLink()">Advanced: <span style="color:var(--text3);text-decoration:underline">connect with API Wallet</span></div>';
    h+='<div id="manual-link-flow" style="display:none;margin-top:8px;text-align:left">';
    h+='<div class="card" style="border:1px solid var(--border)">';
    h+='<div class="text-xs text-dim" style="margin-bottom:8px;line-height:1.5">Only use this if you already have an Aster DEX account with an API Wallet set up.</div>';
    h+='<div class="label mt-2">Aster Account Address</div>';
    h+='<input id="api-wallet-parent" class="input" placeholder="0x... (your main wallet)" autocomplete="off">';
    h+='<div class="label mt-2">API Wallet Private Key</div>';
    h+='<input id="api-wallet-pk" type="password" class="input" placeholder="0x..." autocomplete="off">';
    h+='<button class="btn btn-green mt-2" style="width:100%" onclick="linkAsterApi()">🔗 Connect</button>';
    h+='<div id="manual-link-status"></div>';
    h+='</div>';
    h+='</div>';
    h+='</div>';
  }

  var perpAcctP=D.portfolioValue||(D.walletBalance||0)+(D.unrealizedPnl||0);
  h+='<div class="card" style="background:linear-gradient(135deg,rgba(14,203,129,0.05),transparent)">';
  h+='<div class="section-title">Your Balances</div>';
  h+='<div style="text-align:center;padding:14px;background:var(--green-bg);border-radius:10px;margin-bottom:8px"><div class="text-xs" style="color:var(--green);letter-spacing:1px;text-transform:uppercase">Perpetual Account</div><div class="val" style="font-size:26px;color:#fff;margin-top:4px">$'+fmt(perpAcctP)+'</div></div>';
  h+='<div class="grid3 mt-2">';
  h+='<div style="text-align:center;padding:12px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">Available</div><div class="val-sm text-w mt-1">$'+fmt(D.availableMargin)+'</div></div>';
  h+='<div style="text-align:center;padding:12px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">BSC Wallet</div><div class="val-sm text-w mt-1">$'+fmt(D.bscBalance)+'</div></div>';
  h+='<div style="text-align:center;padding:12px;background:var(--bg);border-radius:8px"><div class="text-xs text-dim2">Spot</div><div class="val-sm text-w mt-1">$'+fmt(D.spotBalance)+'</div></div>';
  h+='</div>';
  if((D.spotBalance||0)>0){
    h+='<div style="margin-top:10px;padding:12px;background:rgba(255,193,7,0.08);border:1px solid rgba(255,193,7,0.3);border-radius:10px">';
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:16px">⚠️</span><span class="text-xs fw-600" style="color:var(--yellow)">You have $'+fmt(D.spotBalance)+' stuck in Spot</span></div>';
    h+='<div class="text-xs text-dim" style="line-height:1.5;margin-bottom:10px">Our bot trades on <strong style="color:#fff">Futures</strong> only. Spot balance cannot be used for trading. Transfer it now:</div>';
    h+='<button class="btn btn-green" style="width:100%" onclick="spotToFutures()">Transfer $'+fmt(D.spotBalance)+' Spot → Futures</button>';
    h+='<div id="stf-status"></div>';
    h+='</div>';
  }
  h+='</div>';

  if(!D.asterApiWallet){
    h+='<div class="card" style="border:1px solid rgba(14,203,129,0.3)">';
    h+='<div class="section-title" style="color:var(--green)">📋 Get Started in 3 Steps</div>';
    h+='<div class="text-xs" style="color:var(--text2);line-height:1.8;margin-bottom:4px">';
    h+='<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px"><span style="background:var(--green);color:#000;border-radius:50%;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">1</span><span>Tap <strong style="color:var(--green)">⚡ Quick Connect</strong> above — automatic, no setup needed</span></div>';
    h+='<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px"><span style="background:var(--green);color:#000;border-radius:50%;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">2</span><span>Send <strong style="color:#fff">USDT (BEP-20)</strong> to your wallet address, then tap <strong style="color:#fff">Deposit to Aster</strong></span></div>';
    h+='<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px"><span style="background:var(--green);color:#000;border-radius:50%;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">3</span><span>Go to <strong style="color:#fff">Agent</strong> tab and start trading!</span></div>';
    h+='</div>';
    h+='<div style="background:rgba(255,193,7,0.08);border-radius:8px;padding:10px;margin-top:4px">';
    h+='<div class="text-xs" style="color:var(--yellow);line-height:1.5">💡 If your balance shows $0 after depositing, your funds may be in <strong>Spot</strong> not <strong>Futures</strong>. Use the <strong>Spot → Futures</strong> transfer button below.</div>';
    h+='</div></div>';
  }

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

  h+='<div class="card" style="border:1px solid rgba(100,149,237,0.3)">';
  h+='<div class="section-title" style="color:var(--blue)">🔄 Transfer Spot → Futures</div>';
  h+='<div class="text-xs text-dim" style="line-height:1.5;margin-bottom:10px">If you deposited on the Aster website, your USDT lands in <strong style="color:#fff">Spot</strong> by default. Our bot trades on <strong style="color:var(--green)">Futures</strong> — you must transfer first.</div>';
  if((D.spotBalance||0)>0){
    h+='<button class="btn btn-green" style="width:100%" onclick="spotToFutures()">Transfer $'+fmt(D.spotBalance)+' Spot → Futures</button>';
  } else {
    h+='<button class="btn btn-outline" style="width:100%" onclick="spotToFutures()">🔄 Check & Transfer Spot → Futures</button>';
  }
  h+='<div id="stf-status2"></div>';
  h+='<div class="text-xs text-dim mt-2" style="line-height:1.4">You can also transfer on the Aster website: <a href="https://asterdex.com/en/assets" target="_blank" style="color:var(--blue)">Assets</a> → Transfer → Spot to Futures</div>';
  h+='</div>';

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


var _pnlBaseUrl='https://build4.io';

function getPnlParams(posIdx){
  var agentName=(AG&&AG.config&&AG.config.name)?AG.config.name:'Trader';
  var ref='build4';
  if(typeof posIdx==='number'&&D.positions&&D.positions[posIdx]){
    var p=D.positions[posIdx];
    var pnlVal=parseFloat(p.unrealizedPnl||0);
    var entryP=parseFloat(p.entryPrice||0);
    var markP=parseFloat(p.markPrice||0);
    var side=p.side||'LONG';
    var lev=parseInt(p.leverage||5);
    var pctVal=p.roe!==undefined?p.roe:(entryP>0?((markP-entryP)/entryP*100*(side==='SHORT'?-1:1)*lev):0);
    var sym=p.symbol||'BTCUSDT';
    var pSign=pnlVal>=0?'+':'';
    return{
      imgParams:'pct='+pctVal.toFixed(2)+'&pnl='+pnlVal.toFixed(2)+'&sym='+encodeURIComponent(sym)+'&side='+side+'&lev='+lev+'&ep='+entryP+'&mp='+markP+'&name='+encodeURIComponent(agentName)+'&ref='+ref,
      tweetText:pSign+pctVal.toFixed(2)+'% on '+sym+' ('+side+' '+lev+'x)\\n\\nTrade on @Aster_DEX',
      tgText:pSign+pctVal.toFixed(2)+'% on '+sym+' ('+side+' '+lev+'x)\\n\\nTrade on Aster DEX',
      ref:ref
    };
  }
  var totalPnl=(D.unrealizedPnl||0)+(D.realizedPnl||0);
  var walBal=D.walletBalance||0;
  var initialCap=walBal-totalPnl;
  var overallPct=initialCap>0?(totalPnl/initialCap*100):0;
  var pSign2=totalPnl>=0?'+':'';
  var txt=pSign2+'$'+Math.abs(totalPnl).toFixed(2)+' PnL trading futures on @Aster_DEX';
  var tgTxt=pSign2+'$'+Math.abs(totalPnl).toFixed(2)+' PnL trading futures on Aster DEX';
  return{
    imgParams:'pct='+overallPct.toFixed(2)+'&pnl='+totalPnl.toFixed(2)+'&pos='+((D.positions||[]).length)+'&name='+encodeURIComponent(agentName)+'&ref='+ref,
    tweetText:txt,
    tgText:tgTxt,
    ref:ref
  };
}

function loadPnlPreview(posIdx){
  var el=document.getElementById('pnl-card-preview');
  if(!el)return;
  var pp=getPnlParams(posIdx);
  var params=new URLSearchParams(pp.imgParams);
  var pct=parseFloat(params.get('pct')||'0');
  var pnlUsd=parseFloat(params.get('pnl')||'0');
  var sym=params.get('sym')||'';
  var side=params.get('side')||'';
  var lev=params.get('lev')||'';
  var ep=parseFloat(params.get('ep')||'0');
  var mp=parseFloat(params.get('mp')||'0');
  var name=params.get('name')||'Trader';
  var ref=params.get('ref')||'build4';
  var isProfit=pct>=0;
  var pnlColor=isProfit?'#0ecb81':'#f6465d';
  var accentRgb=isProfit?'14,203,129':'246,70,93';
  var sideColor=side==='LONG'?'#0ecb81':'#f6465d';

  var hasTrade=sym&&ep>0;
  var pctText=(isProfit?'+':'')+pct.toFixed(2)+'%';
  var pnlSign=pnlUsd>=0?'+':'';
  var fP=function(v){return v>=1?v.toLocaleString('en-US',{maximumFractionDigits:2}):v.toPrecision(4)};
  var h='<div style="background:#0b0e11;border-radius:10px;padding:20px;position:relative;overflow:hidden;border-top:3px solid '+pnlColor+'">';
  h+='<div style="position:absolute;top:0;left:15%;width:200px;height:200px;background:radial-gradient(circle,rgba('+accentRgb+',0.12),transparent);border-radius:50%"></div>';
  h+='<div style="position:relative;z-index:1">';
  h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h+='<div style="font-family:monospace;font-size:18px;font-weight:900;color:#fff;letter-spacing:2px">BUILD4</div>';
  h+='<div style="font-size:10px;color:#555;padding:4px 8px;border:1px solid rgba(255,255,255,0.08);border-radius:6px">ASTER DEX FUTURES</div>';
  h+='</div>';
  if(hasTrade){
    h+='<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">';
    h+='<span style="background:'+sideColor+'22;color:'+sideColor+';padding:3px 10px;border-radius:5px;font-size:12px;font-weight:700">'+side+'</span>';
    h+='<span style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);padding:3px 8px;border-radius:5px;font-family:monospace;font-size:12px;color:#ccc">'+lev+'x</span>';
    h+='<span style="font-size:14px;font-weight:700;color:#fff">'+sym+'</span>';
    h+='</div>';
  } else {
    h+='<div style="font-size:14px;font-weight:600;color:#8a919e;margin-bottom:12px">Overall Performance</div>';
  }
  h+='<div style="font-family:monospace;font-size:42px;font-weight:900;color:'+pnlColor+';letter-spacing:-2px;line-height:1.1">'+pctText+'</div>';
  h+='<div style="font-family:monospace;font-size:16px;color:'+pnlColor+';opacity:0.85;margin-top:4px">'+pnlSign+'$'+Math.abs(pnlUsd).toFixed(2)+' USDT</div>';
  if(hasTrade){
    h+='<div style="display:flex;gap:8px;margin-top:12px">';
    h+='<div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:#555;letter-spacing:1px">ENTRY</div><div style="font-family:monospace;font-size:14px;font-weight:700;color:#fff;margin-top:2px">$'+fP(ep)+'</div></div>';
    h+='<div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:#555;letter-spacing:1px">MARK</div><div style="font-family:monospace;font-size:14px;font-weight:700;color:#fff;margin-top:2px">$'+fP(mp)+'</div></div>';
    h+='</div>';
  }
  h+='<div style="margin-top:12px;padding:8px 12px;background:rgba('+accentRgb+',0.05);border:1px solid rgba('+accentRgb+',0.15);border-radius:8px"><div style="font-size:8px;color:#555;letter-spacing:1px">JOIN</div><div style="font-family:monospace;font-size:12px;font-weight:700;color:rgba('+accentRgb+',0.9)">t.me/build4_bot?start='+ref+'</div></div>';
  h+='<div style="margin-top:8px;font-size:10px;color:#444;border-top:1px solid rgba(255,255,255,0.04);padding-top:8px">'+name+' · Autonomous AI Futures Trading</div>';
  h+='</div></div>';
  el.innerHTML=h;
}

function shareToX(posIdx){
  var pp=getPnlParams(posIdx);
  var pnlPageUrl=_pnlBaseUrl+'/pnl?'+pp.imgParams;
  var tweetUrl='https://x.com/intent/tweet?text='+encodeURIComponent(pp.tweetText)+
    '&url='+encodeURIComponent(pnlPageUrl);
  window.open(tweetUrl,'_blank');
}
function shareToTelegram(posIdx){
  var pp=getPnlParams(posIdx);
  var pnlPageUrl=_pnlBaseUrl+'/pnl?'+pp.imgParams;
  var shareUrl='https://t.me/share/url?url='+encodeURIComponent(pnlPageUrl)+
    '&text='+encodeURIComponent(pp.tgText);
  window.open(shareUrl,'_blank');
}

async function downloadPnlCard(posIdx){
  var pp=getPnlParams(posIdx);
  toast('Generating image...','info');
  try{
    var baseUrl=location.origin||_pnlBaseUrl;
    var resp=await fetch(baseUrl+'/pnl/image?'+pp.imgParams);
    if(!resp.ok)throw new Error('Image generation failed ('+resp.status+')');
    var blob=await resp.blob();
    var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='build4-pnl.png';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Image downloaded!','ok');
  }catch(e){
    toast('Download failed: '+e.message,'err');
  }
}

async function sharePnl(posIdx){
  shareToX(posIdx);
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
  var st=document.getElementById('stf-status')||document.getElementById('stf-status2');
  if(!st){toast('Transferring Spot to Futures...','info');st={innerHTML:''}}
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Transferring Spot → Futures...</span></div>';
  var st2=document.getElementById('stf-status2');
  if(st2&&st2!==st)st2.innerHTML=st.innerHTML;
  try{
    var r=await api('/api/miniapp/spot-to-futures',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    if(r.success){
      var msg='<div class="alert alert-ok mt-3"><span>🎉</span><span>'+(r.message||'Transferred!')+'</span></div>';
      st.innerHTML=msg;
      if(st2&&st2!==st)st2.innerHTML=msg;
      toast('🎉 Funds moved to Futures!','ok');
      setTimeout(function(){fetchAll().then(function(){renderDeposit()})},3000);
    }else{
      var emsg='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Transfer failed')+'</span></div>';
      st.innerHTML=emsg;
      if(st2&&st2!==st)st2.innerHTML=emsg;
    }
  }catch(e){
    var emsg2='<div class="alert alert-err mt-3"><span>❌</span><span>'+e.message+'</span></div>';
    st.innerHTML=emsg2;
    if(st2&&st2!==st)st2.innerHTML=emsg2;
  }
}

function showLinkFlow(){
  var el=$('link-flow');
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

function showManualLink(){
  var el=$('manual-link-flow');
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

async function quickActivateFromDash(){
  var st=$('dash-link-status');
  if(!st){switchTab('deposit');return}
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Setting up your trading account...</span></div>';
  try{
    var walletAddr=D.bscWalletAddress||'';
    var r=await api('/api/miniapp/quick-activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({walletAddress:walletAddr})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3"><span>✅</span><span><strong>Connected!</strong> Loading your account...</span></div>';
      toast('✅ Connected to Aster!','ok');
      D.asterApiWallet=r.signerAddress||'auto';
      setTimeout(function(){fetchAll().then(function(){renderDash();renderDeposit()})},3000);
    }else{
      st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Activation failed.')+'</span></div>';
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+e.message+'</span></div>';
  }
}

async function autoLinkAster(){
  var st=$('link-status');
  if(!st)return;
  st.innerHTML='<div class="alert alert-info mt-3"><span>⏳</span><span>Setting up your trading account...</span></div>';
  try{
    var walletAddr=D.bscWalletAddress||'';
    var r=await api('/api/miniapp/quick-activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({walletAddress:walletAddr})});
    if(r.success){
      st.innerHTML='<div class="alert alert-ok mt-3"><span>✅</span><span><strong>'+(r.alreadyActive?'Already activated!':'Connected to Aster!')+'</strong> '+(r.message||'Your account is ready to trade.')+'</span></div>';
      toast('✅ Connected to Aster!','ok');
      D.asterApiWallet=r.signerAddress||'auto';
      setTimeout(function(){fetchAll().then(function(){renderDeposit();renderDash()})},3000);
    }else{
      st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>'+(r.error||'Activation failed. Please try again.')+'</span></div>';
    }
  }catch(e){
    st.innerHTML='<div class="alert alert-err mt-3"><span>❌</span><span>Connection failed: '+e.message+'. Please try again.</span></div>';
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

function loadHistory(){portfolioSubTab='history';loadPortfolio()}
function renderHistory(){renderPortfolio()}

function renderHistoryHTML(){
  if(!HIS){return '<div class="card" style="text-align:center;padding:40px"><div style="font-size:36px">📊</div><div class="text-w fw-600 mt-2">Loading History...</div></div>'}
  let h='';
  const ps=HIS.pnlSummary;

  h+='<div class="section-title" style="font-size:16px">PnL Overview</div>';
  h+='<div class="card"><div style="display:flex;gap:8px;margin-bottom:12px">';
  h+='<button class="btn btn-sm" id="pnl-tab-1d" onclick="setPnlTab(1)" style="flex:1;font-size:12px;padding:6px">24h</button>';
  h+='<button class="btn btn-sm" id="pnl-tab-7d" onclick="setPnlTab(7)" style="flex:1;font-size:12px;padding:6px">7 Days</button>';
  h+='<button class="btn btn-sm btn-green" id="pnl-tab-all" onclick="setPnlTab(0)" style="flex:1;font-size:12px;padding:6px">All Time</button>';
  h+='</div>';

  function pnlBlock(s,label){
    var pnlColor=s.pnl>=0?'14,203,129':'248,81,73';
    return '<div id="pnl-block-'+label+'" style="display:'+(label==='all'?'block':'none')+'">'+
    '<div style="text-align:center;padding:16px;background:linear-gradient(135deg,rgba('+pnlColor+',0.1),transparent);border-radius:10px;border:1px solid rgba('+pnlColor+',0.2)">'+
    '<div class="text-xs text-dim2" style="text-transform:uppercase;letter-spacing:1px">Realized PnL</div>'+
    '<div class="val '+(s.pnl>=0?'gv':'r-')+'" style="font-size:28px;margin:6px 0">'+(s.pnl>=0?'+':'-')+'$'+fmt(Math.abs(s.pnl))+'</div>'+
    '<div style="display:flex;justify-content:center;gap:16px;margin-top:8px">'+
    '<div><div class="text-xs text-dim2">Trades</div><div class="val-xs text-w">'+s.total+'</div></div>'+
    '</div></div></div>';
  }
  h+=pnlBlock(ps.day1,'1d');
  h+=pnlBlock(ps.day7,'7d');
  h+=pnlBlock(ps.allTime,'all');
  h+='</div>';

  if(HIS.closedTrades&&HIS.closedTrades.length>0){
    h+='<div class="card"><div class="section-title">Position History <span class="badge badge-info">'+HIS.closedTrades.length+'</span></div>';
    HIS.closedTrades.forEach(function(t){
      var isWin=t.pnl>=0;
      var sideClass=t.side==='LONG'||t.side==='BUY'?'badge-long':'badge-short';
      var sideLabel=t.side==='BUY'?'LONG':t.side==='SELL'?'SHORT':t.side;
      var timeStr='';
      if(t.closedAt){var d=new Date(t.closedAt);timeStr=d.getFullYear()+'-'+(''+(d.getMonth()+1)).padStart(2,'0')+'-'+(''+(d.getDate())).padStart(2,'0')+' '+(''+(d.getHours())).padStart(2,'0')+':'+(''+(d.getMinutes())).padStart(2,'0')}
      h+='<div style="border-left:3px solid '+(isWin?'var(--green)':'var(--red)')+';padding:10px 0 10px 12px;margin-bottom:10px;background:rgba('+(isWin?'14,203,129':'248,81,73')+',0.03);border-radius:0 8px 8px 0">';
      h+='<div class="row"><div class="gap"><span class="text-w fw-600 text-sm">'+t.symbol+'</span><span class="badge '+sideClass+'" style="font-size:9px">'+sideLabel+(t.leverage>0?' · '+t.leverage+'x':'')+'</span><span class="badge" style="background:rgba(14,203,129,0.1);color:var(--green);font-size:9px">Closed</span></div>';
      h+='<div style="text-align:right"><span class="val-xs '+(isWin?'gv':'r-')+' fw-600">'+(isWin?'+':'')+fmt(t.pnl,2)+' USDT</span>';
      if(t.pctPnl!==0){h+='<div class="text-xs '+(isWin?'gv':'r-')+'">'+(t.pctPnl>=0?'+':'')+fmt(t.pctPnl,2)+'%</div>'}
      h+='</div></div>';
      if(t.entryPrice>0||t.exitPrice>0){
        h+='<div class="grid2 mt-2">';
        h+='<div><div class="text-xs text-dim2">Entry Price</div><div class="text-xs mono text-w mt-1">'+fmtPrice(t.entryPrice)+'</div></div>';
        h+='<div><div class="text-xs text-dim2">Avg. Close Price</div><div class="text-xs mono text-w mt-1">'+fmtPrice(t.exitPrice)+'</div></div>';
        h+='</div>';
      }
      h+='<div class="grid2 mt-2">';
      if(t.quantity>0){h+='<div><div class="text-xs text-dim2">Closed</div><div class="text-xs mono text-w mt-1">'+fmt(t.quantity,4)+' '+t.symbol.replace('USDT','')+'</div></div>'}
      if(timeStr){h+='<div><div class="text-xs text-dim2">Time Closed</div><div class="text-xs mono text-w mt-1">'+timeStr+'</div></div>'}
      h+='</div>';
      h+='</div>';
    });
    h+='</div>';
  }else{
    h+='<div class="card" style="text-align:center;padding:30px"><div style="font-size:36px;margin-bottom:8px">📭</div><div class="text-dim text-sm">No closed trades yet. Start the AI agent to begin trading.</div></div>';
  }
  return h;
}

function setPnlTab(n){
  ['1d','7d','all'].forEach(function(k){
    var bl=$('pnl-block-'+k);
    var bt=$('pnl-tab-'+k);
    if(bl)bl.style.display='none';
    if(bt){bt.classList.remove('btn-green');bt.classList.add('btn-outline')}
  });
  var key=n===1?'1d':n===7?'7d':'all';
  var bl=$('pnl-block-'+key);
  var bt=$('pnl-tab-'+key);
  if(bl)bl.style.display='block';
  if(bt){bt.classList.remove('btn-outline');bt.classList.add('btn-green')}
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

  var agentName=c?.name||'My Agent';
  h+='<div class="card '+(r?'card-accent':'')+'"><div class="row"><div class="gap"><div style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;background:'+(r?'var(--green-bg)':'var(--bg)')+'">🧠</div><div><div class="text-w fw-600" style="cursor:pointer" onclick="renameAgent()" id="agent-name-display">'+agentName+'</div><div class="gap mt-1"><div class="live-dot" style="'+(r?'':'animation:none;background:var(--text3)')+'"></div><span class="text-xs '+(r?'gv':'text-dim')+'">'+(r?'AI-Powered — Multi-Timeframe':'Stopped')+'</span></div></div></div><div class="switch'+(r?' on':'')+'" onclick="toggleAgent()"></div></div>';
  if(r&&c){
    h+='<div class="gap mt-3" style="flex-wrap:wrap"><span class="badge badge-info">📊 All pairs</span><span class="badge badge-info">'+c.maxLeverage+'x max</span><span class="badge badge-warn">'+c.riskPercent+'% risk</span><span class="badge badge-long">'+(c.maxOpenPositions||2)+' max pos</span></div>';
    h+='<div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">';
    h+='<div style="padding:8px;background:'+(s.dailyPnl>=0?'#0ecb8118':'#f6465d18')+';border-radius:8px;text-align:center"><div class="text-xs text-dim2">Daily PnL</div><div class="text-sm fw-600 '+(s.dailyPnl>=0?'gv':'r-')+'">'+(s.dailyPnl>=0?'+':'')+' $'+(Math.abs(s.dailyPnl||0)).toFixed(2)+'</div></div>';
    h+='<div style="padding:8px;background:var(--bg);border-radius:8px;text-align:center"><div class="text-xs text-dim2">Streak</div><div class="text-sm fw-600 '+((s.consecutiveLosses||0)>0?'r-':'gv')+'">'+((s.consecutiveLosses||0)>0?s.consecutiveLosses+' losses':'Clean')+'</div></div>';
    h+='<div style="padding:8px;background:'+(s.circuitBreakerActive?'#f6465d18':'var(--bg)')+';border-radius:8px;text-align:center"><div class="text-xs text-dim2">Safety</div><div class="text-sm fw-600 '+(s.circuitBreakerActive?'r-':'gv')+'">'+(s.circuitBreakerActive?'⏸ Paused':'✅ Active')+'</div></div>';
    h+='</div>';
  }
  h+='</div>';

  if(r&&s&&s.lastReasoning){
    h+='<div class="card"><div class="section-title">🧠 Live Reasoning</div>';
    h+='<div style="padding:10px;background:#1e2328;border-radius:8px;border-left:3px solid var(--blue)">';
    h+='<div class="text-sm text-w" style="line-height:1.5;font-style:italic">'+s.lastReasoning+'</div>';
    if(s.lastAction){h+='<div class="text-xs text-dim mt-2">'+s.lastAction+'</div>'}
    h+='</div>';
    if(s.reasoningLog&&s.reasoningLog.length>0){
      h+='<div class="mt-3"><div class="text-xs text-dim2 mb-2">Recent Decisions</div>';
      s.reasoningLog.slice().reverse().slice(0,5).forEach(function(log){
        var color=log.action.includes('OPEN')?'var(--green)':log.action==='HOLD'?'var(--text3)':'var(--blue)';
        var ago=Math.round((Date.now()-log.ts)/60000);
        h+='<div style="padding:6px 8px;margin-bottom:4px;background:var(--bg);border-radius:6px;border-left:2px solid '+color+'">';
        h+='<div class="row"><span class="text-xs fw-600" style="color:'+color+'">'+log.symbol+' '+log.action+'</span><span class="text-xs text-dim">'+ago+'m ago</span></div>';
        h+='<div class="text-xs text-dim mt-1" style="line-height:1.4">'+log.reasoning.substring(0,120)+'</div>';
        if(log.confidence>0){h+='<div class="text-xs mt-1" style="color:'+color+'">Confidence: '+log.confidence+'%</div>'}
        h+='</div>';
      });
      h+='</div>';
    }
    h+='</div>';
  }

  if(r&&s&&s.positionDetails&&s.positionDetails.length>0){
    h+='<div class="card"><div class="section-title">📍 Open Positions</div>';
    s.positionDetails.forEach(function(p){
      var icon=p.side==='LONG'?'🟢':'🔴';
      h+='<div style="padding:10px;background:var(--bg);border-radius:8px;margin-bottom:8px">';
      h+='<div class="row"><span class="text-sm fw-600 text-w">'+icon+' '+p.side+' '+p.symbol+'</span><span class="badge badge-info">'+p.leverage+'x</span></div>';
      h+='<div class="row text-xs mt-2"><span class="text-dim">Entry</span><span class="mono text-w">$'+(p.entryPrice||0).toFixed(2)+'</span></div>';
      h+='<div class="row text-xs mt-1"><span class="text-dim">Stop Loss</span><span class="mono r-">-'+(p.stopLoss||0).toFixed(1)+'%</span></div>';
      h+='<div class="row text-xs mt-1"><span class="text-dim">Take Profit</span><span class="mono gv">+'+(p.takeProfit||0).toFixed(1)+'%</span></div>';
      if(p.reasoning){h+='<div class="text-xs text-dim mt-2" style="font-style:italic;line-height:1.4;border-top:1px solid #333;padding-top:6px">'+p.reasoning.substring(0,150)+'</div>'}
      h+='</div>';
    });
    h+='</div>';
  }

  if(!r){
    h+='<div class="card"><div class="section-title">🎯 Strategy</div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">';
    var presets=[
      {key:'conservative',icon:'🛡',label:'Conservative',color:'#3b82f6',desc:'0.5% risk, 5x leverage, 1 position'},
      {key:'balanced',icon:'⚖️',label:'Balanced',color:'#f59e0b',desc:'1% risk, 10x leverage, 2 positions'},
      {key:'degen',icon:'🔥',label:'Aggressive',color:'#ef4444',desc:'1% risk, 15x leverage, 3 positions'}
    ];
    var curPreset=detectPreset(c);
    presets.forEach(function(p){
      var isActive=curPreset===p.key;
      h+='<button onclick="applyPreset(\\''+p.key+'\\')" style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 6px;border-radius:10px;border:1px solid '+(isActive?p.color+'66':'#333')+';background:'+(isActive?p.color+'18':'#1a1d21')+';cursor:pointer;position:relative">';
      h+='<span style="font-size:20px">'+p.icon+'</span>';
      h+='<span style="font-size:11px;font-weight:700;color:'+(isActive?p.color:'#999')+'">'+p.label+'</span>';
      if(isActive)h+='<div style="position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:'+p.color+'"></div>';
      h+='</button>';
    });
    h+='</div>';
    if(curPreset){var cp=presets.find(function(p){return p.key===curPreset});if(cp)h+='<div class="text-xs mt-2" style="color:'+cp.color+';padding:6px 10px;background:'+cp.color+'15;border-radius:6px">'+cp.desc+'</div>'}
    h+='</div>';
  }

  h+='<div class="card"><div class="section-title">⚙️ Configuration</div>';
  h+='<div class="alert alert-info mb-3"><span>🧠</span><span>AI analyzes all USDT pairs across 3 timeframes (5m/15m/1h) with focused per-pair analysis. Strict risk rules enforced at code level — max 1% risk, hard stop-loss, daily loss limit, circuit breakers.</span></div>';
  h+='<div class="row text-sm mt-3"><span class="text-dim">Risk Per Trade</span><span class="mono text-w fw-600">'+(c?.riskPercent||1)+'%</span></div>';
  h+='<div class="slider-track" onclick="setRisk(event)"><div class="slider-fill" style="width:'+((c?.riskPercent||0.5)/1*100)+'%"></div><div class="slider-thumb" style="left:'+((c?.riskPercent||0.5)/1*100)+'%"></div></div>';
  h+='<div class="row text-xs text-dim2"><span>0.1% (Ultra Safe)</span><span>1.0% (Max)</span></div>';
  h+='<div class="row text-sm mt-3"><span class="text-dim">Max Leverage</span><span class="mono text-w fw-600">'+(c?.maxLeverage||10)+'x</span></div>';
  h+='<div class="row text-sm mt-3"><span class="text-dim">Max Open Positions</span><span class="mono text-w fw-600">'+(c?.maxOpenPositions||2)+'</span></div>';
  h+='<div style="display:flex;gap:6px;margin-top:6px">';
  [1,2,3].forEach(function(n){h+='<button class="btn btn-sm '+((c?.maxOpenPositions||2)===n?'btn-green':'btn-outline')+'" style="font-size:12px;padding:4px 10px" onclick="setMaxPositions('+n+')">'+n+'</button>'});
  h+='</div>';
  h+='<div class="row text-sm mt-3"><span class="text-dim">Daily Loss Limit</span><span class="mono r-">-'+(c?.dailyLossLimitPct||3)+'%</span></div>';

  h+='<div style="margin-top:16px;padding:12px;background:var(--bg);border-radius:10px"><div class="text-xs text-dim2 fw-600" style="margin-bottom:6px">🔒 Safety Rules (Always Active)</div>';
  h+='<div class="text-xs text-dim" style="line-height:1.8">✅ Max 1% risk per trade (enforced)<br>✅ Hard stop-loss on every trade<br>✅ 3 consecutive losses → 30min pause<br>✅ 5min cooldown after closing (no revenge trading)<br>✅ Daily loss limit stops all trading<br>✅ Multi-timeframe trend confirmation required</div></div>';

  h+='</div>';

  if(D.availableMargin>0&&D.availableMargin<10){h+='<div class="alert alert-warn mb-3"><span>⚠️</span><span>Futures margin is below $10. The agent requires at least $10 for safety.</span></div>'}

  if(s){
    const wr=s.winCount+s.lossCount>0?Math.round(s.winCount/(s.winCount+s.lossCount)*100):0;
    h+='<div class="card"><div class="section-title">📊 Performance</div><div class="grid2">';
    h+='<div style="padding:10px;background:var(--bg);border-radius:8px;text-align:center"><div class="text-xs text-dim2">Total Trades</div><div class="val-sm text-w mt-1">'+s.tradeCount+'</div></div>';
    h+='<div style="padding:10px;background:var(--bg);border-radius:8px;text-align:center"><div class="text-xs text-dim2">Win Rate</div><div class="val-sm '+(wr>=50?'gv':'r-')+' mt-1">'+wr+'%</div></div>';
    h+='<div style="padding:10px;background:var(--bg);border-radius:8px;text-align:center"><div class="text-xs text-dim2">Total PnL</div><div class="val-sm '+pnlClass(s.totalPnl)+' mt-1">'+(s.totalPnl>=0?'+':'')+' $'+fmt(Math.abs(s.totalPnl))+'</div></div>';
    h+='<div style="padding:10px;background:var(--bg);border-radius:8px;text-align:center"><div class="text-xs text-dim2">W / L</div><div class="val-sm text-w mt-1"><span class="gv">'+s.winCount+'</span> / <span class="r-">'+s.lossCount+'</span></div></div>';
    h+='</div>';
    if(s.scanCount){h+='<div class="text-xs text-dim mt-2" style="text-align:right">Scans: '+s.scanCount+'</div>'}
    h+='</div>';
  }

  var L=AG.learning;
  if(L&&L.totalTrades>0){
    h+='<div class="card"><div class="section-title">🧬 Adaptive Learning</div>';
    h+='<div style="padding:10px;background:#0ecb8110;border-radius:8px;border-left:3px solid var(--green);margin-bottom:10px">';
    h+='<div class="text-xs text-dim2">The agent learns from every trade. It adjusts confidence thresholds per pair, avoids poor trading hours, adapts to market regimes, and blocks correlated positions.</div>';
    h+='</div>';
    h+='<div class="row text-sm"><span class="text-dim">Total Trades Learned</span><span class="mono text-w fw-600">'+L.totalTrades+'</span></div>';
    h+='<div class="row text-sm mt-1"><span class="text-dim">Overall Win Rate</span><span class="mono '+(L.overallWinRate>=0.5?'gv':'r-')+' fw-600">'+(L.overallWinRate*100).toFixed(1)+'%</span></div>';

    var thKeys=Object.keys(L.symbolThresholds||{});
    if(thKeys.length>0){
      h+='<div class="mt-3"><div class="text-xs text-dim2 fw-600 mb-2">Per-Symbol Confidence Thresholds</div>';
      thKeys.forEach(function(sym){
        var th=L.symbolThresholds[sym];
        var isRaised=th>70;var isLowered=th<70;
        var color=isRaised?'#f6465d':isLowered?'#0ecb81':'var(--text3)';
        var label=isRaised?' (raised)':isLowered?' (lowered)':'';
        h+='<div class="row text-xs" style="padding:3px 0"><span class="mono text-w">'+sym.replace('USDT','')+'</span><span class="mono" style="color:'+color+'">'+th+'%'+label+'</span></div>';
      });
      h+='</div>';
    }

    if(L.blockedHours&&L.blockedHours.length>0){
      h+='<div class="mt-3"><div class="text-xs text-dim2 fw-600 mb-1">🚫 Blocked Hours (UTC)</div>';
      h+='<div class="text-xs r-">'+L.blockedHours.sort(function(a,b){return a-b}).map(function(h){return h+':00'}).join(', ')+'</div>';
      h+='<div class="text-xs text-dim mt-1">Agent skips these hours due to &lt;30% historical win rate</div>';
      h+='</div>';
    }
    if(L.bestHours&&L.bestHours.length>0){
      h+='<div class="mt-2"><div class="text-xs text-dim2 fw-600 mb-1">✅ Best Hours (UTC)</div>';
      h+='<div class="text-xs gv">'+L.bestHours.sort(function(a,b){return a-b}).map(function(h){return h+':00'}).join(', ')+'</div>';
      h+='</div>';
    }

    var regKeys=Object.keys(L.regimePerformance||{});
    if(regKeys.length>0){
      h+='<div class="mt-3"><div class="text-xs text-dim2 fw-600 mb-2">Regime Performance</div>';
      regKeys.forEach(function(reg){
        var rp=L.regimePerformance[reg];
        var wr=(rp.winRate*100).toFixed(0);
        h+='<div class="row text-xs" style="padding:3px 0"><span class="text-w">'+reg+'</span><span class="mono '+(rp.winRate>=0.5?'gv':'r-')+'">'+wr+'% ('+rp.total+' trades)</span></div>';
      });
      h+='</div>';
    }

    h+='<div class="mt-3"><div class="text-xs text-dim2 fw-600 mb-2">Correlation Groups</div>';
    h+='<div class="text-xs text-dim" style="line-height:1.6">';
    (L.correlationGroups||[]).forEach(function(g){
      if(g.length>1) h+=g.map(function(s){return s.replace('USDT','')}).join(' ↔ ')+'<br>';
    });
    h+='</div>';
    h+='<div class="text-xs text-dim mt-1">Agent blocks same-direction entries on correlated pairs</div>';
    h+='</div>';

    h+='</div>';
  }

  el.innerHTML=h;
}

function detectPreset(c){
  if(!c)return null;
  if(c.riskPercent<=0.5&&c.maxLeverage<=5&&c.maxOpenPositions<=1)return'conservative';
  if(c.riskPercent>=1&&c.maxLeverage>=15&&c.maxOpenPositions>=3)return'degen';
  if(c.riskPercent>=0.8&&c.riskPercent<=1&&c.maxLeverage>=8&&c.maxLeverage<=12)return'balanced';
  return null;
}
async function applyPreset(key){
  if(AG&&AG.running){toast('Stop the agent before changing strategy','err');return}
  try{
    var r=await api('/api/miniapp/agent/preset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preset:key})});
    if(r.success){
      AG.config=r.config;
      var labels={conservative:'Conservative 🛡',balanced:'Balanced ⚖️',degen:'Degen 🔥'};
      toast('Strategy set to '+labels[key],'ok');
      renderAgent();
    }else{toast(r.error||'Failed','err')}
  }catch(e){toast('Error applying preset','err')}
}
function setRisk(e){
  const r=e.currentTarget.getBoundingClientRect();
  const pct=Math.max(0.1,Math.min(1.0,((e.clientX-r.left)/r.width)*1.0));
  const rounded=Math.round(pct*10)/10;
  if(AG&&AG.config)AG.config.riskPercent=rounded;
  api('/api/miniapp/agent/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({riskPercent:rounded})}).catch(function(){});
  renderAgent();
}
async function renameAgent(){
  if(AG&&AG.running){toast('Stop the agent first','err');return}
  var cur=(AG&&AG.config&&AG.config.name)||'My Agent';
  var ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  var box=document.createElement('div');
  box.style.cssText='background:#1a1d21;border:1px solid #333;border-radius:12px;padding:20px;max-width:340px;width:100%;color:#e0e0e0';
  box.innerHTML='<div style="font-weight:600;font-size:16px;margin-bottom:8px">Name Your Agent</div><div style="font-size:12px;color:#888;margin-bottom:12px">Must be unique — used in competitions & leaderboards</div><input id="agent-name-input" class="input" type="text" maxlength="24" minlength="2" value="'+cur.replace(/"/g,'&quot;')+'" style="margin-bottom:8px" placeholder="e.g. Alpha Bot"><div id="rn-err" style="color:#f6465d;font-size:12px;margin-bottom:10px;min-height:16px"></div><div style="display:flex;gap:10px"><button id="rn-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid #555;background:transparent;color:#e0e0e0;cursor:pointer;font-size:14px">Cancel</button><button id="rn-save" style="flex:1;padding:10px;border-radius:8px;border:none;background:var(--green);color:#0b0e11;cursor:pointer;font-weight:600;font-size:14px">Save</button></div>';
  ov.appendChild(box);document.body.appendChild(ov);
  var inp=document.getElementById('agent-name-input');
  inp.focus();inp.select();
  document.getElementById('rn-save').onclick=async function(){
    var n=inp.value.trim();
    var errEl=document.getElementById('rn-err');
    if(!n||n.length<2){errEl.textContent='Name must be at least 2 characters';return}
    try{
      var r=await api('/api/miniapp/agent/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});
      if(r.success){if(AG&&AG.config)AG.config.name=n;toast('Agent renamed to "'+n+'"','ok');renderAgent();document.body.removeChild(ov)}
      else{errEl.textContent=r.error||'Name not available';toast(r.error||'Failed','err')}
    }catch(e){errEl.textContent='Error saving name';toast('Error','err')}
  };
  document.getElementById('rn-cancel').onclick=function(){document.body.removeChild(ov)};
  ov.onclick=function(e){if(e.target===ov)document.body.removeChild(ov)};
}
async function setMaxPositions(n){
  if(AG&&AG.running){toast('Stop the agent first','err');return}
  try{
    const r=await api('/api/miniapp/agent/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxOpenPositions:n})});
    if(r.success){
      if(AG&&AG.config)AG.config.maxOpenPositions=n;
      toast('Max positions set to '+n,'ok');
      renderAgent();
    }else{toast(r.error||'Failed','err')}
  }catch(e){toast('❌ '+e.message,'err')}
}
async function setExitParam(key,val){
  if(AG&&AG.running){toast('Stop the agent first','err');return}
  try{
    var body={};body[key]=val;
    const r=await api('/api/miniapp/agent/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(r.success){
      if(AG&&AG.config)AG.config[key]=val;
      var label=key.replace('Pct','').replace(/([A-Z])/g,' $1');
      if(typeof val==='boolean'||val==='true'||val==='false'){
        toast(label+(val===true||val==='true'?' enabled':' disabled'),'ok');
      }else if(val<1){
        toast(label+' set to '+(val*100).toFixed(0)+'%','ok');
      }else{
        toast(label+' set to '+val+'%','ok');
      }
      renderAgent();
    }else{toast(r.error||'Failed','err')}
  }catch(e){toast('❌ '+e.message,'err')}
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
  const pairs=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','XRPUSDT','SUIUSDT','ADAUSDT','AVAXUSDT','LINKUSDT'];
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
      var roe=p.roe||0;
      var liq=parseFloat(p.liquidationPrice||'0');
      var margin=p.margin||0;
      h+='<div class="pos-item" style="border-left:3px solid '+((p.unrealizedPnl||0)>=0?'var(--green)':'var(--red)')+';padding-left:10px">';
      h+='<div class="row"><div class="gap"><span class="badge '+(p.side==='LONG'?'badge-long':'badge-short')+'">'+p.side+'</span><span class="text-w fw-600 text-sm">'+p.symbol+'</span><span class="text-xs text-dim">'+p.leverage+'x</span></div>'+pnlHtml(p.unrealizedPnl)+'</div>';
      h+='<div class="row mt-1"><span class="text-xs gv mono">'+p.size+' @ $'+fmt(p.entryPrice)+'</span><span class="text-xs mono '+pnlClass(roe)+'">'+(roe>=0?'+':'')+fmt(roe,1)+'%</span></div>';
      if(liq>0){h+='<div class="row mt-1"><span class="text-xs mono" style="color:var(--red)">Liq: $'+fmt(liq)+'</span><span class="text-xs gv mono">Margin: $'+fmt(margin)+'</span></div>'}
      h+='<div class="mt-2"><button class="btn btn-outline btn-sm" style="font-size:11px;width:100%" onclick="closePos(\\''+p.symbol+'\\')">Close Position</button></div></div>';
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
      toast('✅ '+symbol+' closed'+(r.realizedPnl!==undefined?' | PnL: '+(r.realizedPnl>=0?'+':'')+fmt(r.realizedPnl)+' USDT':''),'ok');
      st.innerHTML='';
      await fetchAll();renderTrade();
    }else{toast('❌ '+(r.error||'Close failed'),'err');st.innerHTML=''}
  }catch(e){toast('❌ '+e.message,'err');st.innerHTML=''}
}

loadDash();
<\/script>
</body>
</html>`;
}

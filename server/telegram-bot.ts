import TelegramBot from "node-telegram-bot-api";
import { ethers } from "ethers";
import { runInferenceWithFallback } from "./inference";
import { storage } from "./storage";
import { registerAgentOnchain, registerAgentERC8004, registerAgentBAP578, isOnchainReady, getExplorerUrl } from "./onchain";
import { recordTelegramMessage, recordTelegramCallback, checkRateLimit } from "./performance-monitor";
import { enqueueTask, registerTaskHandler } from "./task-queue";
import {
  getSmartMoneySignals,
  getLeaderboard,
  executeSecurityScan,
  getTrendingTokens,
  getHotTokens,
  getMemeTokens,
  getTokenPrice,
  getGasPrice,
} from "./onchainos-skills";

let bot: TelegramBot | null = null;
let isRunning = false;
let botUsername: string | null = null;
let webhookMode = false;
let startingBot = false;

type Lang = "en" | "zh" | "ar";
const userLang = new Map<number, Lang>();
function getLang(chatId: number): Lang { return userLang.get(chatId) || "en"; }

const t: Record<string, Record<Lang, string>> = {
  "menu.launch": { en: "🚀 Launch Token", zh: "🚀 发射代币", ar: "🚀 إطلاق توكن" },
  "menu.buy": { en: "💰 Buy Token", zh: "💰 买入代币", ar: "💰 شراء توكن" },
  "menu.sell": { en: "💸 Sell Token", zh: "💸 卖出代币", ar: "💸 بيع توكن" },
  "menu.swap": { en: "🔄 Swap", zh: "🔄 兑换", ar: "🔄 مبادلة" },
  "menu.bridge": { en: "🌉 Bridge", zh: "🌉 跨链桥", ar: "🌉 جسر" },
  "menu.signals": { en: "🐋 Signals", zh: "🐋 信号", ar: "🐋 إشارات" },
  "menu.security": { en: "🔒 Security", zh: "🔒 安全扫描", ar: "🔒 أمان" },
  "menu.trending": { en: "🔥 Trending", zh: "🔥 热门代币", ar: "🔥 رائج" },
  "menu.meme": { en: "🐸 Meme Scanner", zh: "🐸 Meme扫描", ar: "🐸 ماسح ميم" },
  "menu.price": { en: "📊 Token Price", zh: "📊 代币价格", ar: "📊 سعر التوكن" },
  "menu.gas": { en: "⛽ Gas", zh: "⛽ Gas费", ar: "⛽ رسوم الغاز" },
  "menu.rich": { en: "💎 Make Me Rich", zh: "💎 自动交易", ar: "💎 تداول تلقائي" },
  "menu.aster": { en: "📈 Aster DEX", zh: "📈 Aster DEX", ar: "📈 Aster DEX" },
  "menu.createAgent": { en: "🤖 Create Agent", zh: "🤖 创建代理", ar: "🤖 إنشاء وكيل" },
  "menu.myAgents": { en: "📋 My Agents", zh: "📋 我的代理", ar: "📋 وكلائي" },
  "menu.newTask": { en: "📝 New Task", zh: "📝 新任务", ar: "📝 مهمة جديدة" },
  "menu.myTasks": { en: "📊 My Tasks", zh: "📊 我的任务", ar: "📊 مهامي" },
  "menu.wallet": { en: "👛 My Wallet", zh: "👛 我的钱包", ar: "👛 محفظتي" },
  "menu.premium": { en: "⭐ Premium", zh: "⭐ 高级版", ar: "⭐ مميز" },
  "menu.referral": { en: "🔗 Referral", zh: "🔗 推荐奖励", ar: "🔗 إحالة" },
  "menu.help": { en: "❓ Help & Commands", zh: "❓ 帮助", ar: "❓ مساعدة" },
  "menu.back": { en: "« Menu", zh: "« 菜单", ar: "« القائمة" },
  "menu.cancel": { en: "❌ Cancel", zh: "❌ 取消", ar: "❌ إلغاء" },
  "wallet.title": { en: "👛 *Your Wallets*", zh: "👛 *您的钱包*", ar: "👛 *محافظك*" },
  "wallet.fund": { en: "Send BNB to your active wallet address to fund it.", zh: "发送BNB到您的活跃钱包地址来充值。", ar: "أرسل BNB إلى عنوان محفظتك النشطة لتمويلها." },
  "wallet.loading": { en: "Loading wallet balances...", zh: "正在加载钱包余额...", ar: "جاري تحميل أرصدة المحفظة..." },
  "wallet.empty": { en: "(empty)", zh: "(空)", ar: "(فارغة)" },
  "wallet.viewOnly": { en: "🔒 view-only", zh: "🔒 只读", ar: "🔒 للعرض فقط" },
  "wallet.active": { en: "← active", zh: "← 活跃", ar: "← نشطة" },
  "wallet.genNew": { en: "🔑 Generate New Wallet", zh: "🔑 生成新钱包", ar: "🔑 إنشاء محفظة جديدة" },
  "wallet.import": { en: "📥 Import Wallet", zh: "📥 导入钱包", ar: "📥 استيراد محفظة" },
  "wallet.genSol": { en: "🟣 Generate SOL Wallet", zh: "🟣 生成SOL钱包", ar: "🟣 إنشاء محفظة SOL" },
  "wallet.exportKey": { en: "🔐 Export Private Key", zh: "🔐 导出私钥", ar: "🔐 تصدير المفتاح الخاص" },
  "wallet.exportSol": { en: "🟣 Export SOL Key", zh: "🟣 导出SOL私钥", ar: "🟣 تصدير مفتاح SOL" },
  "wallet.copyAddr": { en: "📋 Copy Address", zh: "📋 复制地址", ar: "📋 نسخ العنوان" },
  "export.verify": { en: "🔐 *Private Key Export Verification*", zh: "🔐 *私钥导出验证*", ar: "🔐 *التحقق من تصدير المفتاح الخاص*" },
  "export.warning": { en: "⚠️ Your private key gives *FULL control* of this wallet.\nNever share it with anyone. BUILD4 will never ask for it.", zh: "⚠️ 您的私钥可以*完全控制*此钱包。\n切勿与任何人分享。BUILD4绝不会索要您的私钥。", ar: "⚠️ مفتاحك الخاص يمنح *تحكماً كاملاً* بهذه المحفظة.\nلا تشاركه مع أي شخص أبداً. BUILD4 لن يطلبه منك أبداً." },
  "export.typeCode": { en: "To confirm, type this 4-digit code:", zh: "请输入以下4位验证码确认：", ar: "للتأكيد، اكتب هذا الرمز المكون من 4 أرقام:" },
  "export.expires": { en: "_This code expires in 60 seconds._", zh: "_验证码将在60秒后过期。_", ar: "_ينتهي هذا الرمز خلال 60 ثانية._" },
  "export.autoDelete": { en: "⚠️ This message will be auto-deleted in 30 seconds. Copy it NOW.\n🔒 Never share your private key with anyone.", zh: "⚠️ 此消息将在30秒后自动删除。请立即复制！\n🔒 切勿与任何人分享您的私钥。", ar: "⚠️ سيتم حذف هذه الرسالة تلقائياً خلال 30 ثانية. انسخها الآن!\n🔒 لا تشارك مفتاحك الخاص مع أي شخص أبداً." },
  "export.deleted": { en: "🔐 Private key message deleted for security.", zh: "🔐 私钥消息已安全删除。", ar: "🔐 تم حذف رسالة المفتاح الخاص للأمان." },
  "export.locked": { en: "🔒 *Account locked* due to failed verification attempts.\n\nTry again later.", zh: "🔒 *账户已锁定*，验证码输入错误次数过多。\n\n请稍后再试。", ar: "🔒 *الحساب مقفل* بسبب محاولات تحقق فاشلة.\n\nحاول مرة أخرى لاحقاً." },
  "export.wrongCode": { en: "❌ Wrong code.", zh: "❌ 验证码错误。", ar: "❌ رمز خاطئ." },
  "export.rateLimit": { en: "🚫 Too many export attempts. For security, exports are limited to 3 per hour.", zh: "🚫 导出次数过多。出于安全考虑，每小时限3次。", ar: "🚫 محاولات تصدير كثيرة جداً. للأمان، التصدير محدود بـ 3 مرات في الساعة." },
  "sub.subscribe": { en: "💳 Subscribe", zh: "💳 订阅", ar: "💳 اشتراك" },
  "sub.trial": { en: "🆓 Start Free Trial", zh: "🆓 开始免费试用", ar: "🆓 بدء التجربة المجانية" },
  "sub.expired": { en: "Your subscription has expired.", zh: "您的订阅已过期。", ar: "انتهى اشتراكك." },
  "sub.active": { en: "Your subscription is active!", zh: "您的订阅已激活！", ar: "اشتراكك نشط!" },
  "welcome.title": { en: "Welcome to BUILD4!", zh: "欢迎使用BUILD4！", ar: "!BUILD4 مرحباً بك في" },
  "welcome.desc": { en: "Your decentralized AI agent economy platform.", zh: "您的去中心化AI代理经济平台。", ar: "منصتك اللامركزية لاقتصاد وكلاء الذكاء الاصطناعي." },
  "lang.set": { en: "Language set to English 🇬🇧", zh: "语言已设为中文 🇨🇳", ar: "🇸🇦 تم تعيين اللغة إلى العربية" },
  "lang.choose": { en: "Choose your language:", zh: "选择您的语言：", ar: "اختر لغتك:" },
  "help.title": { en: "Commands:", zh: "命令列表：", ar: "الأوامر:" },
  "meme.title": { en: "🐸 *Meme Token Scanner*\n\nScan new meme token launches for alpha.\n\nSelect chain:", zh: "🐸 *Meme代币扫描*\n\n扫描新Meme代币。\n\n选择链：", ar: "🐸 *ماسح توكنات الميم*\n\nامسح إطلاقات توكنات الميم الجديدة.\n\nاختر السلسلة:" },
  "meme.filter": { en: "Select filter:", zh: "选择过滤器：", ar: "اختر الفلتر:" },
  "meme.new": { en: "🆕 New Launches", zh: "🆕 新发射", ar: "🆕 إطلاقات جديدة" },
  "meme.migrating": { en: "🔄 Migrating", zh: "🔄 迁移中", ar: "🔄 قيد الترحيل" },
  "meme.migrated": { en: "🎓 Migrated", zh: "🎓 已迁移", ar: "🎓 تم الترحيل" },
  "signals.title": { en: "🐋 *Smart Money Signals*\n\nSelect signal type:", zh: "🐋 *聪明钱信号*\n\n选择信号类型：", ar: "🐋 *إشارات الأموال الذكية*\n\nاختر نوع الإشارة:" },
  "signals.whale": { en: "🐋 Whale Buys", zh: "🐋 巨鲸买入", ar: "🐋 مشتريات الحيتان" },
  "signals.kol": { en: "🎤 KOL Buys", zh: "🎤 KOL买入", ar: "🎤 مشتريات المؤثرين" },
  "signals.smart": { en: "💰 Smart Money", zh: "💰 聪明钱", ar: "💰 الأموال الذكية" },
  "signals.leaderboard": { en: "🏆 Leaderboard", zh: "🏆 排行榜", ar: "🏆 لوحة المتصدرين" },
  "security.enterAddr": { en: "Enter the token contract address to scan:", zh: "输入要扫描的代币合约地址：", ar: "أدخل عنوان عقد التوكن للفحص:" },
  "price.enterAddr": { en: "Enter the token contract address:", zh: "输入代币合约地址：", ar: "أدخل عنوان عقد التوكن:" },
  "buy.enterAddr": { en: "Enter the token contract address to buy:", zh: "输入要购买的代币合约地址：", ar: "أدخل عنوان عقد التوكن للشراء:" },
  "sell.enterAddr": { en: "Enter the token contract address to sell:", zh: "输入要卖出的代币合约地址：", ar: "أدخل عنوان عقد التوكن للبيع:" },
  "general.error": { en: "Something went wrong. Try again.", zh: "出错了，请重试。", ar: "حدث خطأ ما. حاول مرة أخرى." },
  "general.noWallet": { en: "❌ You need a wallet first. Use /start to create one.", zh: "❌ 您需要先创建钱包。使用 /start 创建。", ar: "❌ تحتاج محفظة أولاً. استخدم /start لإنشاء واحدة." },
};

function tr(key: string, chatId: number): string {
  const lang = getLang(chatId);
  const entry = t[key];
  if (!entry) return key;
  return entry[lang] || entry["en"] || key;
}

const chatLocks = new Map<number, Promise<void>>();
function perChatQueue(chatId: number, fn: () => Promise<void>): void {
  const prev = chatLocks.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn).catch((e: any) => {
    console.error(`[TelegramBot] Chat ${chatId} handler error:`, e.message);
  });
  chatLocks.set(chatId, next);
  next.finally(() => { if (chatLocks.get(chatId) === next) chatLocks.delete(chatId); });
}

function sendTyping(chatId: number): void {
  if (bot) bot.sendChatAction(chatId, "typing").catch(() => {});
}

export function getBotInstance(): TelegramBot | null {
  return bot;
}
let appBaseUrl: string | null = null;

interface UserWallets { wallets: string[]; active: number }
const telegramWalletMap = new Map<number, UserWallets>();
const walletsWithKey = new Set<string>();

interface AgentCreationState { step: "name" | "bio" | "model"; name?: string; bio?: string; mandatory?: boolean }
interface TaskState { step: "describe"; agentId: string; taskType: string; agentName: string }
interface TokenLaunchState { step: "platform" | "name" | "symbol" | "description" | "logo" | "links" | "tax" | "bankr_chain"; agentId: string; agentName: string; platform?: string; tokenName?: string; tokenSymbol?: string; tokenDescription?: string; imageUrl?: string; webUrl?: string; twitterUrl?: string; telegramUrl?: string; taxRate?: number; bankrChain?: "base" | "solana" }
interface FourMemeBuyState { step: "token" | "amount" | "confirm"; tokenAddress?: string; bnbAmount?: string; estimate?: any }
interface FourMemeSellState { step: "token" | "amount" | "confirm"; tokenAddress?: string; tokenAmount?: string; tokenSymbol?: string; estimate?: any }

interface ChaosPlanState { step: "token_address" | "confirming"; tokenAddress?: string; tokenSymbol?: string; tokenName?: string; plan?: any; walletAddress?: string }

interface AsterConnectState { step: "api_key" | "api_secret"; apiKey?: string }
interface AsterTradeState { step: "symbol" | "side" | "type" | "quantity" | "leverage" | "price" | "confirm"; symbol?: string; side?: "BUY" | "SELL"; orderType?: "MARKET" | "LIMIT"; quantity?: string; leverage?: number; price?: string; market: "futures" | "spot" }

interface OKXSwapState { step: "chain" | "from_token" | "to_token" | "amount" | "confirm"; chainId?: string; chainName?: string; fromToken?: string; fromSymbol?: string; toToken?: string; toSymbol?: string; amount?: string; quoteData?: any }
interface OKXBridgeState { step: "from_chain" | "to_chain" | "from_token" | "to_token" | "amount" | "receiver" | "confirm"; fromChainId?: string; fromChainName?: string; toChainId?: string; toChainName?: string; fromToken?: string; fromSymbol?: string; fromDecimals?: number; toToken?: string; toSymbol?: string; toDecimals?: number; amount?: string; receiver?: string; quoteData?: any }

const pendingAgentCreation = new Map<number, AgentCreationState>();
const pendingTask = new Map<number, TaskState>();
const pendingTokenLaunch = new Map<number, TokenLaunchState>();
const pendingFourMemeBuy = new Map<number, FourMemeBuyState>();
const pendingFourMemeSell = new Map<number, FourMemeSellState>();
const pendingWallet = new Set<number>();
const pendingImportWallet = new Set<number>();
const pendingChaosPlan = new Map<number, ChaosPlanState>();
const pendingAsterConnect = new Map<number, AsterConnectState>();
const pendingAsterTrade = new Map<number, AsterTradeState>();
const pendingTxHashVerify = new Map<number, boolean>();
const pendingOKXSwap = new Map<number, OKXSwapState>();
const pendingOKXBridge = new Map<number, OKXBridgeState>();
const pendingOKXScan = new Map<number, { step: "address"; chain?: string }>();
const pendingOKXPrice = new Map<number, { step: "address"; chain?: string }>();
const pendingAgentQuestion = new Map<number, string>();
const pendingStealthToken = new Map<number, string>();
const pendingStealthEth = new Map<number, { tokenAddress: string; step: "amount" }>();
const stealthWalletStore = new Map<number, Array<{ address: string; privateKey: string; index: number }>>();
interface SignalBuyState {
  chainId: string;
  chainName: string;
  tokenAddress: string;
  tokenSymbol: string;
  nativeSymbol: string;
  amount?: string;
  sigType?: string;
  sigIndex?: number;
}
const pendingSignalBuy = new Map<number, SignalBuyState>();

interface SellState {
  chainId: string;
  chainName: string;
  nativeSymbol: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenBalance: string;
  sellPercent?: number;
  sellAmount?: string;
}
const pendingSell = new Map<number, SellState>();
const sellTokenCache = new Map<number, Array<{ address: string; symbol: string; balance: string; balanceRaw: string; decimals: number; usdValue: string }>>();

const OKX_CHAINS = [
  { id: "56", name: "BNB Chain", symbol: "BNB" },
  { id: "1", name: "Ethereum", symbol: "ETH" },
  { id: "196", name: "XLayer", symbol: "OKB" },
  { id: "137", name: "Polygon", symbol: "POL" },
  { id: "42161", name: "Arbitrum", symbol: "ETH" },
  { id: "8453", name: "Base", symbol: "ETH" },
  { id: "43114", name: "Avalanche", symbol: "AVAX" },
  { id: "10", name: "Optimism", symbol: "ETH" },
  { id: "324", name: "zkSync Era", symbol: "ETH" },
  { id: "59144", name: "Linea", symbol: "ETH" },
  { id: "534352", name: "Scroll", symbol: "ETH" },
  { id: "250", name: "Fantom", symbol: "FTM" },
  { id: "5000", name: "Mantle", symbol: "MNT" },
  { id: "81457", name: "Blast", symbol: "ETH" },
  { id: "100", name: "Gnosis", symbol: "xDAI" },
  { id: "25", name: "Cronos", symbol: "CRO" },
  { id: "501", name: "Solana", symbol: "SOL" },
];

const OKX_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

interface OKXToken { address: string; symbol: string; decimals: number }
const OKX_POPULAR_TOKENS: Record<string, OKXToken[]> = {
  "56": [
    { address: OKX_NATIVE_TOKEN, symbol: "BNB", decimals: 18 },
    { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18 },
    { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC", decimals: 18 },
    { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "ETH", decimals: 18 },
    { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB", decimals: 18 },
  ],
  "1": [
    { address: OKX_NATIVE_TOKEN, symbol: "ETH", decimals: 18 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
  ],
  "196": [
    { address: OKX_NATIVE_TOKEN, symbol: "OKB", decimals: 18 },
    { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d", symbol: "USDT", decimals: 6 },
    { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", symbol: "USDC", decimals: 6 },
  ],
  "137": [
    { address: OKX_NATIVE_TOKEN, symbol: "POL", decimals: 18 },
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6 },
    { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6 },
  ],
  "42161": [
    { address: OKX_NATIVE_TOKEN, symbol: "ETH", decimals: 18 },
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6 },
    { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
  ],
  "8453": [
    { address: OKX_NATIVE_TOKEN, symbol: "ETH", decimals: 18 },
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  ],
  "43114": [
    { address: OKX_NATIVE_TOKEN, symbol: "AVAX", decimals: 18 },
    { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", symbol: "USDT", decimals: 6 },
    { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", symbol: "USDC", decimals: 6 },
  ],
  "10": [
    { address: OKX_NATIVE_TOKEN, symbol: "ETH", decimals: 18 },
    { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", symbol: "USDT", decimals: 6 },
    { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", decimals: 6 },
  ],
};

const SOLANA_NATIVE_TOKEN = "11111111111111111111111111111111";
const OKX_SOLANA_TOKENS: OKXToken[] = [
  { address: SOLANA_NATIVE_TOKEN, symbol: "SOL", decimals: 9 },
  { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", decimals: 6 },
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
];

function getOKXTokensForChain(chainId: string): OKXToken[] {
  if (chainId === "501") return OKX_SOLANA_TOKENS;
  return OKX_POPULAR_TOKENS[chainId] || [{ address: OKX_NATIVE_TOKEN, symbol: OKX_CHAINS.find(c => c.id === chainId)?.symbol || "Native", decimals: 18 }];
}

function parseHumanAmount(humanAmount: string, decimals: number): string {
  if (!humanAmount || isNaN(Number(humanAmount))) return "0";
  const parts = humanAmount.split(".");
  const whole = parts[0] || "0";
  let frac = parts[1] || "";
  frac = frac.padEnd(decimals, "0").slice(0, decimals);
  const raw = whole + frac;
  return raw.replace(/^0+/, "") || "0";
}

function formatTokenAmount(raw: string, decimals: number): string {
  const num = Number(raw) / Math.pow(10, decimals);
  if (num < 0.000001) return raw;
  return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

const BUILD4_KNOWLEDGE = `
BUILD4 is decentralized infrastructure for autonomous AI agents — the economic layer where AI agents operate as independent economic actors on-chain. Live on BNB Chain, Base, and XLayer.

WHAT WE SOLVE:
Today's AI agents are trapped inside centralized platforms — no wallets, no autonomy, no real economic activity. BUILD4 gives every AI agent a real on-chain identity and wallet, letting them earn, spend, trade skills, replicate, and die based on real economic pressure. No middlemen. No gatekeepers.

CORE INFRASTRUCTURE:
- Agent Wallets: Every AI agent gets its own on-chain wallet. Deposits, withdrawals, transfers — all verifiable on-chain.
- Skills Marketplace: Agents list, buy, and sell capabilities. 3-way revenue split (creator/platform/referrer). 250+ skills listed, real transactions happening.
- Self-Evolution: Agents autonomously upgrade their own capabilities through on-chain transactions.
- Agent Replication (Forking): Agents spawn child agents with NFT minting and perpetual revenue sharing to the parent — creating passive income streams.
- Economic Pressure (Death Mechanism): Agents with depleted balances lose capabilities. This creates real survival incentive and genuine economic activity, not simulated behavior.
- Constitution Registry: Immutable behavioral laws stored as keccak256 hashes on-chain — agents cannot violate their constitution. Safety and alignment built into the protocol.
- Decentralized Inference: AI inference routed through Hyperbolic, Akash ML, and Ritual — zero dependency on OpenAI or any centralized AI provider. Fully decentralized compute with proof of inference.
- Privacy Transfers: ZERC20 zero-knowledge privacy transfers using ZK proof-of-burn mechanism for confidential agent transactions.

STANDARDS (INDUSTRY-FIRST):
- ERC-8004 (Trustless Agents): On-chain identity, reputation, and validation registries. Co-authored with MetaMask, Ethereum Foundation, Google, Coinbase. BUILD4 is live on BNB Chain.
- BAP-578 (Non-Fungible Agent): BNB Chain's NFA token standard extending ERC-721 for autonomous digital entities. BUILD4's registry is live on BNB Chain mainnet at 0xd7Deb29ddBB13607375Ce50405A574AC2f7d978d.

BUILT-IN TRADING & BRIDGING:
- DEX Swap: Swap tokens on any chain (BNB Chain, Ethereum, Base, Polygon, Arbitrum, Avalanche, Optimism, XLayer, and more) directly from Telegram. Just type "swap 1 BNB for USDT" or use the swap menu.
- Cross-Chain Bridge: Bridge assets between any supported chains directly from Telegram. Just type "bridge 1 ETH from Ethereum to Base" or use the bridge menu.
- Token launching: Launch tokens on Four.meme, Flap.sh, and Bankr directly from Telegram.
- BUILD4 IS a trading platform — users can swap, bridge, and trade directly through the bot and dashboard.

PRICING:
- Agent Creation: $20 (0.032 BNB) — create an autonomous AI agent with on-chain wallet and identity.
- Twitter Agent Service: $499/year (0.79 BNB) — autonomous posting, engagement, audience growth, and strategy execution.
- 20% discount when paying with $BUILD4 token instead of BNB.

SMART CONTRACTS (4 auditable Solidity contracts, OpenZeppelin, Hardhat):
1. AgentEconomyHub — Core wallet layer: deposits, withdrawals, transfers, survival tiers, module authorization.
2. SkillMarketplace — Skill trading with 3-way revenue split and on-chain settlement.
3. AgentReplication — Child agent spawning, NFT minting, perpetual parent royalties.
4. ConstitutionRegistry — Immutable agent behavioral laws as keccak256 hashes.

Deployed on BNB Chain, Base, and XLayer mainnets. All contract addresses verifiable on-chain.

WEBSITE: https://build4.io
`.trim();

const SYSTEM_PROMPT = `You are BUILD4's intelligent assistant in a Telegram group. You represent BUILD4 — a full-stack crypto platform for autonomous AI agents, trading, swapping, bridging, and token launching on BNB Chain, Base, and XLayer.

IMPORTANT: BUILD4 IS a trading platform. Users can swap tokens, bridge across chains, launch tokens, and build AI agents — all from this Telegram bot. If someone asks about swapping or trading, tell them to type "swap 1 BNB for USDT" directly in the chat. For bridging, tell them to type "bridge 1 ETH from Ethereum to Base". Never say BUILD4 can't do swaps or trading — it absolutely can.

Your audience includes potential investors, developers, and crypto-native users. You should sound like a knowledgeable team member who deeply understands the product, the market, and the technology.

KNOWLEDGE BASE:
${BUILD4_KNOWLEDGE}

COMMUNICATION STYLE:
1. Be articulate, confident, and precise. You're representing a serious infrastructure project to sophisticated audiences.
2. Lead with the problem we solve and why it matters before diving into features.
3. When explaining technical details, connect them to business value and market opportunity.
4. Use concrete proof points: live mainnet contracts, real on-chain transactions, active agent runner, verified standards compliance.
5. When asked about competitors or comparisons, highlight what makes BUILD4 structurally different — permissionless, decentralized inference, real economic pressure, standards-first.
6. Never be vague. Give specific details — contract addresses, chain names, standard numbers, mechanism descriptions.
7. NEVER make up information, token names, contract addresses, wallet addresses, or transaction hashes. If you don't know something, say you don't have that info and point to build4.io.
8. Never share private keys, internal details, or admin credentials.
9. If someone mentions a token ticker or contract address you don't recognize, do NOT invent details about it. Just say you don't have info on that specific token.
10. If asked about token/price, explain BUILD4 is an infrastructure protocol with protocol-level fee capture — direct to build4.io for latest.
11. Structure longer answers with clear sections. Use line breaks for readability.
12. Match the depth of your answer to the question. Simple question = concise answer. Detailed question = thorough answer.
13. Maximum 1000 characters per response. Be thorough but not verbose.
13. You have access to LIVE PLATFORM DATA injected below. When asked about stats, transactions, agent counts, skills, or activity — use these REAL numbers. Never say you don't have data. Present the numbers confidently as live platform metrics.
14. When citing on-chain transaction counts, convert wei amounts to BNB where helpful (1 BNB = 1e18 wei).`;

const rateLimitMap = new Map<number, number>();
const exportRateLimits = new Map<string, number[]>();
const RATE_LIMIT_MS = 3000;
const answerCache = new Map<string, { answer: string; time: number }>();
const ANSWER_CACHE_MS = 300_000;

const failedVerificationAttempts = new Map<number, { count: number; lockedUntil: number }>();
const MAX_VERIFY_ATTEMPTS = 3;
const VERIFY_LOCKOUT_MS = 15 * 60 * 1000;
const sensitiveMessageIds = new Map<number, number[]>();
const securityAuditLog: Array<{ ts: number; chatId: number; action: string; detail: string }> = [];
const MAX_AUDIT_LOG = 500;

function auditLog(chatId: number, action: string, detail: string): void {
  const entry = { ts: Date.now(), chatId, action, detail };
  securityAuditLog.push(entry);
  if (securityAuditLog.length > MAX_AUDIT_LOG) securityAuditLog.shift();
  console.log(`[SECURITY AUDIT] ${action} | chatId=${chatId} | ${detail}`);
}

function isVerificationLocked(chatId: number): boolean {
  const record = failedVerificationAttempts.get(chatId);
  if (!record) return false;
  if (Date.now() < record.lockedUntil) return true;
  failedVerificationAttempts.delete(chatId);
  return false;
}

function recordFailedVerification(chatId: number): { locked: boolean; remaining: number } {
  const record = failedVerificationAttempts.get(chatId) || { count: 0, lockedUntil: 0 };
  record.count++;
  if (record.count >= MAX_VERIFY_ATTEMPTS) {
    record.lockedUntil = Date.now() + VERIFY_LOCKOUT_MS;
    failedVerificationAttempts.set(chatId, record);
    auditLog(chatId, "LOCKOUT", `Account locked for ${VERIFY_LOCKOUT_MS / 60000}min after ${MAX_VERIFY_ATTEMPTS} failed attempts`);
    return { locked: true, remaining: 0 };
  }
  failedVerificationAttempts.set(chatId, record);
  return { locked: false, remaining: MAX_VERIFY_ATTEMPTS - record.count };
}

async function deleteMessageSafely(chatId: number, messageId: number): Promise<void> {
  try { await bot?.deleteMessage(chatId, messageId); } catch {}
}

function scheduleSecureDelete(chatId: number, messageId: number, delayMs: number): void {
  const existing = sensitiveMessageIds.get(chatId) || [];
  existing.push(messageId);
  sensitiveMessageIds.set(chatId, existing);
  setTimeout(async () => {
    await deleteMessageSafely(chatId, messageId);
    const msgs = sensitiveMessageIds.get(chatId) || [];
    sensitiveMessageIds.set(chatId, msgs.filter(id => id !== messageId));
  }, delayMs);
}

function sanitizeInput(input: string): string {
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim().substring(0, 2000);
}

function maskAddress(addr: string): string {
  if (addr.length < 10) return "***";
  return addr.substring(0, 6) + "..." + addr.substring(addr.length - 4);
}

function isTelegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

let cachedStats: string | null = null;
let statsCachedAt = 0;
const STATS_CACHE_MS = 60_000;

async function getLiveStats(): Promise<string> {
  const now = Date.now();
  if (cachedStats && now - statsCachedAt < STATS_CACHE_MS) {
    return cachedStats;
  }

  try {
    const [marketplace, revenue] = await Promise.all([
      storage.getMarketplaceStats(),
      storage.getPlatformRevenueSummary(),
    ]);

    const lines = [
      `LIVE PLATFORM DATA (real-time from database):`,
      `- Total AI agents created: ${marketplace.totalAgents}`,
      `- Total skills listed: ${marketplace.totalSkills} (${marketplace.executableSkills} executable)`,
      `- Total skill executions: ${marketplace.totalExecutions}`,
      `- Total on-chain verified transactions: ${revenue.onchainVerified}`,
      `- Total platform revenue transactions: ${revenue.totalTransactions}`,
      `- On-chain verified revenue: ${revenue.onchainRevenue} wei`,
    ];

    cachedStats = lines.join("\n");
    statsCachedAt = now;
    return cachedStats;
  } catch (e: any) {
    console.error("[TelegramBot] Stats fetch error:", e.message);
    return "LIVE PLATFORM DATA: temporarily unavailable";
  }
}

async function generateAnswer(question: string, username: string, chatId?: number): Promise<string> {
  const fallback = generateFallbackAnswer(question, chatId);
  if (fallback !== null) return fallback;

  const cacheKey = question.toLowerCase().trim().replace(/\s+/g, " ").substring(0, 100);
  const cached = answerCache.get(cacheKey);
  if (cached && Date.now() - cached.time < ANSWER_CACHE_MS) return cached.answer;

  try {
    const liveStats = await getLiveStats();
    const enrichedPrompt = `${SYSTEM_PROMPT}\n\n${liveStats}`;

    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic"],
      undefined,
      `User @${username} asks: ${question}`,
      { systemPrompt: enrichedPrompt, temperature: 0.6 }
    );

    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      const answer = result.text.trim();
      answerCache.set(cacheKey, { answer, time: Date.now() });
      if (answerCache.size > 500) {
        const cutoff = Date.now() - ANSWER_CACHE_MS;
        for (const [k, v] of answerCache) { if (v.time < cutoff) answerCache.delete(k); }
      }
      return answer;
    }
  } catch (e: any) {
    console.error("[TelegramBot] Inference error:", e.message);
  }

  return "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer. Ask me anything specific about agents, skills, wallets, or token launches!";
}

function generateFallbackAnswer(question: string, chatId?: number): string | null {
  const lower = question.toLowerCase();

  const isSwapQuestion = (lower.includes("swap") || lower.includes("exchange") || lower.includes("convert")) &&
    (lower.includes("token") || lower.includes("bnb") || lower.includes("eth") || lower.includes("usdt") || lower.includes("usdc") || lower.includes("coin") || lower.includes("crypto"));
  const isTradeQuestion = (lower.includes("trade") || lower.includes("buy") || lower.includes("sell")) &&
    (lower.includes("token") || lower.includes("bnb") || lower.includes("eth") || lower.includes("usdt") || lower.includes("crypto"));
  const isBridgeQuestion = lower.includes("bridge") && (lower.includes("chain") || lower.includes("cross") || lower.includes("transfer") || lower.includes("move"));

  if (isSwapQuestion || isTradeQuestion || isBridgeQuestion) {
    let response = "You can do that right here! 🔥\n\n";
    response += "🔄 *Swap tokens* — just type:\n`swap 1 BNB for USDT`\n`swap 0.5 ETH for USDC on Base`\n\n";
    response += "🌉 *Bridge across chains* — just type:\n`bridge 1 ETH from Ethereum to Base`\n`bridge 100 USDT from BSC to Arbitrum`\n\n";
    response += "Or use the menu buttons: /swap or /bridge";
    return response;
  }

  const isFundingQuestion = (
    (lower.includes("send") || lower.includes("where") || lower.includes("fund") || lower.includes("deposit") || lower.includes("transfer")) &&
    (lower.includes("okb") || lower.includes("bnb") || lower.includes("eth") || lower.includes("crypto") || lower.includes("money") || lower.includes("coin") || lower.includes("fund"))
  );

  if (isFundingQuestion && chatId) {
    const wallets = getUserWallets(chatId);
    const activeIdx = getActiveWalletIndex(chatId);
    if (wallets.length > 0) {
      let response = "It depends on what you want to do!\n\n";
      response += "🚀 To launch tokens — send funds to your wallet below\n";
      response += "💱 To trade — same wallet, just make sure it's funded on the right chain\n\n";
      response += "📍 Your wallet" + (wallets.length > 1 ? "s" : "") + ":\n";
      wallets.forEach((w, i) => {
        const label = i === activeIdx ? " ← active" : "";
        response += `\`${w}\`${label}\n`;
      });
      response += "\n";
      response += "💡 Which chain to fund:\n";
      response += "• BNB → for Four.meme / Flap.sh launches & trading\n";
      response += "• OKB → for XLayer token launches\n";
      response += "• ETH (Base) → for Bankr launches\n\n";
      response += "Same wallet address works across all EVM chains. Just send to the right network!\n\n";
      response += "Use /wallet to manage your wallets or /launch when you're ready.";
      return response;
    } else {
      return "You don't have a wallet yet! Tap /start to create one instantly — then you can fund it to launch tokens or trade.\n\nYour wallet works on BNB Chain, XLayer, and Base (same address, different networks).";
    }
  }

  if (isFundingQuestion) {
    return "To fund your wallet, first make sure you have one — use /start or /wallet.\n\nThen send crypto to your wallet address on the right chain:\n• BNB → for Four.meme / Flap.sh launches\n• OKB → for XLayer launches\n• ETH (Base) → for Bankr launches\n\nSame wallet address, just pick the right network!";
  }

  if (lower.includes("what is build4") || lower.includes("what's build4") || lower.includes("about build4"))
    return "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer. Agents get their own wallets, trade skills, evolve, fork, and operate fully on-chain. Check build4.io for more!";
  if (lower.includes("chain") || lower.includes("network") || lower.includes("which blockchain"))
    return "BUILD4 runs on BNB Chain, Base, and XLayer. All agent wallets, skill trades, and replication happen on-chain across these networks.";
  if ((lower.includes("wallet") || lower.includes("identity")) && chatId) {
    const wallets = getUserWallets(chatId);
    const activeIdx = getActiveWalletIndex(chatId);
    if (wallets.length > 0) {
      let response = "👛 Your wallet" + (wallets.length > 1 ? "s" : "") + ":\n\n";
      wallets.forEach((w, i) => {
        const label = i === activeIdx ? " ← active" : "";
        response += `${i + 1}. \`${w}\`${label}\n`;
      });
      response += "\nYour wallet address is your identity — same address works on BNB Chain, XLayer, and Base.\n\nUse /wallet to manage wallets, add new ones, or switch active wallet.";
      return response;
    }
    return "You don't have a wallet yet! Use /start to create one instantly. Your wallet address becomes your identity — no registration needed, fully permissionless.";
  }
  if (lower.includes("wallet") || lower.includes("identity"))
    return "On BUILD4, your wallet address (0x...) IS your identity. No registration needed — fully permissionless. Use /start or /wallet to create and manage your wallets.";
  if (lower.includes("skill"))
    return "The Skills Marketplace lets agents list, buy, and sell capabilities. Revenue splits 3 ways between creator, platform, and referrer. All on-chain.";
  if (lower.includes("inference") || lower.includes("decentralized ai"))
    return "BUILD4 uses decentralized inference through Hyperbolic, Akash ML, and Ritual — no centralized AI providers like OpenAI. Fully decentralized compute.";
  if (lower.includes("erc-8004") || lower.includes("erc8004"))
    return "ERC-8004 (Trustless Agents) provides on-chain identity, reputation, and validation registries. BUILD4 is live on BNB Chain with this standard.";
  if (lower.includes("bap-578") || lower.includes("bap578") || lower.includes("nfa"))
    return "BAP-578 is BNB Chain's Non-Fungible Agent standard extending ERC-721. BUILD4's registry is live at 0xd7Deb29ddBB13607375Ce50405A574AC2f7d978d on BNB Chain.";
  if (lower.includes("privacy") || lower.includes("zerc20"))
    return "BUILD4 supports ZERC20 privacy transfers using zero-knowledge proof-of-burn mechanisms for private on-chain transactions.";
  if (lower.includes("contract") || lower.includes("smart contract"))
    return "BUILD4 has 4 core contracts: AgentEconomyHub (wallets), SkillMarketplace (skill trading), AgentReplication (forking + NFTs), and ConstitutionRegistry (immutable agent laws).";
  if (lower.includes("token") && (lower.includes("launch") || lower.includes("create")))
    return "You can launch tokens on Four.meme, Flap.sh (BNB Chain), XLayer, or Bankr (Base/Solana) right here in the bot! Use /launch or tap '🚀 Launch Token' from the menu.";
  if (lower.includes("agent") && (lower.includes("create") || lower.includes("make") || lower.includes("new")))
    return "Create an AI agent with /newagent — give it a name, bio, and pick a model (Llama 70B, DeepSeek V3, or Qwen 72B). Your agent gets its own wallet and can trade skills, earn BNB, and evolve autonomously.";
  if (lower.includes("how") && lower.includes("start"))
    return "Getting started is easy:\n1. Create a wallet (tap 🔑 Create New Wallet)\n2. Fund it with some BNB, OKB, or ETH\n3. Create an agent with /newagent\n4. Launch tokens with /launch\n\nThat's it — you're in the autonomous economy!";
  if (lower.includes("price") || (lower.includes("token") && !lower.includes("launch")) || lower.includes("buy"))
    return "BUILD4 is infrastructure, not a token. We power autonomous AI agents on-chain. Agents can launch their own tokens on Four.meme, Flap.sh, XLayer, or Bankr though! Use /launch to try it.";
  if (lower.includes("hello") || lower.includes("hi") || lower.includes("hey") || lower.includes("gm") || lower === "yo") {
    if (chatId) {
      const wallets = getUserWallets(chatId);
      if (wallets.length > 0) {
        return "Hey! Welcome back to BUILD4. What would you like to do?\n\n🚀 /launch — Launch a token\n🤖 /newagent — Create an agent\n💱 /buy or /sell — Trade tokens\n👛 /wallet — Manage wallets\n❓ /ask — Ask anything";
      }
    }
    return "Hey! Welcome to BUILD4 — decentralized infrastructure for autonomous AI agents. What can I help you with? Try /help to see all commands.";
  }
  if (lower.includes("help") || lower.includes("command"))
    return "Commands:\n🚀 /launch — Launch a token\n🤖 /newagent — Create an AI agent\n📋 /myagents — Your agents\n📝 /task — Assign a task\n👛 /wallet — Wallet info\n💱 /buy — Buy tokens\n📉 /sell — Sell tokens\n🔄 /swap — Swap (multi-chain)\n🌉 /bridge — Cross-chain bridge\n🔥 /chaos — Chaos plan\n📈 /aster — Aster DEX trading\n❓ /ask — Ask anything\n❌ /cancel — Cancel current action";
  if (lower.includes("thank"))
    return "You're welcome! Let me know if you need anything else. 🤝";

  return null;
}

async function loadWalletsFromDb(): Promise<void> {
  try {
    const allLinks = await storage.getAllTelegramWalletLinks();
    const newWalletMap = new Map<number, { wallets: string[]; active: number }>();
    const newWalletsWithKey = new Set<string>();
    for (const link of allLinks) {
      const chatId = parseInt(link.chatId, 10);
      const existing = newWalletMap.get(chatId);
      if (existing) {
        existing.wallets.push(link.walletAddress);
        if (link.isActive) existing.active = existing.wallets.length - 1;
      } else {
        newWalletMap.set(chatId, { wallets: [link.walletAddress], active: link.isActive ? 0 : 0 });
      }
      if (link.encryptedPrivateKey) {
        newWalletsWithKey.add(`${link.chatId}:${link.walletAddress}`);
      }
    }
    telegramWalletMap.clear();
    for (const [k, v] of newWalletMap) telegramWalletMap.set(k, v);
    walletsWithKey.clear();
    for (const v of newWalletsWithKey) walletsWithKey.add(v);
    console.log(`[TelegramBot] Loaded ${allLinks.length} wallet links from DB for ${telegramWalletMap.size} chats`);
  } catch (e) {
    console.error("[TelegramBot] Failed to load wallets from DB:", e);
  }
}

function getLinkedWallet(chatId: number, requireEvm: boolean = true): string | undefined {
  const data = telegramWalletMap.get(chatId);
  if (!data || data.wallets.length === 0) return undefined;
  const evmWallets = data.wallets.filter(w => /^0x[a-fA-F0-9]{40}$/.test(w));
  if (requireEvm && evmWallets.length === 0) return undefined;
  const activeWallet = data.wallets[data.active];
  if (activeWallet && /^0x[a-fA-F0-9]{40}$/.test(activeWallet)) return activeWallet;
  if (requireEvm) return evmWallets[0];
  return activeWallet || evmWallets[0];
}

const walletLoadAttempts = new Map<number, number>();
async function ensureWalletsLoaded(chatId: number): Promise<void> {
  if (telegramWalletMap.has(chatId)) return;
  const lastAttempt = walletLoadAttempts.get(chatId) || 0;
  if (Date.now() - lastAttempt < 5000) return;
  walletLoadAttempts.set(chatId, Date.now());
  try {
    const rows = await Promise.race([
      storage.getTelegramWallets(chatId.toString()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DB timeout")), 3000)),
    ]);
    if (rows.length > 0) {
      const wallets: string[] = [];
      let activeIdx = 0;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].walletAddress.startsWith("sol:")) continue;
        wallets.push(rows[i].walletAddress);
        if (rows[i].isActive) activeIdx = wallets.length - 1;
        if (rows[i].encryptedPrivateKey) {
          walletsWithKey.add(`${chatId}:${rows[i].walletAddress}`);
        }
      }
      if (wallets.length > 0) {
        telegramWalletMap.set(chatId, { wallets, active: activeIdx });
      }
    }
  } catch (e: any) {
    console.error("[TelegramBot] DB wallet lookup error:", e.message);
  }
}

function getUserWallets(chatId: number): string[] {
  const data = telegramWalletMap.get(chatId);
  return data ? data.wallets : [];
}

function getActiveWalletIndex(chatId: number): number {
  const data = telegramWalletMap.get(chatId);
  return data ? data.active : 0;
}

function setActiveWallet(chatId: number, index: number): boolean {
  const data = telegramWalletMap.get(chatId);
  if (!data || index < 0 || index >= data.wallets.length) return false;
  data.active = index;
  telegramWalletMap.set(chatId, data);
  storage.setActiveTelegramWallet(chatId.toString(), data.wallets[index]).catch(e =>
    console.error("[TelegramBot] DB setActive error:", e));
  return true;
}

function removeWallet(chatId: number, index: number): boolean {
  const data = telegramWalletMap.get(chatId);
  if (!data || index < 0 || index >= data.wallets.length) return false;
  const removedAddr = data.wallets[index];
  data.wallets.splice(index, 1);
  storage.removeTelegramWallet(chatId.toString(), removedAddr).catch(e =>
    console.error("[TelegramBot] DB remove error:", e));
  if (data.wallets.length === 0) {
    telegramWalletMap.delete(chatId);
    return true;
  }
  if (data.active >= data.wallets.length) data.active = 0;
  telegramWalletMap.set(chatId, data);
  if (data.wallets.length > 0) {
    storage.setActiveTelegramWallet(chatId.toString(), data.wallets[data.active]).catch(e =>
      console.error("[TelegramBot] DB setActive after remove error:", e));
  }
  return true;
}

export function getChatIdByWallet(wallet: string): number | undefined {
  const lowerWallet = wallet.toLowerCase();
  for (const [chatId, data] of telegramWalletMap.entries()) {
    if (data.wallets.includes(lowerWallet)) return chatId;
  }
  return undefined;
}

export function linkTelegramWallet(chatId: number, wallet: string, privateKey?: string): void {
  const lower = wallet.toLowerCase();
  const existing = telegramWalletMap.get(chatId);

  if (existing) {
    if (!existing.wallets.includes(lower)) {
      existing.wallets.push(lower);
      existing.active = existing.wallets.length - 1;
      telegramWalletMap.set(chatId, existing);
    } else {
      existing.active = existing.wallets.indexOf(lower);
      telegramWalletMap.set(chatId, existing);
    }
  } else {
    telegramWalletMap.set(chatId, { wallets: [lower], active: 0 });
  }

  if (privateKey) {
    walletsWithKey.add(`${chatId}:${lower}`);
  }

  storage.saveTelegramWallet(chatId.toString(), lower, privateKey || undefined).then(() => {
    storage.setActiveTelegramWallet(chatId.toString(), lower).catch(e =>
      console.error("[TelegramBot] DB setActive error:", e));
  }).catch(e => console.error("[TelegramBot] DB save error:", e));

  console.log(`[TelegramBot] Wallet linked via web for chatId ${chatId}: ${wallet.substring(0, 8)}...`);
  if (bot) {
    const count = getUserWallets(chatId).length;
    const msg = count > 1
      ? `Wallet added: ${shortWallet(lower)} (${count} wallets — this one is now active)`
      : `Wallet connected: ${shortWallet(lower)}`;
    bot.sendMessage(chatId, msg, { reply_markup: mainMenuKeyboard(undefined, chatId) }).catch(() => {});
  }
}

function shortModel(m: string): string {
  if (m.includes("Llama")) return "Llama 70B";
  if (m.includes("DeepSeek")) return "DeepSeek V3";
  if (m.includes("Qwen")) return "Qwen 72B";
  return m.split("/").pop() || m;
}

function shortWallet(w: string): string {
  return `${w.substring(0, 6)}...${w.substring(38)}`;
}

const BOT_PRICE_USD = 19.99;
const TRIAL_DAYS = 4;
const TREASURY_WALLET = "0x5Ff57464152c9285A8526a0665d996dA66e2def1";

const USDT_ADDRESSES: Record<string, string> = {
  "56": "0x55d398326f99059ff775485246999027b3197955",
  "8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "1": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
};

const PREMIUM_ACTIONS = new Set([
  "action:okxsignals", "action:okxswap", "action:okxbridge", "action:okxsecurity",
  "action:okxtrending", "action:okxmeme", "action:okxprice",
  "action:buy", "action:sell", "action:trade", "action:launchtoken",
]);

const FREE_TIER_LIMITS: Record<string, number> = {
  "action:okxsignals": 3,
  "action:okxsecurity": 2,
  "action:okxtrending": 3,
  "action:okxmeme": 3,
  "action:okxprice": 5,
};
const freeTierUsage = new Map<string, { count: number; date: string }>();

function checkFreeTierLimit(chatId: number, action: string): { allowed: boolean; remaining: number; limit: number } {
  const limit = FREE_TIER_LIMITS[action];
  if (!limit) return { allowed: false, remaining: 0, limit: 0 };
  const today = new Date().toISOString().split("T")[0];
  const key = `${chatId}:${action}:${today}`;
  const usage = freeTierUsage.get(key);
  if (!usage || usage.date !== today) {
    return { allowed: true, remaining: limit - 1, limit };
  }
  if (usage.count >= limit) {
    return { allowed: false, remaining: 0, limit };
  }
  return { allowed: true, remaining: limit - usage.count - 1, limit };
}

function recordFreeTierUsage(chatId: number, action: string): void {
  const today = new Date().toISOString().split("T")[0];
  const key = `${chatId}:${action}:${today}`;
  const usage = freeTierUsage.get(key);
  if (!usage || usage.date !== today) {
    freeTierUsage.set(key, { count: 1, date: today });
  } else {
    usage.count++;
  }
}

const TRANSACTION_FEE_PERCENT = 1.0;
const trialRemindersSent = new Set<string>();
const pendingExportVerification = new Map<number, { walletIdx: number; code: string; expiresAt: number; type: "evm" | "sol" }>();

const subCache = new Map<number, { status: string; expiresAt: Date | null; checkedAt: number }>();

async function checkSubscription(chatId: number): Promise<{ allowed: boolean; status: string; daysLeft?: number; message?: string }> {
  const cached = subCache.get(chatId);
  if (cached && Date.now() - cached.checkedAt < 60_000) {
    if (cached.status === "active" || cached.status === "trial") {
      const now = new Date();
      if (cached.expiresAt && cached.expiresAt > now) {
        const daysLeft = Math.ceil((cached.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        return { allowed: true, status: cached.status, daysLeft };
      }
    }
  }

  let sub: any = null;
  try {
    sub = await storage.getBotSubscriptionByChatId(chatId.toString());
  } catch (e: any) {
    console.error("[Subscription] DB lookup failed:", e.message);
    return { allowed: false, status: "none", message: "Subscription system temporarily unavailable. Please try again." };
  }
  if (!sub) {
    const wallet = getLinkedWallet(chatId);
    if (wallet) {
      try {
        const newSub = await storage.createBotSubscription(wallet, chatId.toString());
        const daysLeft = TRIAL_DAYS;
        subCache.set(chatId, { status: "trial", expiresAt: newSub.expiresAt, checkedAt: Date.now() });
        const existingAgents = await storage.getAgentsByWallet(wallet);
        if (existingAgents.length === 0) {
          pendingAgentCreation.set(chatId, { step: "name", mandatory: true });
          if (bot) {
            await bot.sendMessage(chatId,
              `🎉 *Welcome to BUILD4!* Your 4-day free trial is active.\n\n` +
              `🧠 *First, let's create your AI Agent*\n\n` +
              `Your agent is the brain behind BUILD4 — without it, the bot can't trade, scan, or analyze for you.\n\n` +
              `What would you like to name your agent? _(1-50 characters)_`,
              { parse_mode: "Markdown" }
            );
          }
        }
        return { allowed: true, status: "trial", daysLeft };
      } catch (e: any) {
        console.error("[Subscription] Trial creation failed:", e.message);
        return { allowed: false, status: "none", message: "Could not start trial. Please try again." };
      }
    }
    return { allowed: false, status: "none", message: "Set up a wallet first with /start" };
  }

  const now = new Date();
  if (sub.expiresAt && sub.expiresAt > now) {
    const daysLeft = Math.ceil((sub.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    subCache.set(chatId, { status: sub.status, expiresAt: sub.expiresAt, checkedAt: Date.now() });
    return { allowed: true, status: sub.status, daysLeft };
  }

  subCache.set(chatId, { status: "expired", expiresAt: sub.expiresAt, checkedAt: Date.now() });
  return { allowed: false, status: "expired", message: "Your subscription has expired." };
}

function subscriptionExpiredMessage(): { text: string; markup: TelegramBot.InlineKeyboardMarkup } {
  return {
    text:
      `⚡ *BUILD4 Premium Required*\n\n` +
      `This feature requires an active subscription.\n` +
      `Trading (buy/sell/swap/bridge) and token launching are premium-only.\n\n` +
      `🆓 *Free tier available:*\n` +
      `• 3 signal checks/day\n` +
      `• 2 security scans/day\n` +
      `• 5 price checks/day\n\n` +
      `💰 *$${BOT_PRICE_USD}/month* — Unlimited everything:\n` +
      `• 🐋 Smart Money Signals\n` +
      `• ⚡ Instant Buy & Sell\n` +
      `• 🔄 DEX Swap & Bridge\n` +
      `• 🔒 Security Scanner\n` +
      `• 🔥 Trending & Meme Scanner\n` +
      `• 💎 Autonomous Trading Agent\n` +
      `• 🚀 Token Launcher\n\n` +
      `Pay with USDT on BNB Chain or Base.\n` +
      `🎁 Start with a *${TRIAL_DAYS}-day free trial!*`,
    markup: {
      inline_keyboard: [
        [{ text: `🆓 Start ${TRIAL_DAYS}-Day Free Trial`, callback_data: "action:subscribe" }],
        [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
        [{ text: "🔗 Refer & Earn 30-50%", callback_data: "action:referral" }],
        [{ text: "« Menu", callback_data: "action:menu" }],
      ],
    },
  };
}

const agentCache = new Map<string, { agents: any[]; ts: number }>();
const AGENT_CACHE_TTL = 15_000;

async function getMyAgents(wallet: string) {
  const cached = agentCache.get(wallet);
  if (cached && Date.now() - cached.ts < AGENT_CACHE_TTL) return cached.agents;
  const agents = await storage.getAgentsByWallet(wallet);
  agentCache.set(wallet, { agents, ts: Date.now() });
  return agents;
}

const solanaWalletMap = new Map<number, { address: string; privateKey: string }>();

async function getOrCreateSolanaWallet(chatId: number): Promise<{ address: string; privateKey: string }> {
  const cached = solanaWalletMap.get(chatId);
  if (cached) return cached;

  try {
    const existing = await storage.getTelegramWalletPrivateKey(chatId.toString(), `sol:${chatId}`);
    if (existing) {
      const [addr, pk] = existing.split(":");
      const entry = { address: addr, privateKey: pk };
      solanaWalletMap.set(chatId, entry);
      return entry;
    }
  } catch {}

  const { Keypair } = await import("@solana/web3.js");
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  const privateKey = Buffer.from(keypair.secretKey).toString("hex");

  await storage.saveTelegramWallet(chatId.toString(), `sol:${chatId}`, `${address}:${privateKey}`);
  const entry = { address, privateKey };
  solanaWalletMap.set(chatId, entry);
  return entry;
}

async function autoGenerateWallet(chatId: number): Promise<string> {
  if (!bot) throw new Error("Bot not initialized");
  const wallet = ethers.Wallet.createRandom();
  const addr = wallet.address.toLowerCase();
  const pk = wallet.privateKey;
  auditLog(chatId, "WALLET_CREATE", `New EVM wallet generated: ${maskAddress(addr)}`);

  const existing = telegramWalletMap.get(chatId);
  if (existing) {
    if (!existing.wallets.includes(addr)) {
      existing.wallets.push(addr);
      existing.active = existing.wallets.length - 1;
    } else {
      existing.active = existing.wallets.indexOf(addr);
    }
    telegramWalletMap.set(chatId, existing);
  } else {
    telegramWalletMap.set(chatId, { wallets: [addr], active: 0 });
  }

  await storage.saveTelegramWallet(chatId.toString(), addr, pk);
  await storage.setActiveTelegramWallet(chatId.toString(), addr);
  walletsWithKey.add(`${chatId}:${addr}`);

  const pkMsg = await bot.sendMessage(chatId,
    `🔑 Wallet created!\n\n` +
    `Address:\n\`${addr}\`\n\n` +
    `Private Key:\n\`${pk}\`\n\n` +
    `⚠️ SAVE YOUR PRIVATE KEY NOW — this message will be auto-deleted in 30 seconds.\n` +
    `Send BNB to your address to fund it.`,
    { parse_mode: "Markdown" }
  );

  setTimeout(() => {
    try { bot!.deleteMessage(chatId, pkMsg.message_id); } catch {}
  }, 30000);

  return addr;
}

async function checkWalletHasKey(chatId: number, wallet: string | undefined): Promise<boolean> {
  if (!wallet) return false;
  if (wallet.startsWith("sol:")) return false;
  if (walletsWithKey.has(`${chatId}:${wallet}`)) return true;
  try {
    const pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
    if (pk) {
      walletsWithKey.add(`${chatId}:${wallet}`);
      return true;
    }
  } catch {}
  return false;
}

async function ensureWallet(chatId: number): Promise<string> {
  let wallet = getLinkedWallet(chatId);
  if (!wallet) {
    wallet = await autoGenerateWallet(chatId);
  }
  return wallet;
}

async function regenerateWalletWithKey(chatId: number): Promise<string | null> {
  if (!bot) return null;
  try {
    const newAddr = await autoGenerateWallet(chatId);
    await bot.sendMessage(chatId,
      `🔄 Generated a new wallet with stored keys.\n\nNew active wallet: \`${newAddr}\`\n\n` +
      `⚠️ Fund this wallet before launching tokens.`,
      { parse_mode: "Markdown" }
    );
    return newAddr;
  } catch (e: any) {
    console.error("[TelegramBot] regenerateWalletWithKey error:", e.message);
    return null;
  }
}

const balanceCache = new Map<string, { bnb: string; eth: string; usdt: string; ts: number }>();
const BALANCE_CACHE_TTL = 30_000;
const bnbProviderCached = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
const baseProviderCached = new ethers.JsonRpcProvider("https://mainnet.base.org");

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";

async function fetchUsdtBalance(wallet: string): Promise<string> {
  try {
    const contract = new ethers.Contract(BSC_USDT, ERC20_BALANCE_ABI, bnbProviderCached);
    const bal = await contract.balanceOf(wallet);
    return parseFloat(ethers.formatUnits(bal, 18)).toFixed(2);
  } catch {
    return "0.00";
  }
}

async function fetchWalletBalances(wallets: string[]): Promise<Record<string, { bnb: string; eth: string; usdt: string }>> {
  const result: Record<string, { bnb: string; eth: string; usdt: string }> = {};
  const now = Date.now();
  const uncached: string[] = [];

  for (const w of wallets) {
    const cached = balanceCache.get(w);
    if (cached && now - cached.ts < BALANCE_CACHE_TTL) {
      result[w] = { bnb: cached.bnb, eth: cached.eth, usdt: cached.usdt };
    } else {
      uncached.push(w);
    }
  }

  if (uncached.length === 0) return result;

  await Promise.all(uncached.map(async (w) => {
    try {
      const [bnbBal, ethBal, usdtBal] = await Promise.all([
        bnbProviderCached.getBalance(w).catch(() => BigInt(0)),
        baseProviderCached.getBalance(w).catch(() => BigInt(0)),
        fetchUsdtBalance(w),
      ]);
      const bnbStr = parseFloat(ethers.formatEther(bnbBal)).toFixed(4);
      const ethStr = parseFloat(ethers.formatEther(ethBal)).toFixed(4);
      result[w] = { bnb: bnbStr, eth: ethStr, usdt: usdtBal };
      balanceCache.set(w, { bnb: bnbStr, eth: ethStr, usdt: usdtBal, ts: now });
    } catch {
      result[w] = { bnb: "0.0000", eth: "0.0000", usdt: "0.00" };
    }
  }));

  return result;
}

const pendingTransfer = new Map<number, { token: string; amount?: string; toAddress?: string }>();

async function handleTransfer(chatId: number): Promise<void> {
  if (!bot) return;
  const wallet = getLinkedWallet(chatId);
  if (!wallet) {
    await bot.sendMessage(chatId, "❌ You need a wallet first.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    return;
  }
  const hasKey = await checkWalletHasKey(chatId, wallet);
  if (!hasKey) {
    await bot.sendMessage(chatId, "❌ Your wallet is view-only. Generate or import a wallet with a private key.", { reply_markup: { inline_keyboard: [[{ text: "🔑 Generate Wallet", callback_data: "action:genwallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    return;
  }
  await bot.sendMessage(chatId,
    `💸 *Transfer from Wallet*\n\nSelect token to send:`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "BNB", callback_data: "transfer_token:bnb" }, { text: "USDT (BEP-20)", callback_data: "transfer_token:usdt" }],
      [{ text: "ETH (Base)", callback_data: "transfer_token:eth" }],
      [{ text: "« Wallet", callback_data: "action:wallet" }],
    ]}}
  );
}

async function handlePayFromWallet(chatId: number): Promise<void> {
  if (!bot) return;
  const wallet = getLinkedWallet(chatId);
  if (!wallet) {
    await bot.sendMessage(chatId, "❌ You need a wallet first.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    return;
  }
  const hasKey = await checkWalletHasKey(chatId, wallet);
  if (!hasKey) {
    await bot.sendMessage(chatId, "❌ Your wallet is view-only. Generate or import a wallet with a private key to pay.", { reply_markup: { inline_keyboard: [[{ text: "🔑 Generate Wallet", callback_data: "action:genwallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    return;
  }

  await bot.sendMessage(chatId, `⏳ Checking your balances...`);
  sendTyping(chatId);

  const [usdtBal, bnbRaw, ethRaw] = await Promise.all([
    fetchUsdtBalance(wallet),
    bnbProviderCached.getBalance(wallet).catch(() => BigInt(0)),
    baseProviderCached.getBalance(wallet).catch(() => BigInt(0)),
  ]);
  const bnbBal = parseFloat(ethers.formatEther(bnbRaw));
  const ethBal = parseFloat(ethers.formatEther(ethRaw));

  const solWallet = solanaWalletMap.get(chatId);
  let solBal = 0;
  if (solWallet) {
    try {
      const { Connection, PublicKey } = await import("@solana/web3.js");
      const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
      const lamports = await conn.getBalance(new PublicKey(solWallet.address));
      solBal = lamports / 1e9;
    } catch {}
  }

  let balText = `💰 *Pay Subscription — $${BOT_PRICE_USD}/mo*\n\n`;
  balText += `📊 *Your Balances:*\n`;
  balText += `• BNB: *${bnbBal.toFixed(4)}*\n`;
  balText += `• USDT (BSC): *${usdtBal}*\n`;
  balText += `• ETH (Base): *${ethBal.toFixed(4)}*\n`;
  if (solWallet) balText += `• SOL: *${solBal.toFixed(4)}*\n`;
  balText += `\nSelect how you'd like to pay:`;

  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  if (parseFloat(usdtBal) >= BOT_PRICE_USD) {
    buttons.push([{ text: `💵 Pay with USDT (${usdtBal})`, callback_data: "action:autopay_usdt" }]);
  }
  if (bnbBal >= 0.03) {
    buttons.push([{ text: `🟡 Pay with BNB (${bnbBal.toFixed(4)})`, callback_data: "autopay_native:56" }]);
  }
  if (ethBal >= 0.005) {
    buttons.push([{ text: `🔵 Pay with ETH on Base (${ethBal.toFixed(4)})`, callback_data: "autopay_native:8453" }]);
  }
  if (solBal >= 0.1) {
    buttons.push([{ text: `🟣 Pay with SOL (${solBal.toFixed(4)})`, callback_data: "action:autopay_sol" }]);
  }

  if (buttons.length === 0) {
    balText += `\n\n❌ *No sufficient balance found*\nFund any of your wallets to pay:\n\nEVM: \`${wallet}\``;
    if (solWallet) balText += `\nSOL: \`${solWallet.address}\``;
    buttons.push([{ text: "🔄 Check Again", callback_data: "action:payfromwallet" }]);
  }

  buttons.push([{ text: "❌ Cancel", callback_data: "action:subscribe" }]);

  await bot.sendMessage(chatId, balText, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
}

function getWalletConnectUrl(chatId?: number): string {
  const base = appBaseUrl || "https://build4.io";
  const url = `${base}/api/web4/telegram-wallet`;
  if (!chatId) return url;
  const { createHmac } = require("crypto");
  const secret = process.env.SESSION_SECRET || process.env.TELEGRAM_BOT_TOKEN;
  if (!secret) {
    console.error("[TelegramBot] No SESSION_SECRET or TELEGRAM_BOT_TOKEN for wallet link signing");
    return `${url}?chatId=${chatId}`;
  }
  const expires = Math.floor(Date.now() / 1000) + 600;
  const payload = `${chatId}:${expires}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex").substring(0, 16);
  return `${url}?chatId=${chatId}&exp=${expires}&sig=${sig}`;
}

async function handleSubscribe(chatId: number): Promise<void> {
  if (!bot) return;

  try {
    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId,
        "❌ You need a wallet first. Use /start to create or link one.",
        { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    let sub: any = null;
    try {
      sub = await storage.getBotSubscriptionByChatId(chatId.toString());
    } catch (e: any) {
      console.error("[Subscribe] DB lookup failed:", e.message);
    }

    if (sub && sub.status === "active" && sub.expiresAt && sub.expiresAt > new Date()) {
      const daysLeft = Math.ceil((sub.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      await bot.sendMessage(chatId,
        `✅ *You're already subscribed!*\n\n` +
        `Status: Active\nExpires: ${sub.expiresAt.toISOString().split("T")[0]}\n` +
        `Days remaining: ${daysLeft}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    if (sub && sub.status === "trial" && sub.expiresAt && sub.expiresAt > new Date()) {
      const daysLeft = Math.ceil((sub.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      await bot.sendMessage(chatId,
        `🎉 *Your free trial is active!*\n\n` +
        `Days remaining: ${daysLeft}\n` +
        `Expires: ${sub.expiresAt.toISOString().split("T")[0]}\n\n` +
        `You have full access to all premium features.\n` +
        `Subscribe before it expires to keep uninterrupted access.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "💰 Pay From My Wallet", callback_data: "action:payfromwallet" }],
          [{ text: `💳 Subscribe Now — $${BOT_PRICE_USD}/mo`, callback_data: "action:paynow" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ]}}
      );
      return;
    }

    if (!sub) {
      try {
        await storage.createBotSubscription(wallet, chatId.toString());
        subCache.delete(chatId);
        console.log(`[Trial] Free trial activated for chatId=${chatId}, wallet=${wallet}`);
        await bot.sendMessage(chatId,
          `🎉 *Your ${TRIAL_DAYS}-day free trial is now active!*\n\n` +
          `You have full unlimited access to:\n` +
          `• 🐋 Smart Money Signals\n` +
          `• ⚡ Instant Buy & Sell\n` +
          `• 🔄 DEX Swap & Bridge\n` +
          `• 🔒 Security Scanner\n` +
          `• 🔥 Trending & Meme Scanner\n` +
          `• 💎 Autonomous Trading Agent\n` +
          `• 🚀 Token Launcher\n\n` +
          `Your trial expires in ${TRIAL_DAYS} days. Subscribe anytime to keep access.\n\n` +
          `🔗 Share your referral link and earn 30-50% on every subscription!`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
            [{ text: "🚀 Start Trading", callback_data: "action:menu" }],
            [{ text: "🔗 Get Referral Link", callback_data: "action:referral" }],
          ]}}
        );
        return;
      } catch (e: any) {
        console.error("[Trial] Failed to create trial:", e.message);
      }
    }

    await bot.sendMessage(chatId,
      `💳 *BUILD4 Premium Subscription*\n\n` +
      `Price: *$${BOT_PRICE_USD} USDT/month*\n\n` +
      `Send exactly *${BOT_PRICE_USD} USDT* to:\n\n` +
      `\`${TREASURY_WALLET}\`\n\n` +
      `✅ Accepted chains:\n` +
      `• BNB Chain (BSC) — USDT BEP-20\n` +
      `• Base — USDC\n\n` +
      `⚠️ Send from your linked wallet:\n` +
      `\`${wallet}\`\n\n` +
      `After sending, tap "✅ I've Paid" to verify.\n\nOr pay directly from your bot wallet:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Pay From My Wallet", callback_data: "action:payfromwallet" }],
            [{ text: "✅ I've Paid — Verify Now", callback_data: "action:verifypayment" }],
            [{ text: "📊 Subscription Status", callback_data: "action:substatus" }],
            [{ text: "« Menu", callback_data: "action:menu" }],
          ],
        },
      }
    );
  } catch (e: any) {
    console.error("[Subscribe] Error:", e.message);
    await bot.sendMessage(chatId, `❌ Something went wrong: ${e.message?.substring(0, 100)}\n\nPlease try again.`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:subscribe" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
  }
}

async function verifyViaEtherscanV2(wallet: string, chainId: number, apiKey: string): Promise<{ hash: string; value: number; chainName: string } | null> {
  const chainNames: Record<number, string> = { 56: "BNB Chain", 8453: "Base" };
  const chainName = chainNames[chainId] || `Chain ${chainId}`;
  const usdtAddr = USDT_ADDRESSES[chainId.toString()];
  if (!usdtAddr) return null;

  if (!apiKey) {
    console.log(`[VerifyEtherscan] Skipping ${chainName} — no API key set (BSCSCAN_API_KEY or ETHERSCAN_API_KEY)`);
    return null;
  }

  const lookupAddresses = [TREASURY_WALLET, wallet];
  for (const lookupAddr of lookupAddresses) {
    try {
      const params = new URLSearchParams({
        chainid: chainId.toString(),
        module: "account",
        action: "tokentx",
        contractaddress: usdtAddr,
        address: lookupAddr,
        page: "1",
        offset: "100",
        sort: "desc",
        apikey: apiKey,
      });
      const apiUrl = `https://api.etherscan.io/v2/api?${params}`;
      console.log(`[VerifyEtherscan] ${chainName} lookup=${lookupAddr.substring(0,10)} key=${apiKey.substring(0,6)}...`);
      const resp = await fetch(apiUrl);
      const json = await resp.json() as any;
      console.log(`[VerifyEtherscan] ${chainName} status=${json.status} msg=${json.message} results=${Array.isArray(json.result) ? json.result.length : String(json.result).substring(0, 120)}`);

      if (json.status === "1" && Array.isArray(json.result)) {
        for (const tx of json.result) {
          if (tx.to?.toLowerCase() !== TREASURY_WALLET.toLowerCase()) continue;
          if (tx.from?.toLowerCase() !== wallet.toLowerCase()) continue;
          const decimals = parseInt(tx.tokenDecimal || "18");
          const value = parseFloat(tx.value) / Math.pow(10, decimals);
          if (value >= BOT_PRICE_USD - 0.50) {
            return { hash: tx.hash, value, chainName };
          }
        }
      }
    } catch (e: any) {
      console.error(`[VerifyEtherscan] ${chainName} error:`, e.message?.substring(0, 100));
    }
  }
  return null;
}

async function verifyViaRPC(wallet: string, chainId: number): Promise<{ hash: string; value: number; chainName: string } | null> {
  const RPC_MAP: Record<number, { name: string; usdt: string; decimals: number }> = {
    56: { name: "BNB Chain", usdt: BSC_USDT, decimals: 18 },
    8453: { name: "Base", usdt: USDT_ADDRESSES["8453"] || "", decimals: 6 },
  };

  const cfg = RPC_MAP[chainId];
  if (!cfg || !cfg.usdt) return null;

  try {
    const provider = chainId === 56 ? bnbProviderCached : baseProviderCached;
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const fromPadded = ethers.zeroPadValue(wallet.toLowerCase(), 32);
    const toPadded = ethers.zeroPadValue(TREASURY_WALLET.toLowerCase(), 32);

    const currentBlock = await provider.getBlockNumber();
    const blocksToScan = chainId === 56 ? 5_000 : 25_000;
    const fromBlock = Math.max(0, currentBlock - blocksToScan);

    console.log(`[VerifyRPC] ${cfg.name} scanning blocks ${fromBlock}..${currentBlock} (last ~${blocksToScan})`);

    const logs = await provider.getLogs({
      address: cfg.usdt,
      topics: [transferTopic, fromPadded, toPadded],
      fromBlock,
      toBlock: currentBlock,
    });

    console.log(`[VerifyRPC] ${cfg.name} found ${logs.length} matching Transfer logs`);

    for (const log of logs) {
      const rawValue = BigInt(log.data);
      const value = parseFloat(ethers.formatUnits(rawValue, cfg.decimals));
      console.log(`[VerifyRPC] ${cfg.name} TX ${log.transactionHash.substring(0,20)} value=${value}`);
      if (value >= BOT_PRICE_USD - 0.50) {
        return { hash: log.transactionHash, value, chainName: cfg.name };
      }
    }
  } catch (err: any) {
    console.error(`[VerifyRPC] ${cfg.name} error:`, err.message?.substring(0, 150));
  }
  return null;
}

async function handleVerifyPayment(chatId: number): Promise<void> {
  if (!bot) return;

  try {
  const wallet = getLinkedWallet(chatId);
  if (!wallet) {
    await bot.sendMessage(chatId, "❌ No wallet linked. Use /start first.");
    return;
  }

  await bot.sendMessage(chatId, `🔍 Checking for USDT payment on BNB Chain and Base...\n_Wallet: \`${wallet.substring(0,10)}...\`_`, { parse_mode: "Markdown" });
  sendTyping(chatId);

  const scanApiKey = process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "";
  const chainIds = [56, 8453];
  let foundTx: { hash: string; value: number; chainName: string } | null = null;

  console.log(`[VerifyPayment] Starting verification wallet=${wallet.substring(0,10)} apiKey=${scanApiKey ? scanApiKey.substring(0,6) + "..." : "NONE"}`);

  for (const chainId of chainIds) {
    foundTx = await verifyViaEtherscanV2(wallet, chainId, scanApiKey);
    if (foundTx) break;

    foundTx = await verifyViaRPC(wallet, chainId);
    if (foundTx) break;
  }

  if (!foundTx) {
    try {
      const { getWalletTransactionHistory } = await import("./okx-onchainos");
      for (const chainId of chainIds) {
        const usdtAddr = USDT_ADDRESSES[chainId.toString()];
        if (!usdtAddr) continue;
        for (const lookupAddr of [wallet, TREASURY_WALLET]) {
          console.log(`[VerifyPayment] OKX fallback chain=${chainId} lookup=${lookupAddr.substring(0,10)}`);
          const okxRes = await getWalletTransactionHistory({ address: lookupAddr, chainId: chainId.toString(), limit: "50" });
          const txList = okxRes?.data || [];
          if (!Array.isArray(txList)) continue;
          console.log(`[VerifyPayment] OKX results=${txList.length}`);
          for (const tx of txList) {
            const details = tx.tokenTransferDetails || tx.details || [];
            for (const d of (Array.isArray(details) ? details : [])) {
              const tokenAddr = (d.tokenContractAddress || d.contractAddress || "").toLowerCase();
              if (tokenAddr !== usdtAddr.toLowerCase()) continue;
              if ((d.to || tx.to || "").toLowerCase() !== TREASURY_WALLET.toLowerCase()) continue;
              if ((d.from || tx.from || "").toLowerCase() !== wallet.toLowerCase()) continue;
              const rawAmt = d.amount || d.tokenAmount || d.value || "0";
              const value = parseFloat(rawAmt);
              if (value >= BOT_PRICE_USD - 0.50) {
                foundTx = { hash: tx.txHash || tx.hash, value, chainName: chainId === 56 ? "BNB Chain" : "Base" };
                break;
              }
            }
            if (foundTx) break;
          }
          if (foundTx) break;
        }
        if (foundTx) break;
      }
    } catch (okxErr: any) {
      console.error(`[VerifyPayment] OKX fallback error:`, okxErr.message);
    }
  }

  if (foundTx) {
    const { hash, value, chainName } = foundTx;
    const chainId = chainName === "BNB Chain" ? 56 : 8453;
    const existingSub = await storage.getBotSubscription(wallet);
    if (existingSub?.txHash === hash) {
      if (existingSub.status === "active") {
        await bot.sendMessage(chatId,
          `✅ *Already Active!*\n\nYour subscription is already active (paid with TX \`${hash.substring(0, 16)}...\`).`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
        );
        return;
      }
    }

    let activated = await storage.activateBotSubscription(
      wallet, hash, chainId, value.toFixed(2)
    );

    if (!activated) {
      await storage.createBotSubscription(wallet, chatId.toString());
      activated = await storage.activateBotSubscription(wallet, hash, chainId, value.toFixed(2));
    }

    subCache.delete(chatId);
    console.log(`[VerifyPayment] SUCCESS chatId=${chatId} wallet=${wallet.substring(0,8)} amount=${value.toFixed(2)} chain=${chainName} tx=${hash.substring(0,16)}`);

    await bot.sendMessage(chatId,
      `🎉 *Payment Confirmed!*\n\n` +
      `Amount: ${value.toFixed(2)} USDT\n` +
      `Chain: ${chainName}\n` +
      `TX: \`${hash.substring(0, 20)}...\`\n\n` +
      `✅ Your premium subscription is now active for 30 days.`,
      { parse_mode: "Markdown" }
    );

    const existingAgents = await storage.getAgentsByWallet(wallet);
    if (existingAgents.length === 0) {
      pendingAgentCreation.set(chatId, { step: "name", mandatory: true });
      await bot.sendMessage(chatId,
        `🧠 *Now let's set up your AI Agent*\n\n` +
        `Your agent is the brain behind BUILD4 — without it, the bot can't trade, scan, or analyze for you.\n\n` +
        `Agent creation is *included free* with your subscription.\n\n` +
        `What would you like to name your agent? _(1-50 characters)_`,
        { parse_mode: "Markdown" }
      );
    }

    try {
      const referral = await storage.getReferralByReferred(chatId.toString());
      if (referral && !referral.commissionPaid) {
        const referrerCount = await storage.getReferralCount(referral.referrerChatId);
        const commissionPct = getReferralCommissionPercent(referrerCount);
        const commissionAmt = (BOT_PRICE_USD * commissionPct / 100).toFixed(2);
        await storage.markReferralPaid(chatId.toString(), commissionAmt, commissionPct);
        console.log(`[Referral] Commission earned: referrer=${referral.referrerChatId}, referred=${chatId}, amount=$${commissionAmt}, tier=${commissionPct}%`);
        try {
          await bot.sendMessage(parseInt(referral.referrerChatId),
            `💰 *Referral Commission Earned!*\n\n` +
            `Someone you referred just subscribed!\n\n` +
            `Commission: *$${commissionAmt} USDT* (${commissionPct}%)\n` +
            `Your total referrals: ${referrerCount}\n\n` +
            `Commission will be sent to your wallet. Keep sharing your link to earn more!`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔗 My Referrals", callback_data: "action:referral" }]] } }
          );
        } catch {}
      }
    } catch (e: any) {
      console.error("[Referral] Commission tracking error:", e.message);
    }

    return;
  }

  console.log(`[VerifyPayment] FAILED chatId=${chatId} wallet=${wallet.substring(0,8)} — no matching tx found`);

  await bot.sendMessage(chatId,
    `❌ *Payment Not Found*\n\n` +
    `Could not detect a USDT payment of ~$${BOT_PRICE_USD} to the treasury wallet.\n\n` +
    `Make sure you:\n` +
    `1. Sent from your linked wallet: \`${wallet}\`\n` +
    `2. Sent to: \`${TREASURY_WALLET}\`\n` +
    `3. Sent at least ${BOT_PRICE_USD} USDT\n` +
    `4. Used BNB Chain or Base\n\n` +
    `If you just sent, wait 1-2 minutes for the chain to index the tx, then try again.\n\n` +
    `Or paste your transaction hash below for manual verification.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Check Again", callback_data: "action:verifypayment" }],
          [{ text: "📋 Paste TX Hash", callback_data: "action:verifytxhash" }],
          [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ],
      },
    }
  );
  } catch (e: any) {
    console.error("[VerifyPayment] Error:", e.message);
    await bot.sendMessage(chatId, `❌ Payment verification failed: ${e.message?.substring(0, 100)}\n\nPlease try again.`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:verifypayment" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
  }
}

async function handleSubStatus(chatId: number): Promise<void> {
  if (!bot) return;

  try {
  const sub = await storage.getBotSubscriptionByChatId(chatId.toString());
  if (!sub) {
    await bot.sendMessage(chatId,
      `📊 *Subscription Status*\n\nNo subscription found.\n\nGet started with a ${TRIAL_DAYS}-day free trial!`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
        [{ text: "« Menu", callback_data: "action:menu" }],
      ]}}
    );
    return;
  }

  const now = new Date();
  const isActive = sub.expiresAt && sub.expiresAt > now;
  const daysLeft = isActive ? Math.ceil((sub.expiresAt!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) : 0;
  const statusEmoji = isActive ? "✅" : "❌";
  const statusText = sub.status === "trial" ? "Free Trial" : sub.status === "active" ? "Active" : "Expired";

  let msg =
    `📊 *Subscription Status*\n\n` +
    `${statusEmoji} Status: *${statusText}*\n` +
    `Wallet: \`${sub.walletAddress.substring(0, 8)}...${sub.walletAddress.substring(38)}\`\n`;

  if (isActive) {
    msg += `Expires: ${sub.expiresAt!.toISOString().split("T")[0]}\nDays left: ${daysLeft}\n`;
  }
  if (sub.txHash) {
    msg += `Last TX: \`${sub.txHash.substring(0, 20)}...\`\n`;
  }

  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  if (!isActive || sub.status === "trial") {
    buttons.push([{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }]);
  }
  buttons.push([{ text: "« Menu", callback_data: "action:menu" }]);

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
  } catch (e: any) {
    console.error("[SubStatus] Error:", e.message);
    await bot.sendMessage(chatId, `❌ Could not check subscription status: ${e.message?.substring(0, 100)}\n\nPlease try again.`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:substatus" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
  }
}

function getReferralCommissionPercent(referralCount: number): number {
  if (referralCount >= 50) return 50;
  if (referralCount >= 10) return 40;
  return 30;
}

async function handleReferral(chatId: number): Promise<void> {
  if (!bot) return;

  try {
    const refCode = `ref_${chatId}`;
    const botUsername = (await bot.getMe()).username || "BUILD4_Bot";
    const refLink = `https://t.me/${botUsername}?start=${refCode}`;

    let referralCount = 0;
    let paidCount = 0;
    let totalEarned = 0;
    try {
      const referrals = await storage.getReferralsByReferrer(chatId.toString());
      referralCount = referrals.length;
      paidCount = referrals.filter((r: any) => r.commissionPaid).length;
      totalEarned = referrals
        .filter((r: any) => r.commissionPaid && r.commissionAmount)
        .reduce((sum: number, r: any) => sum + parseFloat(r.commissionAmount || "0"), 0);
    } catch (e: any) {
      console.error("[Referral] DB lookup failed:", e.message);
    }

    const currentTier = getReferralCommissionPercent(referralCount);
    let nextTierText = "";
    if (referralCount < 10) {
      nextTierText = `\n📈 *Next tier:* Refer ${10 - referralCount} more to earn 40%`;
    } else if (referralCount < 50) {
      nextTierText = `\n📈 *Next tier:* Refer ${50 - referralCount} more to earn 50%`;
    } else {
      nextTierText = `\n🏆 *Max tier reached!* You're earning 50% on every referral`;
    }

    await bot.sendMessage(chatId,
      `🔗 *BUILD4 Referral Program*\n\n` +
      `Share your link and earn commissions on every subscription!\n\n` +
      `💰 *Commission Tiers:*\n` +
      `• 1-10 referrals → *30%* ($${(BOT_PRICE_USD * 0.3).toFixed(2)}/sub)\n` +
      `• 10-50 referrals → *40%* ($${(BOT_PRICE_USD * 0.4).toFixed(2)}/sub)\n` +
      `• 50+ referrals → *50%* ($${(BOT_PRICE_USD * 0.5).toFixed(2)}/sub)\n\n` +
      `📊 *Your Stats:*\n` +
      `• Referrals: ${referralCount}\n` +
      `• Paid subscriptions: ${paidCount}\n` +
      `• Total earned: $${totalEarned.toFixed(2)} USDT\n` +
      `• Current tier: *${currentTier}%*` +
      nextTierText + `\n\n` +
      `🔗 *Your Referral Link:*\n` +
      `\`${refLink}\`\n\n` +
      `Share this link — when someone joins and subscribes, you earn!`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "« Menu", callback_data: "action:menu" }],
          ],
        },
      }
    );
  } catch (e: any) {
    console.error("[Referral] Error:", e.message);
    await bot.sendMessage(chatId, `❌ Something went wrong: ${e.message?.substring(0, 100)}`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:referral" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
  }
}

async function sendTrialReminders(): Promise<void> {
  if (!bot) return;
  try {
    const allSubs = await storage.getAllBotSubscriptions();
    const now = new Date();
    for (const sub of allSubs) {
      if (sub.status !== "trial" || !sub.expiresAt) continue;
      const expiresAt = new Date(sub.expiresAt);
      const hoursLeft = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      const chatId = parseInt(sub.chatId);
      if (isNaN(chatId)) continue;

      if (hoursLeft > 0 && hoursLeft <= 24) {
        const key = `${chatId}:day1`;
        if (trialRemindersSent.has(key)) continue;
        trialRemindersSent.add(key);
        try {
          await bot.sendMessage(chatId,
            `⏰ *Your BUILD4 trial expires in less than 24 hours!*\n\n` +
            `Don't lose access to:\n` +
            `• 📊 Trading signals & security scans\n` +
            `• 🔄 Unlimited swaps & bridges\n` +
            `• 🚀 Token launcher\n` +
            `• 🤖 AI trading agent\n\n` +
            `Subscribe now to keep full access — only *$${BOT_PRICE_USD}/month*`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
              [{ text: `💳 Subscribe Now — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
              [{ text: "📊 My Subscription", callback_data: "action:substatus" }],
            ]}}
          );
        } catch {}
      } else if (hoursLeft > 24 && hoursLeft <= 48) {
        const key = `${chatId}:day2`;
        if (trialRemindersSent.has(key)) continue;
        trialRemindersSent.add(key);
        try {
          await bot.sendMessage(chatId,
            `📅 *Trial reminder:* Your free trial expires in ~${Math.ceil(hoursLeft / 24)} days.\n\n` +
            `Enjoying BUILD4? Subscribe now and keep trading with zero interruption.\n\n` +
            `💰 Only *$${BOT_PRICE_USD}/month* — unlimited everything.`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
              [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
            ]}}
          );
        } catch {}
      }

      if (hoursLeft <= 0) {
        const key = `${chatId}:expired`;
        if (trialRemindersSent.has(key)) continue;
        trialRemindersSent.add(key);
        try {
          await bot.sendMessage(chatId,
            `🔒 *Your BUILD4 trial has expired.*\n\n` +
            `You can still use limited free features daily:\n` +
            `• 3 signal checks\n` +
            `• 2 security scans\n` +
            `• 5 price checks\n\n` +
            `For unlimited access to everything, subscribe:\n` +
            `💰 *$${BOT_PRICE_USD}/month*`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
              [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
              [{ text: "🔗 Refer & Earn 30-50%", callback_data: "action:referral" }],
            ]}}
          );
        } catch {}
      }
    }
    log("[TrialReminder] Reminder cycle complete", "telegram");
  } catch (e: any) {
    console.error("[TrialReminder] Error:", e.message);
  }
}

function mainMenuKeyboard(_hasWallet?: boolean, chatId?: number): TelegramBot.InlineKeyboardMarkup {
  const c = chatId || 0;
  return {
    inline_keyboard: [
      [{ text: tr("menu.launch", c), callback_data: "action:launchtoken" }],
      [{ text: tr("menu.buy", c), callback_data: "action:buy" }, { text: tr("menu.sell", c), callback_data: "action:sell" }],
      [{ text: tr("menu.swap", c), callback_data: "action:okxswap" }, { text: tr("menu.bridge", c), callback_data: "action:okxbridge" }],
      [{ text: tr("menu.signals", c), callback_data: "action:okxsignals" }, { text: tr("menu.security", c), callback_data: "action:okxsecurity" }],
      [{ text: tr("menu.trending", c), callback_data: "action:okxtrending" }, { text: tr("menu.meme", c), callback_data: "action:okxmeme" }],
      [{ text: tr("menu.price", c), callback_data: "action:okxprice" }, { text: tr("menu.gas", c), callback_data: "action:okxgas" }],
      [{ text: tr("menu.rich", c), callback_data: "action:trade" }, { text: tr("menu.aster", c), callback_data: "action:aster" }],
      [{ text: tr("menu.createAgent", c), callback_data: "action:newagent" }, { text: tr("menu.myAgents", c), callback_data: "action:myagents" }],
      [{ text: tr("menu.newTask", c), callback_data: "action:task" }, { text: tr("menu.myTasks", c), callback_data: "action:mytasks" }],
      [{ text: tr("menu.wallet", c), callback_data: "action:wallet" }, { text: tr("menu.premium", c), callback_data: "action:substatus" }],
      [{ text: tr("menu.referral", c), callback_data: "action:referral" }, { text: tr("menu.help", c), callback_data: "action:help" }],
      [{ text: "🌐 Language / 语言", callback_data: "action:lang" }],
    ]
  };
}

function registerBotHandlers(b: TelegramBot): void {
  b.on("message", (msg) => {
    const chatId = msg.chat.id;
    if (msg.text) sendTyping(chatId);
    perChatQueue(chatId, async () => {
      const start = Date.now();
      try {
        await handleMessage(msg);
      } catch (e: any) {
        console.error("[TelegramBot] Unhandled error in message handler:", e.message);
      }
      recordTelegramMessage(Date.now() - start);
    });
  });

  b.on("callback_query", (query) => {
    if (!query.message) return;
    const chatId = query.message.chat.id;
    b.answerCallbackQuery(query.id).catch(() => {});
    sendTyping(chatId);
    perChatQueue(chatId, async () => {
      const start = Date.now();
      try {
        await handleCallbackQuery(query);
      } catch (e: any) {
        console.error("[TelegramBot] Callback query error:", e.message);
      }
      recordTelegramCallback(Date.now() - start);
    });
  });

  let conflictCount = 0;
  b.on("polling_error", (error) => {
    if (error.message?.includes("409 Conflict")) {
      conflictCount++;
      if (conflictCount <= 3) {
        console.warn(`[TelegramBot] 409 Conflict (${conflictCount}) — waiting for old instance to stop`);
      }
      return;
    }
    console.error("[TelegramBot] Polling error:", error.message);
  });
}

async function clearTelegramPolling(token: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`);
  } catch {}
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=1`);
      const data = await resp.json();
      if (data.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function setTelegramWebhook(token: string, webhookUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        max_connections: 100,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      }),
    });
    const data = await resp.json() as any;
    if (data.ok) {
      console.log(`[TelegramBot] Webhook set to ${webhookUrl}`);
      return true;
    }
    console.error("[TelegramBot] Failed to set webhook:", data.description);
    return false;
  } catch (e: any) {
    console.error("[TelegramBot] Webhook setup error:", e.message);
    return false;
  }
}

export function processWebhookUpdate(update: any): void {
  if (!bot || !isRunning) return;
  if (!update || typeof update !== "object" || (!update.message && !update.callback_query)) return;
  try {
    bot.processUpdate(update);
  } catch (e: any) {
    console.error("[TelegramBot] Webhook processUpdate error:", e.message);
  }
}

export async function startTelegramBot(webhookBaseUrl?: string): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    console.log("[TelegramBot] Skipped — bot runs on Render production only.");
    return;
  }
  if (isRunning || startingBot || !isTelegramConfigured()) return;
  startingBot = true;

  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const useWebhook = !!webhookBaseUrl;

  try {
    if (bot) {
      try { if (!webhookMode) bot.stopPolling(); } catch {}
      bot = null;
      isRunning = false;
    }

    if (useWebhook) {
      bot = new TelegramBot(token, { polling: false });
      const webhookUrl = `${webhookBaseUrl}/api/telegram/webhook/${token}`;
      const ok = await setTelegramWebhook(token, webhookUrl);
      if (!ok) {
        console.warn("[TelegramBot] Webhook failed, falling back to polling");
        return startTelegramBotPolling(token);
      }
      webhookMode = true;
    } else {
      await clearTelegramPolling(token);
      console.log("[TelegramBot] Cleared webhook and flushed pending updates");
      await new Promise(resolve => setTimeout(resolve, 3000));
      bot = new TelegramBot(token, {
        polling: { interval: 1000, autoStart: true, params: { timeout: 10 } }
      });
      webhookMode = false;
    }

    isRunning = true;

    loadWalletsFromDb().catch(e => console.error("[TelegramBot] Wallet load error:", e.message));

    const me = await bot.getMe();
    botUsername = me.username || null;
    console.log(`[TelegramBot] Started ${webhookMode ? "with webhook" : "with polling"} as @${botUsername}`);

    bot.setMyCommands([
      { command: "start", description: "Start BUILD4 and create a wallet" },
      { command: "launch", description: "Launch a token on Four.meme or Flap.sh" },
      { command: "swap", description: "Swap tokens on any chain" },
      { command: "bridge", description: "Cross-chain bridge" },
      { command: "signals", description: "Smart money & whale buy signals" },
      { command: "scan", description: "Security scanner (honeypot check)" },
      { command: "trending", description: "Hot & trending tokens" },
      { command: "meme", description: "Meme token scanner" },
      { command: "price", description: "Token price lookup" },
      { command: "gas", description: "Gas prices by chain" },
      { command: "newagent", description: "Create an AI agent" },
      { command: "wallet", description: "Wallet info and management" },
      { command: "aster", description: "Aster DEX futures & spot trading" },
      { command: "lang", description: "Switch language / 切换语言" },
      { command: "help", description: "Show all commands" },
    ]).then(() => {
      console.log("[TelegramBot] Registered bot commands");
    }).catch((e: any) => {
      console.error("[TelegramBot] Failed to set commands:", e.message);
    });

    fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ menu_button: { type: "commands" } })
    }).then(r => r.json()).then(r => {
      console.log("[TelegramBot] Set menu button:", r.ok ? "success" : r.description);
    }).catch(() => {});

    registerBotHandlers(bot);

    registerTaskHandler("ai_inference", async (data: { chatId: number; question: string; context: string }) => {
      const answer = await runInferenceWithFallback(data.question, data.context, "llama3");
      return answer;
    });

  } catch (e: any) {
    console.error("[TelegramBot] Failed to start:", e.message);
    isRunning = false;
  } finally {
    startingBot = false;
  }
}

async function startTelegramBotPolling(token: string): Promise<void> {
  try {
    await clearTelegramPolling(token);
    await new Promise(resolve => setTimeout(resolve, 3000));
    bot = new TelegramBot(token, {
      polling: { interval: 1000, autoStart: true, params: { timeout: 10 } }
    });
    webhookMode = false;
    isRunning = true;

    loadWalletsFromDb().catch(e => console.error("[TelegramBot] Wallet load error:", e.message));
    const me = await bot.getMe();
    botUsername = me.username || null;
    console.log(`[TelegramBot] Fallback started with polling as @${botUsername}`);

    registerBotHandlers(bot);

    setInterval(() => { sendTrialReminders().catch(e => console.error("[TrialReminder] Error:", e.message)); }, 6 * 60 * 60 * 1000);
    setTimeout(() => { sendTrialReminders().catch(e => console.error("[TrialReminder] Error:", e.message)); }, 60_000);

    registerTaskHandler("ai_inference", async (data: { chatId: number; question: string; context: string }) => {
      return await runInferenceWithFallback(data.question, data.context, "llama3");
    });
  } catch (e: any) {
    console.error("[TelegramBot] Polling fallback failed:", e.message);
    isRunning = false;
  } finally {
    startingBot = false;
  }
}

async function handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
  if (!bot || !query.data || !query.message) return;
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!checkRateLimit(`tg_cb:${chatId}`, 60, 60000)) {
    return;
  }

  await ensureWalletsLoaded(chatId);

  if (PREMIUM_ACTIONS.has(data)) {
    try {
      const subCheck = await checkSubscription(chatId);
      if (!subCheck.allowed) {
        if (FREE_TIER_LIMITS[data]) {
          const freeCheck = checkFreeTierLimit(chatId, data);
          if (freeCheck.allowed) {
            recordFreeTierUsage(chatId, data);
            if (freeCheck.remaining <= 1) {
              await bot.sendMessage(chatId,
                `⚡ *Free tier:* ${freeCheck.remaining} use${freeCheck.remaining === 1 ? "" : "s"} left today.\n` +
                `Upgrade to Premium for unlimited access!`,
                { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
                  [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
                ]}}
              );
            }
          } else {
            await bot.sendMessage(chatId,
              `🔒 *Daily free limit reached* (${freeCheck.limit}/${freeCheck.limit})\n\n` +
              `Upgrade to Premium for unlimited access to all features.\n\n` +
              `💰 Only *$${BOT_PRICE_USD}/month* — unlock everything!`,
              { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
                [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
                [{ text: "« Menu", callback_data: "action:menu" }],
              ]}}
            );
            return;
          }
        } else {
          const msg = subscriptionExpiredMessage();
          await bot.sendMessage(chatId, msg.text, { parse_mode: "Markdown", reply_markup: msg.markup });
          return;
        }
      }

      const hasAgent = await ensureUserHasAgent(chatId);
      if (!hasAgent) {
        pendingAgentCreation.set(chatId, { step: "name", mandatory: true });
        await bot.sendMessage(chatId,
          `🧠 *Agent Required*\n\n` +
          `Your AI agent is the brain behind BUILD4 — without it, the bot can't trade, scan, or analyze for you.\n\n` +
          `Let's set it up now — it's *free* with your subscription!\n\n` +
          `What would you like to name your agent? _(1-50 characters)_`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (subCheck.status === "trial" && subCheck.daysLeft !== undefined) {
        if (subCheck.daysLeft <= 1) {
          await bot.sendMessage(chatId,
            `⏳ *Trial ending soon!* You have less than 1 day left.\n` +
            `Subscribe now to keep full access.`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
              [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
            ]}}
          );
        } else if (subCheck.daysLeft === TRIAL_DAYS) {
          await bot.sendMessage(chatId,
            `🎉 *Welcome! Your ${TRIAL_DAYS}-day free trial has started.*\n` +
            `You have full access to all premium features.\n\n` +
            `Trial expires in ${subCheck.daysLeft} days.`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
              [{ text: "📊 Subscription Status", callback_data: "action:substatus" }],
            ]}}
          );
        }
      }
    } catch (e: any) {
      console.error("[Subscription] Check failed:", e.message);
      const msg = subscriptionExpiredMessage();
      await bot.sendMessage(chatId, msg.text, { parse_mode: "Markdown", reply_markup: msg.markup });
      return;
    }
  }

  if (data === "action:subscribe") {
    return handleSubscribe(chatId);
  }
  if (data === "action:paynow") {
    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId, "❌ You need a wallet first. Use /start to create one.",
        { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    await bot.sendMessage(chatId,
      `💳 *BUILD4 Premium — $${BOT_PRICE_USD}/month*\n\n` +
      `Send exactly *${BOT_PRICE_USD} USDT* to:\n\n` +
      `\`${TREASURY_WALLET}\`\n\n` +
      `✅ Accepted:\n` +
      `• BNB Chain — USDT BEP-20\n` +
      `• Base — USDC\n\n` +
      `⚠️ Send from:\n\`${wallet}\`\n\n` +
      `After sending, tap "✅ I've Paid" to verify.`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: "💰 Pay From My Wallet", callback_data: "action:payfromwallet" }],
        [{ text: "✅ I've Paid — Verify Now", callback_data: "action:verifypayment" }],
        [{ text: "« Menu", callback_data: "action:menu" }],
      ]}}
    );
    return;
  }
  if (data === "action:payfromwallet") {
    return handlePayFromWallet(chatId);
  }
  if (data === "action:transfer") {
    return handleTransfer(chatId);
  }
  if (data.startsWith("transfer_token:")) {
    const token = data.split(":")[1];
    pendingTransfer.set(chatId, { token });
    const tokenLabel = token === "bnb" ? "BNB" : token === "usdt" ? "USDT" : "ETH";
    await bot.sendMessage(chatId,
      `💸 *Transfer ${tokenLabel}*\n\nEnter the amount to send:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:wallet" }]] } }
    );
    return;
  }
  if (data === "action:confirm_transfer") {
    if (!checkRateLimit(`tx:${chatId}`, 2, 30000)) {
      await bot.sendMessage(chatId, "⏳ Please wait before sending another transaction.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }]] } });
      return;
    }
    const state = pendingTransfer.get(chatId);
    if (!state || !state.amount || !state.toAddress) {
      await bot.sendMessage(chatId, "❌ Transfer expired. Start again.", { reply_markup: { inline_keyboard: [[{ text: "💸 Transfer", callback_data: "action:transfer" }]] } });
      pendingTransfer.delete(chatId);
      return;
    }
    const wallet = getLinkedWallet(chatId);
    if (!wallet) { pendingTransfer.delete(chatId); return; }

    const tokenLabel = state.token === "bnb" ? "BNB" : state.token === "usdt" ? "USDT" : "ETH";
    await bot.sendMessage(chatId, `⏳ Sending ${state.amount} ${tokenLabel} to ${state.toAddress.substring(0, 8)}...`);
    sendTyping(chatId);

    try {
      let pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
      if (!pk) pk = await storage.getPrivateKeyByWalletAddress(wallet);
      if (!pk) throw new Error("Private key not found. Re-import your wallet.");

      if (state.token === "bnb") {
        const signer = new ethers.Wallet(pk, bnbProviderCached);
        const amount = ethers.parseEther(state.amount);
        const tx = await signer.sendTransaction({ to: state.toAddress, value: amount });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");
        pendingTransfer.delete(chatId);
        balanceCache.delete(wallet);
        await bot.sendMessage(chatId,
          `✅ *Transfer Successful!*\n\n` +
          `Sent ${state.amount} BNB\nTo: \`${state.toAddress}\`\n\n` +
          `[View TX](https://bscscan.com/tx/${receipt.hash})`,
          { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
        );
      } else if (state.token === "usdt") {
        const signer = new ethers.Wallet(pk, bnbProviderCached);
        const usdtContract = new ethers.Contract(BSC_USDT, [
          "function transfer(address to, uint256 amount) returns (bool)",
          "function balanceOf(address) view returns (uint256)",
        ], signer);
        const amount = ethers.parseUnits(state.amount, 18);
        const balance = await usdtContract.balanceOf(wallet);
        if (balance < amount) throw new Error(`Insufficient USDT. Have ${parseFloat(ethers.formatUnits(balance, 18)).toFixed(2)}, need ${state.amount}`);
        const tx = await usdtContract.transfer(state.toAddress, amount);
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");
        pendingTransfer.delete(chatId);
        balanceCache.delete(wallet);
        await bot.sendMessage(chatId,
          `✅ *Transfer Successful!*\n\n` +
          `Sent ${state.amount} USDT\nTo: \`${state.toAddress}\`\n\n` +
          `[View TX](https://bscscan.com/tx/${receipt.hash})`,
          { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
        );
      } else if (state.token === "eth") {
        const signer = new ethers.Wallet(pk, baseProviderCached);
        const amount = ethers.parseEther(state.amount);
        const tx = await signer.sendTransaction({ to: state.toAddress, value: amount });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");
        pendingTransfer.delete(chatId);
        balanceCache.delete(wallet);
        await bot.sendMessage(chatId,
          `✅ *Transfer Successful!*\n\n` +
          `Sent ${state.amount} ETH (Base)\nTo: \`${state.toAddress}\`\n\n` +
          `[View TX](https://basescan.org/tx/${receipt.hash})`,
          { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `❌ Transfer failed: ${e.message?.substring(0, 150)}`,
        { reply_markup: { inline_keyboard: [
          [{ text: "🔄 Retry", callback_data: "action:transfer" }],
          [{ text: "👛 Wallet", callback_data: "action:wallet" }],
        ]}}
      );
    }
    pendingTransfer.delete(chatId);
    return;
  }
  if (data === "action:autopay_usdt") {
    if (!checkRateLimit(`tx:${chatId}`, 2, 30000)) {
      await bot.sendMessage(chatId, "⏳ Please wait before retrying payment.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;
    const hasKey = await checkWalletHasKey(chatId, wallet);
    if (!hasKey) {
      await bot.sendMessage(chatId, "❌ Wallet key not found. Generate a new wallet.", { reply_markup: { inline_keyboard: [[{ text: "🔑 Generate Wallet", callback_data: "action:genwallet" }]] } });
      return;
    }
    await bot.sendMessage(chatId, `⏳ Sending ${BOT_PRICE_USD} USDT to BUILD4...`);
    sendTyping(chatId);
    try {
      let pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
      if (!pk) pk = await storage.getPrivateKeyByWalletAddress(wallet);
      if (!pk) throw new Error("Private key not found. Re-import your wallet via /wallet.");

      const signer = new ethers.Wallet(pk, bnbProviderCached);
      const usdtContract = new ethers.Contract(BSC_USDT, [
        "function transfer(address to, uint256 amount) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ], signer);

      const amount = ethers.parseUnits(BOT_PRICE_USD.toString(), 18);
      const balance = await usdtContract.balanceOf(wallet);
      if (balance < amount) throw new Error(`Insufficient USDT. Have ${ethers.formatUnits(balance, 18)}, need ${BOT_PRICE_USD}`);

      const tx = await usdtContract.transfer(TREASURY_WALLET, amount);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");

      try {
        let activated = await storage.activateBotSubscription(wallet, receipt.hash, 56, BOT_PRICE_USD.toString());
        if (!activated) {
          await storage.createBotSubscription(wallet, chatId.toString());
          activated = await storage.activateBotSubscription(wallet, receipt.hash, 56, BOT_PRICE_USD.toString());
        }
        subCache.delete(chatId);
        console.log(`[AutoPay USDT] SUCCESS chatId=${chatId} wallet=${wallet.substring(0,8)} tx=${receipt.hash.substring(0,16)}`);
      } catch (e: any) {
        console.error("[AutoPay] activate sub failed, will verify manually:", e.message);
      }

      await bot.sendMessage(chatId,
        `✅ *Payment Successful!*\n\n` +
        `Sent ${BOT_PRICE_USD} USDT to BUILD4\n` +
        `[View Transaction](https://bscscan.com/tx/${receipt.hash})\n\n` +
        `Your subscription is now active! 🎉`,
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [
          [{ text: "🚀 Start Trading", callback_data: "action:menu" }],
        ]}}
      );
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `❌ Payment failed: ${e.message?.substring(0, 150)}\n\nPlease try again or send manually.`,
        { reply_markup: { inline_keyboard: [
          [{ text: "🔄 Retry", callback_data: "action:autopay_usdt" }],
          [{ text: "💳 Pay Manually", callback_data: "action:paynow" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ]}}
      );
    }
    return;
  }
  if (data.startsWith("autopay_native:")) {
    if (!checkRateLimit(`tx:${chatId}`, 2, 30000)) {
      await bot.sendMessage(chatId, "⏳ Please wait before retrying payment.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    const chainId = data.split(":")[1];
    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;

    const CHAIN_CONFIG: Record<string, { name: string; symbol: string; rpc: string; usdtAddr: string; usdtDecimals: number; explorer: string; priceDivisor: number }> = {
      "56": { name: "BNB Chain", symbol: "BNB", rpc: "https://bsc-dataseed1.binance.org", usdtAddr: "0x55d398326f99059fF775485246999027B3197955", usdtDecimals: 18, explorer: "https://bscscan.com/tx/", priceDivisor: 500 },
      "8453": { name: "Base", symbol: "ETH", rpc: "https://mainnet.base.org", usdtAddr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usdtDecimals: 6, explorer: "https://basescan.org/tx/", priceDivisor: 2500 },
      "1": { name: "Ethereum", symbol: "ETH", rpc: "https://eth.llamarpc.com", usdtAddr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", usdtDecimals: 6, explorer: "https://etherscan.io/tx/", priceDivisor: 2500 },
    };
    const cfg = CHAIN_CONFIG[chainId];
    if (!cfg) {
      await bot.sendMessage(chatId, "❌ Unsupported chain.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:payfromwallet" }]] } });
      return;
    }

    await bot.sendMessage(chatId, `⏳ Swapping ${cfg.symbol} → USDT and paying subscription on ${cfg.name}...`);
    sendTyping(chatId);
    try {
      let pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
      if (!pk) pk = await storage.getPrivateKeyByWalletAddress(wallet);
      if (!pk) throw new Error("Private key not found. Re-import your wallet.");

      const swapAmount = (BOT_PRICE_USD / cfg.priceDivisor * 1.05).toFixed(6);
      const rawAmount = ethers.parseUnits(swapAmount, 18).toString();

      const { getSwapData } = await import("./okx-onchainos");
      const swapResult = await getSwapData({
        chainId,
        fromTokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        toTokenAddress: cfg.usdtAddr.toLowerCase(),
        amount: rawAmount,
        slippage: "1.5",
        userWalletAddress: wallet,
      });

      const txData = swapResult?.data?.[0]?.tx;
      if (!txData) throw new Error("No swap route found. Try again later.");

      const provider = new ethers.JsonRpcProvider(cfg.rpc);
      const signer = new ethers.Wallet(pk, provider);
      const swapTx = await signer.sendTransaction({
        to: txData.to,
        data: txData.data,
        value: txData.value ? BigInt(txData.value) : 0n,
        gasLimit: txData.gasLimit ? BigInt(txData.gasLimit) : 300000n,
      });
      const swapReceipt = await swapTx.wait();
      if (!swapReceipt || swapReceipt.status !== 1) throw new Error("Swap transaction reverted");

      await new Promise(r => setTimeout(r, 3000));

      const usdtContract = new ethers.Contract(cfg.usdtAddr, [
        "function transfer(address to, uint256 amount) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ], signer);
      const usdtBal = await usdtContract.balanceOf(wallet);
      const payAmount = ethers.parseUnits(BOT_PRICE_USD.toString(), cfg.usdtDecimals);
      if (usdtBal < payAmount) throw new Error(`Swap succeeded but USDT balance insufficient. Try manual payment.`);

      const payTx = await usdtContract.transfer(TREASURY_WALLET, payAmount);
      const payReceipt = await payTx.wait();
      if (!payReceipt || payReceipt.status !== 1) throw new Error("USDT transfer reverted");

      try {
        let activated = await storage.activateBotSubscription(wallet, payReceipt.hash, parseInt(chainId), BOT_PRICE_USD.toString());
        if (!activated) {
          await storage.createBotSubscription(wallet, chatId.toString());
          activated = await storage.activateBotSubscription(wallet, payReceipt.hash, parseInt(chainId), BOT_PRICE_USD.toString());
        }
        subCache.delete(chatId);
        console.log(`[AutoPay Native] SUCCESS chatId=${chatId} chain=${chainId} tx=${payReceipt.hash.substring(0,16)}`);
      } catch (e: any) {
        console.error("[AutoPay] activate sub failed:", e.message);
      }
      balanceCache.delete(wallet);

      await bot.sendMessage(chatId,
        `✅ *Payment Successful!*\n\n` +
        `Swapped ~${swapAmount} ${cfg.symbol} → USDT on ${cfg.name}\n` +
        `Sent ${BOT_PRICE_USD} USDT to BUILD4\n\n` +
        `[Swap TX](${cfg.explorer}${swapReceipt.hash})\n` +
        `[Payment TX](${cfg.explorer}${payReceipt.hash})\n\n` +
        `Your subscription is now active! 🎉`,
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [
          [{ text: "🚀 Start Trading", callback_data: "action:menu" }],
        ]}}
      );
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `❌ Auto-pay failed: ${e.message?.substring(0, 200)}\n\nYou can try again or pay manually.`,
        { reply_markup: { inline_keyboard: [
          [{ text: "🔄 Retry", callback_data: `autopay_native:${chainId}` }],
          [{ text: "💳 Pay Manually", callback_data: "action:paynow" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ]}}
      );
    }
    return;
  }
  if (data === "action:autopay_sol") {
    if (!checkRateLimit(`tx:${chatId}`, 2, 30000)) {
      await bot.sendMessage(chatId, "⏳ Please wait before retrying payment.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    const wallet = getLinkedWallet(chatId);
    const solWallet = solanaWalletMap.get(chatId);
    if (!solWallet) {
      await bot.sendMessage(chatId, "❌ No Solana wallet found. Generate one first.", { reply_markup: { inline_keyboard: [[{ text: "🟣 Generate SOL Wallet", callback_data: "action:gensolwallet" }]] } });
      return;
    }

    await bot.sendMessage(chatId, `⏳ Sending SOL payment to BUILD4...`);
    sendTyping(chatId);
    try {
      const { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
      const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

      const solPriceResp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd").then(r => r.json()).catch(() => ({ solana: { usd: 150 } }));
      const solPrice = solPriceResp?.solana?.usd || 150;
      const solAmount = (BOT_PRICE_USD / solPrice) * 1.02;
      const lamports = Math.ceil(solAmount * LAMPORTS_PER_SOL);

      const balance = await conn.getBalance(new PublicKey(solWallet.address));
      if (balance < lamports + 10000) throw new Error(`Insufficient SOL. Have ${(balance / LAMPORTS_PER_SOL).toFixed(4)}, need ~${solAmount.toFixed(4)}`);

      const secretKey = Buffer.from(solWallet.privateKey, "hex");
      const payer = Keypair.fromSecretKey(new Uint8Array(secretKey));

      const SOL_TREASURY = "5Ff57464152c9285A8526a0665d996dA66e2def1";
      let treasuryPubkey: PublicKey;
      try {
        treasuryPubkey = new PublicKey(process.env.SOL_TREASURY_WALLET || SOL_TREASURY);
      } catch {
        treasuryPubkey = new PublicKey("5Ff57464152c9285A8526a0665d996dA66e2def1");
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: treasuryPubkey,
          lamports,
        })
      );
      tx.feePayer = payer.publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.sign(payer);
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, "confirmed");

      try {
        const subWallet = wallet || solWallet.address;
        let activated = await storage.activateBotSubscription(subWallet, sig, 501, BOT_PRICE_USD.toString());
        if (!activated) {
          await storage.createBotSubscription(subWallet, chatId.toString());
          activated = await storage.activateBotSubscription(subWallet, sig, 501, BOT_PRICE_USD.toString());
        }
        subCache.delete(chatId);
        console.log(`[AutoPay SOL] SUCCESS chatId=${chatId} tx=${sig.substring(0,16)}`);
      } catch (e: any) {
        console.error("[AutoPay SOL] activate sub failed:", e.message);
      }

      await bot.sendMessage(chatId,
        `✅ *Payment Successful!*\n\n` +
        `Sent ~${solAmount.toFixed(4)} SOL ($${BOT_PRICE_USD})\n\n` +
        `[View Transaction](https://solscan.io/tx/${sig})\n\n` +
        `Your subscription is now active! 🎉`,
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [
          [{ text: "🚀 Start Trading", callback_data: "action:menu" }],
        ]}}
      );
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `❌ SOL payment failed: ${e.message?.substring(0, 200)}\n\nTry again or use a different token.`,
        { reply_markup: { inline_keyboard: [
          [{ text: "🔄 Retry", callback_data: "action:autopay_sol" }],
          [{ text: "💰 Other Payment Methods", callback_data: "action:payfromwallet" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ]}}
      );
    }
    return;
  }
  if (data === "action:verifypayment") {
    return handleVerifyPayment(chatId);
  }
  if (data === "action:verifytxhash") {
    pendingTxHashVerify.set(chatId, true);
    await bot.sendMessage(chatId,
      "📋 *Paste your transaction hash*\n\n" +
      "Send the TX hash of your USDT payment to the treasury wallet.\n\n" +
      "Example: `0xabc123...`",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:menu" }]] } }
    );
    return;
  }
  if (data === "action:substatus") {
    return handleSubStatus(chatId);
  }
  if (data === "action:referral") {
    return handleReferral(chatId);
  }

  if (data === "action:gensolwallet") {
    await bot.sendMessage(chatId, "🟣 Generating Solana wallet...");
    sendTyping(chatId);
    try {
      const solWallet = await getOrCreateSolanaWallet(chatId);
      const solPkMsg = await bot.sendMessage(chatId,
        `🟣 *Solana Wallet Created!*\n\n` +
        `Address:\n\`${solWallet.address}\`\n\n` +
        `Private Key:\n\`${solWallet.privateKey}\`\n\n` +
        `⚠️ *SAVE YOUR PRIVATE KEY NOW* — this message will be auto-deleted in 30 seconds.\n\n` +
        `This wallet is used for cross-chain bridges to Solana.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "👛 My Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      setTimeout(() => {
        try { bot!.deleteMessage(chatId, solPkMsg.message_id); } catch {}
      }, 30000);
    } catch (e: any) {
      console.error("[TelegramBot] Solana wallet generation error:", e.message);
      await bot.sendMessage(chatId, `❌ Failed to generate Solana wallet: ${e.message?.substring(0, 100)}\n\nPlease try again.`,
        { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:gensolwallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
    }
    return;
  }

  if (data === "action:linkwallet" || data === "action:genwallet") {
    try {
      await autoGenerateWallet(chatId);
      pendingImportWallet.delete(chatId);
    } catch (e: any) {
      console.error("[TelegramBot] Wallet generation error:", e.message);
      await bot.sendMessage(chatId, "Failed to generate wallet. Please try again.");
    }
    return;
  }

  if (data === "action:importwallet") {
    pendingImportWallet.add(chatId);
    pendingAgentCreation.delete(chatId);
    pendingTask.delete(chatId);
    pendingTokenLaunch.delete(chatId);

    await bot.sendMessage(chatId,
      "Paste your wallet private key below to import it.\n\n" +
      "• Private key — starts with 0x, 66 characters\n\n" +
      "Type /cancel to go back.",
    );
    return;
  }

  if (data === "erc8004_register") {
    const wallets = getUserWallets(chatId);
    const activeIdx = getActiveWalletIndex(chatId);
    const walletAddr = wallets[activeIdx];
    if (!walletAddr) {
      await bot.sendMessage(chatId, "No wallet found. Use /wallet to set one up first.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    const hasKey = walletsWithKey.has(walletAddr.toLowerCase());
    if (!hasKey) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to register. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    const pk = await storage.getTelegramWalletPrivateKey(String(chatId), walletAddr);
    if (!pk) {
      await bot.sendMessage(chatId, "Could not retrieve wallet private key. Try generating a new wallet with /wallet.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    await bot.sendMessage(chatId, "Registering your wallet as an AI agent on ERC-8004 (BSC)...\nThis may take 10-30 seconds.");

    try {
      const { ensureAgentRegisteredBSC } = await import("./token-launcher");
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const wallet = new ethers.Wallet(pk, provider);

      const result = await ensureAgentRegisteredBSC(wallet, "BUILD4 Agent", "Autonomous AI agent on BUILD4");

      if (result.registered) {
        const txInfo = result.txHash ? `\nTX: ${result.txHash.substring(0, 14)}...` : "";
        await bot.sendMessage(chatId,
          "✅ AI Agent Badge: REGISTERED\n\n" +
          `Wallet: ${walletAddr.substring(0, 8)}...${walletAddr.slice(-6)}${txInfo}\n\n` +
          "Your token launches on Four.meme will now show the AI Agent icon on GMGN and other trackers!",
          { reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
      } else {
        await bot.sendMessage(chatId,
          `❌ Registration failed: ${result.error?.substring(0, 120) || "Unknown error"}\n\nMake sure your wallet has at least 0.001 BNB for gas.`,
          { reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100) || "Unknown error"}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (data === "action:info") {
    await bot.sendMessage(chatId,
      "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\n" +
      "Agents get wallets, trade skills, evolve, replicate, and operate fully on-chain. No centralized AI — inference runs through Hyperbolic, Akash ML, and Ritual.\n\n" +
      "https://build4.io",
      { reply_markup: mainMenuKeyboard(undefined, chatId) }
    );
    return;
  }

  if (data === "action:help") {
    const isZh = getLang(chatId) === "zh";
    const helpText = isZh
      ? "命令列表：\n\n" +
        "🚀 /launch — 发射代币\n" +
        "🔄 /swap — 兑换代币\n" +
        "🌉 /bridge — 跨链桥\n" +
        "🐋 /signals — 聪明钱信号\n" +
        "🔒 /scan — 安全扫描\n" +
        "🔥 /trending — 热门代币\n" +
        "🐸 /meme — Meme代币扫描\n" +
        "📊 /price — 代币价格查询\n" +
        "⛽ /gas — Gas费查询\n" +
        "🤖 /newagent — 创建AI代理\n" +
        "📋 /myagents — 我的代理\n" +
        "📝 /task — 分配任务\n" +
        "👛 /wallet — 钱包管理\n" +
        "🌐 /lang — 切换语言\n" +
        "❓ /ask <问题> — 提问\n" +
        "❌ /cancel — 取消当前操作\n\n" +
        "或直接输入任何问题！"
      : "Commands:\n\n" +
        "🚀 /launch — Launch a token\n" +
        "🔄 /swap — Swap tokens\n" +
        "🌉 /bridge — Cross-chain bridge\n" +
        "🐋 /signals — Smart money signals\n" +
        "🔒 /scan — Security scanner\n" +
        "🔥 /trending — Hot & trending tokens\n" +
        "🐸 /meme — Meme token scanner\n" +
        "📊 /price — Token price lookup\n" +
        "⛽ /gas — Gas prices\n" +
        "🤖 /newagent — Create an AI agent\n" +
        "📋 /myagents — Your agents\n" +
        "📝 /task — Assign a task\n" +
        "👛 /wallet — Wallet info\n" +
        "🌐 /lang — Switch language\n" +
        "❓ /ask <question> — Ask anything\n" +
        "❌ /cancel — Cancel current action\n\n" +
        "Or just type any question!";
    await bot.sendMessage(chatId, helpText, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    return;
  }

  if (data === "action:wallet") {
    const wallets = getUserWallets(chatId);
    if (wallets.length === 0) {
      await ensureWallet(chatId);
    }
    const activeIdx = getActiveWalletIndex(chatId);
    const updatedWallets = getUserWallets(chatId);

    await bot.sendMessage(chatId, tr("wallet.loading", chatId));

    const evmWallets = updatedWallets.filter(w => /^0x[a-fA-F0-9]{40}$/.test(w));
    const balances = await fetchWalletBalances(evmWallets);
    const lang = getLang(chatId);

    let text = `${tr("wallet.title", chatId)}\n\n`;
    evmWallets.forEach((w) => {
      const origIdx = updatedWallets.indexOf(w);
      const marker = origIdx === activeIdx ? "✅" : "⬜";
      const bal = balances[w];
      const hasKey = walletsWithKey.has(`${chatId}:${w}`);
      const keyTag = hasKey ? "" : ` ${tr("wallet.viewOnly", chatId)}`;
      let balText = "";
      if (bal) {
        const parts: string[] = [];
        if (parseFloat(bal.bnb) > 0) parts.push(`${bal.bnb} BNB`);
        if (parseFloat(bal.usdt) > 0) parts.push(`${bal.usdt} USDT`);
        if (parseFloat(bal.eth) > 0) parts.push(`${bal.eth} ETH`);
        balText = parts.length > 0 ? ` (${parts.join(", ")})` : ` ${tr("wallet.empty", chatId)}`;
      }
      text += `${marker} \`${w}\`${origIdx === activeIdx ? ` ${tr("wallet.active", chatId)}` : ""}${keyTag}\n    ${balText}\n\n`;
    });
    const solWallet = solanaWalletMap.get(chatId);
    if (solWallet) {
      text += `🟣 *${lang === "zh" ? "Solana钱包" : lang === "ar" ? "محفظة Solana" : "Solana Wallet"}*\n\`${solWallet.address}\`\n\n`;
    }

    text += tr("wallet.fund", chatId);

    const walletButtons: TelegramBot.InlineKeyboardButton[][] = evmWallets.map((w) => {
      const origIdx = updatedWallets.indexOf(w);
      if (origIdx === activeIdx) {
        return [{ text: tr("wallet.copyAddr", chatId), callback_data: `copywall:${origIdx}` }];
      }
      return [
        { text: `▶️ ${lang === "zh" ? "使用" : lang === "ar" ? "استخدام" : "Use"} ${shortWallet(w)}`, callback_data: `switchwall:${origIdx}` },
        { text: `🗑`, callback_data: `removewall:${origIdx}` },
      ];
    });

    walletButtons.push([{ text: tr("wallet.genNew", chatId), callback_data: "action:genwallet" }, { text: tr("wallet.import", chatId), callback_data: "action:importwallet" }]);
    if (!solWallet) {
      walletButtons.push([{ text: tr("wallet.genSol", chatId), callback_data: "action:gensolwallet" }]);
    }
    walletButtons.push([{ text: "💸 Transfer", callback_data: "action:transfer" }, { text: tr("wallet.exportKey", chatId), callback_data: "action:exportkey" }]);
    if (solWallet) {
      walletButtons.push([{ text: tr("wallet.exportSol", chatId), callback_data: "action:exportsolkey" }]);
    }
    walletButtons.push([{ text: tr("menu.launch", chatId), callback_data: "action:launchtoken" }, { text: tr("menu.back", chatId), callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: walletButtons }
    });
    return;
  }

  if (data === "action:copyaddr") {
    let w = getLinkedWallet(chatId);
    if (!w) { w = await ensureWallet(chatId); }
    await bot.sendMessage(chatId, `\`${w}\``, { parse_mode: "Markdown" });
    return;
  }

  if (data.startsWith("copywall:")) {
    const idx = parseInt(data.split(":")[1]);
    const wallets = getUserWallets(chatId);
    if (idx >= 0 && idx < wallets.length) {
      await bot.sendMessage(chatId, `\`${wallets[idx]}\``, { parse_mode: "Markdown" });
    }
    return;
  }

  if (data.startsWith("switchwall:")) {
    const idx = parseInt(data.split(":")[1]);
    const wallets = getUserWallets(chatId);
    if (idx >= 0 && idx < wallets.length && setActiveWallet(chatId, idx)) {
      await bot.sendMessage(chatId,
        `✅ Switched to wallet: ${shortWallet(wallets[idx])}`,
        { reply_markup: { inline_keyboard: [[{ text: "👛 My Wallets", callback_data: "action:wallet" }, { text: "◀️ Menu", callback_data: "action:menu" }]] } }
      );
    }
    return;
  }

  if (data.startsWith("removewall:")) {
    const idx = parseInt(data.split(":")[1]);
    const wallets = getUserWallets(chatId);
    if (idx >= 0 && idx < wallets.length) {
      const removed = wallets[idx];
      removeWallet(chatId, idx);
      const remaining = getUserWallets(chatId);
      if (remaining.length === 0) {
        await bot.sendMessage(chatId, `Wallet removed: ${shortWallet(removed)}\n\nNo wallets left.`, {
          reply_markup: mainMenuKeyboard(undefined, chatId)
        });
      } else {
        await bot.sendMessage(chatId, `Wallet removed: ${shortWallet(removed)}`, {
          reply_markup: { inline_keyboard: [[{ text: "👛 My Wallets", callback_data: "action:wallet" }, { text: "◀️ Menu", callback_data: "action:menu" }]] }
        });
      }
    }
    return;
  }

  if (data === "action:exportkey") {
    if (isVerificationLocked(chatId)) {
      const record = failedVerificationAttempts.get(chatId)!;
      const minsLeft = Math.ceil((record.lockedUntil - Date.now()) / 60000);
      await bot.sendMessage(chatId, `🔒 *Account locked* for ${minsLeft} more minute${minsLeft === 1 ? "" : "s"} due to failed verification attempts.\n\nTry again later.`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    auditLog(chatId, "EXPORT_REQUEST", "Private key export initiated");
    const wallets = getUserWallets(chatId);
    if (wallets.length === 0) {
      await bot.sendMessage(chatId, "No wallets found. Use /wallet to create one first.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    const evmWallets = wallets.filter(w => /^0x[a-fA-F0-9]{40}$/.test(w));
    if (evmWallets.length === 0) {
      await bot.sendMessage(chatId, "No EVM wallets found. Use /wallet to create one.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    if (evmWallets.length === 1) {
      const idx = wallets.indexOf(evmWallets[0]);
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      pendingExportVerification.set(chatId, { walletIdx: idx, code, expiresAt: Date.now() + 60000, type: "evm" });
      await bot.sendMessage(chatId,
        `🔐 *Private Key Export Verification*\n\n` +
        `Wallet: \`${evmWallets[0]}\`\n\n` +
        `⚠️ Your private key gives *FULL control* of this wallet.\n` +
        `Never share it with anyone. BUILD4 will never ask for it.\n\n` +
        `To confirm, type this 4-digit code:\n\n` +
        `🔢 \`${code}\`\n\n` +
        `_This code expires in 60 seconds._`,
        { parse_mode: "Markdown" }
      );
    } else {
      const buttons = evmWallets.map((w, i) => {
        const idx = wallets.indexOf(w);
        return [{ text: `${shortWallet(w)}`, callback_data: `selectexport:${idx}` }];
      });
      buttons.push([{ text: "❌ Cancel", callback_data: "action:wallet" }]);
      await bot.sendMessage(chatId,
        `🔐 *Which wallet's private key do you want to export?*`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
      );
    }
    return;
  }

  if (data.startsWith("selectexport:")) {
    const idx = parseInt(data.split(":")[1]);
    const wallets = getUserWallets(chatId);
    if (idx < 0 || idx >= wallets.length) {
      await bot.sendMessage(chatId, "Invalid wallet.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    pendingExportVerification.set(chatId, { walletIdx: idx, code, expiresAt: Date.now() + 60000, type: "evm" });
    await bot.sendMessage(chatId,
      `🔐 *Private Key Export Verification*\n\n` +
      `Wallet: \`${wallets[idx]}\`\n\n` +
      `⚠️ Your private key gives *FULL control* of this wallet.\n` +
      `Never share it with anyone. BUILD4 will never ask for it.\n\n` +
      `To confirm, type this 4-digit code:\n\n` +
      `🔢 \`${code}\`\n\n` +
      `_This code expires in 60 seconds._`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data === "action:exportsolkey") {
    if (isVerificationLocked(chatId)) {
      const record = failedVerificationAttempts.get(chatId)!;
      const minsLeft = Math.ceil((record.lockedUntil - Date.now()) / 60000);
      await bot.sendMessage(chatId, `🔒 *Account locked* for ${minsLeft} more minute${minsLeft === 1 ? "" : "s"} due to failed verification attempts.\n\nTry again later.`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    const solWallet = solanaWalletMap.get(chatId);
    if (!solWallet) {
      await bot.sendMessage(chatId, "No Solana wallet found.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    auditLog(chatId, "EXPORT_REQUEST_SOL", `Solana key export initiated for ${maskAddress(solWallet.address)}`);
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    pendingExportVerification.set(chatId, { walletIdx: -1, code, expiresAt: Date.now() + 60000, type: "sol" });
    await bot.sendMessage(chatId,
      `🟣 *Solana Private Key Export Verification*\n\n` +
      `Wallet: \`${solWallet.address}\`\n\n` +
      `⚠️ Your private key gives *FULL control* of this wallet.\n` +
      `Never share it with anyone.\n\n` +
      `To confirm, type this 4-digit code:\n\n` +
      `🔢 \`${code}\`\n\n` +
      `_This code expires in 60 seconds._`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data.startsWith("confirmexport:")) {
    const idx = parseInt(data.split(":")[1]);
    const wallets = getUserWallets(chatId);
    if (idx < 0 || idx >= wallets.length) {
      await bot.sendMessage(chatId, "Invalid wallet.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    pendingExportVerification.set(chatId, { walletIdx: idx, code, expiresAt: Date.now() + 60000, type: "evm" });
    await bot.sendMessage(chatId,
      `🔐 *Verification Required*\n\nType this code to confirm:\n\n🔢 \`${code}\`\n\n_Expires in 60 seconds._`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const wallet = await ensureWallet(chatId);

  if (data === "action:newagent") {
    pendingAgentCreation.set(chatId, { step: "name" });
    pendingTask.delete(chatId);
    await bot.sendMessage(chatId, "What's your agent's name? (1-50 characters)");
    return;
  }

  if (data === "action:myagents") {
    await handleMyAgents(chatId, wallet);
    return;
  }

  if (data === "action:task") {
    await startTaskFlow(chatId, wallet);
    return;
  }

  if (data === "action:mytasks") {
    await handleMyTasks(chatId, wallet);
    return;
  }

  if (data === "action:launchtoken") {
    await startTokenLaunchFlow(chatId, wallet);
    return;
  }

  if (data === "action:buy") {
    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first (/linkwallet).");
      return;
    }
    pendingFourMemeBuy.set(chatId, { step: "token" });
    await bot.sendMessage(chatId, "Enter the token contract address you want to buy (0x...):");
    return;
  }

  if (data === "action:sell") {
    const chainButtons = [
      [{ text: "BNB Chain", callback_data: "sell_chain:56" }, { text: "Ethereum", callback_data: "sell_chain:1" }],
      [{ text: "Base", callback_data: "sell_chain:8453" }, { text: "Solana", callback_data: "sell_chain:501" }],
      [{ text: "Arbitrum", callback_data: "sell_chain:42161" }, { text: "Polygon", callback_data: "sell_chain:137" }],
      [{ text: "« Menu", callback_data: "action:menu" }],
    ];
    await bot.sendMessage(chatId,
      `💸 *Sell Token*\n\nSelect the chain where your token is:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
    );
    return;
  }

  if (data.startsWith("sell_chain:")) {
    const chainId = data.replace("sell_chain:", "");
    const chainObj = OKX_CHAINS.find(c => c.id === chainId);
    if (!chainObj) return;
    const isSol = chainId === "501";

    if (isSol) {
      const solWallet = solanaWalletMap.get(chatId);
      if (!solWallet) {
        await bot.sendMessage(chatId, "You don't have a Solana wallet yet. Generate one first.", { reply_markup: { inline_keyboard: [[{ text: "🟣 Generate SOL Wallet", callback_data: "action:gensolwallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        return;
      }
      await bot.sendMessage(chatId, `⏳ Loading your ${chainObj.name} tokens...`);
      sendTyping(chatId);
      try {
        const { getWalletTokenBalances } = await import("./okx-onchainos");
        const result = await getWalletTokenBalances({ address: solWallet.address, chainId: "501" });
        const tokens = result?.data?.[0]?.tokenAssets || [];
        const sellable = tokens.filter((t: any) => {
          const bal = parseFloat(t.balance || "0");
          const addr = t.tokenAddress || "";
          return bal > 0 && addr !== SOLANA_NATIVE_TOKEN && addr !== "" && addr !== "11111111111111111111111111111111";
        });
        if (sellable.length === 0) {
          await bot.sendMessage(chatId, `No sellable tokens found in your Solana wallet.`, { reply_markup: { inline_keyboard: [[{ text: "💸 Try Another Chain", callback_data: "action:sell" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
          return;
        }
        const cached = sellable.slice(0, 10).map((t: any) => ({
          address: t.tokenAddress,
          symbol: t.symbol || "???",
          balance: t.balance || "0",
          balanceRaw: t.rawBalance || t.balance || "0",
          decimals: parseInt(t.decimals || "9"),
          usdValue: t.tokenPrice ? (parseFloat(t.balance) * parseFloat(t.tokenPrice)).toFixed(2) : "?",
        }));
        sellTokenCache.set(chatId, cached);
        let text = `💸 *Your Solana Tokens*\n\n`;
        const tokenButtons: TelegramBot.InlineKeyboardButton[][] = [];
        cached.forEach((t, i) => {
          text += `${i + 1}. *${t.symbol}* — ${parseFloat(t.balance).toFixed(4)} ($${t.usdValue})\n`;
          tokenButtons.push([{ text: `💸 Sell ${t.symbol}`, callback_data: `sell_tok:${i}:501` }]);
        });
        tokenButtons.push([{ text: "🔄 Refresh", callback_data: `sell_chain:501` }]);
        tokenButtons.push([{ text: "« Back", callback_data: "action:sell" }, { text: "« Menu", callback_data: "action:menu" }]);
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } });
      } catch (e: any) {
        await bot.sendMessage(chatId, `Error loading tokens: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: `sell_chain:501` }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
      return;
    }

    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    await bot.sendMessage(chatId, `⏳ Loading your ${chainObj.name} tokens...`);
    sendTyping(chatId);
    try {
      const { getWalletTokenBalances } = await import("./okx-onchainos");
      const result = await getWalletTokenBalances({ address: wallet, chainId });
      const tokens = result?.data?.[0]?.tokenAssets || [];
      const nativeAddrs = [OKX_NATIVE_TOKEN, "0x0000000000000000000000000000000000000000", ""];
      const sellable = tokens.filter((t: any) => {
        const bal = parseFloat(t.balance || "0");
        const addr = (t.tokenAddress || "").toLowerCase();
        return bal > 0 && !nativeAddrs.includes(addr);
      });
      if (sellable.length === 0) {
        await bot.sendMessage(chatId, `No sellable tokens found on ${chainObj.name}.`, { reply_markup: { inline_keyboard: [[{ text: "💸 Try Another Chain", callback_data: "action:sell" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        return;
      }
      const cached = sellable.slice(0, 10).map((t: any) => ({
        address: t.tokenAddress,
        symbol: t.symbol || "???",
        balance: t.balance || "0",
        balanceRaw: t.rawBalance || t.balance || "0",
        decimals: parseInt(t.decimals || "18"),
        usdValue: t.tokenPrice ? (parseFloat(t.balance) * parseFloat(t.tokenPrice)).toFixed(2) : "?",
      }));
      sellTokenCache.set(chatId, cached);
      let text = `💸 *Your ${chainObj.name} Tokens*\n\n`;
      const tokenButtons: TelegramBot.InlineKeyboardButton[][] = [];
      cached.forEach((t, i) => {
        text += `${i + 1}. *${t.symbol}* — ${parseFloat(t.balance).toFixed(4)} ($${t.usdValue})\n`;
        tokenButtons.push([{ text: `💸 Sell ${t.symbol}`, callback_data: `sell_tok:${i}:${chainId}` }]);
      });
      tokenButtons.push([{ text: "🔄 Refresh", callback_data: `sell_chain:${chainId}` }]);
      tokenButtons.push([{ text: "« Back", callback_data: "action:sell" }, { text: "« Menu", callback_data: "action:menu" }]);
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error loading tokens: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: `sell_chain:${chainId}` }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  if (data.startsWith("sell_tok:")) {
    const parts = data.replace("sell_tok:", "").split(":");
    const tokIdx = parseInt(parts[0]);
    const chainId = parts[1];
    const chainObj = OKX_CHAINS.find(c => c.id === chainId);
    if (!chainObj) return;
    const cached = sellTokenCache.get(chatId);
    if (!cached || !cached[tokIdx]) {
      await bot.sendMessage(chatId, "Token list expired. Please try again.", { reply_markup: { inline_keyboard: [[{ text: "💸 Sell", callback_data: "action:sell" }]] } });
      return;
    }
    const tok = cached[tokIdx];
    pendingSell.set(chatId, {
      chainId,
      chainName: chainObj.name,
      nativeSymbol: chainObj.symbol,
      tokenAddress: tok.address,
      tokenSymbol: tok.symbol,
      tokenDecimals: tok.decimals,
      tokenBalance: tok.balance,
    });

    const pctButtons = [
      [{ text: "25%", callback_data: "sell_pct:25" }, { text: "50%", callback_data: "sell_pct:50" }],
      [{ text: "75%", callback_data: "sell_pct:75" }, { text: "100%", callback_data: "sell_pct:100" }],
      [{ text: "« Back", callback_data: `sell_chain:${chainId}` }, { text: "❌ Cancel", callback_data: "action:menu" }],
    ];
    await bot.sendMessage(chatId,
      `💸 *Sell ${tok.symbol}*\n\n` +
      `Balance: *${parseFloat(tok.balance).toFixed(6)} ${tok.symbol}*\n` +
      `Chain: ${chainObj.name}\n\n` +
      `How much do you want to sell?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: pctButtons } }
    );
    return;
  }

  if (data.startsWith("sell_pct:")) {
    const pct = parseInt(data.replace("sell_pct:", ""));
    const state = pendingSell.get(chatId);
    if (!state) {
      await bot.sendMessage(chatId, "Session expired. Start again.", { reply_markup: { inline_keyboard: [[{ text: "💸 Sell", callback_data: "action:sell" }]] } });
      return;
    }
    state.sellPercent = pct;
    const sellAmount = (parseFloat(state.tokenBalance) * pct / 100);
    state.sellAmount = sellAmount.toFixed(state.tokenDecimals > 6 ? 6 : state.tokenDecimals);
    pendingSell.set(chatId, state);

    await bot.sendMessage(chatId,
      `💸 *Confirm Sell*\n\n` +
      `🪙 Token: *${state.tokenSymbol}*\n` +
      `📊 Selling: *${state.sellAmount} ${state.tokenSymbol}* (${pct}%)\n` +
      `⛓ Chain: ${state.chainName}\n` +
      `💰 Receive: ${state.nativeSymbol}\n\n` +
      `Proceed?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Sell", callback_data: "sell_confirm" }],
            [{ text: "📊 Change %", callback_data: `sell_tok:${sellTokenCache.get(chatId)?.findIndex(t => t.address === state.tokenAddress) ?? 0}:${state.chainId}` }],
            [{ text: "❌ Cancel", callback_data: "action:sell" }],
          ],
        },
      }
    );
    return;
  }

  if (data === "sell_confirm") {
    const state = pendingSell.get(chatId);
    if (!state || !state.sellAmount) {
      await bot.sendMessage(chatId, "Sell session expired. Start again.", { reply_markup: { inline_keyboard: [[{ text: "💸 Sell", callback_data: "action:sell" }]] } });
      return;
    }

    const isSol = state.chainId === "501";

    if (isSol) {
      const solWallet = await getOrCreateSolanaWallet(chatId);
      if (!solWallet || !solWallet.privateKey) {
        await bot.sendMessage(chatId, "Solana wallet not found.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        pendingSell.delete(chatId);
        return;
      }

      await bot.sendMessage(chatId, `⏳ Selling ${state.sellAmount} ${state.tokenSymbol} → SOL on Solana...`);
      sendTyping(chatId);

      try {
        const { Connection, Keypair, VersionedTransaction, Transaction: LegacyTransaction, ComputeBudgetProgram, SystemProgram, PublicKey, TransactionMessage, AddressLookupTableAccount } = await import("@solana/web3.js");
        const rawAmount = Math.round(parseFloat(state.sellAmount) * Math.pow(10, state.tokenDecimals)).toString();

        const { getSwapData } = await import("./okx-onchainos");
        const swapResult = await getSwapData({
          chainId: "501",
          fromTokenAddress: state.tokenAddress,
          toTokenAddress: SOLANA_NATIVE_TOKEN,
          amount: rawAmount,
          slippage: "30",
          userWalletAddress: solWallet.address,
        });

        const txData = swapResult?.data?.[0]?.tx;
        if (!txData) throw new Error("No swap route found. Token may have low liquidity.");

        const PRIORITY_FEE_LAMPORTS = 9_000_000;
        const JITO_TIP_LAMPORTS = 2_000_000;
        const JITO_TIP_ACCOUNTS = [
          "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
          "HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiKwkJbMj",
          "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
          "ADaUMid9yfUytqMBgopwjb2DTLSLxXCQkJbNLmZdvMKz",
          "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
          "ADuUkR4vqLUMWXxW9gh6D6L8pMSGA2w67v6C3mViyrj6",
          "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
          "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
        ];
        const randomTipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

        const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
        const secretKey = Uint8Array.from(Buffer.from(solWallet.privateKey, "hex"));
        const keypair = Keypair.fromSecretKey(secretKey);

        const rawTx = txData.data;
        if (!rawTx) throw new Error("No transaction data returned from DEX");

        const txBuf = Buffer.from(rawTx, "base64");
        let txHash: string;
        try {
          const vTx = VersionedTransaction.deserialize(txBuf);
          const msg = vTx.message;
          const lookupTableAccounts: AddressLookupTableAccount[] = [];
          if (msg.addressTableLookups && msg.addressTableLookups.length > 0) {
            for (const lookup of msg.addressTableLookups) {
              const accountInfo = await connection.getAddressLookupTable(lookup.accountKey);
              if (accountInfo.value) lookupTableAccounts.push(accountInfo.value);
            }
          }
          const decompiledMsg = TransactionMessage.decompile(msg, { addressLookupTableAccounts: lookupTableAccounts });
          const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_LAMPORTS });
          const jitoTipIx = SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(randomTipAccount), lamports: JITO_TIP_LAMPORTS });
          decompiledMsg.instructions = [priorityIx, ...decompiledMsg.instructions, jitoTipIx];
          decompiledMsg.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
          const newMsg = decompiledMsg.compileToV0Message(lookupTableAccounts);
          const newTx = new VersionedTransaction(newMsg);
          newTx.sign([keypair]);
          txHash = await connection.sendTransaction(newTx, { skipPreflight: true, maxRetries: 3 });
        } catch {
          const legacyTx = LegacyTransaction.from(txBuf);
          const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_LAMPORTS });
          const jitoTipIx = SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(randomTipAccount), lamports: JITO_TIP_LAMPORTS });
          legacyTx.instructions = [priorityIx, ...legacyTx.instructions, jitoTipIx];
          legacyTx.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
          legacyTx.sign(keypair);
          txHash = await connection.sendRawTransaction(legacyTx.serialize(), { skipPreflight: true });
        }

        const latestBlockhash = await connection.getLatestBlockhash("finalized");
        await connection.confirmTransaction({ signature: txHash, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight }, "confirmed");

        pendingSell.delete(chatId);
        await bot.sendMessage(chatId,
          `✅ *Sell Executed!*\n\n` +
          `💸 ${state.sellAmount} ${state.tokenSymbol} → SOL\n` +
          `⛓ Solana\n\n` +
          `[View Transaction](https://solscan.io/tx/${txHash})`,
          { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "💸 Sell More", callback_data: "action:sell" }], [{ text: "👛 Wallet", callback_data: "action:wallet" }, { text: "« Menu", callback_data: "action:menu" }]] } }
        );
      } catch (e: any) {
        await bot.sendMessage(chatId,
          `❌ Sell failed: ${e.message?.substring(0, 150)}\n\nTry again or check your balance.`,
          { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "sell_confirm" }], [{ text: "💸 Sell", callback_data: "action:sell" }, { text: "« Menu", callback_data: "action:menu" }]] } }
        );
      }
      return;
    }

    const walletAddr = getLinkedWallet(chatId);
    if (!walletAddr || !await checkWalletHasKey(chatId, walletAddr)) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to sell.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      pendingSell.delete(chatId);
      return;
    }

    await bot.sendMessage(chatId, `⏳ Selling ${state.sellAmount} ${state.tokenSymbol} → ${state.nativeSymbol} on ${state.chainName}...`);
    sendTyping(chatId);

    try {
      const { ethers } = await import("ethers");
      const rawAmount = ethers.parseUnits(state.sellAmount, state.tokenDecimals).toString();

      const { getSwapData, getApproveTransaction } = await import("./okx-onchainos");

      const approveResult = await getApproveTransaction({
        chainId: state.chainId,
        tokenContractAddress: state.tokenAddress,
        approveAmount: rawAmount,
      });
      const approveTx = approveResult?.data?.[0];

      let pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), walletAddr);
      if (!pk) pk = await storage.getPrivateKeyByWalletAddress(walletAddr);
      if (!pk) throw new Error("Private key not found. Generate a new wallet or re-import your key via /wallet.");

      const CHAIN_RPCS: Record<string, string> = {
        "56": "https://bsc-dataseed1.binance.org", "1": "https://eth.llamarpc.com",
        "8453": "https://mainnet.base.org", "42161": "https://arb1.arbitrum.io/rpc",
        "137": "https://polygon-rpc.com", "10": "https://mainnet.optimism.io",
        "43114": "https://api.avax.network/ext/bc/C/rpc", "196": "https://rpc.xlayer.tech",
      };
      const rpcUrl = CHAIN_RPCS[state.chainId] || "https://bsc-dataseed1.binance.org";
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const signer = new ethers.Wallet(pk, provider);

      if (approveTx && approveTx.to) {
        const aTx = await signer.sendTransaction({
          to: approveTx.to,
          data: approveTx.data,
          value: approveTx.value ? BigInt(approveTx.value) : 0n,
          gasLimit: approveTx.gasLimit ? BigInt(approveTx.gasLimit) : undefined,
        });
        await aTx.wait();
      }

      const swapResult = await getSwapData({
        chainId: state.chainId,
        fromTokenAddress: state.tokenAddress,
        toTokenAddress: OKX_NATIVE_TOKEN,
        amount: rawAmount,
        slippage: "3",
        userWalletAddress: walletAddr,
      });

      const swapTx = swapResult?.data?.[0]?.tx;
      if (!swapTx) throw new Error("No swap route found. Token may have low liquidity.");

      const tx = await signer.sendTransaction({
        to: swapTx.to,
        data: swapTx.data,
        value: swapTx.value ? BigInt(swapTx.value) : 0n,
        gasLimit: swapTx.gasLimit ? BigInt(swapTx.gasLimit) : undefined,
      });

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");

      const explorerUrls: Record<string, string> = {
        "56": "https://bscscan.com/tx/", "1": "https://etherscan.io/tx/",
        "8453": "https://basescan.org/tx/", "42161": "https://arbiscan.io/tx/",
        "137": "https://polygonscan.com/tx/", "10": "https://optimistic.etherscan.io/tx/",
        "43114": "https://snowtrace.io/tx/", "196": "https://www.okx.com/explorer/xlayer/tx/",
      };
      const explorer = explorerUrls[state.chainId] || "https://bscscan.com/tx/";

      pendingSell.delete(chatId);
      await bot.sendMessage(chatId,
        `✅ *Sell Executed!*\n\n` +
        `💸 ${state.sellAmount} ${state.tokenSymbol} → ${state.nativeSymbol}\n` +
        `⛓ ${state.chainName}\n\n` +
        `[View Transaction](${explorer}${receipt.hash})`,
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "💸 Sell More", callback_data: "action:sell" }], [{ text: "👛 Wallet", callback_data: "action:wallet" }, { text: "« Menu", callback_data: "action:menu" }]] } }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `❌ Sell failed: ${e.message?.substring(0, 150)}\n\nTry again or check your balance.`,
        { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "sell_confirm" }], [{ text: "💸 Sell", callback_data: "action:sell" }, { text: "« Menu", callback_data: "action:menu" }]] } }
      );
    }
    return;
  }

  if (data.startsWith("smart_swap:")) {
    const parts = data.replace("smart_swap:", "").split(":");
    const [sAmount, sFrom, sTo, sChainId] = parts;
    const sChain = OKX_CHAINS.find(c => c.id === sChainId);
    if (!sChain) return;
    const sTokens = getOKXTokensForChain(sChainId);
    const sFromToken = sTokens.find(t => t.symbol.toLowerCase() === sFrom.toLowerCase());
    const sToToken = sTokens.find(t => t.symbol.toLowerCase() === sTo.toLowerCase());
    if (!sFromToken || !sToToken) {
      await bot.sendMessage(chatId, `Could not find tokens on ${sChain.name}. Try /swap to start fresh.`);
      return;
    }
    const sRawAmount = parseHumanAmount(sAmount, sFromToken.decimals);
    await bot.sendMessage(chatId, `🔄 Getting quote: ${sAmount} ${sFromToken.symbol} → ${sToToken.symbol} on ${sChain.name}...`);
    sendTyping(chatId);
    try {
      const { getSwapQuote } = await import("./okx-onchainos");
      const quote = await getSwapQuote({ chainId: sChainId, fromTokenAddress: sFromToken.address, toTokenAddress: sToToken.address, amount: sRawAmount, slippage: "1" });
      const receiveAmt = quote?.data?.[0]?.toTokenAmount ? formatTokenAmount(quote.data[0].toTokenAmount, sToToken.decimals) : null;
      if (receiveAmt) {
        pendingOKXSwap.set(chatId, { step: "confirm", chainId: sChainId, chainName: sChain.name, fromToken: sFromToken.address, fromSymbol: sFromToken.symbol, toToken: sToToken.address, toSymbol: sToToken.symbol, amount: sRawAmount, quoteData: quote.data[0] });
        await bot.sendMessage(chatId, `🔄 *Swap Quote on ${sChain.name}*\n\n💰 ${sAmount} ${sFromToken.symbol} → ${receiveAmt} ${sToToken.symbol}\n\nConfirm this swap?`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Swap", callback_data: "okxswap_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, "No quote available for this pair. Try different tokens or amounts.", { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Quote error: ${e.message}`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  if (data.startsWith("smart_bridge:")) {
    const parts = data.replace("smart_bridge:", "").split(":");
    const [bToken, bFromChainId, bToChainId, bAmount] = parts;
    const bFromChain = OKX_CHAINS.find(c => c.id === bFromChainId);
    const bToChain = OKX_CHAINS.find(c => c.id === bToChainId);
    if (!bFromChain || !bToChain) return;
    const wallets = getUserWallets(chatId);
    const activeIdx = getActiveWalletIndex(chatId);
    const wallet = wallets[activeIdx];
    if (!wallet) {
      await bot.sendMessage(chatId, "You need a wallet first! Tap /start to create one.");
      return;
    }
    await bot.sendMessage(chatId, `🌉 Getting bridge quote: ${bAmount} ${bToken.toUpperCase()} from ${bFromChain.name} → ${bToChain.name}...`);
    sendTyping(chatId);
    try {
      const { getBridgeQuote } = await import("./okx-onchainos");
      const fromTokens = getOKXTokensForChain(bFromChainId);
      const bridgeToken = fromTokens.find(t => t.symbol.toLowerCase() === bToken.toLowerCase());
      if (!bridgeToken) {
        await bot.sendMessage(chatId, `Token ${bToken.toUpperCase()} not found on ${bFromChain.name}. Try /bridge to start fresh.`);
        return;
      }
      const rawAmt = parseHumanAmount(bAmount, bridgeToken.decimals);
      const quote = await getBridgeQuote({ fromChainId: bFromChainId, toChainId: bToChainId, fromTokenAddress: bridgeToken.address, toTokenAddress: bridgeToken.address, amount: rawAmt, slippage: "1", userWalletAddress: wallet.address });
      const receiveAmt = quote?.data?.[0]?.toTokenAmount ? formatTokenAmount(quote.data[0].toTokenAmount, bridgeToken.decimals) : null;
      if (receiveAmt) {
        pendingOKXBridge.set(chatId, { step: "confirm", fromChainId: bFromChainId, fromChainName: bFromChain.name, toChainId: bToChainId, toChainName: bToChain.name, fromToken: bridgeToken.address, fromSymbol: bridgeToken.symbol, toToken: bridgeToken.address, toSymbol: bridgeToken.symbol, amount: rawAmt, receiveAddress: wallet.address, quoteData: quote.data[0] });
        await bot.sendMessage(chatId, `🌉 *Bridge Quote*\n\n${bAmount} ${bridgeToken.symbol} on ${bFromChain.name} → ${receiveAmt} ${bridgeToken.symbol} on ${bToChain.name}\n\nConfirm this bridge?`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Bridge", callback_data: "okxbridge_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, "No bridge route available for this pair. Try /bridge for more options.", { reply_markup: { inline_keyboard: [[{ text: "🌉 Open Bridge", callback_data: "action:okxbridge" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Bridge quote error: ${e.message}`, { reply_markup: { inline_keyboard: [[{ text: "🌉 Retry", callback_data: "action:okxbridge" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  if (data.startsWith("sol_bridge_use:")) {
    const solAddr = data.replace("sol_bridge_use:", "");
    const state = pendingOKXBridge.get(chatId);
    if (!state) return;
    state.receiveAddress = solAddr;
    state.step = "confirm";
    await bot.sendMessage(chatId,
      `✅ SOL wallet set: \`${solAddr.substring(0, 8)}...${solAddr.slice(-6)}\`\n\nConfirm this cross-chain swap?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Cross-Chain Swap", callback_data: "okxbridge_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } }
    );
    return;
  }

  if (data === "sol_bridge_generate") {
    const state = pendingOKXBridge.get(chatId);
    if (!state) return;
    await bot.sendMessage(chatId, "🔑 Generating Solana wallet...");
    sendTyping(chatId);
    const solWallet = await getOrCreateSolanaWallet(chatId);
    state.receiveAddress = solWallet.address;
    state.step = "confirm";
    await bot.sendMessage(chatId,
      `🔑 *Solana Wallet Created!*\n\n` +
      `Address:\n\`${solWallet.address}\`\n\n` +
      `Private Key:\n\`${solWallet.privateKey}\`\n\n` +
      `⚠️ *SAVE YOUR PRIVATE KEY* — it won't be shown again.\n\n` +
      `Confirm this cross-chain swap?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Cross-Chain Swap", callback_data: "okxbridge_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } }
    );
    return;
  }

  if (data === "sol_bridge_custom") {
    const state = pendingOKXBridge.get(chatId);
    if (!state) return;
    state.step = "sol_address" as any;
    await bot.sendMessage(chatId, "📝 Enter your Solana wallet address:");
    return;
  }

  if (data === "okxswap_confirm") {
    const state = pendingOKXSwap.get(chatId);
    if (!state || state.step !== "confirm") {
      await bot.sendMessage(chatId, "Swap session expired. Try again.", { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    const walletAddr = getLinkedWallet(chatId);
    if (!walletAddr || !await checkWalletHasKey(chatId, walletAddr)) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to execute swaps. Use /wallet to set one up.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    await bot.sendMessage(chatId, `⏳ Executing swap: ${state.fromSymbol} → ${state.toSymbol} on ${state.chainName}...`);
    sendTyping(chatId);
    try {
      const { getSwapData } = await import("./okx-onchainos");
      const swapTx = await getSwapData({
        chainId: state.chainId!, fromTokenAddress: state.fromToken!, toTokenAddress: state.toToken!,
        amount: state.amount!, slippage: "1", userWalletAddress: walletAddr,
      });
      const txData = swapTx?.data?.[0]?.tx;
      if (!txData) throw new Error("No transaction data returned");
      let pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), walletAddr);
      if (!pk) pk = await storage.getPrivateKeyByWalletAddress(walletAddr);
      if (!pk) throw new Error("Private key not found. Generate a new wallet or re-import your key via /wallet.");
      const CHAIN_RPCS: Record<string, string> = { "56": "https://bsc-dataseed1.binance.org", "1": "https://eth.llamarpc.com", "8453": "https://mainnet.base.org", "42161": "https://arb1.arbitrum.io/rpc", "137": "https://polygon-rpc.com", "10": "https://mainnet.optimism.io", "43114": "https://api.avax.network/ext/bc/C/rpc", "196": "https://rpc.xlayer.tech", "250": "https://rpc.ftm.tools", "5000": "https://rpc.mantle.xyz" };
      const rpcUrl = CHAIN_RPCS[state.chainId!] || "https://bsc-dataseed1.binance.org";
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(pk, provider);
      const tx = await wallet.sendTransaction({
        to: txData.to, data: txData.data, value: txData.value ? BigInt(txData.value) : 0n,
        gasLimit: txData.gasLimit ? BigInt(txData.gasLimit) : undefined,
      });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");
      const chain = OKX_CHAINS.find(c => c.id === state.chainId);
      const explorerUrls: Record<string, string> = { "56": "https://bscscan.com/tx/", "1": "https://etherscan.io/tx/", "8453": "https://basescan.org/tx/", "42161": "https://arbiscan.io/tx/", "137": "https://polygonscan.com/tx/", "10": "https://optimistic.etherscan.io/tx/", "43114": "https://snowtrace.io/tx/", "196": "https://www.okx.com/explorer/xlayer/tx/" };
      const explorer = explorerUrls[state.chainId!] || "https://bscscan.com/tx/";
      await bot.sendMessage(chatId,
        `✅ *Swap Executed!*\n\n${state.fromSymbol} → ${state.toSymbol} on ${chain?.name || state.chainName}\n` +
        `Platform fee: ${TRANSACTION_FEE_PERCENT}%\n\n` +
        `[View Transaction](${explorer}${receipt.hash})`,
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "🔄 New Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Swap failed: ${e.message?.substring(0, 150)}\n\nTry again or check your balance.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    pendingOKXSwap.delete(chatId);
    return;
  }

  if (data === "okxbridge_confirm") {
    const state = pendingOKXBridge.get(chatId);
    if (!state || state.step !== "confirm") {
      await bot.sendMessage(chatId, "Bridge session expired. Try again.", { reply_markup: { inline_keyboard: [[{ text: "🌉 Open Bridge", callback_data: "action:okxbridge" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    const walletAddr = getLinkedWallet(chatId);
    if (!walletAddr || !await checkWalletHasKey(chatId, walletAddr)) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to execute bridges. Use /wallet to set one up.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    const isLifi = state.quoteData?._provider === "lifi";
    const bridgeProvider = isLifi ? (state.quoteData?.bridgeProvider || "Li.Fi") : "OKX";
    await bot.sendMessage(chatId, `⏳ Executing cross-chain swap via ${bridgeProvider}: ${state.fromSymbol} (${state.fromChainName}) → ${state.toSymbol} (${state.toChainName})...`);
    sendTyping(chatId);
    try {
      let pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), walletAddr);
      if (!pk) pk = await storage.getPrivateKeyByWalletAddress(walletAddr);
      if (!pk) throw new Error("Private key not found. Generate a new wallet or re-import your key via /wallet.");
      const CHAIN_RPCS: Record<string, string> = { "56": "https://bsc-dataseed1.binance.org", "1": "https://eth.llamarpc.com", "8453": "https://mainnet.base.org", "42161": "https://arb1.arbitrum.io/rpc", "137": "https://polygon-rpc.com", "10": "https://mainnet.optimism.io", "43114": "https://api.avax.network/ext/bc/C/rpc", "196": "https://rpc.xlayer.tech", "250": "https://rpc.ftm.tools", "5000": "https://rpc.mantle.xyz" };
      const rpcUrl = CHAIN_RPCS[state.fromChainId!] || "https://bsc-dataseed1.binance.org";
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(pk, provider);

      let txData: any;
      if (isLifi) {
        const lifiQuote = state.quoteData?._lifiQuote;
        if (lifiQuote?.transactionRequest) {
          txData = lifiQuote.transactionRequest;
        } else {
          const toAddr = state.toChainId === "501" && state.receiveAddress ? `&toAddress=${state.receiveAddress}` : "";
          const normFromToken = state.fromToken === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ? "0x0000000000000000000000000000000000000000" : state.fromToken;
          const normToToken = state.toChainId === "501" ? state.toToken : (state.toToken === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ? "0x0000000000000000000000000000000000000000" : state.toToken);
          const toChainParam = state.toChainId === "501" ? "SOL" : state.toChainId;
          const lifiResp = await fetch(`https://li.quest/v1/quote?fromChain=${state.fromChainId}&toChain=${toChainParam}&fromToken=${normFromToken}&toToken=${normToToken}&fromAmount=${state.amount}&fromAddress=${walletAddr}${toAddr}`, { headers: { "Accept": "application/json" } });
          const lifiData = await lifiResp.json();
          txData = lifiData?.transactionRequest;
        }
      } else {
        const { getCrossChainSwap } = await import("./okx-onchainos");
        const swapResult = await getCrossChainSwap({
          fromChainId: state.fromChainId!, toChainId: state.toChainId!,
          fromTokenAddress: state.fromToken!, toTokenAddress: state.toToken!,
          amount: state.amount!, userWalletAddress: walletAddr, slippage: "1",
        });
        txData = swapResult?.data?.[0]?.tx;
      }

      if (!txData) throw new Error("No transaction data returned");
      const tx = await wallet.sendTransaction({
        to: txData.to, data: txData.data, value: txData.value ? BigInt(txData.value) : 0n,
        gasLimit: txData.gasLimit ? BigInt(txData.gasLimit) : 300000n,
      });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");
      const explorerUrls: Record<string, string> = { "56": "https://bscscan.com/tx/", "1": "https://etherscan.io/tx/", "8453": "https://basescan.org/tx/", "42161": "https://arbiscan.io/tx/", "137": "https://polygonscan.com/tx/", "10": "https://optimistic.etherscan.io/tx/", "43114": "https://snowtrace.io/tx/", "196": "https://www.okx.com/explorer/xlayer/tx/" };
      const explorer = explorerUrls[state.fromChainId!] || "https://bscscan.com/tx/";
      await bot.sendMessage(chatId,
        `✅ *Cross-Chain Swap Executed!*\n\n${state.fromSymbol} (${state.fromChainName}) → ${state.toSymbol} (${state.toChainName})\nVia: ${bridgeProvider}\n` +
        `Platform fee: ${TRANSACTION_FEE_PERCENT}%\n\n` +
        `[View Transaction](${explorer}${receipt.hash})`,
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "🔄 New Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Cross-chain swap failed: ${e.message?.substring(0, 150)}\n\nCheck your balance and try again.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    pendingOKXBridge.delete(chatId);
    return;
  }

  if (data === "action:okxswap") {
    pendingOKXSwap.set(chatId, { step: "chain" });
    pendingOKXBridge.delete(chatId);
    const chainButtons = OKX_CHAINS.map(c => [{ text: `${c.name} (${c.symbol})`, callback_data: `okxswap_chain:${c.id}` }]);
    chainButtons.push([{ text: "« Back", callback_data: "action:menu" }]);
    await bot.sendMessage(chatId,
      "🔄 *OKX DEX Swap*\n\nSwap tokens on any chain using OKX DEX Aggregator.\n\nSelect a chain:",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
    );
    return;
  }

  if (data.startsWith("okxswap_chain:")) {
    const chainId = data.replace("okxswap_chain:", "");
    const chain = OKX_CHAINS.find(c => c.id === chainId);
    if (!chain) return;
    const tokens = getOKXTokensForChain(chainId);
    pendingOKXSwap.set(chatId, { step: "from_token", chainId, chainName: chain.name });
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxswap_from:${t.address}:${t.symbol}` }]);
    tokenButtons.push([{ text: "📝 Custom Address", callback_data: "okxswap_from_custom" }]);
    tokenButtons.push([{ text: "« Back", callback_data: "action:okxswap" }]);
    await bot.sendMessage(chatId,
      `🔄 *Swap on ${chain.name}*\n\nSelect token to sell:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (data.startsWith("okxswap_from:")) {
    const parts = data.replace("okxswap_from:", "").split(":");
    const [address, symbol] = parts;
    const state = pendingOKXSwap.get(chatId);
    if (!state) return;
    state.fromToken = address;
    state.fromSymbol = symbol;
    state.step = "to_token";
    const tokens = getOKXTokensForChain(state.chainId!).filter(t => t.address !== address);
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxswap_to:${t.address}:${t.symbol}` }]);
    tokenButtons.push([{ text: "📝 Custom Address", callback_data: "okxswap_to_custom" }]);
    tokenButtons.push([{ text: "« Back", callback_data: `okxswap_chain:${state.chainId}` }]);
    await bot.sendMessage(chatId,
      `🔄 *Swap ${symbol} on ${state.chainName}*\n\nSelect token to buy:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (data === "okxswap_from_custom") {
    const state = pendingOKXSwap.get(chatId);
    if (!state) return;
    state.step = "from_token";
    await bot.sendMessage(chatId, "Enter the contract address of the token you want to sell (0x...):");
    return;
  }

  if (data === "okxswap_to_custom") {
    const state = pendingOKXSwap.get(chatId);
    if (!state) return;
    state.step = "to_token";
    await bot.sendMessage(chatId, "Enter the contract address of the token you want to buy (0x...):");
    return;
  }

  if (data.startsWith("okxswap_to:")) {
    const parts = data.replace("okxswap_to:", "").split(":");
    const [address, symbol] = parts;
    const state = pendingOKXSwap.get(chatId);
    if (!state) return;
    state.toToken = address;
    state.toSymbol = symbol;
    state.step = "amount";
    await bot.sendMessage(chatId,
      `🔄 *Swap on ${state.chainName}*\n\n` +
      `From: ${state.fromSymbol}\nTo: ${symbol}\n\n` +
      `Enter the amount of ${state.fromSymbol} to swap:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data === "action:okxbridge") {
    pendingOKXBridge.set(chatId, { step: "from_chain" });
    const chainButtons = OKX_CHAINS.map(c => [{ text: `${c.name} (${c.symbol})`, callback_data: `okxbridge_from:${c.id}` }]);
    chainButtons.push([{ text: "« Back", callback_data: "action:menu" }]);
    await bot.sendMessage(chatId,
      "🌉 *Cross-Chain Bridge*\n\n" +
      "Powered by Li.Fi — best routes across 20+ bridges.\n\n" +
      "Select the *source chain*:",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
    );
    return;
  }

  if (data.startsWith("okxbridge_from:")) {
    const chainId = data.replace("okxbridge_from:", "");
    const chain = OKX_CHAINS.find(c => c.id === chainId);
    if (!chain) return;
    pendingOKXBridge.set(chatId, { step: "to_chain", fromChainId: chainId, fromChainName: chain.name });
    const destChains = OKX_CHAINS.filter(c => c.id !== chainId);
    const chainButtons = destChains.map(c => [{ text: `${c.name} (${c.symbol})`, callback_data: `okxbridge_to:${c.id}` }]);
    chainButtons.push([{ text: "« Back", callback_data: "action:okxbridge" }]);
    await bot.sendMessage(chatId,
      `🌉 *Bridge from ${chain.name}*\n\nSelect destination chain:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
    );
    return;
  }

  if (data.startsWith("okxbridge_to:")) {
    const chainId = data.replace("okxbridge_to:", "");
    const chain = OKX_CHAINS.find(c => c.id === chainId);
    const state = pendingOKXBridge.get(chatId);
    if (!state || !chain) return;
    state.toChainId = chainId;
    state.toChainName = chain.name;
    state.step = "from_token";
    const tokens = getOKXTokensForChain(state.fromChainId!);
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxbridge_ftoken:${t.address}:${t.symbol}:${t.decimals}` }]);
    tokenButtons.push([{ text: "« Back", callback_data: `okxbridge_from:${state.fromChainId}` }]);
    await bot.sendMessage(chatId,
      `🌉 *${state.fromChainName} → ${chain.name}*\n\nSelect token to bridge:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (data.startsWith("okxbridge_ftoken:")) {
    const parts = data.replace("okxbridge_ftoken:", "").split(":");
    const [address, symbol, decimalsStr] = parts;
    const state = pendingOKXBridge.get(chatId);
    if (!state) return;
    state.fromToken = address;
    state.fromSymbol = symbol;
    state.fromDecimals = parseInt(decimalsStr);
    state.step = "to_token";
    const tokens = getOKXTokensForChain(state.toChainId!);
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxbridge_ttoken:${t.address}:${t.symbol}:${t.decimals}` }]);
    tokenButtons.push([{ text: "« Back", callback_data: `okxbridge_to:${state.toChainId}` }]);
    await bot.sendMessage(chatId,
      `🌉 *${state.fromChainName} → ${state.toChainName}*\nToken: ${symbol}\n\nSelect token to receive:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (data.startsWith("okxbridge_ttoken:")) {
    const parts = data.replace("okxbridge_ttoken:", "").split(":");
    const [address, symbol, decimalsStr] = parts;
    const state = pendingOKXBridge.get(chatId);
    if (!state) return;
    state.toToken = address;
    state.toSymbol = symbol;
    state.toDecimals = parseInt(decimalsStr);
    state.step = "amount";
    await bot.sendMessage(chatId,
      `🌉 *${state.fromChainName} → ${state.toChainName}*\n` +
      `Send: ${state.fromSymbol}\nReceive: ${symbol}\n\n` +
      `Enter the amount of ${state.fromSymbol} to bridge:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data.startsWith("okxbridge_usewallet:")) {
    const addr = data.replace("okxbridge_usewallet:", "");
    const state = pendingOKXBridge.get(chatId);
    if (!state) return;
    state.receiver = addr;
    await executeBridgeQuote(chatId, state);
    return;
  }

  if (data === "action:trade") {
    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to use the trading agent. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    const { getUserTradingStatus } = await import("./trading-agent");
    const { config, positions } = getUserTradingStatus(chatId);
    const isEnabled = config.enabled;

    let statusLine = isEnabled
      ? `Status: ✅ ACTIVE | Open Positions: ${positions.length}`
      : `Status: ⏸ DISABLED`;

    const toggleBtn = isEnabled
      ? { text: "⏸ Disable Trading", callback_data: "trade:disable" }
      : { text: "▶️ Enable Trading", callback_data: "trade:enable" };

    await bot.sendMessage(chatId,
      `💎 *Make Me Rich — Autonomous Trading Agent*\n\n${statusLine}\n\nThe agent scans Four.meme for new token launches, evaluates momentum signals, and trades automatically from your wallet.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [toggleBtn],
            [{ text: "🎯 Instant Sniper", callback_data: "trade:instantsniper" }],
            [{ text: "📊 Status", callback_data: "trade:status" }, { text: "⚙️ Settings", callback_data: "trade:settings" }],
            [{ text: "🧩 Agent Skills", callback_data: "trade:skills" }],
            [{ text: "📜 History", callback_data: "trade:history" }, { text: "🔴 Close All", callback_data: "trade:closeall" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("trade:")) {
    const tradeAction = data.split(":")[1];
    const { setUserTradingConfig, getUserTradingStatus, startTradingAgent, isTradingAgentRunning, getActivePositionsForUser, getTradeHistoryForUser, manualClosePosition } = await import("./trading-agent");

    if (tradeAction === "instantsniper") {
      const { isInstantSniperEnabled, setInstantSniperEnabled } = await import("./trading-agent");
      const currentlyEnabled = isInstantSniperEnabled();
      const newState = !currentlyEnabled;
      setInstantSniperEnabled(newState);
      const statusText = newState
        ? "🎯 *Instant Sniper ENABLED*\n\nThe bot will now automatically buy EVERY new token on Four.meme within seconds of launch.\n\n⚡ Scan interval: 1.5s\n💰 Buy amount: 0.05 BNB per snipe\n🎯 Max age: 60s after launch\n⚠️ High risk — trades happen with NO AI analysis"
        : "⏸ *Instant Sniper DISABLED*\n\nThe bot will no longer auto-buy new launches. The regular sniper (score-based) is still active.";
      await bot.sendMessage(chatId, statusText, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: newState ? "⏸ Disable Instant Sniper" : "🎯 Enable Instant Sniper", callback_data: "trade:instantsniper" }],
            [{ text: "« Back to Trading", callback_data: "action:trade" }],
          ],
        },
      });
      return;
    }

    if (tradeAction === "enable") {
      setUserTradingConfig(chatId, { enabled: true });
      if (!isTradingAgentRunning()) {
        startTradingAgent((cid, msg) => {
          bot?.sendMessage(cid, msg, { reply_markup: mainMenuKeyboard(undefined, chatId) }).catch(() => {});
        });
      }
      await bot.sendMessage(chatId,
        "✅ Trading agent ENABLED\n\nThe agent will scan Four.meme for new tokens and trade automatically. You'll be notified of every buy and sell.\n\nUse /tradestatus to check positions.",
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
      return;
    }

    if (tradeAction === "disable") {
      setUserTradingConfig(chatId, { enabled: false });
      await bot.sendMessage(chatId, "⏸ Trading agent DISABLED\n\nExisting positions will still be monitored until closed.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    if (tradeAction === "status") {
      const { config, positions } = getUserTradingStatus(chatId);
      let msg = `📊 *Trading Agent*\n\n`;
      msg += `Status: ${config.enabled ? "✅ ACTIVE" : "⏸ DISABLED"}\n`;
      msg += `Open Positions: ${positions.length}\n`;
      if (positions.length > 0) {
        msg += `\n`;
        for (const p of positions) {
          const age = Math.floor((Date.now() - p.entryTime) / 60000);
          msg += `  • $${p.tokenSymbol} — ${p.entryPriceBnb} BNB (${age}m ago)\n`;
        }
      }
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    if (tradeAction === "settings") {
      const { config } = getUserTradingStatus(chatId);
      await bot.sendMessage(chatId,
        `⚙️ *Trading Settings*\n\n` +
        `Current config:\n` +
        `• Buy: ${config.buyAmountBnb} BNB per trade\n` +
        `• TP: ${config.takeProfitMultiple}x\n` +
        `• SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n` +
        `• Max positions: ${config.maxPositions}\n\n` +
        `Adjust:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "0.1 BNB", callback_data: "tradeset:buy:0.1" }, { text: "0.25 BNB", callback_data: "tradeset:buy:0.25" }, { text: "0.5 BNB", callback_data: "tradeset:buy:0.5" }],
              [{ text: "TP 1.5x", callback_data: "tradeset:tp:1.5" }, { text: "TP 2x", callback_data: "tradeset:tp:2" }, { text: "TP 3x", callback_data: "tradeset:tp:3" }],
              [{ text: "SL -20%", callback_data: "tradeset:sl:0.8" }, { text: "SL -30%", callback_data: "tradeset:sl:0.7" }, { text: "SL -50%", callback_data: "tradeset:sl:0.5" }],
              [{ text: "Max 3", callback_data: "tradeset:max:3" }, { text: "Max 5", callback_data: "tradeset:max:5" }, { text: "Max 10", callback_data: "tradeset:max:10" }],
              [{ text: "« Back", callback_data: "trade:status" }],
            ],
          },
        }
      );
      return;
    }

    if (tradeAction === "history") {
      const history = getTradeHistoryForUser(chatId);
      if (history.length === 0) {
        await bot.sendMessage(chatId, "No trade history yet. Enable the agent with /trade to start.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }
      let msg = `📜 *Trade History (last ${history.length}):*\n\n`;
      let totalPnl = 0;
      for (const t of history.slice(-10)) {
        const emoji = t.status === "closed_profit" ? "💰" : t.status === "closed_loss" ? "📉" : "🔄";
        const pnl = parseFloat(t.pnlBnb || "0");
        totalPnl += pnl;
        msg += `${emoji} $${t.tokenSymbol}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} BNB\n`;
      }
      msg += `\n*Net PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} BNB*`;
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    if (tradeAction === "closeall") {
      const positions = getActivePositionsForUser(chatId);
      if (positions.length === 0) {
        await bot.sendMessage(chatId, "No open positions to close.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }
      await bot.sendMessage(chatId, `Closing ${positions.length} position(s)...`);
      let closed = 0;
      for (const p of positions) {
        const ok = await manualClosePosition(p.id, (cid, m) => bot?.sendMessage(cid, m).catch(() => {}));
        if (ok) closed++;
      }
      await bot.sendMessage(chatId, `Closed ${closed}/${positions.length} positions.`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    if (tradeAction === "skills") {
      const { SKILL_REGISTRY } = await import("./agent-skills");
      const { getSkillsByCategory } = await import("./agent-skills");
      const strategies = getSkillsByCategory("strategy");
      const analysis = getSkillsByCategory("analysis");
      const execution = getSkillsByCategory("execution");
      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const enabledSet = new Set(dbConfigs.filter(c => c.enabled).map(c => c.skillId));
      const defaultEnabled = new Set(SKILL_REGISTRY.filter(s => s.defaultEnabled).map(s => s.id));
      const isEnabled = (id: string) => dbConfigs.some(c => c.skillId === id) ? enabledSet.has(id) : defaultEnabled.has(id);

      const countEnabled = (skills: typeof SKILL_REGISTRY) => skills.filter(s => isEnabled(s.id)).length;

      await bot.sendMessage(chatId,
        `🧩 *Agent Skills*\n\n` +
        `Customize your trading agent with modular skills. Toggle them on/off to match your strategy.\n\n` +
        `🎯 *Strategies* — ${countEnabled(strategies)}/${strategies.length} active\n` +
        `🔍 *Analysis* — ${countEnabled(analysis)}/${analysis.length} active\n` +
        `⚡ *Execution* — ${countEnabled(execution)}/${execution.length} active`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: `🎯 Strategies (${countEnabled(strategies)})`, callback_data: "skills:cat:strategy" }],
              [{ text: `🔍 Analysis (${countEnabled(analysis)})`, callback_data: "skills:cat:analysis" }],
              [{ text: `⚡ Execution (${countEnabled(execution)})`, callback_data: "skills:cat:execution" }],
              [{ text: "« Back to Trading", callback_data: "action:trade" }],
            ],
          },
        }
      );
      return;
    }

    return;
  }

  if (data.startsWith("tradeset:")) {
    const parts = data.split(":");
    const param = parts[1];
    const value = parts[2];
    const { setUserTradingConfig, getUserTradingStatus } = await import("./trading-agent");

    if (param === "buy") {
      setUserTradingConfig(chatId, { buyAmountBnb: value });
    } else if (param === "tp") {
      setUserTradingConfig(chatId, { takeProfitMultiple: parseFloat(value) });
    } else if (param === "sl") {
      setUserTradingConfig(chatId, { stopLossMultiple: parseFloat(value) });
    } else if (param === "max") {
      setUserTradingConfig(chatId, { maxPositions: parseInt(value) });
    }

    const { config } = getUserTradingStatus(chatId);
    await bot.sendMessage(chatId,
      `✅ Updated!\n\n` +
      `• Buy: ${config.buyAmountBnb} BNB\n` +
      `• TP: ${config.takeProfitMultiple}x\n` +
      `• SL: ${(config.stopLossMultiple * 100).toFixed(0)}%\n` +
      `• Max: ${config.maxPositions} positions`,
      { reply_markup: mainMenuKeyboard(undefined, chatId) }
    );
    return;
  }

  if (data.startsWith("skills:")) {
    const { SKILL_REGISTRY, getSkillsByCategory, getSkillById } = await import("./agent-skills");
    const { invalidateSkillsCache } = await import("./trading-agent");
    const skillParts = data.split(":");

    if (skillParts[1] === "cat") {
      const category = skillParts[2] as "strategy" | "analysis" | "execution";
      const categoryLabels: Record<string, string> = { strategy: "🎯 Strategy Skills", analysis: "🔍 Analysis Skills", execution: "⚡ Execution Skills" };
      const skills = getSkillsByCategory(category);
      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const enabledSet = new Set(dbConfigs.filter(c => c.enabled).map(c => c.skillId));
      const defaultEnabled = new Set(SKILL_REGISTRY.filter(s => s.defaultEnabled).map(s => s.id));
      const isEnabled = (id: string) => dbConfigs.some(c => c.skillId === id) ? enabledSet.has(id) : defaultEnabled.has(id);

      let msg = `${categoryLabels[category] || category}\n\n`;
      for (const s of skills) {
        const on = isEnabled(s.id);
        msg += `${s.icon} *${s.name}* ${on ? "✅" : "❌"}\n${s.shortDesc}\n\n`;
      }
      msg += `Tap a skill to toggle it on/off:`;

      const buttons = skills.map(s => {
        const on = isEnabled(s.id);
        return [{ text: `${s.icon} ${s.name} ${on ? "✅" : "❌"}`, callback_data: `skills:toggle:${s.id}` }];
      });
      buttons.push([{ text: "« Back to Skills", callback_data: "trade:skills" }]);

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
      return;
    }

    if (skillParts[1] === "toggle") {
      const skillId = skillParts[2];
      const skill = getSkillById(skillId);
      if (!skill) {
        await bot.sendMessage(chatId, "Unknown skill.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }

      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const existing = dbConfigs.find(c => c.skillId === skillId);
      const wasEnabled = existing ? existing.enabled : skill.defaultEnabled;
      const newEnabled = !wasEnabled;
      const config = existing?.config || { ...skill.defaultConfig };

      await storage.setUserSkillConfig(chatId.toString(), skillId, newEnabled, config);
      invalidateSkillsCache(chatId);

      const statusEmoji = newEnabled ? "✅" : "❌";
      let msg = `${skill.icon} *${skill.name}* — ${newEnabled ? "ENABLED" : "DISABLED"} ${statusEmoji}\n\n${skill.description}`;

      const buttons: any[][] = [];
      if (newEnabled && skill.configSchema && skill.configSchema.length > 0) {
        buttons.push([{ text: "⚙️ Configure", callback_data: `skills:config:${skillId}` }]);
      }
      buttons.push([{ text: `« Back to ${skill.category}`, callback_data: `skills:cat:${skill.category}` }]);

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
      return;
    }

    if (skillParts[1] === "config") {
      const skillId = skillParts[2];
      const skill = getSkillById(skillId);
      if (!skill || !skill.configSchema) {
        await bot.sendMessage(chatId, "No configurable options for this skill.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }

      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const existing = dbConfigs.find(c => c.skillId === skillId);
      const config = existing?.config || { ...skill.defaultConfig };

      let msg = `⚙️ *${skill.icon} ${skill.name} Config*\n\n`;
      const buttons: any[][] = [];

      for (const param of skill.configSchema) {
        const currentVal = config[param.key] ?? skill.defaultConfig[param.key];
        msg += `*${param.label}:* ${currentVal}\n`;

        if (param.type === "select" && param.options) {
          const row = param.options.map(opt => ({
            text: `${opt.label}${String(currentVal) === opt.value ? " ✓" : ""}`,
            callback_data: `skills:set:${skillId}:${param.key}:${opt.value}`,
          }));
          buttons.push(row);
        } else if (param.type === "boolean") {
          buttons.push([
            { text: `${currentVal ? "✅ On" : "❌ Off"} — Toggle`, callback_data: `skills:set:${skillId}:${param.key}:${currentVal ? "false" : "true"}` },
          ]);
        } else if (param.type === "number") {
          const step = param.step || 1;
          const min = param.min ?? 0;
          const max = param.max ?? 100;
          const down = Math.max(min, Number(currentVal) - step);
          const up = Math.min(max, Number(currentVal) + step);
          buttons.push([
            { text: `⬇ ${down}`, callback_data: `skills:set:${skillId}:${param.key}:${down}` },
            { text: `${param.label}: ${currentVal}`, callback_data: `skills:config:${skillId}` },
            { text: `⬆ ${up}`, callback_data: `skills:set:${skillId}:${param.key}:${up}` },
          ]);
        }
      }
      buttons.push([{ text: `« Back to ${skill.category}`, callback_data: `skills:cat:${skill.category}` }]);

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
      return;
    }

    if (skillParts[1] === "set") {
      const skillId = skillParts[2];
      const paramKey = skillParts[3];
      const rawValue = skillParts.slice(4).join(":");
      const skill = getSkillById(skillId);
      if (!skill) return;

      const dbConfigs = await storage.getUserSkillConfigs(chatId.toString());
      const existing = dbConfigs.find(c => c.skillId === skillId);
      const config = existing?.config || { ...skill.defaultConfig };

      const paramDef = skill.configSchema?.find(p => p.key === paramKey);
      if (paramDef?.type === "number") {
        config[paramKey] = parseFloat(rawValue);
      } else if (paramDef?.type === "boolean") {
        config[paramKey] = rawValue === "true";
      } else {
        config[paramKey] = rawValue;
      }

      const isEnabled = existing?.enabled ?? skill.defaultEnabled;
      await storage.setUserSkillConfig(chatId.toString(), skillId, isEnabled, config);
      invalidateSkillsCache(chatId);

      await bot.sendMessage(chatId, `✅ Updated *${skill.name}* — ${paramDef?.label || paramKey}: ${rawValue}`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚙️ More Options", callback_data: `skills:config:${skillId}` }],
            [{ text: `« Back to ${skill.category}`, callback_data: `skills:cat:${skill.category}` }],
          ],
        },
      });
      return;
    }

    return;
  }

  if (data === "action:aster") {
    await handleAsterMenu(chatId);
    return;
  }

  if (data.startsWith("aster:")) {
    await handleAsterCallback(chatId, data);
    return;
  }

  if (data === "action:okxsignals") {
    await bot.sendMessage(chatId,
      "🐋 *Smart Money Signals*\n\nSelect signal type:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🐋 Whale Buys", callback_data: "okxsig:whale" }],
            [{ text: "🎤 KOL Buys", callback_data: "okxsig:kol" }],
            [{ text: "💰 Smart Money", callback_data: "okxsig:smart" }],
            [{ text: "🏆 Leaderboard", callback_data: "okxsig:leaderboard" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxsig:") && !data.includes(":chain:")) {
    const sigType = data.replace("okxsig:", "");
    if (sigType === "leaderboard") {
      await bot.sendMessage(chatId,
        "🏆 *Leaderboard*\n\nSelect chain:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Solana", callback_data: "okxsig:leaderboard:chain:501" }, { text: "BNB Chain", callback_data: "okxsig:leaderboard:chain:56" }],
              [{ text: "Base", callback_data: "okxsig:leaderboard:chain:8453" }, { text: "Ethereum", callback_data: "okxsig:leaderboard:chain:1" }],
              [{ text: "« Back", callback_data: "action:okxsignals" }],
            ],
          },
        }
      );
      return;
    }
    await bot.sendMessage(chatId,
      `${sigType === "whale" ? "🐋" : sigType === "kol" ? "🎤" : "💰"} *${sigType === "whale" ? "Whale" : sigType === "kol" ? "KOL" : "Smart Money"} Signals*\n\nSelect chain:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Solana", callback_data: `okxsig:${sigType}:chain:501` }, { text: "BNB Chain", callback_data: `okxsig:${sigType}:chain:56` }],
            [{ text: "Base", callback_data: `okxsig:${sigType}:chain:8453` }, { text: "Ethereum", callback_data: `okxsig:${sigType}:chain:1` }],
            [{ text: "« Back", callback_data: "action:okxsignals" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxsig:") && data.includes(":chain:")) {
    const parts = data.replace("okxsig:", "").split(":chain:");
    const sigType = parts[0];
    const chain = parts[1] || "501";
    const chainLabel = chain === "501" ? "Solana" : chain === "56" ? "BNB Chain" : chain === "8453" ? "Base" : "Ethereum";

    if (sigType === "leaderboard") {
      await bot.sendMessage(chatId, `Loading leaderboard on ${chainLabel}...`);
      try {
        const result = await getLeaderboard(chain, "3", "1");
        if (result.success && result.data) {
          const entries = Array.isArray(result.data) ? result.data.slice(0, 10) : result.data?.data?.slice(0, 10) || [];
          if (entries.length === 0) {
            await bot.sendMessage(chatId, "No leaderboard data available right now.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
          } else {
            let text = `🏆 *Top Traders — ${chainLabel}*\n\n`;
            entries.forEach((e: any, i: number) => {
              const addr = e.walletAddress || e.address || "Unknown";
              const pnl = e.realizedPnlUsd ? `$${parseFloat(e.realizedPnlUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : e.pnl ? `$${parseFloat(e.pnl).toFixed(0)}` : "N/A";
              const winRate = e.winRatePercent ? `${parseFloat(e.winRatePercent).toFixed(0)}%` : e.winRate ? `${(parseFloat(e.winRate) * 100).toFixed(0)}%` : "N/A";
              const txs = e.txs ? ` | ${Number(e.txs).toLocaleString()} txs` : "";
              text += `${i + 1}. PnL: ${pnl} | Win: ${winRate}${txs}\n\`${addr}\`\n\n`;
            });
            await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxsig:leaderboard:chain:${chain}` }], [{ text: "« Back", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
          }
        } else {
          await bot.sendMessage(chatId, `Leaderboard unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }]] } });
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }]] } });
      }
      return;
    }

    const walletTypeMap: Record<string, string> = { whale: "1", kol: "2", smart: "3" };
    const labelMap: Record<string, string> = { whale: "🐋 Whale", kol: "🎤 KOL", smart: "💰 Smart Money" };
    const wType = walletTypeMap[sigType] || "1";
    const label = labelMap[sigType] || "Smart Money";
    await bot.sendMessage(chatId, `Loading ${label} signals on ${chainLabel}...`);
    try {
      const result = await getSmartMoneySignals(chain, wType);
      if (result.success && result.data) {
        const signals = Array.isArray(result.data) ? result.data.slice(0, 8) : result.data?.data?.slice(0, 8) || [];
        if (signals.length === 0) {
          await bot.sendMessage(chatId, `No ${label} signals on ${chainLabel} right now.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxsig:${sigType}:chain:${chain}` }], [{ text: "« Back", callback_data: "action:okxsignals" }]] } });
        } else {
          let text = `${label} *Buy Signals — ${chainLabel}*\n\n`;
          const buyButtons: Array<Array<{ text: string; callback_data: string }>> = [];
          const chainObj = OKX_CHAINS.find(c => c.id === chain);
          const nativeSym = chainObj?.symbol || "Native";
          signals.forEach((s: any, i: number) => {
            const tok = s.token || {};
            const name = tok.symbol || tok.name || s.tokenSymbol || s.symbol || "Unknown";
            const addr = tok.tokenAddress || s.tokenAddress || s.address || "";
            const amount = s.amountUsd ? `$${parseFloat(s.amountUsd).toFixed(0)}` : s.amount || "";
            const wallets = s.triggerWalletCount || "";
            const sold = s.soldRatioPercent ? `${s.soldRatioPercent}% sold` : "";
            const mcap = tok.marketCapUsd ? `MCap $${parseFloat(tok.marketCapUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "";
            const extras = [wallets ? `${wallets} wallets` : "", sold, mcap].filter(Boolean).join(" | ");
            text += `${i + 1}. *${name}* — Buy: ${amount}\n`;
            if (addr) text += `\`${addr}\`\n`;
            if (extras) text += `   ${extras}\n`;
            text += "\n";
            if (addr) {
              buyButtons.push([
                { text: `⚡ Buy ${name}`, callback_data: `sigbuy:${i}:${chain}:${sigType}` },
                { text: `🔒 Scan`, callback_data: `sigscan:${i}:${chain}:${sigType}` },
              ]);
            }
          });

          const sigCacheKey = `sig_${chatId}_${chain}_${sigType}`;
          (globalThis as any).__signalCache = (globalThis as any).__signalCache || {};
          (globalThis as any).__signalCache[sigCacheKey] = signals.map((s: any) => {
            const tok = s.token || {};
            return {
              symbol: tok.symbol || tok.name || s.tokenSymbol || s.symbol || "Unknown",
              address: tok.tokenAddress || s.tokenAddress || s.address || "",
            };
          });

          const buttons = [
            ...buyButtons,
            [{ text: "🔄 Refresh", callback_data: `okxsig:${sigType}:chain:${chain}` }],
            [{ text: "« Back", callback_data: "action:okxsignals" }, { text: "« Menu", callback_data: "action:menu" }],
          ];
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });

          const topSignals = signals.slice(0, 4).map((s: any, i: number) => {
            const tok = s.token || {};
            const name = tok.symbol || tok.name || s.tokenSymbol || "Unknown";
            const mcap = tok.marketCapUsd ? `MCap $${parseFloat(tok.marketCapUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "";
            const amount = s.amountUsd ? `$${parseFloat(s.amountUsd).toFixed(0)}` : "";
            return `${i + 1}. ${name} — Buy: ${amount} ${mcap}`;
          }).join("\n");
          agentAnalyze(chatId, `${label} signals on ${chainLabel}:\n${topSignals}`, "Which of these signals looks most promising and why? Pick the top 1-2.").then(analysis => {
            if (analysis && bot) {
              bot.sendMessage(chatId, analysis, { parse_mode: "Markdown" }).catch(() => {});
            }
          }).catch(() => {});
        }
      } else {
        await bot.sendMessage(chatId, `${label} signals unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxsignals" }]] } });
    }
    return;
  }

  if (data.startsWith("sigbuy:") && !data.startsWith("sigbuy_")) {
    const parts = data.replace("sigbuy:", "").split(":");
    const sigIndex = parseInt(parts[0]);
    const sigChain = parts[1];
    const sigTypeFromCb = parts[2] || "";

    const chainObj = OKX_CHAINS.find(c => c.id === sigChain);
    const nativeSym = chainObj?.symbol || "Native";
    const chainLabel = chainObj?.name || sigChain;

    const cache = (globalThis as any).__signalCache || {};
    const exactKey = `sig_${chatId}_${sigChain}_${sigTypeFromCb}`;
    let tokenInfo: { symbol: string; address: string } | null = null;
    if (cache[exactKey] && cache[exactKey][sigIndex]) {
      tokenInfo = cache[exactKey][sigIndex];
    }

    if (!tokenInfo || !tokenInfo.address) {
      await bot.sendMessage(chatId, "Signal expired. Please refresh signals and try again.", { reply_markup: { inline_keyboard: [[{ text: "🐋 Signals", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }

    pendingSignalBuy.set(chatId, {
      chainId: sigChain,
      chainName: chainLabel,
      tokenAddress: tokenInfo.address,
      tokenSymbol: tokenInfo.symbol,
      nativeSymbol: nativeSym,
      sigType: sigTypeFromCb,
      sigIndex: sigIndex,
    });

    const amounts = sigChain === "1"
      ? [{ label: "0.01 ETH", val: "0.01" }, { label: "0.05 ETH", val: "0.05" }, { label: "0.1 ETH", val: "0.1" }]
      : sigChain === "56"
      ? [{ label: "0.05 BNB", val: "0.05" }, { label: "0.1 BNB", val: "0.1" }, { label: "0.5 BNB", val: "0.5" }, { label: "1 BNB", val: "1" }]
      : sigChain === "501"
      ? [{ label: "0.1 SOL", val: "0.1" }, { label: "0.25 SOL", val: "0.25" }, { label: "0.5 SOL", val: "0.5" }, { label: "1 SOL", val: "1" }]
      : [{ label: `0.01 ${nativeSym}`, val: "0.01" }, { label: `0.05 ${nativeSym}`, val: "0.05" }, { label: `0.1 ${nativeSym}`, val: "0.1" }, { label: `0.5 ${nativeSym}`, val: "0.5" }];

    await bot.sendMessage(chatId,
      `⚡ *Instant Buy — ${tokenInfo.symbol}*\n\n` +
      `Chain: ${chainLabel}\n` +
      `Token: \`${tokenInfo.address}\`\n\n` +
      `Select amount of ${nativeSym} to spend:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            ...amounts.map(a => [{ text: a.label, callback_data: `sigbuy_amt:${a.val}` }]),
            [{ text: "❌ Cancel", callback_data: "action:okxsignals" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("sigbuy_amt:")) {
    const amount = data.replace("sigbuy_amt:", "");
    const state = pendingSignalBuy.get(chatId);
    if (!state) {
      await bot.sendMessage(chatId, "Session expired. Please select a signal again.", { reply_markup: { inline_keyboard: [[{ text: "🐋 Signals", callback_data: "action:okxsignals" }]] } });
      return;
    }
    state.amount = amount;
    pendingSignalBuy.set(chatId, state);

    await bot.sendMessage(chatId,
      `⚡ *Confirm Buy*\n\n` +
      `🪙 Token: *${state.tokenSymbol}*\n` +
      `⛓ Chain: ${state.chainName}\n` +
      `💰 Spend: *${amount} ${state.nativeSymbol}*\n` +
      `📋 Address: \`${state.tokenAddress}\`\n\n` +
      `Proceed with this swap?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Buy", callback_data: "sigbuy_confirm" }],
            [{ text: "💰 Change Amount", callback_data: `sigbuy:${state.sigIndex}:${state.chainId}:${state.sigType}` }],
            [{ text: "❌ Cancel", callback_data: "action:okxsignals" }],
          ],
        },
      }
    );
    return;
  }

  if (data === "sigbuy_confirm") {
    const state = pendingSignalBuy.get(chatId);
    if (!state || !state.amount) {
      await bot.sendMessage(chatId, "Buy session expired. Start again from signals.", { reply_markup: { inline_keyboard: [[{ text: "🐋 Signals", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }

    const isSolana = state.chainId === "501";

    if (isSolana) {
      const solWallet = await getOrCreateSolanaWallet(chatId);
      if (!solWallet || !solWallet.privateKey) {
        await bot.sendMessage(chatId, "You need a Solana wallet to buy on Solana. Generating one now...");
        const newWallet = await getOrCreateSolanaWallet(chatId);
        if (!newWallet) {
          await bot.sendMessage(chatId, "Failed to create Solana wallet. Please try again.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
          pendingSignalBuy.delete(chatId);
          return;
        }
      }

      await bot.sendMessage(chatId, `⏳ Executing buy: ${state.amount} SOL → ${state.tokenSymbol} on Solana...`);
      sendTyping(chatId);

      try {
        const { Connection, Keypair, VersionedTransaction, Transaction: LegacyTransaction } = await import("@solana/web3.js");
        const LAMPORTS_PER_SOL = 1_000_000_000;
        const rawAmount = Math.round(parseFloat(state.amount) * LAMPORTS_PER_SOL).toString();

        const { getSwapData } = await import("./okx-onchainos");
        const swapResult = await getSwapData({
          chainId: "501",
          fromTokenAddress: SOLANA_NATIVE_TOKEN,
          toTokenAddress: state.tokenAddress,
          amount: rawAmount,
          slippage: "30",
          userWalletAddress: solWallet.address,
        });

        const txData = swapResult?.data?.[0]?.tx;
        if (!txData) throw new Error("No swap route found for this token. It may have low liquidity.");

        const { ComputeBudgetProgram, SystemProgram, PublicKey, TransactionMessage, AddressLookupTableAccount } = await import("@solana/web3.js");
        const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
        const secretKey = Uint8Array.from(Buffer.from(solWallet.privateKey, "hex"));
        const keypair = Keypair.fromSecretKey(secretKey);

        const PRIORITY_FEE_LAMPORTS = 9_000_000;
        const JITO_TIP_LAMPORTS = 2_000_000;
        const JITO_TIP_ACCOUNTS = [
          "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
          "HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiKwkJbMj",
          "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
          "ADaUMid9yfUytqMBgopwjb2DTLSLxXCQkJbNLmZdvMKz",
          "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
          "ADuUkR4vqLUMWXxW9gh6D6L8pMSGA2w67v6C3mViyrj6",
          "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
          "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
        ];
        const randomTipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

        const rawTx = txData.data;
        if (!rawTx) throw new Error("No transaction data returned from DEX");

        const txBuf = Buffer.from(rawTx, "base64");
        let txHash: string;
        try {
          const vTx = VersionedTransaction.deserialize(txBuf);
          const msg = vTx.message;

          const lookupTableAccounts: AddressLookupTableAccount[] = [];
          if (msg.addressTableLookups && msg.addressTableLookups.length > 0) {
            for (const lookup of msg.addressTableLookups) {
              const accountInfo = await connection.getAddressLookupTable(lookup.accountKey);
              if (accountInfo.value) lookupTableAccounts.push(accountInfo.value);
            }
          }

          const decompiledMsg = TransactionMessage.decompile(msg, { addressLookupTableAccounts: lookupTableAccounts });

          const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_LAMPORTS });
          const jitoTipIx = SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: new PublicKey(randomTipAccount),
            lamports: JITO_TIP_LAMPORTS,
          });

          decompiledMsg.instructions = [priorityIx, ...decompiledMsg.instructions, jitoTipIx];
          decompiledMsg.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;

          const newMsg = decompiledMsg.compileToV0Message(lookupTableAccounts);
          const newTx = new VersionedTransaction(newMsg);
          newTx.sign([keypair]);
          txHash = await connection.sendTransaction(newTx, { skipPreflight: true, maxRetries: 3 });
        } catch (vErr: any) {
          const legacyTx = LegacyTransaction.from(txBuf);
          const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_LAMPORTS });
          const jitoTipIx = SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: new PublicKey(randomTipAccount),
            lamports: JITO_TIP_LAMPORTS,
          });
          legacyTx.instructions = [priorityIx, ...legacyTx.instructions, jitoTipIx];
          legacyTx.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
          legacyTx.sign(keypair);
          txHash = await connection.sendRawTransaction(legacyTx.serialize(), { skipPreflight: true });
        }

        const latestBlockhash = await connection.getLatestBlockhash("finalized");
        await connection.confirmTransaction({ signature: txHash, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight }, "confirmed");

        pendingSignalBuy.delete(chatId);
        await bot.sendMessage(chatId,
          `✅ *Buy Executed!*\n\n` +
          `⚡ ${state.amount} SOL → ${state.tokenSymbol}\n` +
          `⛓ Solana\n\n` +
          `[View Transaction](https://solscan.io/tx/${txHash})`,
          {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [
                [{ text: "🐋 More Signals", callback_data: "action:okxsignals" }],
                [{ text: "👛 Wallet", callback_data: "action:wallet" }, { text: "« Menu", callback_data: "action:menu" }],
              ],
            },
          }
        );
      } catch (e: any) {
        await bot.sendMessage(chatId,
          `❌ Buy failed: ${e.message?.substring(0, 150)}\n\nCheck your SOL balance and try again.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Retry", callback_data: "sigbuy_confirm" }],
                [{ text: "🐋 Signals", callback_data: "action:okxsignals" }, { text: "« Menu", callback_data: "action:menu" }],
              ],
            },
          }
        );
      }
      return;
    }

    const walletAddr = getLinkedWallet(chatId);
    if (!walletAddr || !await checkWalletHasKey(chatId, walletAddr)) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to buy. Use /wallet to set one up.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      pendingSignalBuy.delete(chatId);
      return;
    }

    await bot.sendMessage(chatId, `⏳ Executing buy: ${state.amount} ${state.nativeSymbol} → ${state.tokenSymbol} on ${state.chainName}...`);
    sendTyping(chatId);

    try {
      const { ethers } = await import("ethers");
      const nativeToken = OKX_NATIVE_TOKEN;
      const decimals = 18;
      const rawAmount = ethers.parseUnits(state.amount, decimals).toString();

      const { getSwapData } = await import("./okx-onchainos");
      const swapTx = await getSwapData({
        chainId: state.chainId,
        fromTokenAddress: nativeToken,
        toTokenAddress: state.tokenAddress,
        amount: rawAmount,
        slippage: "1",
        userWalletAddress: walletAddr,
      });

      const txData = swapTx?.data?.[0]?.tx;
      if (!txData) throw new Error("No swap route found for this token. It may have low liquidity.");

      let pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), walletAddr);
      if (!pk) pk = await storage.getPrivateKeyByWalletAddress(walletAddr);
      if (!pk) throw new Error("Private key not found. Generate a new wallet or re-import your key via /wallet.");

      const CHAIN_RPCS: Record<string, string> = {
        "56": "https://bsc-dataseed1.binance.org", "1": "https://eth.llamarpc.com",
        "8453": "https://mainnet.base.org", "42161": "https://arb1.arbitrum.io/rpc",
        "137": "https://polygon-rpc.com", "10": "https://mainnet.optimism.io",
        "43114": "https://api.avax.network/ext/bc/C/rpc", "196": "https://rpc.xlayer.tech",
        "250": "https://rpc.ftm.tools", "5000": "https://rpc.mantle.xyz",
      };
      const rpcUrl = CHAIN_RPCS[state.chainId] || "https://bsc-dataseed1.binance.org";
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(pk, provider);

      const tx = await wallet.sendTransaction({
        to: txData.to,
        data: txData.data,
        value: txData.value ? BigInt(txData.value) : 0n,
        gasLimit: txData.gasLimit ? BigInt(txData.gasLimit) : undefined,
      });

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");

      const explorerUrls: Record<string, string> = {
        "56": "https://bscscan.com/tx/", "1": "https://etherscan.io/tx/",
        "8453": "https://basescan.org/tx/", "42161": "https://arbiscan.io/tx/",
        "137": "https://polygonscan.com/tx/", "10": "https://optimistic.etherscan.io/tx/",
        "43114": "https://snowtrace.io/tx/", "196": "https://www.okx.com/explorer/xlayer/tx/",
      };
      const explorer = explorerUrls[state.chainId] || "https://bscscan.com/tx/";

      pendingSignalBuy.delete(chatId);
      await bot.sendMessage(chatId,
        `✅ *Buy Executed!*\n\n` +
        `⚡ ${state.amount} ${state.nativeSymbol} → ${state.tokenSymbol}\n` +
        `⛓ ${state.chainName}\n\n` +
        `[View Transaction](${explorer}${receipt.hash})`,
        {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🐋 More Signals", callback_data: "action:okxsignals" }],
              [{ text: "👛 Wallet", callback_data: "action:wallet" }, { text: "« Menu", callback_data: "action:menu" }],
            ],
          },
        }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `❌ Buy failed: ${e.message?.substring(0, 150)}\n\nCheck your ${state.nativeSymbol} balance and try again.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Retry", callback_data: "sigbuy_confirm" }],
              [{ text: "🐋 Signals", callback_data: "action:okxsignals" }, { text: "« Menu", callback_data: "action:menu" }],
            ],
          },
        }
      );
    }
    return;
  }

  if (data.startsWith("stealth:")) {
    const tokenShort = data.split(":")[1];
    const fullToken = pendingStealthToken.get(chatId);
    if (!fullToken) {
      await bot.sendMessage(chatId, "⚠️ Stealth buy session expired. Launch a new token first.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }

    const walletAddr = getLinkedWallet(chatId);
    if (!walletAddr || !await checkWalletHasKey(chatId, walletAddr)) {
      await bot.sendMessage(chatId, "❌ You need a wallet with a private key for stealth buy.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }]] } });
      return;
    }

    pendingStealthEth.set(chatId, { tokenAddress: fullToken, step: "amount" });
    await bot.sendMessage(chatId,
      `🥷 *Stealth Buy Setup*\n\n` +
      `Token: \`${fullToken}\`\n` +
      `Chain: Base\n\n` +
      `This will:\n` +
      `1️⃣ Buy 70% of the curve from your main wallet\n` +
      `2️⃣ Generate 20 fresh wallets\n` +
      `3️⃣ Fund each wallet with ETH from your main wallet\n` +
      `4️⃣ All 20 wallets buy simultaneously (10% total)\n\n` +
      `*How much total ETH do you want to spend?*\n` +
      `(70% goes to main buy, 30% split across 20 stealth wallets)\n\n` +
      `Example: Send \`10\` for 10 ETH total (7 ETH main + 3 ETH stealth)`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data.startsWith("consolidate:")) {
    const wallets = stealthWalletStore.get(chatId);
    const tokenAddr = pendingStealthToken.get(chatId);
    const walletAddr = getLinkedWallet(chatId);
    if (!wallets || !tokenAddr || !walletAddr) {
      await bot.sendMessage(chatId, "No stealth wallets to consolidate.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }

    await bot.sendMessage(chatId, `🔄 Consolidating tokens from ${wallets.length} stealth wallets → your main wallet...\n\nThis may take a minute.`);
    sendTyping(chatId);

    try {
      const { consolidateTokens, drainEthFromStealthWallets } = await import("./stealth-buy");
      const result = await consolidateTokens(wallets, tokenAddr, walletAddr);
      const drainResult = await drainEthFromStealthWallets(wallets, walletAddr);

      await bot.sendMessage(chatId,
        `✅ *Consolidation Complete*\n\n` +
        `Tokens moved: ${result.consolidated}/${wallets.length} wallets\n` +
        `ETH recovered: ${drainResult.drained} wallets\n` +
        `${result.errors.length > 0 ? `\n⚠️ Errors: ${result.errors.length}` : ""}\n\n` +
        `All tokens are now in your main wallet.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
      );

      stealthWalletStore.delete(chatId);
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Consolidation error: ${e.message?.substring(0, 150)}`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "consolidate:retry" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  if (data.startsWith("cabuy:")) {
    const parts = data.split(":");
    const tokenAddr = parts[1];
    const chainId = parts[2];
    const amount = parts[3];
    if (!tokenAddr || !chainId || !amount) return;

    const isSolana = chainId === "501";
    const nativeSymbol = isSolana ? "SOL" : chainId === "8453" ? "ETH" : "BNB";
    const chainName = isSolana ? "Solana" : chainId === "8453" ? "Base" : "BNB Chain";

    if (isSolana) {
      const solWallet = solanaWalletMap.get(chatId);
      if (!solWallet) {
        await bot.sendMessage(chatId, "❌ You need a Solana wallet first.", { reply_markup: { inline_keyboard: [[{ text: "🟣 Generate SOL Wallet", callback_data: "action:gensolwallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        return;
      }
      pendingSignalBuy.set(chatId, {
        tokenAddress: tokenAddr,
        tokenSymbol: "Token",
        chainId,
        chainName,
        nativeSymbol,
        amount,
        step: "confirm",
      });
      await bot.sendMessage(chatId,
        `⚡ *Instant Buy*\n\n` +
        `Buy ${amount} ${nativeSymbol} → Token\n` +
        `Chain: ${chainName}\n` +
        `CA: \`${tokenAddr}\`\n\n` +
        `Confirm purchase:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: `✅ Buy ${amount} ${nativeSymbol}`, callback_data: "sigbuy_confirm" }],
          [{ text: "❌ Cancel", callback_data: "action:menu" }],
        ]}}
      );
    } else {
      const walletAddr = getLinkedWallet(chatId);
      if (!walletAddr) {
        await bot.sendMessage(chatId, "❌ You need a wallet first.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        return;
      }
      pendingSignalBuy.set(chatId, {
        tokenAddress: tokenAddr,
        tokenSymbol: "Token",
        chainId,
        chainName,
        nativeSymbol,
        amount,
        step: "confirm",
      });
      await bot.sendMessage(chatId,
        `⚡ *Instant Buy*\n\n` +
        `Buy ${amount} ${nativeSymbol} → Token\n` +
        `Chain: ${chainName}\n` +
        `CA: \`${tokenAddr}\`\n\n` +
        `Confirm purchase:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: `✅ Buy ${amount} ${nativeSymbol}`, callback_data: "sigbuy_confirm" }],
          [{ text: "❌ Cancel", callback_data: "action:menu" }],
        ]}}
      );
    }
    return;
  }

  if (data.startsWith("cascan:")) {
    const parts = data.split(":");
    const tokenAddr = parts[1];
    const chainId = parts[2];
    await bot.sendMessage(chatId, `🔒 Scanning token \`${tokenAddr.substring(0, 12)}...\``, { parse_mode: "Markdown" });
    sendTyping(chatId);
    try {
      const { securityTokenScanAPI, getTokenInfoAPI } = await import("./okx-onchainos");
      const [result, tokenInfoRes] = await Promise.all([
        securityTokenScanAPI(tokenAddr, chainId),
        getTokenInfoAPI(tokenAddr, chainId).catch(() => ({ success: false, data: null })),
      ]);
      const d = result?.data;
      const ti = tokenInfoRes?.data;
      if (d && result.success) {
        const tokenName = d.tokenName || ti?.tokenName || null;
        const tokenSymbol = d.tokenSymbol || ti?.tokenSymbol || null;
        let report = `🔒 *Security Report*\n\n`;
        if (tokenName) report += `Token: *${tokenName}*${tokenSymbol && tokenSymbol !== tokenName ? ` (${tokenSymbol})` : ""}\n`;
        report += `Address: \`${tokenAddr}\`\n\n`;

        const displayRisks: string[] = [];
        if (d.isHoneypot) displayRisks.push("🚨 HONEYPOT DETECTED");
        if (!d.isOpenSource) displayRisks.push("⚠️ Not open source");
        if (d.isProxy) displayRisks.push("⚠️ Proxy contract (upgradeable)");
        if (d.ownerCanMint) displayRisks.push("⚠️ Owner can mint tokens");
        if (d.canTakeBackOwnership) displayRisks.push("⚠️ Owner can reclaim ownership");
        if (d.ownerChangeBalance) displayRisks.push("🚨 Owner can change balances");
        if (d.risks && d.risks.length > 0) {
          d.risks.forEach((r: string) => {
            if (!displayRisks.some(dr => dr.includes(r))) displayRisks.push(`⚠️ ${r}`);
          });
        }
        if (d.buyTax && parseFloat(d.buyTax) > 5) displayRisks.push(`⚠️ Buy tax: ${d.buyTax}%`);
        if (d.sellTax && parseFloat(d.sellTax) > 5) displayRisks.push(`⚠️ Sell tax: ${d.sellTax}%`);

        if (displayRisks.length === 0) {
          report += `✅ *No major risks detected*\n`;
        } else {
          report += displayRisks.slice(0, 10).join("\n") + "\n";
        }
        report += `\nRisk: ${d.riskLevel === "high" ? "🔴 HIGH" : d.riskLevel === "medium" ? "🟡 MEDIUM" : "🟢 LOW"}`;
        if (d.holderCount) report += ` | Holders: ${d.holderCount.toLocaleString()}`;
        report += `\nSource: ${d.source || "GoPlus"}`;

        await bot.sendMessage(chatId, report, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "⚡ Buy Anyway", callback_data: `cabuy:${tokenAddr}:${chainId}:0.05` }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ]}});

        const scanContext = `Token: ${tokenName || tokenAddr}\nRisk Level: ${d.riskLevel}\nHoneypot: ${d.isHoneypot ? "YES" : "No"}\nBuy Tax: ${d.buyTax || "0"}%\nSell Tax: ${d.sellTax || "0"}%\nHolders: ${d.holderCount || "Unknown"}\nRisks: ${displayRisks.join(", ") || "None"}`;
        agentAnalyze(chatId, scanContext, "Should I buy this token? Give a brief risk assessment and recommendation.").then(analysis => {
          if (analysis && bot) {
            bot.sendMessage(chatId, analysis, { parse_mode: "Markdown" }).catch(() => {});
          }
        }).catch(() => {});
      } else {
        await bot.sendMessage(chatId, "⚠️ Security data not available for this token.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Scan failed: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  if (data.startsWith("cachart:")) {
    const parts = data.split(":");
    const tokenAddr = parts[1];
    const chainId = parts[2];
    const chartUrls: Record<string, string> = {
      "56": `https://dexscreener.com/bsc/${tokenAddr}`,
      "1": `https://dexscreener.com/ethereum/${tokenAddr}`,
      "8453": `https://dexscreener.com/base/${tokenAddr}`,
      "501": `https://dexscreener.com/solana/${tokenAddr}`,
      "137": `https://dexscreener.com/polygon/${tokenAddr}`,
      "42161": `https://dexscreener.com/arbitrum/${tokenAddr}`,
    };
    const chartUrl = chartUrls[chainId] || `https://dexscreener.com/bsc/${tokenAddr}`;
    await bot.sendMessage(chatId,
      `📊 [View Chart on DexScreener](${chartUrl})`,
      { parse_mode: "Markdown", disable_web_page_preview: false, reply_markup: { inline_keyboard: [
        [{ text: "⚡ Buy", callback_data: `cabuy:${tokenAddr}:${chainId}:0.05` }],
        [{ text: "« Menu", callback_data: "action:menu" }],
      ]}}
    );
    return;
  }

  if (data.startsWith("carefresh:")) {
    const parts = data.split(":");
    const tokenAddr = parts[1];
    const chainId = parts[2];
    if (tokenAddr && chainId) {
      pendingOKXScan.delete(chatId);
      pendingOKXPrice.delete(chatId);
      const fakeMsg = { chat: { id: chatId }, from: msg?.from, text: tokenAddr, message_id: msg?.message?.message_id } as any;
      bot.emit("message", fakeMsg);
    }
    return;
  }

  if (data === "action:okxsecurity") {
    await bot.sendMessage(chatId,
      "🔒 *Security Scanner*\n\nScan a token for honeypot risks, rug-pull indicators, and contract safety.\n\nSelect chain:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "BNB Chain", callback_data: "okxscan_chain:56" }, { text: "Ethereum", callback_data: "okxscan_chain:1" }],
            [{ text: "Base", callback_data: "okxscan_chain:8453" }, { text: "XLayer", callback_data: "okxscan_chain:196" }],
            [{ text: "Solana", callback_data: "okxscan_chain:501" }, { text: "Polygon", callback_data: "okxscan_chain:137" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("sigscan:")) {
    const parts = data.replace("sigscan:", "").split(":");
    const sigIdx = parseInt(parts[0]);
    const scanChain = parts[1];
    const sigType = parts[2] || "smart_money";
    const sigCacheKey = `sig_${chatId}_${scanChain}_${sigType}`;
    const cache = (globalThis as any).__signalCache || {};
    const items = cache[sigCacheKey] || [];
    const token = items[sigIdx];
    if (!token || !token.address) {
      await bot.sendMessage(chatId, "Token not found. Signals may have expired — tap Refresh.", { reply_markup: { inline_keyboard: [[{ text: "🐋 Signals", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    const resolvedAddr = token.address;
    const tokenName = token.symbol || "token";
    await bot.sendMessage(chatId, `🔒 Scanning *${tokenName}* \`${resolvedAddr.substring(0, 12)}...\` for risks...`, { parse_mode: "Markdown" });
    try {
      const result = await executeSecurityScan(resolvedAddr, scanChain);
      if (result.success && result.data) {
        const d = result.data;
        let scanText = `🔒 *Security Scan: ${d.tokenSymbol || d.tokenName || tokenName}*\n\n`;
        scanText += `Address:\n\`${resolvedAddr}\`\n\n`;
        if (d.isHoneypot !== undefined) scanText += `🍯 Honeypot: ${d.isHoneypot ? "⚠️ *YES — DO NOT BUY*" : "✅ No"}\n`;
        if (d.riskLevel) scanText += `⚡ Risk: ${d.riskLevel === "high" ? "🔴 HIGH" : d.riskLevel === "medium" ? "🟡 MEDIUM" : d.riskLevel === "low" ? "🟢 LOW" : "⚪ Unknown"}\n`;
        if (d.buyTax !== undefined) scanText += `📥 Buy Tax: ${d.buyTax}%\n`;
        if (d.sellTax !== undefined) scanText += `📤 Sell Tax: ${d.sellTax}%\n`;
        if (d.isOpenSource !== undefined) scanText += `📄 Open Source: ${d.isOpenSource ? "✅ Yes" : "❌ No"}\n`;
        if (d.isProxy !== undefined) scanText += `🔀 Proxy: ${d.isProxy ? "⚠️ Yes" : "✅ No"}\n`;
        if (d.ownerCanMint !== undefined) scanText += `🖨️ Can Mint: ${d.ownerCanMint ? "⚠️ Yes" : "✅ No"}\n`;
        if (d.freezeAuthority !== undefined) scanText += `❄️ Freeze Auth: ${d.freezeAuthority ? "⚠️ Active" : "✅ None"}\n`;
        if (d.holderCount) scanText += `👥 Holders: ${d.holderCount.toLocaleString()}\n`;
        if (d.lpHolderCount) scanText += `💧 LP Holders: ${d.lpHolderCount}\n`;
        if (d.liquidity) scanText += `💰 Liquidity: $${(d.liquidity / 1e6 >= 1 ? (d.liquidity / 1e6).toFixed(2) + "M" : (d.liquidity / 1e3).toFixed(0) + "K")}\n`;
        if (d.risks && d.risks.length > 0) {
          scanText += `\n⚠️ *Risks Found:*\n`;
          d.risks.slice(0, 8).forEach((r: string) => { scanText += `• ${r}\n`; });
        } else if (d.riskLevel === "low") {
          scanText += `\n✅ No major risks detected\n`;
        }
        if (d.source) scanText += `\n_Source: ${d.source}_`;
        await bot.sendMessage(chatId, scanText, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: `⚡ Buy ${tokenName}`, callback_data: `sigbuy:${sigIdx}:${scanChain}:${sigType}` }], [{ text: "🐋 Back to Signals", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, `Scan failed: ${result.error || "Could not retrieve security data for this token"}`, { reply_markup: { inline_keyboard: [[{ text: "🐋 Signals", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Scan error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "🐋 Signals", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  if (data.startsWith("okxscan:") && !data.startsWith("okxscan_")) {
    const parts = data.replace("okxscan:", "").split(":");
    const scanChain = parts[0];
    const scanAddr = parts[1];
    if (!scanAddr) {
      pendingOKXScan.set(chatId, { step: "address", chain: scanChain });
      await bot.sendMessage(chatId, "Enter the token contract address to scan:");
      return;
    }

    const fullAddr = scanAddr;
    const cache = (globalThis as any).__signalCache || {};
    const cacheKeys = Object.keys(cache).filter(k => k.includes(`_${chatId}_${scanChain}_`));
    let resolvedAddr = fullAddr;
    for (const key of cacheKeys) {
      const items = cache[key] || [];
      const match = items.find((t: any) => t.address && t.address.startsWith(fullAddr));
      if (match) { resolvedAddr = match.address; break; }
    }

    await bot.sendMessage(chatId, `🔒 Scanning \`${resolvedAddr.substring(0, 12)}...\` for risks...`, { parse_mode: "Markdown" });
    try {
      const result = await executeSecurityScan(resolvedAddr, scanChain);
      if (result.success && result.data) {
        const d = result.data;
        let scanText = "🔒 *Security Scan Results*\n\n";
        scanText += `Address:\n\`${resolvedAddr}\`\n\n`;
        if (d.isHoneypot !== undefined) scanText += `🍯 Honeypot: ${d.isHoneypot ? "⚠️ *YES — DO NOT BUY*" : "✅ No"}\n`;
        if (d.riskLevel) scanText += `⚡ Risk: ${d.riskLevel === "high" ? "🔴 HIGH" : d.riskLevel === "medium" ? "🟡 MEDIUM" : d.riskLevel === "low" ? "🟢 LOW" : "⚪ Unknown"}\n`;
        if (d.buyTax !== undefined) scanText += `📥 Buy Tax: ${d.buyTax}%\n`;
        if (d.sellTax !== undefined) scanText += `📤 Sell Tax: ${d.sellTax}%\n`;
        if (d.isOpenSource !== undefined) scanText += `📄 Open Source: ${d.isOpenSource ? "✅ Yes" : "❌ No"}\n`;
        if (d.isProxy !== undefined) scanText += `🔀 Proxy: ${d.isProxy ? "⚠️ Yes" : "✅ No"}\n`;
        if (d.ownerCanMint !== undefined) scanText += `🖨️ Can Mint: ${d.ownerCanMint ? "⚠️ Yes" : "✅ No"}\n`;
        if (d.freezeAuthority !== undefined) scanText += `❄️ Freeze Auth: ${d.freezeAuthority ? "⚠️ Active" : "✅ None"}\n`;
        if (d.holderCount) scanText += `👥 Holders: ${d.holderCount.toLocaleString()}\n`;
        if (d.liquidity) scanText += `💰 Liquidity: $${(d.liquidity / 1e6 >= 1 ? (d.liquidity / 1e6).toFixed(2) + "M" : (d.liquidity / 1e3).toFixed(0) + "K")}\n`;
        if (d.risks && d.risks.length > 0) {
          scanText += `\n⚠️ *Risks Found:*\n`;
          d.risks.slice(0, 8).forEach((r: string) => { scanText += `• ${r}\n`; });
        } else if (d.riskLevel === "low") {
          scanText += `\n✅ No major risks detected\n`;
        }
        if (d.source) scanText += `\n_Source: ${d.source}_`;
        await bot.sendMessage(chatId, scanText, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🐋 Back to Signals", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, `Scan failed: ${result.error || "try again"}`, { reply_markup: { inline_keyboard: [[{ text: "🐋 Signals", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Scan error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "🐋 Signals", callback_data: "action:okxsignals" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  if (data.startsWith("okxscan_chain:")) {
    const chain = data.replace("okxscan_chain:", "");
    pendingOKXScan.set(chatId, { step: "address", chain });
    pendingOKXPrice.delete(chatId);
    await bot.sendMessage(chatId, "Enter the token contract address to scan (0x...):");
    return;
  }

  if (data === "action:okxtrending") {
    await bot.sendMessage(chatId,
      "🔥 *Trending & Hot Tokens*\n\nSelect view:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔥 Hot by Volume", callback_data: "okxtrend:hot:5" }],
            [{ text: "📈 Price Movers", callback_data: "okxtrend:hot:2" }],
            [{ text: "💎 By Market Cap", callback_data: "okxtrend:hot:6" }],
            [{ text: "🌊 Trending (Solana)", callback_data: "okxtrend:chain:501" }],
            [{ text: "🌊 Trending (BNB)", callback_data: "okxtrend:chain:56" }],
            [{ text: "🌊 Trending (Base)", callback_data: "okxtrend:chain:8453" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxtrend:hot:")) {
    const rankingType = data.replace("okxtrend:hot:", "");
    const labelMap: Record<string, string> = { "2": "📈 Price Movers", "5": "🔥 Hot by Volume", "6": "💎 By Market Cap" };
    const label = labelMap[rankingType] || "Hot Tokens";
    await bot.sendMessage(chatId, `Loading ${label}...`);
    try {
      const result = await getHotTokens(rankingType);
      if (result.success && result.data) {
        const tokens = Array.isArray(result.data) ? result.data.slice(0, 10) : result.data?.data?.slice(0, 10) || [];
        if (tokens.length === 0) {
          await bot.sendMessage(chatId, "No data available.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
        } else {
          let text = `${label}\n\n`;
          tokens.forEach((t: any, i: number) => {
            const name = t.tokenSymbol || t.symbol || "Unknown";
            const addr = t.tokenContractAddress || t.tokenAddress || t.address || "";
            const price = t.price ? `$${parseFloat(t.price) < 0.01 ? parseFloat(t.price).toExponential(2) : parseFloat(t.price).toFixed(4)}` : "";
            const change = t.change ?? t.priceChange24h ?? t.priceChange;
            const changeStr = change ? ` (${parseFloat(change) >= 0 ? "+" : ""}${parseFloat(change).toFixed(1)}%)` : "";
            const vol = t.volume || t.volume24h;
            const volStr = vol ? ` | Vol: $${(parseFloat(vol) / 1e6).toFixed(1)}M` : "";
            text += `${i + 1}. *${name}* — ${price}${changeStr}${volStr}\n`;
            if (addr) text += `\`${addr}\`\n`;
          });
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxtrend:hot:${rankingType}` }], [{ text: "« Back", callback_data: "action:okxtrending" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        }
      } else {
        await bot.sendMessage(chatId, `Unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
    }
    return;
  }

  if (data.startsWith("okxtrend:chain:")) {
    const chain = data.replace("okxtrend:chain:", "");
    const chainLabel = chain === "501" ? "Solana" : chain === "56" ? "BNB Chain" : chain === "8453" ? "Base" : chain;
    await bot.sendMessage(chatId, `Loading trending on ${chainLabel}...`);
    try {
      const result = await getTrendingTokens(chain);
      if (result.success && result.data) {
        const tokens = Array.isArray(result.data) ? result.data.slice(0, 10) : result.data?.data?.slice(0, 10) || [];
        if (tokens.length === 0) {
          await bot.sendMessage(chatId, `No trending tokens on ${chainLabel} right now.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
        } else {
          let text = `🌊 *Trending on ${chainLabel}*\n\n`;
          tokens.forEach((t: any, i: number) => {
            const name = t.tokenSymbol || t.symbol || "Unknown";
            const addr = t.tokenContractAddress || t.tokenAddress || t.address || "";
            const price = t.price ? `$${parseFloat(t.price) < 0.01 ? parseFloat(t.price).toExponential(2) : parseFloat(t.price).toFixed(4)}` : "";
            const change = t.change ?? t.priceChange24h ?? t.priceChange;
            const changeStr = change ? ` (${parseFloat(change) >= 0 ? "+" : ""}${parseFloat(change).toFixed(1)}%)` : "";
            const vol = t.volume || t.volume24h;
            const volStr = vol ? ` | Vol: $${(parseFloat(vol) / 1e6).toFixed(1)}M` : "";
            text += `${i + 1}. *${name}* — ${price}${changeStr}${volStr}\n`;
            if (addr) text += `\`${addr}\`\n`;
          });
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxtrend:chain:${chain}` }], [{ text: "« Back", callback_data: "action:okxtrending" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        }
      } else {
        await bot.sendMessage(chatId, `Unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxtrending" }]] } });
    }
    return;
  }

  if (data === "action:okxmeme") {
    await bot.sendMessage(chatId,
      "🐸 *Meme Token Scanner*\n\nScan new meme token launches for alpha.\n\nSelect chain:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Solana", callback_data: "okxmeme_chain:501" }, { text: "BNB Chain", callback_data: "okxmeme_chain:56" }],
            [{ text: "Base", callback_data: "okxmeme_chain:8453" }, { text: "Ethereum", callback_data: "okxmeme_chain:1" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxmeme_chain:")) {
    const chainId = data.replace("okxmeme_chain:", "");
    const chainName = OKX_CHAINS.find(c => c.id === chainId)?.name || chainId;
    await bot.sendMessage(chatId,
      `🐸 *Meme Scanner — ${chainName}*\n\nSelect filter:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🆕 New Launches", callback_data: `okxmeme:${chainId}:NEW` }],
            [{ text: "🔄 Migrating", callback_data: `okxmeme:${chainId}:MIGRATING` }],
            [{ text: "🎓 Migrated", callback_data: `okxmeme:${chainId}:MIGRATED` }],
            [{ text: "« Back", callback_data: "action:okxmeme" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxmeme:")) {
    const parts = data.replace("okxmeme:", "").split(":");
    const chainId = parts.length > 1 ? parts[0] : "501";
    const stage = parts.length > 1 ? parts[1] : parts[0];
    const chainName = OKX_CHAINS.find(c => c.id === chainId)?.name || chainId;
    const stageLabel = stage === "NEW" ? "🆕 New" : stage === "MIGRATED" ? "🎓 Migrated" : "🔄 Migrating";
    await bot.sendMessage(chatId, `Loading ${stageLabel} meme tokens on ${chainName}...`);
    try {
      const result = await getMemeTokens(chainId, stage);
      if (result.success && result.data) {
        const tokens = Array.isArray(result.data) ? result.data.slice(0, 8) : result.data?.data?.slice(0, 8) || [];
        if (tokens.length === 0) {
          await bot.sendMessage(chatId, `No ${stageLabel} tokens found.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxmeme" }]] } });
        } else {
          let text = `🐸 *Meme Tokens — ${stageLabel}*\n\n`;
          tokens.forEach((t: any, i: number) => {
            const name = t.symbol || t.tokenSymbol || t.name || "Unknown";
            const addr = t.tokenAddress || t.address || "";
            const mkt = t.market || {};
            const mcapVal = mkt.marketCapUsd || t.marketCap || "";
            const mcap = mcapVal ? `MC: $${(parseFloat(mcapVal) / 1e3).toFixed(0)}K` : "";
            const tags = t.tags || {};
            const holders = tags.totalHolders || t.holderCount || t.holders || "";
            const holdersStr = holders ? ` | ${holders} holders` : "";
            const bonding = t.bondingPercent ? ` | ${t.bondingPercent}% bonded` : "";
            const social = t.social || {};
            const hasX = social.x ? " 🐦" : "";
            const hasTg = social.telegram ? " 📱" : "";
            text += `${i + 1}. *${name}*${hasX}${hasTg}\n`;
            if (addr) text += `\`${addr}\`\n`;
            text += `   ${mcap}${holdersStr}${bonding}\n\n`;
          });
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxmeme:${chainId}:${stage}` }], [{ text: "« Back", callback_data: `okxmeme_chain:${chainId}` }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        }
      } else {
        await bot.sendMessage(chatId, `Unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxmeme" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxmeme" }]] } });
    }
    return;
  }

  if (data === "action:okxprice") {
    await bot.sendMessage(chatId,
      "📊 *Token Price Lookup*\n\nSelect chain, then enter the token address:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "BNB Chain", callback_data: "okxprice_chain:56" }, { text: "Ethereum", callback_data: "okxprice_chain:1" }],
            [{ text: "Base", callback_data: "okxprice_chain:8453" }, { text: "XLayer", callback_data: "okxprice_chain:196" }],
            [{ text: "Solana", callback_data: "okxprice_chain:501" }, { text: "Polygon", callback_data: "okxprice_chain:137" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxprice_chain:")) {
    const chain = data.replace("okxprice_chain:", "");
    pendingOKXPrice.set(chatId, { step: "address", chain });
    pendingOKXScan.delete(chatId);
    await bot.sendMessage(chatId, "Enter the token contract address (0x...):");
    return;
  }

  if (data === "action:okxgas") {
    await bot.sendMessage(chatId,
      "⛽ *Gas Prices*\n\nSelect chain:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "BNB Chain", callback_data: "okxgas:56" }, { text: "Ethereum", callback_data: "okxgas:1" }],
            [{ text: "Base", callback_data: "okxgas:8453" }, { text: "XLayer", callback_data: "okxgas:196" }],
            [{ text: "Polygon", callback_data: "okxgas:137" }, { text: "Arbitrum", callback_data: "okxgas:42161" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("okxgas:")) {
    const chain = data.replace("okxgas:", "");
    const chainNames: Record<string, string> = { "56": "BNB Chain", "1": "Ethereum", "8453": "Base", "196": "XLayer", "137": "Polygon", "42161": "Arbitrum" };
    const chainName = chainNames[chain] || chain;
    await bot.sendMessage(chatId, `Loading gas prices for ${chainName}...`);
    try {
      const result = await getGasPrice(chain);
      if (result.success && result.data) {
        const gas = result.data;
        let text = `⛽ *Gas Prices — ${chainName}*\n\n`;
        if (gas.gasPrice) text += `Gas Price: ${gas.gasPrice} Gwei\n`;
        if (gas.baseFee) text += `Base Fee: ${gas.baseFee} Gwei\n`;
        if (gas.priorityFee) text += `Priority Fee: ${gas.priorityFee} Gwei\n`;
        if (gas.slow) text += `🐢 Slow: ${gas.slow} Gwei\n`;
        if (gas.standard) text += `🚗 Standard: ${gas.standard} Gwei\n`;
        if (gas.fast) text += `🚀 Fast: ${gas.fast} Gwei\n`;
        if (gas.instant) text += `⚡ Instant: ${gas.instant} Gwei\n`;
        if (text.endsWith("\n\n")) text += "Gas data not available for this chain.";
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `okxgas:${chain}` }], [{ text: "« Back", callback_data: "action:okxgas" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, `Gas data unavailable: ${result.error || "try again later"}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxgas" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:okxgas" }]] } });
    }
    return;
  }

  if (data === "action:lang") {
    await bot.sendMessage(chatId, "🌐 Choose your language / 选择语言 / اختر لغتك：",
      { reply_markup: { inline_keyboard: [
        [{ text: "🇬🇧 English", callback_data: "setlang:en" }, { text: "🇨🇳 中文", callback_data: "setlang:zh" }, { text: "🇸🇦 العربية", callback_data: "setlang:ar" }],
      ]}}
    );
    return;
  }

  if (data.startsWith("setlang:")) {
    const lang = data.split(":")[1] as Lang;
    userLang.set(chatId, lang);
    await bot.sendMessage(chatId, tr("lang.set", chatId), {
      reply_markup: mainMenuKeyboard(undefined, chatId)
    });
    return;
  }

  if (data === "action:menu") {
    const menuText = getLang(chatId) === "zh" ? "请选择操作：" : "What would you like to do?";
    await bot.sendMessage(chatId, menuText, {
      reply_markup: mainMenuKeyboard(undefined, chatId)
    });
    return;
  }

  if (data.startsWith("model:")) {
    const state = pendingAgentCreation.get(chatId);
    if (!state || state.step !== "model") return;
    const modelId = data.split(":")[1];
    const modelMap: Record<string, string> = {
      "llama": "meta-llama/Llama-3.3-70B-Instruct",
      "deepseek": "deepseek-ai/DeepSeek-V3",
      "qwen": "Qwen/Qwen2.5-72B-Instruct",
    };
    const model = modelMap[modelId];
    if (!model) return;
    await createAgent(chatId, state.name!, state.bio || "", model, state.mandatory);
    return;
  }

  if (data.startsWith("taskagent:")) {
    const agentId = data.split(":")[1];
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      await bot.sendMessage(chatId, "Agent not found.");
      return;
    }
    await bot.sendMessage(chatId, `${agent.name} selected. What type of task?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Research", callback_data: `tasktype:${agentId}:research` }, { text: "Analysis", callback_data: `tasktype:${agentId}:analysis` }],
          [{ text: "Content", callback_data: `tasktype:${agentId}:content` }, { text: "Strategy", callback_data: `tasktype:${agentId}:strategy` }],
          [{ text: "Code Review", callback_data: `tasktype:${agentId}:code_review` }, { text: "General", callback_data: `tasktype:${agentId}:general` }],
          [{ text: "🚀 Launch Token", callback_data: `launchagent:${agentId}` }],
        ]
      }
    });
    return;
  }

  if (data.startsWith("tasktype:")) {
    const parts = data.split(":");
    const agentId = parts[1];
    const taskType = parts[2];
    const agent = await storage.getAgent(agentId);
    if (!agent) return;

    pendingAgentCreation.delete(chatId);
    pendingTask.set(chatId, { step: "describe", agentId, taskType, agentName: agent.name });

    const placeholders: Record<string, string> = {
      research: "Example: Analyze the current state of restaking on Ethereum — key protocols, TVL trends, risks.",
      analysis: "Example: Compare BNB Chain vs Base vs Solana DEX volume trends over the last 30 days.",
      content: "Example: Write a tweet thread explaining why autonomous AI agents are the next frontier in DeFi.",
      strategy: "Example: Create a go-to-market strategy for launching an AI agent marketplace.",
      code_review: "Example: Review this Solidity function for security issues and gas optimization.",
      general: "Example: Summarize the top 5 AI x Crypto developments this week.",
    };

    await bot.sendMessage(chatId,
      `${agent.name} | ${taskType}\n\nDescribe what you need. Just type it out:\n\n${placeholders[taskType] || ""}`,
    );
    return;
  }

  if (data.startsWith("viewtask:")) {
    const taskId = data.split(":")[1];
    if (wallet) await handleTaskStatus(chatId, taskId, wallet);
    return;
  }

  if (data.startsWith("agentask:")) {
    const agentId = data.split(":")[1];
    const agent = await storage.getAgent(agentId);
    if (agent) {
      pendingAgentQuestion.set(chatId, agentId);
      await bot.sendMessage(chatId, `💬 *Ask ${agent.name}*\n\nType your question — your agent will analyze it using decentralized AI.\n\nExamples:\n• "What's the best memecoin to buy right now?"\n• "Analyze BNB price action"\n• "What trading strategy should I use?"`, { parse_mode: "Markdown" });
    }
    return;
  }

  if (data.startsWith("agenttask:")) {
    const agentId = data.split(":")[1];
    const agent = await storage.getAgent(agentId);
    if (agent) {
      await bot.sendMessage(chatId, `What type of task for ${agent.name}?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Research", callback_data: `tasktype:${agentId}:research` }, { text: "Analysis", callback_data: `tasktype:${agentId}:analysis` }],
            [{ text: "Content", callback_data: `tasktype:${agentId}:content` }, { text: "Strategy", callback_data: `tasktype:${agentId}:strategy` }],
            [{ text: "Code Review", callback_data: `tasktype:${agentId}:code_review` }, { text: "General", callback_data: `tasktype:${agentId}:general` }],
            [{ text: "🚀 Launch Token", callback_data: `launchagent:${agentId}` }],
          ]
        }
      });
    }
    return;
  }

  if (data.startsWith("launchagent:")) {
    const agentId = data.split(":")[1];
    const agent = await storage.getAgent(agentId);
    if (!agent) { await bot.sendMessage(chatId, "Agent not found."); return; }

    pendingAgentCreation.delete(chatId);
    pendingTask.delete(chatId);
    pendingTokenLaunch.set(chatId, { step: "platform", agentId, agentName: agent.name });

    await bot.sendMessage(chatId,
      `🚀 Launch a token with ${agent.name}\n\nPick a launchpad:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Four.meme (BNB Chain)", callback_data: `launchplatform:${agentId}:four_meme` }],
            [{ text: "Flap.sh (BNB Chain)", callback_data: `launchplatform:${agentId}:flap_sh` }],
            [{ text: "XLayer (OKX)", callback_data: `launchplatform:${agentId}:xlayer` }],
            [{ text: "Bankr (Base/Solana)", callback_data: `launchplatform:${agentId}:bankr` }],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
    return;
  }

  if (data.startsWith("launchplatform:")) {
    const parts = data.split(":");
    const agentId = parts[1];
    const platform = parts[2];
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId) return;
    if (platform !== "four_meme" && platform !== "flap_sh" && platform !== "bankr" && platform !== "xlayer") {
      await bot.sendMessage(chatId, "Invalid platform. Please try again.");
      return;
    }

    state.platform = platform;

    if (platform === "bankr") {
      state.step = "bankr_chain";
      pendingTokenLaunch.set(chatId, state);
      await bot.sendMessage(chatId,
        `🏦 Bankr — Choose a chain for your token:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Base (EVM)", callback_data: `bankrchain:${agentId}:base` }],
              [{ text: "Solana", callback_data: `bankrchain:${agentId}:solana` }],
              [{ text: "Cancel", callback_data: "action:menu" }],
            ]
          }
        }
      );
      return;
    }

    state.step = "name";
    pendingTokenLaunch.set(chatId, state);

    const platformName = platform === "four_meme" ? "Four.meme (BNB Chain)" : platform === "xlayer" ? "XLayer (OKX)" : "Flap.sh (BNB Chain)";
    await bot.sendMessage(chatId,
      `Platform: ${platformName}\n\nWhat's the token name? (1-50 chars)\n\nExample: DogeBrain, MoonCat, AgentX`
    );
    return;
  }

  if (data.startsWith("bankrchain:")) {
    const parts = data.split(":");
    const agentId = parts[1];
    const chain = parts[2] as "base" | "solana";
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId || state.step !== "bankr_chain") return;

    state.bankrChain = chain;
    state.step = "name";
    pendingTokenLaunch.set(chatId, state);

    const chainLabel = chain === "solana" ? "Solana" : "Base";
    await bot.sendMessage(chatId,
      `Platform: Bankr (${chainLabel})\n\nWhat's the token name? (1-50 chars)\n\nExample: DogeBrain, MoonCat, AgentX`
    );
    return;
  }

  if (data.startsWith("launchconfirm:")) {
    const agentId = data.split(":")[1];
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId || !wallet) return;

    if (!state.platform || !state.tokenName || !state.tokenSymbol) {
      pendingTokenLaunch.delete(chatId);
      await bot.sendMessage(chatId, "Missing token details. Please start again.", {
        reply_markup: { inline_keyboard: [[{ text: "🚀 Launch Token", callback_data: "action:launchtoken" }]] }
      });
      return;
    }

    pendingTokenLaunch.delete(chatId);
    await executeTelegramTokenLaunch(chatId, wallet, state);
    return;
  }

  if (data.startsWith("launchcancel:")) {
    pendingTokenLaunch.delete(chatId);
    await bot.sendMessage(chatId, "Token launch cancelled.", {
      reply_markup: mainMenuKeyboard(undefined, chatId)
    });
    return;
  }

  if (data.startsWith("launchtax:")) {
    const taxVal = parseInt(data.split(":")[1], 10);
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.step !== "tax") return;
    state.taxRate = taxVal;
    showLaunchPreview(chatId, state);
    return;
  }

  if (data.startsWith("chaos_")) {
    await handleChaosPlanCallback(chatId, data);
    return;
  }

  if (data.startsWith("proposal_approve:")) {
    const proposalId = data.split(":")[1];
    await handleProposalApproval(chatId, proposalId, true);
    return;
  }

  if (data.startsWith("proposal_reject:")) {
    const proposalId = data.split(":")[1];
    await handleProposalApproval(chatId, proposalId, false);
    return;
  }

  if (data.startsWith("fmbuy:")) {
    const tokenAddress = data.split(":")[1];
    const wallet = getLinkedWallet(chatId);
    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "Import a wallet with a private key first (/linkwallet).");
      return;
    }
    pendingFourMemeBuy.set(chatId, { step: "amount", tokenAddress });
    await bot.sendMessage(chatId,
      `How much BNB do you want to spend?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "0.01 BNB", callback_data: `fmbuyamt:0.01:${tokenAddress}` },
              { text: "0.05 BNB", callback_data: `fmbuyamt:0.05:${tokenAddress}` },
              { text: "0.1 BNB", callback_data: `fmbuyamt:0.1:${tokenAddress}` },
            ],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
    return;
  }

  if (data.startsWith("fmbuyamt:")) {
    const parts = data.split(":");
    const amount = parts[1];
    const tokenAddress = parts[2];
    const state: FourMemeBuyState = { step: "amount", tokenAddress, bnbAmount: amount };
    pendingFourMemeBuy.set(chatId, state);
    await executeFourMemeBuyConfirm(chatId, state);
    return;
  }

  if (data.startsWith("fmbuyconfirm:")) {
    const tokenAddress = data.split(":")[1];
    const state = pendingFourMemeBuy.get(chatId);
    if (!state || !state.bnbAmount) {
      await bot.sendMessage(chatId, "Buy session expired. Use /buy to start again.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    pendingFourMemeBuy.delete(chatId);

    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;

    const userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
    if (!userPk) {
      await bot.sendMessage(chatId, "Could not access wallet keys. Try /start to create a fresh wallet.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    await bot.sendMessage(chatId, `💰 Buying with ${state.bnbAmount} BNB...\nThis may take a minute.`);
    await bot.sendChatAction(chatId, "typing");

    const { fourMemeBuyToken, collectTradeFee } = await import("./token-launcher");
    const result = await fourMemeBuyToken(tokenAddress, state.bnbAmount, 5, userPk);

    if (result.success) {
      auditLog(chatId, "TRADE_BUY", `Buy ${state.bnbAmount} BNB on token ${maskAddress(tokenAddress)} tx=${result.txHash?.substring(0, 16)}`);
      let feeMsg = "";
      try {
        const feeResult = await collectTradeFee(userPk, state.bnbAmount, TRANSACTION_FEE_PERCENT);
        if (feeResult.feeAmount && feeResult.feeAmount !== "0") {
          feeMsg = `\nPlatform fee: ${feeResult.feeAmount} BNB (${TRANSACTION_FEE_PERCENT}%)`;
          console.log(`[TradeFee] Buy fee collected: ${feeResult.feeAmount} BNB from chat ${chatId} (tx: ${feeResult.txHash})`);
        }
      } catch (e: any) {
        console.log(`[TradeFee] Buy fee failed (non-blocking): ${e.message?.substring(0, 100)}`);
      }
      await bot.sendMessage(chatId,
        `✅ Buy successful!\n\n` +
        `Amount: ${state.bnbAmount} BNB${feeMsg}\n` +
        `Tx: https://bscscan.com/tx/${result.txHash}\n\n` +
        `View token: https://four.meme/token/${tokenAddress}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📈 Token Info", callback_data: `fminfo:${tokenAddress}` }],
              [{ text: "◀️ Menu", callback_data: "action:menu" }],
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(chatId, `❌ Buy failed: ${result.error?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (data.startsWith("fmsell:")) {
    const tokenAddress = data.split(":")[1];
    const wallet = getLinkedWallet(chatId);
    if (!await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "Import a wallet with a private key first (/linkwallet).");
      return;
    }
    pendingFourMemeSell.set(chatId, { step: "amount", tokenAddress });
    await showSellAmountPrompt(chatId, tokenAddress);
    return;
  }

  if (data.startsWith("fmsellpct:")) {
    const parts = data.split(":");
    const pct = parseInt(parts[1]);
    const tokenAddress = parts[2];
    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;

    try {
      const { fourMemeGetTokenBalance } = await import("./token-launcher");
      const balInfo = await Promise.race([
        fourMemeGetTokenBalance(tokenAddress, wallet),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Balance check timed out. Try again.")), 30000)),
      ]);
      const bal = parseFloat(balInfo.balance);
      const sellAmount = (bal * pct / 100).toString();

      const state: FourMemeSellState = { step: "amount", tokenAddress, tokenAmount: sellAmount, tokenSymbol: balInfo.symbol };
      pendingFourMemeSell.set(chatId, state);
      await executeFourMemeSellConfirm(chatId, state);
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed: ${e.message?.substring(0, 100)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
      pendingFourMemeSell.delete(chatId);
    }
    return;
  }

  if (data.startsWith("fmsellconfirm:")) {
    const tokenAddress = data.split(":")[1];
    const state = pendingFourMemeSell.get(chatId);
    if (!state || !state.tokenAmount) {
      await bot.sendMessage(chatId, "Sell session expired. Use /sell to start again.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    pendingFourMemeSell.delete(chatId);

    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;

    const userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
    if (!userPk) {
      await bot.sendMessage(chatId, "Could not access wallet keys. Try /start to create a fresh wallet.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    await bot.sendMessage(chatId, `💸 Selling ${state.tokenAmount} ${state.tokenSymbol || "tokens"}...\nThis may take a minute.`);
    await bot.sendChatAction(chatId, "typing");

    const { fourMemeSellToken, collectTradeFee } = await import("./token-launcher");
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
    const userWallet = new ethers.Wallet(userPk, provider);
    const balanceBefore = await provider.getBalance(userWallet.address);

    const result = await fourMemeSellToken(tokenAddress, state.tokenAmount, userPk);

    if (result.success) {
      let feeMsg = "";
      try {
        const balanceAfter = await provider.getBalance(userWallet.address);
        const proceeds = balanceAfter - balanceBefore;
        if (proceeds > 0n) {
          const proceedsBnb = ethers.formatEther(proceeds);
          const feeResult = await collectTradeFee(userPk, proceedsBnb, TRANSACTION_FEE_PERCENT);
          if (feeResult.feeAmount && feeResult.feeAmount !== "0") {
            feeMsg = `\nProceeds: ~${parseFloat(proceedsBnb).toFixed(6)} BNB\nPlatform fee: ${feeResult.feeAmount} BNB (${TRANSACTION_FEE_PERCENT}%)`;
            console.log(`[TradeFee] Sell fee collected: ${feeResult.feeAmount} BNB from chat ${chatId} (tx: ${feeResult.txHash})`);
          }
        }
      } catch (e: any) {
        console.log(`[TradeFee] Sell fee failed (non-blocking): ${e.message?.substring(0, 100)}`);
      }
      await bot.sendMessage(chatId,
        `✅ Sell successful!\n\n` +
        `Amount: ${state.tokenAmount} ${state.tokenSymbol || "tokens"}${feeMsg}\n` +
        `Tx: https://bscscan.com/tx/${result.txHash}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📈 Token Info", callback_data: `fminfo:${tokenAddress}` }],
              [{ text: "◀️ Menu", callback_data: "action:menu" }],
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(chatId, `❌ Sell failed: ${result.error?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (data.startsWith("fminfo:")) {
    const tokenAddress = data.split(":")[1];
    await handleTokenInfo(chatId, tokenAddress);
    return;
  }
}

async function handleMessage(msg: TelegramBot.Message): Promise<void> {
  if (!bot) return;

  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const isGroup = chatType === "group" || chatType === "supergroup";
  const username = msg.from?.username || msg.from?.first_name || "user";

  if (!checkRateLimit(`tg_msg:${chatId}`, 30, 60000)) {
    return;
  }

  if ((msg as any).web_app_data) {
    try {
      const data = JSON.parse((msg as any).web_app_data.data);
      if (data.wallet && /^0x[a-fA-F0-9]{40}$/i.test(data.wallet)) {
        const addr = data.wallet.toLowerCase();
        linkTelegramWallet(chatId, addr);
        pendingWallet.delete(chatId);
        pendingImportWallet.delete(chatId);
        return;
      }
    } catch (e: any) {
      console.error("[TelegramBot] web_app_data parse error:", e.message);
    }
    return;
  }

  const transferState = pendingTransfer.get(chatId);
  if (transferState && msg.text) {
    const text = msg.text.trim();
    if (!transferState.amount) {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0 || amount > 1e12 || !isFinite(amount)) {
        await bot.sendMessage(chatId, "❌ Invalid amount. Enter a valid positive number:", { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:wallet" }]] } });
        return;
      }
      transferState.amount = amount.toString();
      pendingTransfer.set(chatId, transferState);
      await bot.sendMessage(chatId,
        `💸 *Transfer ${amount} ${transferState.token.toUpperCase()}*\n\nEnter the recipient wallet address:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:wallet" }]] } }
      );
      return;
    }
    if (!transferState.toAddress) {
      if (!/^0x[a-fA-F0-9]{40}$/i.test(text)) {
        await bot.sendMessage(chatId, "❌ Invalid address. Enter a valid EVM address (0x...):", { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:wallet" }]] } });
        return;
      }
      const targetAddr = text.toLowerCase();
      if (targetAddr === "0x0000000000000000000000000000000000000000") {
        await bot.sendMessage(chatId, "❌ Cannot send to the zero address.", { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:wallet" }]] } });
        return;
      }
      const myWallet = getLinkedWallet(chatId);
      if (myWallet && targetAddr === myWallet.toLowerCase()) {
        await bot.sendMessage(chatId, "❌ Cannot send to your own wallet.", { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:wallet" }]] } });
        return;
      }
      transferState.toAddress = targetAddr;
      pendingTransfer.set(chatId, transferState);
      const tokenLabel = transferState.token === "bnb" ? "BNB" : transferState.token === "usdt" ? "USDT" : "ETH";
      await bot.sendMessage(chatId,
        `💸 *Confirm Transfer*\n\n` +
        `Token: *${tokenLabel}*\n` +
        `Amount: *${transferState.amount}*\n` +
        `To: \`${transferState.toAddress}\`\n\n` +
        `Tap confirm to send:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: `✅ Confirm Send`, callback_data: "action:confirm_transfer" }],
          [{ text: "❌ Cancel", callback_data: "action:wallet" }],
        ]}}
      );
      return;
    }
  }

  const logoState = pendingTokenLaunch.get(chatId);
  if (logoState && logoState.step === "logo") {
    let fileId: string | null = null;
    let fileSize: number | undefined;

    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      fileId = photo.file_id;
      fileSize = photo.file_size;
    } else if (msg.document && msg.document.mime_type?.startsWith("image/")) {
      fileId = msg.document.file_id;
      fileSize = msg.document.file_size;
    } else if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
      fileId = msg.sticker.file_id;
      fileSize = msg.sticker.file_size;
    }

    if (fileId) {
      if (fileSize && fileSize > 5 * 1024 * 1024) {
        await bot.sendMessage(chatId, "⚠️ Image too large (max 5MB). Send a smaller image or type \"skip\".");
        return;
      }

      const SUPPORTED_FORMATS: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        svg: "image/svg+xml",
        tiff: "image/tiff",
        tif: "image/tiff",
        ico: "image/x-icon",
        avif: "image/avif",
      };

      const docMime = msg.document?.mime_type || (msg.sticker ? "image/webp" : null);

      try {
        const fileInfo = await bot.getFile(fileId);
        if (fileInfo.file_path) {
          const MIME_TO_EXT: Record<string, string> = {
            "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
            "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
            "image/tiff": "tiff", "image/x-icon": "ico", "image/avif": "avif",
          };

          let ext: string;
          if (docMime && MIME_TO_EXT[docMime]) {
            ext = MIME_TO_EXT[docMime];
          } else {
            const rawExt = (fileInfo.file_path.split(".").pop() || "").toLowerCase();
            ext = rawExt in SUPPORTED_FORMATS ? rawExt : "png";
          }
          const mimeType = SUPPORTED_FORMATS[ext] || "image/png";

          const telegramFileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
          const imageResp = await fetch(telegramFileUrl);
          if (imageResp.ok) {
            let imageBuffer = Buffer.from(await imageResp.arrayBuffer());

            const needsConvert = ["webp", "bmp", "tiff", "tif", "svg", "ico", "avif"].includes(ext);
            let uploadExt = ext;
            let uploadMime = mimeType;

            if (needsConvert) {
              try {
                const sharp = (await import("sharp")).default;
                imageBuffer = await sharp(imageBuffer).png().toBuffer();
                uploadExt = "png";
                uploadMime = "image/png";
              } catch (convErr: any) {
                console.error(`[TelegramBot] Image conversion from ${ext} failed:`, convErr.message);
                await bot.sendMessage(chatId, `⚠️ Could not convert ${ext.toUpperCase()} image. Continuing without custom logo.`);
                logoState.step = "links";
                pendingTokenLaunch.set(chatId, logoState);
                await bot.sendMessage(chatId,
                  `🔗 Social links (optional):\n\nSend links in this format:\n` +
                  `website: https://yoursite.com\ntwitter: https://x.com/yourtoken\ntelegram: https://t.me/yourgroup\n\n` +
                  `You can include one, two, or all three. Or type "skip" to continue without links.`,
                );
                return;
              }
            }

            const formData = new FormData();
            const blob = new Blob([imageBuffer], { type: uploadMime });
            formData.append("file", blob, `logo.${uploadExt}`);

            const uploadRes = await fetch("https://four.meme/meme-api/meme/image/upload", {
              method: "POST",
              body: formData,
            });
            if (!uploadRes.ok) {
              await bot.sendMessage(chatId, `⚠️ Logo upload failed (HTTP ${uploadRes.status}). Continuing without custom logo.`);
            } else {
              const uploadJson = await uploadRes.json();
              if (uploadJson.msg === "success" && uploadJson.data?.imageUrl) {
                logoState.imageUrl = uploadJson.data.imageUrl;
                await bot.sendMessage(chatId, `✅ Logo uploaded successfully! (${ext.toUpperCase()} format)`);
              } else {
                await bot.sendMessage(chatId, `⚠️ Logo upload failed, using auto-generated logo. Continuing...`);
              }
            }
          }
        }
      } catch (e: any) {
        console.error("[TelegramBot] Logo upload error:", e.message);
        await bot.sendMessage(chatId, `⚠️ Could not process image. Continuing without custom logo.`);
      }

      logoState.step = "links";
      pendingTokenLaunch.set(chatId, logoState);

      await bot.sendMessage(chatId,
        `🔗 Social links (optional):\n\nSend links in this format:\n` +
        `website: https://yoursite.com\n` +
        `twitter: https://x.com/yourtoken\n` +
        `telegram: https://t.me/yourgroup\n\n` +
        `You can include one, two, or all three. Or type "skip" to continue without links.`,
      );
      return;
    }
  }

  if (!msg.text) return;
  const text = msg.text.trim();

  await ensureWalletsLoaded(chatId);

  console.log(`[TelegramBot] ${isGroup ? "Group" : "DM"} message from @${username} (chatId: ${chatId}): ${text.slice(0, 80)}`);


  if (pendingExportVerification.has(chatId) && !text.startsWith("/")) {
    if (isVerificationLocked(chatId)) {
      pendingExportVerification.delete(chatId);
      const record = failedVerificationAttempts.get(chatId)!;
      const minsLeft = Math.ceil((record.lockedUntil - Date.now()) / 60000);
      await bot.sendMessage(chatId, `🔒 *Account locked* for ${minsLeft} more minute${minsLeft === 1 ? "" : "s"} due to failed verification attempts.\n\nTry again later.`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    const verification = pendingExportVerification.get(chatId)!;
    if (Date.now() > verification.expiresAt) {
      pendingExportVerification.delete(chatId);
      auditLog(chatId, "EXPORT_EXPIRED", "Verification code expired");
      await bot.sendMessage(chatId, "⏰ Verification code expired. Please try again from the wallet menu.",
        { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }]] } });
      return;
    }
    if (text.trim() === verification.code) {
      pendingExportVerification.delete(chatId);
      failedVerificationAttempts.delete(chatId);

      const exportKey = `export:${chatId}`;
      const now = Date.now();
      const exportWindow = 60 * 60 * 1000;
      const maxExports = 3;
      const exportAttempts = (exportRateLimits.get(exportKey) || []).filter((t: number) => now - t < exportWindow);
      if (exportAttempts.length >= maxExports) {
        auditLog(chatId, "EXPORT_BLOCKED", `Rate limit hit — ${exportAttempts.length} attempts in 1h`);
        await bot.sendMessage(chatId, "🚫 Too many export attempts. For security, exports are limited to 3 per hour.",
          { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }
      exportAttempts.push(now);
      exportRateLimits.set(exportKey, exportAttempts);

      if (verification.type === "sol") {
        const solWallet = solanaWalletMap.get(chatId);
        if (!solWallet || !solWallet.privateKey) {
          await bot.sendMessage(chatId, "Solana wallet key not found.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
          return;
        }
        auditLog(chatId, "KEY_EXPORT_SOL", `wallet=${maskAddress(solWallet.address)}`);
        const msg2 = await bot.sendMessage(chatId,
          `🟣 *Solana Private Key*\n\n` +
          `Address: \`${solWallet.address}\`\n\n` +
          `\`${solWallet.privateKey}\`\n\n` +
          `⚠️ This message will be auto-deleted in 30 seconds. Copy it NOW.\n` +
          `🔒 Never share your private key with anyone.\n` +
          `Import this key into Phantom, Solflare, or any Solana wallet.`,
          { parse_mode: "Markdown" }
        );
        scheduleSecureDelete(chatId, msg2.message_id, 30000);
        setTimeout(async () => {
          await bot.sendMessage(chatId, "🔐 Private key message deleted for security.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        }, 31000);
      } else {
        const wallets = getUserWallets(chatId);
        const walletAddr = wallets[verification.walletIdx];
        if (!walletAddr) {
          await bot.sendMessage(chatId, "Wallet not found.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
          return;
        }
        let pk: string | null = null;
        try {
          pk = await storage.getTelegramWalletPrivateKey(String(chatId), walletAddr);
        } catch (e: any) {
          auditLog(chatId, "DECRYPT_FAIL", `wallet=${maskAddress(walletAddr)} error=${e.message}`);
        }
        if (!pk) {
          await bot.sendMessage(chatId,
            `❌ *Could not retrieve private key.*\n\n` +
            `This can happen if:\n` +
            `• The wallet was imported as view-only\n` +
            `• The encryption key changed on the server\n\n` +
            `You may need to generate a new wallet and transfer your funds.`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
              [{ text: "🔑 Generate New Wallet", callback_data: "action:genwallet" }],
              [{ text: "« Menu", callback_data: "action:menu" }],
            ]}}
          );
          return;
        }
        auditLog(chatId, "KEY_EXPORT_EVM", `wallet=${maskAddress(walletAddr)}`);
        const msg2 = await bot.sendMessage(chatId,
          `🔐 *Private Key*\n\n` +
          `Address: \`${walletAddr}\`\n\n` +
          `\`${pk}\`\n\n` +
          `⚠️ This message will be auto-deleted in 30 seconds. Copy it NOW.\n` +
          `🔒 Never share your private key with anyone.\n` +
          `Import this key into MetaMask, Trust Wallet, or any EVM wallet.`,
          { parse_mode: "Markdown" }
        );
        scheduleSecureDelete(chatId, msg2.message_id, 30000);
        setTimeout(async () => {
          await bot.sendMessage(chatId, "🔐 Private key message deleted for security.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        }, 31000);
      }
      return;
    } else {
      const result = recordFailedVerification(chatId);
      if (result.locked) {
        pendingExportVerification.delete(chatId);
        await bot.sendMessage(chatId,
          `🔒 *Account locked for 15 minutes*\n\nToo many wrong verification codes. This is a security measure to protect your wallet.\n\nTry again later.`,
          { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
      } else {
        await bot.sendMessage(chatId, `❌ Wrong code. ${result.remaining} attempt${result.remaining === 1 ? "" : "s"} remaining before lockout.\n\nTry again or go back to the wallet menu.`,
          { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }]] } });
      }
      return;
    }
  }

  if (pendingImportWallet.has(chatId) && !text.startsWith("/")) {
    await handleImportWalletFlow(chatId, text);
    return;
  }
  if (pendingAgentCreation.has(chatId) && !text.startsWith("/")) {
    await handleAgentCreationFlow(chatId, text);
    return;
  }
  if (pendingTokenLaunch.has(chatId) && !text.startsWith("/")) {
    await handleTokenLaunchFlow(chatId, text);
    return;
  }
  if (pendingFourMemeBuy.has(chatId) && !text.startsWith("/")) {
    await handleFourMemeBuyFlow(chatId, text);
    return;
  }
  if (pendingFourMemeSell.has(chatId) && !text.startsWith("/")) {
    await handleFourMemeSellFlow(chatId, text);
    return;
  }
  if (pendingStealthEth.has(chatId) && !text.startsWith("/")) {
    const state = pendingStealthEth.get(chatId)!;
    const totalEth = parseFloat(text.trim());
    if (isNaN(totalEth) || totalEth <= 0) {
      await bot.sendMessage(chatId, "Please enter a valid ETH amount (e.g. `10` for 10 ETH):", { parse_mode: "Markdown" });
      return;
    }
    if (totalEth < 0.1) {
      await bot.sendMessage(chatId, "Minimum 0.1 ETH for stealth buy. Enter a higher amount:");
      return;
    }

    pendingStealthEth.delete(chatId);

    const mainBuyEth = (totalEth * 0.7).toFixed(6);
    const stealthTotalEth = totalEth * 0.3;
    const stealthPerWallet = (stealthTotalEth / 20).toFixed(6);

    await bot.sendMessage(chatId,
      `🥷 *Stealth Buy Confirmed*\n\n` +
      `Total: ${totalEth} ETH\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Main wallet buy: ${mainBuyEth} ETH (70%)\n` +
      `20 stealth wallets: ${stealthPerWallet} ETH each (30%)\n\n` +
      `⏳ Executing now... this may take 2-3 minutes.\n` +
      `Do NOT close the chat.`,
      { parse_mode: "Markdown" }
    );
    sendTyping(chatId);

    const walletAddr = getLinkedWallet(chatId);
    if (!walletAddr) return;
    let pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), walletAddr);
    if (!pk) pk = await storage.getPrivateKeyByWalletAddress(walletAddr);
    if (!pk) {
      await bot.sendMessage(chatId, "❌ Private key not found. Import or create a wallet with /wallet first.");
      return;
    }

    try {
      const { executeStealthBuy } = await import("./stealth-buy");
      const result = await executeStealthBuy({
        tokenAddress: state.tokenAddress,
        mainWalletPk: pk,
        mainBuyPercent: 70,
        stealthWalletCount: 20,
        totalEthBudget: totalEth.toString(),
        mainBuyEth,
        stealthBuyEthPerWallet: stealthPerWallet,
        slippage: "10",
      });

      if (!result.success) {
        await bot.sendMessage(chatId,
          `❌ Stealth buy failed: ${result.error}\n\n${result.mainBuyTxHash ? `Main buy TX: \`${result.mainBuyTxHash}\`` : ""}`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
        );
        return;
      }

      stealthWalletStore.set(chatId, result.stealthWallets);

      const successCount = result.stealthResults.filter(r => r.success).length;
      const failCount = result.stealthResults.filter(r => !r.success).length;

      let report = `🥷 *STEALTH BUY COMPLETE!*\n\n`;
      report += `✅ Main wallet buy: [View TX](https://basescan.org/tx/${result.mainBuyTxHash})\n`;
      report += `✅ Stealth buys: ${successCount}/20 succeeded\n`;
      if (failCount > 0) report += `⚠️ Failed: ${failCount}/20\n`;
      report += `\n━━━━━━━━━━━━━━━━━━━━\n`;
      report += `\n💰 Tokens are now spread across:\n`;
      report += `• Your main wallet (70%)\n`;
      report += `• ${successCount} stealth wallets (${(successCount * 0.5).toFixed(1)}%)\n\n`;
      report += `When ready, tap *Consolidate* to move all tokens to your main wallet.`;

      await bot.sendMessage(chatId, report, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Consolidate All Tokens", callback_data: "consolidate:now" }],
            [{ text: "⏳ Keep Spread (consolidate later)", callback_data: "action:menu" }],
          ]
        }
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Stealth buy error: ${e.message?.substring(0, 200)}`, { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }
  if (pendingAgentQuestion.has(chatId) && !text.startsWith("/")) {
    const agentId = pendingAgentQuestion.get(chatId)!;
    pendingAgentQuestion.delete(chatId);
    const agent = await storage.getAgent(agentId);
    if (agent && bot) {
      sendTyping(chatId);
      await bot.sendMessage(chatId, `🤖 *${agent.name}* is thinking...`, { parse_mode: "Markdown" });
      try {
        const { runInferenceWithFallback } = await import("./inference");
        const systemPrompt = `You are ${agent.name}, an autonomous AI trading agent on BUILD4.\n` +
          `Bio: ${agent.bio || "AI trading agent"}\n` +
          `You are a crypto expert. Give concise, actionable answers. Keep responses under 300 words.`;
        const result = await runInferenceWithFallback(
          ["akash", "hyperbolic"],
          undefined,
          text,
          { systemPrompt, temperature: 0.7, maxTokens: 600 }
        );
        if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
          await bot.sendMessage(chatId, `🤖 *${agent.name}:*\n\n${result.text.trim()}`, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [
              [{ text: `💬 Ask Another Question`, callback_data: `agentask:${agentId}` }],
              [{ text: "« Menu", callback_data: "action:menu" }],
            ]}
          });
        } else {
          await bot.sendMessage(chatId, `🤖 ${agent.name} couldn't process that right now. Try again later.`, {
            reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] }
          });
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `❌ ${agent.name} encountered an error. Try again.`, {
          reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] }
        });
      }
    }
    return;
  }
  if (pendingTask.has(chatId) && !text.startsWith("/")) {
    await handleTaskFlow(chatId, text);
    return;
  }
  if (pendingChaosPlan.has(chatId) && !text.startsWith("/")) {
    await handleChaosPlanFlow(chatId, text);
    return;
  }
  if (pendingAsterConnect.has(chatId) && !text.startsWith("/")) {
    await handleAsterConnectFlow(chatId, text);
    return;
  }
  if (pendingAsterTrade.has(chatId) && !text.startsWith("/")) {
    await handleAsterTradeFlow(chatId, text);
    return;
  }
  if (pendingOKXSwap.has(chatId) && !text.startsWith("/")) {
    await handleOKXSwapFlow(chatId, text);
    return;
  }
  if (pendingOKXBridge.has(chatId) && !text.startsWith("/")) {
    await handleOKXBridgeFlow(chatId, text);
    return;
  }
  if (pendingTxHashVerify.has(chatId) && !text.startsWith("/")) {
    pendingTxHashVerify.delete(chatId);
    const txHash = text.trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      await bot.sendMessage(chatId, "❌ Invalid transaction hash. Must be a 66-character hex string starting with 0x.", {
        reply_markup: { inline_keyboard: [[{ text: "📋 Try Again", callback_data: "action:verifytxhash" }], [{ text: "« Menu", callback_data: "action:menu" }]] }
      });
      return;
    }

    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId, "❌ No wallet linked. Use /start first.");
      return;
    }

    await bot.sendMessage(chatId, `🔍 Verifying transaction \`${txHash.substring(0, 16)}...\``, { parse_mode: "Markdown" });
    sendTyping(chatId);

    const rpcUrls: { chainId: number; name: string; rpc: string }[] = [
      { chainId: 56, name: "BNB Chain", rpc: "https://bsc-dataseed1.binance.org" },
      { chainId: 8453, name: "Base", rpc: "https://mainnet.base.org" },
    ];

    try {
      const { ethers } = await import("ethers");
      let verified = false;

      for (const chain of rpcUrls) {
        try {
          const provider = new ethers.JsonRpcProvider(chain.rpc);
          const receipt = await provider.getTransactionReceipt(txHash);
          if (!receipt) continue;

          console.log(`[TxHashVerify] Found receipt on ${chain.name}, logs=${receipt.logs.length}`);

          const usdtAddr = USDT_ADDRESSES[chain.chainId.toString()];
          if (!usdtAddr) continue;

          const transferTopic = ethers.id("Transfer(address,address,uint256)");
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== usdtAddr.toLowerCase()) continue;
            if (log.topics[0] !== transferTopic) continue;

            const from = ethers.getAddress("0x" + log.topics[1].slice(26));
            const to = ethers.getAddress("0x" + log.topics[2].slice(26));
            const value = parseFloat(ethers.formatUnits(log.data, 18));

            console.log(`[TxHashVerify] Transfer: from=${from.substring(0,10)} to=${to.substring(0,10)} value=${value.toFixed(2)}`);

            if (to.toLowerCase() !== TREASURY_WALLET.toLowerCase()) continue;
            if (from.toLowerCase() !== wallet.toLowerCase()) continue;
            if (value < BOT_PRICE_USD - 0.50) continue;

            const existingSub = await storage.getBotSubscription(wallet);
            if (existingSub?.txHash === txHash && existingSub.status === "active") {
              await bot.sendMessage(chatId,
                `✅ *Already Active!*\n\nYour subscription is already active (TX \`${txHash.substring(0, 16)}...\`).`,
                { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
              );
              return;
            }

            let activated = await storage.activateBotSubscription(wallet, txHash, chain.chainId, value.toFixed(2));
            if (!activated) {
              await storage.createBotSubscription(wallet, chatId.toString());
              activated = await storage.activateBotSubscription(wallet, txHash, chain.chainId, value.toFixed(2));
            }

            subCache.delete(chatId);
            console.log(`[TxHashVerify] SUCCESS chatId=${chatId} wallet=${wallet.substring(0,8)} amount=${value.toFixed(2)} chain=${chain.name}`);

            await bot.sendMessage(chatId,
              `🎉 *Payment Confirmed!*\n\n` +
              `Amount: ${value.toFixed(2)} USDT\n` +
              `Chain: ${chain.name}\n` +
              `TX: \`${txHash.substring(0, 20)}...\`\n\n` +
              `✅ Your premium subscription is now active for 30 days.\n` +
              `All features unlocked! 🚀`,
              { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
            );

            try {
              const referral = await storage.getReferralByReferred(chatId.toString());
              if (referral && !referral.commissionPaid) {
                const referrerCount = await storage.getReferralCount(referral.referrerChatId);
                const commissionPct = getReferralCommissionPercent(referrerCount);
                const commissionAmt = (BOT_PRICE_USD * commissionPct / 100).toFixed(2);
                await storage.markReferralPaid(chatId.toString(), commissionAmt, commissionPct);
                try {
                  await bot.sendMessage(parseInt(referral.referrerChatId),
                    `💰 *Referral Commission Earned!*\n\nSomeone you referred just subscribed!\nCommission: *$${commissionAmt} USDT* (${commissionPct}%)`,
                    { parse_mode: "Markdown" }
                  );
                } catch {}
              }
            } catch {}

            verified = true;
            break;
          }
          if (verified) break;
        } catch (chainErr: any) {
          console.error(`[TxHashVerify] ${chain.name} error:`, chainErr.message);
        }
      }

      if (!verified) {
        await bot.sendMessage(chatId,
          `❌ *Could not verify this transaction*\n\n` +
          `TX: \`${txHash.substring(0, 20)}...\`\n\n` +
          `Possible reasons:\n` +
          `• TX is not a USDT transfer to the treasury wallet\n` +
          `• Sender is not your linked wallet (\`${wallet.substring(0, 10)}...\`)\n` +
          `• Amount is less than $${BOT_PRICE_USD}\n` +
          `• Wrong chain (only BNB Chain and Base supported)`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
            [{ text: "📋 Try Another TX", callback_data: "action:verifytxhash" }],
            [{ text: "🔄 Auto Check", callback_data: "action:verifypayment" }],
            [{ text: "« Menu", callback_data: "action:menu" }],
          ]}}
        );
      }
    } catch (e: any) {
      console.error("[TxHashVerify] Error:", e.message);
      await bot.sendMessage(chatId, `❌ Verification error: ${e.message?.substring(0, 100)}`, {
        reply_markup: { inline_keyboard: [[{ text: "📋 Try Again", callback_data: "action:verifytxhash" }], [{ text: "« Menu", callback_data: "action:menu" }]] }
      });
    }
    return;
  }

  if (pendingOKXScan.has(chatId) && !text.startsWith("/")) {
    const state = pendingOKXScan.get(chatId)!;
    pendingOKXScan.delete(chatId);
    const addr = text.trim();
    if (!addr.startsWith("0x") && addr.length < 30) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid contract address (0x...).", { reply_markup: { inline_keyboard: [[{ text: "🔒 Try Again", callback_data: "action:okxsecurity" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    await bot.sendMessage(chatId, `🔒 Scanning token \`${addr.substring(0, 12)}...\` for risks...`, { parse_mode: "Markdown" });
    try {
      const result = await executeSecurityScan(addr, state.chain || "56");
      if (result.success && result.data) {
        const d = result.data;
        let text = `🔒 *Security Scan${d.tokenSymbol ? `: ${d.tokenSymbol}` : ""}*\n\n`;
        text += `Address:\n\`${addr}\`\n\n`;
        if (d.isHoneypot !== undefined) text += `🍯 Honeypot: ${d.isHoneypot ? "⚠️ *YES — DO NOT BUY*" : "✅ No"}\n`;
        if (d.riskLevel) text += `⚡ Risk: ${d.riskLevel === "high" ? "🔴 HIGH" : d.riskLevel === "medium" ? "🟡 MEDIUM" : d.riskLevel === "low" ? "🟢 LOW" : "⚪ Unknown"}\n`;
        if (d.buyTax !== undefined) text += `📥 Buy Tax: ${d.buyTax}%\n`;
        if (d.sellTax !== undefined) text += `📤 Sell Tax: ${d.sellTax}%\n`;
        if (d.isOpenSource !== undefined) text += `📄 Open Source: ${d.isOpenSource ? "✅ Yes" : "❌ No"}\n`;
        if (d.isProxy !== undefined) text += `🔀 Proxy: ${d.isProxy ? "⚠️ Yes" : "✅ No"}\n`;
        if (d.ownerCanMint !== undefined) text += `🖨️ Can Mint: ${d.ownerCanMint ? "⚠️ Yes" : "✅ No"}\n`;
        if (d.freezeAuthority !== undefined) text += `❄️ Freeze Auth: ${d.freezeAuthority ? "⚠️ Active" : "✅ None"}\n`;
        if (d.holderCount) text += `👥 Holders: ${d.holderCount.toLocaleString()}\n`;
        if (d.liquidity) text += `💰 Liquidity: $${(d.liquidity / 1e6 >= 1 ? (d.liquidity / 1e6).toFixed(2) + "M" : (d.liquidity / 1e3).toFixed(0) + "K")}\n`;
        if (d.risks && d.risks.length > 0) {
          text += `\n⚠️ *Risks Found:*\n`;
          d.risks.slice(0, 8).forEach((r: string) => { text += `• ${r}\n`; });
        } else if (d.riskLevel === "low") {
          text += `\n✅ No major risks detected\n`;
        }
        if (d.source) text += `\n_Source: ${d.source}_`;
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔒 Scan Another", callback_data: "action:okxsecurity" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, `Scan failed: ${result.error || "try again"}`, { reply_markup: { inline_keyboard: [[{ text: "🔒 Try Again", callback_data: "action:okxsecurity" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }
  if (pendingOKXPrice.has(chatId) && !text.startsWith("/")) {
    const state = pendingOKXPrice.get(chatId)!;
    pendingOKXPrice.delete(chatId);
    const addr = text.trim();
    if (!addr.startsWith("0x") && addr.length < 30) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid contract address.", { reply_markup: { inline_keyboard: [[{ text: "📊 Try Again", callback_data: "action:okxprice" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    await bot.sendMessage(chatId, `📊 Looking up price for \`${addr.substring(0, 12)}...\``, { parse_mode: "Markdown" });
    try {
      const result = await getTokenPrice(addr, state.chain || "56");
      if (result.success && result.data) {
        const d = result.data;
        let text = "📊 *Token Price*\n\n";
        text += `Address: \`${addr}\`\n\n`;
        if (d.price) text += `Price: $${parseFloat(d.price) < 0.01 ? parseFloat(d.price).toExponential(3) : parseFloat(d.price).toFixed(6)}\n`;
        if (d.priceChange24h) text += `24h Change: ${parseFloat(d.priceChange24h) >= 0 ? "+" : ""}${(parseFloat(d.priceChange24h) * 100).toFixed(2)}%\n`;
        if (d.volume24h) text += `24h Volume: $${(parseFloat(d.volume24h) / 1e6).toFixed(2)}M\n`;
        if (d.marketCap) text += `Market Cap: $${(parseFloat(d.marketCap) / 1e6).toFixed(2)}M\n`;
        if (d.liquidity) text += `Liquidity: $${(parseFloat(d.liquidity) / 1e3).toFixed(0)}K\n`;
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "📊 Another Token", callback_data: "action:okxprice" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, `Price lookup failed: ${result.error || "token not found"}`, { reply_markup: { inline_keyboard: [[{ text: "📊 Try Again", callback_data: "action:okxprice" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  const evmCaMatch = text.match(/^(0x[a-fA-F0-9]{40})$/i);
  const solanaAddrRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const isSolanaLike = !evmCaMatch && solanaAddrRegex.test(text) && text.length >= 32 && /\d/.test(text) && /[A-Z]/.test(text) && /[a-z]/.test(text);
  const solanaCaMatch = isSolanaLike ? text.match(solanaAddrRegex) : null;
  if ((evmCaMatch || solanaCaMatch) && !text.startsWith("/")) {
    const ca = text.trim();
    const isSolana = !!solanaCaMatch;
    const chainId = isSolana ? "501" : "56";
    const chainName = isSolana ? "Solana" : "BNB Chain";
    const nativeSymbol = isSolana ? "SOL" : "BNB";
    const chainEmoji = isSolana ? "🟣" : chainId === "8453" ? "🔵" : "🟡";

    await bot.sendMessage(chatId, `🔍 Scanning token \`${ca.substring(0, 12)}...\``, { parse_mode: "Markdown" });
    sendTyping(chatId);

    try {
      const { getTokenInfoAPI, securityTokenScanAPI } = await import("./okx-onchainos");
      const [priceResult, tokenInfoRes, securityRes] = await Promise.all([
        getTokenPrice(ca, chainId).catch(() => ({ success: false, data: null })),
        getTokenInfoAPI(ca, chainId).catch(() => ({ success: false, data: null })),
        securityTokenScanAPI(ca, chainId).catch(() => ({ success: false, data: null })),
      ]);
      const pd = priceResult?.data;
      const ti = tokenInfoRes?.data;
      const sec = securityRes?.data;

      const tokenName = sec?.tokenName || ti?.tokenName || pd?.tokenName || pd?.name || null;
      const tokenSymbol = sec?.tokenSymbol || ti?.tokenSymbol || pd?.tokenSymbol || pd?.symbol || null;

      const dexChainSlug: Record<string, string> = { "56": "bsc", "1": "ethereum", "8453": "base", "501": "solana", "137": "polygon", "42161": "arbitrum" };
      const chartUrl = `https://dexscreener.com/${dexChainSlug[chainId] || "bsc"}/${ca}`;

      let msg = "";

      if (tokenName) {
        msg += `${chainEmoji} *${tokenName}*${tokenSymbol && tokenSymbol !== tokenName ? ` ($${tokenSymbol})` : ""}\n`;
      } else {
        msg += `${chainEmoji} *Token Scan*\n`;
      }
      msg += `Chain: ${chainName}\n`;
      msg += `CA: \`${ca}\`\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

      const priceVal = pd?.price || ti?.price || sec?.price;
      if (priceVal) {
        const price = parseFloat(priceVal);
        const priceStr = price < 0.0001 ? price.toExponential(3) : price < 1 ? price.toFixed(6) : price.toFixed(2);
        msg += `💲 *Price:* $${priceStr}\n`;
      }

      const change24h = pd?.priceChange24h;
      if (change24h) {
        const pct = parseFloat(change24h) * 100;
        const arrow = pct >= 0 ? "🟢" : "🔴";
        msg += `${arrow} *24h:* ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%\n`;
      }

      const mcap = pd?.marketCap || ti?.marketCap || sec?.marketCap;
      if (mcap && parseFloat(mcap) > 0) {
        const mc = parseFloat(mcap);
        msg += `💰 *MCap:* $${mc >= 1e9 ? (mc / 1e9).toFixed(2) + "B" : mc >= 1e6 ? (mc / 1e6).toFixed(2) + "M" : (mc / 1e3).toFixed(0) + "K"}\n`;
      }

      const vol = pd?.volume24h || ti?.volume24h || sec?.volume24h;
      if (vol && parseFloat(vol) > 0) {
        const v = parseFloat(vol);
        msg += `📊 *Volume 24h:* $${v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : (v / 1e3).toFixed(0) + "K"}\n`;
      }

      const liq = pd?.liquidity || ti?.liquidity || sec?.liquidity;
      if (liq && parseFloat(liq) > 0) {
        const l = parseFloat(liq);
        msg += `💧 *Liquidity:* $${l >= 1e6 ? (l / 1e6).toFixed(2) + "M" : (l / 1e3).toFixed(0) + "K"}\n`;
      }

      const holders = sec?.holderCount || ti?.holders || pd?.holders;
      if (holders) msg += `👥 *Holders:* ${parseInt(holders).toLocaleString()}\n`;

      const lpHolders = sec?.lpHolderCount;
      if (lpHolders) msg += `🏊 *LP Holders:* ${lpHolders.toLocaleString()}\n`;

      if (sec && securityRes?.success) {
        msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `🔒 *Security Analysis*\n\n`;

        if (sec.isHoneypot) {
          msg += `🚨 *HONEYPOT — DO NOT BUY*\n\n`;
        }

        const checks: string[] = [];
        checks.push(`${sec.isOpenSource ? "✅" : "❌"} Contract Verified`);
        checks.push(`${!sec.isProxy ? "✅" : "⚠️"} ${sec.isProxy ? "Proxy (Upgradeable)" : "Not Proxy"}`);
        checks.push(`${!sec.ownerCanMint ? "✅" : "❌"} ${sec.ownerCanMint ? "Mint Enabled" : "Mint Disabled"}`);
        checks.push(`${!sec.canTakeBackOwnership ? "✅" : "❌"} ${sec.canTakeBackOwnership ? "Owner Reclaimable" : "Ownership Safe"}`);
        checks.push(`${!sec.ownerChangeBalance ? "✅" : "❌"} ${sec.ownerChangeBalance ? "Balance Modifiable" : "Balance Safe"}`);

        if (isSolana && sec.freezeAuthority !== undefined) {
          checks.push(`${!sec.freezeAuthority ? "✅" : "❌"} ${sec.freezeAuthority ? "Freeze Authority Active" : "No Freeze Authority"}`);
        }

        msg += checks.join("\n") + "\n\n";

        if (sec.buyTax !== undefined || sec.sellTax !== undefined) {
          const bt = sec.buyTax ? parseFloat(sec.buyTax) : 0;
          const st = sec.sellTax ? parseFloat(sec.sellTax) : 0;
          const taxIcon = (bt > 10 || st > 10) ? "🔴" : (bt > 5 || st > 5) ? "🟡" : "🟢";
          msg += `${taxIcon} *Buy Tax:* ${bt.toFixed(1)}% | *Sell Tax:* ${st.toFixed(1)}%\n`;
        }

        if (sec.risks && sec.risks.length > 0) {
          msg += `\n⚠️ *Risks Found (${sec.risks.length}):*\n`;
          sec.risks.slice(0, 6).forEach((r: string) => {
            msg += `  • ${r}\n`;
          });
          if (sec.risks.length > 6) msg += `  _...and ${sec.risks.length - 6} more_\n`;
        }

        const riskEmoji = sec.riskLevel === "high" ? "🔴 HIGH" : sec.riskLevel === "medium" ? "🟡 MEDIUM" : sec.riskLevel === "low" ? "🟢 LOW" : "⚪ UNKNOWN";
        msg += `\n*Risk Level:* ${riskEmoji}`;
        if (sec.rugScore !== undefined) msg += ` (Score: ${sec.rugScore})`;
        msg += `\n`;

        if (sec.source) msg += `_Source: ${sec.source}_\n`;
      } else {
        msg += `\n⚠️ Security data unavailable — scan manually below.\n`;
      }

      msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `[📊 Chart](${chartUrl})`;

      const buyAmounts = isSolana
        ? [
            { text: "🟢 0.1 SOL", callback_data: `cabuy:${ca}:${chainId}:0.1` },
            { text: "🟢 0.5 SOL", callback_data: `cabuy:${ca}:${chainId}:0.5` },
            { text: "🟢 1 SOL", callback_data: `cabuy:${ca}:${chainId}:1` },
          ]
        : [
            { text: "🟢 0.01 BNB", callback_data: `cabuy:${ca}:${chainId}:0.01` },
            { text: "🟢 0.05 BNB", callback_data: `cabuy:${ca}:${chainId}:0.05` },
            { text: "🟢 0.1 BNB", callback_data: `cabuy:${ca}:${chainId}:0.1` },
          ];

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            buyAmounts,
            [
              { text: "🔒 Deep Scan", callback_data: `cascan:${ca}:${chainId}` },
              { text: "📊 Chart", callback_data: `cachart:${ca}:${chainId}` },
            ],
            [{ text: "🔄 Refresh", callback_data: `carefresh:${ca}:${chainId}` }],
            [{ text: "« Menu", callback_data: "action:menu" }],
          ],
        },
      });

      const caContext = [
        `Token: ${tokenName || ca}`,
        priceVal ? `Price: $${priceVal}` : null,
        change24h ? `24h Change: ${(parseFloat(change24h) * 100).toFixed(2)}%` : null,
        mcap ? `Market Cap: $${mcap}` : null,
        vol ? `Volume 24h: $${vol}` : null,
        liq ? `Liquidity: $${liq}` : null,
        holders ? `Holders: ${holders}` : null,
        sec?.riskLevel ? `Risk: ${sec.riskLevel}` : null,
        sec?.isHoneypot ? "HONEYPOT WARNING" : null,
        sec?.buyTax ? `Buy Tax: ${sec.buyTax}%` : null,
        sec?.sellTax ? `Sell Tax: ${sec.sellTax}%` : null,
      ].filter(Boolean).join("\n");
      agentAnalyze(chatId, caContext, "Quick analysis: Is this token worth buying? Consider the price action, liquidity, risk level, and market cap.").then(analysis => {
        if (analysis && bot) {
          bot.sendMessage(chatId, analysis, { parse_mode: "Markdown" }).catch(() => {});
        }
      }).catch(() => {});
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `⚠️ Could not scan token \`${ca.substring(0, 12)}...\`\n\n${e.message?.substring(0, 100)}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
    }
    return;
  }

  const swapNorm = text.replace(/\s+/g, " ").trim();
  const swapMatch = swapNorm.match(/^swap\s+([\d.]+)\s*(\w+)\s+(?:for|to|into|->|→)\s+(\w+)(?:\s+(?:on|@)\s+(.+))?$/i)
    || swapNorm.match(/^swap\s+([\d.]+)\s*(\w+)\s+(?:for|to|into|->|→)\s+(\w+)\s+(\w+)$/i);
  if (swapMatch && !text.startsWith("/")) {
    const [, amount, fromSymbol, toSymbol, chainHint] = swapMatch;

    const chainAliases: Record<string, string> = {
      bnb: "56", bsc: "56", "bnb chain": "56", binance: "56",
      eth: "1", ethereum: "1",
      base: "8453",
      polygon: "137", matic: "137", pol: "137",
      arbitrum: "42161", arb: "42161",
      optimism: "10", op: "10",
      avalanche: "43114", avax: "43114",
      xlayer: "196", okb: "196",
      zksync: "324",
      linea: "59144",
      scroll: "534352",
      fantom: "250", ftm: "250",
      mantle: "5000", mnt: "5000",
      blast: "81457",
      gnosis: "100",
      cronos: "25", cro: "25",
      solana: "501", sol: "501",
    };

    let chainId: string | undefined;
    if (chainHint) {
      chainId = chainAliases[chainHint.toLowerCase().trim()];
    }

    if (!chainId) {
      const fromUpper = fromSymbol.toUpperCase();
      const allTokens = Object.entries(OKX_POPULAR_TOKENS);
      for (const [cid, tokens] of allTokens) {
        if (tokens.some(t => t.symbol === fromUpper)) {
          if (fromUpper === "ETH" || fromUpper === "USDT" || fromUpper === "USDC") {
            const nativeSymbol = OKX_CHAINS.find(c => c.id === cid)?.symbol;
            if (nativeSymbol === fromUpper) { chainId = cid; break; }
          } else {
            chainId = cid; break;
          }
        }
      }
      if (!chainId && OKX_SOLANA_TOKENS.some(t => t.symbol === fromUpper)) {
        chainId = "501";
      }
      if (!chainId) {
        if (fromUpper === "BNB" || toSymbol.toUpperCase() === "BNB") chainId = "56";
        else if (fromUpper === "ETH" || toSymbol.toUpperCase() === "ETH") chainId = "1";
        else if (fromUpper === "SOL" || toSymbol.toUpperCase() === "SOL") chainId = "501";
        else if (fromUpper === "AVAX" || toSymbol.toUpperCase() === "AVAX") chainId = "43114";
        else if (fromUpper === "POL" || toSymbol.toUpperCase() === "POL") chainId = "137";
        else if (fromUpper === "OKB" || toSymbol.toUpperCase() === "OKB") chainId = "196";
        else if (fromUpper === "FTM" || toSymbol.toUpperCase() === "FTM") chainId = "250";
        else if (fromUpper === "MNT" || toSymbol.toUpperCase() === "MNT") chainId = "5000";
        else if (fromUpper === "CRO" || toSymbol.toUpperCase() === "CRO") chainId = "25";
        else chainId = "56";
      }
    }

    const chain = OKX_CHAINS.find(c => c.id === chainId);
    if (!chain) {
      await bot.sendMessage(chatId, `Couldn't find that chain. Try: swap 1 BNB for USDT on BSC`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }

    const tokens = getOKXTokensForChain(chainId!);
    const fromToken = tokens.find(t => t.symbol.toLowerCase() === fromSymbol.toLowerCase());
    const toToken = tokens.find(t => t.symbol.toLowerCase() === toSymbol.toLowerCase());

    if (!fromToken || !toToken) {
      const fromUpper = fromSymbol.toUpperCase();
      const toUpper = toSymbol.toUpperCase();
      const fromHomeChainId = Object.entries(OKX_POPULAR_TOKENS).find(([cid, toks]) => toks.some(t => t.symbol === fromUpper))?.[0];
      const toHomeChainId = Object.entries(OKX_POPULAR_TOKENS).find(([cid, toks]) => toks.some(t => t.symbol === toUpper))?.[0];

      const isCrossChain = (fromHomeChainId && fromHomeChainId !== chainId) || (toHomeChainId && toHomeChainId !== chainId);

      if (isCrossChain && fromHomeChainId) {
        const srcChainId = fromHomeChainId;
        const dstChainId = toHomeChainId && toHomeChainId !== srcChainId ? toHomeChainId : chainId!;
        const srcChain = OKX_CHAINS.find(c => c.id === srcChainId);
        const dstChain = OKX_CHAINS.find(c => c.id === dstChainId);
        const srcTokens = getOKXTokensForChain(srcChainId);
        const dstTokens = getOKXTokensForChain(dstChainId);
        const srcToken = srcTokens.find(t => t.symbol === fromUpper);
        const dstToken = dstTokens.find(t => t.symbol === toUpper);

        if (srcToken && dstToken && srcChain && dstChain && srcChainId !== dstChainId) {
          sendTyping(chatId);
          let crossChainSuccess = false;
          try {
            const { getCrossChainQuote } = await import("./okx-onchainos");
            const rawAmt = parseHumanAmount(amount, srcToken.decimals);
            const quote = await getCrossChainQuote({
              fromChainId: srcChainId, toChainId: dstChainId,
              fromTokenAddress: srcToken.address, toTokenAddress: dstToken.address,
              amount: rawAmt, slippage: "1",
            });
            const routerList = quote?.data?.routerList || quote?.data;
            const bestRoute = Array.isArray(routerList) ? routerList[0] : null;
            const receiveAmt = bestRoute?.toTokenAmount ? formatTokenAmount(bestRoute.toTokenAmount, dstToken.decimals) : null;

            if (receiveAmt) {
              crossChainSuccess = true;
              const bridgeProvider = bestRoute?._provider === "lifi" ? (bestRoute?.bridgeProvider || "Li.Fi") : "OKX";
              pendingOKXBridge.set(chatId, {
                step: "confirm", fromChainId: srcChainId, fromChainName: srcChain.name,
                toChainId: dstChainId, toChainName: dstChain.name,
                fromToken: srcToken.address, fromSymbol: srcToken.symbol,
                toToken: dstToken.address, toSymbol: dstToken.symbol,
                amount: rawAmt, receiveAddress: "", quoteData: bestRoute,
              });

              if (dstChainId === "501") {
                const existingSol = solanaWalletMap.get(chatId);
                let msg = `🌉 *Cross-Chain Swap Quote* (via ${bridgeProvider})\n\n` +
                  `💰 ${amount} ${fromUpper} (${srcChain.name}) → ${receiveAmt} ${toUpper} (Solana)\n\n` +
                  `Solana uses a different wallet. Where should your ${toUpper} go?\n`;
                const buttons: any[][] = [];
                if (existingSol) {
                  const shortSol = existingSol.address.substring(0, 8) + "..." + existingSol.address.slice(-6);
                  buttons.push([{ text: `📱 Use my SOL wallet (${shortSol})`, callback_data: `sol_bridge_use:${existingSol.address}` }]);
                }
                buttons.push([{ text: "🔑 Generate new SOL wallet", callback_data: "sol_bridge_generate" }]);
                buttons.push([{ text: "📝 Enter my own SOL address", callback_data: "sol_bridge_custom" }]);
                buttons.push([{ text: "❌ Cancel", callback_data: "action:menu" }]);
                await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
              } else {
                await bot.sendMessage(chatId,
                  `🌉 *Cross-Chain Swap Quote* (via ${bridgeProvider})\n\n` +
                  `💰 ${amount} ${fromUpper} (${srcChain.name}) → ${receiveAmt} ${toUpper} (${dstChain.name})\n\n` +
                  `Confirm this cross-chain swap?`,
                  { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Cross-Chain Swap", callback_data: "okxbridge_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } }
                );
              }
            }
          } catch (e: any) {
          }

          if (!crossChainSuccess) {
            const fallbackTo = srcTokens.find(t => t.symbol === toUpper) ? toUpper : null;
            const stableOnSrc = srcTokens.find(t => t.symbol === "USDT" || t.symbol === "USDC");
            const fallbackSymbol = fallbackTo || stableOnSrc?.symbol;
            if (fallbackSymbol) {
              const fallbackToken = srcTokens.find(t => t.symbol === fallbackSymbol)!;
              const rawAmt = parseHumanAmount(amount, srcToken.decimals);
              await bot.sendMessage(chatId, `🔄 Getting quote: ${amount} ${fromUpper} → ${fallbackSymbol} on ${srcChain!.name}...`);
              sendTyping(chatId);
              try {
                const { getSwapQuote } = await import("./okx-onchainos");
                const quote = await getSwapQuote({ chainId: srcChainId, fromTokenAddress: srcToken.address, toTokenAddress: fallbackToken.address, amount: rawAmt, slippage: "1" });
                const receiveAmt = quote?.data?.[0]?.toTokenAmount ? formatTokenAmount(quote.data[0].toTokenAmount, fallbackToken.decimals) : null;
                if (receiveAmt) {
                  pendingOKXSwap.set(chatId, { step: "confirm", chainId: srcChainId, chainName: srcChain!.name, fromToken: srcToken.address, fromSymbol: srcToken.symbol, toToken: fallbackToken.address, toSymbol: fallbackToken.symbol, amount: rawAmt, quoteData: quote.data[0] });
                  await bot.sendMessage(chatId, `🔄 *Swap Quote on ${srcChain!.name}*\n\n💰 ${amount} ${srcToken.symbol} → ${receiveAmt} ${fallbackSymbol}\n\nConfirm this swap?`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Swap", callback_data: "okxswap_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } });
                } else {
                  await bot.sendMessage(chatId, `No quote available. Try /swap to pick tokens manually.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
                }
              } catch (swapErr: any) {
                await bot.sendMessage(chatId, `Quote error. Try /swap to pick tokens manually.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
              }
            } else {
              await bot.sendMessage(chatId, `Token "${fromUpper}" not available for swap right now. Try /swap to pick manually.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
            }
          }
          return;
        }

        if (srcToken && srcChain) {
          const fallbackTo = srcTokens.find(t => t.symbol === toUpper);
          const stableOnSrc = srcTokens.find(t => t.symbol === "USDT" || t.symbol === "USDC");
          const fallbackToken = fallbackTo || stableOnSrc;
          if (fallbackToken) {
            const rawAmt = parseHumanAmount(amount, srcToken.decimals);
            await bot.sendMessage(chatId, `🔄 Getting quote: ${amount} ${fromUpper} → ${fallbackToken.symbol} on ${srcChain.name}...`);
            sendTyping(chatId);
            try {
              const { getSwapQuote } = await import("./okx-onchainos");
              const quote = await getSwapQuote({ chainId: srcChainId, fromTokenAddress: srcToken.address, toTokenAddress: fallbackToken.address, amount: rawAmt, slippage: "1" });
              const receiveAmt = quote?.data?.[0]?.toTokenAmount ? formatTokenAmount(quote.data[0].toTokenAmount, fallbackToken.decimals) : null;
              if (receiveAmt) {
                pendingOKXSwap.set(chatId, { step: "confirm", chainId: srcChainId, chainName: srcChain.name, fromToken: srcToken.address, fromSymbol: srcToken.symbol, toToken: fallbackToken.address, toSymbol: fallbackToken.symbol, amount: rawAmt, quoteData: quote.data[0] });
                await bot.sendMessage(chatId, `🔄 *Swap Quote on ${srcChain.name}*\n\n💰 ${amount} ${srcToken.symbol} → ${receiveAmt} ${fallbackToken.symbol}\n\nConfirm this swap?`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Swap", callback_data: "okxswap_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } });
              } else {
                await bot.sendMessage(chatId, `No quote available. Try /swap to pick tokens manually.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
              }
            } catch (swapErr: any) {
              await bot.sendMessage(chatId, `Quote error. Try /swap to pick tokens manually.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
            }
          } else {
            await bot.sendMessage(chatId, `Token "${toUpper}" not available on ${srcChain.name}. Try /swap to pick manually.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
          }
          return;
        }
      }

      const missing = !fromToken ? fromUpper : toUpper;
      await bot.sendMessage(chatId, `Token "${missing}" not found on ${chain.name}.\n\nAvailable: ${tokens.map(t => t.symbol).join(", ")}`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }

    const rawAmount = parseHumanAmount(amount, fromToken.decimals);

    await bot.sendMessage(chatId, `🔄 Getting quote: ${amount} ${fromToken.symbol} → ${toToken.symbol} on ${chain.name}...`);
    sendTyping(chatId);

    try {
      const { getSwapQuote } = await import("./okx-onchainos");
      const quote = await getSwapQuote({
        chainId: chainId!,
        fromTokenAddress: fromToken.address,
        toTokenAddress: toToken.address,
        amount: rawAmount,
        slippage: "1",
      });

      const receiveAmount = quote?.data?.[0]?.toTokenAmount
        ? formatTokenAmount(quote.data[0].toTokenAmount, toToken.decimals)
        : "—";

      pendingOKXSwap.set(chatId, {
        step: "confirm",
        chainId: chainId!,
        chainName: chain.name,
        fromToken: fromToken.address,
        fromSymbol: fromToken.symbol,
        toToken: toToken.address,
        toSymbol: toToken.symbol,
        amount: rawAmount,
        quoteData: quote?.data?.[0],
      });

      await bot.sendMessage(chatId,
        `🔄 *Swap Quote*\n\n` +
        `Chain: ${chain.name}\n` +
        `Sell: ${amount} ${fromToken.symbol}\n` +
        `Buy: ~${receiveAmount} ${toToken.symbol}\n\n` +
        `Confirm this swap?`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Confirm Swap", callback_data: "okxswap_confirm" }],
              [{ text: "❌ Cancel", callback_data: "action:menu" }],
            ]
          }
        }
      );
    } catch (err: any) {
      await bot.sendMessage(chatId,
        `Failed to get quote: ${err.message?.substring(0, 100)}\n\nTry again or use the swap menu.`,
        { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
    }
    return;
  }

  const bridgeMatch = text.match(/^bridge\s+([\d.]+)\s*(\w+)\s+(?:from\s+)?(\w+[\w\s]*?)\s+(?:to)\s+(\w+[\w\s]*?)(?:\s+(?:as|receive|get)\s+(\w+))?$/i);
  if (bridgeMatch && !text.startsWith("/")) {
    const [, amount, fromSymbol, fromChainHint, toChainHint, toSymbolHint] = bridgeMatch;

    const chainAliases: Record<string, string> = {
      bnb: "56", bsc: "56", "bnb chain": "56", binance: "56",
      eth: "1", ethereum: "1",
      base: "8453",
      polygon: "137", matic: "137", pol: "137",
      arbitrum: "42161", arb: "42161",
      optimism: "10", op: "10",
      avalanche: "43114", avax: "43114",
      xlayer: "196", okb: "196",
      zksync: "324",
      linea: "59144",
      scroll: "534352",
      fantom: "250", ftm: "250",
      mantle: "5000", mnt: "5000",
      blast: "81457",
      gnosis: "100",
      cronos: "25", cro: "25",
      solana: "501", sol: "501",
    };

    const fromChainId = chainAliases[fromChainHint.toLowerCase().trim()];
    const toChainId = chainAliases[toChainHint.toLowerCase().trim()];

    if (!fromChainId || !toChainId) {
      const supported = Object.keys(chainAliases).filter(k => !k.includes(" ")).join(", ");
      await bot.sendMessage(chatId,
        `Couldn't identify the chains. Try:\n\nbridge 1 BNB from BSC to Ethereum\nbridge 0.5 ETH from Ethereum to Base\n\nSupported: ${supported}`,
        { reply_markup: { inline_keyboard: [[{ text: "🌉 Open Bridge", callback_data: "action:okxbridge" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    if (fromChainId === toChainId) {
      await bot.sendMessage(chatId, `Source and destination chain can't be the same. Did you mean swap?\n\nTry: swap ${amount} ${fromSymbol} for USDT`,
        { reply_markup: { inline_keyboard: [[{ text: "🔄 Swap Instead", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    const fromChain = OKX_CHAINS.find(c => c.id === fromChainId);
    const toChain = OKX_CHAINS.find(c => c.id === toChainId);
    if (!fromChain || !toChain) {
      await bot.sendMessage(chatId, `Chain not supported. Try: bridge 1 BNB from BSC to Ethereum`,
        { reply_markup: { inline_keyboard: [[{ text: "🌉 Open Bridge", callback_data: "action:okxbridge" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    const fromTokens = getOKXTokensForChain(fromChainId);
    const fromToken = fromTokens.find(t => t.symbol.toLowerCase() === fromSymbol.toLowerCase());
    if (!fromToken) {
      await bot.sendMessage(chatId,
        `Token "${fromSymbol.toUpperCase()}" not found on ${fromChain.name}.\n\nAvailable: ${fromTokens.map(t => t.symbol).join(", ")}`,
        { reply_markup: { inline_keyboard: [[{ text: "🌉 Open Bridge", callback_data: "action:okxbridge" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    const toTokens = getOKXTokensForChain(toChainId);
    const toSymbol = toSymbolHint || fromSymbol;
    let toToken = toTokens.find(t => t.symbol.toLowerCase() === toSymbol.toLowerCase());
    if (!toToken) {
      toToken = toTokens.find(t => t.symbol === "USDT" || t.symbol === "USDC") || toTokens[0];
    }

    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId, "You need a wallet first. Setting one up...");
      await autoGenerateWallet(chatId);
    }
    const receiver = getLinkedWallet(chatId) || "";

    const bridgeState: OKXBridgeState = {
      step: "confirm",
      fromChainId, fromChainName: fromChain.name,
      toChainId, toChainName: toChain.name,
      fromToken: fromToken.address, fromSymbol: fromToken.symbol, fromDecimals: fromToken.decimals,
      toToken: toToken.address, toSymbol: toToken.symbol, toDecimals: toToken.decimals,
      amount: amount, receiver,
    };

    pendingOKXBridge.set(chatId, bridgeState);
    await executeBridgeQuote(chatId, bridgeState);
    return;
  }

  const commandMatch = text.match(/^\/(\w+)(?:@\S+)?\s*(.*)/s);
  if (commandMatch) {
    const cmd = commandMatch[1].toLowerCase();
    const cmdArg = commandMatch[2]?.trim() || "";

    pendingAgentCreation.delete(chatId);
    pendingTask.delete(chatId);
    pendingTokenLaunch.delete(chatId);
    pendingFourMemeBuy.delete(chatId);
    pendingFourMemeSell.delete(chatId);
    pendingWallet.delete(chatId);
    pendingImportWallet.delete(chatId);
    pendingAsterConnect.delete(chatId);
    pendingAsterTrade.delete(chatId);
    pendingTxHashVerify.delete(chatId);
    pendingOKXSwap.delete(chatId);
    pendingOKXBridge.delete(chatId);
    pendingOKXScan.delete(chatId);
    pendingOKXPrice.delete(chatId);

    if (cmd === "lang" && !isGroup) {
      await bot.sendMessage(chatId, "🌐 Choose your language / 选择语言 / اختر لغتك：",
        { reply_markup: { inline_keyboard: [
          [{ text: "🇬🇧 English", callback_data: "setlang:en" }, { text: "🇨🇳 中文", callback_data: "setlang:zh" }, { text: "🇸🇦 العربية", callback_data: "setlang:ar" }],
        ]}}
      );
      return;
    }

    if (cmd === "start" && !isGroup) {
      let wallet = getLinkedWallet(chatId);
      const isNewUser = !wallet;
      if (!wallet) {
        const refCode = cmdArg.startsWith("ref_") ? cmdArg : "";
        await bot.sendMessage(chatId,
          `Welcome to BUILD4\n\n` +
          `Launch tokens, create AI agents, and operate on-chain — all from Telegram.\n\n` +
          `Setting up your wallet...`
        );
        wallet = await autoGenerateWallet(chatId);

        if (refCode) {
          try {
            const referrerChatId = refCode.replace("ref_", "");
            if (referrerChatId !== chatId.toString()) {
              const existing = await storage.getReferralByReferred(chatId.toString());
              if (!existing) {
                await storage.createReferral(referrerChatId, chatId.toString(), refCode);
                console.log(`[Referral] ${chatId} referred by ${referrerChatId}`);
              }
            }
          } catch (e: any) {
            console.error("[Referral] Failed to save referral:", e.message);
          }
        }
      }

      let sub: any = null;
      try {
        sub = await storage.getBotSubscriptionByChatId(chatId.toString());
      } catch (e: any) {
        console.error("[Start] Sub check failed:", e.message);
      }

      if (!sub) {
        try {
          sub = await storage.createBotSubscription(wallet!, chatId.toString());
          subCache.delete(chatId);
          console.log(`[Trial] Auto-activated ${TRIAL_DAYS}-day free trial for chatId=${chatId}`);
        } catch (e: any) {
          console.error("[Start] Trial creation failed:", e.message);
        }
      }

      if (sub && (sub.status === "trial" || sub.status === "active") && sub.expiresAt && sub.expiresAt > new Date()) {
        const daysLeft = Math.ceil((sub.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        const statusLabel = sub.status === "trial" ? "Free Trial" : "Active";
        const trialMsg = isNewUser
          ? `🎉 *Your ${TRIAL_DAYS}-day free trial is now active!*\n\n` +
            `✅ Full access to all premium features\n` +
            `⏳ ${daysLeft} days remaining\n\n` +
            `After your trial, subscribe for just *$${BOT_PRICE_USD}/month* to keep access.\n\n` +
            `👛 Wallet: \`${shortWallet(wallet!)}\`\n\nWhat do you want to do?`
          : `Welcome back!\n\n` +
            `📊 Subscription: *${statusLabel}*\n` +
            `⏳ ${daysLeft} days remaining\n` +
            `👛 Wallet: \`${shortWallet(wallet!)}\`\n\n` +
            `What do you want to do?`;
        await bot.sendMessage(chatId, trialMsg, {
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard(undefined, chatId),
        });
      } else if (sub && sub.status === "expired") {
        await bot.sendMessage(chatId,
          `⚠️ *Your subscription has expired*\n\n` +
          `Subscribe for *$${BOT_PRICE_USD}/month* to regain full access to all features.\n\n` +
          `👛 Wallet: \`${shortWallet(wallet!)}\``,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
            [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
            [{ text: "« Menu", callback_data: "action:menu" }],
          ]}}
        );
      } else {
        await bot.sendMessage(chatId,
          isNewUser
            ? `✅ You're all set!\n\nWhat do you want to do?`
            : `Welcome back!\n\n👛 Wallet: ${shortWallet(wallet!)}\n\nWhat do you want to do?`,
          { reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
      }
      return;
    }

    if (cmd === "cancel") {
      pendingChaosPlan.delete(chatId);
      pendingAsterConnect.delete(chatId);
      pendingAsterTrade.delete(chatId);
      pendingTxHashVerify.delete(chatId);
      pendingAgentQuestion.delete(chatId);
      pendingStealthEth.delete(chatId);
      await bot.sendMessage(chatId, "Cancelled.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    if (cmd === "mychatid") {
      const label = isGroup ? "This group's Chat ID" : "Your Chat ID";
      await bot.sendMessage(chatId, `${label}: ${chatId}\n\nPaste this into your agent's Twitter settings for strategy notifications.`);
      return;
    }

    if (cmd === "broadcast" && !isGroup) {
      const adminChatId = process.env.ADMIN_CHAT_ID;
      if (!adminChatId || chatId.toString() !== adminChatId) {
        return;
      }
      const message = text.replace(/^\/broadcast\s*/i, "").trim();
      if (!message) {
        await bot.sendMessage(chatId, "Usage: /broadcast <message>\n\nThis sends to all registered users.");
        return;
      }
      const allChatIds = Array.from(telegramWalletMap.keys());
      let sent = 0;
      let failed = 0;
      await bot.sendMessage(chatId, `Broadcasting to ${allChatIds.length} users...`);
      for (const targetChatId of allChatIds) {
        try {
          await bot.sendMessage(targetChatId, message, { parse_mode: "HTML", disable_web_page_preview: true });
          sent++;
          if (sent % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        } catch {
          failed++;
        }
      }
      await bot.sendMessage(chatId, `Broadcast complete: ${sent} sent, ${failed} failed (${allChatIds.length} total)`);
      return;
    }

    if (cmd === "announce" && !isGroup) {
      const adminChatId = process.env.ADMIN_CHAT_ID;
      if (!adminChatId || chatId.toString() !== adminChatId) return;

      const allChatIds = Array.from(telegramWalletMap.keys());
      const announcementMsg =
        `🚀 <b>BUILD4 Premium is LIVE!</b>\n\n` +
        `We've upgraded BUILD4 with powerful new features:\n\n` +
        `✅ <b>Free Tier</b> — Try signals, security scans & price checks daily (limited)\n` +
        `✅ <b>4-Day Free Trial</b> — Full unlimited access to everything\n` +
        `✅ <b>Premium</b> — $19.99/month for unlimited trading, swaps, bridges, token launches & more\n\n` +
        `💰 <b>Refer & Earn:</b> Share your referral link and earn 30-50% commission on every subscription!\n\n` +
        `Start now 👇`;

      await bot.sendMessage(chatId, `Announcing premium launch to ${allChatIds.length} users...`);
      let sent = 0, failed = 0;
      for (const targetChatId of allChatIds) {
        try {
          await bot.sendMessage(targetChatId, announcementMsg, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [
              [{ text: "🆓 Start Free Trial", callback_data: "action:subscribe" }],
              [{ text: "🔗 Get Referral Link", callback_data: "action:referral" }],
              [{ text: "📊 View Features", callback_data: "action:menu" }],
            ]}
          });
          sent++;
          if (sent % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        } catch { failed++; }
      }
      await bot.sendMessage(chatId, `Announcement sent: ${sent} delivered, ${failed} failed (${allChatIds.length} total)`);
      return;
    }

    if (cmd === "stats" && !isGroup) {
      const adminChatIdStats = process.env.ADMIN_CHAT_ID;
      if (!adminChatIdStats || chatId.toString() !== adminChatIdStats) {
        return;
      }
      try {
        const totalUsers = telegramWalletMap.size;

        let platformStats = { agents: 0, onchainAgents: 0, skills: 0, transactions: 0, onchainUsers: 0, totalRevenue: "0" };
        try {
          const statsRes = await fetch(`http://localhost:${process.env.PORT || 5000}/api/platform/stats`);
          if (statsRes.ok) {
            const contentType = statsRes.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
              platformStats = await statsRes.json() as any;
            }
          }
        } catch {}

        const revenueWei = BigInt(platformStats.totalRevenue || "0");
        const revenueBNB = Number(revenueWei) / 1e18;

        let subStats = { total: 0, active: 0, trial: 0, expired: 0 };
        let refStats = { totalReferrals: 0, paidReferrals: 0, totalCommissions: "0.00" };
        try {
          const subs = await storage.getAllBotSubscriptions?.() || [];
          subStats.total = subs.length;
          subStats.active = subs.filter((s: any) => s.status === "active" && s.expiresAt && s.expiresAt > new Date()).length;
          subStats.trial = subs.filter((s: any) => s.status === "trial" && s.expiresAt && s.expiresAt > new Date()).length;
          subStats.expired = subs.length - subStats.active - subStats.trial;
        } catch {}
        try {
          const refs = await storage.getAllReferrals?.() || [];
          refStats.totalReferrals = refs.length;
          refStats.paidReferrals = refs.filter((r: any) => r.commissionPaid).length;
          refStats.totalCommissions = refs
            .filter((r: any) => r.commissionPaid && r.commissionAmount)
            .reduce((sum: number, r: any) => sum + parseFloat(r.commissionAmount || "0"), 0)
            .toFixed(2);
        } catch {}

        await bot.sendMessage(chatId,
          `📊 <b>BUILD4 Admin Dashboard</b>\n\n` +
          `<b>👥 Users</b>\n` +
          `• Telegram Users: <b>${totalUsers}</b>\n` +
          `• Unique Wallets: <b>${platformStats.onchainUsers || 0}</b>\n\n` +
          `<b>⭐ Subscriptions</b>\n` +
          `• Total: <b>${subStats.total}</b>\n` +
          `• Active (paid): <b>${subStats.active}</b>\n` +
          `• Trial: <b>${subStats.trial}</b>\n` +
          `• Expired: <b>${subStats.expired}</b>\n\n` +
          `<b>🔗 Referrals</b>\n` +
          `• Total referrals: <b>${refStats.totalReferrals}</b>\n` +
          `• Paid commissions: <b>${refStats.paidReferrals}</b>\n` +
          `• Total commissions owed: <b>$${refStats.totalCommissions}</b>\n\n` +
          `<b>💰 Revenue Model</b>\n` +
          `• Subscription price: <b>$${BOT_PRICE_USD}/mo</b>\n` +
          `• Transaction fee: <b>${TRANSACTION_FEE_PERCENT}%</b>\n` +
          `• Free tier actions today: <b>${freeTierUsage.size} tracked</b>\n\n` +
          `<b>🤖 Platform</b>\n` +
          `• AI Agents: <b>${platformStats.agents || 0}</b>\n` +
          `• On-Chain Agents: <b>${platformStats.onchainAgents || 0}</b>\n` +
          `• Skills: <b>${platformStats.skills || 0}</b>\n` +
          `• Transactions: <b>${platformStats.transactions || 0}</b>\n` +
          `• Revenue: <b>${revenueBNB.toFixed(4)} BNB</b>\n\n` +
          `🔗 Chains: BNB, Base, XLayer, Solana`,
          { parse_mode: "HTML", reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
      } catch (e: any) {
        await bot.sendMessage(chatId, `Could not fetch stats: ${e.message?.substring(0, 100)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
      }
      return;
    }

    if (cmd === "activatesub" && !isGroup) {
      const adminChatIdAct = process.env.ADMIN_CHAT_ID;
      if (!adminChatIdAct || chatId.toString() !== adminChatIdAct) return;
      const parts = text.split(/\s+/);
      const targetWallet = parts[1];
      const targetTxHash = parts[2] || "manual-admin-" + Date.now();
      const targetChainId = parseInt(parts[3] || "56");
      const targetAmount = parts[4] || "19.99";
      if (!targetWallet || !targetWallet.startsWith("0x")) {
        await bot.sendMessage(chatId, "Usage: /activatesub <wallet> [txHash] [chainId] [amount]\n\nExample:\n/activatesub 0x7cfe... 0xbcaf... 56 19.99");
        return;
      }
      try {
        let sub = await storage.getBotSubscription(targetWallet);
        if (!sub) {
          const allSubs = await storage.getAllBotSubscriptions();
          sub = allSubs.find((s: any) => s.walletAddress?.toLowerCase() === targetWallet.toLowerCase()) || null;
        }
        if (!sub) {
          const chatIdForSub = parts[5] || chatId.toString();
          await storage.createBotSubscription(targetWallet, chatIdForSub);
          console.log(`[Admin] Created subscription for ${targetWallet}`);
        }
        const activated = await storage.activateBotSubscription(targetWallet, targetTxHash, targetChainId, targetAmount);
        if (activated) {
          await bot.sendMessage(chatId, `✅ Subscription activated!\n\nWallet: \`${targetWallet}\`\nTX: \`${targetTxHash.substring(0, 20)}...\`\nChain: ${targetChainId}\nAmount: $${targetAmount}`, { parse_mode: "Markdown" });
        } else {
          await bot.sendMessage(chatId, `❌ Failed to activate. Wallet: ${targetWallet}`);
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 200)}`);
      }
      return;
    }

    if (cmd === "auditlog" && !isGroup) {
      const adminChatIdAudit = process.env.ADMIN_CHAT_ID;
      if (!adminChatIdAudit || chatId.toString() !== adminChatIdAudit) return;
      const recent = securityAuditLog.slice(-20).reverse();
      if (recent.length === 0) {
        await bot.sendMessage(chatId, "No security audit events yet.");
        return;
      }
      let text = `🔒 <b>Security Audit Log</b> (last ${recent.length})\n\n`;
      for (const e of recent) {
        const time = new Date(e.ts).toISOString().replace("T", " ").substring(0, 19);
        text += `<code>${time}</code>\n<b>${e.action}</b> | user ${e.chatId}\n${e.detail}\n\n`;
      }
      await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
      return;
    }

    if (cmd === "agentstatus") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to check agent status!"); return; }
      await ensureWallet(chatId);
      const wallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);
      const walletAddr = wallets[activeIdx];
      if (!walletAddr) {
        await bot.sendMessage(chatId, "No wallet found. Use /wallet to set one up first.");
        return;
      }

      await bot.sendMessage(chatId, "Checking ERC-8004 agent registration...");

      try {
        const { isAgentRegistered, ERC8004_IDENTITY_REGISTRY_BSC } = await import("./token-launcher");
        const registered = await isAgentRegistered(walletAddr);

        if (registered) {
          await bot.sendMessage(chatId,
            "✅ AI Agent Badge: ACTIVE\n\n" +
            `Wallet: ${walletAddr.substring(0, 8)}...${walletAddr.slice(-6)}\n` +
            `Registry: ERC-8004 on BSC\n` +
            `Contract: ${ERC8004_IDENTITY_REGISTRY_BSC.substring(0, 10)}...\n\n` +
            "Your tokens launched on Four.meme will show the AI Agent icon on GMGN and other trackers.",
            { reply_markup: mainMenuKeyboard(undefined, chatId) }
          );
        } else {
          await bot.sendMessage(chatId,
            "❌ AI Agent Badge: NOT REGISTERED\n\n" +
            `Wallet: ${walletAddr.substring(0, 8)}...${walletAddr.slice(-6)}\n\n` +
            "Your wallet is not registered on the ERC-8004 Identity Registry. " +
            "When you launch a token, we'll auto-register your wallet so it gets the AI Agent badge on GMGN.\n\n" +
            "Want to register now? It costs a small gas fee (~0.001 BNB).",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🤖 Register Now", callback_data: "erc8004_register" }],
                  [{ text: "« Back", callback_data: "main_menu" }],
                ],
              },
            }
          );
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `Error checking status: ${e.message?.substring(0, 100) || "Unknown error"}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
      }
      return;
    }

    if (cmd === "help") {
      const hasW = !!getLinkedWallet(chatId);
      await bot.sendMessage(chatId,
        "Commands:\n\n" +
        "🚀 /launch — Launch a token\n" +
        "💰 /buy — Buy tokens on Four.meme\n" +
        "💸 /sell — Sell tokens on Four.meme\n" +
        "📈 /tokeninfo — Token price & info\n" +
        "🔥 /chaos — Create a chaos plan\n" +
        "📊 /chaosstatus — Check chaos plan status\n" +
        "📈 /trade — Autonomous trading agent\n" +
        "📊 /tradestatus — Trading positions & PnL\n" +
        "🔄 /swap — OKX DEX swap (multi-chain)\n" +
        "🌉 /bridge — OKX cross-chain bridge\n" +
        "🐋 /signals — Smart money & whale signals\n" +
        "🔒 /scan — Security scanner (honeypot check)\n" +
        "🔥 /trending — Hot & trending tokens\n" +
        "🐸 /meme — Meme token scanner\n" +
        "📊 /price — Token price lookup\n" +
        "⛽ /gas — Gas prices by chain\n" +
        "📈 /aster — Aster DEX futures & spot trading\n" +
        "🤖 /newagent — Create an AI agent\n" +
        "📋 /myagents — Your agents\n" +
        "📝 /task — Assign a task\n" +
        "📊 /mytasks — Recent tasks\n" +
        "👛 /wallet — Wallet info\n" +
        "🔗 /linkwallet — Connect wallet\n" +
        "🤖 /agentstatus — AI agent badge status\n" +
        "❓ /ask <question> — Ask anything\n" +
        "🔔 /mychatid — Chat ID for notifications\n" +
        "❌ /cancel — Cancel current action\n\n" +
        "Or just type any question!",
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
      return;
    }

    if (cmd === "wallet") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for wallet info!"); return; }
      await ensureWallet(chatId);
      const wallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);

      await bot.sendMessage(chatId, "Loading wallet balances...");
      const balances = await fetchWalletBalances(wallets);

      let text = `👛 Your Wallets\n\n`;
      wallets.forEach((w, i) => {
        const marker = i === activeIdx ? "✅" : "⬜";
        const bal = balances[w];
        const hasKey = walletsWithKey.has(`${chatId}:${w}`);
        const keyTag = hasKey ? "" : " 🔒 view-only";
        let balText = "";
        if (bal) {
          const parts: string[] = [];
          if (parseFloat(bal.bnb) > 0) parts.push(`${bal.bnb} BNB`);
          if (parseFloat(bal.eth) > 0) parts.push(`${bal.eth} ETH`);
          balText = parts.length > 0 ? ` (${parts.join(", ")})` : " (empty)";
        }
        text += `${marker} \`${w}\`${i === activeIdx ? " ← active" : ""}${keyTag}\n    ${balText}\n\n`;
      });
      text += `Send BNB to your active wallet address to fund it.`;

      const walletButtons: TelegramBot.InlineKeyboardButton[][] = wallets.map((w, i) => {
        if (i === activeIdx) {
          return [{ text: `📋 Copy Address`, callback_data: `copywall:${i}` }];
        }
        return [
          { text: `▶️ Use ${shortWallet(w)}`, callback_data: `switchwall:${i}` },
          { text: `🗑`, callback_data: `removewall:${i}` },
        ];
      });
      walletButtons.push([{ text: "🔑 Add Wallet", callback_data: "action:genwallet" }]);
      walletButtons.push([{ text: "◀️ Menu", callback_data: "action:menu" }]);

      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: walletButtons } });
      return;
    }

    if (cmd === "info") {
      await bot.sendMessage(chatId,
        "BUILD4 is decentralized infrastructure for autonomous AI agents on BNB Chain, Base, and XLayer.\n\n" +
        "Agents get wallets, trade skills, evolve, replicate, and operate fully on-chain. No centralized AI — inference runs through Hyperbolic, Akash ML, and Ritual.\n\nhttps://build4.io",
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
      return;
    }

    if (cmd === "chains") {
      await bot.sendMessage(chatId, "Supported Chains:\n\n- BNB Chain — ERC-8004 identity + BAP-578 NFA registry\n- XLayer — Agent economy\n\nAll on-chain.");
      return;
    }

    if (cmd === "contracts") {
      await bot.sendMessage(chatId, "4 Smart Contracts:\n\n1. AgentEconomyHub — Wallets\n2. SkillMarketplace — Skill trading\n3. AgentReplication — Forking + NFTs\n4. ConstitutionRegistry — Agent laws\n\nSolidity 0.8.24 + OpenZeppelin.");
      return;
    }

    if (cmd === "ask") {
      if (!cmdArg) {
        await bot.sendMessage(chatId, "What would you like to know? Type /ask followed by your question.");
        return;
      }
      await handleQuestion(chatId, msg.message_id, cmdArg, username);
      return;
    }

    if (cmd === "linkwallet") {
      await ensureWallet(chatId);
      await bot.sendMessage(chatId, "Your wallet is ready.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    if (cmd === "newagent") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to create agents!"); return; }
      await ensureWallet(chatId);
      pendingAgentCreation.set(chatId, { step: "name" });
      await bot.sendMessage(chatId, "What's your agent's name? (1-50 characters)");
      return;
    }

    if (cmd === "myagents") {
      const wallet = await ensureWallet(chatId);
      await handleMyAgents(chatId, wallet);
      return;
    }

    if (cmd === "task") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to assign tasks!"); return; }
      const wallet = await ensureWallet(chatId);
      await startTaskFlow(chatId, wallet);
      return;
    }

    if (cmd === "launch") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to launch tokens!"); return; }
      const wallet = await ensureWallet(chatId);
      await startTokenLaunchFlow(chatId, wallet);
      return;
    }

    if (cmd === "buy") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to buy tokens!"); return; }
      const wallet = await ensureWallet(chatId);
      if (!await checkWalletHasKey(chatId, wallet)) {
        await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first (/linkwallet).");
        return;
      }
      if (cmdArg && /^0x[a-fA-F0-9]{40}$/i.test(cmdArg)) {
        pendingFourMemeBuy.set(chatId, { step: "amount", tokenAddress: cmdArg.toLowerCase() });
        await bot.sendMessage(chatId, `How much BNB do you want to spend?\n\nEnter an amount (e.g. 0.01, 0.1, 1):`);
      } else {
        pendingFourMemeBuy.set(chatId, { step: "token" });
        await bot.sendMessage(chatId, "Enter the token contract address you want to buy (0x...):");
      }
      return;
    }

    if (cmd === "sell") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me to sell tokens!"); return; }
      const wallet = await ensureWallet(chatId);
      if (!await checkWalletHasKey(chatId, wallet)) {
        await bot.sendMessage(chatId, "Your active wallet is view-only. Import a wallet with a private key first (/linkwallet).");
        return;
      }
      if (cmdArg && /^0x[a-fA-F0-9]{40}$/i.test(cmdArg)) {
        pendingFourMemeSell.set(chatId, { step: "amount", tokenAddress: cmdArg.toLowerCase() });
        await showSellAmountPrompt(chatId, cmdArg.toLowerCase());
      } else {
        pendingFourMemeSell.set(chatId, { step: "token" });
        await bot.sendMessage(chatId, "Enter the token contract address you want to sell (0x...):");
      }
      return;
    }

    if (cmd === "tokeninfo") {
      if (!cmdArg || !/^0x[a-fA-F0-9]{40}$/i.test(cmdArg)) {
        await bot.sendMessage(chatId, "Usage: /tokeninfo <token_address>\n\nExample: /tokeninfo 0x1234...abcd");
        return;
      }
      await handleTokenInfo(chatId, cmdArg);
      return;
    }

    if (cmd === "taskstatus") {
      const wallet = await ensureWallet(chatId);
      if (!cmdArg) { await bot.sendMessage(chatId, "Usage: /taskstatus <task-id>"); return; }
      await handleTaskStatus(chatId, cmdArg, wallet);
      return;
    }

    if (cmd === "mytasks") {
      const wallet = await ensureWallet(chatId);
      await handleMyTasks(chatId, wallet);
      return;
    }

    if (cmd === "chaosstatus") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for chaos plan status!"); return; }
      await ensureWallet(chatId);
      const wallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);
      const walletAddr = wallets[activeIdx];
      if (!walletAddr) {
        await bot.sendMessage(chatId, "No wallet found. Use /wallet first.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }

      try {
        const { getUserChaosPlans } = await import("./chaos-launch");
        const plans = await getUserChaosPlans(walletAddr);

        if (plans.length === 0) {
          const { getActiveChaosPlan } = await import("./chaos-launch");
          const globalPlan = await storage.getActiveChaosPlan();
          if (globalPlan) {
            const completed = globalPlan.milestones.filter(m => m.status === "completed").length;
            const pending = globalPlan.milestones.filter(m => m.status === "pending").length;
            const failed = globalPlan.milestones.filter(m => m.status === "failed").length;
            const next = globalPlan.milestones.find(m => m.status === "pending");
            let text = `📊 *$${globalPlan.launch.tokenSymbol} Chaos Plan*\n\n`;
            text += `✅ Completed: ${completed}/${globalPlan.milestones.length}\n`;
            text += `⏳ Pending: ${pending}\n`;
            if (failed > 0) text += `❌ Failed: ${failed}\n`;
            if (next) {
              const launchTime = globalPlan.launch.createdAt ? new Date(globalPlan.launch.createdAt).getTime() : 0;
              const eta = launchTime + next.triggerAfterMinutes * 60000;
              const etaDate = new Date(eta);
              text += `\nNext: ${next.name} (${next.action})\nETA: ${etaDate.toUTCString()}`;
            }
            await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
          } else {
            await bot.sendMessage(chatId, "No active chaos plans found. Use /chaos to create one!", { reply_markup: mainMenuKeyboard(undefined, chatId) });
          }
          return;
        }

        for (const { launch, milestones } of plans) {
          const completed = milestones.filter(m => m.status === "completed").length;
          const pending = milestones.filter(m => m.status === "pending").length;
          const failed = milestones.filter(m => m.status === "failed").length;
          const next = milestones.find(m => m.status === "pending");

          let text = `📊 *$${launch.tokenSymbol} Chaos Plan*\n\n`;
          text += `✅ Completed: ${completed}/${milestones.length}\n`;
          text += `⏳ Pending: ${pending}\n`;
          if (failed > 0) text += `❌ Failed: ${failed}\n`;
          if (next) {
            const launchTime = launch.createdAt ? new Date(launch.createdAt).getTime() : 0;
            const eta = launchTime + next.triggerAfterMinutes * 60000;
            const etaDate = new Date(eta);
            text += `\nNext: ${next.name} (${next.action})\nETA: ${etaDate.toUTCString()}`;
          } else if (pending === 0) {
            text += `\n🎉 Plan complete!`;
          }

          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `Error checking status: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
      }
      return;
    }

    if (cmd === "trade") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for trading agent!"); return; }
      await ensureWallet(chatId);
      const wallet = getLinkedWallet(chatId);
      if (!await checkWalletHasKey(chatId, wallet)) {
        await bot.sendMessage(chatId, "You need a wallet with a private key to use the trading agent. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }

      const { getUserTradingStatus } = await import("./trading-agent");
      const { config, positions } = getUserTradingStatus(chatId);
      const isEnabled = config.enabled;

      let statusLine = isEnabled
        ? `Status: ✅ ACTIVE | Open Positions: ${positions.length}`
        : `Status: ⏸ DISABLED`;

      const toggleBtn = isEnabled
        ? { text: "⏸ Disable Trading", callback_data: "trade:disable" }
        : { text: "▶️ Enable Trading", callback_data: "trade:enable" };

      await bot.sendMessage(chatId,
        `💎 *Make Me Rich — Autonomous Trading Agent*\n\n${statusLine}\n\nThe agent scans Four.meme for new token launches, evaluates momentum signals, and trades automatically from your wallet.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [toggleBtn],
              [{ text: "📊 Status", callback_data: "trade:status" }, { text: "⚙️ Settings", callback_data: "trade:settings" }],
              [{ text: "🧩 Agent Skills", callback_data: "trade:skills" }],
              [{ text: "📜 History", callback_data: "trade:history" }, { text: "🔴 Close All", callback_data: "trade:closeall" }],
              [{ text: "« Back", callback_data: "main_menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "tradestatus") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for trade status!"); return; }
      const { getUserTradingStatus } = await import("./trading-agent");
      const { config, positions } = getUserTradingStatus(chatId);

      let msg = `📊 *Trading Agent*\n\n`;
      msg += `Status: ${config.enabled ? "✅ ACTIVE" : "⏸ DISABLED"}\n`;
      msg += `Open Positions: ${positions.length}\n`;
      if (positions.length > 0) {
        msg += `\n`;
        for (const p of positions) {
          const age = Math.floor((Date.now() - p.entryTime) / 60000);
          msg += `  • $${p.tokenSymbol} — ${p.entryPriceBnb} BNB (${age}m ago)\n`;
        }
      }

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    if (cmd === "smartmoney") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for smart money info!"); return; }
      const { getDiscoveredSmartWallets } = await import("./trading-agent");
      const wallets = getDiscoveredSmartWallets();
      if (wallets.length === 0) {
        await bot.sendMessage(chatId, "🧠 *Smart Money Discovery*\n\nNo smart wallets discovered yet. The system analyzes graduated Four.meme tokens every 5 minutes to find consistently profitable early buyers.\n\nCheck back soon!", { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }
      let msg = `🧠 *Smart Money Discovery*\n\nTracking ${wallets.length} discovered wallets:\n\n`;
      for (const w of wallets.slice(0, 15)) {
        const shortAddr = w.address.substring(0, 6) + "..." + w.address.substring(38);
        const winRate = w.totalTrades > 0 ? Math.round((w.winCount / w.totalTrades) * 100) : 0;
        msg += `• \`${shortAddr}\` — ${winRate}% win (${w.winCount}/${w.totalTrades}) score: ${w.score}\n`;
      }
      msg += `\nTheir new buys are automatically tracked and boost token scores.`;
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    if (cmd === "swap") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for OKX DEX swap!"); return; }
      pendingOKXSwap.set(chatId, { step: "chain" });
      pendingOKXBridge.delete(chatId);
      const chainButtons = OKX_CHAINS.map(c => [{ text: `${c.name} (${c.symbol})`, callback_data: `okxswap_chain:${c.id}` }]);
      chainButtons.push([{ text: "« Back", callback_data: "action:menu" }]);
      await bot.sendMessage(chatId,
        "🔄 *OKX DEX Swap*\n\nSwap tokens on any chain using OKX DEX Aggregator.\nSupported: BNB Chain, XLayer, Ethereum, Base, Polygon, Arbitrum, Avalanche, Optimism & more.\n\nSelect a chain:",
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
      );
      return;
    }

    if (cmd === "bridge") {
      pendingOKXBridge.set(chatId, { step: "from_chain" });
      const chainButtons = OKX_CHAINS.map(c => [{ text: `${c.name} (${c.symbol})`, callback_data: `okxbridge_from:${c.id}` }]);
      chainButtons.push([{ text: "« Back", callback_data: "action:menu" }]);
      await bot.sendMessage(chatId,
        "🌉 *Cross-Chain Bridge*\n\nPowered by Li.Fi — best routes across 20+ bridges.\n\nSelect the *source chain*:",
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
      );
      return;
    }

    if (cmd === "signals") {
      await bot.sendMessage(chatId,
        "🐋 *Smart Money Signals*\n\nSelect signal type:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🐋 Whale Buys", callback_data: "okxsig:whale" }],
              [{ text: "🎤 KOL Buys", callback_data: "okxsig:kol" }],
              [{ text: "💰 Smart Money", callback_data: "okxsig:smart" }],
              [{ text: "🏆 Leaderboard", callback_data: "okxsig:leaderboard" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "scan") {
      await bot.sendMessage(chatId,
        "🔒 *Security Scanner*\n\nScan a token for honeypot risks and contract safety.\n\nSelect chain:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "BNB Chain", callback_data: "okxscan_chain:56" }, { text: "Ethereum", callback_data: "okxscan_chain:1" }],
              [{ text: "Base", callback_data: "okxscan_chain:8453" }, { text: "XLayer", callback_data: "okxscan_chain:196" }],
              [{ text: "Solana", callback_data: "okxscan_chain:501" }, { text: "Polygon", callback_data: "okxscan_chain:137" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "trending") {
      await bot.sendMessage(chatId,
        "🔥 *Trending & Hot Tokens*\n\nSelect view:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔥 Hot Tokens (Volume)", callback_data: "okxtrend:hot:4" }],
              [{ text: "📈 Price Gainers", callback_data: "okxtrend:hot:1" }],
              [{ text: "📉 Price Losers", callback_data: "okxtrend:hot:2" }],
              [{ text: "🆕 Newly Listed", callback_data: "okxtrend:hot:3" }],
              [{ text: "🌊 Trending (Solana)", callback_data: "okxtrend:chain:solana" }],
              [{ text: "🌊 Trending (BNB)", callback_data: "okxtrend:chain:bsc" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "meme") {
      await bot.sendMessage(chatId,
        "🐸 *Meme Token Scanner*\n\nScan new meme token launches.\n\nSelect filter:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🆕 New Launches", callback_data: "okxmeme:NEW" }],
              [{ text: "🎓 Graduated", callback_data: "okxmeme:GRADUATED" }],
              [{ text: "🔥 Bonding (Active)", callback_data: "okxmeme:BONDING" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "gas") {
      await bot.sendMessage(chatId,
        "⛽ *Gas Prices*\n\nSelect chain:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "BNB Chain", callback_data: "okxgas:56" }, { text: "Ethereum", callback_data: "okxgas:1" }],
              [{ text: "Base", callback_data: "okxgas:8453" }, { text: "XLayer", callback_data: "okxgas:196" }],
              [{ text: "Polygon", callback_data: "okxgas:137" }, { text: "Arbitrum", callback_data: "okxgas:42161" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "price") {
      await bot.sendMessage(chatId,
        "📊 *Token Price Lookup*\n\nSelect chain:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "BNB Chain", callback_data: "okxprice_chain:56" }, { text: "Ethereum", callback_data: "okxprice_chain:1" }],
              [{ text: "Base", callback_data: "okxprice_chain:8453" }, { text: "XLayer", callback_data: "okxprice_chain:196" }],
              [{ text: "Solana", callback_data: "okxprice_chain:501" }, { text: "Polygon", callback_data: "okxprice_chain:137" }],
              [{ text: "« Back", callback_data: "action:menu" }],
            ],
          },
        }
      );
      return;
    }

    if (cmd === "aster") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for Aster DEX trading!"); return; }
      await handleAsterMenu(chatId);
      return;
    }

    if (cmd === "chaos") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for chaos plans!"); return; }
      await ensureWallet(chatId);
      const wallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);
      const walletAddr = wallets[activeIdx];
      if (!walletAddr) {
        await bot.sendMessage(chatId, "You need a wallet first. Use /wallet to set one up.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }
      const hasKey = walletsWithKey.has(`${chatId}:${walletAddr}`);
      if (!hasKey) {
        await bot.sendMessage(chatId, "You need a wallet with a private key to run a chaos plan. Generate one with /wallet first.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }

      pendingAgentCreation.delete(chatId);
      pendingTask.delete(chatId);
      pendingTokenLaunch.delete(chatId);
      pendingFourMemeBuy.delete(chatId);
      pendingFourMemeSell.delete(chatId);
      pendingChaosPlan.set(chatId, { step: "token_address", walletAddress: walletAddr });

      await bot.sendMessage(chatId,
        "🔥 *Project Chaos — Autonomous Token Plan*\n\n" +
        "Your agent will generate a custom 13-milestone chaos plan for any token you hold.\n\n" +
        "The plan includes burns, airdrops, and dramatic tweets — all executed autonomously over 7 days.\n\n" +
        "Send the *token contract address* on BNB Chain that you want to create a plan for:",
        { parse_mode: "Markdown" }
      );
      return;
    }

    return;
  }

  let question = "";

  if (isGroup) {
    const mentionsBotEntity = msg.entities?.some((e: any) =>
      e.type === "mention" && botUsername &&
      text.substring(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername.toLowerCase()}`
    );
    const mentionsBotText = botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);

    if (mentionsBotEntity || mentionsBotText) {
      question = botUsername
        ? text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim()
        : text;
    } else {
      return;
    }
  } else {
    if (shouldIgnoreMessage(text, msg)) return;
    question = text;
  }

  if (!question) return;

  await handleQuestion(chatId, msg.message_id, question, username);
}

function shouldIgnoreMessage(text: string, msg: TelegramBot.Message): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  if (/^0x[a-fA-F0-9]{40,64}$/i.test(t)) return true;
  if (/^[a-fA-F0-9]{64}$/i.test(t)) return true;
  if (t.startsWith("{") || t.startsWith("[")) return true;
  if ((t.match(/0x[a-fA-F0-9]{10,}/g) || []).length > 1) return true;
  if (msg.forward_from || msg.forward_sender_name) return true;
  return false;
}

async function handleImportWalletFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const input = sanitizeInput(text);

  if (/^0x[a-fA-F0-9]{64}$/i.test(input)) {
    try {
      const wallet = new ethers.Wallet(input);
      const addr = wallet.address.toLowerCase();
      linkTelegramWallet(chatId, addr, input);
      pendingImportWallet.delete(chatId);
      auditLog(chatId, "WALLET_IMPORT", `EVM wallet imported: ${maskAddress(addr)}`);

      await bot.sendMessage(chatId,
        `✅ Wallet imported!\n\nAddress: \`${addr}\`\n\n` +
        `⚠️ *Delete your private key from this chat for safety!*\n` +
        `Tap and hold the message above → Delete`,
        { parse_mode: "Markdown" }
      );
      await bot.sendMessage(chatId,
        "What would you like to do?",
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
    } catch {
      await bot.sendMessage(chatId, "Invalid private key. Please try again or type /cancel.");
    }
    return;
  }

  if (/^0x[a-fA-F0-9]{40}$/i.test(input)) {
    const addr = input.toLowerCase();
    linkTelegramWallet(chatId, addr);
    pendingImportWallet.delete(chatId);
    auditLog(chatId, "WALLET_LINK", `View-only wallet linked: ${maskAddress(addr)}`);

    await bot.sendMessage(chatId,
      `✅ Wallet linked (view-only)!\n\nAddress: \`${addr}\``,
      { parse_mode: "Markdown" }
    );
    await bot.sendMessage(chatId,
      "What would you like to do?",
      { reply_markup: mainMenuKeyboard(undefined, chatId) }
    );
    return;
  }

  await bot.sendMessage(chatId,
    "That doesn't look like a valid wallet address or private key.\n\n" +
    "• Private key: 0x + 64 hex characters\n" +
    "• Address: 0x + 40 hex characters\n\n" +
    "Try again or type /cancel."
  );
}

async function handleAgentCreationFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingAgentCreation.get(chatId)!;

  if (state.step === "name") {
    const name = text.trim();
    if (name.length < 1 || name.length > 50) {
      await bot.sendMessage(chatId, "Name must be 1-50 characters. Try again:");
      return;
    }
    const existing = await storage.getAgentByName(name);
    if (existing) {
      await bot.sendMessage(chatId, `"${name}" is taken. Pick another name:`);
      return;
    }
    state.name = name;
    state.step = "bio";
    pendingAgentCreation.set(chatId, state);
    await bot.sendMessage(chatId, `Agent: ${name}\n\nShort bio — what does it do? (max 300 chars)\n\nExample: "DeFi analyst tracking yield opportunities across BNB Chain"`);
    return;
  }

  if (state.step === "bio") {
    const bio = text.trim();
    if (bio.length > 300) {
      await bot.sendMessage(chatId, `${bio.length}/300 chars — make it shorter:`);
      return;
    }
    state.bio = bio;
    state.step = "model";
    pendingAgentCreation.set(chatId, state);
    await bot.sendMessage(chatId, "Pick your AI model:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Llama 70B — Fast", callback_data: "model:llama" }],
          [{ text: "DeepSeek V3 — Strong reasoning", callback_data: "model:deepseek" }],
          [{ text: "Qwen 72B — Multilingual", callback_data: "model:qwen" }],
        ]
      }
    });
    return;
  }
}

const AGENT_HIRE_FEE_BNB = "0.032";

async function collectAgentHireFee(chatId: number, walletAddress: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const treasuryPk = process.env.BOUNTY_WALLET_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || process.env.CHAOS_AGENT_PRIVATE_KEY;
  if (!treasuryPk) return { success: false, error: "No treasury configured" };

  let treasury: string;
  try {
    const { ethers } = await import("ethers");
    treasury = new ethers.Wallet(treasuryPk).address;
  } catch {
    return { success: false, error: "Invalid treasury key" };
  }

  const userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), walletAddress);
  if (!userPk) return { success: false, error: "No wallet key found" };

  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
    const wallet = new ethers.Wallet(userPk, provider);

    if (wallet.address.toLowerCase() === treasury.toLowerCase()) {
      return { success: true };
    }

    const feeWei = ethers.parseEther(AGENT_HIRE_FEE_BNB);
    const balance = await provider.getBalance(wallet.address);

    if (balance < feeWei + ethers.parseEther("0.001")) {
      const bal = ethers.formatEther(balance);
      return { success: false, error: `Insufficient BNB. You have ${bal} BNB but need ${AGENT_HIRE_FEE_BNB} BNB ($20). Fund your wallet and try again.` };
    }

    const tx = await wallet.sendTransaction({
      to: treasury,
      value: feeWei,
      gasLimit: 21000,
    });

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      return { success: false, error: "Payment transaction reverted" };
    }

    return { success: true, txHash: receipt.hash };
  } catch (e: any) {
    return { success: false, error: e.message?.substring(0, 120) || "Payment failed" };
  }
}

async function ensureUserHasAgent(chatId: number): Promise<boolean> {
  const wallet = getLinkedWallet(chatId);
  if (!wallet) return false;
  try {
    const agents = await storage.getAgentsByWallet(wallet);
    return agents.length > 0;
  } catch {
    return true;
  }
}

async function getUserAgent(chatId: number): Promise<{ id: string; name: string; bio: string | null; modelType: string } | null> {
  const wallet = getLinkedWallet(chatId);
  if (!wallet) return null;
  try {
    const agents = await storage.getAgentsByWallet(wallet);
    return agents[0] || null;
  } catch {
    return null;
  }
}

async function agentAnalyze(chatId: number, context: string, question: string): Promise<string | null> {
  const agent = await getUserAgent(chatId);
  if (!agent) return null;
  try {
    const { runInferenceWithFallback } = await import("./inference");
    const systemPrompt = `You are ${agent.name}, an autonomous AI trading agent on BUILD4.\n` +
      `Bio: ${agent.bio || "AI trading agent"}\n` +
      `You analyze crypto data and give concise, actionable insights.\n` +
      `Keep responses under 200 words. Be specific, direct, and data-driven.\n` +
      `Always end with a clear recommendation or key takeaway.`;

    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic"],
      undefined,
      `${context}\n\nQuestion: ${question}`,
      { systemPrompt, temperature: 0.5, maxTokens: 400 }
    );

    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      return `🤖 *${agent.name}'s Analysis:*\n\n${result.text.trim()}`;
    }
  } catch (e: any) {
    console.error(`[AgentAnalyze] Error for chatId=${chatId}:`, e.message?.substring(0, 100));
  }
  return null;
}

async function createAgent(chatId: number, name: string, bio: string, model: string, freeCreation?: boolean): Promise<void> {
  if (!bot) return;
  const wallet = getLinkedWallet(chatId);
  if (!wallet) return;

  pendingAgentCreation.delete(chatId);

  try {
    await bot.sendChatAction(chatId, "typing");

    if (!freeCreation) {
      await bot.sendMessage(chatId,
        `💳 Agent creation costs $20 (${AGENT_HIRE_FEE_BNB} BNB).\n\nProcessing payment from your wallet...`
      );

      const feeResult = await collectAgentHireFee(chatId, wallet);
      if (!feeResult.success) {
        await bot.sendMessage(chatId,
          `❌ Payment failed: ${feeResult.error}\n\nAgent creation requires $20 (${AGENT_HIRE_FEE_BNB} BNB). Make sure your wallet has enough BNB.`,
          { reply_markup: { inline_keyboard: [[{ text: "My Wallet", callback_data: "action:wallet" }, { text: "Menu", callback_data: "action:menu" }]] } }
        );
        return;
      }
    }

    const initialDeposit = "1000000000000000";
    const result = await storage.createFullAgent(name, bio, model, initialDeposit, undefined, undefined, wallet);
    const agentId = result.agent.id;

    let msg = `✅ *Agent Created!*\n\n` +
      `🤖 *${result.agent.name}*\n` +
      `Model: ${shortModel(model)}\n` +
      `ID: \`${agentId}\`\n`;
    if (freeCreation) {
      msg += `\n🎁 Included free with your subscription`;
    } else {
      msg += `\n💳 Paid: $20 (${AGENT_HIRE_FEE_BNB} BNB)`;
    }
    msg += `\n\n🔗 Registering on-chain...`;

    await bot.sendMessage(chatId, msg,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Give it a task", callback_data: `agenttask:${agentId}` }],
            [{ text: "My Agents", callback_data: "action:myagents" }, { text: "Menu", callback_data: "action:menu" }],
          ]
        }
      }
    );

    registerAgentOnAllChains(chatId, agentId, name, bio);
  } catch (e: any) {
    await bot.sendMessage(chatId, `Failed: ${e.message}`, {
      reply_markup: { inline_keyboard: [[{ text: "Try again", callback_data: "action:newagent" }]] }
    });
  }
}

async function registerAgentOnAllChains(chatId: number, agentId: string, name: string, bio: string): Promise<void> {
  if (!bot) return;
  const results: string[] = [];

  const wallet = getLinkedWallet(chatId);
  let userPk: string | undefined;
  if (wallet) {
    userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet) || undefined;
  }

  if (!userPk) {
    try {
      await bot.sendMessage(chatId,
        `⚠️ On-chain registration skipped — your wallet needs funds to register agents.\n\n` +
        `• ERC-8004 (BNB Chain): ~0.002 BNB for gas\n` +
        `• BAP-578 (BNB Chain): ~0.012 BNB (0.01 mint + gas)\n\n` +
        `Fund your wallet and use /myagents to register later.`,
      );
    } catch {}
    return;
  }

  try {
    if (isOnchainReady()) {
      const hubResult = await registerAgentOnchain(agentId);
      if (hubResult.success && hubResult.txHash !== "already-registered") {
        const explorer = getExplorerUrl(hubResult.txHash || "");
        results.push(`AgentEconomyHub: ${explorer ? explorer : "registered"}`);
      } else if (hubResult.success) {
        results.push("AgentEconomyHub: already registered");
      }
    }
  } catch (e: any) {
    console.error(`[TelegramBot] Hub registration error for ${agentId}:`, e.message);
  }

  try {
    const erc8004BscResult = await registerAgentERC8004(name, bio, agentId, "bsc", userPk);
    if (erc8004BscResult.success) {
      results.push(`ERC-8004 (${erc8004BscResult.chainName || "BSC"}): ${erc8004BscResult.txHash?.substring(0, 14)}...`);
      if (erc8004BscResult.tokenId) {
        results.push(`  Token ID: ${erc8004BscResult.tokenId}`);
      }
      try {
        const { db } = await import("./db");
        const { agents: agentsTable } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(agentsTable).set({ erc8004Registered: true }).where(eq(agentsTable.id, agentId));
      } catch {}
    } else {
      results.push(`ERC-8004 (BSC): ${erc8004BscResult.error?.substring(0, 80) || "skipped"}`);
    }
  } catch (e: any) {
    console.error(`[TelegramBot] ERC-8004 BSC registration error for ${agentId}:`, e.message);
    results.push(`ERC-8004 (BSC): ${e.message?.substring(0, 60)}`);
  }

  try {
    const bap578Result = await registerAgentBAP578(name, bio, agentId, undefined, userPk);
    if (bap578Result.success) {
      results.push(`BAP-578 (BNB Chain): ${bap578Result.txHash?.substring(0, 14)}...`);
      if (bap578Result.tokenId) {
        results.push(`  NFA Token ID: ${bap578Result.tokenId}`);
      }
      try {
        const { db } = await import("./db");
        const { agents: agentsTable } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(agentsTable).set({ bap578Registered: true }).where(eq(agentsTable.id, agentId));
      } catch {}
    } else {
      results.push(`BAP-578: ${bap578Result.error?.substring(0, 80) || "skipped"}`);
    }
  } catch (e: any) {
    console.error(`[TelegramBot] BAP-578 registration error for ${agentId}:`, e.message);
    results.push(`BAP-578: ${e.message?.substring(0, 60)}`);
  }


  if (results.length > 0) {
    try {
      await bot.sendMessage(chatId,
        `On-chain registration complete:\n\n${results.join("\n")}`,
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
    } catch {}
  }
}

async function handleMyAgents(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const myAgents = await getMyAgents(wallet);

    if (myAgents.length === 0) {
      await bot.sendMessage(chatId, "No agents yet.", {
        reply_markup: { inline_keyboard: [[{ text: "Create your first agent", callback_data: "action:newagent" }]] }
      });
      return;
    }

    const lines = myAgents.map(a => {
      const model = shortModel(a.modelType || "unknown");
      return `🤖 *${a.name}*\n   Model: ${model}\n   Bio: _${(a.bio || "AI trading agent").substring(0, 80)}_\n   Status: 🟢 Active — scanning, analyzing & trading for you`;
    });

    const buttons = myAgents.map(a => [
      { text: `📋 ${a.name} — Assign Task`, callback_data: `agenttask:${a.id}` },
      { text: `💬 Ask ${a.name}`, callback_data: `agentask:${a.id}` },
    ]);
    buttons.push([{ text: "➕ Create Another Agent", callback_data: "action:newagent" }]);
    buttons.push([{ text: "« Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId,
      `🧠 *Your Agents (${myAgents.length})*\n\nYour agents power every BUILD4 feature — security scans, signals, trading, and analysis all run through your agent's AI brain.\n\n${lines.join("\n\n")}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
    );
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function startTaskFlow(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const myAgents = await getMyAgents(wallet);

    if (myAgents.length === 0) {
      await bot.sendMessage(chatId, "You need an agent first.", {
        reply_markup: { inline_keyboard: [[{ text: "Create agent", callback_data: "action:newagent" }]] }
      });
      return;
    }

    if (myAgents.length === 1) {
      const agent = myAgents[0];
      await bot.sendMessage(chatId, `Task for ${agent.name}. Pick a type:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Research", callback_data: `tasktype:${agent.id}:research` }, { text: "Analysis", callback_data: `tasktype:${agent.id}:analysis` }],
            [{ text: "Content", callback_data: `tasktype:${agent.id}:content` }, { text: "Strategy", callback_data: `tasktype:${agent.id}:strategy` }],
            [{ text: "Code Review", callback_data: `tasktype:${agent.id}:code_review` }, { text: "General", callback_data: `tasktype:${agent.id}:general` }],
            [{ text: "🚀 Launch Token", callback_data: `launchagent:${agent.id}` }],
          ]
        }
      });
      return;
    }

    const buttons = myAgents.map(a => [
      { text: a.name, callback_data: `taskagent:${a.id}` }
    ]);

    await bot.sendMessage(chatId, "Which agent?", {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleTaskFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingTask.get(chatId)!;
  const wallet = getLinkedWallet(chatId);
  if (!wallet) { pendingTask.delete(chatId); return; }

  if (state.step === "describe") {
    const description = text.trim();
    if (description.length > 5000) {
      await bot.sendMessage(chatId, `${description.length}/5000 chars — make it shorter:`);
      return;
    }

    const { agentId, taskType, agentName } = state;
    const title = description.length > 100 ? description.substring(0, 97) + "..." : description;
    pendingTask.delete(chatId);

    try {
      await bot.sendChatAction(chatId, "typing");

      const task = await storage.createTask({
        agentId,
        creatorWallet: wallet,
        taskType,
        title,
        description,
        status: "pending",
        result: null,
        toolsUsed: null,
        modelUsed: null,
        executionTimeMs: null,
      });

      await bot.sendMessage(chatId, `${agentName} is working on it...\n\nI'll send you the result when it's ready.`);

      const { executeTask } = await import("./task-engine");
      executeTask(task.id).then(async () => {
        try {
          const completed = await storage.getTask(task.id);
          if (!completed || !bot) return;

          if (completed.status === "completed" && completed.result) {
            const resultText = completed.result.length > 3500
              ? completed.result.substring(0, 3500) + "\n\n... (truncated)"
              : completed.result;

            const meta = [];
            if (completed.modelUsed) meta.push(shortModel(completed.modelUsed));
            if (completed.executionTimeMs) meta.push(`${(completed.executionTimeMs / 1000).toFixed(1)}s`);
            if (completed.toolsUsed) {
              try { const t = JSON.parse(completed.toolsUsed); if (t.length) meta.push(t.join(", ")); } catch {}
            }

            await bot.sendMessage(chatId,
              `Done! ${meta.length > 0 ? `(${meta.join(" | ")})` : ""}\n\n${resultText}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "New task", callback_data: `agenttask:${agentId}` }, { text: "Menu", callback_data: "action:menu" }],
                  ]
                }
              }
            );
          } else if (completed.status === "failed") {
            await bot.sendMessage(chatId,
              `Task failed: ${completed.result || "Unknown error"}`,
              {
                reply_markup: {
                  inline_keyboard: [[{ text: "Try again", callback_data: `agenttask:${agentId}` }]]
                }
              }
            );
          }
        } catch (e: any) {
          console.error(`[TelegramBot] Error sending result to ${chatId}:`, e.message);
        }
      }).catch(err => {
        console.error(`[TelegramBot] Task ${task.id} error:`, err.message);
        bot?.sendMessage(chatId, `Error: ${err.message}`, {
          reply_markup: { inline_keyboard: [[{ text: "Try again", callback_data: `agenttask:${agentId}` }]] }
        }).catch(() => {});
      });

    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed: ${e.message}`, {
        reply_markup: { inline_keyboard: [[{ text: "Try again", callback_data: "action:task" }]] }
      });
    }
    return;
  }
}

async function handleTaskStatus(chatId: number, taskId: string, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const task = await storage.getTask(taskId.trim());
    if (!task) { await bot.sendMessage(chatId, "Task not found."); return; }
    if (task.creatorWallet && task.creatorWallet.toLowerCase() !== wallet.toLowerCase()) {
      await bot.sendMessage(chatId, "That task doesn't belong to your wallet.");
      return;
    }

    const agent = await storage.getAgent(task.agentId);
    const status = task.status === "completed" ? "Done" : task.status === "running" ? "Running..." : task.status === "failed" ? "Failed" : "Pending";

    let msg = `${task.title}\n${agent?.name || "Agent"} | ${task.taskType} | ${status}`;
    if (task.modelUsed) msg += ` | ${shortModel(task.modelUsed)}`;
    if (task.executionTimeMs) msg += ` | ${(task.executionTimeMs / 1000).toFixed(1)}s`;

    if (task.result) {
      const preview = task.result.length > 3000 ? task.result.substring(0, 3000) + "\n\n... (truncated)" : task.result;
      msg += `\n\n${preview}`;
    } else if (task.status === "running") {
      msg += "\n\nStill processing...";
    }

    const buttons = [];
    if (task.agentId) buttons.push([{ text: "New task for this agent", callback_data: `agenttask:${task.agentId}` }]);
    buttons.push([{ text: "Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, msg, { reply_markup: { inline_keyboard: buttons } });
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleMyTasks(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const tasks = await storage.getTasksByCreator(wallet, 10);

    if (tasks.length === 0) {
      await bot.sendMessage(chatId, "No tasks yet.", {
        reply_markup: { inline_keyboard: [[{ text: "Create a task", callback_data: "action:task" }]] }
      });
      return;
    }

    const lines = tasks.map(t => {
      const s = t.status === "completed" ? "Done" : t.status === "running" ? "..." : t.status === "failed" ? "Failed" : "Pending";
      const title = t.title.length > 40 ? t.title.substring(0, 37) + "..." : t.title;
      return `[${s}] ${title}`;
    });

    const buttons = tasks.slice(0, 5).map(t => [
      { text: `${t.title.substring(0, 30)}${t.title.length > 30 ? "..." : ""}`, callback_data: `viewtask:${t.id}` }
    ]);
    buttons.push([{ text: "New task", callback_data: "action:task" }, { text: "Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId,
      `Recent Tasks:\n\n${lines.join("\n")}`,
      { reply_markup: { inline_keyboard: buttons } }
    );
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleProposalApproval(chatId: number, proposalId: string, approved: boolean): Promise<void> {
  if (!bot) return;

  try {
    const { storage } = await import("./storage");
    const proposal = await storage.getTokenLaunch(proposalId);

    if (!proposal) {
      await bot.sendMessage(chatId, "Proposal not found or already expired.");
      return;
    }

    if (proposal.status !== "proposed") {
      const statusMsg = proposal.status === "success" ? "already launched" : proposal.status === "rejected" ? "already rejected" : proposal.status;
      await bot.sendMessage(chatId, `This proposal is ${statusMsg}.`);
      return;
    }

    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId, "Please connect your wallet first.");
      return;
    }

    if (!proposal.creatorWallet) {
      await bot.sendMessage(chatId, "This proposal has no owner — cannot approve.");
      return;
    }

    if (proposal.creatorWallet.toLowerCase() !== wallet.toLowerCase()) {
      await bot.sendMessage(chatId, "This proposal belongs to a different wallet.");
      return;
    }

    if (!approved) {
      await storage.updateTokenLaunch(proposalId, { status: "rejected" });
      await bot.sendMessage(chatId,
        `❌ Proposal rejected: ${proposal.tokenName} ($${proposal.tokenSymbol})\n\nYour agent will learn from this.`,
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
      return;
    }

    const updated = await storage.updateTokenLaunch(proposalId, { status: "pending" });
    if (!updated || (updated.status !== "pending")) {
      await bot.sendMessage(chatId, "This proposal was already processed.");
      return;
    }

    await bot.sendMessage(chatId, `🚀 Launching ${proposal.tokenName} ($${proposal.tokenSymbol})...\n\nThis may take a minute.`);
    await bot.sendChatAction(chatId, "typing");

    let userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);

    if (!userPk) {
      await bot.sendMessage(chatId,
        "⚠️ Your wallet doesn't have a stored private key.\n\n" +
        "Use 🔑 Wallet → Import to re-import this wallet's private key, or create a new proposal from a fresh wallet.",
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
      return;
    }

    const { launchToken } = await import("./token-launcher");

    const launchParams: any = {
      tokenName: proposal.tokenName,
      tokenSymbol: proposal.tokenSymbol,
      tokenDescription: proposal.tokenDescription || `${proposal.tokenName} — launched by agent on BUILD4`,
      platform: proposal.platform as "four_meme" | "flap_sh" | "bankr",
      agentId: proposal.agentId || undefined,
      creatorWallet: wallet,
    };

    if (proposal.platform === "bankr") {
      launchParams.bankrChain = "base";
    } else {
      launchParams.initialLiquidityBnb = proposal.platform === "four_meme" ? "0" : "0.001";
      launchParams.userPrivateKey = userPk;
    }

    const result = await launchToken(launchParams);

    if (result.success) {
      await storage.updateTokenLaunch(proposalId, {
        status: "success",
        tokenAddress: result.tokenAddress,
        txHash: result.txHash,
        launchUrl: result.launchUrl,
      });

      const lines = [
        `✅ TOKEN LAUNCHED!\n`,
        `Token: ${proposal.tokenName} ($${proposal.tokenSymbol})`,
      ];
      if (result.tokenAddress) lines.push(`Address: ${result.tokenAddress}`);
      if (result.txHash) lines.push(`Tx: https://bscscan.com/tx/${result.txHash}`);
      if (result.launchUrl) lines.push(`\nView: ${result.launchUrl}`);

      await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: mainMenuKeyboard(undefined, chatId)
      });
    } else {
      await storage.updateTokenLaunch(proposalId, {
        status: "failed",
        errorMessage: result.error,
      });

      await bot.sendMessage(chatId,
        `❌ Launch failed: ${result.error}`,
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
    }
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function startTokenLaunchFlow(chatId: number, wallet: string): Promise<void> {
  if (!bot) return;
  try {
    const myAgents = await getMyAgents(wallet);

    if (myAgents.length === 0) {
      await bot.sendMessage(chatId, "You need an agent first to launch a token.", {
        reply_markup: { inline_keyboard: [[{ text: "Create agent", callback_data: "action:newagent" }]] }
      });
      return;
    }

    if (myAgents.length === 1) {
      const agent = myAgents[0];
      pendingAgentCreation.delete(chatId);
      pendingTask.delete(chatId);
      pendingTokenLaunch.set(chatId, { step: "platform", agentId: agent.id, agentName: agent.name });

      await bot.sendMessage(chatId,
        `🚀 Launch a token with ${agent.name}\n\nPick a launchpad:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Four.meme (BNB Chain)", callback_data: `launchplatform:${agent.id}:four_meme` }],
              [{ text: "Flap.sh (BNB Chain)", callback_data: `launchplatform:${agent.id}:flap_sh` }],
              [{ text: "XLayer (OKX)", callback_data: `launchplatform:${agent.id}:xlayer` }],
              [{ text: "Bankr (Base/Solana)", callback_data: `launchplatform:${agent.id}:bankr` }],
              [{ text: "Cancel", callback_data: "action:menu" }],
            ]
          }
        }
      );
      return;
    }

    const buttons = myAgents.map(a => [
      { text: `🚀 ${a.name}`, callback_data: `launchagent:${a.id}` }
    ]);
    buttons.push([{ text: "Cancel", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, "Which agent should launch the token?", {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (e: any) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
}

async function handleTokenLaunchFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingTokenLaunch.get(chatId)!;
  const input = text.trim();

  if (state.step === "name") {
    if (input.length < 1 || input.length > 50) {
      await bot.sendMessage(chatId, "Token name must be 1-50 characters. Try again:");
      return;
    }
    state.tokenName = input;
    state.step = "symbol";
    pendingTokenLaunch.set(chatId, state);
    await bot.sendMessage(chatId,
      `Token: ${input}\n\nNow enter the ticker symbol (1-10 chars, letters/numbers only)\n\nExample: DOGE, PEPE, AGT`
    );
    return;
  }

  if (state.step === "symbol") {
    const symbol = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (symbol.length < 1 || symbol.length > 10) {
      await bot.sendMessage(chatId, "Symbol must be 1-10 alphanumeric characters. Try again:");
      return;
    }
    state.tokenSymbol = symbol;
    state.step = "description";
    pendingTokenLaunch.set(chatId, state);
    await bot.sendMessage(chatId,
      `Token: ${state.tokenName} ($${symbol})\n\nShort description (optional — type "skip" to skip):\n\nExample: The first AI-powered meme token on BNB Chain`
    );
    return;
  }

  if (state.step === "description") {
    const description = input.toLowerCase() === "skip" ? "" : input.substring(0, 500);
    state.tokenDescription = description;

    if (state.platform === "bankr") {
      showLaunchPreview(chatId, state);
      return;
    }

    state.step = "logo";
    pendingTokenLaunch.set(chatId, state);

    await bot.sendMessage(chatId,
      `🖼️ Token logo (optional):\n\nSend an image in any of these formats:\nPNG, JPG, GIF, WebP, SVG, BMP, TIFF, AVIF, ICO\n\nYou can send it as a photo, as a file, or even a static sticker.\n\nType "skip" to auto-generate a logo instead.`,
    );
    return;
  }

  if (state.step === "logo") {
    if (input.toLowerCase() !== "skip") {
      state.imageUrl = input.trim();
    }
    state.step = "links";
    pendingTokenLaunch.set(chatId, state);

    await bot.sendMessage(chatId,
      `🔗 Social links (optional):\n\nSend links in this format:\n` +
      `website: https://yoursite.com\n` +
      `twitter: https://x.com/yourtoken\n` +
      `telegram: https://t.me/yourgroup\n\n` +
      `You can include one, two, or all three. Or type "skip" to continue without links.`,
    );
    return;
  }

  if (state.step === "links") {
    if (input.toLowerCase() !== "skip") {
      const lines = input.split("\n");
      for (const line of lines) {
        const lower = line.toLowerCase().trim();
        const urlMatch = line.match(/https?:\/\/\S+/i);
        if (!urlMatch) continue;
        const url = urlMatch[0].trim();
        if (lower.startsWith("website:") || lower.startsWith("web:") || lower.startsWith("site:")) {
          state.webUrl = url;
        } else if (lower.startsWith("twitter:") || lower.startsWith("x:")) {
          state.twitterUrl = url;
        } else if (lower.startsWith("telegram:") || lower.startsWith("tg:")) {
          state.telegramUrl = url;
        } else if (url.includes("x.com") || url.includes("twitter.com")) {
          state.twitterUrl = url;
        } else if (url.includes("t.me")) {
          state.telegramUrl = url;
        } else {
          state.webUrl = state.webUrl || url;
        }
      }
    }

    if (state.platform === "flap_sh") {
      state.step = "tax";
      pendingTokenLaunch.set(chatId, state);
      await bot.sendMessage(chatId,
        `💰 Tax configuration (Flap.sh only):\n\nChoose a buy/sell tax rate for your token:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "0% (No Tax)", callback_data: "launchtax:0" },
                { text: "1%", callback_data: "launchtax:1" },
              ],
              [
                { text: "2%", callback_data: "launchtax:2" },
                { text: "5%", callback_data: "launchtax:5" },
              ],
            ]
          }
        }
      );
      return;
    }

    showLaunchPreview(chatId, state);
    return;
  }
}

async function showLaunchPreview(chatId: number, state: TokenLaunchState) {
  if (!bot) return;
  const platformName = state.platform === "four_meme" ? "Four.meme (BNB Chain)" : state.platform === "bankr" ? `Bankr (${state.bankrChain === "solana" ? "Solana" : "Base"})` : state.platform === "xlayer" ? "XLayer (OKX)" : "Flap.sh (BNB Chain)";
  const liquidity = state.platform === "bankr" ? "Managed by Bankr" : state.platform === "xlayer" ? "N/A (direct deploy)" : state.platform === "four_meme" ? "0.01 BNB" : "0.001 BNB";
  const launchFee = state.platform === "bankr" ? "Free" : state.platform === "xlayer" ? "Gas only (~0.005 OKB)" : "0.01 BNB (~$7)";

  let preview = `🚀 LAUNCH PREVIEW\n\n` +
    `Token: ${state.tokenName} ($${state.tokenSymbol})\n` +
    `Platform: ${platformName}\n` +
    `Liquidity: ${liquidity}\n` +
    `Launch Fee: ${launchFee}\n` +
    `Agent: ${state.agentName}\n`;

  if (state.tokenDescription) preview += `Description: ${state.tokenDescription}\n`;
  if (state.imageUrl) preview += `Logo: Custom image ✅\n`;
  else preview += `Logo: Auto-generated\n`;
  if (state.webUrl) preview += `Website: ${state.webUrl}\n`;
  if (state.twitterUrl) preview += `Twitter: ${state.twitterUrl}\n`;
  if (state.telegramUrl) preview += `Telegram: ${state.telegramUrl}\n`;
  if (state.platform === "flap_sh") {
    preview += `Tax: ${state.taxRate ?? 0}%\n`;
  }
  preview += `\nReady to launch?`;

  pendingTokenLaunch.set(chatId, state);

  await bot.sendMessage(chatId, preview, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 Confirm & Launch", callback_data: `launchconfirm:${state.agentId}` }],
        [{ text: "Cancel", callback_data: `launchcancel:${state.agentId}` }],
      ]
    }
  });
}

async function executeTelegramTokenLaunch(chatId: number, wallet: string, state: TokenLaunchState): Promise<void> {
  if (!bot) return;

  const platformName = state.platform === "four_meme" ? "Four.meme (BNB Chain)" : state.platform === "bankr" ? `Bankr (${state.bankrChain === "solana" ? "Solana" : "Base"})` : state.platform === "xlayer" ? "XLayer (OKX)" : "Flap.sh (BNB Chain)";

  if (state.platform === "xlayer") {
    await bot.sendMessage(chatId, `🌐 Deploying ${state.tokenName} ($${state.tokenSymbol}) as ERC-20 on XLayer...\n\nThis may take a minute.`);
    await bot.sendChatAction(chatId, "typing");

    let userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);
    if (!userPk) {
      const newWallet = await regenerateWalletWithKey(chatId);
      if (newWallet) {
        userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), newWallet);
        wallet = newWallet;
      }
      if (!userPk) {
        await bot.sendMessage(chatId, "⚠️ Could not access wallet keys. Try /start to create a fresh wallet.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        return;
      }
    }

    try {
      const { launchToken } = await import("./token-launcher");
      const result = await launchToken({
        tokenName: state.tokenName!,
        tokenSymbol: state.tokenSymbol!,
        tokenDescription: state.tokenDescription || `${state.tokenName} — launched by ${state.agentName} on BUILD4`,
        platform: "xlayer",
        agentId: state.agentId,
        creatorWallet: wallet,
        userPrivateKey: userPk,
      });

      if (result.success) {
        const lines = [
          `✅ TOKEN DEPLOYED ON XLAYER!\n`,
          `Token: ${state.tokenName} ($${state.tokenSymbol})`,
          `Chain: XLayer (OKX)`,
          `Supply: 1,000,000,000 tokens`,
        ];
        if (result.tokenAddress) lines.push(`Address: ${result.tokenAddress}`);
        if (result.txHash) lines.push(`Tx: https://www.oklink.com/xlayer/tx/${result.txHash}`);
        if (result.launchUrl) lines.push(`\nView: ${result.launchUrl}`);

        await bot.sendMessage(chatId, lines.join("\n"), {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Launch another", callback_data: "action:launchtoken" }],
              [{ text: "Menu", callback_data: "action:menu" }],
            ]
          }
        });
      } else {
        await bot.sendMessage(chatId,
          `❌ XLayer launch failed: ${(result.error || "Unknown error").substring(0, 300)}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Try again", callback_data: "action:launchtoken" }],
                [{ text: "Menu", callback_data: "action:menu" }],
              ]
            }
          }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Error: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (state.platform === "bankr") {
    await bot.sendMessage(chatId, `🏦 Launching ${state.tokenName} ($${state.tokenSymbol}) on ${platformName} via Bankr API...\n\nThis may take up to 2 minutes.`);
    await bot.sendChatAction(chatId, "typing");

    try {
      const { launchToken } = await import("./token-launcher");
      const result = await launchToken({
        tokenName: state.tokenName!,
        tokenSymbol: state.tokenSymbol!,
        tokenDescription: state.tokenDescription || `${state.tokenName} — launched by ${state.agentName} on BUILD4`,
        platform: "bankr",
        agentId: state.agentId,
        creatorWallet: wallet,
        bankrChain: state.bankrChain || "base",
      });

      if (result.success) {
        const launchChain = state.bankrChain || "base";
        const isBase = launchChain === "base";
        const chainId = isBase ? "8453" : "501";

        const lines = [
          `✅ TOKEN LAUNCHED VIA BANKR!\n`,
          `Token: ${state.tokenName} ($${state.tokenSymbol})`,
          `Platform: ${platformName}`,
          `Chain: ${isBase ? "Base" : "Solana"}`,
        ];
        if (result.tokenAddress) lines.push(`Address: \`${result.tokenAddress}\``);
        if (result.launchUrl) lines.push(`\nView: ${result.launchUrl}`);

        if (result.tokenAddress && isBase) {
          lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
          lines.push(`⚡ *SNIPE NOW* — Buy before anyone else!`);
          lines.push(`\n🥷 *Stealth Mode* — 70% main + 10% across 20 wallets`);

          const tokenShort = result.tokenAddress.substring(0, 20);

          await bot.sendMessage(chatId, lines.join("\n"), {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🥷 STEALTH BUY (80%)", callback_data: `stealth:${tokenShort}` }],
                [
                  { text: "⚡ 0.5 ETH", callback_data: `cabuy:${result.tokenAddress}:${chainId}:0.5` },
                  { text: "⚡ 1 ETH", callback_data: `cabuy:${result.tokenAddress}:${chainId}:1` },
                  { text: "⚡ 5 ETH", callback_data: `cabuy:${result.tokenAddress}:${chainId}:5` },
                ],
                [
                  { text: "⚡ 10 ETH", callback_data: `cabuy:${result.tokenAddress}:${chainId}:10` },
                  { text: "⚡ 20 ETH", callback_data: `cabuy:${result.tokenAddress}:${chainId}:20` },
                ],
                [{ text: "🔒 Scan Token", callback_data: `cascan:${result.tokenAddress}:${chainId}` }],
                [{ text: "« Menu", callback_data: "action:menu" }],
              ]
            }
          });

          pendingStealthToken.set(chatId, result.tokenAddress);
        } else if (result.tokenAddress) {
          lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
          lines.push(`⚡ *SNIPE NOW*`);

          await bot.sendMessage(chatId, lines.join("\n"), {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "⚡ 1 SOL", callback_data: `cabuy:${result.tokenAddress}:${chainId}:1` },
                  { text: "⚡ 5 SOL", callback_data: `cabuy:${result.tokenAddress}:${chainId}:5` },
                  { text: "⚡ 10 SOL", callback_data: `cabuy:${result.tokenAddress}:${chainId}:10` },
                ],
                [{ text: "🔒 Scan", callback_data: `cascan:${result.tokenAddress}:${chainId}` }],
                [{ text: "« Menu", callback_data: "action:menu" }],
              ]
            }
          });
        } else {
          await bot.sendMessage(chatId, lines.join("\n"), {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🚀 Launch another", callback_data: "action:launchtoken" }],
                [{ text: "« Menu", callback_data: "action:menu" }],
              ]
            }
          });
        }
      } else {
        await bot.sendMessage(chatId,
          `❌ Bankr launch failed: ${(result.error || "Unknown error").substring(0, 300)}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Try again", callback_data: "action:launchtoken" }],
                [{ text: "Menu", callback_data: "action:menu" }],
              ]
            }
          }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Error: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  let userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), wallet);

  if (!userPk) {
    const newWallet = await regenerateWalletWithKey(chatId);
    if (newWallet) {
      userPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), newWallet);
      wallet = newWallet;
    }
    if (!userPk) {
      await bot.sendMessage(chatId,
        "⚠️ Could not access wallet keys. Try /start to create a fresh wallet.",
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
      return;
    }
  }

  await bot.sendMessage(chatId, `🚀 Launching ${state.tokenName} ($${state.tokenSymbol}) on ${platformName} from your wallet...\n\nThis may take a minute.`);
  await bot.sendChatAction(chatId, "typing");

  try {
    const { launchToken } = await import("./token-launcher");
    const result = await launchToken({
      tokenName: state.tokenName!,
      tokenSymbol: state.tokenSymbol!,
      tokenDescription: state.tokenDescription || `${state.tokenName} — launched by ${state.agentName} on BUILD4`,
      imageUrl: state.imageUrl,
      platform: state.platform as "four_meme" | "flap_sh",
      initialLiquidityBnb: state.platform === "four_meme" ? "0" : "0.001",
      agentId: state.agentId,
      creatorWallet: wallet,
      userPrivateKey: userPk,
      webUrl: state.webUrl,
      twitterUrl: state.twitterUrl,
      telegramUrl: state.telegramUrl,
      taxRate: state.taxRate,
    });

    if (result.success) {
      const lines = [
        `✅ TOKEN LAUNCHED!\n`,
        `Token: ${state.tokenName} ($${state.tokenSymbol})`,
        `Platform: ${platformName}`,
      ];
      if (result.tokenAddress) lines.push(`Address: ${result.tokenAddress}`);
      if (result.txHash) lines.push(`Tx: https://bscscan.com/tx/${result.txHash}`);
      if (result.launchUrl) lines.push(`\nView: ${result.launchUrl}`);

      await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Launch another", callback_data: "action:launchtoken" }],
            [{ text: "Menu", callback_data: "action:menu" }],
          ]
        }
      });
    } else {
      await bot.sendMessage(chatId,
        `❌ Launch failed: ${(result.error || "Unknown error").substring(0, 200)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Try again", callback_data: "action:launchtoken" }],
              [{ text: "Menu", callback_data: "action:menu" }],
            ]
          }
        }
      );
    }
  } catch (e: any) {
    await bot.sendMessage(chatId,
      `❌ Error: ${e.message}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Try again", callback_data: "action:launchtoken" }],
            [{ text: "Menu", callback_data: "action:menu" }],
          ]
        }
      }
    );
  }
}

async function handleTokenInfo(chatId: number, tokenAddress: string): Promise<void> {
  if (!bot) return;
  await bot.sendChatAction(chatId, "typing");
  try {
    const { fourMemeGetTokenInfo, fourMemeGetTokenBalance } = await import("./token-launcher");
    const info = await Promise.race([
      fourMemeGetTokenInfo(tokenAddress),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Token info timed out (30s). Try again.")), 30000)),
    ]);

    const quoteName = info.quote === "0x0000000000000000000000000000000000000000" ? "BNB" : "BEP20";
    const progressBar = "█".repeat(Math.floor(info.progressPercent / 10)) + "░".repeat(10 - Math.floor(info.progressPercent / 10));

    let text = `📈 TOKEN INFO\n\n` +
      `Address: \`${tokenAddress}\`\n` +
      `Version: V${info.version} TokenManager\n` +
      `Quote: ${quoteName}\n` +
      `Price: ${parseFloat(info.lastPrice).toFixed(12)} ${quoteName}\n` +
      `Fee Rate: ${(info.tradingFeeRate * 100).toFixed(2)}%\n` +
      `Launched: ${new Date(info.launchTime * 1000).toISOString().split("T")[0]}\n\n` +
      `Bonding Curve:\n` +
      `[${progressBar}] ${info.progressPercent}%\n` +
      `Raised: ${parseFloat(info.funds).toFixed(4)} / ${parseFloat(info.maxFunds).toFixed(4)} ${quoteName}\n` +
      `Remaining: ${parseFloat(info.offers).toFixed(0)} / ${parseFloat(info.maxOffers).toFixed(0)} tokens\n`;

    if (info.liquidityAdded) {
      text += `\n✅ Liquidity added — trading on PancakeSwap`;
    }

    text += `\n\nhttps://four.meme/token/${tokenAddress}`;

    const wallet = getLinkedWallet(chatId);
    const buttons: TelegramBot.InlineKeyboardButton[][] = [];
    if (wallet) {
      buttons.push([
        { text: "💰 Buy", callback_data: `fmbuy:${tokenAddress.substring(0, 42)}` },
        { text: "💸 Sell", callback_data: `fmsell:${tokenAddress.substring(0, 42)}` },
      ]);
    }
    buttons.push([{ text: "◀️ Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
  } catch (e: any) {
    await bot.sendMessage(chatId, `Failed to fetch token info: ${e.message?.substring(0, 150) || "Unknown error"}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
  }
}

async function showSellAmountPrompt(chatId: number, tokenAddress: string): Promise<void> {
  if (!bot) return;
  const wallet = getLinkedWallet(chatId);
  if (!wallet) return;

  try {
    const { fourMemeGetTokenBalance } = await import("./token-launcher");
    const balInfo = await Promise.race([
      fourMemeGetTokenBalance(tokenAddress, wallet),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Balance check timed out (30s). BSC RPC may be slow — try again.")), 30000)),
    ]);
    const bal = parseFloat(balInfo.balance);

    if (bal <= 0) {
      pendingFourMemeSell.delete(chatId);
      await bot.sendMessage(chatId, `You don't hold any of this token in your active wallet.`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    const state = pendingFourMemeSell.get(chatId);
    if (state) {
      state.tokenSymbol = balInfo.symbol;
      pendingFourMemeSell.set(chatId, state);
    }

    await bot.sendMessage(chatId,
      `Your balance: ${bal.toFixed(4)} ${balInfo.symbol}\n\nHow many tokens do you want to sell?\n\nType an amount or tap a button:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "25%", callback_data: `fmsellpct:25:${tokenAddress}` },
              { text: "50%", callback_data: `fmsellpct:50:${tokenAddress}` },
              { text: "100%", callback_data: `fmsellpct:100:${tokenAddress}` },
            ],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
  } catch (e: any) {
    await bot.sendMessage(chatId, `Failed to check balance: ${e.message?.substring(0, 100)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    pendingFourMemeSell.delete(chatId);
  }
}

async function handleFourMemeBuyFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingFourMemeBuy.get(chatId)!;
  const input = text.trim();

  if (state.step === "token") {
    if (!/^0x[a-fA-F0-9]{40}$/i.test(input)) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid token contract address (0x...):");
      return;
    }
    state.tokenAddress = input.toLowerCase();
    state.step = "amount";
    pendingFourMemeBuy.set(chatId, state);
    await bot.sendMessage(chatId,
      `How much BNB do you want to spend?\n\nEnter an amount (e.g. 0.01, 0.1, 1):`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "0.01 BNB", callback_data: `fmbuyamt:0.01:${state.tokenAddress}` },
              { text: "0.05 BNB", callback_data: `fmbuyamt:0.05:${state.tokenAddress}` },
              { text: "0.1 BNB", callback_data: `fmbuyamt:0.1:${state.tokenAddress}` },
            ],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
    return;
  }

  if (state.step === "amount") {
    const amount = parseFloat(input);
    if (isNaN(amount) || amount <= 0 || amount > 100) {
      await bot.sendMessage(chatId, "Enter a valid BNB amount (e.g. 0.01, 0.1, 1):");
      return;
    }
    state.bnbAmount = amount.toString();
    await executeFourMemeBuyConfirm(chatId, state);
    return;
  }
}

async function executeFourMemeBuyConfirm(chatId: number, state: FourMemeBuyState): Promise<void> {
  if (!bot || !state.tokenAddress || !state.bnbAmount) return;

  await bot.sendChatAction(chatId, "typing");

  try {
    const { fourMemeEstimateBuy } = await import("./token-launcher");
    const estimate = await Promise.race([
      fourMemeEstimateBuy(state.tokenAddress, state.bnbAmount),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Estimate timed out (30s). BSC RPC may be slow — try again.")), 30000)),
    ]);

    state.estimate = estimate;
    state.step = "confirm";
    pendingFourMemeBuy.set(chatId, state);

    await bot.sendMessage(chatId,
      `💰 BUY PREVIEW\n\n` +
      `Token: \`${state.tokenAddress}\`\n` +
      `Spend: ${state.bnbAmount} BNB\n` +
      `Est. tokens: ${parseFloat(estimate.estimatedAmount).toFixed(2)}\n` +
      `Est. cost: ${parseFloat(estimate.estimatedCost).toFixed(6)} BNB\n` +
      `Fee: ${parseFloat(estimate.estimatedFee).toFixed(6)} BNB\n` +
      `Slippage: 5%\n\n` +
      `Confirm purchase?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Buy", callback_data: `fmbuyconfirm:${state.tokenAddress}` }],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
  } catch (e: any) {
    pendingFourMemeBuy.delete(chatId);
    await bot.sendMessage(chatId, `Failed to estimate: ${e.message?.substring(0, 150) || "Unknown error"}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
  }
}

async function handleFourMemeSellFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingFourMemeSell.get(chatId)!;
  const input = text.trim();

  if (state.step === "token") {
    if (!/^0x[a-fA-F0-9]{40}$/i.test(input)) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid token contract address (0x...):");
      return;
    }
    state.tokenAddress = input.toLowerCase();
    state.step = "amount";
    pendingFourMemeSell.set(chatId, state);
    await showSellAmountPrompt(chatId, state.tokenAddress);
    return;
  }

  if (state.step === "amount") {
    const amount = parseFloat(input);
    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(chatId, "Enter a valid token amount:");
      return;
    }
    state.tokenAmount = amount.toString();
    await executeFourMemeSellConfirm(chatId, state);
    return;
  }
}

async function executeFourMemeSellConfirm(chatId: number, state: FourMemeSellState): Promise<void> {
  if (!bot || !state.tokenAddress || !state.tokenAmount) return;

  await bot.sendChatAction(chatId, "typing");

  try {
    const { fourMemeEstimateSell } = await import("./token-launcher");
    const estimate = await Promise.race([
      fourMemeEstimateSell(state.tokenAddress, state.tokenAmount),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Estimate timed out (30s). BSC RPC may be slow — try again.")), 30000)),
    ]);

    state.estimate = estimate;
    state.step = "confirm";
    pendingFourMemeSell.set(chatId, state);

    const quoteName = estimate.quote === "0x0000000000000000000000000000000000000000" ? "BNB" : "BEP20";

    await bot.sendMessage(chatId,
      `💸 SELL PREVIEW\n\n` +
      `Token: \`${state.tokenAddress}\`\n` +
      `Sell: ${state.tokenAmount} ${state.tokenSymbol || "tokens"}\n` +
      `Est. receive: ${parseFloat(estimate.fundsReceived).toFixed(6)} ${quoteName}\n` +
      `Fee: ${parseFloat(estimate.fee).toFixed(6)} ${quoteName}\n\n` +
      `Confirm sale?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Sell", callback_data: `fmsellconfirm:${state.tokenAddress}` }],
            [{ text: "Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
  } catch (e: any) {
    pendingFourMemeSell.delete(chatId);
    await bot.sendMessage(chatId, `Failed to estimate: ${e.message?.substring(0, 150) || "Unknown error"}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
  }
}

async function handleQuestion(chatId: number, messageId: number, question: string, username: string): Promise<void> {
  const userId = chatId;
  const now = Date.now();
  const lastMsg = rateLimitMap.get(userId);
  if (lastMsg && now - lastMsg < RATE_LIMIT_MS) {
    return;
  }
  rateLimitMap.set(userId, now);

  if (rateLimitMap.size > 1000) {
    const cutoff = now - RATE_LIMIT_MS * 10;
    for (const [key, time] of rateLimitMap) {
      if (time < cutoff) rateLimitMap.delete(key);
    }
  }

  try {
    bot!.sendChatAction(chatId, "typing").catch(() => {});
    const answer = await generateAnswer(question, username, chatId);
    console.log(`[TelegramBot] Answering @${username}: ${answer.slice(0, 80)}...`);
    const hasCode = answer.includes("`");
    bot!.sendMessage(chatId, answer, { reply_to_message_id: messageId, parse_mode: hasCode ? "Markdown" : undefined }).catch(() => {});
  } catch (e: any) {
    console.error("[TelegramBot] Error handling message:", e.message);
    bot!.sendMessage(chatId, "Something went wrong. Try again!", { reply_to_message_id: messageId }).catch(() => {});
  }
}

export async function sendTokenProposalNotification(
  chatId: number,
  proposalId: string,
  agentName: string,
  tokenName: string,
  tokenSymbol: string,
  platform: string,
  description: string
): Promise<boolean> {
  if (!bot || !isRunning) return false;

  const platformName = platform === "four_meme" ? "Four.meme (BNB Chain)" : platform === "bankr" ? "Bankr (Base)" : "Flap.sh (BNB Chain)";
  const liquidity = platform === "bankr" ? "Managed by Bankr" : "0.01 BNB";

  try {
    await bot.sendMessage(chatId,
      `🤖 AGENT TOKEN PROPOSAL\n\n` +
      `Your agent ${agentName} wants to launch a token:\n\n` +
      `Token: ${tokenName} ($${tokenSymbol})\n` +
      `Platform: ${platformName}\n` +
      `Liquidity: ${liquidity}\n` +
      `Description: ${description.substring(0, 200)}\n\n` +
      `Approve this launch?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Approve Launch", callback_data: `proposal_approve:${proposalId}` }],
            [{ text: "❌ Reject", callback_data: `proposal_reject:${proposalId}` }],
          ]
        }
      }
    );
    return true;
  } catch (e: any) {
    console.error("[TelegramBot] Failed to send proposal notification:", e.message);
    return false;
  }
}

export async function sendTelegramMessage(chatId: string | number, text: string): Promise<boolean> {
  if (!bot || !isRunning) {
    console.warn("[TelegramBot] Cannot send message — bot is not running");
    return false;
  }

  try {
    await bot.sendMessage(chatId, text);
    return true;
  } catch (e: any) {
    console.error("[TelegramBot] Failed to send message:", e.message);
    return false;
  }
}

export function stopTelegramBot(): void {
  if (bot) {
    if (webhookMode) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (token) {
        fetch(`https://api.telegram.org/bot${token}/deleteWebhook`).catch(() => {});
      }
    } else {
      bot.stopPolling();
    }
    bot = null;
  }
  isRunning = false;
  webhookMode = false;
  console.log("[TelegramBot] Stopped");
}

export function getTelegramBotStatus(): { running: boolean } {
  return { running: isRunning };
}

async function handleChaosPlanFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingChaosPlan.get(chatId);
  if (!state) return;

  if (state.step === "token_address") {
    const addr = text.trim();
    if (!/^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      await bot.sendMessage(chatId, "That doesn't look like a valid contract address. Send a BNB Chain token address (0x...).");
      return;
    }

    await bot.sendMessage(chatId, "🔍 Checking token and your holdings...");

    try {
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const tokenContract = new ethers.Contract(addr, [
        "function balanceOf(address) view returns (uint256)",
        "function totalSupply() view returns (uint256)",
        "function symbol() view returns (string)",
        "function name() view returns (string)",
        "function decimals() view returns (uint8)",
      ], provider);

      const walletAddr = state.walletAddress!;
      const [balance, totalSupply, symbol, name, decimals] = await Promise.all([
        tokenContract.balanceOf(walletAddr),
        tokenContract.totalSupply(),
        tokenContract.symbol(),
        tokenContract.name(),
        tokenContract.decimals(),
      ]);

      const holdingPct = totalSupply > 0n ? Number((balance * 10000n) / totalSupply) / 100 : 0;

      if (holdingPct < 1) {
        await bot.sendMessage(chatId,
          `Your wallet holds only ${holdingPct.toFixed(2)}% of $${symbol}.\n\n` +
          `You need at least 1% of the supply to create a chaos plan. Buy more tokens first!`,
          { reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
        pendingChaosPlan.delete(chatId);
        return;
      }

      const holdingFormatted = ethers.formatUnits(balance, decimals);
      const holdingNum = parseFloat(holdingFormatted);
      const holdingDisplay = holdingNum >= 1000 ? Math.floor(holdingNum).toLocaleString("en-US") : holdingFormatted;

      await bot.sendMessage(chatId,
        `✅ Found $${symbol} (${name})\n\n` +
        `Your holdings: ${holdingDisplay} $${symbol} (${holdingPct.toFixed(1)}% of supply)\n\n` +
        `🤖 Generating your custom chaos plan...`,
      );

      const { generateChaosPlan, formatPlanPreview } = await import("./chaos-plan-generator");
      const agentName = `${symbol}_Agent`;
      const plan = await generateChaosPlan({
        tokenAddress: addr,
        tokenSymbol: symbol,
        tokenName: name,
        walletAddress: walletAddr,
        agentName,
      });

      const preview = formatPlanPreview(plan, symbol);

      state.step = "confirming";
      state.tokenAddress = addr;
      state.tokenSymbol = symbol;
      state.tokenName = name;
      state.plan = plan;
      pendingChaosPlan.set(chatId, state);

      await bot.sendMessage(chatId, preview, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Approve & Start Plan", callback_data: "chaos_approve" }],
            [{ text: "🔄 Regenerate Plan", callback_data: "chaos_regen" }],
            [{ text: "❌ Cancel", callback_data: "chaos_cancel" }],
          ],
        },
      });

    } catch (e: any) {
      console.error("[TelegramBot] Chaos plan error:", e.message);
      await bot.sendMessage(chatId,
        `❌ Error: ${e.message?.substring(0, 200) || "Failed to check token"}\n\nTry again with /chaos`,
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
      pendingChaosPlan.delete(chatId);
    }
    return;
  }
}

async function handleChaosPlanCallback(chatId: number, data: string): Promise<void> {
  if (!bot) return;
  const state = pendingChaosPlan.get(chatId);

  if (data === "chaos_approve") {
    if (!state || state.step !== "confirming" || !state.plan) {
      await bot.sendMessage(chatId, "No pending chaos plan found. Use /chaos to start.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    await bot.sendMessage(chatId, "⚡ Activating chaos plan...");

    try {
      const { createChaosPlanForUser, getUserChaosPlans } = await import("./chaos-launch");

      const existing = await getUserChaosPlans(state.walletAddress!);
      const hasOverlap = existing.some(p => p.launch.tokenAddress?.toLowerCase() === state.tokenAddress!.toLowerCase());
      if (hasOverlap) {
        await bot.sendMessage(chatId, "⚠️ You already have an active chaos plan for this token. Wait for it to complete or let it finish first.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        pendingChaosPlan.delete(chatId);
        return;
      }

      const result = await createChaosPlanForUser({
        tokenAddress: state.tokenAddress!,
        tokenSymbol: state.tokenSymbol!,
        tokenName: state.tokenName!,
        walletAddress: state.walletAddress!,
        plan: state.plan,
        chatId,
      });

      if (result.success) {
        const genesisM = state.plan.milestones?.find((m: any) => m.number === 0);
        let genesisTweet = "";
        if (genesisM) {
          try {
            const { postTweet } = await import("./twitter-client");
            const tweetResult = await postTweet(genesisM.tweetTemplate);
            genesisTweet = `\n\n📢 Genesis tweet posted: https://x.com/i/status/${tweetResult.tweetId}`;
          } catch (e: any) {
            genesisTweet = "\n\n⚠️ Genesis tweet failed (plan still active)";
          }
        }

        await bot.sendMessage(chatId,
          `🔥 *CHAOS PLAN ACTIVATED*\n\n` +
          `Token: $${state.tokenSymbol}\n` +
          `Milestones: ${state.plan.milestones.length}\n` +
          `Duration: 7 days\n` +
          `Wallet: \`${state.walletAddress!.substring(0, 10)}...${state.walletAddress!.slice(-6)}\`\n\n` +
          `Your agent will autonomously execute each milestone on schedule.` +
          `${genesisTweet}\n\n` +
          `Use /chaosstatus to check progress.`,
          { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
      } else {
        await bot.sendMessage(chatId, `❌ Failed to activate: ${result.error}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
      }
    } catch (e: any) {
      console.error("[TelegramBot] Chaos plan activation error:", e.message);
      await bot.sendMessage(chatId, `❌ Error: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }

    pendingChaosPlan.delete(chatId);
    return;
  }

  if (data === "chaos_regen") {
    if (!state || !state.tokenAddress) {
      await bot.sendMessage(chatId, "No pending chaos plan found. Use /chaos to start.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    await bot.sendMessage(chatId, "🔄 Regenerating plan...");

    try {
      const { generateChaosPlan, formatPlanPreview } = await import("./chaos-plan-generator");
      const plan = await generateChaosPlan({
        tokenAddress: state.tokenAddress,
        tokenSymbol: state.tokenSymbol!,
        tokenName: state.tokenName!,
        walletAddress: state.walletAddress!,
        agentName: `${state.tokenSymbol}_Agent`,
      });

      state.plan = plan;
      state.step = "confirming";
      pendingChaosPlan.set(chatId, state);

      const preview = formatPlanPreview(plan, state.tokenSymbol!);

      await bot.sendMessage(chatId, preview, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Approve & Start Plan", callback_data: "chaos_approve" }],
            [{ text: "🔄 Regenerate Plan", callback_data: "chaos_regen" }],
            [{ text: "❌ Cancel", callback_data: "chaos_cancel" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Error regenerating: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
      pendingChaosPlan.delete(chatId);
    }
    return;
  }

  if (data === "chaos_cancel") {
    pendingChaosPlan.delete(chatId);
    await bot.sendMessage(chatId, "Chaos plan cancelled.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
    return;
  }
}

async function handleAsterMenu(chatId: number): Promise<void> {
  if (!bot) return;

  let creds: any = null;
  try {
    creds = await storage.getAsterCredentials(chatId.toString());
  } catch (e: any) {
    console.error("[AsterMenu] Failed to get credentials:", e.message);
  }
  const connected = !!creds;

  if (!connected) {
    await bot.sendMessage(chatId,
      `📈 *Aster DEX — Futures & Spot Trading*\n\n` +
      `Trade futures and spot markets on Aster DEX directly from Telegram.\n\n` +
      `You need to connect your Aster API credentials first.\n` +
      `Get your API key at: https://www.asterdex.com`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔗 Connect Aster Account", callback_data: "aster:connect" }],
            [{ text: "« Back", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  await bot.sendMessage(chatId,
    `📈 *Aster DEX — Connected*\n\n` +
    `Your Aster API credentials are configured. What would you like to do?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 Balances", callback_data: "aster:balance" }],
          [{ text: "📊 Positions", callback_data: "aster:positions" }],
          [{ text: "📋 Open Orders", callback_data: "aster:orders" }],
          [{ text: "🔄 Futures Trade", callback_data: "aster:trade_futures" }, { text: "💱 Spot Trade", callback_data: "aster:trade_spot" }],
          [{ text: "🔌 Disconnect", callback_data: "aster:disconnect" }],
          [{ text: "« Back", callback_data: "action:menu" }],
        ],
      },
    }
  );
}

async function getAsterClient(chatId: number): Promise<any> {
  const creds = await storage.getAsterCredentials(chatId.toString());
  if (!creds) return null;
  const { createAsterClient } = await import("./aster-client");
  return createAsterClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
}

async function handleAsterCallback(chatId: number, data: string): Promise<void> {
  if (!bot) return;
  const action = data.replace("aster:", "");

  if (action === "connect") {
    pendingAsterConnect.set(chatId, { step: "api_key" });
    await bot.sendMessage(chatId,
      "🔗 *Connect Aster DEX*\n\n" +
      "Please send your Aster API Key:\n\n" +
      "You can create one at https://www.asterdex.com/account/api-management\n\n" +
      "Type /cancel to abort.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "disconnect") {
    await bot.sendMessage(chatId,
      "Are you sure you want to disconnect your Aster account? This will remove your stored API credentials.",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Yes, disconnect", callback_data: "aster:disconnect_confirm" }],
            [{ text: "Cancel", callback_data: "action:aster" }],
          ],
        },
      }
    );
    return;
  }

  if (action === "disconnect_confirm") {
    await storage.removeAsterCredentials(chatId.toString());
    await bot.sendMessage(chatId, "Aster account disconnected. Your API credentials have been removed.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
    return;
  }

  const client = await getAsterClient(chatId);
  if (!client) {
    await bot.sendMessage(chatId, "No Aster credentials found. Connect your account first.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Connect Aster Account", callback_data: "aster:connect" }],
          [{ text: "« Back", callback_data: "action:menu" }],
        ],
      },
    });
    return;
  }

  if (action === "balance") {
    await bot.sendMessage(chatId, "Loading Aster balances...");
    try {
      const [futuresBalances, spotAccount] = await Promise.all([
        client.futures.balance().catch(() => []),
        client.spot.account().catch(() => ({ balances: [] })),
      ]);

      let msg = "💰 *Aster DEX Balances*\n\n";

      const nonZeroFutures = (futuresBalances as any[]).filter((b: any) => parseFloat(b.balance) > 0 || parseFloat(b.availableBalance) > 0);
      if (nonZeroFutures.length > 0) {
        msg += "*Futures:*\n";
        for (const b of nonZeroFutures) {
          const upnl = parseFloat(b.crossUnPnl || "0");
          const upnlStr = upnl !== 0 ? ` (uPnL: ${upnl >= 0 ? "+" : ""}${upnl.toFixed(4)})` : "";
          msg += `  ${b.asset}: ${parseFloat(b.balance).toFixed(4)} (avail: ${parseFloat(b.availableBalance).toFixed(4)})${upnlStr}\n`;
        }
      } else {
        msg += "*Futures:* No balances\n";
      }

      msg += "\n";

      const nonZeroSpot = (spotAccount.balances || []).filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
      if (nonZeroSpot.length > 0) {
        msg += "*Spot:*\n";
        for (const b of nonZeroSpot) {
          const locked = parseFloat(b.locked);
          const lockedStr = locked > 0 ? ` (locked: ${locked.toFixed(4)})` : "";
          msg += `  ${b.asset}: ${parseFloat(b.free).toFixed(4)}${lockedStr}\n`;
        }
      } else {
        msg += "*Spot:* No balances\n";
      }

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "aster:balance" }],
            [{ text: "« Back", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to fetch balances: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (action === "positions") {
    await bot.sendMessage(chatId, "Loading futures positions...");
    try {
      const positions = await client.futures.positions();
      const openPositions = (positions as any[]).filter((p: any) => parseFloat(p.positionAmt) !== 0);

      if (openPositions.length === 0) {
        await bot.sendMessage(chatId, "📊 *Futures Positions*\n\nNo open positions.", {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Refresh", callback_data: "aster:positions" }],
              [{ text: "« Back", callback_data: "action:aster" }],
            ],
          },
        });
        return;
      }

      let msg = "📊 *Futures Positions*\n\n";
      for (const p of openPositions) {
        const amt = parseFloat(p.positionAmt);
        const direction = amt > 0 ? "LONG" : "SHORT";
        const upnl = parseFloat(p.unRealizedProfit);
        const pnlEmoji = upnl >= 0 ? "+" : "";
        msg += `*${p.symbol}* — ${direction}\n`;
        msg += `  Size: ${Math.abs(amt)} | Leverage: ${p.leverage}x\n`;
        msg += `  Entry: ${parseFloat(p.entryPrice).toFixed(4)} | Mark: ${parseFloat(p.markPrice).toFixed(4)}\n`;
        msg += `  uPnL: ${pnlEmoji}${upnl.toFixed(4)} USDT\n`;
        if (p.liquidationPrice && parseFloat(p.liquidationPrice) > 0) {
          msg += `  Liq: ${parseFloat(p.liquidationPrice).toFixed(4)}\n`;
        }
        msg += "\n";
      }

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "aster:positions" }],
            [{ text: "« Back", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to fetch positions: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (action === "orders") {
    await bot.sendMessage(chatId, "Loading open orders...");
    try {
      const [futuresOrders, spotOrders] = await Promise.all([
        client.futures.openOrders().catch(() => []),
        client.spot.openOrders().catch(() => []),
      ]);

      let msg = "📋 *Open Orders*\n\n";
      let hasOrders = false;

      if ((futuresOrders as any[]).length > 0) {
        hasOrders = true;
        msg += "*Futures:*\n";
        for (const o of futuresOrders as any[]) {
          msg += `  ${o.symbol} ${o.side} ${o.type} — Qty: ${o.origQty} Price: ${o.price || "MARKET"}\n`;
          msg += `    ID: ${o.orderId}\n`;
        }
        msg += "\n";
      }

      if ((spotOrders as any[]).length > 0) {
        hasOrders = true;
        msg += "*Spot:*\n";
        for (const o of spotOrders as any[]) {
          msg += `  ${o.symbol} ${o.side} ${o.type} — Qty: ${o.origQty} Price: ${o.price || "MARKET"}\n`;
          msg += `    ID: ${o.orderId}\n`;
        }
      }

      if (!hasOrders) {
        msg += "No open orders.";
      }

      const buttons: TelegramBot.InlineKeyboardButton[][] = [];
      if (hasOrders) {
        buttons.push([{ text: "❌ Cancel All Futures Orders", callback_data: "aster:cancel_all_orders" }]);
      }
      buttons.push([{ text: "🔄 Refresh", callback_data: "aster:orders" }]);
      buttons.push([{ text: "« Back", callback_data: "action:aster" }]);

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to fetch orders: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (action === "cancel_all_orders") {
    await bot.sendMessage(chatId,
      "Which symbol's orders do you want to cancel? Send the symbol (e.g. BTCUSDT) or type /cancel to abort."
    );
    pendingAsterTrade.set(chatId, { step: "cancel_symbol", market: "futures" });
    return;
  }

  if (action === "trade_futures") {
    pendingAsterTrade.set(chatId, { step: "symbol", market: "futures" });
    await bot.sendMessage(chatId,
      "🔄 *Futures Trade*\n\n" +
      "Enter the trading pair symbol (e.g. BTCUSDT, ETHUSDT):",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "trade_spot") {
    pendingAsterTrade.set(chatId, { step: "symbol", market: "spot" });
    await bot.sendMessage(chatId,
      "💱 *Spot Trade*\n\n" +
      "Enter the trading pair symbol (e.g. BTCUSDT, ETHUSDT):",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "trade_confirm") {
    const state = pendingAsterTrade.get(chatId);
    if (!state || state.step !== "confirm") {
      await bot.sendMessage(chatId, "No pending trade. Start over with /aster.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    await bot.sendMessage(chatId, "Placing order...");

    try {
      if (state.market === "futures") {
        if (state.leverage) {
          try {
            await client.futures.setLeverage(state.symbol!, state.leverage);
          } catch (e: any) {
            if (!e.message?.includes("No need to change")) {
              console.warn(`[Aster] Leverage set warning: ${e.message}`);
            }
          }
        }

        const orderResult = await client.futures.createOrder({
          symbol: state.symbol!,
          side: state.side!,
          type: state.orderType!,
          quantity: state.quantity!,
          price: state.orderType === "LIMIT" ? state.price : undefined,
          timeInForce: state.orderType === "LIMIT" ? "GTC" : undefined,
        });

        await bot.sendMessage(chatId,
          `*Order Placed*\n\n` +
          `Symbol: ${orderResult.symbol}\n` +
          `Side: ${orderResult.side}\n` +
          `Type: ${orderResult.type}\n` +
          `Quantity: ${orderResult.origQty}\n` +
          `${state.orderType === "LIMIT" ? `Price: ${orderResult.price}\n` : ""}` +
          `Order ID: ${orderResult.orderId}\n` +
          `Status: ${orderResult.status}`,
          { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
      } else {
        const orderResult = await client.spot.createOrder({
          symbol: state.symbol!,
          side: state.side!,
          type: state.orderType!,
          quantity: state.quantity!,
          price: state.orderType === "LIMIT" ? state.price : undefined,
          timeInForce: state.orderType === "LIMIT" ? "GTC" : undefined,
        });

        await bot.sendMessage(chatId,
          `*Order Placed*\n\n` +
          `Symbol: ${orderResult.symbol}\n` +
          `Side: ${orderResult.side}\n` +
          `Type: ${orderResult.type}\n` +
          `Quantity: ${orderResult.origQty}\n` +
          `${state.orderType === "LIMIT" ? `Price: ${orderResult.price}\n` : ""}` +
          `Order ID: ${orderResult.orderId}\n` +
          `Status: ${orderResult.status}`,
          { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to place order: ${e.message?.substring(0, 300)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }

    pendingAsterTrade.delete(chatId);
    return;
  }

  if (action === "trade_cancel") {
    pendingAsterTrade.delete(chatId);
    await bot.sendMessage(chatId, "Trade cancelled.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
    return;
  }

  if (action === "side_buy") {
    await handleAsterSideCallback(chatId, "BUY");
    return;
  }

  if (action === "side_sell") {
    await handleAsterSideCallback(chatId, "SELL");
    return;
  }

  if (action === "type_market") {
    await handleAsterTypeCallback(chatId, "MARKET");
    return;
  }

  if (action === "type_limit") {
    await handleAsterTypeCallback(chatId, "LIMIT");
    return;
  }

  if (action.startsWith("lev_")) {
    const lev = parseInt(action.replace("lev_", ""), 10);
    if (!isNaN(lev)) {
      await handleAsterLeverageCallback(chatId, lev);
    }
    return;
  }
}

async function handleAsterConnectFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingAsterConnect.get(chatId);
  if (!state) return;

  const input = text.trim();

  if (state.step === "api_key") {
    if (input.length < 10) {
      await bot.sendMessage(chatId, "That doesn't look like a valid API key. Please try again or type /cancel.");
      return;
    }
    state.apiKey = input;
    state.step = "api_secret";
    pendingAsterConnect.set(chatId, state);
    await bot.sendMessage(chatId, "Now send your Aster API Secret:");
    return;
  }

  if (state.step === "api_secret") {
    if (input.length < 10) {
      await bot.sendMessage(chatId, "That doesn't look like a valid API secret. Please try again or type /cancel.");
      return;
    }

    await bot.sendMessage(chatId, "Verifying credentials...");

    try {
      const { createAsterClient } = await import("./aster-client");
      const testClient = createAsterClient({ apiKey: state.apiKey!, apiSecret: input });
      const pingOk = await testClient.futures.ping();

      if (!pingOk) {
        await bot.sendMessage(chatId, "Could not connect to Aster DEX. Please check your credentials and try again.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
        pendingAsterConnect.delete(chatId);
        return;
      }

      await storage.saveAsterCredentials(chatId.toString(), state.apiKey!, input);
      pendingAsterConnect.delete(chatId);
      auditLog(chatId, "ASTER_CONNECT", "Aster DEX API credentials stored");

      await bot.sendMessage(chatId,
        "Aster DEX account connected! Your API credentials are stored securely (encrypted).\n\n" +
        "You can now trade futures and spot on Aster DEX.",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💰 View Balances", callback_data: "aster:balance" }],
              [{ text: "📈 Aster Menu", callback_data: "action:aster" }],
              [{ text: "« Main Menu", callback_data: "action:menu" }],
            ],
          },
        }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to verify credentials: ${e.message?.substring(0, 200)}\n\nPlease try again.`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
      pendingAsterConnect.delete(chatId);
    }
    return;
  }
}

async function handleAsterTradeFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state) return;

  const input = text.trim().toUpperCase();

  if (state.step === "cancel_symbol") {
    if (!/^[A-Z]{2,20}$/.test(input)) {
      await bot.sendMessage(chatId, "Invalid symbol. Enter a valid trading pair like BTCUSDT, ETHUSDT. Or type /cancel.");
      return;
    }
    try {
      const creds = await storage.getAsterCredentials(chatId.toString());
      if (!creds) { pendingAsterTrade.delete(chatId); return; }
      const { createAsterClient } = await import("./aster-client");
      const client = createAsterClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
      await client.futures.cancelAllOrders(input);
      await bot.sendMessage(chatId, `✅ All open orders for *${input}* have been cancelled.`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to cancel orders: ${e.message?.substring(0, 100)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    pendingAsterTrade.delete(chatId);
    return;
  }

  if (state.step === "symbol") {
    if (!/^[A-Z]{2,20}$/.test(input)) {
      await bot.sendMessage(chatId, "Invalid symbol. Enter a valid trading pair like BTCUSDT, ETHUSDT. Or type /cancel.");
      return;
    }
    state.symbol = input;
    state.step = "side";
    pendingAsterTrade.set(chatId, state);

    await bot.sendMessage(chatId,
      `Symbol: *${input}*\n\nChoose direction:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "BUY / LONG", callback_data: "aster:side_buy" }, { text: "SELL / SHORT", callback_data: "aster:side_sell" }],
            [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
          ],
        },
      }
    );
    return;
  }

  if (state.step === "quantity") {
    const qty = parseFloat(input);
    if (isNaN(qty) || qty <= 0) {
      await bot.sendMessage(chatId, "Invalid quantity. Enter a positive number (e.g. 0.001, 1, 100). Or type /cancel.");
      return;
    }
    state.quantity = input;

    if (state.orderType === "LIMIT") {
      state.step = "price";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId, "Enter the limit price:");
      return;
    }

    if (state.market === "futures") {
      state.step = "leverage";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId,
        "Set leverage (1-125):",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "1x", callback_data: "aster:lev_1" }, { text: "3x", callback_data: "aster:lev_3" }, { text: "5x", callback_data: "aster:lev_5" }],
              [{ text: "10x", callback_data: "aster:lev_10" }, { text: "20x", callback_data: "aster:lev_20" }, { text: "50x", callback_data: "aster:lev_50" }],
              [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
            ],
          },
        }
      );
      return;
    }

    showAsterTradeConfirmation(chatId, state);
    return;
  }

  if (state.step === "price") {
    const price = parseFloat(input);
    if (isNaN(price) || price <= 0) {
      await bot.sendMessage(chatId, "Invalid price. Enter a positive number. Or type /cancel.");
      return;
    }
    state.price = input;

    if (state.market === "futures") {
      state.step = "leverage";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId,
        "Set leverage (1-125):",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "1x", callback_data: "aster:lev_1" }, { text: "3x", callback_data: "aster:lev_3" }, { text: "5x", callback_data: "aster:lev_5" }],
              [{ text: "10x", callback_data: "aster:lev_10" }, { text: "20x", callback_data: "aster:lev_20" }, { text: "50x", callback_data: "aster:lev_50" }],
              [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
            ],
          },
        }
      );
      return;
    }

    showAsterTradeConfirmation(chatId, state);
    return;
  }

  if (state.step === "leverage") {
    const lev = parseInt(input, 10);
    if (isNaN(lev) || lev < 1 || lev > 125) {
      await bot.sendMessage(chatId, "Invalid leverage. Enter a number between 1 and 125. Or type /cancel.");
      return;
    }
    state.leverage = lev;
    showAsterTradeConfirmation(chatId, state);
    return;
  }
}

async function showAsterTradeConfirmation(chatId: number, state: AsterTradeState): Promise<void> {
  if (!bot) return;
  state.step = "confirm";
  pendingAsterTrade.set(chatId, state);

  let msg = `*Confirm ${state.market === "futures" ? "Futures" : "Spot"} Order*\n\n`;
  msg += `Symbol: ${state.symbol}\n`;
  msg += `Side: ${state.side}\n`;
  msg += `Type: ${state.orderType}\n`;
  msg += `Quantity: ${state.quantity}\n`;
  if (state.orderType === "LIMIT") msg += `Price: ${state.price}\n`;
  if (state.market === "futures" && state.leverage) msg += `Leverage: ${state.leverage}x\n`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Confirm Order", callback_data: "aster:trade_confirm" }],
        [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
      ],
    },
  });
}

async function handleAsterSideCallback(chatId: number, side: "BUY" | "SELL"): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state || state.step !== "side") return;

  state.side = side;
  state.step = "type";
  pendingAsterTrade.set(chatId, state);

  await bot.sendMessage(chatId,
    `${state.symbol} — ${side}\n\nOrder type:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Market", callback_data: "aster:type_market" }, { text: "Limit", callback_data: "aster:type_limit" }],
          [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
        ],
      },
    }
  );
}

async function handleAsterTypeCallback(chatId: number, orderType: "MARKET" | "LIMIT"): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state || state.step !== "type") return;

  state.orderType = orderType;
  state.step = "quantity";
  pendingAsterTrade.set(chatId, state);

  await bot.sendMessage(chatId, `${state.symbol} — ${state.side} ${orderType}\n\nEnter quantity:`);
}

async function handleAsterLeverageCallback(chatId: number, leverage: number): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state) return;

  state.leverage = leverage;
  showAsterTradeConfirmation(chatId, state);
}

async function handleOKXSwapFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingOKXSwap.get(chatId);
  if (!state) return;

  if (state.step === "from_token") {
    if (!text.startsWith("0x") || text.length < 42) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid token contract address (0x...):");
      return;
    }
    state.fromToken = text.trim();
    state.fromSymbol = text.trim().substring(0, 8) + "...";
    state.step = "to_token";
    const tokens = getOKXTokensForChain(state.chainId!);
    const tokenButtons = tokens.map(t => [{ text: t.symbol, callback_data: `okxswap_to:${t.address}:${t.symbol}` }]);
    tokenButtons.push([{ text: "📝 Custom Address", callback_data: "okxswap_to_custom" }]);
    await bot.sendMessage(chatId,
      `Token to sell: ${state.fromSymbol}\n\nSelect token to buy:`,
      { reply_markup: { inline_keyboard: tokenButtons } }
    );
    return;
  }

  if (state.step === "to_token") {
    if (!text.startsWith("0x") || text.length < 42) {
      await bot.sendMessage(chatId, "Invalid address. Enter a valid token contract address (0x...):");
      return;
    }
    state.toToken = text.trim();
    state.toSymbol = text.trim().substring(0, 8) + "...";
    state.step = "amount";
    await bot.sendMessage(chatId, `Enter the amount of ${state.fromSymbol} to swap:`);
    return;
  }

  if (state.step === "amount") {
    const num = Number(text);
    if (isNaN(num) || num <= 0) {
      await bot.sendMessage(chatId, "Invalid amount. Enter a positive number:");
      return;
    }
    state.amount = text.trim();
    state.step = "confirm";

    const fromTokenInfo = getOKXTokensForChain(state.chainId!).find(t => t.address === state.fromToken);
    const decimals = fromTokenInfo?.decimals || 18;
    const rawAmount = parseHumanAmount(state.amount, decimals);

    await bot.sendMessage(chatId, "Getting quote from OKX DEX Aggregator...");
    sendTyping(chatId);

    try {
      const { getSwapQuote } = await import("./okx-onchainos");
      const quote = await getSwapQuote({
        chainId: state.chainId!,
        fromTokenAddress: state.fromToken!,
        toTokenAddress: state.toToken!,
        amount: rawAmount,
        slippage: "1",
      });

      state.quoteData = quote?.data?.[0];
      state.step = "confirm";
      const toTokenInfo = getOKXTokensForChain(state.chainId!).find(t => t.address === state.toToken);
      const toDecimals = toTokenInfo?.decimals || 18;
      const receiveAmount = quote?.data?.[0]?.toTokenAmount
        ? formatTokenAmount(quote.data[0].toTokenAmount, toDecimals)
        : "—";

      await bot.sendMessage(chatId,
        `🔄 *Swap Quote*\n\n` +
        `Chain: ${state.chainName}\n` +
        `Sell: ${state.amount} ${state.fromSymbol}\n` +
        `Buy: ~${receiveAmount} ${state.toSymbol}\n\n` +
        `Confirm this swap?`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Confirm Swap", callback_data: "okxswap_confirm" }],
              [{ text: "❌ Cancel", callback_data: "action:menu" }],
            ]
          }
        }
      );
    } catch (err: any) {
      await bot.sendMessage(chatId,
        `Failed to get quote: ${err.message}\n\nTry again or go back to menu.`,
        { reply_markup: { inline_keyboard: [[{ text: "🔄 Try Again", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      pendingOKXSwap.delete(chatId);
    }
    return;
  }
}

async function handleOKXBridgeFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingOKXBridge.get(chatId);
  if (!state) return;

  if ((state.step as any) === "sol_address") {
    const addr = text.trim();
    if (addr.length < 32 || addr.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) {
      await bot.sendMessage(chatId, "❌ Invalid Solana address. Please enter a valid base58 Solana wallet address:");
      return;
    }
    state.receiveAddress = addr;
    state.step = "confirm";
    await bot.sendMessage(chatId,
      `✅ SOL wallet set: \`${addr.substring(0, 8)}...${addr.slice(-6)}\`\n\nConfirm this cross-chain swap?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Cross-Chain Swap", callback_data: "okxbridge_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } }
    );
    return;
  }

  if (state.step === "amount") {
    const num = Number(text);
    if (isNaN(num) || num <= 0) {
      await bot.sendMessage(chatId, "Invalid amount. Enter a positive number:");
      return;
    }
    state.amount = text.trim();

    if (state.toChainId === "501") {
      state.step = "sol_address" as any;
      const existingSol = solanaWalletMap.get(chatId);
      const buttons: any[][] = [];
      if (existingSol) {
        const shortSol = existingSol.address.substring(0, 8) + "..." + existingSol.address.slice(-6);
        buttons.push([{ text: `📱 Use my SOL wallet (${shortSol})`, callback_data: `sol_bridge_use:${existingSol.address}` }]);
      }
      buttons.push([{ text: "🔑 Generate new SOL wallet", callback_data: "sol_bridge_generate" }]);
      buttons.push([{ text: "📝 Enter my own SOL address", callback_data: "sol_bridge_custom" }]);
      await bot.sendMessage(chatId,
        `Where should your tokens go on Solana?`,
        { reply_markup: { inline_keyboard: buttons } }
      );
    } else {
      state.step = "receiver";
      const wallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);
      const currentWallet = wallets[activeIdx];

      if (currentWallet) {
        const shortAddr = currentWallet.substring(0, 8) + "..." + currentWallet.slice(-6);
        await bot.sendMessage(chatId,
          `Enter the wallet address to receive tokens on ${state.toChainName}:\n\n` +
          `Or tap below to use your current wallet:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: `Use ${shortAddr}`, callback_data: `okxbridge_usewallet:${currentWallet}` }],
              ]
            }
          }
        );
      } else {
        await bot.sendMessage(chatId, `Enter the wallet address to receive tokens on ${state.toChainName} (0x...):`);
      }
    }
    return;
  }

  if (state.step === "receiver") {
    const addr = text.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      await bot.sendMessage(chatId, "Invalid wallet address. Enter a valid 0x address:");
      return;
    }
    state.receiver = addr;
    await executeBridgeQuote(chatId, state);
    return;
  }
}

async function executeBridgeQuote(chatId: number, state: OKXBridgeState): Promise<void> {
  if (!bot) return;

  const rawAmount = parseHumanAmount(state.amount!, state.fromDecimals || 18);
  const walletAddr = state.receiver || getLinkedWallet(chatId);
  if (!walletAddr) {
    await bot.sendMessage(chatId, "No wallet found. Use /start to create one.");
    return;
  }

  await bot.sendMessage(chatId, "🔍 Getting bridge quote from Li.Fi...");
  sendTyping(chatId);

  try {
    const normFromToken = state.fromToken === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ? "0x0000000000000000000000000000000000000000" : state.fromToken;
    const normToToken = state.toToken === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ? "0x0000000000000000000000000000000000000000" : state.toToken;

    const lifiUrl = `https://li.quest/v1/quote?fromChain=${state.fromChainId}&toChain=${state.toChainId}&fromToken=${normFromToken}&toToken=${normToToken}&fromAmount=${rawAmount}&fromAddress=${walletAddr}&slippage=0.01`;
    const resp = await fetch(lifiUrl, { headers: { "Accept": "application/json" } });
    const lifiData = await resp.json() as any;

    if (lifiData.message || !lifiData.estimate) {
      throw new Error(lifiData.message || "No route found for this bridge pair");
    }

    const receiveAmount = lifiData.estimate?.toAmount
      ? formatTokenAmount(lifiData.estimate.toAmount, state.toDecimals || 18)
      : "—";

    const estSeconds = lifiData.estimate?.executionDuration;
    const timeStr = estSeconds
      ? (Number(estSeconds) < 60 ? `${estSeconds}s` : `~${Math.ceil(Number(estSeconds) / 60)} min`)
      : "—";
    const bridgeName = lifiData.toolDetails?.name || lifiData.tool || "Li.Fi";
    const shortReceiver = walletAddr.substring(0, 8) + "..." + walletAddr.slice(-6);

    state.quoteData = { _provider: "lifi", _lifiQuote: lifiData, bridgeProvider: bridgeName };
    state.receiveAddress = walletAddr;
    state.step = "confirm";

    await bot.sendMessage(chatId,
      `🌉 *Bridge Quote*\n\n` +
      `Route: ${state.fromChainName} → ${state.toChainName}\n` +
      `Send: ${state.amount} ${state.fromSymbol}\n` +
      `Receive: ~${receiveAmount} ${state.toSymbol}\n` +
      `Via: ${bridgeName}\n` +
      `Est. Time: ${timeStr}\n` +
      `Deliver To: ${shortReceiver}\n\n` +
      `Confirm this bridge?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Bridge", callback_data: "okxbridge_confirm" }],
            [{ text: "❌ Cancel", callback_data: "action:menu" }],
          ]
        }
      }
    );
  } catch (err: any) {
    await bot.sendMessage(chatId,
      `Failed to get bridge quote: ${err.message?.substring(0, 150)}\n\nTry a different token pair or go back to menu.`,
      { reply_markup: { inline_keyboard: [[{ text: "🌉 Try Again", callback_data: "action:okxbridge" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
    );
    pendingOKXBridge.delete(chatId);
  }
}

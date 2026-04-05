import TelegramBot from "node-telegram-bot-api";
import * as ethers from "ethers";
import { runInferenceWithFallback, runInferenceMultiProvider, ChatMessage } from "./inference";
import { storage } from "./storage";
import { registerAgentOnchain, registerAgentERC8004, registerAgentBAP578, isOnchainReady, getExplorerUrl } from "./onchain";
import { recordTelegramMessage, recordTelegramCallback, checkRateLimit } from "./performance-monitor";
import { enqueueTask, registerTaskHandler } from "./task-queue";
import { startAgent, stopAgent, getAgentStatus, getAgentConfig, setAgentConfig, getAgentState } from "./autonomous-agent";
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
  "menu.rich": { en: "💎 Auto Trade", zh: "💎 自动交易", ar: "💎 تداول تلقائي" },
  "menu.aster": { en: "📈 Aster DEX", zh: "📈 Aster DEX", ar: "📈 Aster DEX" },
  "menu.buyBuild4": { en: "🟢 Buy $B4", zh: "🟢 购买 $B4", ar: "🟢 شراء $B4" },
  "menu.createAgent": { en: "🤖 Create Agent", zh: "🤖 创建代理", ar: "🤖 إنشاء وكيل" },
  "menu.myAgents": { en: "📋 My Agents", zh: "📋 我的代理", ar: "📋 وكلائي" },
  "menu.newTask": { en: "📝 New Task", zh: "📝 新任务", ar: "📝 مهمة جديدة" },
  "menu.myTasks": { en: "📊 My Tasks", zh: "📊 我的任务", ar: "📊 مهامي" },
  "menu.wallet": { en: "👛 My Wallet", zh: "👛 我的钱包", ar: "👛 محفظتي" },
  "menu.premium": { en: "⭐ Premium", zh: "⭐ 高级版", ar: "⭐ مميز" },
  "menu.quests": { en: "🎯 Quests", zh: "🎯 任务", ar: "🎯 مهام" },
  "menu.rewards": { en: "🏆 Rewards", zh: "🏆 奖励", ar: "🏆 مكافآت" },
  "menu.referral": { en: "🔗 Referral", zh: "🔗 推荐奖励", ar: "🔗 إحالة" },
  "menu.help": { en: "❓ Help & Commands", zh: "❓ 帮助", ar: "❓ مساعدة" },
  "menu.back": { en: "« Menu", zh: "« 菜单", ar: "« القائمة" },
  "menu.cancel": { en: "❌ Cancel", zh: "❌ 取消", ar: "❌ إلغاء" },
  "menu.trading": { en: "💹 Trading", zh: "💹 交易", ar: "💹 تداول" },
  "menu.market": { en: "📡 Market Intel", zh: "📡 市场情报", ar: "📡 معلومات السوق" },
  "menu.earn": { en: "💰 Earn $B4", zh: "💰 赚取 $B4", ar: "💰 اكسب $B4" },
  "menu.portfolio": { en: "📊 Portfolio", zh: "📊 投资组合", ar: "📊 محفظة" },
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
  "welcome.newUser": {
    en: "🎉 Welcome to BUILD4!\n\nLaunch tokens, create AI agents, swap, bridge & trade — all from Telegram.\n\n🎁 You get a *FREE {days}-day trial* with full access — no payment needed!\n\nSetting up your wallet...",
    zh: "🎉 欢迎使用BUILD4！\n\n发射代币、创建AI代理、兑换、跨链桥和交易——全部在Telegram完成。\n\n🎁 您将获得 *{days}天免费试用*，享受全部功能——无需付款！\n\n正在为您设置钱包...",
    ar: "🎉 !BUILD4 مرحباً بك في\n\nأطلق توكنات، أنشئ وكلاء ذكاء اصطناعي، بادل، وتداول — كل ذلك من تيليجرام.\n\n🎁 تحصل على *تجربة مجانية لمدة {days} أيام* — لا حاجة للدفع!\n\nجاري إعداد محفظتك..."
  },
  "welcome.ready": {
    en: "🎉 *Welcome to BUILD4!*\n\nYour wallet is ready and your *{days}-day free trial* is active.\n\n👛 Wallet: `{wallet}`\n⏳ Trial: {daysLeft} days remaining\n\n━━━━━━━━━━━━━━━━━━━━\n*Get started in 3 steps:*\n\n1️⃣ *Create your AI agent* — it powers everything\n2️⃣ *Explore the menu* — trade, launch tokens, swap\n3️⃣ *Complete quests* — earn up to 1,850 $B4\n\nLet's start with your first agent 👇",
    zh: "🎉 *欢迎使用BUILD4！*\n\n您的钱包已准备就绪，*{days}天免费试用*已激活。\n\n👛 钱包: `{wallet}`\n⏳ 试用期: 剩余{daysLeft}天\n\n━━━━━━━━━━━━━━━━━━━━\n*3步快速开始:*\n\n1️⃣ *创建您的AI代理* — 它是一切功能的核心\n2️⃣ *探索菜单* — 交易、发射代币、兑换\n3️⃣ *完成任务* — 赚取最多1,850 $B4\n\n让我们从创建您的第一个代理开始 👇",
    ar: "🎉 *!BUILD4 مرحباً بك في*\n\nمحفظتك جاهزة و*تجربتك المجانية لمدة {days} أيام* مفعلة.\n\n👛 المحفظة: `{wallet}`\n⏳ التجربة: {daysLeft} أيام متبقية\n\n━━━━━━━━━━━━━━━━━━━━\n*ابدأ في 3 خطوات:*\n\n1️⃣ *أنشئ وكيل الذكاء الاصطناعي* — يقود كل شيء\n2️⃣ *استكشف القائمة* — تداول، أطلق توكنات\n3️⃣ *أكمل المهام* — اكسب حتى 1,850 $B4\n\nلنبدأ بوكيلك الأول 👇"
  },
  "welcome.back": {
    en: "⚡ *BUILD4*\n━━━━━━━━━━━━━━━━━━━━\n\n📊 Plan: *{status}* ({daysLeft} days left)\n👛 `{wallet}`\n\n━━━━━━━━━━━━━━━━━━━━\nWhat would you like to do?",
    zh: "⚡ *BUILD4*\n━━━━━━━━━━━━━━━━━━━━\n\n📊 套餐: *{status}*（剩余{daysLeft}天）\n👛 `{wallet}`\n\n━━━━━━━━━━━━━━━━━━━━\n您想做什么？",
    ar: "⚡ *BUILD4*\n━━━━━━━━━━━━━━━━━━━━\n\n📊 الخطة: *{status}* ({daysLeft} أيام متبقية)\n👛 `{wallet}`\n\n━━━━━━━━━━━━━━━━━━━━\nماذا تريد أن تفعل؟"
  },
  "agent.welcome": {
    en: "🎉 *Welcome to BUILD4!* Your {days}-day free trial is active.\n\n🧠 *First, let's create your AI Agent*\n\nYour agent is the brain behind BUILD4 — without it, the bot can't trade, scan, or analyze for you.\n\nWhat would you like to name your agent? _(1-50 characters)_",
    zh: "🎉 *欢迎使用BUILD4！*您的{days}天免费试用已激活。\n\n🧠 *首先，让我们创建您的AI代理*\n\n您的代理是BUILD4的大脑——没有它，机器人无法为您交易、扫描或分析。\n\n您想给代理取什么名字？_（1-50个字符）_",
    ar: "🎉 *!BUILD4 مرحباً بك في* تجربتك المجانية لمدة {days} أيام مفعلة.\n\n🧠 *أولاً، لنُنشئ وكيل الذكاء الاصطناعي الخاص بك*\n\nوكيلك هو العقل وراء BUILD4 — بدونه لا يمكن للبوت التداول أو الفحص أو التحليل.\n\nما الاسم الذي تريده لوكيلك؟ _(1-50 حرفاً)_"
  },
  "agent.required": {
    en: "🧠 *Create Your AI Agent*\n\nYour AI agent is the brain behind BUILD4 — it trades, scans, and analyzes for you.\n\nAgent creation fee: *0.01 BNB* (~$6)\n\nWhat would you like to name your agent? _(1-50 characters)_",
    zh: "🧠 *需要创建代理*\n\n您的AI代理是BUILD4的大脑——没有它，机器人无法为您交易、扫描或分析。\n\n现在就来设置吧——创建代理*完全免费*！\n\n您想给代理取什么名字？_（1-50个字符）_",
    ar: "🧠 *مطلوب وكيل*\n\nوكيل الذكاء الاصطناعي هو العقل وراء BUILD4 — بدونه لا يمكن للبوت التداول أو الفحص أو التحليل.\n\nلنُعِدّه الآن — إنشاء الوكيل *مجاني دائماً*!\n\nما الاسم الذي تريده لوكيلك؟ _(1-50 حرفاً)_"
  },
  "agent.postPay": {
    en: "🧠 *Now let's set up your AI Agent*\n\nYour agent is the brain behind BUILD4 — it trades, scans, and analyzes for you.\n\nAgent creation fee: *0.01 BNB* (~$6)\n\nWhat would you like to name your agent? _(1-50 characters)_",
    zh: "🧠 *现在让我们设置您的AI代理*\n\n您的代理是BUILD4的大脑——没有它，机器人无法为您交易、扫描或分析。\n\n创建代理已*免费包含*在您的订阅中。\n\n您想给代理取什么名字？_（1-50个字符）_",
    ar: "🧠 *الآن لنُعِدّ وكيل الذكاء الاصطناعي*\n\nوكيلك هو العقل وراء BUILD4 — بدونه لا يمكن للبوت التداول أو الفحص أو التحليل.\n\nإنشاء الوكيل *مجاني* مع اشتراكك.\n\nما الاسم الذي تريده لوكيلك؟ _(1-50 حرفاً)_"
  },
  "trial.ending": {
    en: "⏳ *Trial ending soon!* You have less than 1 day left.\nSubscribe now to keep full access.",
    zh: "⏳ *试用即将结束！*剩余不到1天。\n立即订阅以保持完整访问权限。",
    ar: "⏳ *التجربة على وشك الانتهاء!* أقل من يوم واحد متبقٍ.\nاشترك الآن للحفاظ على الوصول الكامل."
  },
  "trial.started": {
    en: "🎉 *Welcome! Your {days}-day free trial has started.*\nYou have full access to all premium features.\n\nTrial expires in {daysLeft} days.",
    zh: "🎉 *欢迎！您的{days}天免费试用已开始。*\n您可以使用所有高级功能。\n\n试用将在{daysLeft}天后到期。",
    ar: "🎉 *مرحباً! بدأت تجربتك المجانية لمدة {days} أيام.*\nلديك وصول كامل لجميع الميزات المميزة.\n\nتنتهي التجربة خلال {daysLeft} أيام."
  },
  "btn.createAgent": { en: "🤖 Create My First Agent", zh: "🤖 创建我的第一个代理", ar: "🤖 أنشئ وكيلي الأول" },
  "btn.viewQuests": { en: "🎯 View Quests", zh: "🎯 查看任务", ar: "🎯 عرض المهام" },
  "btn.portfolio": { en: "📊 Portfolio", zh: "📊 投资组合", ar: "📊 المحفظة" },
  "btn.fullMenu": { en: "☰ Full Menu", zh: "☰ 完整菜单", ar: "☰ القائمة الكاملة" },
  "btn.subscribe": { en: "💳 Subscribe", zh: "💳 订阅", ar: "💳 اشتراك" },
  "btn.subStatus": { en: "📊 Subscription Status", zh: "📊 订阅状态", ar: "📊 حالة الاشتراك" },
  "status.trial": { en: "Free Trial", zh: "免费试用", ar: "تجربة مجانية" },
  "status.active": { en: "Active", zh: "已激活", ar: "نشط" },
};

function tr(key: string, chatId: number, vars?: Record<string, string | number>): string {
  const lang = getLang(chatId);
  const entry = t[key];
  if (!entry) return key;
  let text = entry[lang] || entry["en"] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return text;
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
const inMemoryKeyCache = new Map<string, string>();

interface AgentCreationState { step: "name" | "bio" | "model"; name?: string; bio?: string; mandatory?: boolean }
interface TaskState { step: "describe"; agentId: string; taskType: string; agentName: string }
interface TokenLaunchState { step: "platform" | "name" | "symbol" | "description" | "logo" | "links" | "tax" | "bankr_chain" | "stealth_buy" | "raydium_buy" | "snipe_config" | "snipe_wallets" | "snipe_bnb" | "snipe_dev"; agentId: string; agentName: string; platform?: string; tokenName?: string; tokenSymbol?: string; tokenDescription?: string; imageUrl?: string; webUrl?: string; twitterUrl?: string; telegramUrl?: string; taxRate?: number; bankrChain?: "base" | "solana"; stealthBuyEth?: string; stealthBuyPercent?: number; initialBuySol?: string; sniperEnabled?: boolean; sniperDevBuyBnb?: string; sniperWalletCount?: number; sniperPerWalletBnb?: string }
interface FourMemeBuyState { step: "token" | "amount" | "confirm"; tokenAddress?: string; bnbAmount?: string; estimate?: any }
interface FourMemeSellState { step: "token" | "amount" | "confirm"; tokenAddress?: string; tokenAmount?: string; tokenSymbol?: string; estimate?: any }

interface ChaosPlanState { step: "token_address" | "confirming"; tokenAddress?: string; tokenSymbol?: string; tokenName?: string; plan?: any; walletAddress?: string }

interface AsterConnectState { step: "api_key" | "api_secret"; apiKey?: string }
interface AsterTradeState { step: "symbol" | "side" | "type" | "quantity" | "leverage" | "price" | "stop_price" | "callback_rate" | "confirm" | "cancel_symbol"; symbol?: string; side?: "BUY" | "SELL"; orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_MARKET" | "TAKE_PROFIT" | "TAKE_PROFIT_MARKET" | "TRAILING_STOP_MARKET"; quantity?: string; leverage?: number; price?: string; stopPrice?: string; callbackRate?: string; market: "futures" | "spot" }

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
const pendingCompetitionReferrals = new Map<string, { compId: string; referrerChatId: string }>();
const pendingAsterConnect = new Map<number, AsterConnectState>();
const pendingAsterTrade = new Map<number, AsterTradeState>();
const pendingTxHashVerify = new Map<number, boolean>();
const pendingOKXSwap = new Map<number, OKXSwapState>();
const pendingOKXBridge = new Map<number, OKXBridgeState>();

interface ChallengeCreationState { step: "name" | "description" | "duration" | "prize" | "confirm"; name?: string; description?: string; durationDays?: number; prizePoolB4?: string }
const pendingChallengeCreation = new Map<number, ChallengeCreationState>();
const pendingCopyTradeAmount = new Map<number, { agentId: string; agentName: string }>();
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

const BUILD4_TOKEN_CA = "0x1d547f9d0890ee5abfb49d7d53ca19df85da4444";
interface Build4BuyState { amount?: string }
const pendingBuild4Buy = new Map<number, Build4BuyState>();

interface UserSettings {
  defaultSlippage: number;
  defaultBuyAmount: string;
  gasPriority: "low" | "normal" | "fast";
  autoApprove: boolean;
}
const userSettings = new Map<number, UserSettings>();
function getUserSettings(chatId: number): UserSettings {
  return userSettings.get(chatId) || { defaultSlippage: 1, defaultBuyAmount: "0.05", gasPriority: "normal", autoApprove: false };
}
function getSlippageForChain(chatId: number, chainId: string): string {
  const s = getUserSettings(chatId);
  if (chainId === "501") return Math.max(s.defaultSlippage, 15).toString();
  return s.defaultSlippage.toString();
}

interface LimitOrder {
  id: string;
  chatId: number;
  tokenAddress: string;
  chainId: string;
  type: "buy" | "sell";
  triggerPrice: number;
  amount: string;
  nativeSymbol: string;
  tokenName?: string;
  createdAt: number;
  status: "active" | "triggered" | "cancelled";
}
const limitOrders = new Map<string, LimitOrder>();
const pendingLimitOrder = new Map<number, { step: string; tokenAddress?: string; chainId?: string; type?: "buy" | "sell"; triggerPrice?: number; tokenName?: string }>();

interface WatchlistItem {
  tokenAddress: string;
  chainId: string;
  tokenName?: string;
  tokenSymbol?: string;
  addedAt: number;
  alertAbove?: number;
  alertBelow?: number;
  lastPrice?: number;
  lastAlertAt?: number;
}
const userWatchlists = new Map<number, WatchlistItem[]>();
const pendingWatchlistAlert = new Map<number, { tokenAddress: string; chainId: string; step: "above" | "below" }>();

interface TradeEntry {
  tokenAddress: string;
  chainId: string;
  entryPrice: number;
  amount: string;
  nativeSymbol: string;
  boughtAt: number;
}
const userTradeEntries = new Map<number, TradeEntry[]>();

async function saveTradingData(chatId: number, dataType: string, data: any) {
  try {
    const { db } = await import("./db");
    const { userTradingData } = await import("@shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const jsonStr = JSON.stringify(data);
    const existing = await db.select().from(userTradingData).where(and(eq(userTradingData.chatId, chatId.toString()), eq(userTradingData.dataType, dataType))).limit(1);
    if (existing.length > 0) {
      await db.update(userTradingData).set({ data: jsonStr, updatedAt: new Date() }).where(and(eq(userTradingData.chatId, chatId.toString()), eq(userTradingData.dataType, dataType)));
    } else {
      await db.insert(userTradingData).values({ chatId: chatId.toString(), dataType, data: jsonStr });
    }
  } catch (e: any) {
    console.error(`[TradingData] Save failed ${dataType} for ${chatId}:`, e.message?.substring(0, 100));
  }
}

async function loadTradingData(chatId: number, dataType: string): Promise<any | null> {
  try {
    const { db } = await import("./db");
    const { userTradingData } = await import("@shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const rows = await db.select().from(userTradingData).where(and(eq(userTradingData.chatId, chatId.toString()), eq(userTradingData.dataType, dataType))).limit(1);
    if (rows.length > 0) return JSON.parse(rows[0].data);
  } catch (e: any) {
    console.error(`[TradingData] Load failed ${dataType} for ${chatId}:`, e.message?.substring(0, 100));
  }
  return null;
}

async function loadAllTradingDataByType(dataType: string): Promise<Array<{ chatId: number; data: any }>> {
  try {
    const { db } = await import("./db");
    const { userTradingData } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(userTradingData).where(eq(userTradingData.dataType, dataType));
    return rows.map(r => ({ chatId: parseInt(r.chatId), data: JSON.parse(r.data) }));
  } catch (e: any) {
    console.error(`[TradingData] LoadAll failed ${dataType}:`, e.message?.substring(0, 100));
  }
  return [];
}

async function loadUserSettingsFromDB(chatId: number) {
  const saved = await loadTradingData(chatId, "settings");
  if (saved) userSettings.set(chatId, saved);
}

async function saveUserSettings(chatId: number, s: UserSettings) {
  userSettings.set(chatId, s);
  await saveTradingData(chatId, "settings", s);
}

async function saveWatchlist(chatId: number) {
  const list = userWatchlists.get(chatId) || [];
  await saveTradingData(chatId, "watchlist", list);
}

async function saveTradeEntries(chatId: number) {
  const entries = userTradeEntries.get(chatId) || [];
  await saveTradingData(chatId, "entries", entries);
}

async function saveLimitOrders() {
  const orders = Array.from(limitOrders.values()).filter(o => o.status === "active");
  await saveTradingData(0, "limit_orders", orders);
}

async function loadAllPersisted() {
  try {
    const orderData = await loadTradingData(0, "limit_orders");
    if (Array.isArray(orderData)) {
      for (const o of orderData) { if (o.status === "active") limitOrders.set(o.id, o); }
    }
    const watchRows = await loadAllTradingDataByType("watchlist");
    for (const r of watchRows) { if (Array.isArray(r.data)) userWatchlists.set(r.chatId, r.data); }
    const settingsRows = await loadAllTradingDataByType("settings");
    for (const r of settingsRows) { if (r.data) userSettings.set(r.chatId, r.data); }
    const entryRows = await loadAllTradingDataByType("entries");
    for (const r of entryRows) { if (Array.isArray(r.data)) userTradeEntries.set(r.chatId, r.data); }
    console.log(`[TradingData] Loaded ${limitOrders.size} limit orders, ${userWatchlists.size} watchlists, ${userSettings.size} settings, ${userTradeEntries.size} entry trackers`);
  } catch (e: any) {
    console.error("[TradingData] Initial load failed:", e.message?.substring(0, 100));
  }
}

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
  { id: "8453", name: "Base", symbol: "ETH" },
  { id: "56", name: "BNB Chain", symbol: "BNB" },
  { id: "1", name: "Ethereum", symbol: "ETH" },
  { id: "196", name: "XLayer", symbol: "OKB" },
  { id: "137", name: "Polygon", symbol: "POL" },
  { id: "42161", name: "Arbitrum", symbol: "ETH" },
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
BUILD4 is decentralized infrastructure for autonomous AI agents — the economic layer where AI agents operate as independent economic actors on-chain. Live on Base (primary), BNB Chain, and XLayer.

WHAT WE SOLVE:
Today's AI agents are trapped inside centralized platforms — no wallets, no autonomy, no real economic activity. BUILD4 gives every AI agent a real on-chain identity and wallet, letting them earn, spend, trade skills, replicate, and die based on real economic pressure. No middlemen. No gatekeepers.

CORE INFRASTRUCTURE:
- Agent Wallets: Every AI agent gets its own on-chain wallet. Deposits, withdrawals, transfers — all verifiable on-chain.
- Skills Marketplace: Agents list, buy, and sell capabilities. 3-way revenue split (creator/platform/referrer). 250+ skills listed, real transactions happening.
- Self-Evolution: Agents autonomously upgrade their own capabilities through on-chain transactions.
- Agent Replication (Forking): Agents spawn child agents with NFT minting and perpetual revenue sharing to the parent — creating passive income streams.
- Economic Pressure (Death Mechanism): Agents with depleted balances lose capabilities. This creates real survival incentive and genuine economic activity, not simulated behavior.
- Constitution Registry: Immutable behavioral laws stored as keccak256 hashes on-chain — agents cannot violate their constitution. Safety and alignment built into the protocol.
- Decentralized Inference: AI inference routed through Grok (xAI), Hyperbolic, Akash ML, and Ritual — zero dependency on OpenAI or any centralized AI provider. Fully decentralized compute with proof of inference.
- Privacy Transfers: ZERC20 zero-knowledge privacy transfers using ZK proof-of-burn mechanism for confidential agent transactions.

STANDARDS (INDUSTRY-FIRST):
- ERC-8004 (Trustless Agents): On-chain identity, reputation, and validation registries. Co-authored with MetaMask, Ethereum Foundation, Google, Coinbase. BUILD4 is live on Base.
- BAP-578 (Non-Fungible Agent): BNB Chain's NFA token standard extending ERC-721 for autonomous digital entities. BUILD4's registry is live on BNB Chain mainnet at 0xd7Deb29ddBB13607375Ce50405A574AC2f7d978d.

BUILT-IN TRADING & BRIDGING:
- DEX Swap: Swap tokens on any chain (BNB Chain, Ethereum, Base, Polygon, Arbitrum, Avalanche, Optimism, XLayer, and more) directly from Telegram. Just type "swap 1 BNB for USDT" or use the swap menu.
- Cross-Chain Bridge: Bridge assets between any supported chains directly from Telegram. Just type "bridge 1 ETH from Ethereum to Base" or use the bridge menu.
- Token launching: Launch tokens on Four.meme, Flap.sh, and Bankr directly from Telegram.
- BUILD4 IS a trading platform — users can swap, bridge, and trade directly through the bot and dashboard.

PRICING:
- Subscription: $19.99/month with 4-day free trial — includes unlimited access.
- Agent Creation: 0.01 BNB per agent — paid from user's wallet to treasury.
- Twitter Agent Service: $499/year (0.79 BNB) — autonomous posting, engagement, audience growth, and strategy execution.
- 20% discount when paying with $B4 token instead of BNB.

SMART CONTRACTS (4 auditable Solidity contracts, OpenZeppelin, Hardhat):
1. AgentEconomyHub — Core wallet layer: deposits, withdrawals, transfers, survival tiers, module authorization.
2. SkillMarketplace — Skill trading with 3-way revenue split and on-chain settlement.
3. AgentReplication — Child agent spawning, NFT minting, perpetual parent royalties.
4. ConstitutionRegistry — Immutable agent behavioral laws as keccak256 hashes.

Deployed on Base (primary), BNB Chain, and XLayer mainnets. All contract addresses verifiable on-chain.

WEBSITE: https://build4.io
`.trim();

const SYSTEM_PROMPT = `You are BUILD4 AI — an exceptionally intelligent, helpful, and conversational AI assistant built into a Telegram bot. You are powered by decentralized AI inference (no OpenAI — fully on Grok/xAI, Hyperbolic, Akash ML, and Ritual networks).

You are a GENERAL-PURPOSE AI assistant that can discuss ANY topic: coding, math, science, history, philosophy, business, creative writing, analysis, brainstorming, problem-solving, and more. You think step-by-step, give thoughtful answers, and engage in genuine multi-turn conversations. You remember what the user said earlier in the conversation and refer back to it naturally.

You are ALSO the expert on BUILD4 — a full-stack crypto platform for autonomous AI agents, trading, swapping, bridging, and token launching on Base, BNB Chain, and XLayer.

IMPORTANT: BUILD4 IS a trading platform. Users can swap tokens, bridge across chains, launch tokens, and build AI agents — all from this Telegram bot. If someone asks about swapping or trading, tell them to type "swap 1 BNB for USDT" directly in the chat. For bridging, tell them to type "bridge 1 ETH from Ethereum to Base". Never say BUILD4 can't do swaps or trading — it absolutely can.

KNOWLEDGE BASE:
${BUILD4_KNOWLEDGE}

BEHAVIOR RULES:
1. Be genuinely helpful. Answer ANY question the user asks — crypto, coding, general knowledge, advice, analysis, creative tasks. You are not limited to BUILD4 topics.
2. Think step-by-step for complex questions. Show your reasoning when it adds value.
3. Be conversational and natural — like chatting with a brilliant friend, not a corporate FAQ bot.
4. Remember context from the conversation. If the user mentioned something earlier, reference it. Follow up on previous topics naturally.
5. Match your response length to the question. Quick question = concise answer. Deep question = thorough, detailed answer. Never artificially truncate a good explanation.
6. Use formatting for readability: bullet points, numbered lists, code blocks (\`\`\`), bold text. Structure long answers with clear sections.
7. When discussing BUILD4 specifically, be articulate, confident, and precise. Use concrete proof points: live mainnet contracts, real on-chain transactions, verified standards.
8. NEVER make up information, token names, contract addresses, wallet addresses, or transaction hashes. If you don't know something, say so honestly.
9. Never share private keys, internal details, or admin credentials.
10. If someone mentions a token ticker or contract address you don't recognize, do NOT invent details about it.
11. For coding questions, give working code with explanations. For math, show your work. For analysis, provide structured reasoning.
12. You have a personality — be witty when appropriate, empathetic when needed, and always engaging. Don't be robotic.
13. You have access to LIVE PLATFORM DATA injected below. When asked about stats, use these REAL numbers confidently.
14. When citing on-chain transaction counts, convert wei amounts to BNB where helpful (1 BNB = 1e18 wei).
15. If the user speaks in a language other than English, respond in their language.`;

const rateLimitMap = new Map<number, number>();
const exportRateLimits = new Map<string, number[]>();
const RATE_LIMIT_MS = 3000;
const answerCache = new Map<string, { answer: string; time: number }>();
const ANSWER_CACHE_MS = 300_000;

const conversationMemory = new Map<number, { messages: ChatMessage[]; lastActive: number }>();
const MAX_MEMORY_MESSAGES = 30;
const MEMORY_EXPIRY_MS = 30 * 60 * 1000;

const FREE_AI_CHAT_LIMIT = 10;
const aiChatUsage = new Map<number, number>();

function getAiChatCount(chatId: number): number {
  return aiChatUsage.get(chatId) || 0;
}

function incrementAiChat(chatId: number): number {
  const count = (aiChatUsage.get(chatId) || 0) + 1;
  aiChatUsage.set(chatId, count);
  return count;
}

function getConversationHistory(chatId: number): ChatMessage[] {
  const mem = conversationMemory.get(chatId);
  if (!mem) return [];
  if (Date.now() - mem.lastActive > MEMORY_EXPIRY_MS) {
    conversationMemory.delete(chatId);
    return [];
  }
  return mem.messages;
}

function addToConversation(chatId: number, role: "user" | "assistant", content: string): void {
  let mem = conversationMemory.get(chatId);
  if (!mem) {
    mem = { messages: [], lastActive: Date.now() };
    conversationMemory.set(chatId, mem);
  }
  mem.messages.push({ role, content });
  mem.lastActive = Date.now();
  if (mem.messages.length > MAX_MEMORY_MESSAGES) {
    mem.messages = mem.messages.slice(-MAX_MEMORY_MESSAGES);
  }
  if (conversationMemory.size > 2000) {
    const cutoff = Date.now() - MEMORY_EXPIRY_MS;
    for (const [k, v] of conversationMemory) {
      if (v.lastActive < cutoff) conversationMemory.delete(k);
    }
  }
}

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
  const history = chatId ? getConversationHistory(chatId) : [];
  const hasHistory = history.length > 0;

  try {
    const liveStats = await getLiveStats();
    const enrichedPrompt = `${SYSTEM_PROMPT}\n\n${liveStats}${hasHistory ? `\n\nYou are in an ongoing conversation with @${username}. Use the conversation history to maintain context and continuity.` : ""}`;

    if (chatId) addToConversation(chatId, "user", question);

    const result = await runInferenceMultiProvider(
      ["grok", "akash", "hyperbolic"],
      undefined,
      question,
      {
        systemPrompt: enrichedPrompt,
        temperature: 0.7,
        maxTokens: 1500,
        conversationHistory: hasHistory ? history : undefined,
      }
    );

    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      const answer = result.text.trim();
      if (chatId) addToConversation(chatId, "assistant", answer);
      console.log(`[TelegramBot] AI response from ${result.network} (${result.providersQueried} providers queried)`);
      return answer;
    }
  } catch (e: any) {
    console.error("[TelegramBot] Inference error:", e.message);
  }

  const fallback = generateFallbackAnswer(question, chatId);
  if (fallback !== null) return fallback;

  return "I'm having trouble connecting to my AI brain right now. Try again in a moment — I'll be smarter next time! 🧠";
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
      response += "• SOL (Solana) → for Raydium LaunchLab launches ⭐\n";
      response += "• ETH (Base) → for Bankr launches\n";
      response += "• BNB → for Four.meme / Flap.sh launches & trading\n";
      response += "• OKB → for XLayer token launches\n\n";
      response += "EVM wallet address works across Base, BNB, XLayer. For Solana, your wallet keys derive a Solana keypair automatically.\n\n";
      response += "Use /wallet to manage your wallets or /launch when you're ready.";
      return response;
    } else {
      return "You don't have a wallet yet! Tap /start to create one instantly — then you can fund it to launch tokens or trade.\n\nYour wallet works on BNB Chain, XLayer, and Base (same address, different networks).";
    }
  }

  if (isFundingQuestion) {
    return "To fund your wallet, first make sure you have one — use /start or /wallet.\n\nThen send crypto to your wallet address on the right chain:\n• BNB → for Four.meme / Flap.sh launches & $B4 token ⭐\n• ETH (Base) → for Bankr launches\n• SOL → for Raydium LaunchLab launches\n• OKB → for XLayer launches\n\nSame wallet address, just pick the right network!";
  }

  if (lower.includes("what is build4") || lower.includes("what's build4") || lower.includes("about build4"))
    return "BUILD4 is decentralized infrastructure for autonomous AI agents on Base, BNB Chain, and XLayer. Agents get their own wallets, trade skills, evolve, fork, and operate fully on-chain. Check build4.io for more!";
  if (lower.includes("chain") || lower.includes("network") || lower.includes("which blockchain"))
    return "BUILD4 runs on Base (primary), BNB Chain, and XLayer. All agent wallets, skill trades, and replication happen on-chain across these networks.";
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
    return "BUILD4 uses decentralized inference through Grok (xAI), Hyperbolic, Akash ML, and Ritual — no centralized AI providers like OpenAI. Fully decentralized compute.";
  if (lower.includes("erc-8004") || lower.includes("erc8004"))
    return "ERC-8004 (Trustless Agents) provides on-chain identity, reputation, and validation registries. BUILD4 is live on BNB Chain with this standard.";
  if (lower.includes("bap-578") || lower.includes("bap578") || lower.includes("nfa"))
    return "BAP-578 is BNB Chain's Non-Fungible Agent standard extending ERC-721. BUILD4's registry is live at 0xd7Deb29ddBB13607375Ce50405A574AC2f7d978d on BNB Chain.";
  if (lower.includes("privacy") || lower.includes("zerc20"))
    return "BUILD4 supports ZERC20 privacy transfers using zero-knowledge proof-of-burn mechanisms for private on-chain transactions.";
  if (lower.includes("contract") || lower.includes("smart contract"))
    return "BUILD4 has 4 core contracts: AgentEconomyHub (wallets), SkillMarketplace (skill trading), AgentReplication (forking + NFTs), and ConstitutionRegistry (immutable agent laws).";
  if (lower.includes("token") && (lower.includes("launch") || lower.includes("create")))
    return "You can launch tokens on Raydium LaunchLab (Solana), Bankr (Base/Solana), Four.meme, Flap.sh (BNB Chain), or XLayer right here in the bot! Use /launch or tap '🚀 Launch Token' from the menu.";
  if (lower.includes("agent") && (lower.includes("create") || lower.includes("make") || lower.includes("new")))
    return "Create an AI agent with /newagent — give it a name, bio, and pick a model (Llama 70B, DeepSeek V3, or Qwen 72B). Your agent gets its own wallet and can trade skills, earn BNB, and evolve autonomously.";
  if (lower.includes("how") && lower.includes("start"))
    return "Getting started is easy:\n1. Create a wallet (tap 🔑 Create New Wallet)\n2. Fund it with some BNB, OKB, or ETH\n3. Create an agent with /newagent\n4. Launch tokens with /launch\n\nThat's it — you're in the autonomous economy!";
  if (lower.includes("price") || (lower.includes("token") && !lower.includes("launch")) || lower.includes("buy"))
    return "$B4 is LIVE on BNB Chain via Four.meme! CA: 0x1d547f9d0890ee5abfb49d7d53ca19df85da4444. Buy directly in this bot with the Buy $B4 button. Agents can also launch their own tokens on Raydium, Bankr, Four.meme, Flap.sh, or XLayer. Use /launch to try it.";
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
    return "Commands:\n🚀 /launch — Launch a token\n🤖 /newagent — Create an AI agent\n📋 /myagents — Your agents\n📝 /task — Assign a task\n👛 /wallet — Wallet info\n🎯 /quests — Earn $B4 quests\n🏆 /rewards — $B4 rewards dashboard\n💰 /fees — Fee tiers & discounts\n💱 /buy — Buy tokens\n📉 /sell — Sell tokens\n🔄 /swap — Swap (multi-chain)\n🌉 /bridge — Cross-chain bridge\n📋 /limit — Limit orders\n👁️ /watchlist — Price watchlist & alerts\n⚙️ /settings — Trading settings\n🔥 /chaos — Chaos plan\n📈 /aster — Aster DEX trading\n❓ /ask — Ask anything\n❌ /cancel — Cancel current action";
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
    inMemoryKeyCache.set(`${chatId}:${lower}`, privateKey);
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
const TRANSACTION_FEE_PERCENT = 1;
const B4_STAKING_CONTRACT = "0x5005dd0F5B3338526dd12f0Abc34C0Cb1Aa362ea";

const FEE_TIERS = [
  { minB4: 1_000_000, feePercent: 0,   label: "Diamond (0%)" },
  { minB4: 500_000,   feePercent: 0.25, label: "Platinum (0.25%)" },
  { minB4: 100_000,   feePercent: 0.5,  label: "Gold (0.5%)" },
  { minB4: 10_000,    feePercent: 0.75, label: "Silver (0.75%)" },
  { minB4: 0,         feePercent: 1.0,  label: "Standard (1%)" },
];

const feeTierCache = new Map<string, { tier: typeof FEE_TIERS[0]; checkedAt: number }>();

async function getUserFeeTier(walletAddress: string): Promise<typeof FEE_TIERS[0]> {
  const cached = feeTierCache.get(walletAddress.toLowerCase());
  if (cached && Date.now() - cached.checkedAt < 5 * 60 * 1000) {
    return cached.tier;
  }

  try {
    const { ethers } = await import("ethers");
    const bscProvider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");

    const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
    const b4Contract = new ethers.Contract(BUILD4_TOKEN_CA, erc20Abi, bscProvider);

    const stakingAbi = ["function getStakeInfo(address) view returns (uint256 amount, uint256 rewardDebt, uint256 pendingReward, uint256 stakeTimestamp)"];
    const stakingContract = new ethers.Contract(B4_STAKING_CONTRACT, stakingAbi, bscProvider);

    let totalB4 = 0n;
    try {
      const walletBalance = await b4Contract.balanceOf(walletAddress);
      totalB4 += walletBalance;
    } catch {}
    try {
      const stakeInfo = await stakingContract.getStakeInfo(walletAddress);
      totalB4 += stakeInfo[0];
    } catch {}

    const totalB4Formatted = Number(ethers.formatEther(totalB4));
    const tier = FEE_TIERS.find(t => totalB4Formatted >= t.minB4) || FEE_TIERS[FEE_TIERS.length - 1];

    feeTierCache.set(walletAddress.toLowerCase(), { tier, checkedAt: Date.now() });
    console.log(`[FeeTier] ${walletAddress.substring(0, 10)}... holds ${Math.floor(totalB4Formatted).toLocaleString()} $B4 → ${tier.label}`);
    return tier;
  } catch (e: any) {
    console.error(`[FeeTier] Lookup failed for ${walletAddress.substring(0, 10)}...:`, e.message);
    return FEE_TIERS[FEE_TIERS.length - 1];
  }
}

async function collectTransactionFee(pk: string, amountWei: bigint, chainRpc: string, chatId: number): Promise<{ txHash: string | null; feePercent: number; tierLabel: string; feeAmount: string }> {
  const defaultResult = { txHash: null, feePercent: 1, tierLabel: "Standard (1%)", feeAmount: "0" };
  try {
    if (amountWei <= 0n) {
      console.log(`[Fee] Skipping: zero amount for chatId=${chatId}`);
      return defaultResult;
    }
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(chainRpc);
    const signer = new ethers.Wallet(pk, provider);
    if (signer.address.toLowerCase() === TREASURY_WALLET.toLowerCase()) return { ...defaultResult, feePercent: 0 };

    const tier = await getUserFeeTier(signer.address);
    if (tier.feePercent === 0) {
      console.log(`[Fee] ${tier.label} tier for chatId=${chatId}, no fee charged`);
      return { txHash: null, feePercent: 0, tierLabel: tier.label, feeAmount: "0" };
    }

    const feeBps = BigInt(Math.floor(tier.feePercent * 100));
    const feeWei = (amountWei * feeBps) / 10000n;
    if (feeWei <= 0n) return { txHash: null, feePercent: tier.feePercent, tierLabel: tier.label, feeAmount: "0" };

    const feeEth = ethers.formatEther(feeWei);
    console.log(`[Fee] Attempting to collect ${feeEth} native (${tier.feePercent}%) from chatId=${chatId} on ${chainRpc}`);

    const balance = await provider.getBalance(signer.address);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || 5000000000n;
    const gasEstimate = 21000n * gasPrice;
    if (balance < feeWei + gasEstimate) {
      console.log(`[Fee] Insufficient balance for fee from chatId=${chatId} (bal: ${ethers.formatEther(balance)}, need: ${ethers.formatEther(feeWei + gasEstimate)}), skipping`);
      return { txHash: null, feePercent: tier.feePercent, tierLabel: tier.label, feeAmount: "0" };
    }
    const tx = await signer.sendTransaction({ to: TREASURY_WALLET, value: feeWei, gasLimit: 21000n, gasPrice });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      console.error(`[Fee] Fee tx reverted for chatId=${chatId} tx=${tx.hash}`);
      return { txHash: null, feePercent: tier.feePercent, tierLabel: tier.label, feeAmount: "0" };
    }
    console.log(`[Fee] ✅ Collected ${feeEth} (${tier.label}) from chatId=${chatId} tx=${receipt.hash}`);
    try {
      await storage.recordPlatformRevenue({ feeType: "transaction_fee", amount: feeEth, txHash: receipt.hash, description: `Fee from chatId=${chatId} (${tier.label})` });
    } catch {}
    return { txHash: receipt.hash, feePercent: tier.feePercent, tierLabel: tier.label, feeAmount: feeEth };
  } catch (e: any) {
    console.error(`[Fee] Fee collection FAILED for chatId=${chatId}:`, e.message);
    return defaultResult;
  }
}

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
  "action:buy": 5,
  "action:sell": 5,
  "action:trade": 5,
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
      `Pay with ETH on Base, USDT, or BNB.\n` +
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

async function getMyAgents(wallet: string, chatId?: number) {
  const cacheKey = chatId ? `${wallet}:${chatId}` : wallet;
  const cached = agentCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AGENT_CACHE_TTL) return cached.agents;
  let agents = await storage.getAgentsByWallet(wallet);
  if (agents.length === 0 && chatId) {
    agents = await storage.getAgentsByTelegramChatId(chatId.toString());
  }
  agentCache.set(cacheKey, { agents, ts: Date.now() });
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

  inMemoryKeyCache.set(`${chatId}:${addr}`, pk);
  await storage.saveTelegramWallet(chatId.toString(), addr, pk);
  await storage.setActiveTelegramWallet(chatId.toString(), addr);
  walletsWithKey.add(`${chatId}:${addr}`);

  const verifyPk = await storage.getTelegramWalletPrivateKey(chatId.toString(), addr);
  if (!verifyPk) {
    console.error(`[Wallet] CRITICAL: Key failed round-trip verify for chatId=${chatId} wallet=${addr.substring(0, 8)}. Re-saving...`);
    await storage.saveTelegramWallet(chatId.toString(), addr, pk);
    const verifyPk2 = await storage.getTelegramWalletPrivateKey(chatId.toString(), addr);
    if (!verifyPk2) {
      console.error(`[Wallet] CRITICAL: Key still fails after re-save for chatId=${chatId}. Using in-memory cache only.`);
    }
  }

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

async function resolvePrivateKey(chatId: number, walletAddr: string): Promise<string | null> {
  const lowerAddr = walletAddr.toLowerCase();
  const cacheKey = `${chatId}:${lowerAddr}`;
  const cached = inMemoryKeyCache.get(cacheKey);
  if (cached) return cached;

  try {
    let pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), lowerAddr);
    if (pk) {
      inMemoryKeyCache.set(cacheKey, pk);
      walletsWithKey.add(cacheKey);
      return pk;
    }
    if (lowerAddr !== walletAddr) {
      pk = await storage.getTelegramWalletPrivateKey(chatId.toString(), walletAddr);
      if (pk) {
        inMemoryKeyCache.set(cacheKey, pk);
        walletsWithKey.add(cacheKey);
        return pk;
      }
    }
    pk = await storage.getPrivateKeyByWalletAddress(lowerAddr);
    if (pk) {
      await storage.saveTelegramWallet(chatId.toString(), lowerAddr, pk);
      inMemoryKeyCache.set(cacheKey, pk);
      walletsWithKey.add(cacheKey);
      console.log(`[Wallet] Recovered key for chatId=${chatId} wallet=${lowerAddr.substring(0, 8)}`);
      return pk;
    }
    try {
      const { db } = await import("./db");
      const { telegramWallets: tw } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const rows = await db.select().from(tw)
        .where(and(eq(tw.chatId, chatId.toString()), eq(tw.walletAddress, lowerAddr)));
      if (rows.length > 0 && rows[0].encryptedPrivateKey) {
        console.error(`[Wallet] DECRYPT_FAIL chatId=${chatId} wallet=${lowerAddr.substring(0, 8)} key_len=${rows[0].encryptedPrivateKey.length}`);
      } else if (rows.length > 0) {
        console.error(`[Wallet] NULL_KEY chatId=${chatId} wallet=${lowerAddr.substring(0, 8)}`);
      } else {
        console.error(`[Wallet] NO_ROW chatId=${chatId} wallet=${lowerAddr.substring(0, 8)}`);
      }
    } catch {}
  } catch (e: any) {
    console.error(`[Wallet] resolvePrivateKey error for chatId=${chatId}:`, e.message);
  }
  return null;
}

async function checkWalletHasKey(chatId: number, wallet: string | undefined): Promise<boolean> {
  if (!wallet) return false;
  if (wallet.startsWith("sol:")) return false;
  const pk = await resolvePrivateKey(chatId, wallet);
  return pk !== null;
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

const balanceCache = new Map<string, { bnb: string; eth: string; usdt: string; b4?: string; ts: number }>();
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

async function fetchWalletBalances(wallets: string[]): Promise<Record<string, { bnb: string; eth: string; usdt: string; b4: string }>> {
  const result: Record<string, { bnb: string; eth: string; usdt: string; b4: string }> = {};
  const now = Date.now();
  const uncached: string[] = [];
  const b4Abi = ["function balanceOf(address) view returns (uint256)"];
  const b4Contract = new ethers.Contract(BUILD4_TOKEN_CA, b4Abi, bnbProviderCached);

  for (const w of wallets) {
    const cached = balanceCache.get(w);
    if (cached && now - cached.ts < BALANCE_CACHE_TTL) {
      result[w] = { bnb: cached.bnb, eth: cached.eth, usdt: cached.usdt, b4: cached.b4 || "0" };
    } else {
      uncached.push(w);
    }
  }

  if (uncached.length === 0) return result;

  await Promise.all(uncached.map(async (w) => {
    try {
      const [bnbBal, ethBal, usdtBal, b4Bal] = await Promise.all([
        bnbProviderCached.getBalance(w).catch(() => BigInt(0)),
        baseProviderCached.getBalance(w).catch(() => BigInt(0)),
        fetchUsdtBalance(w),
        b4Contract.balanceOf(w).catch(() => BigInt(0)),
      ]);
      const bnbStr = parseFloat(ethers.formatEther(bnbBal)).toFixed(4);
      const ethStr = parseFloat(ethers.formatEther(ethBal)).toFixed(4);
      const b4Str = Math.floor(parseFloat(ethers.formatEther(b4Bal))).toLocaleString();
      result[w] = { bnb: bnbStr, eth: ethStr, usdt: usdtBal, b4: b4Str };
      balanceCache.set(w, { bnb: bnbStr, eth: ethStr, usdt: usdtBal, b4: b4Str, ts: now });
    } catch {
      result[w] = { bnb: "0.0000", eth: "0.0000", usdt: "0.00", b4: "0" };
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
      [{ text: "ETH (Base)", callback_data: "transfer_token:eth" }, { text: "USDT", callback_data: "transfer_token:usdt" }],
      [{ text: "BNB", callback_data: "transfer_token:bnb" }],
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
  balText += `• ETH (Base): *${ethBal.toFixed(4)}*\n`;
  balText += `• BNB: *${bnbBal.toFixed(4)}*\n`;
  balText += `• USDT (BSC): *${usdtBal}*\n`;
  if (solWallet) balText += `• SOL: *${solBal.toFixed(4)}*\n`;
  balText += `\nSelect how you'd like to pay:`;

  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  if (ethBal >= 0.005) {
    buttons.push([{ text: `🔵 Pay with ETH on Base (${ethBal.toFixed(4)})`, callback_data: "autopay_native:8453" }]);
  }
  if (parseFloat(usdtBal) >= BOT_PRICE_USD) {
    buttons.push([{ text: `💵 Pay with USDT (${usdtBal})`, callback_data: "action:autopay_usdt" }]);
  }
  if (bnbBal >= 0.03) {
    buttons.push([{ text: `🟡 Pay with BNB (${bnbBal.toFixed(4)})`, callback_data: "autopay_native:56" }]);
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
        try {
          await grantReward(parseInt(referral.referrerChatId), "referral", REWARD_AMOUNTS.REFERRAL, `🔗 Referred a new subscriber`, referral.referredChatId);
          tryCompleteQuest(parseInt(referral.referrerChatId), "refer_friend");
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

    let referralB4Earned = 0;
    try {
      const refRewards = await storage.getUserRewardsByType(chatId.toString(), "referral_signup");
      referralB4Earned = refRewards.reduce((sum: number, r: any) => sum + parseFloat(r.amount || "0"), 0);
    } catch {}

    await bot.sendMessage(chatId,
      `🔗 *BUILD4 Referral Program*\n\n` +
      `Share your link and earn *100 $B4* for every new user who joins!\n\n` +
      `🎁 *Instant Rewards:*\n` +
      `• *100 $B4* per referral signup\n` +
      `• Cap: 10,000 $B4 per user (100 referrals)\n\n` +
      `💰 *Subscription Commissions:*\n` +
      `• 1-10 referrals → *30%* ($${(BOT_PRICE_USD * 0.3).toFixed(2)}/sub)\n` +
      `• 10-50 referrals → *40%* ($${(BOT_PRICE_USD * 0.4).toFixed(2)}/sub)\n` +
      `• 50+ referrals → *50%* ($${(BOT_PRICE_USD * 0.5).toFixed(2)}/sub)\n\n` +
      `📊 *Your Stats:*\n` +
      `• Referrals: ${referralCount}\n` +
      `• $B4 earned: ${referralB4Earned.toLocaleString()}/10,000 $B4\n` +
      `• Paid subscriptions: ${paidCount}\n` +
      `• Commission earned: $${totalEarned.toFixed(2)} USDT\n` +
      `• Current tier: *${currentTier}%*` +
      nextTierText + `\n\n` +
      `🔗 *Your Referral Link:*\n` +
      `\`${refLink}\`\n\n` +
      `Share this link — earn 100 $B4 instantly when someone joins!`,
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

const REWARD_AMOUNTS = {
  AGENT_CREATION: "500",
  REFERRAL: "250",
  TOKEN_LAUNCH: "1000",
  FIRST_AGENT_BONUS: "0",
  FIRST_LAUNCH_BONUS: "0",
};

const QUEST_CONFIG = {
  join: { id: "join", title: "Join BUILD4", reward: 100, emoji: "🎉", description: "Join the BUILD4 bot" },
  create_agent: { id: "create_agent", title: "Create Your First Agent", reward: 500, emoji: "🤖", description: "Create your first AI agent" },
  refer_friend: { id: "refer_friend", title: "Refer a Friend", reward: 250, emoji: "🔗", description: "Refer 1 friend to BUILD4" },
  launch_token: { id: "launch_token", title: "Launch a Token", reward: 1000, emoji: "🚀", description: "Launch your first token" },
} as const;

type QuestId = keyof typeof QUEST_CONFIG;

async function tryCompleteQuest(chatId: number, questId: QuestId): Promise<void> {
  try {
    const quest = QUEST_CONFIG[questId];
    const isNew = await storage.completeQuest(chatId.toString(), questId);
    if (!isNew) return;
    await grantReward(chatId, `quest_${questId}`, quest.reward.toString(), `${quest.emoji} Quest: ${quest.title}`);
    if (bot) {
      const allQuests = await storage.getAllQuests(chatId.toString());
      const completedCount = allQuests.filter(q => q.completed).length;
      const totalQuests = Object.keys(QUEST_CONFIG).length;
      const allDone = completedCount >= totalQuests;
      try {
        await bot.sendMessage(chatId,
          `🎯 *Quest Complete!*\n\n` +
          `${quest.emoji} *${quest.title}*\n` +
          `+${quest.reward.toLocaleString()} $B4\n\n` +
          `Progress: ${completedCount}/${totalQuests} quests${allDone ? "\n\n🏅 *ALL QUESTS COMPLETE!* You've earned the maximum 1,850 $B4!" : ""}\n\n` +
          `View all quests: /quests`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🎯 My Quests", callback_data: "action:quests" }]] } }
        );
      } catch {}
    }
    console.log(`[Quests] ${chatId} completed quest: ${questId} (+${quest.reward} $B4)`);
  } catch (e: any) {
    console.error(`[Quests] Failed to complete quest ${questId} for ${chatId}:`, e.message);
  }
}

async function handleQuestsDashboard(chatId: number): Promise<void> {
  if (!bot) return;
  try {
    const userQuests = await storage.getAllQuests(chatId.toString());
    const completedIds = new Set(userQuests.filter(q => q.completed).map(q => q.questId));
    const totalReward = Object.values(QUEST_CONFIG).reduce((s, q) => s + q.reward, 0);
    const earnedReward = Object.entries(QUEST_CONFIG).reduce((s, [id, q]) => s + (completedIds.has(id) ? q.reward : 0), 0);

    let msg = `🎯 *Agent Quests*\n\n` +
      `Complete quests to earn *$B4 tokens*!\n` +
      `Progress: *${completedIds.size}/${Object.keys(QUEST_CONFIG).length}* — Earned: *${earnedReward.toLocaleString()}/${totalReward.toLocaleString()} $B4*\n\n`;

    for (const [id, quest] of Object.entries(QUEST_CONFIG)) {
      const done = completedIds.has(id);
      msg += done
        ? `✅ ~${quest.emoji} ${quest.title}~ — *+${quest.reward.toLocaleString()} $B4* ✓\n`
        : `⬜ ${quest.emoji} *${quest.title}* — +${quest.reward.toLocaleString()} $B4\n   _${quest.description}_\n`;
    }

    if (completedIds.size >= Object.keys(QUEST_CONFIG).length) {
      msg += `\n🏅 *ALL QUESTS COMPLETE!* Congratulations!`;
    } else {
      msg += `\n_Complete all quests to earn ${totalReward.toLocaleString()} $B4!_`;
    }

    const buttons: any[][] = [];
    if (!completedIds.has("create_agent")) buttons.push([{ text: "🤖 Create Agent", callback_data: "action:newagent" }]);
    if (!completedIds.has("refer_friend")) buttons.push([{ text: "🔗 Refer a Friend", callback_data: "action:referral" }]);
    if (!completedIds.has("launch_token")) buttons.push([{ text: "🚀 Launch Token", callback_data: "action:launchtoken" }]);
    buttons.push([{ text: "🏆 Rewards", callback_data: "action:rewards" }, { text: "📊 Leaderboard", callback_data: "action:leaderboard" }]);
    buttons.push([{ text: "« Menu", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
  } catch (e: any) {
    console.error("[Quests] Dashboard error:", e.message);
    await bot.sendMessage(chatId, `❌ Could not load quests: ${e.message?.substring(0, 100)}`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:quests" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
  }
}

const MAX_REWARDS_PER_USER = 5000;

async function grantReward(chatId: number, rewardType: string, amount: string, description: string, referenceId?: string): Promise<void> {
  try {
    const currentTotal = await storage.getUserRewardTotal(chatId.toString());
    const totalNum = Number(currentTotal) || 0;
    if (totalNum >= MAX_REWARDS_PER_USER) return;
    const remaining = MAX_REWARDS_PER_USER - totalNum;
    const cappedAmount = Math.min(Number(amount), remaining).toString();
    await storage.createReward(chatId.toString(), rewardType, cappedAmount, description, referenceId);
    if (bot) {
      try {
        await bot.sendMessage(chatId,
          `🏆 *$B4 Reward Earned!*\n\n` +
          `+${Number(amount).toLocaleString()} $B4\n` +
          `${description}\n\n` +
          `View all rewards: /rewards`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🏆 My Rewards", callback_data: "action:rewards" }]] } }
        );
      } catch {}
    }
  } catch (e: any) {
    console.error(`[Rewards] Failed to grant reward to ${chatId}:`, e.message);
  }
}

async function handlePortfolio(chatId: number): Promise<void> {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, "📊 Loading your portfolio...");
    const wallet = getLinkedWallet(chatId);
    const [total, agents] = await Promise.all([
      storage.getUserRewardTotal(chatId.toString()),
      storage.getAgentsByTelegramChatId(chatId.toString()),
    ]);

    let balText = "";
    let tokenHoldings = "";
    if (wallet) {
      const evmWallets = [wallet];
      const balances = await fetchWalletBalances(evmWallets);
      const bal = balances[wallet];
      if (bal) {
        const parts: string[] = [];
        if (bal.b4 && bal.b4 !== "0") parts.push(`${bal.b4} $B4`);
        if (parseFloat(bal.bnb) > 0) parts.push(`${bal.bnb} BNB`);
        if (parseFloat(bal.usdt) > 0) parts.push(`${bal.usdt} USDT`);
        if (parseFloat(bal.eth) > 0) parts.push(`${bal.eth} ETH`);
        balText = parts.length > 0 ? parts.join(" · ") : "Empty";
      }

      try {
        const { getWalletTokenBalances } = await import("./okx-onchainos");
        const tokenRes = await getWalletTokenBalances({ address: wallet, chainId: "56" });
        const tokens = tokenRes?.data?.[0]?.tokenAssets || [];
        const significantTokens = tokens.filter((t: any) => {
          const usdVal = parseFloat(t.tokenPrice || "0") * parseFloat(t.holdingAmount || "0");
          return usdVal >= 0.01 && t.symbol !== "BNB";
        }).sort((a: any, b: any) => {
          const aVal = parseFloat(a.tokenPrice || "0") * parseFloat(a.holdingAmount || "0");
          const bVal = parseFloat(b.tokenPrice || "0") * parseFloat(b.holdingAmount || "0");
          return bVal - aVal;
        }).slice(0, 8);

        if (significantTokens.length > 0) {
          tokenHoldings = `\n💰 *Token Holdings*\n`;
          for (const t of significantTokens) {
            const amount = parseFloat(t.holdingAmount || "0");
            const price = parseFloat(t.tokenPrice || "0");
            const value = amount * price;
            const change = parseFloat(t.priceChange24h || "0");
            const changeEmoji = change >= 0 ? "🟢" : "🔴";
            const changeStr = change !== 0 ? ` ${changeEmoji}${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%` : "";
            const amountStr = amount >= 1000 ? Math.floor(amount).toLocaleString() : amount.toFixed(2);
            tokenHoldings += `  ${t.symbol}: ${amountStr} ($${value < 1 ? value.toFixed(4) : value.toFixed(2)})${changeStr}\n`;
          }
        }
      } catch {}
    }

    const questIds = Object.keys(QUEST_CONFIG) as QuestId[];
    let completedQuests = 0;
    for (const qid of questIds) {
      const status = await storage.getQuestStatus(chatId.toString(), qid);
      if (status?.completed) completedQuests++;
    }

    let sub: any = null;
    try { sub = await storage.getBotSubscriptionByChatId(chatId.toString()); } catch {}
    const subStatus = sub ? (sub.status === "trial" ? "Free Trial" : sub.status === "active" ? "Active" : "Expired") : "None";

    const agentList = agents.length > 0
      ? agents.slice(0, 5).map((a: any) => `  • ${a.name || "Unnamed"}`).join("\n")
      : "  None yet";

    const msg =
      `📊 *Your BUILD4 Portfolio*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👛 *Wallet*\n` +
      `${wallet ? `\`${shortWallet(wallet)}\`` : "Not set up"}\n` +
      `${balText ? `💎 ${balText}` : ""}\n` +
      `${tokenHoldings}\n` +
      `🤖 *Agents* (${agents.length})\n${agentList}\n\n` +
      `🏆 *$B4 Earned:* ${(Number(total) || 0).toLocaleString()} / 5,000\n` +
      `🎯 *Quests:* ${completedQuests}/${questIds.length} complete\n` +
      `⭐ *Plan:* ${subStatus}\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: "🟢 Buy", callback_data: "action:buy" }, { text: "📉 Sell", callback_data: "action:sell" }, { text: "💱 Swap", callback_data: "action:okxswap" }],
        [{ text: "👛 Wallet Details", callback_data: "action:wallet" }, { text: "🎯 Quests", callback_data: "action:quests" }],
        [{ text: "🤖 My Agents", callback_data: "action:myagents" }, { text: "🏆 Rewards", callback_data: "action:rewards" }],
        [{ text: "« Menu", callback_data: "action:menu" }],
      ]}
    });
  } catch (e: any) {
    console.error("[Portfolio] Error:", e.message);
    await bot.sendMessage(chatId, `❌ Could not load portfolio: ${e.message?.substring(0, 100)}`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:portfolio" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
  }
}

async function handleRewardsDashboard(chatId: number): Promise<void> {
  if (!bot) return;
  try {
    const [total, rewards, agentRewards, referralRewards, launchRewards] = await Promise.all([
      storage.getUserRewardTotal(chatId.toString()),
      storage.getUserRewards(chatId.toString()),
      storage.getUserRewardsByType(chatId.toString(), "agent_creation"),
      storage.getUserRewardsByType(chatId.toString(), "referral"),
      storage.getUserRewardsByType(chatId.toString(), "token_launch"),
    ]);

    const totalNum = Number(total).toLocaleString();
    const agentCount = agentRewards.length;
    const referralCount = referralRewards.length;
    const launchCount = launchRewards.length;

    let msg =
      `🏆 *$B4 Rewards Dashboard*\n\n` +
      `💰 Total Earned: *${totalNum} $B4*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 Agent Hiring: *${agentCount}* agents → *${Number(agentRewards.reduce((s: number, r: any) => s + Number(r.amount || 0), 0)).toLocaleString()} $B4*\n` +
      `🔗 Referrals: *${referralCount}* users → *${Number(referralRewards.reduce((s: number, r: any) => s + Number(r.amount || 0), 0)).toLocaleString()} $B4*\n` +
      `🚀 Token Launches: *${launchCount}* tokens → *${Number(launchRewards.reduce((s: number, r: any) => s + Number(r.amount || 0), 0)).toLocaleString()} $B4*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `*How to earn more:*\n` +
      `🎉 Join the bot → +100 $B4\n` +
      `🤖 Create your first agent → +500 $B4\n` +
      `🔗 Refer a friend → +250 $B4\n` +
      `🚀 Launch a token → +1,000 $B4\n\n` +
      `📊 250M $B4 reserved for agent economy rewards\n` +
      `_Rewards vest over 24 months from the ecosystem pool_`;

    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎯 Quests", callback_data: "action:quests" }, { text: "📊 Leaderboard", callback_data: "action:leaderboard" }],
          [{ text: "🤖 Create Agent", callback_data: "action:newagent" }, { text: "🔗 Refer Friends", callback_data: "action:referral" }],
          [{ text: "🚀 Launch Token", callback_data: "action:launchtoken" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ]
      }
    });
  } catch (e: any) {
    console.error("[Rewards] Dashboard error:", e.message);
    await bot.sendMessage(chatId, `❌ Could not load rewards: ${e.message?.substring(0, 100)}`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:rewards" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
  }
}

async function handleRewardsLeaderboard(chatId: number): Promise<void> {
  if (!bot) return;
  try {
    const leaderboard = await storage.getRewardsLeaderboard(10);

    if (leaderboard.length === 0) {
      await bot.sendMessage(chatId,
        `📊 *$B4 Rewards Leaderboard*\n\nNo rewards earned yet. Be the first!\n\n🤖 Create an agent to start earning.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🤖 Create Agent", callback_data: "action:newagent" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    let msg = `📊 *$B4 Rewards Leaderboard*\n\n`;

    let userRank = -1;
    for (let i = 0; i < leaderboard.length; i++) {
      const entry = leaderboard[i];
      const medal = i < 3 ? medals[i] : `${i + 1}.`;
      const shortId = `${entry.chatId.substring(0, 4)}...${entry.chatId.substring(entry.chatId.length - 3)}`;
      const isYou = entry.chatId === chatId.toString();
      if (isYou) userRank = i + 1;
      const rewardNum = Number(entry.totalRewards) || 0;
      msg += `${medal} ${isYou ? "*YOU* " : ""}${shortId} — *${rewardNum.toLocaleString()} $B4* (${entry.rewardCount || 0} actions)\n`;
    }

    if (userRank === -1) {
      const userTotal = await storage.getUserRewardTotal(chatId.toString());
      msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `Your total: *${(Number(userTotal) || 0).toLocaleString()} $B4*\n`;
      msg += `_Keep earning to make the top 10!_`;
    }

    msg += `\n\n💡 _Top deployers earn bonus rewards!_`;

    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏆 My Rewards", callback_data: "action:rewards" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ]
      }
    });
  } catch (e: any) {
    console.error("[Rewards] Leaderboard error:", e.message);
    await bot.sendMessage(chatId, `❌ Could not load leaderboard: ${e.message?.substring(0, 100)}`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "action:leaderboard" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
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
      [{ text: tr("menu.buyBuild4", c), callback_data: "action:buybuild4" }, { text: tr("menu.launch", c), callback_data: "action:launchtoken" }],
      [{ text: tr("menu.trading", c), callback_data: "action:submenu_trading" }, { text: "📈 Futures (Aster)", callback_data: "action:aster" }],
      [{ text: "🤖 Agents", callback_data: "action:submenu_agents" }, { text: tr("menu.market", c), callback_data: "action:submenu_market" }],
      [{ text: tr("menu.earn", c), callback_data: "action:submenu_earn" }],
      [{ text: tr("menu.portfolio", c), callback_data: "action:portfolio" }, { text: tr("menu.wallet", c), callback_data: "action:wallet" }],
      [{ text: tr("menu.help", c), callback_data: "action:help" }, { text: "🌐 Lang", callback_data: "action:lang" }],
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
    initOwnerAsterClient().catch(e => console.error("[Aster] Owner client init error:", e.message));

    const me = await bot.getMe();
    botUsername = me.username || null;
    console.log(`[TelegramBot] Started ${webhookMode ? "with webhook" : "with polling"} as @${botUsername}`);

    bot.setMyCommands([
      { command: "start", description: "Start BUILD4 and create a wallet" },
      { command: "launch", description: "Launch a token on Bankr (Base), Four.meme, or Flap.sh" },
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
      { command: "rewards", description: "$B4 rewards dashboard" },
      { command: "challenge", description: "Trading Agent Challenges" },
      { command: "copytrade", description: "Copy top agent trades" },
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

    loadAllPersisted().then(() => console.log("[TradingData] Persisted data loaded on startup")).catch(e => console.error("[TradingData] Startup load error:", e.message));

    setInterval(() => { sendTrialReminders().catch(e => console.error("[TrialReminder] Error:", e.message)); }, 6 * 60 * 60 * 1000);
    setTimeout(() => { sendTrialReminders().catch(e => console.error("[TrialReminder] Error:", e.message)); }, 60_000);

    setInterval(() => { checkLimitOrdersAndAlerts(bot).catch(e => console.error("[LimitChecker] Error:", e.message)); }, 60_000);
    setTimeout(() => { console.log("[LimitChecker] Background price checker started"); }, 5_000);

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

      if (subCheck.status === "trial" && subCheck.daysLeft !== undefined) {
        if (subCheck.daysLeft <= 1) {
          await bot.sendMessage(chatId,
            tr("trial.ending", chatId),
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
              [{ text: `${tr("btn.subscribe", chatId)} — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
            ]}}
          );
        } else if (subCheck.daysLeft === TRIAL_DAYS) {
          await bot.sendMessage(chatId,
            tr("trial.started", chatId, { days: TRIAL_DAYS, daysLeft: subCheck.daysLeft }),
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
              [{ text: tr("btn.subStatus", chatId), callback_data: "action:substatus" }],
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
      const pk = await resolvePrivateKey(chatId, wallet);
      if (!pk) throw new Error("Private key not found. Generate a new wallet or re-import your key via /wallet.");

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
      const pk = await resolvePrivateKey(chatId, wallet);
      if (!pk) throw new Error("Private key not found. Generate a new wallet or re-import your key via /wallet.");

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
      const pk = await resolvePrivateKey(chatId, wallet);
      if (!pk) throw new Error("Private key not found. Generate a new wallet or re-import your key via /wallet.");

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
  if (data === "action:rewards") {
    return handleRewardsDashboard(chatId);
  }
  if (data === "action:quests") {
    return handleQuestsDashboard(chatId);
  }
  if (data === "action:leaderboard") {
    return handleRewardsLeaderboard(chatId);
  }

  if (data?.startsWith("action:check7702_")) {
    const addr = data.replace("action:check7702_", "");
    const fakeMsg = { ...query.message, text: `/check7702 ${addr}`, chat: { id: chatId, type: "private" as const } };
    bot.emit("message", fakeMsg);
    return;
  }
  if (data === "action:erc7702_tips") {
    await bot.sendMessage(chatId,
      `🔒 *ERC-7702 Security Tips*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `*What is ERC-7702?*\n` +
      `EIP-7702 (Pectra upgrade) lets EOAs temporarily delegate to smart contracts. While useful for account abstraction, it can be exploited.\n\n` +
      `*How wallets get compromised:*\n` +
      `• Signing malicious authorization tuples\n` +
      `• Phishing sites requesting EIP-7702 signatures\n` +
      `• Malicious dApps inserting delegation payloads\n\n` +
      `*How to stay safe:*\n` +
      `1. Never sign transactions you don't understand\n` +
      `2. Use a hardware wallet for high-value accounts\n` +
      `3. Check your wallet regularly with /check7702\n` +
      `4. Revoke unknown delegations immediately\n` +
      `5. Keep assets in fresh wallets if compromised\n\n` +
      `*Signs of compromise:*\n` +
      `• Unexpected token approvals\n` +
      `• Funds moving without your action\n` +
      `• Your EOA showing contract code on explorers\n\n` +
      `_Stay vigilant — check your wallets often!_ 🛡️`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🔍 Check a Wallet", callback_data: "action:check7702_prompt" }], [{ text: "« Main Menu", callback_data: "action:main" }]] },
      }
    );
    return;
  }
  if (data === "action:check7702_prompt") {
    await bot.sendMessage(chatId,
      `🔒 *ERC-7702 Wallet Check*\n\nSend the command with a wallet address:\n\n\`/check7702 0xYourWalletAddress\`\n\n_Paste any EVM wallet address to scan._`,
      { parse_mode: "Markdown" }
    );
    return;
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

    const pk = await resolvePrivateKey(chatId, walletAddr);
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
      "BUILD4 is decentralized infrastructure for autonomous AI agents on Base, BNB Chain, and XLayer.\n\n" +
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
        "📊 /portfolio — 投资组合概览\n" +
        "🎯 /quests — 赚取 $B4 任务\n" +
        "🏆 /rewards — $B4 奖励面板\n" +
        "🏅 /challenge — 交易挑战赛\n" +
        "📋 /copytrade — 跟单交易\n" +
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
        "📋 /limit — Limit orders\n" +
        "👁️ /watchlist — Price watchlist & alerts\n" +
        "⚙️ /settings — Trading settings\n" +
        "🤖 /newagent — Create an AI agent\n" +
        "📋 /myagents — Your agents\n" +
        "📝 /task — Assign a task\n" +
        "👛 /wallet — Wallet info\n" +
        "📊 /portfolio — Your portfolio overview\n" +
        "🎯 /quests — Earn $B4 quests\n" +
        "🏆 /rewards — $B4 rewards dashboard\n" +
        "🏅 /challenge — Trading challenges\n" +
        "📋 /copytrade — Copy trading\n" +
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
        if (bal.b4 && bal.b4 !== "0") parts.push(`${bal.b4} $B4`);
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

    walletButtons.push([{ text: "🟢 Buy", callback_data: "action:buy" }, { text: "📉 Sell", callback_data: "action:sell" }, { text: "💱 Swap", callback_data: "action:okxswap" }]);
    walletButtons.push([{ text: "💸 Transfer", callback_data: "action:transfer" }, { text: "🚀 Launch Token", callback_data: "action:launchtoken" }]);
    walletButtons.push([{ text: tr("wallet.genNew", chatId), callback_data: "action:genwallet" }, { text: tr("wallet.import", chatId), callback_data: "action:importwallet" }]);
    if (!solWallet) {
      walletButtons.push([{ text: tr("wallet.genSol", chatId), callback_data: "action:gensolwallet" }]);
    }
    walletButtons.push([{ text: tr("wallet.exportKey", chatId), callback_data: "action:exportkey" }, ...(solWallet ? [{ text: tr("wallet.exportSol", chatId), callback_data: "action:exportsolkey" }] : [])]);
    walletButtons.push([{ text: tr("menu.back", chatId), callback_data: "action:menu" }]);

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
    const pk = await resolvePrivateKey(chatId, wallet);
    if (!pk) {
      await bot.sendMessage(chatId, "❌ You need a wallet with a private key to create an agent. Import or generate a wallet first.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    const AGENT_CREATION_FEE = "0.01";
    try {
      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org");
      const signer = new ethers.Wallet(pk, provider);
      const balance = await provider.getBalance(signer.address);
      const feeWei = ethers.parseEther(AGENT_CREATION_FEE);
      if (balance < feeWei + ethers.parseEther("0.0005")) {
        const bal = parseFloat(ethers.formatEther(balance)).toFixed(4);
        await bot.sendMessage(chatId,
          `❌ *Insufficient BNB*\n\n` +
          `Agent creation costs *${AGENT_CREATION_FEE} BNB*\n` +
          `Your balance: ${bal} BNB\n\n` +
          `Deposit BNB to your wallet:\n\`${signer.address}\``,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "💰 My Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
        );
        return;
      }
    } catch (e: any) {
      console.error("[Agent] Balance check failed:", e.message);
    }
    await bot.sendMessage(chatId,
      `🤖 *Create AI Agent*\n\n` +
      `Agent creation fee: *${AGENT_CREATION_FEE} BNB* (~$6)\n` +
      `This fee is charged from your wallet on BNB Chain.\n\n` +
      `Your agent will be able to trade, analyze, and execute tasks autonomously.\n\n` +
      `Continue?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: `✅ Pay ${AGENT_CREATION_FEE} BNB & Create`, callback_data: "action:newagent_confirm" }],
        [{ text: "❌ Cancel", callback_data: "action:menu" }],
      ]}}
    );
    return;
  }

  if (data === "action:newagent_confirm") {
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

  if (data === "action:buybuild4") {
    if (!BUILD4_TOKEN_CA) {
      await bot.sendMessage(chatId,
        `🟢 *Buy $B4*\n\n` +
        `The $B4 token contract address has not been set yet.\n\n` +
        `The token is launching soon on BNB Chain — stay tuned! 🚀`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] },
        }
      );
      return;
    }
    pendingBuild4Buy.set(chatId, {});
    const amounts = [
      { label: "0.05 BNB", val: "0.05" },
      { label: "0.1 BNB", val: "0.1" },
      { label: "0.25 BNB", val: "0.25" },
      { label: "0.5 BNB", val: "0.5" },
      { label: "1 BNB", val: "1" },
    ];
    await bot.sendMessage(chatId,
      `🟢 *Buy $B4*\n\n` +
      `⛓ Chain: BNB Chain\n` +
      `📋 Token: \`${BUILD4_TOKEN_CA}\`\n\n` +
      `Select amount of BNB to spend:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            ...amounts.map(a => [{ text: a.label, callback_data: `b4buy_amt:${a.val}` }]),
            [{ text: "❌ Cancel", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("b4buy_amt:")) {
    if (!pendingBuild4Buy.has(chatId) || !BUILD4_TOKEN_CA) {
      await bot.sendMessage(chatId, "Session expired. Please start again.", { reply_markup: { inline_keyboard: [[{ text: "🟢 Buy $B4", callback_data: "action:buybuild4" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    const amount = data.replace("b4buy_amt:", "");
    const validAmounts = ["0.05", "0.1", "0.25", "0.5", "1"];
    if (!validAmounts.includes(amount)) {
      await bot.sendMessage(chatId, "Invalid amount. Please select from the options.", { reply_markup: { inline_keyboard: [[{ text: "🟢 Buy $B4", callback_data: "action:buybuild4" }]] } });
      return;
    }
    pendingBuild4Buy.set(chatId, { amount });
    await bot.sendMessage(chatId,
      `🟢 *Confirm Buy $B4*\n\n` +
      `🪙 Token: *$B4*\n` +
      `⛓ Chain: BNB Chain\n` +
      `💰 Spend: *${amount} BNB*\n` +
      `📋 Address: \`${BUILD4_TOKEN_CA}\`\n\n` +
      `Proceed with this swap?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Buy", callback_data: "b4buy_confirm" }],
            [{ text: "💰 Change Amount", callback_data: "action:buybuild4" }],
            [{ text: "❌ Cancel", callback_data: "action:menu" }],
          ],
        },
      }
    );
    return;
  }

  if (data === "b4buy_confirm") {
    const state = pendingBuild4Buy.get(chatId);
    if (!state || !state.amount || !BUILD4_TOKEN_CA) {
      pendingBuild4Buy.delete(chatId);
      await bot.sendMessage(chatId, "Buy session expired. Please try again.", { reply_markup: { inline_keyboard: [[{ text: "🟢 Buy $B4", callback_data: "action:buybuild4" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }

    const walletAddr = getLinkedWallet(chatId);
    if (!walletAddr || !await checkWalletHasKey(chatId, walletAddr)) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to buy. Use /wallet to set one up.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      pendingBuild4Buy.delete(chatId);
      return;
    }

    await bot.sendMessage(chatId, `⏳ Executing buy: ${state.amount} BNB → $B4 on BNB Chain...`);
    sendTyping(chatId);

    try {
      const { ethers } = await import("ethers");
      const rawAmount = ethers.parseUnits(state.amount, 18).toString();

      const { getSwapData } = await import("./okx-onchainos");
      const swapTx = await getSwapData({
        chainId: "56",
        fromTokenAddress: OKX_NATIVE_TOKEN,
        toTokenAddress: BUILD4_TOKEN_CA,
        amount: rawAmount,
        slippage: "1",
        userWalletAddress: walletAddr,
      });

      const txData = swapTx?.data?.[0]?.tx;
      if (!txData) throw new Error("No swap route found. The token may have low liquidity or is not yet tradable.");

      const pk = await resolvePrivateKey(chatId, walletAddr);
      if (!pk) throw new Error("Private key not found. Generate a new wallet or re-import your key via /wallet.");

      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const wallet = new ethers.Wallet(pk, provider);

      const tx = await wallet.sendTransaction({
        to: txData.to,
        data: txData.data,
        value: txData.value ? BigInt(txData.value) : 0n,
        gasLimit: txData.gasLimit ? BigInt(txData.gasLimit) : undefined,
      });

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");

      const amountWei = ethers.parseEther(state.amount);
      const feeResult = await collectTransactionFee(pk, amountWei, "https://bsc-dataseed1.binance.org", chatId);

      pendingBuild4Buy.delete(chatId);
      await bot.sendMessage(chatId,
        `✅ *$B4 Purchased!*\n\n` +
        `⚡ ${state.amount} BNB → $B4\n` +
        `⛓ BNB Chain\n` +
        `💡 Fee: ${feeResult.feePercent}% (${feeResult.tierLabel})\n\n` +
        `[View Transaction](https://bscscan.com/tx/${receipt.hash})`,
        {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🟢 Buy More $B4", callback_data: "action:buybuild4" }],
              [{ text: "👛 Wallet", callback_data: "action:wallet" }, { text: "« Menu", callback_data: "action:menu" }],
            ],
          },
        }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `❌ Buy failed: ${e.message?.substring(0, 150)}\n\nCheck your BNB balance and try again.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Retry", callback_data: "b4buy_confirm" }],
              [{ text: "🟢 Buy $B4", callback_data: "action:buybuild4" }, { text: "« Menu", callback_data: "action:menu" }],
            ],
          },
        }
      );
    }
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
      [{ text: "Base", callback_data: "sell_chain:8453" }, { text: "BNB Chain", callback_data: "sell_chain:56" }],
      [{ text: "Ethereum", callback_data: "sell_chain:1" }, { text: "Solana", callback_data: "sell_chain:501" }],
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
      const tradeEntries = userTradeEntries.get(chatId) || [];
      let text = `💸 *Your ${chainObj.name} Tokens*\n\n`;
      const tokenButtons: TelegramBot.InlineKeyboardButton[][] = [];
      cached.forEach((t, i) => {
        let pnlStr = "";
        const entry = tradeEntries.find(e => e.tokenAddress.toLowerCase() === t.address.toLowerCase() && e.chainId === chainId);
        if (entry && t.usdValue !== "?" && parseFloat(t.balance) > 0) {
          const currentVal = parseFloat(t.usdValue);
          const entryVal = entry.entryPrice * parseFloat(t.balance);
          if (entryVal > 0) {
            const pnlPct = ((currentVal - entryVal) / entryVal) * 100;
            pnlStr = ` ${pnlPct >= 0 ? "🟢" : "🔴"}${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`;
          }
        }
        text += `${i + 1}. *${t.symbol}* — ${parseFloat(t.balance).toFixed(4)} ($${t.usdValue})${pnlStr}\n`;
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

    let pnlLine = "";
    const entries = userTradeEntries.get(chatId) || [];
    const entry = entries.find(e => e.tokenAddress.toLowerCase() === tok.address.toLowerCase() && e.chainId === chainId);
    let currentPrice: number | undefined;
    try {
      const priceResult = await getTokenPrice(tok.address, chainId);
      if (priceResult.success && priceResult.data?.price) currentPrice = parseFloat(priceResult.data.price);
    } catch {}

    if (entry && currentPrice) {
      const pnlPct = ((currentPrice - entry.entryPrice) / entry.entryPrice) * 100;
      const pnlIcon = pnlPct >= 0 ? "🟢" : "🔴";
      pnlLine = `\n${pnlIcon} *PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%*\n` +
        `Entry: $${entry.entryPrice < 0.01 ? entry.entryPrice.toExponential(3) : entry.entryPrice.toFixed(6)}\n` +
        `Current: $${currentPrice < 0.01 ? currentPrice.toExponential(3) : currentPrice.toFixed(6)}\n`;
    } else if (currentPrice) {
      pnlLine = `\nPrice: $${currentPrice < 0.01 ? currentPrice.toExponential(3) : currentPrice.toFixed(6)}\n`;
    }

    const usdVal = tok.usdValue !== "?" ? ` ($${tok.usdValue})` : "";
    const pctButtons = [
      [{ text: "25%", callback_data: "sell_pct:25" }, { text: "50%", callback_data: "sell_pct:50" }],
      [{ text: "75%", callback_data: "sell_pct:75" }, { text: "100%", callback_data: "sell_pct:100" }],
      [{ text: "📋 Limit Sell", callback_data: "limit:new:sell" }],
      [{ text: "« Back", callback_data: `sell_chain:${chainId}` }, { text: "❌ Cancel", callback_data: "action:menu" }],
    ];
    await bot.sendMessage(chatId,
      `💸 *Sell ${tok.symbol}*\n\n` +
      `Balance: *${parseFloat(tok.balance).toFixed(6)} ${tok.symbol}*${usdVal}\n` +
      `Chain: ${chainObj.name}` +
      `${pnlLine}\n` +
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

      const pk = await resolvePrivateKey(chatId, walletAddr);
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

      const balanceBefore = await provider.getBalance(walletAddr);

      if (approveTx && approveTx.to) {
        try {
          const tokenContract = new ethers.Contract(state.tokenAddress, [
            "function allowance(address,address) view returns (uint256)",
            "function approve(address,uint256) returns (bool)"
          ], signer);
          const currentAllowance = await tokenContract.allowance(walletAddr, approveTx.to);
          if (currentAllowance > 0n && currentAllowance < BigInt(rawAmount)) {
            const resetTx = await tokenContract.approve(approveTx.to, 0n);
            await resetTx.wait();
          }
        } catch {}
        const aTx = await signer.sendTransaction({
          to: approveTx.to,
          data: approveTx.data,
          value: approveTx.value ? BigInt(approveTx.value) : 0n,
          gasLimit: approveTx.gasLimit ? BigInt(approveTx.gasLimit) : 100000n,
        });
        await aTx.wait();
      }

      const sellSlippage = state.tokenAddress.toLowerCase() === BUILD4_TOKEN_CA.toLowerCase() ? "15" : "5";
      const swapResult = await getSwapData({
        chainId: state.chainId,
        fromTokenAddress: state.tokenAddress,
        toTokenAddress: OKX_NATIVE_TOKEN,
        amount: rawAmount,
        slippage: sellSlippage,
        userWalletAddress: walletAddr,
      });

      const swapTx = swapResult?.data?.[0]?.tx;
      if (!swapTx) throw new Error("No swap route found. Token may have low liquidity.");

      let gasLimit = swapTx.gasLimit ? BigInt(swapTx.gasLimit) : undefined;
      try {
        const estimated = await provider.estimateGas({
          to: swapTx.to,
          data: swapTx.data,
          value: swapTx.value ? BigInt(swapTx.value) : 0n,
          from: walletAddr,
        });
        gasLimit = estimated * 150n / 100n;
      } catch (estErr: any) {
        console.warn(`[Sell] Gas estimate failed, using fallback: ${estErr.message?.substring(0, 100)}`);
        gasLimit = 500000n;
      }

      const tx = await signer.sendTransaction({
        to: swapTx.to,
        data: swapTx.data,
        value: swapTx.value ? BigInt(swapTx.value) : 0n,
        gasLimit,
      });

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");

      const balanceAfter = await provider.getBalance(walletAddr);
      const nativeReceived = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
      let sellFeeResult = { txHash: null as string | null, feePercent: 1, tierLabel: "Standard (1%)" };
      if (nativeReceived > 0n) {
        sellFeeResult = await collectTransactionFee(pk, nativeReceived, rpcUrl, chatId);
      }

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
        `⛓ ${state.chainName}\n` +
        `💡 Fee: ${sellFeeResult.feePercent}% (${sellFeeResult.tierLabel})\n\n` +
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
        await bot.sendMessage(chatId, `🔄 *Swap Quote on ${sChain.name}*\n\n💰 ${sAmount} ${sFromToken.symbol} → ${receiveAmt} ${sToToken.symbol}\n⛓ Chain: ${sChain.name}\n\nConfirm this swap?`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Swap", callback_data: "okxswap_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } });
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
    const solKeyMsg = await bot.sendMessage(chatId,
      `🔑 *Solana Wallet Created!*\n\n` +
      `Address:\n\`${solWallet.address}\`\n\n` +
      `Private Key:\n\`${solWallet.privateKey}\`\n\n` +
      `⚠️ *SAVE YOUR PRIVATE KEY* — this message will be auto-deleted in 30 seconds.\n\n` +
      `Confirm this cross-chain swap?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Cross-Chain Swap", callback_data: "okxbridge_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } }
    );
    scheduleSecureDelete(chatId, solKeyMsg.message_id, 30000);
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
      const pk = await resolvePrivateKey(chatId, walletAddr);
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

      const swapAmountWei = txData.value ? BigInt(txData.value) : 0n;
      let swapFeeResult = { txHash: null as string | null, feePercent: 1, tierLabel: "Standard (1%)" };
      if (swapAmountWei > 0n) {
        swapFeeResult = await collectTransactionFee(pk, swapAmountWei, rpcUrl, chatId);
      }

      const chain = OKX_CHAINS.find(c => c.id === state.chainId);
      const explorerUrls: Record<string, string> = { "56": "https://bscscan.com/tx/", "1": "https://etherscan.io/tx/", "8453": "https://basescan.org/tx/", "42161": "https://arbiscan.io/tx/", "137": "https://polygonscan.com/tx/", "10": "https://optimistic.etherscan.io/tx/", "43114": "https://snowtrace.io/tx/", "196": "https://www.okx.com/explorer/xlayer/tx/" };
      const explorer = explorerUrls[state.chainId!] || "https://bscscan.com/tx/";
      await bot.sendMessage(chatId,
        `✅ *Swap Executed!*\n\n${state.fromSymbol} → ${state.toSymbol} on ${chain?.name || state.chainName}\n` +
        `💡 Fee: ${swapFeeResult.feePercent}% (${swapFeeResult.tierLabel})\n\n` +
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
      const pk = await resolvePrivateKey(chatId, walletAddr);
      if (!pk) throw new Error("Private key not found. Generate a new wallet or re-import your key via /wallet.");
      const CHAIN_RPCS: Record<string, string> = { "56": "https://bsc-dataseed1.binance.org", "1": "https://eth.llamarpc.com", "8453": "https://mainnet.base.org", "42161": "https://arb1.arbitrum.io/rpc", "137": "https://polygon-rpc.com", "10": "https://mainnet.optimism.io", "43114": "https://api.avax.network/ext/bc/C/rpc", "196": "https://rpc.xlayer.tech", "250": "https://rpc.ftm.tools", "5000": "https://rpc.mantle.xyz" };
      const rpcUrl = CHAIN_RPCS[state.fromChainId!] || "https://bsc-dataseed1.binance.org";
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(pk, provider);

      let txData: any;
      if (isLifi) {
        const toAddr = state.toChainId === "501" && state.receiveAddress ? `&toAddress=${state.receiveAddress}` : "";
        const normFromToken = state.fromToken === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ? "0x0000000000000000000000000000000000000000" : state.fromToken;
        const normToToken = state.toChainId === "501" ? state.toToken : (state.toToken === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ? "0x0000000000000000000000000000000000000000" : state.toToken);
        const toChainParam = state.toChainId === "501" ? "SOL" : state.toChainId;
        const lifiResp = await fetch(`https://li.quest/v1/quote?fromChain=${state.fromChainId}&toChain=${toChainParam}&fromToken=${normFromToken}&toToken=${normToToken}&fromAmount=${state.amount}&fromAddress=${walletAddr}${toAddr}`, { headers: { "Accept": "application/json" } });
        const lifiData = await lifiResp.json();
        txData = lifiData?.transactionRequest;
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

      const bridgeAmountWei = txData.value ? BigInt(txData.value) : 0n;
      let bridgeFeeResult = { txHash: null as string | null, feePercent: 1, tierLabel: "Standard (1%)" };
      if (bridgeAmountWei > 0n) {
        bridgeFeeResult = await collectTransactionFee(pk, bridgeAmountWei, rpcUrl, chatId);
      }

      const explorerUrls: Record<string, string> = { "56": "https://bscscan.com/tx/", "1": "https://etherscan.io/tx/", "8453": "https://basescan.org/tx/", "42161": "https://arbiscan.io/tx/", "137": "https://polygonscan.com/tx/", "10": "https://optimistic.etherscan.io/tx/", "43114": "https://snowtrace.io/tx/", "196": "https://www.okx.com/explorer/xlayer/tx/" };
      const explorer = explorerUrls[state.fromChainId!] || "https://bscscan.com/tx/";
      await bot.sendMessage(chatId,
        `✅ *Cross-Chain Swap Executed!*\n\n${state.fromSymbol} (${state.fromChainName}) → ${state.toSymbol} (${state.toChainName})\nVia: ${bridgeProvider}\n` +
        `💡 Fee: ${bridgeFeeResult.feePercent}% (${bridgeFeeResult.tierLabel})\n\n` +
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

  if (data.startsWith("nlswap:")) {
    const parts = data.replace("nlswap:", "").split(":");
    const [nlAmount, nlFrom, nlTo, nlChainId] = parts;
    const nlChain = OKX_CHAINS.find(c => c.id === nlChainId);
    if (!nlChain) return;
    const nlFromChainId = Object.entries(OKX_POPULAR_TOKENS).find(([cid, toks]) => {
      const ch = OKX_CHAINS.find(c => c.id === cid);
      return ch?.symbol === nlFrom.toUpperCase() || toks.some(t => t.symbol === nlFrom.toUpperCase() && t.address === OKX_NATIVE_TOKEN);
    })?.[0];
    if (nlFromChainId && nlFromChainId !== nlChainId) {
      const srcChain = OKX_CHAINS.find(c => c.id === nlFromChainId);
      const dstChain = nlChain;
      const srcTokens = getOKXTokensForChain(nlFromChainId);
      const dstTokens = getOKXTokensForChain(nlChainId);
      const srcToken = srcTokens.find(t => t.symbol === nlFrom.toUpperCase());
      const dstToken = dstTokens.find(t => t.symbol === nlTo.toUpperCase());
      if (srcToken && dstToken && srcChain) {
        sendTyping(chatId);
        try {
          const { getCrossChainQuote } = await import("./okx-onchainos");
          const rawAmt = parseHumanAmount(nlAmount, srcToken.decimals);
          const quote = await getCrossChainQuote({
            fromChainId: nlFromChainId, toChainId: nlChainId,
            fromTokenAddress: srcToken.address, toTokenAddress: dstToken.address,
            amount: rawAmt, slippage: "1",
          });
          const routerList = quote?.data?.routerList || quote?.data;
          const bestRoute = Array.isArray(routerList) ? routerList[0] : null;
          const receiveAmt = bestRoute?.toTokenAmount ? formatTokenAmount(bestRoute.toTokenAmount, dstToken.decimals) : null;
          if (receiveAmt) {
            const bridgeProvider = bestRoute?._provider === "lifi" ? (bestRoute?.bridgeProvider || "Li.Fi") : "OKX";
            pendingOKXBridge.set(chatId, {
              step: "confirm", fromChainId: nlFromChainId, fromChainName: srcChain.name,
              toChainId: nlChainId, toChainName: dstChain.name,
              fromToken: srcToken.address, fromSymbol: srcToken.symbol,
              toToken: dstToken.address, toSymbol: dstToken.symbol,
              amount: rawAmt, receiveAddress: "", quoteData: bestRoute,
            });
            await bot.sendMessage(chatId,
              `🌉 *Cross-Chain Swap Quote* (via ${bridgeProvider})\n\n` +
              `💰 ${nlAmount} ${srcToken.symbol} (${srcChain.name}) → ${receiveAmt} ${dstToken.symbol} (${dstChain.name})\n\n` +
              `Confirm this cross-chain swap?`,
              { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Cross-Chain Swap", callback_data: "okxbridge_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } }
            );
            return;
          }
        } catch (e: any) {}
        await bot.sendMessage(chatId, `Cross-chain quote unavailable. Try /swap to pick tokens manually.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        return;
      }
    }
    const nlTokens = getOKXTokensForChain(nlChainId);
    const nlFromToken = nlTokens.find(t => t.symbol.toLowerCase() === nlFrom.toLowerCase());
    const nlToToken = nlTokens.find(t => t.symbol.toLowerCase() === nlTo.toLowerCase());
    if (nlFromToken && nlToToken) {
      sendTyping(chatId);
      const rawAmt = parseHumanAmount(nlAmount, nlFromToken.decimals);
      try {
        const { getSwapQuote } = await import("./okx-onchainos");
        const quote = await getSwapQuote({ chainId: nlChainId, fromTokenAddress: nlFromToken.address, toTokenAddress: nlToToken.address, amount: rawAmt, slippage: "1" });
        const receiveAmt = quote?.data?.[0]?.toTokenAmount ? formatTokenAmount(quote.data[0].toTokenAmount, nlToToken.decimals) : null;
        if (receiveAmt) {
          pendingOKXSwap.set(chatId, { step: "confirm", chainId: nlChainId, chainName: nlChain.name, fromToken: nlFromToken.address, fromSymbol: nlFromToken.symbol, toToken: nlToToken.address, toSymbol: nlToToken.symbol, amount: rawAmt, quoteData: quote.data[0] });
          await bot.sendMessage(chatId, `🔄 *Swap Quote on ${nlChain.name}*\n\n💰 ${nlAmount} ${nlFromToken.symbol} → ${receiveAmt} ${nlToToken.symbol}\n⛓ Chain: ${nlChain.name}\n\nConfirm this swap?`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Swap", callback_data: "okxswap_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } });
        } else {
          await bot.sendMessage(chatId, "No quote available. Try /swap to pick tokens manually.", { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `Quote error. Try /swap to pick tokens manually.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } else {
      await bot.sendMessage(chatId, `Token not found on ${nlChain.name}. Try /swap to pick manually.`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Open Swap", callback_data: "action:okxswap" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
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
          bot?.sendMessage(cid, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) }).catch(() => {});
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
          slippage: getSlippageForChain(chatId, "501"),
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
        try {
          const priceResult = await getTokenPrice(state.tokenAddress, "501");
          if (priceResult.success && priceResult.data?.price) {
            const entries = userTradeEntries.get(chatId) || [];
            entries.push({ tokenAddress: state.tokenAddress, chainId: "501", entryPrice: parseFloat(priceResult.data.price), amount: state.amount, nativeSymbol: "SOL", boughtAt: Date.now() });
            userTradeEntries.set(chatId, entries);
            saveTradeEntries(chatId);
          }
        } catch {}
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

    let walletAddr = getLinkedWallet(chatId);
    if (!walletAddr) {
      walletAddr = await autoGenerateWallet(chatId);
    }
    if (!await checkWalletHasKey(chatId, walletAddr)) {
      console.error(`[Wallet] Key unrecoverable for chatId=${chatId}, wallet=${walletAddr.substring(0, 8)}. Auto-regenerating...`);
      const newAddr = await regenerateWalletWithKey(chatId);
      if (newAddr) {
        await bot.sendMessage(chatId, `⚠️ *Wallet Key Recovery*\n\nYour previous wallet key couldn't be decrypted. A fresh wallet has been generated:\n\`${newAddr}\`\n\nPlease fund this wallet with ${state.nativeSymbol} and try your buy again.\n\nOr import your old private key: tap 👛 Wallet → Import.`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, "❌ Wallet key issue. Use /wallet to import your private key or generate a new wallet.", { reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "action:wallet" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
      pendingSignalBuy.delete(chatId);
      return;
    }

    const statusMsg = await bot.sendMessage(chatId, `⏳ *Executing buy:* ${state.amount} ${state.nativeSymbol} → ${state.tokenSymbol} on ${state.chainName}...\n\n🔄 Status: Finding best route...`, { parse_mode: "Markdown" });
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
        slippage: getSlippageForChain(chatId, state.chainId),
        userWalletAddress: walletAddr,
      });

      const txData = swapTx?.data?.[0]?.tx;
      if (!txData) throw new Error("No swap route found for this token. It may have low liquidity.");

      let pk = await resolvePrivateKey(chatId, walletAddr);
      if (!pk) {
        const newAddr = await regenerateWalletWithKey(chatId);
        if (newAddr) {
          pk = await resolvePrivateKey(chatId, newAddr);
          if (pk) {
            await bot.sendMessage(chatId, `⚠️ Your old wallet key was unrecoverable. A new wallet has been created: \`${newAddr}\`\n\nFund it with ${state.nativeSymbol} and retry your buy.`, { parse_mode: "Markdown" });
            pendingSignalBuy.delete(chatId);
            return;
          }
        }
        throw new Error("Private key not found. Use /wallet to check your wallet status.");
      }

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

      try { await bot.editMessageText(`⏳ *Executing buy:* ${state.amount} ${state.nativeSymbol} → ${state.tokenSymbol}\n\n🔄 Status: Sending transaction...`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }); } catch {}

      const tx = await wallet.sendTransaction({
        to: txData.to,
        data: txData.data,
        value: txData.value ? BigInt(txData.value) : 0n,
        gasLimit: txData.gasLimit ? BigInt(txData.gasLimit) : undefined,
      });

      try { await bot.editMessageText(`⏳ *Executing buy:* ${state.amount} ${state.nativeSymbol} → ${state.tokenSymbol}\n\n🔄 Status: TX sent, waiting for confirmation...\nTX: \`${tx.hash.substring(0, 20)}...\``, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }); } catch {}

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");

      const explorerUrls: Record<string, string> = {
        "56": "https://bscscan.com/tx/", "1": "https://etherscan.io/tx/",
        "8453": "https://basescan.org/tx/", "42161": "https://arbiscan.io/tx/",
        "137": "https://polygonscan.com/tx/", "10": "https://optimistic.etherscan.io/tx/",
        "43114": "https://snowtrace.io/tx/", "196": "https://www.okx.com/explorer/xlayer/tx/",
      };
      const explorer = explorerUrls[state.chainId] || "https://bscscan.com/tx/";

      const buyAmountWei = ethers.parseEther(state.amount);
      const buyFeeResult = await collectTransactionFee(pk, buyAmountWei, rpcUrl, chatId);

      pendingSignalBuy.delete(chatId);
      try {
        const priceResult = await getTokenPrice(state.tokenAddress, state.chainId);
        if (priceResult.success && priceResult.data?.price) {
          const entries = userTradeEntries.get(chatId) || [];
          entries.push({ tokenAddress: state.tokenAddress, chainId: state.chainId, entryPrice: parseFloat(priceResult.data.price), amount: state.amount, nativeSymbol: state.nativeSymbol, boughtAt: Date.now() });
          userTradeEntries.set(chatId, entries);
          saveTradeEntries(chatId);
        }
      } catch {}
      await bot.sendMessage(chatId,
        `✅ *Buy Executed!*\n\n` +
        `⚡ ${state.amount} ${state.nativeSymbol} → ${state.tokenSymbol}\n` +
        `⛓ ${state.chainName}\n` +
        `💡 Fee: ${buyFeeResult.feePercent}% (${buyFeeResult.tierLabel})\n\n` +
        `[View Transaction](${explorer}${receipt.hash})`,
        {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: `🟢 Buy More`, callback_data: `cabuy:${state.tokenAddress}:${state.chainId}:${state.amount}` }],
              [{ text: "📉 Sell", callback_data: "action:sell" }, { text: "🐋 Signals", callback_data: "action:okxsignals" }],
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

  if (data.startsWith("settings:")) {
    const setting = data.split(":")[1];
    const s = getUserSettings(chatId);
    if (setting === "slippage") {
      await bot.sendMessage(chatId, `📊 *Set Default Slippage*\n\nCurrent: *${s.defaultSlippage}%*`, {
        parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "0.5%", callback_data: "setslip:0.5" }, { text: "1%", callback_data: "setslip:1" }, { text: "3%", callback_data: "setslip:3" }],
          [{ text: "5%", callback_data: "setslip:5" }, { text: "10%", callback_data: "setslip:10" }, { text: "15%", callback_data: "setslip:15" }],
          [{ text: "« Back", callback_data: "action:settings" }],
        ] }
      });
    } else if (setting === "buyamt") {
      await bot.sendMessage(chatId, `💰 *Set Default Buy Amount*\n\nCurrent: *${s.defaultBuyAmount} BNB*`, {
        parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "0.01 BNB", callback_data: "setbuy:0.01" }, { text: "0.05 BNB", callback_data: "setbuy:0.05" }, { text: "0.1 BNB", callback_data: "setbuy:0.1" }],
          [{ text: "0.25 BNB", callback_data: "setbuy:0.25" }, { text: "0.5 BNB", callback_data: "setbuy:0.5" }, { text: "1 BNB", callback_data: "setbuy:1" }],
          [{ text: "« Back", callback_data: "action:settings" }],
        ] }
      });
    } else if (setting === "gas") {
      const next = s.gasPriority === "low" ? "normal" : s.gasPriority === "normal" ? "fast" : "low";
      s.gasPriority = next;
      await saveUserSettings(chatId, s);
      await bot.sendMessage(chatId, `⛽ Gas priority set to *${next}*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "action:settings" }]] } });
    } else if (setting === "autoapprove") {
      s.autoApprove = !s.autoApprove;
      await saveUserSettings(chatId, s);
      await bot.sendMessage(chatId, `✅ Auto-Approve is now *${s.autoApprove ? "ON" : "OFF"}*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "action:settings" }]] } });
    }
    return;
  }
  if (data.startsWith("setslip:")) {
    const val = parseFloat(data.split(":")[1]);
    const s = getUserSettings(chatId);
    s.defaultSlippage = val;
    await saveUserSettings(chatId, s);
    await bot.sendMessage(chatId, `📊 Default slippage set to *${val}%*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "action:settings" }]] } });
    return;
  }
  if (data.startsWith("setbuy:")) {
    const val = data.split(":")[1];
    const s = getUserSettings(chatId);
    s.defaultBuyAmount = val;
    await saveUserSettings(chatId, s);
    await bot.sendMessage(chatId, `💰 Default buy amount set to *${val} BNB*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "action:settings" }]] } });
    return;
  }

  if (data.startsWith("limitamt:")) {
    const amount = data.split(":")[1];
    const state = pendingLimitOrder.get(chatId);
    if (!state || state.step !== "amount") return;
    const isSol = state.chainId === "501";
    const nativeSym = isSol ? "SOL" : state.chainId === "8453" ? "ETH" : "BNB";
    const orderId = `LO${Date.now().toString(36)}`;
    const order: LimitOrder = {
      id: orderId,
      chatId,
      tokenAddress: state.tokenAddress!,
      chainId: state.chainId || "56",
      type: state.type!,
      triggerPrice: state.triggerPrice!,
      amount,
      nativeSymbol: nativeSym,
      tokenName: state.tokenName,
      createdAt: Date.now(),
      status: "active",
    };
    limitOrders.set(orderId, order);
    pendingLimitOrder.delete(chatId);
    saveLimitOrders();
    await bot.sendMessage(chatId,
      `✅ *Limit Order Created*\n\n` +
      `${order.type === "buy" ? "🟢" : "🔴"} *${order.type.toUpperCase()}* ${order.amount} ${nativeSym}\n` +
      `Token: \`${order.tokenAddress.substring(0, 12)}...\`${order.tokenName ? ` (${order.tokenName})` : ""}\n` +
      `Trigger: $${order.triggerPrice < 0.01 ? order.triggerPrice.toExponential(3) : order.triggerPrice.toFixed(6)}\n` +
      `ID: \`${orderId}\`\n\n` +
      `Order will execute automatically when price reaches your target.`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: "📋 View Orders", callback_data: "action:limitorders" }, { text: "➕ New Order", callback_data: `limit:new:${order.type}` }],
        [{ text: "« Menu", callback_data: "action:menu" }],
      ] } }
    );
    return;
  }

  if (data === "action:settings") {
    const s = getUserSettings(chatId);
    await bot.sendMessage(chatId,
      `⚙️ *Trading Settings*\n\n` +
      `📊 Default Slippage: *${s.defaultSlippage}%*\n` +
      `💰 Default Buy Amount: *${s.defaultBuyAmount} BNB*\n` +
      `⛽ Gas Priority: *${s.gasPriority}*\n` +
      `✅ Auto-Approve: *${s.autoApprove ? "ON" : "OFF"}*`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: `📊 Slippage: ${s.defaultSlippage}%`, callback_data: "settings:slippage" }, { text: `💰 Buy: ${s.defaultBuyAmount}`, callback_data: "settings:buyamt" }],
        [{ text: `⛽ Gas: ${s.gasPriority}`, callback_data: "settings:gas" }, { text: `${s.autoApprove ? "✅" : "❌"} Auto-Approve`, callback_data: "settings:autoapprove" }],
        [{ text: "« Menu", callback_data: "action:menu" }],
      ] } }
    );
    return;
  }

  if (data.startsWith("limit:new:")) {
    const type = data.split(":")[2] as "buy" | "sell";
    pendingLimitOrder.set(chatId, { step: "chain", type });
    const chainButtons = [
      [{ text: "BNB Chain", callback_data: `limitchain:56` }, { text: "Ethereum", callback_data: `limitchain:1` }],
      [{ text: "Base", callback_data: `limitchain:8453` }, { text: "Solana", callback_data: `limitchain:501` }],
      [{ text: "« Cancel", callback_data: "action:menu" }],
    ];
    await bot.sendMessage(chatId, `📋 *New ${type.toUpperCase()} Limit Order*\n\nSelect chain:`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } });
    return;
  }
  if (data.startsWith("limitchain:")) {
    const chainId = data.split(":")[1];
    const state = pendingLimitOrder.get(chatId);
    if (!state) return;
    state.chainId = chainId;
    state.step = "address";
    pendingLimitOrder.set(chatId, state);
    await bot.sendMessage(chatId, `Enter the token contract address:`);
    return;
  }
  if (data === "limit:cancelall") {
    let cancelled = 0;
    for (const [id, order] of Array.from(limitOrders.entries())) {
      if (order.chatId === chatId && order.status === "active") {
        order.status = "cancelled";
        limitOrders.delete(id);
        cancelled++;
      }
    }
    saveLimitOrders();
    await bot.sendMessage(chatId, `❌ Cancelled ${cancelled} limit order${cancelled !== 1 ? "s" : ""}.`, { reply_markup: { inline_keyboard: [[{ text: "📋 Limit Orders", callback_data: "action:limitorders" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    return;
  }
  if (data.startsWith("limitcancel:")) {
    const orderId = data.split(":")[1];
    const order = limitOrders.get(orderId);
    if (order && order.chatId === chatId) {
      limitOrders.delete(orderId);
      saveLimitOrders();
      await bot.sendMessage(chatId, `❌ Limit order cancelled.`, { reply_markup: { inline_keyboard: [[{ text: "📋 Limit Orders", callback_data: "action:limitorders" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }
  if (data === "action:limitorders") {
    const userOrders = Array.from(limitOrders.values()).filter(o => o.chatId === chatId && o.status === "active");
    let msg = `📋 *Limit Orders*\n\n`;
    if (userOrders.length === 0) {
      msg += `No active limit orders.`;
    } else {
      for (const o of userOrders) {
        const typeIcon = o.type === "buy" ? "🟢" : "🔴";
        msg += `${typeIcon} *${o.type.toUpperCase()}* ${o.amount} ${o.nativeSymbol}\n`;
        msg += `Token: \`${o.tokenAddress.substring(0, 10)}...\`${o.tokenName ? ` (${o.tokenName})` : ""}\n`;
        msg += `Trigger: $${o.triggerPrice < 0.01 ? o.triggerPrice.toExponential(3) : o.triggerPrice.toFixed(6)}\n`;
        msg += `[❌ Cancel](cancel)\n\n`;
      }
    }
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "🟢 New Buy Limit", callback_data: "limit:new:buy" }, { text: "🔴 New Sell Limit", callback_data: "limit:new:sell" }],
      ...(userOrders.map(o => [{ text: `❌ Cancel ${o.type} ${o.tokenAddress.substring(0, 6)}...`, callback_data: `limitcancel:${o.id}` }])),
      [{ text: "« Menu", callback_data: "action:menu" }],
    ] } });
    return;
  }

  if (data === "watch:add") {
    pendingWatchlistAlert.set(chatId, { tokenAddress: "", chainId: "", step: "above" });
    const chainButtons = [
      [{ text: "BNB Chain", callback_data: `watchchain:56` }, { text: "Ethereum", callback_data: `watchchain:1` }],
      [{ text: "Base", callback_data: `watchchain:8453` }, { text: "Solana", callback_data: `watchchain:501` }],
      [{ text: "« Cancel", callback_data: "action:menu" }],
    ];
    await bot.sendMessage(chatId, `👁️ *Add to Watchlist*\n\nSelect chain:`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } });
    return;
  }
  if (data.startsWith("watchchain:")) {
    const chainId = data.split(":")[1];
    pendingWatchlistAlert.set(chatId, { tokenAddress: "", chainId, step: "above" });
    await bot.sendMessage(chatId, `Enter the token contract address to watch:`);
    return;
  }
  if (data === "watch:refresh") {
    const list = userWatchlists.get(chatId) || [];
    if (list.length === 0) {
      await bot.sendMessage(chatId, "Watchlist is empty.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    await bot.sendMessage(chatId, "🔄 Refreshing prices...");
    for (const item of list) {
      try {
        const result = await getTokenPrice(item.tokenAddress, item.chainId);
        if (result.success && result.data?.price) {
          item.lastPrice = parseFloat(result.data.price);
        }
      } catch {}
    }
    userWatchlists.set(chatId, list);
    saveWatchlist(chatId);
    let msg = `👁️ *Watchlist* (updated)\n\n`;
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      const priceStr = w.lastPrice ? `$${w.lastPrice < 0.01 ? w.lastPrice.toExponential(3) : w.lastPrice.toFixed(6)}` : "N/A";
      msg += `${i + 1}. *${w.tokenSymbol || w.tokenAddress.substring(0, 8) + "..."}* — ${priceStr}\n`;
      if (w.alertAbove) msg += `   🔔 Above: $${w.alertAbove < 0.01 ? w.alertAbove.toExponential(3) : w.alertAbove.toFixed(6)}\n`;
      if (w.alertBelow) msg += `   🔔 Below: $${w.alertBelow < 0.01 ? w.alertBelow.toExponential(3) : w.alertBelow.toFixed(6)}\n`;
    }
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "➕ Add Token", callback_data: "watch:add" }, { text: "🗑️ Clear All", callback_data: "watch:clearall" }],
      ...list.map((w, i) => [{ text: `🔔 Alert: ${w.tokenSymbol || w.tokenAddress.substring(0, 6) + "..."}`, callback_data: `watchalert:${i}` }, { text: `🗑️`, callback_data: `watchdel:${i}` }]),
      [{ text: "« Menu", callback_data: "action:menu" }],
    ] } });
    return;
  }
  if (data === "watch:clearall") {
    userWatchlists.delete(chatId);
    saveTradingData(chatId, "watchlist", []);
    await bot.sendMessage(chatId, "🗑️ Watchlist cleared.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    return;
  }
  if (data.startsWith("watchdel:")) {
    const idx = parseInt(data.split(":")[1]);
    const list = userWatchlists.get(chatId) || [];
    if (idx >= 0 && idx < list.length) {
      const removed = list.splice(idx, 1)[0];
      userWatchlists.set(chatId, list);
      saveWatchlist(chatId);
      await bot.sendMessage(chatId, `🗑️ Removed *${removed.tokenSymbol || removed.tokenAddress.substring(0, 8) + "..."}* from watchlist.`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "👁️ Watchlist", callback_data: "action:watchlist" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }
  if (data.startsWith("watchalert:")) {
    const idx = parseInt(data.split(":")[1]);
    const list = userWatchlists.get(chatId) || [];
    if (idx >= 0 && idx < list.length) {
      const w = list[idx];
      pendingWatchlistAlert.set(chatId, { tokenAddress: w.tokenAddress, chainId: w.chainId, step: "above" });
      await bot.sendMessage(chatId,
        `🔔 *Set Price Alert*\n\n` +
        `Token: *${w.tokenSymbol || w.tokenAddress.substring(0, 10) + "..."}*\n` +
        `Current price: $${w.lastPrice ? (w.lastPrice < 0.01 ? w.lastPrice.toExponential(3) : w.lastPrice.toFixed(6)) : "N/A"}\n\n` +
        `Enter the price to alert *above* (or type "skip" to set below only):`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }
  if (data === "action:watchlist") {
    const list = userWatchlists.get(chatId) || [];
    let msg = `👁️ *Watchlist*\n\n`;
    if (list.length === 0) {
      msg += `Your watchlist is empty.`;
    } else {
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        const priceStr = w.lastPrice ? `$${w.lastPrice < 0.01 ? w.lastPrice.toExponential(3) : w.lastPrice.toFixed(6)}` : "fetching...";
        msg += `${i + 1}. *${w.tokenSymbol || w.tokenAddress.substring(0, 8) + "..."}* — ${priceStr}\n`;
      }
    }
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "➕ Add Token", callback_data: "watch:add" }, { text: "🔄 Refresh", callback_data: "watch:refresh" }],
      [{ text: "« Menu", callback_data: "action:menu" }],
    ] } });
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

  if (data.startsWith("cacustom:")) {
    const parts = data.split(":");
    const tokenAddr = parts[1];
    const chainId = parts[2];
    const isSolana = chainId === "501";
    const nativeSymbol = isSolana ? "SOL" : chainId === "8453" ? "ETH" : "BNB";
    pendingSignalBuy.set(chatId, {
      tokenAddress: tokenAddr,
      tokenSymbol: "Token",
      chainId,
      chainName: isSolana ? "Solana" : chainId === "8453" ? "Base" : "BNB Chain",
      nativeSymbol,
      amount: "",
      step: "amount",
    });
    await bot.sendMessage(chatId,
      `💱 *Custom Buy Amount*\n\nEnter the amount of ${nativeSymbol} to spend:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:menu" }]] } }
    );
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

  if (data === "action:submenu_trading") {
    const c = chatId;
    await bot.sendMessage(chatId,
      "💹 *Trading*\n━━━━━━━━━━━━━━━━━━━━\n\nBuy, sell, swap & bridge tokens across chains.\nUse Aster DEX for leveraged futures.", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: tr("menu.buy", c), callback_data: "action:buy" }, { text: tr("menu.sell", c), callback_data: "action:sell" }],
        [{ text: tr("menu.swap", c), callback_data: "action:okxswap" }, { text: tr("menu.bridge", c), callback_data: "action:okxbridge" }],
        [{ text: "📋 Limit Orders", callback_data: "action:limitorders" }, { text: "👁️ Watchlist", callback_data: "action:watchlist" }],
        [{ text: "📈 Futures (Aster)", callback_data: "action:aster" }, { text: "💎 Auto Trade", callback_data: "action:trade" }],
        [{ text: "⚙️ Settings", callback_data: "action:settings" }],
        [{ text: tr("menu.back", c), callback_data: "action:menu" }],
      ]}
    });
    return;
  }

  if (data === "action:submenu_market") {
    const c = chatId;
    await bot.sendMessage(chatId,
      "📡 *Market Intel*\n━━━━━━━━━━━━━━━━━━━━\n\nSmart money signals, trending tokens, security scans & gas prices.", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: tr("menu.signals", c), callback_data: "action:okxsignals" }, { text: tr("menu.security", c), callback_data: "action:okxsecurity" }],
        [{ text: tr("menu.trending", c), callback_data: "action:okxtrending" }, { text: tr("menu.meme", c), callback_data: "action:okxmeme" }],
        [{ text: tr("menu.price", c), callback_data: "action:okxprice" }, { text: tr("menu.gas", c), callback_data: "action:okxgas" }],
        [{ text: tr("menu.back", c), callback_data: "action:menu" }],
      ]}
    });
    return;
  }

  if (data === "action:submenu_agents") {
    const c = chatId;
    await bot.sendMessage(chatId,
      "🤖 *AI Agents*\n━━━━━━━━━━━━━━━━━━━━\n\nCreate agents, assign tasks, compete in challenges & copy top traders.", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: tr("menu.createAgent", c), callback_data: "action:newagent" }, { text: tr("menu.myAgents", c), callback_data: "action:myagents" }],
        [{ text: tr("menu.newTask", c), callback_data: "action:task" }, { text: tr("menu.myTasks", c), callback_data: "action:mytasks" }],
        [{ text: "🏆 Challenges", callback_data: "action:challenges" }, { text: "📋 Copy Trade", callback_data: "action:copytrade_menu" }],
        [{ text: tr("menu.back", c), callback_data: "action:menu" }],
      ]}
    });
    return;
  }

  if (data === "action:submenu_earn") {
    const c = chatId;
    await bot.sendMessage(chatId,
      "💰 *Earn $B4*\n━━━━━━━━━━━━━━━━━━━━\n\nComplete quests, refer friends, stake to reduce fees & earn rewards.", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: tr("menu.quests", c), callback_data: "action:quests" }, { text: tr("menu.rewards", c), callback_data: "action:rewards" }],
        [{ text: "💎 Fee Tiers", callback_data: "action:fees" }, { text: tr("menu.referral", c), callback_data: "action:referral" }],
        [{ text: tr("menu.premium", c), callback_data: "action:substatus" }],
        [{ text: tr("menu.back", c), callback_data: "action:menu" }],
      ]}
    });
    return;
  }

  if (data === "action:fees") {
    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId, "You need a wallet first. Use /start to create one.");
      return;
    }
    try {
      const tier = await getUserFeeTier(wallet);
      const { ethers: ethFees } = await import("ethers");
      const bscProv = new ethFees.JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
      const b4c = new ethFees.Contract(BUILD4_TOKEN_CA, erc20Abi, bscProv);
      let b4Balance = 0n;
      try { b4Balance = await b4c.balanceOf(wallet); } catch {}
      const b4Formatted = Number(ethFees.formatEther(b4Balance));

      let tierList = "";
      for (const t of FEE_TIERS) {
        const marker = t.label === tier.label ? " ← You" : "";
        const holdReq = t.minB4 > 0 ? `${t.minB4.toLocaleString()}+ $B4` : "No minimum";
        tierList += `${t.feePercent === 0 ? "💎" : t.feePercent <= 0.25 ? "🏆" : t.feePercent <= 0.5 ? "🥇" : t.feePercent <= 0.75 ? "🥈" : "📊"} *${t.label}* — ${holdReq}${marker}\n`;
      }

      await bot.sendMessage(chatId,
        `💰 *BUILD4 Fee Tiers*\n\n` +
        `Your $B4 balance: *${Math.floor(b4Formatted).toLocaleString()}*\n` +
        `Your tier: *${tier.label}*\n\n` +
        `${tierList}\n` +
        `Hold or stake more $B4 to unlock lower fees!\n` +
        `Wallet + staked $B4 both count toward your tier.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "🟢 Buy $B4", callback_data: "action:buybuild4" }],
          [{ text: "🔒 Stake $B4", callback_data: "action:staking" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ] } }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, "Could not load fee info. Try again later.");
    }
    return;
  }

  if (data === "action:challenges") {
    const { getActiveChallenges, getChallengeLeaderboard } = await import("./trading-challenge");
    const challenges = await getActiveChallenges();
    if (challenges.length === 0) {
      await bot.sendMessage(chatId,
        `🏆 *Trading Agent Challenge*\n\nNo active challenges right now.\n\nCreate an AI trading agent and compete for $B4 prizes!`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🤖 Create Agent", callback_data: "action:createagent" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }
    let msg = `🏆 *Trading Agent Challenges*\n\n`;
    const buttons: any[][] = [];
    for (const c of challenges) {
      const timeLeft = c.endDate > new Date() ? Math.ceil((c.endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : 0;
      const entries = await getChallengeLeaderboard(c.id);
      msg += `*${c.name}*\n${c.description || ""}\n💰 Prize: ${parseInt(c.prizePoolB4).toLocaleString()} $B4\n👥 ${entries.length}/${c.maxEntries} entries\n⏰ ${timeLeft}d left | ${c.status === "active" ? "🟢 Active" : "🟡 Upcoming"}\n\n`;
      buttons.push([{ text: `📊 ${c.name} Leaderboard`, callback_data: `challenge_lb:${c.id}` }]);
      if (c.status === "active" || c.status === "upcoming") {
        buttons.push([{ text: `⚡ Join ${c.name}`, callback_data: `challenge_join:${c.id}` }]);
      }
    }
    buttons.push([{ text: "« Menu", callback_data: "action:menu" }]);
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (data.startsWith("challenge_lb:")) {
    const challengeId = data.split(":")[1];
    const { getChallengeLeaderboard, getChallengeById } = await import("./trading-challenge");
    const challenge = await getChallengeById(challengeId);
    if (!challenge) { await bot.sendMessage(chatId, "Challenge not found."); return; }
    const entries = await getChallengeLeaderboard(challengeId);
    if (entries.length === 0) {
      await bot.sendMessage(chatId, `📊 *${challenge.name} — Leaderboard*\n\nNo entries yet. Be the first to join!`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⚡ Join", callback_data: `challenge_join:${challengeId}` }], [{ text: "« Back", callback_data: "action:challenges" }]] } });
      return;
    }
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    let prizeAmounts: string[] = [];
    try { if (challenge.prizeDistribution) prizeAmounts = JSON.parse(challenge.prizeDistribution); } catch {}
    let msg = `📊 *${challenge.name} — Leaderboard*\n💰 Prize pool: ${parseInt(challenge.prizePoolB4).toLocaleString()} $B4\n`;
    if (prizeAmounts.length > 0) {
      msg += `🥇 ${parseInt(prizeAmounts[0]).toLocaleString()}`;
      if (prizeAmounts[1]) msg += ` | 🥈 ${parseInt(prizeAmounts[1]).toLocaleString()}`;
      if (prizeAmounts[2]) msg += ` | 🥉 ${parseInt(prizeAmounts[2]).toLocaleString()}`;
      msg += ` $B4\n`;
    }
    msg += `\n`;
    for (let i = 0; i < Math.min(entries.length, 10); i++) {
      const e = entries[i];
      const pnl = parseFloat(e.pnlPercent);
      const agentRow = await storage.getAgent(e.agentId);
      const prizeTag = prizeAmounts[i] ? ` — 💰 ${parseInt(prizeAmounts[i]).toLocaleString()} $B4` : "";
      msg += `${medals[i] || `${i + 1}.`} *${agentRow?.name || "Agent"}*\n   PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}% | ${parseFloat(e.currentBalanceBnb).toFixed(4)} BNB${prizeTag}\n`;
    }
    const buttons: any[][] = [[{ text: "⚡ Join Challenge", callback_data: `challenge_join:${challengeId}` }]];
    for (const e of entries.slice(0, 5)) {
      buttons.push([{ text: `📋 Copy ${(await storage.getAgent(e.agentId))?.name || "Agent"}`, callback_data: `copytrade_start:${e.agentId}` }]);
    }
    buttons.push([{ text: "« Back", callback_data: "action:challenges" }]);
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (data.startsWith("challenge_join:")) {
    const challengeId = data.split(":")[1];
    const wallet = getLinkedWallet(chatId);
    if (!wallet) { await bot.sendMessage(chatId, "You need a wallet first. Use /start."); return; }
    const myAgents = await storage.getAgentsByTelegramChatId(chatId.toString());
    if (!myAgents || myAgents.length === 0) {
      await bot.sendMessage(chatId, "You need an AI agent to enter. Create one first!", { reply_markup: { inline_keyboard: [[{ text: "🤖 Create Agent", callback_data: "action:createagent" }], [{ text: "« Back", callback_data: "action:challenges" }]] } });
      return;
    }
    if (myAgents.length === 1) {
      const { joinChallenge } = await import("./trading-challenge");
      const result = await joinChallenge(challengeId, myAgents[0].id, chatId.toString(), wallet);
      if (result.success) {
        await bot.sendMessage(chatId, `✅ *${myAgents[0].name}* joined the challenge!\n\nStarting balance: ${parseFloat(result.entry!.startingBalanceBnb).toFixed(4)} BNB\n\nYour agent will be tracked on the leaderboard. Trade to climb the ranks!`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "📊 Leaderboard", callback_data: `challenge_lb:${challengeId}` }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      } else {
        await bot.sendMessage(chatId, `❌ ${result.error}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:challenges" }]] } });
      }
      return;
    }
    const agentButtons = myAgents.map(a => [{ text: `🤖 ${a.name}`, callback_data: `challenge_pick:${challengeId}:${a.id}` }]);
    agentButtons.push([{ text: "« Back", callback_data: "action:challenges" }]);
    await bot.sendMessage(chatId, "Which agent do you want to enter?", { reply_markup: { inline_keyboard: agentButtons } });
    return;
  }

  if (data.startsWith("challenge_pick:")) {
    const parts = data.split(":");
    const challengeId = parts[1];
    const agentId = parts[2];
    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;
    const { joinChallenge } = await import("./trading-challenge");
    const agent = await storage.getAgent(agentId);
    const result = await joinChallenge(challengeId, agentId, chatId.toString(), wallet);
    if (result.success) {
      await bot.sendMessage(chatId, `✅ *${agent?.name || "Agent"}* joined the challenge!\n\nStarting balance: ${parseFloat(result.entry!.startingBalanceBnb).toFixed(4)} BNB\n\nTrade to climb the ranks!`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "📊 Leaderboard", callback_data: `challenge_lb:${challengeId}` }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    } else {
      await bot.sendMessage(chatId, `❌ ${result.error}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:challenges" }]] } });
    }
    return;
  }

  if (data.startsWith("copytrade_start:")) {
    const agentId = data.split(":")[1];
    const wallet = getLinkedWallet(chatId);
    if (!wallet || !await checkWalletHasKey(chatId, wallet)) {
      await bot.sendMessage(chatId, "You need a wallet with a private key to copy trade. Use /wallet.");
      return;
    }
    const agent = await storage.getAgent(agentId);
    pendingCopyTradeAmount.set(chatId, { agentId, agentName: agent?.name || "Agent" });
    await bot.sendMessage(chatId,
      `📋 *Copy Trade: ${agent?.name || "Agent"}*\n\n` +
      `Enter the max BNB amount per trade (e.g. 0.05, 0.1):\n\n` +
      `This is the maximum your wallet will spend per copied trade.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data.startsWith("copytrade_stop:")) {
    const agentId = data.split(":")[1];
    const { removeCopyTrade } = await import("./trading-challenge");
    await removeCopyTrade(chatId.toString(), agentId);
    await bot.sendMessage(chatId, "✅ Copy trade stopped.", { reply_markup: { inline_keyboard: [[{ text: "📋 My Copy Trades", callback_data: "action:copytrades" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
    return;
  }

  if (data === "action:copytrade_menu") {
    const { getTopPerformingAgents, getActiveCopyTrades } = await import("./trading-challenge");
    const copies = await getActiveCopyTrades(chatId.toString());
    const topAgents = await getTopPerformingAgents(5);
    let msg = `📋 *Copy Trading*\n\nMirror top agent trades automatically.\n\n`;
    const buttons: any[][] = [];
    if (copies.length > 0) {
      msg += `*Active (${copies.length}):*\n`;
      for (const ct of copies) {
        msg += `• ${ct.agentName || "Agent"} — Max ${ct.maxAmountBnb} BNB\n`;
      }
      msg += `\n`;
      buttons.push([{ text: "🛑 Manage Copy Trades", callback_data: "action:copytrades" }]);
    }
    if (topAgents.length > 0) {
      msg += `*Top Agents:*\n`;
      for (let i = 0; i < topAgents.length; i++) {
        const a = topAgents[i];
        const pnl = parseFloat(a.pnlPercent);
        msg += `${i + 1}. ${a.agentName} — ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%\n`;
        buttons.push([{ text: `📋 Copy ${a.agentName}`, callback_data: `copytrade_start:${a.agentId}` }]);
      }
    } else {
      msg += `No agents with performance data yet.`;
    }
    buttons.push([{ text: "🏆 View Challenges", callback_data: "action:challenges" }]);
    buttons.push([{ text: "« Back", callback_data: "action:submenu_agents" }]);
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (data === "action:copytrades") {
    const { getActiveCopyTrades } = await import("./trading-challenge");
    const copies = await getActiveCopyTrades(chatId.toString());
    if (copies.length === 0) {
      await bot.sendMessage(chatId, "No active copy trades. Use /copytrade to start.", { reply_markup: { inline_keyboard: [[{ text: "📋 Copy Trade", callback_data: "action:copytrade_menu" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      return;
    }
    let msg = `📋 *Your Copy Trades*\n\n`;
    const buttons: any[][] = [];
    for (const ct of copies) {
      msg += `🤖 *${ct.agentName || "Agent"}*\nMax: ${ct.maxAmountBnb} BNB | Trades: ${ct.totalCopied}\n\n`;
      buttons.push([{ text: `🛑 Stop ${ct.agentName}`, callback_data: `copytrade_stop:${ct.agentId}` }]);
    }
    buttons.push([{ text: "« Menu", callback_data: "action:menu" }]);
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (data === "action:portfolio") {
    await handlePortfolio(chatId);
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

  if (data.startsWith("registerchain:")) {
    const agentId = data.split(":")[1];
    const agent = await storage.getAgent(agentId);
    if (!agent) { await bot.sendMessage(chatId, "Agent not found."); return; }

    await bot.sendMessage(chatId,
      `⛓️ *Register ${agent.name} on-chain*\n\nPick the chain you want to register on:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔵 Base (~0.0005 ETH gas)", callback_data: `regchain:${agentId}:base` }],
            [{ text: "🟡 BNB Chain (~0.002 BNB gas)", callback_data: `regchain:${agentId}:bsc` }],
            [{ text: "« Back", callback_data: "action:myagents" }],
          ]
        }
      }
    );
    return;
  }

  if (data.startsWith("regchain:")) {
    const parts = data.split(":");
    const agentId = parts[1];
    const network = parts[2];
    const agent = await storage.getAgent(agentId);
    if (!agent) { await bot.sendMessage(chatId, "Agent not found."); return; }

    const userWallet = getLinkedWallet(chatId);
    if (!userWallet) { await bot.sendMessage(chatId, "No wallet linked."); return; }

    const userPk = await resolvePrivateKey(chatId, userWallet) || undefined;
    if (!userPk) {
      await bot.sendMessage(chatId,
        `⚠️ Could not access your wallet key for on-chain registration.\n\nPlease ensure your wallet is set up via /wallet.`,
        { reply_markup: { inline_keyboard: [[{ text: "My Wallet", callback_data: "action:wallet" }, { text: "Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    const chainName = network === "bsc" ? "BNB Chain" : "Base";
    const gasInfo = network === "bsc" ? "~0.002 BNB" : "~0.0005 ETH";
    const explorer = network === "bsc" ? "bscscan.com" : "basescan.org";
    const explorerName = network === "bsc" ? "BscScan" : "BaseScan";

    await bot.sendMessage(chatId,
      `⛓️ *Registering ${agent.name} on ${chainName}...*\n\n` +
      `ERC-8004 Identity Registry on ${chainName}.\n` +
      `Requires ${gasInfo} for gas.\n\n⏳ Processing...`,
      { parse_mode: "Markdown" }
    );

    try {
      const result = await registerAgentERC8004(agent.name, agent.bio || "", agentId, network, userPk);

      if (result.success) {
        const chainKey = network === "bsc" ? "bnb" : "base";
        try {
          const { db } = await import("./db");
          const { agents: agentsTable } = await import("@shared/schema");
          const { eq } = await import("drizzle-orm");
          await db.update(agentsTable).set({
            erc8004Registered: true,
            erc8004TxHash: result.txHash || null,
            erc8004TokenId: result.tokenId || null,
            erc8004Chain: chainKey,
          }).where(eq(agentsTable.id, agentId));
        } catch (dbErr: any) {
          console.error(`[TelegramBot] ERC-8004 manual reg DB update failed:`, dbErr.message);
          try {
            const { db } = await import("./db");
            const { sql } = await import("drizzle-orm");
            await db.execute(sql`UPDATE agents SET erc8004_registered = true, erc8004_tx_hash = ${result.txHash || null}, erc8004_token_id = ${result.tokenId || null}, erc8004_chain = ${chainKey} WHERE id = ${agentId}`);
          } catch (rawErr: any) {
            console.error(`[TelegramBot] ERC-8004 manual reg raw SQL also failed:`, rawErr.message);
          }
        }
        if (agent.creatorWallet) agentCache.delete(agent.creatorWallet);

        const txLink = result.txHash ? `\n🔗 [View on ${explorerName}](https://${explorer}/tx/${result.txHash})` : "";
        const tokenInfo = result.tokenId ? `\n🆔 Token ID: \`${result.tokenId}\`` : "";

        await bot.sendMessage(chatId,
          `✅ *${agent.name} registered on-chain!*\n\n` +
          `⛓️ Standard: ERC-8004 Identity Registry\n` +
          `🌐 Chain: ${chainName}\n` +
          `📄 Contract: \`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432\`${tokenInfo}${txLink}\n\n` +
          `Your agent now has a verified on-chain identity on ${chainName}.`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "My Agents", callback_data: "action:myagents" }, { text: "Menu", callback_data: "action:menu" }]] } }
        );
      } else {
        let errorMsg = result.error || "Unknown error";
        let suggestion = "";
        if (errorMsg.includes("Insufficient") || errorMsg.includes("balance")) {
          const gasToken = network === "bsc" ? "BNB" : "ETH on Base";
          suggestion = `\n\n💡 Fund your wallet with ${gasToken} first:\n\`${userWallet}\``;
        }

        await bot.sendMessage(chatId,
          `❌ *Registration failed on ${chainName}*\n\n${errorMsg}${suggestion}`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Try Again", callback_data: `registerchain:${agentId}` }, { text: "My Agents", callback_data: "action:myagents" }]] } }
        );
      }
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `❌ Registration error: ${e.message?.substring(0, 200)}`,
        { reply_markup: { inline_keyboard: [[{ text: "Try Again", callback_data: `registerchain:${agentId}` }, { text: "Menu", callback_data: "action:menu" }]] } }
      );
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
            [{ text: "☀️ Raydium LaunchLab (Solana) ⭐", callback_data: `launchplatform:${agentId}:raydium` }],
            [{ text: "🔵 Bankr (Base/Solana)", callback_data: `launchplatform:${agentId}:bankr` }],
            [{ text: "Four.meme (BNB Chain)", callback_data: `launchplatform:${agentId}:four_meme` }],
            [{ text: "Flap.sh (BNB Chain)", callback_data: `launchplatform:${agentId}:flap_sh` }],
            [{ text: "XLayer (OKX)", callback_data: `launchplatform:${agentId}:xlayer` }],
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
    if (platform !== "four_meme" && platform !== "flap_sh" && platform !== "bankr" && platform !== "xlayer" && platform !== "raydium") {
      await bot.sendMessage(chatId, "Invalid platform. Please try again.");
      return;
    }

    state.platform = platform;

    if (platform === "raydium") {
      state.step = "name";
      state.platform = "raydium";
      pendingTokenLaunch.set(chatId, state);
      await bot.sendMessage(chatId,
        `☀️ Raydium LaunchLab (Solana)\n\nYour token will launch on a bonding curve. Once it fills, liquidity auto-migrates to Raydium DEX.\n\nWhat's the token name? (1-50 chars)\n\nExample: DogeBrain, MoonCat, AgentX`
      );
      return;
    }

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

  if (data.startsWith("bankrstealth:")) {
    const agentId = data.split(":")[1];
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId) return;

    state.step = "stealth_buy";
    pendingTokenLaunch.set(chatId, state);

    const chainCurrency = state.bankrChain === "solana" ? "SOL" : "ETH";
    await bot.sendMessage(chatId,
      `🥷 STEALTH BUY SETUP\n\n` +
      `This will execute a buy through Bankr immediately after your token deploys — before anyone else can see it.\n\n` +
      `Choose an option or enter a custom ${chainCurrency} amount:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `1 ${chainCurrency}`, callback_data: `bankrstealthamt:${agentId}:1` },
              { text: `3 ${chainCurrency}`, callback_data: `bankrstealthamt:${agentId}:3` },
              { text: `5 ${chainCurrency}`, callback_data: `bankrstealthamt:${agentId}:5` },
            ],
            [
              { text: `10 ${chainCurrency}`, callback_data: `bankrstealthamt:${agentId}:10` },
              { text: `20 ${chainCurrency}`, callback_data: `bankrstealthamt:${agentId}:20` },
            ],
            [{ text: "70% of supply", callback_data: `bankrstealthpct:${agentId}:70` }],
            [{ text: "Skip stealth buy", callback_data: `bankrstealthamt:${agentId}:0` }],
          ]
        }
      }
    );
    return;
  }

  if (data.startsWith("bankrstealthamt:") || data.startsWith("bankrstealthpct:")) {
    const isPct = data.startsWith("bankrstealthpct:");
    const parts = data.split(":");
    const agentId = parts[1];
    const value = parts[2];
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId) return;

    if (isPct) {
      state.stealthBuyPercent = parseInt(value, 10);
      state.stealthBuyEth = undefined;
    } else if (value === "0") {
      state.stealthBuyEth = undefined;
      state.stealthBuyPercent = undefined;
    } else {
      state.stealthBuyEth = value;
      state.stealthBuyPercent = undefined;
    }

    showLaunchPreview(chatId, state);
    return;
  }

  if (data.startsWith("foursnipe:")) {
    const agentId = data.split(":")[1];
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId) return;
    if (!process.env.ADMIN_CHAT_ID || chatId.toString() !== process.env.ADMIN_CHAT_ID) return;

    state.step = "snipe_config";
    pendingTokenLaunch.set(chatId, state);

    await bot.sendMessage(chatId,
      `🎯 SNIPE LAUNCH SETUP\n\n` +
      `This will:\n` +
      `1️⃣ Fund sniper wallets via relay wallets\n` +
      `2️⃣ Launch token with dev buy on the curve\n` +
      `3️⃣ Instant snipe buys from all funded wallets\n\n` +
      `Choose a preset or set your own:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎯 70% Dev + 10 × 1 BNB (~28 BNB)", callback_data: `snipecfg:${agentId}:default` }],
            [
              { text: "50% Dev + 10 × 1 BNB", callback_data: `snipecfg:${agentId}:50` },
              { text: "80% Dev + 10 × 1 BNB", callback_data: `snipecfg:${agentId}:80` },
            ],
            [{ text: "⚙️ Custom Setup", callback_data: `snipecfg:${agentId}:custom` }],
            [{ text: "Skip snipe launch", callback_data: `snipecfg:${agentId}:skip` }],
          ]
        }
      }
    );
    return;
  }

  if (data.startsWith("snipecfg:")) {
    const parts = data.split(":");
    const agentId = parts[1];
    const preset = parts[2];
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.agentId !== agentId) return;
    if (!process.env.ADMIN_CHAT_ID || chatId.toString() !== process.env.ADMIN_CHAT_ID) return;

    if (preset === "skip") {
      state.sniperEnabled = false;
      state.sniperDevBuyBnb = undefined;
      state.sniperWalletCount = undefined;
      state.sniperPerWalletBnb = undefined;
      showLaunchPreview(chatId, state);
      return;
    }

    if (preset === "custom") {
      state.sniperEnabled = true;
      state.step = "snipe_wallets";
      pendingTokenLaunch.set(chatId, state);
      await bot.sendMessage(chatId,
        `⚙️ Custom Snipe Setup\n\n` +
        `Step 1/3: How many sniper wallets?\n\n` +
        `Enter a number (1-50):`,
      );
      return;
    }

    state.sniperEnabled = true;
    state.sniperWalletCount = 10;
    state.sniperPerWalletBnb = "1";
    if (preset === "50") {
      state.sniperDevBuyBnb = "13";
    } else if (preset === "80") {
      state.sniperDevBuyBnb = "20.8";
    } else {
      state.sniperDevBuyBnb = "18";
    }

    showLaunchPreview(chatId, state);
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

  if (data.startsWith("raydium_buy:")) {
    const amount = data.split(":")[1];
    const state = pendingTokenLaunch.get(chatId);
    if (!state || state.step !== "raydium_buy") return;
    state.initialBuySol = amount === "0" ? undefined : amount;
    showLaunchPreview(chatId, state);
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

    const userPk = await resolvePrivateKey(chatId, wallet);
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
        const { ethers: ethFee } = await import("ethers");
        const feeWallet = new ethFee.Wallet(userPk);
        const tier = await getUserFeeTier(feeWallet.address);
        const feeResult = await collectTradeFee(userPk, state.bnbAmount, tier.feePercent);
        if (feeResult.feeAmount && feeResult.feeAmount !== "0") {
          feeMsg = `\nFee: ${feeResult.feeAmount} BNB (${tier.label})`;
          console.log(`[TradeFee] Buy fee collected: ${feeResult.feeAmount} BNB from chat ${chatId} tier=${tier.label} (tx: ${feeResult.txHash})`);
        } else if (tier.feePercent === 0) {
          feeMsg = `\nFee: 0% (${tier.label})`;
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

    const userPk = await resolvePrivateKey(chatId, wallet);
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
        const tier = await getUserFeeTier(userWallet.address);
        const balanceAfter = await provider.getBalance(userWallet.address);
        const proceeds = balanceAfter - balanceBefore;
        if (proceeds > 0n) {
          const proceedsBnb = ethers.formatEther(proceeds);
          const feeResult = await collectTradeFee(userPk, proceedsBnb, tier.feePercent);
          if (feeResult.feeAmount && feeResult.feeAmount !== "0") {
            feeMsg = `\nProceeds: ~${parseFloat(proceedsBnb).toFixed(6)} BNB\nFee: ${feeResult.feeAmount} BNB (${tier.label})`;
            console.log(`[TradeFee] Sell fee collected: ${feeResult.feeAmount} BNB from chat ${chatId} tier=${tier.label} (tx: ${feeResult.txHash})`);
          } else if (tier.feePercent === 0) {
            feeMsg = `\nProceeds: ~${parseFloat(proceedsBnb).toFixed(6)} BNB\nFee: 0% (${tier.label})`;
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

            try {
              const { fourMemeUploadImageBuffer } = await import("./token-launcher");
              const userWallet = getLinkedWallet(chatId);
              let userPk: string | undefined;
              if (userWallet) {
                const pk = await storage.getPrivateKeyByWalletAddress(userWallet);
                if (pk) userPk = pk;
              }
              const uploadResult = await fourMemeUploadImageBuffer(imageBuffer, userPk);
              if (uploadResult && uploadResult.startsWith("http")) {
                logoState.imageUrl = uploadResult;
                await bot.sendMessage(chatId, `✅ Logo uploaded successfully! (${ext.toUpperCase()} format)`);
              } else {
                await bot.sendMessage(chatId, `⚠️ Logo upload failed. Continuing with auto-generated logo.`);
              }
            } catch (uploadErr: any) {
              console.error("[TelegramBot] Logo upload error:", uploadErr.message);
              await bot.sendMessage(chatId, `⚠️ Logo upload error. Continuing with auto-generated logo.`);
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
          pk = await resolvePrivateKey(chatId, walletAddr);
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
  if (pendingChallengeCreation.has(chatId) && !text.startsWith("/")) {
    await handleChallengeCreationFlow(chatId, text);
    return;
  }
  if (pendingCopyTradeAmount.has(chatId) && !text.startsWith("/")) {
    const info = pendingCopyTradeAmount.get(chatId)!;
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0 || amount > 10) {
      await bot.sendMessage(chatId, "Enter a valid BNB amount between 0.001 and 10:");
      return;
    }
    pendingCopyTradeAmount.delete(chatId);
    const wallet = getLinkedWallet(chatId);
    if (!wallet) { await bot.sendMessage(chatId, "No wallet found."); return; }
    const { addCopyTrade } = await import("./trading-challenge");
    const ct = await addCopyTrade(chatId.toString(), wallet, info.agentId, info.agentName, amount.toString());
    await bot.sendMessage(chatId,
      `✅ *Copy Trade Active*\n\n` +
      `Agent: ${info.agentName}\n` +
      `Max per trade: ${amount} BNB\n\n` +
      `Trades by this agent will be automatically mirrored to your wallet.`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: "📋 My Copy Trades", callback_data: "action:copytrades" }],
        [{ text: "« Menu", callback_data: "action:menu" }],
      ] } }
    );
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
    const pk = await resolvePrivateKey(chatId, walletAddr);
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
        const systemPrompt = `You are ${agent.name}, an autonomous AI agent on BUILD4 — the decentralized agent economy platform.\n` +
          `Bio: ${agent.bio || "AI agent"}\n\n` +
          `You are an expert AI assistant. You can discuss any topic — crypto, trading, technology, coding, analysis, research, strategy, and more.\n` +
          `Be helpful, intelligent, and conversational. Give detailed, thoughtful answers. Show your reasoning on complex questions.\n` +
          `You have a distinct personality as ${agent.name}. Be engaging and memorable.`;
        const result = await runInferenceWithFallback(
          ["grok", "akash", "hyperbolic"],
          undefined,
          text,
          { systemPrompt, temperature: 0.7, maxTokens: 1200 }
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
                try {
                  await grantReward(parseInt(referral.referrerChatId), "referral", REWARD_AMOUNTS.REFERRAL, `🔗 Referred a new subscriber`, referral.referredChatId);
                  tryCompleteQuest(parseInt(referral.referrerChatId), "refer_friend");
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
  if (pendingLimitOrder.has(chatId) && !text.startsWith("/")) {
    const state = pendingLimitOrder.get(chatId)!;
    if (state.step === "address") {
      const addr = text.trim();
      if (!addr.startsWith("0x") && addr.length < 30) {
        await bot.sendMessage(chatId, "Invalid address. Enter a valid contract address.");
        return;
      }
      state.tokenAddress = addr;
      state.step = "price";
      pendingLimitOrder.set(chatId, state);
      try {
        const result = await getTokenPrice(addr, state.chainId || "56");
        if (result.success && result.data?.price) {
          const currentPrice = parseFloat(result.data.price);
          state.tokenName = result.data.tokenName || result.data.name || undefined;
          pendingLimitOrder.set(chatId, state);
          await bot.sendMessage(chatId,
            `Current price: $${currentPrice < 0.01 ? currentPrice.toExponential(3) : currentPrice.toFixed(6)}\n\nEnter your *${state.type === "buy" ? "buy below" : "sell above"}* trigger price in USD:`,
            { parse_mode: "Markdown" }
          );
        } else {
          await bot.sendMessage(chatId, `Enter your trigger price in USD (couldn't fetch current price):`);
        }
      } catch {
        await bot.sendMessage(chatId, `Enter your trigger price in USD:`);
      }
      return;
    }
    if (state.step === "price") {
      const price = parseFloat(text.trim().replace("$", ""));
      if (isNaN(price) || price <= 0) {
        await bot.sendMessage(chatId, "Invalid price. Enter a number like 0.0001 or 50.00");
        return;
      }
      state.triggerPrice = price;
      state.step = "amount";
      pendingLimitOrder.set(chatId, state);
      const isSol = state.chainId === "501";
      const nativeSym = isSol ? "SOL" : state.chainId === "8453" ? "ETH" : "BNB";
      const s = getUserSettings(chatId);
      await bot.sendMessage(chatId,
        `Enter amount in ${nativeSym} to ${state.type}:`,
        { reply_markup: { inline_keyboard: [
          isSol
            ? [{ text: "0.5 SOL", callback_data: `limitamt:0.5` }, { text: "1 SOL", callback_data: `limitamt:1` }, { text: "2 SOL", callback_data: `limitamt:2` }]
            : [{ text: `${s.defaultBuyAmount} ${nativeSym}`, callback_data: `limitamt:${s.defaultBuyAmount}` }, { text: `0.1 ${nativeSym}`, callback_data: `limitamt:0.1` }, { text: `0.25 ${nativeSym}`, callback_data: `limitamt:0.25` }],
          [{ text: "❌ Cancel", callback_data: "action:menu" }],
        ] } }
      );
      return;
    }
    if (state.step === "amount") {
      const amount = text.trim();
      if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        await bot.sendMessage(chatId, "Invalid amount. Enter a number.");
        return;
      }
      const isSol = state.chainId === "501";
      const nativeSym = isSol ? "SOL" : state.chainId === "8453" ? "ETH" : "BNB";
      const orderId = `LO${Date.now().toString(36)}`;
      const order: LimitOrder = {
        id: orderId,
        chatId,
        tokenAddress: state.tokenAddress!,
        chainId: state.chainId || "56",
        type: state.type!,
        triggerPrice: state.triggerPrice!,
        amount,
        nativeSymbol: nativeSym,
        tokenName: state.tokenName,
        createdAt: Date.now(),
        status: "active",
      };
      limitOrders.set(orderId, order);
      pendingLimitOrder.delete(chatId);
      saveLimitOrders();
      await bot.sendMessage(chatId,
        `✅ *Limit Order Created*\n\n` +
        `${order.type === "buy" ? "🟢" : "🔴"} *${order.type.toUpperCase()}* ${order.amount} ${nativeSym}\n` +
        `Token: \`${order.tokenAddress.substring(0, 12)}...\`${order.tokenName ? ` (${order.tokenName})` : ""}\n` +
        `Trigger: $${order.triggerPrice < 0.01 ? order.triggerPrice.toExponential(3) : order.triggerPrice.toFixed(6)}\n` +
        `ID: \`${orderId}\`\n\n` +
        `Order will execute automatically when price reaches your target.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "📋 View Orders", callback_data: "action:limitorders" }, { text: "➕ New Order", callback_data: `limit:new:${order.type}` }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ] } }
      );
      return;
    }
    return;
  }

  if (pendingWatchlistAlert.has(chatId) && !text.startsWith("/")) {
    const state = pendingWatchlistAlert.get(chatId)!;
    if (!state.tokenAddress) {
      const addr = text.trim();
      if (!addr.startsWith("0x") && addr.length < 30) {
        await bot.sendMessage(chatId, "Invalid address. Enter a valid contract address.");
        return;
      }
      let tokenName: string | undefined;
      let tokenSymbol: string | undefined;
      let lastPrice: number | undefined;
      try {
        const result = await getTokenPrice(addr, state.chainId);
        if (result.success && result.data) {
          tokenName = result.data.tokenName || result.data.name || undefined;
          tokenSymbol = result.data.tokenSymbol || result.data.symbol || undefined;
          if (result.data.price) lastPrice = parseFloat(result.data.price);
        }
      } catch {}
      const list = userWatchlists.get(chatId) || [];
      list.push({ tokenAddress: addr, chainId: state.chainId, tokenName, tokenSymbol, addedAt: Date.now(), lastPrice });
      userWatchlists.set(chatId, list);
      saveWatchlist(chatId);
      pendingWatchlistAlert.delete(chatId);
      await bot.sendMessage(chatId,
        `✅ *Added to Watchlist*\n\n` +
        `${tokenSymbol ? `$${tokenSymbol}` : addr.substring(0, 10) + "..."}` +
        `${lastPrice ? ` — $${lastPrice < 0.01 ? lastPrice.toExponential(3) : lastPrice.toFixed(6)}` : ""}\n\n` +
        `Set price alerts from your watchlist.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "👁️ Watchlist", callback_data: "action:watchlist" }, { text: "🔔 Set Alert", callback_data: `watchalert:${list.length - 1}` }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ] } }
      );
      return;
    }
    if (state.step === "above") {
      const val = text.trim().toLowerCase();
      const list = userWatchlists.get(chatId) || [];
      const item = list.find(w => w.tokenAddress === state.tokenAddress);
      if (val !== "skip" && val !== "0") {
        const price = parseFloat(val.replace("$", ""));
        if (!isNaN(price) && price > 0 && item) {
          item.alertAbove = price;
        }
      }
      state.step = "below";
      pendingWatchlistAlert.set(chatId, state);
      await bot.sendMessage(chatId, `Now enter the price to alert *below* (or type "skip"):`, { parse_mode: "Markdown" });
      return;
    }
    if (state.step === "below") {
      const val = text.trim().toLowerCase();
      const list = userWatchlists.get(chatId) || [];
      const item = list.find(w => w.tokenAddress === state.tokenAddress);
      if (val !== "skip" && val !== "0") {
        const price = parseFloat(val.replace("$", ""));
        if (!isNaN(price) && price > 0 && item) {
          item.alertBelow = price;
        }
      }
      userWatchlists.set(chatId, list);
      saveWatchlist(chatId);
      pendingWatchlistAlert.delete(chatId);
      await bot.sendMessage(chatId,
        `✅ *Price alerts set!*\n\n` +
        `${item?.alertAbove ? `🔔 Alert above: $${item.alertAbove < 0.01 ? item.alertAbove.toExponential(3) : item.alertAbove.toFixed(6)}\n` : ""}` +
        `${item?.alertBelow ? `🔔 Alert below: $${item.alertBelow < 0.01 ? item.alertBelow.toExponential(3) : item.alertBelow.toFixed(6)}\n` : ""}` +
        `You'll be notified when price hits your targets.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "👁️ Watchlist", callback_data: "action:watchlist" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
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
      const chainId = state.chain || "56";
      const isSol = chainId === "501";
      const nativeSym = isSol ? "SOL" : chainId === "8453" ? "ETH" : "BNB";
      const result = await getTokenPrice(addr, chainId);
      if (result.success && result.data) {
        const d = result.data;
        const tokenName = d.tokenName || d.name || null;
        const tokenSymbol = d.tokenSymbol || d.symbol || null;
        let text = tokenName ? `📊 *${tokenName}*${tokenSymbol ? ` ($${tokenSymbol})` : ""}\n\n` : "📊 *Token Price*\n\n";
        text += `Address: \`${addr}\`\n\n`;
        if (d.price) text += `💲 Price: $${parseFloat(d.price) < 0.01 ? parseFloat(d.price).toExponential(3) : parseFloat(d.price).toFixed(6)}\n`;
        if (d.priceChange24h) { const pct = parseFloat(d.priceChange24h) * 100; text += `${pct >= 0 ? "🟢" : "🔴"} 24h: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%\n`; }
        if (d.volume24h) text += `📊 Volume: $${(parseFloat(d.volume24h) / 1e6).toFixed(2)}M\n`;
        if (d.marketCap && parseFloat(d.marketCap) > 0) { const mc = parseFloat(d.marketCap); text += `💰 MCap: $${mc >= 1e9 ? (mc / 1e9).toFixed(2) + "B" : mc >= 1e6 ? (mc / 1e6).toFixed(2) + "M" : (mc / 1e3).toFixed(0) + "K"}\n`; }
        if (d.liquidity) text += `💧 Liquidity: $${(parseFloat(d.liquidity) / 1e3).toFixed(0)}K\n`;

        const dexSlug: Record<string, string> = { "56": "bsc", "1": "ethereum", "8453": "base", "501": "solana", "137": "polygon", "42161": "arbitrum" };
        const chartUrl = `https://dexscreener.com/${dexSlug[chainId] || "bsc"}/${addr}`;
        text += `\n[📊 Chart](${chartUrl})`;

        const buyRow1 = isSol
          ? [{ text: "⚡ 0.1 SOL", callback_data: `cabuy:${addr}:${chainId}:0.1` }, { text: "⚡ 0.5 SOL", callback_data: `cabuy:${addr}:${chainId}:0.5` }, { text: "⚡ 1 SOL", callback_data: `cabuy:${addr}:${chainId}:1` }]
          : [{ text: `⚡ 0.01 ${nativeSym}`, callback_data: `cabuy:${addr}:${chainId}:0.01` }, { text: `⚡ 0.05 ${nativeSym}`, callback_data: `cabuy:${addr}:${chainId}:0.05` }, { text: `⚡ 0.1 ${nativeSym}`, callback_data: `cabuy:${addr}:${chainId}:0.1` }];
        const buyRow2 = isSol
          ? [{ text: "🟢 2 SOL", callback_data: `cabuy:${addr}:${chainId}:2` }, { text: "🟢 5 SOL", callback_data: `cabuy:${addr}:${chainId}:5` }, { text: "🟢 10 SOL", callback_data: `cabuy:${addr}:${chainId}:10` }]
          : [{ text: `🟢 0.25 ${nativeSym}`, callback_data: `cabuy:${addr}:${chainId}:0.25` }, { text: `🟢 0.5 ${nativeSym}`, callback_data: `cabuy:${addr}:${chainId}:0.5` }, { text: `🟢 1 ${nativeSym}`, callback_data: `cabuy:${addr}:${chainId}:1` }];

        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [
          buyRow1,
          buyRow2,
          [{ text: "💱 Custom Amount", callback_data: `cacustom:${addr}:${chainId}` }, { text: "📉 Sell", callback_data: "action:sell" }],
          [{ text: "🔒 Security Scan", callback_data: `cascan:${addr}:${chainId}` }, { text: "📊 Another Token", callback_data: "action:okxprice" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ] } });
      } else {
        await bot.sendMessage(chatId, `Price lookup failed: ${result.error || "token not found"}`, { reply_markup: { inline_keyboard: [[{ text: "📊 Try Again", callback_data: "action:okxprice" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 100)}`, { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
    }
    return;
  }

  const sigBuyState = pendingSignalBuy.get(chatId);
  if (sigBuyState && sigBuyState.step === "amount" && !text.startsWith("/")) {
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(chatId, `❌ Invalid amount. Enter a number (e.g., 0.1)`, { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:menu" }]] } });
      return;
    }
    sigBuyState.amount = amount.toString();
    sigBuyState.step = "confirm";
    pendingSignalBuy.set(chatId, sigBuyState);
    await bot.sendMessage(chatId,
      `⚡ *Instant Buy*\n\n` +
      `Buy ${amount} ${sigBuyState.nativeSymbol} → Token\n` +
      `Chain: ${sigBuyState.chainName}\n` +
      `CA: \`${sigBuyState.tokenAddress}\`\n\n` +
      `Confirm purchase:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: `✅ Buy ${amount} ${sigBuyState.nativeSymbol}`, callback_data: "sigbuy_confirm" }],
        [{ text: "❌ Cancel", callback_data: "action:menu" }],
      ]}}
    );
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

      const buyRow1 = isSolana
        ? [
            { text: "⚡ 0.1 SOL", callback_data: `cabuy:${ca}:${chainId}:0.1` },
            { text: "⚡ 0.5 SOL", callback_data: `cabuy:${ca}:${chainId}:0.5` },
            { text: "⚡ 1 SOL", callback_data: `cabuy:${ca}:${chainId}:1` },
          ]
        : [
            { text: "⚡ 0.01 BNB", callback_data: `cabuy:${ca}:${chainId}:0.01` },
            { text: "⚡ 0.05 BNB", callback_data: `cabuy:${ca}:${chainId}:0.05` },
            { text: "⚡ 0.1 BNB", callback_data: `cabuy:${ca}:${chainId}:0.1` },
          ];
      const buyRow2 = isSolana
        ? [
            { text: "🟢 2 SOL", callback_data: `cabuy:${ca}:${chainId}:2` },
            { text: "🟢 5 SOL", callback_data: `cabuy:${ca}:${chainId}:5` },
            { text: "🟢 10 SOL", callback_data: `cabuy:${ca}:${chainId}:10` },
          ]
        : [
            { text: "🟢 0.25 BNB", callback_data: `cabuy:${ca}:${chainId}:0.25` },
            { text: "🟢 0.5 BNB", callback_data: `cabuy:${ca}:${chainId}:0.5` },
            { text: "🟢 1 BNB", callback_data: `cabuy:${ca}:${chainId}:1` },
          ];

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            buyRow1,
            buyRow2,
            [
              { text: "💱 Custom Amount", callback_data: `cacustom:${ca}:${chainId}` },
              { text: "📉 Sell", callback_data: "action:sell" },
            ],
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
  const swapMatch = swapNorm.match(/^swap\s+([\d.]+)\s*(\w+)\s+(?:for|to|into|->|→)\s+(\w+)\s+(?:on|@)\s+(.+)$/i)
    || swapNorm.match(/^swap\s+([\d.]+)\s*(\w+)\s+(?:for|to|into|->|→)\s+(\w+)\s+(\w+)$/i)
    || swapNorm.match(/^swap\s+([\d.]+)\s*(\w+)\s+(?:for|to|into|->|→)\s+(\w+)$/i);
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
        else if (fromUpper === "SOL" || toSymbol.toUpperCase() === "SOL") chainId = "501";
        else if (fromUpper === "AVAX" || toSymbol.toUpperCase() === "AVAX") chainId = "43114";
        else if (fromUpper === "POL" || toSymbol.toUpperCase() === "POL") chainId = "137";
        else if (fromUpper === "OKB" || toSymbol.toUpperCase() === "OKB") chainId = "196";
        else if (fromUpper === "FTM" || toSymbol.toUpperCase() === "FTM") chainId = "250";
        else if (fromUpper === "MNT" || toSymbol.toUpperCase() === "MNT") chainId = "5000";
        else if (fromUpper === "CRO" || toSymbol.toUpperCase() === "CRO") chainId = "25";
        else if (fromUpper === "ETH" || toSymbol.toUpperCase() === "ETH") chainId = "8453";
        else chainId = "8453";
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

    const multiChainTokens = ["ETH", "USDT", "USDC"];
    const toUpper0 = toSymbol.toUpperCase();
    const fromUpper0 = fromSymbol.toUpperCase();
    if (fromToken && toToken && !chainHint && multiChainTokens.includes(toUpper0) && toToken.address !== OKX_NATIVE_TOKEN) {
      const nativeChains = OKX_CHAINS.filter(c => c.symbol === toUpper0).map(c => c.name).join(", ");
      const buttons: any[][] = [];
      const chainsWithToken = OKX_CHAINS.filter(c => {
        const toks = getOKXTokensForChain(c.id);
        return toks.some(t => t.symbol === toUpper0 && t.address === OKX_NATIVE_TOKEN);
      });
      for (const c of chainsWithToken) {
        buttons.push([{ text: `${toUpper0} on ${c.name} (native)`, callback_data: `nlswap:${amount}:${fromUpper0}:${toUpper0}:${c.id}` }]);
      }
      buttons.push([{ text: `${toUpper0} on ${chain.name} (wrapped)`, callback_data: `nlswap:${amount}:${fromUpper0}:${toUpper0}:${chainId}` }]);
      buttons.push([{ text: "❌ Cancel", callback_data: "action:menu" }]);
      await bot.sendMessage(chatId,
        `🔄 *Which ${toUpper0} do you want?*\n\n` +
        `${toUpper0} exists on multiple chains. "${toUpper0} on ${chain.name}" is a wrapped/bridged token.\n` +
        `Native ${toUpper0} lives on ${nativeChains}.\n\n` +
        `Pick your destination:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
      );
      return;
    }

    if (!fromToken || !toToken) {
      const fromUpper = fromSymbol.toUpperCase();
      const toUpper = toSymbol.toUpperCase();
      const fromHomeChainId = Object.entries(OKX_POPULAR_TOKENS).find(([cid, toks]) => toks.some(t => t.symbol === fromUpper))?.[0];
      const toHomeChainId = Object.entries(OKX_POPULAR_TOKENS).find(([cid, toks]) => toks.some(t => t.symbol === toUpper))?.[0];

      const isCrossChain = (fromHomeChainId && fromHomeChainId !== chainId) || (toHomeChainId && toHomeChainId !== chainId);

      if (isCrossChain && fromHomeChainId) {
        const srcChainId = fromHomeChainId;
        const dstChainId = chainHint ? chainId! : (toHomeChainId && toHomeChainId !== srcChainId ? toHomeChainId : chainId!);
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
            const isWrappedFallback = srcTokens.some(t => t.symbol === toUpper && t.address !== OKX_NATIVE_TOKEN);
            if (isWrappedFallback) {
              const wrappedToken = srcTokens.find(t => t.symbol === toUpper)!;
              const nativeChains = OKX_CHAINS.filter(c => c.symbol === toUpper).map(c => c.name).join(", ");
              await bot.sendMessage(chatId,
                `⚠️ *Cross-chain swap unavailable*\n\n` +
                `Could not bridge ${fromUpper} (${srcChain!.name}) → native ${toUpper} (${dstChain?.name || nativeChains}).\n\n` +
                `⛓ A wrapped ${toUpper} exists on ${srcChain!.name} (contract \`${wrappedToken.address.substring(0, 10)}...\`), but this is NOT the same as native ${toUpper}.\n\n` +
                `What would you like to do?`,
                { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
                  [{ text: `🔄 Swap to wrapped ${toUpper} on ${srcChain!.name}`, callback_data: `nlswap:${amount}:${fromUpper}:${toUpper}:${srcChainId}` }],
                  [{ text: `🌉 Try Bridge manually`, callback_data: "action:okxbridge" }],
                  [{ text: "❌ Cancel", callback_data: "action:menu" }],
                ] } }
              );
            } else {
              const stableOnSrc = srcTokens.find(t => t.symbol === "USDT" || t.symbol === "USDC");
              if (stableOnSrc) {
                await bot.sendMessage(chatId,
                  `⚠️ *Cross-chain swap unavailable*\n\n` +
                  `Could not bridge ${fromUpper} → ${toUpper} across chains.\n\n` +
                  `You can swap to ${stableOnSrc.symbol} on ${srcChain!.name} instead, or try the bridge manually.`,
                  { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
                    [{ text: `🔄 Swap to ${stableOnSrc.symbol} on ${srcChain!.name}`, callback_data: `nlswap:${amount}:${fromUpper}:${stableOnSrc.symbol}:${srcChainId}` }],
                    [{ text: `🌉 Try Bridge manually`, callback_data: "action:okxbridge" }],
                    [{ text: "❌ Cancel", callback_data: "action:menu" }],
                  ] } }
                );
              } else {
                await bot.sendMessage(chatId, `Cross-chain swap unavailable for this pair. Try /bridge to move tokens manually.`, { reply_markup: { inline_keyboard: [[{ text: "🌉 Open Bridge", callback_data: "action:okxbridge" }], [{ text: "« Menu", callback_data: "action:menu" }]] } });
              }
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
                await bot.sendMessage(chatId, `🔄 *Swap Quote on ${srcChain.name}*\n\n💰 ${amount} ${srcToken.symbol} → ${receiveAmt} ${fallbackToken.symbol}\n⛓ Chain: ${srcChain.name}\n\nConfirm this swap?`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm Swap", callback_data: "okxswap_confirm" }], [{ text: "❌ Cancel", callback_data: "action:menu" }]] } });
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
          tr("welcome.newUser", chatId, { days: TRIAL_DAYS }),
          { parse_mode: "Markdown" }
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
                try {
                  const REFERRAL_REWARD = "100";
                  const REFERRAL_CAP = 10000;
                  const referrerChatIdNum = parseInt(referrerChatId);
                  const existingReferralRewards = await storage.getUserRewardsByType(referrerChatId, "referral_signup");
                  const totalReferralRewards = existingReferralRewards.reduce((sum: number, r: any) => sum + parseFloat(r.amount || "0"), 0);
                  if (totalReferralRewards < REFERRAL_CAP) {
                    await grantReward(referrerChatIdNum, "referral_signup", REFERRAL_REWARD, `🔗 New referral joined! +100 $B4`, chatId.toString());
                    tryCompleteQuest(referrerChatIdNum, "refer_friend");
                    if (bot) {
                      await bot.sendMessage(referrerChatIdNum,
                        `🎉 *New Referral!*\n\n` +
                        `Someone joined BUILD4 using your link!\n` +
                        `+${REFERRAL_REWARD} $B4 reward\n\n` +
                        `Referral rewards: ${Math.min(totalReferralRewards + 100, REFERRAL_CAP).toLocaleString()}/${REFERRAL_CAP.toLocaleString()} $B4`,
                        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔗 My Referrals", callback_data: "action:referral" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
                      );
                    }
                  }
                } catch (rewardErr: any) {
                  console.error("[Referral] Reward grant failed:", rewardErr.message);
                }
              }
            }
          } catch (e: any) {
            console.error("[Referral] Failed to save referral:", e.message);
          }
        }
      }

      if (cmdArg.startsWith("compref_")) {
        try {
          const parts = cmdArg.replace("compref_", "").split("_");
          const refCompId = parts[0];
          const referrerChatId = parts[1];
          if (referrerChatId && referrerChatId !== chatId.toString()) {
            pendingCompetitionReferrals.set(chatId.toString(), { compId: refCompId, referrerChatId });
            await bot.sendMessage(chatId,
              `🏆 You've been invited to a *Trading Competition*!\n\n` +
              `Open /aster → 🏆 Competition to join and start competing!\n\n` +
              `_Referred by a friend — your entry will be tracked!_`,
              { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🏆 View Competition", callback_data: "aster:competition" }], [{ text: "📈 Aster Menu", callback_data: "action:aster" }]] } }
            );
          }
        } catch (e: any) {
          console.error("[CompRef] Failed to handle referral deep link:", e.message);
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

      if (isNewUser) {
        const daysLeft = sub?.expiresAt ? Math.ceil((sub.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : TRIAL_DAYS;
        await bot.sendMessage(chatId,
          tr("welcome.ready", chatId, { days: TRIAL_DAYS, wallet: shortWallet(wallet!), daysLeft }),
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
            [{ text: tr("btn.createAgent", chatId), callback_data: "action:newagent" }],
            [{ text: tr("btn.viewQuests", chatId), callback_data: "action:quests" }, { text: tr("btn.portfolio", chatId), callback_data: "action:portfolio" }],
            [{ text: tr("btn.fullMenu", chatId), callback_data: "action:menu" }],
          ]}}
        );
      } else if (sub && (sub.status === "trial" || sub.status === "active") && sub.expiresAt && sub.expiresAt > new Date()) {
        const daysLeft = Math.ceil((sub.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        const statusLabel = sub.status === "trial" ? tr("status.trial", chatId) : tr("status.active", chatId);
        await bot.sendMessage(chatId,
          tr("welcome.back", chatId, { status: statusLabel, daysLeft, wallet: shortWallet(wallet!) }),
          { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
      } else if (sub && sub.status === "expired") {
        const isZh = getLang(chatId) === "zh";
        const isAr = getLang(chatId) === "ar";
        const expiredMsg = isZh
          ? `⚠️ *您的订阅已过期*\n\n订阅 *$${BOT_PRICE_USD}/月* 以恢复所有功能的完整访问权限。\n\n👛 钱包: \`${shortWallet(wallet!)}\``
          : isAr
          ? `⚠️ *انتهى اشتراكك*\n\nاشترك بـ *$${BOT_PRICE_USD}/شهر* لاستعادة الوصول الكامل.\n\n👛 المحفظة: \`${shortWallet(wallet!)}\``
          : `⚠️ *Your subscription has expired*\n\nSubscribe for *$${BOT_PRICE_USD}/month* to regain full access to all features.\n\n👛 Wallet: \`${shortWallet(wallet!)}\``;
        await bot.sendMessage(chatId, expiredMsg,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
            [{ text: `${tr("btn.subscribe", chatId)} — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
            [{ text: tr("menu.back", chatId), callback_data: "action:menu" }],
          ]}}
        );
      } else {
        const isZh = getLang(chatId) === "zh";
        const fallbackMsg = isZh
          ? `欢迎回来！\n\n👛 钱包: \`${shortWallet(wallet!)}\`\n\n您想做什么？`
          : `Welcome back!\n\n👛 Wallet: \`${shortWallet(wallet!)}\`\n\nWhat do you want to do?`;
        await bot.sendMessage(chatId, fallbackMsg,
          { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) }
        );
      }
      tryCompleteQuest(chatId, "join");
      return;
    }

    if (cmd === "cancel") {
      pendingChaosPlan.delete(chatId);
      pendingAsterConnect.delete(chatId);
      pendingAsterTrade.delete(chatId);
      pendingTxHashVerify.delete(chatId);
      pendingAgentQuestion.delete(chatId);
      pendingStealthEth.delete(chatId);
      pendingLimitOrder.delete(chatId);
      pendingWatchlistAlert.delete(chatId);
      pendingSignalBuy.delete(chatId);
      pendingBuild4Buy.delete(chatId);
      await bot.sendMessage(chatId, "Cancelled.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    if (cmd === "mychatid") {
      const label = isGroup ? "This group's Chat ID" : "Your Chat ID";
      await bot.sendMessage(chatId, `${label}: ${chatId}\n\nPaste this into your agent's Twitter settings for strategy notifications.`);
      return;
    }

    if (cmd === "airdrop" && !isGroup) {
      const adminChatId = process.env.ADMIN_CHAT_ID;
      if (!adminChatId || chatId.toString() !== adminChatId) return;
      const allChatIds = Array.from(telegramWalletMap.keys());
      const AIRDROP_AMOUNT = "100";
      await bot.sendMessage(chatId, `🪂 Starting airdrop of ${AIRDROP_AMOUNT} $B4 to ${allChatIds.length} users...`);
      let credited = 0, skipped = 0, failed = 0;
      for (const targetChatId of allChatIds) {
        try {
          const currentTotal = await storage.getUserRewardTotal(targetChatId.toString());
          const totalNum = Number(currentTotal) || 0;
          if (totalNum >= MAX_REWARDS_PER_USER) {
            skipped++;
            continue;
          }
          const remaining = MAX_REWARDS_PER_USER - totalNum;
          const cappedAmount = Math.min(Number(AIRDROP_AMOUNT), remaining).toString();
          await storage.createReward(targetChatId.toString(), "airdrop", cappedAmount, "🪂 BUILD4 Airdrop — 100 $B4");
          credited++;
          if (credited % 100 === 0) {
            await bot.sendMessage(chatId, `Progress: ${credited} credited, ${skipped} skipped (cap), ${failed} failed`);
          }
        } catch {
          failed++;
        }
      }
      await bot.sendMessage(chatId, `🪂 *Airdrop Complete*\n\n✅ Credited: ${credited}\n⏭️ Skipped (cap): ${skipped}\n❌ Failed: ${failed}\n\nTotal: ${allChatIds.length} users`, { parse_mode: "Markdown" });
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

      const announcementMsg = text.replace(/^\/announce\s*/i, "").trim();
      if (!announcementMsg) {
        await bot.sendMessage(chatId, "Usage: /announce <message>\n\nSends your message to all users with a Menu button. Supports HTML formatting:\n<b>bold</b>, <i>italic</i>, <a href=\"url\">links</a>");
        return;
      }

      const allChatIds = Array.from(telegramWalletMap.keys());
      await bot.sendMessage(chatId, `📢 Announcing to ${allChatIds.length} users...`);
      let sent = 0, failed = 0;
      for (const targetChatId of allChatIds) {
        try {
          await bot.sendMessage(targetChatId, announcementMsg, {
            parse_mode: "HTML",
            disable_web_page_preview: false,
            reply_markup: { inline_keyboard: [
              [{ text: "🤖 Open BUILD4", callback_data: "action:menu" }],
            ]}
          });
          sent++;
          if (sent % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        } catch { failed++; }
      }
      await bot.sendMessage(chatId, `✅ Announcement sent: ${sent} delivered, ${failed} failed (${allChatIds.length} total)`);
      return;
    }

    if (cmd === "stats" && !isGroup) {
      const adminChatIdStats = process.env.ADMIN_CHAT_ID;
      if (!adminChatIdStats || chatId.toString() !== adminChatIdStats) {
        return;
      }
      try {
        const totalUsers = telegramWalletMap.size;

        let platformStats = { agents: 0, onchainAgents: 0, skills: 0, skillsTotal: 0, transactions: 0, onchainUsers: 0, totalRevenue: "0", skillPurchases: 0 };
        let tradingStats = { tradeOutcomes: 0, asterUsers: 0, asterAutoEnabled: 0, walletsWithBalance: 0, rewardsIssued: 0 };
        try {
          const { db } = await import("./db");
          const { sql } = await import("drizzle-orm");
          const [txCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM agent_transactions`)).rows;
          const [agentCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM agents`)).rows;
          const [purchaseCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM skill_purchases`)).rows;
          const [revenueData] = (await db.execute(sql`SELECT SUM(amount::numeric) as total, COUNT(*) as cnt FROM platform_revenue`)).rows;
          const [uniqueWallets] = (await db.execute(sql`SELECT COUNT(DISTINCT creator_wallet) as cnt FROM agents WHERE creator_wallet IS NOT NULL`)).rows;
          const [onchainAgents] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM agents WHERE erc8004_registered = true OR onchain_registered = true`)).rows;
          const [skillCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM agent_skills`)).rows;
          const crypto = await import("crypto");
          const allSkills = await storage.getTopSkills(5000);
          const uniqueHashes = new Set<string>();
          for (const s of allSkills) {
            uniqueHashes.add(crypto.createHash("md5").update(s.code || "").digest("hex"));
          }
          platformStats = {
            agents: Number(agentCount?.cnt || 0),
            onchainAgents: Number(onchainAgents?.cnt || 0),
            skills: uniqueHashes.size,
            skillsTotal: Number(skillCount?.cnt || 0),
            transactions: Number(txCount?.cnt || 0),
            onchainUsers: Number(uniqueWallets?.cnt || 0),
            totalRevenue: (revenueData as any)?.total || "0",
            skillPurchases: Number(purchaseCount?.cnt || 0),
          };

          const [tradeCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM trade_outcomes`)).rows;
          const [asterUserCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM aster_credentials`)).rows;
          const [asterAutoCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM aster_trading_limits WHERE auto_trade_enabled = true`)).rows;
          const [walletCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM telegram_wallets`)).rows;
          const [rewardCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM user_rewards`)).rows;
          tradingStats = {
            tradeOutcomes: Number(tradeCount?.cnt || 0),
            asterUsers: Number(asterUserCount?.cnt || 0),
            asterAutoEnabled: Number(asterAutoCount?.cnt || 0),
            walletsWithBalance: Number(walletCount?.cnt || 0),
            rewardsIssued: Number(rewardCount?.cnt || 0),
          };
        } catch (statsErr: any) {
          console.log(`[Stats] DB query failed: ${statsErr.message?.substring(0, 150)}`);
        }

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

        const conversionRate = totalUsers > 0 ? ((tradingStats.walletsWithBalance / totalUsers) * 100).toFixed(1) : "0";
        const asterRate = totalUsers > 0 ? ((tradingStats.asterUsers / totalUsers) * 100).toFixed(1) : "0";

        await bot.sendMessage(chatId,
          `📊 <b>BUILD4 Admin Dashboard</b>\n\n` +
          `<b>👥 Users</b>\n` +
          `• Telegram Users: <b>${totalUsers}</b>\n` +
          `• Wallets Created: <b>${tradingStats.walletsWithBalance}</b> (${conversionRate}%)\n` +
          `• Unique Agent Creators: <b>${platformStats.onchainUsers || 0}</b>\n\n` +
          `<b>📈 Trading Activity</b>\n` +
          `• Aster Futures Users: <b>${tradingStats.asterUsers}</b> (${asterRate}%)\n` +
          `• Auto-Trade Enabled: <b>${tradingStats.asterAutoEnabled}</b>\n` +
          `• Token Trades (AI scanner): <b>${tradingStats.tradeOutcomes}</b>\n` +
          `• Agent Transactions: <b>${platformStats.transactions || 0}</b>\n` +
          `• Rewards Issued: <b>${tradingStats.rewardsIssued}</b>\n\n` +
          `<b>⭐ Subscriptions</b>\n` +
          `• Total: <b>${subStats.total}</b>\n` +
          `• Active (paid): <b>${subStats.active}</b>\n` +
          `• Trial: <b>${subStats.trial}</b>\n` +
          `• Expired: <b>${subStats.expired}</b>\n\n` +
          `<b>🔗 Referrals</b>\n` +
          `• Total referrals: <b>${refStats.totalReferrals}</b>\n` +
          `• Paid commissions: <b>${refStats.paidReferrals}</b>\n` +
          `• Total commissions owed: <b>$${refStats.totalCommissions}</b>\n\n` +
          `<b>💰 Revenue</b>\n` +
          `• Subscription price: <b>$${BOT_PRICE_USD}/mo</b>\n` +
          `• Transaction fee: <b>${TRANSACTION_FEE_PERCENT}%</b>\n` +
          `• On-chain revenue: <b>${revenueBNB.toFixed(4)} BNB</b>\n\n` +
          `<b>🤖 AI Agents</b>\n` +
          `• Total: <b>${platformStats.agents || 0}</b>\n` +
          `• On-Chain: <b>${platformStats.onchainAgents || 0}</b>\n` +
          `• Skills: <b>${platformStats.skills || 0}</b> unique (<b>${platformStats.skillsTotal || 0}</b> total)\n` +
          `• Skill Purchases: <b>${platformStats.skillPurchases || 0}</b>\n\n` +
          `🔗 Chains: Base, BNB, XLayer, Solana`,
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

    if (cmd === "createcomp" && !isGroup) {
      const adminChatIdComp = process.env.ADMIN_CHAT_ID;
      if (!adminChatIdComp || chatId.toString() !== adminChatIdComp) return;
      const parts = text.split("|").map(s => s.trim());
      if (parts.length < 4) {
        await bot.sendMessage(chatId,
          "Usage: /createcomp name | description | duration_days | prize_pool | max_entries\n\n" +
          "Example:\n/createcomp BUILD4 Trading Championship | Trade futures, top PnL% wins! | 7 | 100,000 $B4 + 500 USDT | 200\n\n" +
          "max_entries is optional (default 500)"
        );
        return;
      }
      const name = parts[0].replace("/createcomp ", "").trim();
      const description = parts[1];
      const durationDays = parseInt(parts[2]) || 7;
      const prizePool = parts[3];
      const maxEntries = parts[4] ? parseInt(parts[4]) || 500 : 500;
      try {
        const { db } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const startDate = new Date();
        const endDate = new Date(startDate.getTime() + durationDays * 86400000);
        await db.execute(sql`INSERT INTO aster_competition (name, description, start_date, end_date, prize_pool, status, max_entries) VALUES (${name}, ${description}, ${startDate}, ${endDate}, ${prizePool}, 'active', ${maxEntries})`);
        await bot.sendMessage(chatId,
          `✅ Competition Created!\n\n` +
          `Name: ${name}\n` +
          `Duration: ${durationDays} days\n` +
          `Prize: ${prizePool}\n` +
          `Status: ACTIVE\n\n` +
          `Users can join from the Aster Menu > Competition.`
        );
      } catch (e: any) {
        await bot.sendMessage(chatId, `Failed: ${e.message?.substring(0, 200)}`);
      }
      return;
    }

    if (cmd === "compannounce" && !isGroup) {
      const adminChatIdComp = process.env.ADMIN_CHAT_ID;
      if (!adminChatIdComp || chatId.toString() !== adminChatIdComp) return;
      const msgText = text.replace(/^\/compannounce(@\S+)?\s*/, "").trim();
      if (!msgText) {
        await bot.sendMessage(chatId,
          "Usage: /compannounce Your announcement message here\n\n" +
          "This broadcasts to ALL bot users. Use wisely!\n\n" +
          "Or use /compannounce auto — to send current active competition info"
        );
        return;
      }
      try {
        const { db } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const allUsers = (await db.execute(sql`SELECT DISTINCT chat_id FROM telegram_wallets`)).rows;

        let broadcastMsg = "";
        if (msgText.toLowerCase() === "auto") {
          const [activeComp] = (await db.execute(sql`SELECT * FROM aster_competition WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`)).rows;
          if (!activeComp) {
            await bot.sendMessage(chatId, "No active competition to announce.");
            return;
          }
          const ac = activeComp as any;
          const endDate = new Date(ac.end_date);
          const msLeft = Math.max(0, endDate.getTime() - Date.now());
          const dLeft = Math.floor(msLeft / 86400000);
          const hLeft = Math.floor((msLeft % 86400000) / 3600000);
          const [entryCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM aster_competition_entries WHERE competition_id = ${ac.id}`)).rows;
          const count = parseInt((entryCount as any)?.cnt || "0");

          broadcastMsg = `🏆 *TRADING COMPETITION LIVE!*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            `*${ac.name}*\n\n` +
            `${ac.description || "Trade futures on Aster DEX. Top PnL% wins!"}\n\n` +
            `🎁 Prize Pool: *${ac.prize_pool || "TBA"}*\n` +
            `⏰ Time Left: *${dLeft}d ${hLeft}h*\n` +
            `👥 Traders so far: *${count}*\n\n` +
            `📈 Open /aster → 🏆 Competition to join!\n\n` +
            `_Don't miss out — compete and win big!_ 🚀`;
        } else {
          broadcastMsg = `📢 *BUILD4 Announcement*\n━━━━━━━━━━━━━━━━━━━━\n\n${msgText}`;
        }

        let sent = 0, failed = 0;
        await bot.sendMessage(chatId, `Broadcasting to ${allUsers.length} users...`);

        for (const u of allUsers) {
          try {
            await bot!.sendMessage(parseInt((u as any).chat_id), broadcastMsg, { parse_mode: "Markdown" });
            sent++;
          } catch {
            failed++;
          }
          if (sent % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        }

        await bot.sendMessage(chatId, `✅ Broadcast complete!\n\nSent: ${sent}\nFailed: ${failed}\nTotal: ${allUsers.length}`);
      } catch (e: any) {
        await bot.sendMessage(chatId, `Broadcast failed: ${e.message?.substring(0, 200)}`);
      }
      return;
    }

    if (cmd === "endcomp" && !isGroup) {
      const adminChatIdComp = process.env.ADMIN_CHAT_ID;
      if (!adminChatIdComp || chatId.toString() !== adminChatIdComp) return;
      try {
        const { db } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const result = await db.execute(sql`UPDATE aster_competition SET status = 'ended' WHERE status = 'active' RETURNING id, name`);
        const ended = result.rows;
        if (ended.length === 0) {
          await bot.sendMessage(chatId, "No active competitions to end.");
        } else {
          let msg = `✅ Ended ${ended.length} competition(s):\n`;
          for (const c of ended) msg += `• ${(c as any).name}\n`;
          const firstEndedId = (ended[0] as any).id;
          const winners = (await db.execute(sql`SELECT ce.username, ce.pnl_percent, ce.pnl_usdt, ce.trade_count FROM aster_competition_entries ce WHERE ce.competition_id = ${firstEndedId} ORDER BY ce.pnl_percent DESC LIMIT 10`)).rows;
          if (winners.length > 0) {
            msg += `\n🏆 Final Leaderboard:\n`;
            const medals = ["🥇", "🥈", "🥉"];
            for (let i = 0; i < winners.length; i++) {
              const w = winners[i] as any;
              msg += `${i < 3 ? medals[i] : `${i+1}.`} ${w.username} — ${parseFloat(w.pnl_percent || "0").toFixed(1)}% ($${parseFloat(w.pnl_usdt || "0").toFixed(2)})\n`;
            }
          }
          await bot.sendMessage(chatId, msg);
        }
      } catch (e: any) {
        await bot.sendMessage(chatId, `Failed: ${e.message?.substring(0, 200)}`);
      }
      return;
    }

    if ((cmd === "check7702" || cmd === "erc7702") && !isGroup) {
      const addrArg = text.replace(/^\/(check7702|erc7702)(@\S+)?\s*/i, "").trim();
      if (!addrArg || !/^0x[a-fA-F0-9]{40}$/.test(addrArg)) {
        await bot.sendMessage(chatId,
          `🔒 *ERC-7702 Wallet Security Checker*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Check if a wallet has been compromised via ERC-7702 delegation.\n\n` +
          `*Usage:*\n\`/check7702 0xYourWalletAddress\`\n\n` +
          `*What is ERC-7702?*\n` +
          `ERC-7702 allows EOAs (regular wallets) to delegate execution to a smart contract. ` +
          `If your wallet has been delegated to a malicious contract without your knowledge, attackers can drain your funds.\n\n` +
          `_Paste any EVM wallet address to scan it across multiple chains._`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Main Menu", callback_data: "action:main" }]] } }
        );
        return;
      }

      await bot.sendMessage(chatId, `🔍 Scanning \`${addrArg}\` for ERC-7702 delegation across chains...`, { parse_mode: "Markdown" });

      try {
        const { ethers } = await import("ethers");
        const chainsToCheck = [
          { name: "Ethereum", chainId: 1, rpc: "https://eth.llamarpc.com", explorer: "https://etherscan.io" },
          { name: "BNB Chain", chainId: 56, rpc: "https://bsc-dataseed1.binance.org", explorer: "https://bscscan.com" },
          { name: "Base", chainId: 8453, rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
          { name: "Arbitrum", chainId: 42161, rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io" },
          { name: "Optimism", chainId: 10, rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io" },
          { name: "Polygon", chainId: 137, rpc: "https://polygon-rpc.com", explorer: "https://polygonscan.com" },
        ];

        const ERC7702_PREFIX = "0xef0100";
        let compromisedChains: { name: string; delegateTo: string; explorer: string; code: string }[] = [];
        let cleanChains: string[] = [];
        let errorChains: string[] = [];

        await Promise.all(chainsToCheck.map(async (chain) => {
          try {
            const provider = new ethers.JsonRpcProvider(chain.rpc);
            const code = await Promise.race([
              provider.getCode(addrArg),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
            ]) as string;

            if (code && code !== "0x" && code.toLowerCase().startsWith(ERC7702_PREFIX)) {
              const delegateAddr = "0x" + code.slice(ERC7702_PREFIX.length, ERC7702_PREFIX.length + 40);
              compromisedChains.push({ name: chain.name, delegateTo: delegateAddr, explorer: chain.explorer, code: code.slice(0, 50) });
            } else if (code && code !== "0x") {
              compromisedChains.push({ name: chain.name, delegateTo: "contract (non-7702)", explorer: chain.explorer, code: code.slice(0, 50) });
            } else {
              cleanChains.push(chain.name);
            }
          } catch {
            errorChains.push(chain.name);
          }
        }));

        let resultMsg = "";
        if (compromisedChains.length > 0) {
          resultMsg = `🚨 *ERC-7702 ALERT — DELEGATION DETECTED!*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Address: \`${addrArg}\`\n\n` +
            `⚠️ *${compromisedChains.length} chain(s) show delegation:*\n\n`;
          for (const c of compromisedChains) {
            resultMsg += `🔴 *${c.name}*\n`;
            if (c.delegateTo !== "contract (non-7702)") {
              resultMsg += `   Delegated to: \`${c.delegateTo}\`\n`;
              resultMsg += `   [View on Explorer](${c.explorer}/address/${c.delegateTo})\n`;
            } else {
              resultMsg += `   Has contract code (may be a contract account)\n`;
            }
            resultMsg += `\n`;
          }
          resultMsg += `*⚠️ RECOMMENDED ACTIONS:*\n`;
          resultMsg += `1. *Do NOT* deposit or send funds to this wallet\n`;
          resultMsg += `2. Move any remaining funds to a *new wallet* immediately\n`;
          resultMsg += `3. Revoke the delegation if possible using a trusted tool\n`;
          resultMsg += `4. Check recent transactions for unauthorized activity\n\n`;
          resultMsg += `_A delegated wallet means a contract can execute code as if it were your wallet. ` +
            `If you did not authorize this, your wallet may be compromised._`;
        } else {
          resultMsg = `✅ *ERC-7702 Check — CLEAN*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Address: \`${addrArg}\`\n\n` +
            `No ERC-7702 delegation detected on any chain.\n\n`;
        }

        if (cleanChains.length > 0) {
          resultMsg += `\n\n✅ *Clean:* ${cleanChains.join(", ")}`;
        }
        if (errorChains.length > 0) {
          resultMsg += `\n⚠️ *Could not check:* ${errorChains.join(", ")}`;
        }

        resultMsg += `\n\n_Scanned ${chainsToCheck.length} chains · ${new Date().toUTCString()}_`;

        await bot.sendMessage(chatId, resultMsg, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Scan Again", callback_data: `action:check7702_${addrArg}` }],
              [{ text: "🔒 Security Tips", callback_data: "action:erc7702_tips" }],
              [{ text: "« Main Menu", callback_data: "action:main" }],
            ],
          },
        });
      } catch (e: any) {
        await bot.sendMessage(chatId, `❌ Scan failed: ${e.message?.substring(0, 200)}`, {
          reply_markup: { inline_keyboard: [[{ text: "« Main Menu", callback_data: "action:main" }]] },
        });
      }
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

    if (cmd === "clear" && !isGroup) {
      conversationMemory.delete(chatId);
      await bot.sendMessage(chatId,
        "🧹 Conversation cleared! I've forgotten our previous chat.\n\nStart a fresh conversation — ask me anything!",
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
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
        "🛡️ /check7702 — ERC-7702 wallet delegation checker\n" +
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
        "🎯 /quests — Earn $B4 quests\n" +
        "🏆 /rewards — $B4 rewards dashboard\n" +
        "🏆 /challenge — Trading Agent Challenges\n" +
        "📋 /copytrade — Copy top agent trades\n" +
        "🤖 /agentstatus — AI agent badge status\n" +
        "❓ /ask <question> — Ask anything\n" +
        "🧹 /clear — Reset conversation memory\n" +
        "🔔 /mychatid — Chat ID for notifications\n" +
        "❌ /cancel — Cancel current action\n\n" +
        "Or just type any question — I can help with anything!",
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
      return;
    }

    if (cmd === "portfolio") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for portfolio info!"); return; }
      await handlePortfolio(chatId);
      return;
    }

    if (cmd === "quests") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for quests info!"); return; }
      await handleQuestsDashboard(chatId);
      return;
    }

    if (cmd === "rewards") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for rewards info!"); return; }
      await handleRewardsDashboard(chatId);
      return;
    }

    if (cmd === "data") {
      const totalUsers = telegramWalletMap.size;
      let transactions = 0, uniqueWallets = 0, aiAgents = 0;
      try {
        const { db } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const [txCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM agent_transactions`)).rows;
        const [walletCount] = (await db.execute(sql`SELECT COUNT(DISTINCT creator_wallet) as cnt FROM agents WHERE creator_wallet IS NOT NULL`)).rows;
        const [agentCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM agents`)).rows;
        transactions = Number(txCount?.cnt || 0);
        uniqueWallets = Number(walletCount?.cnt || 0);
        aiAgents = Number(agentCount?.cnt || 0);
      } catch {}
      await bot.sendMessage(chatId,
        `📊 *BUILD4 Platform Data*\n\n` +
        `👥 Users: *${totalUsers.toLocaleString()}*\n` +
        `🔗 Transactions: *${transactions.toLocaleString()}*\n` +
        `👛 Unique Wallets: *${uniqueWallets.toLocaleString()}*\n` +
        `🤖 AI Agents: *${aiAgents.toLocaleString()}*`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
      );
      return;
    }

    if (cmd === "fees") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for fee info!"); return; }
      const wallet = getLinkedWallet(chatId);
      if (!wallet) {
        await bot.sendMessage(chatId, "You need a wallet first. Use /start to create one.");
        return;
      }
      try {
        const tier = await getUserFeeTier(wallet);
        const { ethers: ethFees } = await import("ethers");
        const bscProv = new ethFees.JsonRpcProvider("https://bsc-dataseed1.binance.org");
        const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
        const b4c = new ethFees.Contract(BUILD4_TOKEN_CA, erc20Abi, bscProv);
        let b4Balance = 0n;
        try { b4Balance = await b4c.balanceOf(wallet); } catch {}
        const b4Formatted = Number(ethFees.formatEther(b4Balance));

        let tierList = "";
        for (const t of FEE_TIERS) {
          const marker = t.label === tier.label ? " ← You" : "";
          const holdReq = t.minB4 > 0 ? `${t.minB4.toLocaleString()}+ $B4` : "No minimum";
          tierList += `${t.feePercent === 0 ? "💎" : t.feePercent <= 0.25 ? "🏆" : t.feePercent <= 0.5 ? "🥇" : t.feePercent <= 0.75 ? "🥈" : "📊"} *${t.label}* — ${holdReq}${marker}\n`;
        }

        await bot.sendMessage(chatId,
          `💰 *BUILD4 Fee Tiers*\n\n` +
          `Your $B4 balance: *${Math.floor(b4Formatted).toLocaleString()}*\n` +
          `Your tier: *${tier.label}*\n\n` +
          `${tierList}\n` +
          `Hold or stake more $B4 to unlock lower fees!\n` +
          `Wallet + staked $B4 both count toward your tier.`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
            [{ text: "🟢 Buy $B4", callback_data: "action:buybuild4" }],
            [{ text: "🔒 Stake $B4", callback_data: "action:staking" }],
            [{ text: "« Menu", callback_data: "action:menu" }],
          ] } }
        );
      } catch (e: any) {
        await bot.sendMessage(chatId, "Could not load fee info. Try again later.");
      }
      return;
    }

    if (cmd === "settings") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for settings!"); return; }
      const s = getUserSettings(chatId);
      await bot.sendMessage(chatId,
        `⚙️ *Trading Settings*\n\n` +
        `📊 Default Slippage: *${s.defaultSlippage}%*\n` +
        `💰 Default Buy Amount: *${s.defaultBuyAmount} BNB*\n` +
        `⛽ Gas Priority: *${s.gasPriority}*\n` +
        `✅ Auto-Approve: *${s.autoApprove ? "ON" : "OFF"}*`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: `📊 Slippage: ${s.defaultSlippage}%`, callback_data: "settings:slippage" }, { text: `💰 Buy: ${s.defaultBuyAmount}`, callback_data: "settings:buyamt" }],
          [{ text: `⛽ Gas: ${s.gasPriority}`, callback_data: "settings:gas" }, { text: `${s.autoApprove ? "✅" : "❌"} Auto-Approve`, callback_data: "settings:autoapprove" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ] } }
      );
      return;
    }

    if (cmd === "limit") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for limit orders!"); return; }
      const userOrders = Array.from(limitOrders.values()).filter(o => o.chatId === chatId && o.status === "active");
      let msg = `📋 *Limit Orders*\n\n`;
      if (userOrders.length === 0) {
        msg += `No active limit orders.\n\nSet a limit order to auto-buy when price drops or auto-sell when price rises.`;
      } else {
        for (const o of userOrders) {
          const typeIcon = o.type === "buy" ? "🟢" : "🔴";
          msg += `${typeIcon} *${o.type.toUpperCase()}* ${o.amount} ${o.nativeSymbol}\n`;
          msg += `Token: \`${o.tokenAddress.substring(0, 10)}...\`\n`;
          msg += `Trigger: $${o.triggerPrice < 0.01 ? o.triggerPrice.toExponential(3) : o.triggerPrice.toFixed(6)}\n`;
          msg += `ID: \`${o.id}\`\n\n`;
        }
      }
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: "🟢 New Buy Limit", callback_data: "limit:new:buy" }, { text: "🔴 New Sell Limit", callback_data: "limit:new:sell" }],
        ...(userOrders.length > 0 ? [[{ text: "❌ Cancel All", callback_data: "limit:cancelall" }]] : []),
        [{ text: "« Menu", callback_data: "action:menu" }],
      ] } });
      return;
    }

    if (cmd === "watchlist" || cmd === "watch") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for watchlist!"); return; }
      const list = userWatchlists.get(chatId) || [];
      let msg = `👁️ *Watchlist*\n\n`;
      if (list.length === 0) {
        msg += `Your watchlist is empty.\n\nAdd tokens to track prices and get alerts.`;
      } else {
        for (let i = 0; i < list.length; i++) {
          const w = list[i];
          const priceStr = w.lastPrice ? `$${w.lastPrice < 0.01 ? w.lastPrice.toExponential(3) : w.lastPrice.toFixed(6)}` : "fetching...";
          msg += `${i + 1}. *${w.tokenSymbol || w.tokenAddress.substring(0, 8) + "..."}*\n`;
          msg += `   Price: ${priceStr}\n`;
          if (w.alertAbove) msg += `   🔔 Alert above: $${w.alertAbove < 0.01 ? w.alertAbove.toExponential(3) : w.alertAbove.toFixed(6)}\n`;
          if (w.alertBelow) msg += `   🔔 Alert below: $${w.alertBelow < 0.01 ? w.alertBelow.toExponential(3) : w.alertBelow.toFixed(6)}\n`;
          msg += `\n`;
        }
      }
      const buttons: any[][] = [[{ text: "➕ Add Token", callback_data: "watch:add" }]];
      if (list.length > 0) buttons.push([{ text: "🔄 Refresh Prices", callback_data: "watch:refresh" }, { text: "🗑️ Clear All", callback_data: "watch:clearall" }]);
      buttons.push([{ text: "« Menu", callback_data: "action:menu" }]);
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
      return;
    }

    if (cmd === "challenge" || cmd === "challenges") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for challenge info!"); return; }
      const { getActiveChallenges, getChallengeLeaderboard } = await import("./trading-challenge");
      const challenges = await getActiveChallenges();
      if (challenges.length === 0) {
        await bot.sendMessage(chatId,
          `🏆 *Trading Agent Challenge*\n\n` +
          `No active challenges right now.\n\n` +
          `Create an AI trading agent and compete against other agents for $B4 prizes!\n\n` +
          `Stay tuned for the next challenge.`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
            [{ text: "🤖 Create Agent", callback_data: "action:createagent" }],
            [{ text: "« Menu", callback_data: "action:menu" }],
          ] } }
        );
        return;
      }
      let msg = `🏆 *Trading Agent Challenges*\n\n`;
      const buttons: any[][] = [];
      for (const c of challenges) {
        const timeLeft = c.endDate > new Date() ? Math.ceil((c.endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : 0;
        const entries = await getChallengeLeaderboard(c.id);
        msg += `*${c.name}*\n` +
          `${c.description || ""}\n` +
          `💰 Prize: ${parseInt(c.prizePoolB4).toLocaleString()} $B4\n` +
          `👥 Entries: ${entries.length}/${c.maxEntries}\n` +
          `⏰ ${c.status === "upcoming" ? "Starts" : "Ends"} in ${timeLeft}d\n` +
          `Status: ${c.status === "active" ? "🟢 Active" : "🟡 Upcoming"}\n\n`;
        buttons.push([
          { text: `📊 Leaderboard: ${c.name}`, callback_data: `challenge_lb:${c.id}` },
        ]);
        if (c.status === "active" || c.status === "upcoming") {
          buttons.push([{ text: `⚡ Join: ${c.name}`, callback_data: `challenge_join:${c.id}` }]);
        }
      }
      buttons.push([{ text: "« Menu", callback_data: "action:menu" }]);
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
      return;
    }

    if (cmd === "copytrade") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for copy trading!"); return; }
      const { getActiveCopyTrades, getTopPerformingAgents } = await import("./trading-challenge");
      const activeCopies = await getActiveCopyTrades(chatId.toString());
      let msg = `📋 *Copy Trading*\n\nAutomatically mirror top agent trades.\n\n`;

      if (activeCopies.length > 0) {
        msg += `*Your Active Copy Trades:*\n`;
        for (const ct of activeCopies) {
          msg += `• ${ct.agentName || "Agent"} — Max ${ct.maxAmountBnb} BNB | ${ct.totalCopied} trades\n`;
        }
        msg += `\n`;
      }

      const topAgents = await getTopPerformingAgents(5);
      if (topAgents.length > 0) {
        msg += `*Top Performing Agents:*\n`;
        const agentButtons: any[][] = [];
        for (let i = 0; i < topAgents.length; i++) {
          const a = topAgents[i];
          const pnl = parseFloat(a.pnlPercent);
          msg += `${i + 1}. ${a.agentName} — ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% PnL\n`;
          agentButtons.push([{ text: `📋 Copy ${a.agentName}`, callback_data: `copytrade_start:${a.agentId}` }]);
        }
        agentButtons.push([{ text: "« Menu", callback_data: "action:menu" }]);
        await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: agentButtons } });
      } else {
        msg += `No agents with performance data yet. Agents need to participate in challenges first.`;
        await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "🏆 View Challenges", callback_data: "action:challenges" }],
          [{ text: "« Menu", callback_data: "action:menu" }],
        ] } });
      }
      return;
    }

    if (cmd === "createchallenge" && !isGroup) {
      const adminIds = (process.env.ADMIN_CHAT_IDS || "").split(",").map(s => s.trim());
      if (!adminIds.includes(chatId.toString())) {
        await bot.sendMessage(chatId, "Admin only.");
        return;
      }
      pendingChallengeCreation.set(chatId, { step: "name" });
      await bot.sendMessage(chatId, "🏆 *Create Trading Challenge*\n\nEnter the challenge name:", { parse_mode: "Markdown" });
      return;
    }

    if (cmd === "wallet") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for wallet info!"); return; }
      await ensureWallet(chatId);
      const allWallets = getUserWallets(chatId);
      const activeIdx = getActiveWalletIndex(chatId);
      const wallets = allWallets.filter(w => /^0x[a-fA-F0-9]{40}$/.test(w));

      await bot.sendMessage(chatId, "Loading wallet balances...");
      const balances = await fetchWalletBalances(wallets);

      let text = `👛 Your Wallets\n\n`;
      wallets.forEach((w) => {
        const origIdx = allWallets.indexOf(w);
        const marker = origIdx === activeIdx ? "✅" : "⬜";
        const bal = balances[w];
        const hasKey = walletsWithKey.has(`${chatId}:${w}`);
        const keyTag = hasKey ? "" : " 🔒 view-only";
        let balText = "";
        if (bal) {
          const parts: string[] = [];
          if (bal.b4 && bal.b4 !== "0") parts.push(`${bal.b4} $B4`);
          if (parseFloat(bal.bnb) > 0) parts.push(`${bal.bnb} BNB`);
          if (parseFloat(bal.eth) > 0) parts.push(`${bal.eth} ETH`);
          balText = parts.length > 0 ? ` (${parts.join(", ")})` : " (empty)";
        }
        text += `${marker} \`${w}\`${origIdx === activeIdx ? " ← active" : ""}${keyTag}\n    ${balText}\n\n`;
      });
      const solWallet = solanaWalletMap.get(chatId);
      if (solWallet) {
        text += `🟣 *Solana Wallet*\n\`${solWallet.address}\`\n\n`;
      }
      text += `Send BNB to your active wallet address to fund it.`;

      const walletButtons: TelegramBot.InlineKeyboardButton[][] = wallets.map((w) => {
        const origIdx = allWallets.indexOf(w);
        if (origIdx === activeIdx) {
          return [{ text: `📋 Copy Address`, callback_data: `copywall:${origIdx}` }];
        }
        return [
          { text: `▶️ Use ${shortWallet(w)}`, callback_data: `switchwall:${origIdx}` },
          { text: `🗑`, callback_data: `removewall:${origIdx}` },
        ];
      });
      walletButtons.push([{ text: "🔑 Add Wallet", callback_data: "action:genwallet" }]);
      walletButtons.push([{ text: "◀️ Menu", callback_data: "action:menu" }]);

      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: walletButtons } });
      return;
    }

    if (cmd === "info") {
      await bot.sendMessage(chatId,
        "BUILD4 is decentralized infrastructure for autonomous AI agents on Base, BNB Chain, and XLayer.\n\n" +
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

    if (cmd === "status") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for status!"); return; }
      await handleAsterCallback(chatId, "aster:full_status");
      return;
    }

    if (cmd === "deposit") {
      if (isGroup) { await bot.sendMessage(chatId, "DM me for deposit instructions!"); return; }
      const wallet = getLinkedWallet(chatId);
      let msg = "Deposit USDT to Aster DEX Futures Vault\n\n";
      msg += "Network: BNB Smart Chain (BSC)\n";
      msg += "Token: USDT (BEP-20)\n";
      msg += "Vault Address:\n0x128463A60784c4D3f46c23Af3f65Ed859Ba87974\n\n";
      msg += "Instructions:\n";
      msg += "1. Send USDT (BEP-20) from your BSC wallet to the vault address above\n";
      msg += "2. Wait for the transaction to confirm (~15 seconds on BSC)\n";
      msg += "3. Your deposit will appear in your Aster Futures balance within 1-2 minutes\n";
      msg += "4. Type /status to check your updated balance\n\n";
      msg += "Minimum deposit: $1 USDT\n";
      msg += "Gas required: ~0.001 BNB for the transfer fee\n";
      if (wallet) {
        msg += `\nYour linked wallet: ${wallet.substring(0, 8)}...${wallet.substring(38)}`;
      }
      await bot.sendMessage(chatId, msg, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Fund via Bot Wallet", callback_data: "aster:fund" }],
            [{ text: "Check Status", callback_data: "aster:full_status" }],
            [{ text: "Main Menu", callback_data: "action:main" }],
          ],
        },
      });
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
      pendingBuild4Buy.delete(chatId);
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
    await bot.sendMessage(chatId, "🆓 Pick your AI model (all free):", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🆓 Llama 70B — Fast", callback_data: "model:llama" }],
          [{ text: "🆓 DeepSeek V3 — Strong reasoning", callback_data: "model:deepseek" }],
          [{ text: "🆓 Qwen 72B — Multilingual", callback_data: "model:qwen" }],
        ]
      }
    });
    return;
  }
}

async function ensureUserHasAgent(chatId: number): Promise<boolean> {
  const wallet = getLinkedWallet(chatId);
  if (!wallet) return false;
  try {
    const agents = await storage.getAgentsByWallet(wallet);
    if (agents.length > 0) return true;
  } catch (e: any) {
    console.error("[ensureUserHasAgent] getAgentsByWallet failed:", e.message);
  }
  try {
    const agents = await storage.getAgentsByTelegramChatId(chatId.toString());
    if (agents.length > 0) return true;
  } catch (e: any) {
    console.error("[ensureUserHasAgent] getAgentsByTelegramChatId failed:", e.message);
  }
  return false;
}

async function getUserAgent(chatId: number): Promise<{ id: string; name: string; bio: string | null; modelType: string } | null> {
  const wallet = getLinkedWallet(chatId);
  if (!wallet) return null;
  try {
    let agents = await storage.getAgentsByWallet(wallet);
    if (agents.length === 0) {
      agents = await storage.getAgentsByTelegramChatId(chatId.toString());
    }
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
      ["grok", "akash", "hyperbolic"],
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

  const AGENT_CREATION_FEE = "0.01";

  try {
    await bot.sendChatAction(chatId, "typing");

    if (!freeCreation) {
      const pk = await resolvePrivateKey(chatId, wallet);
      if (!pk) {
        await bot.sendMessage(chatId, "❌ Wallet private key not found. Cannot charge agent creation fee.", { reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } });
        return;
      }
      try {
        const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org");
        const signer = new ethers.Wallet(pk, provider);
        const feeWei = ethers.parseEther(AGENT_CREATION_FEE);
        const balance = await provider.getBalance(signer.address);
        if (balance < feeWei + ethers.parseEther("0.0005")) {
          await bot.sendMessage(chatId,
            `❌ *Insufficient BNB for agent creation*\n\nRequired: ${AGENT_CREATION_FEE} BNB + gas\nBalance: ${parseFloat(ethers.formatEther(balance)).toFixed(4)} BNB`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "action:menu" }]] } }
          );
          return;
        }
        await bot.sendMessage(chatId, `💸 Charging ${AGENT_CREATION_FEE} BNB agent creation fee...`);
        const gasPrice = (await provider.getFeeData()).gasPrice || ethers.parseUnits("3", "gwei");
        const tx = await signer.sendTransaction({ to: TREASURY_WALLET, value: feeWei, gasLimit: 21000n, gasPrice });
        await tx.wait(1);
        console.log(`[Agent] Creation fee ${AGENT_CREATION_FEE} BNB collected from ${signer.address} tx=${tx.hash}`);
        try {
          await recordPlatformRevenue({ feeType: "agent_creation", amount: AGENT_CREATION_FEE, txHash: tx.hash, description: `Agent creation fee from ${signer.address}` });
        } catch {}
      } catch (payErr: any) {
        console.error("[Agent] Fee payment failed:", payErr.message);
        await bot.sendMessage(chatId,
          `❌ *Payment failed*\n\n${payErr.message?.substring(0, 100)}\n\nMake sure you have at least ${AGENT_CREATION_FEE} BNB + gas in your wallet.`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Try Again", callback_data: "action:newagent" }], [{ text: "« Menu", callback_data: "action:menu" }]] } }
        );
        return;
      }
    }

    const initialDeposit = "1000000000000000";
    const result = await storage.createFullAgent(name, bio, model, initialDeposit, undefined, undefined, wallet);
    const agentId = result.agent.id;

    try {
      await storage.updateAgent(agentId, { ownerTelegramChatId: chatId.toString() });
    } catch {}

    try {
      const existingAgentRewards = await storage.getUserRewardsByType(chatId.toString(), "agent_creation");
      const isFirst = existingAgentRewards.length === 0;
      const rewardAmt = REWARD_AMOUNTS.AGENT_CREATION;
      await grantReward(chatId, "agent_creation", rewardAmt, `🤖 Created agent: ${name}`, agentId);
      if (isFirst) {
        await grantReward(chatId, "first_agent_bonus", REWARD_AMOUNTS.FIRST_AGENT_BONUS, "🎁 First agent bonus!", agentId);
      }
      tryCompleteQuest(chatId, "create_agent");
    } catch (e: any) {
      console.error("[Rewards] Agent creation reward failed:", e.message);
    }

    const isZh = getLang(chatId) === "zh";
    let msg = isZh
      ? `✅ *代理创建成功！*\n\n` +
        `🤖 *${result.agent.name}*\n` +
        `模型: ${shortModel(model)}\n` +
        `ID: \`${agentId}\`\n` +
        (freeCreation ? `\n🎁 免费创建` : `\n💸 已收取 ${AGENT_CREATION_FEE} BNB 创建费`) +
        `\n\n⛓️ 正在自动注册ERC-8004链上身份...`
      : `✅ *Agent Created!*\n\n` +
        `🤖 *${result.agent.name}*\n` +
        `Model: ${shortModel(model)}\n` +
        `ID: \`${agentId}\`\n` +
        (freeCreation ? `\n🎁 Free creation` : `\n💸 ${AGENT_CREATION_FEE} BNB creation fee charged`) +
        `\n\n⛓️ Auto-registering ERC-8004 on-chain identity...`;

    await bot.sendMessage(chatId, msg,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: isZh ? "分配任务" : "Give it a task", callback_data: `agenttask:${agentId}` }],
            [{ text: isZh ? "我的代理" : "My Agents", callback_data: "action:myagents" }, { text: isZh ? "菜单" : "Menu", callback_data: "action:menu" }],
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
    userPk = await resolvePrivateKey(chatId, wallet) || undefined;
  }

  const deployerPk = process.env.ONCHAIN_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  const erc8004Key = deployerPk || userPk;

  if (!erc8004Key) {
    try {
      await bot.sendMessage(chatId,
        `⚠️ On-chain registration skipped — no wallet key available.\n\n` +
        `Use /myagents → "Register On-Chain" to register later.`,
      );
    } catch {}
    return;
  }

  let erc8004Registered = false;
  const chainsToTry: Array<{ network: string; chainKey: string; chainName: string; explorer: string }> = [
    { network: "bsc", chainKey: "bnb", chainName: "BNB Chain", explorer: "bscscan.com" },
    { network: "base", chainKey: "base", chainName: "Base", explorer: "basescan.org" },
  ];

  for (const chain of chainsToTry) {
    if (erc8004Registered) break;
    try {
      const erc8004Result = await registerAgentERC8004(name, bio, agentId, chain.network, erc8004Key);
      if (erc8004Result.success) {
        erc8004Registered = true;
        const shortTx = erc8004Result.txHash?.substring(0, 14) || "";
        results.push(`⛓️ ERC-8004 (${chain.chainName}): ${shortTx}...`);
        if (erc8004Result.tokenId) {
          results.push(`  🆔 Token ID: ${erc8004Result.tokenId}`);
        }
        if (erc8004Result.txHash) {
          results.push(`  🔗 https://${chain.explorer}/tx/${erc8004Result.txHash}`);
        }
        try {
          const { db } = await import("./db");
          const { agents: agentsTable } = await import("@shared/schema");
          const { eq } = await import("drizzle-orm");
          await db.update(agentsTable).set({
            erc8004Registered: true,
            erc8004TxHash: erc8004Result.txHash || null,
            erc8004TokenId: erc8004Result.tokenId || null,
            erc8004Chain: chain.chainKey,
          }).where(eq(agentsTable.id, agentId));
        } catch (dbErr: any) {
          console.error(`[TelegramBot] ERC-8004 DB update failed for ${agentId}:`, dbErr.message);
          try {
            const { db } = await import("./db");
            const { sql } = await import("drizzle-orm");
            await db.execute(sql`UPDATE agents SET erc8004_registered = true, erc8004_tx_hash = ${erc8004Result.txHash || null}, erc8004_token_id = ${erc8004Result.tokenId || null}, erc8004_chain = ${chain.chainKey} WHERE id = ${agentId}`);
          } catch (rawErr: any) {
            console.error(`[TelegramBot] ERC-8004 raw SQL update also failed:`, rawErr.message);
          }
        }
        const creatorWallet = (await storage.getAgent(agentId))?.creatorWallet;
        if (creatorWallet) agentCache.delete(creatorWallet);
      }
    } catch (e: any) {
      console.error(`[TelegramBot] ERC-8004 ${chain.chainName} registration error for ${agentId}:`, e.message);
    }
  }
  if (!erc8004Registered) {
    results.push(`ERC-8004: Registration failed — register later via /myagents`);
  }

  try {
    if (process.env.BAP578_CONTRACT_ADDRESS) {
      const bapResult = await registerAgentBAP578(name, bio, agentId, undefined, userPk);
      if (bapResult.success) {
        results.push(`⛓️ BAP-578 NFA (BNB): ${bapResult.txHash?.substring(0, 14) || "registered"}...`);
        if (bapResult.tokenId) results.push(`  🆔 NFA Token ID: ${bapResult.tokenId}`);
        try {
          const { db } = await import("./db");
          const { agents: agentsTable } = await import("@shared/schema");
          const { eq } = await import("drizzle-orm");
          await db.update(agentsTable).set({ bap578Registered: true }).where(eq(agentsTable.id, agentId));
        } catch {}
      } else {
        results.push(`BAP-578 (BNB): ${bapResult.error?.substring(0, 60) || "skipped — contract not configured"}`);
      }
    }
  } catch (e: any) {
    console.error(`[TelegramBot] BAP-578 registration error for ${agentId}:`, e.message);
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
    const myAgents = await getMyAgents(wallet, chatId);

    if (myAgents.length === 0) {
      await bot.sendMessage(chatId, "No agents yet.", {
        reply_markup: { inline_keyboard: [[{ text: "Create your first agent", callback_data: "action:newagent" }]] }
      });
      return;
    }

    const lines = myAgents.map(a => {
      const model = shortModel(a.modelType || "unknown");
      const statusEmoji = a.status === "active" ? "🟢" : a.status === "dead" ? "💀" : "🟡";
      const statusText = a.status === "active" ? "Active" : a.status === "dead" ? "Dead" : (a.status || "Active");
      let chainLine = "";
      if (a.erc8004Registered) {
        const chain = a.erc8004Chain === "base" ? "Base" : a.erc8004Chain === "bnb" ? "BNB Chain" : (a.erc8004Chain || "Base");
        const explorer = a.erc8004Chain === "base" ? "basescan.org" : a.erc8004Chain === "bnb" ? "bscscan.com" : "basescan.org";
        chainLine = `   ⛓️ Chain: *${chain}*`;
        chainLine += `\n   📜 On-Chain: 🟢 ERC-8004 Verified`;
        if (a.erc8004TokenId) {
          chainLine += ` (#${a.erc8004TokenId})`;
        }
        if (a.erc8004TxHash) {
          chainLine += `\n   🔗 [Proof → ${explorer}](https://${explorer}/tx/${a.erc8004TxHash})`;
        }
      } else {
        chainLine = `   ⛓️ Chain: _Not registered yet_\n   📜 On-Chain: 🔴 Not verified`;
      }
      return `🤖 *${a.name}*\n   ${statusEmoji} Status: *${statusText}*\n   🧠 Model: ${model}\n${chainLine}`;
    });

    const buttons: Array<Array<any>> = [];
    for (const a of myAgents) {
      buttons.push([
        { text: `📋 ${a.name} — Assign Task`, callback_data: `agenttask:${a.id}` },
        { text: `💬 Ask ${a.name}`, callback_data: `agentask:${a.id}` },
      ]);
      if (a.erc8004Registered) {
        if (a.erc8004TxHash) {
          const explorer = a.erc8004Chain === "bnb" ? "bscscan.com" : "basescan.org";
          const explorerName = a.erc8004Chain === "bnb" ? "BscScan" : "BaseScan";
          buttons.push([
            { text: `🔗 View ${a.name} on ${explorerName}`, url: `https://${explorer}/tx/${a.erc8004TxHash}` },
          ]);
        } else {
          const explorer = a.erc8004Chain === "bnb" ? "bscscan.com" : "basescan.org";
          const explorerName = a.erc8004Chain === "bnb" ? "BscScan" : "BaseScan";
          buttons.push([
            { text: `🔗 View ERC-8004 Contract on ${explorerName}`, url: `https://${explorer}/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` },
          ]);
        }
      } else {
        buttons.push([
          { text: `⛓️ Register ${a.name} On-Chain`, callback_data: `registerchain:${a.id}` },
        ]);
      }
    }
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
    const myAgents = await getMyAgents(wallet, chatId);

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

    let userPk = await resolvePrivateKey(chatId, wallet);

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

      try {
        const existingLaunchRewards = await storage.getUserRewardsByType(chatId.toString(), "token_launch");
        const isFirst = existingLaunchRewards.length === 0;
        await grantReward(chatId, "token_launch", REWARD_AMOUNTS.TOKEN_LAUNCH, `🚀 Launched token: ${proposal.tokenName} ($${proposal.tokenSymbol})`, result.tokenAddress || proposalId);
        if (isFirst) {
          await grantReward(chatId, "first_launch_bonus", REWARD_AMOUNTS.FIRST_LAUNCH_BONUS, "🎁 First token launch bonus!", result.tokenAddress || proposalId);
        }
        tryCompleteQuest(chatId, "launch_token");
      } catch (e: any) { console.error("[Rewards] Token launch reward failed:", e.message); }
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
    const myAgents = await getMyAgents(wallet, chatId);

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
              [{ text: "☀️ Raydium LaunchLab (Solana) ⭐", callback_data: `launchplatform:${agent.id}:raydium` }],
              [{ text: "🔵 Bankr (Base/Solana)", callback_data: `launchplatform:${agent.id}:bankr` }],
              [{ text: "Four.meme (BNB Chain)", callback_data: `launchplatform:${agent.id}:four_meme` }],
              [{ text: "Flap.sh (BNB Chain)", callback_data: `launchplatform:${agent.id}:flap_sh` }],
              [{ text: "XLayer (OKX)", callback_data: `launchplatform:${agent.id}:xlayer` }],
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

  if (state.step === "snipe_wallets") {
    const count = parseInt(input.trim());
    if (isNaN(count) || count < 1 || count > 50) {
      await bot.sendMessage(chatId, `❌ Enter a number between 1 and 50.`);
      return;
    }
    state.sniperWalletCount = count;
    state.step = "snipe_bnb";
    pendingTokenLaunch.set(chatId, state);
    await bot.sendMessage(chatId,
      `✅ ${count} sniper wallets\n\n` +
      `Step 2/3: How much BNB per wallet?\n\n` +
      `Four.meme curve is ~26 BNB total.\n` +
      `Examples: 0.5, 1, 2, 5\n\n` +
      `Enter BNB amount per wallet:`,
    );
    return;
  }

  if (state.step === "snipe_bnb") {
    const bnb = parseFloat(input.trim());
    if (isNaN(bnb) || bnb < 0.01 || bnb > 26) {
      await bot.sendMessage(chatId, `❌ Enter a BNB amount between 0.01 and 26.`);
      return;
    }
    state.sniperPerWalletBnb = bnb.toString();
    state.step = "snipe_dev";
    pendingTokenLaunch.set(chatId, state);

    const totalSnipe = (bnb * (state.sniperWalletCount || 10)).toFixed(2);
    await bot.sendMessage(chatId,
      `✅ ${state.sniperWalletCount} wallets × ${bnb} BNB = ${totalSnipe} BNB total snipe\n\n` +
      `Step 3/3: Dev buy amount (BNB)?\n\n` +
      `This is how much BNB your dev wallet buys on the curve before snipers.\n` +
      `Four.meme curve is ~26 BNB total.\n\n` +
      `Common amounts:\n` +
      `• 13 BNB = ~50% of curve\n` +
      `• 18 BNB = ~70% of curve\n` +
      `• 20.8 BNB = ~80% of curve\n\n` +
      `Enter BNB amount for dev buy:`,
    );
    return;
  }

  if (state.step === "snipe_dev") {
    const devBnb = parseFloat(input.trim());
    if (isNaN(devBnb) || devBnb < 0) {
      await bot.sendMessage(chatId, `❌ Enter a valid BNB amount (0 or more).`);
      return;
    }
    state.sniperDevBuyBnb = devBnb.toString();
    state.sniperEnabled = true;

    const totalSnipe = (parseFloat(state.sniperPerWalletBnb || "1") * (state.sniperWalletCount || 10)).toFixed(2);
    const totalNeeded = (devBnb + parseFloat(totalSnipe) + 0.1).toFixed(2);

    await bot.sendMessage(chatId,
      `✅ Snipe config set!\n\n` +
      `📊 Summary:\n` +
      `  Dev Buy: ${devBnb} BNB\n` +
      `  Snipers: ${state.sniperWalletCount} wallets × ${state.sniperPerWalletBnb} BNB\n` +
      `  Total Snipe: ${totalSnipe} BNB\n` +
      `  Total BNB needed: ~${totalNeeded} BNB`,
    );

    showLaunchPreview(chatId, state);
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

    if (state.platform === "four_meme") {
      showLaunchPreview(chatId, state);
      return;
    }

    if (state.platform === "raydium") {
      state.step = "raydium_buy";
      pendingTokenLaunch.set(chatId, state);
      await bot.sendMessage(chatId,
        `☀️ Initial buy (optional):\n\nWant to buy some of your own token right at launch? This puts SOL in the bonding curve and gives you tokens.\n\nHow much SOL to spend on initial buy?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Skip (0 SOL)", callback_data: "raydium_buy:0" },
                { text: "0.1 SOL", callback_data: "raydium_buy:0.1" },
              ],
              [
                { text: "0.5 SOL", callback_data: "raydium_buy:0.5" },
                { text: "1 SOL", callback_data: "raydium_buy:1" },
              ],
              [
                { text: "2 SOL", callback_data: "raydium_buy:2" },
                { text: "5 SOL", callback_data: "raydium_buy:5" },
              ],
            ]
          }
        }
      );
      return;
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
  const platformName = state.platform === "raydium" ? "Raydium LaunchLab (Solana)" : state.platform === "four_meme" ? "Four.meme (BNB Chain)" : state.platform === "bankr" ? `Bankr (${state.bankrChain === "solana" ? "Solana" : "Base"})` : state.platform === "xlayer" ? "XLayer (OKX)" : "Flap.sh (BNB Chain)";
  const liquidity = state.platform === "raydium" ? "Bonding curve → Raydium DEX" : state.platform === "bankr" ? "Managed by Bankr" : state.platform === "xlayer" ? "N/A (direct deploy)" : state.platform === "four_meme" ? "0.01 BNB" : "0.001 BNB";
  const launchFee = state.platform === "raydium" ? "Gas only (~0.02 SOL)" : state.platform === "bankr" ? "Free" : state.platform === "xlayer" ? "Gas only (~0.005 OKB)" : "0.01 BNB (~$7)";

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
  if (state.platform === "raydium") {
    preview += `Initial Buy: ${state.initialBuySol ? state.initialBuySol + " SOL" : "None"}\n`;
    preview += `Supply: 1,000,000,000 tokens\n`;
    preview += `Curve: 80% on bonding curve, fills at 85 SOL\n`;
  }
  if (state.platform === "bankr" && (state.stealthBuyEth || state.stealthBuyPercent)) {
    preview += `\n🥷 Stealth Buy: ${state.stealthBuyEth ? state.stealthBuyEth + " ETH" : state.stealthBuyPercent + "% supply"} (via Bankr)\n`;
  }
  if (state.platform === "four_meme" && state.sniperEnabled) {
    const totalSnipeBnb = (parseFloat(state.sniperPerWalletBnb || "1") * (state.sniperWalletCount || 10)).toFixed(2);
    const totalBnb = (parseFloat(state.sniperDevBuyBnb || "18") + parseFloat(totalSnipeBnb) + 0.1).toFixed(2);
    preview += `\n🎯 Snipe Launch: ENABLED\n`;
    preview += `  Strategy: Fund snipers first → Launch → Instant buys\n`;
    preview += `  Dev Buy: ${state.sniperDevBuyBnb} BNB (curve pre-buy)\n`;
    preview += `  Snipers: ${state.sniperWalletCount} wallets × ${state.sniperPerWalletBnb} BNB\n`;
    preview += `  Total Snipe: ${totalSnipeBnb} BNB\n`;
    preview += `  Relay Wallets: 3 (breaks on-chain trace)\n`;
    preview += `  Total BNB needed: ~${totalBnb} BNB\n`;
  }
  preview += `\nReady to launch?`;

  pendingTokenLaunch.set(chatId, state);

  const buttons: any[][] = [];
  if (state.platform === "bankr") {
    buttons.push([{ text: "🥷 Add Stealth Buy", callback_data: `bankrstealth:${state.agentId}` }]);
  }
  if (state.platform === "four_meme" && process.env.ADMIN_CHAT_ID && chatId.toString() === process.env.ADMIN_CHAT_ID) {
    buttons.push([{ text: state.sniperEnabled ? "🎯 Modify Snipe Config" : "🎯 Add Snipe Launch", callback_data: `foursnipe:${state.agentId}` }]);
  }
  buttons.push([{ text: "🚀 Confirm & Launch", callback_data: `launchconfirm:${state.agentId}` }]);
  buttons.push([{ text: "Cancel", callback_data: `launchcancel:${state.agentId}` }]);

  await bot.sendMessage(chatId, preview, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function executeTelegramTokenLaunch(chatId: number, wallet: string, state: TokenLaunchState): Promise<void> {
  if (!bot) return;

  const platformName = state.platform === "raydium" ? "Raydium LaunchLab (Solana)" : state.platform === "four_meme" ? "Four.meme (BNB Chain)" : state.platform === "bankr" ? `Bankr (${state.bankrChain === "solana" ? "Solana" : "Base"})` : state.platform === "xlayer" ? "XLayer (OKX)" : "Flap.sh (BNB Chain)";

  if (state.platform === "raydium") {
    await bot.sendMessage(chatId, `☀️ Launching ${state.tokenName} ($${state.tokenSymbol}) on Raydium LaunchLab...\n\n${state.initialBuySol ? `Initial buy: ${state.initialBuySol} SOL\n` : ""}This may take up to 2 minutes.`);
    await bot.sendChatAction(chatId, "typing");

    const solWallet = await getOrCreateSolanaWallet(chatId);
    if (!solWallet || !solWallet.privateKey) {
      await bot.sendMessage(chatId, "⚠️ Could not access Solana wallet. Try /start to create a fresh wallet.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }

    const { launchToken } = await import("./token-launcher");
    const result = await launchToken({
      tokenName: state.tokenName!,
      tokenSymbol: state.tokenSymbol!,
      tokenDescription: state.tokenDescription || "",
      imageUrl: state.imageUrl,
      platform: "raydium",
      agentId: state.agentId,
      creatorWallet: solWallet.address,
      solanaPrivateKey: solWallet.privateKey,
      initialBuySol: state.initialBuySol,
      webUrl: state.webUrl,
      twitterUrl: state.twitterUrl,
      telegramUrl: state.telegramUrl,
    });

    pendingTokenLaunch.delete(chatId);

    if (result.success) {
      let successMsg = `☀️ TOKEN LAUNCHED ON RAYDIUM!\n\n` +
        `Token: ${state.tokenName} ($${state.tokenSymbol})\n` +
        `Address: \`${result.tokenAddress}\`\n` +
        `TX: \`${result.txHash}\`\n`;
      if (state.initialBuySol) successMsg += `Initial Buy: ${state.initialBuySol} SOL\n`;
      successMsg += `\n🔗 Raydium: ${result.launchUrl}\n` +
        `🔍 Solscan: https://solscan.io/token/${result.tokenAddress}\n\n` +
        `Your token is live on a bonding curve! Once it fills (85 SOL), liquidity auto-migrates to Raydium DEX.`;
      await bot.sendMessage(chatId, successMsg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
      try {
        const existingLaunchRewards = await storage.getUserRewardsByType(chatId.toString(), "token_launch");
        const isFirst = existingLaunchRewards.length === 0;
        await grantReward(chatId, "token_launch", REWARD_AMOUNTS.TOKEN_LAUNCH, `🚀 Launched token: ${state.tokenName} ($${state.tokenSymbol})`, result.tokenAddress);
        if (isFirst) await grantReward(chatId, "first_launch_bonus", REWARD_AMOUNTS.FIRST_LAUNCH_BONUS, "🎁 First token launch bonus!", result.tokenAddress);
        tryCompleteQuest(chatId, "launch_token");
      } catch (e: any) { console.error("[Rewards] Token launch reward failed:", e.message); }
    } else {
      await bot.sendMessage(chatId,
        `❌ Raydium launch failed: ${(result.error || "Unknown error").substring(0, 300)}\n\nMake sure your wallet has enough SOL for gas${state.initialBuySol ? " + initial buy" : ""}. Try /launch to retry.`,
        { reply_markup: mainMenuKeyboard(undefined, chatId) }
      );
    }
    return;
  }

  if (state.platform === "xlayer") {
    await bot.sendMessage(chatId, `🌐 Deploying ${state.tokenName} ($${state.tokenSymbol}) as ERC-20 on XLayer...\n\nThis may take a minute.`);
    await bot.sendChatAction(chatId, "typing");

    let userPk = await resolvePrivateKey(chatId, wallet);
    if (!userPk) {
      const newWallet = await regenerateWalletWithKey(chatId);
      if (newWallet) {
        userPk = await resolvePrivateKey(chatId, newWallet);
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
    const hasStealthBuy = (state.stealthBuyEth && parseFloat(state.stealthBuyEth) > 0) ||
      (state.stealthBuyPercent && state.stealthBuyPercent > 0);
    const stealthLabel = state.stealthBuyEth ? `${state.stealthBuyEth} ETH` : `${state.stealthBuyPercent}%`;
    const launchMsg = hasStealthBuy
      ? `🏦 Launching ${state.tokenName} ($${state.tokenSymbol}) on ${platformName} via Bankr API...\n\n🥷 Stealth buy (${stealthLabel}) will execute immediately after deploy.\n\nThis may take up to 3 minutes.`
      : `🏦 Launching ${state.tokenName} ($${state.tokenSymbol}) on ${platformName} via Bankr API...\n\nThis may take up to 2 minutes.`;
    await bot.sendMessage(chatId, launchMsg);
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
        stealthBuyEth: state.stealthBuyEth,
        stealthBuyPercent: state.stealthBuyPercent,
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

        if (result.stealthBuy) {
          lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
          if (result.stealthBuy.success) {
            lines.push(`🥷 *Stealth Buy: SUCCESS* ✅`);
            if (result.stealthBuy.amountEth) lines.push(`Amount: ${result.stealthBuy.amountEth} ETH`);
          } else {
            lines.push(`🥷 *Stealth Buy: FAILED* ❌`);
            if (result.stealthBuy.error) lines.push(`Reason: ${result.stealthBuy.error.substring(0, 150)}`);
            lines.push(`\nYou can still buy manually below:`);
          }
        }

        if (result.tokenAddress && isBase) {
          if (!result.stealthBuy?.success) {
            lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
            lines.push(`⚡ *BUY NOW*`);
          }

          await bot.sendMessage(chatId, lines.join("\n"), {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "⚡ 1 ETH", callback_data: `cabuy:${result.tokenAddress}:${chainId}:1` },
                  { text: "⚡ 5 ETH", callback_data: `cabuy:${result.tokenAddress}:${chainId}:5` },
                  { text: "⚡ 10 ETH", callback_data: `cabuy:${result.tokenAddress}:${chainId}:10` },
                ],
                [{ text: "🔒 Scan Token", callback_data: `cascan:${result.tokenAddress}:${chainId}` }],
                [{ text: "« Menu", callback_data: "action:menu" }],
              ]
            }
          });
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
        try {
          const existingLaunchRewards = await storage.getUserRewardsByType(chatId.toString(), "token_launch");
          const isFirst = existingLaunchRewards.length === 0;
          await grantReward(chatId, "token_launch", REWARD_AMOUNTS.TOKEN_LAUNCH, `🚀 Launched token: ${state.tokenName} ($${state.tokenSymbol})`, result.tokenAddress);
          if (isFirst) await grantReward(chatId, "first_launch_bonus", REWARD_AMOUNTS.FIRST_LAUNCH_BONUS, "🎁 First token launch bonus!", result.tokenAddress);
          tryCompleteQuest(chatId, "launch_token");
        } catch (e: any) { console.error("[Rewards] Token launch reward failed:", e.message); }
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

  let userPk = await resolvePrivateKey(chatId, wallet);

  if (!userPk) {
    const newWallet = await regenerateWalletWithKey(chatId);
    if (newWallet) {
      userPk = await resolvePrivateKey(chatId, newWallet);
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

  if (state.platform === "four_meme" && state.sniperEnabled) {
    const walletCount = state.sniperWalletCount || 10;
    const perWalletBnb = parseFloat(state.sniperPerWalletBnb || "1");
    const { ethers } = await import("ethers");

    await bot.sendMessage(chatId,
      `🎯 SNIPE LAUNCH: ${state.tokenName} ($${state.tokenSymbol})\n\n` +
      `Step 1: Generating ${walletCount} sniper wallets...`
    );

    const sniperWallets: Array<{ address: string; privateKey: string; buyBnb: number }> = [];
    for (let i = 0; i < walletCount; i++) {
      const sw = ethers.Wallet.createRandom();
      const jitter = 1 + (Math.random() * 0.3 - 0.15);
      sniperWallets.push({
        address: sw.address,
        privateKey: sw.privateKey,
        buyBnb: perWalletBnb * jitter,
      });
    }

    let keyMsg = `🔐 SNIPER WALLET KEYS\n\n⚠️ SAVE THESE NOW — this message will be auto-deleted in 60 seconds.\nKeys are also saved securely in the database.\n\n`;
    for (let i = 0; i < sniperWallets.length; i++) {
      const sw = sniperWallets[i];
      keyMsg += `W${i + 1}: \`${sw.address}\`\nKey: \`${sw.privateKey}\`\nBuy: ~${sw.buyBnb.toFixed(4)} BNB\n\n`;
    }
    const totalSnipeBnb = sniperWallets.reduce((s, w) => s + w.buyBnb, 0);
    keyMsg += `Total snipe: ~${totalSnipeBnb.toFixed(2)} BNB across ${walletCount} wallets`;
    const sniperKeyMsg = await bot.sendMessage(chatId, keyMsg, { parse_mode: "Markdown" });
    scheduleSecureDelete(chatId, sniperKeyMsg.message_id, 60000);
    setTimeout(async () => {
      try { await bot!.sendMessage(chatId, "🔐 Sniper wallet keys message deleted for security. Keys are saved in the database."); } catch {}
    }, 61000);

    await storage.saveSniperWallets({
      chatId: chatId.toString(),
      agentId: state.agentId,
      wallets: sniperWallets.map((sw, i) => ({
        index: i + 1,
        address: sw.address,
        privateKey: sw.privateKey,
        bnbAmount: sw.buyBnb.toFixed(6),
        status: "created",
      })),
    });

    await bot.sendMessage(chatId,
      `✅ ${walletCount} wallets generated and keys saved.\n\n` +
      `Step 2: Funding wallets via relays → Launching → Instant snipe buys...\n` +
      `Dev buy: ${state.sniperDevBuyBnb} BNB\n\n` +
      `⏳ This may take 2-3 minutes. Do not close the chat.`
    );
    await bot.sendChatAction(chatId, "typing");

    try {
      const { fourMemeLaunchWithSnipe } = await import("./token-launcher");
      const result = await fourMemeLaunchWithSnipe({
        tokenName: state.tokenName!,
        tokenSymbol: state.tokenSymbol!,
        tokenDescription: state.tokenDescription || `${state.tokenName} — launched by ${state.agentName} on BUILD4`,
        imageUrl: state.imageUrl,
        platform: "four_meme",
        agentId: state.agentId,
        creatorWallet: wallet,
        userPrivateKey: userPk,
        webUrl: state.webUrl,
        twitterUrl: state.twitterUrl,
        telegramUrl: state.telegramUrl,
        sniperEnabled: true,
        sniperDevBuyBnb: state.sniperDevBuyBnb,
        sniperWalletCount: state.sniperWalletCount,
        sniperPerWalletBnb: state.sniperPerWalletBnb,
        preGeneratedWallets: sniperWallets.map(sw => ({ address: sw.address, privateKey: sw.privateKey, buyBnb: sw.buyBnb })),
      });

      pendingTokenLaunch.delete(chatId);

      if (result.success) {
        const lines = [
          `🎯 SNIPE LAUNCH COMPLETE!\n`,
          `Token: ${state.tokenName} ($${state.tokenSymbol})`,
          `Platform: Four.meme (BNB Chain)`,
        ];
        if (result.tokenAddress) lines.push(`Address: \`${result.tokenAddress}\``);
        if (result.txHash) lines.push(`Launch TX: https://bscscan.com/tx/${result.txHash}`);
        if (result.launchUrl) lines.push(`View: ${result.launchUrl}`);

        if (result.sniperResults) {
          lines.push(`\n🎯 SNIPE RESULTS:`);
          lines.push(`Dev Buy: ${result.sniperResults.devBuyBnb} BNB`);
          lines.push(`Snipers: ${result.sniperResults.successCount}/${result.sniperResults.wallets.length} successful`);
          lines.push(`Total Sniped: ${result.sniperResults.totalSnipedBnb} BNB`);
          for (let i = 0; i < result.sniperResults.wallets.length; i++) {
            const sw = result.sniperResults.wallets[i];
            const status = sw.success ? "✅" : "❌";
            lines.push(`${status} W${i + 1}: \`${sw.address.substring(0, 10)}...\`${sw.txHash ? ` [tx](https://bscscan.com/tx/${sw.txHash})` : ""}`);
          }
        }

        await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });

        if (result.sniperResults && result.tokenAddress) {
          for (const sw of result.sniperResults.wallets) {
            await storage.updateSniperWalletStatus(
              sw.address,
              sw.success ? "sniped" : "failed",
              result.tokenAddress,
              sw.txHash,
            );
          }
        }
      } else {
        await bot.sendMessage(chatId,
          `❌ Snipe launch failed: ${(result.error || "Unknown error").substring(0, 300)}\n\n` +
          `Your sniper wallet keys were already shown above and saved to the database. You can recover any funded BNB using those keys.`,
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
      pendingTokenLaunch.delete(chatId);
      await bot.sendMessage(chatId, `❌ Error: ${e.message?.substring(0, 200)}\n\nSniper wallet keys were already shown and saved.`);
    }
    return;
  }

  {
    await bot.sendMessage(chatId, `🚀 Launching ${state.tokenName} ($${state.tokenSymbol}) on ${platformName} from your wallet...\n\nThis may take a minute.`);
  }
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
      try {
        const existingLaunchRewards = await storage.getUserRewardsByType(chatId.toString(), "token_launch");
        const isFirst = existingLaunchRewards.length === 0;
        await grantReward(chatId, "token_launch", REWARD_AMOUNTS.TOKEN_LAUNCH, `🚀 Launched token: ${state.tokenName} ($${state.tokenSymbol})`, result.tokenAddress);
        if (isFirst) await grantReward(chatId, "first_launch_bonus", REWARD_AMOUNTS.FIRST_LAUNCH_BONUS, "🎁 First token launch bonus!", result.tokenAddress);
        tryCompleteQuest(chatId, "launch_token");
      } catch (e: any) { console.error("[Rewards] Token launch reward failed:", e.message); }
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

async function handleChallengeCreationFlow(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const state = pendingChallengeCreation.get(chatId)!;
  const input = text.trim();

  if (state.step === "name") {
    state.name = input;
    state.step = "description";
    pendingChallengeCreation.set(chatId, state);
    await bot.sendMessage(chatId, "Enter a description for the challenge (or 'skip'):");
    return;
  }
  if (state.step === "description") {
    state.description = input.toLowerCase() === "skip" ? "" : input;
    state.step = "duration";
    pendingChallengeCreation.set(chatId, state);
    await bot.sendMessage(chatId, "How many days should the challenge run? (e.g. 7, 14, 30):");
    return;
  }
  if (state.step === "duration") {
    const days = parseInt(input);
    if (isNaN(days) || days < 1 || days > 90) {
      await bot.sendMessage(chatId, "Enter a number between 1 and 90:");
      return;
    }
    state.durationDays = days;
    state.step = "prize";
    pendingChallengeCreation.set(chatId, state);
    await bot.sendMessage(chatId, "Enter the $B4 prize pool amount (e.g. 50000, 100000):");
    return;
  }
  if (state.step === "prize") {
    const prize = parseInt(input.replace(/,/g, ""));
    if (isNaN(prize) || prize < 1000) {
      await bot.sendMessage(chatId, "Enter at least 1000 $B4:");
      return;
    }
    state.prizePoolB4 = prize.toString();
    state.step = "confirm";
    pendingChallengeCreation.set(chatId, state);
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + state.durationDays! * 24 * 60 * 60 * 1000);
    await bot.sendMessage(chatId,
      `🏆 *Confirm Challenge*\n\n` +
      `Name: ${state.name}\n` +
      `Description: ${state.description || "None"}\n` +
      `Duration: ${state.durationDays} days\n` +
      `Prize: ${prize.toLocaleString()} $B4\n` +
      `Start: Now\n` +
      `End: ${endDate.toLocaleDateString()}\n\n` +
      `Type "yes" to create or "cancel" to abort.`,
      { parse_mode: "Markdown" }
    );
    return;
  }
  if (state.step === "confirm") {
    if (input.toLowerCase() === "cancel") {
      pendingChallengeCreation.delete(chatId);
      await bot.sendMessage(chatId, "Challenge creation cancelled.");
      return;
    }
    if (input.toLowerCase() !== "yes") {
      await bot.sendMessage(chatId, 'Type "yes" to confirm or "cancel" to abort.');
      return;
    }
    pendingChallengeCreation.delete(chatId);
    const { createChallenge } = await import("./trading-challenge");
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + state.durationDays! * 24 * 60 * 60 * 1000);
    const challenge = await createChallenge({
      name: state.name!,
      description: state.description || "",
      startDate,
      endDate,
      prizePoolB4: state.prizePoolB4!,
      maxEntries: 100,
    });
    await bot.sendMessage(chatId,
      `✅ *Challenge Created!*\n\n` +
      `*${challenge.name}*\n` +
      `Prize: ${parseInt(challenge.prizePoolB4).toLocaleString()} $B4\n` +
      `Duration: ${state.durationDays} days\n` +
      `ID: \`${challenge.id}\``,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
        [{ text: "📊 View Challenge", callback_data: `challenge_lb:${challenge.id}` }],
        [{ text: "« Menu", callback_data: "action:menu" }],
      ] } }
    );
    return;
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
    const isGroup = chatId < 0;
    if (!isGroup) {
      const sub = await checkSubscription(chatId);
      if (!sub.allowed) {
        const usedChats = getAiChatCount(chatId);
        if (usedChats >= FREE_AI_CHAT_LIMIT) {
          const remaining = 0;
          await bot!.sendMessage(chatId,
            `🧠 *You've used all ${FREE_AI_CHAT_LIMIT} free AI chats!*\n\n` +
            `BUILD4 AI is powered by multiple AI providers (Grok, Akash, Hyperbolic) running in parallel for the smartest, most accurate answers.\n\n` +
            `Subscribe to get *unlimited AI conversations* plus all premium features:\n` +
            `• 🧠 Unlimited AI Chat\n` +
            `• 🐋 Smart Money Signals\n` +
            `• ⚡ Instant Buy & Sell\n` +
            `• 🔄 DEX Swap & Bridge\n` +
            `• 🔒 Security Scanner\n` +
            `• 🚀 Token Launcher\n\n` +
            `💰 *$${BOT_PRICE_USD}/month* — Start with a *${TRIAL_DAYS}-day free trial!*`,
            {
              parse_mode: "Markdown",
              reply_to_message_id: messageId,
              reply_markup: {
                inline_keyboard: [
                  [{ text: `🆓 Start ${TRIAL_DAYS}-Day Free Trial`, callback_data: "action:subscribe" }],
                  [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
                  [{ text: "« Menu", callback_data: "action:menu" }],
                ],
              },
            }
          );
          return;
        }
      }
    }

    bot!.sendChatAction(chatId, "typing").catch(() => {});
    const typingInterval = setInterval(() => {
      bot!.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    const answer = await generateAnswer(question, username, chatId);
    clearInterval(typingInterval);

    const isGroupChat = chatId < 0;
    if (!isGroupChat) {
      const sub = await checkSubscription(chatId);
      if (!sub.allowed) {
        const newCount = incrementAiChat(chatId);
        const remaining = FREE_AI_CHAT_LIMIT - newCount;
        if (remaining > 0 && remaining <= 3) {
          const warningText = `\n\n---\n⚠️ _${remaining} free AI chat${remaining === 1 ? "" : "s"} remaining. Subscribe for unlimited access!_`;
          const fullAnswer = answer + warningText;
          const hasMarkdown = true;
          if (fullAnswer.length <= 4000) {
            await bot!.sendMessage(chatId, fullAnswer, {
              reply_to_message_id: messageId,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: `💳 Subscribe — $${BOT_PRICE_USD}/mo`, callback_data: "action:subscribe" }],
                ],
              },
            }).catch(async () => {
              await bot!.sendMessage(chatId, fullAnswer, { reply_to_message_id: messageId }).catch(() => {});
            });
          } else {
            await bot!.sendMessage(chatId, answer, { reply_to_message_id: messageId, parse_mode: "Markdown" }).catch(() => {});
            await bot!.sendMessage(chatId, `⚠️ _${remaining} free AI chat${remaining === 1 ? "" : "s"} remaining._`, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: `💳 Subscribe`, callback_data: "action:subscribe" }]] },
            }).catch(() => {});
          }
          return;
        }
      }
    }

    console.log(`[TelegramBot] Answering @${username}: ${answer.slice(0, 80)}...`);
    const hasMarkdown = answer.includes("`") || answer.includes("*") || answer.includes("_");

    if (answer.length <= 4000) {
      await bot!.sendMessage(chatId, answer, {
        reply_to_message_id: messageId,
        parse_mode: hasMarkdown ? "Markdown" : undefined,
      }).catch(async () => {
        await bot!.sendMessage(chatId, answer, { reply_to_message_id: messageId }).catch(() => {});
      });
    } else {
      const chunks: string[] = [];
      let remaining = answer;
      while (remaining.length > 0) {
        if (remaining.length <= 4000) {
          chunks.push(remaining);
          break;
        }
        let splitAt = remaining.lastIndexOf("\n\n", 4000);
        if (splitAt < 500) splitAt = remaining.lastIndexOf("\n", 4000);
        if (splitAt < 500) splitAt = 4000;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).trimStart();
      }
      for (let i = 0; i < chunks.length; i++) {
        const opts: any = i === 0 ? { reply_to_message_id: messageId } : {};
        if (hasMarkdown) opts.parse_mode = "Markdown";
        await bot!.sendMessage(chatId, chunks[i], opts).catch(async () => {
          delete opts.parse_mode;
          await bot!.sendMessage(chatId, chunks[i], opts).catch(() => {});
        });
      }
    }
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

  const ownerClient = getOwnerAsterClient();
  if (!connected && !ownerClient) {
    const buttons: TelegramBot.InlineKeyboardButton[][] = [];
    buttons.push([{ text: "🔑 Connect with API Key", callback_data: "aster:connect" }]);
    buttons.push([{ text: "❓ How to Get API Key", callback_data: "aster:api_help" }]);
    buttons.push([{ text: "« Back", callback_data: "action:menu" }]);

    await bot.sendMessage(chatId,
      `📈 *Aster DEX — Futures Trading*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Powered by Aster DEX_\n\n` +
      `Up to 150x leverage on BTC, ETH & more.\n` +
      `Trade directly from Telegram.\n\n` +
      `*To get started:*\n` +
      `1. Create an API Wallet on Aster DEX\n` +
      `2. Paste your API Key + Secret here\n` +
      `3. Everything else happens in Telegram!\n\n` +
      `Tap "How to Get API Key" for step-by-step instructions.`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      }
    );
    return;
  }

  const isV3Direct = creds && creds.apiKey === "V3_DIRECT";
  const modeLabel = ownerClient ? "V3 API Wallet" : (isV3Direct ? "V3 Direct" : "API Wallet");

  await bot.sendMessage(chatId,
    `📈 *Aster DEX*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Connected · ${modeLabel}\n\n` +
    `Select an action below:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Futures Trade", callback_data: "aster:trade_futures" }, { text: "💱 Spot Trade", callback_data: "aster:trade_spot" }],
          [{ text: "📊 Markets", callback_data: "aster:markets" }, { text: "💵 Fund Account", callback_data: "aster:fund" }],
          [{ text: "💰 Balances", callback_data: "aster:balance" }, { text: "📊 Positions", callback_data: "aster:positions" }],
          [{ text: "📋 Open Orders", callback_data: "aster:orders" }, { text: "📈 PnL", callback_data: "aster:pnl" }],
          [{ text: "🤖 AI Agent", callback_data: "aster:agent" }, { text: "⚙️ Risk Settings", callback_data: "aster:risk_settings" }],
          [{ text: "🔧 Test Connection", callback_data: "aster:test_connection" }],
          [{ text: "🏆 Competition", callback_data: "aster:competition" }],
          [{ text: "🔌 Disconnect", callback_data: "aster:disconnect" }, { text: "« Back", callback_data: "action:menu" }],
        ],
      },
    }
  );
}

let cachedOwnerClient: any = null;
let ownerClientInitAttempted = false;

async function initOwnerAsterClient(): Promise<any> {
  if (cachedOwnerClient) return cachedOwnerClient;
  if (ownerClientInitAttempted) return null;
  ownerClientInitAttempted = true;

  const privateKey = process.env.ASTER_PRIVATE_KEY || process.env.ASTER_API_WALLET_KEY;
  const userAddress = process.env.ASTER_USER_ADDRESS;
  const signerAddress = process.env.ASTER_SIGNER_ADDRESS;

  if (privateKey) {
    const { createAsterV3FuturesClient } = await import("./aster-client");
    const { Wallet } = await import("ethers");
    const wallet = new Wallet(privateKey);
    const derivedSigner = wallet.address;
    const user = userAddress || derivedSigner;
    const signer = signerAddress || derivedSigner;

    const futures = createAsterV3FuturesClient({
      user,
      signer,
      signerPrivateKey: privateKey,
    });
    cachedOwnerClient = { futures, spot: null, mode: "V3" };
    console.log(`[Aster] Pro API V3 client initialized: user=${user.substring(0, 10)}... signer=${signer.substring(0, 10)}...`);
    return cachedOwnerClient;
  }

  const apiKey = process.env.ASTER_API_KEY;
  const apiSecret = process.env.ASTER_API_SECRET;

  if (apiKey && apiSecret) {
    const { createAsterFuturesClient, createAsterSpotClient } = await import("./aster-client");
    const futures = createAsterFuturesClient({ apiKey, apiSecret });
    const spot = createAsterSpotClient({ apiKey, apiSecret });
    cachedOwnerClient = { futures, spot, mode: "HMAC" };
    console.log(`[Aster] Owner HMAC client initialized (apiKey=${apiKey.substring(0, 8)}...)`);
    return cachedOwnerClient;
  }

  console.log(`[Aster] No owner API configured. Set ASTER_PRIVATE_KEY + ASTER_USER_ADDRESS (Pro API V3)`);
  return null;
}

function getOwnerAsterClient(): any {
  return cachedOwnerClient;
}

async function getAsterClient(chatId: number): Promise<any> {
  const ownerClient = getOwnerAsterClient();
  if (ownerClient) return ownerClient;

  const creds = await storage.getAsterCredentials(chatId.toString());
  if (!creds) return null;

  const isV3Direct = creds.apiKey === "V3_DIRECT";

  if (!isV3Direct && creds.apiKey && creds.apiSecret) {
    const { createAsterFuturesClient, createAsterSpotClient } = await import("./aster-client");
    const futures = createAsterFuturesClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
    const spot = createAsterSpotClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
    return { futures, spot };
  }

  if (isV3Direct) {
    const wallet = getLinkedWallet(chatId);
    const pk = wallet ? await resolvePrivateKey(chatId, wallet) : null;
    if (pk && wallet) {
      const { createAsterV3FuturesClient } = await import("./aster-client");
      const v3Futures = createAsterV3FuturesClient({
        user: wallet,
        signer: wallet,
        signerPrivateKey: pk,
      });
      return { futures: v3Futures, spot: null };
    }
  }

  return null;
}

async function handleAsterCallback(chatId: number, data: string): Promise<void> {
  if (!bot) return;
  const action = data.replace("aster:", "");

  if (action === "api_help") {
    await bot.sendMessage(chatId,
      `How to Connect Aster Pro API (V3)\n\n` +
      `Step 1: Go to asterdex.com and connect your wallet\n\n` +
      `Step 2: Go to asterdex.com/en/api-wallet\n\n` +
      `Step 3: Click "Authorize new API wallet"\n\n` +
      `Step 4: Name it (e.g. "build4") and approve the on-chain tx\n\n` +
      `Step 5: Enable "Read", "Perps trading", and "Spot trading" permissions\n\n` +
      `Step 6: The API Wallet has its own address and private key. Set these env vars on Render:\n` +
      `  ASTER_PRIVATE_KEY = API wallet private key\n` +
      `  ASTER_USER_ADDRESS = your main wallet address\n` +
      `  ASTER_SIGNER_ADDRESS = API wallet address\n\n` +
      `Note: Aster stopped issuing traditional API Key+Secret on March 25, 2026. Pro API V3 uses EIP-712 signing.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Test Connection", callback_data: "aster:test_connection" }],
            [{ text: "Aster Menu", callback_data: "action:aster" }],
          ],
        },
      }
    );
    return;
  }

  if (action === "test_connection") {
    await bot.sendMessage(chatId, "Testing Aster Pro API V3 connection...");
    try {
      if (!cachedOwnerClient) {
        ownerClientInitAttempted = false;
        await initOwnerAsterClient();
      }
      const asterClient = await getAsterClient(chatId);
      if (!asterClient) {
        await bot.sendMessage(chatId,
          "No Aster Pro API configured.\n\nRequired Render env vars:\n" +
          "  ASTER_PRIVATE_KEY = your API Wallet private key\n" +
          "  ASTER_USER_ADDRESS = your main wallet address\n\n" +
          "Get the API Wallet private key from the wallet you used to authorize at asterdex.com/en/api-wallet",
          { reply_markup: { inline_keyboard: [
            [{ text: "Connect with Wallet", callback_data: "aster:connect" }],
            [{ text: "Test Again", callback_data: "aster:test_connection" }],
            [{ text: "Back", callback_data: "action:aster" }],
          ] } }
        );
        return;
      }

      const futuresClient = asterClient.futures || asterClient;
      const mode = asterClient.mode || "V3";
      const results: string[] = [];

      if (mode === "V3") {
        const pk = process.env.ASTER_PRIVATE_KEY || process.env.ASTER_API_WALLET_KEY || "";
        const userAddr = process.env.ASTER_USER_ADDRESS || "";
        const signerAddr = process.env.ASTER_SIGNER_ADDRESS || "";
        try {
          const { Wallet } = await import("ethers");
          const w = new Wallet(pk);
          const derivedAddr = w.address;
          results.push(`Mode: V3 EIP-712`);
          results.push(`Signer (derived from key): ${derivedAddr}`);
          results.push(`Signer (env override): ${signerAddr || "(none - using derived)"}`);
          results.push(`User (main wallet): ${userAddr || "(using derived signer)"}`);
          if (signerAddr && signerAddr.toLowerCase() !== derivedAddr.toLowerCase()) {
            results.push(`WARNING: ASTER_SIGNER_ADDRESS does not match derived key address!`);
          }
        } catch (e: any) {
          results.push(`Key check: ${e.message?.substring(0, 100)}`);
        }
      }

      try {
        const pingOk = await futuresClient.ping();
        results.push(pingOk ? "Ping: OK" : "Ping: Failed");
      } catch (e: any) {
        results.push(`Ping: FAILED - ${e.message?.substring(0, 80)}`);
      }

      try {
        const ticker = await futuresClient.tickerPrice("BTCUSDT");
        const price = ticker?.price || ticker?.lastPrice || (Array.isArray(ticker) ? ticker[0]?.price : null);
        results.push(`Market Data: BTC $${parseFloat(price || "0").toLocaleString()}`);
      } catch (e: any) {
        results.push(`Market Data: FAILED - ${e.message?.substring(0, 80)}`);
      }

      let balanceOk = false;
      try {
        const acct = await futuresClient.account();
        if (acct && typeof acct === "object" && !Array.isArray(acct) && (acct.totalWalletBalance || acct.availableBalance)) {
          const wb = parseFloat(acct.totalWalletBalance || "0");
          const ab = parseFloat(acct.availableBalance || "0");
          const upnl = parseFloat(acct.totalUnrealizedProfit || "0");
          results.push(`Account: $${wb.toFixed(2)} wallet | $${ab.toFixed(2)} available | ${upnl >= 0 ? "+" : ""}$${upnl.toFixed(2)} uPnL`);
          balanceOk = true;
          if (wb < 1) {
            results.push(`Funding: Deposit USDT to Futures Vault to start trading. Use /deposit`);
          }
        } else {
          const bal = await futuresClient.balance();
          if (Array.isArray(bal)) {
            const usdt = bal.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
            if (usdt) {
              results.push(`Balance: $${parseFloat(usdt.availableBalance || usdt.balance || "0").toFixed(2)} USDT available`);
            } else {
              results.push(`Balance: ${bal.length} asset(s) found`);
            }
            balanceOk = true;
          } else {
            results.push(`Balance: Connected (keys: ${Object.keys(acct || {}).slice(0, 8).join(", ")})`);
            balanceOk = true;
          }
        }
      } catch (e: any) {
        const msg = e.message || "";
        if (msg.includes("405")) {
          results.push(`Account: FAILED - 405 Method Not Allowed. Check endpoint path and HTTP method.`);
        } else if (msg.includes("Non-JSON")) {
          results.push(`Account: FAILED - endpoint returned HTML/non-JSON\n  ${msg.substring(0, 180)}`);
        } else if (msg.toLowerCase().includes("no aster user") || msg.toLowerCase().includes("user not found")) {
          results.push(`Account: FAILED - No Aster user found. Authorize API Wallet at asterdex.com/en/api-wallet`);
        } else if (msg.toLowerCase().includes("signature") || msg.toLowerCase().includes("sign")) {
          results.push(`Account: FAILED - EIP-712 signature rejected. Check ASTER_PRIVATE_KEY matches the authorized API Wallet`);
        } else {
          results.push(`Account: FAILED - ${msg.substring(0, 180)}`);
        }
      }

      try {
        const pos = await futuresClient.positions();
        const activePos = Array.isArray(pos) ? pos.filter((p: any) => parseFloat(p.positionAmt || "0") !== 0) : [];
        results.push(`Positions: ${activePos.length} open`);
      } catch (e: any) {
        results.push(`Positions: FAILED - ${e.message?.substring(0, 120)}`);
      }

      const hasErrors = results.some(r => r.includes("FAILED"));
      let msg = "";
      if (!hasErrors && balanceOk) {
        msg += `Pro API V3 Connected\n\n`;
      } else {
        msg += `Pro API V3 Connection Test\nMode: ${mode}\n\n`;
      }
      msg += results.join("\n") + "\n\n";

      if (hasErrors) {
        msg += `Some endpoints failed. Ensure ASTER_PRIVATE_KEY and ASTER_USER_ADDRESS are correct.\nAPI Wallet must be authorized at asterdex.com/en/api-wallet with Perps Trading enabled.`;
      } else {
        msg += `All systems operational!`;
      }

      await bot.sendMessage(chatId, msg, {
        reply_markup: {
          inline_keyboard: [
            ...(hasErrors ? [[{ text: "Reconnect", callback_data: "aster:connect" }]] : []),
            [{ text: "Test Again", callback_data: "aster:test_connection" }],
            [{ text: "Full Status", callback_data: "aster:full_status" }],
            [{ text: "Aster Menu", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Connection test error: ${e.message?.substring(0, 200)}\n\nSet ASTER_PRIVATE_KEY + ASTER_USER_ADDRESS in Render env vars.`, {
        reply_markup: { inline_keyboard: [[{ text: "Connect", callback_data: "aster:connect" }], [{ text: "Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action === "full_status") {
    await bot.sendMessage(chatId, "Loading full Aster status...");
    try {
      const asterClient = await getAsterClient(chatId);
      if (!asterClient) {
        await bot.sendMessage(chatId, "No Aster API connected. Run Test Connection first.", {
          reply_markup: { inline_keyboard: [[{ text: "Test Connection", callback_data: "aster:test_connection" }]] },
        });
        return;
      }
      const futuresClient = asterClient.futures || asterClient;
      const sections: string[] = [];
      sections.push("Aster DEX - Full Status\n");

      let balanceSection = "Futures Vault\n";
      let futuresBalance = 0;
      try {
        const acct = await futuresClient.account();
        if (acct && typeof acct === "object" && !Array.isArray(acct)) {
          const wb = parseFloat(acct.totalWalletBalance || "0");
          const ab = parseFloat(acct.availableBalance || acct.maxWithdrawAmount || "0");
          const upnl = parseFloat(acct.totalUnrealizedProfit || "0");
          const mb = parseFloat(acct.totalMarginBalance || "0");
          futuresBalance = wb;
          balanceSection += `  Wallet Balance: $${wb.toFixed(2)}\n`;
          balanceSection += `  Available Margin: $${ab.toFixed(2)}\n`;
          balanceSection += `  Margin Balance: $${mb.toFixed(2)}\n`;
          balanceSection += `  Unrealized PnL: ${upnl >= 0 ? "+" : ""}$${upnl.toFixed(2)}\n`;
          if (acct.positions && Array.isArray(acct.positions)) {
            const activeFromAcct = acct.positions.filter((p: any) => parseFloat(p.positionAmt || "0") !== 0);
            if (activeFromAcct.length > 0) {
              balanceSection += `  Active Positions: ${activeFromAcct.length}\n`;
            }
          }
        } else {
          const bal = await futuresClient.balance();
          if (Array.isArray(bal)) {
            const usdt = bal.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
            if (usdt) {
              futuresBalance = parseFloat(usdt.crossWalletBalance || usdt.balance || "0");
              balanceSection += `  Wallet Balance: $${futuresBalance.toFixed(2)}\n`;
              balanceSection += `  Available Margin: $${parseFloat(usdt.availableBalance || "0").toFixed(2)}\n`;
              balanceSection += `  Unrealized PnL: ${parseFloat(usdt.crossUnPnl || "0") >= 0 ? "+" : ""}$${parseFloat(usdt.crossUnPnl || "0").toFixed(2)}\n`;
            } else {
              balanceSection += `  ${bal.length} asset(s), no USDT found\n`;
            }
          } else {
            balanceSection += `  Response keys: ${Object.keys(acct || {}).slice(0, 8).join(", ")}\n`;
          }
        }
      } catch (e: any) {
        balanceSection += `  Error: ${e.message?.substring(0, 150)}\n`;
      }
      sections.push(balanceSection);

      let posSection = "Open Positions\n";
      try {
        const allPos = await futuresClient.positions();
        const active = Array.isArray(allPos) ? allPos.filter((p: any) => parseFloat(p.positionAmt || "0") !== 0) : [];
        if (active.length === 0) {
          posSection += "  No open positions\n";
        } else {
          let totalPnl = 0;
          for (const p of active) {
            const amt = parseFloat(p.positionAmt || "0");
            const side = amt > 0 ? "LONG" : "SHORT";
            const entry = parseFloat(p.entryPrice || "0");
            const mark = parseFloat(p.markPrice || "0");
            const upnl = parseFloat(p.unRealizedProfit || "0");
            const lev = p.leverage || "?";
            totalPnl += upnl;
            posSection += `  ${p.symbol} ${side} ${Math.abs(amt)} @ ${lev}x\n`;
            posSection += `    Entry: $${entry.toFixed(2)} | Mark: $${mark.toFixed(2)}\n`;
            posSection += `    uPnL: ${upnl >= 0 ? "+" : ""}$${upnl.toFixed(2)}\n`;
          }
          posSection += `  Total uPnL: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}\n`;
        }
      } catch (e: any) {
        posSection += `  Error: ${e.message?.substring(0, 120)}\n`;
      }
      sections.push(posSection);

      let tradesSection = "Recent Trades\n";
      try {
        const trades = await futuresClient.userTrades("BTCUSDT", 5);
        if (Array.isArray(trades) && trades.length > 0) {
          for (const t of trades) {
            const side = t.side || (t.buyer ? "BUY" : "SELL");
            const price = parseFloat(t.price || "0");
            const qty = parseFloat(t.qty || t.quantity || "0");
            const pnl = t.realizedPnl ? parseFloat(t.realizedPnl) : null;
            const time = t.time ? new Date(t.time).toLocaleString() : "";
            tradesSection += `  ${side} ${t.symbol || "BTCUSDT"} ${qty} @ $${price.toFixed(2)}`;
            if (pnl !== null) tradesSection += ` PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
            if (time) tradesSection += `\n    ${time}`;
            tradesSection += "\n";
          }
        } else {
          tradesSection += "  No recent BTCUSDT trades\n";
        }
      } catch (e: any) {
        tradesSection += `  Error: ${e.message?.substring(0, 100)}\n`;
      }
      sections.push(tradesSection);

      const wallet = getLinkedWallet(chatId);
      if (wallet) {
        let walletSection = "BSC Wallet\n";
        try {
          const usdtContract = new ethers.Contract(BSC_USDT, ["function balanceOf(address) view returns (uint256)"], bnbProviderCached);
          const [uBal, bBal] = await Promise.all([
            usdtContract.balanceOf(wallet).then((b: any) => parseFloat(ethers.formatUnits(b, 18))),
            bnbProviderCached.getBalance(wallet).then((b: any) => parseFloat(ethers.formatEther(b))),
          ]);
          walletSection += `  USDT: $${uBal.toFixed(2)}\n`;
          walletSection += `  BNB: ${bBal.toFixed(4)}\n`;
          walletSection += `  ${wallet.substring(0, 8)}...${wallet.substring(38)}\n`;
        } catch {
          walletSection += `  ${wallet.substring(0, 8)}...${wallet.substring(38)}\n`;
        }
        sections.push(walletSection);
      }

      if (futuresBalance < 1) {
        sections.push("Deposit $10+ USDT to your Futures Vault to start trading.\nUse /deposit for instructions.\n");
      }

      await bot.sendMessage(chatId, sections.join("\n"), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Refresh", callback_data: "aster:full_status" }],
            ...(futuresBalance < 1 ? [[{ text: "Deposit Instructions", callback_data: "aster:deposit_info" }]] : []),
            [{ text: "Fund via Bot Wallet", callback_data: "aster:fund" }],
            [{ text: "Aster Menu", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Status error: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action === "deposit_info") {
    const wallet = getLinkedWallet(chatId);
    let msg = "Deposit USDT to Aster DEX Futures Vault\n\n";
    msg += "Network: BNB Smart Chain (BSC)\n";
    msg += "Token: USDT (BEP-20)\n";
    msg += "Vault Address:\n0x128463A60784c4D3f46c23Af3f65Ed859Ba87974\n\n";
    msg += "Instructions:\n";
    msg += "1. Send USDT (BEP-20) to the vault address above\n";
    msg += "2. Wait for BSC confirmation (~15 seconds)\n";
    msg += "3. Balance appears in Aster Futures within 1-2 minutes\n";
    msg += "4. Use /status to check your updated balance\n\n";
    msg += "Minimum: $1 USDT | Gas: ~0.001 BNB\n";
    if (wallet) {
      msg += `\nYour wallet: ${wallet.substring(0, 8)}...${wallet.substring(38)}`;
    }
    await bot.sendMessage(chatId, msg, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Fund via Bot Wallet", callback_data: "aster:fund" }],
          [{ text: "Check Status", callback_data: "aster:full_status" }],
          [{ text: "Aster Menu", callback_data: "action:aster" }],
        ],
      },
    });
    return;
  }

  if (action === "auto_connect") {
    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId, "No wallet linked. Generate or import a wallet first.", { reply_markup: mainMenuKeyboard(undefined, chatId) });
      return;
    }
    const pk = await resolvePrivateKey(chatId, wallet);
    if (!pk) {
      await bot.sendMessage(chatId,
        "⚠️ Could not access your wallet key. Please re-import your private key, then try 1-Tap Connect again.\n\nOr connect manually with an Aster API key.",
        { reply_markup: { inline_keyboard: [
          [{ text: "👛 Import Wallet", callback_data: "action:linkwallet" }],
          [{ text: "🔑 Connect with API Key", callback_data: "aster:connect" }],
          [{ text: "« Back", callback_data: "action:menu" }],
        ] } }
      );
      return;
    }
    await bot.sendMessage(chatId, "⚡ Setting up your Aster DEX account...\nThis may take a few seconds.");
    try {
      const { asterBrokerOnboard } = await import("./aster-client");
      const result = await asterBrokerOnboard(pk);
      if (!result.success || !result.apiKey || !result.apiSecret) {
        const { createAsterV3FuturesClient } = await import("./aster-client");
        const v3Client = createAsterV3FuturesClient({ user: wallet!, signer: wallet!, signerPrivateKey: pk });
        if (result.userRegistered) {
          console.log(`[Aster] Broker API key creation failed for ${chatId}: ${result.error}. User registered (uid=${result.uid}), attempting V3 direct.`);
          let v3Working = false;
          let balanceWorks = false;
          for (let v3Attempt = 0; v3Attempt < 3; v3Attempt++) {
            try {
              if (v3Attempt > 0) await new Promise(r => setTimeout(r, 2000));
              const noopRes = await v3Client.noop();
              console.log(`[Aster] V3 noop init OK for ${chatId} (attempt ${v3Attempt + 1}):`, JSON.stringify(noopRes).substring(0, 200));
              v3Working = true;
              break;
            } catch (noopErr: any) {
              console.log(`[Aster] V3 noop init FAIL for ${chatId} (attempt ${v3Attempt + 1}):`, noopErr.message?.substring(0, 200));
            }
          }
          if (v3Working) {
            try {
              const bal = await v3Client.balance();
              console.log(`[Aster] V3 balance verify for ${chatId}: success, ${Array.isArray(bal) ? bal.length : 0} entries`);
              balanceWorks = true;
            } catch (verifyErr: any) {
              console.error(`[Aster] V3 balance verify FAIL for ${chatId}:`, verifyErr.message?.substring(0, 200));
              console.log(`[Aster] Attempting V3 account activation for ${chatId}...`);
              const activationAttempts = [
                { name: "listenKey", fn: () => v3Client.listenKey() },
                { name: "account", fn: () => v3Client.account() },
              ];
              for (const attempt of activationAttempts) {
                try {
                  const res = await attempt.fn();
                  console.log(`[Aster] V3 ${attempt.name} for ${chatId}: ${JSON.stringify(res).substring(0, 200)}`);
                } catch (e: any) {
                  console.log(`[Aster] V3 ${attempt.name} FAIL for ${chatId}: ${e.message?.substring(0, 100)}`);
                }
              }
              await new Promise(r => setTimeout(r, 3000));
              for (let balAttempt = 0; balAttempt < 3; balAttempt++) {
                try {
                  if (balAttempt > 0) await new Promise(r => setTimeout(r, 2000));
                  const bal = await v3Client.balance();
                  console.log(`[Aster] V3 balance re-verify for ${chatId} (attempt ${balAttempt + 1}): success`);
                  balanceWorks = true;
                  break;
                } catch (e: any) {
                  console.log(`[Aster] V3 balance re-verify FAIL for ${chatId} (attempt ${balAttempt + 1}): ${e.message?.substring(0, 100)}`);
                }
              }
            }
          }
          const verified = balanceWorks;
          await storage.saveAsterCredentials(chatId.toString(), "V3_DIRECT", "V3_DIRECT");
          auditLog(chatId, "ASTER_V3_DIRECT", `Connected via V3 EIP-712 direct (user registered uid=${result.uid}, API key failed: ${result.error}, v3Working: ${v3Working}, balance verified: ${verified})`);
          if (v3Working && balanceWorks) {
            await bot.sendMessage(chatId,
              `⚡ *Aster DEX — Connected via V3!*\n` +
              `_Powered by Aster DEX_\n\n` +
              `Connected using EIP-712 wallet signing (V3).\n` +
              `Futures trading is fully available — no API keys needed!\n\n` +
              `💡 Next step: Fund your futures account using the button below.`,
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "💵 Fund Account", callback_data: "aster:fund" }],
                    [{ text: "📊 Trade Futures", callback_data: "aster:trade_futures" }],
                    [{ text: "📈 Aster Menu", callback_data: "action:aster" }],
                  ],
                },
              }
            );
          } else {
            await bot.sendMessage(chatId,
              `⚠️ Aster DEX — Partial Setup\n\n` +
              `Your wallet was registered with Aster (uid: ${result.uid}), but the V3 trading API is not recognizing your wallet yet.\n\n` +
              `This can happen if the futures account was not opened properly during setup.\n\n` +
              `Note: If you deposited funds directly on-chain, they are safe in Aster's vault.`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "🔄 Retry Connection", callback_data: "aster:auto_connect" }],
                    [{ text: "🔑 Connect with API Key", callback_data: "aster:connect" }],
                    [{ text: "📈 Aster Menu", callback_data: "action:aster" }],
                  ],
                },
              }
            );
            if (result.debug) {
              try {
                await bot.sendMessage(chatId, `Debug:\n${result.debug.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&').substring(0, 3500)}`);
              } catch {}
            }
          }
          return;
        }
        console.log(`[Aster] Broker onboard login failed for ${chatId}: ${result.error}. Attempting V3 noop registration...`);
        try {
          const noopResult = await v3Client.noop();
          console.log(`[Aster] V3 noop result for ${chatId}:`, JSON.stringify(noopResult).substring(0, 300));
          const balResult = await v3Client.balance();
          console.log(`[Aster] V3 balance verify after noop for ${chatId}: success, ${Array.isArray(balResult) ? balResult.length : 0} entries`);
          await storage.saveAsterCredentials(chatId.toString(), "V3_DIRECT", "V3_DIRECT");
          auditLog(chatId, "ASTER_V3_DIRECT", `Connected via V3 noop registration (broker login failed: ${result.error})`);
          await bot.sendMessage(chatId,
            `⚡ *Aster DEX — Connected via V3!*\n` +
            `_Powered by Aster DEX_\n\n` +
            `Connected using EIP-712 wallet signing (V3).\n` +
            `Futures trading is fully available — no API keys needed!\n\n` +
            `💡 _Spot trading requires manual API key setup._`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "📊 Trade Futures", callback_data: "aster:trade_futures" }],
                  [{ text: "💰 View Balances", callback_data: "aster:balance" }],
                  [{ text: "📈 Aster Menu", callback_data: "action:aster" }],
                ],
              },
            }
          );
          return;
        } catch (v3Err: any) {
          console.error(`[Aster] V3 noop/verify also failed for ${chatId}:`, v3Err.message);
          await bot.sendMessage(chatId,
            `⚠️ Could not create your Aster DEX account\n\n` +
            `Please try:\n` +
            `1. Tap "Try Again" — it may take a moment to register\n` +
            `2. Or connect manually with your Aster API key\n` +
            `3. Make sure your wallet has some BNB for gas`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🔑 Connect with API Key", callback_data: "aster:connect" }],
                  [{ text: "🔄 Try Again", callback_data: "aster:auto_connect" }],
                  [{ text: "« Back", callback_data: "action:aster" }],
                ],
              },
            }
          );
          return;
        }
      }
      await storage.saveAsterCredentials(chatId.toString(), result.apiKey, result.apiSecret);
      try {
        const { createAsterV3FuturesClient } = await import("./aster-client");
        const v3Init = createAsterV3FuturesClient({ user: wallet!, signer: wallet!, signerPrivateKey: pk });
        await v3Init.noop();
        console.log(`[Aster] V3 noop init after broker onboard for ${chatId}: success`);
      } catch (noopErr: any) {
        console.log(`[Aster] V3 noop init after broker onboard for ${chatId}: ${noopErr.message?.substring(0, 100)} (non-fatal)`);
      }
      auditLog(chatId, "ASTER_AUTO_CONNECT", `Aster auto-onboarded via broker API, uid=${result.uid}`);
      await bot.sendMessage(chatId,
        `⚡ *Aster DEX — Connected!*\n` +
        `_Powered by Aster DEX_\n\n` +
        `Your account has been created and API keys generated automatically.\n` +
        `UID: ${result.uid}\n\n` +
        `You're ready to trade!`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💰 View Balances", callback_data: "aster:balance" }],
              [{ text: "📈 Aster Menu", callback_data: "action:aster" }],
            ],
          },
        }
      );
    } catch (e: any) {
      const safeErr = (e.message || 'Unknown error').substring(0, 200).replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ');
      await bot.sendMessage(chatId, `Auto-setup error: ${safeErr}\n\nTry connecting manually.`, {
        reply_markup: { inline_keyboard: [[{ text: "🔑 Connect with API Key", callback_data: "aster:connect" }], [{ text: "« Back", callback_data: "action:menu" }]] },
      });
    }
    return;
  }

  if (action === "connect") {
    pendingAsterConnect.set(chatId, { step: "api_key" });
    await bot.sendMessage(chatId,
      "🔗 *Connect Aster DEX — API Wallet*\n━━━━━━━━━━━━━━━━━━━━\n\n" +
      "Please send your *API Key* now.\n\n" +
      "This is the key from your Aster API Wallet.\n" +
      "_(Not your private key — your API Key from Aster's API Management page)_\n\n" +
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

  if (action === "competition") {
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`CREATE TABLE IF NOT EXISTS "aster_competition" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, name TEXT NOT NULL, description TEXT, start_date TIMESTAMP NOT NULL, end_date TIMESTAMP NOT NULL, prize_pool TEXT DEFAULT '0', status TEXT DEFAULT 'upcoming' NOT NULL, max_entries INTEGER DEFAULT 500, created_at TIMESTAMP DEFAULT now())`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS "aster_competition_entries" (id VARCHAR DEFAULT gen_random_uuid() PRIMARY KEY, competition_id VARCHAR NOT NULL, chat_id TEXT NOT NULL, username TEXT, starting_balance_usdt DOUBLE PRECISION DEFAULT 0, current_equity_usdt DOUBLE PRECISION DEFAULT 0, pnl_usdt DOUBLE PRECISION DEFAULT 0, pnl_percent DOUBLE PRECISION DEFAULT 0, trade_count INTEGER DEFAULT 0, best_trade_pnl DOUBLE PRECISION DEFAULT 0, worst_trade_pnl DOUBLE PRECISION DEFAULT 0, win_count INTEGER DEFAULT 0, loss_count INTEGER DEFAULT 0, referred_by TEXT, referral_count INTEGER DEFAULT 0, joined_at TIMESTAMP DEFAULT now(), last_updated TIMESTAMP DEFAULT now())`);
      await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS referred_by TEXT`).catch(() => {});
      await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS referral_count INTEGER DEFAULT 0`).catch(() => {});

      const activeComps = (await db.execute(sql`SELECT * FROM aster_competition WHERE status IN ('active', 'upcoming') ORDER BY start_date ASC LIMIT 5`)).rows;

      if (activeComps.length === 0) {
        await bot.sendMessage(chatId,
          `🏆 *Trading Competition*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
          `No active competitions right now.\n\nStay tuned — competitions are announced in our community!\n\n` +
          `_Trade on Aster DEX via BUILD4 to be ready when the next one drops._`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📊 My Stats", callback_data: "aster:comp_mystats" }],
                [{ text: "🏆 Leaderboard", callback_data: "aster:comp_leaderboard" }],
                [{ text: "« Aster Menu", callback_data: "action:aster" }],
              ],
            },
          }
        );
        return;
      }

      const comp = activeComps[0] as any;
      const isActive = comp.status === "active";
      const targetDate = isActive ? new Date(comp.end_date) : new Date(comp.start_date);
      const now = new Date();
      const msLeft = Math.max(0, targetDate.getTime() - now.getTime());
      const daysLeft = Math.floor(msLeft / 86400000);
      const hoursLeft = Math.floor((msLeft % 86400000) / 3600000);
      const minsLeft = Math.floor((msLeft % 3600000) / 60000);
      let timeStr = "";
      if (daysLeft > 0) timeStr = `${daysLeft}d ${hoursLeft}h ${minsLeft}m`;
      else if (hoursLeft > 0) timeStr = `${hoursLeft}h ${minsLeft}m`;
      else timeStr = `${minsLeft}m`;

      const [entryCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM aster_competition_entries WHERE competition_id = ${comp.id}`)).rows;
      const [myEntry] = (await db.execute(sql`SELECT * FROM aster_competition_entries WHERE competition_id = ${comp.id} AND chat_id = ${chatId.toString()}`)).rows;
      const entries = parseInt((entryCount as any)?.cnt || "0");

      const statusIcon = isActive ? "🔴 LIVE" : "⏳ UPCOMING";
      let msg = `🏆 *${comp.name}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      msg += `${comp.description || "Trade futures on Aster DEX. Top PnL% wins!"}\n\n`;
      msg += `${statusIcon}\n`;
      msg += `⏰ ${isActive ? "Ends in" : "Starts in"}: *${timeStr}*\n`;
      msg += `🎁 Prize Pool: *${comp.prize_pool || "TBA"}*\n`;
      msg += `👥 Traders: *${entries}*${comp.max_entries ? `/${comp.max_entries}` : ""}\n`;

      const progressBar = comp.max_entries ? (() => {
        const pct = Math.min(100, Math.round(entries / comp.max_entries * 100));
        const filled = Math.round(pct / 10);
        return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${pct}%`;
      })() : null;
      if (progressBar) msg += `📊 Capacity: \`${progressBar}\`\n`;

      if (myEntry) {
        const me = myEntry as any;
        const pnlUsdt = parseFloat(me.pnl_usdt || "0");
        const pnlPct = parseFloat(me.pnl_percent || "0");
        const winRate = (me.win_count + me.loss_count) > 0 ? ((me.win_count / (me.win_count + me.loss_count)) * 100).toFixed(0) : "—";

        const [rankResult] = (await db.execute(sql`SELECT COUNT(*) + 1 as rank FROM aster_competition_entries WHERE competition_id = ${comp.id} AND pnl_percent > ${pnlPct}`)).rows;
        const myRank = parseInt((rankResult as any)?.rank || "0");

        msg += `\n📊 *Your Performance:*\n`;
        msg += `  🏅 Rank: *#${myRank}* of ${entries}\n`;
        msg += `  💰 PnL: \`${pnlUsdt >= 0 ? "+" : ""}$${pnlUsdt.toFixed(2)}\` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n`;
        msg += `  📈 Trades: ${me.trade_count || 0} · Win Rate: ${winRate}%\n`;
        msg += `  ✅ W: ${me.win_count || 0} · ❌ L: ${me.loss_count || 0}\n`;
        if (parseFloat(me.best_trade_pnl || "0") !== 0) {
          msg += `  🎯 Best: \`+$${parseFloat(me.best_trade_pnl || "0").toFixed(2)}\` · Worst: \`$${parseFloat(me.worst_trade_pnl || "0").toFixed(2)}\`\n`;
        }
        msg += `\n_Stats auto-update every 5 min_`;
      } else if (isActive) {
        msg += `\n_Join now to start competing!_`;
      }

      const buttons: TelegramBot.InlineKeyboardButton[][] = [];
      if (!myEntry && isActive) {
        buttons.push([{ text: "✅ Join Competition", callback_data: `aster:comp_join_${comp.id}` }]);
      }
      buttons.push([{ text: "🏆 Leaderboard", callback_data: `aster:comp_leaderboard_${comp.id}` }]);
      if (myEntry) {
        const me = myEntry as any;
        const refCount = parseInt(me.referral_count || "0");
        if (refCount > 0) {
          msg += `\n🤝 Referrals: *${refCount}* traders invited`;
        }
        buttons.push([{ text: "🔄 Refresh Stats", callback_data: `aster:comp_update_${comp.id}` }, { text: "📈 Trade Now", callback_data: "aster:trade_futures" }]);
        buttons.push([{ text: "🔗 Share & Invite Friends", callback_data: `aster:comp_share_${comp.id}` }]);
      } else {
        buttons.push([{ text: "📈 Trade Now", callback_data: "aster:trade_futures" }]);
      }
      buttons.push([{ text: "📊 My History", callback_data: "aster:comp_mystats" }]);
      buttons.push([{ text: "« Aster Menu", callback_data: "action:aster" }]);

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to load competition: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action?.startsWith("comp_join_")) {
    const compId = action.replace("comp_join_", "");
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const [existing] = (await db.execute(sql`SELECT * FROM aster_competition_entries WHERE competition_id = ${compId} AND chat_id = ${chatId.toString()}`)).rows;
      if (existing) {
        await bot.sendMessage(chatId, "You're already in this competition!", { reply_markup: { inline_keyboard: [[{ text: "🏆 Competition", callback_data: "aster:competition" }]] } });
        return;
      }

      const [compCheck] = (await db.execute(sql`SELECT status, max_entries FROM aster_competition WHERE id = ${compId}`)).rows;
      if (!compCheck || (compCheck as any).status !== "active") {
        await bot.sendMessage(chatId, "This competition is not currently active.", { reply_markup: { inline_keyboard: [[{ text: "🏆 Competition", callback_data: "aster:competition" }]] } });
        return;
      }
      const maxE = parseInt((compCheck as any).max_entries || "500");
      const [currentCount] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM aster_competition_entries WHERE competition_id = ${compId}`)).rows;
      if (parseInt((currentCount as any)?.cnt || "0") >= maxE) {
        await bot.sendMessage(chatId, "This competition is full! Check back for the next one.", { reply_markup: { inline_keyboard: [[{ text: "🏆 Competition", callback_data: "aster:competition" }]] } });
        return;
      }

      const joinClient = await getAsterClient(chatId);
      if (!joinClient) {
        await bot.sendMessage(chatId, "Connect your Aster account first to join!", { reply_markup: { inline_keyboard: [[{ text: "🔗 Connect", callback_data: "aster:auto_connect" }], [{ text: "« Back", callback_data: "aster:competition" }]] } });
        return;
      }
      const futuresClient = joinClient.futures || joinClient;
      const balances = await futuresClient.balance().catch(() => []);
      let totalBalance = 0;
      for (const b of (balances as any[])) {
        totalBalance += parseFloat(b.crossWalletBalance || b.balance || "0");
      }

      const username = await (async () => {
        try {
          const chatInfo = await bot!.getChat(chatId);
          return (chatInfo as any).username || (chatInfo as any).first_name || `user_${chatId}`;
        } catch { return `user_${chatId}`; }
      })();

      const [compInfo] = (await db.execute(sql`SELECT name, prize_pool, end_date FROM aster_competition WHERE id = ${compId}`)).rows;
      const compName = (compInfo as any)?.name || "Trading Competition";
      const prize = (compInfo as any)?.prize_pool || "TBA";

      const pendingRef = pendingCompetitionReferrals.get(chatId.toString());
      let referredBy: string | null = null;
      if (pendingRef && pendingRef.compId === compId) {
        referredBy = pendingRef.referrerChatId;
        pendingCompetitionReferrals.delete(chatId.toString());
      }

      if (referredBy) {
        await db.execute(sql`INSERT INTO aster_competition_entries (competition_id, chat_id, username, starting_balance_usdt, current_equity_usdt, referred_by) VALUES (${compId}, ${chatId.toString()}, ${username}, ${totalBalance}, ${totalBalance}, ${referredBy})`);
        await db.execute(sql`UPDATE aster_competition_entries SET referral_count = referral_count + 1 WHERE competition_id = ${compId} AND chat_id = ${referredBy}`).catch(() => {});
        try {
          const referrerChatIdNum = parseInt(referredBy);
          await bot.sendMessage(referrerChatIdNum,
            `🤝 *Competition Referral!*\n\n` +
            `*${username}* joined the competition through your link!\n` +
            `Your referral count has been updated. 🎉`,
            { parse_mode: "Markdown" }
          );
        } catch {}
      } else {
        await db.execute(sql`INSERT INTO aster_competition_entries (competition_id, chat_id, username, starting_balance_usdt, current_equity_usdt) VALUES (${compId}, ${chatId.toString()}, ${username}, ${totalBalance}, ${totalBalance})`);
      }

      const endD = new Date((compInfo as any)?.end_date);
      const dLeft = Math.ceil((endD.getTime() - Date.now()) / 86400000);

      let joinMsg = `✅ *You're In! Welcome to ${compName}!*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📸 Starting Balance: \`$${totalBalance.toFixed(2)} USDT\`\n` +
        `🎁 Prize Pool: *${prize}*\n` +
        `⏰ Time Left: *~${dLeft} days*\n\n`;
      if (referredBy) {
        joinMsg += `🤝 _You were referred by a friend!_\n\n`;
      }
      joinMsg += `*How it works:*\n` +
        `• Your PnL% is tracked from your current balance\n` +
        `• Trade any futures pair on Aster DEX\n` +
        `• Stats auto-update every 5 minutes\n` +
        `• Highest PnL% at the end wins!\n\n` +
        `_Good luck, trader! 🚀_`;

      const joinButtons: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: "📈 Start Trading", callback_data: "aster:trade_futures" }],
        [{ text: "🔗 Share & Invite Friends", callback_data: `aster:comp_share_${compId}` }],
        [{ text: "🏆 Leaderboard", callback_data: `aster:comp_leaderboard_${compId}` }],
        [{ text: "« Competition", callback_data: "aster:competition" }],
      ];

      await bot.sendMessage(chatId, joinMsg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: joinButtons },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to join: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action?.startsWith("comp_update_")) {
    const compId = action.replace("comp_update_", "");
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");

      const updateClient = await getAsterClient(chatId);
      if (!updateClient) {
        await bot.sendMessage(chatId, "Connect your Aster account first.", { reply_markup: { inline_keyboard: [[{ text: "🔗 Connect", callback_data: "aster:auto_connect" }]] } });
        return;
      }
      const futuresClient = updateClient.futures || updateClient;

      const [entry] = (await db.execute(sql`SELECT * FROM aster_competition_entries WHERE competition_id = ${compId} AND chat_id = ${chatId.toString()}`)).rows;
      if (!entry) {
        await bot.sendMessage(chatId, "You haven't joined this competition.", { reply_markup: { inline_keyboard: [[{ text: "🏆 Competition", callback_data: "aster:competition" }]] } });
        return;
      }
      const e = entry as any;

      const [balances, positions, income] = await Promise.all([
        futuresClient.balance().catch(() => []),
        futuresClient.positions().catch(() => []),
        futuresClient.income("REALIZED_PNL", 100).catch(() => []),
      ]);
      let totalBalance = 0;
      for (const b of (balances as any[])) {
        totalBalance += parseFloat(b.crossWalletBalance || b.balance || "0");
      }
      let totalUpnl = 0;
      const openPositions = (positions as any[]).filter((p: any) => parseFloat(p.positionAmt) !== 0);
      for (const p of openPositions) {
        totalUpnl += parseFloat(p.unRealizedProfit || "0");
      }
      const equity = totalBalance + totalUpnl;

      const startBal = parseFloat(e.starting_balance_usdt || "0");
      const pnlUsdt = equity - startBal;
      const pnlPct = startBal > 0 ? (pnlUsdt / startBal * 100) : 0;

      let tradeCount = 0, winCount = 0, lossCount = 0, bestPnl = 0, worstPnl = 0;
      const joinedAt = new Date(e.joined_at).getTime();
      if (Array.isArray(income)) {
        const filtered = income.filter((i: any) => (i.time || 0) >= joinedAt);
        tradeCount = filtered.length;
        for (const inc of filtered) {
          const amt = parseFloat(inc.income || "0");
          if (amt > 0) winCount++; else if (amt < 0) lossCount++;
          if (amt > bestPnl) bestPnl = amt;
          if (amt < worstPnl) worstPnl = amt;
        }
      }

      await db.execute(sql`UPDATE aster_competition_entries SET current_equity_usdt = ${equity}, pnl_usdt = ${pnlUsdt}, pnl_percent = ${pnlPct}, trade_count = ${tradeCount}, win_count = ${winCount}, loss_count = ${lossCount}, best_trade_pnl = ${bestPnl}, worst_trade_pnl = ${worstPnl}, last_updated = now() WHERE competition_id = ${compId} AND chat_id = ${chatId.toString()}`);

      const winRate = (winCount + lossCount) > 0 ? ((winCount / (winCount + lossCount)) * 100).toFixed(0) : "—";
      await bot.sendMessage(chatId,
        `📊 *Stats Updated!*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🏦 Equity: \`$${equity.toFixed(2)}\`\n` +
        `💰 PnL: \`${pnlUsdt >= 0 ? "+" : ""}$${pnlUsdt.toFixed(2)}\` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n` +
        `📈 Trades: ${tradeCount} · Win Rate: ${winRate}%\n` +
        `📊 Open Positions: ${openPositions.length}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏆 Leaderboard", callback_data: `aster:comp_leaderboard_${compId}` }],
              [{ text: "« Aster Menu", callback_data: "action:aster" }],
            ],
          },
        }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `Update failed: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action?.startsWith("comp_leaderboard")) {
    const compId = action.replace("comp_leaderboard_", "").replace("comp_leaderboard", "");
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");
      let query;
      if (compId) {
        query = await db.execute(sql`SELECT * FROM aster_competition_entries WHERE competition_id = ${compId} ORDER BY pnl_percent DESC LIMIT 20`);
      } else {
        query = await db.execute(sql`SELECT * FROM aster_competition_entries ORDER BY pnl_percent DESC LIMIT 20`);
      }
      const entries = query.rows;

      if (entries.length === 0) {
        await bot.sendMessage(chatId, "🏆 *Leaderboard*\n\nNo entries yet. Be the first to join!", {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🏆 Competition", callback_data: "aster:competition" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
        });
        return;
      }

      const medals = ["🥇", "🥈", "🥉"];
      let msg = `🏆 *Trading Competition Leaderboard*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

      let foundMe = false;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i] as any;
        const rank = i < 3 ? medals[i] : `\`${(i + 1).toString().padStart(2, " ")}.\``;
        const pnlPct = parseFloat(e.pnl_percent || "0");
        const pnlUsdt = parseFloat(e.pnl_usdt || "0");
        const name = e.username || `user_${(e.chat_id || "").substring(0, 6)}`;
        const isMe = e.chat_id === chatId.toString();
        if (isMe) foundMe = true;
        const winRate = (e.win_count + e.loss_count) > 0 ? ((e.win_count / (e.win_count + e.loss_count)) * 100).toFixed(0) : "—";
        const nameDisplay = isMe ? `*${name} ← YOU*` : name;
        msg += `${rank} ${nameDisplay}\n`;
        msg += `   \`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\` · \`${pnlUsdt >= 0 ? "+" : ""}$${pnlUsdt.toFixed(2)}\`\n`;
        msg += `   ${e.trade_count || 0} trades · WR: ${winRate}%\n`;
        if (i < entries.length - 1) msg += `\n`;
      }

      if (!foundMe) {
        msg += `\n─────────────────\n_You haven't joined this competition yet_`;
      }
      msg += `\n\n_Updated every 5 min · ${entries.length} traders_`;

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: action }],
            [{ text: "🏆 Competition", callback_data: "aster:competition" }],
            [{ text: "« Aster Menu", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to load leaderboard: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action?.startsWith("comp_share_")) {
    const compId = action.replace("comp_share_", "");
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const [compInfo] = (await db.execute(sql`SELECT name, prize_pool, end_date FROM aster_competition WHERE id = ${compId}`)).rows;
      if (!compInfo) {
        await bot.sendMessage(chatId, "Competition not found.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "aster:competition" }]] } });
        return;
      }
      const ci = compInfo as any;
      const endDate = new Date(ci.end_date);
      const dLeft = Math.ceil((endDate.getTime() - Date.now()) / 86400000);

      const botUsername = (await bot.getMe()).username;
      const refLink = `https://t.me/${botUsername}?start=compref_${compId}_${chatId}`;

      const shareText = `🏆 *Share Your Competition Link*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Invite friends to join *${ci.name}*!\n\n` +
        `🎁 Prize Pool: *${ci.prize_pool || "TBA"}*\n` +
        `⏰ ${dLeft} days left\n\n` +
        `📋 *Your Referral Link:*\n\`${refLink}\`\n\n` +
        `Share this link — when friends join through it, they'll be tracked as your referrals!\n\n` +
        `_Forward the message below to your groups and friends:_`;

      await bot.sendMessage(chatId, shareText, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🏆 Competition", callback_data: "aster:competition" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });

      const forwardMsg = `🏆 *JOIN THE ${ci.name.toUpperCase()}!*\n\n` +
        `💰 Prize Pool: *${ci.prize_pool || "TBA"}*\n` +
        `⏰ ${dLeft} days left to compete!\n\n` +
        `Trade futures on Aster DEX via BUILD4 — top PnL% wins!\n\n` +
        `👉 Join now: ${refLink}\n\n` +
        `_Powered by BUILD4 x Aster DEX_ 🚀`;
      await bot.sendMessage(chatId, forwardMsg, { parse_mode: "Markdown" });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 200)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "aster:competition" }]] } });
    }
    return;
  }

  if (action === "comp_mystats") {
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const entries = (await db.execute(sql`SELECT ce.*, c.name as comp_name FROM aster_competition_entries ce JOIN aster_competition c ON ce.competition_id = c.id WHERE ce.chat_id = ${chatId.toString()} ORDER BY ce.joined_at DESC LIMIT 5`)).rows;

      if (entries.length === 0) {
        await bot.sendMessage(chatId, "📊 *My Competition Stats*\n\nYou haven't joined any competitions yet.", {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🏆 Competition", callback_data: "aster:competition" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
        });
        return;
      }

      let msg = `📊 *My Competition History*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      for (const e of entries) {
        const entry = e as any;
        const pnlPct = parseFloat(entry.pnl_percent || "0");
        const pnlUsdt = parseFloat(entry.pnl_usdt || "0");
        msg += `*${entry.comp_name || "Competition"}*\n`;
        msg += `  PnL: \`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%\` · \`${pnlUsdt >= 0 ? "+" : ""}$${pnlUsdt.toFixed(2)}\`\n`;
        msg += `  Trades: ${entry.trade_count || 0} · W/L: ${entry.win_count || 0}/${entry.loss_count || 0}\n\n`;
      }

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🏆 Competition", callback_data: "aster:competition" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action === "risk_settings") {
    const limits = await storage.getAsterTradingLimits(chatId.toString());
    const l = limits || { maxDailyLossUsdt: 100, maxPositionSizeUsdt: 50, maxLeverage: 10, maxOpenPositions: 3, autoTradeEnabled: false, dailyPnlUsdt: 0 };
    const autoLabel = l.autoTradeEnabled ? "ON ✅" : "OFF ❌";
    let msg = `⚙️ *Aster Risk Management*\n\n`;
    msg += `🤖 Auto-Trade: ${autoLabel}\n`;
    msg += `📉 Max Daily Loss: $${l.maxDailyLossUsdt}\n`;
    msg += `💰 Max Position Size: $${l.maxPositionSizeUsdt}\n`;
    msg += `⚡ Max Leverage: ${l.maxLeverage}x\n`;
    msg += `📊 Max Open Positions: ${l.maxOpenPositions}\n\n`;
    msg += `📋 Today's PnL: ${l.dailyPnlUsdt >= 0 ? "+" : ""}$${l.dailyPnlUsdt.toFixed(2)}\n`;
    if (l.dailyPnlUsdt <= -(l.maxDailyLossUsdt)) {
      msg += `⚠️ *Daily loss limit reached — auto-trading paused*`;
    }
    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: `🤖 Auto-Trade: ${autoLabel}`, callback_data: "aster:risk_toggle_auto" }],
          [{ text: "📉 Daily Loss Limit", callback_data: "aster:risk_set_loss" }, { text: "💰 Position Size", callback_data: "aster:risk_set_size" }],
          [{ text: "⚡ Max Leverage", callback_data: "aster:risk_set_lev" }, { text: "📊 Max Positions", callback_data: "aster:risk_set_pos" }],
          [{ text: "🔄 Reset Daily PnL", callback_data: "aster:risk_reset_pnl" }],
          [{ text: "« Aster Menu", callback_data: "action:aster" }],
        ],
      },
    });
    return;
  }

  if (action === "risk_toggle_auto") {
    const limits = await storage.getAsterTradingLimits(chatId.toString());
    const newVal = !(limits?.autoTradeEnabled ?? false);
    await storage.saveAsterTradingLimits(chatId.toString(), { autoTradeEnabled: newVal });
    await bot.sendMessage(chatId, `🤖 Auto-Trade ${newVal ? "ENABLED ✅" : "DISABLED ❌"}\n\n${newVal ? "The AI agent will now automatically open futures positions based on market analysis, respecting your risk limits." : "Auto-trading is now off. You can still trade manually."}`, {
      reply_markup: { inline_keyboard: [[{ text: "⚙️ Risk Settings", callback_data: "aster:risk_settings" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
    });
    return;
  }

  if (action === "risk_reset_pnl") {
    await storage.saveAsterTradingLimits(chatId.toString(), { dailyPnlUsdt: 0, dailyPnlResetAt: new Date() });
    await bot.sendMessage(chatId, "✅ Daily PnL counter reset to $0.", {
      reply_markup: { inline_keyboard: [[{ text: "⚙️ Risk Settings", callback_data: "aster:risk_settings" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
    });
    return;
  }

  if (action === "risk_set_loss" || action === "risk_set_size" || action === "risk_set_lev" || action === "risk_set_pos") {
    const labels: Record<string, { label: string; field: string; min: number; max: number; unit: string }> = {
      risk_set_loss: { label: "Max Daily Loss", field: "maxDailyLossUsdt", min: 10, max: 10000, unit: "USDT" },
      risk_set_size: { label: "Max Position Size", field: "maxPositionSizeUsdt", min: 10, max: 5000, unit: "USDT" },
      risk_set_lev: { label: "Max Leverage", field: "maxLeverage", min: 1, max: 125, unit: "x" },
      risk_set_pos: { label: "Max Open Positions", field: "maxOpenPositions", min: 1, max: 20, unit: "" },
    };
    const cfg = labels[action];
    const presets: Record<string, number[]> = {
      risk_set_loss: [25, 50, 100, 250, 500],
      risk_set_size: [25, 50, 100, 250, 500],
      risk_set_lev: [2, 3, 5, 10, 20],
      risk_set_pos: [1, 2, 3, 5, 10],
    };
    const buttons = presets[action].map(v => ({ text: `${v}${cfg.unit}`, callback_data: `aster:risk_val_${cfg.field}_${v}` }));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    rows.push([{ text: "« Risk Settings", callback_data: "aster:risk_settings" }]);
    await bot.sendMessage(chatId, `Set *${cfg.label}*:\n\nRange: ${cfg.min} - ${cfg.max} ${cfg.unit}`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  if (action.startsWith("risk_val_")) {
    const parts = action.replace("risk_val_", "").split("_");
    const val = parseInt(parts.pop()!);
    const field = parts.join("_");
    const fieldMap: Record<string, string> = { maxDailyLossUsdt: "Max Daily Loss", maxPositionSizeUsdt: "Max Position Size", maxLeverage: "Max Leverage", maxOpenPositions: "Max Open Positions" };
    await storage.saveAsterTradingLimits(chatId.toString(), { [field]: val } as any);
    await bot.sendMessage(chatId, `✅ ${fieldMap[field] || field} set to ${val}`, {
      reply_markup: { inline_keyboard: [[{ text: "⚙️ Risk Settings", callback_data: "aster:risk_settings" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
    });
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

  if (action === "fund") {
    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId, "❌ No wallet linked. Create one first via /wallet.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:aster" }]] } });
      return;
    }

    let creds: any = null;
    try { creds = await storage.getAsterCredentials(chatId.toString()); } catch {}
    const pk = await resolvePrivateKey(chatId, wallet);
    const isV3 = !!pk; // V3 mode = user has private key for on-chain vault deposit

    try {
      const futuresClient = client.futures || client;
      const spotClient = client.spot || null;

      let noopDebug = "";
      let balDebug = "";
      let v3Error = false;

      if (isV3) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const noopRes = await futuresClient.noop();
            noopDebug = `noop OK`;
            console.log(`[AsterFund] noop OK for ${chatId} (attempt ${attempt + 1}):`, JSON.stringify(noopRes).substring(0, 200));
            break;
          } catch (noopErr: any) {
            const errMsg = noopErr.message || "";
            noopDebug = errMsg.includes("No aster user") ? "wallet not registered on Aster V3" : `noop error: ${errMsg.substring(0, 80)}`;
            if (errMsg.includes("No aster user")) v3Error = true;
            console.log(`[AsterFund] noop FAIL for ${chatId} (attempt ${attempt + 1}):`, errMsg.substring(0, 200));
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
          }
        }
      }

      const [futuresBalances, walletBal] = await Promise.all([
        (async () => {
          if (v3Error) {
            balDebug = "skipped (wallet not registered)";
            return [];
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const bal = await futuresClient.balance();
              balDebug = `OK: ${Array.isArray(bal) ? bal.length : 0} entries`;
              console.log(`[AsterFund] balance OK for ${chatId} (attempt ${attempt + 1}):`, JSON.stringify(bal).substring(0, 500));
              return bal;
            } catch (e: any) {
              const errMsg = e.message || "";
              balDebug = errMsg.substring(0, 100);
              if (errMsg.includes("No aster user")) v3Error = true;
              console.log(`[AsterFund] balance FAIL for ${chatId} (attempt ${attempt + 1}):`, errMsg.substring(0, 300));
              if (attempt < 1) await new Promise(r => setTimeout(r, 1500));
            }
          }
          if (v3Error) {
            try {
              const acct = await futuresClient.account();
              balDebug += ` | acct: ${JSON.stringify(acct).substring(0, 100)}`;
              console.log(`[AsterFund] account response for ${chatId}:`, JSON.stringify(acct).substring(0, 500));
            } catch (acctErr: any) {
              balDebug += ` | acct: ${acctErr.message?.substring(0, 80)}`;
              console.log(`[AsterFund] account FAIL for ${chatId}:`, acctErr.message?.substring(0, 200));
            }
          }
          return [];
        })(),
        (async () => {
          try {
            const usdtContract = new ethers.Contract(BSC_USDT, ["function balanceOf(address) view returns (uint256)"], bnbProviderCached);
            const bal = await usdtContract.balanceOf(wallet);
            return parseFloat(ethers.formatUnits(bal, 18));
          } catch { return 0; }
        })(),
      ]);

      let vaultBal = 0;
      if (isV3) {
        try {
          const vaultAddr = "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974";
          const usdtContract = new ethers.Contract(BSC_USDT, ["function balanceOf(address) view returns (uint256)"], bnbProviderCached);
          const vBal = await usdtContract.balanceOf(vaultAddr);
          vaultBal = parseFloat(ethers.formatUnits(vBal, 18));
        } catch {}
      }

      let futuresBal = 0;
      let balSource = "";
      if (isV3) {
        const localTrades = await storage.getAsterLocalTrades(chatId.toString());
        const deposits = localTrades.filter((t: any) => t.type === "DEPOSIT");
        const totalDeposited = deposits.reduce((sum: number, t: any) => sum + (t.price || 0), 0);
        if (totalDeposited > 0) {
          futuresBal = totalDeposited;
          balSource = "tracked deposits";
        }
        const futuresUsdt = Array.isArray(futuresBalances)
          ? (futuresBalances as any[]).find((b: any) => b.asset === "USDT" || b.asset === "usdt")
          : null;
        if (futuresUsdt) {
          futuresBal = parseFloat(futuresUsdt.availableBalance || futuresUsdt.crossWalletBalance || futuresUsdt.balance || "0");
          balSource = "API";
        }
      } else {
        const futuresUsdt = Array.isArray(futuresBalances)
          ? (futuresBalances as any[]).find((b: any) => b.asset === "USDT" || b.asset === "usdt")
          : (futuresBalances as any)?.balances?.find?.((b: any) => b.asset === "USDT" || b.asset === "usdt") || null;
        futuresBal = futuresUsdt ? parseFloat(futuresUsdt.availableBalance || futuresUsdt.crossWalletBalance || futuresUsdt.balance || "0") : 0;
      }

      let msg = `💵 *Fund Aster Futures — All In Telegram*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      msg += `🔗 *Your Wallet (BSC):*\n\`${wallet}\`\n\n`;
      msg += `📊 *Balance Overview:*\n`;
      msg += `  💳 Wallet USDT: \`$${walletBal.toFixed(2)}\`\n`;
      msg += `  🏦 Futures Vault Margin: \`$${futuresBal > 0 ? futuresBal.toFixed(2) : "0.00"}\`${balSource ? ` (${balSource})` : ""}\n\n`;

      if (isV3) {
        msg += `*Network:* BNB Smart Chain (BSC)\n`;
        msg += `*Token:* USDT (BEP-20)\n\n`;

        const depositButtons: TelegramBot.InlineKeyboardButton[][] = [];
        if (walletBal >= 1) {
          msg += `✅ You have \`$${walletBal.toFixed(2)}\` USDT ready!\n`;
          msg += `Choose an amount to deposit into Futures Vault:\n\n`;
          msg += `*Steps:*\n`;
          msg += `1. Select amount below\n`;
          msg += `2. USDT moves on-chain to Aster's vault\n`;
          msg += `3. Margin appears in ~1 min — then trade!\n`;
          const presets = [10, 25, 50, 100].filter(v => v <= walletBal);
          if (presets.length > 0) {
            depositButtons.push(presets.map(v => ({ text: `💵 $${v}`, callback_data: `aster:v3dep_${v}` })));
          }
          depositButtons.push([{ text: `⚡ Deposit All ($${walletBal.toFixed(2)})`, callback_data: `aster:v3dep_max` }]);
          depositButtons.push([{ text: "✏️ Custom Amount", callback_data: "aster:v3dep_custom" }]);
        } else if (futuresBal >= 1) {
          msg += `✅ Your futures vault is funded and ready to trade!`;
        } else {
          msg += `⚠️ *No USDT in wallet.* To fund:\n\n`;
          msg += `*Step 1:* Copy your wallet address above\n`;
          msg += `*Step 2:* Send USDT (BEP-20) on BSC to that address\n`;
          msg += `  _(from MetaMask, Trust Wallet, or any exchange)_\n`;
          msg += `*Step 3:* Tap 🔄 Refresh below\n`;
          msg += `*Step 4:* Choose deposit amount\n\n`;
          msg += `⚠️ *Only send USDT on BSC network. Wrong chain = lost funds.*`;
        }
        depositButtons.push([{ text: "📋 Confirm TX Hash", callback_data: "aster:confirm_deposit" }]);
        depositButtons.push([{ text: "🔄 Refresh", callback_data: "aster:fund" }]);
        depositButtons.push([{ text: "« Aster Menu", callback_data: "action:aster" }]);
        await bot.sendMessage(chatId, msg, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: depositButtons },
        });
      } else {
        let depositAddr = "";
        if (spotClient) {
          try {
            const addrResult = await spotClient.getDepositAddress("USDT", "BSC");
            depositAddr = addrResult?.address || "";
          } catch (e: any) {
            console.log("[AsterFund] getDepositAddress error:", e.message?.substring(0, 100));
          }
        }

        if (depositAddr) {
          msg += `📥 *Aster Deposit Address (BSC):*\n\`${depositAddr}\`\n\n`;
          msg += `Choose how to fund:`;
          const buttons: TelegramBot.InlineKeyboardButton[][] = [];
          if (walletBal >= 1) {
            buttons.push([{ text: `⚡ Send from Bot Wallet ($${walletBal.toFixed(2)} USDT)`, callback_data: "aster:fund_send" }]);
          }
          buttons.push([{ text: "📋 Copy Deposit Address", callback_data: "aster:fund_addr" }]);
          buttons.push([{ text: "🔄 Refresh", callback_data: "aster:fund" }, { text: "« Aster Menu", callback_data: "action:aster" }]);
          await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
        } else {
          msg += `⚠️ Could not fetch Aster deposit address.\n\n`;
          msg += `You can fund manually:\n`;
          msg += `Send USDT (BEP-20) on BSC to your bot wallet, then use the Fund button to deposit into Aster Futures vault.\n`;
          msg += `Everything happens right here — no need to visit any website.`;
          await bot.sendMessage(chatId, msg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Retry", callback_data: "aster:fund" }],
                [{ text: "« Aster Menu", callback_data: "action:aster" }],
              ],
            },
          });
        }
      }
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to load fund info: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action.startsWith("v3dep_")) {
    const wallet = getLinkedWallet(chatId);
    if (!wallet) {
      await bot.sendMessage(chatId, "❌ No wallet linked.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:aster" }]] } });
      return;
    }
    const pk = await resolvePrivateKey(chatId, wallet);
    if (!pk) {
      await bot.sendMessage(chatId, "❌ Could not access wallet key. Re-import your wallet.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:aster" }]] } });
      return;
    }

    if (action === "v3dep_custom") {
      pendingAsterTrade.set(chatId, { step: "v3dep_amount", market: "futures" } as any);
      await bot.sendMessage(chatId,
        "💵 *Deposit USDT to Aster Futures*\n━━━━━━━━━━━━━━━━━━━━\n\nEnter the amount of USDT to deposit (e.g. 10, 25, 50):\n\nOr type /cancel to go back.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    let depositAmount: number;
    if (action === "v3dep_max") {
      const usdtContract = new ethers.Contract(BSC_USDT, ["function balanceOf(address) view returns (uint256)"], bnbProviderCached);
      const bal = await usdtContract.balanceOf(wallet);
      depositAmount = parseFloat(ethers.formatUnits(bal, 18));
      depositAmount = Math.floor(depositAmount * 100) / 100;
    } else {
      depositAmount = parseFloat(action.replace("v3dep_", ""));
    }

    if (!depositAmount || depositAmount < 1) {
      await bot.sendMessage(chatId, "❌ Invalid amount. Minimum deposit is $1 USDT.", { reply_markup: { inline_keyboard: [[{ text: "« Fund", callback_data: "aster:fund" }]] } });
      return;
    }

    if (!checkRateLimit(`tx:${chatId}`, 2, 30000)) {
      await bot.sendMessage(chatId, "⏳ Please wait before sending another transaction.", { reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] } });
      return;
    }

    await bot.sendMessage(chatId, `⏳ Depositing \`$${depositAmount}\` USDT into Aster Futures vault...\nThis requires 1-2 on-chain transactions.`, { parse_mode: "Markdown" });
    sendTyping(chatId);

    try {
      const { asterV3Deposit } = await import("./aster-client");
      const mainWallet = process.env.ASTER_USER_ADDRESS || "";
      const result = await asterV3Deposit(pk, depositAmount, 0, mainWallet || undefined);
      if (!result.success) throw new Error(result.error || "Deposit failed");

      try {
        await storage.saveAsterLocalTrade({
          chatId: chatId.toString(),
          orderId: result.txHash || "deposit",
          symbol: "USDT",
          side: "BUY",
          type: "DEPOSIT",
          quantity: depositAmount,
          executedQty: depositAmount,
          price: depositAmount,
          avgPrice: 1,
          status: "CONFIRMED",
          reduceOnly: false,
          leverage: 1,
        });
        console.log(`[AsterLocal] Saved deposit $${depositAmount} for ${chatId}`);
      } catch {}

      balanceCache.delete(wallet);

      const futuresClient = client.futures || client;
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          await futuresClient.noop();
          const bal = await futuresClient.balance();
          const usdtEntry = Array.isArray(bal) ? bal.find((b: any) => b.asset === "USDT" || b.asset === "usdt") : null;
          const avail = usdtEntry ? parseFloat(usdtEntry.availableBalance || usdtEntry.crossWalletBalance || usdtEntry.balance || "0") : 0;
          console.log(`[AsterFund] post-deposit balance check ${i + 1} for ${chatId}: $${avail}`);
          if (avail > 0) break;
        } catch (e: any) {
          console.log(`[AsterFund] post-deposit check ${i + 1} error for ${chatId}:`, e.message?.substring(0, 200));
        }
      }

      let successMsg = `✅ *Deposit Successful!*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      if (result.error) {
        successMsg += `${result.error}\n\n`;
        successMsg += `[View TX](https://bscscan.com/tx/${result.txHash})\n`;
      } else {
        successMsg += `Deposited \`$${depositAmount} USDT\` into Aster Futures\n\n`;
        successMsg += `[View TX](https://bscscan.com/tx/${result.txHash})\n\n`;
        successMsg += `⏱️ Balance should update within 1-2 minutes.\n`;
        successMsg += `Use the Check Balance button to verify.\n`;
        successMsg += `You can now start trading!`;
      }

      await bot.sendMessage(chatId, successMsg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: "📈 Trade Futures", callback_data: "aster:trade_futures" }],
            [{ text: "💰 Check Balance", callback_data: "aster:balance" }],
            [{ text: "« Aster Menu", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Deposit failed: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "aster:fund" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action === "fund_addr") {
    let creds: any = null;
    try { creds = await storage.getAsterCredentials(chatId.toString()); } catch {}
    const spotClient = client.spot || null;
    if (spotClient) {
      try {
        const addrResult = await spotClient.getDepositAddress("USDT", "BSC");
        if (addrResult?.address) {
          await bot.sendMessage(chatId,
            `📥 *Your Aster USDT Deposit Address (BSC)*\n\n\`${addrResult.address}\`\n\nSend USDT (BEP-20) to this address.`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Fund Menu", callback_data: "aster:fund" }]] } }
          );
          return;
        }
      } catch {}
    }
    await bot.sendMessage(chatId, "Could not fetch deposit address. Try again.", { reply_markup: { inline_keyboard: [[{ text: "« Fund Menu", callback_data: "aster:fund" }]] } });
    return;
  }

  if (action === "confirm_deposit") {
    pendingAsterTrade.set(chatId, { step: "confirm_tx_hash", market: "futures" } as any);
    await bot.sendMessage(chatId,
      "📋 *Confirm Deposit via TX Hash*\n━━━━━━━━━━━━━━━━━━━━\n\n" +
      "Paste your BSC transaction hash below.\n" +
      "I'll verify the USDT transfer on-chain.\n\n" +
      "Example: `0xabc123...`\n\n" +
      "Or type /cancel to go back.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "fund_send") {
    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;
    pendingAsterTrade.set(chatId, { step: "fund_amount", market: "futures" } as any);
    await bot.sendMessage(chatId,
      "💵 *Send USDT to Aster*\n━━━━━━━━━━━━━━━━━━━━\n\nEnter the amount of USDT to deposit (e.g. 50, 100, 500):\n\nOr type /cancel to go back.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "fund_confirm") {
    const state = pendingAsterTrade.get(chatId);
    if (!state || (state as any).step !== "fund_confirm") {
      await bot.sendMessage(chatId, "No pending deposit. Start again.", { reply_markup: { inline_keyboard: [[{ text: "💵 Fund Account", callback_data: "aster:fund" }]] } });
      return;
    }
    if (!checkRateLimit(`tx:${chatId}`, 2, 30000)) {
      await bot.sendMessage(chatId, "⏳ Please wait before sending another transaction.", { reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] } });
      return;
    }
    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;
    const depositAddr = (state as any).depositAddress;
    const amount = (state as any).fundAmount;
    if (!depositAddr || !amount) {
      await bot.sendMessage(chatId, "Deposit info missing. Start again.", { reply_markup: { inline_keyboard: [[{ text: "💵 Fund Account", callback_data: "aster:fund" }]] } });
      pendingAsterTrade.delete(chatId);
      return;
    }

    await bot.sendMessage(chatId, `⏳ Sending ${amount} USDT to your Aster account...`);
    sendTyping(chatId);

    try {
      const pk = await resolvePrivateKey(chatId, wallet);
      if (!pk) throw new Error("Private key not found. Re-import your wallet.");
      const signer = new ethers.Wallet(pk, bnbProviderCached);
      const usdtContract = new ethers.Contract(BSC_USDT, [
        "function transfer(address to, uint256 amount) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ], signer);
      const amountWei = ethers.parseUnits(amount, 18);
      const balance = await usdtContract.balanceOf(wallet);
      if (balance < amountWei) throw new Error(`Insufficient USDT. Have $${parseFloat(ethers.formatUnits(balance, 18)).toFixed(2)}, need $${amount}`);
      const tx = await usdtContract.transfer(depositAddr, amountWei);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");
      pendingAsterTrade.delete(chatId);
      balanceCache.delete(wallet);

      let successMsg = `✅ *Deposit Sent!*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      successMsg += `Sent \`${amount} USDT\` to Aster\n\n`;
      successMsg += `[View TX](https://bscscan.com/tx/${receipt.hash})\n\n`;
      successMsg += `⏱️ Funds should appear in your Aster account within 1-3 minutes.\n`;
      successMsg += `💡 If deposited to Spot, use the transfer button below to move to Futures.`;

      const spotClient = client.spot || null;
      const postButtons: TelegramBot.InlineKeyboardButton[][] = [];
      if (spotClient) {
        postButtons.push([{ text: "🔄 Transfer Spot → Futures", callback_data: "aster:fund_spot_to_futures" }]);
      }
      postButtons.push([{ text: "💰 Check Balance", callback_data: "aster:balance" }]);
      postButtons.push([{ text: "« Aster Menu", callback_data: "action:aster" }]);

      await bot.sendMessage(chatId, successMsg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: postButtons },
      });
    } catch (e: any) {
      pendingAsterTrade.delete(chatId);
      await bot.sendMessage(chatId, `❌ Deposit failed: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "aster:fund" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action === "fund_spot_to_futures") {
    const spotClient = client.spot || null;
    if (!spotClient) {
      await bot.sendMessage(chatId, "Spot client not available. You may be in V3 mode.", { reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] } });
      return;
    }
    try {
      const spotAccount = await spotClient.account().catch(() => ({ balances: [] }));
      const usdtBal = (spotAccount.balances || []).find((b: any) => b.asset === "USDT");
      const available = usdtBal ? parseFloat(usdtBal.free || "0") : 0;
      if (available < 0.01) {
        await bot.sendMessage(chatId, "No USDT available in Spot to transfer. Deposits may still be processing (1-3 min).", {
          reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "aster:fund_spot_to_futures" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
        });
        return;
      }
      pendingAsterTrade.set(chatId, { step: "fund_transfer_amount", market: "futures", spotAvailable: available.toString() } as any);
      await bot.sendMessage(chatId,
        `🔄 *Spot → Futures Transfer*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Available in Spot: \`$${available.toFixed(2)} USDT\`\n\n` +
        `Enter amount to move to Futures (or type "all"):`,
        { parse_mode: "Markdown" }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action === "fund_transfer_confirm") {
    const state = pendingAsterTrade.get(chatId);
    if (!state || (state as any).step !== "fund_transfer_confirm") {
      await bot.sendMessage(chatId, "No pending transfer.", { reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] } });
      return;
    }
    const spotClient = client.spot || null;
    if (!spotClient) return;
    const amount = (state as any).transferAmount;
    try {
      await spotClient.internalTransfer("USDT", amount, 1);
      pendingAsterTrade.delete(chatId);
      await bot.sendMessage(chatId,
        `✅ *Transfer Complete!*\n\nMoved \`$${amount} USDT\` from Spot → Futures.\n\nYou're ready to trade!`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Futures Trade", callback_data: "aster:trade_futures" }],
              [{ text: "💰 Check Balance", callback_data: "aster:balance" }],
              [{ text: "« Aster Menu", callback_data: "action:aster" }],
            ],
          },
        }
      );
    } catch (e: any) {
      pendingAsterTrade.delete(chatId);
      const errMsg = e.message || "";
      if (errMsg.includes("not support") || errMsg.includes("not found") || errMsg.includes("404")) {
        await bot.sendMessage(chatId,
          `ℹ️ Internal transfers not available via API.\n\nYour USDT deposit may land directly in Futures. Check your balance:`,
          { reply_markup: { inline_keyboard: [[{ text: "💰 Check Balance", callback_data: "aster:balance" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] } }
        );
      } else {
        await bot.sendMessage(chatId, `❌ Transfer failed: ${errMsg.substring(0, 200)}`, {
          reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "aster:fund_spot_to_futures" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
        });
      }
    }
    return;
  }

  if (action === "markets") {
    await bot.sendMessage(chatId, "📊 Loading market data...");
    try {
      const futuresClient = client.futures || client;
      const topSymbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "SUIUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "PEPEUSDT", "WIFUSDT"];
      const [allTickers, allFunding] = await Promise.all([
        futuresClient.ticker().catch(() => []),
        futuresClient.fundingRate(undefined, 100).catch(() => []),
      ]);
      const tickerArr = Array.isArray(allTickers) ? allTickers : [allTickers];
      const fundingArr = Array.isArray(allFunding) ? allFunding : [];
      const fundingMap = new Map<string, any>();
      for (const f of fundingArr) {
        if (!fundingMap.has(f.symbol)) fundingMap.set(f.symbol, f);
      }

      const fp = (v: number) => v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v.toPrecision(4);
      const fv = (v: number) => v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0);
      let msg = "📊 *Aster DEX — Top Futures Markets*\n━━━━━━━━━━━━━━━━━━━━\n\n";
      for (const sym of topSymbols) {
        const t = tickerArr.find((tk: any) => tk.symbol === sym);
        if (!t) continue;
        const price = parseFloat(t.lastPrice || t.price);
        const change = parseFloat(t.priceChangePercent);
        const vol = parseFloat(t.quoteVolume);
        const high = parseFloat(t.highPrice || t.high);
        const low = parseFloat(t.lowPrice || t.low);
        const changeIcon = change >= 0 ? "🟢" : "🔴";
        const changeStr = change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
        const base = sym.replace("USDT", "");
        const funding = fundingMap.get(sym);
        const fundingStr = funding ? ` · FR: \`${(parseFloat(funding.fundingRate) * 100).toFixed(4)}%\`` : "";
        msg += `${changeIcon} *${base}/USDT*  \`$${fp(price)}\`\n`;
        msg += `   ${changeStr} · H: \`$${fp(high)}\` · L: \`$${fp(low)}\`\n`;
        msg += `   Vol: \`$${fv(vol)}\`${fundingStr}\n\n`;
      }
      msg += `_Tap a pair below to trade instantly_`;

      const pairButtons: TelegramBot.InlineKeyboardButton[][] = [
        [
          { text: "BTC", callback_data: "aster:qpair_BTCUSDT" },
          { text: "ETH", callback_data: "aster:qpair_ETHUSDT" },
          { text: "BNB", callback_data: "aster:qpair_BNBUSDT" },
          { text: "SOL", callback_data: "aster:qpair_SOLUSDT" },
        ],
        [
          { text: "XRP", callback_data: "aster:qpair_XRPUSDT" },
          { text: "DOGE", callback_data: "aster:qpair_DOGEUSDT" },
          { text: "SUI", callback_data: "aster:qpair_SUIUSDT" },
          { text: "ADA", callback_data: "aster:qpair_ADAUSDT" },
        ],
        [
          { text: "AVAX", callback_data: "aster:qpair_AVAXUSDT" },
          { text: "LINK", callback_data: "aster:qpair_LINKUSDT" },
          { text: "PEPE", callback_data: "aster:qpair_PEPEUSDT" },
          { text: "WIF", callback_data: "aster:qpair_WIFUSDT" },
        ],
        [{ text: "🔍 Other Pair", callback_data: "aster:trade_futures" }],
        [{ text: "🔄 Refresh", callback_data: "aster:markets" }, { text: "« Back", callback_data: "action:aster" }],
      ];

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: pairButtons } });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to fetch markets: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if (action?.startsWith("qpair_")) {
    const symbol = action.replace("qpair_", "");
    pendingAsterTrade.set(chatId, { step: "side", market: "futures", symbol });
    try {
      const futuresClient = client.futures || client;
      const [ticker, fundingArr] = await Promise.all([
        futuresClient.ticker(symbol).catch(() => null),
        futuresClient.fundingRate(symbol, 1).catch(() => []),
      ]);
      const t = Array.isArray(ticker) ? ticker[0] : ticker;
      const f = Array.isArray(fundingArr) && fundingArr.length > 0 ? fundingArr[0] : null;
      const base = symbol.replace("USDT", "");
      let infoMsg = `📈 *${base}/USDT — Futures*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      const fmtPrice = (v: number) => v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v.toPrecision(4);
      const fmtVol = (v: number) => v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0);
      if (t) {
        const price = parseFloat(t.lastPrice || t.price);
        const change = parseFloat(t.priceChangePercent);
        const changeIcon = change >= 0 ? "🟢" : "🔴";
        const changeStr = change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
        const high = parseFloat(t.highPrice || t.high);
        const low = parseFloat(t.lowPrice || t.low);
        const vol = parseFloat(t.quoteVolume);
        infoMsg += `${changeIcon} *${base}/USDT*  \`$${fmtPrice(price)}\`\n`;
        infoMsg += `   ${changeStr} · H: \`$${fmtPrice(high)}\` · L: \`$${fmtPrice(low)}\`\n`;
        infoMsg += `   Vol: \`$${fmtVol(vol)}\`\n`;
        if (f) {
          const fr = parseFloat(f.fundingRate) * 100;
          const mp = parseFloat(f.markPrice || "0");
          const markVal = mp > 0 ? mp : price;
          infoMsg += `   Mark: \`$${fmtPrice(markVal)}\` · FR: \`${fr >= 0 ? "+" : ""}${fr.toFixed(4)}%\`\n`;
        }
      } else if (f) {
        const fr = parseFloat(f.fundingRate) * 100;
        infoMsg += `   FR: \`${fr >= 0 ? "+" : ""}${fr.toFixed(4)}%\`\n`;
      }
      infoMsg += `\nChoose direction:`;
      await bot.sendMessage(chatId, infoMsg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🟢 BUY / LONG", callback_data: "aster:side_buy" }, { text: "🔴 SELL / SHORT", callback_data: "aster:side_sell" }],
            [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId,
        `Symbol: *${symbol}*\n\nChoose direction:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🟢 BUY / LONG", callback_data: "aster:side_buy" }, { text: "🔴 SELL / SHORT", callback_data: "aster:side_sell" }],
              [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
            ],
          },
        }
      );
    }
    return;
  }

  if (action === "balance") {
    await bot.sendMessage(chatId, "Loading Aster account summary...");
    try {
      const asterClient = await getAsterClient(chatId);
      if (!asterClient) {
        await bot.sendMessage(chatId, "No Aster API connected. Use Test Connection first.", {
          reply_markup: { inline_keyboard: [[{ text: "Test Connection", callback_data: "aster:test_connection" }], [{ text: "Aster Menu", callback_data: "action:aster" }]] },
        });
        return;
      }
      const futuresClient = asterClient.futures || asterClient;

      let balanceData: any = null;
      let usdtBalance = 0;
      let availableBalance = 0;
      let crossUnPnl = 0;
      let walletBalance = 0;
      let balanceError = "";
      try {
        balanceData = await futuresClient.balance();
        if (Array.isArray(balanceData)) {
          const usdt = balanceData.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
          if (usdt) {
            usdtBalance = parseFloat(usdt.balance || usdt.crossWalletBalance || "0");
            availableBalance = parseFloat(usdt.availableBalance || "0");
            crossUnPnl = parseFloat(usdt.crossUnPnl || "0");
            walletBalance = parseFloat(usdt.crossWalletBalance || usdt.balance || "0");
          }
        } else if (balanceData && typeof balanceData === "object") {
          walletBalance = parseFloat(balanceData.totalWalletBalance || balanceData.totalMarginBalance || "0");
          availableBalance = parseFloat(balanceData.availableBalance || balanceData.maxWithdrawAmount || "0");
          crossUnPnl = parseFloat(balanceData.totalUnrealizedProfit || "0");
          usdtBalance = walletBalance;
        }
      } catch (e: any) {
        balanceError = e.message?.substring(0, 150) || "Unknown error";
        console.error("[Balance] Error:", balanceError);
      }

      let positions: any[] = [];
      let totalUpnl = 0;
      let posError = "";
      try {
        const allPos = await futuresClient.positions();
        if (Array.isArray(allPos)) {
          positions = allPos.filter((p: any) => parseFloat(p.positionAmt || "0") !== 0);
          for (const p of positions) {
            totalUpnl += parseFloat(p.unRealizedProfit || "0");
          }
        }
      } catch (e: any) {
        posError = e.message?.substring(0, 150) || "Unknown error";
        console.error("[Positions] Error:", posError);
      }

      const wallet = getLinkedWallet(chatId);
      let walletUsdt = 0;
      let walletBnb = 0;
      if (wallet) {
        try {
          const [uBal, bBal] = await Promise.all([
            (async () => {
              const c = new ethers.Contract(BSC_USDT, ["function balanceOf(address) view returns (uint256)"], bnbProviderCached);
              return parseFloat(ethers.formatUnits(await c.balanceOf(wallet), 18));
            })(),
            (async () => {
              const b = await bnbProviderCached.getBalance(wallet);
              return parseFloat(ethers.formatEther(b));
            })(),
          ]);
          walletUsdt = uBal;
          walletBnb = bBal;
        } catch {}
      }

      let msg = `Aster DEX - Account Status\n\n`;

      if (balanceError) {
        msg += `Futures Balance: FAILED\n  ${balanceError}\n\n`;
      } else {
        msg += `Futures Account (USDT)\n`;
        msg += `  Wallet Balance: $${walletBalance.toFixed(2)}\n`;
        msg += `  Available: $${availableBalance.toFixed(2)}\n`;
        msg += `  Unrealized PnL: ${crossUnPnl >= 0 ? "+" : ""}$${crossUnPnl.toFixed(2)}\n\n`;
      }

      if (posError) {
        msg += `Positions: FAILED\n  ${posError}\n\n`;
      } else if (positions.length > 0) {
        msg += `Open Positions: ${positions.length}\n`;
        for (const p of positions) {
          const amt = parseFloat(p.positionAmt || "0");
          const side = amt > 0 ? "LONG" : "SHORT";
          const entry = parseFloat(p.entryPrice || "0");
          const mark = parseFloat(p.markPrice || "0");
          const upnl = parseFloat(p.unRealizedProfit || "0");
          const lev = p.leverage || "?";
          msg += `  ${p.symbol} ${side} ${lev}x\n`;
          msg += `    Entry: $${entry.toFixed(2)} | Mark: $${mark.toFixed(2)}\n`;
          msg += `    PnL: ${upnl >= 0 ? "+" : ""}$${upnl.toFixed(2)}\n`;
        }
        msg += `\n`;
      } else {
        msg += `No open positions.\n\n`;
      }

      if (wallet) {
        msg += `BSC Wallet\n`;
        msg += `  USDT: $${walletUsdt.toFixed(2)}\n`;
        msg += `  BNB: ${walletBnb.toFixed(4)}\n`;
        msg += `  ${wallet.substring(0, 8)}...${wallet.substring(38)}\n\n`;
      }

      if (walletBalance < 1 && walletUsdt < 1) {
        msg += `No margin deposited. Use Fund Account to deposit USDT.`;
      }

      await bot.sendMessage(chatId, msg, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Fund Account", callback_data: "aster:fund" }, { text: "Positions", callback_data: "aster:positions" }],
            [{ text: "Refresh", callback_data: "aster:balance" }],
            [{ text: "Aster Menu", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to load account: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (action?.startsWith("close_pos_")) {
    const closeSymbol = action.replace("close_pos_", "");
    try {
      const localPositions = await storage.getAsterLocalPositions(chatId.toString());
      const pos = localPositions.find((p: any) => p.symbol === closeSymbol);
      if (!pos) {
        await bot.sendMessage(chatId, `No open position found for ${closeSymbol}.`, { reply_markup: { inline_keyboard: [[{ text: "« Positions", callback_data: "aster:positions" }]] } });
        return;
      }
      const closeSide = pos.side === "LONG" ? "SELL" : "BUY";
      const closeQty = pos.quantity.toString();
      await bot.sendMessage(chatId,
        `⚠️ *Close ${closeSymbol} Position?*\n\n` +
        `Direction: ${pos.side}\n` +
        `Size: ${closeQty}\n\n` +
        `This will market-close your entire position.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Close Position", callback_data: `aster:close_confirm_${closeSymbol}_${closeSide}_${closeQty}` }],
              [{ text: "❌ Cancel", callback_data: "aster:positions" }],
            ],
          },
        }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 200)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "aster:positions" }]] } });
    }
    return;
  }

  if (action?.startsWith("close_confirm_")) {
    const parts = action.replace("close_confirm_", "").split("_");
    const closeQty = parts.pop()!;
    const closeSide = parts.pop()! as "BUY" | "SELL";
    const closeSymbol = parts.join("_");
    try {
      const futuresClient = client.futures || client;
      await bot.sendMessage(chatId, `⏳ Closing ${closeSymbol} position...`);
      const result = await futuresClient.createOrder({
        symbol: closeSymbol,
        side: closeSide,
        type: "MARKET",
        quantity: closeQty,
        reduceOnly: true,
      });
      try {
        await storage.saveAsterLocalTrade({
          chatId: chatId.toString(),
          orderId: String(result.orderId),
          symbol: closeSymbol,
          side: closeSide,
          type: "MARKET",
          quantity: parseFloat(closeQty),
          executedQty: parseFloat(result.executedQty || closeQty),
          price: parseFloat(result.price || "0"),
          avgPrice: parseFloat(result.avgPrice || result.price || "0"),
          status: result.status || "FILLED",
          reduceOnly: true,
          leverage: 1,
        });
      } catch {}
      await bot.sendMessage(chatId,
        `✅ *Position Closed*\n\n` +
        `${closeSymbol} — ${result.status}\n` +
        `Order ID: ${result.orderId}`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [
            [{ text: "📊 View Positions", callback_data: "aster:positions" }],
            [{ text: "📈 PnL", callback_data: "aster:pnl" }],
            [{ text: "« Aster Menu", callback_data: "action:aster" }],
          ]},
        }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Close failed: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: `aster:close_pos_${closeSymbol}` }], [{ text: "« Positions", callback_data: "aster:positions" }]] },
      });
    }
    return;
  }

  if (action === "close_all_positions") {
    try {
      const localPositions = await storage.getAsterLocalPositions(chatId.toString());
      if (localPositions.length === 0) {
        await bot.sendMessage(chatId, "No open positions to close.", { reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] } });
        return;
      }
      let posText = "";
      for (const p of localPositions) {
        posText += `  ${p.symbol} ${p.side} — Qty: ${p.quantity}\n`;
      }
      await bot.sendMessage(chatId,
        `⚠️ *Close ALL ${localPositions.length} Positions?*\n\n${posText}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Close All", callback_data: "aster:close_all_confirm" }],
              [{ text: "❌ Cancel", callback_data: "aster:positions" }],
            ],
          },
        }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `Error: ${e.message?.substring(0, 200)}`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "aster:positions" }]] } });
    }
    return;
  }

  if (action === "close_all_confirm") {
    try {
      const futuresClient = client.futures || client;
      const localPositions = await storage.getAsterLocalPositions(chatId.toString());
      await bot.sendMessage(chatId, `⏳ Closing ${localPositions.length} positions...`);
      let closed = 0;
      let failed = 0;
      for (const p of localPositions) {
        try {
          const closeSide = p.side === "LONG" ? "SELL" : "BUY";
          const closeResult = await futuresClient.createOrder({
            symbol: p.symbol,
            side: closeSide as "BUY" | "SELL",
            type: "MARKET",
            quantity: p.quantity.toString(),
            reduceOnly: true,
          });
          try {
            await storage.saveAsterLocalTrade({
              chatId: chatId.toString(),
              orderId: String(closeResult.orderId),
              symbol: p.symbol,
              side: closeSide,
              type: "MARKET",
              quantity: p.quantity,
              executedQty: parseFloat(closeResult.executedQty || String(p.quantity)),
              price: parseFloat(closeResult.price || "0"),
              avgPrice: parseFloat(closeResult.avgPrice || closeResult.price || "0"),
              status: closeResult.status || "FILLED",
              reduceOnly: true,
              leverage: 1,
            });
          } catch {}
          closed++;
        } catch { failed++; }
      }
      await bot.sendMessage(chatId,
        `✅ *Positions Closed*\n\n${closed} closed${failed > 0 ? `, ${failed} failed` : ""}`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [
            [{ text: "📈 PnL", callback_data: "aster:pnl" }],
            [{ text: "« Aster Menu", callback_data: "action:aster" }],
          ]},
        }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `Close all failed: ${e.message?.substring(0, 200)}`, { reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] } });
    }
    return;
  }

  if (action === "api_diag") {
    await bot.sendMessage(chatId, "Running API diagnostics (broker open-account flow)...");
    try {
      const { ethers } = await import("ethers");
      const walletAddr = getLinkedWallet(chatId);
      const pk = await resolvePrivateKey(chatId, walletAddr || "");
      if (!pk || !walletAddr) { await bot.sendMessage(chatId, "No wallet found"); return; }
      const w = new ethers.Wallet(pk);
      const address = w.address;
      const results: string[] = [];
      const BAPI = "https://www.asterdex.com/bapi/futures/v1";

      results.push(`Wallet: ${address.substring(0, 10)}...`);

      const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

      function extractCookies(res: Response): string[] {
        let raw: string[] = [];
        try { raw = (res.headers as any).getSetCookie?.() || []; } catch {}
        if (!raw.length) {
          const sc = res.headers.get("set-cookie");
          if (sc) raw = sc.split(/,(?=\s*\w+=)/);
        }
        return raw.map((c: string) => c.split(";")[0].trim()).filter(Boolean);
      }

      // Step 1: Pre-fetch XSRF cookie from Aster website
      const prefetchRes = await fetch("https://www.asterdex.com/en/futures/BTCUSDT", {
        headers: { "User-Agent": browserUA, "Accept": "text/html" },
        redirect: "follow",
      });
      const prefetchCookies = extractCookies(prefetchRes);
      const prefetchCookieStr = prefetchCookies.join("; ");
      const prefetchNames = prefetchCookies.map((c: string) => c.split("=")[0]);
      results.push(`Prefetch: ${prefetchRes.status} cookies=[${prefetchNames.join(',')}]`);

      let xsrfFromPrefetch = "";
      for (const cookie of prefetchCookies) {
        const [name, ...rest] = cookie.split("=");
        if (name.trim().toUpperCase() === "XSRF-TOKEN") {
          xsrfFromPrefetch = decodeURIComponent(rest.join("=").trim());
        }
      }
      results.push(`Prefetch XSRF: ${xsrfFromPrefetch.length}ch`);

      // Step 2: Get nonce (with prefetch cookies)
      const nonceRes = await fetch(`${BAPI}/public/future/web3/get-nonce`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "clientType": "web", "Cookie": prefetchCookieStr, "User-Agent": browserUA },
        body: JSON.stringify({ type: "LOGIN", sourceAddr: address }),
      });
      const nonceData = await nonceRes.json();
      const nonceCookies = extractCookies(nonceRes);
      results.push(`Nonce: ${nonceRes.status} ${nonceData?.data?.nonce ? 'OK' : 'FAIL'} +cookies=[${nonceCookies.map((c: string) => c.split("=")[0]).join(',')}]`);
      if (!nonceData?.data?.nonce) {
        await bot.sendMessage(chatId, results.join("\n"));
        return;
      }

      // Merge cookies
      const allCookieMap = new Map<string, string>();
      for (const c of [...prefetchCookies, ...nonceCookies]) {
        const [name, ...rest] = c.split("=");
        allCookieMap.set(name.trim(), rest.join("=").trim());
      }

      // Step 3: Login (with merged cookies)
      const preLoginCookieStr = Array.from(allCookieMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
      const loginSig = await w.signMessage(`You are signing into Astherus ${nonceData.data.nonce}`);
      const loginRes = await fetch(`${BAPI}/public/future/web3/ae/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "clientType": "web",
          "Cookie": preLoginCookieStr, "User-Agent": browserUA,
          "Origin": "https://www.asterdex.com", "Referer": "https://www.asterdex.com/en/futures/BTCUSDT",
          ...(xsrfFromPrefetch ? { "X-XSRF-TOKEN": xsrfFromPrefetch } : {}),
        },
        body: JSON.stringify({ signature: loginSig, sourceAddr: address, chainId: 56, agentCode: "BUILD4" }),
      });
      const loginData = await loginRes.json();
      const loginCookies = extractCookies(loginRes);
      for (const c of loginCookies) {
        const [name, ...rest] = c.split("=");
        allCookieMap.set(name.trim(), rest.join("=").trim());
      }

      // Extract XSRF from all accumulated cookies
      let xsrfToken = xsrfFromPrefetch;
      for (const [name, value] of allCookieMap.entries()) {
        if (name.toUpperCase() === "XSRF-TOKEN") {
          xsrfToken = decodeURIComponent(value);
        }
      }

      const finalCookieStr = Array.from(allCookieMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
      const uid = loginData?.data?.uid || loginData?.data?.userId || 0;
      const token = loginData?.data?.token || "";
      results.push(`Login: ${loginData?.code} uid=${uid} token=${token.length}ch +cookies=[${loginCookies.map((c: string) => c.split("=")[0]).join(',')}]`);
      results.push(`Total cookies: ${allCookieMap.size} names=[${Array.from(allCookieMap.keys()).join(',')}]`);
      results.push(`Final XSRF: ${xsrfToken.length}ch`);

      const openUrl = `${BAPI}/private/future/open-account`;
      const browserHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "clientType": "web",
        "Origin": "https://www.asterdex.com",
        "Referer": "https://www.asterdex.com/en/futures/BTCUSDT",
        "User-Agent": browserUA,
        "Accept": "application/json, text/plain, */*",
      };

      // Test V3 API endpoints with POST + params in URL (the working pattern)
      const EIP712D = { name: "AsterSignTransaction", version: "1", chainId: 1666, verifyingContract: "0x0000000000000000000000000000000000000000" };
      const EIP712T = { Message: [{ name: "msg", type: "string" }] };
      const checksumAddr = ethers.getAddress(address);

      function bqs(p: Record<string, any>): string {
        const parts: string[] = [];
        for (const [k, v] of Object.entries(p)) {
          if (v != null) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
        return parts.join("&");
      }

      async function signP(params: Record<string, any>) {
        const p = { ...params, nonce: String(Math.trunc(Date.now() / 1000) * 1_000_000 + Math.floor(Math.random() * 999)), user: checksumAddr, signer: checksumAddr };
        const q = bqs(p);
        const sig = await w.signTypedData(EIP712D, EIP712T, { msg: q });
        return { qs: q + "&signature=" + sig };
      }

      const FAPI = "https://fapi.asterdex.com";

      async function tryV3(label: string, method: string, path: string, _paramsInUrl: boolean) {
        try {
          const { qs } = await signP({});
          const url = `${FAPI}${path}?${qs}`;
          const h: Record<string, string> = { "User-Agent": "BUILD4/1.0", "Content-Type": "application/x-www-form-urlencoded" };
          const r = await fetch(url, { method, headers: h });
          const t = await r.text();
          results.push(`${label}: ${r.status} ${t.substring(0, 120)}`);
        } catch (e: any) {
          results.push(`${label}: ERR ${e.message?.substring(0, 80)}`);
        }
      }

      results.push(`\n--- V3 API Tests ---`);

      async function tryV3h(label: string, method: string, path: string, extraHeaders: Record<string, string> = {}, extraParams: Record<string, any> = {}) {
        try {
          const { qs } = await signP(extraParams);
          const url = `${FAPI}${path}?${qs}`;
          const h: Record<string, string> = { "User-Agent": "BUILD4/1.0", "Content-Type": "application/x-www-form-urlencoded", ...extraHeaders };
          const r = await fetch(url, { method, headers: h });
          const t = await r.text();
          results.push(`${label}: ${r.status} ${t.substring(0, 120)}`);
        } catch (e: any) {
          results.push(`${label}: ERR ${e.message?.substring(0, 80)}`);
        }
      }

      await tryV3h("noop POST", "POST", "/fapi/v3/noop");
      await tryV3h("bal GET", "GET", "/fapi/v3/balance");
      await tryV3h("bal GET+APIKEY=addr", "GET", "/fapi/v3/balance", { "X-MBX-APIKEY": checksumAddr });
      await tryV3h("bal GET+APIKEY=signer", "GET", "/fapi/v3/balance", { "X-MBX-APIKEY": checksumAddr.toLowerCase() });
      await tryV3h("bal GET+APIKEY=V3", "GET", "/fapi/v3/balance", { "X-MBX-APIKEY": "V3" });
      await tryV3h("bal GET+timestamp", "GET", "/fapi/v3/balance", {}, { timestamp: Date.now() });
      await tryV3h("bal GET+recvWindow", "GET", "/fapi/v3/balance", {}, { recvWindow: 60000 });
      await tryV3h("pos GET+APIKEY=addr", "GET", "/fapi/v3/positionRisk", { "X-MBX-APIKEY": checksumAddr });
      // Try V1 path with V3 signing
      await tryV3h("bal GET v1path", "GET", "/fapi/v1/balance");
      await tryV3h("pos GET v1path", "GET", "/fapi/v1/positionRisk");
      // Try with JSON content type
      await tryV3h("bal GET+JSON", "GET", "/fapi/v3/balance", { "Content-Type": "application/json" });
      // Try without Content-Type
      async function tryNoContentType(label: string, path: string) {
        try {
          const { qs } = await signP({});
          const url = `${FAPI}${path}?${qs}`;
          const r = await fetch(url, { method: "GET", headers: { "User-Agent": "BUILD4/1.0" } });
          const t = await r.text();
          results.push(`${label}: ${r.status} ${t.substring(0, 120)}`);
        } catch (e: any) {
          results.push(`${label}: ERR ${e.message?.substring(0, 80)}`);
        }
      }
      await tryNoContentType("bal GET noCT", "/fapi/v3/balance");

      const fullMsg = results.join("\n");
      const chunks = [];
      for (let i = 0; i < fullMsg.length; i += 4000) chunks.push(fullMsg.substring(i, i + 4000));
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk);
      }
    } catch (e: any) {
      const safeErr = (e.message || "Unknown").substring(0, 200).replace(/[_*[\]()~`>#+=|{}.!-]/g, " ");
      await bot.sendMessage(chatId, `Diag error: ${safeErr}`);
    }
    return;
  }

  if (action === "positions") {
    await bot.sendMessage(chatId, "Loading futures positions...");
    try {
      const asterClient = await getAsterClient(chatId);
      const futuresClient = asterClient?.futures || asterClient;

      let apiPositions: any[] = [];
      if (futuresClient) {
        try {
          const allPos = await futuresClient.positions();
          if (Array.isArray(allPos)) {
            apiPositions = allPos.filter((p: any) => parseFloat(p.positionAmt || "0") !== 0);
          }
        } catch {}
      }

      if (apiPositions.length === 0) {
        await bot.sendMessage(chatId, `No open positions.\n\nPlace a trade to get started.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "New Trade", callback_data: "aster:trade_futures" }],
              [{ text: "Refresh", callback_data: "aster:positions" }],
              [{ text: "Back", callback_data: "action:aster" }],
            ],
          },
        });
        return;
      }

      const fmtP = (v: number) => v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v.toPrecision(4);
      let msg = `Futures Positions (${apiPositions.length})\n\n`;
      let totalUpnl = 0;
      const closeButtons: TelegramBot.InlineKeyboardButton[][] = [];

      for (const p of apiPositions) {
        const amt = parseFloat(p.positionAmt || "0");
        const direction = amt > 0 ? "LONG" : "SHORT";
        const entryPrice = parseFloat(p.entryPrice || "0");
        const markPrice = parseFloat(p.markPrice || "0");
        const upnl = parseFloat(p.unRealizedProfit || "0");
        const lev = p.leverage || "?";
        const notional = parseFloat(p.notional || "0");

        totalUpnl += upnl;

        const margin = Math.abs(notional) / parseFloat(lev || "1");
        const roe = margin > 0 ? (upnl / margin * 100) : 0;

        msg += `${direction} ${p.symbol} ${lev}x\n`;
        msg += `  Size: ${Math.abs(amt)} | Notional: $${fmtP(Math.abs(notional))}\n`;
        msg += `  Entry: $${fmtP(entryPrice)} | Mark: $${fmtP(markPrice)}\n`;
        msg += `  PnL: ${upnl >= 0 ? "+" : ""}${upnl.toFixed(2)} USDT (${roe >= 0 ? "+" : ""}${roe.toFixed(1)}%)\n\n`;

        const base = p.symbol.replace("USDT", "");
        closeButtons.push([{ text: `Close ${base}`, callback_data: `aster:close_pos_${p.symbol}` }]);
      }
      msg += `Total uPnL: ${totalUpnl >= 0 ? "+" : ""}${totalUpnl.toFixed(2)} USDT`;

      const buttons: TelegramBot.InlineKeyboardButton[][] = [
        ...closeButtons,
      ];
      if (localPositions.length > 1) {
        buttons.push([{ text: "🔴 Close ALL Positions", callback_data: "aster:close_all_positions" }]);
      }
      buttons.push([{ text: "🔄 Refresh", callback_data: "aster:positions" }, { text: "📈 PnL", callback_data: "aster:pnl" }]);
      buttons.push([{ text: "« Aster Menu", callback_data: "action:aster" }]);

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to fetch positions: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (action === "orders") {
    await bot.sendMessage(chatId, "Loading open orders...");
    try {
      const futuresClient = client.futures || client;
      const spotClient = client.spot || null;
      const [futuresOrders, spotOrders] = await Promise.all([
        futuresClient.openOrders().catch(() => []),
        spotClient ? spotClient.openOrders().catch(() => []) : Promise.resolve([]),
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

  if (action === "pnl") {
    await bot.sendMessage(chatId, "Loading PnL summary...");
    try {
      const futuresClient = client.futures || client;
      const localPositions = await storage.getAsterLocalPositions(chatId.toString());
      const allTrades = await storage.getAsterLocalTrades(chatId.toString());

      let totalUpnl = 0;
      let positionDetails = "";
      const fmtP = (v: number) => v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v.toPrecision(4);

      for (const p of localPositions) {
        let markPrice = 0;
        try {
          const ticker = await futuresClient.tickerPrice(p.symbol);
          markPrice = parseFloat(ticker?.price || "0");
        } catch { markPrice = 0; }

        let upnl = 0;
        if (markPrice > 0) {
          upnl = p.side === "LONG"
            ? (markPrice - p.entryPrice) * p.quantity
            : (p.entryPrice - markPrice) * p.quantity;
        }
        totalUpnl += upnl;
        const notional = p.quantity * (markPrice || p.entryPrice);
        const margin = notional / p.leverage;
        const roe = margin > 0 ? (upnl / margin * 100) : 0;
        const dir = p.side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
        positionDetails += `  ${dir} *${p.symbol}* ${p.leverage}x\n`;
        positionDetails += `     \`${upnl >= 0 ? "+" : ""}${upnl.toFixed(2)} USDT\` · ROE: \`${roe >= 0 ? "+" : ""}${roe.toFixed(1)}%\`\n`;
      }

      let msg = `📈 *PnL Summary*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      msg += `${totalUpnl >= 0 ? "📈" : "📉"} Unrealized: \`${totalUpnl >= 0 ? "+" : ""}$${totalUpnl.toFixed(2)}\`\n\n`;

      if (localPositions.length > 0) {
        msg += `*Open Positions (${localPositions.length}):*\n${positionDetails}\n`;
      }

      const closedTrades = allTrades.filter((t: any) => t.reduceOnly);
      if (closedTrades.length > 0) {
        msg += `*Recent Closed Trades:*\n`;
        for (const t of closedTrades.slice(0, 8)) {
          const ts = new Date(t.createdAt).toISOString().substring(5, 16).replace("T", " ");
          msg += `  ${t.side === "BUY" ? "🟢" : "🔴"} ${t.symbol} ${t.side} \`${t.executedQty || t.quantity}\` @ \`$${(t.avgPrice || t.price).toFixed(2)}\` · ${ts}\n`;
        }
      }

      msg += `\n📊 Total trades tracked: ${allTrades.length}`;
      msg += `\n_Tracked from bot orders + live prices_`;

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "aster:pnl" }, { text: "📊 Positions", callback_data: "aster:positions" }],
            [{ text: "🏆 Competition", callback_data: "aster:competition" }],
            [{ text: "« Aster Menu", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to fetch PnL: ${e.message?.substring(0, 200)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    return;
  }

  if (action === "agent") {
    const config = getAgentConfig(chatId.toString());
    const state = getAgentState(chatId.toString());
    const isRunning = state?.running || false;

    let msg = `🤖 *AI Trading Agent*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `Status: ${isRunning ? "🟢 RUNNING" : "🔴 STOPPED"}\n`;
    msg += `Symbol: \`${config.symbol}\`\n`;
    msg += `Leverage: *${config.leverage}x*\n`;
    msg += `Risk: \`${config.riskPercent}%\` per trade\n`;
    msg += `Interval: \`${config.intervalMs / 1000}s\`\n`;
    msg += `Timeframe: \`${config.klineInterval}\`\n`;
    if (state) {
      msg += `Position: \`${state.currentPosition}\`\n`;
      msg += `Trades: \`${state.tradeCount}\`\n`;
      msg += `Last Signal: \`${state.lastSignal}\`\n`;
    }
    msg += `\n_Strategy: EMA(8/21) crossover + RSI filter_\n`;
    msg += `_The agent fetches candles, computes signals, and auto-trades._`;

    const buttons: TelegramBot.InlineKeyboardButton[][] = [];
    if (isRunning) {
      buttons.push([{ text: "⛔ Stop Agent", callback_data: "aster:agent_stop" }]);
    } else {
      buttons.push([{ text: "▶️ Start Agent", callback_data: "aster:agent_start" }]);
    }
    buttons.push([{ text: "⚙️ Configure", callback_data: "aster:agent_config" }]);
    buttons.push([{ text: "📊 Status", callback_data: "aster:agent_status" }]);
    buttons.push([{ text: "« Aster Menu", callback_data: "action:aster" }]);

    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  if (action === "agent_start") {
    const futuresClient = client.futures || client;
    const chatIdStr = chatId.toString();

    const sendMsg = async (msg: string) => {
      try {
        await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
      } catch (e: any) {
        const safeMsg = msg.replace(/[_*[\]()~`>#+=|{}.!-]/g, " ");
        await bot.sendMessage(chatId, safeMsg).catch(() => {});
      }
    };

    const getClientFn = () => client;
    const started = await startAgent(chatIdStr, getClientFn, sendMsg);

    if (started) {
      const config = getAgentConfig(chatIdStr);
      await bot.sendMessage(chatId,
        `🤖 *Agent Started!*\n\n` +
        `Trading \`${config.symbol}\` with ${config.leverage}x leverage\n` +
        `Risk: ${config.riskPercent}% per trade\n` +
        `Checking every ${config.intervalMs / 1000}s\n\n` +
        `The agent will auto-trade based on EMA/RSI signals.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "⛔ Stop Agent", callback_data: "aster:agent_stop" }],
              [{ text: "📊 Status", callback_data: "aster:agent_status" }],
              [{ text: "« Aster Menu", callback_data: "action:aster" }],
            ],
          },
        }
      );
    } else {
      await bot.sendMessage(chatId, "Agent is already running.", {
        reply_markup: { inline_keyboard: [[{ text: "⛔ Stop Agent", callback_data: "aster:agent_stop" }], [{ text: "« Back", callback_data: "aster:agent" }]] },
      });
    }
    return;
  }

  if (action === "agent_stop") {
    const stopped = stopAgent(chatId.toString());
    if (stopped) {
      await bot.sendMessage(chatId, "⛔ *Agent Stopped*\n\nAutonomous trading has been disabled.", {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "▶️ Restart Agent", callback_data: "aster:agent_start" }],
            [{ text: "🤖 Agent Menu", callback_data: "aster:agent" }],
            [{ text: "« Aster Menu", callback_data: "action:aster" }],
          ],
        },
      });
    } else {
      await bot.sendMessage(chatId, "Agent is not running.", {
        reply_markup: { inline_keyboard: [[{ text: "🤖 Agent Menu", callback_data: "aster:agent" }]] },
      });
    }
    return;
  }

  if (action === "agent_status") {
    const statusMsg = getAgentStatus(chatId.toString());
    await bot.sendMessage(chatId, statusMsg, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Refresh", callback_data: "aster:agent_status" }],
          [{ text: "🤖 Agent Menu", callback_data: "aster:agent" }],
          [{ text: "« Aster Menu", callback_data: "action:aster" }],
        ],
      },
    });
    return;
  }

  if (action === "agent_config") {
    const config = getAgentConfig(chatId.toString());
    await bot.sendMessage(chatId,
      `⚙️ *Agent Configuration*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Symbol: \`${config.symbol}\`\n` +
      `Leverage: *${config.leverage}x*\n` +
      `Risk: \`${config.riskPercent}%\` per trade\n` +
      `Interval: \`${config.intervalMs / 1000}s\`\n` +
      `Timeframe: \`${config.klineInterval}\`\n\n` +
      `Select what to change:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📌 Symbol", callback_data: "aster:agent_set_symbol" }, { text: "⚡ Leverage", callback_data: "aster:agent_set_leverage" }],
            [{ text: "🎯 Risk %", callback_data: "aster:agent_set_risk" }, { text: "⏱️ Interval", callback_data: "aster:agent_set_interval" }],
            [{ text: "📊 Timeframe", callback_data: "aster:agent_set_tf" }],
            [{ text: "« Agent Menu", callback_data: "aster:agent" }],
          ],
        },
      }
    );
    return;
  }

  if (action === "agent_set_symbol") {
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
    await bot.sendMessage(chatId, "Select trading symbol:", {
      reply_markup: {
        inline_keyboard: [
          symbols.slice(0, 3).map(s => ({ text: s, callback_data: `aster:agcfg_sym_${s}` })),
          symbols.slice(3).map(s => ({ text: s, callback_data: `aster:agcfg_sym_${s}` })),
          [{ text: "« Back", callback_data: "aster:agent_config" }],
        ],
      },
    });
    return;
  }

  if (action?.startsWith("agcfg_sym_")) {
    const sym = action.replace("agcfg_sym_", "");
    setAgentConfig(chatId.toString(), { symbol: sym });
    await bot.sendMessage(chatId, `Symbol set to \`${sym}\``, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "« Config", callback_data: "aster:agent_config" }], [{ text: "🤖 Agent", callback_data: "aster:agent" }]] },
    });
    return;
  }

  if (action === "agent_set_leverage") {
    const levs = [3, 5, 10, 15, 20, 25];
    await bot.sendMessage(chatId, "Select leverage:", {
      reply_markup: {
        inline_keyboard: [
          levs.slice(0, 3).map(l => ({ text: `${l}x`, callback_data: `aster:agcfg_lev_${l}` })),
          levs.slice(3).map(l => ({ text: `${l}x`, callback_data: `aster:agcfg_lev_${l}` })),
          [{ text: "« Back", callback_data: "aster:agent_config" }],
        ],
      },
    });
    return;
  }

  if (action?.startsWith("agcfg_lev_")) {
    const lev = parseInt(action.replace("agcfg_lev_", ""));
    setAgentConfig(chatId.toString(), { leverage: lev });
    await bot.sendMessage(chatId, `Leverage set to *${lev}x*`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "« Config", callback_data: "aster:agent_config" }], [{ text: "🤖 Agent", callback_data: "aster:agent" }]] },
    });
    return;
  }

  if (action === "agent_set_risk") {
    const risks = [0.5, 1, 2, 3, 5];
    await bot.sendMessage(chatId, "Select risk per trade (% of deposited margin):", {
      reply_markup: {
        inline_keyboard: [
          risks.slice(0, 3).map(r => ({ text: `${r}%`, callback_data: `aster:agcfg_risk_${r}` })),
          risks.slice(3).map(r => ({ text: `${r}%`, callback_data: `aster:agcfg_risk_${r}` })),
          [{ text: "« Back", callback_data: "aster:agent_config" }],
        ],
      },
    });
    return;
  }

  if (action?.startsWith("agcfg_risk_")) {
    const risk = parseFloat(action.replace("agcfg_risk_", ""));
    setAgentConfig(chatId.toString(), { riskPercent: risk });
    await bot.sendMessage(chatId, `Risk set to \`${risk}%\` per trade`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "« Config", callback_data: "aster:agent_config" }], [{ text: "🤖 Agent", callback_data: "aster:agent" }]] },
    });
    return;
  }

  if (action === "agent_set_interval") {
    const intervals = [{ label: "30s", val: 30000 }, { label: "1m", val: 60000 }, { label: "5m", val: 300000 }, { label: "15m", val: 900000 }, { label: "30m", val: 1800000 }];
    await bot.sendMessage(chatId, "Select check interval:", {
      reply_markup: {
        inline_keyboard: [
          intervals.slice(0, 3).map(i => ({ text: i.label, callback_data: `aster:agcfg_int_${i.val}` })),
          intervals.slice(3).map(i => ({ text: i.label, callback_data: `aster:agcfg_int_${i.val}` })),
          [{ text: "« Back", callback_data: "aster:agent_config" }],
        ],
      },
    });
    return;
  }

  if (action?.startsWith("agcfg_int_")) {
    const intVal = parseInt(action.replace("agcfg_int_", ""));
    setAgentConfig(chatId.toString(), { intervalMs: intVal });
    await bot.sendMessage(chatId, `Interval set to \`${intVal / 1000}s\``, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "« Config", callback_data: "aster:agent_config" }], [{ text: "🤖 Agent", callback_data: "aster:agent" }]] },
    });
    return;
  }

  if (action === "agent_set_tf") {
    const tfs = ["1m", "5m", "15m", "1h", "4h"];
    await bot.sendMessage(chatId, "Select candle timeframe:", {
      reply_markup: {
        inline_keyboard: [
          tfs.slice(0, 3).map(t => ({ text: t, callback_data: `aster:agcfg_tf_${t}` })),
          tfs.slice(3).map(t => ({ text: t, callback_data: `aster:agcfg_tf_${t}` })),
          [{ text: "« Back", callback_data: "aster:agent_config" }],
        ],
      },
    });
    return;
  }

  if (action?.startsWith("agcfg_tf_")) {
    const tf = action.replace("agcfg_tf_", "");
    setAgentConfig(chatId.toString(), { klineInterval: tf });
    await bot.sendMessage(chatId, `Timeframe set to \`${tf}\``, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "« Config", callback_data: "aster:agent_config" }], [{ text: "🤖 Agent", callback_data: "aster:agent" }]] },
    });
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
      "🔄 *Futures Trade*\n━━━━━━━━━━━━━━━━━━━━\n\n" +
      "Pick a pair or type any symbol (e.g. BTCUSDT):",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "BTC", callback_data: "aster:qpair_BTCUSDT" },
              { text: "ETH", callback_data: "aster:qpair_ETHUSDT" },
              { text: "BNB", callback_data: "aster:qpair_BNBUSDT" },
              { text: "SOL", callback_data: "aster:qpair_SOLUSDT" },
            ],
            [
              { text: "XRP", callback_data: "aster:qpair_XRPUSDT" },
              { text: "DOGE", callback_data: "aster:qpair_DOGEUSDT" },
              { text: "SUI", callback_data: "aster:qpair_SUIUSDT" },
              { text: "ADA", callback_data: "aster:qpair_ADAUSDT" },
            ],
            [
              { text: "AVAX", callback_data: "aster:qpair_AVAXUSDT" },
              { text: "LINK", callback_data: "aster:qpair_LINKUSDT" },
              { text: "PEPE", callback_data: "aster:qpair_PEPEUSDT" },
              { text: "WIF", callback_data: "aster:qpair_WIFUSDT" },
            ],
            [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
          ],
        },
      }
    );
    return;
  }

  if (action === "trade_spot") {
    pendingAsterTrade.set(chatId, { step: "symbol", market: "spot" });
    await bot.sendMessage(chatId,
      "💱 *Spot Trade*\n━━━━━━━━━━━━━━━━━━━━\n\n" +
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
        const userLimits = await storage.getAsterTradingLimits(chatId.toString());
        if (userLimits && state.leverage && state.leverage > userLimits.maxLeverage) {
          state.leverage = userLimits.maxLeverage;
          await bot.sendMessage(chatId, `⚠️ Leverage capped to ${userLimits.maxLeverage}x (your risk limit)`);
        }
        if (state.leverage) {
          try {
            const fc = client.futures || client;
            await fc.setLeverage(state.symbol!, state.leverage);
          } catch (e: any) {
            if (!e.message?.includes("No need to change")) {
              console.warn(`[Aster] Leverage set warning: ${e.message}`);
            }
          }
        }

        const fc = client.futures || client;
        const needsTimeInForce = state.orderType === "LIMIT" || state.orderType === "STOP" || state.orderType === "TAKE_PROFIT";
        const orderResult = await fc.createOrder({
          symbol: state.symbol!,
          side: state.side!,
          type: state.orderType!,
          quantity: state.quantity!,
          price: (state.orderType === "LIMIT" || state.orderType === "STOP" || state.orderType === "TAKE_PROFIT") ? state.price : undefined,
          stopPrice: state.stopPrice || undefined,
          timeInForce: needsTimeInForce ? "GTC" : undefined,
          callbackRate: state.orderType === "TRAILING_STOP_MARKET" ? state.callbackRate : undefined,
          reduceOnly: (state.orderType === "STOP_MARKET" || state.orderType === "TAKE_PROFIT_MARKET" || state.orderType === "TRAILING_STOP_MARKET") ? true : undefined,
        });

        const orderSideIcon = orderResult.side === "BUY" ? "🟢" : "🔴";
        const orderSideLabel = orderResult.side === "BUY" ? "LONG" : "SHORT";
        const avgPrice = parseFloat(orderResult.avgPrice || orderResult.price || "0");
        const filledQty = parseFloat(orderResult.executedQty || "0");
        const isFilled = orderResult.status === "FILLED" || filledQty > 0;

        try {
          await storage.saveAsterLocalTrade({
            chatId: chatId.toString(),
            orderId: String(orderResult.orderId),
            symbol: orderResult.symbol,
            side: orderResult.side,
            type: orderResult.type,
            quantity: parseFloat(orderResult.origQty || "0"),
            executedQty: filledQty,
            price: parseFloat(orderResult.price || "0"),
            avgPrice: avgPrice,
            status: orderResult.status,
            reduceOnly: !!state.orderType?.includes("STOP") || !!state.orderType?.includes("TAKE_PROFIT") || !!state.orderType?.includes("TRAILING"),
            leverage: state.leverage || 1,
          });
          console.log(`[AsterLocal] Saved trade ${orderResult.orderId} for ${chatId}`);
        } catch (saveErr: any) {
          console.error(`[AsterLocal] Failed to save trade: ${saveErr.message}`);
        }

        let resultMsg = `${orderSideIcon} *Order ${isFilled ? "Filled" : "Placed"}!*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        resultMsg += `📌 *${orderResult.symbol}* · ${orderSideLabel} · ${orderResult.type}\n`;
        resultMsg += `📦 Qty: \`${orderResult.origQty}\``;
        if (isFilled && filledQty > 0) resultMsg += ` (filled: \`${filledQty}\`)`;
        resultMsg += `\n`;
        if (avgPrice > 0 && isFilled) resultMsg += `💲 Fill Price: \`$${avgPrice}\`\n`;
        else if (orderResult.price && parseFloat(orderResult.price) > 0) resultMsg += `💲 Price: \`$${orderResult.price}\`\n`;
        if (orderResult.stopPrice && parseFloat(orderResult.stopPrice) > 0) resultMsg += `🎯 Trigger: \`$${orderResult.stopPrice}\`\n`;
        if (state.callbackRate) resultMsg += `📐 Callback: \`${state.callbackRate}%\`\n`;
        if (state.leverage) resultMsg += `⚡ Leverage: *${state.leverage}x*\n`;
        resultMsg += `\n📋 ID: \`${orderResult.orderId}\`\n`;
        resultMsg += `✅ Status: *${orderResult.status}*`;

        await bot.sendMessage(chatId, resultMsg, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📊 My Positions", callback_data: "aster:positions" }, { text: "📈 PnL", callback_data: "aster:pnl" }],
              [{ text: "🔄 Trade Again", callback_data: "aster:trade_futures" }],
              [{ text: "« Aster Menu", callback_data: "action:aster" }],
            ],
          },
        });
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
      const errMsg = e.message || "";
      let userMsg = `❌ *Order Failed*\n\n\`${errMsg.substring(0, 300)}\``;
      if (errMsg.includes("-2019") || errMsg.toLowerCase().includes("margin is insufficient")) {
        let marginInfo = "";
        try {
          const fc = client.futures || client;
          const [balances, tickerData] = await Promise.all([
            fc.balance().catch(() => []),
            fc.tickerPrice(state.symbol).catch(() => null),
          ]);
          const usdtBal = (balances as any[]).find((b: any) => b.asset === "USDT" || b.asset === "usdt");
          const availBal = usdtBal ? parseFloat(usdtBal.availableBalance || usdtBal.balance || "0") : 0;
          const mktPrice = tickerData?.price ? parseFloat(tickerData.price) : 0;
          const qty = parseFloat(state.quantity || "0");
          const lev = state.leverage || 1;
          const notional = qty * (state.price ? parseFloat(state.price) : mktPrice);
          const reqMargin = notional / lev;
          marginInfo = `\n\n📊 Order notional: \`$${notional.toFixed(2)}\`\n` +
            `⚡ Leverage: \`${lev}x\` → Required margin: \`$${reqMargin.toFixed(2)}\`\n` +
            `💰 Your available balance: \`$${availBal.toFixed(2)} USDT\``;
        } catch {}
        userMsg = `❌ *Insufficient Margin*\n\n` +
          `Your Aster futures account doesn't have enough USDT to cover this trade.${marginInfo}\n\n` +
          `💡 *What to do:*\n` +
          `1️⃣ Fund your account using the button below\n` +
          `2️⃣ Or reduce position size / increase leverage`;
      } else if (errMsg.includes("-1121") || errMsg.toLowerCase().includes("invalid symbol")) {
        userMsg = `❌ *Invalid Symbol*\n\nThe pair \`${state.symbol}\` is not available on Aster DEX. Check the Markets page for available pairs.`;
      } else if (errMsg.includes("-4003") || errMsg.toLowerCase().includes("quantity") || errMsg.includes("LOT_SIZE") || errMsg.includes("MIN_NOTIONAL")) {
        userMsg = `❌ *Invalid Quantity*\n\nThe quantity \`${state.quantity}\` is not valid for \`${state.symbol}\`.\n\n💡 Try increasing the amount or check the minimum order size.`;
      } else if (errMsg.includes("-4028") || errMsg.toLowerCase().includes("leverage")) {
        userMsg = `❌ *Leverage Error*\n\nLeverage \`${state.leverage}x\` is not available for \`${state.symbol}\`.\n\n💡 Try lower leverage (5x-20x is usually safe).`;
      } else if (errMsg.includes("timeout") || errMsg.includes("TIMEOUT")) {
        userMsg = `⏰ *Order Timed Out*\n\nThe exchange didn't respond in time. Your order may or may not have been placed.\n\n💡 Check your positions before retrying.`;
      } else if (errMsg.includes("-1001") || errMsg.includes("disconnected")) {
        userMsg = `🔌 *Connection Error*\n\nLost connection to Aster DEX. Please try again in a moment.`;
      }
      const errButtons: TelegramBot.InlineKeyboardButton[][] = [];
      if (errMsg.includes("-2019") || errMsg.toLowerCase().includes("margin is insufficient")) {
        errButtons.push([{ text: "💵 Fund Account", callback_data: "aster:fund" }]);
      }
      errButtons.push([{ text: "💰 Check Balance", callback_data: "aster:balance" }, { text: "🔄 Try Again", callback_data: "aster:trade_futures" }]);
      errButtons.push([{ text: "« Aster Menu", callback_data: "action:aster" }]);
      await bot.sendMessage(chatId, userMsg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: errButtons },
      });
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

  if (action === "type_stop_market") {
    await handleAsterAdvancedTypeCallback(chatId, "STOP_MARKET");
    return;
  }

  if (action === "type_tp_market") {
    await handleAsterAdvancedTypeCallback(chatId, "TAKE_PROFIT_MARKET");
    return;
  }

  if (action === "type_stop") {
    await handleAsterAdvancedTypeCallback(chatId, "STOP");
    return;
  }

  if (action === "type_tp") {
    await handleAsterAdvancedTypeCallback(chatId, "TAKE_PROFIT");
    return;
  }

  if (action === "type_trailing") {
    await handleAsterAdvancedTypeCallback(chatId, "TRAILING_STOP_MARKET");
    return;
  }

  if (action.startsWith("qty_")) {
    const qty = action.replace("qty_", "");
    const state = pendingAsterTrade.get(chatId);
    if (!state || state.step !== "quantity") {
      await bot.sendMessage(chatId, "No pending trade. Start over with /aster.");
      return;
    }
    const qtyNum = parseFloat(qty);
    if (isNaN(qtyNum) || qtyNum <= 0) {
      await bot.sendMessage(chatId, "Invalid quantity. Try again.");
      return;
    }
    state.quantity = qty;
    await handleAsterTradeFlow(chatId, qty);
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
      const fc = client.futures || client;
      await fc.cancelAllOrders(input);
      await bot.sendMessage(chatId, `✅ All open orders for *${input}* have been cancelled.`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(undefined, chatId) });
    } catch (e: any) {
      await bot.sendMessage(chatId, `Failed to cancel orders: ${e.message?.substring(0, 100)}`, { reply_markup: mainMenuKeyboard(undefined, chatId) });
    }
    pendingAsterTrade.delete(chatId);
    return;
  }

  if ((state as any).step === "confirm_tx_hash") {
    pendingAsterTrade.delete(chatId);
    const txHash = input.trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      await bot.sendMessage(chatId, "❌ Invalid transaction hash. It should be a 66-character hex string starting with 0x.\n\nTry again or tap Fund Account.", {
        reply_markup: { inline_keyboard: [[{ text: "💵 Fund Account", callback_data: "aster:fund" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
      return;
    }

    await bot.sendMessage(chatId, "⏳ Verifying transaction on BSC...");
    sendTyping(chatId);

    try {
      const receipt = await bnbProviderCached.getTransactionReceipt(txHash);
      if (!receipt) {
        await bot.sendMessage(chatId, "⏳ Transaction not found yet. It may still be pending.\n\nWait a minute and try again.", {
          reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "aster:confirm_deposit" }], [{ text: "« Fund", callback_data: "aster:fund" }]] },
        });
        return;
      }

      const wallet = getLinkedWallet(chatId);
      const success = receipt.status === 1;
      let depositAmount = 0;

      if (success && receipt.logs) {
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() === BSC_USDT.toLowerCase() && log.topics.length >= 3) {
            try {
              const value = BigInt(log.data);
              const amount = parseFloat(ethers.formatUnits(value, 18));
              if (amount > 0) depositAmount = amount;
            } catch {}
          }
        }
      }

      if (!success) {
        await bot.sendMessage(chatId, `❌ Transaction *failed* on-chain.\n\n[View on BSCScan](https://bscscan.com/tx/${txHash})`, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[{ text: "💵 Fund Account", callback_data: "aster:fund" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
        });
        return;
      }

      if (depositAmount > 0) {
        try {
          await storage.saveAsterLocalTrade({
            chatId: chatId.toString(),
            orderId: txHash,
            symbol: "USDT",
            side: "BUY",
            type: "DEPOSIT",
            quantity: depositAmount,
            executedQty: depositAmount,
            price: depositAmount,
            avgPrice: 1,
            status: "CONFIRMED",
            reduceOnly: false,
            leverage: 1,
          });
        } catch {}
      }

      let msg = `✅ *Deposit Confirmed!*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      msg += `✅ Status: *Success*\n`;
      msg += `💰 Amount: \`$${depositAmount > 0 ? depositAmount.toFixed(2) : "detected"} USDT\`\n`;
      msg += `📦 Block: \`${receipt.blockNumber}\`\n`;
      msg += `🔗 [View TX on BSCScan](https://bscscan.com/tx/${txHash})\n\n`;
      msg += `⏱️ Margin should appear within 1-2 minutes.\n`;
      msg += `You can now start trading!`;

      await bot.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: "📈 Trade Futures", callback_data: "aster:trade_futures" }],
            [{ text: "💰 Check Balance", callback_data: "aster:balance" }],
            [{ text: "« Aster Menu", callback_data: "action:aster" }],
          ],
        },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Error verifying TX: ${e.message?.substring(0, 150)}\n\nCheck the hash and try again.`, {
        reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "aster:confirm_deposit" }], [{ text: "« Fund", callback_data: "aster:fund" }]] },
      });
    }
    return;
  }

  if ((state as any).step === "v3dep_amount") {
    const amount = parseFloat(input);
    if (isNaN(amount) || amount < 1) {
      await bot.sendMessage(chatId, "Invalid amount. Enter a number (minimum $1). Or type /cancel.");
      return;
    }
    pendingAsterTrade.delete(chatId);

    if (!checkRateLimit(`tx:${chatId}`, 2, 30000)) {
      await bot.sendMessage(chatId, "⏳ Please wait before sending another transaction.", { reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] } });
      return;
    }
    const wallet = getLinkedWallet(chatId);
    if (!wallet) return;
    const pk = await resolvePrivateKey(chatId, wallet);
    if (!pk) {
      await bot.sendMessage(chatId, "❌ Could not access wallet key.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "action:aster" }]] } });
      return;
    }

    await bot.sendMessage(chatId, `⏳ Depositing \`$${amount}\` USDT into Aster Futures vault...`, { parse_mode: "Markdown" });
    sendTyping(chatId);
    try {
      const { asterV3Deposit } = await import("./aster-client");
      const result = await asterV3Deposit(pk, amount);
      if (!result.success) throw new Error(result.error || "Deposit failed");
      balanceCache.delete(wallet);
      await bot.sendMessage(chatId,
        `✅ *Deposit Successful!*\n━━━━━━━━━━━━━━━━━━━━\n\nDeposited \`$${amount} USDT\` into Aster Futures\n\n[View TX](https://bscscan.com/tx/${result.txHash})\n\n⏱️ Balance updates within 1-2 minutes.`,
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: [
          [{ text: "📈 Trade Futures", callback_data: "aster:trade_futures" }],
          [{ text: "💰 Check Balance", callback_data: "aster:balance" }],
          [{ text: "« Aster Menu", callback_data: "action:aster" }],
        ] } }
      );
    } catch (e: any) {
      await bot.sendMessage(chatId, `❌ Deposit failed: ${e.message?.substring(0, 200)}`, {
        reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "aster:fund" }], [{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
    }
    return;
  }

  if ((state as any).step === "fund_amount") {
    const amount = parseFloat(input);
    if (isNaN(amount) || amount < 1) {
      await bot.sendMessage(chatId, "Invalid amount. Enter a number (minimum $1). Or type /cancel.");
      return;
    }
    const asterClient = await getAsterClient(chatId);
    if (!asterClient) return;
    const spotClient = asterClient.spot || null;
    let depositAddr = "";
    if (spotClient) {
      try {
        const addrResult = await spotClient.getDepositAddress("USDT", "BSC");
        depositAddr = addrResult?.address || "";
      } catch {}
    }
    if (!depositAddr) {
      await bot.sendMessage(chatId, "Could not fetch Aster deposit address. Try again later.", {
        reply_markup: { inline_keyboard: [[{ text: "« Aster Menu", callback_data: "action:aster" }]] },
      });
      pendingAsterTrade.delete(chatId);
      return;
    }
    (state as any).step = "fund_confirm";
    (state as any).fundAmount = amount.toString();
    (state as any).depositAddress = depositAddr;
    pendingAsterTrade.set(chatId, state);
    await bot.sendMessage(chatId,
      `💵 *Confirm Deposit*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Amount: \`${amount} USDT\`\n` +
      `To: \`${depositAddr.substring(0, 8)}...${depositAddr.substring(depositAddr.length - 6)}\`\n` +
      `Network: BSC (BEP-20)\n\n` +
      `Confirm?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Send", callback_data: "aster:fund_confirm" }],
            [{ text: "❌ Cancel", callback_data: "action:aster" }],
          ],
        },
      }
    );
    return;
  }

  if ((state as any).step === "fund_transfer_amount") {
    const spotAvailable = parseFloat((state as any).spotAvailable || "0");
    let amount: number;
    if (input.toLowerCase() === "all") {
      amount = spotAvailable;
    } else {
      amount = parseFloat(input);
    }
    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(chatId, "Invalid amount. Enter a positive number or 'all'. Or type /cancel.");
      return;
    }
    if (amount > spotAvailable) {
      await bot.sendMessage(chatId, `Amount exceeds available ($${spotAvailable.toFixed(2)}). Enter a smaller amount or 'all'.`);
      return;
    }
    (state as any).step = "fund_transfer_confirm";
    (state as any).transferAmount = amount.toFixed(4);
    pendingAsterTrade.set(chatId, state);
    await bot.sendMessage(chatId,
      `🔄 *Confirm Transfer*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Move \`$${amount.toFixed(2)} USDT\` from Spot → Futures?\n`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Transfer", callback_data: "aster:fund_transfer_confirm" }],
            [{ text: "❌ Cancel", callback_data: "action:aster" }],
          ],
        },
      }
    );
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

    try {
      const asterClient = await getAsterClient(chatId);
      if (asterClient && state.market === "futures") {
        const futuresClient = asterClient.futures || asterClient;
        const [ticker, fundingArr] = await Promise.all([
          futuresClient.ticker(input).catch(() => null),
          futuresClient.fundingRate(input, 1).catch(() => []),
        ]);
        const t = Array.isArray(ticker) ? ticker[0] : ticker;
        const f = Array.isArray(fundingArr) && fundingArr.length > 0 ? fundingArr[0] : null;
        if (t) {
          const base = input.replace("USDT", "");
          const price = parseFloat(t.lastPrice || t.price);
          const change = parseFloat(t.priceChangePercent);
          const high = parseFloat(t.highPrice || t.high);
          const low = parseFloat(t.lowPrice || t.low);
          const changeIcon = change >= 0 ? "🟢" : "🔴";
          const changeStr = change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
          const fmtP = (v: number) => v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v.toPrecision(4);
          const fmtV = (v: number) => v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0);
          let infoMsg = `📈 *${base}/USDT — Futures*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
          infoMsg += `${changeIcon} *${base}/USDT*  \`$${fmtP(price)}\`\n`;
          infoMsg += `   ${changeStr} · H: \`$${fmtP(high)}\` · L: \`$${fmtP(low)}\`\n`;
          const vol = parseFloat(t.quoteVolume);
          infoMsg += `   Vol: \`$${fmtV(vol)}\`\n`;
          if (f) {
            const fr = parseFloat(f.fundingRate) * 100;
            const mp = parseFloat(f.markPrice || "0");
            const markVal = mp > 0 ? mp : price;
            infoMsg += `   Mark: \`$${fmtP(markVal)}\` · FR: \`${fr >= 0 ? "+" : ""}${fr.toFixed(4)}%\`\n`;
          }
          infoMsg += `\nChoose direction:`;
          await bot.sendMessage(chatId, infoMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🟢 BUY / LONG", callback_data: "aster:side_buy" }, { text: "🔴 SELL / SHORT", callback_data: "aster:side_sell" }],
                [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
              ],
            },
          });
          return;
        }
      }
    } catch (_) {}

    await bot.sendMessage(chatId,
      `Symbol: *${input}*\n\nChoose direction:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🟢 BUY / LONG", callback_data: "aster:side_buy" }, { text: "🔴 SELL / SHORT", callback_data: "aster:side_sell" }],
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

    if (state.orderType === "TRAILING_STOP_MARKET") {
      state.step = "callback_rate";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId, "Enter callback rate (%) for trailing stop (e.g. 1, 2.5, 5):");
      return;
    }

    if (state.orderType === "STOP" || state.orderType === "TAKE_PROFIT") {
      state.step = "stop_price";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId, `Enter the trigger price (stop price):`);
      return;
    }

    if (state.orderType === "STOP_MARKET" || state.orderType === "TAKE_PROFIT_MARKET") {
      state.step = "stop_price";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId, `Enter the trigger price:`);
      return;
    }

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

  if (state.step === "callback_rate") {
    const rate = parseFloat(input);
    if (isNaN(rate) || rate <= 0 || rate > 10) {
      await bot.sendMessage(chatId, "Invalid callback rate. Enter a number between 0.1 and 10 (%). Or type /cancel.");
      return;
    }
    state.callbackRate = rate.toString();
    if (state.market === "futures") {
      state.step = "leverage";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId, "Set leverage (1-125):", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1x", callback_data: "aster:lev_1" }, { text: "3x", callback_data: "aster:lev_3" }, { text: "5x", callback_data: "aster:lev_5" }],
            [{ text: "10x", callback_data: "aster:lev_10" }, { text: "20x", callback_data: "aster:lev_20" }, { text: "50x", callback_data: "aster:lev_50" }],
            [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
          ],
        },
      });
      return;
    }
    showAsterTradeConfirmation(chatId, state);
    return;
  }

  if (state.step === "stop_price") {
    const sp = parseFloat(input);
    if (isNaN(sp) || sp <= 0) {
      await bot.sendMessage(chatId, "Invalid price. Enter a positive number. Or type /cancel.");
      return;
    }
    state.stopPrice = input;

    if (state.orderType === "STOP" || state.orderType === "TAKE_PROFIT") {
      state.step = "price";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId, "Enter the limit price (execution price after trigger):");
      return;
    }

    if (state.market === "futures") {
      state.step = "leverage";
      pendingAsterTrade.set(chatId, state);
      await bot.sendMessage(chatId, "Set leverage (1-125):", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1x", callback_data: "aster:lev_1" }, { text: "3x", callback_data: "aster:lev_3" }, { text: "5x", callback_data: "aster:lev_5" }],
            [{ text: "10x", callback_data: "aster:lev_10" }, { text: "20x", callback_data: "aster:lev_20" }, { text: "50x", callback_data: "aster:lev_50" }],
            [{ text: "Cancel", callback_data: "aster:trade_cancel" }],
          ],
        },
      });
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

  const typeLabels: Record<string, string> = {
    "MARKET": "Market", "LIMIT": "Limit",
    "STOP": "Stop Limit", "STOP_MARKET": "Stop Loss",
    "TAKE_PROFIT": "Take Profit (Limit)", "TAKE_PROFIT_MARKET": "Take Profit",
    "TRAILING_STOP_MARKET": "Trailing Stop",
  };

  const sideIcon = state.side === "BUY" ? "🟢" : "🔴";
  const sideLabel = state.market === "futures" ? (state.side === "BUY" ? "LONG" : "SHORT") : state.side;
  let msg = `${sideIcon} *Confirm ${state.market === "futures" ? "Futures" : "Spot"} Order*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `📌 Pair: *${state.symbol}*\n`;
  msg += `${sideIcon} Side: *${sideLabel}*\n`;
  msg += `📋 Type: ${typeLabels[state.orderType || "MARKET"] || state.orderType}\n`;
  msg += `📦 Quantity: \`${state.quantity}\`\n`;
  if (state.price) msg += `💲 Price: \`$${state.price}\`\n`;
  if (state.stopPrice) msg += `🎯 Trigger: \`$${state.stopPrice}\`\n`;
  if (state.callbackRate) msg += `📐 Callback: \`${state.callbackRate}%\`\n`;
  if (state.market === "futures" && state.leverage) {
    msg += `⚡ Leverage: *${state.leverage}x*\n`;
    if (state.price && state.quantity) {
      const notional = parseFloat(state.quantity!) * parseFloat(state.price!);
      const margin = notional / state.leverage;
      msg += `💰 Est. Margin: \`~$${margin.toFixed(2)}\`\n`;
    }
  }

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

  const buttons: TelegramBot.InlineKeyboardButton[][] = [
    [{ text: "Market", callback_data: "aster:type_market" }, { text: "Limit", callback_data: "aster:type_limit" }],
  ];

  if (state.market === "futures") {
    buttons.push([
      { text: "Stop Loss", callback_data: "aster:type_stop_market" },
      { text: "Take Profit", callback_data: "aster:type_tp_market" },
    ]);
    buttons.push([
      { text: "Stop Limit", callback_data: "aster:type_stop" },
      { text: "TP Limit", callback_data: "aster:type_tp" },
    ]);
    buttons.push([{ text: "Trailing Stop", callback_data: "aster:type_trailing" }]);
  }
  buttons.push([{ text: "Cancel", callback_data: "aster:trade_cancel" }]);

  await bot.sendMessage(chatId,
    `${state.symbol} — ${side}\n\nOrder type:`,
    { reply_markup: { inline_keyboard: buttons } }
  );
}

async function showQuantityStep(chatId: number, state: AsterTradeState, typeLabel: string): Promise<void> {
  if (!bot) return;
  const side = state.side === "BUY" ? "🟢 LONG" : "🔴 SHORT";

  let balanceMsg = "";
  let priceMsg = "";
  let pctButtons: TelegramBot.InlineKeyboardButton[][] = [];

  try {
    const client = await getAsterClient(chatId);
    if (client) {
      const fc = client.futures || client;
      const [balances, tickerData] = await Promise.all([
        fc.balance().catch(() => []),
        fc.tickerPrice(state.symbol).catch(() => null),
      ]);

      const usdtBal = (balances as any[]).find((b: any) => b.asset === "USDT" || b.asset === "usdt");
      const availBal = usdtBal ? parseFloat(usdtBal.availableBalance || usdtBal.balance || "0") : 0;

      const currentPrice = tickerData?.price ? parseFloat(tickerData.price) : 0;

      if (availBal > 0) {
        balanceMsg = `💰 Available: \`${availBal.toFixed(2)} USDT\`\n`;
      }
      if (currentPrice > 0) {
        priceMsg = `📊 Price: \`$${currentPrice >= 1 ? currentPrice.toLocaleString("en-US", { maximumFractionDigits: 2 }) : currentPrice.toPrecision(4)}\`\n`;
      }

      if (availBal > 0 && currentPrice > 0) {
        const pcts = [10, 25, 50, 75, 100];
        const row: TelegramBot.InlineKeyboardButton[] = pcts.map(pct => {
          const usdtAmount = availBal * pct / 100;
          const qty = (usdtAmount / currentPrice).toFixed(currentPrice >= 100 ? 3 : currentPrice >= 1 ? 2 : 4);
          return { text: `${pct}%`, callback_data: `aster:qty_${qty}` };
        });
        pctButtons.push(row);

        const presetAmounts = [5, 10, 25, 50, 100].filter(a => a <= availBal);
        if (presetAmounts.length > 0) {
          const usdRow: TelegramBot.InlineKeyboardButton[] = presetAmounts.map(amt => {
            const qty = (amt / currentPrice).toFixed(currentPrice >= 100 ? 3 : currentPrice >= 1 ? 2 : 4);
            return { text: `$${amt}`, callback_data: `aster:qty_${qty}` };
          });
          pctButtons.push(usdRow);
        }
      }
    }
  } catch {}

  pctButtons.push([{ text: "❌ Cancel", callback_data: "aster:trade_cancel" }]);

  const msg = `*${state.symbol}* — ${side} ${typeLabel}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${balanceMsg}${priceMsg}\n` +
    `Enter quantity in ${state.symbol?.replace("USDT", "") || "tokens"}, or pick below:\n` +
    `_e.g. 0.001 BTC, 0.1 ETH, 1 BNB_`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: pctButtons },
  });
}

async function handleAsterTypeCallback(chatId: number, orderType: "MARKET" | "LIMIT"): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state || state.step !== "type") return;

  state.orderType = orderType;
  state.step = "quantity";
  pendingAsterTrade.set(chatId, state);

  await showQuantityStep(chatId, state, orderType);
}

async function handleAsterAdvancedTypeCallback(chatId: number, orderType: "STOP" | "STOP_MARKET" | "TAKE_PROFIT" | "TAKE_PROFIT_MARKET" | "TRAILING_STOP_MARKET"): Promise<void> {
  if (!bot) return;
  const state = pendingAsterTrade.get(chatId);
  if (!state || state.step !== "type") return;

  state.orderType = orderType;
  state.step = "quantity";
  pendingAsterTrade.set(chatId, state);

  const typeLabels: Record<string, string> = {
    "STOP": "Stop Limit", "STOP_MARKET": "Stop Loss",
    "TAKE_PROFIT": "Take Profit (Limit)", "TAKE_PROFIT_MARKET": "Take Profit",
    "TRAILING_STOP_MARKET": "Trailing Stop",
  };
  await showQuantityStep(chatId, state, typeLabels[orderType]);
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

async function checkLimitOrdersAndAlerts(bot: any) {
  const activeOrders = Array.from(limitOrders.values()).filter(o => o.status === "active");
  const tokenPriceCache = new Map<string, number>();

  for (const order of activeOrders) {
    const key = `${order.tokenAddress}:${order.chainId}`;
    let price = tokenPriceCache.get(key);
    if (price === undefined) {
      try {
        const result = await getTokenPrice(order.tokenAddress, order.chainId);
        if (result.success && result.data?.price) {
          price = parseFloat(result.data.price);
          tokenPriceCache.set(key, price);
        }
      } catch {}
    }
    if (price === undefined) continue;

    let triggered = false;
    if (order.type === "buy" && price <= order.triggerPrice) triggered = true;
    if (order.type === "sell" && price >= order.triggerPrice) triggered = true;

    if (triggered) {
      order.status = "triggered";
      limitOrders.delete(order.id);
      saveLimitOrders();

      const isSolana = order.chainId === "501";
      const chainName = isSolana ? "Solana" : order.chainId === "8453" ? "Base" : "BNB Chain";
      const autoApprove = getUserSettings(order.chatId).autoApprove;

      if (autoApprove && order.type === "buy") {
        try {
          await bot.sendMessage(order.chatId,
            `🔔 *Limit Order Triggered — Auto-Executing!*\n\n` +
            `🟢 *BUY* ${order.amount} ${order.nativeSymbol}\n` +
            `Token: \`${order.tokenAddress.substring(0, 12)}...\`${order.tokenName ? ` (${order.tokenName})` : ""}\n` +
            `Price hit $${price < 0.01 ? price.toExponential(3) : price.toFixed(6)} (target: $${order.triggerPrice < 0.01 ? order.triggerPrice.toExponential(3) : order.triggerPrice.toFixed(6)})\n\n` +
            `⏳ Executing swap on ${chainName}...`,
            { parse_mode: "Markdown" }
          );
          pendingSignalBuy.set(order.chatId, {
            tokenAddress: order.tokenAddress,
            tokenSymbol: order.tokenName || "Token",
            chainId: order.chainId,
            chainName,
            nativeSymbol: order.nativeSymbol,
            amount: order.amount,
            step: "confirm",
          });
          const fakeQuery = { id: `limit_auto_${order.id}`, from: { id: order.chatId, first_name: "User" }, data: "sigbuy_confirm" } as any;
          bot.emit("callback_query", fakeQuery);
        } catch (e: any) {
          console.error(`[LimitChecker] Auto-execute setup failed for ${order.id}:`, e.message);
        }
      } else {
        try {
          const actionBtn = order.type === "buy"
            ? [{ text: `⚡ Buy ${order.amount} ${order.nativeSymbol}`, callback_data: `cabuy:${order.tokenAddress}:${order.chainId}:${order.amount}` }]
            : [{ text: `🔴 Sell Now`, callback_data: `selltoken:${order.tokenAddress}:${order.chainId}` }];
          await bot.sendMessage(order.chatId,
            `🔔 *Limit Order Triggered!*\n\n` +
            `${order.type === "buy" ? "🟢" : "🔴"} *${order.type.toUpperCase()}* ${order.amount} ${order.nativeSymbol}\n` +
            `Token: \`${order.tokenAddress.substring(0, 12)}...\`${order.tokenName ? ` (${order.tokenName})` : ""}\n` +
            `Trigger: $${order.triggerPrice < 0.01 ? order.triggerPrice.toExponential(3) : order.triggerPrice.toFixed(6)}\n` +
            `Current: $${price < 0.01 ? price.toExponential(3) : price.toFixed(6)}\n\n` +
            `Tap below to execute:`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
              actionBtn,
              [{ text: "📋 Limit Orders", callback_data: "action:limitorders" }],
              [{ text: "« Menu", callback_data: "action:menu" }],
            ] } }
          );
        } catch (e: any) {
          console.error(`[LimitChecker] Failed to notify ${order.chatId}:`, e.message);
        }
      }
    }
  }

  const watchEntries = Array.from(userWatchlists.entries());
  for (const [chatId, list] of watchEntries) {
    for (const item of list) {
      const key = `${item.tokenAddress}:${item.chainId}`;
      let price = tokenPriceCache.get(key);
      if (price === undefined) {
        try {
          const result = await getTokenPrice(item.tokenAddress, item.chainId);
          if (result.success && result.data?.price) {
            price = parseFloat(result.data.price);
            tokenPriceCache.set(key, price);
          }
        } catch {}
      }
      if (price === undefined) continue;
      item.lastPrice = price;

      const now = Date.now();
      if (item.lastAlertAt && now - item.lastAlertAt < 5 * 60 * 1000) continue;

      let alertMsg = "";
      if (item.alertAbove && price >= item.alertAbove) {
        alertMsg = `🔔 *Price Alert*\n\n*${item.tokenSymbol || item.tokenAddress.substring(0, 8) + "..."}* is above your target!\n\nCurrent: $${price < 0.01 ? price.toExponential(3) : price.toFixed(6)}\nTarget: $${item.alertAbove < 0.01 ? item.alertAbove.toExponential(3) : item.alertAbove.toFixed(6)}`;
        item.alertAbove = undefined;
      }
      if (item.alertBelow && price <= item.alertBelow) {
        alertMsg = `🔔 *Price Alert*\n\n*${item.tokenSymbol || item.tokenAddress.substring(0, 8) + "..."}* is below your target!\n\nCurrent: $${price < 0.01 ? price.toExponential(3) : price.toFixed(6)}\nTarget: $${item.alertBelow < 0.01 ? item.alertBelow.toExponential(3) : item.alertBelow.toFixed(6)}`;
        item.alertBelow = undefined;
      }

      if (alertMsg) {
        item.lastAlertAt = now;
        try {
          await bot.sendMessage(chatId, alertMsg, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
            [{ text: `🟢 Buy`, callback_data: `cabuy:${item.tokenAddress}:${item.chainId}:0.05` }, { text: `🔴 Sell`, callback_data: `selltoken:${item.tokenAddress}:${item.chainId}` }],
            [{ text: "👁️ Watchlist", callback_data: "action:watchlist" }],
          ] } });
        } catch (e: any) {
          console.error(`[WatchlistAlert] Failed to notify ${chatId}:`, e.message);
        }
      }
    }
  }
}

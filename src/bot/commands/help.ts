import type { BotContext } from "../middleware/auth.js";

export async function helpCommand(ctx: BotContext) {
  await ctx.reply(
    `📖 *Build4 Bot Commands*\n\n` +
    `*💰 Wallet*\n` +
    `/start — Create account & wallet\n` +
    `/wallet — View wallets & balances\n\n` +
    `*🤖 Trading Agents*\n` +
    `/newagent — Create a trading agent\n` +
    `/agents — View your agents\n` +
    `/trade — Start/stop trading\n` +
    `/tradestatus — View open positions\n\n` +
    `*📊 Market*\n` +
    `/signals — Smart money signals\n` +
    `/scan <address> — Scan a contract\n` +
    `/buy <token> <amount> — Buy tokens\n` +
    `/sell — Sell your tokens\n\n` +
    `*🏆 Social*\n` +
    `/copytrade — Copy top traders\n` +
    `/portfolio — Your portfolio & PnL\n` +
    `/quests — Earn rewards\n\n` +
    `*🚀 Launch*\n` +
    `/launch — Launch your own token`,
    { parse_mode: "Markdown" }
  );
}

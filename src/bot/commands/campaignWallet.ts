import { Bot, Context } from 'grammy';
import { db } from '../../db';
import { generateAndSaveWallet } from '../../services/wallet';
import { isAdminTelegramId } from '../../services/telegramAuth';

// ── Admin-only commands for the 42.space campaign ────────────────────────
//
// /newcampaignwallet              — generates a fresh BSC wallet, label "Campaign",
//                                    prints the address so you can pre-fund it.
// /bindcampaignwallet <agentId>   — pins your most recent "Campaign"-labelled
//                                    wallet to the given Agent (Agent.walletId).
// /campaignstatus                 — shows current campaign env config + bound agent.
//
// All three require the caller's Telegram ID to be in ADMIN_TELEGRAM_IDS.
// Without that env, the commands silently no-op (so a non-admin spamming
// the command can't fingerprint that the campaign exists).

function isAdmin(ctx: Context): boolean {
  const tg = ctx.from?.id;
  if (!tg) return false;
  return isAdminTelegramId(BigInt(tg));
}

export function registerCampaignWallet(bot: Bot) {
  bot.command('newcampaignwallet', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const user = (ctx as any).dbUser;
    if (!user) {
      await ctx.reply('No user record found for your Telegram ID.');
      return;
    }
    try {
      const w = await generateAndSaveWallet(user.id, 'BSC', 'Campaign');
      await ctx.reply(
        `🆕 *Campaign wallet created*\n\n` +
          `Address: \`${w.address}\`\n` +
          `Label: Campaign\n\n` +
          `Pre-fund this address with USDT (BSC) before the campaign starts, ` +
          `then bind it to your campaign agent with:\n\n` +
          `\`/bindcampaignwallet <agentId>\`\n\n` +
          `Then set in env:\n` +
          `\`FT_CAMPAIGN_MODE=true\`\n` +
          `\`FT_CAMPAIGN_AGENT_ID=<agentId>\`\n` +
          `\`FT_CAMPAIGN_TG_CHANNEL=@your_channel\` (optional)\n` +
          `\`FT_CAMPAIGN_START_MS=<unix ms of round 1>\` (optional, for "Round X/12" labels)`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      await ctx.reply(`Wallet generation failed: ${(err as Error).message}`);
    }
  });

  bot.command('bindcampaignwallet', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const user = (ctx as any).dbUser;
    if (!user) {
      await ctx.reply('No user record found for your Telegram ID.');
      return;
    }
    const arg = (ctx.message?.text ?? '').split(/\s+/).slice(1).join(' ').trim();
    if (!arg) {
      await ctx.reply('Usage: `/bindcampaignwallet <agentName-or-id>`', { parse_mode: 'Markdown' });
      return;
    }
    // Find the most-recent Campaign-labelled wallet for this user.
    const w = await db.wallet.findFirst({
      where: { userId: user.id, chain: 'BSC', label: 'Campaign' },
      orderBy: { createdAt: 'desc' },
    });
    if (!w) {
      await ctx.reply('No "Campaign"-labelled wallet found. Run `/newcampaignwallet` first.', { parse_mode: 'Markdown' });
      return;
    }
    // Resolve <arg> to an Agent owned by this user, accepting either:
    //   1. The internal cuid (Agent.id) — exact match, fastest path.
    //   2. The display name (case-insensitive, exact) — UX shortcut for
    //      admins who only see the name in /myagents output.
    // Restricted to this user's agents so a name collision with someone
    // else's agent can never bind cross-user. If the name resolves to
    // multiple of *your own* agents, we refuse and ask for the cuid so
    // the operator never accidentally binds the wrong one mid-campaign.
    let agent: { id: string; userId: string; name: string; walletId: string | null } | undefined;
    const byId = await db.$queryRawUnsafe<Array<{ id: string; userId: string; name: string; walletId: string | null }>>(
      `SELECT id, "userId", name, "walletId" FROM "Agent" WHERE id = $1 AND "userId" = $2 LIMIT 1`,
      arg,
      user.id,
    );
    if (byId[0]) {
      agent = byId[0];
    } else {
      const byName = await db.$queryRawUnsafe<Array<{ id: string; userId: string; name: string; walletId: string | null }>>(
        `SELECT id, "userId", name, "walletId" FROM "Agent" WHERE LOWER(name) = LOWER($1) AND "userId" = $2`,
        arg,
        user.id,
      );
      if (byName.length > 1) {
        await ctx.reply(
          `Multiple agents named \`${arg}\` (${byName.length}). Use the cuid instead:\n\n` +
            byName.map((a) => `• \`${a.id}\``).join('\n'),
          { parse_mode: 'Markdown' },
        );
        return;
      }
      agent = byName[0];
    }
    if (!agent) {
      await ctx.reply(`Agent \`${arg}\` not found in your account.`, { parse_mode: 'Markdown' });
      return;
    }
    if (agent.userId !== user.id) {
      await ctx.reply('You can only bind a wallet to your own agent.');
      return;
    }
    await db.$executeRawUnsafe(
      `UPDATE "Agent" SET "walletId" = $1 WHERE id = $2`,
      w.id,
      agent.id,
    );
    await ctx.reply(
      `✅ *Bound*\n\n` +
        `Agent: ${agent.name} (\`${agent.id}\`)\n` +
        `Wallet: \`${w.address}\` (label: Campaign)\n\n` +
        (agent.walletId
          ? `⚠️ Replaced previous binding (was \`${agent.walletId}\`).\n\n`
          : '') +
        `Now set \`FT_CAMPAIGN_MODE=true\` and \`FT_CAMPAIGN_AGENT_ID=${agent.id}\` in your env, then redeploy.`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('campaignstatus', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const mode = process.env.FT_CAMPAIGN_MODE === 'true';
    const agentId = process.env.FT_CAMPAIGN_AGENT_ID ?? '<unset>';
    const channel = process.env.FT_CAMPAIGN_TG_CHANNEL ?? '<unset>';
    const startMs = process.env.FT_CAMPAIGN_START_MS ?? '<unset>';
    let agentLine = '';
    if (mode && process.env.FT_CAMPAIGN_AGENT_ID) {
      const rows = await db.$queryRawUnsafe<Array<{ id: string; name: string; walletId: string | null; userId: string }>>(
        `SELECT id, name, "walletId", "userId" FROM "Agent" WHERE id = $1 LIMIT 1`,
        process.env.FT_CAMPAIGN_AGENT_ID,
      );
      if (rows.length) {
        agentLine = `\nAgent: ${rows[0].name} (walletId=${rows[0].walletId ?? '<unbound>'})`;
      } else {
        agentLine = `\nAgent: <not found in DB>`;
      }
    }
    await ctx.reply(
      `🤖 *Campaign status*\n\n` +
        `FT_CAMPAIGN_MODE: ${mode ? '✅ on' : '❌ off'}\n` +
        `FT_CAMPAIGN_AGENT_ID: \`${agentId}\`\n` +
        `FT_CAMPAIGN_TG_CHANNEL: ${channel}\n` +
        `FT_CAMPAIGN_START_MS: ${startMs}` +
        agentLine,
      { parse_mode: 'Markdown' },
    );
  });
}

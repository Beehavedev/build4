import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import { encryptPrivateKey, getBalance } from "../../services/wallet.js";
import { getAsterAccountBalance } from "../../services/aster.js";
import type { BotContext } from "../middleware/auth.js";

const prisma = new PrismaClient();

const pendingImports = new Map<number, { step: string; timestamp: number }>();

export async function importWalletCommand(ctx: BotContext) {
  if (!ctx.dbUser || !ctx.from) {
    await ctx.reply("Please use /start first.");
    return;
  }

  pendingImports.set(ctx.from.id, { step: "awaiting_key", timestamp: Date.now() });

  await ctx.reply(
    "🔑 *Import Existing Wallet*\n\n" +
    "Send your wallet's private key to link it to Build4.\n\n" +
    "This lets you:\n" +
    "• See your Aster DEX balance\n" +
    "• Trade on Aster through Build4\n" +
    "• Use AI agents with your funds\n\n" +
    "⚠️ Your key will be encrypted and stored securely.\n" +
    "Paste your private key now (with or without 0x prefix):",
    { parse_mode: "Markdown" }
  );
}

export async function handleImportMessage(ctx: BotContext): Promise<boolean> {
  if (!ctx.from || !ctx.dbUser || !ctx.message?.text) return false;

  const pending = pendingImports.get(ctx.from.id);
  if (!pending || pending.step !== "awaiting_key") return false;

  if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
    pendingImports.delete(ctx.from.id);
    return false;
  }

  pendingImports.delete(ctx.from.id);

  const rawKey = ctx.message.text.trim();

  try {
    await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id);
  } catch {}

  let pk = rawKey;
  if (!pk.startsWith("0x")) pk = "0x" + pk;

  try {
    const wallet = new ethers.Wallet(pk);
    const address = wallet.address;

    const existing = await prisma.wallet.findFirst({
      where: { userId: ctx.dbUser.id, address: { equals: address, mode: "insensitive" } },
    });

    if (existing) {
      await prisma.wallet.update({
        where: { id: existing.id },
        data: { encryptedPK: encryptPrivateKey(pk, ctx.dbUser.id) },
      });
      await prisma.wallet.updateMany({
        where: { userId: ctx.dbUser.id },
        data: { isActive: false },
      });
      await prisma.wallet.update({
        where: { id: existing.id },
        data: { isActive: true },
      });
    } else {
      await prisma.wallet.updateMany({
        where: { userId: ctx.dbUser.id },
        data: { isActive: false },
      });

      const count = await prisma.wallet.count({ where: { userId: ctx.dbUser.id } });
      await prisma.wallet.create({
        data: {
          userId: ctx.dbUser.id,
          chain: "BSC",
          address,
          encryptedPK: encryptPrivateKey(pk, ctx.dbUser.id),
          label: `Imported ${count + 1}`,
          isActive: true,
        },
      });
    }

    const shortAddr = address.slice(0, 6) + "..." + address.slice(-4);
    let statusText = `✅ *Wallet Imported!*\n\n`;
    statusText += `Address: \`${shortAddr}\`\n\n`;

    const loadingMsg = await ctx.reply(statusText + "Checking balances...", { parse_mode: "Markdown" });

    try {
      const [bal, asterBal] = await Promise.all([
        getBalance(address, "BSC"),
        getAsterAccountBalance(pk),
      ]);

      statusText += `💰 *BSC Wallet:*\n`;
      statusText += `BNB: ${parseFloat(bal.native).toFixed(6)}\n`;
      statusText += `USDT: ${parseFloat(bal.usdt).toFixed(2)}\n\n`;

      if (asterBal.accountValue > 0) {
        statusText += `⭐ *Aster DEX Account:*\n`;
        statusText += `Account Value: $${asterBal.accountValue.toFixed(2)}\n`;
        statusText += `Available: $${asterBal.availableBalance.toFixed(2)}\n`;
        statusText += `Margin Used: $${asterBal.marginUsed.toFixed(2)}\n`;
        statusText += `Unrealized PnL: $${asterBal.unrealizedPnl.toFixed(2)}\n`;
      } else {
        statusText += `⭐ *Aster DEX:* No balance found yet\n`;
        statusText += `Use /bridge to deposit funds to Aster\n`;
      }

      await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, statusText, { parse_mode: "Markdown" });
    } catch {
      await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, statusText + "Balance check pending...", { parse_mode: "Markdown" });
    }

  } catch (err: any) {
    await ctx.reply(
      "❌ *Invalid Private Key*\n\n" +
      "The key you provided is not a valid EVM private key.\n" +
      "Make sure it's a 64-character hex string.\n\n" +
      "Use /importwallet to try again.",
      { parse_mode: "Markdown" }
    );
  }
}

export function isAwaitingImport(telegramId: number): boolean {
  const pending = pendingImports.get(telegramId);
  if (!pending) return false;
  if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
    pendingImports.delete(telegramId);
    return false;
  }
  return pending.step === "awaiting_key";
}

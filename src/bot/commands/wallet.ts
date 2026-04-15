import { PrismaClient } from "@prisma/client";
import { generateEVMWallet, encryptPrivateKey, getBalance } from "../../services/wallet.js";
import type { BotContext } from "../middleware/auth.js";

const prisma = new PrismaClient();

export async function walletCommand(ctx: BotContext) {
  if (!ctx.dbUser) {
    await ctx.reply("Please use /start first.");
    return;
  }

  try {
    const wallets = await prisma.wallet.findMany({
      where: { userId: ctx.dbUser.id },
      orderBy: { createdAt: "asc" },
    });

    if (wallets.length === 0) {
      await ctx.reply("You don't have a wallet yet. Use /start to create one.");
      return;
    }

    let text = "💰 *Your Wallets*\n\n";

    for (const w of wallets) {
      const active = w.isActive ? " ✅" : "";
      const shortAddr = w.address.slice(0, 6) + "..." + w.address.slice(-4);
      text += `*${w.label}* (${w.chain})${active}\n`;
      text += `\`${w.address}\`\n`;

      if (w.isActive) {
        try {
          const bal = await getBalance(w.address, w.chain);
          const nativeName = w.chain === "BSC" ? "BNB" : w.chain === "ETH" ? "ETH" : "Native";
          text += `${nativeName}: ${parseFloat(bal.native).toFixed(6)}\n`;
          text += `USDT: ${parseFloat(bal.usdt).toFixed(2)}\n`;
        } catch {
          text += `Balance: loading...\n`;
        }
      }
      text += "\n";
    }

    await ctx.reply(text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "➕ New Wallet", callback_data: "wallet_new" },
            { text: "🔄 Switch Active", callback_data: "wallet_switch" },
          ],
          [
            { text: "🔑 Export Key", callback_data: "wallet_export" },
            { text: "🔄 Refresh", callback_data: "cmd_wallet" },
          ],
        ],
      },
    });
  } catch (err: any) {
    console.error("[WALLET] Error:", err.message);
    await ctx.reply("⚠️ Error loading wallets. Please try again.");
  }
}

export async function handleWalletCallback(ctx: BotContext, action: string) {
  if (!ctx.dbUser) return;

  if (action === "wallet_new") {
    const { address, privateKey } = generateEVMWallet();
    const encrypted = encryptPrivateKey(privateKey, ctx.dbUser.id);
    const count = await prisma.wallet.count({ where: { userId: ctx.dbUser.id } });

    await prisma.wallet.create({
      data: {
        userId: ctx.dbUser.id,
        chain: "BSC",
        address,
        encryptedPK: encrypted,
        label: `Wallet ${count + 1}`,
        isActive: false,
      },
    });

    await ctx.answerCallbackQuery({ text: "New wallet created!" });
    await walletCommand(ctx);
  } else if (action === "wallet_switch") {
    const wallets = await prisma.wallet.findMany({
      where: { userId: ctx.dbUser.id },
    });

    if (wallets.length <= 1) {
      await ctx.answerCallbackQuery({ text: "You only have one wallet." });
      return;
    }

    const buttons = wallets.map((w) => ({
      text: `${w.isActive ? "✅ " : ""}${w.label}`,
      callback_data: `wallet_activate_${w.id}`,
    }));

    await ctx.reply("Select wallet to activate:", {
      reply_markup: {
        inline_keyboard: buttons.map((b) => [b]),
      },
    });
  } else if (action === "wallet_export") {
    await ctx.reply(
      "⚠️ *Security Warning*\n\nExporting your private key is dangerous. " +
      "Anyone with your key can steal your funds.\n\n" +
      "Type `I CONFIRM` to proceed.",
      { parse_mode: "Markdown" }
    );
  } else if (action.startsWith("wallet_activate_")) {
    const walletId = action.replace("wallet_activate_", "");
    await prisma.wallet.updateMany({
      where: { userId: ctx.dbUser.id },
      data: { isActive: false },
    });
    await prisma.wallet.update({
      where: { id: walletId },
      data: { isActive: true },
    });
    await ctx.answerCallbackQuery({ text: "Wallet switched!" });
    await walletCommand(ctx);
  }
}

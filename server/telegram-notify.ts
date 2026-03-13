const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegramDirect(chatId: number | string, text: string, options?: { parse_mode?: string; reply_markup?: any }): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  try {
    const body: any = { chat_id: chatId, text };
    if (options?.parse_mode) body.parse_mode = options.parse_mode;
    if (options?.reply_markup) body.reply_markup = options.reply_markup;

    const resp = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    const data = await resp.json() as any;
    if (!data.ok) {
      console.error(`[TelegramNotify] sendMessage failed: ${data.description}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error(`[TelegramNotify] sendMessage error: ${e.message}`);
    return false;
  }
}

export async function sendTokenProposalDirect(
  chatId: number,
  proposalId: string,
  agentName: string,
  tokenName: string,
  tokenSymbol: string,
  platform: string,
  description: string
): Promise<boolean> {
  const platformName = platform === "four_meme" ? "Four.meme (BNB Chain)" : platform === "bankr" ? "Bankr (Base)" : "Flap.sh (BNB Chain)";
  const liquidity = platform === "bankr" ? "Managed by Bankr" : "0.01 BNB";

  return sendTelegramDirect(chatId,
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
}

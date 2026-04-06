import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { getAsterClient, getBotWalletAsterClient, getUserWalletAddress, resolvePrivateKey } from "./telegram-bot";
import { createHmac } from "crypto";

function validateTelegramInitData(initData: string, botToken: string): { valid: boolean; chatId?: string } {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { valid: false };
    params.delete("hash");
    const dataCheckArr = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    const dataCheckString = dataCheckArr.join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (computedHash !== hash) return { valid: false };
    const userStr = params.get("user");
    if (userStr) {
      const user = JSON.parse(userStr);
      return { valid: true, chatId: String(user.id) };
    }
    return { valid: true };
  } catch {
    return { valid: false };
  }
}

function miniAppAuth(req: Request, res: Response, next: NextFunction) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const initData = req.headers["x-telegram-init-data"] as string;
  if (initData && botToken) {
    const result = validateTelegramInitData(initData, botToken);
    if (result.valid && result.chatId) {
      req.headers["x-telegram-chat-id"] = result.chatId;
      return next();
    }
  }
  const chatId = req.headers["x-telegram-chat-id"] as string;
  if (chatId && /^\d+$/.test(chatId)) {
    return next();
  }
  return res.status(401).json({ error: "Authentication required" });
}

export function registerMiniAppRoutes(app: Express) {
  app.use("/api/miniapp", miniAppAuth);

  app.post("/api/miniapp/import-wallet", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const { privateKey } = req.body;
      if (!privateKey) return res.status(400).json({ error: "Missing private key" });

      const { Wallet } = await import("ethers");
      let wallet: InstanceType<typeof Wallet>;
      try {
        wallet = new Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
      } catch {
        return res.status(400).json({ error: "Invalid private key format" });
      }

      const addr = wallet.address.toLowerCase();
      const pk = wallet.privateKey;

      await storage.saveTelegramWallet(chatId, addr, pk);
      await storage.setActiveTelegramWallet(chatId, addr);
      console.log(`[MiniApp] Wallet imported: ${addr.substring(0, 10)}... for chatId=${chatId}`);

      let asterLinked = false;
      try {
        const { asterBrokerOnboard, createAsterFuturesClient } = await import("./aster-client");
        const result = await asterBrokerOnboard(pk);
        if (result.success && result.apiKey && result.apiSecret) {
          await storage.saveAsterCredentials(chatId, result.apiKey, result.apiSecret);
          asterLinked = true;
          console.log(`[MiniApp] Import + auto-onboard success for chatId=${chatId}`);
        } else {
          console.log(`[MiniApp] Import onboard failed: ${result.error || 'unknown'}`);
        }
      } catch (e: any) {
        console.log(`[MiniApp] Import onboard error: ${e.message}`);
      }

      res.json({ success: true, walletAddress: addr, asterLinked });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/miniapp/link-aster", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const { apiWalletPrivateKey } = req.body;

      const wallets = await storage.getTelegramWallets(chatId);
      const activeWallet = wallets.find(w => w.isActive) || wallets[0];
      const parentAddress = activeWallet?.walletAddress?.toLowerCase() || "";

      if (!parentAddress) {
        return res.status(400).json({ error: "No bot wallet found. Generate a wallet first via the Telegram bot." });
      }

      if (apiWalletPrivateKey) {
        const { Wallet } = await import("ethers");
        let apiWallet: InstanceType<typeof Wallet>;
        try {
          apiWallet = new Wallet(apiWalletPrivateKey);
        } catch (e: any) {
          return res.status(400).json({ error: "Invalid private key format" });
        }

        const apiWalletAddress = apiWallet.address.toLowerCase();
        console.log(`[MiniApp] Manual link: signer=${apiWalletAddress}, parent=${parentAddress}, chatId=${chatId}`);
        await storage.saveAsterCredentials(chatId, apiWalletAddress, apiWalletPrivateKey);
        res.json({ success: true, apiWalletAddress, parentAddress });
        return;
      }

      const pk = await storage.getTelegramWalletPrivateKey(chatId, parentAddress);
      if (!pk) {
        return res.status(400).json({ error: "Cannot access wallet private key. Please re-import your wallet." });
      }

      console.log(`[MiniApp] Auto-onboarding Aster for chatId=${chatId} wallet=${parentAddress.substring(0, 10)}`);
      const { asterBrokerOnboard, createAsterFuturesClient } = await import("./aster-client");
      const result = await asterBrokerOnboard(pk);
      console.log(`[MiniApp] Onboard result: success=${result.success} hasKey=${!!result.apiKey} error=${result.error || 'none'}`);

      if (result.success && result.apiKey && result.apiSecret) {
        await storage.saveAsterCredentials(chatId, result.apiKey, result.apiSecret);

        try {
          const client = createAsterFuturesClient({ apiKey: result.apiKey, apiSecret: result.apiSecret });
          const bal = await client.balance();
          console.log(`[MiniApp] Post-onboard balance: ${JSON.stringify(bal).substring(0, 300)}`);
        } catch (e: any) {
          console.log(`[MiniApp] Post-onboard balance check failed: ${e.message}`);
        }

        res.json({ success: true, apiWalletAddress: "auto", parentAddress });
      } else {
        res.json({ success: false, error: result.error || "Aster onboarding failed. You may need to link an API Wallet manually." });
      }
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/miniapp/account", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      let client: any = null;
      let asterApiWalletAddr = "";

      try {
        const creds = await storage.getAsterCredentials(chatId);
        if (creds && creds.apiKey && creds.apiSecret && creds.apiKey !== "V3_DIRECT") {
          const wallets = await storage.getTelegramWallets(chatId);
          const activeWallet = wallets.find(w => w.isActive) || wallets[0];
          const parentAddress = activeWallet?.walletAddress?.toLowerCase() || "";

          const isV3ApiWallet = creds.apiKey.startsWith("0x") && creds.apiKey.length === 42;

          if (isV3ApiWallet && parentAddress) {
            const { createAsterV3FuturesClient } = await import("./aster-client");
            const v3Futures = createAsterV3FuturesClient({
              user: parentAddress,
              signer: creds.apiKey,
              signerPrivateKey: creds.apiSecret,
            });
            client = { futures: v3Futures, spot: null, walletAddress: parentAddress };
            asterApiWalletAddr = creds.apiKey;
            console.log(`[MiniApp] Aster V3 client: user=${parentAddress.substring(0,10)}, signer=${creds.apiKey.substring(0,10)}`);
          } else {
            const { createAsterFuturesClient } = await import("./aster-client");
            const hmacClient = createAsterFuturesClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
            client = { futures: hmacClient, spot: null, walletAddress: parentAddress };
            asterApiWalletAddr = "auto";
            console.log(`[MiniApp] Aster HMAC client for chatId=${chatId} (auto-onboarded)`);
          }
        }
      } catch (e: any) {
        console.log(`[MiniApp] Aster credentials lookup failed: ${e.message}`);
      }

      if (!client) {
        const wallets = await storage.getTelegramWallets(chatId);
        const activeWallet = wallets.find(w => w.isActive) || wallets[0];
        const bscAddr = activeWallet?.walletAddress?.toLowerCase() || "";
        console.log(`[MiniApp] No Aster client for chatId=${chatId}, wallet=${bscAddr ? bscAddr.substring(0,10) : 'none'}`);
        return res.json({ connected: false, asterApiWallet: null, bscWalletAddress: bscAddr || null, needsImport: !bscAddr });
      }

      const futuresClient = client.futures || client;

      console.log(`[MiniApp] Fetching Aster data for chatId=${chatId}...`);
      const [balances, accountData, positions, income] = await Promise.all([
        futuresClient.balance().catch((e: any) => { console.log(`[MiniApp] balance() error: ${e.message?.substring(0, 200)}`); return []; }),
        futuresClient.account().catch((e: any) => { console.log(`[MiniApp] account() error: ${e.message?.substring(0, 200)}`); return null; }),
        futuresClient.positions().catch((e: any) => { console.log(`[MiniApp] positions() error: ${e.message?.substring(0, 200)}`); return []; }),
        futuresClient.income("REALIZED_PNL", 20).catch((e: any) => { console.log(`[MiniApp] income() error: ${e.message?.substring(0, 200)}`); return []; }),
      ]);

      console.log(`[MiniApp] balance raw type=${typeof balances} isArr=${Array.isArray(balances)} len=${Array.isArray(balances)?balances.length:'n/a'}: ${JSON.stringify(balances).substring(0, 500)}`);
      console.log(`[MiniApp] account raw type=${typeof accountData}: ${JSON.stringify(accountData).substring(0, 500)}`);

      let availBal = 0;
      let walletBal = 0;

      function extractFromObj(obj: any): boolean {
        if (!obj || typeof obj !== "object") return false;
        const keys = Object.keys(obj);
        for (const k of keys) {
          const v = obj[k];
          if (typeof v === "string" || typeof v === "number") {
            const num = parseFloat(String(v));
            if (!isNaN(num) && num > 0) {
              const kl = k.toLowerCase();
              if (kl.includes("availablebalance") || kl.includes("available") || kl.includes("maxwithdraw")) {
                availBal = Math.max(availBal, num);
              }
              if (kl.includes("walletbalance") || kl.includes("crosswalletbalance") || kl.includes("balance") || kl.includes("totalwalletbalance")) {
                walletBal = Math.max(walletBal, num);
              }
            }
          }
        }
        return availBal > 0 || walletBal > 0;
      }

      if (Array.isArray(balances) && balances.length > 0) {
        const usdtBal = balances.find((b: any) => {
          const a = (b.asset || "").toUpperCase();
          return a === "USDT" || a === "USD";
        });
        if (usdtBal) extractFromObj(usdtBal);
      }

      if (availBal === 0 && walletBal === 0 && balances && typeof balances === "object" && !Array.isArray(balances)) {
        extractFromObj(balances);
      }

      if (availBal === 0 && walletBal === 0 && accountData) {
        if (Array.isArray(accountData.assets)) {
          const usdtAsset = accountData.assets.find((a: any) => (a.asset || "").toUpperCase() === "USDT");
          if (usdtAsset) extractFromObj(usdtAsset);
        }
        if (availBal === 0 && walletBal === 0) {
          extractFromObj(accountData);
        }
      }

      console.log(`[MiniApp] parsed: availBal=${availBal}, walletBal=${walletBal} for chatId=${chatId}`);

      const openPositions = Array.isArray(positions)
        ? positions.filter((p: any) => parseFloat(p.positionAmt || "0") !== 0)
        : [];

      let totalUpnl = 0;
      const positionList = openPositions.map((p: any) => {
        const amt = parseFloat(p.positionAmt || "0");
        const upnl = parseFloat(p.unRealizedProfit || "0");
        totalUpnl += upnl;
        return {
          symbol: p.symbol,
          side: amt > 0 ? "LONG" : "SHORT",
          size: Math.abs(amt),
          entryPrice: parseFloat(p.entryPrice || "0"),
          markPrice: parseFloat(p.markPrice || "0"),
          leverage: p.leverage || "1",
          unrealizedPnl: upnl,
          notional: parseFloat(p.notional || "0"),
        };
      });

      let realizedPnl = 0;
      let wins = 0;
      let losses = 0;
      const incomeList: any[] = [];
      if (Array.isArray(income)) {
        for (const inc of income) {
          const amt = parseFloat(inc.income || "0");
          realizedPnl += amt;
          if (amt > 0) wins++;
          else if (amt < 0) losses++;
          incomeList.push({
            symbol: inc.symbol,
            amount: amt,
            type: inc.incomeType,
            time: inc.time,
          });
        }
      }

      if (availBal === 0 && walletBal === 0) {
        try {
          const walletRows = await storage.getTelegramWallets(chatId);
          const botWalletAddr = getUserWalletAddress(parseInt(chatId)) || (walletRows.length > 0 ? walletRows[0].walletAddress : null);

          if (botWalletAddr) {
            const pk = await resolvePrivateKey(parseInt(chatId), botWalletAddr);
            let botFc: any = null;

            if (pk) {
              const { createAsterV3FuturesClient } = await import("./aster-client");
              botFc = createAsterV3FuturesClient({ user: botWalletAddr, signer: botWalletAddr, signerPrivateKey: pk });
              console.log(`[MiniApp] Trying bot wallet ${botWalletAddr.substring(0, 10)} with own key`);
            } else {
              const asterPk = process.env.ASTER_PRIVATE_KEY;
              const asterSigner = process.env.ASTER_SIGNER_ADDRESS;
              if (asterPk) {
                const { createAsterV3FuturesClient } = await import("./aster-client");
                botFc = createAsterV3FuturesClient({ user: botWalletAddr, signer: asterSigner || botWalletAddr, signerPrivateKey: asterPk });
                console.log(`[MiniApp] Trying bot wallet ${botWalletAddr.substring(0, 10)} with ASTER_PRIVATE_KEY signer`);
              }
            }

            if (botFc) {
              const [botBal, botAcct] = await Promise.all([
                botFc.balance().catch((e: any) => { console.log(`[MiniApp] bot wallet balance err: ${e.message?.substring(0, 150)}`); return []; }),
                botFc.account().catch((e: any) => { console.log(`[MiniApp] bot wallet account err: ${e.message?.substring(0, 150)}`); return null; }),
              ]);
              console.log(`[MiniApp] Bot wallet balance raw: ${JSON.stringify(botBal).substring(0, 500)}`);
              console.log(`[MiniApp] Bot wallet account raw: ${JSON.stringify(botAcct).substring(0, 500)}`);
              if (Array.isArray(botBal) && botBal.length > 0) {
                const usdtBal = botBal.find((b: any) => (b.asset || "").toUpperCase() === "USDT" || (b.asset || "").toUpperCase() === "USD");
                if (usdtBal) extractFromObj(usdtBal);
              }
              if (availBal === 0 && walletBal === 0 && botBal && typeof botBal === "object" && !Array.isArray(botBal)) {
                extractFromObj(botBal);
              }
              if (availBal === 0 && walletBal === 0 && botAcct) {
                if (Array.isArray(botAcct.assets)) {
                  const usdtAsset = botAcct.assets.find((a: any) => (a.asset || "").toUpperCase() === "USDT");
                  if (usdtAsset) extractFromObj(usdtAsset);
                }
                if (availBal === 0 && walletBal === 0) extractFromObj(botAcct);
              }
              if (availBal > 0 || walletBal > 0) {
                console.log(`[MiniApp] Found balance via bot wallet: avail=$${availBal}, wallet=$${walletBal}`);
              }
            }
          }
        } catch (botErr: any) {
          console.log(`[MiniApp] Bot wallet balance check error: ${botErr.message?.substring(0, 150)}`);
        }
      }

      if (availBal === 0 && walletBal > 0) availBal = walletBal;
      if (walletBal === 0 && availBal > 0) walletBal = availBal;

      let spotBalance = 0;
      try {
        const spotClient = client.spot;
        if (spotClient && spotClient.account) {
          const spotAcct = await spotClient.account();
          if (spotAcct && Array.isArray(spotAcct.balances)) {
            const usdtSpot = spotAcct.balances.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
            if (usdtSpot) spotBalance = parseFloat(usdtSpot.free || "0");
          }
          console.log(`[MiniApp] Spot balance: $${spotBalance}`);
        }
      } catch (spotErr: any) {
        console.log(`[MiniApp] Spot balance error: ${spotErr.message?.substring(0, 100)}`);
      }

      let bscBalance = 0;
      let bnbBalance = 0;
      let walletAddr: string | null = null;
      try {
        walletAddr = getUserWalletAddress(parseInt(chatId));
        console.log(`[MiniApp] in-memory wallet for chatId=${chatId}: ${walletAddr}`);
        if (!walletAddr) {
          const walletRows = await storage.getTelegramWallets(chatId);
          walletAddr = walletRows.length > 0 ? walletRows[0].walletAddress : null;
          console.log(`[MiniApp] DB wallet fallback chatId=${chatId}, found=${walletRows.length}, addr=${walletAddr}`);
        }
        if (walletAddr) {
          const ethers = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
          const usdt = new ethers.Contract(
            "0x55d398326f99059fF775485246999027B3197955",
            ["function balanceOf(address) view returns (uint256)"],
            provider
          );
          const [bal, bnbBal] = await Promise.all([
            usdt.balanceOf(walletAddr),
            provider.getBalance(walletAddr),
          ]);
          bscBalance = parseFloat(ethers.formatUnits(bal, 18));
          bnbBalance = parseFloat(ethers.formatEther(bnbBal));
          console.log(`[MiniApp] BSC balance for ${walletAddr}: $${bscBalance} USDT, ${bnbBalance} BNB`);
        }
      } catch (bscErr: any) {
        console.error(`[MiniApp] BSC balance fetch error:`, bscErr.message);
      }

      res.json({
        connected: true,
        walletBalance: walletBal,
        availableMargin: availBal,
        spotBalance,
        bscBalance,
        bnbBalance,
        bscWalletAddress: walletAddr,
        asterApiWallet: asterApiWalletAddr || null,
        unrealizedPnl: totalUpnl,
        realizedPnl,
        wins,
        losses,
        positions: positionList,
        recentIncome: incomeList,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.post("/api/miniapp/deposit", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      const { amount } = req.body;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      if (!amount || amount < 0.5) return res.status(400).json({ error: "Minimum deposit is $0.50" });

      console.log(`[MiniApp] deposit request chatId=${chatId}, amount=${amount}`);

      const activeWallet = getUserWalletAddress(parseInt(chatId));
      const walletRows = await storage.getTelegramWallets(chatId);
      const walletAddr = activeWallet || (walletRows.length > 0 ? walletRows[0].walletAddress : null);
      if (!walletAddr) return res.status(400).json({ error: "No wallet linked to this chat. Use /start in the bot first." });

      console.log(`[MiniApp] deposit: activeWallet=${activeWallet}, dbFirst=${walletRows[0]?.walletAddress}, using=${walletAddr}`);

      let rawPk = await resolvePrivateKey(parseInt(chatId), walletAddr);
      if (!rawPk) {
        console.log(`[MiniApp] deposit: key unavailable for ${walletAddr?.substring(0, 8)}, generating new wallet with working key...`);
        const { regenerateWalletForDeposit } = await import("./telegram-bot");
        const newWallet = await regenerateWalletForDeposit(parseInt(chatId));
        if (newWallet) {
          console.log(`[MiniApp] deposit: new wallet ${newWallet.address.substring(0, 10)} created, key available`);
          return res.json({
            success: false,
            needsNewWallet: true,
            newWalletAddress: newWallet.address,
            oldWalletAddress: walletAddr,
            error: `Wallet key recovered. New wallet: ${newWallet.address}\n\nSend your USDT from your old wallet (${walletAddr}) to this new address, then try deposit again.`,
          });
        }
        return res.status(400).json({ error: "Wallet key unavailable. Send USDT manually to pool wallet: 0xaac5f84303ee5cdbd19c265cee295cd5a36a26ee" });
      }

      const ethers = await import("ethers");
      const pkWallet = new ethers.Wallet(rawPk);
      const derivedAddr = pkWallet.address.toLowerCase();
      const storedAddr = walletAddr.toLowerCase();
      console.log(`[MiniApp] deposit: stored wallet=${storedAddr}, key derives to=${derivedAddr}`);

      if (derivedAddr !== storedAddr) {
        console.log(`[MiniApp] KEY MISMATCH: key belongs to ${derivedAddr}, not ${storedAddr}. Cannot auto-deposit.`);
        return res.json({
          success: false,
          error: `Auto-deposit unavailable — wallet key mismatch. Please deposit manually:\n\n1. Open your external wallet app\n2. Send $${amount} USDT (BEP-20) on BSC to:\n0xaac5f84303ee5cdbd19c265cee295cd5a36a26ee\n3. Paste the TX hash below to verify`,
        });
      }

      const { asterV3Deposit } = await import("./aster-client");
      const ownerAddr = process.env.ASTER_USER_ADDRESS || "";
      const needsDepositTo = ownerAddr && ownerAddr.toLowerCase() !== derivedAddr;
      console.log(`[MiniApp] deposit: ownerAddr=${ownerAddr}, needsDepositTo=${needsDepositTo}`);
      const result = await asterV3Deposit(rawPk, amount, 0, needsDepositTo ? ownerAddr : undefined);

      if (!result.success) return res.json({ success: false, error: result.error });

      console.log(`[MiniApp] deposit TX success: ${result.txHash}`);

      let spotTransferred = false;
      let futuresTransferred = false;
      try {
        const client = await getAsterClient(parseInt(chatId));
        if (client) {
          const fc = client.futures || client;
          console.log(`[MiniApp] Waiting 8s for vault credit...`);
          await new Promise(r => setTimeout(r, 8000));

          if (fc.spotToFutures) {
            try {
              await fc.spotToFutures("USDT", amount.toString());
              futuresTransferred = true;
              console.log(`[MiniApp] Spot→Futures transfer done: $${amount}`);
            } catch (stfErr: any) {
              console.log(`[MiniApp] Spot→Futures failed: ${stfErr.message?.substring(0, 100)}`);
            }
          }
        }
      } catch (postErr: any) {
        console.log(`[MiniApp] Post-deposit error: ${postErr.message?.substring(0, 100)}`);
      }

      res.json({
        success: true,
        txHash: result.txHash,
        spotTransferred: true,
        futuresTransferred,
        message: futuresTransferred
          ? `$${amount} deposited and moved to Futures — ready to trade!`
          : `$${amount} deposited to Aster Spot. Use the bot to transfer Spot→Futures when ready.`,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.post("/api/miniapp/withdraw", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { amount, toAddress } = req.body;
      if (!amount || amount < 1) return res.status(400).json({ error: "Minimum withdrawal is $1" });

      const activeWallet = getUserWalletAddress(parseInt(chatId));
      const withdrawTo = toAddress || activeWallet;
      if (!withdrawTo) return res.status(400).json({ error: "No withdrawal address. Provide a BSC address." });

      console.log(`[MiniApp] withdraw request: chatId=${chatId}, amount=${amount}, to=${withdrawTo}`);

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.status(400).json({ error: "Aster not connected" });

      const fc = client.futures || client;

      try {
        console.log(`[MiniApp] Futures→Spot transfer: $${amount}`);
        await fc.futuresToSpot("USDT", amount.toString());
        console.log(`[MiniApp] Futures→Spot done`);
      } catch (ftsErr: any) {
        console.log(`[MiniApp] Futures→Spot failed: ${ftsErr.message?.substring(0, 150)}`);
        return res.json({ success: false, error: `Failed to move funds from Futures to Spot: ${ftsErr.message?.substring(0, 150)}` });
      }

      await new Promise(r => setTimeout(r, 2000));

      try {
        console.log(`[MiniApp] On-chain withdraw: $${amount} to ${withdrawTo}`);
        const result = await fc.withdrawOnChain("USDT", amount.toString(), withdrawTo, "BSC");
        console.log(`[MiniApp] Withdraw success:`, JSON.stringify(result).substring(0, 200));
        res.json({
          success: true,
          message: `Withdrawal of $${amount} USDT initiated to ${withdrawTo.substring(0, 8)}...${withdrawTo.slice(-4)}. Allow 5-10 minutes for on-chain confirmation.`,
          withdrawId: result?.id || result?.withdrawId || null,
        });
      } catch (wErr: any) {
        console.log(`[MiniApp] Withdraw failed: ${wErr.message?.substring(0, 200)}`);
        res.json({ success: false, error: `Withdrawal failed: ${wErr.message?.substring(0, 150)}. Funds moved back to Spot — try again or withdraw manually on asterdex.com.` });
      }
    } catch (e: any) {
      console.log(`[MiniApp] withdraw error: ${e.message?.substring(0, 200)}`);
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.post("/api/miniapp/spot-to-futures", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.status(400).json({ error: "Aster not connected" });

      const fc = client.futures || client;

      let spotBal = 0;
      try {
        const balances = await fc.balance();
        if (Array.isArray(balances)) {
          const usdt = balances.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
          if (usdt) spotBal = parseFloat(usdt.balance || usdt.walletBalance || "0");
        }
      } catch {}

      const amount = req.body.amount || spotBal;
      if (!amount || amount <= 0) return res.json({ success: false, error: "No Spot balance available to transfer. Deposit may still be processing — wait 2-3 minutes and try again." });

      console.log(`[MiniApp] Spot→Futures transfer: $${amount}`);

      if (!fc.spotToFutures) return res.json({ success: false, error: "Spot→Futures transfer not available on this API" });

      await fc.spotToFutures("USDT", amount.toString());
      console.log(`[MiniApp] Spot→Futures done: $${amount}`);
      res.json({ success: true, amount, message: `$${amount} transferred to Futures — ready to trade!` });
    } catch (e: any) {
      console.log(`[MiniApp] Spot→Futures error: ${e.message?.substring(0, 150)}`);
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.get("/api/miniapp/agent", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { getAgentConfig, getAgentState } = await import("./autonomous-agent");
      const config = getAgentConfig(chatId);
      const state = getAgentState(chatId);

      res.json({
        running: state?.running || false,
        config: {
          riskPercent: config?.riskPercent || 1.0,
          maxLeverage: config?.maxLeverage || 10,
          symbol: config?.symbol || "BTCUSDT",
          interval: config?.interval || 60,
        },
        stats: state ? {
          tradeCount: state.tradeCount || 0,
          winCount: state.winCount || 0,
          lossCount: state.lossCount || 0,
          totalPnl: state.totalPnl || 0,
          lastAction: state.lastAction || null,
          lastReason: state.lastReason || null,
        } : null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.post("/api/miniapp/agent/toggle", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { getAgentState, startAgent, stopAgent } = await import("./autonomous-agent");
      const state = getAgentState(chatId);

      if (state?.running) {
        stopAgent(chatId);
        res.json({ running: false });
      } else {
        const client = await getAsterClient(parseInt(chatId));
        if (!client) return res.status(400).json({ error: "Aster not connected" });
        const getClientFn = () => client;
        const sendMsg = async (msg: string) => {};
        await startAgent(chatId, getClientFn, sendMsg);
        res.json({ running: true });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.get("/api/miniapp/trades", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      const symbol = (req.query.symbol as string) || "BTCUSDT";
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.json({ trades: [], income: [] });

      const futuresClient = client.futures || client;
      const [trades, income] = await Promise.all([
        futuresClient.userTrades(symbol, 20).catch(() => []),
        futuresClient.income(undefined, 30).catch(() => []),
      ]);

      res.json({
        trades: Array.isArray(trades) ? trades.map((t: any) => ({
          symbol: t.symbol,
          side: t.side,
          qty: parseFloat(t.qty || "0"),
          price: parseFloat(t.price || "0"),
          realizedPnl: parseFloat(t.realizedPnl || "0"),
          time: t.time,
        })) : [],
        income: Array.isArray(income) ? income.map((i: any) => ({
          symbol: i.symbol,
          type: i.incomeType,
          amount: parseFloat(i.income || "0"),
          time: i.time,
        })) : [],
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.post("/api/miniapp/trade", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { symbol, side, amount, leverage } = req.body;
      if (!symbol || !side || !amount) return res.status(400).json({ error: "Missing symbol, side, or amount" });
      if (!["BUY", "SELL"].includes(side)) return res.status(400).json({ error: "Side must be BUY or SELL" });
      if (amount <= 0) return res.status(400).json({ error: "Amount must be positive" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.status(400).json({ error: "Aster not connected" });

      const fc = client.futures || client;

      if (leverage && leverage > 0) {
        try {
          await fc.setLeverage(symbol, Math.min(Math.max(1, Math.round(leverage)), 125));
        } catch (e: any) {
          console.log(`[MiniApp] setLeverage warning: ${e.message}`);
        }
      }

      const ticker = await fc.tickerPrice(symbol).catch(() => null);
      const price = parseFloat(ticker?.price || "0");
      if (price <= 0) return res.status(400).json({ error: `Cannot get price for ${symbol}` });

      const lev = leverage || 10;
      const notional = amount * lev;
      let qty: number;

      const stepSizes: Record<string, number> = {
        BTCUSDT: 0.001, ETHUSDT: 0.01, SOLUSDT: 0.1, BNBUSDT: 0.01,
        DOGEUSDT: 1, XRPUSDT: 0.1, ADAUSDT: 1, AVAXUSDT: 0.1,
        DOTUSDT: 0.1, MATICUSDT: 1, LINKUSDT: 0.01, LTCUSDT: 0.001,
      };
      const step = stepSizes[symbol] || 0.001;
      qty = Math.floor((notional / price) / step) * step;
      if (qty <= 0) return res.status(400).json({ error: "Amount too small for this pair" });

      const precision = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
      const qtyStr = qty.toFixed(precision);

      console.log(`[MiniApp] Trade: ${side} ${qtyStr} ${symbol} @ ~$${price} (margin=$${amount}, lev=${lev}x)`);

      const order = await fc.createOrder({
        symbol,
        side,
        type: "MARKET",
        quantity: qtyStr,
      });

      res.json({
        success: true,
        orderId: order.orderId || order.orderid,
        symbol,
        side,
        quantity: qtyStr,
        price,
        leverage: lev,
        margin: amount,
        status: order.status || "FILLED",
      });
    } catch (e: any) {
      console.error(`[MiniApp] Trade error: ${e.message}`);
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.post("/api/miniapp/close", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { symbol } = req.body;
      if (!symbol) return res.status(400).json({ error: "Missing symbol" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.status(400).json({ error: "Aster not connected" });

      const fc = client.futures || client;

      const positions = await fc.positions();
      const pos = Array.isArray(positions)
        ? positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt || "0") !== 0)
        : null;
      if (!pos) return res.status(400).json({ error: `No open position for ${symbol}` });

      const amt = parseFloat(pos.positionAmt || "0");
      const closeSide = amt > 0 ? "SELL" : "BUY";
      const absAmt = Math.abs(amt);

      console.log(`[MiniApp] Close: ${closeSide} ${absAmt} ${symbol}`);

      const order = await fc.createOrder({
        symbol,
        side: closeSide,
        type: "MARKET",
        quantity: absAmt.toString(),
        reduceOnly: true,
      });

      res.json({
        success: true,
        orderId: order.orderId || order.orderid,
        symbol,
        side: closeSide,
        quantity: absAmt,
        status: order.status || "FILLED",
      });
    } catch (e: any) {
      console.error(`[MiniApp] Close error: ${e.message}`);
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.get("/api/miniapp/debug", async (_req: Request, res: Response) => {
    try {
      const { getAsterClient } = await import("./telegram-bot");
      const client = await getAsterClient(0);
      if (!client) return res.json({ error: "No Aster client", hasPrivateKey: !!process.env.ASTER_PRIVATE_KEY, hasUser: !!process.env.ASTER_USER_ADDRESS });
      const fc = client.futures || client;
      const [bal, acct] = await Promise.all([
        fc.balance().catch((e: any) => ({ error: e.message })),
        fc.account().catch((e: any) => ({ error: e.message })),
      ]);
      res.json({
        balanceType: typeof bal,
        balanceIsArray: Array.isArray(bal),
        balance: JSON.parse(JSON.stringify(bal)).toString !== undefined ? bal : bal,
        accountKeys: acct && typeof acct === "object" && !acct.error ? Object.keys(acct) : null,
        accountAssetsSample: acct?.assets?.slice?.(0, 2) || null,
        accountTopLevel: acct && typeof acct === "object" && !acct.error ? {
          totalWalletBalance: acct.totalWalletBalance,
          totalCrossWalletBalance: acct.totalCrossWalletBalance,
          availableBalance: acct.availableBalance,
          totalCrossUnPnl: acct.totalCrossUnPnl,
          maxWithdrawAmount: acct.maxWithdrawAmount,
        } : acct,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/miniapp/markets", async (req: Request, res: Response) => {
    try {
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT"];
      const chatId = req.headers["x-telegram-chat-id"] as string;
      const client = chatId ? await getAsterClient(parseInt(chatId)) : null;

      if (!client) {
        console.log(`[MiniApp] markets: no client (chatId=${chatId || 'missing'})`);
        return res.json({ markets: [] });
      }
      const futuresClient = client.futures || client;

      const prices = await Promise.all(
        symbols.map(async (sym) => {
          try {
            const ticker = await futuresClient.tickerPrice(sym);
            return { symbol: sym, price: parseFloat(ticker?.price || "0") };
          } catch {
            return { symbol: sym, price: 0 };
          }
        })
      );
      res.json({ markets: prices });
    } catch (e: any) {
      res.status(500).json({ error: e.message?.substring(0, 200) });
    }
  });

  app.get("/api/miniapp/pool/user", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const user = await storage.upsertPoolUser(chatId);
      const deposits = await storage.getPoolDeposits(chatId);
      const stats = await storage.getPoolStats();
      res.json({ user, deposits, stats });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/miniapp/pool/deposit", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const { txHash, amount, fromAddress } = req.body;
      if (!txHash || !amount || amount <= 0) return res.status(400).json({ error: "Invalid deposit data" });

      const existing = await storage.getPoolDeposits(chatId);
      const dupe = existing.find((d: any) => d.tx_hash === txHash);
      if (dupe) return res.json({ success: true, deposit: dupe, message: "Deposit already recorded" });

      let verified = false;
      try {
        const bscRes = await fetch(`https://api.bscscan.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${process.env.BSCSCAN_API_KEY || 'YourApiKeyToken'}`);
        const bscData = await bscRes.json();
        if (bscData?.result?.status === "0x1") {
          verified = true;
          console.log(`[Pool] TX ${txHash.substring(0, 12)} verified on BSC for chatId=${chatId}`);
        }
      } catch (e: any) {
        console.log(`[Pool] BSC verification failed for ${txHash.substring(0, 12)}: ${e.message?.substring(0, 100)}`);
      }

      const deposit = await storage.createPoolDeposit(chatId, amount, txHash, fromAddress, "external");
      if (verified && deposit) {
        await storage.updatePoolDepositStatus(deposit.id, "verified");
      }

      let bridgeResult: any = null;
      if (verified && deposit) {
        try {
          const pk = process.env.ASTER_PRIVATE_KEY;
          const ownerAddr = process.env.ASTER_USER_ADDRESS || "0xeb0616e044c55c1ca214ed3629fee3354bbf9826";
          if (pk) {
            const { asterV3Deposit } = await import("./aster-client");
            console.log(`[Pool] Auto-bridge: forwarding $${amount} USDT from holding wallet to Aster for owner ${ownerAddr.substring(0, 10)}...`);
            bridgeResult = await asterV3Deposit(pk, amount, 0, ownerAddr);
            if (bridgeResult.success) {
              console.log(`[Pool] Auto-bridge SUCCESS: $${amount} deposited to Aster. TX: ${bridgeResult.txHash}`);
              await storage.updatePoolDepositStatus(deposit.id, "credited");
            } else {
              console.log(`[Pool] Auto-bridge failed: ${bridgeResult.error?.substring(0, 200)}`);
            }
          }
        } catch (e: any) {
          console.error(`[Pool] Auto-bridge error: ${e.message?.substring(0, 200)}`);
          bridgeResult = { success: false, error: e.message?.substring(0, 200) };
        }
      }

      const message = bridgeResult?.success
        ? "Deposit verified and forwarded to Aster trading pool!"
        : verified
          ? "Deposit verified. Auto-bridge to Aster pending."
          : "Deposit recorded, awaiting verification.";

      res.json({
        success: true,
        deposit,
        verified,
        bridged: bridgeResult?.success || false,
        bridgeTx: bridgeResult?.txHash || null,
        bridgeError: bridgeResult?.error || null,
        message,
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/miniapp/pool/credit", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const { depositId } = req.body;
      if (!depositId) return res.status(400).json({ error: "Missing deposit ID" });
      await storage.updatePoolDepositStatus(depositId, "credited");
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/miniapp/pool/stats", async (req: Request, res: Response) => {
    try {
      const stats = await storage.getPoolStats();

      let poolBalance = 0;
      try {
        const client = await getAsterClient(0);
        if (client) {
          const fc = client.futures || client;
          const bal = await fc.balance().catch(() => []);
          if (Array.isArray(bal)) {
            const usdt = bal.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
            if (usdt) {
              poolBalance = Math.max(
                parseFloat(usdt.walletBalance || "0"),
                parseFloat(usdt.availableBalance || "0"),
                parseFloat(usdt.crossWalletBalance || "0")
              );
            }
          }
        }
      } catch {}

      res.json({
        ...stats,
        poolBalance,
        totalPnl: poolBalance - stats.totalDeposits,
        pnlPercent: stats.totalDeposits > 0 ? ((poolBalance - stats.totalDeposits) / stats.totalDeposits * 100) : 0,
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/miniapp/pool/bridge-now", async (req: Request, res: Response) => {
    try {
      const pk = process.env.ASTER_PRIVATE_KEY;
      const ownerAddr = process.env.ASTER_USER_ADDRESS || "0xeb0616e044c55c1ca214ed3629fee3354bbf9826";
      if (!pk) return res.status(400).json({ error: "No ASTER_PRIVATE_KEY" });

      const { JsonRpcProvider, Wallet, Contract, formatUnits } = await import("ethers");
      const provider = new JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const wallet = new Wallet(pk, provider);
      const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
      const usdt = new Contract(BSC_USDT, ["function balanceOf(address) view returns (uint256)"], provider);
      const rawBal = await usdt.balanceOf(wallet.address);
      const usdtBal = parseFloat(formatUnits(rawBal, 18));

      if (usdtBal < 0.01) {
        return res.json({ success: false, error: `Holding wallet has $${usdtBal.toFixed(4)} USDT — nothing to bridge` });
      }

      const { asterV3Deposit } = await import("./aster-client");
      console.log(`[Bridge] Manual trigger: forwarding $${usdtBal} USDT to Aster for ${ownerAddr.substring(0, 10)}...`);
      const result = await asterV3Deposit(pk, usdtBal, 0, ownerAddr);

      if (result.success) {
        console.log(`[Bridge] SUCCESS: $${usdtBal} deposited to Aster. TX: ${result.txHash}`);
      } else {
        console.log(`[Bridge] FAILED: ${result.error}`);
      }

      res.json({ ...result, amount: usdtBal, holdingWallet: wallet.address, owner: ownerAddr });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/miniapp/pool/holding-balance", async (req: Request, res: Response) => {
    try {
      const pk = process.env.ASTER_PRIVATE_KEY;
      if (!pk) return res.status(400).json({ error: "No ASTER_PRIVATE_KEY" });

      const { JsonRpcProvider, Wallet, Contract, formatUnits, formatEther } = await import("ethers");
      const provider = new JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const wallet = new Wallet(pk, provider);
      const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
      const usdt = new Contract(BSC_USDT, ["function balanceOf(address) view returns (uint256)"], provider);
      const rawBal = await usdt.balanceOf(wallet.address);
      const bnbBal = await provider.getBalance(wallet.address);

      res.json({
        holdingWallet: wallet.address,
        usdtBalance: parseFloat(formatUnits(rawBal, 18)),
        bnbBalance: parseFloat(formatEther(bnbBal)),
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

}

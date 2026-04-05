import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { getAsterClient, getUserWalletAddress, resolvePrivateKey } from "./telegram-bot";

export function registerMiniAppRoutes(app: Express) {
  app.get("/api/miniapp/account", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) {
        console.log(`[MiniApp] No Aster client for chatId=${chatId}`);
        return res.json({ connected: false });
      }

      const futuresClient = client.futures || client;

      const [balances, accountData, positions, income] = await Promise.all([
        futuresClient.balance().catch((e: any) => { console.log(`[MiniApp] balance() error: ${e.message}`); return []; }),
        futuresClient.account().catch((e: any) => { console.log(`[MiniApp] account() error: ${e.message}`); return null; }),
        futuresClient.positions().catch((e: any) => { console.log(`[MiniApp] positions() error: ${e.message}`); return []; }),
        futuresClient.income("REALIZED_PNL", 20).catch((e: any) => { console.log(`[MiniApp] income() error: ${e.message}`); return []; }),
      ]);

      console.log(`[MiniApp] balance raw: ${JSON.stringify(balances).substring(0, 500)}`);
      console.log(`[MiniApp] account raw: ${JSON.stringify(accountData).substring(0, 500)}`);

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

      if (availBal === 0 && walletBal > 0) availBal = walletBal;
      if (walletBal === 0 && availBal > 0) walletBal = availBal;

      console.log(`[MiniApp] parsed: availBal=${availBal}, walletBal=${walletBal}`);

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
        bscBalance,
        bnbBalance,
        bscWalletAddress: walletAddr,
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

      const rawPk = await resolvePrivateKey(parseInt(chatId), walletAddr);
      if (!rawPk) return res.status(400).json({ error: "No private key available for auto-deposit. Send USDT manually to the vault address shown below." });

      const ethers = await import("ethers");
      const pkWallet = new ethers.Wallet(rawPk);
      const derivedAddr = pkWallet.address.toLowerCase();
      const storedAddr = walletAddr.toLowerCase();
      console.log(`[MiniApp] deposit: stored wallet=${storedAddr}, key derives to=${derivedAddr}`);

      if (derivedAddr !== storedAddr) {
        console.log(`[MiniApp] KEY MISMATCH: key belongs to ${derivedAddr}, not ${storedAddr}. Cannot auto-deposit.`);
        return res.json({
          success: false,
          error: `Auto-deposit unavailable — wallet key mismatch. Please deposit manually:\n\n1. Open your external wallet app\n2. Send $${amount} USDT (BEP-20) on BSC to:\n0x128463A60784c4D3f46c23Af3f65Ed859Ba87974\n3. Paste the TX hash below to verify`,
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
}

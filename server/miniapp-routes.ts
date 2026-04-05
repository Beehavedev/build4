import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { getAsterClient } from "./telegram-bot";

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

      const [balances, positions, income] = await Promise.all([
        futuresClient.balance().catch((e: any) => { console.log(`[MiniApp] balance() error: ${e.message}`); return []; }),
        futuresClient.positions().catch((e: any) => { console.log(`[MiniApp] positions() error: ${e.message}`); return []; }),
        futuresClient.income("REALIZED_PNL", 20).catch((e: any) => { console.log(`[MiniApp] income() error: ${e.message}`); return []; }),
      ]);

      console.log(`[MiniApp] balance raw (type=${typeof balances}, isArray=${Array.isArray(balances)}): ${JSON.stringify(balances).substring(0, 300)}`);

      let usdtBal: any = null;
      if (Array.isArray(balances)) {
        usdtBal = balances.find((b: any) => b.asset === "USDT" || b.asset === "usdt");
      } else if (balances && typeof balances === "object") {
        if ((balances as any).asset) {
          usdtBal = balances;
        } else if ((balances as any).totalCrossWalletBalance || (balances as any).availableBalance) {
          usdtBal = { asset: "USDT", availableBalance: (balances as any).availableBalance || "0", crossWalletBalance: (balances as any).totalCrossWalletBalance || "0", balance: (balances as any).totalWalletBalance || "0" };
        }
      }

      const availBal = usdtBal ? parseFloat(usdtBal.availableBalance || usdtBal.crossWalletBalance || "0") : 0;
      const walletBal = usdtBal ? parseFloat(usdtBal.crossWalletBalance || usdtBal.balance || "0") : 0;

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
      try {
        const { Contract, JsonRpcProvider, formatUnits } = await import("ethers");
        const provider = new JsonRpcProvider("https://bsc-dataseed1.binance.org");
        const walletRows = await storage.getTelegramWallets(chatId);
        const walletAddr = walletRows.length > 0 ? walletRows[0].walletAddress : null;
        if (walletAddr) {
          const usdt = new Contract(
            "0x55d398326f99059fF775485246999027B3197955",
            ["function balanceOf(address) view returns (uint256)"],
            provider
          );
          const bal = await usdt.balanceOf(walletAddr);
          bscBalance = parseFloat(formatUnits(bal, 18));
        }
      } catch {}

      res.json({
        connected: true,
        walletBalance: walletBal,
        availableMargin: availBal,
        bscBalance,
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
      if (!amount || amount < 1) return res.status(400).json({ error: "Minimum deposit is $1" });

      const walletRows = await storage.getTelegramWallets(chatId);
      if (walletRows.length === 0) return res.status(400).json({ error: "No wallet linked" });

      const walletAddr = walletRows[0].walletAddress;
      const pk = walletRows[0].encryptedPrivateKey;
      if (!pk) return res.status(400).json({ error: "No private key available for auto-deposit" });

      const { asterV3Deposit } = await import("./aster-client");
      const userAddr = process.env.ASTER_USER_ADDRESS || walletAddr;
      const result = await asterV3Deposit(pk, amount, 0, userAddr);

      if (!result.success) return res.json({ success: false, error: result.error });

      let transferred = false;
      try {
        const client = await getAsterClient(parseInt(chatId));
        if (client) {
          const fc = client.futures || client;
          if (fc.spotToFutures) {
            await new Promise(r => setTimeout(r, 5000));
            await fc.spotToFutures("USDT", amount.toString());
            transferred = true;
          }
        }
      } catch {}

      res.json({
        success: true,
        txHash: result.txHash,
        spotToFuturesTransferred: transferred,
      });
    } catch (e: any) {
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

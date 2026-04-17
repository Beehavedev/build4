const BASE = "";

export interface UserData {
  id: string;
  telegramId: string;
  username: string | null;
  subscriptionTier: string;
  totalFeesSpent: number;
}

export interface WalletData {
  id: string;
  chain: string;
  address: string;
  label: string;
  isActive: boolean;
}

export interface AgentData {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isPaused: boolean;
  exchange: string;
  pairs: string[];
  timeframe: string;
  maxPositionSize: number;
  maxDailyLoss: number;
  maxLeverage: number;
  stopLossPct: number;
  takeProfitPct: number;
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  onchainRegistered: boolean;
  erc8004Registered: boolean;
  bap578Registered: boolean;
  erc8004TxHash: string | null;
  erc8004TokenId: string | null;
  erc8004Chain: string | null;
  creatorWallet: string | null;
}

export interface TradeData {
  id: string;
  pair: string;
  side: string;
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  leverage: number;
  pnl: number | null;
  status: string;
  createdAt: string;
}

export interface PortfolioData {
  totalValue: number;
  totalPnl: number;
  dailyPnl: number;
  weeklyPnl: number;
}

function getInitData(): string {
  return (window as any).Telegram?.WebApp?.initData ?? '';
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const initData = getInitData();
  if (initData) headers.set('X-Telegram-Init-Data', initData);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = `API error: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

async function fetchApi<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

export function getUser(telegramId: number) {
  return fetchApi<UserData>(`/api/user/${telegramId}`);
}

export function getUserAgents(userId: string) {
  return fetchApi<AgentData[]>(`/api/agents/${userId}`);
}

export function getLeaderboard() {
  return fetchApi<AgentData[]>("/api/leaderboard");
}

export function getSignals() {
  return fetchApi<any[]>("/api/signals");
}

export function getTelegramUser() {
  const tg = window.Telegram?.WebApp;
  return tg?.initDataUnsafe?.user || null;
}

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
  // Per-agent venue allow-list (Phase 1, 2026-04-28). Replaces the
  // single isActive toggle as the operational control surface — each
  // venue here gets its own scan + decision pass per tick. Empty array
  // means the agent is dormant. Backfilled from `exchange` for legacy
  // rows so single-venue users see no behavioural change.
  enabledVenues?: string[];
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
  currentPair: string | null;
  lastScanScore: number | null;
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

// ApiError preserves the response body and status so callers can surface
// rich diagnostics (e.g. /api/aster/approve returns a `debug` object with
// the wallet-PK encryption format when decryption fails — without this
// the UI just sees "Could not decrypt wallet" with no way to triage).
export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const initData = getInitData();
  if (initData) headers.set('X-Telegram-Init-Data', initData);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = `API error: ${res.status}`;
    let body: any = null;
    try {
      body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new ApiError(msg, res.status, body);
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

export interface FeedEntry {
  id: string;
  agentId: string;
  agentName: string;
  action: string;        // HOLD, OPEN_LONG, OPEN_SHORT, CLOSE, SKIP_OPEN
  // Internal gate identifier when action='SKIP_OPEN' (rr_floor,
  // confidence_floor, setup_score_floor, risk_guard, twak_risk,
  // no_balance, venue_rejected, no_creds). Null otherwise.
  gate?: string | null;
  pair: string | null;
  price: number | null;
  reason: string | null;
  adx: number | null;
  rsi: number | null;
  score: number | null;
  regime: string | null;
  // Which venue this row belongs to: 'aster' | 'hyperliquid' | 'fortytwo'
  // (or null on legacy rows). Rendered as a coloured chip per row so the
  // user always knows which exchange the agent was scanning.
  exchange?: string | null;
  createdAt: string;
}

// `before` is an ISO timestamp cursor for "Load older entries" — when
// supplied the server only returns feed rows strictly older than this
// time. Omit it (or pass undefined) for the default "latest N" behaviour.
export function getMyFeed(limit = 20, before?: string) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (before) qs.set('before', before);
  return apiFetch<FeedEntry[]>(`/api/me/feed?${qs.toString()}`);
}

// Update an agent's risk-limit settings. Each field is independently
// optional — only send the ones the user actually changed. Backend
// returns the updated agent on success or an `ApiError` with the
// validation message on failure (400).
export interface AgentSettingsUpdate {
  maxPositionSize?: number;
  maxDailyLoss?: number;
  maxLeverage?: number;
}
export function updateAgentSettings(agentId: string, patch: AgentSettingsUpdate) {
  return apiFetch<AgentData>(`/api/agents/${agentId}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function getTelegramUser() {
  const tg = window.Telegram?.WebApp;
  return tg?.initDataUnsafe?.user || null;
}

// One-shot agent deployment for the new Onboard mini-app page. Server runs
// the full wallet-gen → fund → ERC-8004 register pipeline and returns the
// hydrated agent on success. On failure the body has { error, partial,
// agentId } — the partial flag means the agent's wallet was funded but
// the register call failed (so /myagents can offer a retry path) and the
// row was kept rather than rolled back.
export function onboardAgent(opts: {
  preset: 'safe' | 'balanced' | 'aggressive'
  startingCapital: number
  chain?: 'bsc' | 'xlayer'
  // Optional. When omitted the server picks a friendly random name from
  // its 30-name pool (Falcon, Mantis, Cobalt, ...). When supplied the
  // server validates the format (3-24 chars, [a-zA-Z0-9_]) and surfaces
  // an "already taken" error if the name is in use.
  name?: string
}) {
  return apiFetch<{ success: true; agent: AgentData }>('/api/me/agents/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
}

// Hard-delete an agent. Server validates ownership and (in addition to
// removing the row) flips isActive=false first so the runner stops
// dispatching mid-loop. There's no undo — UI should confirm before
// calling. Returns { ok: true } on success.
export function deleteAgent(agentId: string) {
  return apiFetch<{ ok: true }>(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
  })
}

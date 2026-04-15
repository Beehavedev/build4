import { Context, SessionFlavor } from "grammy";

export interface SessionData {
  step?: string;
  agentDraft?: {
    name?: string;
    exchange?: string;
    pairs?: string[];
    maxPositionSize?: number;
    maxDailyLoss?: number;
    maxLeverage?: number;
    description?: string;
  };
}

export type SessionContext = Context & SessionFlavor<SessionData>;

export function initialSessionData(): SessionData {
  return {};
}

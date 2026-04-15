export interface AsterPosition {
  pair: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  pnl: number;
  liquidationPrice: number;
}

export async function getAsterPositions(_apiKey?: string): Promise<AsterPosition[]> {
  return [];
}

export async function openAsterPosition(params: {
  pair: string;
  side: "LONG" | "SHORT";
  size: number;
  leverage: number;
}): Promise<{ success: boolean; txHash?: string; error?: string }> {
  console.log(`[ASTER] Mock open: ${params.side} ${params.pair} $${params.size} ${params.leverage}x`);
  return {
    success: true,
    txHash: "0x" + Math.random().toString(16).slice(2, 18),
  };
}

export async function closeAsterPosition(params: {
  pair: string;
}): Promise<{ success: boolean; txHash?: string }> {
  console.log(`[ASTER] Mock close: ${params.pair}`);
  return {
    success: true,
    txHash: "0x" + Math.random().toString(16).slice(2, 18),
  };
}

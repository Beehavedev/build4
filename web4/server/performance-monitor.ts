interface RequestMetric {
  path: string;
  method: string;
  statusCode: number;
  durationMs: number;
  timestamp: number;
}

interface PerformanceSnapshot {
  uptime: number;
  memoryMB: { rss: number; heapUsed: number; heapTotal: number };
  requests: {
    total: number;
    last5min: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    errorRate: number;
  };
  telegram: {
    messagesProcessed: number;
    callbacksProcessed: number;
    avgResponseMs: number;
    slowResponses: number;
  };
  trading: {
    scansCompleted: number;
    tradesExecuted: number;
    avgScanMs: number;
  };
}

const MAX_METRICS = 10000;
const requestMetrics: RequestMetric[] = [];
const startTime = Date.now();

let telegramMessages = 0;
let telegramCallbacks = 0;
let telegramTotalMs = 0;
let telegramSlowCount = 0;
const TELEGRAM_SLOW_THRESHOLD_MS = 2000;

let tradingScans = 0;
let tradingTrades = 0;
let tradingScanTotalMs = 0;

export function recordRequest(path: string, method: string, statusCode: number, durationMs: number): void {
  requestMetrics.push({ path, method, statusCode, durationMs, timestamp: Date.now() });
  if (requestMetrics.length > MAX_METRICS) {
    requestMetrics.splice(0, requestMetrics.length - MAX_METRICS);
  }
}

export function recordTelegramMessage(durationMs: number): void {
  telegramMessages++;
  telegramTotalMs += durationMs;
  if (durationMs > TELEGRAM_SLOW_THRESHOLD_MS) telegramSlowCount++;
}

export function recordTelegramCallback(durationMs: number): void {
  telegramCallbacks++;
  telegramTotalMs += durationMs;
  if (durationMs > TELEGRAM_SLOW_THRESHOLD_MS) telegramSlowCount++;
}

export function recordTradingScan(durationMs: number): void {
  tradingScans++;
  tradingScanTotalMs += durationMs;
}

export function recordTrade(): void {
  tradingTrades++;
}

export function getPerformanceSnapshot(): PerformanceSnapshot {
  const mem = process.memoryUsage();
  const now = Date.now();
  const fiveMinAgo = now - 300000;

  const recentMetrics = requestMetrics.filter(m => m.timestamp > fiveMinAgo);
  const allDurations = requestMetrics.map(m => m.durationMs).sort((a, b) => a - b);
  const errorCount = requestMetrics.filter(m => m.statusCode >= 500).length;

  const p95Idx = Math.floor(allDurations.length * 0.95);
  const p95 = allDurations[p95Idx] || 0;
  const avgLatency = allDurations.length > 0
    ? Math.round(allDurations.reduce((s, d) => s + d, 0) / allDurations.length)
    : 0;

  const telegramTotal = telegramMessages + telegramCallbacks;

  return {
    uptime: Math.floor((now - startTime) / 1000),
    memoryMB: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
      heapTotal: Math.round(mem.heapTotal / 1048576),
    },
    requests: {
      total: requestMetrics.length,
      last5min: recentMetrics.length,
      avgLatencyMs: avgLatency,
      p95LatencyMs: Math.round(p95),
      errorRate: requestMetrics.length > 0 ? Math.round((errorCount / requestMetrics.length) * 10000) / 100 : 0,
    },
    telegram: {
      messagesProcessed: telegramMessages,
      callbacksProcessed: telegramCallbacks,
      avgResponseMs: telegramTotal > 0 ? Math.round(telegramTotalMs / telegramTotal) : 0,
      slowResponses: telegramSlowCount,
    },
    trading: {
      scansCompleted: tradingScans,
      tradesExecuted: tradingTrades,
      avgScanMs: tradingScans > 0 ? Math.round(tradingScanTotalMs / tradingScans) : 0,
    },
  };
}

const MAX_RATE_LIMIT_BUCKETS = 50000;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    if (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
      for (const [k, b] of rateLimitBuckets) {
        if (now > b.resetAt) rateLimitBuckets.delete(k);
        if (rateLimitBuckets.size < MAX_RATE_LIMIT_BUCKETS * 0.8) break;
      }
    }
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= maxRequests) return false;
  bucket.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(key);
  }
}, 60000);

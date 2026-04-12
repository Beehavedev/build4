const MIN_INTERVAL_MS = 1000;
let _lastRequestTime = 0;
let _requestCount = 0;
let _queue: Array<{ resolve: () => void; priority: boolean }> = [];
let _processing = false;

let _ipBanned = false;
let _ipBanTime = 0;

let _weightPausedUntil = 0;

const _cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL_MS = 60000;

async function processQueue(): Promise<void> {
  if (_processing) return;
  _processing = true;
  while (_queue.length > 0) {
    if (_ipBanned) {
      const item = _queue.shift()!;
      item.resolve();
      continue;
    }
    const now = Date.now();
    if (_weightPausedUntil > now) {
      const waitMs = _weightPausedUntil - now;
      console.log(`[RateLimit] Weight pause active, waiting ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
    const priorityIdx = _queue.findIndex(q => q.priority);
    const idx = priorityIdx >= 0 ? priorityIdx : 0;
    const item = _queue.splice(idx, 1)[0];
    const elapsed = Date.now() - _lastRequestTime;
    if (elapsed < MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
    }
    _lastRequestTime = Date.now();
    _requestCount++;
    item.resolve();
  }
  _processing = false;
}

export async function rateLimitWait(priority = false): Promise<void> {
  if (_ipBanned) {
    throw new Error(`IP banned by Aster API at ${new Date(_ipBanTime).toISOString()}. All requests stopped.`);
  }
  return new Promise<void>((resolve) => {
    _queue.push({ resolve, priority });
    processQueue();
  });
}

export function markIpBanned(): void {
  _ipBanned = true;
  _ipBanTime = Date.now();
  console.error(`[RateLimit] IP BANNED (418). All Aster API requests stopped.`);
}

export function isIpBanned(): boolean {
  return _ipBanned;
}

export function setWeightPause(durationMs: number = 30000): void {
  _weightPausedUntil = Date.now() + durationMs;
  console.log(`[RateLimit] Weight limit exceeded, pausing all requests for ${durationMs / 1000}s`);
}

export function checkWeightHeader(headers: Headers): void {
  const weight = headers.get("x-mbx-used-weight-1m") || headers.get("X-MBX-USED-WEIGHT-1M");
  if (weight) {
    const w = parseInt(weight, 10);
    if (!isNaN(w) && w > 800) {
      console.log(`[RateLimit] Weight ${w} > 800, pausing 30s`);
      setWeightPause(30000);
    }
  }
}

export function getRetryAfterMs(headers: Headers): number | null {
  const ra = headers.get("retry-after") || headers.get("Retry-After");
  if (ra) {
    const secs = parseInt(ra, 10);
    if (!isNaN(secs) && secs > 0) return secs * 1000;
  }
  return null;
}

export function getCached(key: string): any | null {
  const entry = _cache.get(key);
  if (entry && (Date.now() - entry.ts) < CACHE_TTL_MS) {
    return entry.data;
  }
  if (entry) _cache.delete(key);
  return null;
}

export function setCache(key: string, data: any): void {
  _cache.set(key, { data, ts: Date.now() });
  if (_cache.size > 500) {
    const now = Date.now();
    const keys = Array.from(_cache.keys());
    for (const k of keys) {
      const v = _cache.get(k);
      if (v && now - v.ts > CACHE_TTL_MS) _cache.delete(k);
    }
  }
}

export function getRateLimitStats(): { requestCount: number; lastRequestTime: number; queueLength: number; ipBanned: boolean; weightPausedUntil: number } {
  return { requestCount: _requestCount, lastRequestTime: _lastRequestTime, queueLength: _queue.length, ipBanned: _ipBanned, weightPausedUntil: _weightPausedUntil };
}

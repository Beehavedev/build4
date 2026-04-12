const MIN_INTERVAL_MS = 600;
let _lastRequestTime = 0;
let _requestCount = 0;

export async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  _lastRequestTime = Date.now();
  _requestCount++;
}

export function getRateLimitStats(): { requestCount: number; lastRequestTime: number } {
  return { requestCount: _requestCount, lastRequestTime: _lastRequestTime };
}

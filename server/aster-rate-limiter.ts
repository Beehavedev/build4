const MIN_INTERVAL_MS = 200;
let _lastRequestTime = 0;
let _requestCount = 0;
let _queue: Array<{ resolve: () => void; priority: boolean }> = [];
let _processing = false;

async function processQueue(): Promise<void> {
  if (_processing) return;
  _processing = true;
  while (_queue.length > 0) {
    const priorityIdx = _queue.findIndex(q => q.priority);
    const idx = priorityIdx >= 0 ? priorityIdx : 0;
    const item = _queue.splice(idx, 1)[0];
    const now = Date.now();
    const elapsed = now - _lastRequestTime;
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
  return new Promise<void>((resolve) => {
    _queue.push({ resolve, priority });
    processQueue();
  });
}

export function getRateLimitStats(): { requestCount: number; lastRequestTime: number; queueLength: number } {
  return { requestCount: _requestCount, lastRequestTime: _lastRequestTime, queueLength: _queue.length };
}

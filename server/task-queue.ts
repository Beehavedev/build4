type TaskPriority = "critical" | "high" | "normal" | "low";

interface QueuedTask<T = any> {
  id: string;
  type: string;
  data: T;
  priority: TaskPriority;
  createdAt: number;
  attempts: number;
  maxAttempts: number;
  status: "pending" | "processing" | "completed" | "failed";
  result?: any;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

type TaskHandler = (data: any) => Promise<any>;

const PRIORITY_ORDER: Record<TaskPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
const MAX_CONCURRENT = 8;
const DEFAULT_MAX_ATTEMPTS = 3;

const queues = new Map<string, QueuedTask[]>();
const handlers = new Map<string, TaskHandler>();
let activeTasks = 0;
let totalProcessed = 0;
let totalFailed = 0;
let totalLatencyMs = 0;
let processing = false;

export function registerTaskHandler(type: string, handler: TaskHandler): void {
  handlers.set(type, handler);
}

export function enqueueTask<T = any>(
  type: string,
  data: T,
  options?: { priority?: TaskPriority; maxAttempts?: number }
): string {
  const id = `${type}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const task: QueuedTask<T> = {
    id, type, data,
    priority: options?.priority || "normal",
    createdAt: Date.now(),
    attempts: 0,
    maxAttempts: options?.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    status: "pending",
  };

  if (!queues.has(type)) queues.set(type, []);
  queues.get(type)!.push(task);

  setImmediate(() => processQueue());
  return id;
}

export function enqueueAndWait<T = any, R = any>(
  type: string,
  data: T,
  options?: { priority?: TaskPriority; maxAttempts?: number; timeoutMs?: number }
): Promise<R> {
  return new Promise((resolve, reject) => {
    const id = `${type}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const timeoutMs = options?.timeoutMs || 30000;

    const task: QueuedTask<T> = {
      id, type, data,
      priority: options?.priority || "normal",
      createdAt: Date.now(),
      attempts: 0,
      maxAttempts: options?.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      status: "pending",
    };

    if (!queues.has(type)) queues.set(type, []);
    queues.get(type)!.push(task);

    const timer = setTimeout(() => {
      reject(new Error(`Task ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const checkInterval = setInterval(() => {
      if (task.status === "completed") {
        clearInterval(checkInterval);
        clearTimeout(timer);
        resolve(task.result);
      } else if (task.status === "failed") {
        clearInterval(checkInterval);
        clearTimeout(timer);
        reject(new Error(task.error || "Task failed"));
      }
    }, 50);

    setImmediate(() => processQueue());
  });
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    while (activeTasks < MAX_CONCURRENT) {
      const nextTask = getNextTask();
      if (!nextTask) break;

      activeTasks++;
      processTask(nextTask).finally(() => {
        activeTasks--;
        setImmediate(() => processQueue());
      });
    }
  } finally {
    processing = false;
  }
}

function getNextTask(): QueuedTask | null {
  let bestTask: QueuedTask | null = null;
  let bestPriority = 999;

  for (const [, queue] of queues) {
    for (let i = 0; i < queue.length; i++) {
      const task = queue[i];
      if (task.status !== "pending") continue;
      const p = PRIORITY_ORDER[task.priority];
      if (p < bestPriority || (p === bestPriority && task.createdAt < (bestTask?.createdAt || Infinity))) {
        bestTask = task;
        bestPriority = p;
      }
    }
  }

  return bestTask;
}

async function processTask(task: QueuedTask): Promise<void> {
  const handler = handlers.get(task.type);
  if (!handler) {
    task.status = "failed";
    task.error = `No handler for type: ${task.type}`;
    totalFailed++;
    return;
  }

  task.status = "processing";
  task.startedAt = Date.now();
  task.attempts++;

  try {
    task.result = await handler(task.data);
    task.status = "completed";
    task.completedAt = Date.now();
    totalProcessed++;
    totalLatencyMs += task.completedAt - task.startedAt;
  } catch (e: any) {
    if (task.attempts < task.maxAttempts) {
      task.status = "pending";
      await new Promise(r => setTimeout(r, Math.min(1000 * task.attempts, 5000)));
    } else {
      task.status = "failed";
      task.error = e.message?.substring(0, 200) || "Unknown error";
      task.completedAt = Date.now();
      totalFailed++;
    }
  }

  for (const [type, queue] of queues) {
    const idx = queue.findIndex(t => t.status === "completed" || t.status === "failed");
    if (idx >= 0 && Date.now() - (queue[idx].completedAt || 0) > 60000) {
      queues.set(type, queue.filter(t => t.status === "pending" || t.status === "processing"));
    }
  }
}

export function getQueueStats(): {
  totalQueued: number;
  totalProcessing: number;
  totalProcessed: number;
  totalFailed: number;
  avgLatencyMs: number;
  queuesByType: Record<string, { pending: number; processing: number }>;
} {
  const queuesByType: Record<string, { pending: number; processing: number }> = {};
  let totalQueued = 0;
  let totalProcessingNow = 0;

  for (const [type, queue] of queues) {
    const pending = queue.filter(t => t.status === "pending").length;
    const proc = queue.filter(t => t.status === "processing").length;
    queuesByType[type] = { pending, processing: proc };
    totalQueued += pending;
    totalProcessingNow += proc;
  }

  return {
    totalQueued,
    totalProcessing: totalProcessingNow,
    totalProcessed,
    totalFailed,
    avgLatencyMs: totalProcessed > 0 ? Math.round(totalLatencyMs / totalProcessed) : 0,
    queuesByType,
  };
}

export function cleanupOldTasks(): void {
  const cutoff = Date.now() - 120000;
  for (const [type, queue] of queues) {
    queues.set(type, queue.filter(t => 
      t.status === "pending" || t.status === "processing" || (t.completedAt && t.completedAt > cutoff)
    ));
  }
}

setInterval(cleanupOldTasks, 60000);

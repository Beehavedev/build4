// Append-only JSONL store for A/B harness decisions.
// Kept on disk (not the Prisma DB) so the harness is fully isolated from
// production trading and adds zero migration risk. Each record is a single
// JSON line; rewrites (used by the resolver to attach PnL) load + rewrite
// the whole file atomically. Volumes are tiny (≤ a few thousand records
// over a multi-day run), so this is plenty fast.

import { promises as fs } from 'fs';
import * as path from 'path';
import { AbDecisionRecord } from './types';

const DEFAULT_PATH = path.join(process.cwd(), '.local', 'ab', 'decisions.jsonl');

export function getStorePath(): string {
  return process.env.AB_HARNESS_LOG ?? DEFAULT_PATH;
}

async function ensureDir(p: string) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

export async function appendDecision(rec: AbDecisionRecord, file = getStorePath()): Promise<void> {
  await ensureDir(file);
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
}

export async function readAll(file = getStorePath()): Promise<AbDecisionRecord[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AbDecisionRecord);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

// Rewrite the whole file. Used by the resolver after attaching `resolved`.
// Atomicity: write to a temp file then rename — protects against a crash
// mid-write turning the log into garbage.
export async function rewriteAll(records: AbDecisionRecord[], file = getStorePath()): Promise<void> {
  await ensureDir(file);
  const tmp = file + '.tmp';
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);
}

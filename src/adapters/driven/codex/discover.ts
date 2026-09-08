/**
 * Codex session discovery (tasks.md 12.1, spec: "Codex Session Discovery and Record Families").
 *
 * Codex sessions live at `<root>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, a date-
 * partitioned tree (research-local-evidence.md Q1). Unlike Claude Code, Codex has no subagent
 * transcript convention — correlation is flat, always (design.md "Correlation and the Agent
 * Tree": "Codex | none — only `thread_id`/`turn_id` within one thread").
 *
 * This module never opens a file for writing. `discoverCodexSessions` only reads directory
 * entries; it never creates, modifies, or deletes anything under `root`.
 */
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { SessionRef } from '../../../ports/activity-source.port';

export interface CodexSessionRef extends SessionRef {
  harness: 'codex';
  filePath: string;
}

const ROLLOUT_FILENAME_PATTERN =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/**
 * Pure filename classifier: decides whether a `.jsonl` path is a Codex rollout session file and
 * extracts its session id (the trailing UUID). Returns `null` for any path that does not match.
 * No I/O.
 */
export function classifyCodexSessionPath(filePath: string): Omit<CodexSessionRef, 'discoveredAt'> | null {
  const fileName = basename(filePath);
  const match = ROLLOUT_FILENAME_PATTERN.exec(fileName);
  if (!match) return null;
  const sessionId = match[1];
  return {
    harness: 'codex',
    sessionKey: `codex:${sessionId}`,
    filePath,
  };
}

/** Recursively lists every regular file under `dir`. Read-only: uses `readdir` only. */
async function listFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * One-shot scan of `<root>/sessions/**` for Codex rollout files, regardless of date-partition
 * depth (spec: "Session file located by date partition"). Read-only.
 */
export async function discoverCodexSessions(root: string): Promise<CodexSessionRef[]> {
  const sessionsRoot = join(root, 'sessions');
  let files: string[];
  try {
    files = await listFilesRecursively(sessionsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const now = Date.now();
  const refs: CodexSessionRef[] = [];
  for (const filePath of files) {
    if (!filePath.endsWith('.jsonl')) continue;
    const classified = classifyCodexSessionPath(filePath);
    if (classified) refs.push({ ...classified, discoveredAt: now });
  }
  return refs;
}

/** Today's date-partitioned rollout directory under `<root>/sessions/YYYY/MM/DD`. */
export function currentDayDirectory(root: string, now: Date = new Date()): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return join(root, 'sessions', year, month, day);
}

/**
 * Watches the current day's directory for newly added rollout files (spec/design.md: "watch the
 * current day directory") and invokes `onDiscovered` for each one. Read-only: chokidar's `add`
 * watcher never writes to the watched tree. The caller owns the returned watcher's lifecycle.
 */
export function watchCodexSessions(
  root: string,
  dayDirectory: string,
  onDiscovered: (ref: CodexSessionRef) => void,
): FSWatcher {
  const watcher = chokidar.watch(dayDirectory, { ignoreInitial: true });
  watcher.on('add', (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) return;
    const classified = classifyCodexSessionPath(filePath);
    if (classified) onDiscovered({ ...classified, discoveredAt: Date.now() });
  });
  return watcher;
}

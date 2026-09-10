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
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { SessionRef } from '../../../ports/activity-source.port';
import { DEFAULT_ACTIVE_WINDOW_MS, isWithinActiveWindow } from '../../../shared/active-window';

export interface DiscoverActiveWindowOptions {
  /** Injectable clock, for deterministic active-window tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Bootstrap window (design.md: attach only to sessions touched within 24h). */
  activeWindowMs?: number;
}

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
export function classifyCodexSessionPath(filePath: string): Omit<CodexSessionRef, 'discoveredAt' | 'cwd'> | null {
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

/**
 * Bound on how much of a rollout file is scanned for its `session_meta` record (design.md
 * "Launch <-> log correlation"). `session_meta` is always ordinal 0 in practice
 * (research-local-evidence.md), so this bound is generous, not tight.
 */
const CWD_PROBE_MAX_BYTES = 64 * 1024;

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
  const stream = createReadStream(filePath, { start: 0, end: maxBytes - 1, encoding: 'utf8' });
  let out = '';
  for await (const chunk of stream) out += chunk as string;
  return out;
}

/**
 * Task 25.2 (blocker resolution): scans the bounded file prefix for the `session_meta` record's
 * `payload.cwd` — Codex's exact-match cwd signal for the launch correlator. Returns `null`, never
 * a guess, when no `session_meta` record is found within the bound or the file cannot be read.
 */
export async function resolveCodexSessionCwd(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFilePrefix(filePath, CWD_PROBE_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const record = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } };
      if (record.type === 'session_meta' && typeof record.payload?.cwd === 'string') return record.payload.cwd;
    } catch {
      continue; // a truncated trailing line at the byte bound is expected — try the next line
    }
  }
  return null;
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
export async function discoverCodexSessions(
  root: string,
  options: DiscoverActiveWindowOptions = {},
): Promise<CodexSessionRef[]> {
  const now = options.now ?? Date.now;
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const sessionsRoot = join(root, 'sessions');
  let files: string[];
  try {
    files = await listFilesRecursively(sessionsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const discoveredAt = now();
  const refs: CodexSessionRef[] = [];
  for (const filePath of files) {
    if (!filePath.endsWith('.jsonl')) continue;
    const classified = classifyCodexSessionPath(filePath);
    if (!classified) continue;
    const fileStat = await stat(filePath);
    if (!isWithinActiveWindow(fileStat.mtimeMs, discoveredAt, activeWindowMs)) continue;
    const cwd = await resolveCodexSessionCwd(filePath);
    refs.push({ ...classified, cwd, discoveredAt });
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
    if (!classified) return;
    void resolveCodexSessionCwd(filePath).then((cwd) => {
      onDiscovered({ ...classified, cwd, discoveredAt: Date.now() });
    });
  });
  return watcher;
}

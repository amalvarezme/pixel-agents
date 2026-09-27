/**
 * Pi orchestrator session discovery (spec: "Pi Orchestrator Session Discovery").
 *
 * Pi keeps orchestrator transcripts at `<root>/sessions/<encoded-cwd>/<iso-ts>_<session-id>.jsonl`,
 * a one-level project tree. Subagent transcripts are NOT here: children are spawned with
 * `--session-dir <root>/gentle-agents/sessions` (gentle-pi `lib/agents-runner.ts`), so everything
 * this module discovers is an orchestrator by construction (design.md D3). That is the structural
 * reason Pi needs no role classifier and no correlation heuristic.
 *
 * The directory name is NEVER decoded. Pi builds it by replacing every `/` with `-`, so
 * `/tmp/a-b` and `/tmp/a/b` both encode to `--tmp-a-b--`; inverting that would have to guess.
 * The transcript's own `session` record carries the real `cwd`, and it is the only signal used.
 *
 * This module never opens a file for writing (spec: "Pi Zero-Write Guarantee").
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

export interface PiSessionRef extends SessionRef {
  harness: 'pi';
  /**
   * The bare session id, WITHOUT the `pi:` key prefix. Kept separately because the presence
   * registry correlates on `sha256(sessionId)` of exactly this string (design.md D2) — hashing
   * the prefixed `sessionKey` would never match a single header.
   */
  sessionId: string;
  filePath: string;
}

/**
 * `<iso-timestamp>_<session-id>.jsonl`. The id is a UUIDv7 in practice (`01a0e06e-…-7018-…`), so
 * the pattern accepts any hex UUID layout rather than pinning version/variant nibbles, which would
 * reject real sessions the moment Pi changes its id generator.
 */
const TRANSCRIPT_FILENAME_PATTERN =
  /^[0-9TZ:.\-]+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Pure filename classifier. Returns `null` for any path that is not a Pi transcript. No I/O. */
export function classifyPiSessionPath(
  filePath: string,
): Omit<PiSessionRef, 'discoveredAt' | 'cwd'> | null {
  const sessionId = TRANSCRIPT_FILENAME_PATTERN.exec(basename(filePath))?.[1];
  if (!sessionId) return null;
  return { harness: 'pi', sessionKey: `pi:${sessionId}`, sessionId, filePath };
}

/**
 * Bound on how much of a transcript is scanned for its `session` record. That record is always
 * the first line in practice, so this bound is generous rather than tight — the same shape as
 * `codex/discover.ts`'s `CWD_PROBE_MAX_BYTES`.
 */
const CWD_PROBE_MAX_BYTES = 64 * 1024;

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
  const stream = createReadStream(filePath, { start: 0, end: maxBytes - 1, encoding: 'utf8' });
  let out = '';
  for await (const chunk of stream) out += chunk as string;
  return out;
}

/**
 * Scans the bounded prefix for the `session` record's `cwd` — Pi's only project signal. Returns
 * `null`, never a guess, when the record is absent within the bound or the file cannot be read.
 */
export async function resolvePiSessionCwd(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFilePrefix(filePath, CWD_PROBE_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"session"')) continue;
    try {
      const record = JSON.parse(line) as { type?: string; cwd?: unknown };
      if (record.type === 'session' && typeof record.cwd === 'string') return record.cwd;
    } catch {
      continue; // a truncated trailing line at the byte bound is expected — try the next line
    }
  }
  return null;
}

/** One-shot read-only scan of `<root>/sessions/<project>/*.jsonl`. */
export async function discoverPiSessions(
  root: string,
  options: DiscoverActiveWindowOptions = {},
): Promise<PiSessionRef[]> {
  const now = options.now ?? Date.now;
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const sessionsRoot = join(root, 'sessions');

  let projectDirs: string[];
  try {
    projectDirs = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsRoot, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const discoveredAt = now();
  const refs: PiSessionRef[] = [];
  for (const projectDir of projectDirs) {
    const entries = await readdir(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = join(projectDir, entry.name);
      const classified = classifyPiSessionPath(filePath);
      if (!classified) continue;
      const fileStat = await stat(filePath);
      if (!isWithinActiveWindow(fileStat.mtimeMs, discoveredAt, activeWindowMs)) continue;
      refs.push({
        ...classified,
        cwd: await resolvePiSessionCwd(filePath),
        discoveredAt,
        lastActivityAt: fileStat.mtimeMs,
      });
    }
  }
  return refs;
}

/**
 * Watches `<root>/sessions` recursively for newly added transcripts. Read-only: chokidar's `add`
 * watcher never writes to the watched tree. The caller owns the returned watcher's lifecycle.
 */
export function watchPiSessions(
  sessionsRoot: string,
  onDiscovered: (ref: PiSessionRef) => void,
): FSWatcher {
  const watcher = chokidar.watch(sessionsRoot, { ignoreInitial: true });
  watcher.on('add', (filePath: string) => {
    const classified = classifyPiSessionPath(filePath);
    if (!classified) return;
    void resolvePiSessionCwd(filePath).then((cwd) => {
      // A freshly-added file: its mtime IS effectively now, so `Date.now()` is a faithful stand-in
      // rather than a real stat() round-trip.
      onDiscovered({ ...classified, cwd, discoveredAt: Date.now(), lastActivityAt: Date.now() });
    });
  });
  return watcher;
}

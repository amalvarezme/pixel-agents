/**
 * Claude Code session discovery (tasks.md 7.1, spec: "Claude Code Session Discovery").
 *
 * Top-level sessions live at `<root>/projects/<slug>/<session-id>.jsonl`. Subagent transcripts
 * live at `<root>/projects/<slug>/<parent-session-id>/subagents/agent-<agentId>.jsonl` — the
 * `<parent-session-id>` path segment is a second, independent parent edge (design.md
 * "Correlation and the Agent Tree"), distinct from the `toolUseResult.agentId` edge parsed from
 * record content in `parse.ts`/`correlate.ts`.
 *
 * This module never opens a file for writing. `discoverClaudeCodeSessions` only reads directory
 * entries; it never creates, modifies, or deletes anything under `root`.
 */
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { SessionRef } from '../../../ports/activity-source.port';

export interface ClaudeCodeSessionRef extends SessionRef {
  harness: 'claude-code';
  filePath: string;
  isSubagent: boolean;
  parentSessionKey: string | null;
}

const SUBAGENT_FILENAME_PATTERN = /^agent-(.+)\.jsonl$/;
const SESSION_FILENAME_PATTERN = /^(.+)\.jsonl$/;

/**
 * Pure path classifier: decides whether a `.jsonl` path is a top-level Claude Code session or a
 * subagent transcript, and extracts both session identity and the directory-derived parent edge.
 * Returns `null` for any path that does not match either shape. No I/O.
 */
export function classifyClaudeCodeSessionPath(filePath: string): Omit<ClaudeCodeSessionRef, 'discoveredAt' | 'cwd'> | null {
  const fileName = basename(filePath);
  const parentDir = dirname(filePath);
  const parentDirName = basename(parentDir);

  if (parentDirName === 'subagents') {
    const match = SUBAGENT_FILENAME_PATTERN.exec(fileName);
    if (!match) return null;
    const agentId = match[1];
    const parentSessionId = basename(dirname(parentDir));
    return {
      harness: 'claude-code',
      sessionKey: `claude-code:${agentId}`,
      filePath,
      isSubagent: true,
      parentSessionKey: `claude-code:${parentSessionId}`,
    };
  }

  const match = SESSION_FILENAME_PATTERN.exec(fileName);
  if (!match) return null;
  const sessionId = match[1];
  return {
    harness: 'claude-code',
    sessionKey: `claude-code:${sessionId}`,
    filePath,
    isSubagent: false,
    parentSessionKey: null,
  };
}

/**
 * Bound on how much of a session file is scanned for a `cwd` field (design.md "Launch <-> log
 * correlation"). Read-only, and bounded so a large pre-existing session's discovery scan never
 * reads the whole file — a fresh, correlation-relevant file's `cwd` record appears within this
 * prefix in practice.
 */
const CWD_PROBE_MAX_BYTES = 64 * 1024;

/** Reads only the first `maxBytes` of `filePath`. Never touches the rest of the file. */
async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
  const stream = createReadStream(filePath, { start: 0, end: maxBytes - 1, encoding: 'utf8' });
  let out = '';
  for await (const chunk of stream) out += chunk as string;
  return out;
}

/**
 * Task 25.2 (blocker resolution): scans the bounded file prefix for the first record carrying a
 * string `cwd` field — Claude Code JSONL records carry a top-level `cwd`, but not necessarily on
 * the first line (an early bootstrap-only record may omit it). Returns `null`, never a guess,
 * when no `cwd` is found within the bound or the file cannot be read.
 */
export async function resolveClaudeCodeSessionCwd(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFilePrefix(filePath, CWD_PROBE_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const record = JSON.parse(line) as { cwd?: unknown };
      if (typeof record.cwd === 'string') return record.cwd;
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
 * One-shot scan of `<root>/projects/**` for Claude Code session and subagent files. Read-only.
 * The caller is responsible for turning discovered files into a live tail (see `tail.ts`) and for
 * live discovery of files added after this scan (see `watchClaudeCodeSessions`).
 */
export async function discoverClaudeCodeSessions(root: string): Promise<ClaudeCodeSessionRef[]> {
  const projectsRoot = join(root, 'projects');
  let files: string[];
  try {
    files = await listFilesRecursively(projectsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const now = Date.now();
  const refs: ClaudeCodeSessionRef[] = [];
  for (const filePath of files) {
    if (!filePath.endsWith('.jsonl')) continue;
    const classified = classifyClaudeCodeSessionPath(filePath);
    if (!classified) continue;
    const cwd = await resolveClaudeCodeSessionCwd(filePath);
    refs.push({ ...classified, cwd, discoveredAt: now });
  }
  return refs;
}

/**
 * Watches `<root>/projects/**` for newly added session/subagent files and invokes `onDiscovered`
 * for each one that classifies as a Claude Code session (spec: "chokidar `add` for new files").
 * Read-only: chokidar's `add` watcher never writes to the watched tree. The caller owns the
 * returned watcher's lifecycle and must call `close()` to stop watching.
 */
export function watchClaudeCodeSessions(
  root: string,
  onDiscovered: (ref: ClaudeCodeSessionRef) => void,
): FSWatcher {
  const projectsRoot = join(root, 'projects');
  const watcher = chokidar.watch(projectsRoot, { ignoreInitial: true });
  watcher.on('add', (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) return;
    const classified = classifyClaudeCodeSessionPath(filePath);
    if (!classified) return;
    void resolveClaudeCodeSessionCwd(filePath).then((cwd) => {
      onDiscovered({ ...classified, cwd, discoveredAt: Date.now() });
    });
  });
  return watcher;
}

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
export function classifyClaudeCodeSessionPath(filePath: string): Omit<ClaudeCodeSessionRef, 'discoveredAt'> | null {
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
    if (classified) refs.push({ ...classified, discoveredAt: now });
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
    if (classified) onDiscovered({ ...classified, discoveredAt: Date.now() });
  });
  return watcher;
}

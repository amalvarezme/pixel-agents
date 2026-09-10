/**
 * Antigravity session discovery (tasks.md 13.1, spec: "Antigravity CLI Session Discovery",
 * "Antigravity IDE Root Separation"). Two surfaces share one on-disk shape but are otherwise
 * distinct:
 *
 * - CLI: `<root>/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`, which may
 *   have a sibling `transcript_full.jsonl` once a conversation has compacted. Both are recorded
 *   as candidates (research-local-evidence.md: "transcript_full.jsonl is the CLI's un-truncated
 *   superset"), but ONLY `transcript.jsonl` is ever tailed (design.md: "following both
 *   double-emits"). CLI sessions are launch-eligible.
 * - IDE: `<root>/antigravity-ide/brain/<uuid>/.system_generated/logs/transcript.jsonl`, which
 *   never has a `transcript_full.jsonl` counterpart on this evidence. IDE sessions are read-only
 *   and NEVER launch-eligible (spec: "no launch affordance is offered for it").
 *
 * This module never opens a file for writing. `discoverAntigravitySessions` only reads directory
 * entries; it never creates, modifies, or deletes anything under `root`.
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { SessionRef } from '../../../ports/activity-source.port';
import { DEFAULT_ACTIVE_WINDOW_MS, isWithinActiveWindow } from '../../../shared/active-window';

export interface DiscoverActiveWindowOptions {
  /** Injectable clock, for deterministic active-window tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Bootstrap window (design.md: attach only to sessions touched within 24h). */
  activeWindowMs?: number;
}

export type AntigravitySurface = 'cli' | 'ide';

export interface AntigravitySessionRef extends SessionRef {
  harness: 'antigravity';
  /** The ONLY file ever tailed — always `transcript.jsonl` (design.md D-tail decision). */
  filePath: string;
  surface: AntigravitySurface;
  /** True only for the CLI surface; the IDE surface is ingestion-only (spec: IDE Root Separation). */
  launchEligible: boolean;
  /** Every file discovered for this conversation, including `transcript_full.jsonl` when present. */
  candidateFiles: string[];
}

const SURFACE_DIR_NAMES: Record<string, AntigravitySurface> = {
  'antigravity-cli': 'cli',
  'antigravity-ide': 'ide',
};

export interface ClassifiedAntigravityLogPath {
  surface: AntigravitySurface;
  conversationId: string;
  isFull: boolean;
}

/**
 * Pure path classifier for one file under `<root>/antigravity-{cli,ide}/brain/<uuid>/
 * .system_generated/logs/`. Returns `null` for any file that does not match this exact shape
 * (e.g. an unrelated file under `logs/`, or a path entirely outside the brain tree). No I/O.
 */
export function classifyAntigravityLogPath(filePath: string): ClassifiedAntigravityLogPath | null {
  const fileName = basename(filePath);
  if (fileName !== 'transcript.jsonl' && fileName !== 'transcript_full.jsonl') return null;

  const logsDir = dirname(filePath);
  if (basename(logsDir) !== 'logs') return null;
  const systemGeneratedDir = dirname(logsDir);
  if (basename(systemGeneratedDir) !== '.system_generated') return null;
  const conversationDir = dirname(systemGeneratedDir);
  const brainDir = dirname(conversationDir);
  if (basename(brainDir) !== 'brain') return null;
  const surfaceDir = dirname(brainDir);
  const surface = SURFACE_DIR_NAMES[basename(surfaceDir)];
  if (!surface) return null;

  return { surface, conversationId: basename(conversationDir), isFull: fileName === 'transcript_full.jsonl' };
}

/** Recursively lists every regular file under `dir`. Read-only: uses `readdir` only. */
async function listFilesRecursively(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
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

interface ConversationFiles {
  surface: AntigravitySurface;
  transcript: string | null;
  transcriptFull: string | null;
}

/**
 * One-shot scan of `<root>/antigravity-{cli,ide}/brain/**` for CLI and IDE conversations. A
 * conversation without a `transcript.jsonl` yields no ref — there is nothing to tail — even if a
 * lone `transcript_full.jsonl` exists. Read-only.
 */
export async function discoverAntigravitySessions(
  root: string,
  options: DiscoverActiveWindowOptions = {},
): Promise<AntigravitySessionRef[]> {
  const now = options.now ?? Date.now;
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const files = [
    ...(await listFilesRecursively(join(root, 'antigravity-cli'))),
    ...(await listFilesRecursively(join(root, 'antigravity-ide'))),
  ];

  const byConversation = new Map<string, ConversationFiles>();
  for (const filePath of files) {
    const classified = classifyAntigravityLogPath(filePath);
    if (!classified) continue;
    const key = `${classified.surface}:${classified.conversationId}`;
    const entry = byConversation.get(key) ?? { surface: classified.surface, transcript: null, transcriptFull: null };
    if (classified.isFull) entry.transcriptFull = filePath;
    else entry.transcript = filePath;
    byConversation.set(key, entry);
  }

  const discoveredAt = now();
  const refs: AntigravitySessionRef[] = [];
  for (const [key, entry] of byConversation) {
    if (!entry.transcript) continue;
    const fileStat = await stat(entry.transcript);
    if (!isWithinActiveWindow(fileStat.mtimeMs, discoveredAt, activeWindowMs)) continue;
    const conversationId = key.slice(entry.surface.length + 1);
    const candidateFiles = [entry.transcript, ...(entry.transcriptFull ? [entry.transcriptFull] : [])];
    refs.push({
      harness: 'antigravity',
      sessionKey: `antigravity:${entry.surface}:${conversationId}`,
      filePath: entry.transcript,
      surface: entry.surface,
      launchEligible: entry.surface === 'cli',
      candidateFiles,
      // Antigravity's transcript carries no cwd field at all (design.md "Launch <-> log
      // correlation") — never guessed, so the correlator falls back to harness+window only.
      cwd: null,
      discoveredAt,
      lastActivityAt: fileStat.mtimeMs,
    });
  }
  return refs;
}

/**
 * Watches both surface roots for a newly added `transcript.jsonl` (b1-remaining-harnesses work
 * unit). Only `transcript.jsonl` ever triggers discovery here, matching the one-shot scan's
 * tail-only decision (design.md: "following both double-emits") — a lone new
 * `transcript_full.jsonl` is ignored. Read-only: chokidar's `add` watcher never writes to the
 * watched tree. The caller owns the returned watcher's lifecycle.
 */
export function watchAntigravitySessions(
  root: string,
  onDiscovered: (ref: AntigravitySessionRef) => void,
): FSWatcher {
  const watcher = chokidar.watch([join(root, 'antigravity-cli'), join(root, 'antigravity-ide')], {
    ignoreInitial: true,
  });
  watcher.on('add', (filePath: string) => {
    const classified = classifyAntigravityLogPath(filePath);
    if (!classified || classified.isFull) return;
    onDiscovered({
      harness: 'antigravity',
      sessionKey: `antigravity:${classified.surface}:${classified.conversationId}`,
      filePath,
      surface: classified.surface,
      launchEligible: classified.surface === 'cli',
      candidateFiles: [filePath],
      cwd: null,
      discoveredAt: Date.now(),
      // A freshly-added file: its mtime IS effectively now, so `Date.now()` is a faithful
      // stand-in rather than a real stat() round-trip.
      lastActivityAt: Date.now(),
    });
  });
  return watcher;
}

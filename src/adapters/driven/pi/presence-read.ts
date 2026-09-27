/**
 * Pi subagent presence registry reader (spec: "Pi Subagent Presence Registry").
 *
 * Pi publishes its live subagent state to `<root>/gentle-agents/presence/` as a pair of files per
 * ACTIVATION (`sessionHash` + `incarnation`):
 *
 *   `<sessionHash>.<incarnation>.header.json`   — label, heartbeat, generation, counts, digest
 *   `<sessionHash>.<incarnation>.activity.json` — the tasks themselves, with their thread
 *
 * Both are replaced ATOMICALLY (write-temp + rename) on every change, so a naive read can land
 * between the two writes and see a header describing bytes that no longer exist. This reader
 * reproduces the discipline of Pi's own reader (`gentle-pi/lib/orchestrator-presence.ts`) rather
 * than trusting the filesystem:
 *
 *   1. `lstat`, and reject anything that is not a regular file owned by us with `nlink === 1`
 *      (a symlink could point anywhere; a hard link lets another path rewrite the content).
 *   2. Reject a file past its bound BEFORE reading it.
 *   3. Open with `O_NOFOLLOW`, then `fstat` the descriptor and reject if `dev`/`ino` moved —
 *      that is exactly an atomic replacement mid-read.
 *   4. Require the filename to equal what the header says it is.
 *   5. Verify `sha256(activityBytes) === header.digest` and `activity.generation ===
 *      header.generation`.
 *
 * Every failure is a COUNTED SKIP, never a throw (spec: "Any validation failure MUST be a counted
 * skip"). A registry that cannot be read leaves the office floor as it was; it never stops the
 * process.
 *
 * Directory MODE is deliberately not enforced here, unlike in Pi's own reader. Pi is the publisher
 * and owns that invariant; a reader that refused a readable directory because of its permission
 * bits would make the visualizer blind for a reason it cannot fix. The meaningful check for a
 * reader — file ownership — is applied per file, above.
 *
 * Read-only: nothing here ever opens a file for writing or creates a directory.
 */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Bounds, matching `orchestrator-presence.ts`'s own `HEADER_LIMIT` / `ACTIVITY_LIMIT`. */
const HEADER_LIMIT = 16 * 1024;
const ACTIVITY_LIMIT = 16 * 1024 * 1024;
/** Pi refreshes `heartbeat` every 5s; its own consumers treat 15s as the recency TTL. */
const RECENT_TTL_MS = 15_000;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/**
 * The task statuses Pi's own `validActivity` accepts. Not the same set as our domain's
 * `SessionLifecycle`: this is the WIRE vocabulary, validated here so an unknown status is rejected
 * at the boundary instead of leaking into the office as an unhandled case.
 */
export const PRESENCE_TASK_STATUSES = [
  'running',
  'queued',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;

export type PresenceTaskStatus = (typeof PRESENCE_TASK_STATUSES)[number];

export interface PresenceTaskSummary {
  id: string;
  agent: string;
  label: string;
  status: PresenceTaskStatus;
  model: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number;
}

export type PresenceThreadItem =
  | { kind: 'tool'; callId: string; name: string; output: string; running: boolean; isError: boolean }
  | { kind: 'text' | 'thinking' | 'note'; text: string };

export interface PresenceThread {
  version: number;
  dropped: number;
  items: PresenceThreadItem[];
}

export interface PresenceTask {
  summary: PresenceTaskSummary;
  thread: PresenceThread;
}

export interface PresenceHeader {
  schema: 1;
  sessionHash: string;
  incarnation: string;
  label: string;
  heartbeat: number;
  generation: number;
  counts: { running: number; queued: number; waiting: number; finished: number };
  digest: string | null;
  unavailable: 'activity-too-large' | null;
}

/** `recent` is a READER-owned display hint, never part of what Pi published. */
export type PresenceEntry = PresenceHeader & { recent: boolean };

export interface PresenceHeaderPage {
  entries: PresenceEntry[];
  scanned: number;
  rejected: number;
  /** Set when the directory itself could not be traversed; `'missing'` is the normal cold state. */
  unavailable?: string;
}

export function presenceHeaderFileName(sessionHash: string, incarnation: string): string {
  return `${sessionHash}.${incarnation}.header.json`;
}

export function presenceActivityFileName(sessionHash: string, incarnation: string): string {
  return `${sessionHash}.${incarnation}.activity.json`;
}

/** `<root>/gentle-agents/presence` — the directory Pi creates lazily on the first subagent run. */
export function presenceRootFor(piHome: string): string {
  return join(piHome, 'gentle-agents', 'presence');
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hasExactKeys = (value: Record<string, unknown>, names: readonly string[]): boolean =>
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));

function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'missing';
  if (code === 'ELOOP') return 'unsafe-file';
  if (code) return 'io-error';
  if (error instanceof SyntaxError) return 'malformed';
  return (error as Error).message;
}

/**
 * Rejects anything a trustworthy snapshot file cannot be: a non-regular file, a file we do not own,
 * or one with more than one link (another name for the same inode can rewrite it behind our back).
 */
function assertRegularOwnedFile(stats: Stats): void {
  if (!stats.isFile() || stats.nlink !== 1) throw new Error('unsafe-file');
  if (process.platform !== 'win32' && stats.uid !== process.getuid?.()) throw new Error('unsafe-file');
}

export interface BoundedReadHooks {
  /** Test-only seam: runs between the `lstat` and the `open`, to reproduce an atomic replacement. */
  afterStat?: () => Promise<void> | void;
}

/**
 * Bounded, symlink-refusing, inode-pinned read. Throws a named reason; every caller turns that
 * into a counted skip.
 */
async function boundedRead(path: string, limit: number, hooks: BoundedReadHooks = {}): Promise<Buffer> {
  const before = await lstat(path);
  assertRegularOwnedFile(before);
  if (before.size > limit) throw new Error('oversized');

  await hooks.afterStat?.();

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    assertRegularOwnedFile(stats);
    // The identity check: a rename landing between the lstat above and this open gives us a
    // descriptor on a DIFFERENT inode than the one we validated.
    if (stats.ino !== before.ino || stats.dev !== before.dev) throw new Error('unsafe-file');
    if (stats.size > limit) throw new Error('oversized');
    const bytes = Buffer.alloc(stats.size);
    const { bytesRead } = await handle.read(bytes, 0, stats.size, 0);
    if (bytesRead !== stats.size) throw new Error('changed-file');
    return bytes;
  } finally {
    await handle.close();
  }
}

function isValidHeader(value: unknown): value is PresenceHeader {
  if (!isObject(value)) return false;
  const keys = ['schema', 'sessionHash', 'incarnation', 'label', 'heartbeat', 'generation', 'counts', 'digest', 'unavailable'];
  if (!hasExactKeys(value, keys)) return false;
  if (value.schema !== 1) return false;
  if (typeof value.sessionHash !== 'string' || !HASH_PATTERN.test(value.sessionHash)) return false;
  if (typeof value.incarnation !== 'string' || !UUID_PATTERN.test(value.incarnation)) return false;
  if (typeof value.label !== 'string') return false;
  if (!isCount(value.heartbeat) || !isCount(value.generation) || (value.generation as number) <= 0) return false;
  const counts = value.counts;
  if (!isObject(counts) || !hasExactKeys(counts, ['running', 'queued', 'waiting', 'finished'])) return false;
  if (!Object.values(counts).every(isCount)) return false;
  // Exactly one of the two states: a trustworthy digest, or a declared oversize with no digest.
  const trustworthy = value.unavailable === null && typeof value.digest === 'string' && HASH_PATTERN.test(value.digest);
  const oversized = value.unavailable === 'activity-too-large' && value.digest === null;
  return trustworthy || oversized;
}

function isValidThreadItem(value: unknown): value is PresenceThreadItem {
  if (!isObject(value)) return false;
  if (value.kind === 'tool') {
    return (
      hasExactKeys(value, ['kind', 'callId', 'name', 'output', 'running', 'isError']) &&
      ['callId', 'name', 'output'].every((key) => typeof value[key] === 'string') &&
      typeof value.running === 'boolean' &&
      typeof value.isError === 'boolean'
    );
  }
  return (
    ['text', 'thinking', 'note'].includes(value.kind as string) &&
    hasExactKeys(value, ['kind', 'text']) &&
    typeof value.text === 'string'
  );
}

function isValidTask(value: unknown): value is PresenceTask {
  if (!isObject(value) || !hasExactKeys(value, ['summary', 'thread'])) return false;
  const { summary, thread } = value;
  if (!isObject(summary) || !isObject(thread)) return false;

  const summaryKeys = ['id', 'agent', 'label', 'status', 'model', 'createdAt', 'startedAt', 'endedAt', 'lastActivityAt'];
  if (!hasExactKeys(summary, summaryKeys)) return false;
  if (!['id', 'agent', 'label', 'status', 'model'].every((key) => typeof summary[key] === 'string')) return false;
  if (!(PRESENCE_TASK_STATUSES as readonly string[]).includes(summary.status as string)) return false;
  if (!isCount(summary.createdAt) || !isCount(summary.lastActivityAt)) return false;
  if (![summary.startedAt, summary.endedAt].every((time) => time === null || isCount(time))) return false;

  if (!hasExactKeys(thread, ['version', 'dropped', 'items'])) return false;
  if (!isCount(thread.version) || !isCount(thread.dropped)) return false;
  return Array.isArray(thread.items) && thread.items.every(isValidThreadItem);
}

/**
 * One read-only pass over the presence directory. A missing directory is the normal cold state
 * (Pi creates it on the first subagent run), reported as `unavailable: 'missing'` with no entries —
 * never an error, and never a directory we create.
 */
export async function readPresenceHeaders(presenceRoot: string, now: number): Promise<PresenceHeaderPage> {
  const page: PresenceHeaderPage = { entries: [], scanned: 0, rejected: 0 };
  let names: string[];
  try {
    names = await readdir(presenceRoot);
  } catch (error) {
    return { ...page, unavailable: reason(error) };
  }

  for (const name of names) {
    if (!name.endsWith('.header.json') || name.startsWith('.')) continue;
    page.scanned++;
    try {
      const bytes = await boundedRead(join(presenceRoot, name), HEADER_LIMIT);
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!isValidHeader(value)) throw new Error('malformed');
      // The filename must name the activation the header claims to be, so one activation's header
      // can never be read as another's.
      if (presenceHeaderFileName(value.sessionHash, value.incarnation) !== name) throw new Error('malformed');
      page.entries.push({ ...value, recent: now >= value.heartbeat && now - value.heartbeat <= RECENT_TTL_MS });
    } catch {
      page.rejected++;
    }
  }
  return page;
}

export interface PresenceActivityResult {
  activity?: { tasks: PresenceTask[] };
  /** The named skip reason; `undefined` only when `activity` is present. */
  unavailable?: string;
}

/**
 * Reads the activity file the given header vouches for. The selection PINS both the activation and
 * the generation: a mismatch in either is a skip, never a silent fall back to whatever is on disk.
 */
export async function readPresenceActivity(
  presenceRoot: string,
  selection: PresenceEntry,
  hooks: BoundedReadHooks = {},
): Promise<PresenceActivityResult> {
  const { recent: _recent, ...header } = selection;
  try {
    if (!isValidHeader(header)) throw new Error('malformed');
    // An oversized activity was never written; opening the path would read a stale generation.
    if (header.unavailable) return { unavailable: header.unavailable };

    const bytes = await boundedRead(
      join(presenceRoot, presenceActivityFileName(header.sessionHash, header.incarnation)),
      ACTIVITY_LIMIT,
      hooks,
    );
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isObject(value)) throw new Error('malformed');
    // Generation is checked BEFORE the digest so a stale-but-intact file reports the accurate
    // reason rather than the generic one.
    if (value.generation !== header.generation) throw new Error('generation-mismatch');
    if (createHash('sha256').update(bytes).digest('hex') !== header.digest) throw new Error('digest-mismatch');
    if (!hasExactKeys(value, ['schema', 'sessionHash', 'incarnation', 'generation', 'activity'])) throw new Error('malformed');
    if (value.schema !== 1 || value.sessionHash !== header.sessionHash || value.incarnation !== header.incarnation) {
      throw new Error('malformed');
    }
    const activity = value.activity;
    if (!isObject(activity) || !hasExactKeys(activity, ['tasks']) || !Array.isArray(activity.tasks)) {
      throw new Error('malformed');
    }
    if (!activity.tasks.every(isValidTask)) throw new Error('malformed');

    return { activity: { tasks: activity.tasks } };
  } catch (error) {
    return { unavailable: reason(error) };
  }
}

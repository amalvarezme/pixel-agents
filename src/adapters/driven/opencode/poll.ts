/**
 * OpenCode seq polling, backoff, and checkpointing (tasks.md 17.1-17.5; design.md "OpenCode
 * SQLite" table; spec: "SQLITE_BUSY triggers backoff, not failure").
 *
 * Query: `SELECT seq, type, data FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq LIMIT
 * 500` via `event_aggregate_seq_idx` — the exact query design.md specifies, `LIMIT 500` doubling
 * as the natural per-poll rate cap.
 *
 * Backoff: exponential 50->100->200->400->800->1600, capped at 2000ms, full jitter, reset on
 * success (each fresh `pollWithBackoff` call starts its own attempt counter at 0 — the caller is
 * expected to invoke it once per poll tick, so a successful poll naturally resets the schedule
 * for the next tick). `SQLITE_BUSY`/`_LOCKED`/`_SNAPSHOT` are never surfaced as a failure; any
 * other error propagates immediately (never retried).
 */
import type { SeqCheckpoint } from '../../../ports/activity-source.port';
import type { DatabaseSync } from './db';

export interface OpenCodeEventRow {
  seq: number;
  type: string;
  data: unknown;
}

const DEFAULT_LIMIT = 500;

/** Parses `data` defensively — a malformed JSON payload never throws, it just carries `null`. */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** `SELECT seq, type, data FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq LIMIT ?`. */
export function selectEventsSince(
  db: DatabaseSync,
  aggregateId: string,
  sinceSeq: number,
  limit = DEFAULT_LIMIT,
): OpenCodeEventRow[] {
  const rows = db
    .prepare('SELECT seq, type, data FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(aggregateId, sinceSeq, limit) as Array<{ seq: number; type: string; data: string }>;
  return rows.map((row) => ({ seq: row.seq, type: row.type, data: safeParseJson(row.data) }));
}

export const BACKOFF_SCHEDULE_MS = [50, 100, 200, 400, 800, 1600] as const;
export const BACKOFF_CAP_MS = 2000;
export const BUSY_DEGRADED_THRESHOLD_MS = 30_000;

/** The base delay for a given retry attempt (0-indexed), before jitter, capped at `BACKOFF_CAP_MS`. */
export function backoffBaseForAttempt(attempt: number): number {
  if (attempt < 0 || attempt >= BACKOFF_SCHEDULE_MS.length) return BACKOFF_CAP_MS;
  return BACKOFF_SCHEDULE_MS[attempt] ?? BACKOFF_CAP_MS;
}

/** Full jitter: a uniformly random delay in `[0, base]`. `random` is injectable for determinism. */
export function backoffDelayWithFullJitter(attempt: number, random: () => number = Math.random): number {
  return random() * backoffBaseForAttempt(attempt);
}

const BUSY_ERRCODES = new Set([5, 6, 517]); // SQLITE_BUSY, SQLITE_LOCKED, SQLITE_BUSY_SNAPSHOT

/** Classifies an error as a "busy" signal (backoff-and-retry), never a hard failure. */
export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode === 'number' && BUSY_ERRCODES.has(errcode)) return true;
  return false;
}

export interface PollWithBackoffOptions<T> {
  query: () => T;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onDegraded?: () => void;
}

/**
 * Runs `query`, retrying through busy-class errors with full-jitter exponential backoff. Any
 * non-busy error propagates immediately, unretried. After `BUSY_DEGRADED_THRESHOLD_MS` of
 * continuous busy, calls `onDegraded` exactly once and keeps retrying — busy is never a failure.
 */
export async function pollWithBackoff<T>(options: PollWithBackoffOptions<T>): Promise<T> {
  const { query, sleep, random = Math.random, now = Date.now, onDegraded } = options;
  let attempt = 0;
  let busySince: number | null = null;
  let degradedEmitted = false;

  for (;;) {
    try {
      return query();
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;

      if (busySince === null) busySince = now();
      if (!degradedEmitted && now() - busySince >= BUSY_DEGRADED_THRESHOLD_MS) {
        degradedEmitted = true;
        onDegraded?.();
      }

      await sleep(backoffDelayWithFullJitter(attempt, random));
      attempt++;
    }
  }
}

/**
 * Advances `bySession[aggregateId]` to the max `seq` seen in `events`. Pure and non-mutating —
 * the caller is responsible for calling this ONLY after the batch has actually been published
 * (design.md: "Checkpoint ... committed only after the batch is published"), never before.
 */
export function nextSeqCheckpoint(current: SeqCheckpoint, aggregateId: string, events: OpenCodeEventRow[]): SeqCheckpoint {
  if (events.length === 0) return current;
  const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), -Infinity);
  return { kind: 'seq', bySession: { ...current.bySession, [aggregateId]: maxSeq } };
}

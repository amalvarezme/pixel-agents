/**
 * `ActivitySource` implementation for OpenCode (opencode-activity-source work unit, closing
 * blocker B.1's remaining piece). Composes the already-existing, already-tested building blocks —
 * `db.ts` (read-only open), `schema-probe.ts` (startup drift check), `poll.ts` (seq-ordered event
 * query, full-jitter backoff, busy classification, checkpoint math) and `parse.ts` (row -> event
 * mapping, memory_write wiring) — behind the same `ActivitySource` port the three JSONL harnesses
 * implement (design.md D1: "One ActivitySource port, four implementations").
 *
 * OpenCode is NOT a file tailer: there is no session log to watch, so this file re-implements
 * none of `poll.ts`'s query/backoff/checkpoint logic — it drives that loop on a fixed cadence
 * instead of reacting to filesystem events.
 *
 * Event-to-content hydration (deliberate composition decision): `event.data`'s exact JSON shape
 * for `message.part.updated.1` was never confirmed (tasks.md 17.1) and `parse.ts`'s
 * `mapOpenCodePartToEvents` needs a full `part` row (`id`, `message_id`, `session_id`, `data`) —
 * fields the `event` table does not carry directly. Rather than guess at an unconfirmed shape,
 * this adapter uses `event.seq` (via `poll.ts`'s tested query/backoff/checkpoint helpers) purely
 * as the "something changed for this session" wake signal and the numeric checkpoint currency
 * (`SeqCheckpoint.bySession` is adapter-private opaque JSON per the port doc — its unit does not
 * have to be literally `event.seq` for another adapter, but IS here since it is the only checkpoint
 * math `poll.ts` provides), and separately re-reads the `part` table directly (confirmed shape,
 * research-local-evidence.md Q3) past an in-memory per-session watermark to get the actual rows
 * `mapOpenCodePartToEvents` needs. A process restart replays parts newer than the watermark once
 * per resumed session even if their owning event.seq was already checkpointed — a documented,
 * bounded gap accepted rather than half-guessing an unconfirmed schema (see Deviations in
 * apply-progress).
 *
 * Read-only always: this file never opens its own `DatabaseSync` — every access goes through
 * `openOpenCodeDbReadOnly` (`db.ts`), which enforces `PRAGMA query_only=1`/`busy_timeout=0` and
 * refuses to open when `-shm` is missing while `-wal` is present, never falling back to
 * `immutable=1`. A missing db or a schema-drifted db degrades `discover()`/`probe()` to `disabled`
 * quietly — this adapter never throws out of `discover()`, `open()`, or `close()`.
 */
import type {
  ActivitySource,
  ActivityStream,
  ActivityStreamItem,
  Checkpoint,
  SeqCheckpoint,
  SessionRef,
  SourceHealth,
} from '../../../ports/activity-source.port';
import type { HarnessId } from '../../../domain/events/types';
import { createAsyncQueue } from '../../../shared/async-queue';
import { openOpenCodeDbReadOnly, type DatabaseSync, type OpenCodeDbHandle } from './db';
import { probeOpenCodeSchema } from './schema-probe';
import { nextSeqCheckpoint, pollWithBackoff, selectEventsSince, type OpenCodeEventRow } from './poll';
import { mapOpenCodePartToEvents, mapOpenCodeSessionToEvents, openCodeSessionKey, type OpenCodePartRow, type OpenCodeSessionRow } from './parse';

export interface OpenCodeSessionRef extends SessionRef {
  /** The raw `session.id` (unprefixed) — `open()` needs this to query `event`/`part` by row. */
  sessionId: string;
}

const DEFAULT_CADENCE_MS = 500;
const DEFAULT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OpenCodeActivitySourceOptions {
  /** Injectable monotonic id allocator. Defaults to an in-process counter starting at 1. */
  allocateId?: () => number;
  /** Poll cadence in ms (design.md: 500ms default, 250-2000ms range). */
  cadenceMs?: number;
  /** Injectable clock, for deterministic active-window tests. */
  now?: () => number;
  /** Bootstrap window (design.md: attach only to sessions touched within 24h). */
  activeWindowMs?: number;
}

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

/**
 * Wraps `setTimeout` so every pending sleep across this source's discovery loop and every
 * per-session pump can be cancelled synchronously from one place — `close()` — leaving zero
 * dangling timers instead of waiting out their natural delay.
 */
class CancellableSleeper {
  private readonly pending = new Map<ReturnType<typeof setTimeout>, () => void>();

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = setTimeout(() => {
        this.pending.delete(handle);
        resolve();
      }, ms);
      this.pending.set(handle, resolve);
    });
  }

  cancelAll(): void {
    for (const [handle, resolve] of this.pending) {
      clearTimeout(handle);
      resolve();
    }
    this.pending.clear();
  }
}

interface PartWithTimeUpdated {
  row: OpenCodePartRow;
  timeUpdated: number;
}

interface SessionPumpState {
  stopped: boolean;
}

export class OpenCodeActivitySource implements ActivitySource {
  readonly harness: HarnessId = 'opencode';
  private readonly allocateId: () => number;
  private readonly cadenceMs: number;
  private readonly now: () => number;
  private readonly activeWindowMs: number;
  private readonly sleeper = new CancellableSleeper();
  private readonly activePumps = new Set<Promise<void>>();
  private dbHandle: OpenCodeDbHandle | null = null;
  private closed = false;

  constructor(
    private readonly dbPath: string,
    options: OpenCodeActivitySourceOptions = {},
  ) {
    this.allocateId = options.allocateId ?? defaultAllocateId();
    this.cadenceMs = options.cadenceMs ?? DEFAULT_CADENCE_MS;
    this.now = options.now ?? Date.now;
    this.activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  }

  /** Opens the read-only connection once and reuses it for discovery and every session pump. */
  private ensureOpen(): { status: 'ready'; db: DatabaseSync } | { status: 'disabled'; reason: string; detail?: string } {
    if (this.dbHandle) return { status: 'ready', db: this.dbHandle.db };
    const result = openOpenCodeDbReadOnly(this.dbPath);
    if (result.status !== 'ready') return result;
    this.dbHandle = result.handle;
    return { status: 'ready', db: result.handle.db };
  }

  async probe(): Promise<SourceHealth> {
    const opened = this.ensureOpen();
    if (opened.status !== 'ready') return { status: 'disabled', reason: opened.reason, detail: opened.detail };
    const schema = probeOpenCodeSchema(opened.db);
    if (schema.status !== 'ready') return { status: 'disabled', reason: schema.reason, detail: schema.detail };
    return { status: 'ready' };
  }

  private selectActiveSessions(db: DatabaseSync, seen: Set<string>): OpenCodeSessionRef[] {
    const rows = db
      .prepare('SELECT id, directory, time_updated FROM session WHERE time_updated > ?')
      .all(this.now() - this.activeWindowMs) as Array<{ id: string; directory: string; time_updated: number }>;
    const fresh: OpenCodeSessionRef[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      // `directory` is the launch correlator's OpenCode cwd signal (design.md "Launch <-> log
      // correlation"; real schema: `directory text NOT NULL`, research-local-evidence.md Q3).
      fresh.push({
        harness: 'opencode',
        sessionKey: openCodeSessionKey(row.id),
        cwd: row.directory,
        discoveredAt: this.now(),
        // The session's REAL last-activity time (design.md "Session discovery and aging out"),
        // distinct from `discoveredAt` — carried to the synthetic session_start by open() below.
        lastActivityAt: row.time_updated,
        sessionId: row.id,
      });
    }
    return fresh;
  }

  /**
   * Never throws: a missing db or a schema-drifted db yields nothing rather than raising
   * (Threat Matrix / spec: "OpenCode Schema-Drift Degradation" applied to discovery).
   */
  async *discover(): AsyncIterable<SessionRef> {
    const opened = this.ensureOpen();
    if (opened.status !== 'ready' || this.closed) return;
    const schema = probeOpenCodeSchema(opened.db);
    if (schema.status !== 'ready') return;

    const seen = new Set<string>();
    for (const ref of this.selectActiveSessions(opened.db, seen)) yield ref;
    if (this.closed) return;

    while (!this.closed) {
      await this.sleeper.sleep(this.cadenceMs);
      if (this.closed) return;
      for (const ref of this.selectActiveSessions(opened.db, seen)) yield ref;
    }
  }

  private selectSessionRow(db: DatabaseSync, sessionId: string): OpenCodeSessionRow | null {
    const row = db.prepare('SELECT id, parent_id, title, agent FROM session WHERE id = ?').get(sessionId) as
      | { id: string; parent_id: string | null; title: string; agent: string | null }
      | undefined;
    return row ?? null;
  }

  /** `part` rows for `sessionId` newer than the given watermark (confirmed shape, Q3). */
  private selectNewParts(db: DatabaseSync, sessionId: string, sinceTimeUpdated: number): PartWithTimeUpdated[] {
    const rows = db
      .prepare('SELECT id, message_id, session_id, data, time_updated FROM part WHERE session_id = ? AND time_updated > ? ORDER BY time_updated, id')
      .all(sessionId, sinceTimeUpdated) as Array<{
      id: string;
      message_id: string;
      session_id: string;
      data: string;
      time_updated: number;
    }>;
    return rows.map((row) => ({
      row: { id: row.id, message_id: row.message_id, session_id: row.session_id, data: row.data },
      timeUpdated: row.time_updated,
    }));
  }

  /**
   * Drives `poll.ts`'s tested query/backoff/checkpoint loop for ONE session, on `cadenceMs`.
   * A non-busy query error degrades this session's pump quietly (loop exits, never throws out of
   * `open()`); `SQLITE_BUSY`/`_LOCKED`/`_SNAPSHOT` retry with full-jitter backoff forever
   * (`pollWithBackoff`, never surfaced as a failure).
   */
  private async pumpSession(
    db: DatabaseSync,
    sessionId: string,
    initialCheckpoint: SeqCheckpoint,
    queue: ReturnType<typeof createAsyncQueue<ActivityStreamItem>>,
    state: SessionPumpState,
  ): Promise<void> {
    let checkpoint = initialCheckpoint;
    // Seeded from the checkpoint, never 0-by-default: a resumed session must not re-select
    // `time_updated > 0` and republish every historical part (see SeqCheckpoint.partsBySession).
    let partWatermark = initialCheckpoint.partsBySession?.[sessionId] ?? 0;

    while (!state.stopped && !this.closed) {
      const sinceSeq = checkpoint.bySession[sessionId] ?? 0;
      let events: OpenCodeEventRow[];
      try {
        events = await pollWithBackoff({
          query: () => selectEventsSince(db, sessionId, sinceSeq),
          sleep: (ms) => this.sleeper.sleep(ms),
        });
      } catch {
        return; // non-busy error: degrade this session's pump quietly, never crash the process
      }
      if (state.stopped || this.closed) return;

      if (events.length > 0) {
        const seqAdvanced = nextSeqCheckpoint(checkpoint, sessionId, events);
        const parts = this.selectNewParts(db, sessionId, partWatermark);
        for (const part of parts) {
          partWatermark = Math.max(partWatermark, part.timeUpdated);
          // The published checkpoint carries the watermark of the part being published, so a crash
          // mid-batch resumes at the last row actually handed to the consumer, never before it.
          const nextCheckpoint: SeqCheckpoint = {
            ...seqAdvanced,
            partsBySession: { ...seqAdvanced.partsBySession, [sessionId]: partWatermark },
          };
          for (const event of mapOpenCodePartToEvents(part.row, { allocateId: this.allocateId })) {
            queue.push({ event, checkpoint: nextCheckpoint });
          }
          checkpoint = nextCheckpoint;
        }
        checkpoint = { ...seqAdvanced, partsBySession: { ...seqAdvanced.partsBySession, [sessionId]: partWatermark } };
      }

      await this.sleeper.sleep(this.cadenceMs);
    }
  }

  open(session: SessionRef, from: Checkpoint | null): ActivityStream {
    const sessionId = (session as OpenCodeSessionRef).sessionId;
    const initialCheckpoint: SeqCheckpoint = from && from.kind === 'seq' ? from : { kind: 'seq', bySession: {} };
    const queue = createAsyncQueue<ActivityStreamItem>();
    const state: SessionPumpState = { stopped: false };

    const opened = this.ensureOpen();
    if (opened.status !== 'ready') {
      queue.end();
      return { events: queue, stop: (): void => {} };
    }

    const sessionRow = this.selectSessionRow(opened.db, sessionId);
    if (sessionRow) {
      // Associated-project tracking: `session.cwd` was already resolved from the `directory`
      // column at discovery time (`selectActiveSessions` above); `sessionRow` itself carries no
      // directory (its query never selects it), so it is threaded through here instead.
      for (const event of mapOpenCodeSessionToEvents(sessionRow, {
        allocateId: this.allocateId,
        at: session.lastActivityAt,
        ...(session.cwd !== null ? { projectPath: session.cwd } : {}),
      })) {
        queue.push({ event, checkpoint: initialCheckpoint });
      }
    }

    const pumpPromise = this.pumpSession(opened.db, sessionId, initialCheckpoint, queue, state);
    this.activePumps.add(pumpPromise);
    void pumpPromise.finally(() => this.activePumps.delete(pumpPromise));

    return {
      events: queue,
      stop: (): void => {
        state.stopped = true;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sleeper.cancelAll();
    await Promise.all(this.activePumps);
    if (this.dbHandle) {
      this.dbHandle.close();
      this.dbHandle = null;
    }
  }
}

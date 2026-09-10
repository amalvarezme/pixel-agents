/**
 * `ActivitySource` implementation for Antigravity (b1-remaining-harnesses work unit, blocker
 * B.1). Mirrors `claude-code/activity-source.ts` exactly (design.md D1), reusing the SAME
 * `readTailIncrement`/`watchAndTailFile` byte-offset tailer — Antigravity's `transcript.jsonl` is
 * JSONL like Claude Code and Codex (design.md: "ONE shared mechanism for all three"). This file
 * re-implements none of `discover.ts`'s or `tail.ts`'s logic; it only bridges their shapes into
 * the `AsyncIterable` `ActivitySource` contract, via `shared/async-queue.ts`.
 *
 * `open()` always emits ONE synthetic `session_start` event first, before any content-derived
 * event, for the same reason as every sibling adapter: without it,
 * `domain/office/office.ts`'s `applyEventToOfficeState` never creates a worker for the session.
 *
 * Read-only: this file never opens anything under `root` for writing, only for reading
 * (`discoverAntigravitySessions`) and watching (`watchAntigravitySessions`, `watchAndTailFile`).
 */
import type { FSWatcher } from 'chokidar';
import type {
  ActivitySource,
  ActivityStream,
  ActivityStreamItem,
  ByteOffsetCheckpoint,
  Checkpoint,
  SessionRef,
  SourceHealth,
} from '../../../ports/activity-source.port';
import type { HarnessId } from '../../../domain/events/types';
import { createEventFromLogRecord } from '../../../domain/events/factories';
import { createAsyncQueue } from '../../../shared/async-queue';
import { readTailIncrement, watchAndTailFile } from '../claude-code/tail';
import { discoverAntigravitySessions, watchAntigravitySessions, type AntigravitySessionRef } from './discover';
import { mapAntigravityRecordToEvents, parseAntigravityLine } from './parse';

export interface AntigravityActivitySourceOptions {
  /** Injectable monotonic id allocator. Defaults to an in-process counter starting at 1. */
  allocateId?: () => number;
  /** Injectable clock, for deterministic active-window tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Bootstrap window (design.md: attach only to sessions touched within 24h). */
  activeWindowMs?: number;
  /**
   * Opt-in (design.md "Session discovery and aging out" — Bootstrap: "an opt-in --replay-since
   * exists for demos and fixture capture"): when true, a session with NO prior checkpoint
   * bootstraps by reading its entire transcript from offset 0. Defaults to false — bootstraps at
   * EOF instead, so process start never floods the scene. An EXISTING checkpoint always resumes
   * from where it left off regardless of this flag.
   */
  replayFromStart?: boolean;
}

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

export class AntigravityActivitySource implements ActivitySource {
  readonly harness: HarnessId = 'antigravity';
  private readonly allocateId: () => number;
  private readonly now: () => number;
  private readonly activeWindowMs?: number;
  private readonly replayFromStart: boolean;
  private discoveryWatcher: FSWatcher | null = null;
  private readonly fileWatchers = new Set<FSWatcher>();
  private closed = false;

  constructor(
    private readonly root: string,
    options: AntigravityActivitySourceOptions = {},
  ) {
    this.allocateId = options.allocateId ?? defaultAllocateId();
    this.now = options.now ?? Date.now;
    this.activeWindowMs = options.activeWindowMs;
    this.replayFromStart = options.replayFromStart ?? false;
  }

  async probe(): Promise<SourceHealth> {
    return { status: 'ready' };
  }

  async *discover(): AsyncIterable<SessionRef> {
    for (const ref of await discoverAntigravitySessions(this.root, { now: this.now, activeWindowMs: this.activeWindowMs })) {
      yield ref;
    }
    if (this.closed) return;

    const queue = createAsyncQueue<AntigravitySessionRef>();
    this.discoveryWatcher = watchAntigravitySessions(this.root, (ref) => queue.push(ref));
    for await (const ref of queue) {
      if (this.closed) return;
      yield ref;
    }
  }

  open(session: SessionRef, from: Checkpoint | null): ActivityStream {
    const filePath = (session as AntigravitySessionRef).filePath;
    const sessionKey = session.sessionKey;
    const initialCheckpoint: ByteOffsetCheckpoint | null = from && from.kind === 'byte-offset' ? from : null;
    const queue = createAsyncQueue<ActivityStreamItem>();
    let stopped = false;
    let watcher: FSWatcher | null = null;

    const emitRecordEvents = (lines: string[], checkpoint: Checkpoint): void => {
      for (const line of lines) {
        const record = parseAntigravityLine(line);
        if (!record) continue;
        for (const event of mapAntigravityRecordToEvents(record, { sessionKey, allocateId: this.allocateId })) {
          queue.push({ event, checkpoint });
        }
      }
    };

    const bootstrapCheckpoint: Checkpoint = initialCheckpoint ?? { kind: 'byte-offset', offset: 0, size: 0, inode: 0 };
    queue.push({
      event: createEventFromLogRecord(this.allocateId(), {
        kind: 'session_start',
        harness: 'antigravity',
        sessionKey,
        // The session's REAL last-activity time (design.md "Session discovery and aging out"),
        // never the moment open() happens to run — falls back to now() only for a fake/scripted
        // SessionRef that never set it.
        at: session.lastActivityAt ?? this.now(),
      }),
      checkpoint: bootstrapCheckpoint,
    });

    void readTailIncrement(filePath, initialCheckpoint, { bootstrapFromEof: !this.replayFromStart })
      .then((result) => {
        if (stopped) return initialCheckpoint;
        const checkpointAfterBootstrap = result.kind === 'no-op' ? initialCheckpoint : result.checkpoint;
        if (result.kind !== 'no-op') emitRecordEvents(result.lines, result.checkpoint);
        return checkpointAfterBootstrap;
      })
      .then((checkpointAfterBootstrap) => {
        if (stopped) return;
        watcher = watchAndTailFile(filePath, checkpointAfterBootstrap, (result) => {
          if (result.kind === 'no-op' || stopped) return;
          emitRecordEvents(result.lines, result.checkpoint);
        });
        this.fileWatchers.add(watcher);
      });

    return {
      events: queue,
      stop: (): void => {
        stopped = true;
        if (watcher) {
          this.fileWatchers.delete(watcher);
          void watcher.close();
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.discoveryWatcher) await this.discoveryWatcher.close();
    for (const watcher of this.fileWatchers) await watcher.close();
    this.fileWatchers.clear();
  }
}

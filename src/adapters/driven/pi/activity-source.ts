/**
 * `ActivitySource` implementation for Pi orchestrator transcripts (spec: "Pi Orchestrator Session
 * Discovery", "Pi Transcript Record Families").
 *
 * Mirrors `codex/activity-source.ts` and `claude-code/activity-source.ts` (design.md D1: "One
 * ActivitySource port, N implementations"), reusing the SAME `readTailIncrement`/`watchAndTailFile`
 * byte-offset tailer — Pi is JSONL like Claude Code, Codex and Antigravity, and that tailer is
 * generic JSONL-file mechanics with no Claude-specific assumptions.
 *
 * Scope: ORCHESTRATORS ONLY. Pi's subagents never appear under `<root>/sessions` — children are
 * spawned with `--session-dir <root>/gentle-agents/sessions` — so everything this source opens is a
 * root session by construction (design.md D3), and `PiPresenceSource` owns subagents separately.
 * That disjointness is what makes a duplicate worker structurally impossible here.
 *
 * `open()` always emits ONE synthetic `session_start` first, before any content-derived event, for
 * the same reason as every other adapter: without it, `applyEventToOfficeState` never creates a
 * worker for the session.
 *
 * Read-only: nothing under `root` is ever opened for writing (spec: "Pi Zero-Write Guarantee").
 */
import type { FSWatcher } from 'chokidar';
import { join } from 'node:path';
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
import { discoverPiSessions, watchPiSessions, type PiSessionRef } from './discover';
import { mapPiRecordToEvents, parsePiLine } from './parse';

export interface PiActivitySourceOptions {
  /** Injectable monotonic id allocator. Defaults to an in-process counter starting at 1. */
  allocateId?: () => number;
  /** Injectable clock, for deterministic active-window tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Bootstrap window (design.md: attach only to sessions touched within 24h). */
  activeWindowMs?: number;
  /**
   * Opt-in replay: when true, a session with NO prior checkpoint reads its entire transcript from
   * offset 0. Defaults to false — bootstraps at EOF instead, so process start never floods the
   * scene. An EXISTING checkpoint always resumes from where it left off regardless of this flag.
   */
  replayFromStart?: boolean;
  /**
   * Called for every discovered session, so the presence source can build its
   * `sha256(sessionId) -> sessionId` lookup (design.md D2). Optional: the transcript source is
   * fully functional without a subagent registry attached.
   */
  onSessionDiscovered?: (ref: PiSessionRef) => void;
}

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

export class PiActivitySource implements ActivitySource {
  readonly harness: HarnessId = 'pi';
  private readonly allocateId: () => number;
  private readonly now: () => number;
  private readonly activeWindowMs?: number;
  private readonly replayFromStart: boolean;
  private readonly onSessionDiscovered?: (ref: PiSessionRef) => void;
  private discoveryWatcher: FSWatcher | null = null;
  private readonly fileWatchers = new Set<FSWatcher>();
  private closed = false;

  constructor(
    private readonly root: string,
    options: PiActivitySourceOptions = {},
  ) {
    this.allocateId = options.allocateId ?? defaultAllocateId();
    this.now = options.now ?? Date.now;
    this.activeWindowMs = options.activeWindowMs;
    this.replayFromStart = options.replayFromStart ?? false;
    this.onSessionDiscovered = options.onSessionDiscovered;
  }

  /**
   * Always `ready`. A missing `<root>/sessions` is "Pi has never run", not a fault — the same
   * degradation `OpenCodeActivitySource` applies to an absent database (design.md D4).
   */
  async probe(): Promise<SourceHealth> {
    return { status: 'ready' };
  }

  async *discover(): AsyncIterable<SessionRef> {
    for (const ref of await discoverPiSessions(this.root, {
      now: this.now,
      activeWindowMs: this.activeWindowMs,
    })) {
      this.onSessionDiscovered?.(ref);
      yield ref;
    }
    if (this.closed) return;

    const queue = createAsyncQueue<PiSessionRef>();
    this.discoveryWatcher = watchPiSessions(join(this.root, 'sessions'), (ref) => queue.push(ref));
    for await (const ref of queue) {
      if (this.closed) return;
      this.onSessionDiscovered?.(ref);
      yield ref;
    }
  }

  open(session: SessionRef, from: Checkpoint | null): ActivityStream {
    const piSession = session as PiSessionRef;
    const filePath = piSession.filePath;
    const sessionKey = session.sessionKey;
    const initialCheckpoint: ByteOffsetCheckpoint | null = from && from.kind === 'byte-offset' ? from : null;
    const queue = createAsyncQueue<ActivityStreamItem>();
    let stopped = false;
    let watcher: FSWatcher | null = null;

    const emitRecordEvents = (lines: string[], checkpoint: Checkpoint): void => {
      for (const line of lines) {
        const record = parsePiLine(line);
        if (!record) continue;
        // Everything this source opens is an orchestrator (design.md D3) — never a guess.
        for (const event of mapPiRecordToEvents(record, {
          sessionKey,
          allocateId: this.allocateId,
          isSubagent: false,
        })) {
          queue.push({ event, checkpoint });
        }
      }
    };

    const bootstrapCheckpoint: Checkpoint = initialCheckpoint ?? { kind: 'byte-offset', offset: 0, size: 0, inode: 0 };
    queue.push({
      event: createEventFromLogRecord(this.allocateId(), {
        kind: 'session_start',
        harness: 'pi',
        sessionKey,
        // The session's REAL last-activity time, never the moment open() happens to run — falls
        // back to now() only for a fake/scripted SessionRef that never set it.
        at: session.lastActivityAt ?? this.now(),
        // `resolvePiSessionCwd` already read this from the transcript's own `session` record during
        // discovery; `null` means the record was absent, which must never render as a guessed
        // project (spec: "Missing session record leaves cwd absent").
        ...(piSession.cwd !== null ? { projectPath: piSession.cwd } : {}),
        agentProfile: { role: 'orchestrator' },
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

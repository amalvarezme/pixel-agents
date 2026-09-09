/**
 * `ActivitySource` implementation for Claude Code (browser-entrypoint work unit). Composes the
 * already-existing, already-tested building blocks — `discover.ts` (session discovery),
 * `tail.ts` (offset-based incremental reads), `parse.ts` (record -> `AgentEvent` mapping) — behind
 * the one port `application/ingest-agent-activity` and the composition root (`src/server.ts`)
 * depend on (design.md D1). This file re-implements none of their logic; it only bridges their
 * callback/one-shot shapes into the `AsyncIterable` contract `ActivitySource` requires, via
 * `shared/async-queue.ts`.
 *
 * `open()` always emits ONE synthetic `session_start` event first, before any content-derived
 * event. Nothing in `parse.ts` synthesizes that kind (a JSONL line never says "a session began" —
 * that fact is knowable only at the moment this adapter starts tailing a session), and without it
 * `domain/office/office.ts`'s `applyEventToOfficeState` never creates a worker for the session at
 * all (its content-derived branches only update an ALREADY-registered worker) — so real sessions
 * would silently never render.
 *
 * Read-only, matching every sibling module in this adapter: this file never opens anything under
 * `root` for writing, only for reading (`discoverClaudeCodeSessions`) and watching
 * (`watchClaudeCodeSessions`, `watchAndTailFile`).
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
import { discoverClaudeCodeSessions, watchClaudeCodeSessions, type ClaudeCodeSessionRef } from './discover';
import { readTailIncrement, watchAndTailFile } from './tail';
import { mapClaudeCodeRecordToEvents, parseClaudeCodeLine, type ClaudeCodeRecord } from './parse';

export interface ClaudeCodeActivitySourceOptions {
  /** Injectable monotonic id allocator. Defaults to an in-process counter starting at 1. */
  allocateId?: () => number;
  /**
   * Reports every parsed record from a PARENT (non-subagent) session's own transcript, so the
   * composition root can feed the `toolUseResult.agentId` correlation edge (`correlate.ts`'s
   * `correlateFromParentRecord`, spec: "the system MUST correlate parent and child sessions using
   * toolUseResult.agentId"). Never invoked for a subagent transcript itself — that file's records
   * are its own tool activity, not a launch record naming a further child. A throwing callback
   * never breaks the tail loop (design.md "A correlation ... failure degrades that concern only"),
   * matching the try/catch precedent already applied to `onSessionDiscovered`.
   */
  onParentRecord?: (parentSessionKey: string, record: ClaudeCodeRecord) => void;
}

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

export class ClaudeCodeActivitySource implements ActivitySource {
  readonly harness: HarnessId = 'claude-code';
  private readonly allocateId: () => number;
  private discoveryWatcher: FSWatcher | null = null;
  private readonly fileWatchers = new Set<FSWatcher>();
  private closed = false;

  private readonly onParentRecord?: (parentSessionKey: string, record: ClaudeCodeRecord) => void;

  constructor(
    private readonly root: string,
    options: ClaudeCodeActivitySourceOptions = {},
  ) {
    this.allocateId = options.allocateId ?? defaultAllocateId();
    this.onParentRecord = options.onParentRecord;
  }

  async probe(): Promise<SourceHealth> {
    return { status: 'ready' };
  }

  async *discover(): AsyncIterable<SessionRef> {
    for (const ref of await discoverClaudeCodeSessions(this.root)) {
      yield ref;
    }
    if (this.closed) return;

    const queue = createAsyncQueue<ClaudeCodeSessionRef>();
    this.discoveryWatcher = watchClaudeCodeSessions(this.root, (ref) => queue.push(ref));
    for await (const ref of queue) {
      if (this.closed) return;
      yield ref;
    }
  }

  open(session: SessionRef, from: Checkpoint | null): ActivityStream {
    const claudeCodeSession = session as ClaudeCodeSessionRef;
    const filePath = claudeCodeSession.filePath;
    const sessionKey = session.sessionKey;
    const isSubagent = claudeCodeSession.isSubagent;
    const initialCheckpoint: ByteOffsetCheckpoint | null = from && from.kind === 'byte-offset' ? from : null;
    const queue = createAsyncQueue<ActivityStreamItem>();
    let stopped = false;
    let watcher: FSWatcher | null = null;

    const emitRecordEvents = (lines: string[], checkpoint: Checkpoint): void => {
      for (const line of lines) {
        const record = parseClaudeCodeLine(line);
        if (!record) continue;
        if (!isSubagent && this.onParentRecord) {
          try {
            this.onParentRecord(sessionKey, record);
          } catch {
            // A correlation failure degrades that concern only — it must never break the tail.
          }
        }
        for (const event of mapClaudeCodeRecordToEvents(record, { sessionKey, allocateId: this.allocateId })) {
          queue.push({ event, checkpoint });
        }
      }
    };

    // Emit the synthetic `session_start` first, synchronously, before any (necessarily
    // asynchronous) file read — so the very first item this stream ever yields always makes the
    // worker appear, regardless of how the bootstrap read below resolves.
    const bootstrapCheckpoint: Checkpoint = initialCheckpoint ?? { kind: 'byte-offset', offset: 0, size: 0, inode: 0 };
    queue.push({
      event: createEventFromLogRecord(this.allocateId(), {
        kind: 'session_start',
        harness: 'claude-code',
        sessionKey,
        at: Date.now(),
      }),
      checkpoint: bootstrapCheckpoint,
    });

    // Bootstrap read: catch up on any content already present since `initialCheckpoint`. Only
    // AFTER this resolves does the live watcher start, from the bootstrap read's resulting
    // checkpoint — never from `initialCheckpoint` again — so the two never race and double-read
    // the same bytes.
    void readTailIncrement(filePath, initialCheckpoint)
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

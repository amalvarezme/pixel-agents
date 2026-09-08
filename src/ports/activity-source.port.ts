/**
 * Activity source port (design.md D1: "One ActivitySource port, four implementations,
 * adapter-private checkpoints"). Each harness (Claude Code, Codex, OpenCode, Antigravity)
 * implements this port once; `domain/` and `application/` never know which harness they
 * are talking to.
 *
 * `Checkpoint` is opaque JSON the application only stores and hands back to the adapter that
 * produced it: `{kind:'byte-offset', ...}` for JSONL tailers, `{kind:'seq', ...}` for OpenCode's
 * seq-ordered event table.
 */
import type { AgentEvent, HarnessId } from '../domain/events/types';

export interface SessionRef {
  harness: HarnessId;
  sessionKey: string;
  discoveredAt: number;
}

/** JSONL tailer checkpoint: byte offset plus the inode/size pair that detects rotation. */
export interface ByteOffsetCheckpoint {
  kind: 'byte-offset';
  offset: number;
  size: number;
  inode: number;
}

/** OpenCode poller checkpoint: last published `seq` per aggregate (session) id. */
export interface SeqCheckpoint {
  kind: 'seq';
  bySession: Record<string, number>;
  /**
   * Last published `part.time_updated` per session. Separate from `bySession` because the two
   * advance on different currencies: `seq` decides WHEN to wake, `part.time_updated` decides WHICH
   * rows become events (`event.data`'s shape was never confirmed by research, so parts are read
   * from the `part` table directly). Without persisting this, a resumed session re-selects
   * `time_updated > 0` and republishes its entire history. Optional so checkpoints written before
   * this field load unchanged.
   */
  partsBySession?: Record<string, number>;
}

export type Checkpoint = ByteOffsetCheckpoint | SeqCheckpoint;

/**
 * `probe()` MUST NOT throw. A harness that is unreachable, mis-configured, or schema-drifted
 * reports `disabled` with a reason rather than crashing the process (design.md D4, harness-log-
 * ingestion spec: "OpenCode Schema-Drift Degradation").
 */
export type SourceHealth = { status: 'ready' } | { status: 'disabled'; reason: string; detail?: string };

export interface ActivityStreamItem {
  event: AgentEvent;
  checkpoint: Checkpoint;
}

export interface ActivityStream {
  events: AsyncIterable<ActivityStreamItem>;
  stop(): void;
}

export interface ActivitySource {
  readonly harness: HarnessId;
  probe(): Promise<SourceHealth>;
  discover(): AsyncIterable<SessionRef>;
  open(session: SessionRef, from: Checkpoint | null): ActivityStream;
  close(): Promise<void>;
}

/** Signal produced by a per-adapter `MemoryWriteDetector`; drives the `MemoryWriteEvent` fields. */
export interface MemoryWriteSignal {
  title?: string;
  topicKey?: string;
  observationType?: string;
  toolLabel: string;
  toolDetail?: string;
}

/**
 * `TRecord` is the adapter's OWN record type (spec: memory-write-visualization, "Detector
 * Interface Isolation") — there is deliberately no shared normalized record shape across the
 * four harnesses, since their MCP tool-call encodings share no structure.
 */
export interface MemoryWriteDetector<TRecord> {
  readonly harness: HarnessId;
  detect(record: TRecord): MemoryWriteSignal | null;
}

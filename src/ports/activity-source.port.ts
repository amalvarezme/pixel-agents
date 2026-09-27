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
  /**
   * The working directory this session was launched in, when the harness's own log records or
   * schema report it; `null` when the harness's transcript carries no cwd signal at all
   * (Antigravity — design.md "Launch <-> log correlation"). Feeds the launch<->log correlator's
   * `CandidateSession.cwd` (`adapters/driven/launcher/launch-correlator.ts`); never guessed or
   * derived by approximation when the real signal is unavailable.
   */
  cwd: string | null;
  discoveredAt: number;
  /**
   * The session's real last-activity time (a JSONL adapter's file `mtimeMs`; OpenCode's
   * `session.time_updated`) — DISTINCT from `discoveredAt`, which is only "when this scan ran".
   * Session aging (design.md "Session discovery and aging out") must age from this real signal,
   * never from ingestion time, so a transcript last written hours ago is not treated as brand new
   * just because the server happened to notice it late. Optional so a fake/scripted `SessionRef`
   * (tests, `FakeActivitySource`) that never set it keeps working — callers fall back to their own
   * clock when it is absent.
   */
  lastActivityAt?: number;
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

/**
 * Pi presence-registry checkpoint. The registry is a SNAPSHOT store, not an append-only log: Pi
 * rewrites `activity.json` atomically on every change, bumping a monotonic `generation`. There is
 * no offset and no sequence to resume from, so the checkpoint records what was last PUBLISHED.
 *
 * Two currencies, for the same reason `SeqCheckpoint` carries two: `byActivation` decides WHEN a
 * registry file has content we have not seen, while `threadByTask` decides WHICH tasks inside it
 * actually changed. Without the second, one task's progress would republish every sibling task's
 * whole thread on the same tick.
 */
export interface GenerationCheckpoint {
  kind: 'generation';
  /** Last published activity `generation`, keyed by `<sessionHash>.<incarnation>`. */
  byActivation: Record<string, number>;
  /** Last published thread `version`, keyed by `<sessionHash>.<incarnation>.<taskId>`. */
  threadByTask?: Record<string, number>;
  /** Last published task `status`, keyed the same way, so a `status` event fires only on a change. */
  statusByTask?: Record<string, string>;
}

export type Checkpoint = ByteOffsetCheckpoint | SeqCheckpoint | GenerationCheckpoint;

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

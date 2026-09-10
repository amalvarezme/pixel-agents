/**
 * Office aggregate. Slice 1a shipped types only (workers, archive slots, carry-queue shapes).
 * Slice 1b (this file) adds the STRUCTURAL projection needed by the office-scene-renderer spec:
 * worker join/leave on `session_start`/`session_end`, and parent/child correlation from `parent`
 * events (office-scene-renderer spec: "Per-Agent Worker Mapping", "Parent/Child Lane Layout").
 *
 * Archive/animation BEHAVIOR (worker movement, carry-queue collapse, docking) is still out of
 * scope — that lands in slice 4 (design.md: "Slicing"). `applyEventToOfficeState` never inspects
 * `memory_write` for that reason.
 *
 * This function is pure and framework-free so it can be reused verbatim by both the SSE server
 * (to build a resume `snapshot` frame, tasks.md 9.2) and the browser-side `OfficeContainer`
 * client projection (tasks.md 10.4) — one canonical fold over the normalized event stream.
 */
import type { AgentEvent, HarnessId } from '../events/types';
import { DEFAULT_ORPHAN_GRACE_MS } from '../agents/agent-tree';
import {
  completeHeldCarryJob,
  createCarryQueueState,
  enqueueCarryJob,
  type CarryQueueState,
} from './carry-queue';
import { createArchiveDockState, releaseArchiveDock, requestArchiveDock, type ArchiveDockState } from './archive-dock';

export type { CarryJob, CarryQueueState } from './carry-queue';
export type { ArchiveSlot, ArchiveDockState, ArchiveWaitEntry } from './archive-dock';
export { ARCHIVE_SLOT_COUNT } from './archive-dock';

export type WorkerActivity = 'working' | 'idle';

export interface Worker {
  sessionKey: string;
  harness: HarnessId;
  label: string;
  activity: WorkerActivity;
  /**
   * Stable harness-agnostic correlation field, sourced only from a `parent` event's
   * `correlationId` (normalized-event-model spec: "Parent/Child Correlation Field Contract").
   * `null` means this worker is a root — either genuinely unparented, or no `parent` event has
   * arrived yet.
   */
  parentSessionKey: string | null;
  /** Normalized tool_start caption pair (design.md "Captions"), resolved upstream per-harness. */
  toolLabel?: string;
  toolDetail?: string;
}

/**
 * A `parent` edge claimed before the child's own `session_start` was discovered (design.md /
 * agent-tree.ts: the real live-stream ordering has the edge arrive FIRST). Held here — never
 * upserted as a worker — until either `session_start` resolves it or `orphanGraceMs` elapses
 * with no `session_start` ever showing up (mirrors `agent-tree.ts`'s `pending`/`promoteOrphans`).
 */
interface PendingParentEdge {
  correlationId: string;
  claimedAt: number;
}

export interface OfficeState {
  workers: Map<string, Worker>;
  /** The 4 physical archive docking slots plus their wait line (`archive-dock.ts`). */
  archive: ArchiveDockState;
  /** Per-worker FIFO carry queue plus batch collapse (`carry-queue.ts`). */
  carryQueues: Map<string, CarryQueueState>;
  /** Unmatched `parent` edges awaiting their child's `session_start` — never rendered as workers. */
  pendingParentEdges: Map<string, PendingParentEdge>;
}

export function createOfficeState(archiveSlotCount?: number): OfficeState {
  return {
    workers: new Map(),
    archive: createArchiveDockState(archiveSlotCount),
    carryQueues: new Map(),
    pendingParentEdges: new Map(),
  };
}

/**
 * JSON-safe wire shape for `OfficeState` (G.1: the `snapshot` frame must let a late-connecting or
 * evicted client reconstruct FULL state, not just workers — design.md/tasks.md 9.2). `workers` is
 * already an array; `archive` is already plain objects/arrays; `carryQueues` is the only `Map`
 * field, so it is the only one that needs an explicit entries shape — `JSON.stringify(aMap)`
 * silently produces `{}`, which is exactly how G.1 happened.
 */
export interface OfficeSnapshotState {
  workers: Worker[];
  archive: ArchiveDockState;
  carryQueues: Array<{ sessionKey: string; queue: CarryQueueState }>;
}

/** Pure conversion, reused verbatim by both the SSE server (building a resume snapshot) and the
 * browser `OfficeContainer` (consuming one) — see the module comment above for the shared-fold
 * rationale that already applies to `applyEventToOfficeState`. */
export function serializeOfficeState(state: OfficeState): OfficeSnapshotState {
  return {
    workers: [...state.workers.values()],
    archive: state.archive,
    carryQueues: [...state.carryQueues.entries()].map(([sessionKey, queue]) => ({ sessionKey, queue })),
  };
}

/**
 * Inverse of `serializeOfficeState`. `archive`/`carryQueues` are optional on the input so a
 * snapshot missing them (an older wire payload, or a bare `{ workers }` literal in a test)
 * degrades to an empty archive/carry state instead of throwing.
 */
export function deserializeOfficeState(snapshot: {
  workers: Worker[];
  archive?: ArchiveDockState;
  carryQueues?: Array<{ sessionKey: string; queue: CarryQueueState }>;
}): OfficeState {
  return {
    workers: new Map(snapshot.workers.map((w) => [w.sessionKey, w])),
    archive: snapshot.archive ?? createArchiveDockState(),
    carryQueues: new Map((snapshot.carryQueues ?? []).map(({ sessionKey, queue }) => [sessionKey, queue])),
    // Deliberately not part of the wire shape: a still-pending edge is ephemeral ingestion
    // bookkeeping, never state a resuming client needs to reconstruct. If the child's
    // session_start eventually arrives, it lands as a normal live event on the same hub-owned
    // `OfficeState` (never round-tripped through (de)serialize), so nothing is lost in practice.
    pendingParentEdges: new Map(),
  };
}

function upsertWorker(
  state: OfficeState,
  sessionKey: string,
  patch: Partial<Omit<Worker, 'sessionKey'>> & Pick<Worker, 'harness'>,
): OfficeState {
  const workers = new Map(state.workers);
  const existing = workers.get(sessionKey);
  workers.set(sessionKey, {
    sessionKey,
    harness: patch.harness,
    label: patch.label ?? existing?.label ?? sessionKey,
    activity: patch.activity ?? existing?.activity ?? 'working',
    parentSessionKey: patch.parentSessionKey !== undefined ? patch.parentSessionKey : (existing?.parentSessionKey ?? null),
    toolLabel: patch.toolLabel ?? existing?.toolLabel,
    toolDetail: patch.toolDetail ?? existing?.toolDetail,
  });
  return { ...state, workers };
}

/** Drops any pending edge whose child never showed up within `orphanGraceMs` (agent-tree.ts's `promoteOrphans` sibling). */
function pruneExpiredPendingParentEdges(
  state: OfficeState,
  now: number,
  orphanGraceMs: number,
): OfficeState {
  if (state.pendingParentEdges.size === 0) return state;
  const pendingParentEdges = new Map(state.pendingParentEdges);
  for (const [sessionKey, edge] of pendingParentEdges) {
    if (now - edge.claimedAt >= orphanGraceMs) pendingParentEdges.delete(sessionKey);
  }
  return { ...state, pendingParentEdges };
}

/**
 * Folds one normalized `AgentEvent` into `OfficeState`. Never drops the CORRELATION carried by a
 * `parent` event, but a correlation edge alone must never conjure a worker for a session that was
 * never actually discovered (a subagent whose own transcript sits outside the ingestion window,
 * for example): only `session_start` — a real discovery — creates a worker. When `parent` arrives
 * first (the real live-stream ordering — subagent-correlation-coordinator.ts emits the edge from
 * the PARENT's transcript before the child's own transcript is even opened), the edge is held in
 * `pendingParentEdges` and applied the instant the matching `session_start` shows up, exactly
 * like `agent-tree.ts`'s `pending`/`promoteOrphans` pair for the same ordering problem.
 */
export function applyEventToOfficeState(state: OfficeState, event: AgentEvent): OfficeState {
  const pruned = pruneExpiredPendingParentEdges(state, event.at, DEFAULT_ORPHAN_GRACE_MS);

  switch (event.kind) {
    case 'session_start': {
      const pendingEdge = pruned.pendingParentEdges.get(event.sessionKey);
      const worker = upsertWorker(pruned, event.sessionKey, {
        harness: event.harness,
        label: event.label,
        activity: 'working',
        ...(pendingEdge ? { parentSessionKey: pendingEdge.correlationId } : {}),
      });
      if (!pendingEdge) return worker;
      const pendingParentEdges = new Map(worker.pendingParentEdges);
      pendingParentEdges.delete(event.sessionKey);
      return { ...worker, pendingParentEdges };
    }

    case 'session_end': {
      const workers = new Map(pruned.workers);
      workers.delete(event.sessionKey);
      return { ...pruned, workers };
    }

    case 'parent': {
      if (pruned.workers.has(event.sessionKey)) {
        return upsertWorker(pruned, event.sessionKey, {
          harness: event.harness,
          label: event.label,
          parentSessionKey: event.correlationId ?? null,
        });
      }
      // The child was never discovered (yet, or ever) — record the edge, but do NOT create a
      // worker for it. Nothing to hold without a correlationId to apply later.
      if (!event.correlationId) return pruned;
      const pendingParentEdges = new Map(pruned.pendingParentEdges);
      pendingParentEdges.set(event.sessionKey, { correlationId: event.correlationId, claimedAt: event.at });
      return { ...pruned, pendingParentEdges };
    }

    case 'memory_write':
      return applyMemoryWriteToOfficeState(pruned, event.sessionKey, event.at);

    default:
      if (!event.label && !event.toolLabel) return pruned;
      if (!pruned.workers.has(event.sessionKey)) return pruned;
      return upsertWorker(pruned, event.sessionKey, {
        harness: event.harness,
        label: event.label,
        toolLabel: event.toolLabel,
        toolDetail: event.toolDetail,
      });
  }
}

/**
 * memory_write drives the carry queue AND, only on the FIRST held document for this worker (it
 * was idle immediately before this event), requests an archive dock (design.md: "the archive has
 * 4 docking slots assigned round-robin"). A `memory_write` for a session with no known worker is
 * a no-op — the animation has nothing to animate (spec: "whose worker is currently at its default
 * position" assumes an existing worker). Purely synchronous: this is the whole "ingestion never
 * blocks" guarantee — it never depends on `completeArchiveTripForWorker` (the animation-
 * completion side, driven by the UI's own clock) being called.
 */
function applyMemoryWriteToOfficeState(state: OfficeState, sessionKey: string, now: number): OfficeState {
  if (!state.workers.has(sessionKey)) return state;

  const existingQueue = state.carryQueues.get(sessionKey) ?? createCarryQueueState();
  const wasIdle = existingQueue.held === null;
  const nextQueue = enqueueCarryJob(existingQueue, sessionKey, now);

  const carryQueues = new Map(state.carryQueues);
  carryQueues.set(sessionKey, nextQueue);

  const archive = wasIdle ? requestArchiveDock(state.archive, sessionKey, now) : state.archive;

  return { ...state, carryQueues, archive };
}

/**
 * Called by the UI once the archive-trip ANIMATION finishes (not from event ingestion): advances
 * the worker's carry queue and, only once nothing is left to carry, releases its archive dock so
 * the next waiting worker (if any) can be promoted into that exact slot.
 */
export function completeArchiveTripForWorker(state: OfficeState, sessionKey: string, now: number): OfficeState {
  const queue = state.carryQueues.get(sessionKey);
  if (!queue || queue.held === null) return state;

  const nextQueue = completeHeldCarryJob(queue);
  const carryQueues = new Map(state.carryQueues);
  carryQueues.set(sessionKey, nextQueue);

  const archive = nextQueue.held === null ? releaseArchiveDock(state.archive, sessionKey) : state.archive;

  return { ...state, carryQueues, archive };
}

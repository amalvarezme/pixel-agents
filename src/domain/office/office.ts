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
}

export interface ArchiveSlot {
  slotIndex: number;
  occupiedBySessionKey: string | null;
}

export interface CarryJob {
  sessionKey: string;
  queuedAt: number;
}

export interface OfficeState {
  workers: Map<string, Worker>;
  archiveSlots: ArchiveSlot[];
  /** Per-worker FIFO carry queue; slice 4 owns collapsing this beyond `maxQueued`. */
  carryQueues: Map<string, CarryJob[]>;
}

export const ARCHIVE_SLOT_COUNT = 4;

export function createOfficeState(archiveSlotCount = ARCHIVE_SLOT_COUNT): OfficeState {
  return {
    workers: new Map(),
    archiveSlots: Array.from({ length: archiveSlotCount }, (_, slotIndex) => ({
      slotIndex,
      occupiedBySessionKey: null,
    })),
    carryQueues: new Map(),
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
  });
  return { ...state, workers };
}

/**
 * Folds one normalized `AgentEvent` into `OfficeState`. Never throws and never drops an event:
 * an event referencing a session with no prior `session_start` (e.g. a `parent` event arriving
 * first) still creates a worker, matching the domain-wide "no event ever dropped" invariant
 * already established by `agent-tree.ts`.
 */
export function applyEventToOfficeState(state: OfficeState, event: AgentEvent): OfficeState {
  switch (event.kind) {
    case 'session_start':
      return upsertWorker(state, event.sessionKey, {
        harness: event.harness,
        label: event.label,
        activity: 'working',
      });

    case 'session_end': {
      const workers = new Map(state.workers);
      workers.delete(event.sessionKey);
      return { ...state, workers };
    }

    case 'parent':
      return upsertWorker(state, event.sessionKey, {
        harness: event.harness,
        label: event.label,
        parentSessionKey: event.correlationId ?? null,
      });

    default:
      if (!event.label) return state;
      if (!state.workers.has(event.sessionKey)) return state;
      return upsertWorker(state, event.sessionKey, { harness: event.harness, label: event.label });
  }
}

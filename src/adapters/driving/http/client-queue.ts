/**
 * Bounded per-client SSE delivery queue (tasks.md 9.3, design.md D2: "Backpressure").
 *
 * A slow client can fall behind the publish rate. Rather than growing memory unboundedly or
 * dropping events indiscriminately, this module encodes the exact pressure-relief order the
 * design mandates:
 *
 * 1. Coalesce `stats`/`status` events, keeping only the latest per session — these are always
 *    superseded by their own successor, so the older copy carries no information loss.
 * 2. If still over the limit, drop the OLDEST transient events (`message`, `tool_start`) first —
 *    losing one of these degrades detail, not correctness.
 * 3. State-defining events (`session_start`, `session_end`, `parent`, `memory_write`,
 *    `launch_requested`, `launch_started`) are NEVER dropped. If they alone would overflow the
 *    queue, the client is marked `desynced`: the caller must stop trying to catch it up
 *    incrementally and instead push a `snapshot_required` signal (a full resync, not a partial,
 *    corrupted one).
 *
 * Pure and immutable, like `ring-buffer.ts`: no I/O, no socket, trivially testable.
 */
import type { AgentEvent, EventKind } from '../../../domain/events/types';

export const CLIENT_QUEUE_LIMIT = 1000;

const TRANSIENT_KINDS: readonly EventKind[] = ['message', 'tool_start'];
const COALESCIBLE_KINDS: readonly EventKind[] = ['stats', 'status'];

function isTransient(event: AgentEvent): boolean {
  return TRANSIENT_KINDS.includes(event.kind);
}

function isCoalescible(event: AgentEvent): boolean {
  return COALESCIBLE_KINDS.includes(event.kind);
}

export interface ClientQueueState {
  readonly queue: readonly AgentEvent[];
  readonly desynced: boolean;
}

export function createClientQueueState(): ClientQueueState {
  return { queue: [], desynced: false };
}

/** Drops every coalescible event except the latest one for its `(kind, sessionKey)` pair. */
function coalesce(queue: readonly AgentEvent[]): AgentEvent[] {
  const latestBySlot = new Map<string, number>(); // slot key -> index of the latest occurrence
  queue.forEach((event, index) => {
    if (!isCoalescible(event)) return;
    latestBySlot.set(`${event.kind}:${event.sessionKey}`, index);
  });
  return queue.filter((event, index) => {
    if (!isCoalescible(event)) return true;
    return latestBySlot.get(`${event.kind}:${event.sessionKey}`) === index;
  });
}

/** Drops the oldest transient events, one at a time, until the queue fits or none remain. */
function dropOldestTransient(queue: AgentEvent[], limit: number): AgentEvent[] {
  const result = [...queue];
  while (result.length > limit) {
    const oldestTransientIndex = result.findIndex(isTransient);
    if (oldestTransientIndex === -1) break;
    result.splice(oldestTransientIndex, 1);
  }
  return result;
}

export function enqueueForClient(state: ClientQueueState, event: AgentEvent): ClientQueueState {
  // Already desynced: the caller owes this client a `snapshot_required` signal before anything
  // else is accepted. See `acknowledgeDesync`.
  if (state.desynced) return state;

  let queue = [...state.queue, event];

  if (queue.length > CLIENT_QUEUE_LIMIT) {
    queue = coalesce(queue);
  }
  if (queue.length > CLIENT_QUEUE_LIMIT) {
    queue = dropOldestTransient(queue, CLIENT_QUEUE_LIMIT);
  }
  if (queue.length > CLIENT_QUEUE_LIMIT) {
    // Only state-defining events remain and they alone overflow the limit: never drop one of
    // these. The client is desynced; the caller replaces this backlog with one
    // `snapshot_required` signal instead of delivering a partial, silently-corrupted history.
    return { queue: [], desynced: true };
  }

  return { queue, desynced: false };
}

/** Consumed by the delivery layer right after it sends a `snapshot_required` frame. */
export function acknowledgeDesync(_state: ClientQueueState): ClientQueueState {
  return createClientQueueState();
}

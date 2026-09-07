/**
 * Per-worker carry queue (design.md "Decision: animation is a lagging view, ingestion never
 * blocks"): at most ONE document `held` (actively being carried to the archive) at a time.
 * Additional `memory_write` events for the same worker queue up FIFO behind it; once the
 * pending queue would reach `maxQueued` (5), the ENTIRE pending backlog collapses into one
 * `batch` carry with a `×N` badge, so the worker never displays more than one held item and one
 * batch badge regardless of how many documents actually queued.
 *
 * Pure and framework-free: `now` is an explicit parameter (fake-clock by construction), matching
 * every other domain module's time contract (see agent-tree.ts, session-lifecycle.ts).
 */

export const DEFAULT_MAX_QUEUED_CARRIES = 5;

export interface CarryJob {
  sessionKey: string;
  queuedAt: number;
  /** 1 for a normal single carry; >1 only once a collapsed batch is promoted to `held`. */
  count: number;
}

export interface BatchCarryJob {
  count: number;
  queuedAt: number;
}

export interface CarryQueueState {
  held: CarryJob | null;
  queued: CarryJob[];
  batch: BatchCarryJob | null;
}

export function createCarryQueueState(): CarryQueueState {
  return { held: null, queued: [], batch: null };
}

/**
 * Enqueues one `memory_write` carry for `sessionKey`. Starts carrying immediately if nothing is
 * currently held; otherwise queues FIFO, collapsing into `batch` once the queue would reach
 * `maxQueued` (design.md: "Beyond maxQueued (5), the remainder collapses into one batch carry").
 */
export function enqueueCarryJob(
  state: CarryQueueState,
  sessionKey: string,
  now: number,
  maxQueued = DEFAULT_MAX_QUEUED_CARRIES,
): CarryQueueState {
  if (state.held === null) {
    return { ...state, held: { sessionKey, queuedAt: now, count: 1 } };
  }
  if (state.batch !== null) {
    return { ...state, batch: { count: state.batch.count + 1, queuedAt: state.batch.queuedAt } };
  }
  if (state.queued.length + 1 >= maxQueued) {
    return { ...state, queued: [], batch: { count: state.queued.length + 1, queuedAt: now } };
  }
  return { ...state, queued: [...state.queued, { sessionKey, queuedAt: now, count: 1 }] };
}

/**
 * Advances the queue once the currently `held` carry's archive trip finishes: a pending `batch`
 * is promoted whole (as one `×N` trip); otherwise the next FIFO `queued` job is promoted;
 * otherwise the worker has nothing left to carry.
 */
export function completeHeldCarryJob(state: CarryQueueState): CarryQueueState {
  if (state.held === null) return state;
  if (state.batch !== null) {
    return {
      held: { sessionKey: state.held.sessionKey, queuedAt: state.batch.queuedAt, count: state.batch.count },
      queued: [],
      batch: null,
    };
  }
  const [next, ...rest] = state.queued;
  return { held: next ?? null, queued: rest, batch: null };
}

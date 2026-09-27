/**
 * Ended-worker dwell: a worker that ends in a FAILURE state keeps being drawn, carrying its
 * failure indicator, for a short bounded dwell before it disappears. The RENDER half of the spec
 * scenario "A failed subagent ends visibly, not silently" (`openspec/changes/pi-harness-portability`,
 * `office-scene-renderer`) — the same two-half split `sofa-visit.ts` and `trip-animation.ts` follow.
 *
 * WHY this cannot live in `domain/office/office.ts`
 * ------------------------------------------------------------------------------------------------
 * The domain fold is event-driven and clock-less: `applyEventToOfficeState` deletes a worker on
 * `session_end` and never renders anything in between. And a real failure arrives as ONE diff from
 * the Pi presence source — `status(lifecycle:'failed')` followed immediately by `session_end` — so
 * `OfficeContainer.handleMessage` folds BOTH before the browser paints a single frame. The failure
 * indicator the pixi renderer already draws correctly is therefore never actually visible.
 * Making it visible is a piece of playback: it compares the render clock (`OfficeContainer.tick`'s
 * `now`, wall-clock ms, the same domain as `AgentEvent.at`) against the instant the worker left the
 * floor. Only `OfficeContainer` has that clock.
 *
 * Pure and canvas-free, exactly like `sofa-visit.ts`: `now` is always an explicit parameter and this
 * module never reads `Date.now()`.
 */
import { resolveLifecyclePresentation } from '../character/lifecycle-presentation';
import type { WorkerViewModel } from '../../state/office-view-model';

/** How long a failed worker stays on the floor after its `session_end`. Long enough to register as
 * a flag rather than a flicker, far shorter than any poll cadence would make it look like the
 * worker is still alive. */
export const ENDED_WORKER_DWELL_MS = 1_500;

export interface EndedWorkerDwell {
  sessionKey: string;
  /** When the worker left the floor, in the same clock as `now`. */
  startedAt: number;
  /**
   * The worker's last rendered view model at removal time, with every render-half overlay marker
   * stripped by `noteEndedWorker` — see `structuralFrame`. The domain has already forgotten the
   * worker by the time this dwell renders, so the container must hand this module the last known
   * frame instead of it trying to rebuild one.
   */
  worker: WorkerViewModel;
}

export interface EndedWorkerDwellState {
  active: Map<string, EndedWorkerDwell>;
}

export function createEndedWorkerDwellState(): EndedWorkerDwellState {
  return { active: new Map() };
}

/**
 * The captured frame with every RENDER-HALF overlay marker removed.
 *
 * The ghost exists for exactly one claim — "this agent FAILED" — and the whole point of the
 * structural/overlay split in `office-view-model.ts` is that the markers say something else:
 * `archiveTrip` says the worker is mid-carry to the archive, `sofaVisit` says it is walking to or
 * sitting at the sofa. Both are claims about what a LIVE worker is doing, and drawing either on a
 * worker that has already ended contradicts the flag beside it. A worker that has ended carries
 * nothing. `endedDwell` is dropped here too, so the emit path re-adds exactly one copy.
 *
 * `lifecycle` is deliberately NOT touched: it is the failure indicator's own input.
 */
function structuralFrame(worker: WorkerViewModel): WorkerViewModel {
  const {
    archiveTrip: _archiveTrip,
    sofaVisit: _sofaVisit,
    endedDwell: _endedDwell,
    ...structural
  } = worker;
  return structural;
}

/** Whether `dwell` is still inside `ENDED_WORKER_DWELL_MS` as of `now`. Strictly-less, so a dwell
 * that has reached its duration is already gone. */
function isDwelling(dwell: EndedWorkerDwell, now: number): boolean {
  return now - dwell.startedAt < ENDED_WORKER_DWELL_MS;
}

/**
 * Records a dwell for `worker` if — and only if — its last known lifecycle maps to the existing
 * failure presentation. `resolveLifecyclePresentation` is the single source of truth for that
 * mapping (`failed` and `timed_out`); re-deriving it here would let the two drift.
 *
 * `worker` is `undefined` when the end names a session the container never had a frame for, or that
 * had already left for another reason; nothing is recorded then.
 *
 * An ordinary end — `cancelled`, `completed`, or a worker that never reported any lifecycle at all,
 * which is exactly the shape of `SessionLifecycleCoordinator`'s synthetic
 * `session_end(reason:'timeout')` eviction — returns the state UNCHANGED, so the worker vanishes
 * immediately, exactly as it did before this feature existed.
 */
export function noteEndedWorker(
  state: EndedWorkerDwellState,
  worker: WorkerViewModel | undefined,
  now: number,
): EndedWorkerDwellState {
  if (!worker) return state;
  if (resolveLifecyclePresentation(worker.lifecycle).indicator !== 'failed') return state;

  const active = new Map(state.active);
  active.set(worker.sessionKey, {
    sessionKey: worker.sessionKey,
    startedAt: now,
    // Stripped on the way IN, not only on the way out: nothing transient is ever stored, so no
    // later render can resurrect it.
    worker: structuralFrame(worker),
  });
  return { active };
}

/**
 * Forgets any dwell for `sessionKey` — rule 4: a session re-admitted under the same key
 * (`SessionLifecycleCoordinator` revives an evicted session when it speaks again) must never be
 * shadowed by a ghost of its former incarnation.
 */
export function clearEndedWorkerDwell(state: EndedWorkerDwellState, sessionKey: string): EndedWorkerDwellState {
  if (!state.active.has(sessionKey)) return state;
  const active = new Map(state.active);
  active.delete(sessionKey);
  return { active };
}

/** One tick: forget every dwell that has reached its duration, so the container does not grow one
 * entry per failed worker for the life of the process. */
export function advanceEndedWorkerDwells(state: EndedWorkerDwellState, now: number): EndedWorkerDwellState {
  const active = new Map<string, EndedWorkerDwell>();
  for (const [sessionKey, dwell] of state.active) {
    if (isDwelling(dwell, now)) active.set(sessionKey, dwell);
  }
  return { active };
}

/**
 * Appends every still-dwelling worker — in its captured structural shape, marked with
 * `endedDwell: true` — to the rendered worker list. A worker already present in that list is never
 * appended a second time, so this overlay can never double-draw a key that a snapshot or a
 * re-admission put back on the floor.
 *
 * Applies `structuralFrame` again on the way out, so the no-transient-overlay guarantee holds even
 * for a state built by hand rather than through `noteEndedWorker`.
 */
export function applyEndedWorkerDwellOverlay(
  workers: readonly WorkerViewModel[],
  state: EndedWorkerDwellState,
  now: number,
): WorkerViewModel[] {
  if (state.active.size === 0) return [...workers];

  const present = new Set(workers.map((worker) => worker.sessionKey));
  const dwelling: WorkerViewModel[] = [];
  for (const dwell of state.active.values()) {
    if (!isDwelling(dwell, now)) continue;
    if (present.has(dwell.sessionKey)) continue;
    dwelling.push({ ...structuralFrame(dwell.worker), endedDwell: true });
  }
  return dwelling.length === 0 ? [...workers] : [...workers, ...dwelling];
}

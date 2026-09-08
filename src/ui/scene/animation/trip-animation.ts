/**
 * Archive-trip animation (blocker B.2, tasks.md 21.2-21.4): the RENDER half of
 * `OfficeViewModel.archiveTrip`. The data half (`office-view-model.ts`'s `archiveTrip` projection)
 * already existed and was tested; nothing consumed it. This module is that consumer: it walks a
 * worker along its precomputed `archiveTrip.path` (`archive-path.ts`) over real time, dwells and
 * highlights at the archive, then walks back — and reports when a trip's full round trip has
 * finished so the caller can advance the domain carry queue (`completeArchiveTripForWorker`).
 *
 * Pure and canvas-free, matching this codebase's existing split (`pixi-office-renderer.ts`'s
 * `updateStage`): `now` is an explicit parameter (fake-clock by construction), so "where is the
 * worker along its path at time t" is ordinary, unit-testable arithmetic — never something drawn
 * and eyeballed.
 *
 * Deliberately decoupled from ingestion (design.md: "animation is a lagging view, ingestion never
 * blocks"): nothing here is invoked by `OfficeContainer.handleMessage`. Only an explicit `tick`
 * (driven by `requestAnimationFrame` in the browser, or a fake clock in tests) advances it, so an
 * arbitrarily large burst of incoming events can never be slowed down or dropped by animation
 * playback.
 */
import type { OfficeViewModel, WorkerViewModel } from '../../state/office-view-model';
import type { ScenePoint } from '../layout/archive-path';

export type TripPhase = 'walking-out' | 'at-archive' | 'walking-back';

/** Time the worker spends walking each leg of the path. */
export const WALK_DURATION_MS = 600;
/** Time the worker dwells, highlighted, at the archive cabinet before walking back. */
export const DOCK_DURATION_MS = 350;

export interface ActiveTrip {
  sessionKey: string;
  path: ScenePoint[];
  carryCount: number;
  phase: TripPhase;
  /** When the CURRENT phase began, in the same clock as `now` — never reset except on a phase
   * transition, and even then advanced by exactly that phase's duration (not snapped to `now`),
   * so a large time jump collapsing multiple phases in one call still interpolates correctly. */
  phaseStartedAt: number;
}

export interface TripAnimatorState {
  active: Map<string, ActiveTrip>;
  /** Cumulative count of trips that have reached the archive cabinet (design.md: "the archive
   * counter increments"). Tracked here, not in `domain/`, because it is purely an animation-
   * playback fact — a trip that never gets a chance to play out has not "arrived" yet, no matter
   * how long its document has been logically held. */
  archivedCount: number;
}

export function createTripAnimatorState(): TripAnimatorState {
  return { active: new Map(), archivedCount: 0 };
}

/** Position along `path` at `progress` in `[0, 1]`, proportional to cumulative segment length. */
export function interpolatePath(path: ScenePoint[], progress: number): ScenePoint {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return path[0]!;

  const clamped = Math.max(0, Math.min(1, progress));
  const segmentLengths = path.slice(1).map((point, i) => Math.hypot(point.x - path[i]!.x, point.y - path[i]!.y));
  const totalLength = segmentLengths.reduce((sum, len) => sum + len, 0);
  if (totalLength === 0) return path[0]!;

  let remaining = clamped * totalLength;
  for (let i = 0; i < segmentLengths.length; i++) {
    const length = segmentLengths[i]!;
    const isLastSegment = i === segmentLengths.length - 1;
    if (remaining <= length || isLastSegment) {
      const t = length === 0 ? 0 : Math.min(1, remaining / length);
      const a = path[i]!;
      const b = path[i + 1]!;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= length;
  }
  return path[path.length - 1]!;
}

function phaseDuration(phase: TripPhase): number {
  return phase === 'at-archive' ? DOCK_DURATION_MS : WALK_DURATION_MS;
}

/**
 * Advances one trip's phase as far as `now` allows, possibly through several transitions in one
 * call. Returns `trip: null` once the round trip (walking-out -> at-archive -> walking-back) is
 * fully done. `justArrived` is `true` exactly once, on the walking-out -> at-archive transition.
 */
function stepTrip(trip: ActiveTrip, now: number): { trip: ActiveTrip | null; justArrived: boolean } {
  let current: ActiveTrip = trip;
  let justArrived = false;

  // At most 3 transitions are possible (walking-out -> at-archive -> walking-back -> done); a
  // small bounded loop, never unbounded, even for an arbitrarily large `now`.
  for (let i = 0; i < 3; i++) {
    const duration = phaseDuration(current.phase);
    if (now - current.phaseStartedAt < duration) break;

    if (current.phase === 'walking-out') {
      current = { ...current, phase: 'at-archive', phaseStartedAt: current.phaseStartedAt + duration };
      justArrived = true;
    } else if (current.phase === 'at-archive') {
      current = { ...current, phase: 'walking-back', phaseStartedAt: current.phaseStartedAt + duration };
    } else {
      return { trip: null, justArrived };
    }
  }

  return { trip: current, justArrived };
}

export interface AdvanceTripAnimationsResult {
  state: TripAnimatorState;
  /** sessionKeys whose full round trip finished THIS call — the caller must advance their carry
   * queue (`completeArchiveTripForWorker`) so the next queued/batched job (if any) can start. */
  completed: string[];
}

/**
 * One animation tick: starts a trip for any worker that newly carries an `archiveTrip` and has no
 * active trip yet, then advances every currently active trip to `now`. Never restarts a trip that
 * is already in progress (design.md: workers with a still-held document stay in the same trip
 * until it completes).
 */
export function advanceTripAnimations(
  state: TripAnimatorState,
  workers: WorkerViewModel[],
  now: number,
): AdvanceTripAnimationsResult {
  const active = new Map(state.active);

  for (const worker of workers) {
    if (!worker.archiveTrip) continue;
    if (active.has(worker.sessionKey)) continue;
    active.set(worker.sessionKey, {
      sessionKey: worker.sessionKey,
      path: worker.archiveTrip.path,
      carryCount: worker.archiveTrip.carryCount,
      phase: 'walking-out',
      phaseStartedAt: now,
    });
  }

  let archivedCount = state.archivedCount;
  const completed: string[] = [];

  for (const [sessionKey, trip] of active) {
    const { trip: nextTrip, justArrived } = stepTrip(trip, now);
    if (justArrived) archivedCount += 1;
    if (nextTrip) {
      active.set(sessionKey, nextTrip);
    } else {
      active.delete(sessionKey);
      completed.push(sessionKey);
    }
  }

  return { state: { active, archivedCount }, completed };
}

export interface TripRenderOverlay {
  x: number;
  y: number;
  /** True only while dwelling at the archive (design.md: "brief highlight"). */
  highlight: boolean;
  /** True for the whole trip — the carried document sprite is visible throughout. */
  showDocument: boolean;
}

/** The current rendered position/highlight for `sessionKey`'s active trip, or `null` if it has
 * none (either never started, or already completed and released). */
export function getTripOverlay(state: TripAnimatorState, sessionKey: string, now: number): TripRenderOverlay | null {
  const trip = state.active.get(sessionKey);
  if (!trip) return null;

  if (trip.phase === 'at-archive') {
    const destination = trip.path[trip.path.length - 1]!;
    return { x: destination.x, y: destination.y, highlight: true, showDocument: true };
  }

  const elapsed = now - trip.phaseStartedAt;
  const progress = Math.min(1, elapsed / WALK_DURATION_MS);
  const position = interpolatePath(trip.path, trip.phase === 'walking-out' ? progress : 1 - progress);
  return { x: position.x, y: position.y, highlight: false, showDocument: true };
}

/**
 * Overlays every active trip's animated position/highlight onto a structural `OfficeViewModel`
 * (`buildOfficeViewModel`'s output). A worker with no active trip passes through unchanged.
 */
export function applyTripOverlay(viewModel: OfficeViewModel, state: TripAnimatorState, now: number): OfficeViewModel {
  const workers = viewModel.workers.map((worker) => {
    const overlay = getTripOverlay(state, worker.sessionKey, now);
    if (!overlay || !worker.archiveTrip) return worker;
    return {
      ...worker,
      x: overlay.x,
      y: overlay.y,
      archiveTrip: { ...worker.archiveTrip, highlight: overlay.highlight, showDocument: overlay.showDocument },
    };
  });

  return { ...viewModel, workers, archiveCount: state.archivedCount };
}

/**
 * Sofa-visit animation: a worker quiet for a minute walks to the central meeting sofa, sits there,
 * and walks back to its desk the moment it becomes active again. The RENDER half of this feature —
 * mirrors `trip-animation.ts`'s own split exactly, for the same reason.
 *
 * WHY this lives here, in the render layer, rather than in `domain/office/office.ts`
 * ------------------------------------------------------------------------------------------------
 * The domain is event-driven: `applyEventToOfficeState` only runs when an event arrives, so a
 * worker going quiet produces no event, and the domain can never notice a minute passing on its
 * own — it has no clock. The only place in this codebase with a clock is `OfficeContainer.tick(now)`.
 * This is the exact same reason `TripAnimatorState.archivedCount` is deliberately kept out of
 * `domain/` (see `trip-animation.ts`'s own header comment): it is a playback fact, derived by
 * comparing the render clock to a domain timestamp, not a fact the domain fold can compute itself.
 *
 * Also important: `Worker.activity === 'idle'` is NOT usable for this feature. Its flip is driven
 * by `IDLE_TIMEOUT_MS` (`domain/sessions/session-lifecycle.ts`), which is 10 minutes — this
 * feature needs a 1-minute signal, so it reads `WorkerViewModel.lastEventAt` (`domain/office/
 * office.ts`'s `Worker.lastEventAt`) directly instead.
 *
 * Pure and canvas-free, matching `trip-animation.ts`: `now` is always an explicit parameter, never
 * read from the wall clock, so "where is the worker along its path at time t" stays ordinary,
 * unit-testable arithmetic.
 *
 * Seat allocation is intentionally its OWN small free-index search, not a reuse of
 * `domain/office/archive-dock.ts`. The archive has 4 slots and a wait queue because a held
 * document must eventually be filed; the sofa has 3 seats and no such obligation (rule 2 below), so
 * borrowing a module named "archive dock" for sofa seats would mislead the next reader about why a
 * seat request can simply be dropped.
 */
import type { WorkerViewModel } from '../../state/office-view-model';
import type { MapPoint } from '../world/office-map';
import { MEETING_SOFA } from '../world/office-map';
import { officeNavigation } from '../world/office-navigation';
import { resolveMoveDirection } from '../character/character-facing';
import type { CharacterDirection } from '../character/character-sprite';
import { interpolatePath, WALK_DURATION_MS } from './trip-animation';

/** How long a worker must go without a single event before it is considered quiet enough to visit
 * the sofa. Deliberately far shorter than `IDLE_TIMEOUT_MS` (10 minutes, `session-lifecycle.ts`):
 * that timeout marks a session as functionally abandoned, while this one just notices a lull. */
export const SOFA_IDLE_MS = 60_000;

/** The sofa's seat count, derived from the map rather than hardcoded (guide section 2: "No
 * codificar manualmente ... coordenadas de estaciones si ya existen en JSON") — asserted at module
 * load so a repacked map that changes the sofa's anchor count fails loudly here, rather than
 * silently desyncing seat allocation from `MEETING_SOFA.anchors`. */
export const SOFA_SEAT_COUNT = MEETING_SOFA.anchors.length;
if (SOFA_SEAT_COUNT !== 3) {
  throw new Error(`sofa-visit: expected office-map.json's meeting_sofa to declare 3 seats, found ${SOFA_SEAT_COUNT}`);
}

export type SofaVisitPhase = 'walking-out' | 'seated' | 'walking-back';

export interface ActiveSofaVisit {
  sessionKey: string;
  seatIndex: number;
  path: MapPoint[];
  phase: SofaVisitPhase;
  /** When the CURRENT phase began, in the same clock as `now` — advanced by exactly
   * `WALK_DURATION_MS` on the walking-out -> seated transition (never snapped to `now`), mirroring
   * `trip-animation.ts`'s `ActiveTrip.phaseStartedAt` so a large time jump still interpolates
   * correctly on the next tick instead of skipping. */
  phaseStartedAt: number;
  /** When the visit itself began (fixed for its whole lifetime) — the reference point rule 5 reads
   * to tell whether the worker has become active again since it sat down. */
  startedAt: number;
}

export interface SofaVisitState {
  active: Map<string, ActiveSofaVisit>;
}

export function createSofaVisitState(): SofaVisitState {
  return { active: new Map() };
}

/** The lowest-numbered seat not currently held by any active visit, or `null` when the sofa is
 * full. A plain linear scan over `SOFA_SEAT_COUNT` — this is the whole "seat allocation is local to
 * this module" contract; no cursor, no wait line, because rule 2 means a denied request is simply
 * retried on the next tick rather than queued. */
function findFreeSeatIndex(occupied: ReadonlySet<number>): number | null {
  for (let seatIndex = 0; seatIndex < SOFA_SEAT_COUNT; seatIndex++) {
    if (!occupied.has(seatIndex)) return seatIndex;
  }
  return null;
}

/**
 * One tick: drops visits for workers that vanished from `workers` (rule 7 — session eviction must
 * never leave a ghost holding a seat), starts a new visit for any newly-quiet, seatable worker
 * (rules 1-3), then advances every active visit's phase to `now` (rules 4-6).
 */
export function advanceSofaVisits(state: SofaVisitState, workers: WorkerViewModel[], now: number): SofaVisitState {
  const active = new Map(state.active);
  const workersByKey = new Map(workers.map((w) => [w.sessionKey, w]));

  // Rule 7: a worker no longer in the roster releases its seat immediately, never lingering as a
  // ghost occupant — the seat frees up for allocation in the very same call below.
  for (const sessionKey of active.keys()) {
    if (!workersByKey.has(sessionKey)) active.delete(sessionKey);
  }

  // Rules 1-3: start a visit for every worker that is quiet long enough, carries no archiveTrip
  // (filing outranks sitting down), has no visit already, and can be given a free seat.
  const occupiedSeats = new Set<number>();
  for (const visit of active.values()) occupiedSeats.add(visit.seatIndex);

  for (const worker of workers) {
    if (active.has(worker.sessionKey)) continue;
    if (worker.archiveTrip) continue;
    if (worker.lastEventAt === undefined) continue;
    if (now - worker.lastEventAt < SOFA_IDLE_MS) continue;

    const seatIndex = findFreeSeatIndex(occupiedSeats);
    if (seatIndex === null) continue; // rule 2: no wait queue — re-evaluated next tick instead

    occupiedSeats.add(seatIndex);
    const anchor = MEETING_SOFA.anchors[seatIndex]!;
    const start = { x: worker.seatX ?? worker.x, y: worker.seatY ?? worker.y };
    active.set(worker.sessionKey, {
      sessionKey: worker.sessionKey,
      seatIndex,
      path: officeNavigation.findPath(start, anchor),
      phase: 'walking-out',
      phaseStartedAt: now,
      startedAt: now,
    });
  }

  // Rules 4-6: advance every active visit's phase.
  for (const [sessionKey, visit] of active) {
    const worker = workersByKey.get(sessionKey)!; // vanished sessions were already dropped above
    const stepped = stepSofaVisit(visit, worker, now);
    if (stepped) {
      active.set(sessionKey, stepped);
    } else {
      active.delete(sessionKey);
    }
  }

  return { active };
}

/**
 * Advances one visit's phase as far as `now`/the worker's current state allows. Returns `null`
 * once the round trip (walking-out -> seated -> walking-back) is fully done, at which point the
 * seat is released simply by the caller dropping this entry from `state.active`.
 */
function stepSofaVisit(visit: ActiveSofaVisit, worker: WorkerViewModel, now: number): ActiveSofaVisit | null {
  let current = visit;

  if (current.phase === 'walking-out' && now - current.phaseStartedAt >= WALK_DURATION_MS) {
    // Rule 4: advanced by exactly WALK_DURATION_MS, never snapped to `now` — see
    // `ActiveSofaVisit.phaseStartedAt`'s doc comment for why.
    current = { ...current, phase: 'seated', phaseStartedAt: current.phaseStartedAt + WALK_DURATION_MS };
  }

  if (current.phase === 'seated') {
    // Rule 5: active again (a fresh event since the visit started), or filing a document now
    // outranks sitting — either way, head back. This is a worker-state check, not a duration, so
    // (unlike the two duration transitions) `phaseStartedAt` snaps to `now`: there is no prior
    // elapsed walk to preserve the start of.
    const becameActive = worker.lastEventAt !== undefined && worker.lastEventAt > current.startedAt;
    const gainedArchiveTrip = Boolean(worker.archiveTrip);
    if (becameActive || gainedArchiveTrip) {
      current = { ...current, phase: 'walking-back', phaseStartedAt: now };
    }
  }

  if (current.phase === 'walking-back' && now - current.phaseStartedAt >= WALK_DURATION_MS) {
    return null; // rule 6: round trip done — seat released by the caller dropping this entry
  }

  return current;
}

/** How far along the path to sample when reading the direction of travel — same value and same
 * rationale as `trip-animation.ts`'s own `DIRECTION_SAMPLE`: small enough to stay on the current
 * leg of a dogleg route, large enough to survive floating-point noise. Not imported from
 * `trip-animation.ts` because it is a private implementation constant there, not part of its
 * public contract. */
const DIRECTION_SAMPLE = 0.01;

/**
 * The direction the character is travelling at path position `travel` (0 = desk, 1 = sofa seat),
 * taken from two points straddling it so the answer follows the CURRENT leg of the route — the
 * exact technique `trip-animation.ts`'s own (private) `tripDirection` uses, reimplemented here
 * because that helper is not exported.
 *
 * `outbound` is what distinguishes walking-out from walking-back: both legs retrace the identical
 * path, so a worker's position alone cannot tell them apart — walking back is the same samples
 * read in reverse.
 */
function sofaDirection(visit: ActiveSofaVisit, travel: number, outbound: boolean): CharacterDirection {
  const before = interpolatePath(visit.path, Math.max(0, travel - DIRECTION_SAMPLE));
  const after = interpolatePath(visit.path, Math.min(1, travel + DIRECTION_SAMPLE));
  return outbound ? resolveMoveDirection(before, after) : resolveMoveDirection(after, before);
}

export interface SofaVisitOverlay {
  x: number;
  y: number;
  /** True only while seated at the sofa — mirrors `TripRenderOverlay.highlight`'s role of marking
   * the "arrived and dwelling" moment. */
  seated: boolean;
  direction: CharacterDirection;
}

/** The current rendered position/seated-flag for `sessionKey`'s active sofa visit, or `null` if it
 * has none (never started, or already completed and released). */
export function getSofaOverlay(state: SofaVisitState, sessionKey: string, now: number): SofaVisitOverlay | null {
  const visit = state.active.get(sessionKey);
  if (!visit) return null;

  if (visit.phase === 'seated') {
    const anchor = MEETING_SOFA.anchors[visit.seatIndex]!;
    return { x: anchor.x, y: anchor.y, seated: true, direction: sofaDirection(visit, 1, true) };
  }

  const elapsed = now - visit.phaseStartedAt;
  const progress = Math.min(1, elapsed / WALK_DURATION_MS);
  const outbound = visit.phase === 'walking-out';
  const travel = outbound ? progress : 1 - progress;
  const position = interpolatePath(visit.path, travel);
  return { x: position.x, y: position.y, seated: false, direction: sofaDirection(visit, travel, outbound) };
}

/**
 * Overlays every active sofa visit's animated position/seated-flag onto a `WorkerViewModel[]`
 * list (`buildOfficeViewModel(...).workers`, already possibly passed through `applyTripOverlay`).
 *
 * A worker with an `archiveTrip` passes through COMPLETELY UNCHANGED, never overlaid — rule 9: an
 * archive trip always outranks a sofa visit. This is a defensive final check, not the only guard:
 * `advanceSofaVisits`'s own rule 1 (never START a visit for a filing worker) and rule 5 (an
 * existing visit ALWAYS steps to walking-back the instant one gains an archiveTrip) already keep
 * the two from coexisting in `state.active` in practice, but a worker that passed through this
 * function unmodified is a stronger guarantee than trusting that upstream invariant alone.
 */
export function applySofaOverlay(workers: WorkerViewModel[], state: SofaVisitState, now: number): WorkerViewModel[] {
  return workers.map((worker) => {
    if (worker.archiveTrip) return worker;
    const overlay = getSofaOverlay(state, worker.sessionKey, now);
    if (!overlay) return worker;
    return {
      ...worker,
      x: overlay.x,
      y: overlay.y,
      sofaVisit: { seated: overlay.seated, direction: overlay.direction },
    };
  });
}

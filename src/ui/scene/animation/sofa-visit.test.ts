import { describe, expect, it } from 'vitest';
import {
  advanceSofaVisits,
  applySofaOverlay,
  createSofaVisitState,
  getSofaOverlay,
  SOFA_IDLE_MS,
  SOFA_SEAT_COUNT,
  type ActiveSofaVisit,
  type SofaVisitState,
} from './sofa-visit';
import { interpolatePath, WALK_DURATION_MS } from './trip-animation';
import { MEETING_SOFA } from '../world/office-map';
import type { WorkerViewModel } from '../../state/office-view-model';

function quietWorker(overrides: Partial<WorkerViewModel> = {}): WorkerViewModel {
  return {
    sessionKey: 'claude-code:s1',
    harness: 'claude-code',
    label: 'my-session',
    x: 100,
    y: 100,
    seatX: 100,
    seatY: 100,
    lastEventAt: 0,
    ...overrides,
  };
}

describe('SOFA_SEAT_COUNT — derived from the map, never hardcoded', () => {
  it('matches the number of anchors meeting_sofa actually declares', () => {
    expect(SOFA_SEAT_COUNT).toBe(MEETING_SOFA.anchors.length);
    expect(SOFA_SEAT_COUNT).toBe(3);
  });
});

describe('advanceSofaVisits — starting a visit (rule 1: quiet, no archiveTrip, free seat)', () => {
  it('starts a visit for a worker quiet for at least SOFA_IDLE_MS', () => {
    const state = createSofaVisitState();
    const worker = quietWorker({ lastEventAt: 0 });

    const next = advanceSofaVisits(state, [worker], SOFA_IDLE_MS);

    expect(next.active.has('claude-code:s1')).toBe(true);
    expect(next.active.get('claude-code:s1')?.phase).toBe('walking-out');
  });

  // Adversarial twin: strictly BEFORE the idle threshold, no visit starts — proves the guard is
  // time-gated, not "any worker with a lastEventAt".
  it('does NOT start a visit before SOFA_IDLE_MS has elapsed since lastEventAt', () => {
    const state = createSofaVisitState();
    const worker = quietWorker({ lastEventAt: 0 });

    const next = advanceSofaVisits(state, [worker], SOFA_IDLE_MS - 1);

    expect(next.active.size).toBe(0);
  });

  // Adversarial twin: a worker with no lastEventAt at all (never touched by an event, per the
  // domain contract) must never be treated as infinitely quiet.
  it('does NOT start a visit for a worker with no lastEventAt at all', () => {
    const state = createSofaVisitState();
    const worker = quietWorker();
    delete (worker as { lastEventAt?: number }).lastEventAt;

    const next = advanceSofaVisits(state, [worker], SOFA_IDLE_MS * 100);

    expect(next.active.size).toBe(0);
  });

  // Rule 1: a worker with an archiveTrip is busy filing a document, even if quiet long enough —
  // filing outranks a sofa visit, exactly as it outranks staying seated (rule 5).
  it('does NOT start a visit for a quiet worker that has an archiveTrip', () => {
    const state = createSofaVisitState();
    const worker = quietWorker({
      lastEventAt: 0,
      archiveTrip: { path: [{ x: 100, y: 100 }, { x: 1010, y: 455 }], carryCount: 1 },
    });

    const next = advanceSofaVisits(state, [worker], SOFA_IDLE_MS);

    expect(next.active.size).toBe(0);
  });

  it('routes the walk from the worker\'s own seat to one of the sofa\'s anchors via findPath (never a straight line through furniture)', () => {
    const state = createSofaVisitState();
    const worker = quietWorker({ seatX: 660, seatY: 695, x: 660, y: 695, lastEventAt: 0 });

    const next = advanceSofaVisits(state, [worker], SOFA_IDLE_MS);

    const visit = next.active.get('claude-code:s1')!;
    expect(visit.path[0]).toEqual({ x: 660, y: 695 });
    expect(visit.path[visit.path.length - 1]).toEqual(MEETING_SOFA.anchors[visit.seatIndex]);
  });
});

describe('advanceSofaVisits — seat allocation (rules 2 and 3: local, no wait queue)', () => {
  it('allocates a distinct seat to each of three simultaneously-quiet workers', () => {
    const state = createSofaVisitState();
    const workers = [
      quietWorker({ sessionKey: 'claude-code:a', lastEventAt: 0 }),
      quietWorker({ sessionKey: 'claude-code:b', lastEventAt: 0 }),
      quietWorker({ sessionKey: 'claude-code:c', lastEventAt: 0 }),
    ];

    const next = advanceSofaVisits(state, workers, SOFA_IDLE_MS);

    const seatIndexes = workers.map((w) => next.active.get(w.sessionKey)?.seatIndex).sort();
    expect(seatIndexes).toEqual([0, 1, 2]);
  });

  // Rule 2: no wait queue — a 4th quiet worker with no free seat simply stays at its desk (no
  // active entry at all), unlike the archive dock's wait line.
  it('a 4th simultaneously-quiet worker with no free seat stays at its desk (no queue entry)', () => {
    const state = createSofaVisitState();
    const workers = [
      quietWorker({ sessionKey: 'claude-code:a', lastEventAt: 0 }),
      quietWorker({ sessionKey: 'claude-code:b', lastEventAt: 0 }),
      quietWorker({ sessionKey: 'claude-code:c', lastEventAt: 0 }),
      quietWorker({ sessionKey: 'claude-code:d', lastEventAt: 0 }),
    ];

    const next = advanceSofaVisits(state, workers, SOFA_IDLE_MS);

    expect(next.active.has('claude-code:d')).toBe(false);
    expect(next.active.size).toBe(3);
  });

  // The re-evaluation half of rule 2: once a seat frees up on a LATER tick, a worker that was
  // denied one gets it then — proving there is no queue holding its place, just a fresh re-check
  // of `findFreeSeatIndex` every call.
  it('a worker denied a seat is offered one again on a later tick once one frees up', () => {
    const a = quietWorker({ sessionKey: 'claude-code:a', lastEventAt: 0 });
    const b = quietWorker({ sessionKey: 'claude-code:b', lastEventAt: 0 });
    const c = quietWorker({ sessionKey: 'claude-code:c', lastEventAt: 0 });
    const latecomer = quietWorker({ sessionKey: 'claude-code:d', lastEventAt: 0 });

    let state = advanceSofaVisits(createSofaVisitState(), [a, b, c, latecomer], SOFA_IDLE_MS);
    expect(state.active.has('claude-code:d')).toBe(false);

    // `a`'s session ends (vanishes from the roster entirely) — rule 7 releases its seat.
    state = advanceSofaVisits(state, [b, c, latecomer], SOFA_IDLE_MS);
    expect(state.active.has('claude-code:a')).toBe(false);

    const next = advanceSofaVisits(state, [b, c, latecomer], SOFA_IDLE_MS);

    expect(next.active.get('claude-code:d')?.seatIndex).toBe(0);
  });
});

describe('advanceSofaVisits — phase transitions (rules 4-6)', () => {
  it('transitions walking-out -> seated once WALK_DURATION_MS has elapsed', () => {
    const worker = quietWorker({ lastEventAt: 0 });
    const started = advanceSofaVisits(createSofaVisitState(), [worker], SOFA_IDLE_MS);

    const arrived = advanceSofaVisits(started, [worker], SOFA_IDLE_MS + WALK_DURATION_MS);

    expect(arrived.active.get('claude-code:s1')?.phase).toBe('seated');
  });

  // Adversarial twin: strictly before WALK_DURATION_MS, the visit must still be walking-out.
  it('does NOT transition to seated before WALK_DURATION_MS elapses', () => {
    const worker = quietWorker({ lastEventAt: 0 });
    const started = advanceSofaVisits(createSofaVisitState(), [worker], SOFA_IDLE_MS);

    const stillWalking = advanceSofaVisits(started, [worker], SOFA_IDLE_MS + WALK_DURATION_MS - 1);

    expect(stillWalking.active.get('claude-code:s1')?.phase).toBe('walking-out');
  });

  // Rule 4: phaseStartedAt is advanced by exactly WALK_DURATION_MS, never snapped to `now` — a
  // large time jump collapsing straight through walking-out must still land on the SAME seated
  // phaseStartedAt a series of small ticks would have produced, mirroring `trip-animation.ts`'s
  // own "collapses multiple elapsed phases correctly in a single large time jump" guarantee.
  it('advances phaseStartedAt by exactly WALK_DURATION_MS on the walking-out -> seated transition, not to `now`', () => {
    const worker = quietWorker({ lastEventAt: 0 });
    const started = advanceSofaVisits(createSofaVisitState(), [worker], SOFA_IDLE_MS);

    const farInTheFuture = advanceSofaVisits(started, [worker], SOFA_IDLE_MS + WALK_DURATION_MS + 10_000);

    expect(farInTheFuture.active.get('claude-code:s1')?.phaseStartedAt).toBe(SOFA_IDLE_MS + WALK_DURATION_MS);
  });

  it('transitions seated -> walking-back once the worker becomes active again', () => {
    const worker = quietWorker({ lastEventAt: 0 });
    let state = advanceSofaVisits(createSofaVisitState(), [worker], SOFA_IDLE_MS);
    state = advanceSofaVisits(state, [worker], SOFA_IDLE_MS + WALK_DURATION_MS);
    expect(state.active.get('claude-code:s1')?.phase).toBe('seated');

    const activeAgain = { ...worker, lastEventAt: SOFA_IDLE_MS + WALK_DURATION_MS + 1 };
    const next = advanceSofaVisits(state, [activeAgain], SOFA_IDLE_MS + WALK_DURATION_MS + 2);

    expect(next.active.get('claude-code:s1')?.phase).toBe('walking-back');
  });

  // Adversarial twin: staying quiet (lastEventAt never advances past the visit's own startedAt)
  // must keep the worker seated indefinitely — proves the transition reads actual new activity,
  // not just the passage of time.
  it('stays seated indefinitely while the worker remains quiet', () => {
    const worker = quietWorker({ lastEventAt: 0 });
    let state = advanceSofaVisits(createSofaVisitState(), [worker], SOFA_IDLE_MS);
    state = advanceSofaVisits(state, [worker], SOFA_IDLE_MS + WALK_DURATION_MS);

    const stillQuiet = advanceSofaVisits(state, [worker], SOFA_IDLE_MS + WALK_DURATION_MS + 10_000_000);

    expect(stillQuiet.active.get('claude-code:s1')?.phase).toBe('seated');
  });

  // Rule 5's second clause: filing a document outranks sitting on the sofa, even with no new
  // activity event at all.
  it('transitions seated -> walking-back the moment the worker gains an archiveTrip, even while otherwise still quiet', () => {
    const worker = quietWorker({ lastEventAt: 0 });
    let state = advanceSofaVisits(createSofaVisitState(), [worker], SOFA_IDLE_MS);
    state = advanceSofaVisits(state, [worker], SOFA_IDLE_MS + WALK_DURATION_MS);
    expect(state.active.get('claude-code:s1')?.phase).toBe('seated');

    const filing = { ...worker, archiveTrip: { path: [{ x: 100, y: 100 }, { x: 1010, y: 455 }], carryCount: 1 } };
    const next = advanceSofaVisits(state, [filing], SOFA_IDLE_MS + WALK_DURATION_MS + 1);

    expect(next.active.get('claude-code:s1')?.phase).toBe('walking-back');
  });

  it('removes the visit and releases the seat once walking-back finishes after WALK_DURATION_MS', () => {
    const worker = quietWorker({ lastEventAt: 0 });
    let state = advanceSofaVisits(createSofaVisitState(), [worker], SOFA_IDLE_MS);
    state = advanceSofaVisits(state, [worker], SOFA_IDLE_MS + WALK_DURATION_MS);
    const activeAgain = { ...worker, lastEventAt: SOFA_IDLE_MS + WALK_DURATION_MS + 1 };
    state = advanceSofaVisits(state, [activeAgain], SOFA_IDLE_MS + WALK_DURATION_MS + 1);
    expect(state.active.get('claude-code:s1')?.phase).toBe('walking-back');
    const walkingBackStartedAt = state.active.get('claude-code:s1')!.phaseStartedAt;

    const done = advanceSofaVisits(state, [activeAgain], walkingBackStartedAt + WALK_DURATION_MS);

    expect(done.active.has('claude-code:s1')).toBe(false);

    // The freed seat is immediately available to a different, newly-quiet worker.
    const other = quietWorker({ sessionKey: 'claude-code:other', lastEventAt: 0 });
    const reallocated = advanceSofaVisits(done, [activeAgain, other], walkingBackStartedAt + WALK_DURATION_MS);
    expect(reallocated.active.get('claude-code:other')?.seatIndex).toBe(0);
  });

  // Rule 7, its own explicit test per the spec: a worker that disappears from the `workers` array
  // (session eviction) releases its seat immediately and its visit is dropped, regardless of what
  // phase it was in — a ghost must never hold a seat forever.
  it('releases the seat and drops the visit immediately when the worker disappears from the roster (session eviction)', () => {
    const worker = quietWorker({ lastEventAt: 0 });
    const state = advanceSofaVisits(createSofaVisitState(), [worker], SOFA_IDLE_MS);
    expect(state.active.has('claude-code:s1')).toBe(true);

    const evicted = advanceSofaVisits(state, [], SOFA_IDLE_MS);

    expect(evicted.active.has('claude-code:s1')).toBe(false);

    // Its seat (0) is immediately available to someone else — proving it was actually released,
    // not merely orphaned.
    const other = quietWorker({ sessionKey: 'claude-code:other', lastEventAt: 0 });
    const reallocated = advanceSofaVisits(evicted, [other], SOFA_IDLE_MS);
    expect(reallocated.active.get('claude-code:other')?.seatIndex).toBe(0);
  });
});

/** A hand-built path (the same dogleg shape `trip-animation.test.ts`'s own `interpolatePath`
 * suite uses), so direction tests read the actual geometry rather than depending on the real
 * office-navigation grid producing a particular route. */
const HAND_BUILT_PATH = [
  { x: 0, y: 0 },
  { x: 0, y: 10 },
  { x: 10, y: 10 },
];

function stateWithVisit(overrides: Partial<ActiveSofaVisit> = {}): SofaVisitState {
  return {
    active: new Map([
      [
        'claude-code:s1',
        {
          sessionKey: 'claude-code:s1',
          seatIndex: 0,
          path: HAND_BUILT_PATH,
          phase: 'walking-out',
          phaseStartedAt: 0,
          startedAt: 0,
          ...overrides,
        },
      ],
    ]),
  };
}

describe('getSofaOverlay — the currently-rendered position/seated-flag for an active visit (rule 8)', () => {
  it('returns null for a session with no active visit', () => {
    expect(getSofaOverlay(createSofaVisitState(), 'claude-code:s1', 0)).toBeNull();
  });

  it('is at the path start, not seated, at the very start of walking-out', () => {
    const overlay = getSofaOverlay(stateWithVisit({ phase: 'walking-out', phaseStartedAt: 0 }), 'claude-code:s1', 0);

    expect(overlay).toMatchObject({ x: 0, y: 0, seated: false });
  });

  it('interpolates along the path exactly like the archive-trip overlay does, while walking-out', () => {
    const state = stateWithVisit({ phase: 'walking-out', phaseStartedAt: 0 });

    const overlay = getSofaOverlay(state, 'claude-code:s1', WALK_DURATION_MS / 4);

    const expected = interpolatePath(HAND_BUILT_PATH, 0.25);
    expect(overlay).toMatchObject({ x: expected.x, y: expected.y, seated: false });
  });

  it('is at the allocated seat\'s own anchor, seated:true, while seated (not necessarily seat 0)', () => {
    const overlay = getSofaOverlay(stateWithVisit({ phase: 'seated', seatIndex: 1 }), 'claude-code:s1', 999);

    expect(overlay).toMatchObject({ x: MEETING_SOFA.anchors[1]!.x, y: MEETING_SOFA.anchors[1]!.y, seated: true });
  });

  it('reports the direction of the final leg while seated, matching the archive-trip convention', () => {
    // HAND_BUILT_PATH's last leg runs (0,10) -> (10,10): a rightward move.
    const overlay = getSofaOverlay(stateWithVisit({ phase: 'seated' }), 'claude-code:s1', 0);

    expect(overlay?.direction).toBe('right');
  });

  it('reads the direction from the CURRENT leg while walking out', () => {
    // Progress 0.25 (5 of 20 total units) sits on the first, vertical leg — a downward move.
    const overlay = getSofaOverlay(stateWithVisit({ phase: 'walking-out', phaseStartedAt: 0 }), 'claude-code:s1', WALK_DURATION_MS / 4);

    expect(overlay?.direction).toBe('down');
  });

  // Rule 8's decisive case: walking-back retraces the SAME path, so the direction must reverse —
  // read backwards — rather than repeat what walking-out reported at the mirrored progress.
  it('reverses the direction while walking back, reading the path backwards', () => {
    const overlay = getSofaOverlay(stateWithVisit({ phase: 'walking-back', phaseStartedAt: 0 }), 'claude-code:s1', WALK_DURATION_MS / 4);

    // Progress 0.25 walking back means travel = 0.75, on the second (horizontal) leg, heading
    // from the sofa back toward the desk — i.e. leftward, the reverse of that leg's outbound
    // (rightward) reading.
    expect(overlay?.direction).toBe('left');
  });
});

describe('applySofaOverlay — overlays active visits onto a WorkerViewModel list (rule 9)', () => {
  it('sets x/y from the overlay and a new sofaVisit field for a worker with an active visit', () => {
    const state = stateWithVisit({ phase: 'seated', seatIndex: 2 });
    const workers: WorkerViewModel[] = [quietWorker({ x: 5, y: 5 })];

    const overlaid = applySofaOverlay(workers, state, 0);

    expect(overlaid[0]!.x).toBe(MEETING_SOFA.anchors[2]!.x);
    expect(overlaid[0]!.y).toBe(MEETING_SOFA.anchors[2]!.y);
    expect(overlaid[0]!.sofaVisit).toEqual({ seated: true, direction: 'right' });
  });

  it('leaves a worker with no active visit completely unchanged', () => {
    const workers: WorkerViewModel[] = [quietWorker()];

    const overlaid = applySofaOverlay(workers, createSofaVisitState(), 0);

    expect(overlaid[0]).toEqual(workers[0]);
  });

  // Rule 9's precedence clause: a worker that ALSO has an archiveTrip must pass through this
  // function completely unchanged — the archive overlay always wins, never stacked with sofa data.
  it('leaves a worker with an archiveTrip unchanged even while it has an active sofa visit', () => {
    const state = stateWithVisit({ phase: 'seated' });
    const filingWorker = quietWorker({
      archiveTrip: { path: [{ x: 100, y: 100 }, { x: 1010, y: 455 }], carryCount: 1 },
    });

    const overlaid = applySofaOverlay([filingWorker], state, 0);

    expect(overlaid[0]).toEqual(filingWorker);
    expect(overlaid[0]!.sofaVisit).toBeUndefined();
  });
});

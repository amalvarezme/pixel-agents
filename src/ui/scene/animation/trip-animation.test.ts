import { describe, expect, it } from 'vitest';
import {
  advanceTripAnimations,
  applyTripOverlay,
  createTripAnimatorState,
  getTripOverlay,
  interpolatePath,
  WALK_DURATION_MS,
  DOCK_DURATION_MS,
} from './trip-animation';
import type { OfficeViewModel, WorkerViewModel } from '../../state/office-view-model';

function workerWithTrip(overrides: Partial<WorkerViewModel> = {}): WorkerViewModel {
  return {
    sessionKey: 'claude-code:s1',
    harness: 'claude-code',
    label: 'my-session',
    x: 100,
    y: 100,
    archiveTrip: { path: [{ x: 100, y: 100 }, { x: 100, y: 1000 }, { x: 1720, y: 1000 }, { x: 1720, y: 540 }], carryCount: 1 },
    ...overrides,
  };
}

describe('interpolatePath — pure position-at-time-t arithmetic', () => {
  const path = [
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 10, y: 10 },
  ];

  it('returns the first point at progress 0', () => {
    expect(interpolatePath(path, 0)).toEqual({ x: 0, y: 0 });
  });

  it('returns the last point at progress 1', () => {
    expect(interpolatePath(path, 1)).toEqual({ x: 10, y: 10 });
  });

  it('returns a point strictly between segment endpoints at a midpoint progress', () => {
    // Total length is 20 (10 + 10). Progress 0.25 -> 5 units in -> still on the first segment.
    expect(interpolatePath(path, 0.25)).toEqual({ x: 0, y: 5 });
  });

  it('clamps progress above 1 to the final point (adversarial: no overshoot)', () => {
    expect(interpolatePath(path, 1.5)).toEqual({ x: 10, y: 10 });
  });

  it('clamps negative progress to the first point', () => {
    expect(interpolatePath(path, -0.5)).toEqual({ x: 0, y: 0 });
  });
});

describe('advanceTripAnimations — fake-clock phase transitions', () => {
  it('starts a new active trip the first time a worker carries an archiveTrip', () => {
    const state = createTripAnimatorState();
    const { state: next } = advanceTripAnimations(state, [workerWithTrip()], 0);

    expect(next.active.has('claude-code:s1')).toBe(true);
    expect(next.active.get('claude-code:s1')?.phase).toBe('walking-out');
  });

  // Adversarial twin: a worker with NO archiveTrip must never get an active entry — proves the
  // guard actually reads `worker.archiveTrip`, not "every worker".
  it('does NOT start a trip for a worker with no archiveTrip', () => {
    const state = createTripAnimatorState();
    const plainWorker: WorkerViewModel = { sessionKey: 'claude-code:idle', harness: 'claude-code', label: 'idle', x: 0, y: 0 };

    const { state: next } = advanceTripAnimations(state, [plainWorker], 0);

    expect(next.active.size).toBe(0);
  });

  it('does not restart an already-active trip on a later tick (resumes, never resets)', () => {
    const state = createTripAnimatorState();
    const first = advanceTripAnimations(state, [workerWithTrip()], 0).state;
    const second = advanceTripAnimations(first, [workerWithTrip()], 100);

    // phaseStartedAt is unchanged: the SAME trip is still walking-out, not a fresh one at t=100.
    expect(second.state.active.get('claude-code:s1')?.phase).toBe('walking-out');
    expect(second.state.active.get('claude-code:s1')?.phaseStartedAt).toBe(0);
  });

  it('transitions walking-out -> at-archive once WALK_DURATION_MS elapses, incrementing archivedCount exactly once', () => {
    const state = createTripAnimatorState();
    const started = advanceTripAnimations(state, [workerWithTrip()], 0).state;

    const arrived = advanceTripAnimations(started, [workerWithTrip()], WALK_DURATION_MS);

    expect(arrived.state.active.get('claude-code:s1')?.phase).toBe('at-archive');
    expect(arrived.state.archivedCount).toBe(1);
  });

  // Adversarial twin: BEFORE the walk duration elapses, the trip must still be walking-out and
  // the counter must still be 0 — proves the transition is time-gated, not immediate.
  it('does NOT transition or increment the counter before WALK_DURATION_MS elapses', () => {
    const state = createTripAnimatorState();
    const started = advanceTripAnimations(state, [workerWithTrip()], 0).state;

    const stillWalking = advanceTripAnimations(started, [workerWithTrip()], WALK_DURATION_MS - 1);

    expect(stillWalking.state.active.get('claude-code:s1')?.phase).toBe('walking-out');
    expect(stillWalking.state.archivedCount).toBe(0);
  });

  it('completes the round trip (walking-out -> at-archive -> walking-back -> gone) and reports it in `completed`', () => {
    const state = createTripAnimatorState();
    let s = advanceTripAnimations(state, [workerWithTrip()], 0).state;
    s = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS).state;
    s = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS + DOCK_DURATION_MS).state;

    const result = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS + DOCK_DURATION_MS + WALK_DURATION_MS);

    expect(result.completed).toEqual(['claude-code:s1']);
    expect(result.state.active.has('claude-code:s1')).toBe(false);
  });

  it('collapses multiple elapsed phases correctly in a single large time jump', () => {
    // One call jumping straight past all three phase durations must land in the same completed
    // state as three incremental calls (proves the internal stepping loop, not just per-tick math).
    const state = createTripAnimatorState();
    const started = advanceTripAnimations(state, [workerWithTrip()], 0).state;

    const result = advanceTripAnimations(started, [workerWithTrip()], WALK_DURATION_MS * 2 + DOCK_DURATION_MS + 1);

    expect(result.completed).toEqual(['claude-code:s1']);
    expect(result.state.archivedCount).toBe(1);
  });

  // Task 21.4 (render trigger): any harness's memory_write must drive the identical animation
  // trigger — this function never inspects `harness` at all.
  it('starts an identical trip for an antigravity worker, proving the trigger never branches on harness', () => {
    const state = createTripAnimatorState();
    const antigravityWorker = workerWithTrip({ sessionKey: 'antigravity:cli:s1', harness: 'antigravity' });

    const { state: next } = advanceTripAnimations(state, [antigravityWorker], 0);

    expect(next.active.get('antigravity:cli:s1')?.phase).toBe('walking-out');
  });
});

describe('getTripOverlay — the currently-rendered position/highlight for an active trip', () => {
  it('returns null for a session with no active trip', () => {
    const state = createTripAnimatorState();
    expect(getTripOverlay(state, 'claude-code:s1', 0)).toBeNull();
  });

  it('is at the path start, not highlighted, while walking-out', () => {
    const state = createTripAnimatorState();
    const started = advanceTripAnimations(state, [workerWithTrip()], 0).state;

    const overlay = getTripOverlay(started, 'claude-code:s1', 0);

    expect(overlay).toMatchObject({ x: 100, y: 100, highlight: false, showDocument: true });
  });

  it('is at the archive destination and highlighted while at-archive', () => {
    const state = createTripAnimatorState();
    let s = advanceTripAnimations(state, [workerWithTrip()], 0).state;
    s = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS).state;

    const overlay = getTripOverlay(s, 'claude-code:s1', WALK_DURATION_MS);

    expect(overlay).toMatchObject({ x: 1720, y: 540, highlight: true, showDocument: true });
  });

  it('is not highlighted again while walking back', () => {
    const state = createTripAnimatorState();
    let s = advanceTripAnimations(state, [workerWithTrip()], 0).state;
    s = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS).state;
    s = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS + DOCK_DURATION_MS).state;

    const overlay = getTripOverlay(s, 'claude-code:s1', WALK_DURATION_MS + DOCK_DURATION_MS);

    expect(overlay).toMatchObject({ x: 1720, y: 540, highlight: false, showDocument: true });
  });

  // Movement animations: "including which way it is facing". The v2 pack draws four directions,
  // and the route to the archive is a dogleg (`archive-path.ts`: down into the corridor, along it,
  // up to the cabinet) — so the drawn direction has to follow the CURRENT leg, not the straight
  // line between the trip's two ends.
  describe('direction — follows the current leg of the route, not the straight line', () => {
    it('heads down the first leg, which descends from the desk into the corridor', () => {
      const state = createTripAnimatorState();
      const started = advanceTripAnimations(state, [workerWithTrip()], 0).state;

      const overlay = getTripOverlay(started, 'claude-code:s1', 0);

      expect(overlay?.direction).toBe('down');
    });

    it('turns to walk along the corridor once it reaches it', () => {
      // Half way along the path is deep inside the long horizontal leg (900 units down, then 1620
      // across): a reading taken from the trip's endpoints alone would still say "down" here.
      const started = advanceTripAnimations(createTripAnimatorState(), [workerWithTrip()], 0).state;

      const overlay = getTripOverlay(started, 'claude-code:s1', WALK_DURATION_MS / 2);

      expect(overlay?.direction).toBe('right');
    });

    // The decisive case: BOTH legs of the trip occupy the exact same stretch of floor (the path
    // is retraced), so a naive "current position" read would give the same answer for both — the
    // direction must actually reverse once the trip does.
    it('reverses once the trip turns around (walking-back)', () => {
      const state = createTripAnimatorState();
      let s = advanceTripAnimations(state, [workerWithTrip()], 0).state;
      s = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS).state;
      s = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS + DOCK_DURATION_MS).state;

      const outbound = getTripOverlay(s, 'claude-code:s1', WALK_DURATION_MS + DOCK_DURATION_MS + WALK_DURATION_MS / 2);

      expect(outbound?.direction).toBe('left');
    });

    it('reports a defined direction while dwelling at the archive', () => {
      const state = createTripAnimatorState();
      let s = advanceTripAnimations(state, [workerWithTrip()], 0).state;
      s = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS).state;

      const overlay = getTripOverlay(s, 'claude-code:s1', WALK_DURATION_MS);

      // The last leg rises from the corridor to the cabinet.
      expect(overlay?.direction).toBe('up');
    });

    // Adversarial twin: a trip walking the OPPOSITE way along the corridor must report the
    // opposite direction, proving this reads the path rather than being hardcoded to "right".
    it('walks left along the corridor when the desk sits to the right of the archive', () => {
      const reversedPathWorker = workerWithTrip({
        archiveTrip: { path: [{ x: 1720, y: 100 }, { x: 1720, y: 1000 }, { x: 100, y: 1000 }, { x: 100, y: 540 }], carryCount: 1 },
      });
      const state = createTripAnimatorState();
      const started = advanceTripAnimations(state, [reversedPathWorker], 0).state;

      const overlay = getTripOverlay(started, 'claude-code:s1', WALK_DURATION_MS / 2);

      expect(overlay?.direction).toBe('left');
    });
  });
});

describe('applyTripOverlay — overlays animated position/highlight onto an OfficeViewModel', () => {
  it('leaves a worker with no active trip completely unchanged', () => {
    const animatorState = createTripAnimatorState();
    const viewModel: OfficeViewModel = { workers: [{ sessionKey: 'claude-code:s1', harness: 'claude-code', label: 'x', x: 5, y: 5 }], overflowCount: 0 };

    const overlaid = applyTripOverlay(viewModel, animatorState, 0);

    expect(overlaid.workers[0]).toEqual(viewModel.workers[0]);
    expect(overlaid.archiveCount).toBe(0);
  });

  it('overrides x/y with the interpolated position for a worker with an active trip', () => {
    const started = advanceTripAnimations(createTripAnimatorState(), [workerWithTrip()], 0).state;
    const midway = advanceTripAnimations(started, [workerWithTrip()], WALK_DURATION_MS / 2).state;
    const viewModel: OfficeViewModel = { workers: [workerWithTrip()], overflowCount: 0 };

    const overlaid = applyTripOverlay(viewModel, midway, WALK_DURATION_MS / 2);

    expect(overlaid.workers[0]!.x).not.toBe(100);
    expect(overlaid.workers[0]!.archiveTrip?.showDocument).toBe(true);
  });

  it('reports the animator-tracked archiveCount, incrementing after a trip reaches the archive', () => {
    let s = advanceTripAnimations(createTripAnimatorState(), [workerWithTrip()], 0).state;
    s = advanceTripAnimations(s, [workerWithTrip()], WALK_DURATION_MS).state;
    const viewModel: OfficeViewModel = { workers: [workerWithTrip()], overflowCount: 0 };

    const overlaid = applyTripOverlay(viewModel, s, WALK_DURATION_MS);

    expect(overlaid.archiveCount).toBe(1);
  });

  it('carries the resolved direction through onto the overlaid worker\'s archiveTrip', () => {
    const started = advanceTripAnimations(createTripAnimatorState(), [workerWithTrip()], 0).state;
    const viewModel: OfficeViewModel = { workers: [workerWithTrip()], overflowCount: 0 };

    const overlaid = applyTripOverlay(viewModel, started, 0);

    expect(overlaid.workers[0]!.archiveTrip?.direction).toBe('down');
  });

  // Character animation frames (ui/scene/character/animation-clock.ts) need the same clock the
  // walk-position interpolation above already uses — carried through as `now` so the pixi
  // renderer never has to invent its own clock.
  it('carries the animation clock through as `now`, for frame-based character animation', () => {
    const viewModel: OfficeViewModel = { workers: [], overflowCount: 0 };

    expect(applyTripOverlay(viewModel, createTripAnimatorState(), 0).now).toBe(0);
    expect(applyTripOverlay(viewModel, createTripAnimatorState(), 4200).now).toBe(4200);
  });
});

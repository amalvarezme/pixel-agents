import { describe, expect, it } from 'vitest';
import {
  advanceEndedWorkerDwells,
  applyEndedWorkerDwellOverlay,
  clearEndedWorkerDwell,
  createEndedWorkerDwellState,
  ENDED_WORKER_DWELL_MS,
  noteEndedWorker,
} from './ended-worker-dwell';
import type { WorkerViewModel } from '../../state/office-view-model';

function worker(overrides: Partial<WorkerViewModel> = {}): WorkerViewModel {
  return {
    sessionKey: 'pi:task:t1',
    harness: 'pi',
    label: 'child-task',
    x: 100,
    y: 100,
    seatX: 100,
    seatY: 100,
    ...overrides,
  };
}

describe('ENDED_WORKER_DWELL_MS', () => {
  it('is a bounded, positive dwell — not an indefinite ghost', () => {
    expect(ENDED_WORKER_DWELL_MS).toBeGreaterThan(0);
  });
});

// Rule 1: only a worker whose LAST KNOWN lifecycle maps to the existing failure presentation
// dwells. The mapping is `resolveLifecyclePresentation`'s, never re-derived here — these tests pin
// the reuse indirectly, by picking lifecycles that the presentation maps to `failed`.
describe('noteEndedWorker — recording a dwell', () => {
  it('records a dwell for a worker whose lifecycle maps to the failure indicator', () => {
    const state = noteEndedWorker(createEndedWorkerDwellState(), worker({ lifecycle: 'failed' }), 1_000);

    expect(state.active.get('pi:task:t1')?.startedAt).toBe(1_000);
    expect(state.active.get('pi:task:t1')?.worker.lifecycle).toBe('failed');
  });

  // Triangulation: `timed_out` is the other lifecycle the presentation flags as a failure, so it
  // must dwell too, through the SAME mapping rather than a second hardcoded list.
  it('records a dwell for timed_out as well — the other failure presentation', () => {
    const state = noteEndedWorker(createEndedWorkerDwellState(), worker({ lifecycle: 'timed_out' }), 1_000);

    expect(state.active.has('pi:task:t1')).toBe(true);
  });

  // Rule 2, adversarial twin: a cancellation was someone's choice, not a fault.
  it('never dwells a cancelled worker', () => {
    const state = noteEndedWorker(createEndedWorkerDwellState(), worker({ lifecycle: 'cancelled' }), 1_000);

    expect(state.active.size).toBe(0);
  });

  // Triangulation for rule 2: an ordinary successful end has nothing to report either.
  it('never dwells a completed worker', () => {
    const state = noteEndedWorker(createEndedWorkerDwellState(), worker({ lifecycle: 'completed' }), 1_000);

    expect(state.active.size).toBe(0);
  });

  // Rule 3: this is the `SessionLifecycleCoordinator` eviction shape — no lifecycle was ever
  // reported, so there is no failure to make visible.
  it('never dwells a worker with no lifecycle at all', () => {
    const state = noteEndedWorker(createEndedWorkerDwellState(), worker(), 1_000);

    expect(state.active.size).toBe(0);
  });

  it('records nothing when the end names a worker the container never saw', () => {
    const state = noteEndedWorker(createEndedWorkerDwellState(), undefined, 1_000);

    expect(state.active.size).toBe(0);
  });
});

describe('applyEndedWorkerDwellOverlay — visibility and expiry', () => {
  it('re-appends the captured worker, marked as dwelling, for the whole dwell window', () => {
    const captured = worker({ lifecycle: 'failed' });
    const state = noteEndedWorker(createEndedWorkerDwellState(), captured, 1_000);

    const atStart = applyEndedWorkerDwellOverlay([], state, 1_000);
    expect(atStart.map((w) => w.sessionKey)).toEqual(['pi:task:t1']);
    expect(atStart[0]?.lifecycle).toBe('failed');
    expect(atStart[0]?.endedDwell).toBe(true);

    const justBeforeExpiry = applyEndedWorkerDwellOverlay([], state, 1_000 + ENDED_WORKER_DWELL_MS - 1);
    expect(justBeforeExpiry).toHaveLength(1);
  });

  it('drops the worker at expiry', () => {
    const state = noteEndedWorker(createEndedWorkerDwellState(), worker({ lifecycle: 'failed' }), 1_000);

    expect(applyEndedWorkerDwellOverlay([], state, 1_000 + ENDED_WORKER_DWELL_MS)).toEqual([]);
  });

  // Preserved behaviour: with nothing dwelling, the overlay is the identity function — a worker
  // with no lifecycle, a sofa visitor and a filing worker all pass through untouched.
  it('leaves an ordinary worker list untouched when nothing is dwelling', () => {
    const alive = worker({ sessionKey: 'claude-code:s1' });
    const result = applyEndedWorkerDwellOverlay([alive], createEndedWorkerDwellState(), 5_000);

    expect(result).toEqual([alive]);
  });

  it('never renders a second copy of a worker that is already back on the floor', () => {
    const captured = worker({ lifecycle: 'failed' });
    const state = noteEndedWorker(createEndedWorkerDwellState(), captured, 1_000);

    expect(applyEndedWorkerDwellOverlay([captured], state, 1_000)).toHaveLength(1);
  });
});

// Risk 2: the ghost exists so a human can SEE the failure. It must not simultaneously claim the
// dead worker is mid-carry to the archive or sitting at the sofa — both are contradicting claims
// about an agent that is gone, and a worker that has ended carries nothing.
describe('applyEndedWorkerDwellOverlay — the ghost shows structural state only', () => {
  it('strips every render-half overlay marker from the captured frame', () => {
    const captured = worker({
      lifecycle: 'failed',
      archiveTrip: {
        path: [{ x: 100, y: 100 }, { x: 1010, y: 455 }],
        carryCount: 2,
        highlight: true,
        showDocument: true,
        direction: 'left',
      },
      sofaVisit: { seated: true, direction: 'right' },
    });
    const state = noteEndedWorker(createEndedWorkerDwellState(), captured, 1_000);

    const [ghost] = applyEndedWorkerDwellOverlay([], state, 1_000);

    expect(ghost?.archiveTrip).toBeUndefined();
    expect(ghost?.sofaVisit).toBeUndefined();
    // ...while the structural state and, above all, the failure indicator survive.
    expect(ghost?.lifecycle).toBe('failed');
    expect(ghost?.x).toBe(100);
    expect(ghost?.seatX).toBe(100);
    expect(ghost?.label).toBe('child-task');
    expect(ghost?.endedDwell).toBe(true);
  });

  // Triangulation: the strip happens on the RECORDED frame, not only on the emitted one, so a
  // ghost cannot carry a stale overlay even if it is emitted on a later render.
  it('strips the markers even when the ghost is emitted long after it was recorded', () => {
    const captured = worker({
      lifecycle: 'failed',
      archiveTrip: { path: [{ x: 100, y: 100 }, { x: 1010, y: 455 }], carryCount: 1 },
    });
    const state = noteEndedWorker(createEndedWorkerDwellState(), captured, 1_000);

    const [ghost] = applyEndedWorkerDwellOverlay([], state, 1_000 + ENDED_WORKER_DWELL_MS - 1);

    expect(ghost?.archiveTrip).toBeUndefined();
    expect(ghost?.lifecycle).toBe('failed');
  });
});

describe('advanceEndedWorkerDwells — the dwell container stops growing', () => {
  it('forgets an expired dwell while keeping a still-dwelling one', () => {
    let state = createEndedWorkerDwellState();
    state = noteEndedWorker(state, worker({ sessionKey: 'pi:task:old', lifecycle: 'failed' }), 1_000);
    state = noteEndedWorker(state, worker({ sessionKey: 'pi:task:new', lifecycle: 'failed' }), 2_000);

    const next = advanceEndedWorkerDwells(state, 1_000 + ENDED_WORKER_DWELL_MS);

    expect(next.active.has('pi:task:old')).toBe(false);
    expect(next.active.has('pi:task:new')).toBe(true);
  });
});

// Rule 4: `SessionLifecycleCoordinator` re-admits an evicted session under the same key.
describe('clearEndedWorkerDwell', () => {
  it('a re-admitted session_start clears the dwell for the same sessionKey', () => {
    const state = noteEndedWorker(createEndedWorkerDwellState(), worker({ lifecycle: 'failed' }), 1_000);

    expect(clearEndedWorkerDwell(state, 'pi:task:t1').active.size).toBe(0);
  });

  it('clearing an unrelated key leaves the dwell alone', () => {
    const state = noteEndedWorker(createEndedWorkerDwellState(), worker({ lifecycle: 'failed' }), 1_000);

    expect(clearEndedWorkerDwell(state, 'pi:task:other').active.size).toBe(1);
  });
});

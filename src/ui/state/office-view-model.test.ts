import { describe, expect, it } from 'vitest';
import { applyEventToOfficeState, createOfficeState } from '../../domain/office/office';
import type { AgentEvent, HarnessId } from '../../domain/events/types';
import { buildOfficeViewModel } from './office-view-model';
import { PERSISTENT_MEMORY } from '../scene/world/office-map';
import { MAX_SEATED_WORKERS } from '../scene/layout/office-layout';

function sessionStart(id: number, sessionKey: string, label?: string): AgentEvent {
  return { id, kind: 'session_start', harness: 'claude-code', sessionKey, at: id, label };
}

function sessionStartFor(id: number, harness: HarnessId, sessionKey: string, label?: string): AgentEvent {
  return { id, kind: 'session_start', harness, sessionKey, at: id, label };
}

function parent(id: number, sessionKey: string, correlationId: string): AgentEvent {
  return { id, kind: 'parent', harness: 'claude-code', sessionKey, at: id, correlationId };
}

function memoryWrite(id: number, harness: HarnessId, sessionKey: string, at: number): AgentEvent {
  return { id, kind: 'memory_write', harness, sessionKey, at, toolLabel: 'mem_save' };
}

describe('buildOfficeViewModel (tasks.md 10.4 client projection)', () => {
  it('projects an empty office to an empty view model', () => {
    const vm = buildOfficeViewModel(createOfficeState());
    expect(vm.workers).toEqual([]);
    expect(vm.overflowCount).toBe(0);
  });

  it('projects one active worker with its resolved layout position and label', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1', 'my-session'));

    const vm = buildOfficeViewModel(state);

    expect(vm.workers).toHaveLength(1);
    expect(vm.workers[0]).toMatchObject({ sessionKey: 'claude-code:s1', label: 'my-session' });
    expect(typeof vm.workers[0]!.x).toBe('number');
    expect(typeof vm.workers[0]!.y).toBe('number');
  });

  // The room's desks belong to the artwork, so a subagent no longer gets a lane of its own — but
  // it must still get its own workstation rather than sharing its parent's.
  it('seats a child worker at its own workstation, never on top of its parent', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:parent1'));
    state = applyEventToOfficeState(state, sessionStart(2, 'claude-code:child1'));
    state = applyEventToOfficeState(state, parent(3, 'claude-code:child1', 'claude-code:parent1'));

    const vm = buildOfficeViewModel(state);

    const parentVm = vm.workers.find((w) => w.sessionKey === 'claude-code:parent1');
    const childVm = vm.workers.find((w) => w.sessionKey === 'claude-code:child1');
    expect(parentVm?.stationId).toBeDefined();
    expect(childVm?.stationId).not.toBe(parentVm?.stationId);
    expect({ x: childVm?.x, y: childVm?.y }).not.toEqual({ x: parentVm?.x, y: parentVm?.y });
  });

  it('renders three unrelated sessions from three different harnesses as distinct, non-overlapping workers (office-scene-renderer spec: Multi-Agent Layout, cross-harness)', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStartFor(1, 'claude-code', 'claude-code:s1'));
    state = applyEventToOfficeState(state, sessionStartFor(2, 'codex', 'codex:s2'));
    state = applyEventToOfficeState(state, sessionStartFor(3, 'antigravity', 'antigravity:cli:s3'));

    const vm = buildOfficeViewModel(state);

    expect(vm.workers).toHaveLength(3);
    expect(vm.workers.map((w) => w.harness).sort()).toEqual(['antigravity', 'claude-code', 'codex']);

    // Non-overlapping: every worker occupies a distinct (x, y) position.
    const positions = vm.workers.map((w) => `${w.x},${w.y}`);
    expect(new Set(positions).size).toBe(3);
  });

  it('has no archiveTrip for a worker that never received a memory_write', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));

    const vm = buildOfficeViewModel(state);

    expect(vm.workers[0]!.archiveTrip).toBeUndefined();
  });

  // Task 21.3: a memory_write event for S1 animates a path to the fixed archive destination
  // (office-scene-renderer spec: "Archive Destination Rendering").
  it('projects an archiveTrip path ending at the fixed archive destination once memory_write arrives', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));
    state = applyEventToOfficeState(state, memoryWrite(2, 'claude-code', 'claude-code:s1', 1000));

    const vm = buildOfficeViewModel(state);
    const worker = vm.workers.find((w) => w.sessionKey === 'claude-code:s1')!;

    expect(worker.archiveTrip).toBeDefined();
    expect(worker.archiveTrip!.path[0]).toEqual({ x: worker.x, y: worker.y });
    expect(worker.archiveTrip!.path[worker.archiveTrip!.path.length - 1]).toEqual(PERSISTENT_MEMORY.anchor);
    expect(worker.archiveTrip!.carryCount).toBe(1);
  });

  // Task 21.4: any harness's memory_write (incl. antigravity) triggers the identical animation
  // path — the projection never branches on `harness`.
  it('produces the identical archive path shape for every harness, from an antigravity memory_write too', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStartFor(1, 'antigravity', 'antigravity:cli:s1'));
    state = applyEventToOfficeState(state, memoryWrite(2, 'antigravity', 'antigravity:cli:s1', 1000));

    const vm = buildOfficeViewModel(state);
    const worker = vm.workers.find((w) => w.sessionKey === 'antigravity:cli:s1')!;

    expect(worker.archiveTrip!.path[worker.archiveTrip!.path.length - 1]).toEqual(PERSISTENT_MEMORY.anchor);
  });
});

// Agent profile tracking: carries the domain's `Worker.agentProfile` straight through to the
// view model, same shape as toolLabel/toolDetail already do.
describe('buildOfficeViewModel — agent profile tracking', () => {
  it('carries a resolved agentProfile through onto the view model worker', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1000,
      agentProfile: { role: 'subagent', agentType: 'sdd-apply', model: 'sonnet', task: 'Apply slice 2' },
    });

    const vm = buildOfficeViewModel(state);

    expect(vm.workers[0]!.agentProfile).toEqual({ role: 'subagent', agentType: 'sdd-apply', model: 'sonnet', task: 'Apply slice 2' });
  });

  // Adversarial near-miss: a worker with no agentProfile at all must not gain one out of nowhere.
  it('has no agentProfile when the worker has none', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));

    const vm = buildOfficeViewModel(state);

    expect(vm.workers[0]!.agentProfile).toBeUndefined();
  });
});

// Associated-project tracking: carries `domain/office/office.ts`'s `Worker.projectPath` through
// to the view model, same shape as agentProfile above.
describe('buildOfficeViewModel — project path tracking', () => {
  it('carries a known projectPath through onto the view model worker', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1000,
      projectPath: '/Users/andresalvarez/Documents/pixel-agents',
    });

    const vm = buildOfficeViewModel(state);

    expect(vm.workers[0]!.projectPath).toBe('/Users/andresalvarez/Documents/pixel-agents');
  });

  // Adversarial near-miss: a worker with no projectPath at all must not gain one out of nowhere.
  it('has no projectPath when the worker has none', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));

    const vm = buildOfficeViewModel(state);

    expect(vm.workers[0]!.projectPath).toBeUndefined();
  });
});

// Character animation states (idle/working/walking) select from the worker's `activity` — this
// carries `domain/office/office.ts`'s `Worker.activity` through, same shape as agentProfile above.
describe('buildOfficeViewModel — worker activity', () => {
  it('carries the worker activity through onto the view model', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));

    const vm = buildOfficeViewModel(state);

    expect(vm.workers[0]!.activity).toBe('working');
  });
});

/**
 * The room has only `MAX_SEATED_WORKERS` workstations, and `workers` is capped at that —
 * everything past it used to survive only as a bare `overflowCount`, with no record of WHICH
 * sessions were dropped. Any consumer reporting on who is active (the project roster panel) has to
 * see all of them, which is what `roster` is for.
 */
describe('buildOfficeViewModel roster', () => {
  function stateWith(count: number, projectPath?: string) {
    let state = createOfficeState();
    for (let i = 0; i < count; i++) {
      state = applyEventToOfficeState(state, {
        id: i + 1,
        kind: 'session_start',
        harness: 'claude-code',
        sessionKey: `claude-code:s${i}`,
        at: 0,
        ...(projectPath ? { projectPath } : {}),
      });
    }
    return state;
  }

  it('lists every worker, including the ones with no workstation', () => {
    const total = MAX_SEATED_WORKERS + 4;
    const viewModel = buildOfficeViewModel(stateWith(total));

    expect(viewModel.workers).toHaveLength(MAX_SEATED_WORKERS);
    expect(viewModel.overflowCount).toBe(4);
    expect(viewModel.roster).toHaveLength(total);
  });

  it('carries the fields the roster panel groups and counts by', () => {
    const viewModel = buildOfficeViewModel(stateWith(1, '/Users/me/pixel-agents'));

    expect(viewModel.roster?.[0]).toMatchObject({
      sessionKey: 'claude-code:s0',
      harness: 'claude-code',
      projectPath: '/Users/me/pixel-agents',
      activity: 'working',
    });
  });

  it('matches the worker list exactly when nothing overflows', () => {
    const viewModel = buildOfficeViewModel(stateWith(3));

    expect(viewModel.roster?.map((entry) => entry.sessionKey)).toEqual(
      viewModel.workers.map((worker) => worker.sessionKey),
    );
  });
});

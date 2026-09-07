import { describe, expect, it } from 'vitest';
import { applyEventToOfficeState, createOfficeState } from '../../domain/office/office';
import type { AgentEvent } from '../../domain/events/types';
import { buildOfficeViewModel } from './office-view-model';

function sessionStart(id: number, sessionKey: string, label?: string): AgentEvent {
  return { id, kind: 'session_start', harness: 'claude-code', sessionKey, at: id, label };
}

function parent(id: number, sessionKey: string, correlationId: string): AgentEvent {
  return { id, kind: 'parent', harness: 'claude-code', sessionKey, at: id, correlationId };
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
    expect(vm.workers[0]).toMatchObject({ sessionKey: 'claude-code:s1', label: 'my-session', lane: 'root' });
    expect(typeof vm.workers[0]!.x).toBe('number');
    expect(typeof vm.workers[0]!.y).toBe('number');
  });

  it('projects a child worker into the child lane, distinct from its parent', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:parent1'));
    state = applyEventToOfficeState(state, sessionStart(2, 'claude-code:child1'));
    state = applyEventToOfficeState(state, parent(3, 'claude-code:child1', 'claude-code:parent1'));

    const vm = buildOfficeViewModel(state);

    const parentVm = vm.workers.find((w) => w.sessionKey === 'claude-code:parent1');
    const childVm = vm.workers.find((w) => w.sessionKey === 'claude-code:child1');
    expect(parentVm?.lane).toBe('root');
    expect(childVm?.lane).toBe('child');
    expect(childVm?.y).not.toBe(parentVm?.y);
  });
});

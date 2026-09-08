import { describe, expect, it } from 'vitest';
import { applyEventToOfficeState, createOfficeState } from './office';
import type { AgentEvent } from '../events/types';

describe('applyEventToOfficeState (office-scene-renderer spec: Per-Agent Worker Mapping, Parent/Child Lane Layout)', () => {
  it('adds a worker on session_start', () => {
    const state = createOfficeState();
    const event: AgentEvent = {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1000,
      label: 'my-session',
    };

    const next = applyEventToOfficeState(state, event);

    expect(next.workers.has('claude-code:s1')).toBe(true);
    expect(next.workers.get('claude-code:s1')).toMatchObject({
      sessionKey: 'claude-code:s1',
      harness: 'claude-code',
      label: 'my-session',
      activity: 'working',
      parentSessionKey: null,
    });
  });

  it('removes the worker on session_end', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1000,
    });
    expect(state.workers.has('claude-code:s1')).toBe(true);

    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'session_end',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 2000,
    });

    expect(state.workers.has('claude-code:s1')).toBe(false);
  });

  it('records the parent correlation from a parent event correlationId, not a harness-specific field', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:parent1',
      at: 1000,
    });
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:child1',
      at: 1000,
    });

    state = applyEventToOfficeState(state, {
      id: 3,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:child1',
      at: 1500,
      correlationId: 'claude-code:parent1',
    });

    expect(state.workers.get('claude-code:child1')?.parentSessionKey).toBe('claude-code:parent1');
    expect(state.workers.get('claude-code:parent1')?.parentSessionKey).toBeNull();
  });

  it('a parent event arriving before the child worker exists still creates the worker (no event ever dropped)', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:child1',
      at: 1000,
      correlationId: 'claude-code:parent1',
      label: 'child-label',
    });

    expect(state.workers.get('claude-code:child1')).toMatchObject({
      sessionKey: 'claude-code:child1',
      parentSessionKey: 'claude-code:parent1',
      label: 'child-label',
    });
  });

  it('updates the worker label from a later event without disturbing its parent correlation', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1000,
      label: 'agent-unknown',
    });
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1200,
      correlationId: 'claude-code:root',
    });
    state = applyEventToOfficeState(state, {
      id: 3,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1300,
      label: 'resolved-label',
    });

    const worker = state.workers.get('claude-code:s1');
    expect(worker?.label).toBe('resolved-label');
    expect(worker?.parentSessionKey).toBe('claude-code:root');
  });
});

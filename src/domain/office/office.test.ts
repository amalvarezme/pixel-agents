import { describe, expect, it } from 'vitest';
import { applyEventToOfficeState, completeArchiveTripForWorker, createOfficeState } from './office';
import type { AgentEvent } from '../events/types';

function sessionStart(id: number, sessionKey: string): AgentEvent {
  return { id, kind: 'session_start', harness: 'claude-code', sessionKey, at: id };
}

function memoryWrite(id: number, sessionKey: string, at: number): AgentEvent {
  return {
    id,
    kind: 'memory_write',
    harness: 'claude-code',
    sessionKey,
    at,
    toolLabel: 'mem_save',
  };
}

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

  // Task 21.5: normalized {toolLabel, toolDetail} carried through the same generic branch as
  // `label` already is above — no harness-specific handling added here either.
  it('carries a tool_start toolLabel/toolDetail pair onto the worker', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1000,
    });
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1100,
      toolLabel: 'Read',
      toolDetail: 'design.md',
    });

    const worker = state.workers.get('claude-code:s1');
    expect(worker?.toolLabel).toBe('Read');
    expect(worker?.toolDetail).toBe('design.md');
  });
});

describe('applyEventToOfficeState — memory_write drives the carry queue and archive docking (design.md: "animation is a lagging view, ingestion never blocks")', () => {
  it('a memory_write for an existing worker starts a held carry and docks it', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));

    state = applyEventToOfficeState(state, memoryWrite(2, 'claude-code:s1', 1000));

    expect(state.carryQueues.get('claude-code:s1')?.held).toMatchObject({ count: 1 });
    expect(state.archive.slots.some((s) => s.occupiedBySessionKey === 'claude-code:s1')).toBe(true);
  });

  it('a memory_write for a session with no known worker is a safe no-op (spec: "worker currently at its default position")', () => {
    const state = createOfficeState();

    const next = applyEventToOfficeState(state, memoryWrite(1, 'claude-code:ghost', 1000));

    expect(next.carryQueues.has('claude-code:ghost')).toBe(false);
    expect(next.archive.slots.every((s) => s.occupiedBySessionKey === null)).toBe(true);
  });

  // Task 20.4 (cross-worker concurrency), exercised through the full event fold: 5 simultaneous
  // memory_write events for 5 different workers — 4 dock immediately, 1 waits.
  it('5 simultaneous memory_write events across 5 workers dock 4 immediately and queue the 5th', () => {
    let state = createOfficeState();
    for (const worker of ['w1', 'w2', 'w3', 'w4', 'w5']) {
      state = applyEventToOfficeState(state, sessionStart(1, worker));
    }

    for (const worker of ['w1', 'w2', 'w3', 'w4', 'w5']) {
      state = applyEventToOfficeState(state, memoryWrite(2, worker, 1000));
    }

    const dockedCount = state.archive.slots.filter((s) => s.occupiedBySessionKey !== null).length;
    expect(dockedCount).toBe(4);
    expect(state.archive.waitQueue.map((w) => w.sessionKey)).toEqual(['w5']);
  });

  // Adversarial boundary twin: exactly 4 concurrent workers must all dock, none waiting.
  it('4 simultaneous memory_write events across 4 workers all dock, none wait', () => {
    let state = createOfficeState();
    for (const worker of ['w1', 'w2', 'w3', 'w4']) {
      state = applyEventToOfficeState(state, sessionStart(1, worker));
    }

    for (const worker of ['w1', 'w2', 'w3', 'w4']) {
      state = applyEventToOfficeState(state, memoryWrite(2, worker, 1000));
    }

    expect(state.archive.waitQueue).toEqual([]);
  });

  it('a second memory_write for the SAME worker while it is already carrying does not request a second dock', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));
    state = applyEventToOfficeState(state, memoryWrite(2, 'claude-code:s1', 1000));
    const dockedAfterFirst = state.archive.slots.filter((s) => s.occupiedBySessionKey !== null).length;

    state = applyEventToOfficeState(state, memoryWrite(3, 'claude-code:s1', 1001));

    const dockedAfterSecond = state.archive.slots.filter((s) => s.occupiedBySessionKey !== null).length;
    expect(dockedAfterSecond).toBe(dockedAfterFirst);
    expect(state.carryQueues.get('claude-code:s1')?.queued).toHaveLength(1);
  });

  it('completeArchiveTripForWorker advances the carry queue and releases the dock once nothing is left held', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));
    state = applyEventToOfficeState(state, memoryWrite(2, 'claude-code:s1', 1000));

    state = completeArchiveTripForWorker(state, 'claude-code:s1', 2000);

    expect(state.carryQueues.get('claude-code:s1')?.held).toBeNull();
    expect(state.archive.slots.every((s) => s.occupiedBySessionKey !== 'claude-code:s1')).toBe(true);
  });

  it('completeArchiveTripForWorker keeps the dock when a queued job is promoted to held', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));
    state = applyEventToOfficeState(state, memoryWrite(2, 'claude-code:s1', 1000));
    state = applyEventToOfficeState(state, memoryWrite(3, 'claude-code:s1', 1001));

    state = completeArchiveTripForWorker(state, 'claude-code:s1', 2000);

    expect(state.carryQueues.get('claude-code:s1')?.held).toMatchObject({ count: 1 });
    expect(state.archive.slots.some((s) => s.occupiedBySessionKey === 'claude-code:s1')).toBe(true);
  });

  // "Ingestion never blocks" (design.md): a burst of memory_write events for one worker, well
  // past the batch-collapse threshold, applies fully and synchronously — the fold never awaits
  // or depends on `completeArchiveTripForWorker` (the animation-completion side) being called.
  it('ingesting a large burst of memory_write events never blocks on archive-animation completion', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));

    let result: unknown;
    for (let i = 0; i < 500; i++) {
      result = applyEventToOfficeState(state, memoryWrite(i + 2, 'claude-code:s1', 1000 + i));
      state = result as typeof state;
    }

    expect(result).not.toBeInstanceOf(Promise);
    expect(state.carryQueues.get('claude-code:s1')?.batch).toMatchObject({ count: 499 });
  });
});

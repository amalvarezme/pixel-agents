import { describe, expect, it } from 'vitest';
import {
  applyEventToOfficeState,
  completeArchiveTripForWorker,
  createOfficeState,
  deserializeOfficeState,
  serializeOfficeState,
} from './office';
import type { AgentEvent } from '../events/types';
import { DEFAULT_ORPHAN_GRACE_MS } from '../agents/agent-tree';

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

  it('a parent event arriving before the child worker exists does NOT create a worker (an edge is not a discovery)', () => {
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

    expect(state.workers.has('claude-code:child1')).toBe(false);
  });

  // This is the real ordering from live streams: `parent` arrives BEFORE the child's own
  // `session_start` (subagent-correlation-coordinator publishes the edge from the parent's
  // transcript before the child transcript is even opened). A test that sends session_start
  // FIRST would pass even with the old conjuring bug, because the worker already exists by the
  // time `parent` is applied — it would not discriminate at all.
  it('a parent edge held pending is applied once the child session_start actually arrives', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:child1',
      at: 1000,
      correlationId: 'claude-code:parent1',
    });
    expect(state.workers.has('claude-code:child1')).toBe(false);

    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:child1',
      at: 1050,
      label: 'child-label',
    });

    expect(state.workers.get('claude-code:child1')).toMatchObject({
      sessionKey: 'claude-code:child1',
      parentSessionKey: 'claude-code:parent1',
      label: 'child-label',
    });
  });

  // Adversarial near-miss of the guard above: without a PRIOR `parent` edge, a plain
  // `session_start` must still produce a root worker (parentSessionKey: null) — proving the
  // pending-edge application is conditional on an actual held claim, not applied unconditionally.
  it('adversarial near-miss: a session_start with no prior parent edge stays a root worker', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:solo1',
      at: 1000,
      label: 'solo-label',
    });

    expect(state.workers.get('claude-code:solo1')).toMatchObject({
      sessionKey: 'claude-code:solo1',
      parentSessionKey: null,
      label: 'solo-label',
    });
  });

  // Mirrors agent-tree.ts's `promoteOrphans`: a claim whose child never shows up must not linger
  // forever. Reuses the same grace-period concept (`DEFAULT_ORPHAN_GRACE_MS`) rather than a
  // second, unrelated timeout.
  it('an unmatched parent edge expires after the orphan grace period — the child never appears', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:orphan1',
      at: 1000,
      correlationId: 'claude-code:parent1',
    });

    // A later, unrelated event ticks the fold's notion of "now" well past the grace window.
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:other',
      at: 1000 + DEFAULT_ORPHAN_GRACE_MS + 1,
    });

    // The orphan's own session_start finally shows up — but too late, the claim already expired,
    // so it must land as a plain root worker, not retroactively parented.
    state = applyEventToOfficeState(state, {
      id: 3,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orphan1',
      at: 1000 + DEFAULT_ORPHAN_GRACE_MS + 2,
      label: 'orphan-label',
    });

    expect(state.workers.get('claude-code:orphan1')).toMatchObject({
      sessionKey: 'claude-code:orphan1',
      parentSessionKey: null,
    });
  });

  // Adversarial near-miss of the expiry guard: the exact same claim, but the child's
  // session_start arrives WELL WITHIN the grace period — it must still resolve to parented.
  // Differs from the expiry test in exactly the elapsed-time property under test.
  it('adversarial near-miss: a parent edge still resolves when the child arrives within the grace period', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:child2',
      at: 1000,
      correlationId: 'claude-code:parent1',
    });

    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:child2',
      at: 1000 + DEFAULT_ORPHAN_GRACE_MS - 1,
      label: 'child2-label',
    });

    expect(state.workers.get('claude-code:child2')).toMatchObject({
      sessionKey: 'claude-code:child2',
      parentSessionKey: 'claude-code:parent1',
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

// Agent profile tracking: what a worker IS (orchestrator vs subagent), what MODEL it runs, and
// what TASK it was given. Carried on the shared envelope (`agentProfile`), never a harness special
// case — attached at session_start (baseline role) and enriched later via a `parent` event
// (subagent profile join) or a default-branch event (orchestrator's own message.model).
describe('applyEventToOfficeState — agent profile tracking', () => {
  it('stamps the baseline role from session_start', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orch1',
      at: 1000,
      agentProfile: { role: 'orchestrator' },
    });

    expect(state.workers.get('claude-code:orch1')?.agentProfile).toEqual({ role: 'orchestrator' });
  });

  // The orchestrator is distinguishable from its subagents purely from role — no other field is
  // required for this guard to hold.
  it('a root worker with no agentProfile at all stays undefined, never defaulted to a role', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:plain1',
      at: 1000,
    });

    expect(state.workers.get('claude-code:plain1')?.agentProfile).toBeUndefined();
  });

  it('enriches an existing worker with a subagent profile from a parent event, without disturbing its parentSessionKey', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:child1',
      at: 1000,
      agentProfile: { role: 'subagent' },
    });
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:child1',
      at: 1500,
      correlationId: 'claude-code:parent1',
    });

    state = applyEventToOfficeState(state, {
      id: 3,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:child1',
      at: 2000,
      agentProfile: { role: 'subagent', agentType: 'sdd-apply', model: 'sonnet', task: 'Apply slice 2' },
    });

    const worker = state.workers.get('claude-code:child1');
    expect(worker?.parentSessionKey).toBe('claude-code:parent1');
    expect(worker?.agentProfile).toEqual({ role: 'subagent', agentType: 'sdd-apply', model: 'sonnet', task: 'Apply slice 2' });
  });

  // Real ordering: the profile-only `parent` event (no correlationId at all) arrives BEFORE the
  // child's own session_start — must buffer, never conjure a worker (same guard the correlation
  // edge already has, now proven for a profile-only edge too).
  it('a profile-only parent event (no correlationId) arriving before the child exists does NOT create a worker', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:child2',
      at: 1000,
      agentProfile: { role: 'subagent', agentType: 'jd-judge-a', model: 'opus', task: 'Judge' },
    });

    expect(state.workers.has('claude-code:child2')).toBe(false);

    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:child2',
      at: 1050,
      agentProfile: { role: 'subagent' },
    });

    expect(state.workers.get('claude-code:child2')?.agentProfile).toEqual({
      role: 'subagent',
      agentType: 'jd-judge-a',
      model: 'opus',
      task: 'Judge',
    });
  });

  it('adds the orchestrator model from a later tool_start event without losing the role already set', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orch2',
      at: 1000,
      agentProfile: { role: 'orchestrator' },
    });

    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orch2',
      at: 1100,
      label: 'orch2',
      toolLabel: 'Read',
      agentProfile: { role: 'orchestrator', model: 'claude-opus-5' },
    });

    expect(state.workers.get('claude-code:orch2')?.agentProfile).toEqual({ role: 'orchestrator', model: 'claude-opus-5' });
  });

  // Adversarial near-miss: a subagent profile missing `model` must leave it absent, never
  // defaulted to some placeholder string.
  it('a subagent profile missing model leaves model absent rather than defaulting it', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:child3',
      at: 1000,
      agentProfile: { role: 'subagent' },
    });
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:child3',
      at: 1500,
      agentProfile: { role: 'subagent', agentType: 'sdd-tasks', task: 'Break down change' },
    });

    const profile = state.workers.get('claude-code:child3')?.agentProfile;
    expect(profile).toEqual({ role: 'subagent', agentType: 'sdd-tasks', task: 'Break down change' });
    expect(profile?.model).toBeUndefined();
  });

  // Model is a LIVE, time-varying observation (a session can switch model mid-run via /model or
  // a fast-mode toggle) — the fold must report the LATEST observed value, never the first.
  it('a model switch (opus -> sonnet) reports the latest value, not the first one seen', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orch3',
      at: 1000,
      agentProfile: { role: 'orchestrator' },
    });
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orch3',
      at: 1100,
      agentProfile: { role: 'orchestrator', model: 'claude-opus-5' },
    });
    state = applyEventToOfficeState(state, {
      id: 3,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orch3',
      at: 1200,
      agentProfile: { role: 'orchestrator', model: 'claude-sonnet-5' },
    });

    expect(state.workers.get('claude-code:orch3')?.agentProfile?.model).toBe('claude-sonnet-5');
  });

  // Adversarial near-miss of the switch guard: a later event with NO agentProfile at all (e.g. a
  // record whose message.model was the "<synthetic>" sentinel, filtered upstream in parse.ts)
  // must leave the already-tracked model untouched, never clear or corrupt it.
  it('a later event carrying no agentProfile at all leaves the previously tracked model untouched', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orch4',
      at: 1000,
      agentProfile: { role: 'orchestrator' },
    });
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orch4',
      at: 1100,
      agentProfile: { role: 'orchestrator', model: 'claude-opus-5' },
    });
    state = applyEventToOfficeState(state, {
      id: 3,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:orch4',
      at: 1200,
      label: 'plain-tool-event',
    });

    expect(state.workers.get('claude-code:orch4')?.agentProfile).toEqual({ role: 'orchestrator', model: 'claude-opus-5' });
  });

  // The requested launch alias and the resolved live model are DISTINCT fields that must never be
  // conflated: a subagent launched with alias "sonnet" (via the parent's Agent tool_use, joined
  // through a `parent` event) whose OWN transcript later reports the resolved "claude-sonnet-5"
  // must end up with BOTH fields present and distinct.
  it('keeps the requested launch alias and the resolved live model as distinct fields', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:child4',
      at: 1000,
      agentProfile: { role: 'subagent' },
    });
    // The launch join (subagent-correlation-coordinator.ts's publishProfile): requestedModel only.
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:child4',
      at: 1500,
      agentProfile: { role: 'subagent', agentType: 'sdd-apply', requestedModel: 'sonnet', task: 'Apply slice 2' },
    });
    // The subagent's OWN transcript later reports the resolved model.
    state = applyEventToOfficeState(state, {
      id: 3,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:child4',
      at: 2000,
      agentProfile: { role: 'subagent', model: 'claude-sonnet-5' },
    });

    expect(state.workers.get('claude-code:child4')?.agentProfile).toEqual({
      role: 'subagent',
      agentType: 'sdd-apply',
      requestedModel: 'sonnet',
      task: 'Apply slice 2',
      model: 'claude-sonnet-5',
    });
  });
});

// Associated-project tracking: the working directory an ingestion adapter observed for a session
// (`AgentEventBase.projectPath`), carried onto `Worker.projectPath` with the same merge-not-
// replace discipline already proven for `agentProfile` above.
describe('applyEventToOfficeState — project path tracking', () => {
  it('records projectPath from session_start', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:proj1',
      at: 1000,
      projectPath: '/Users/andresalvarez/Documents/pixel-agents',
    });

    expect(state.workers.get('claude-code:proj1')?.projectPath).toBe('/Users/andresalvarez/Documents/pixel-agents');
  });

  it('a root worker with no projectPath at all stays undefined, never invented', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:proj-none',
      at: 1000,
    });

    expect(state.workers.get('claude-code:proj-none')?.projectPath).toBeUndefined();
  });

  // Adversarial twin (merge-not-replace, mirrors the agentProfile guard above): a LATER event
  // that carries no projectPath at all must leave the already-known project untouched, never
  // clear it.
  it('a later event carrying no projectPath at all leaves the previously known project untouched', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:proj2',
      at: 1000,
      projectPath: '/Users/andresalvarez/Documents/pixel-agents',
    });
    state = applyEventToOfficeState(state, {
      id: 2,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:proj2',
      at: 1100,
      label: 'plain-tool-event',
    });

    expect(state.workers.get('claude-code:proj2')?.projectPath).toBe('/Users/andresalvarez/Documents/pixel-agents');
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

// G.1: "A client connecting AFTER memory_write events have been ingested sees the workers but
// Archived: 0" — the snapshot frame must carry archive + carry-queue state, not just workers.
// `OfficeState.carryQueues` is a `Map`, which is not directly JSON-serializable (`JSON.stringify`
// silently produces `{}`), so this wire shape is arrays of entries, converted by one pure
// round-trip pair reused verbatim by both the SSE server and the browser client projection.
describe('serializeOfficeState / deserializeOfficeState (G.1: snapshot wire shape round trip)', () => {
  it('round-trips a non-zero, non-one archive count so a late-connecting client reconstructs it exactly', () => {
    let state = createOfficeState();
    for (const worker of ['w1', 'w2', 'w3']) {
      state = applyEventToOfficeState(state, sessionStart(1, worker));
      state = applyEventToOfficeState(state, memoryWrite(2, worker, 1000));
    }
    const dockedBefore = state.archive.slots.filter((s) => s.occupiedBySessionKey !== null).length;
    expect(dockedBefore).toBe(3); // deliberately not 0, not 1 — cannot pass by accident

    const restored = deserializeOfficeState(serializeOfficeState(state));

    const dockedAfter = restored.archive.slots.filter((s) => s.occupiedBySessionKey !== null).length;
    expect(dockedAfter).toBe(3);
    expect(dockedAfter).not.toBe(0);
    expect(dockedAfter).not.toBe(1);
  });

  // Adversarial near-miss: the PRE-FIX wire shape (`{ workers }` only, exactly what `buildSnapshot`
  // used to return) must reconstruct a ZERO archive count. This proves the round-trip test above
  // actually exercises the fix — a snapshot missing archive/carryQueues is observably different.
  it('adversarial near-miss: a workers-only snapshot (the pre-fix shape) reconstructs a ZERO archive count', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));
    state = applyEventToOfficeState(state, memoryWrite(2, 'claude-code:s1', 1000));
    expect(state.archive.slots.some((s) => s.occupiedBySessionKey !== null)).toBe(true);

    const preFixWire = { workers: [...state.workers.values()] };
    const restored = deserializeOfficeState(preFixWire);

    expect(restored.archive.slots.every((s) => s.occupiedBySessionKey === null)).toBe(true);
  });

  it('round-trips an in-flight carry queue (held + one queued) for a worker', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));
    state = applyEventToOfficeState(state, memoryWrite(2, 'claude-code:s1', 1000));
    state = applyEventToOfficeState(state, memoryWrite(3, 'claude-code:s1', 1001));

    const restored = deserializeOfficeState(serializeOfficeState(state));

    expect(restored.carryQueues.get('claude-code:s1')?.held).toMatchObject({ count: 1 });
    expect(restored.carryQueues.get('claude-code:s1')?.queued).toHaveLength(1);
  });

  it('produces a JSON-safe wire shape — no Map survives an actual JSON.stringify/parse round trip', () => {
    let state = createOfficeState();
    state = applyEventToOfficeState(state, sessionStart(1, 'claude-code:s1'));
    state = applyEventToOfficeState(state, memoryWrite(2, 'claude-code:s1', 1000));

    const wireBytes = JSON.stringify(serializeOfficeState(state));
    const restored = deserializeOfficeState(JSON.parse(wireBytes));

    expect(restored.carryQueues.get('claude-code:s1')?.held).toMatchObject({ count: 1 });
    expect(restored.archive.slots.some((s) => s.occupiedBySessionKey === 'claude-code:s1')).toBe(true);
  });
});

/**
 * The idle announcement from `adapters/driven/sessions/session-lifecycle-coordinator.ts` is the
 * ONLY path in the whole system that can move a worker out of `'working'` — every other branch
 * either defaults the field to `'working'` or preserves whatever is already there. Before it
 * existed, `Worker.activity` was write-once and every worker on the floor was drawn as actively
 * typing no matter how long its transcript had been untouched.
 */
describe('applyEventToOfficeState worker activity', () => {
  function started(sessionKey: string): AgentEvent {
    return { id: 1, kind: 'session_start', harness: 'claude-code', sessionKey, at: 0 };
  }
  function activityStatus(sessionKey: string, activity: 'working' | 'idle', at: number, id = 2): AgentEvent {
    return { id, kind: 'status', harness: 'claude-code', sessionKey, at, activity };
  }

  it('marks a worker idle when a status event announces it', () => {
    let state = applyEventToOfficeState(createOfficeState(), started('claude-code:s1'));
    expect(state.workers.get('claude-code:s1')?.activity).toBe('working');

    state = applyEventToOfficeState(state, activityStatus('claude-code:s1', 'idle', 1000));

    expect(state.workers.get('claude-code:s1')?.activity).toBe('idle');
  });

  it('brings an idle worker back to working when the announcement reverses', () => {
    let state = applyEventToOfficeState(createOfficeState(), started('claude-code:s1'));
    state = applyEventToOfficeState(state, activityStatus('claude-code:s1', 'idle', 1000));
    state = applyEventToOfficeState(state, activityStatus('claude-code:s1', 'working', 2000, 3));

    expect(state.workers.get('claude-code:s1')?.activity).toBe('working');
  });

  it('keeps a worker idle across later events that carry no activity of their own', () => {
    let state = applyEventToOfficeState(createOfficeState(), started('claude-code:s1'));
    state = applyEventToOfficeState(state, activityStatus('claude-code:s1', 'idle', 1000));
    state = applyEventToOfficeState(state, {
      id: 4,
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 2000,
      toolLabel: 'Bash',
    });

    // The lifecycle coordinator owns the transition back to work and announces it separately; a
    // caption update must never silently resurrect a worker's activity as a side effect.
    expect(state.workers.get('claude-code:s1')?.activity).toBe('idle');
  });

  it('never conjures a worker from an activity announcement for an unknown session', () => {
    const state = applyEventToOfficeState(createOfficeState(), activityStatus('claude-code:ghost', 'idle', 1000));

    expect(state.workers.size).toBe(0);
  });
});

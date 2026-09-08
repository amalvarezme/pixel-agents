/**
 * OpenCode session-row mapping: parent/child correlation + worker label resolution
 * (tasks.md 18.6, 18.7; spec: "OpenCode uses first-class agent column as label", office-scene-
 * renderer spec: "Parent/Child Lane Layout"). `session.parent_id` needs no fallback edge (design.md
 * "Correlation and the Agent Tree": "first-class column ... none needed") — a single mapping
 * function can emit both `session_start` and `parent` synchronously.
 */
import { describe, expect, it } from 'vitest';
import { applyEventToOfficeState, createOfficeState } from '../../../domain/office/office';
import {
  mapOpenCodeSessionToEvents,
  openCodeSessionKey,
  parseOpenCodePartData,
  resolveOpenCodeWorkerLabel,
  type OpenCodeSessionRow,
} from './parse';

function allocator(): () => number {
  let next = 1;
  return () => next++;
}

describe('resolveOpenCodeWorkerLabel (tasks.md 18.6)', () => {
  it('uses session.agent as the label when present (spec: "OpenCode uses first-class agent column as label")', () => {
    const label = resolveOpenCodeWorkerLabel({ id: 'ses_1', title: 'Fase 0: Observador ingesta insumos', agent: 'observador' });
    expect(label).toBe('observador');
  });

  it('falls back to title, then a deterministic session-<shortId> label, when agent is absent', () => {
    expect(resolveOpenCodeWorkerLabel({ id: 'ses_1', title: 'Extract graph chunk 1', agent: null })).toBe(
      'Extract graph chunk 1',
    );
    expect(resolveOpenCodeWorkerLabel({ id: 'ses_0fe19e81', title: '', agent: null })).toBe('session-ses_0fe1');
  });
});

describe('mapOpenCodeSessionToEvents (tasks.md 18.6, 18.7)', () => {
  it('emits only a session_start event for a root session (no parent_id)', () => {
    const session: OpenCodeSessionRow = { id: 'ses_parent1', parent_id: null, title: 'root', agent: 'general' };

    const events = mapOpenCodeSessionToEvents(session, { allocateId: allocator(), at: 1000 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'session_start', harness: 'opencode', sessionKey: 'opencode:ses_parent1', label: 'general' });
  });

  it('emits session_start AND a parent event carrying correlationId = the parent session key', () => {
    const session: OpenCodeSessionRow = {
      id: 'ses_child1',
      parent_id: 'ses_parent1',
      title: 'Fase 0: Observador ingesta insumos (@observador subagent)',
      agent: 'observador',
    };

    const events = mapOpenCodeSessionToEvents(session, { allocateId: allocator(), at: 1500 });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'session_start', sessionKey: 'opencode:ses_child1', label: 'observador' });
    expect(events[1]).toMatchObject({
      kind: 'parent',
      sessionKey: 'opencode:ses_child1',
      correlationId: 'opencode:ses_parent1',
    });
  });

  it('drives office-scene-renderer lane assignment: the child ends up correlated to its parent, distinct from an unrelated third session', () => {
    const parent: OpenCodeSessionRow = { id: 'ses_parent1', parent_id: null, title: 'root', agent: 'general' };
    const child: OpenCodeSessionRow = { id: 'ses_child1', parent_id: 'ses_parent1', title: 'sub', agent: 'observador' };
    const unrelated: OpenCodeSessionRow = { id: 'ses_other', parent_id: null, title: 'other', agent: 'general' };

    const allocateId = allocator();
    let state = createOfficeState();
    for (const event of [
      ...mapOpenCodeSessionToEvents(parent, { allocateId, at: 1000 }),
      ...mapOpenCodeSessionToEvents(child, { allocateId, at: 1000 }),
      ...mapOpenCodeSessionToEvents(unrelated, { allocateId, at: 1000 }),
    ]) {
      state = applyEventToOfficeState(state, event);
    }

    expect(state.workers.get(openCodeSessionKey('ses_child1'))?.parentSessionKey).toBe(openCodeSessionKey('ses_parent1'));
    expect(state.workers.get(openCodeSessionKey('ses_parent1'))?.parentSessionKey).toBeNull();
    expect(state.workers.get(openCodeSessionKey('ses_other'))?.parentSessionKey).toBeNull();
  });
});

describe('parseOpenCodePartData', () => {
  it('parses valid JSON and returns null for malformed input', () => {
    expect(parseOpenCodePartData('{"type":"tool"}')).toEqual({ type: 'tool' });
    expect(parseOpenCodePartData('{not json')).toBeNull();
  });
});

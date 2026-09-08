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
  mapOpenCodePartToEvents,
  mapOpenCodeSessionToEvents,
  openCodeSessionKey,
  parseOpenCodePartData,
  resolveOpenCodeToolCaption,
  resolveOpenCodeWorkerLabel,
  type OpenCodePartRow,
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

describe('resolveOpenCodeToolCaption (design.md "Captions": part.data.tool + state.title when non-empty)', () => {
  it('sources toolLabel from data.tool and toolDetail from state.title', () => {
    const data = parseOpenCodePartData('{"type":"tool","tool":"read","state":{"title":"design.md"}}')!;
    expect(resolveOpenCodeToolCaption(data)).toEqual({ toolLabel: 'read', toolDetail: 'design.md' });
  });

  it('omits toolDetail when state.title is empty or absent', () => {
    const data = parseOpenCodePartData('{"type":"tool","tool":"bash","state":{"title":""}}')!;
    expect(resolveOpenCodeToolCaption(data)).toEqual({ toolLabel: 'bash' });
  });

  it('returns null for a non-tool part', () => {
    const data = parseOpenCodePartData('{"type":"text"}')!;
    expect(resolveOpenCodeToolCaption(data)).toBeNull();
  });
});

describe('mapOpenCodePartToEvents', () => {
  function partRow(data: unknown, sessionId = 'ses_synth0001'): OpenCodePartRow {
    return { id: 'prt_1', message_id: 'msg_1', session_id: sessionId, data: JSON.stringify(data) };
  }

  it('maps a tool part to a tool_start event carrying the normalized caption', () => {
    const row = partRow({ type: 'tool', tool: 'read', state: { title: 'design.md' } });
    const events = mapOpenCodePartToEvents(row, { allocateId: allocator(), at: 2000 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool_start',
      harness: 'opencode',
      sessionKey: 'opencode:ses_synth0001',
      toolLabel: 'read',
      toolDetail: 'design.md',
    });
  });

  it('produces no events for a non-tool part (e.g. type: text)', () => {
    const row = partRow({ type: 'text' });
    expect(mapOpenCodePartToEvents(row, { allocateId: allocator(), at: 2000 })).toEqual([]);
  });

  it('produces no events for a malformed data payload', () => {
    const row: OpenCodePartRow = { id: 'prt_1', message_id: 'msg_1', session_id: 'ses_synth0001', data: '{not json' };
    expect(mapOpenCodePartToEvents(row, { allocateId: allocator(), at: 2000 })).toEqual([]);
  });

  // Blocker B.1 (tasks.md): OpenCodeMemoryWriteDetector exists and is fixture-tested, but nothing
  // ever called it at runtime. This wires it into the same tool-part mapping that already
  // produces tool_start.
  describe('memory_write wiring (blocker B.1, OpenCode)', () => {
    it('emits a memory_write event IN ADDITION TO tool_start for an engram_mem_save part', () => {
      const row = partRow({
        type: 'tool',
        tool: 'engram_mem_save',
        state: { input: { title: 'Synthetic fixture: verified OpenCode Engram wiring', topic_key: 'probe/topic', type: 'discovery' } },
      });
      const events = mapOpenCodePartToEvents(row, { allocateId: allocator(), at: 2000 });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'tool_start', harness: 'opencode' });
      expect(events[1]).toMatchObject({
        kind: 'memory_write',
        harness: 'opencode',
        sessionKey: 'opencode:ses_synth0001',
        title: 'Synthetic fixture: verified OpenCode Engram wiring',
        topicKey: 'probe/topic',
        observationType: 'discovery',
        toolLabel: 'engram_mem_save',
      });
    });

    // Adversarial twin: a similarly-shaped tool part for an unrelated tool (context7's docs
    // query) must emit ONLY tool_start. Proves the wiring is gated on detector.detect(), not
    // merely on seeing a tool-type part.
    it('emits ONLY tool_start for a non-matching tool part (near-miss: context7_query-docs)', () => {
      const row = partRow({ type: 'tool', tool: 'context7_query-docs', state: { input: {} } });
      const events = mapOpenCodePartToEvents(row, { allocateId: allocator(), at: 2000 });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_start' });
      expect(events.some((e) => e.kind === 'memory_write')).toBe(false);
    });

    it('allocates a distinct, monotonically increasing id for the memory_write event after tool_start', () => {
      const row = partRow({ type: 'tool', tool: 'engram_mem_save', state: { input: { title: 'x' } } });
      const events = mapOpenCodePartToEvents(row, { allocateId: allocator(), at: 2000 });

      expect(events.map((e) => e.id)).toEqual([1, 2]);
    });
  });
});

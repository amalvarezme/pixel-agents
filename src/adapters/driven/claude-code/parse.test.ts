import { describe, expect, it } from 'vitest';
import {
  extractAgentIdFromToolUseResult,
  extractToolUseBlocks,
  mapClaudeCodeRecordToEvents,
  parseClaudeCodeLine,
  resolveWorkerLabel,
} from './parse';

describe('parseClaudeCodeLine', () => {
  it('parses a well-formed assistant record', () => {
    const line = '{"type":"assistant","uuid":"u1","message":{"role":"assistant","content":[]}}';
    const record = parseClaudeCodeLine(line);
    expect(record).toEqual({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [] } });
  });

  it('never throws on malformed JSON and returns null instead', () => {
    expect(() => parseClaudeCodeLine('{not valid json')).not.toThrow();
    expect(parseClaudeCodeLine('{not valid json')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parseClaudeCodeLine('')).toBeNull();
  });
});

describe('extractToolUseBlocks', () => {
  it('returns tool_use content blocks from an assistant message', () => {
    const record = parseClaudeCodeLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"t1","name":"Read","input":{"file":"a.ts"}}]}}',
    )!;
    const blocks = extractToolUseBlocks(record);
    expect(blocks).toEqual([{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.ts' } }]);
  });

  it('returns an empty array when the record has no tool_use content', () => {
    const record = parseClaudeCodeLine('{"type":"user","message":{"role":"user","content":"plain text"}}')!;
    expect(extractToolUseBlocks(record)).toEqual([]);
  });
});

describe('extractAgentIdFromToolUseResult', () => {
  it('extracts agentId from toolUseResult when present', () => {
    const record = parseClaudeCodeLine(
      '{"type":"user","toolUseResult":{"agentId":"abc123","description":"Auditar"}}',
    )!;
    expect(extractAgentIdFromToolUseResult(record)).toBe('abc123');
  });

  it('returns null when toolUseResult has no agentId', () => {
    const record = parseClaudeCodeLine('{"type":"user","toolUseResult":{"description":"no agent here"}}')!;
    expect(extractAgentIdFromToolUseResult(record)).toBeNull();
  });

  it('returns null when there is no toolUseResult at all', () => {
    const record = parseClaudeCodeLine('{"type":"user"}')!;
    expect(extractAgentIdFromToolUseResult(record)).toBeNull();
  });
});

describe('resolveWorkerLabel', () => {
  it('prefers attributionAgent when present', () => {
    const record = parseClaudeCodeLine('{"type":"assistant","attributionAgent":"sdd-tasks"}')!;
    expect(resolveWorkerLabel(record, 'abc123')).toBe('sdd-tasks');
  });

  it('falls back to toolUseResult.description when attributionAgent is absent', () => {
    const record = parseClaudeCodeLine('{"type":"user","toolUseResult":{"description":"Auditar rutas"}}')!;
    expect(resolveWorkerLabel(record, 'abc123')).toBe('Auditar rutas');
  });

  it('falls back to a deterministic agent-<shortId> label when neither field is present', () => {
    const record = parseClaudeCodeLine('{"type":"assistant"}')!;
    expect(resolveWorkerLabel(record, 'abc123def456')).toBe('agent-abc123de');
  });

  it('falls back to "agent-unknown" when no field and no agentId are available', () => {
    const record = parseClaudeCodeLine('{"type":"assistant"}')!;
    expect(resolveWorkerLabel(record, null)).toBe('agent-unknown');
  });
});

describe('mapClaudeCodeRecordToEvents', () => {
  function context(sessionKey = 'claude-code:session-abc') {
    let id = 0;
    return { sessionKey, allocateId: () => ++id };
  }

  it('maps a tool_use content block to a tool_start event', () => {
    const record = parseClaudeCodeLine(
      '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
    )!;
    const events = mapClaudeCodeRecordToEvents(record, context());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tool_start', harness: 'claude-code', sessionKey: 'claude-code:session-abc' });
  });

  it('maps a tool_result content block to a tool_end event', () => {
    const record = parseClaudeCodeLine(
      '{"type":"user","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}}',
    )!;
    const events = mapClaudeCodeRecordToEvents(record, context());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tool_end', harness: 'claude-code' });
  });

  it('maps a plain assistant/user record with no tool blocks to a message event', () => {
    const record = parseClaudeCodeLine(
      '{"type":"assistant","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    )!;
    const events = mapClaudeCodeRecordToEvents(record, context());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'message', harness: 'claude-code' });
  });

  it('produces no events for a record with neither tool blocks nor assistant/user text (e.g. system)', () => {
    const record = parseClaudeCodeLine('{"type":"system","timestamp":"2026-01-01T00:00:03.000Z"}')!;
    expect(mapClaudeCodeRecordToEvents(record, context())).toEqual([]);
  });

  it('allocates monotonically increasing ids across multiple events from the same record', () => {
    const record = parseClaudeCodeLine(
      '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}},{"type":"tool_use","id":"t2","name":"Write","input":{}}]}}',
    )!;
    const events = mapClaudeCodeRecordToEvents(record, context());

    expect(events.map((e) => e.id)).toEqual([1, 2]);
  });
});

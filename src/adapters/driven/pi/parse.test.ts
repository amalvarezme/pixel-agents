import { describe, expect, it } from 'vitest';
import {
  classifyPiRecordFamily,
  extractPiRecordModel,
  mapPiRecordToEvents,
  parsePiLine,
  resolvePiToolCaption,
  type PiRecord,
} from './parse';

const ctx = () => {
  let next = 1;
  return { sessionKey: 'pi:s1', allocateId: () => next++, isSubagent: false };
};

/** Real shapes, taken verbatim from `~/.pi/agent/sessions/**` (session version 3). */
const assistantWithToolCall = (name: string, args: Record<string, unknown>, id = 'toolu_01'): PiRecord => ({
  type: 'message',
  id: 'rec1',
  parentId: 'rec0',
  timestamp: '2026-09-27T01:16:58.120Z',
  message: {
    role: 'assistant',
    provider: 'claude-bridge',
    model: 'claude-opus-5',
    content: [{ type: 'toolCall', id, name, arguments: args }],
  },
});

describe('parsePiLine', () => {
  it('parses a well-formed Pi record', () => {
    expect(parsePiLine('{"type":"session","id":"s1","cwd":"/p"}')).toEqual({
      type: 'session',
      id: 's1',
      cwd: '/p',
    });
  });

  it('returns null for a truncated line instead of throwing', () => {
    expect(parsePiLine('{"type":"message","message":{"role":"assis')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parsePiLine('   ')).toBeNull();
  });
});

describe('classifyPiRecordFamily', () => {
  it.each([
    ['session', 'session'],
    ['model_change', 'model_change'],
    ['thinking_level_change', 'thinking_level_change'],
    ['custom', 'custom'],
    ['message', 'message'],
  ])('classifies the %s family', (type, expected) => {
    expect(classifyPiRecordFamily({ type } as PiRecord)).toBe(expected);
  });

  it('returns null for an unknown family (adversarial near-miss)', () => {
    expect(classifyPiRecordFamily({ type: 'compacted' } as PiRecord)).toBeNull();
  });
});

describe('extractPiRecordModel', () => {
  it('reads the live model from a model_change record', () => {
    expect(
      extractPiRecordModel({
        type: 'model_change',
        provider: 'claude-bridge',
        modelId: 'claude-opus-5',
      } as PiRecord),
    ).toBe('claude-opus-5');
  });

  it('reads the live model from an assistant message', () => {
    expect(extractPiRecordModel(assistantWithToolCall('bash', { command: 'ls' }))).toBe('claude-opus-5');
  });

  it('leaves the model absent when the record carries none, never defaulting one', () => {
    expect(extractPiRecordModel({ type: 'thinking_level_change' } as PiRecord)).toBeUndefined();
  });
});

describe('resolvePiToolCaption', () => {
  it('captions a bash call with a bounded command head', () => {
    const caption = resolvePiToolCaption({ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'git log --oneline' } });

    expect(caption).toEqual({ toolLabel: 'bash', toolDetail: 'git log --oneline' });
  });

  it('truncates an overlong command head rather than carrying the whole command', () => {
    const command = 'echo '.repeat(100);
    const caption = resolvePiToolCaption({ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command } });

    expect(caption?.toolDetail?.length).toBeLessThanOrEqual(61);
    expect(caption?.toolDetail?.endsWith('…')).toBe(true);
  });

  it('captions a file tool with its path', () => {
    expect(resolvePiToolCaption({ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'src/server.ts' } })).toEqual({
      toolLabel: 'read',
      toolDetail: 'src/server.ts',
    });
  });

  it('carries a label with no detail when no known detail argument is present', () => {
    expect(resolvePiToolCaption({ type: 'toolCall', id: 'c1', name: 'todo', arguments: { action: 'list' } })).toEqual({
      toolLabel: 'todo',
    });
  });
});

describe('mapPiRecordToEvents', () => {
  it('maps an assistant toolCall to tool_start with its caption and the live model', () => {
    const events = mapPiRecordToEvents(assistantWithToolCall('bash', { command: 'git log' }), ctx());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool_start',
      harness: 'pi',
      sessionKey: 'pi:s1',
      at: Date.parse('2026-09-27T01:16:58.120Z'),
      toolLabel: 'bash',
      toolDetail: 'git log',
      agentProfile: { role: 'orchestrator', model: 'claude-opus-5' },
    });
  });

  it('maps a toolResult to tool_end, naming the tool the result belongs to', () => {
    const record: PiRecord = {
      type: 'message',
      id: 'rec2',
      timestamp: '2026-09-27T01:17:00.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'toolu_01',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
      },
    };

    const events = mapPiRecordToEvents(record, ctx());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tool_end', harness: 'pi', toolLabel: 'bash' });
  });

  it('maps two toolCalls in one assistant turn to two tool_start events with distinct ids', () => {
    const record = assistantWithToolCall('bash', { command: 'ls' });
    (record.message!.content as unknown[]).push({ type: 'toolCall', id: 'toolu_02', name: 'read', arguments: { path: 'a.ts' } });

    const events = mapPiRecordToEvents(record, ctx());

    expect(events.map((e) => e.toolLabel)).toEqual(['bash', 'read']);
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it('maps a text-only assistant turn to one message event', () => {
    const record: PiRecord = {
      type: 'message',
      id: 'rec3',
      timestamp: '2026-09-27T01:18:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }] },
    };

    const events = mapPiRecordToEvents(record, ctx());

    expect(events.map((e) => e.kind)).toEqual(['message']);
  });

  it('maps a thinking-only assistant turn to one message event, not a tool event', () => {
    const record: PiRecord = {
      type: 'message',
      id: 'rec4',
      timestamp: '2026-09-27T01:18:00.000Z',
      message: { role: 'assistant', content: [{ type: 'thinking', text: 'considering' }] },
    };

    expect(mapPiRecordToEvents(record, ctx()).map((e) => e.kind)).toEqual(['message']);
  });

  it('yields nothing for a system message', () => {
    const record: PiRecord = {
      type: 'message',
      id: 'rec5',
      timestamp: '2026-09-27T01:18:00.000Z',
      message: { role: 'system', content: [] },
    };

    expect(mapPiRecordToEvents(record, ctx())).toEqual([]);
  });

  it('yields nothing for the session-worktree custom record (triangulation: a non-event family)', () => {
    const record: PiRecord = {
      type: 'custom',
      customType: 'gentle-pi.session-worktree/v1',
      id: 'rec6',
      timestamp: '2026-09-27T01:15:56.960Z',
      data: { sessionId: 's1', root: '/p', evidence: 'session:cwd' },
    };

    expect(mapPiRecordToEvents(record, ctx())).toEqual([]);
  });

  // Spec: "Pi memory_write Detection" — memory_write is emitted ALONGSIDE tool_start.
  it('emits memory_write alongside tool_start for a mem_save call', () => {
    const record = assistantWithToolCall('mem_save', {
      title: 'Decision X',
      topic_key: 'pi/portability',
      type: 'decision',
    });

    const events = mapPiRecordToEvents(record, ctx());

    expect(events.map((e) => e.kind)).toEqual(['tool_start', 'memory_write']);
    expect(events[1]).toMatchObject({
      kind: 'memory_write',
      harness: 'pi',
      title: 'Decision X',
      topicKey: 'pi/portability',
      observationType: 'decision',
      toolLabel: 'mem_save',
    });
  });

  it('emits only tool_start for a non-memory tool call', () => {
    const events = mapPiRecordToEvents(assistantWithToolCall('bash', { command: 'ls' }), ctx());

    expect(events.map((e) => e.kind)).toEqual(['tool_start']);
  });

  it('tags a subagent context with role subagent rather than orchestrator', () => {
    const events = mapPiRecordToEvents(assistantWithToolCall('bash', { command: 'ls' }), {
      sessionKey: 'pi:task:t1',
      allocateId: () => 1,
      isSubagent: true,
    });

    expect(events[0]?.agentProfile).toMatchObject({ role: 'subagent' });
  });
});

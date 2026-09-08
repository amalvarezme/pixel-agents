import { describe, expect, it } from 'vitest';
import {
  dequoteOnce,
  extractCallMcpToolSignal,
  extractToolCalls,
  mapAntigravityRecordToEvents,
  parseAntigravityLine,
  parseCallMcpToolArguments,
  resolveAntigravityToolCaption,
  resolveAntigravityWorkerLabel,
} from './parse';

describe('parseAntigravityLine', () => {
  it('parses a well-formed PLANNER_RESPONSE record', () => {
    const line = '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE"}';
    expect(parseAntigravityLine(line)).toEqual({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE' });
  });

  it('never throws on malformed JSON and returns null instead', () => {
    expect(() => parseAntigravityLine('{not valid json')).not.toThrow();
    expect(parseAntigravityLine('{not valid json')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parseAntigravityLine('')).toBeNull();
  });
});

describe('extractToolCalls', () => {
  it('returns the tool_calls array when present', () => {
    const record = parseAntigravityLine('{"type":"PLANNER_RESPONSE","tool_calls":[{"name":"list_dir","args":{}}]}')!;
    expect(extractToolCalls(record)).toEqual([{ name: 'list_dir', args: {} }]);
  });

  it('returns an empty array when tool_calls is absent', () => {
    const record = parseAntigravityLine('{"type":"USER_QUERY"}')!;
    expect(extractToolCalls(record)).toEqual([]);
  });
});

describe('dequoteOnce (proves the double-decode is mandatory, spec: memory-write-visualization)', () => {
  it('strips exactly one layer of literal surrounding quote characters', () => {
    // The raw value is the 8-character string `"engram"`, quotes included — not the bare word.
    expect(dequoteOnce('"engram"')).toBe('engram');
  });

  it('a naive equality check against the raw quoted value is false — this is why de-quoting is mandatory', () => {
    const raw: string = '"engram"';
    expect(raw === 'engram').toBe(false);
    expect(dequoteOnce(raw) === 'engram').toBe(true);
  });

  it('returns the value unchanged when it has no surrounding quotes', () => {
    expect(dequoteOnce('engram')).toBe('engram');
  });

  it('returns undefined for a non-string value', () => {
    expect(dequoteOnce(undefined)).toBeUndefined();
    expect(dequoteOnce(42)).toBeUndefined();
  });
});

describe('extractCallMcpToolSignal', () => {
  it('de-quotes ServerName/ToolName/toolAction/toolSummary and passes Arguments through as a raw string', () => {
    const toolCall = {
      name: 'call_mcp_tool',
      args: {
        ServerName: '"engram"',
        ToolName: '"mem_save"',
        Arguments: '{"title":"x"}',
        toolAction: '"Saving probe memory to Engram"',
        toolSummary: '"Engram probe memory save"',
      },
    };
    expect(extractCallMcpToolSignal(toolCall)).toEqual({
      server: 'engram',
      tool: 'mem_save',
      argumentsRaw: '{"title":"x"}',
      toolAction: 'Saving probe memory to Engram',
      toolSummary: 'Engram probe memory save',
    });
  });

  it('returns null for a non-call_mcp_tool tool call (e.g. an IDE-native editor action)', () => {
    expect(extractCallMcpToolSignal({ name: 'list_dir', args: { DirectoryPath: '"/tmp"' } })).toBeNull();
  });
});

describe('parseCallMcpToolArguments (second JSON.parse of the Arguments string)', () => {
  it('parses a well-formed JSON-encoded arguments string', () => {
    expect(parseCallMcpToolArguments('{"title":"x","topic_key":"a/b"}')).toEqual({ title: 'x', topic_key: 'a/b' });
  });

  it('returns null for malformed JSON', () => {
    expect(parseCallMcpToolArguments('{not valid')).toBeNull();
  });
});

describe('resolveAntigravityWorkerLabel (office-scene-renderer spec: Worker Label Resolution, Antigravity)', () => {
  it('de-quotes toolAction as the label and toolSummary as the detail', () => {
    const toolCall = {
      name: 'call_mcp_tool',
      args: { toolAction: '"Saving probe memory to Engram"', toolSummary: '"Engram probe memory save"' },
    };
    expect(resolveAntigravityWorkerLabel(toolCall)).toEqual({
      label: 'Saving probe memory to Engram',
      detail: 'Engram probe memory save',
    });
  });

  it('works for any tool call, not only call_mcp_tool (e.g. an IDE-native editor action)', () => {
    const toolCall = { name: 'list_dir', args: { toolAction: '"Listing workspace directory"', toolSummary: '"Workspace directory listing"' } };
    expect(resolveAntigravityWorkerLabel(toolCall)).toEqual({
      label: 'Listing workspace directory',
      detail: 'Workspace directory listing',
    });
  });

  it('falls back to a deterministic default label when toolAction is absent', () => {
    const toolCall = { name: 'call_mcp_tool', args: {} };
    expect(resolveAntigravityWorkerLabel(toolCall)).toEqual({ label: 'antigravity-agent', detail: undefined });
  });
});

describe('resolveAntigravityToolCaption (design.md "Captions": de-quoted toolAction/toolSummary)', () => {
  it('sources toolLabel/toolDetail from the same de-quoted toolAction/toolSummary pair as the worker label', () => {
    const toolCall = {
      name: 'call_mcp_tool',
      args: { toolAction: '"Saving probe memory to Engram"', toolSummary: '"Engram probe memory save"' },
    };
    expect(resolveAntigravityToolCaption(toolCall)).toEqual({
      toolLabel: 'Saving probe memory to Engram',
      toolDetail: 'Engram probe memory save',
    });
  });
});

describe('mapAntigravityRecordToEvents', () => {
  function context(sessionKey = 'antigravity:cli:abc-123') {
    let id = 0;
    return { sessionKey, allocateId: () => ++id };
  }

  it('maps a tool_calls[] entry to a tool_start event carrying the de-quoted caption', () => {
    const record = parseAntigravityLine(
      '{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-06-15T20:23:35Z","tool_calls":[{"name":"list_dir","args":{"toolAction":"\\"Listing workspace directory\\"","toolSummary":"\\"Workspace directory listing\\""}}]}',
    )!;
    const events = mapAntigravityRecordToEvents(record, context());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool_start',
      harness: 'antigravity',
      sessionKey: 'antigravity:cli:abc-123',
      label: 'Listing workspace directory',
      toolLabel: 'Listing workspace directory',
      toolDetail: 'Workspace directory listing',
    });
  });

  it('maps a record with no tool_calls but non-empty thinking text to a message event', () => {
    const record = parseAntigravityLine(
      '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-06-15T20:23:00Z","thinking":"Reviewing the request."}',
    )!;
    const events = mapAntigravityRecordToEvents(record, context());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'message', harness: 'antigravity' });
  });

  it('produces no events for a record with neither tool_calls nor thinking text', () => {
    const record = parseAntigravityLine('{"step_index":2,"source":"USER","type":"USER_QUERY"}')!;
    expect(mapAntigravityRecordToEvents(record, context())).toEqual([]);
  });

  it('maps multiple tool_calls[] entries to one tool_start event each, in order', () => {
    const record = parseAntigravityLine(
      '{"type":"PLANNER_RESPONSE","tool_calls":[{"name":"list_dir","args":{"toolAction":"\\"A\\""}},{"name":"read_file","args":{"toolAction":"\\"B\\""}}]}',
    )!;
    const events = mapAntigravityRecordToEvents(record, context());

    expect(events.map((e) => e.toolLabel)).toEqual(['A', 'B']);
  });

  // Blocker B.1 (tasks.md): AntigravityMemoryWriteDetector exists and is fixture-tested, but
  // nothing ever called it at runtime. This wires it into the same tool_calls[] loop that already
  // produces tool_start.
  describe('memory_write wiring (blocker B.1, Antigravity)', () => {
    it('emits a memory_write event IN ADDITION TO tool_start for a de-quoted engram/mem_save call_mcp_tool', () => {
      const record = parseAntigravityLine(
        '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-24T10:00:00Z","tool_calls":[{"name":"call_mcp_tool","args":{"Arguments":"{\\"title\\":\\"antigravity-mcp-probe\\",\\"topic_key\\":\\"probe/topic\\",\\"type\\":\\"discovery\\"}","ServerName":"\\"engram\\"","ToolName":"\\"mem_save\\"","toolAction":"\\"Saving probe memory to Engram\\"","toolSummary":"\\"Engram probe memory save\\""}}]}',
      )!;
      const events = mapAntigravityRecordToEvents(record, context());

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'tool_start', harness: 'antigravity' });
      expect(events[1]).toMatchObject({
        kind: 'memory_write',
        harness: 'antigravity',
        sessionKey: 'antigravity:cli:abc-123',
        title: 'antigravity-mcp-probe',
        topicKey: 'probe/topic',
        observationType: 'discovery',
      });
    });

    // Adversarial twin: a de-quoted call_mcp_tool for an unrelated server (codegraph, not engram)
    // must emit ONLY tool_start. Proves the wiring is gated on detector.detect(), not merely on
    // seeing a call_mcp_tool entry.
    it('emits ONLY tool_start for a non-matching call_mcp_tool (near-miss: codegraph, not engram)', () => {
      const record = parseAntigravityLine(
        '{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-24T10:01:00Z","tool_calls":[{"name":"call_mcp_tool","args":{"Arguments":"{\\"query\\":\\"x\\"}","ServerName":"\\"codegraph\\"","ToolName":"\\"codegraph_explore\\"","toolAction":"\\"Exploring codebase\\"","toolSummary":"\\"Codegraph exploration\\""}}]}',
      )!;
      const events = mapAntigravityRecordToEvents(record, context());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_start' });
      expect(events.some((e) => e.kind === 'memory_write')).toBe(false);
    });

    it('allocates a distinct, monotonically increasing id for the memory_write event after tool_start', () => {
      const record = parseAntigravityLine(
        '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-24T10:00:00Z","tool_calls":[{"name":"call_mcp_tool","args":{"Arguments":"{\\"title\\":\\"x\\"}","ServerName":"\\"engram\\"","ToolName":"\\"mem_save\\""}}]}',
      )!;
      const events = mapAntigravityRecordToEvents(record, context());

      expect(events.map((e) => e.id)).toEqual([1, 2]);
    });
  });
});

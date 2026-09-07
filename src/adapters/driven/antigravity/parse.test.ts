import { describe, expect, it } from 'vitest';
import {
  dequoteOnce,
  extractCallMcpToolSignal,
  extractToolCalls,
  parseAntigravityLine,
  parseCallMcpToolArguments,
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

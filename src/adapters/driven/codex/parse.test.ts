import { describe, expect, it } from 'vitest';
import {
  classifyCodexRecordFamily,
  extractMcpToolCallItem,
  isCodexCustomToolCall,
  parseCodexLine,
  resolveCodexToolCaption,
} from './parse';

describe('parseCodexLine', () => {
  it('parses a well-formed event_msg record', () => {
    const line = '{"type":"event_msg","ordinal":1,"payload":{"type":"item_completed"}}';
    const record = parseCodexLine(line);
    expect(record).toEqual({ type: 'event_msg', ordinal: 1, payload: { type: 'item_completed' } });
  });

  it('never throws on malformed JSON and returns null instead', () => {
    expect(() => parseCodexLine('{not valid json')).not.toThrow();
    expect(parseCodexLine('{not valid json')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parseCodexLine('')).toBeNull();
  });
});

describe('classifyCodexRecordFamily (table-driven, Codex record-family discrimination)', () => {
  const families = ['session_meta', 'event_msg', 'response_item', 'turn_context', 'world_state', 'compacted'] as const;

  it.each(families)('recognizes the "%s" record family', (family) => {
    const record = parseCodexLine(`{"type":"${family}"}`)!;
    expect(classifyCodexRecordFamily(record)).toBe(family);
  });

  it('returns null for an unrecognized record family', () => {
    const record = parseCodexLine('{"type":"something_else"}')!;
    expect(classifyCodexRecordFamily(record)).toBeNull();
  });

  it('returns null when the record has no type field', () => {
    const record = parseCodexLine('{}')!;
    expect(classifyCodexRecordFamily(record)).toBeNull();
  });
});

describe('extractMcpToolCallItem', () => {
  it('extracts server/tool/arguments from an event_msg/item_completed McpToolCall record', () => {
    const record = parseCodexLine(
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"engram","tool":"mem_save","arguments":{"title":"x"}}}}',
    )!;
    expect(extractMcpToolCallItem(record)).toEqual({ server: 'engram', tool: 'mem_save', arguments: { title: 'x' } });
  });

  it('returns null for a CommandExecution item (not an MCP call)', () => {
    const record = parseCodexLine(
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":"ls"}}}',
    )!;
    expect(extractMcpToolCallItem(record)).toBeNull();
  });

  it('returns null for a response_item/custom_tool_call record, even one whose free text mentions an MCP tool name', () => {
    const record = parseCodexLine(
      '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"print(mem_save)","output":"mem_save"}}',
    )!;
    expect(extractMcpToolCallItem(record)).toBeNull();
  });

  it('returns null for a record with no payload', () => {
    const record = parseCodexLine('{"type":"session_meta"}')!;
    expect(extractMcpToolCallItem(record)).toBeNull();
  });
});

describe('resolveCodexToolCaption (design.md "Captions": item.type; server/tool for McpToolCall, command head for CommandExecution)', () => {
  it('sources toolLabel from item.type and toolDetail from server/tool for a McpToolCall', () => {
    const record = parseCodexLine(
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"engram","tool":"mem_save"}}}',
    )!;
    expect(resolveCodexToolCaption(record)).toEqual({ toolLabel: 'McpToolCall', toolDetail: 'engram/mem_save' });
  });

  it('sources toolDetail from the command head for a CommandExecution', () => {
    const record = parseCodexLine(
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":"ls -la /tmp"}}}',
    )!;
    expect(resolveCodexToolCaption(record)).toEqual({ toolLabel: 'CommandExecution', toolDetail: 'ls -la /tmp' });
  });

  it('never false-positives on a response_item/custom_tool_call record (same exclusion as extractMcpToolCallItem)', () => {
    const record = parseCodexLine(
      '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"mem_save"}}',
    )!;
    expect(resolveCodexToolCaption(record)).toBeNull();
  });

  it('returns null for a record with no payload item at all', () => {
    const record = parseCodexLine('{"type":"session_meta"}')!;
    expect(resolveCodexToolCaption(record)).toBeNull();
  });
});

describe('isCodexCustomToolCall', () => {
  it('identifies a response_item/custom_tool_call record', () => {
    const record = parseCodexLine('{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec"}}')!;
    expect(isCodexCustomToolCall(record)).toBe(true);
  });

  it('does not misclassify an event_msg/item_completed McpToolCall record', () => {
    const record = parseCodexLine(
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"engram","tool":"mem_save"}}}',
    )!;
    expect(isCodexCustomToolCall(record)).toBe(false);
  });
});

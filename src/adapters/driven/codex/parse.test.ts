import { describe, expect, it } from 'vitest';
import {
  classifyCodexRecordFamily,
  extractMcpToolCallItem,
  isCodexCustomToolCall,
  mapCodexRecordToEvents,
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

describe('mapCodexRecordToEvents', () => {
  function context(sessionKey = 'codex:01a02fc7-3a34-7443-a79a-3ced988a0f20') {
    let id = 0;
    return { sessionKey, allocateId: () => ++id };
  }

  it('maps a CommandExecution item_completed record to a tool_start event', () => {
    const record = parseCodexLine(
      '{"type":"event_msg","timestamp":"2026-08-23T18:01:00.000Z","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":"ls -la /tmp"}}}',
    )!;
    const events = mapCodexRecordToEvents(record, context());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool_start',
      harness: 'codex',
      sessionKey: 'codex:01a02fc7-3a34-7443-a79a-3ced988a0f20',
      toolLabel: 'CommandExecution',
      toolDetail: 'ls -la /tmp',
    });
  });

  it('produces no events for a record with no resolvable tool caption (e.g. session_meta)', () => {
    const record = parseCodexLine('{"type":"session_meta","timestamp":"2026-08-23T18:00:00.000Z"}')!;
    expect(mapCodexRecordToEvents(record, context())).toEqual([]);
  });

  it('produces no events for a response_item/custom_tool_call record (exec sandbox, not a tool call the scene renders)', () => {
    const record = parseCodexLine(
      '{"type":"response_item","timestamp":"2026-08-23T18:01:10.000Z","payload":{"type":"custom_tool_call","name":"exec","input":"print(mem_save)","output":"mem_save"}}',
    )!;
    expect(mapCodexRecordToEvents(record, context())).toEqual([]);
  });

  // Blocker B.1 (tasks.md): CodexMemoryWriteDetector exists and is fixture-tested, but nothing
  // ever called it at runtime. This wires it into the same item_completed mapping that already
  // produces tool_start for a McpToolCall.
  describe('memory_write wiring (blocker B.1, Codex)', () => {
    it('emits a memory_write event IN ADDITION TO tool_start for a matching engram/mem_save McpToolCall', () => {
      const record = parseCodexLine(
        '{"type":"event_msg","timestamp":"2026-08-23T18:00:25.470Z","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"engram","tool":"mem_save","arguments":{"title":"Verified Gentle AI and Engram availability","topic_key":"config/gentle-ai-engram","type":"config"}}}}',
      )!;
      const events = mapCodexRecordToEvents(record, context());

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'tool_start', harness: 'codex' });
      expect(events[1]).toMatchObject({
        kind: 'memory_write',
        harness: 'codex',
        sessionKey: 'codex:01a02fc7-3a34-7443-a79a-3ced988a0f20',
        title: 'Verified Gentle AI and Engram availability',
        topicKey: 'config/gentle-ai-engram',
        observationType: 'config',
        toolLabel: 'mem_save',
      });
    });

    // Adversarial twin: a McpToolCall for an unrelated server/tool must emit ONLY tool_start.
    // This is the guard that proves the wiring is gated on detector.detect(), not merely on the
    // presence of a McpToolCall — asserting "tool_start is emitted" alone would pass either way.
    it('emits ONLY tool_start for a non-matching McpToolCall (near-miss: different server/tool)', () => {
      const record = parseCodexLine(
        '{"type":"event_msg","timestamp":"2026-08-23T18:02:00.000Z","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"context7","tool":"get-library-docs","arguments":{}}}}',
      )!;
      const events = mapCodexRecordToEvents(record, context());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_start' });
      expect(events.some((e) => e.kind === 'memory_write')).toBe(false);
    });

    it('never fires for the response_item/custom_tool_call exec false-positive trap', () => {
      const record = parseCodexLine(
        '{"type":"response_item","timestamp":"2026-08-23T18:01:10.000Z","payload":{"type":"custom_tool_call","name":"exec","input":"import subprocess","output":"./scratch.py: def mem_save(): pass"}}',
      )!;
      expect(mapCodexRecordToEvents(record, context())).toEqual([]);
    });

    it('allocates a distinct, monotonically increasing id for the memory_write event after tool_start', () => {
      const record = parseCodexLine(
        '{"type":"event_msg","timestamp":"2026-08-23T18:00:25.470Z","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"engram","tool":"mem_save","arguments":{"title":"x"}}}}',
      )!;
      const events = mapCodexRecordToEvents(record, context());

      expect(events.map((e) => e.id)).toEqual([1, 2]);
    });
  });
});

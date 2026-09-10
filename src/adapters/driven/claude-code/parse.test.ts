import { describe, expect, it } from 'vitest';
import {
  extractAgentIdFromToolUseResult,
  extractAgentLaunchClaims,
  extractRecordModel,
  extractToolUseBlocks,
  mapClaudeCodeRecordToEvents,
  parseClaudeCodeLine,
  resolveClaudeCodeToolCaption,
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

describe('resolveClaudeCodeToolCaption (design.md "Captions": tool_use.name + short input digest)', () => {
  it('resolves toolLabel from block.name and toolDetail from a recognized input key', () => {
    const caption = resolveClaudeCodeToolCaption({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'design.md' } });
    expect(caption).toEqual({ toolLabel: 'Read', toolDetail: 'design.md' });
  });

  it('resolves toolLabel alone when the input has no recognized digest key', () => {
    const caption = resolveClaudeCodeToolCaption({ type: 'tool_use', id: 't1', name: 'WebSearch', input: { unrelated: 1 } });
    expect(caption).toEqual({ toolLabel: 'WebSearch' });
  });
});

describe('extractAgentLaunchClaims (agent profile tracking: the tool_use.id -> launch input claim)', () => {
  it('extracts subagent_type/model/description from an Agent tool_use block, keyed by its id', () => {
    const record = parseClaudeCodeLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{"subagent_type":"sdd-apply","model":"sonnet","description":"Apply slice 2","prompt":"a very long prompt body"}}]}}',
    )!;

    expect(extractAgentLaunchClaims(record)).toEqual([
      { toolUseId: 'toolu_1', agentType: 'sdd-apply', model: 'sonnet', task: 'Apply slice 2' },
    ]);
  });

  // Triangulation: a DIFFERENT launch, with a different id/type/model/description, must produce
  // its OWN distinct claim — proves the extraction reads the block's own fields, not a hardcoded
  // single-launch fake.
  it('extracts a different launch with different fields into its own distinct claim', () => {
    const record = parseClaudeCodeLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Agent","input":{"subagent_type":"jd-judge-a","model":"opus","description":"Judge slice 3"}}]}}',
    )!;

    expect(extractAgentLaunchClaims(record)).toEqual([
      { toolUseId: 'toolu_2', agentType: 'jd-judge-a', model: 'opus', task: 'Judge slice 3' },
    ]);
  });

  it('omits model/agentType/task when the launch input omits them, rather than defaulting them', () => {
    const record = parseClaudeCodeLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_3","name":"Agent","input":{"description":"No model given"}}]}}',
    )!;

    expect(extractAgentLaunchClaims(record)).toEqual([{ toolUseId: 'toolu_3', task: 'No model given' }]);
  });

  // Adversarial near-miss: a tool_use block that is NOT an Agent launch (same record shape,
  // different tool name) must never be mistaken for one.
  it('ignores a non-Agent tool_use block entirely', () => {
    const record = parseClaudeCodeLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_4","name":"Read","input":{"file_path":"x.ts"}}]}}',
    )!;

    expect(extractAgentLaunchClaims(record)).toEqual([]);
  });

  it('returns an empty array for a record with no tool_use blocks at all', () => {
    const record = parseClaudeCodeLine('{"type":"user","message":{"role":"user","content":"plain text"}}')!;
    expect(extractAgentLaunchClaims(record)).toEqual([]);
  });
});

describe('extractRecordModel (agent profile tracking: the RESOLVED live model on message.model)', () => {
  it('extracts the model from an assistant record message.model', () => {
    const record = parseClaudeCodeLine('{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","content":[]}}')!;
    expect(extractRecordModel(record)).toBe('claude-opus-5');
  });

  // Triangulation: a different model string on a different record must come through unchanged —
  // this is also the "model switch" case: whichever record is read LAST wins, never the first.
  it('extracts a different model value from a different record', () => {
    const record = parseClaudeCodeLine('{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[]}}')!;
    expect(extractRecordModel(record)).toBe('claude-sonnet-5');
  });

  it('returns undefined when message.model is absent, rather than defaulting it', () => {
    const record = parseClaudeCodeLine('{"type":"assistant","message":{"role":"assistant","content":[]}}')!;
    expect(extractRecordModel(record)).toBeUndefined();
  });

  // Adversarial near-miss: a `user` record must never be read for message.model even if it
  // happens to carry one — this field is only meaningful on an assistant turn.
  it('ignores message.model on a non-assistant record', () => {
    const record = parseClaudeCodeLine('{"type":"user","message":{"role":"user","model":"claude-opus-5","content":[]}}')!;
    expect(extractRecordModel(record)).toBeUndefined();
  });

  // Real trap confirmed in live transcripts: system-generated records carry message.model:
  // "<synthetic>" interleaved with real values (e.g. opus -> <synthetic> -> opus). Naively
  // tracking "the latest value seen" would flip a worker's displayed model to this sentinel.
  it('treats the "<synthetic>" sentinel as no model at all, never as a real value', () => {
    const record = parseClaudeCodeLine('{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[]}}')!;
    expect(extractRecordModel(record)).toBeUndefined();
  });

  // Adversarial near-miss of the sentinel guard: a real model string must still pass through
  // fine, proving the filter targets the exact sentinel value, not e.g. any bracketed string.
  it('a real model value on the SAME record shape as the sentinel test still comes through', () => {
    const record = parseClaudeCodeLine('{"type":"assistant","message":{"role":"assistant","model":"claude-haiku-5","content":[]}}')!;
    expect(extractRecordModel(record)).toBe('claude-haiku-5');
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

  it('carries the normalized toolLabel/toolDetail caption pair on the tool_start event', () => {
    const record = parseClaudeCodeLine(
      '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"design.md"}}]}}',
    )!;
    const events = mapClaudeCodeRecordToEvents(record, context());

    expect(events[0]).toMatchObject({ toolLabel: 'Read', toolDetail: 'design.md' });
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

  // Blocker B.1 (tasks.md): the `ClaudeCodeMemoryWriteDetector` exists and is fixture-tested, but
  // nothing ever called it at runtime — `memory_write` was never emitted. This wires it into the
  // same tool_use loop that already produces `tool_start`.
  describe('memory_write wiring (blocker B.1, Claude Code only)', () => {
    it('emits a memory_write event IN ADDITION TO tool_start for a matching mcp__engram__mem_save call', () => {
      const record = parseClaudeCodeLine(
        '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"mcp__engram__mem_save","input":{"title":"Example decision","topic_key":"example/topic","type":"decision"}}]}}',
      )!;
      const events = mapClaudeCodeRecordToEvents(record, context());

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'tool_start', harness: 'claude-code' });
      expect(events[1]).toMatchObject({
        kind: 'memory_write',
        harness: 'claude-code',
        sessionKey: 'claude-code:session-abc',
        title: 'Example decision',
        topicKey: 'example/topic',
        observationType: 'decision',
        toolLabel: 'mem_save',
      });
    });

    it('also fires on the plugin-wrapped mcp__plugin_engram_engram__mem_save spelling', () => {
      const record = parseClaudeCodeLine(
        '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"mcp__plugin_engram_engram__mem_save","input":{"title":"Example discovery","type":"discovery"}}]}}',
      )!;
      const events = mapClaudeCodeRecordToEvents(record, context());

      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ kind: 'memory_write', title: 'Example discovery', observationType: 'discovery' });
    });

    // Adversarial twin: a non-matching tool_use must emit ONLY tool_start. This is the guard that
    // proves the wiring is actually gated on detector.detect() — asserting "tool_start is emitted"
    // alone would pass whether or not the detector was ever connected.
    it('emits ONLY tool_start for a non-matching tool_use (near-miss: mem_search, not mem_save)', () => {
      const record = parseClaudeCodeLine(
        '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"mcp__engram__mem_search","input":{"query":"x"}}]}}',
      )!;
      const events = mapClaudeCodeRecordToEvents(record, context());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_start' });
      expect(events.some((e) => e.kind === 'memory_write')).toBe(false);
    });

    it('allocates a distinct, monotonically increasing id for the memory_write event after tool_start', () => {
      const record = parseClaudeCodeLine(
        '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"mcp__engram__mem_save","input":{"title":"x"}}]}}',
      )!;
      const events = mapClaudeCodeRecordToEvents(record, context());

      expect(events.map((e) => e.id)).toEqual([1, 2]);
    });
  });

  // Model is a LIVE, time-varying property of the session's own transcript — never fixed once at
  // launch — so this wiring applies uniformly to the orchestrator AND to a subagent's own
  // transcript, differing only in the `role` tag (from `ctx.isSubagent`).
  describe('agent profile wiring: the live model from message.model', () => {
    it('attaches the orchestrator agentProfile (role: orchestrator) onto a tool_start event for a non-subagent session', () => {
      const record = parseClaudeCodeLine(
        '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
      )!;
      const events = mapClaudeCodeRecordToEvents(record, context());

      expect(events[0]).toMatchObject({ agentProfile: { role: 'orchestrator', model: 'claude-opus-5' } });
    });

    // Triangulation: the SAME message.model, but this session IS a subagent's own transcript —
    // attaches role: subagent instead, proving the role tag (not the model extraction) is what's
    // gated by isSubagent.
    it('attaches the subagent agentProfile (role: subagent) from a subagent session\'s own transcript', () => {
      const record = parseClaudeCodeLine(
        '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
      )!;
      const events = mapClaudeCodeRecordToEvents(record, { ...context(), isSubagent: true });

      expect(events[0]).toMatchObject({ agentProfile: { role: 'subagent', model: 'claude-sonnet-5' } });
    });

    it('omits agentProfile entirely when the record carries no message.model', () => {
      const record = parseClaudeCodeLine(
        '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
      )!;
      const events = mapClaudeCodeRecordToEvents(record, context());

      expect(events[0]).not.toHaveProperty('agentProfile');
    });

    // The sentinel guard, exercised through the full wiring: a "<synthetic>" record must never
    // attach an agentProfile at all (there is nothing else on this event to carry one for).
    it('omits agentProfile when message.model is the "<synthetic>" sentinel', () => {
      const record = parseClaudeCodeLine(
        '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
      )!;
      const events = mapClaudeCodeRecordToEvents(record, context());

      expect(events[0]).not.toHaveProperty('agentProfile');
    });
  });
});

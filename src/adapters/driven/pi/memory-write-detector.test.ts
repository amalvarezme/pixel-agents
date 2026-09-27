import { describe, expect, it } from 'vitest';
import { PiMemoryWriteDetector } from './memory-write-detector';
import type { PiToolCallPart } from './parse';

const detector = new PiMemoryWriteDetector();

const toolCall = (name: string, args: Record<string, unknown> = {}): PiToolCallPart => ({
  type: 'toolCall',
  id: 'call_abc|fc_def',
  name,
  arguments: args,
});

describe('PiMemoryWriteDetector', () => {
  it('is bound to the pi harness', () => {
    expect(detector.harness).toBe('pi');
  });

  // Verified against 51 real `toolCall` records under `~/.pi/agent/sessions/**`: Pi writes the
  // bare name, with no `mcp__<server>__` wrapper.
  it('matches the bare `mem_save` name Pi actually writes', () => {
    expect(detector.detect(toolCall('mem_save', { title: 'T', topic_key: 'k', type: 'decision' }))).toEqual({
      title: 'T',
      topicKey: 'k',
      observationType: 'decision',
      toolLabel: 'mem_save',
      toolDetail: 'T',
    });
  });

  it('also matches an MCP-gateway-prefixed spelling', () => {
    expect(detector.detect(toolCall('mcp__engram__mem_save', { title: 'T' }))?.toolLabel).toBe('mem_save');
  });

  it('omits every field the call did not carry, rather than defaulting one', () => {
    expect(detector.detect(toolCall('mem_save'))).toEqual({
      title: undefined,
      topicKey: undefined,
      observationType: undefined,
      toolLabel: 'mem_save',
      toolDetail: undefined,
    });
  });

  it('returns null for another Engram tool (adversarial near-miss: same family, not a write)', () => {
    expect(detector.detect(toolCall('mem_search', { query: 'x' }))).toBeNull();
  });

  it('returns null for a name that merely ends in something similar', () => {
    expect(detector.detect(toolCall('mem_save_prompt'))).toBeNull();
    expect(detector.detect(toolCall('remember_save'))).toBeNull();
  });

  it('returns null for an ordinary tool call', () => {
    expect(detector.detect(toolCall('bash', { command: 'ls' }))).toBeNull();
  });

  it('returns null for a non-toolCall part', () => {
    expect(detector.detect({ type: 'text', text: 'mem_save' } as unknown as PiToolCallPart)).toBeNull();
  });

  it('ignores a non-string title rather than coercing it', () => {
    expect(detector.detect(toolCall('mem_save', { title: 42 }))?.title).toBeUndefined();
  });
});

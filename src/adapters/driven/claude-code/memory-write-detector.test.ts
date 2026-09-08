import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractToolUseBlocks, parseClaudeCodeLine } from './parse';
import { ClaudeCodeMemoryWriteDetector } from './memory-write-detector';

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'test', 'fixtures', 'claude-code');

async function loadFixtureToolUseBlock(fileName: string) {
  const raw = await readFile(join(FIXTURES_DIR, fileName), 'utf8');
  const record = parseClaudeCodeLine(raw.trim());
  if (!record) throw new Error(`fixture ${fileName} failed to parse`);
  const blocks = extractToolUseBlocks(record);
  const block = blocks[0];
  if (!block) throw new Error(`fixture ${fileName} has no tool_use block`);
  return block;
}

describe('ClaudeCodeMemoryWriteDetector', () => {
  const detector = new ClaudeCodeMemoryWriteDetector();

  it('reports harness "claude-code"', () => {
    expect(detector.harness).toBe('claude-code');
  });

  it('fires on the direct mcp__engram__mem_save spelling (true positive, fixture 8.2)', async () => {
    const block = await loadFixtureToolUseBlock('mem-save-direct.jsonl');
    const signal = detector.detect(block);

    expect(signal).not.toBeNull();
    expect(signal?.toolLabel).toBe('mem_save');
    expect(signal?.title).toBe('Example decision');
    expect(signal?.observationType).toBe('decision');
    expect(signal?.topicKey).toBe('example/topic');
  });

  it('fires on the plugin-wrapped mcp__plugin_engram_engram__mem_save spelling (true positive, fixture 8.3)', async () => {
    const block = await loadFixtureToolUseBlock('mem-save-plugin-wrapped.jsonl');
    const signal = detector.detect(block);

    expect(signal).not.toBeNull();
    expect(signal?.toolLabel).toBe('mem_save');
    expect(signal?.title).toBe('Example discovery');
    expect(signal?.observationType).toBe('discovery');
  });

  it('does NOT fire on mcp__engram__mem_search (false-positive trap, fixture 8.4)', async () => {
    const block = await loadFixtureToolUseBlock('mem-search-trap.jsonl');
    const signal = detector.detect(block);

    expect(signal).toBeNull();
  });

  it('does not fire on an unrelated tool_use block', () => {
    const signal = detector.detect({ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.ts' } });
    expect(signal).toBeNull();
  });
});

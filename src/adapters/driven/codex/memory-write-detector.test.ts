import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodexLine } from './parse';
import { CodexMemoryWriteDetector } from './memory-write-detector';

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'test', 'fixtures', 'codex');

async function loadFixtureRecord(fileName: string) {
  const raw = await readFile(join(FIXTURES_DIR, fileName), 'utf8');
  const record = parseCodexLine(raw.trim());
  if (!record) throw new Error(`fixture ${fileName} failed to parse`);
  return record;
}

describe('CodexMemoryWriteDetector', () => {
  const detector = new CodexMemoryWriteDetector();

  it('reports harness "codex"', () => {
    expect(detector.harness).toBe('codex');
  });

  it('fires on an event_msg/item_completed McpToolCall for engram/mem_save (true positive, fixture 12.5)', async () => {
    const record = await loadFixtureRecord('mem-save-mcp-tool-call.jsonl');
    const signal = detector.detect(record);

    expect(signal).not.toBeNull();
    expect(signal?.toolLabel).toBe('mem_save');
    expect(signal?.title).toBe('Verified Gentle AI and Engram availability');
    expect(signal?.topicKey).toBe('config/gentle-ai-engram');
  });

  it('does NOT fire on a custom_tool_call exec record whose free text contains "mem_save" (false-positive trap, fixture 12.6)', async () => {
    const record = await loadFixtureRecord('custom-tool-call-exec-false-positive.jsonl');
    const signal = detector.detect(record);

    expect(signal).toBeNull();
  });

  it('does not fire on an unrelated McpToolCall (different server/tool)', () => {
    const record = parseCodexLine(
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"engram","tool":"mem_search","arguments":{}}}}',
    )!;
    expect(detector.detect(record)).toBeNull();
  });

  it('does not fire on a CommandExecution item', () => {
    const record = parseCodexLine(
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":"ls"}}}',
    )!;
    expect(detector.detect(record)).toBeNull();
  });
});

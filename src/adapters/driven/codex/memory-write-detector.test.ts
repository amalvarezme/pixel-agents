import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCodexCustomToolCall, parseCodexLine } from './parse';
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

  // The 12.6 fixture proves the REAL exec record is rejected, but it is rejected for an incidental
  // reason: its payload carries no `item` at all, so it dies on the `item_completed` check long
  // before the record-family check matters. That leaves the actual exclusion — "only `event_msg`
  // records are ever inspected" — unpinned: widening the family gate to admit `response_item` kept
  // the whole Codex suite green. This test pins it with the adversarial record the fixture cannot
  // express: a `response_item` carrying a fully well-formed engram/mem_save McpToolCall payload.
  // Only the record-family check can reject it, so this test fails the moment that check weakens.
  it('does NOT fire on a response_item carrying an otherwise-matching engram/mem_save McpToolCall (pins the record-family exclusion itself)', () => {
    const record = parseCodexLine(
      '{"type":"response_item","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"engram","tool":"mem_save","arguments":{"title":"should never be detected"}}}}',
    )!;

    // Sanity: the same payload under `event_msg` DOES fire, so the only difference under test is
    // the record family — otherwise this test could pass for an unrelated reason.
    const asEventMsg = parseCodexLine(
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"engram","tool":"mem_save","arguments":{"title":"should never be detected"}}}}',
    )!;
    expect(detector.detect(asEventMsg)).not.toBeNull();

    expect(detector.detect(record)).toBeNull();
  });

  it('classifies the 12.6 exec fixture as the custom_tool_call family that is excluded from detection', async () => {
    const record = await loadFixtureRecord('custom-tool-call-exec-false-positive.jsonl');
    expect(isCodexCustomToolCall(record)).toBe(true);
    expect(detector.detect(record)).toBeNull();
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

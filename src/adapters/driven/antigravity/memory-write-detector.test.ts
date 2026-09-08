import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractToolCalls, parseAntigravityLine } from './parse';
import { AntigravityMemoryWriteDetector } from './memory-write-detector';

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'test', 'fixtures', 'antigravity');

async function loadFixtureToolCall(fileName: string) {
  const raw = await readFile(join(FIXTURES_DIR, fileName), 'utf8');
  const record = parseAntigravityLine(raw.trim());
  if (!record) throw new Error(`fixture ${fileName} failed to parse`);
  const toolCall = extractToolCalls(record)[0];
  if (!toolCall) throw new Error(`fixture ${fileName} has no tool_calls entry`);
  return toolCall;
}

describe('AntigravityMemoryWriteDetector', () => {
  const detector = new AntigravityMemoryWriteDetector();

  it('reports harness "antigravity"', () => {
    expect(detector.harness).toBe('antigravity');
  });

  it('a naive equality check against the raw (quoted) ServerName value FAILS on the true-positive fixture (tasks.md 13.9 — proves de-quoting is mandatory)', async () => {
    const toolCall = await loadFixtureToolCall('mem-save-call-mcp-tool.jsonl');
    const rawServerName = toolCall.args?.ServerName;

    // The raw value is the 8-character string `"engram"`, quotes included — a naive comparison
    // against the bare word is always false. This is why the detector must de-quote first.
    expect(rawServerName === 'engram').toBe(false);
    expect(rawServerName).toBe('"engram"');
  });

  it('fires on a de-quoted engram/mem_save call_mcp_tool (true positive, fixture 13.7)', async () => {
    const toolCall = await loadFixtureToolCall('mem-save-call-mcp-tool.jsonl');
    const signal = detector.detect(toolCall);

    expect(signal).not.toBeNull();
    expect(signal?.title).toBe('antigravity-mcp-probe');
    expect(signal?.observationType).toBe('discovery');
    expect(signal?.toolLabel).toBe('Saving probe memory to Engram');
    expect(signal?.toolDetail).toBe('Engram probe memory save');
  });

  it('does NOT fire on a de-quoted codegraph call_mcp_tool (false-positive trap, fixture 13.8)', async () => {
    const toolCall = await loadFixtureToolCall('call-mcp-tool-codegraph-false-positive.jsonl');
    const signal = detector.detect(toolCall);

    expect(signal).toBeNull();
  });

  it('does not fire on a non-call_mcp_tool tool call (e.g. an IDE-native editor action)', () => {
    const signal = detector.detect({ name: 'list_dir', args: { DirectoryPath: '"/tmp"' } });
    expect(signal).toBeNull();
  });
});

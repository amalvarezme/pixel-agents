import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AntigravityActivitySource } from './activity-source';

// b1-remaining-harnesses: `ActivitySource` composition for Antigravity, mirroring
// `claude-code/activity-source.ts` (design.md D1), reusing the SAME `readTailIncrement`/
// `watchAndTailFile` byte-offset tailer as Claude Code and Codex.
describe('AntigravityActivitySource', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function makeCliTranscript(firstLine?: string): Promise<{ root: string; filePath: string }> {
    root = await mkdtemp(join(tmpdir(), 'antigravity-activity-source-'));
    const logsDir = join(root, 'antigravity-cli', 'brain', 'uuid-1', '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    const filePath = join(logsDir, 'transcript.jsonl');
    await writeFile(filePath, firstLine ? `${firstLine}\n` : '');
    return { root, filePath };
  }

  it('discover() yields a session that already exists on disk before the source was constructed', async () => {
    const record = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-06-15T20:23:35Z',
      tool_calls: [{ name: 'list_dir', args: { toolAction: '"Listing"' } }],
    });
    const { root: harnessRoot } = await makeCliTranscript(record);
    const source = new AntigravityActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();

    expect(sessionRef?.sessionKey).toBe('antigravity:cli:uuid-1');
    await source.close();
  });

  it('open() emits a synthetic session_start event first, then a memory_write-carrying tool_start for a matching call_mcp_tool', async () => {
    const record = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-24T10:00:00Z',
      tool_calls: [
        {
          name: 'call_mcp_tool',
          args: { Arguments: '{"title":"x"}', ServerName: '"engram"', ToolName: '"mem_save"' },
        },
      ],
    });
    const { root: harnessRoot } = await makeCliTranscript(record);
    const source = new AntigravityActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const first = await streamIterator.next();
    expect(first.value?.event.kind).toBe('session_start');

    const second = await streamIterator.next();
    expect(second.value?.event.kind).toBe('tool_start');

    const third = await streamIterator.next();
    expect(third.value?.event.kind).toBe('memory_write');

    stream.stop();
    await source.close();
  });

  it('live-tails a line appended AFTER open() was called', async () => {
    const { root: harnessRoot, filePath } = await makeCliTranscript();
    const source = new AntigravityActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const sessionStart = await streamIterator.next();
    expect(sessionStart.value?.event.kind).toBe('session_start');

    const record = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-24T10:01:00Z',
      tool_calls: [{ name: 'list_dir', args: { toolAction: '"Listing"' } }],
    });
    await writeFile(filePath, `${record}\n`);

    const next = await streamIterator.next();
    expect(next.value?.event.kind).toBe('tool_start');

    stream.stop();
    await source.close();
  });

  it('discover + open + close never writes anything under the harness root (Global No-Write Invariant, composition level)', async () => {
    const { root: harnessRoot, filePath } = await makeCliTranscript('{"step_index":1,"source":"USER","type":"USER_QUERY"}');
    const source = new AntigravityActivitySource(harnessRoot);

    const before = await stat(filePath);
    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    await stream.events[Symbol.asyncIterator]().next(); // drain the synthetic session_start
    stream.stop();
    await source.close();
    const after = await stat(filePath);

    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });
});

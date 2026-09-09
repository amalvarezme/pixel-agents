import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeActivitySource } from './activity-source';

// browser-entrypoint work unit: `ActivitySource` is the one port `application/ingest-agent-
// activity` and the composition root (`src/server.ts`) depend on. Nothing before this work unit
// composed `discover.ts` + `tail.ts` + `parse.ts` behind that single port, so a real end-to-end
// server had nothing to wire. Integration-level, real temp dir + real fs, matching
// `discover.test.ts`/`tail.test.ts`'s established pattern (design.md testing strategy: "JSONL
// adapters end-to-end incl. checkpoint resume").
describe('ClaudeCodeActivitySource', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function makeSessionFile(firstLine?: string): Promise<{ root: string; filePath: string }> {
    root = await mktempRoot();
    const projectDir = join(root, 'projects', 'my-slug');
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, 'session-1.jsonl');
    await writeFile(filePath, firstLine ? `${firstLine}\n` : '');
    return { root, filePath };
  }

  async function mktempRoot(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'claude-code-activity-source-'));
  }

  it('discover() yields a session that already exists on disk before the source was constructed', async () => {
    const toolUseLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
    const { root: harnessRoot } = await makeSessionFile(toolUseLine);
    const source = new ClaudeCodeActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();

    expect(sessionRef?.sessionKey).toBe('claude-code:session-1');
    await source.close();
  });

  it('open() emits a synthetic session_start event first, so the session renders as a worker before any content is parsed', async () => {
    const toolUseLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
    const { root: harnessRoot } = await makeSessionFile(toolUseLine);
    const source = new ClaudeCodeActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const first = await streamIterator.next();
    expect(first.value?.event.kind).toBe('session_start');
    expect(first.value?.event.sessionKey).toBe('claude-code:session-1');

    const second = await streamIterator.next();
    expect(second.value?.event.kind).toBe('tool_start');

    stream.stop();
    await source.close();
  });

  it('live-tails a line appended AFTER open() was called', async () => {
    const { root: harnessRoot, filePath } = await makeSessionFile();
    const source = new ClaudeCodeActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const sessionStart = await streamIterator.next();
    expect(sessionStart.value?.event.kind).toBe('session_start');

    const messageLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hello' } });
    // chokidar's watcher can still be attaching when open() returns: on macOS a single write that
    // lands in that window is never delivered, and awaiting one event then hangs to the 5s timeout.
    // This flaked across all three harnesses' live-tail tests. Re-append on an interval until the
    // event arrives — unlike the `add` case in discover.test.ts, repeated writes to the SAME file
    // each emit `change`, so retrying the same content is enough and the assertion is unchanged.
    const keepAppending = setInterval(() => { void writeFile(filePath, `${messageLine}\n`); }, 150);
    await writeFile(filePath, `${messageLine}\n`);

    const next = await streamIterator.next();
    clearInterval(keepAppending);
    expect(next.value?.event.kind).toBe('message');
    expect(next.value?.event.sessionKey).toBe('claude-code:session-1');

    stream.stop();
    await source.close();
  });

  it('open() reports a parent session record carrying toolUseResult.agentId via onParentRecord', async () => {
    const launchLine = JSON.stringify({ type: 'assistant', toolUseResult: { agentId: 'abc123' } });
    const { root: harnessRoot } = await makeSessionFile(launchLine);
    const onParentRecord = vi.fn();
    const source = new ClaudeCodeActivitySource(harnessRoot, { onParentRecord });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();
    await streamIterator.next(); // session_start
    await streamIterator.next(); // the launch line's own `message` event

    expect(onParentRecord).toHaveBeenCalledTimes(1);
    expect(onParentRecord).toHaveBeenCalledWith('claude-code:session-1', expect.objectContaining({ toolUseResult: { agentId: 'abc123' } }));

    stream.stop();
    await source.close();
  });

  it('open() never reports onParentRecord for a subagent session (the edge only reads PARENT transcripts)', async () => {
    root = await mktempRoot();
    const subagentDir = join(root, 'projects', 'my-slug', 'parent-1', 'subagents');
    await mkdir(subagentDir, { recursive: true });
    const filePath = join(subagentDir, 'agent-abc123.jsonl');
    const line = JSON.stringify({ type: 'assistant', toolUseResult: { agentId: 'nested-should-be-ignored' } });
    await writeFile(filePath, `${line}\n`);
    const onParentRecord = vi.fn();
    const source = new ClaudeCodeActivitySource(root, { onParentRecord });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    expect((sessionRef as { isSubagent?: boolean })?.isSubagent).toBe(true);
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();
    await streamIterator.next(); // session_start
    await streamIterator.next(); // the subagent's own `message` event

    expect(onParentRecord).not.toHaveBeenCalled();

    stream.stop();
    await source.close();
  });

  it('discover + open + close never writes anything under the harness root (Global No-Write Invariant, composition level)', async () => {
    const { root: harnessRoot, filePath } = await makeSessionFile('{"type":"system"}');
    const source = new ClaudeCodeActivitySource(harnessRoot);

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

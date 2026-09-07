import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    await writeFile(filePath, `${messageLine}\n`);

    const next = await streamIterator.next();
    expect(next.value?.event.kind).toBe('message');
    expect(next.value?.event.sessionKey).toBe('claude-code:session-1');

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

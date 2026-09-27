import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiActivitySource } from './activity-source';

const SESSION_ID = '01a0e06e-d6eb-7018-81fe-cc81a7736e52';
const TRANSCRIPT_FILENAME = `2026-09-27T01-15-55-499Z_${SESSION_ID}.jsonl`;

const sessionLine = (cwd: string): string =>
  JSON.stringify({ type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-09-27T01:15:55.499Z', cwd });

const toolCallLine = (name: string, args: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'message',
    id: 'rec1',
    timestamp: '2026-09-27T01:16:58.120Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'toolCall', id: 'toolu_01', name, arguments: args }] },
  });

describe('PiActivitySource', () => {
  let root: string;

  async function makeTranscript(lines: string[] = []): Promise<{ root: string; filePath: string }> {
    root = await mkdtemp(join(tmpdir(), 'pi-activity-source-'));
    const projectDir = join(root, 'sessions', '--Users-a-Documents-proj--');
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, TRANSCRIPT_FILENAME);
    await writeFile(filePath, lines.length ? `${lines.join('\n')}\n` : '');
    return { root, filePath };
  }

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('reports the pi harness id', async () => {
    const { root: harnessRoot } = await makeTranscript();
    const source = new PiActivitySource(harnessRoot);

    expect(source.harness).toBe('pi');
    await source.close();
  });

  it('probe() reports ready even when the sessions root does not exist', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-activity-source-empty-'));
    const source = new PiActivitySource(root);

    expect(await source.probe()).toEqual({ status: 'ready' });
    await source.close();
  });

  it('discover() yields a session that already existed before the source was constructed', async () => {
    const { root: harnessRoot } = await makeTranscript([sessionLine('/Users/a/Documents/proj')]);
    const source = new PiActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: ref } = await iterator.next();

    expect(ref?.sessionKey).toBe(`pi:${SESSION_ID}`);
    await source.close();
  });

  it('open() emits a synthetic session_start first, carrying the resolved projectPath', async () => {
    const { root: harnessRoot } = await makeTranscript([sessionLine('/Users/a/Documents/proj')]);
    const source = new PiActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: ref } = await iterator.next();
    const stream = source.open(ref!, null);
    const first = await stream.events[Symbol.asyncIterator]().next();

    expect(first.value?.event).toMatchObject({
      kind: 'session_start',
      harness: 'pi',
      sessionKey: `pi:${SESSION_ID}`,
      projectPath: '/Users/a/Documents/proj',
      agentProfile: { role: 'orchestrator' },
    });

    stream.stop();
    await source.close();
  });

  it('session_start omits projectPath when the transcript carried no session record', async () => {
    const { root: harnessRoot } = await makeTranscript([JSON.stringify({ type: 'model_change', modelId: 'm' })]);
    const source = new PiActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: ref } = await iterator.next();
    const stream = source.open(ref!, null);
    const first = await stream.events[Symbol.asyncIterator]().next();

    expect(first.value?.event.projectPath).toBeUndefined();

    stream.stop();
    await source.close();
  });

  it("session_start's `at` is the session's real last-activity time, not the moment open() ran", async () => {
    const { root: harnessRoot, filePath } = await makeTranscript([sessionLine('/Users/a/proj')]);
    const mtime = new Date('2026-09-27T01:00:00.000Z');
    await utimes(filePath, mtime, mtime);
    const source = new PiActivitySource(harnessRoot, { now: () => mtime.getTime() + 60_000 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: ref } = await iterator.next();
    const stream = source.open(ref!, null);
    const first = await stream.events[Symbol.asyncIterator]().next();

    expect(first.value?.event.at).toBe(mtime.getTime());

    stream.stop();
    await source.close();
  });

  it('open() with replayFromStart emits tool_start and memory_write for a pre-existing mem_save call', async () => {
    const { root: harnessRoot } = await makeTranscript([
      sessionLine('/Users/a/proj'),
      toolCallLine('mem_save', { title: 'Decision X' }),
    ]);
    const source = new PiActivitySource(harnessRoot, { replayFromStart: true });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: ref } = await iterator.next();
    const stream = source.open(ref!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    expect((await streamIterator.next()).value?.event.kind).toBe('session_start');
    expect((await streamIterator.next()).value?.event.kind).toBe('tool_start');
    expect((await streamIterator.next()).value?.event.kind).toBe('memory_write');

    stream.stop();
    await source.close();
  });

  it('open() with no prior checkpoint and default options never replays pre-existing content', async () => {
    const { root: harnessRoot } = await makeTranscript([
      sessionLine('/Users/a/proj'),
      toolCallLine('bash', { command: 'ls' }),
    ]);
    const source = new PiActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: ref } = await iterator.next();
    const stream = source.open(ref!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    expect((await streamIterator.next()).value?.event.kind).toBe('session_start');

    const next = await Promise.race([
      streamIterator.next().then((r) => r.value?.event.kind),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 600)),
    ]);
    expect(next).toBe('timed-out');

    stream.stop();
    await source.close();
  });

  it('live-tails a line appended AFTER open() was called', async () => {
    const { root: harnessRoot, filePath } = await makeTranscript([sessionLine('/Users/a/proj')]);
    const source = new PiActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: ref } = await iterator.next();
    const stream = source.open(ref!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();
    await streamIterator.next(); // the synthetic session_start

    setTimeout(() => {
      void appendFile(filePath, `${toolCallLine('read', { path: 'src/server.ts' })}\n`);
    }, 150);

    const appended = await streamIterator.next();

    expect(appended.value?.event).toMatchObject({ kind: 'tool_start', toolLabel: 'read', toolDetail: 'src/server.ts' });

    stream.stop();
    await source.close();
  });

  it('discover() excludes a transcript last touched outside the configured active window', async () => {
    const { root: harnessRoot, filePath } = await makeTranscript([sessionLine('/Users/a/proj')]);
    const stale = new Date('2026-09-01T00:00:00.000Z');
    await utimes(filePath, stale, stale);
    const source = new PiActivitySource(harnessRoot, {
      now: () => stale.getTime() + 48 * 60 * 60 * 1000,
      activeWindowMs: 24 * 60 * 60 * 1000,
    });

    const first = await Promise.race([
      source.discover()[Symbol.asyncIterator]().next().then((r) => r.value?.sessionKey ?? 'none'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 600)),
    ]);

    expect(first).toBe('timed-out');
    await source.close();
  });
});

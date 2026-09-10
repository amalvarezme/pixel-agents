import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
    // Opt-in (design.md: "an opt-in --replay-since exists for demos and fixture capture"): this
    // test's purpose is proving PARSED-event ordering, which needs the pre-existing record read.
    const source = new AntigravityActivitySource(harnessRoot, { replayFromStart: true });

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

  // design.md "Session discovery and aging out" — Bootstrap: "start their checkpoint at EOF
  // ... not at zero." Default behavior: no replay of pre-existing content.
  it('open() with no prior checkpoint and default options never replays pre-existing content, only newly appended lines', async () => {
    const mcpRecord = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-24T10:00:00Z',
      tool_calls: [
        { name: 'call_mcp_tool', args: { Arguments: '{"title":"x"}', ServerName: '"engram"', ToolName: '"mem_save"' } },
      ],
    });
    const { root: harnessRoot, filePath } = await makeCliTranscript(mcpRecord);
    const source = new AntigravityActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const first = await streamIterator.next();
    expect(first.value?.event.kind).toBe('session_start');

    const listDirRecord = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-24T10:01:00Z',
      tool_calls: [{ name: 'list_dir', args: { toolAction: '"Listing"' } }],
    });
    const retryTimer = setInterval(() => { void writeFile(filePath, `${listDirRecord}\n`, { flag: 'a' }); }, 150);
    await writeFile(filePath, `${listDirRecord}\n`, { flag: 'a' });

    // Poll for the FULL ~2s window regardless of what arrives first — a replayed call_mcp_tool
    // record produces `tool_start` THEN `memory_write` in that order, so stopping at the first
    // `tool_start` would silently skip past the very event this test exists to rule out.
    const seenKinds: string[] = [];
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const outcome = await Promise.race([
        streamIterator.next().then((r) => ({ timedOut: false as const, kind: r.value?.event.kind })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 200)),
      ]);
      if (!outcome.timedOut && outcome.kind) seenKinds.push(outcome.kind);
    }
    clearInterval(retryTimer);

    expect(seenKinds).toContain('tool_start');
    expect(seenKinds).not.toContain('memory_write');

    stream.stop();
    await source.close();
  }, 10000);

  // The opt-in itself: with `replayFromStart: true`, pre-existing content IS replayed.
  it('open() with replayFromStart: true DOES replay content already on disk', async () => {
    const mcpRecord = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-24T10:00:00Z',
      tool_calls: [
        { name: 'call_mcp_tool', args: { Arguments: '{"title":"x"}', ServerName: '"engram"', ToolName: '"mem_save"' } },
      ],
    });
    const { root: harnessRoot } = await makeCliTranscript(mcpRecord);
    const source = new AntigravityActivitySource(harnessRoot, { replayFromStart: true });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    await streamIterator.next(); // session_start
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
    // chokidar's watcher can still be attaching when open() returns: on macOS a single write that
    // lands in that window is never delivered, and awaiting one event then hangs to the 5s timeout.
    // This flaked across all three harnesses' live-tail tests. Re-append on an interval until the
    // event arrives — unlike the `add` case in discover.test.ts, repeated writes to the SAME file
    // each emit `change`, so retrying the same content is enough and the assertion is unchanged.
    const keepAppending = setInterval(() => { void writeFile(filePath, `${record}\n`); }, 150);
    await writeFile(filePath, `${record}\n`);

    const next = await streamIterator.next();
    clearInterval(keepAppending);
    expect(next.value?.event.kind).toBe('tool_start');

    stream.stop();
    await source.close();
  });

  // design.md "Session discovery and aging out" — Bootstrap: "attach only to sessions touched
  // within `activeWindow` (24h)". Wiring test for the ActivitySource level, mirroring Claude
  // Code's and Codex's: a window SMALLER than the 24h default (1s, against a transcript touched
  // 2s ago) proves the constructor option is actually threaded through.
  it('discover() excludes a transcript last touched outside the configured active window', async () => {
    const { root: harnessRoot } = await makeCliTranscript('{}');
    const staleLogsDir = join(harnessRoot, 'antigravity-cli', 'brain', 'uuid-stale', '.system_generated', 'logs');
    await mkdir(staleLogsDir, { recursive: true });
    const staleFilePath = join(staleLogsDir, 'transcript.jsonl');
    await writeFile(staleFilePath, '{}\n');
    const twoSecondsAgo = new Date(Date.now() - 2000);
    await utimes(staleFilePath, twoSecondsAgo, twoSecondsAgo);
    const source = new AntigravityActivitySource(harnessRoot, { activeWindowMs: 1000 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const withTimeout = (ms: number): Promise<{ timedOut: true } | { timedOut: false; sessionKey?: string }> =>
      Promise.race([
        iterator.next().then((r) => ({ timedOut: false as const, sessionKey: r.value?.sessionKey })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 300)),
      ]);

    const first = await withTimeout(2000);
    expect(first.timedOut).toBe(false);
    expect((first as { sessionKey?: string }).sessionKey).toBe('antigravity:cli:uuid-1');

    const second = await withTimeout(300);
    expect(second.timedOut).toBe(true);

    await source.close();
  });

  // Session aging (design.md "Session discovery and aging out") ages from the synthetic
  // `session_start`'s `at`. It must carry the session's REAL last-activity time (the transcript
  // file's mtime), never the moment `open()` happens to run.
  it('open() stamps the synthetic session_start with the session\'s real last-activity time, not the moment open() was called', async () => {
    const { root: harnessRoot, filePath } = await makeCliTranscript('{}');
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await utimes(filePath, tenHoursAgo, tenHoursAgo);
    const { mtimeMs } = await stat(filePath);
    const source = new AntigravityActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const first = await streamIterator.next();
    expect(first.value?.event.kind).toBe('session_start');
    expect(first.value?.event.at).toBe(mtimeMs);

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

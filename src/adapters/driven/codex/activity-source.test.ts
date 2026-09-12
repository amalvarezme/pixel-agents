import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexActivitySource } from './activity-source';
import { currentDayDirectory } from './discover';

// b1-remaining-harnesses: `ActivitySource` composition for Codex, mirroring
// `claude-code/activity-source.ts` exactly (design.md D1) — reuses the SAME `readTailIncrement`/
// `watchAndTailFile` tailer (design.md: "JSONL tailing ... ONE shared mechanism for all three").
describe('CodexActivitySource', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function makeRolloutFile(firstLine?: string): Promise<{ root: string; filePath: string }> {
    root = await mkdtemp(join(tmpdir(), 'codex-activity-source-'));
    const dayDir = currentDayDirectory(root);
    await mkdir(dayDir, { recursive: true });
    const filePath = join(dayDir, 'rollout-2026-08-23T12-59-40-01a02fc7-3a34-7443-a79a-3ced988a0f20.jsonl');
    await writeFile(filePath, firstLine ? `${firstLine}\n` : '');
    return { root, filePath };
  }

  it('discover() yields a session that already exists on disk before the source was constructed', async () => {
    const mcpToolCallLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-23T18:00:25.470Z',
      payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'engram', tool: 'mem_save', arguments: {} } },
    });
    const { root: harnessRoot } = await makeRolloutFile(mcpToolCallLine);
    const source = new CodexActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();

    expect(sessionRef?.sessionKey).toBe('codex:01a02fc7-3a34-7443-a79a-3ced988a0f20');
    await source.close();
  });

  it('open() emits a synthetic session_start event first, then a memory_write-carrying tool_start for a matching McpToolCall', async () => {
    const mcpToolCallLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-23T18:00:25.470Z',
      payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'engram', tool: 'mem_save', arguments: { title: 'x' } } },
    });
    const { root: harnessRoot } = await makeRolloutFile(mcpToolCallLine);
    // Opt-in (design.md: "an opt-in --replay-since exists for demos and fixture capture"): this
    // test's purpose is proving PARSED-event ordering, which needs the pre-existing line read.
    const source = new CodexActivitySource(harnessRoot, { replayFromStart: true });

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
    const mcpToolCallLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-23T18:00:25.470Z',
      payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'engram', tool: 'mem_save', arguments: {} } },
    });
    const { root: harnessRoot, filePath } = await makeRolloutFile(mcpToolCallLine);
    const source = new CodexActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const first = await streamIterator.next();
    expect(first.value?.event.kind).toBe('session_start');

    const commandLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-23T18:01:00.000Z',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 'ls' } },
    });
    // Same retry-on-an-interval pattern as the other harnesses' live-tail tests (the watcher can
    // still be attaching when `open()` returns). Repeated appends are harmless here — the
    // assertion below is inclusion-based over a bounded poll, tolerant of duplicate `tool_start`s.
    const retryTimer = setInterval(() => { void writeFile(filePath, `${commandLine}\n`, { flag: 'a' }); }, 150);
    await writeFile(filePath, `${commandLine}\n`, { flag: 'a' });

    // Poll for the FULL ~2s window regardless of what arrives first — deliberately never breaks
    // early on the first `tool_start`, because a replayed McpToolCall produces `tool_start` THEN
    // `memory_write` in that order: stopping at the first `tool_start` would silently skip past
    // the very event this test exists to rule out.
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
  });

  // The opt-in itself: with `replayFromStart: true`, pre-existing content IS replayed.
  it('open() with replayFromStart: true DOES replay content already on disk', async () => {
    const mcpToolCallLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-23T18:00:25.470Z',
      payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'engram', tool: 'mem_save', arguments: { title: 'x' } } },
    });
    const { root: harnessRoot } = await makeRolloutFile(mcpToolCallLine);
    const source = new CodexActivitySource(harnessRoot, { replayFromStart: true });

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
    const { root: harnessRoot, filePath } = await makeRolloutFile();
    const source = new CodexActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const sessionStart = await streamIterator.next();
    expect(sessionStart.value?.event.kind).toBe('session_start');

    const commandLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-23T18:01:00.000Z',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 'ls' } },
    });
    // chokidar's watcher can still be attaching when open() returns: on macOS a single write that
    // lands in that window is never delivered, and awaiting one event then hangs to the 5s timeout.
    // This flaked across all three harnesses' live-tail tests. Re-append on an interval until the
    // event arrives — unlike the `add` case in discover.test.ts, repeated writes to the SAME file
    // each emit `change`, so retrying the same content is enough and the assertion is unchanged.
    const keepAppending = setInterval(() => { void writeFile(filePath, `${commandLine}\n`); }, 150);
    await writeFile(filePath, `${commandLine}\n`);

    const next = await streamIterator.next();
    clearInterval(keepAppending);
    expect(next.value?.event.kind).toBe('tool_start');

    stream.stop();
    await source.close();
  });

  // design.md "Session discovery and aging out" — Bootstrap: "attach only to sessions touched
  // within `activeWindow` (24h)". Wiring test for the ActivitySource level, mirroring Claude
  // Code's: a window SMALLER than the 24h default (1s, against a rollout touched 2s ago) proves
  // the constructor option is actually threaded through, not just coinciding with the default.
  it('discover() excludes a rollout file last touched outside the configured active window', async () => {
    const { root: harnessRoot } = await makeRolloutFile('{}');
    const dayDir = currentDayDirectory(harnessRoot);
    const staleFilePath = join(dayDir, 'rollout-2026-08-23T12-59-40-02b13ad8-4b45-8554-b8ab-4dfe099b1031.jsonl');
    await writeFile(staleFilePath, '{}\n');
    const twoSecondsAgo = new Date(Date.now() - 2000);
    await utimes(staleFilePath, twoSecondsAgo, twoSecondsAgo);
    const source = new CodexActivitySource(harnessRoot, { activeWindowMs: 1000 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const withTimeout = (ms: number): Promise<{ timedOut: true } | { timedOut: false; sessionKey?: string }> =>
      Promise.race([
        iterator.next().then((r) => ({ timedOut: false as const, sessionKey: r.value?.sessionKey })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 300)),
      ]);

    const first = await withTimeout(2000);
    expect(first.timedOut).toBe(false);
    expect((first as { sessionKey?: string }).sessionKey).toBe('codex:01a02fc7-3a34-7443-a79a-3ced988a0f20');

    const second = await withTimeout(300);
    expect(second.timedOut).toBe(true);

    await source.close();
  });

  // Session aging (design.md "Session discovery and aging out") ages from the synthetic
  // `session_start`'s `at`. It must carry the session's REAL last-activity time (the rollout
  // file's mtime), never the moment `open()` happens to run.
  it('open() stamps the synthetic session_start with the session\'s real last-activity time, not the moment open() was called', async () => {
    const { root: harnessRoot, filePath } = await makeRolloutFile('{}');
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await utimes(filePath, tenHoursAgo, tenHoursAgo);
    const { mtimeMs } = await stat(filePath);
    const source = new CodexActivitySource(harnessRoot);

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

  // Associated-project tracking: `resolveCodexSessionCwd` (discover.ts) already resolves the
  // session's cwd at discovery time from `session_meta.payload.cwd`; this proves it actually
  // lands on the synthetic `session_start` event, not just on the discovered `SessionRef`.
  it('stamps the synthetic session_start with projectPath from the session\'s resolved cwd', async () => {
    const sessionMetaLine = JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/andresalvarez/Documents/pixel-agents' } });
    const { root: harnessRoot } = await makeRolloutFile(sessionMetaLine);
    const source = new CodexActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    expect(sessionRef?.cwd).toBe('/Users/andresalvarez/Documents/pixel-agents');

    const stream = source.open(sessionRef!, null);
    const first = await stream.events[Symbol.asyncIterator]().next();

    expect(first.value?.event.kind).toBe('session_start');
    expect(first.value?.event.projectPath).toBe('/Users/andresalvarez/Documents/pixel-agents');

    stream.stop();
    await source.close();
  });

  // Adversarial twin: a rollout file with no session_meta cwd record must leave projectPath
  // unset, never guessed.
  it('leaves projectPath unset on session_start when no cwd record was found', async () => {
    const { root: harnessRoot } = await makeRolloutFile('{}');
    const source = new CodexActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const first = await stream.events[Symbol.asyncIterator]().next();

    expect(first.value?.event.projectPath).toBeUndefined();

    stream.stop();
    await source.close();
  });

  it('discover + open + close never writes anything under the harness root (Global No-Write Invariant, composition level)', async () => {
    const { root: harnessRoot, filePath } = await makeRolloutFile('{"type":"session_meta"}');
    const source = new CodexActivitySource(harnessRoot);

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

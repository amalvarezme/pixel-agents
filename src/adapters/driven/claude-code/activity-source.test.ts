import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
    // Opt-in (design.md: "an opt-in --replay-since exists for demos and fixture capture"): this
    // test's purpose is proving event ORDERING (session_start before any content-derived event),
    // which requires the pre-existing line to actually be read — the default (no replay) would
    // never emit it at all, which is covered separately below.
    const source = new ClaudeCodeActivitySource(harnessRoot, { replayFromStart: true });

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

  // design.md "Session discovery and aging out" — Bootstrap: "start their checkpoint at EOF
  // ... not at zero. Replaying 173k Claude lines ... would flood the scene." Default behavior
  // (no `replayFromStart`): a session with no prior checkpoint must NOT replay content already on
  // disk — only the synthetic session_start, then whatever is appended AFTER open().
  it('open() with no prior checkpoint and default options never replays pre-existing content, only newly appended lines', async () => {
    const preExistingLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
    const { root: harnessRoot, filePath } = await makeSessionFile(preExistingLine);
    const source = new ClaudeCodeActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const first = await streamIterator.next();
    expect(first.value?.event.kind).toBe('session_start');

    const newLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hello' } });
    const keepAppending = setInterval(() => { void writeFile(filePath, `${newLine}\n`, { flag: 'a' }); }, 150);
    await writeFile(filePath, `${newLine}\n`, { flag: 'a' });

    const second = await streamIterator.next();
    clearInterval(keepAppending);
    // Only the NEWLY appended `message` event ever arrives — never the pre-existing `tool_start`
    // from the line that was already on disk before `open()` was called.
    expect(second.value?.event.kind).toBe('message');

    stream.stop();
    await source.close();
  });

  // The opt-in itself (design.md: "an opt-in --replay-since exists for demos and fixture
  // capture"): with `replayFromStart: true`, the pre-existing line on disk IS replayed.
  it('open() with replayFromStart: true DOES replay content already on disk', async () => {
    const preExistingLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
    const { root: harnessRoot } = await makeSessionFile(preExistingLine);
    const source = new ClaudeCodeActivitySource(harnessRoot, { replayFromStart: true });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    await streamIterator.next(); // session_start
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
    // replayFromStart: true — this test's own pre-existing line IS the record onParentRecord must
    // see; the default (no replay) would never read it at all.
    const source = new ClaudeCodeActivitySource(harnessRoot, { onParentRecord, replayFromStart: true });

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
    // replayFromStart: true — the subagent's pre-existing line must actually be PARSED for this
    // test to prove anything; otherwise onParentRecord trivially "never called" because nothing
    // was ever read at all.
    const source = new ClaudeCodeActivitySource(root, { onParentRecord, replayFromStart: true });

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

  // design.md "Session discovery and aging out" — Bootstrap: "attach only to sessions touched
  // within `activeWindow` (24h)". Wiring test for the ActivitySource level: `discover()` must
  // forward a caller-supplied `activeWindowMs` down to `discoverClaudeCodeSessions` (already
  // proven correct in isolation by `discover.test.ts`). Deliberately uses a window SMALLER than
  // the 24h default (1s, against a sibling touched 2s ago): if the constructor option were never
  // threaded through and `discover()` fell back to the 24h default instead, the stale sibling
  // would still be well within THAT window and would incorrectly surface as a second yielded
  // value — this is what makes the test prove real wiring, not just coincide with the default.
  it('discover() excludes a session file last touched outside the configured active window', async () => {
    const { root: harnessRoot } = await makeSessionFile('{}');
    const staleDir = join(harnessRoot, 'projects', 'other-slug');
    await mkdir(staleDir, { recursive: true });
    const staleFilePath = join(staleDir, 'session-old.jsonl');
    await writeFile(staleFilePath, '{}\n');
    const twoSecondsAgo = new Date(Date.now() - 2000);
    await utimes(staleFilePath, twoSecondsAgo, twoSecondsAgo);
    const source = new ClaudeCodeActivitySource(harnessRoot, { activeWindowMs: 1000 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const withTimeout = (ms: number): Promise<{ timedOut: true } | { timedOut: false; sessionKey?: string }> =>
      Promise.race([
        iterator.next().then((r) => ({ timedOut: false as const, sessionKey: r.value?.sessionKey })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 300)),
      ]);

    const first = await withTimeout(2000);
    expect(first.timedOut).toBe(false);
    expect((first as { sessionKey?: string }).sessionKey).toBe('claude-code:session-1');

    // The stale sibling must never surface, now or later — the watcher stage that follows the
    // one-shot scan never fires for it either, so a second call hangs forever (times out).
    const second = await withTimeout(300);
    expect(second.timedOut).toBe(true);

    await source.close();
  });

  // Session aging (design.md "Session discovery and aging out") ages from the synthetic
  // `session_start`'s `at`. It must carry the session's REAL last-activity time (the transcript
  // file's mtime), never the moment `open()` happens to run — otherwise a dormant session that
  // bootstraps at EOF (only this synthetic event, no real records) looks brand-new at every
  // server restart no matter how stale its transcript actually is.
  it('open() stamps the synthetic session_start with the session\'s real last-activity time, not the moment open() was called', async () => {
    const { root: harnessRoot, filePath } = await makeSessionFile('{}');
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await utimes(filePath, tenHoursAgo, tenHoursAgo);
    const { mtimeMs } = await stat(filePath);
    const source = new ClaudeCodeActivitySource(harnessRoot);

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

  // Agent profile tracking: "the orchestrator is distinguishable from its subagents" starts at
  // the very first event a session ever produces — the synthetic session_start — so a worker is
  // never rendered with an ambiguous/absent identity even before any correlation or join runs.
  it('stamps the synthetic session_start with role: orchestrator for a root session', async () => {
    const { root: harnessRoot } = await makeSessionFile('{}');
    const source = new ClaudeCodeActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const first = await stream.events[Symbol.asyncIterator]().next();

    expect(first.value?.event.kind).toBe('session_start');
    expect(first.value?.event.agentProfile).toEqual({ role: 'orchestrator' });

    stream.stop();
    await source.close();
  });

  // Adversarial near-miss: the SAME synthetic event, but for a discovered SUBAGENT session, must
  // stamp role: subagent instead — proving the role is read from the real discovery classifier,
  // not hardcoded to one value.
  it('stamps the synthetic session_start with role: subagent for a discovered subagent session', async () => {
    root = await mktempRoot();
    const subagentDir = join(root, 'projects', 'my-slug', 'parent-1', 'subagents');
    await mkdir(subagentDir, { recursive: true });
    const filePath = join(subagentDir, 'agent-abc123.jsonl');
    await writeFile(filePath, '{}\n');
    const source = new ClaudeCodeActivitySource(root);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const first = await stream.events[Symbol.asyncIterator]().next();

    expect(first.value?.event.agentProfile).toEqual({ role: 'subagent' });

    stream.stop();
    await source.close();
  });

  // Associated-project tracking: `resolveClaudeCodeSessionCwd` (discover.ts) already resolves the
  // session's cwd at discovery time; this proves it actually lands on the synthetic
  // `session_start` event, not just on the discovered `SessionRef`.
  it('stamps the synthetic session_start with projectPath from the session\'s resolved cwd', async () => {
    const cwdLine = JSON.stringify({ cwd: '/Users/andresalvarez/Documents/pixel-agents' });
    const { root: harnessRoot } = await makeSessionFile(cwdLine);
    const source = new ClaudeCodeActivitySource(harnessRoot);

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

  // Adversarial twin: a session file with no cwd record must leave projectPath unset, never
  // guessed.
  it('leaves projectPath unset on session_start when no cwd record was found', async () => {
    const { root: harnessRoot } = await makeSessionFile('{}');
    const source = new ClaudeCodeActivitySource(harnessRoot);

    const iterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await iterator.next();
    const stream = source.open(sessionRef!, null);
    const first = await stream.events[Symbol.asyncIterator]().next();

    expect(first.value?.event.projectPath).toBeUndefined();

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

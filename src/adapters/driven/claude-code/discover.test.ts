import { mkdtemp, mkdir, writeFile, rm, stat, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { classifyClaudeCodeSessionPath, discoverClaudeCodeSessions, watchClaudeCodeSessions } from './discover';

describe('classifyClaudeCodeSessionPath', () => {
  it('classifies a top-level session file', () => {
    const filePath = join('home', '.claude', 'projects', 'my-slug', 'session-abc.jsonl');
    const ref = classifyClaudeCodeSessionPath(filePath);

    expect(ref).toEqual({
      harness: 'claude-code',
      sessionKey: 'claude-code:session-abc',
      filePath,
      isSubagent: false,
      parentSessionKey: null,
    });
  });

  it('classifies a subagent transcript and derives the parent session key from the directory name', () => {
    const filePath = join(
      'home',
      '.claude',
      'projects',
      'my-slug',
      'parent-session-1',
      'subagents',
      'agent-abc123.jsonl',
    );
    const ref = classifyClaudeCodeSessionPath(filePath);

    expect(ref).toEqual({
      harness: 'claude-code',
      sessionKey: 'claude-code:abc123',
      filePath,
      isSubagent: true,
      parentSessionKey: 'claude-code:parent-session-1',
    });
  });

  it('returns null for a path that is not a Claude Code session file', () => {
    const filePath = join('home', '.claude', 'projects', 'my-slug', 'notes.txt');
    expect(classifyClaudeCodeSessionPath(filePath)).toBeNull();
  });
});

describe('discoverClaudeCodeSessions', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('discovers top-level sessions and subagent transcripts under a projects root', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-discover-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, 'session-abc.jsonl'), '{}\n');
    const subagentsDir = join(slugDir, 'session-abc', 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(join(subagentsDir, 'agent-child1.jsonl'), '{}\n');

    const sessions = await discoverClaudeCodeSessions(root);
    const sessionKeys = sessions.map((s) => s.sessionKey).sort();

    expect(sessionKeys).toEqual(['claude-code:child1', 'claude-code:session-abc']);
    const subagent = sessions.find((s) => s.isSubagent);
    expect(subagent?.parentSessionKey).toBe('claude-code:session-abc');
  });

  // design.md "Launch <-> log correlation": Claude Code JSONL records carry a top-level `cwd`
  // field (not necessarily on the first line — earlier bootstrap-only records omit it), which is
  // the launch correlator's exact-match signal. tasks.md 25.2's recorded blocker was precisely
  // that SessionRef carried no cwd to feed it.
  it('reports the cwd field found in the session file\'s records, for launch correlation', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-discover-cwd-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });
    // First record has no cwd (bootstrap-only record, matches real observed shape); a later
    // record carries it.
    const lines = [
      JSON.stringify({ type: 'summary', sessionId: 'session-abc' }),
      JSON.stringify({ type: 'user', sessionId: 'session-abc', cwd: '/Users/dev/my-project' }),
    ];
    await writeFile(join(slugDir, 'session-abc.jsonl'), `${lines.join('\n')}\n`);

    const sessions = await discoverClaudeCodeSessions(root);

    expect(sessions[0]?.cwd).toBe('/Users/dev/my-project');
  });

  it('adversarial near-miss: a session file with NO cwd field anywhere reports cwd: null, never a guess', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-discover-no-cwd-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, 'session-abc.jsonl'), `${JSON.stringify({ type: 'summary', sessionId: 'session-abc' })}\n`);

    const sessions = await discoverClaudeCodeSessions(root);

    expect(sessions[0]?.cwd).toBeNull();
  });

  // design.md "Session discovery and aging out" — Bootstrap: "attach only to sessions touched
  // within `activeWindow` (24h)". Real trees carry hundreds of stale transcripts; unfiltered
  // discovery floods the scene with every session ever recorded (measured: 575 total vs ~16
  // actually active). A fresh file's mtime is "now", so it survives any reasonable window
  // untouched — this proves the wiring itself, not the exact boundary math (that is
  // `active-window.test.ts`'s job).
  it('excludes a session file last touched outside the active window', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-discover-window-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });
    const staleFile = join(slugDir, 'session-stale.jsonl');
    const freshFile = join(slugDir, 'session-fresh.jsonl');
    await writeFile(staleFile, '{}\n');
    await writeFile(freshFile, '{}\n');
    const oneDayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(staleFile, oneDayAgo, oneDayAgo);

    const sessions = await discoverClaudeCodeSessions(root, { activeWindowMs: 24 * 60 * 60 * 1000 });

    const sessionKeys = sessions.map((s) => s.sessionKey);
    expect(sessionKeys).toEqual(['claude-code:session-fresh']);
  });

  // Triangulation: the previous test only proves the DEFAULT clock/window path. This drives the
  // same file through the INJECTED `now`/`activeWindowMs` options instead, with the fake clock
  // placed just inside vs just outside the window relative to the file's real mtime — proving the
  // options are actually wired into the comparison, not merely accepted and ignored.
  it('honors an injected clock: the same file is included just inside the window and excluded just outside it', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-discover-window-clock-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });
    const filePath = join(slugDir, 'session-abc.jsonl');
    await writeFile(filePath, '{}\n');
    const { mtimeMs } = await stat(filePath);

    const included = await discoverClaudeCodeSessions(root, {
      now: () => mtimeMs + 1000,
      activeWindowMs: 2000,
    });
    const excluded = await discoverClaudeCodeSessions(root, {
      now: () => mtimeMs + 30_000,
      activeWindowMs: 2000,
    });

    expect(included.map((s) => s.sessionKey)).toEqual(['claude-code:session-abc']);
    expect(excluded).toEqual([]);
  });

  // Session aging (design.md "Session discovery and aging out") ages from the session's REAL last
  // write, never from when the server happened to discover it. `lastActivityAt` carries that real
  // signal downstream to the synthetic `session_start` an ActivitySource emits — it must be the
  // file's own mtime, not `discoveredAt` (which is merely "when this scan ran").
  it('carries the file\'s real mtime as lastActivityAt, distinct from discoveredAt', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-discover-last-activity-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });
    const filePath = join(slugDir, 'session-abc.jsonl');
    await writeFile(filePath, '{}\n');
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await utimes(filePath, tenHoursAgo, tenHoursAgo);
    const { mtimeMs } = await stat(filePath);

    const sessions = await discoverClaudeCodeSessions(root);

    expect(sessions[0]?.lastActivityAt).toBe(mtimeMs);
    expect(sessions[0]?.lastActivityAt).not.toBe(sessions[0]?.discoveredAt);
  });

  it('performs zero writes under the discovered root', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-discover-write-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });
    const sessionFile = join(slugDir, 'session-abc.jsonl');
    await writeFile(sessionFile, '{"type":"system"}\n');

    const before = await readFile(sessionFile, 'utf8');
    const statBefore = await stat(sessionFile);

    await discoverClaudeCodeSessions(root);

    const after = await readFile(sessionFile, 'utf8');
    const statAfter = await stat(sessionFile);

    expect(after).toBe(before);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.size).toBe(statBefore.size);
  });
});

describe('watchClaudeCodeSessions', () => {
  let root: string;
  let closeWatcher: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeWatcher) await closeWatcher();
    if (root) await rm(root, { recursive: true, force: true });
  });

  // chokidar's `ready` fires once the initial scan completes, but on macOS that does NOT guarantee
  // the fsevents stream is already delivering events for the watched tree. Writing a single file
  // on `ready` therefore races: under full-suite concurrency the write lands inside that window
  // roughly one run in five and its `add` is never delivered, timing the test out. That is an
  // environmental race in the watcher's startup, not a defect in the code under test — which is
  // simply "a new .jsonl under the root is classified and forwarded".
  //
  // So instead of betting the whole test on one write landing after one event, keep creating new
  // session files on an interval until the watcher reports one. Each retry is a DISTINCT path,
  // because chokidar emits `add` once per path and a rewrite of a missed file would only emit
  // `change`. The assertion stays exact on everything the code under test decides — the
  // `claude-code:` prefix, the session id taken from the filename, and the subagent flag.
  it('emits an add notification when a new session file appears under the root', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-watch-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });

    let retryTimer: NodeJS.Timeout | undefined;
    const discovered = await new Promise<ClaudeCodeSessionRefLike>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for add event')), 9000);
      const settle = (ref: ClaudeCodeSessionRefLike) => {
        clearTimeout(timeout);
        if (retryTimer) clearInterval(retryTimer);
        resolve(ref);
      };

      const watcher = watchClaudeCodeSessions(root, settle);
      closeWatcher = () => watcher.close();

      let attempt = 0;
      const writeOne = () => {
        attempt += 1;
        writeFile(join(slugDir, `session-new-${attempt}.jsonl`), '{}\n').catch(reject);
      };

      watcher.on('ready', () => {
        writeOne();
        retryTimer = setInterval(writeOne, 250);
      });
      watcher.on('error', reject);
    }).finally(() => {
      if (retryTimer) clearInterval(retryTimer);
    });

    expect(discovered.sessionKey).toMatch(/^claude-code:session-new-\d+$/);
    expect(discovered.isSubagent).toBe(false);
  }, 10000);

  it('resolves cwd from the new file\'s own content, for launch correlation', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-watch-cwd-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });
    const line = JSON.stringify({ type: 'user', cwd: '/Users/dev/watched-project' });

    let retryTimer: NodeJS.Timeout | undefined;
    const discovered = await new Promise<ClaudeCodeSessionRefLike>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for add event')), 9000);
      const settle = (ref: ClaudeCodeSessionRefLike) => {
        clearTimeout(timeout);
        if (retryTimer) clearInterval(retryTimer);
        resolve(ref);
      };

      const watcher = watchClaudeCodeSessions(root, settle);
      closeWatcher = () => watcher.close();

      let attempt = 0;
      const writeOne = () => {
        attempt += 1;
        writeFile(join(slugDir, `session-cwd-${attempt}.jsonl`), `${line}\n`).catch(reject);
      };

      watcher.on('ready', () => {
        writeOne();
        retryTimer = setInterval(writeOne, 250);
      });
      watcher.on('error', reject);
    }).finally(() => {
      if (retryTimer) clearInterval(retryTimer);
    });

    expect(discovered.cwd).toBe('/Users/dev/watched-project');
  }, 10000);
});

interface ClaudeCodeSessionRefLike {
  sessionKey: string;
  isSubagent: boolean;
  cwd?: string | null;
}

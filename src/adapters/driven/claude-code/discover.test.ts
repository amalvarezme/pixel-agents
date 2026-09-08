import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
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
});

interface ClaudeCodeSessionRefLike {
  sessionKey: string;
  isSubagent: boolean;
}

import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { classifyCodexSessionPath, discoverCodexSessions, watchCodexSessions } from './discover';

const ROLLOUT_FILENAME = 'rollout-2026-08-23T12-59-40-01a02fc7-3a34-7443-a79a-3ced988a0f20.jsonl';
const ROLLOUT_SESSION_ID = '01a02fc7-3a34-7443-a79a-3ced988a0f20';

describe('classifyCodexSessionPath', () => {
  it('classifies a date-partitioned rollout file (Codex Session Discovery)', () => {
    const filePath = join('home', '.codex', 'sessions', '2026', '08', '23', ROLLOUT_FILENAME);
    const ref = classifyCodexSessionPath(filePath);

    expect(ref).toEqual({
      harness: 'codex',
      sessionKey: `codex:${ROLLOUT_SESSION_ID}`,
      filePath,
    });
  });

  it('returns null for a path that is not a Codex rollout file', () => {
    const filePath = join('home', '.codex', 'sessions', '2026', '08', '23', 'notes.txt');
    expect(classifyCodexSessionPath(filePath)).toBeNull();
  });
});

describe('discoverCodexSessions', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('discovers a rollout session without requiring a flat/unpartitioned layout', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-discover-'));
    const dayDir = join(root, 'sessions', '2026', '08', '23');
    await mkdir(dayDir, { recursive: true });
    await writeFile(join(dayDir, ROLLOUT_FILENAME), '{}\n');

    const sessions = await discoverCodexSessions(root);

    expect(sessions.map((s) => s.sessionKey)).toEqual([`codex:${ROLLOUT_SESSION_ID}`]);
  });

  it('performs zero writes under the discovered root', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-discover-write-'));
    const dayDir = join(root, 'sessions', '2026', '08', '23');
    await mkdir(dayDir, { recursive: true });
    const sessionFile = join(dayDir, ROLLOUT_FILENAME);
    await writeFile(sessionFile, '{"type":"session_meta"}\n');

    const before = await readFile(sessionFile, 'utf8');
    const statBefore = await stat(sessionFile);

    await discoverCodexSessions(root);

    const after = await readFile(sessionFile, 'utf8');
    const statAfter = await stat(sessionFile);

    expect(after).toBe(before);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.size).toBe(statBefore.size);
  });
});

describe('watchCodexSessions', () => {
  let root: string;
  let closeWatcher: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeWatcher) await closeWatcher();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('emits an add notification when a new rollout file appears under the current day directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-watch-'));
    const dayDir = join(root, 'sessions', '2026', '08', '23');
    await mkdir(dayDir, { recursive: true });

    const discovered = await new Promise<{ sessionKey: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for add event')), 9000);
      const watcher = watchCodexSessions(root, dayDir, (ref) => {
        clearTimeout(timeout);
        resolve(ref);
      });
      closeWatcher = () => watcher.close();
      watcher.on('ready', () => {
        writeFile(join(dayDir, ROLLOUT_FILENAME), '{}\n').catch(reject);
      });
      watcher.on('error', reject);
    });

    expect(discovered.sessionKey).toBe(`codex:${ROLLOUT_SESSION_ID}`);
  }, 10000);
});

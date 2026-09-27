import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { classifyPiSessionPath, discoverPiSessions, resolvePiSessionCwd, watchPiSessions } from './discover';

const SESSION_ID = '01a0e06e-d6eb-7018-81fe-cc81a7736e52';
const TRANSCRIPT_FILENAME = `2026-09-27T01-15-55-499Z_${SESSION_ID}.jsonl`;
const SESSION_ID_2 = '01a0d10c-2a59-72e5-8ad7-67185b421de5';
const TRANSCRIPT_FILENAME_2 = `2026-09-24T01-33-50-553Z_${SESSION_ID_2}.jsonl`;

/** Pi's own `session` record, verbatim in shape (`~/.pi/agent/sessions/**`, version 3). */
const sessionRecord = (cwd: string, id = SESSION_ID): string =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-09-27T01:15:55.499Z', cwd });

describe('classifyPiSessionPath', () => {
  it('classifies a Pi transcript, taking the session id from after the first underscore', () => {
    const filePath = join('home', '.pi', 'agent', 'sessions', '--Users-a-proj--', TRANSCRIPT_FILENAME);

    expect(classifyPiSessionPath(filePath)).toEqual({
      harness: 'pi',
      sessionKey: `pi:${SESSION_ID}`,
      sessionId: SESSION_ID,
      filePath,
    });
  });

  it('returns null for a file that is not a Pi transcript', () => {
    const filePath = join('home', '.pi', 'agent', 'sessions', '--Users-a-proj--', 'notes.txt');
    expect(classifyPiSessionPath(filePath)).toBeNull();
  });

  it('returns null for a .jsonl with no `<timestamp>_<uuid>` shape (adversarial near-miss)', () => {
    const filePath = join('sessions', '--Users-a-proj--', 'transcript.jsonl');
    expect(classifyPiSessionPath(filePath)).toBeNull();
  });
});

describe('resolvePiSessionCwd', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("reads the transcript's own `session` record cwd, the only project signal Pi carries", async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-cwd-'));
    const filePath = join(root, TRANSCRIPT_FILENAME);
    await writeFile(filePath, `${sessionRecord('/Users/dev/pi-project')}\n`);

    expect(await resolvePiSessionCwd(filePath)).toBe('/Users/dev/pi-project');
  });

  it('returns null when no `session` record exists, rather than guessing a project', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-cwd-none-'));
    const filePath = join(root, TRANSCRIPT_FILENAME);
    await writeFile(filePath, `${JSON.stringify({ type: 'model_change', modelId: 'claude-opus-5' })}\n`);

    expect(await resolvePiSessionCwd(filePath)).toBeNull();
  });

  it('returns null for a missing file instead of throwing', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-cwd-missing-'));

    expect(await resolvePiSessionCwd(join(root, 'absent.jsonl'))).toBeNull();
  });
});

describe('discoverPiSessions', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('discovers a transcript under its encoded-cwd directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-discover-'));
    const projectDir = join(root, 'sessions', '--Users-a-Documents-proj--');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, TRANSCRIPT_FILENAME), `${sessionRecord('/Users/a/Documents/proj')}\n`);

    const sessions = await discoverPiSessions(root);

    expect(sessions.map((s) => s.sessionKey)).toEqual([`pi:${SESSION_ID}`]);
    expect(sessions[0]?.cwd).toBe('/Users/a/Documents/proj');
  });

  /**
   * Spec: "Directory-name encoding is never inverted". Pi's directory name replaces every `/`
   * with `-`, so `/tmp/a-b` and `/tmp/a/b` BOTH encode to `--tmp-a-b--`. Decoding the name would
   * have to pick one and be wrong half the time; the `session` record is the only true signal.
   */
  it('never derives cwd from the directory name, which is a lossy encoding', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-discover-lossy-'));
    const collidingDir = join(root, 'sessions', '--tmp-a-b--');
    await mkdir(collidingDir, { recursive: true });
    await writeFile(join(collidingDir, TRANSCRIPT_FILENAME), `${sessionRecord('/tmp/a-b')}\n`);
    await writeFile(
      join(collidingDir, TRANSCRIPT_FILENAME_2),
      `${sessionRecord('/tmp/a/b', SESSION_ID_2)}\n`,
    );

    const sessions = await discoverPiSessions(root);
    const byKey = new Map(sessions.map((s) => [s.sessionKey, s.cwd]));

    expect(byKey.get(`pi:${SESSION_ID}`)).toBe('/tmp/a-b');
    expect(byKey.get(`pi:${SESSION_ID_2}`)).toBe('/tmp/a/b');
  });

  it('reports the file mtime as lastActivityAt, so aging uses the real activity clock', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-discover-mtime-'));
    const projectDir = join(root, 'sessions', '--Users-a-proj--');
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, TRANSCRIPT_FILENAME);
    await writeFile(filePath, `${sessionRecord('/Users/a/proj')}\n`);
    const mtime = new Date('2026-09-27T01:00:00.000Z');
    await utimes(filePath, mtime, mtime);

    const sessions = await discoverPiSessions(root, { now: () => mtime.getTime() + 1000 });

    expect(sessions[0]?.lastActivityAt).toBe(mtime.getTime());
  });

  it('excludes a transcript last touched outside the configured active window', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-discover-window-'));
    const projectDir = join(root, 'sessions', '--Users-a-proj--');
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, TRANSCRIPT_FILENAME);
    await writeFile(filePath, `${sessionRecord('/Users/a/proj')}\n`);
    const stale = new Date('2026-09-01T00:00:00.000Z');
    await utimes(filePath, stale, stale);

    const sessions = await discoverPiSessions(root, {
      now: () => stale.getTime() + 48 * 60 * 60 * 1000,
      activeWindowMs: 24 * 60 * 60 * 1000,
    });

    expect(sessions).toEqual([]);
  });

  it('returns an empty list when the sessions root does not exist', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-discover-absent-'));

    expect(await discoverPiSessions(root)).toEqual([]);
  });
});

describe('watchPiSessions', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('reports a transcript added after the watcher started', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-watch-'));
    const sessionsRoot = join(root, 'sessions');
    const projectDir = join(sessionsRoot, '--Users-a-proj--');
    await mkdir(projectDir, { recursive: true });

    const discovered = new Promise<string>((resolve) => {
      const watcher = watchPiSessions(sessionsRoot, (ref) => {
        void watcher.close();
        resolve(ref.sessionKey);
      });
      setTimeout(() => {
        void writeFile(join(projectDir, TRANSCRIPT_FILENAME), `${sessionRecord('/Users/a/proj')}\n`);
      }, 150);
    });

    await expect(discovered).resolves.toBe(`pi:${SESSION_ID}`);
  });
});

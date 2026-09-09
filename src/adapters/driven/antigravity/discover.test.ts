import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { classifyAntigravityLogPath, discoverAntigravitySessions, watchAntigravitySessions } from './discover';

describe('classifyAntigravityLogPath', () => {
  it('classifies a CLI transcript.jsonl path', () => {
    const filePath = join(
      'home',
      '.gemini',
      'antigravity-cli',
      'brain',
      'f4c9f259-58a9-45b3-9cba-411400f4b195',
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    expect(classifyAntigravityLogPath(filePath)).toEqual({
      surface: 'cli',
      conversationId: 'f4c9f259-58a9-45b3-9cba-411400f4b195',
      isFull: false,
    });
  });

  it('classifies a CLI transcript_full.jsonl path', () => {
    const filePath = join(
      'home',
      '.gemini',
      'antigravity-cli',
      'brain',
      'f4c9f259-58a9-45b3-9cba-411400f4b195',
      '.system_generated',
      'logs',
      'transcript_full.jsonl',
    );
    expect(classifyAntigravityLogPath(filePath)).toEqual({
      surface: 'cli',
      conversationId: 'f4c9f259-58a9-45b3-9cba-411400f4b195',
      isFull: true,
    });
  });

  it('classifies an IDE transcript.jsonl path', () => {
    const filePath = join(
      'home',
      '.gemini',
      'antigravity-ide',
      'brain',
      'bdd0233c-fda1-4974-85db-483f2aae1672',
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    expect(classifyAntigravityLogPath(filePath)).toEqual({
      surface: 'ide',
      conversationId: 'bdd0233c-fda1-4974-85db-483f2aae1672',
      isFull: false,
    });
  });

  it('returns null for an unrelated file under the logs directory', () => {
    const filePath = join(
      'home',
      '.gemini',
      'antigravity-cli',
      'brain',
      'uuid1',
      '.system_generated',
      'logs',
      'notes.txt',
    );
    expect(classifyAntigravityLogPath(filePath)).toBeNull();
  });

  it('returns null for a path outside the brain/logs shape entirely', () => {
    expect(classifyAntigravityLogPath(join('home', '.gemini', 'config', 'mcp_config.json'))).toBeNull();
  });
});

describe('discoverAntigravitySessions', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('records both transcript.jsonl and transcript_full.jsonl as candidates but tails only the former (spec: transcript and transcript_full both discovered)', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-discover-'));
    const logsDir = join(root, 'antigravity-cli', 'brain', 'f4c9f259-58a9-45b3-9cba-411400f4b195', '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'transcript.jsonl'), '{}\n');
    await writeFile(join(logsDir, 'transcript_full.jsonl'), '{}\n');

    const sessions = await discoverAntigravitySessions(root);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.filePath).toBe(join(logsDir, 'transcript.jsonl'));
    expect(sessions[0]?.candidateFiles.sort()).toEqual(
      [join(logsDir, 'transcript.jsonl'), join(logsDir, 'transcript_full.jsonl')].sort(),
    );
  });

  it('surfaces an IDE session as read-only with no launch affordance (spec: IDE Root Separation)', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-discover-ide-'));
    const logsDir = join(root, 'antigravity-ide', 'brain', 'bdd0233c-fda1-4974-85db-483f2aae1672', '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'transcript.jsonl'), '{}\n');

    const sessions = await discoverAntigravitySessions(root);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.surface).toBe('ide');
    expect(sessions[0]?.launchEligible).toBe(false);
    expect(sessions[0]?.candidateFiles).toEqual([join(logsDir, 'transcript.jsonl')]);
  });

  it('marks a CLI session as launch-eligible', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-discover-cli-'));
    const logsDir = join(root, 'antigravity-cli', 'brain', 'uuid-cli-1', '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'transcript.jsonl'), '{}\n');

    const sessions = await discoverAntigravitySessions(root);

    expect(sessions[0]?.launchEligible).toBe(true);
  });

  // design.md "Launch <-> log correlation": Antigravity's transcript carries no cwd signal at
  // all, so the correlator must fall back to harness+window alone for it. `cwd` MUST be `null`
  // here, never a guessed/derived value, even though the launch spec that started this session
  // did have a real cwd.
  it('reports cwd: null — Antigravity transcripts carry no cwd signal to correlate on', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-discover-cwd-'));
    const logsDir = join(root, 'antigravity-cli', 'brain', 'uuid-cwd-1', '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'transcript.jsonl'), '{}\n');

    const sessions = await discoverAntigravitySessions(root);

    expect(sessions[0]?.cwd).toBeNull();
  });

  it('performs zero writes under the discovered root', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-discover-write-'));
    const logsDir = join(root, 'antigravity-cli', 'brain', 'uuid-1', '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    const transcriptFile = join(logsDir, 'transcript.jsonl');
    await writeFile(transcriptFile, '{}\n');

    const before = await readFile(transcriptFile, 'utf8');
    const statBefore = await stat(transcriptFile);

    await discoverAntigravitySessions(root);

    const after = await readFile(transcriptFile, 'utf8');
    const statAfter = await stat(transcriptFile);

    expect(after).toBe(before);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });
});

describe('watchAntigravitySessions', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('discovers a new CLI transcript.jsonl added after the watcher starts', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-watch-'));
    await mkdir(join(root, 'antigravity-cli'), { recursive: true });

    const discovered: string[] = [];
    const watcher = watchAntigravitySessions(root, (ref) => discovered.push(ref.sessionKey));

    await new Promise((resolve) => setTimeout(resolve, 50));
    const logsDir = join(root, 'antigravity-cli', 'brain', 'uuid-new', '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'transcript.jsonl'), '{}\n');

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (discovered.length > 0) return resolve();
        setTimeout(check, 20);
      };
      check();
    });

    expect(discovered).toEqual(['antigravity:cli:uuid-new']);
    await watcher.close();
  });

  it('ignores a newly added transcript_full.jsonl (the one-shot scan already excludes it as a primary source)', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-watch-full-'));
    await mkdir(join(root, 'antigravity-cli'), { recursive: true });

    const discovered: string[] = [];
    const watcher = watchAntigravitySessions(root, (ref) => discovered.push(ref.sessionKey));

    await new Promise((resolve) => setTimeout(resolve, 50));
    const logsDir = join(root, 'antigravity-cli', 'brain', 'uuid-full-only', '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'transcript_full.jsonl'), '{}\n');

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(discovered).toEqual([]);
    await watcher.close();
  });
});

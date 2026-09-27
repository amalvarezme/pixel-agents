/**
 * Global No-Write Invariant, Pi (spec: "Pi Zero-Write Guarantee"). Mirrors the four existing
 * zero-write proofs (`../claude-code/zero-write.test`, `../codex/zero-write.test`, …): snapshots
 * every file's content hash + mtime + inode BEFORE running discovery and a full tail pass over
 * every discovered session, then asserts the snapshot is byte-identical AFTER.
 *
 * Reuses `readTailIncrement` from the Claude Code adapter, like the Codex and Antigravity proofs
 * do — the byte-offset tailer is generic JSONL mechanics with no Claude-specific assumptions.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTailIncrement } from '../claude-code/tail';
import { discoverPiSessions } from './discover';
import {
  presenceActivityFileName,
  presenceHeaderFileName,
  readPresenceActivity,
  readPresenceHeaders,
} from './presence-read';

interface FileSnapshot {
  contentHash: string;
  mtimeMs: number;
  ino: number;
  size: number;
}

async function listAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listAllFiles(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

async function snapshotTree(dir: string): Promise<Record<string, FileSnapshot>> {
  const files = await listAllFiles(dir);
  const snapshot: Record<string, FileSnapshot> = {};
  for (const filePath of files) {
    const [content, stats] = await Promise.all([readFile(filePath), stat(filePath)]);
    snapshot[filePath] = {
      contentHash: createHash('sha256').update(content).digest('hex'),
      mtimeMs: stats.mtimeMs,
      ino: stats.ino,
      size: stats.size,
    };
  }
  return snapshot;
}

describe('Pi adapter: Global No-Write Invariant', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('performs zero writes under ~/.pi across discovery + a full tail pass', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-zero-write-'));
    const projectDir = join(root, 'sessions', '--Users-a-Documents-proj--');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, '2026-09-27T01-15-55-499Z_01a0e06e-d6eb-7018-81fe-cc81a7736e52.jsonl'),
      `${JSON.stringify({ type: 'session', version: 3, id: '01a0e06e-d6eb-7018-81fe-cc81a7736e52', cwd: '/Users/a/Documents/proj' })}\n` +
        `${JSON.stringify({ type: 'message', timestamp: '2026-09-27T01:16:58.120Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'toolCall', id: 'toolu_01', name: 'mem_save', arguments: { title: 'x' } }] } })}\n`,
    );

    const before = await snapshotTree(root);
    expect(Object.keys(before)).toHaveLength(1);

    // Simulate adapter startup: discover every session, then tail each one from a cold start.
    const sessions = await discoverPiSessions(root);
    expect(sessions).toHaveLength(1);
    for (const session of sessions) {
      const result = await readTailIncrement(session.filePath, null);
      expect(result.kind).not.toBe('no-op');
    }

    const after = await snapshotTree(root);

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
  });

  it('creates nothing when the sessions root is absent (never provisions Pi state)', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-zero-write-absent-'));

    expect(await discoverPiSessions(root)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('performs zero writes across a full read of the subagent presence registry', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-zero-write-presence-'));
    const presenceRoot = join(root, 'gentle-agents', 'presence');
    await mkdir(presenceRoot, { recursive: true });
    const sessionHash = 'a'.repeat(64);
    const incarnation = '5f6ea6c5-4745-45b1-b5bc-c9e442172deb';
    const body = JSON.stringify({
      schema: 1,
      sessionHash,
      incarnation,
      generation: 1,
      activity: {
        tasks: [
          {
            summary: {
              id: 't1',
              agent: 'sdd-apply',
              label: 'apply',
              status: 'running',
              model: 'claude-sonnet-5',
              createdAt: 1,
              startedAt: 2,
              endedAt: null,
              lastActivityAt: 3,
            },
            thread: { version: 1, dropped: 0, items: [] },
          },
        ],
      },
    });
    await writeFile(join(presenceRoot, presenceActivityFileName(sessionHash, incarnation)), body);
    await writeFile(
      join(presenceRoot, presenceHeaderFileName(sessionHash, incarnation)),
      JSON.stringify({
        schema: 1,
        sessionHash,
        incarnation,
        label: 'pixel-agents',
        heartbeat: 3,
        generation: 1,
        counts: { running: 1, queued: 0, waiting: 0, finished: 0 },
        digest: createHash('sha256').update(body).digest('hex'),
        unavailable: null,
      }),
    );

    const before = await snapshotTree(root);
    expect(Object.keys(before)).toHaveLength(2);

    const page = await readPresenceHeaders(presenceRoot, 3);
    expect(page.entries).toHaveLength(1);
    expect((await readPresenceActivity(presenceRoot, page.entries[0]!)).activity?.tasks).toHaveLength(1);

    expect(await snapshotTree(root)).toEqual(before);
  });

  it('never creates the presence directory when no subagent has ever run', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-zero-write-nopresence-'));
    const presenceRoot = join(root, 'gentle-agents', 'presence');

    const page = await readPresenceHeaders(presenceRoot, 0);

    expect(page.entries).toEqual([]);
    expect(page.unavailable).toBe('missing');
    expect(await readdir(root)).toEqual([]);
  });
});

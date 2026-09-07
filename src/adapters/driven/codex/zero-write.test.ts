/**
 * Global No-Write Invariant, Codex (tasks.md 12.9, spec: "Adapter startup performs zero
 * writes"). Mirrors the Claude Code adapter's zero-write proof (`../claude-code/zero-write.test`):
 * snapshots every file's content hash + mtime + inode BEFORE running discovery and a full tail
 * pass over every discovered session, then asserts the snapshot is byte-identical AFTER.
 *
 * Reuses `readTailIncrement` from the Claude Code adapter — the byte-offset tailer is generic
 * JSONL-file mechanics with no Claude-specific assumptions (design.md: "JSONL tailing — Claude
 * Code, Codex, Antigravity" describes ONE shared mechanism for all three), and tasks.md 12
 * deliberately does not ask for a second copy of it.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTailIncrement } from '../claude-code/tail';
import { discoverCodexSessions } from './discover';

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

describe('Codex adapter: Global No-Write Invariant', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('performs zero writes under ~/.codex across discovery + a full tail pass', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-zero-write-'));
    const dayDir = join(root, 'sessions', '2026', '08', '23');
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      join(dayDir, 'rollout-2026-08-23T12-59-40-01a02fc7-3a34-7443-a79a-3ced988a0f20.jsonl'),
      '{"type":"session_meta"}\n{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"engram","tool":"mem_save","arguments":{}}}}\n',
    );

    const before = await snapshotTree(root);
    const fileCountBefore = Object.keys(before).length;
    expect(fileCountBefore).toBe(1);

    // Simulate adapter startup: discover every session, then tail each one from a cold start.
    const sessions = await discoverCodexSessions(root);
    expect(sessions).toHaveLength(1);
    for (const session of sessions) {
      const result = await readTailIncrement(session.filePath, null);
      expect(result.kind).not.toBe('no-op');
    }

    const after = await snapshotTree(root);

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
  });
});

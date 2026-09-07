/**
 * Global No-Write Invariant, Claude Code (tasks.md 7.8, spec: "Adapter startup performs zero
 * writes"). Builds a realistic fixture tree standing in for `~/.claude`, snapshots every file's
 * content hash + mtime + inode BEFORE running discovery and a full tail pass over every
 * discovered session, then asserts the snapshot is byte-identical AFTER. This is a genuine
 * behavioral proof — it fails if any adapter code path so much as touches an mtime — not an
 * assertion taken on faith.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverClaudeCodeSessions } from './discover';
import { readTailIncrement } from './tail';

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

describe('Claude Code adapter: Global No-Write Invariant', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('performs zero writes under the harness root across discovery + a full tail pass', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-zero-write-'));
    const slugDir = join(root, 'projects', 'my-slug');
    await mkdir(slugDir, { recursive: true });
    await writeFile(
      join(slugDir, 'parent-session-1.jsonl'),
      '{"type":"system"}\n{"type":"user","toolUseResult":{"agentId":"abc123","description":"Auditar"}}\n',
    );
    const subagentsDir = join(slugDir, 'parent-session-1', 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      join(subagentsDir, 'agent-abc123.jsonl'),
      '{"type":"assistant","isSidechain":true,"agentId":"abc123"}\n',
    );

    const before = await snapshotTree(root);
    const fileCountBefore = Object.keys(before).length;
    expect(fileCountBefore).toBe(2);

    // Simulate adapter startup: discover every session, then tail each one from a cold start.
    const sessions = await discoverClaudeCodeSessions(root);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      const result = await readTailIncrement(session.filePath, null);
      expect(result.kind).not.toBe('no-op');
    }

    const after = await snapshotTree(root);

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
  });
});

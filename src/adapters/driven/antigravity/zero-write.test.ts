/**
 * Global No-Write Invariant, Antigravity (tasks.md 13.12, spec: "Adapter startup performs zero
 * writes"). Mirrors the Claude Code and Codex adapters' zero-write proofs: snapshots every file's
 * content hash + mtime + inode BEFORE running discovery, config resolution, and a full tail pass
 * over every discovered session, then asserts the snapshot is byte-identical AFTER.
 *
 * Also proves the stale `antigravity-cli/mcp_config.json` is left untouched even though it
 * exists on disk during the run (tasks.md 13.5's invariant, re-verified end-to-end here).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTailIncrement } from '../claude-code/tail';
import { readAntigravityMcpConfig } from './config';
import { discoverAntigravitySessions } from './discover';

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

describe('Antigravity adapter: Global No-Write Invariant', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('performs zero writes under ~/.gemini across discovery, config resolution, and a full tail pass', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-zero-write-'));
    const logsDir = join(root, 'antigravity-cli', 'brain', 'uuid-1', '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, 'transcript.jsonl'),
      '{"step_index":0,"source":"USER","type":"USER_QUERY","status":"DONE"}\n',
    );
    await mkdir(join(root, 'antigravity-cli'), { recursive: true });
    await writeFile(join(root, 'antigravity-cli', 'mcp_config.json'), '{"mcpServers":{"engram":{"command":"STALE"}}}');
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'mcp_config.json'), '{"mcpServers":{"engram":{"command":"live"}}}');

    const before = await snapshotTree(root);
    const fileCountBefore = Object.keys(before).length;
    expect(fileCountBefore).toBe(3);

    const sessions = await discoverAntigravitySessions(root);
    expect(sessions).toHaveLength(1);
    for (const session of sessions) {
      const result = await readTailIncrement(session.filePath, null);
      expect(result.kind).not.toBe('no-op');
    }
    const config = await readAntigravityMcpConfig(root);
    expect(config).toEqual({ mcpServers: { engram: { command: 'live' } } });

    const after = await snapshotTree(root);

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
  });
});

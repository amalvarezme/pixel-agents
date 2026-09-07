import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Checkpoint } from '../../../ports/activity-source.port';
import { FileCheckpointStore } from './file-checkpoint-store';
import { InMemoryCheckpointStore } from './in-memory-checkpoint-store';

// Requirement (tasks.md 3.4): checkpoint round-trips byte-for-byte through save/load, for both
// checkpoint shapes the design defines (design.md D1): byte-offset (JSONL tailers) and seq
// (OpenCode). "Byte-for-byte" means the loaded value is deep-equal to the saved value — no
// field dropped, reordered, or coerced.
const byteOffsetCheckpoint: Checkpoint = { kind: 'byte-offset', offset: 4096, size: 8192, inode: 778899 };
const seqCheckpoint: Checkpoint = { kind: 'seq', bySession: { 'opencode:ses_abc': 1975, 'opencode:ses_def': 12 } };

describe('InMemoryCheckpointStore', () => {
  it('round-trips a byte-offset checkpoint byte-for-byte', async () => {
    const store = new InMemoryCheckpointStore();
    await store.save('claude-code:s1', byteOffsetCheckpoint);

    const loaded = await store.load('claude-code:s1');

    expect(loaded).toEqual(byteOffsetCheckpoint);
  });

  it('round-trips a seq checkpoint byte-for-byte and returns null for an unknown session', async () => {
    const store = new InMemoryCheckpointStore();
    await store.save('opencode:ses_abc', seqCheckpoint);

    expect(await store.load('opencode:ses_abc')).toEqual(seqCheckpoint);
    expect(await store.load('opencode:ses_never_saved')).toBeNull();
  });
});

describe('FileCheckpointStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'checkpoint-store-test-'));
    filePath = join(dir, 'checkpoints.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a byte-offset checkpoint byte-for-byte across a fresh instance (simulated restart)', async () => {
    const writer = new FileCheckpointStore(filePath);
    await writer.save('codex:s1', byteOffsetCheckpoint);

    const reader = new FileCheckpointStore(filePath);
    const loaded = await reader.load('codex:s1');

    expect(loaded).toEqual(byteOffsetCheckpoint);
  });

  it('round-trips a seq checkpoint and preserves an unrelated session already on disk', async () => {
    const store = new FileCheckpointStore(filePath);
    await store.save('opencode:ses_abc', seqCheckpoint);
    await store.save('opencode:ses_other', { kind: 'seq', bySession: { 'opencode:ses_other': 3 } });

    expect(await store.load('opencode:ses_abc')).toEqual(seqCheckpoint);
    expect(await store.load('opencode:ses_other')).toEqual({ kind: 'seq', bySession: { 'opencode:ses_other': 3 } });
  });

  it('returns null for an unknown session when the file does not exist yet', async () => {
    const store = new FileCheckpointStore(join(dir, 'missing.json'));

    expect(await store.load('claude-code:never')).toBeNull();
  });

  // browser-entrypoint work unit: `ingestAgentActivity` now ingests every discovered session
  // CONCURRENTLY (see its own concurrency fix). Against a real ~/.claude/projects tree with
  // hundreds of sessions, that means hundreds of concurrent `save()` calls against the SAME
  // checkpoint file — a read-then-write with no serialization corrupts the file the moment two
  // writes interleave (reproduced live: `SyntaxError: Unexpected end of JSON input` from a torn
  // write, crashing the whole process). Every save must land, none may be lost or corrupt the file.
  it('never corrupts the file under many concurrent save() calls for DIFFERENT sessions', async () => {
    const store = new FileCheckpointStore(filePath);
    const sessionCount = 50;

    await Promise.all(
      Array.from({ length: sessionCount }, (_, i) =>
        store.save(`claude-code:s${i}`, { kind: 'byte-offset', offset: i, size: i, inode: i }),
      ),
    );

    for (let i = 0; i < sessionCount; i++) {
      expect(await store.load(`claude-code:s${i}`)).toEqual({ kind: 'byte-offset', offset: i, size: i, inode: i });
    }
  });
});

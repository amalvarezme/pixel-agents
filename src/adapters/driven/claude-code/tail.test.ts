import { mkdtemp, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTailIncrement, scanFileLines, watchAndTailFile } from './tail';

// Records the byte length of every `data` chunk that flows through the real `createReadStream`
// call made by production code, without changing stream behavior. This gives direct, honest
// evidence that `readTailIncrement` reads the increment in bounded chunks — the largest buffer
// ever handed to line-splitting/decoding is exactly one of these recorded chunk sizes, never the
// whole increment in a single call. It cannot observe V8's internal string-length limits directly
// (there is no public API for that), so this is the closest cleanly observable proxy for "never
// materializes one oversized string": bound the input chunk size, and decoding necessarily follows.
const recordedChunkSizes: number[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      stream.on('data', (chunk) => recordedChunkSizes.push((chunk as Buffer).length));
      return stream;
    },
  };
});

describe('readTailIncrement', () => {
  let dir: string;
  let filePath: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // design.md "Session discovery and aging out" — Bootstrap: "start their checkpoint at EOF
  // (`offset = size`), not at zero. Replaying 173k Claude lines ... would flood the scene."
  it('bootstraps at EOF when bootstrapFromEof is true and there is no prior checkpoint: existing content is never read', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-eof-'));
    filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"a":1}\n{"a":2}\n');
    const fileSize = Buffer.byteLength('{"a":1}\n{"a":2}\n');

    const result = await readTailIncrement(filePath, null, { bootstrapFromEof: true });

    if (result.kind === 'no-op') throw new Error('expected growth');
    expect(result.lines).toEqual([]);
    expect(result.checkpoint.offset).toBe(fileSize);
    expect(result.checkpoint.size).toBe(fileSize);
  });

  it('a subsequent read from the EOF-bootstrapped checkpoint returns only content appended AFTER bootstrap', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-eof-resume-'));
    filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"a":1}\n');
    const bootstrap = await readTailIncrement(filePath, null, { bootstrapFromEof: true });
    if (bootstrap.kind === 'no-op') throw new Error('expected growth');

    await writeFile(filePath, '{"a":2}\n', { flag: 'a' });
    const result = await readTailIncrement(filePath, bootstrap.checkpoint);

    expect(result.kind).toBe('growth');
    if (result.kind === 'no-op') throw new Error('expected growth');
    expect(result.lines).toEqual(['{"a":2}']);
  });

  it('reads growth: an initial read (null checkpoint) returns all complete lines', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-'));
    filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"a":1}\n{"a":2}\n');

    const result = await readTailIncrement(filePath, null);

    expect(result.kind).toBe('growth');
    if (result.kind !== 'growth' && result.kind !== 'reset') throw new Error('unexpected kind');
    expect(result.lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(result.checkpoint.offset).toBe(Buffer.byteLength('{"a":1}\n{"a":2}\n'));
  });

  it('reads growth: a second read from a saved checkpoint returns only newly appended lines', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-'));
    filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"a":1}\n');
    const first = await readTailIncrement(filePath, null);
    if (first.kind === 'no-op') throw new Error('expected growth');

    await writeFile(filePath, '{"a":2}\n', { flag: 'a' });
    const second = await readTailIncrement(filePath, first.checkpoint);

    expect(second.kind).toBe('growth');
    if (second.kind !== 'growth' && second.kind !== 'reset') throw new Error('unexpected kind');
    expect(second.lines).toEqual(['{"a":2}']);
  });

  it('is a no-op when the file size has not changed since the checkpoint', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-'));
    filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"a":1}\n');
    const first = await readTailIncrement(filePath, null);
    if (first.kind === 'no-op') throw new Error('expected growth');

    const second = await readTailIncrement(filePath, first.checkpoint);

    expect(second).toEqual({ kind: 'no-op' });
  });

  it('never emits a partial trailing line without a terminating newline', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-'));
    filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"a":1}\n{"a":2}');

    const result = await readTailIncrement(filePath, null);

    if (result.kind === 'no-op') throw new Error('expected growth');
    expect(result.lines).toEqual(['{"a":1}']);
    expect(result.lines.join('')).not.toContain('"a":2');

    await writeFile(filePath, '}\n', { flag: 'a' });
    const completed = await readTailIncrement(filePath, result.checkpoint);
    if (completed.kind === 'no-op') throw new Error('expected growth');
    expect(completed.lines).toEqual(['{"a":2}}']);
  });

  it('resets on truncation (same inode, smaller size) and re-reads from the start', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-'));
    filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"a":1}\n{"a":2}\n');
    const first = await readTailIncrement(filePath, null);
    if (first.kind === 'no-op') throw new Error('expected growth');

    await truncate(filePath, 0);
    await writeFile(filePath, '{"b":1}\n', { flag: 'r+' });

    const result = await readTailIncrement(filePath, first.checkpoint);

    expect(result.kind).toBe('reset');
    if (result.kind === 'no-op') throw new Error('unexpected no-op');
    expect(result.lines).toEqual(['{"b":1}']);
  });

  it('resets on rotation (new inode replaces the file at the same path)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-'));
    filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"a":1}\n');
    const first = await readTailIncrement(filePath, null);
    if (first.kind === 'no-op') throw new Error('expected growth');

    await unlink(filePath);
    await writeFile(filePath, '{"c":1}\n{"c":2}\n');
    const rotatedStat = await stat(filePath);
    expect(rotatedStat.ino).not.toBe(first.checkpoint.inode);

    const result = await readTailIncrement(filePath, first.checkpoint);

    expect(result.kind).toBe('reset');
    if (result.kind === 'no-op') throw new Error('unexpected no-op');
    expect(result.lines).toEqual(['{"c":1}', '{"c":2}']);
    expect(result.checkpoint.inode).toBe(rotatedStat.ino);
  });
});

describe('readTailIncrement — bounded chunk reading (ERR_STRING_TOO_LONG regression)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    recordedChunkSizes.length = 0;
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reads the underlying file in chunks no larger than the injected maxChunkBytes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-chunked-'));
    filePath = join(dir, 'session.jsonl');
    // 200 lines * ~30 bytes/line ~= 6000 bytes, comfortably larger than the 64-byte chunk size
    // injected below, forcing many bounded reads instead of a single whole-file read.
    const lines = Array.from({ length: 200 }, (_, i) => `{"seq":${i},"pad":"xxxxxxxxxx"}`);
    await writeFile(filePath, `${lines.join('\n')}\n`);
    const maxChunkBytes = 64;

    const result = await readTailIncrement(filePath, null, { maxChunkBytes });

    if (result.kind === 'no-op') throw new Error('expected growth');
    expect(result.lines).toEqual(lines);
    expect(recordedChunkSizes.length).toBeGreaterThan(1);
    expect(recordedChunkSizes.every((size) => size <= maxChunkBytes)).toBe(true);
  });

  it('produces the exact same lines via tiny bounded chunks as a single-shot (default) read', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-chunked-'));
    filePath = join(dir, 'session.jsonl');
    const lines = Array.from({ length: 50 }, (_, i) => `{"index":${i},"note":"hello world ${i}"}`);
    const content = `${lines.join('\n')}\n`;
    await writeFile(filePath, content);

    const wholeFileResult = await readTailIncrement(filePath, null);
    const tinyChunkResult = await readTailIncrement(filePath, null, { maxChunkBytes: 5 });

    if (wholeFileResult.kind === 'no-op' || tinyChunkResult.kind === 'no-op') {
      throw new Error('expected growth');
    }
    expect(tinyChunkResult.lines).toEqual(wholeFileResult.lines);
    expect(tinyChunkResult.checkpoint.offset).toBe(wholeFileResult.checkpoint.offset);
  });

  it('decodes a multi-byte UTF-8 character split across a chunk boundary correctly', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-utf8-'));
    filePath = join(dir, 'session.jsonl');
    // '😀' is U+1F600, encoded as 4 UTF-8 bytes (F0 9F 98 80). The 6-byte ASCII prefix plus a
    // maxChunkBytes of 9 puts the chunk boundary 3 bytes into the 4-byte character.
    const prefix = '{"a":"';
    const emoji = '\u{1F600}';
    const suffix = '"}';
    const line = `${prefix}${emoji}${suffix}`;
    await writeFile(filePath, `${line}\n`);
    expect(Buffer.byteLength(prefix, 'utf8')).toBe(6);

    const result = await readTailIncrement(filePath, null, { maxChunkBytes: 9 });

    if (result.kind === 'no-op') throw new Error('expected growth');
    expect(result.lines).toEqual([line]);
    expect(result.lines[0]).toContain(emoji);
  });

  it('carries a partial-line remainder across an internal chunk boundary without emitting it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-tail-partial-'));
    filePath = join(dir, 'session.jsonl');
    // Second line has no trailing newline and is far longer than maxChunkBytes, so it must span
    // several internal chunks yet still never be emitted as a line.
    await writeFile(filePath, '{"a":1}\n{"a":2,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"');

    const result = await readTailIncrement(filePath, null, { maxChunkBytes: 4 });

    if (result.kind === 'no-op') throw new Error('expected growth');
    expect(result.lines).toEqual(['{"a":1}']);
    expect(result.lines.join('')).not.toContain('"a":2');
    expect(recordedChunkSizes.length).toBeGreaterThan(1);
  });
});

describe('watchAndTailFile', () => {
  let dir: string;
  let closeWatcher: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeWatcher) await closeWatcher();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('emits a growth increment when the watched file is appended to', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-watch-tail-'));
    const filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"a":1}\n');

    const increment = await new Promise<Awaited<ReturnType<typeof readTailIncrement>>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for tail increment')), 9000);
      const watcher = watchAndTailFile(filePath, null, (result) => {
        if (result.kind === 'no-op') return;
        clearTimeout(timeout);
        resolve(result);
      });
      closeWatcher = () => watcher.close();
      watcher.on('ready', () => {
        writeFile(filePath, '{"a":2}\n', { flag: 'a' }).catch(reject);
      });
      watcher.on('error', reject);
    });

    if (increment.kind === 'no-op') throw new Error('unexpected no-op');
    expect(increment.lines).toEqual(['{"a":1}', '{"a":2}']);
  }, 10000);
});

// Agent profile tracking (fix: profiles under DEFAULT settings): the discovery-time profile scan
// must cover a whole large transcript for the rare qualifying line without paying JSON.parse cost
// on every line — `scanFileLines` is the cheap substring-filtered primitive that makes that
// affordable. Bounded chunk reading (small `maxChunkBytes`) proves the match is found even when it
// straddles a chunk boundary, mirroring `readTailIncrement`'s own chunk-boundary guarantee.
describe('scanFileLines', () => {
  let dir: string;
  let filePath: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('keeps only lines matching the predicate, even when the match straddles a chunk boundary', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-scan-lines-'));
    filePath = join(dir, 'session.jsonl');
    const noise = '{"type":"tool_use","name":"Read","input":{}}\n'.repeat(20);
    const target = '{"type":"tool_use","name":"Agent","input":{}}\n';
    await writeFile(filePath, `${noise}${target}${noise}`);

    const kept = await scanFileLines(filePath, (line) => line.includes('"name":"Agent"'), 32);

    expect(kept).toEqual([target.trimEnd()]);
  });

  it('returns an empty array when no line matches the predicate', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-scan-lines-empty-'));
    filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"type":"tool_use","name":"Read","input":{}}\n');

    const kept = await scanFileLines(filePath, (line) => line.includes('"name":"Agent"'), 32);

    expect(kept).toEqual([]);
  });
});

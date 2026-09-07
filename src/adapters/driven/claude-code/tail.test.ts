import { mkdtemp, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTailIncrement, watchAndTailFile } from './tail';

describe('readTailIncrement', () => {
  let dir: string;
  let filePath: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
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

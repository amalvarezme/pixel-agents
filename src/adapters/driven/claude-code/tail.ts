/**
 * JSONL tailer offset math (tasks.md 7.2/7.3, design.md "JSONL tailing — Claude Code, Codex,
 * Antigravity"). `readTailIncrement` is a pure-ish read function: given a file path and the
 * previously saved `ByteOffsetCheckpoint`, it decides growth / no-op / reset from `(size, inode)`
 * and returns only complete, newline-terminated lines.
 *
 * Checkpoint semantics: `offset` always points to the byte position immediately AFTER the last
 * complete line. A trailing fragment without `\n` is never advanced past — it is simply re-read
 * (together with whatever gets appended next) on the following call, so no separate in-memory
 * "partial buffer" needs to be persisted in the checkpoint. This is also why "size unchanged"
 * (even with an unterminated trailing fragment sitting past `offset`) is correctly a no-op: the
 * file has not grown, so there is nothing new to read yet, partial or not.
 *
 * This module never writes to the tailed file. `readTailIncrement` performs only `stat` and a
 * read stream from `offset` onward.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ByteOffsetCheckpoint } from '../../../ports/activity-source.port';

export type TailReadResult =
  | { kind: 'no-op' }
  | { kind: 'growth'; lines: string[]; checkpoint: ByteOffsetCheckpoint }
  | { kind: 'reset'; lines: string[]; checkpoint: ByteOffsetCheckpoint };

async function readFromOffset(filePath: string, start: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start });
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function splitCompleteLines(buffer: Buffer): { lines: string[]; consumedOffsetDelta: number } {
  if (buffer.length === 0) return { lines: [], consumedOffsetDelta: 0 };

  const text = buffer.toString('utf8');
  const trailingHasNewline = text.endsWith('\n');
  const parts = text.split('\n');
  // `parts.slice(0, -1)` drops the trailing element unconditionally: it is either the empty
  // string produced by a trailing `\n`, or the unterminated partial fragment — neither is ever
  // emitted as a line.
  const lines = parts.slice(0, -1);
  const partial = trailingHasNewline ? '' : (parts[parts.length - 1] ?? '');
  const partialByteLength = Buffer.byteLength(partial, 'utf8');
  return { lines, consumedOffsetDelta: buffer.length - partialByteLength };
}

async function readGrowth(
  filePath: string,
  fromOffset: number,
  inode: number,
  kind: 'growth' | 'reset',
): Promise<TailReadResult> {
  const buffer = await readFromOffset(filePath, fromOffset);
  const { lines, consumedOffsetDelta } = splitCompleteLines(buffer);
  const observedSize = fromOffset + buffer.length;
  const newOffset = fromOffset + consumedOffsetDelta;
  return {
    kind,
    lines,
    checkpoint: { kind: 'byte-offset', offset: newOffset, size: observedSize, inode },
  };
}

/**
 * Reads the increment since `previous`. `previous === null` means "no checkpoint yet": read the
 * whole current file as growth from offset 0. Never throws on rotation/truncation — those decide
 * a `reset`, not an error (spec: "Global No-Write Invariant" implies read-only recovery too).
 */
export async function readTailIncrement(
  filePath: string,
  previous: ByteOffsetCheckpoint | null,
): Promise<TailReadResult> {
  const stats = await stat(filePath);
  const inode = stats.ino;

  if (previous === null) {
    return await readGrowth(filePath, 0, inode, 'growth');
  }

  const rotatedOrTruncated = previous.inode !== inode || stats.size < previous.size;
  if (rotatedOrTruncated) {
    return await readGrowth(filePath, 0, inode, 'reset');
  }

  if (stats.size === previous.size) {
    return { kind: 'no-op' };
  }

  return await readGrowth(filePath, previous.offset, inode, 'growth');
}

/**
 * Wraps `readTailIncrement` with a chokidar watcher on a single file (design.md: "`chokidar`
 * watch -> `stat` on `change`"). Each `change` (and any late `add`, e.g. the file did not exist
 * yet at watch-start time) triggers exactly one `readTailIncrement` call; `onIncrement` is skipped
 * for `no-op` results only if the caller chooses to skip them — this wrapper always invokes it so
 * callers can observe every polling tick. The caller owns the returned watcher's lifecycle.
 */
export function watchAndTailFile(
  filePath: string,
  initialCheckpoint: ByteOffsetCheckpoint | null,
  onIncrement: (result: TailReadResult) => void,
): FSWatcher {
  let checkpoint = initialCheckpoint;
  const watcher = chokidar.watch(filePath, { ignoreInitial: true });

  const handleTick = async (): Promise<void> => {
    const result = await readTailIncrement(filePath, checkpoint);
    if (result.kind !== 'no-op') {
      checkpoint = result.checkpoint;
    }
    onIncrement(result);
  };

  watcher.on('change', () => {
    void handleTick();
  });
  watcher.on('add', () => {
    void handleTick();
  });

  return watcher;
}

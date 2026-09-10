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
import { StringDecoder } from 'node:string_decoder';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ByteOffsetCheckpoint } from '../../../ports/activity-source.port';

export type TailReadResult =
  | { kind: 'no-op' }
  | { kind: 'growth'; lines: string[]; checkpoint: ByteOffsetCheckpoint }
  | { kind: 'reset'; lines: string[]; checkpoint: ByteOffsetCheckpoint };

export interface ReadTailIncrementOptions {
  /**
   * Upper bound, in bytes, on each chunk read from the underlying file (passed to
   * `createReadStream` as `highWaterMark`). Bounding chunk size is what prevents the historical
   * `ERR_STRING_TOO_LONG` failure: on the very first read of an existing file, `offset` starts at
   * 0, so the "increment" is the whole file — for a large-enough session this used to be
   * concatenated into one `Buffer` and decoded with a single `buffer.toString('utf8')` call,
   * materializing one JavaScript string that can exceed V8's maximum string length. Injectable so
   * tests can drive it down to a handful of bytes and prove chunking works without allocating an
   * oversized fixture.
   */
  maxChunkBytes?: number;
  /**
   * When true AND there is no prior checkpoint (`previous === null`), bootstrap at EOF
   * (`offset = size`) instead of reading the whole file from offset 0 (design.md "Session
   * discovery and aging out" — Bootstrap: "start their checkpoint at EOF ... not at zero.
   * Replaying 173k Claude lines ... would flood the scene"). Defaults to false, so every existing
   * caller of `readTailIncrement(path, null)` keeps reading the whole file unless it opts in;
   * `ActivitySource.open()` flips it per its own `replayFromStart` option (default: EOF).
   */
  bootstrapFromEof?: boolean;
}

// 1 MiB default: comfortably below V8's maximum string length while still large enough that
// steady-state tailing (small increments) issues a single read in the common case.
const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;

interface ChunkedReadResult {
  lines: string[];
  bytesRead: number;
  /** Trailing text after the last complete line, not yet terminated by `\n`. Never emitted. */
  partialLine: string;
}

/**
 * Reads `filePath` from `start` onward in chunks bounded by `maxChunkBytes`, decoding and
 * splitting complete lines incrementally as each chunk arrives. Never concatenates the whole
 * increment into one `Buffer`/string — each chunk is decoded via `StringDecoder`, which also
 * transparently carries an incomplete multi-byte UTF-8 sequence at a chunk boundary over to the
 * next chunk, so a character split across two reads is still decoded correctly.
 */
async function readLinesInChunks(
  filePath: string,
  start: number,
  maxChunkBytes: number,
): Promise<ChunkedReadResult> {
  return await new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const lines: string[] = [];
    let pending = '';
    let bytesRead = 0;

    const appendDecoded = (decoded: string): void => {
      if (decoded.length === 0) return;
      const parts = (pending + decoded).split('\n');
      pending = parts.pop() ?? '';
      if (parts.length > 0) lines.push(...parts);
    };

    const stream = createReadStream(filePath, { start, highWaterMark: maxChunkBytes });
    stream.on('data', (chunk) => {
      const buf = chunk as Buffer;
      bytesRead += buf.length;
      appendDecoded(decoder.write(buf));
    });
    stream.on('end', () => {
      appendDecoded(decoder.end());
      resolve({ lines, bytesRead, partialLine: pending });
    });
    stream.on('error', reject);
  });
}

async function readGrowth(
  filePath: string,
  fromOffset: number,
  inode: number,
  kind: 'growth' | 'reset',
  maxChunkBytes: number,
): Promise<TailReadResult> {
  const { lines, bytesRead, partialLine } = await readLinesInChunks(filePath, fromOffset, maxChunkBytes);
  const partialByteLength = Buffer.byteLength(partialLine, 'utf8');
  const observedSize = fromOffset + bytesRead;
  const newOffset = fromOffset + bytesRead - partialByteLength;
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
  options: ReadTailIncrementOptions = {},
): Promise<TailReadResult> {
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  const stats = await stat(filePath);
  const inode = stats.ino;

  if (previous === null) {
    if (options.bootstrapFromEof) {
      return {
        kind: 'growth',
        lines: [],
        checkpoint: { kind: 'byte-offset', offset: stats.size, size: stats.size, inode },
      };
    }
    return await readGrowth(filePath, 0, inode, 'growth', maxChunkBytes);
  }

  const rotatedOrTruncated = previous.inode !== inode || stats.size < previous.size;
  if (rotatedOrTruncated) {
    return await readGrowth(filePath, 0, inode, 'reset', maxChunkBytes);
  }

  if (stats.size === previous.size) {
    return { kind: 'no-op' };
  }

  return await readGrowth(filePath, previous.offset, inode, 'growth', maxChunkBytes);
}

/**
 * Agent profile tracking (fix: profiles under DEFAULT settings — "profiles are state, not
 * history"): streams the WHOLE file from byte 0, using the same chunked/decoder approach as
 * `readLinesInChunks`, but keeps in memory only the lines for which `keepLine` returns true. A
 * ~29MB transcript may hold only a handful of qualifying lines (an `Agent` launch or its resolving
 * `tool_result`), spread anywhere from 4% to 98% through the file — discarding non-matching lines
 * as they stream, rather than collecting every line first, is what keeps scanning the whole file
 * affordable. `StringDecoder` still carries a multi-byte UTF-8 sequence split across a chunk
 * boundary over to the next chunk, exactly like `readLinesInChunks`.
 */
export async function scanFileLines(
  filePath: string,
  keepLine: (line: string) => boolean,
  maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES,
): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const kept: string[] = [];
    let pending = '';

    const consume = (decoded: string): void => {
      if (decoded.length === 0) return;
      const parts = (pending + decoded).split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) if (keepLine(line)) kept.push(line);
    };

    const stream = createReadStream(filePath, { highWaterMark: maxChunkBytes });
    stream.on('data', (chunk) => consume(decoder.write(chunk as Buffer)));
    stream.on('end', () => {
      consume(decoder.end());
      if (pending.length > 0 && keepLine(pending)) kept.push(pending);
      resolve(kept);
    });
    stream.on('error', reject);
  });
}

/**
 * Reads `filePath` for the byte range `[start, end)` in one bounded read (never larger than the
 * caller-chosen window), decoding via `StringDecoder` exactly like the forward-reading helpers
 * above. Used only by `scanLatestFromEnd`'s backward walk, where the window size is already
 * capped by the caller at `maxChunkBytes`.
 */
async function readByteRange(filePath: string, start: number, end: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let result = '';
    const stream = createReadStream(filePath, { start, end: end - 1 });
    stream.on('data', (chunk) => {
      result += decoder.write(chunk as Buffer);
    });
    stream.on('end', () => {
      result += decoder.end();
      resolve(result);
    });
    stream.on('error', reject);
  });
}

/**
 * Agent profile tracking, live-model recovery: walks `filePath` BACKWARD from EOF, in chunks
 * bounded by `maxChunkBytes`, checking each complete line (newest-to-oldest) against
 * `resolveFromLine` and returning the first defined result. Unlike `scanFileLines` (forward,
 * whole-file — needed because an `Agent` launch can sit anywhere from 4% to 98% through a
 * transcript), the resolved LIVE model is by definition the LAST real occurrence in the file, so
 * this can stop as soon as it finds one instead of paying for a whole-file read.
 *
 * Each backward step reads one bounded window `[start, pos)`; a line straddling the window
 * boundary is carried (as `leftover`, missing its own beginning) into the NEXT, earlier window
 * rather than being treated as complete — mirroring the forward `pending`-carry in
 * `readLinesInChunks`/`scanFileLines`, just walking the other direction.
 */
export async function scanLatestFromEnd<T>(
  filePath: string,
  resolveFromLine: (line: string) => T | undefined,
  maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES,
): Promise<T | undefined> {
  const stats = await stat(filePath);
  let pos = stats.size;
  let leftover = '';

  while (pos > 0) {
    const start = Math.max(0, pos - maxChunkBytes);
    const chunk = await readByteRange(filePath, start, pos);
    const combined = chunk + leftover;
    const parts = combined.split('\n');
    // Every part except parts[0] ends exactly where a real '\n' was in the file (see doc comment
    // above), so it is always a complete line. parts[0] is only complete when `start === 0` (the
    // true beginning of the file) — otherwise it is missing its own beginning and must be carried
    // into the next, earlier window instead of being checked here.
    const firstCompleteIndex = start === 0 ? 0 : 1;
    for (let i = parts.length - 1; i >= firstCompleteIndex; i--) {
      const resolved = resolveFromLine(parts[i] ?? '');
      if (resolved !== undefined) return resolved;
    }
    if (start === 0) return undefined;
    leftover = parts[0] ?? '';
    pos = start;
  }
  return undefined;
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

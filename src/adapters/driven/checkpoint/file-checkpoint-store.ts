/**
 * File-backed `CheckpointStore` — persists all sessions' checkpoints as one JSON object per
 * file, so a process restart resumes tailing/polling instead of replaying from scratch
 * (design.md: "Session discovery and aging out", Bootstrap).
 *
 * `save()` serializes its read-modify-write cycle through `this.writeQueue` (browser-entrypoint
 * work unit). `ingestAgentActivity` now ingests every discovered session CONCURRENTLY, so against
 * a real multi-hundred-session tree this file receives many simultaneous `save()` calls; without
 * serialization, two overlapping read-modify-write cycles interleave and either lose one write or
 * torn-write the file into invalid JSON (reproduced live against a real `~/.claude/projects/`
 * tree: `SyntaxError: Unexpected end of JSON input`, crashing the process). Chaining every save
 * onto the previous one's promise makes each read-modify-write cycle atomic relative to this
 * store's own calls, with no external locking dependency.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Checkpoint } from '../../../ports/activity-source.port';
import type { CheckpointStore } from '../../../ports/checkpoint-store.port';

type CheckpointFile = Record<string, Checkpoint>;

export class FileCheckpointStore implements CheckpointStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async save(sessionKey: string, checkpoint: Checkpoint): Promise<void> {
    const next = this.writeQueue.then(() => this.writeOne(sessionKey, checkpoint));
    // Swallow the error here so one failed write doesn't poison the queue for every save after
    // it; the caller of THIS save still observes the rejection via the returned/awaited `next`.
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async writeOne(sessionKey: string, checkpoint: Checkpoint): Promise<void> {
    const all = await this.readAll();
    all[sessionKey] = checkpoint;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(all), 'utf8');
  }

  async load(sessionKey: string): Promise<Checkpoint | null> {
    const all = await this.readAll();
    return all[sessionKey] ?? null;
  }

  private async readAll(): Promise<CheckpointFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as CheckpointFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }
}

/**
 * File-backed `CheckpointStore` — persists all sessions' checkpoints as one JSON object per
 * file, so a process restart resumes tailing/polling instead of replaying from scratch
 * (design.md: "Session discovery and aging out", Bootstrap).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Checkpoint } from '../../../ports/activity-source.port';
import type { CheckpointStore } from '../../../ports/checkpoint-store.port';

type CheckpointFile = Record<string, Checkpoint>;

export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly filePath: string) {}

  async save(sessionKey: string, checkpoint: Checkpoint): Promise<void> {
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

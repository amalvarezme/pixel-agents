/**
 * In-memory `CheckpointStore` — used for tests and the fake-adapter seam (Phase 5). No
 * persistence across process restarts; see `FileCheckpointStore` for that.
 */
import type { Checkpoint } from '../../../ports/activity-source.port';
import type { CheckpointStore } from '../../../ports/checkpoint-store.port';

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint>();

  async save(sessionKey: string, checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.set(sessionKey, checkpoint);
  }

  async load(sessionKey: string): Promise<Checkpoint | null> {
    return this.checkpoints.get(sessionKey) ?? null;
  }
}

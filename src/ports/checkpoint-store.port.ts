/**
 * Checkpoint persistence port. Adapters treat `Checkpoint` as opaque JSON; only the adapter
 * that produced a checkpoint can interpret it (design.md D1).
 */
import type { Checkpoint } from './activity-source.port';

export interface CheckpointStore {
  save(sessionKey: string, checkpoint: Checkpoint): Promise<void>;
  load(sessionKey: string): Promise<Checkpoint | null>;
}

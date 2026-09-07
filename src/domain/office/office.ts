/**
 * Office aggregate — TYPES ONLY for slice 1a. Behavior (worker movement, archive animation,
 * carry-queue collapse) is out of scope here and lands in slice 4 (design.md: "Slicing").
 */
import type { HarnessId } from '../events/types';

export type WorkerActivity = 'working' | 'idle';

export interface Worker {
  sessionKey: string;
  harness: HarnessId;
  label: string;
  activity: WorkerActivity;
  laneId: string | null;
}

export interface ArchiveSlot {
  slotIndex: number;
  occupiedBySessionKey: string | null;
}

export interface CarryJob {
  sessionKey: string;
  queuedAt: number;
}

export interface OfficeState {
  workers: Map<string, Worker>;
  archiveSlots: ArchiveSlot[];
  /** Per-worker FIFO carry queue; slice 4 owns collapsing this beyond `maxQueued`. */
  carryQueues: Map<string, CarryJob[]>;
}

export const ARCHIVE_SLOT_COUNT = 4;

export function createOfficeState(archiveSlotCount = ARCHIVE_SLOT_COUNT): OfficeState {
  return {
    workers: new Map(),
    archiveSlots: Array.from({ length: archiveSlotCount }, (_, slotIndex) => ({
      slotIndex,
      occupiedBySessionKey: null,
    })),
    carryQueues: new Map(),
  };
}

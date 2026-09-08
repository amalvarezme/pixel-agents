/**
 * Client-side office projection (tasks.md 10.4: "OfficeContainer owns the SSE subscription and
 * client projection"). Pure, canvas-free, reusable both by `OfficeContainer` (folding the live
 * SSE stream) and by `ui/scene/pixi/` renderer input.
 *
 * Combines the domain's structural projection (`applyEventToOfficeState`, `domain/office/office`)
 * with the pure layout math (`office-layout.ts`) into one renderable view model.
 */
import type { HarnessId } from '../../domain/events/types';
import type { OfficeState } from '../../domain/office/office';
import { computeArchivePath, type ScenePoint } from '../scene/layout/archive-path';
import { computeOfficeLayout, type DeskLane, type LayoutWorkerInput } from '../scene/layout/office-layout';

/** memory_write archive-trip animation data (tasks.md 21.2-21.4). `path` is harness-agnostic —
 * it is computed from the worker's desk position alone, never from `harness`. */
export interface ArchiveTripView {
  path: ScenePoint[];
  /** ×N badge count — 1 for a single document, >1 once a batch (carry-queue.ts) is promoted. */
  carryCount: number;
  /** Set by the render half (`ui/scene/animation/trip-animation.ts`'s `applyTripOverlay`) while
   * the worker is dwelling at the archive cabinet (blocker B.2: "a brief highlight fires").
   * `undefined` from `buildOfficeViewModel` itself — this field is animation-clock state, not
   * something the structural projection can know. */
  highlight?: boolean;
  /** Set by the render half: true for the whole trip once animation playback has started. */
  showDocument?: boolean;
}

export interface WorkerViewModel {
  sessionKey: string;
  harness: HarnessId;
  label: string;
  x: number;
  y: number;
  lane: DeskLane;
  /** Normalized tool_start caption pair (design.md "Captions"), resolved upstream per-harness. */
  toolLabel?: string;
  toolDetail?: string;
  archiveTrip?: ArchiveTripView;
}

export interface OfficeViewModel {
  workers: WorkerViewModel[];
  overflowCount: number;
  /** Cumulative count of trips that have reached the archive cabinet (blocker B.2: "a per-archive
   * counter increments"). Set by the render half's `applyTripOverlay`; `undefined`/`0` from
   * `buildOfficeViewModel` itself, which has no animation clock to count against. */
  archiveCount?: number;
}

/** Projects the current `OfficeState` into a renderable `OfficeViewModel`. Pure — no I/O. */
export function buildOfficeViewModel(state: OfficeState): OfficeViewModel {
  const workers = [...state.workers.values()];
  const layoutInputs: LayoutWorkerInput[] = workers.map((w) => ({
    sessionKey: w.sessionKey,
    parentSessionKey: w.parentSessionKey,
  }));
  const layout = computeOfficeLayout(layoutInputs);
  const deskBySessionKey = new Map(layout.desks.map((d) => [d.sessionKey, d]));

  const viewModelWorkers: WorkerViewModel[] = [];
  for (const worker of workers) {
    const desk = deskBySessionKey.get(worker.sessionKey);
    if (!desk) continue; // beyond MAX_PACKED_WORKERS — counted in overflowCount instead
    const held = state.carryQueues.get(worker.sessionKey)?.held;
    viewModelWorkers.push({
      sessionKey: worker.sessionKey,
      harness: worker.harness,
      label: worker.label,
      x: desk.x,
      y: desk.y,
      lane: desk.lane,
      ...(worker.toolLabel !== undefined ? { toolLabel: worker.toolLabel, toolDetail: worker.toolDetail } : {}),
      ...(held ? { archiveTrip: { path: computeArchivePath({ x: desk.x, y: desk.y }), carryCount: held.count } } : {}),
    });
  }

  return { workers: viewModelWorkers, overflowCount: layout.overflowCount };
}

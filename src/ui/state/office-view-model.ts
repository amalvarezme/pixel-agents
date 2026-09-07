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
import { computeOfficeLayout, type DeskLane, type LayoutWorkerInput } from '../scene/layout/office-layout';

export interface WorkerViewModel {
  sessionKey: string;
  harness: HarnessId;
  label: string;
  x: number;
  y: number;
  lane: DeskLane;
}

export interface OfficeViewModel {
  workers: WorkerViewModel[];
  overflowCount: number;
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
    viewModelWorkers.push({
      sessionKey: worker.sessionKey,
      harness: worker.harness,
      label: worker.label,
      x: desk.x,
      y: desk.y,
      lane: desk.lane,
    });
  }

  return { workers: viewModelWorkers, overflowCount: layout.overflowCount };
}

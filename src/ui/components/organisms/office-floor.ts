/**
 * Office floor organism (tasks.md 10.5): the complete, drawable scene description that
 * `ui/scene/pixi/` turns into actual PixiJS sprites. Assembles the `worker` molecules from one
 * `OfficeViewModel` — the container/presentational boundary output.
 *
 * There are no desks in it any more: the room's eleven workstations are painted into the
 * background artwork (`scene/world/office-map.ts`), so the only thing the scene still has to
 * place is the people.
 */
import type { OfficeViewModel } from '../../state/office-view-model';
import { buildWorkerView, type WorkerView } from '../molecules/worker';

export interface OfficeFloorView {
  workers: WorkerView[];
  overflowCount: number;
  /** Blocker B.2 (tasks.md 21.2): cumulative archive-trip count, drawn near the cabinet. */
  archiveCount: number;
}

export function buildOfficeFloorView(viewModel: OfficeViewModel): OfficeFloorView {
  return {
    workers: viewModel.workers.map((w) => buildWorkerView(w)),
    overflowCount: viewModel.overflowCount,
    archiveCount: viewModel.archiveCount ?? 0,
  };
}

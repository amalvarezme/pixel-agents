/**
 * Office floor organism (tasks.md 10.5): the complete, drawable scene description that
 * `ui/scene/pixi/` turns into actual PixiJS sprites. Assembles the `desk` and `worker` molecules
 * from one `OfficeViewModel` — the container/presentational boundary output.
 */
import type { OfficeViewModel } from '../../state/office-view-model';
import { buildDeskView, type DeskView } from '../molecules/desk';
import { buildWorkerView, type WorkerView } from '../molecules/worker';

export interface OfficeFloorView {
  desks: DeskView[];
  workers: WorkerView[];
  overflowCount: number;
  /** Blocker B.2 (tasks.md 21.2): cumulative archive-trip count, drawn near the cabinet. */
  archiveCount: number;
}

export function buildOfficeFloorView(viewModel: OfficeViewModel): OfficeFloorView {
  const ctx = { totalWorkerCount: viewModel.workers.length };
  return {
    desks: viewModel.workers.map((w) => buildDeskView({ sessionKey: w.sessionKey, x: w.x, y: w.y, lane: w.lane }, ctx)),
    workers: viewModel.workers.map((w) => buildWorkerView(w)),
    overflowCount: viewModel.overflowCount,
    archiveCount: viewModel.archiveCount ?? 0,
  };
}

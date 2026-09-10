/**
 * Worker molecule (tasks.md 10.5). Combines the `badge` and `caption` atoms with a worker's
 * resolved layout position into one drawable descriptor. No PixiJS import — `ui/scene/pixi/`
 * consumes this descriptor to draw the actual sprite.
 */
import type { DeskLane } from '../../scene/layout/office-layout';
import type { WorkerViewModel } from '../../state/office-view-model';
import { buildHarnessBadge, type HarnessBadge } from '../atoms/badge';
import { buildCaption } from '../atoms/caption';

/** Archive-trip drawing data (blocker B.2, tasks.md 21.2) — carried through unchanged from
 * `WorkerViewModel.archiveTrip`; presence alone means "draw a carried document". */
export interface WorkerArchiveTripView {
  carryCount: number;
  highlight: boolean;
}

export interface WorkerView {
  sessionKey: string;
  x: number;
  y: number;
  lane: DeskLane;
  badge: HarnessBadge;
  caption: string;
  archiveTrip?: WorkerArchiveTripView;
}

export function buildWorkerView(worker: WorkerViewModel): WorkerView {
  return {
    sessionKey: worker.sessionKey,
    x: worker.x,
    y: worker.y,
    lane: worker.lane,
    badge: buildHarnessBadge(worker.harness),
    caption: buildCaption(
      worker.label,
      worker.toolLabel ? { toolLabel: worker.toolLabel, toolDetail: worker.toolDetail } : undefined,
      worker.agentProfile,
    ),
    ...(worker.archiveTrip
      ? { archiveTrip: { carryCount: worker.archiveTrip.carryCount, highlight: worker.archiveTrip.highlight ?? false } }
      : {}),
  };
}

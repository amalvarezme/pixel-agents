/**
 * Worker molecule (tasks.md 10.5). Combines the `badge` and `caption` atoms with a worker's
 * resolved layout position into one drawable descriptor. No PixiJS import — `ui/scene/pixi/`
 * consumes this descriptor to draw the actual sprite.
 */
import type { DeskLane } from '../../scene/layout/office-layout';
import type { WorkerViewModel } from '../../state/office-view-model';
import { buildHarnessBadge, type HarnessBadge } from '../atoms/badge';
import { buildCaption } from '../atoms/caption';

export interface WorkerView {
  sessionKey: string;
  x: number;
  y: number;
  lane: DeskLane;
  badge: HarnessBadge;
  caption: string;
}

export function buildWorkerView(worker: WorkerViewModel): WorkerView {
  return {
    sessionKey: worker.sessionKey,
    x: worker.x,
    y: worker.y,
    lane: worker.lane,
    badge: buildHarnessBadge(worker.harness),
    caption: buildCaption(worker.label),
  };
}

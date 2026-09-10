/**
 * Worker molecule (tasks.md 10.5). Combines the `badge` and `caption` atoms with a worker's
 * resolved layout position into one drawable descriptor. No PixiJS import — `ui/scene/pixi/`
 * consumes this descriptor to draw the actual sprite.
 */
import type { DeskLane } from '../../scene/layout/office-layout';
import type { WorkerViewModel } from '../../state/office-view-model';
import type { WorkerActivity } from '../../../domain/office/office';
import type { AgentProfile } from '../../../domain/agents/agent-profile';
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
  /** Carried straight through from `WorkerViewModel.activity` — the pixi renderer uses it to pick
   * the drawn idle/working animation state (`ui/scene/character/animation-state.ts`). */
  activity?: WorkerActivity;
  /** Carried straight through from `WorkerViewModel.agentProfile` — the pixi renderer uses
   * `role`/`model` to pick the orchestrator/subagent silhouette and the model accent colour. */
  agentProfile?: AgentProfile;
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
    ...(worker.activity !== undefined ? { activity: worker.activity } : {}),
    ...(worker.agentProfile ? { agentProfile: worker.agentProfile } : {}),
    ...(worker.archiveTrip
      ? { archiveTrip: { carryCount: worker.archiveTrip.carryCount, highlight: worker.archiveTrip.highlight ?? false } }
      : {}),
  };
}

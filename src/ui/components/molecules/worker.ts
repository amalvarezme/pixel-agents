/**
 * Worker molecule (tasks.md 10.5). Combines the `badge` and `caption` atoms with a worker's
 * resolved layout position into one drawable descriptor. No PixiJS import — `ui/scene/pixi/`
 * consumes this descriptor to draw the actual sprite.
 */
import type { WorkerViewModel } from '../../state/office-view-model';
import type { WorkerActivity } from '../../../domain/office/office';
import type { AgentProfile } from '../../../domain/agents/agent-profile';
import { resolveCharacterScale, type CharacterDirection } from '../../scene/character/character-sprite';
import { buildHarnessBadge, type HarnessBadge } from '../atoms/badge';
import { buildCaption } from '../atoms/caption';
import { buildAgentTooltip, type AgentTooltipView } from '../atoms/agent-tooltip';

/** Archive-trip drawing data (blocker B.2, tasks.md 21.2) — carried through unchanged from
 * `WorkerViewModel.archiveTrip`; presence alone means "draw a carried document". */
export interface WorkerArchiveTripView {
  carryCount: number;
  highlight: boolean;
  /** Which way the character is heading on the current leg — carried through only once the render
   * half (`applyTripOverlay`) has resolved it; absent from a structural-only view model. */
  direction?: CharacterDirection;
}

export interface WorkerView {
  sessionKey: string;
  /** The character's FEET, in the map's image-pixel coordinates. */
  x: number;
  y: number;
  /** The whole-number scale the character is drawn at — the room's perspective at `y` plus the
   * role bonus (`resolveCharacterScale`). Resolved here, once, so the renderer and the hover
   * hit-test can never disagree about how big a figure is. */
  scale: number;
  badge: HarnessBadge;
  caption: string;
  /** Untruncated hover-tooltip content (`ui/scene/layout/hover-hit-test.ts` drives the DOM
   * overlay that displays it) — unlike `caption`, this is never bounded by the desk-spacing
   * caption budget, since a DOM tooltip does not need to avoid colliding with neighbours. */
  tooltip: AgentTooltipView;
  /** Carried straight through from `WorkerViewModel.activity` — the pixi renderer uses it to pick
   * the drawn idle/working animation state (`ui/scene/character/animation-state.ts`). */
  activity?: WorkerActivity;
  /** Carried straight through from `WorkerViewModel.agentProfile` — the pixi renderer uses
   * `role`/`model` to pick the orchestrator/subagent silhouette and the model accent colour. */
  agentProfile?: AgentProfile;
  /** Carried straight through from `WorkerViewModel.projectPath` — the pixi renderer resolves it
   * into the project's character colour (`resolveProjectCharacterColor`), shared by every worker
   * under that project regardless of role. */
  projectPath?: string;
  archiveTrip?: WorkerArchiveTripView;
}

export function buildWorkerView(worker: WorkerViewModel): WorkerView {
  const badge = buildHarnessBadge(worker.harness);

  return {
    sessionKey: worker.sessionKey,
    x: worker.x,
    y: worker.y,
    scale: resolveCharacterScale(worker.y, worker.agentProfile?.role ?? 'subagent'),
    badge,
    caption: buildCaption(
      worker.label,
      worker.toolLabel ? { toolLabel: worker.toolLabel, toolDetail: worker.toolDetail } : undefined,
      worker.agentProfile,
    ),
    tooltip: buildAgentTooltip({
      harnessName: badge.name,
      role: worker.agentProfile?.role,
      agentType: worker.agentProfile?.agentType,
      model: worker.agentProfile?.model,
      requestedModel: worker.agentProfile?.requestedModel,
      task: worker.agentProfile?.task,
      toolLabel: worker.toolLabel,
      toolDetail: worker.toolDetail,
      projectPath: worker.projectPath,
    }),
    ...(worker.activity !== undefined ? { activity: worker.activity } : {}),
    ...(worker.agentProfile ? { agentProfile: worker.agentProfile } : {}),
    ...(worker.projectPath !== undefined ? { projectPath: worker.projectPath } : {}),
    ...(worker.archiveTrip
      ? {
          archiveTrip: {
            carryCount: worker.archiveTrip.carryCount,
            highlight: worker.archiveTrip.highlight ?? false,
            ...(worker.archiveTrip.direction !== undefined ? { direction: worker.archiveTrip.direction } : {}),
          },
        }
      : {}),
  };
}

/**
 * Agent tooltip atom — pure content builder for the DOM hover-tooltip overlay. No DOM, no
 * PixiJS: PixiJS interactivity is destroyed by the full scene-graph rebuild on every animation
 * frame (`updateStage` in `ui/scene/pixi/pixi-office-renderer.ts`), so the tooltip is a DOM
 * overlay driven by a pure hit-test (`ui/scene/layout/hover-hit-test.ts`), and this module is the
 * pure half that decides WHAT it says.
 *
 * Always exactly five rows: Project / Agent / Role / Model / Task.
 *
 * Model row contract (mirrors `domain/agents/agent-profile.ts`'s own contract literally):
 * `model` is the RESOLVED, LIVE running model; `requestedModel` is only what a subagent was
 * LAUNCHED with. `requestedModel` must never be displayed as, or mistaken for, the running
 * model — it always carries an explicit "(requested: ...)" marker. A missing model stays
 * visibly "Unknown", never invented or substituted.
 */
import type { AgentRole } from '../../../domain/agents/agent-profile';

export interface AgentTooltipRow {
  label: string;
  value: string;
}

export interface AgentTooltipView {
  rows: AgentTooltipRow[];
}

export interface AgentTooltipSource {
  /** Full product name (e.g. `Claude Code`), from the harness badge's `name` field. */
  harnessName: string;
  role?: AgentRole;
  agentType?: string;
  model?: string;
  requestedModel?: string;
  task?: string;
  toolLabel?: string;
  toolDetail?: string;
}

const UNKNOWN = 'Unknown';
/** Defect fix: the Task row used to fall back to the worker's `label`. But `office.ts` resolves
 * `label: patch.label ?? existing?.label ?? sessionKey` — so a harness that reports no label makes
 * the label BE the session key, and the tooltip printed a raw `claude-code:<uuid>` under "Task".
 * A session identity is not a task. With no task and no tool caption, say so explicitly instead. */
const NO_TASK = 'No task reported';

/** Generous cap so a pathological value cannot blow up the panel. Deliberately much larger than
 * the on-canvas caption budget (`CAPTION_MAX_CHARS`, `atoms/caption.ts`) — that budget exists
 * only to stop neighbouring on-canvas captions colliding and does not apply to a DOM tooltip. */
const TASK_MAX_CHARS = 120;
const TASK_ELLIPSIS = '…';

/** Treats a blank string the same as "absent" throughout the Task fallback chain, so an empty
 * `task`/`toolLabel` value falls through to the next source instead of winning. */
function presence(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function truncateTask(value: string): string {
  if (value.length <= TASK_MAX_CHARS) return value;
  return `${value.slice(0, TASK_MAX_CHARS - TASK_ELLIPSIS.length)}${TASK_ELLIPSIS}`;
}

function buildRoleValue(source: AgentTooltipSource): string {
  if (!source.role) return UNKNOWN;
  if (source.role === 'orchestrator') return 'Orchestrator';
  return source.agentType ? `Subagent (${source.agentType})` : 'Subagent';
}

/** Never defaults or backfills `model` from `requestedModel` — the same rule the domain type
 * itself documents. A `requestedModel`-only worker renders `unknown (requested: <alias>)`,
 * never bare, so it can never be mistaken for a resolved running model. */
function buildModelValue(source: AgentTooltipSource): string {
  const { model, requestedModel } = source;
  if (model && requestedModel) return model === requestedModel ? model : `${model} (requested: ${requestedModel})`;
  if (model) return model;
  if (requestedModel) return `unknown (requested: ${requestedModel})`;
  return UNKNOWN;
}

function buildTaskValue(source: AgentTooltipSource): string {
  const task = presence(source.task);
  if (task) return truncateTask(task);

  const toolLabel = presence(source.toolLabel);
  if (toolLabel) {
    const toolDetail = presence(source.toolDetail);
    return truncateTask(toolDetail ? `${toolLabel}: ${toolDetail}` : toolLabel);
  }

  return NO_TASK;
}

export function buildAgentTooltip(source: AgentTooltipSource): AgentTooltipView {
  return {
    rows: [
      { label: 'Agent', value: source.harnessName },
      { label: 'Role', value: buildRoleValue(source) },
      { label: 'Model', value: buildModelValue(source) },
      { label: 'Task', value: buildTaskValue(source) },
    ],
  };
}

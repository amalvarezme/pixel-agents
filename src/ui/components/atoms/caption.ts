/**
 * Caption atom (tasks.md 10.3, 10.5, 21.5). Shows the worker's resolved label by default; when a
 * normalized `{toolLabel, toolDetail}` pair is supplied (design.md "Captions") it takes priority.
 *
 * This function takes NO `harness` parameter at all — every harness's own resolver (one per
 * adapter, e.g. `resolveClaudeCodeToolCaption`) has already reduced its harness-specific record
 * shape down to this one normalized pair before it ever reaches here, so this atom structurally
 * cannot branch on harness (memory-write-visualization spec's isolation principle, reused here
 * for the same reason: no shared or harness-aware logic at the shared boundary).
 */
import { MIN_SEAT_SPACING } from '../../scene/layout/office-layout';
import type { AgentRole } from '../../../domain/agents/agent-profile';

const EMPTY_LABEL_PLACEHOLDER = '(unnamed worker)';
const CAPTION_ELLIPSIS = '…';

/**
 * Average glyph width heuristic for the renderer's caption font (`CAPTION_STYLE` in
 * `office-scene-renderer.ts`). This module stays canvas-free (design.md D3: "PixiJS behind a
 * pure-layout boundary") so it cannot ask PixiJS for real glyph metrics — ~55% of font size is a
 * standard approximation for a typical sans-serif at this size.
 */
const AVG_CAPTION_CHAR_WIDTH_PX = 6;
/** Leaves headroom below the full seat-to-seat gap so two neighbours' full-budget captions, both
 * centred over their own character, never touch (G.2: "worker captions overlap horizontally"). */
const CAPTION_WIDTH_SAFETY_MARGIN = 0.85;

/**
 * G.2 fix: derives how many caption characters fit before two neighbours' captions would collide,
 * from the SAME seat spacing the layout math already measures off the map — one source of truth
 * instead of a magic number duplicated in the renderer. Pure and deterministic.
 */
export function computeMaxCaptionChars(seatSpacing: number): number {
  return Math.max(1, Math.floor((seatSpacing * CAPTION_WIDTH_SAFETY_MARGIN) / AVG_CAPTION_CHAR_WIDTH_PX));
}

export const CAPTION_MAX_CHARS = computeMaxCaptionChars(MIN_SEAT_SPACING);

/** Truncates `caption` to at most `maxChars`, appending an ellipsis when truncation occurs.
 * Desk positions stay stable — this only bounds caption WIDTH, never repositions a desk. */
export function truncateCaption(caption: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (caption.length <= maxChars) return caption;
  if (maxChars <= CAPTION_ELLIPSIS.length) return CAPTION_ELLIPSIS.slice(0, maxChars);
  return `${caption.slice(0, maxChars - CAPTION_ELLIPSIS.length)}${CAPTION_ELLIPSIS}`;
}

export interface ToolCaptionSource {
  toolLabel: string;
  toolDetail?: string;
}

/**
 * Agent profile tracking: "at minimum the agent type and model on/near the worker, and the task
 * available as the caption detail" — the profile equivalent of `ToolCaptionSource`. Harness-
 * agnostic data (role/agentType/model/task), never a `harness` field, so this atom stays
 * structurally unable to branch on harness.
 */
export interface AgentProfileCaptionSource {
  role: AgentRole;
  agentType?: string;
  /** The resolved, LIVE running model — shown in preference to `requestedModel` once known. */
  model?: string;
  /** The launch's requested model alias — shown only until the resolved `model` arrives. */
  requestedModel?: string;
  task?: string;
}

/** "sdd-apply (sonnet)" / "orchestrator" / "subagent (opus)" — identity first, model in
 * parens only when known (the resolved live model, falling back to the requested alias before
 * it arrives); never invents a model that was never reported. */
function formatAgentProfileIdentity(profile: AgentProfileCaptionSource): string {
  const identity = profile.role === 'orchestrator' ? 'orchestrator' : (profile.agentType ?? 'subagent');
  const displayModel = profile.model ?? profile.requestedModel;
  return displayModel ? `${identity} (${displayModel})` : identity;
}

export function buildCaption(
  label: string,
  tool?: ToolCaptionSource,
  profile?: AgentProfileCaptionSource,
  maxChars: number = CAPTION_MAX_CHARS,
): string {
  const raw =
    tool && tool.toolLabel.length > 0
      ? tool.toolDetail
        ? `${tool.toolLabel}: ${tool.toolDetail}`
        : tool.toolLabel
      : profile
        ? profile.task
          ? `${formatAgentProfileIdentity(profile)}: ${profile.task}`
          : formatAgentProfileIdentity(profile)
        : label.length > 0
          ? label
          : EMPTY_LABEL_PLACEHOLDER;
  return truncateCaption(raw, maxChars);
}

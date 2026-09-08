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
import { DESK_SPACING } from '../../scene/layout/office-layout';

const EMPTY_LABEL_PLACEHOLDER = '(unnamed worker)';
const CAPTION_ELLIPSIS = '…';

/**
 * Average glyph width heuristic for the renderer's fixed 14px caption font (`CAPTION_STYLE` in
 * `office-scene-renderer.ts`). This module stays canvas-free (design.md D3: "PixiJS behind a
 * pure-layout boundary") so it cannot ask PixiJS for real glyph metrics — ~55% of font size is a
 * standard approximation for a typical sans-serif at this size.
 */
const AVG_CAPTION_CHAR_WIDTH_PX = 8;
/** Leaves headroom below the full desk-to-desk gap so two adjacent full-budget captions, both
 * centered under their desk, never touch (G.2: "worker captions overlap horizontally"). */
const CAPTION_WIDTH_SAFETY_MARGIN = 0.85;

/**
 * G.2 fix: derives how many caption characters fit before adjacent desks' captions would
 * collide, from the SAME `DESK_SPACING` the layout math already uses — one source of truth
 * instead of a magic number duplicated in the renderer. Pure and deterministic.
 */
export function computeMaxCaptionChars(deskSpacing: number): number {
  return Math.max(1, Math.floor((deskSpacing * CAPTION_WIDTH_SAFETY_MARGIN) / AVG_CAPTION_CHAR_WIDTH_PX));
}

export const CAPTION_MAX_CHARS = computeMaxCaptionChars(DESK_SPACING);

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

export function buildCaption(label: string, tool?: ToolCaptionSource, maxChars: number = CAPTION_MAX_CHARS): string {
  const raw =
    tool && tool.toolLabel.length > 0
      ? tool.toolDetail
        ? `${tool.toolLabel}: ${tool.toolDetail}`
        : tool.toolLabel
      : label.length > 0
        ? label
        : EMPTY_LABEL_PLACEHOLDER;
  return truncateCaption(raw, maxChars);
}

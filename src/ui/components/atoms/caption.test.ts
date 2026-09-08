import { describe, expect, it } from 'vitest';
import { buildCaption, CAPTION_MAX_CHARS, computeMaxCaptionChars, truncateCaption } from './caption';
import { DESK_SPACING } from '../../scene/layout/office-layout';

describe('buildCaption (atom) — the caption strip text shown under a worker (tasks.md 10.3)', () => {
  it('uses the worker label as the caption text', () => {
    expect(buildCaption('agent-1a2b3c4d')).toBe('agent-1a2b3c4d');
  });

  it('falls back to a placeholder when the label is empty', () => {
    expect(buildCaption('')).toBe('(unnamed worker)');
  });

  // Task 21.5: normalized {toolLabel, toolDetail} caption pair on tool_start, sourced per-harness
  // UPSTREAM of this atom (design.md "Captions") — buildCaption itself takes only the already-
  // resolved pair, with NO `harness` parameter at all, so it structurally cannot branch on it.
  it('prefers the normalized toolLabel/toolDetail pair over the plain label when both are present', () => {
    expect(buildCaption('my-session', { toolLabel: 'Read', toolDetail: 'design.md' })).toBe('Read: design.md');
  });

  it('renders toolLabel alone when no toolDetail was resolved', () => {
    expect(buildCaption('my-session', { toolLabel: 'CommandExecution' })).toBe('CommandExecution');
  });

  it('falls back to the plain label when no tool caption is supplied at all', () => {
    expect(buildCaption('my-session', undefined)).toBe('my-session');
  });
});

// G.2: "worker captions overlap horizontally when several workers sit adjacent on the packed
// row" — harness-specific captions (e.g. `McpToolCall: engram/mem_save`) are long enough to run
// into the neighboring desk's caption at `DESK_SPACING`. Fix: truncate to a caption-width budget
// derived from `DESK_SPACING` with an ellipsis, keeping desk positions themselves untouched. This
// is a pure, canvas-free function with its own tests — not a magic number buried in the renderer
// (`office-scene-renderer.ts` never computes real glyph widths; it just draws `worker.caption`).
describe('computeMaxCaptionChars (pure — derives the caption-width budget from desk spacing)', () => {
  it('returns a smaller character budget for a narrower desk spacing', () => {
    const wide = computeMaxCaptionChars(200);
    const narrow = computeMaxCaptionChars(100);

    expect(narrow).toBeLessThan(wide);
    expect(narrow).toBeGreaterThan(0);
  });

  it('never returns less than 1 char even for a degenerate zero spacing', () => {
    expect(computeMaxCaptionChars(0)).toBe(1);
  });

  it('CAPTION_MAX_CHARS is derived from the real DESK_SPACING, not a hardcoded duplicate', () => {
    expect(CAPTION_MAX_CHARS).toBe(computeMaxCaptionChars(DESK_SPACING));
  });
});

describe('truncateCaption (pure — G.2 ellipsis truncation)', () => {
  it('returns the caption unchanged when it already fits within maxChars', () => {
    expect(truncateCaption('short', 10)).toBe('short');
  });

  it('truncates a caption exceeding maxChars and appends an ellipsis, respecting the exact budget', () => {
    const result = truncateCaption('a very long worker caption text', 10);

    expect(result).toBe('a very lo…');
    expect(result).toHaveLength(10);
  });

  // Adversarial boundary twin: exactly at the limit must NOT truncate; one character over MUST.
  it('boundary: a caption exactly at maxChars length is left untouched', () => {
    expect(truncateCaption('exactly10c', 10)).toBe('exactly10c');
  });

  it('boundary: a caption one character over maxChars IS truncated', () => {
    const result = truncateCaption('exactly11ch', 10);

    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('buildCaption truncates long captions by default (G.2 repro captions)', () => {
  it('truncates the reproduced overlap caption "McpToolCall: engram/mem_save"', () => {
    const result = buildCaption('session', { toolLabel: 'McpToolCall', toolDetail: 'engram/mem_save' });

    expect(result.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(result.endsWith('…')).toBe(true);
  });

  // Different long caption, same treatment — proves the fix is general truncation math, not a
  // special case hardcoded for one harness's exact string (renderer must never branch on harness).
  it('truncates a different long caption too: "Saving to Engram: Engram save"', () => {
    const result = buildCaption('session', { toolLabel: 'Saving to Engram', toolDetail: 'Engram save' });

    expect(result.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not touch a short caption that already fits within the budget', () => {
    expect(buildCaption('my-session')).toBe('my-session');
  });
});

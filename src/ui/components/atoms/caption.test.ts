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

// Agent profile tracking: "at minimum the agent type and model on/near the worker, and the task
// available as the caption detail" — mirrors the existing {toolLabel}: {toolDetail} shape, with
// no `harness` parameter here either (a profile is data, not a harness special case).
describe('buildCaption — agent profile', () => {
  // maxChars raised to 100 in these three: the composed string legitimately exceeds the default
  // desk-width budget, and truncation itself is already covered generically elsewhere — these
  // assert the FORMATTING, not the (separately-tested) truncation behavior.
  it('renders a subagent profile as "agentType (model): task"', () => {
    const result = buildCaption('my-session', undefined, { role: 'subagent', agentType: 'sdd-apply', model: 'sonnet', task: 'Apply slice 2' }, 100);
    expect(result).toBe('sdd-apply (sonnet): Apply slice 2');
  });

  // Triangulation: a different role/agentType/model/task must render its OWN distinct caption,
  // proving this reads the profile's own fields rather than a hardcoded string.
  it('renders the orchestrator profile as "orchestrator (model)" with no task', () => {
    const result = buildCaption('my-session', undefined, { role: 'orchestrator', model: 'claude-opus-5' }, 100);
    expect(result).toBe('orchestrator (claude-opus-5)');
  });

  it('omits the model parens when the profile has no model, without inventing one', () => {
    const result = buildCaption('my-session', undefined, { role: 'subagent', agentType: 'sdd-apply', task: 'Apply slice 2' }, 100);
    expect(result).toBe('sdd-apply: Apply slice 2');
  });

  it('falls back to "subagent" identity when a subagent profile has no agentType', () => {
    const result = buildCaption('my-session', undefined, { role: 'subagent', model: 'sonnet' });
    expect(result).toBe('subagent (sonnet)');
  });

  it('renders the identity alone when the profile has neither model nor task', () => {
    const result = buildCaption('my-session', undefined, { role: 'orchestrator' });
    expect(result).toBe('orchestrator');
  });

  // The live tool caption always wins over the (comparatively static) profile — it reflects what
  // the worker is doing RIGHT NOW.
  it('prefers an active tool caption over the agent profile when both are present', () => {
    const result = buildCaption('my-session', { toolLabel: 'Read', toolDetail: 'design.md' }, { role: 'subagent', agentType: 'sdd-apply' });
    expect(result).toBe('Read: design.md');
  });

  it('prefers the agent profile over the plain label when no tool caption is active', () => {
    const result = buildCaption('my-session', undefined, { role: 'subagent', agentType: 'sdd-apply' });
    expect(result).toBe('sdd-apply');
  });

  // Model is a live observation, distinct from the launch's requested alias: the resolved
  // `model` must be shown once known, never the (possibly stale) `requestedModel` alias.
  it('shows the resolved model over the requested alias once both are known', () => {
    const result = buildCaption('my-session', undefined, { role: 'subagent', agentType: 'sdd-apply', requestedModel: 'sonnet', model: 'claude-sonnet-5' }, 100);
    expect(result).toBe('sdd-apply (claude-sonnet-5)');
  });

  // Adversarial near-miss: before the resolved model ever arrives, the requested alias is the
  // only signal available and should still be shown rather than nothing at all.
  it('falls back to the requested alias when the resolved model is not known yet', () => {
    const result = buildCaption('my-session', undefined, { role: 'subagent', agentType: 'sdd-apply', requestedModel: 'sonnet' });
    expect(result).toBe('sdd-apply (sonnet)');
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

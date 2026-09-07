import { describe, expect, it } from 'vitest';
import { buildCaption } from './caption';

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

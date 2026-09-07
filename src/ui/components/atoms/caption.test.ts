import { describe, expect, it } from 'vitest';
import { buildCaption } from './caption';

describe('buildCaption (atom) — the caption strip text shown under a worker (tasks.md 10.3)', () => {
  it('uses the worker label as the caption text', () => {
    expect(buildCaption('agent-1a2b3c4d')).toBe('agent-1a2b3c4d');
  });

  it('falls back to a placeholder when the label is empty', () => {
    expect(buildCaption('')).toBe('(unnamed worker)');
  });
});

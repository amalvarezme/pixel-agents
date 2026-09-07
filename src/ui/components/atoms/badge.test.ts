import { describe, expect, it } from 'vitest';
import { buildHarnessBadge } from './badge';

describe('buildHarnessBadge (atom) — harness identity is a badge + accent color, not a different sprite (design.md)', () => {
  it('gives each harness a short readable text and a distinct accent color', () => {
    const claude = buildHarnessBadge('claude-code');
    const codex = buildHarnessBadge('codex');
    const opencode = buildHarnessBadge('opencode');
    const antigravity = buildHarnessBadge('antigravity');

    expect(claude).toEqual({ text: 'Claude', color: '#d97757' });
    expect(codex).toEqual({ text: 'Codex', color: '#10a37f' });
    expect(opencode).toEqual({ text: 'OpenCode', color: '#5865f2' });
    expect(antigravity).toEqual({ text: 'Antigravity', color: '#4285f4' });

    const colors = new Set([claude.color, codex.color, opencode.color, antigravity.color]);
    expect(colors.size).toBe(4);
  });
});

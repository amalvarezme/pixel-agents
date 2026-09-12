import { describe, expect, it } from 'vitest';
import { buildHarnessBadge } from './badge';

describe('buildHarnessBadge (atom) — harness identity is a badge + accent color, not a different sprite (design.md)', () => {
  it('gives each harness a short readable text and a distinct accent color', () => {
    const claude = buildHarnessBadge('claude-code');
    const codex = buildHarnessBadge('codex');
    const opencode = buildHarnessBadge('opencode');
    const antigravity = buildHarnessBadge('antigravity');

    expect(claude).toEqual({ text: 'Claude', name: 'Claude Code', color: '#d97757' });
    expect(codex).toEqual({ text: 'Codex', name: 'Codex', color: '#10a37f' });
    expect(opencode).toEqual({ text: 'OpenCode', name: 'OpenCode', color: '#5865f2' });
    expect(antigravity).toEqual({ text: 'Antigravity', name: 'Antigravity', color: '#4285f4' });

    const colors = new Set([claude.color, codex.color, opencode.color, antigravity.color]);
    expect(colors.size).toBe(4);
  });

  // The agent tooltip (src/ui/components/atoms/agent-tooltip.ts) needs the FULL product name —
  // 'Claude Code', not the short 'Claude' badge text — so `name` is a distinct field, not an
  // alias for `text`.
  it('exposes the full product name separately from the short badge text', () => {
    expect(buildHarnessBadge('claude-code').name).toBe('Claude Code');
    expect(buildHarnessBadge('claude-code').text).toBe('Claude');
  });
});

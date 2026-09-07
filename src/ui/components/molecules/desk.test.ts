import { describe, expect, it } from 'vitest';
import { buildDeskView, ROOT_DESK_SIZE, SINGLE_AGENT_DESK_SIZE } from './desk';

describe('buildDeskView (molecule) — the desk furniture under a worker', () => {
  it('sizes a root-lane desk at the standard size', () => {
    const desk = buildDeskView({ sessionKey: 'claude-code:s1', x: 960, y: 540, lane: 'root' }, { totalWorkerCount: 3 });

    expect(desk).toEqual({ sessionKey: 'claude-code:s1', x: 960, y: 540, width: ROOT_DESK_SIZE, height: ROOT_DESK_SIZE });
  });

  it('draws a wider desk for the single-agent layout (design.md: "larger sprite, wider caption strip")', () => {
    const desk = buildDeskView({ sessionKey: 'claude-code:s1', x: 960, y: 540, lane: 'root' }, { totalWorkerCount: 1 });

    expect(desk.width).toBe(SINGLE_AGENT_DESK_SIZE);
    expect(desk.width).toBeGreaterThan(ROOT_DESK_SIZE);
  });

  it('sizes a child-lane desk slightly smaller than a root desk, staying visually distinct', () => {
    const desk = buildDeskView({ sessionKey: 'claude-code:c1', x: 960, y: 760, lane: 'child' }, { totalWorkerCount: 2 });

    expect(desk.width).toBeLessThan(ROOT_DESK_SIZE);
  });
});

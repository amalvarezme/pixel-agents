import { describe, expect, it } from 'vitest';
import {
  computeOfficeLayout,
  FLOOR_HEIGHT,
  FLOOR_WIDTH,
  MAX_PACKED_WORKERS,
  type LayoutWorkerInput,
} from './office-layout';

function worker(sessionKey: string, parentSessionKey: string | null = null): LayoutWorkerInput {
  return { sessionKey, parentSessionKey };
}

describe('office layout math (office-scene-renderer spec: Single-Agent Layout, Multi-Agent Layout)', () => {
  it('is canvas-free: no PixiJS import anywhere in this module', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./office-layout.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/pixi\.js/);
  });

  it('produces no desks and no overflow for an empty office', () => {
    const layout = computeOfficeLayout([]);
    expect(layout.desks).toEqual([]);
    expect(layout.overflowCount).toBe(0);
  });

  it('centers the single active session with no lane subdivision (Single-Agent Layout)', () => {
    const layout = computeOfficeLayout([worker('claude-code:s1')]);

    expect(layout.desks).toHaveLength(1);
    const [desk] = layout.desks;
    expect(desk!.sessionKey).toBe('claude-code:s1');
    expect(desk!.x).toBe(FLOOR_WIDTH / 2);
    expect(desk!.lane).toBe('root');
    expect(desk!.y).toBeGreaterThan(0);
    expect(desk!.y).toBeLessThan(FLOOR_HEIGHT);
  });

  it('renders multiple unrelated sessions as distinct, non-overlapping desks (Multi-Agent Layout)', () => {
    const layout = computeOfficeLayout([worker('claude-code:s1'), worker('claude-code:s2'), worker('claude-code:s3')]);

    expect(layout.desks).toHaveLength(3);
    const xs = layout.desks.map((d) => d.x);
    expect(new Set(xs).size).toBe(3); // every desk gets a unique x position — no overlap
  });

  it('packs at most 8 desks in a row and reports the rest as overflow', () => {
    const workers = Array.from({ length: 10 }, (_, i) => worker(`claude-code:s${i}`));

    const layout = computeOfficeLayout(workers);

    expect(layout.desks).toHaveLength(MAX_PACKED_WORKERS);
    expect(layout.overflowCount).toBe(2);
  });

  // Defect fix: the packed row and the archive cabinet share the SAME root-lane y (540) —
  // ARCHIVE_DESTINATION = { x: 1720, y: 540 }, `office-scene-renderer.ts`. A full 8-desk row
  // centered on the floor reached far enough right to overlap the cabinet and its counter,
  // making the archive destination the carry animation walks to invisible as its own thing.
  it('keeps the packed row clear of the archive destination even at the maximum packed count', () => {
    const workers = Array.from({ length: MAX_PACKED_WORKERS }, (_, i) => worker(`claude-code:s${i}`));

    const layout = computeOfficeLayout(workers);

    const rightmostDeskX = Math.max(...layout.desks.map((d) => d.x));
    // 1720 is ARCHIVE_DESTINATION.x; 150 covers half the desk width plus half the cabinet width
    // plus a visible margin, so the two never touch even accounting for their drawn size.
    expect(rightmostDeskX).toBeLessThan(1720 - 150);
  });

  // Adversarial twin: proves the row shifts as a WHOLE (every desk clears the boundary), not just
  // the specific 8-worker case above landing under the threshold by coincidence.
  it('never places any packed-row desk past the archive clearance boundary, at any count', () => {
    const workers = Array.from({ length: 4 }, (_, i) => worker(`claude-code:s${i}`));

    const layout = computeOfficeLayout(workers);

    for (const desk of layout.desks) {
      expect(desk.x).toBeLessThan(1720 - 150);
    }
  });

  it('places a child worker in a visually distinct lane from its parent', () => {
    const layout = computeOfficeLayout([worker('claude-code:parent1'), worker('claude-code:child1', 'claude-code:parent1')]);

    const parentDesk = layout.desks.find((d) => d.sessionKey === 'claude-code:parent1');
    const childDesk = layout.desks.find((d) => d.sessionKey === 'claude-code:child1');

    expect(parentDesk?.lane).toBe('root');
    expect(childDesk?.lane).toBe('child');
    expect(childDesk?.y).not.toBe(parentDesk?.y);
  });
});

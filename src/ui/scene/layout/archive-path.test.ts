import { describe, expect, it } from 'vitest';
import { ARCHIVE_DESTINATION, computeArchivePath } from './archive-path';
import { computeOfficeLayout } from './office-layout';

describe('computeArchivePath (office-scene-renderer spec: "Archive Destination Rendering")', () => {
  it('starts at the given origin', () => {
    const path = computeArchivePath({ x: 500, y: 300 });
    expect(path[0]).toEqual({ x: 500, y: 300 });
  });

  it('ends at the fixed archive destination regardless of origin', () => {
    const path = computeArchivePath({ x: 100, y: 900 });
    expect(path[path.length - 1]).toEqual(ARCHIVE_DESTINATION);
    expect(ARCHIVE_DESTINATION).toEqual({ x: 1720, y: 540 });
  });

  it('two different origins produce paths that both terminate at the identical destination point', () => {
    const pathA = computeArchivePath({ x: 200, y: 200 });
    const pathB = computeArchivePath({ x: 1500, y: 800 });
    expect(pathA[pathA.length - 1]).toEqual(pathB[pathB.length - 1]);
  });

  // "never cutting through desks" (tasks.md 21.1), verified concretely: 3 packed root-lane desks
  // (office-scene-renderer spec: Multi-Agent Layout) at y=540, x=760/960/1160, half-width 80
  // (ROOT_DESK_SIZE=160). The leftmost worker's computed path must not cross the OTHER two
  // desks' bounding boxes on its way to the archive.
  it('routes around the other desks in a packed row, never crossing their bounding boxes', () => {
    const layout = computeOfficeLayout([
      { sessionKey: 'w1', parentSessionKey: null },
      { sessionKey: 'w2', parentSessionKey: null },
      { sessionKey: 'w3', parentSessionKey: null },
    ]);
    const origin = layout.desks.find((d) => d.sessionKey === 'w1')!;
    const otherDesks = layout.desks.filter((d) => d.sessionKey !== 'w1');
    const DESK_HALF_WIDTH = 80;
    const DESK_HALF_HEIGHT = 80;

    const path = computeArchivePath({ x: origin.x, y: origin.y });

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      // Every intermediate segment in this implementation is axis-aligned (purely vertical or
      // purely horizontal), so a segment crosses a desk's box only if the CONSTANT axis value
      // falls inside the desk's span on that axis while the moving axis also overlaps.
      for (const desk of otherDesks) {
        const deskXRange: [number, number] = [desk.x - DESK_HALF_WIDTH, desk.x + DESK_HALF_WIDTH];
        const deskYRange: [number, number] = [desk.y - DESK_HALF_HEIGHT, desk.y + DESK_HALF_HEIGHT];
        if (a.x === b.x) {
          // vertical segment at x = a.x
          const withinDeskX = a.x > deskXRange[0] && a.x < deskXRange[1];
          const segYMin = Math.min(a.y, b.y);
          const segYMax = Math.max(a.y, b.y);
          const overlapsDeskY = segYMax > deskYRange[0] && segYMin < deskYRange[1];
          expect(withinDeskX && overlapsDeskY).toBe(false);
        } else if (a.y === b.y) {
          // horizontal segment at y = a.y
          const withinDeskY = a.y > deskYRange[0] && a.y < deskYRange[1];
          const segXMin = Math.min(a.x, b.x);
          const segXMax = Math.max(a.x, b.x);
          const overlapsDeskX = segXMax > deskXRange[0] && segXMin < deskXRange[1];
          expect(withinDeskY && overlapsDeskX).toBe(false);
        }
      }
    }
  });

  // Adversarial near-miss twin: a NAIVE single-segment straight line from the same origin
  // straight to the archive DOES cross another desk's bounding box — proving the corridor
  // detour above is load-bearing, not a no-op.
  it('(adversarial) a naive straight-line path from the same origin DOES cross another desk — proving the detour matters', () => {
    const layout = computeOfficeLayout([
      { sessionKey: 'w1', parentSessionKey: null },
      { sessionKey: 'w2', parentSessionKey: null },
      { sessionKey: 'w3', parentSessionKey: null },
    ]);
    const origin = layout.desks.find((d) => d.sessionKey === 'w1')!;
    const middleDesk = layout.desks.find((d) => d.sessionKey === 'w2')!;
    const DESK_HALF_WIDTH = 80;
    const DESK_HALF_HEIGHT = 80;

    const naiveDestination = ARCHIVE_DESTINATION;
    // Single straight segment, same y (both at 540) — passes directly through the middle desk.
    const crossesMiddleDesk =
      origin.y > middleDesk.y - DESK_HALF_HEIGHT &&
      origin.y < middleDesk.y + DESK_HALF_HEIGHT &&
      naiveDestination.x > middleDesk.x - DESK_HALF_WIDTH;

    expect(crossesMiddleDesk).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { computeOfficeLayout, findSeat, MAX_SEATED_WORKERS, MIN_SEAT_SPACING, type LayoutWorkerInput } from './office-layout';
import { WORKSTATIONS, WORLD_HEIGHT, WORLD_WIDTH } from '../world/office-map';
import { officeNavigation } from '../world/office-navigation';

function worker(sessionKey: string): LayoutWorkerInput {
  return { sessionKey };
}

describe('office layout — seating agents at the room\'s real workstations', () => {
  it('is canvas-free: no PixiJS import anywhere in this module', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./office-layout.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/pixi\.js/);
  });

  it('seats nobody and overflows nobody for an empty office', () => {
    expect(computeOfficeLayout([])).toEqual({ seats: [], overflowCount: 0 });
  });

  it('seats a lone agent at a real workstation, not at an invented position', () => {
    const layout = computeOfficeLayout([worker('claude-code:s1')]);

    expect(layout.seats).toHaveLength(1);
    const seat = layout.seats[0]!;
    expect(seat.sessionKey).toBe('claude-code:s1');
    expect(WORKSTATIONS.some((station) => station.id === seat.stationId)).toBe(true);
    expect({ x: seat.x, y: seat.y }).toEqual(
      WORKSTATIONS.find((station) => station.id === seat.stationId)!.interactionAnchor,
    );
  });

  it('gives every agent its own workstation — never two on one desk', () => {
    const layout = computeOfficeLayout(Array.from({ length: MAX_SEATED_WORKERS }, (_, i) => worker(`claude-code:s${i}`)));

    expect(new Set(layout.seats.map((seat) => seat.stationId)).size).toBe(MAX_SEATED_WORKERS);
    expect(new Set(layout.seats.map((seat) => `${seat.x},${seat.y}`)).size).toBe(MAX_SEATED_WORKERS);
  });

  it('seats as many agents as the room has workstations and reports the rest as overflow', () => {
    const layout = computeOfficeLayout(Array.from({ length: MAX_SEATED_WORKERS + 3 }, (_, i) => worker(`claude-code:s${i}`)));

    expect(layout.seats).toHaveLength(MAX_SEATED_WORKERS);
    expect(layout.overflowCount).toBe(3);
  });

  it('seats the same crew in the same places every time it is asked', () => {
    // The floor is redrawn ~60 times a second: seating that varied between two identical calls
    // would make every agent jitter between desks.
    const crew = [worker('claude-code:a'), worker('claude-code:b'), worker('claude-code:c')];

    expect(computeOfficeLayout(crew)).toEqual(computeOfficeLayout(crew));
  });

  it('keeps every agent inside the room', () => {
    const layout = computeOfficeLayout(Array.from({ length: MAX_SEATED_WORKERS }, (_, i) => worker(`claude-code:s${i}`)));

    for (const seat of layout.seats) {
      expect(seat.x).toBeGreaterThan(0);
      expect(seat.x).toBeLessThan(WORLD_WIDTH);
      expect(seat.y).toBeGreaterThan(0);
      expect(seat.y).toBeLessThan(WORLD_HEIGHT);
    }
  });

  /**
   * Every seat is open floor in front of its desk, never inside the furniture: that is what an
   * `interactionAnchor` means (guide section 8), and a seat the pathfinder considered blocked
   * would be a seat no agent could walk back to after an archive trip.
   */
  it('seats every agent on open floor, and leaves every seat reachable', () => {
    const layout = computeOfficeLayout(Array.from({ length: MAX_SEATED_WORKERS }, (_, i) => worker(`claude-code:s${i}`)));

    for (const seat of layout.seats) {
      expect(officeNavigation.isBlocked({ x: seat.x, y: seat.y })).toBe(false);

      const path = officeNavigation.findPath({ x: 960, y: 660 }, { x: seat.x, y: seat.y });
      expect(path.length).toBeGreaterThan(1);
      expect(path[path.length - 1]).toEqual({ x: seat.x, y: seat.y });
      for (const point of path.slice(1, -1)) {
        expect(officeNavigation.isBlocked(point)).toBe(false);
      }
    }
  });

  it('finds the seat a given worker holds, and nothing for one that got none', () => {
    const layout = computeOfficeLayout([worker('claude-code:s1')]);

    expect(findSeat(layout, 'claude-code:s1')).toEqual({ x: layout.seats[0]!.x, y: layout.seats[0]!.y });
    expect(findSeat(layout, 'claude-code:nobody')).toBeUndefined();
  });
});

describe('MIN_SEAT_SPACING', () => {
  it('is measured off the map, as the tightest gap between two workstations in one row', () => {
    // `caption.ts` budgets caption width from this, so it has to be the real worst case rather
    // than an average: two neighbours 85 units apart are what a caption must not bridge.
    let expected = Infinity;
    for (let i = 0; i < WORKSTATIONS.length; i++) {
      for (let j = i + 1; j < WORKSTATIONS.length; j++) {
        const a = WORKSTATIONS[i]!.interactionAnchor;
        const b = WORKSTATIONS[j]!.interactionAnchor;
        if (Math.abs(a.y - b.y) > 60) continue;
        expected = Math.min(expected, Math.abs(a.x - b.x));
      }
    }

    expect(MIN_SEAT_SPACING).toBe(expected);
    expect(MIN_SEAT_SPACING).toBeGreaterThan(0);
  });
});

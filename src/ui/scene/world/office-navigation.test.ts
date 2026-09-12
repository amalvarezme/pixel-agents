import { describe, expect, it } from 'vitest';
import { OfficeNavigation, officeNavigation } from './office-navigation';
import { COLLISION_ZONES, PERSISTENT_MEMORY, WALKABLE_BOUNDS, WORKSTATIONS, type MapPoint } from './office-map';

/** Does the straight line between two points pass through a piece of furniture? Sampled densely
 * enough that a 200-unit-wide desk cannot be stepped over. */
function straightLineCrossesFurniture(from: MapPoint, to: MapPoint): boolean {
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    if (COLLISION_ZONES.some((r) => point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height)) {
      return true;
    }
  }
  return false;
}

describe('OfficeNavigation.isBlocked', () => {
  it('blocks anything outside the walkable band', () => {
    expect(officeNavigation.isBlocked({ x: 0, y: 0 })).toBe(true);
    expect(officeNavigation.isBlocked({ x: WALKABLE_BOUNDS.x - 1, y: WALKABLE_BOUNDS.y + 10 })).toBe(true);
  });

  it('blocks the furniture the map lists', () => {
    const desk = COLLISION_ZONES.find((zone) => zone.id === 'desk_center')!;
    expect(officeNavigation.isBlocked({ x: desk.x + desk.width / 2, y: desk.y + desk.height / 2 })).toBe(true);
  });

  it('leaves the open floor walkable', () => {
    // The aisle between the centre desk and the south row.
    expect(officeNavigation.isBlocked({ x: 960, y: 660 })).toBe(false);
  });
});

describe('OfficeNavigation.findPath', () => {
  const nav = new OfficeNavigation();

  it('starts at exactly the point it was given and ends at exactly the target', () => {
    // The middle of a route is grid-snapped, but the two ends are not: a character has to leave
    // from where it actually stands and arrive at the anchor it was actually sent to.
    const from = WORKSTATIONS[0]!.interactionAnchor;
    const to = PERSISTENT_MEMORY.anchor;

    const path = nav.findPath(from, to);

    expect(path[0]).toEqual(from);
    expect(path[path.length - 1]).toEqual(to);
  });

  it('routes AROUND the furniture instead of straight through it', () => {
    // ws_09 sits at the bottom of the room, the archive at the top: the straight line between them
    // crosses the south-centre desk and the sofa. Guide section 7: "No desplazar en línea recta
    // atravesando escritorios."
    const from = WORKSTATIONS.find((station) => station.id === 'ws_09')!.interactionAnchor;
    const to = PERSISTENT_MEMORY.anchor;
    expect(straightLineCrossesFurniture(from, to)).toBe(true);

    const path = nav.findPath(from, to);

    // Every interior waypoint is walkable — the two endpoints are excluded because an anchor is
    // allowed to sit right against the furniture it belongs to.
    for (const point of path.slice(1, -1)) {
      expect(nav.isBlocked(point)).toBe(false);
    }
    expect(path.length).toBeGreaterThan(2);
  });

  it('reaches the archive from every single workstation', () => {
    // An unreachable desk would strand an agent mid-trip forever. This is the acceptance criterion
    // "se puede llegar a ws_01...ws_11" (guide section 18), enforced rather than eyeballed.
    for (const station of WORKSTATIONS) {
      const path = nav.findPath(station.interactionAnchor, PERSISTENT_MEMORY.anchor);
      expect(path.length).toBeGreaterThan(1);
      for (const point of path.slice(1, -1)) {
        expect(nav.isBlocked(point)).toBe(false);
      }
    }
  });

  it('still returns a usable route when the destination is walled in', () => {
    // A route that cannot exist must degrade to a straight line, never to an empty path: a
    // character with no waypoints would simply stop existing mid-animation.
    const walledIn = new OfficeNavigation({
      bounds: { x: 0, y: 0, width: 200, height: 200 },
      obstacles: [{ x: 90, y: 0, width: 20, height: 200 }],
    });

    const path = walledIn.findPath({ x: 10, y: 10 }, { x: 190, y: 190 });

    expect(path[0]).toEqual({ x: 10, y: 10 });
    expect(path[path.length - 1]).toEqual({ x: 190, y: 190 });
  });

  it('is deterministic: the same two points always produce the same route', () => {
    const from = WORKSTATIONS[5]!.interactionAnchor;
    const to = PERSISTENT_MEMORY.anchor;

    expect(nav.findPath(from, to)).toEqual(nav.findPath(from, to));
  });

  it('takes the direct route when there is nothing in the way', () => {
    const open = new OfficeNavigation({ gridSize: 10, bounds: { x: 0, y: 0, width: 100, height: 100 }, obstacles: [] });

    const path = open.findPath({ x: 10, y: 10 }, { x: 50, y: 10 });

    // Straight along one axis: the grid path in between must not wander off it.
    for (const point of path) expect(point.y).toBe(10);
  });
});

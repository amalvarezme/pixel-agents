/**
 * A* navigation over the office floor — a typed port of the pack's own `04_engine/Navigation.js`,
 * pure and canvas-free.
 *
 * WHY a pathfinder at all, when the old scene walked a hand-built dogleg (`archive-path.ts`): the
 * v1 office was a procedural row of desks with a guaranteed-clear corridor underneath, so a route
 * could be written down once. The v2 office is a drawn room with sixteen solid things in it —
 * desks, a sofa, the memory core, shelves, a robot arm, pods, stairs — and section 7 of
 * `docs/pixel-office/IMPLEMENTACION_AGENTE_CODIGO.md` is explicit: "No desplazar en línea recta
 * atravesando escritorios". The walkable area and the obstacles both come from the map, so the
 * route has to be computed against them rather than assumed.
 *
 * Faithful to the pack's implementation on purpose, including its grid snapping and its
 * eight-direction moves: a route this code invents that the pack's own demo would not is a route
 * whose geometry nobody has looked at.
 */
import { COLLISION_ZONES, NAV_GRID_SIZE, WALKABLE_BOUNDS, type MapPoint, type MapRect } from './office-map';

interface GridCell {
  x: number;
  y: number;
}

export interface OfficeNavigationOptions {
  gridSize?: number;
  bounds?: MapRect;
  obstacles?: readonly MapRect[];
}

/** How far out of a blocked cell to search for a free one. 11 cells at the map's 24px grid is a
 * quarter of the room — beyond that there is no plausible "nearby" cell and the caller is better
 * served by a straight line than by a route to somewhere unrelated. */
const NEAREST_FREE_RADIUS = 11;

const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export class OfficeNavigation {
  private readonly gridSize: number;
  private readonly bounds: MapRect;
  private readonly obstacles: readonly MapRect[];

  constructor(options: OfficeNavigationOptions = {}) {
    this.gridSize = options.gridSize ?? NAV_GRID_SIZE;
    this.bounds = options.bounds ?? WALKABLE_BOUNDS;
    this.obstacles = options.obstacles ?? COLLISION_ZONES;
  }

  /** True for any point outside the walkable band or inside a piece of furniture. Tested against
   * the character's FEET, never its whole frame: a 32x32 body box would refuse to walk past a
   * desk the head merely overlaps (guide section 13). */
  isBlocked(point: MapPoint): boolean {
    const bounds = this.bounds;
    if (
      point.x < bounds.x ||
      point.y < bounds.y ||
      point.x > bounds.x + bounds.width ||
      point.y > bounds.y + bounds.height
    ) {
      return true;
    }
    return this.obstacles.some(
      (rect) =>
        point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height,
    );
  }

  private cellOf(point: MapPoint): GridCell {
    return { x: Math.round(point.x / this.gridSize), y: Math.round(point.y / this.gridSize) };
  }

  private pointOf(cell: GridCell): MapPoint {
    return { x: cell.x * this.gridSize, y: cell.y * this.gridSize };
  }

  /**
   * The nearest walkable cell to `cell`, or `cell` itself when nothing nearby is free.
   *
   * Both ends of a route need this. A workstation's `interactionAnchor` is a floor position that
   * snaps to whichever grid cell is closest, and that cell can land inside the desk the anchor
   * stands in front of; refusing to path from or to it would mean no agent could ever reach a
   * desk.
   */
  private nearestFree(cell: GridCell): GridCell {
    if (!this.isBlocked(this.pointOf(cell))) return cell;

    for (let radius = 1; radius < NEAREST_FREE_RADIUS; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          const candidate = { x: cell.x + dx, y: cell.y + dy };
          if (!this.isBlocked(this.pointOf(candidate))) return candidate;
        }
      }
    }
    return cell;
  }

  /**
   * A walkable route from `start` to `end`, as a list of scene-unit waypoints beginning at `start`
   * and ending at `end`.
   *
   * The two given endpoints are kept verbatim around the grid-snapped middle: a character must
   * leave from exactly where it stands and arrive at exactly the anchor it was sent to, even
   * though everything between those two points is computed on the 24px grid.
   *
   * Falls back to the straight line `[start, end]` when no route exists — an unreachable target is
   * a map-tuning problem (guide section 7: "ajustar exclusivamente office_map.json"), and a
   * character sliding across a desk is a far better failure than one that never moves again.
   */
  findPath(start: MapPoint, end: MapPoint): MapPoint[] {
    const startCell = this.nearestFree(this.cellOf(start));
    const goalCell = this.nearestFree(this.cellOf(end));
    const key = (cell: GridCell): string => `${cell.x},${cell.y}`;

    const open: GridCell[] = [startCell];
    const cameFrom = new Map<string, GridCell>();
    const gScore = new Map<string, number>([[key(startCell), 0]]);
    const closed = new Set<string>();
    const heuristic = (cell: GridCell): number => Math.hypot(cell.x - goalCell.x, cell.y - goalCell.y);

    while (open.length > 0) {
      open.sort((a, b) => (gScore.get(key(a)) ?? Infinity) + heuristic(a) - ((gScore.get(key(b)) ?? Infinity) + heuristic(b)));
      const current = open.shift()!;
      const currentKey = key(current);
      if (closed.has(currentKey)) continue;
      closed.add(currentKey);

      if (current.x === goalCell.x && current.y === goalCell.y) {
        const cells: GridCell[] = [current];
        let cursor = currentKey;
        while (cameFrom.has(cursor)) {
          const previous = cameFrom.get(cursor)!;
          cells.push(previous);
          cursor = key(previous);
        }
        const middle = cells.reverse().map((cell) => this.pointOf(cell));
        return [start, ...middle, end];
      }

      for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
        const neighbour = { x: current.x + dx, y: current.y + dy };
        const neighbourKey = key(neighbour);
        if (closed.has(neighbourKey) || this.isBlocked(this.pointOf(neighbour))) continue;

        const tentative = (gScore.get(currentKey) ?? Infinity) + Math.hypot(dx, dy);
        if (tentative < (gScore.get(neighbourKey) ?? Infinity)) {
          cameFrom.set(neighbourKey, current);
          gScore.set(neighbourKey, tentative);
          if (!open.some((cell) => cell.x === neighbour.x && cell.y === neighbour.y)) open.push(neighbour);
        }
      }
    }

    return [start, end];
  }
}

/** The office's own navigation, built from the shipped map. One instance is enough: it holds no
 * per-route state, and rebuilding the obstacle list per trip would be pure waste. */
export const officeNavigation = new OfficeNavigation();

/**
 * The office world, read from the Pixel Office v2 map. Pure and canvas-free: no PixiJS, no DOM, no
 * fetch (dependency-cruiser's `pixi-only-in-scene-pixi` rule keeps every geometry decision
 * testable without a browser).
 *
 * `office-map.json` is a VERBATIM copy of the pack's own `02_environment/office/office_map.json`
 * and is the single source of truth for the world — section 2 of
 * `docs/pixel-office/IMPLEMENTACION_AGENTE_CODIGO.md`: "No codificar manualmente FPS, filas del
 * spritesheet, anchors ni coordenadas de estaciones si ya existen en JSON". Nothing in this
 * module invents a coordinate; it only reads, names and type-checks what the map already says.
 *
 * It is IMPORTED rather than fetched, deliberately. Layout math has to answer "where does this
 * worker sit" synchronously, the same way `office-layout.ts` always has, and a fetched map would
 * turn every pure layout function into an async one for a file that is fixed at build time. The
 * images it names are the only part that has to be served (`OFFICE_LAYER_URLS`).
 *
 * The map's coordinate system IS the scene's coordinate system: image pixels of the 1672x941
 * artwork, origin top-left (guide section 19.5 — replacing the background with art of a different
 * size means updating this map, not the renderer).
 */
import mapData from './office-map.json';

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The scene's own dimensions, in the map's image-pixel units. */
export const WORLD_WIDTH = mapData.size.width;
export const WORLD_HEIGHT = mapData.size.height;

/**
 * Where the served artwork lives. The map names the files; this is the one place that turns those
 * names into URLs, so a renderer never hand-builds a path.
 */
export const OFFICE_LAYER_URLS = {
  background: `/office/${mapData.layers.background}`,
  foreground: `/office/${mapData.layers.foreground}`,
  windowMask: `/office/${mapData.layers.windowMask}`,
} as const;

export interface Workstation {
  id: string;
  label: string;
  /** Where the laptop is DRAWN. Never a character position — guide section 8 is explicit about
   * this: an agent standing on its laptop is what happens when the two are confused. */
  laptop: MapPoint;
  /** Where a character actually stands to use the station: in front of the desk, on the floor. */
  interactionAnchor: MapPoint;
  /** Which way it faces while working the station — `up`, i.e. toward the desk. */
  facing: 'up' | 'down' | 'left' | 'right';
  defaultAnimation: string;
}

/**
 * The 11 workstations, in the map's own `ws_01..ws_11` order. That order is the seating order, so
 * the same set of workers always lands on the same desks between two frames — a worker that jumped
 * chairs whenever another session started would be unreadable.
 */
export const WORKSTATIONS: readonly Workstation[] = Object.entries(mapData.stations)
  .map(([id, station]) => ({
    id,
    label: station.label,
    laptop: station.laptop,
    interactionAnchor: station.interactionAnchor,
    facing: station.facing as Workstation['facing'],
    defaultAnimation: station.defaultAnimation,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

/** How many agents the office can actually seat. The floor draws this many; the rest are reported
 * as an overflow count and listed by the project roster panel instead. */
export const WORKSTATION_COUNT = WORKSTATIONS.length;

/**
 * The Persistent Memory Archive — the destination of a `memory_write` archive trip. The map
 * declares `point`/`up` as its animation, and guide section 9 maps every `read_memory` /
 * `write_memory` / `search_memory` / `sync_memory` action onto `point` until the pack ships
 * dedicated clips, so the scene shows an agent pointing up into the archive wall.
 */
export const PERSISTENT_MEMORY = {
  anchor: mapData.specialZones.persistent_memory.interactionAnchor as MapPoint,
  facing: mapData.specialZones.persistent_memory.facing as Workstation['facing'],
} as const;

/** One piece of furniture, as an axis-aligned box. The `id` is the map's own name for it — kept
 * because a clipping report is only actionable if it can say WHICH rectangle to tune (guide
 * section 7: fine-tuning happens in `office_map.json`, never in the engine). */
export interface CollisionZone extends MapRect {
  id: string;
}

/** Where a character may walk, and what it must walk around (`office-navigation.ts`). */
export const NAV_GRID_SIZE = mapData.navigation.gridSize;
export const WALKABLE_BOUNDS: MapRect = mapData.navigation.walkableBounds;
export const COLLISION_ZONES: readonly CollisionZone[] = mapData.navigation.collisionZones;

/** The exterior Sentinel's patrol, seen only through the window mask (guide section 11). */
export const SENTINEL_PATH: readonly MapPoint[] = mapData.sentinel.path;

/**
 * Perspective scale for a character standing at `footY`, straight from the map's own
 * `depth.scaleBands` (guide section 6). Bands are ordered by `maxY`, and the first one that
 * contains the point wins; anything past the last band keeps the last band's scale rather than
 * collapsing to zero.
 *
 * This is the ABSOLUTE sprite scale, not a multiplier — the pack's own renderer passes it straight
 * to `draw(ctx, footX, footY, scale)`. Role adds a whole number on top of it
 * (`ROLE_SCALE_BONUS`), never a ratio, because a fractional scale destroys pixel-perfect
 * rendering.
 */
export function depthScaleFor(footY: number): number {
  const bands = mapData.depth.scaleBands;
  for (const band of bands) {
    if (footY <= band.maxY) return band.scale;
  }
  return bands[bands.length - 1]!.scale;
}

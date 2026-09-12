import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLISION_ZONES,
  NAV_GRID_SIZE,
  OFFICE_LAYER_URLS,
  PERSISTENT_MEMORY,
  SENTINEL_PATH,
  WALKABLE_BOUNDS,
  WORKSTATIONS,
  WORKSTATION_COUNT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  depthScaleFor,
} from './office-map';

describe('office map — the world the artwork actually draws', () => {
  it('is the size of the shipped artwork, since every coordinate in it is an image pixel', () => {
    expect({ width: WORLD_WIDTH, height: WORLD_HEIGHT }).toEqual({ width: 1672, height: 941 });
  });

  it('seats eleven agents, one per workstation the map declares', () => {
    expect(WORKSTATION_COUNT).toBe(11);
    expect(WORKSTATIONS).toHaveLength(11);
  });

  it('orders the workstations by id, so the same crew always lands on the same desks', () => {
    // Seating that reshuffled between frames would make the floor unreadable — a worker would
    // appear to change desk every time an unrelated session started or ended.
    expect(WORKSTATIONS.map((station) => station.id)).toEqual([
      'ws_01',
      'ws_02',
      'ws_03',
      'ws_04',
      'ws_05',
      'ws_06',
      'ws_07',
      'ws_08',
      'ws_09',
      'ws_10',
      'ws_11',
    ]);
  });

  it('stands every agent at the interaction anchor, never on the laptop it is using', () => {
    // Guide section 8: "No usar la coordenada visual del portátil como posición del personaje."
    // The anchor is in FRONT of the desk, so it is always lower on the floor than the laptop.
    for (const station of WORKSTATIONS) {
      expect(station.interactionAnchor).not.toEqual(station.laptop);
      expect(station.interactionAnchor.y).toBeGreaterThan(station.laptop.y);
    }
  });

  it('faces every workstation toward its desk', () => {
    for (const station of WORKSTATIONS) {
      expect(station.facing).toBe('up');
      expect(station.defaultAnimation).toBe('typing');
    }
  });

  it('puts every workstation anchor inside the walkable band', () => {
    // An anchor outside it would be unreachable: `office-navigation.ts` refuses to path there.
    for (const station of WORKSTATIONS) {
      const { x, y } = station.interactionAnchor;
      expect(x).toBeGreaterThanOrEqual(WALKABLE_BOUNDS.x);
      expect(x).toBeLessThanOrEqual(WALKABLE_BOUNDS.x + WALKABLE_BOUNDS.width);
      expect(y).toBeGreaterThanOrEqual(WALKABLE_BOUNDS.y);
      expect(y).toBeLessThanOrEqual(WALKABLE_BOUNDS.y + WALKABLE_BOUNDS.height);
    }
  });

  it('knows where the Persistent Memory Archive is approached from', () => {
    expect(PERSISTENT_MEMORY.anchor).toEqual({ x: 1010, y: 455 });
    expect(PERSISTENT_MEMORY.facing).toBe('up');
  });

  it('carries the navigation grid and obstacle list the pathfinder needs', () => {
    expect(NAV_GRID_SIZE).toBe(24);
    expect(COLLISION_ZONES.length).toBeGreaterThan(0);
    for (const zone of COLLISION_ZONES) {
      expect(zone.width).toBeGreaterThan(0);
      expect(zone.height).toBeGreaterThan(0);
    }
  });

  it('carries a sentinel patrol outside the room', () => {
    expect(SENTINEL_PATH.length).toBeGreaterThan(1);
  });
});

describe('depthScaleFor — perspective straight from the map', () => {
  it('draws a character further back smaller than one at the front', () => {
    expect(depthScaleFor(500)).toBeLessThan(depthScaleFor(700));
  });

  it('uses only whole-number scales, so the art stays pixel-perfect', () => {
    for (let y = 0; y <= WORLD_HEIGHT; y += 20) {
      expect(Number.isInteger(depthScaleFor(y))).toBe(true);
    }
  });

  it('keeps the last band rather than collapsing past the bottom of the world', () => {
    expect(depthScaleFor(WORLD_HEIGHT + 500)).toBe(depthScaleFor(WORLD_HEIGHT));
    expect(depthScaleFor(WORLD_HEIGHT + 500)).toBeGreaterThan(0);
  });
});

describe('shipped environment assets', () => {
  it('names layer URLs that the served asset directory actually has', () => {
    for (const url of Object.values(OFFICE_LAYER_URLS)) {
      expect(url.startsWith('/office/')).toBe(true);
      expect(() => readFileSync(join(process.cwd(), 'public', url.slice(1)))).not.toThrow();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SENTINEL_SCAN_MS, SENTINEL_SPEED, sentinelStateAt } from './sentinel-patrol';
import { SENTINEL_PATH } from './office-map';

describe('sentinelStateAt — the exterior patrol as a pure function of time', () => {
  it('starts walking toward the first waypoint', () => {
    const state = sentinelStateAt(0);

    expect(state.action).toBe('walk');
  });

  it('stops to scan on arriving at a waypoint', () => {
    // The first leg runs from the LAST waypoint back to the first, so its length is the whole path.
    const first = SENTINEL_PATH[0]!;
    const last = SENTINEL_PATH[SENTINEL_PATH.length - 1]!;
    const walkMs = (Math.hypot(first.x - last.x, first.y - last.y) / SENTINEL_SPEED) * 1000;

    const state = sentinelStateAt(walkMs + 10);

    expect(state.action).toBe('scan');
    expect({ x: state.x, y: state.y }).toEqual(first);
  });

  it('moves on once the scan is over', () => {
    const first = SENTINEL_PATH[0]!;
    const last = SENTINEL_PATH[SENTINEL_PATH.length - 1]!;
    const walkMs = (Math.hypot(first.x - last.x, first.y - last.y) / SENTINEL_SPEED) * 1000;

    expect(sentinelStateAt(walkMs + SENTINEL_SCAN_MS + 10).action).toBe('walk');
  });

  it('never leaves the patrol path', () => {
    const xs = SENTINEL_PATH.map((p) => p.x);
    const ys = SENTINEL_PATH.map((p) => p.y);

    for (let now = 0; now < 120_000; now += 137) {
      const state = sentinelStateAt(now);
      expect(state.x).toBeGreaterThanOrEqual(Math.min(...xs));
      expect(state.x).toBeLessThanOrEqual(Math.max(...xs));
      expect(state.y).toBeGreaterThanOrEqual(Math.min(...ys));
      expect(state.y).toBeLessThanOrEqual(Math.max(...ys));
    }
  });

  it('mirrors only while walking back the way it came', () => {
    // The path runs left to right, so the only right-to-left leg is the wrap from the last
    // waypoint to the first — and a scan is never mirrored.
    let sawMirrored = false;
    let sawUnmirrored = false;
    for (let now = 0; now < 60_000; now += 97) {
      const state = sentinelStateAt(now);
      if (state.action === 'scan') expect(state.mirrored).toBe(false);
      if (state.mirrored) sawMirrored = true;
      else sawUnmirrored = true;
    }

    expect(sawMirrored).toBe(true);
    expect(sawUnmirrored).toBe(true);
  });

  it('loops forever: one full cycle later is the same state', () => {
    // Nothing resets this clock — the page runs for hours.
    const cycleMs = SENTINEL_PATH.reduce((total, point, index) => {
      const from = index === 0 ? SENTINEL_PATH[SENTINEL_PATH.length - 1]! : SENTINEL_PATH[index - 1]!;
      return total + (Math.hypot(point.x - from.x, point.y - from.y) / SENTINEL_SPEED) * 1000 + SENTINEL_SCAN_MS;
    }, 0);

    expect(sentinelStateAt(1234)).toEqual(sentinelStateAt(1234 + cycleMs));
    expect(sentinelStateAt(1234)).toEqual(sentinelStateAt(1234 + cycleMs * 40));
  });

  it('never produces a position from before the clock started', () => {
    const state = sentinelStateAt(-5000);

    expect(Number.isFinite(state.x)).toBe(true);
    expect(Number.isFinite(state.y)).toBe(true);
    expect(state.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: the same clock reading always gives the same state', () => {
    expect(sentinelStateAt(4321)).toEqual(sentinelStateAt(4321));
  });
});

describe('shipped sentinel asset', () => {
  it('ships the clips the patrol asks for, with the geometry the renderer assumes', () => {
    const meta = JSON.parse(
      readFileSync(join(process.cwd(), 'public', 'characters', 'sentinel', 'sentinel.json'), 'utf8'),
    ) as {
      frameWidth: number;
      frameHeight: number;
      sheetWidth: number;
      sheetHeight: number;
      origin: { x: number; y: number };
      animations: Record<string, { row: number; frames: number; fps: number; loop: boolean }>;
    };

    expect(meta.frameWidth).toBe(64);
    expect(meta.frameHeight).toBe(96);
    for (const action of ['walk', 'scan']) {
      const clip = meta.animations[action]!;
      expect(clip.frames).toBeGreaterThan(0);
      expect((clip.row + 1) * meta.frameHeight).toBeLessThanOrEqual(meta.sheetHeight);
      expect(clip.frames * meta.frameWidth).toBeLessThanOrEqual(meta.sheetWidth);
    }
    // Feet-origin, like every other character in the pack.
    expect(meta.origin.y).toBeGreaterThan(meta.frameHeight * 0.9);
  });
});

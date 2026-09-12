import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHARACTER_IDS,
  DESK_LINE_ROW,
  GROUND_LINE_ROW,
  ROLE_SPRITE_SCALE,
  computeSpriteFrameRect,
  resolveCharacterId,
  resolveSpriteAnchor,
  selectSpriteAnimation,
  selectSpriteFrame,
  type CharacterSpriteMeta,
} from './character-sprite';

const PACK_ROOT = join(process.cwd(), 'public', 'characters');

function loadMeta(id: string): CharacterSpriteMeta {
  return JSON.parse(readFileSync(join(PACK_ROOT, id, `${id}.json`), 'utf8')) as CharacterSpriteMeta;
}

describe('resolveCharacterId', () => {
  it('is deterministic: the same project always gets the same character', () => {
    expect(resolveCharacterId('/Users/me/pixel-agents')).toBe(resolveCharacterId('/Users/me/pixel-agents'));
  });

  it('gives every worker of ONE project the same character, orchestrator and subagents alike', () => {
    // The renderer resolves this from `projectPath` alone — never from role, harness or session
    // key — which is exactly what makes a project's whole crew read as one family.
    const project = '/Users/me/pixel-agents';
    expect(resolveCharacterId(project)).toBe(resolveCharacterId(project));
  });

  it('separates at least two different projects onto different characters', () => {
    const assigned = new Set(
      ['/a/pixel-agents', '/a/laboratorioIA-V2', '/a/especializacionIA', '/a/EsperanzaIA_UNAL'].map(resolveCharacterId),
    );
    expect(assigned.size).toBeGreaterThan(1);
  });

  it('only ever returns an id the asset pack actually ships', () => {
    for (const path of ['/a/one', '/b/two', '/c/three', '/d/four', '/e/five', '', undefined]) {
      expect(CHARACTER_IDS).toContain(resolveCharacterId(path));
    }
  });

  it('falls back to a fixed character for a worker with no project, never a guess per call', () => {
    expect(resolveCharacterId(undefined)).toBe(resolveCharacterId(undefined));
    expect(resolveCharacterId(undefined)).toBe(resolveCharacterId('   '));
  });
});

describe('selectSpriteAnimation', () => {
  it('shows the desk-bound typing clip while working', () => {
    expect(selectSpriteAnimation({ state: 'working' })).toBe('typing');
  });

  it('shows the desk-bound sitting clip once the session has gone quiet', () => {
    expect(selectSpriteAnimation({ state: 'idle' })).toBe('sit');
  });

  it('shows the walk cycle while crossing the office', () => {
    expect(selectSpriteAnimation({ state: 'walking' })).toBe('walk');
  });

  it('celebrates on arrival at the archive, which outranks every other state', () => {
    expect(selectSpriteAnimation({ state: 'walking', atArchive: true })).toBe('celebrate');
    expect(selectSpriteAnimation({ state: 'working', atArchive: true })).toBe('celebrate');
  });
});

describe('selectSpriteFrame', () => {
  const looping = { row: 1, frames: 4, fps: 10, loop: true };
  const once = { row: 6, frames: 4, fps: 10, loop: false };

  it('advances at the fps the pack JSON declares, never a hardcoded rate', () => {
    expect(selectSpriteFrame(looping, 0)).toBe(0);
    expect(selectSpriteFrame(looping, 99)).toBe(0);
    expect(selectSpriteFrame(looping, 100)).toBe(1);
    expect(selectSpriteFrame(looping, 350)).toBe(3);
  });

  it('wraps a looping clip back to its first frame', () => {
    expect(selectSpriteFrame(looping, 400)).toBe(0);
    expect(selectSpriteFrame(looping, 500)).toBe(1);
  });

  it('holds a non-looping clip on its final frame instead of wrapping', () => {
    expect(selectSpriteFrame(once, 300)).toBe(3);
    expect(selectSpriteFrame(once, 5000)).toBe(3);
  });

  it('never returns a negative frame for a clock that has not started', () => {
    expect(selectSpriteFrame(looping, -1000)).toBe(0);
  });

  it('is deterministic: the same clock reading always yields the same frame', () => {
    expect(selectSpriteFrame(looping, 1234)).toBe(selectSpriteFrame(looping, 1234));
  });
});

describe('computeSpriteFrameRect', () => {
  const meta = loadMeta('alex');

  it('reads the source rectangle straight off the pack metadata (guide section 7)', () => {
    expect(computeSpriteFrameRect(meta, 'walk', 2)).toEqual({ x: 64, y: 32, width: 32, height: 32 });
  });

  it('places every animation on its own declared row', () => {
    expect(computeSpriteFrameRect(meta, 'idle', 0).y).toBe(0);
    expect(computeSpriteFrameRect(meta, 'sit', 0).y).toBe(7 * 32);
  });

  it('never reads outside the sheet for any shipped character, animation or frame', () => {
    for (const id of CHARACTER_IDS) {
      const characterMeta = loadMeta(id);
      for (const [animation, clip] of Object.entries(characterMeta.animations)) {
        for (let frame = 0; frame < clip.frames; frame++) {
          const rect = computeSpriteFrameRect(characterMeta, animation, frame);
          expect(rect.x + rect.width).toBeLessThanOrEqual(characterMeta.sheetWidth);
          expect(rect.y + rect.height).toBeLessThanOrEqual(characterMeta.sheetHeight);
        }
      }
    }
  });
});

describe('resolveSpriteAnchor', () => {
  /**
   * The pack draws a desk INTO the `work`/`typing`/`sit` frames (verified by scanning the shipped
   * PNGs: the table's top edge is row 21 of 32 in every one of those frames, for all four
   * characters). Pinning that row to the scene's own desk surface is what stops the office showing
   * two desks per worker — the built-in table lands exactly on ours and reads as the same plane.
   */
  it('pins a desk-bearing clip by its built-in table line', () => {
    expect(resolveSpriteAnchor('typing')).toEqual({ reference: 'desk-surface', row: DESK_LINE_ROW });
    expect(resolveSpriteAnchor('sit')).toEqual({ reference: 'desk-surface', row: DESK_LINE_ROW });
    expect(resolveSpriteAnchor('work')).toEqual({ reference: 'desk-surface', row: DESK_LINE_ROW });
  });

  it('pins a desk-free clip by the ground under its feet', () => {
    expect(resolveSpriteAnchor('walk')).toEqual({ reference: 'floor', row: GROUND_LINE_ROW });
    expect(resolveSpriteAnchor('idle')).toEqual({ reference: 'floor', row: GROUND_LINE_ROW });
    expect(resolveSpriteAnchor('celebrate')).toEqual({ reference: 'floor', row: GROUND_LINE_ROW });
  });
});

describe('ROLE_SPRITE_SCALE', () => {
  /** Guide section 9: integer scales only — a fractional one destroys pixel-perfect rendering. */
  it('uses whole-number scales for both roles', () => {
    expect(Number.isInteger(ROLE_SPRITE_SCALE.orchestrator)).toBe(true);
    expect(Number.isInteger(ROLE_SPRITE_SCALE.subagent)).toBe(true);
  });

  it('draws an orchestrator larger than its subagents', () => {
    expect(ROLE_SPRITE_SCALE.orchestrator).toBeGreaterThan(ROLE_SPRITE_SCALE.subagent);
  });
});

describe('shipped asset pack', () => {
  /** Guide section 31 "Verificación mínima", enforced rather than trusted. */
  it('ships every character the code can resolve, with the frame geometry the code assumes', () => {
    for (const id of CHARACTER_IDS) {
      const meta = loadMeta(id);
      expect(meta.frameWidth).toBe(32);
      expect(meta.frameHeight).toBe(32);
      expect(meta.sheetWidth).toBe(128);
      expect(meta.sheetHeight).toBe(256);
      for (const animation of ['idle', 'walk', 'work', 'typing', 'talk', 'point', 'celebrate', 'sit']) {
        expect(meta.animations[animation]?.frames).toBe(4);
      }
    }
  });

  /**
   * Guide section 23 asks callers not to hardcode the character list when the manifest can supply
   * it. `CHARACTER_IDS` is hardcoded anyway, because the union type it produces is what makes
   * every lookup in this module exhaustive at compile time — so this test is the guard that keeps
   * the two from drifting apart if the pack is ever regenerated.
   */
  it('lists exactly the characters the shipped manifest declares', () => {
    const manifest = JSON.parse(readFileSync(join(PACK_ROOT, 'characters_manifest.json'), 'utf8')) as {
      characters: Record<string, unknown>;
    };

    expect([...CHARACTER_IDS].sort()).toEqual(Object.keys(manifest.characters).sort());
  });

  it('ships a spritesheet and a portrait file for every character', () => {
    for (const id of CHARACTER_IDS) {
      expect(() => readFileSync(join(PACK_ROOT, id, `${id}_spritesheet.png`))).not.toThrow();
      expect(() => readFileSync(join(PACK_ROOT, id, `${id}_portrait.png`))).not.toThrow();
    }
  });
});

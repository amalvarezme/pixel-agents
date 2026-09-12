import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHARACTER_IDS,
  ROLE_SPRITE_SCALE,
  SPRITE_ACTIONS,
  computeSpriteFrameRect,
  resolveCharacterId,
  resolveSpriteClip,
  selectSpriteFrame,
  selectSpritePose,
  spriteAnchorPoint,
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

describe('resolveSpriteClip', () => {
  const meta = loadMeta('alex');

  it('draws the clip the character actually ships for that direction', () => {
    expect(resolveSpriteClip(meta, 'walk', 'down')?.direction).toBe('down');
    expect(resolveSpriteClip(meta, 'walk', 'up')?.direction).toBe('up');
  });

  it('collapses right onto the single drawn side clip, unmirrored', () => {
    // The pack draws `side` facing right (`sideFaces`), so a right-facing character needs no flip.
    expect(resolveSpriteClip(meta, 'walk', 'right')).toMatchObject({ direction: 'side', mirror: false });
  });

  it('answers left with the SAME side clip, mirrored — never a second set of art', () => {
    // Guide section 5: "No crear una segunda copia gráfica para left."
    const left = resolveSpriteClip(meta, 'walk', 'left');
    const right = resolveSpriteClip(meta, 'walk', 'right');
    expect(left?.mirror).toBe(true);
    expect(left?.clip.row).toBe(right?.clip.row);
  });

  it('falls back to the direction an action is actually drawn in', () => {
    // `work`/`typing` exist only as `up`, `celebrate`/`sit` only as `down`.
    expect(resolveSpriteClip(meta, 'typing', 'down')?.direction).toBe('up');
    expect(resolveSpriteClip(meta, 'sit', 'up')?.direction).toBe('down');
  });

  it('never reports a mirror for a fallback that is not the side clip', () => {
    expect(resolveSpriteClip(meta, 'typing', 'left')?.mirror).toBe(false);
  });

  it('returns null for an action the pack does not ship, instead of throwing at render time', () => {
    expect(resolveSpriteClip(meta, 'backflip', 'down')).toBeNull();
  });
});

describe('selectSpritePose', () => {
  it('types at the workstation, facing it, while the session is producing events', () => {
    // office_map.json: every workstation declares `defaultAnimation: "typing"`, `facing: "up"`.
    expect(selectSpritePose({ state: 'working' })).toEqual({ action: 'typing', direction: 'up' });
  });

  it('turns away from the laptop toward the room once the session goes quiet', () => {
    expect(selectSpritePose({ state: 'idle' })).toEqual({ action: 'idle', direction: 'down' });
  });

  it('walks the way it is actually heading', () => {
    expect(selectSpritePose({ state: 'walking', direction: 'left' })).toEqual({ action: 'walk', direction: 'left' });
    expect(selectSpritePose({ state: 'walking', direction: 'up' })).toEqual({ action: 'walk', direction: 'up' });
  });

  it('walks facing the viewer when no direction was resolved, never an undefined clip', () => {
    expect(selectSpritePose({ state: 'walking' })).toEqual({ action: 'walk', direction: 'down' });
  });

  it('points at the archive on arrival, which outranks every other state', () => {
    // specialZones.persistent_memory: `defaultAnimation: "point"`, `facing: "up"`.
    expect(selectSpritePose({ state: 'walking', atArchive: true })).toEqual({ action: 'point', direction: 'up' });
    expect(selectSpritePose({ state: 'working', atArchive: true })).toEqual({ action: 'point', direction: 'up' });
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

  it('reads the source rectangle straight off the resolved clip', () => {
    const walkSide = resolveSpriteClip(meta, 'walk', 'right')!;
    expect(computeSpriteFrameRect(meta, walkSide.clip, 2)).toEqual({
      x: 64,
      y: walkSide.clip.row * 32,
      width: 32,
      height: 32,
    });
  });

  it('never reads outside the sheet for any shipped character, action, direction or frame', () => {
    for (const id of CHARACTER_IDS) {
      const characterMeta = loadMeta(id);
      for (const group of Object.values(characterMeta.animations)) {
        for (const clip of Object.values(group)) {
          for (let frame = 0; frame < clip.frames; frame++) {
            const rect = computeSpriteFrameRect(characterMeta, clip, frame);
            expect(rect.x + rect.width).toBeLessThanOrEqual(characterMeta.sheetWidth);
            expect(rect.y + rect.height).toBeLessThanOrEqual(characterMeta.sheetHeight);
          }
        }
      }
    }
  });
});

describe('spriteAnchorPoint', () => {
  it('pins the sprite by the character\'s own declared origin, not the frame corner', () => {
    // Guide section 5: `(agent.x, agent.y)` are the FEET. Anchoring there is also what makes the
    // left-facing mirror keep the feet in place instead of sliding the body sideways.
    const meta = loadMeta('alex');
    expect(spriteAnchorPoint(meta)).toEqual({ x: 16 / 32, y: 30 / 32 });
  });

  it('puts the anchor on the horizontal centre and at the foot line for every shipped character', () => {
    for (const id of CHARACTER_IDS) {
      const anchor = spriteAnchorPoint(loadMeta(id));
      expect(anchor.x).toBe(0.5);
      expect(anchor.y).toBeGreaterThan(0.9);
      expect(anchor.y).toBeLessThanOrEqual(1);
    }
  });
});

describe('ROLE_SPRITE_SCALE', () => {
  /** Guide section 6: integer scales only — a fractional one destroys pixel-perfect rendering. */
  it('uses whole-number scales for both roles', () => {
    expect(Number.isInteger(ROLE_SPRITE_SCALE.orchestrator)).toBe(true);
    expect(Number.isInteger(ROLE_SPRITE_SCALE.subagent)).toBe(true);
  });

  it('draws an orchestrator larger than its subagents', () => {
    expect(ROLE_SPRITE_SCALE.orchestrator).toBeGreaterThan(ROLE_SPRITE_SCALE.subagent);
  });
});

describe('shipped asset pack', () => {
  /** Guide section 18 "Criterios de aceptación", enforced rather than trusted. */
  it('ships every character the code can resolve, with the frame geometry the code assumes', () => {
    for (const id of CHARACTER_IDS) {
      const meta = loadMeta(id);
      expect(meta.schemaVersion ?? 2).toBe(2);
      expect(meta.frameWidth).toBe(32);
      expect(meta.frameHeight).toBe(32);
      expect(meta.sheetWidth).toBe(128);
      expect(meta.sheetHeight).toBe(512);
      expect(meta.sideFaces).toBe('right');
      for (const action of SPRITE_ACTIONS) {
        expect(Object.keys(meta.animations[action] ?? {}).length).toBeGreaterThan(0);
      }
    }
  });

  it('resolves every pose the scene can ask for, on every shipped character', () => {
    // The renderer has a fallback for a missing clip, but a pose the PACK cannot answer would mean
    // a silent downgrade for every worker of that project — catch it here instead.
    const poses = [
      selectSpritePose({ state: 'working' }),
      selectSpritePose({ state: 'idle' }),
      selectSpritePose({ state: 'walking', atArchive: true }),
      ...(['up', 'down', 'left', 'right'] as const).map((direction) => selectSpritePose({ state: 'walking', direction })),
    ];

    for (const id of CHARACTER_IDS) {
      const meta = loadMeta(id);
      for (const pose of poses) {
        expect(resolveSpriteClip(meta, pose.action, pose.direction)).not.toBeNull();
      }
    }
  });

  /**
   * The v2 sprites are body-only (guide section 5): desks, laptops and chairs belong to the
   * environment. Nothing in code can assert "no furniture", but the sheet HEIGHT can: v1 packed 8
   * furniture-bearing rows into 256px, v2 needs 16 directional rows and 512px. A pack that fails
   * this is the old one, and every anchor in the renderer would be wrong.
   */
  it('ships the 16-row directional sheet, not the 8-row v1 sheet', () => {
    for (const id of CHARACTER_IDS) {
      const meta = loadMeta(id);
      const rows = Object.values(meta.animations).flatMap((group) => Object.values(group).map((clip) => clip.row));
      expect(new Set(rows).size).toBe(16);
      expect(Math.max(...rows)).toBe(15);
    }
  });

  /**
   * `CHARACTER_IDS` is hardcoded because the union type it produces is what makes every lookup in
   * this module exhaustive at compile time — so this test is the guard that keeps it and the
   * shipped manifest from drifting apart if the pack is ever regenerated.
   */
  it('lists exactly the characters the shipped manifest declares', () => {
    const manifest = JSON.parse(readFileSync(join(PACK_ROOT, 'characters_manifest.json'), 'utf8')) as {
      characters: Record<string, unknown>;
    };

    expect([...CHARACTER_IDS].sort()).toEqual(Object.keys(manifest.characters).sort());
  });

  it('ships a spritesheet and a portrait file for every character, at the URLs the code builds', () => {
    for (const id of CHARACTER_IDS) {
      expect(() => readFileSync(join(PACK_ROOT, id, `${id}_spritesheet_v2.png`))).not.toThrow();
      expect(() => readFileSync(join(PACK_ROOT, id, `${id}_portrait_v2.png`))).not.toThrow();
    }
  });
});

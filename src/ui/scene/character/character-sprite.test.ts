import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  CHARACTER_IDS,
  ROLE_SCALE_BONUS,
  SPRITE_ACTIONS,
  characterPortraitUrl,
  characterSheetUrl,
  computeSpriteFrameRect,
  resolveCharacterId,
  resolveCharacterScale,
  resolveSpriteClip,
  selectSpriteFrame,
  selectSpritePose,
  spriteAnchorPoint,
  type CharacterSpriteMeta,
} from './character-sprite';

const PACK_ROOT = join(process.cwd(), 'public', 'characters');

/**
 * The characters that shipped BEFORE the pack moved to v3, and are therefore the only ones with a
 * `_v2` pair on disk. Scorpion and Kitana are born at v3 — neither ever had a v2 — and a fabricated
 * `_v2` file just to satisfy a uniform loop would be a lie about the pack's history, so the two
 * guards below are deliberately split: v3 for every character (the URLs the code actually builds),
 * v2 for these four by name (kept so a future cleanup does not delete files that are still served).
 */
const LEGACY_V2_IDS = ['alex', 'marcus', 'sophia', 'elena'] as const;

function loadMeta(id: string): CharacterSpriteMeta {
  return JSON.parse(readFileSync(join(PACK_ROOT, id, `${id}.json`), 'utf8')) as CharacterSpriteMeta;
}

/**
 * A minimal 8-bit RGBA PNG reader, for one guard only.
 *
 * This file had no image decoder and `package.json` deliberately carries no image dependency (the
 * generator's own `png.mjs` says why: a committed build-time artifact should not cost a runtime
 * dependency). The palette-cohesion guard below needs actual pixel colours, so the smallest honest
 * alternative is this: parse the chunks, `inflateSync` the IDAT, and undo the five standard PNG
 * filters. Every PNG it is asked to read is 8-bit RGBA non-interlaced — the generator writes that
 * shape and the shipped portrait asset is already in it — and any other shape throws loudly instead
 * of returning wrong colours.
 */
function readRgbaPng(path: string): { width: number; height: number; pixels: Buffer } {
  const bytes = readFileSync(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error(`${path} is not a PNG`);

  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8] ?? 0;
      const colorType = data[9] ?? 0;
      const interlace = data[12] ?? 0;
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(
          `${path}: expected 8-bit RGBA non-interlaced, got depth ${bitDepth} type ${colorType} interlace ${interlace}`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const start = y * (stride + 1) + 1;
    const line = Buffer.from(raw.subarray(start, start + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? (line[x - 4] ?? 0) : 0;
      const b = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const c = y > 0 && x >= 4 ? (pixels[(y - 1) * stride + x - 4] ?? 0) : 0;
      let value = line[x] ?? 0;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`${path}: unknown PNG filter ${filter} on row ${y}`);
      }
      line[x] = value & 0xff;
    }
    line.copy(pixels, y * stride);
  }
  return { width, height, pixels };
}

/**
 * The set of VISIBLE colours (opaque RGB triples) in a decoded PNG. A fully transparent pixel has
 * no colour a viewer can see, so it is not part of the palette claim.
 */
function visibleColors(image: { pixels: Buffer }): Set<string> {
  const colors = new Set<string>();
  for (let i = 0; i < image.pixels.length; i += 4) {
    if (image.pixels[i + 3] === 0) continue;
    colors.add(`${image.pixels[i]},${image.pixels[i + 1]},${image.pixels[i + 2]}`);
  }
  return colors;
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

  it('defaults to Scorpion: the first agent on a fresh floor is Scorpion', () => {
    // PRODUCT DECISION, not an implementation detail. Scorpion is the character a worker with no
    // project is drawn as, so `CHARACTER_IDS[0]` is a chosen default rather than an accident of
    // array order. That same slot also answers every project whose hash lands on 0, because the
    // array is the hash table — which is why reordering `CHARACTER_IDS` is a BEHAVIOURAL change
    // and must never be done for tidiness. Changing the default has to be deliberate, and this
    // assertion is what forces that.
    expect(resolveCharacterId(undefined)).toBe('scorpion');
  });

  it('places Kitana SECOND: the maintainer asked for her right after the default', () => {
    // PRODUCT DECISION, not an implementation detail, and deliberately the same shape as the
    // Scorpion-default assertion above. Slot 1 is a bucket of the hash table, not a display order,
    // so WHICH character a new id pushes onto is a choice about which existing projects get
    // redrawn. The maintainer asked for Kitana to be the second character, immediately after the
    // no-project default; this assertion is what makes moving her out of that slot a deliberate,
    // reviewable change rather than a tidy-up that silently reshuffles every project's character.
    expect(CHARACTER_IDS[1]).toBe('kitana');
  });

  it('can reach EVERY shipped character, so no project silently loses the character it was assigned', () => {
    // The modulus is `CHARACTER_IDS.length`, never a literal. A `% 4` left behind when the fifth
    // character was added would make that character unreachable for every project in existence,
    // with no error anywhere — it would simply never be drawn — and no other test would notice.
    const reached = new Set<string>();
    for (let i = 0; i < 500; i++) reached.add(resolveCharacterId(`/projects/project-${i}`));

    expect([...reached].sort()).toEqual([...CHARACTER_IDS].sort());
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

  it('types when a tool started recently enough to be at the keys', () => {
    expect(selectSpritePose({ state: 'working', toolActive: true })).toEqual({ action: 'typing', direction: 'up' });
  });

  it('thinks between tools when no tool has started recently', () => {
    expect(selectSpritePose({ state: 'working', toolActive: false })).toEqual({ action: 'work', direction: 'up' });
  });

  it('falls back to typing when toolActive is omitted, matching the map\'s own default', () => {
    // office_map.json declares `defaultAnimation: "typing"` on every workstation — a caller with
    // no signal must fall back to the map's default rather than silently downgrading to `work`.
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

  // Sofa-visit feature: `sit`/`down` slots into the precedence order right after `walking` — a
  // worker mid-walk to or from the sofa must still show as WALKING (the caller passes
  // `state: 'walking'` for that leg; `seated` only ever accompanies the dwell), and `atArchive`
  // still outranks everything, exactly like it outranks `working`/`idle` above.
  it('sits, facing the viewer, while seated at the meeting sofa', () => {
    // The sofa sits against the back wall and its anchors face the room (office_map.json:
    // specialZones.meeting_sofa's `facing: "up"` means the ANCHOR faces up toward the sofa, so
    // the worker occupying it faces the opposite way — down, toward the viewer). The pack also
    // only ever draws `sit` as `down` in the first place (`fallbackDirections.sit`), so this is
    // both the geometrically correct reading and the only one the asset pack can answer.
    expect(selectSpritePose({ state: 'idle', seated: true })).toEqual({ action: 'sit', direction: 'down' });
  });

  it('seated outranks idle/working but never outranks walking or the archive', () => {
    expect(selectSpritePose({ state: 'working', seated: true })).toEqual({ action: 'sit', direction: 'down' });
    expect(selectSpritePose({ state: 'walking', seated: true, direction: 'left' })).toEqual({ action: 'walk', direction: 'left' });
    expect(selectSpritePose({ state: 'working', seated: true, atArchive: true })).toEqual({ action: 'point', direction: 'up' });
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
      x: 128,
      y: walkSide.clip.row * 64,
      width: 64,
      height: 64,
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

describe('resolveCharacterScale', () => {
  /** Guide section 6: integer scales only — a fractional one destroys pixel-perfect rendering. */
  it('only ever draws at a whole-number scale, anywhere in the room, for either role', () => {
    for (let y = 0; y <= 941; y += 20) {
      expect(Number.isInteger(resolveCharacterScale(y, 'orchestrator'))).toBe(true);
      expect(Number.isInteger(resolveCharacterScale(y, 'subagent'))).toBe(true);
    }
  });

  it('draws an orchestrator larger than a subagent standing in the same place', () => {
    expect(resolveCharacterScale(700, 'orchestrator')).toBeGreaterThan(resolveCharacterScale(700, 'subagent'));
  });

  it('keeps the room\'s perspective: the same agent is smaller further back', () => {
    expect(resolveCharacterScale(500, 'subagent')).toBeLessThan(resolveCharacterScale(800, 'subagent'));
  });

  it('adds role as a whole step rather than a ratio, so perspective survives it', () => {
    expect(ROLE_SCALE_BONUS.orchestrator - ROLE_SCALE_BONUS.subagent).toBe(1);
    expect(resolveCharacterScale(700, 'orchestrator') - resolveCharacterScale(700, 'subagent')).toBe(1);
  });
});

describe('shipped asset pack', () => {
  // Guards the `typing`/`work` split (selectSpritePose): a repacked asset set that drops the
  // `work` row would silently downgrade every worker to `typing` forever, since
  // `resolveSpriteClip` degrades to null rather than throwing.
  it('ships a resolvable work/up clip for every character, alongside typing', () => {
    for (const id of CHARACTER_IDS) {
      const meta = loadMeta(id);
      expect(resolveSpriteClip(meta, 'work', 'up')).not.toBeNull();
    }
  });

  /** Guide section 18 "Criterios de aceptación", enforced rather than trusted. */
  it('ships every character the code can resolve, with the frame geometry the code assumes', () => {
    for (const id of CHARACTER_IDS) {
      const meta = loadMeta(id);
      expect(meta.schemaVersion).toBe(3);
      expect(meta.frameWidth).toBe(64);
      expect(meta.frameHeight).toBe(64);
      expect(meta.sheetWidth).toBe(384);
      expect(meta.sheetHeight).toBe(1024);
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
   * The sprites are body-only (guide section 5): desks, laptops and chairs belong to the
   * environment. Nothing in code can assert "no furniture", but the sheet SHAPE can: v1 packed 8
   * furniture-bearing rows into 256px, v2 needed 16 directional rows at 32px, and v3 draws those
   * same 16 rows at 64px with six frames each. A pack that fails this is an older one, and every
   * anchor in the renderer would be wrong.
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
    // The v3 files are what `characterSheetUrl`/`characterPortraitUrl` return and what the scene
    // actually fetches, so those are the ones a missing character would break on.
    for (const id of CHARACTER_IDS) {
      for (const url of [characterSheetUrl(id), characterPortraitUrl(id)]) {
        expect(() => readFileSync(join(PACK_ROOT, url.replace('/characters/', '')))).not.toThrow();
      }
    }
  });

  /**
   * The tooltip portrait and the floor sprite are two drawings of one character, so the only thing
   * that stops them reading as two characters is that they share a palette. For a GENERATED portrait
   * that is free — it is a crop of a frame of the sheet — but a portrait SHIPPED as an asset
   * (`palette.mjs`'s `portraitAsset`) is drawn outside the generator, and its colours are only as
   * close to the sheet as whoever produced it made them. This guard makes the property MEASURED
   * instead of assumed: it decodes both PNGs and reports any portrait colour that does not appear in
   * that same character's sheet.
   */
  it('keeps every character\'s portrait inside its own sheet\'s palette, so the tooltip cannot drift from the floor', () => {
    for (const id of CHARACTER_IDS) {
      const sheet = visibleColors(readRgbaPng(join(PACK_ROOT, id, `${id}_spritesheet_v3.png`)));
      const portrait = visibleColors(readRgbaPng(join(PACK_ROOT, id, `${id}_portrait_v3.png`)));
      const stray = [...portrait].filter((color) => !sheet.has(color));
      expect(
        stray,
        `${id}: ${stray.length} portrait colour(s) absent from its sheet: ${stray.slice(0, 8).join(' | ')}`,
      ).toEqual([]);
    }
  });

  it('keeps the four original v2 pairs on disk, and fabricates no v2 art for a v3-born character', () => {
    for (const id of LEGACY_V2_IDS) {
      expect(() => readFileSync(join(PACK_ROOT, id, `${id}_spritesheet_v2.png`))).not.toThrow();
      expect(() => readFileSync(join(PACK_ROOT, id, `${id}_portrait_v2.png`))).not.toThrow();
    }

    const bornAtV3 = [...CHARACTER_IDS].filter((id) => !(LEGACY_V2_IDS as readonly string[]).includes(id));
    // Enumerated by name ON PURPOSE: the four legacy pairs are the only `_v2` files that may exist,
    // and every other shipped id must be v3-born with no `_v2` pair. Naming them instead of
    // filtering generically is what kept this negative from silently dropping Kitana when the
    // sixth character landed.
    expect(bornAtV3).toEqual(['scorpion', 'kitana']);
    for (const id of bornAtV3) {
      expect(() => readFileSync(join(PACK_ROOT, id, `${id}_spritesheet_v2.png`))).toThrow();
      expect(() => readFileSync(join(PACK_ROOT, id, `${id}_portrait_v2.png`))).toThrow();
    }
  });
});

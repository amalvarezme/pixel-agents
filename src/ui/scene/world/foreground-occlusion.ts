/**
 * Which side of the foreground layer a character belongs on. Pure, canvas-free, decided from the
 * map's own collision rectangles.
 *
 * The problem this solves: `foreground.png` is ONE image drawn over the whole room, but the
 * furniture in it is not uniformly in front of everybody. An agent at a workstation stands between
 * the viewer and its desk — that is what an `interactionAnchor` IS (guide section 8: the place you
 * stand to use the station) — so the desk must be drawn BEHIND it. The same agent walking up the
 * room later passes behind that desk, and then the desk must be drawn in front. With a single
 * foreground image the only choice available is per-character: draw this one before the layer, or
 * after it.
 *
 * The rule, using only what the map already declares:
 *
 *   a character is behind the foreground when some furniture rectangle
 *     - overlaps the column its FEET occupy, and
 *     - overlaps the rows its BODY is drawn across, and
 *     - has its own front edge NEARER the viewer than the character's feet.
 *
 * All three conditions are needed. Without the first, a planter the character walks past would
 * claim it; without the second, a desk whose art is nowhere near the character would; without the
 * third, every desk a character stands in front of would hide it — which is exactly the defect
 * this replaces.
 *
 * Horizontal overlap is tested against the character's FOOT hitbox rather than its drawn width,
 * because "what am I standing behind" is a question about the floor — the pack ships a small foot
 * hitbox for precisely this and section 13 warns against using the full 32x32 frame. Vertical
 * overlap is tested against the drawn body, because that is what can actually be covered.
 */
import { CHARACTER_BODY_HEIGHT } from '../character/character-sprite';
import { COLLISION_ZONES, type CollisionZone } from './office-map';

/**
 * Half the width of the character's foot hitbox, in frame pixels — `hitbox.width / 2` from the
 * shipped character metadata (14px wide, centred on the origin).
 */
export const CHARACTER_FOOT_HALF_WIDTH = 7;

export interface StandingCharacter {
  /** The character's feet, in map coordinates. */
  x: number;
  y: number;
  /** The scale it is drawn at, so a bigger figure is tested against the rows it really covers. */
  scale: number;
}

/** The first piece of furniture that stands in front of this character, or `null`. */
export function findForegroundOccluder(character: StandingCharacter): CollisionZone | null {
  const footLeft = character.x - CHARACTER_FOOT_HALF_WIDTH * character.scale;
  const footRight = character.x + CHARACTER_FOOT_HALF_WIDTH * character.scale;
  const bodyTop = character.y - CHARACTER_BODY_HEIGHT * character.scale;

  for (const zone of COLLISION_ZONES) {
    const right = zone.x + zone.width;
    const front = zone.y + zone.height;
    if (right < footLeft || zone.x > footRight) continue;
    if (front < bodyTop || zone.y > character.y) continue;
    if (front > character.y) return zone;
  }
  return null;
}

export function isBehindForeground(character: StandingCharacter): boolean {
  return findForegroundOccluder(character) !== null;
}

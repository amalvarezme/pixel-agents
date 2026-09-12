import { describe, expect, it } from 'vitest';
import { findForegroundOccluder, isBehindForeground } from './foreground-occlusion';
import { COLLISION_ZONES, WORKSTATIONS, depthScaleFor } from './office-map';
import { resolveCharacterScale } from '../character/character-sprite';

/** The scale the renderer would actually draw a subagent standing at `y`. */
function scaleAt(y: number): number {
  return resolveCharacterScale(y, 'subagent');
}

describe('findForegroundOccluder — which side of the foreground a character belongs on', () => {
  /**
   * The one that matters: every workstation anchor is the floor IN FRONT of its desk (guide
   * section 8 — it is where you stand to use the station), so its occupant must draw on top of the
   * foreground. Getting this wrong is what buried all eleven agents behind their own desks.
   */
  it('puts every seated agent in front of the furniture it is working at', () => {
    for (const station of WORKSTATIONS) {
      const { x, y } = station.interactionAnchor;
      expect(findForegroundOccluder({ x, y, scale: scaleAt(y) })).toBeNull();
    }
  });

  it('puts a character standing behind a desk behind the foreground', () => {
    // Between the centre desk's back edge and the desk itself: the desk is nearer the viewer.
    const behindTheCentreDesk = { x: 600, y: 640, scale: scaleAt(640) };

    expect(findForegroundOccluder(behindTheCentreDesk)?.id).toBe('desk_center');
    expect(isBehindForeground(behindTheCentreDesk)).toBe(true);
  });

  it('triangulates with a different desk on the other side of the room', () => {
    expect(findForegroundOccluder({ x: 300, y: 470, scale: scaleAt(470) })?.id).toBe('desk_nw');
  });

  it('leaves a character in the open aisle in front of everything', () => {
    expect(isBehindForeground({ x: 960, y: 660, scale: scaleAt(660) })).toBe(false);
  });

  it('ignores furniture the character is standing in front of, however tall it is', () => {
    // Directly below the centre desk (its front edge is at y=675): the desk is BEHIND these feet,
    // so it must not claim them no matter how much of the artwork overlaps the body.
    expect(findForegroundOccluder({ x: 600, y: 700, scale: scaleAt(700) })).toBeNull();
  });

  it('ignores furniture whose art is nowhere near the character', () => {
    // The stairs are nearer the viewer than this point but far off to the right.
    const stairs = COLLISION_ZONES.find((zone) => zone.id === 'stairs')!;
    const wellLeftOfTheStairs = { x: stairs.x - 400, y: stairs.y + 40, scale: 3 };

    expect(findForegroundOccluder(wellLeftOfTheStairs)?.id).not.toBe('stairs');
  });

  /**
   * Horizontal overlap is tested against the FOOT hitbox, not the drawn body. ws_08's agent stands
   * one pixel clear of the left planter: measured by its drawn width it grazes the rectangle and
   * the whole figure would be pushed behind the foreground; measured by its feet — the question
   * actually being asked — it does not.
   */
  it('asks where the FEET are, not how wide the drawing is', () => {
    const ws08 = WORKSTATIONS.find((station) => station.id === 'ws_08')!.interactionAnchor;

    expect(findForegroundOccluder({ x: ws08.x, y: ws08.y, scale: scaleAt(ws08.y) })).toBeNull();
  });

  it('grows the tested body with the scale the character is drawn at', () => {
    // A taller figure reaches up into furniture a shorter one at the same spot never touches.
    const spot = { x: 600, y: 700 };
    const tall = findForegroundOccluder({ ...spot, scale: 12 });
    const short = findForegroundOccluder({ ...spot, scale: 1 });

    expect(short).toBeNull();
    expect(tall).toBeNull(); // still in front — the centre desk's front edge is above these feet
    expect(depthScaleFor(spot.y)).toBeGreaterThan(0);
  });

  it('is deterministic for the same standing position', () => {
    const character = { x: 600, y: 640, scale: 4 };

    expect(findForegroundOccluder(character)).toBe(findForegroundOccluder(character));
  });
});

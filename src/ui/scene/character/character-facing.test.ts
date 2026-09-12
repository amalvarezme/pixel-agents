import { describe, expect, it } from 'vitest';
import { resolveCharacterFacing } from './character-facing';

describe('resolveCharacterFacing — pure direction-from-movement decision', () => {
  it('faces right when moving toward increasing x', () => {
    expect(resolveCharacterFacing(0, 100)).toBe('right');
  });

  it('faces left when moving toward decreasing x', () => {
    expect(resolveCharacterFacing(100, 0)).toBe('left');
  });

  // Adversarial twin: magnitude must never matter, only the SIGN of the delta.
  it('faces the same way regardless of how large the delta is, as long as the sign matches', () => {
    expect(resolveCharacterFacing(0, 1)).toBe(resolveCharacterFacing(0, 10_000));
    expect(resolveCharacterFacing(0, -1)).toBe(resolveCharacterFacing(0, -10_000));
  });

  // The decisive, explicitly required case: a zero delta must not flip erratically — it must
  // return one documented, stable default.
  it('returns a stable, documented default for a zero delta', () => {
    expect(resolveCharacterFacing(500, 500)).toBe('right');
    // Idempotent: calling it again with the same zero-delta input never flips.
    expect(resolveCharacterFacing(500, 500)).toBe(resolveCharacterFacing(500, 500));
  });

  // Adversarial twin: the zero-delta default must hold at any shared x, not just one specific
  // coordinate.
  it('keeps the same zero-delta default regardless of which x the character is standing at', () => {
    expect(resolveCharacterFacing(0, 0)).toBe(resolveCharacterFacing(1720, 1720));
  });

  it('reverses facing when the same leg is walked in the opposite direction', () => {
    const deskX = 400;
    const archiveX = 1720;
    const facingOut = resolveCharacterFacing(deskX, archiveX);
    const facingBack = resolveCharacterFacing(archiveX, deskX);
    expect(facingOut).not.toBe(facingBack);
  });
});

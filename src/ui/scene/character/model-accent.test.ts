import { describe, expect, it } from 'vitest';
import { resolveModelAccentColor } from './model-accent';

describe('resolveModelAccentColor — deterministic per-model colour accent', () => {
  it('returns the same colour for the same model name every time', () => {
    expect(resolveModelAccentColor('claude-sonnet-5')).toBe(resolveModelAccentColor('claude-sonnet-5'));
  });

  // Adversarial twin: two DIFFERENT model names must resolve to different colours — proves the
  // colour is actually derived from the model string, not a constant.
  it('returns a different colour for a different model name', () => {
    expect(resolveModelAccentColor('claude-sonnet-5')).not.toBe(resolveModelAccentColor('claude-opus-5'));
  });

  it('returns one fixed neutral colour when the model is not yet known (undefined)', () => {
    expect(resolveModelAccentColor(undefined)).toBe(resolveModelAccentColor(undefined));
  });

  // Adversarial twin: an unresolved model must never collide with a real, named model's colour.
  it('does not invent a real model colour for an unresolved (undefined) model', () => {
    expect(resolveModelAccentColor(undefined)).not.toBe(resolveModelAccentColor('claude-sonnet-5'));
  });

  it('treats an empty string the same as undefined (no model resolved yet)', () => {
    expect(resolveModelAccentColor('')).toBe(resolveModelAccentColor(undefined));
  });
});

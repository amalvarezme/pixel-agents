import { describe, expect, it } from 'vitest';
import { selectCharacterAnimationState } from './animation-state';

describe('selectCharacterAnimationState — idle vs working vs walking from view-model data', () => {
  it('selects working when the worker is at its desk with activity=working', () => {
    expect(selectCharacterAnimationState({ activity: 'working', isWalking: false })).toBe('working');
  });

  it('selects idle when the worker is at its desk with activity=idle', () => {
    expect(selectCharacterAnimationState({ activity: 'idle', isWalking: false })).toBe('idle');
  });

  // Adversarial twin for the idle/working boundary: only `activity` differs.
  it('does NOT select working for an idle worker (idle/working boundary)', () => {
    const idle = selectCharacterAnimationState({ activity: 'idle', isWalking: false });
    const working = selectCharacterAnimationState({ activity: 'working', isWalking: false });
    expect(idle).not.toBe(working);
  });

  // Walking must win over a desk-bound activity — a worker mid archive-trip transit is never
  // shown typing. Adversarial twin for the working/walking boundary: only `isWalking` differs.
  it('selects walking over working when the worker is mid archive-trip, even with activity=working', () => {
    expect(selectCharacterAnimationState({ activity: 'working', isWalking: true })).toBe('walking');
  });

  it('selects walking over idle when the worker is mid archive-trip', () => {
    expect(selectCharacterAnimationState({ activity: 'idle', isWalking: true })).toBe('walking');
  });

  // Defaults to idle rather than inventing a "working" state for a view model that never
  // specified `activity` (e.g. a hand-built test fixture).
  it('defaults to idle when activity is absent', () => {
    expect(selectCharacterAnimationState({ isWalking: false })).toBe('idle');
  });
});

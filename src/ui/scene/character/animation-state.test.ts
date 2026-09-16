import { describe, expect, it } from 'vitest';
import { TOOL_ACTIVE_WINDOW_MS, isToolRecentlyStarted, selectCharacterAnimationState } from './animation-state';

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

/**
 * `isToolRecentlyStarted` is the typing/thinking recency signal: recency of `tool_start` rather
 * than pairing with `tool_end`, since only the claude-code adapter ever emits `tool_end`
 * (`office.ts`'s `lastToolStartAt` doc comment).
 */
describe('isToolRecentlyStarted — tool-start recency, not tool_start/tool_end pairing', () => {
  it('is never active when no tool_start has ever been recorded', () => {
    expect(isToolRecentlyStarted(undefined, 10_000)).toBe(false);
  });

  it('is active just inside the window', () => {
    expect(isToolRecentlyStarted(10_000, 10_000 + TOOL_ACTIVE_WINDOW_MS - 1)).toBe(true);
  });

  it('is NOT active exactly at the boundary', () => {
    expect(isToolRecentlyStarted(10_000, 10_000 + TOOL_ACTIVE_WINDOW_MS)).toBe(false);
  });

  it('is not active well past the window', () => {
    expect(isToolRecentlyStarted(10_000, 10_000 + TOOL_ACTIVE_WINDOW_MS + 5_000)).toBe(false);
  });

  // Harness clocks and the render clock are independent: a small forward skew must not read as
  // "stale" just because the timestamp is technically in the future.
  it('counts a future timestamp as active', () => {
    expect(isToolRecentlyStarted(10_000, 9_000)).toBe(true);
  });
});

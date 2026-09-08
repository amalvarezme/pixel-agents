/**
 * `isLaunchEligibleSessionKey` (tasks.md 24.8, spec: "Supported Launch Targets" — "Antigravity IDE
 * has no launch affordance"). A pure predicate the UI's launch control uses to decide whether to
 * present a launch/relaunch affordance for an already-ingested session. The Antigravity adapter's
 * own `sessionKey` format (`antigravity:ide:<conversationId>` vs `antigravity:cli:<conversationId>`,
 * `discover.ts`) already encodes the surface — this function only PARSES that generic string; it
 * imports no antigravity adapter file (Subsystem Separation from Ingestion).
 */
import { describe, expect, it } from 'vitest';
import { isLaunchEligibleSessionKey } from './launch-eligibility';

describe('isLaunchEligibleSessionKey', () => {
  it('is NOT eligible for an Antigravity IDE session (spec: Antigravity IDE Root Separation)', () => {
    expect(isLaunchEligibleSessionKey('antigravity:ide:bdd0233c-fda1-4974-85db-483f2aae1672')).toBe(false);
  });

  it('IS eligible for an Antigravity CLI session (adversarial near-miss: same harness, different surface)', () => {
    expect(isLaunchEligibleSessionKey('antigravity:cli:bdd0233c-fda1-4974-85db-483f2aae1672')).toBe(true);
  });

  it('IS eligible for every other harness session key (triangulation: a different code path)', () => {
    expect(isLaunchEligibleSessionKey('claude-code:s1')).toBe(true);
    expect(isLaunchEligibleSessionKey('codex:rollout-1')).toBe(true);
    expect(isLaunchEligibleSessionKey('opencode:session-1')).toBe(true);
  });
});

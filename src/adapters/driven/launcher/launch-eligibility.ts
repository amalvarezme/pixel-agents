/**
 * tasks.md 24.8, spec: "Supported Launch Targets" — Antigravity IDE sessions get no launch
 * control. Pure string predicate; imports no antigravity adapter file (Subsystem Separation).
 */
const ANTIGRAVITY_IDE_PREFIX = 'antigravity:ide:';

export function isLaunchEligibleSessionKey(sessionKey: string): boolean {
  return !sessionKey.startsWith(ANTIGRAVITY_IDE_PREFIX);
}

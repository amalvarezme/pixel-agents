import { describe, expect, it } from 'vitest';
import { isWithinActiveWindow } from './active-window';

// design.md "Session discovery and aging out" — Bootstrap: "attach only to sessions touched
// within `activeWindow` (24h)". OpenCode's own bootstrap query already applies this as a strict
// `time_updated > ?` comparison; this pure predicate is the shared boundary the three JSONL
// adapters' discovery scans (Claude Code, Codex, Antigravity) must mirror exactly. Tested here
// against precise millisecond boundaries via a fake `now`/`mtimeMs`, never real filesystem
// timestamps, because real mtime write precision is not reliable enough to prove an off-by-one.
describe('isWithinActiveWindow', () => {
  const now = 1_000_000;
  const activeWindowMs = 24 * 60 * 60 * 1000;
  const cutoff = now - activeWindowMs;

  it('is false for a file touched exactly AT the cutoff (exclusive boundary)', () => {
    expect(isWithinActiveWindow(cutoff, now, activeWindowMs)).toBe(false);
  });

  it('is true for a file touched 1ms AFTER the cutoff (just inside the window)', () => {
    expect(isWithinActiveWindow(cutoff + 1, now, activeWindowMs)).toBe(true);
  });

  it('is false for a file touched 1ms BEFORE the cutoff (just outside the window)', () => {
    expect(isWithinActiveWindow(cutoff - 1, now, activeWindowMs)).toBe(false);
  });

  it('is true for a file touched at exactly `now`', () => {
    expect(isWithinActiveWindow(now, now, activeWindowMs)).toBe(true);
  });
});

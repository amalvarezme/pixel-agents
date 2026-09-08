/**
 * `buildLaunchControlView` (tasks.md 26.2, spec: "Supported Launch Targets"). A pure view builder
 * for the launcher UI control: the four launchable harnesses, and no entry for Antigravity IDE —
 * that surface is never a `HarnessId` in the first place, so it is structurally impossible for it
 * to appear here (spec: "Antigravity IDE has no launch affordance").
 */
import { describe, expect, it } from 'vitest';
import { buildLaunchControlView } from './launch-control';

describe('buildLaunchControlView', () => {
  it('offers exactly the four supported launch targets, in a stable order', () => {
    const view = buildLaunchControlView();

    expect(view.targets).toEqual([
      { harness: 'claude-code', label: 'Claude Code' },
      { harness: 'codex', label: 'Codex' },
      { harness: 'opencode', label: 'OpenCode' },
      { harness: 'antigravity', label: 'Antigravity' },
    ]);
  });

  it('never includes an Antigravity IDE entry (spec: Antigravity IDE has no launch affordance)', () => {
    const view = buildLaunchControlView();

    expect(view.targets.some((t) => (t.harness as string).includes('ide'))).toBe(false);
  });
});

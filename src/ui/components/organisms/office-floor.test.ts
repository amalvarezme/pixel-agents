import { describe, expect, it } from 'vitest';
import { buildOfficeFloorView } from './office-floor';
import type { OfficeViewModel } from '../../state/office-view-model';

describe('buildOfficeFloorView (organism) — the full renderable scene description consumed by ui/scene/pixi/', () => {
  it('combines every worker into a matching desk+worker pair, preserving overflow count', () => {
    const viewModel: OfficeViewModel = {
      workers: [
        { sessionKey: 'claude-code:s1', harness: 'claude-code', label: 'root-session', x: 760, y: 540, lane: 'root' },
        { sessionKey: 'claude-code:c1', harness: 'claude-code', label: 'child-session', x: 960, y: 760, lane: 'child' },
      ],
      overflowCount: 2,
    };

    const floor = buildOfficeFloorView(viewModel);

    expect(floor.desks).toHaveLength(2);
    expect(floor.workers).toHaveLength(2);
    expect(floor.overflowCount).toBe(2);

    const rootWorker = floor.workers.find((w) => w.sessionKey === 'claude-code:s1');
    const rootDesk = floor.desks.find((d) => d.sessionKey === 'claude-code:s1');
    expect(rootWorker?.caption).toBe('root-session');
    // Desk furniture is wide and short (molecules/desk.ts), not the old square worker-body block.
    expect(rootDesk?.width).toBeGreaterThan(rootDesk?.height ?? 0);
    expect(rootWorker?.x).toBe(rootDesk?.x);
  });

  it('produces an empty floor for an empty office', () => {
    const floor = buildOfficeFloorView({ workers: [], overflowCount: 0 });
    expect(floor.desks).toEqual([]);
    expect(floor.workers).toEqual([]);
    expect(floor.overflowCount).toBe(0);
  });

  // Blocker B.2 (tasks.md 21.2): the archive counter is a scene-level fact, not a per-worker one.
  it('passes archiveCount through from the view model', () => {
    const floor = buildOfficeFloorView({ workers: [], overflowCount: 0, archiveCount: 4 });
    expect(floor.archiveCount).toBe(4);
  });

  it('defaults archiveCount to 0 when the view model omits it', () => {
    const floor = buildOfficeFloorView({ workers: [], overflowCount: 0 });
    expect(floor.archiveCount).toBe(0);
  });
});

/**
 * Regression: `applyTripOverlay` overwrites `x`/`y` with the archive-trip's moving position, and
 * the desk used to be built from those same two fields — so every memory_write sent the whole
 * workstation walking to the cabinet with the character riding on top of it.
 */
describe('buildOfficeFloorView desk position', () => {
  it('keeps the desk at its layout position while the character is mid-trip', () => {
    const floor = buildOfficeFloorView({
      workers: [
        {
          sessionKey: 'claude-code:s1',
          harness: 'claude-code',
          label: 's1',
          x: 1500,
          y: 900,
          deskX: 400,
          deskY: 300,
          lane: 'root',
        },
      ],
      overflowCount: 0,
    });

    expect(floor.desks[0]).toMatchObject({ x: 400, y: 300 });
    expect(floor.workers[0]).toMatchObject({ x: 1500, y: 900 });
  });

  it('falls back to the worker position for a view model that never set a desk position', () => {
    const floor = buildOfficeFloorView({
      workers: [{ sessionKey: 'claude-code:s1', harness: 'claude-code', label: 's1', x: 400, y: 300, lane: 'root' }],
      overflowCount: 0,
    });

    expect(floor.desks[0]).toMatchObject({ x: 400, y: 300 });
  });
});

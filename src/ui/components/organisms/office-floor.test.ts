import { describe, expect, it } from 'vitest';
import { buildOfficeFloorView } from './office-floor';
import type { OfficeViewModel } from '../../state/office-view-model';

describe('buildOfficeFloorView (organism) — the full renderable scene description consumed by ui/scene/pixi/', () => {
  it('turns every seated worker into a drawable character, preserving the overflow count', () => {
    const viewModel: OfficeViewModel = {
      workers: [
        { sessionKey: 'claude-code:s1', harness: 'claude-code', label: 'root-session', x: 760, y: 540 },
        { sessionKey: 'claude-code:c1', harness: 'claude-code', label: 'child-session', x: 960, y: 760 },
      ],
      overflowCount: 2,
    };

    const floor = buildOfficeFloorView(viewModel);

    expect(floor.workers).toHaveLength(2);
    expect(floor.overflowCount).toBe(2);
    expect(floor.workers.find((w) => w.sessionKey === 'claude-code:s1')?.caption).toBe('root-session');
  });

  /**
   * The office's desks are painted into `background.png` and belong to the room, not to any one
   * agent — so the floor describes people and nothing else. This used to carry a parallel list of
   * generated desks, and building them from the worker's own x/y (which the archive-trip overlay
   * overwrites) was what once sent a whole workstation walking to the cabinet.
   */
  it('describes people only — the room itself is artwork, not scene objects', () => {
    const floor = buildOfficeFloorView({
      workers: [{ sessionKey: 'claude-code:s1', harness: 'claude-code', label: 's1', x: 1500, y: 900, seatX: 400, seatY: 300 }],
      overflowCount: 0,
    });

    expect(Object.keys(floor).sort()).toEqual(['archiveCount', 'overflowCount', 'workers']);
    // The character is drawn where it currently IS, not where its seat is.
    expect(floor.workers[0]).toMatchObject({ x: 1500, y: 900 });
  });

  it('produces an empty floor for an empty office', () => {
    const floor = buildOfficeFloorView({ workers: [], overflowCount: 0 });
    expect(floor.workers).toEqual([]);
    expect(floor.overflowCount).toBe(0);
  });

  // Blocker B.2 (tasks.md 21.2): the archive counter is a scene-level fact, not a per-worker one.
  it('passes archiveCount through from the view model', () => {
    expect(buildOfficeFloorView({ workers: [], overflowCount: 0, archiveCount: 4 }).archiveCount).toBe(4);
  });

  it('defaults archiveCount to 0 when the view model omits it', () => {
    expect(buildOfficeFloorView({ workers: [], overflowCount: 0 }).archiveCount).toBe(0);
  });

  it('sizes each character by where it stands, so the room keeps its perspective', () => {
    const floor = buildOfficeFloorView({
      workers: [
        { sessionKey: 'claude-code:back', harness: 'claude-code', label: 'back', x: 500, y: 500 },
        { sessionKey: 'claude-code:front', harness: 'claude-code', label: 'front', x: 500, y: 880 },
      ],
      overflowCount: 0,
    });

    const back = floor.workers.find((w) => w.sessionKey === 'claude-code:back')!;
    const front = floor.workers.find((w) => w.sessionKey === 'claude-code:front')!;
    expect(front.scale).toBeGreaterThan(back.scale);
  });
});

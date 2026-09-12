import { Container, Graphics, Text } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { renderOfficeBackground, renderOfficeScene } from './office-scene-renderer';
import type { OfficeFloorView } from '../../components/organisms/office-floor';
import type { AgentTooltipView } from '../../components/atoms/agent-tooltip';

// This file only exercises the PixiJS DRAWING of a worker, never tooltip CONTENT (that is
// `agent-tooltip.test.ts`'s job) — a fixed placeholder is enough to satisfy `WorkerView.tooltip`.
const TEST_TOOLTIP: AgentTooltipView = {
  rows: [
    { label: 'Agent', value: 'Claude Code' },
    { label: 'Role', value: 'Unknown' },
    { label: 'Model', value: 'Unknown' },
    { label: 'Task', value: 'one' },
  ],
};

describe('renderOfficeScene (tasks.md 10.3) — the only module that imports PixiJS', () => {
  it('renders the office background plus the archive counter for an empty floor', () => {
    const floor: OfficeFloorView = { desks: [], workers: [], overflowCount: 0, archiveCount: 0 };

    const scene = renderOfficeScene(floor);

    expect(scene).toBeInstanceOf(Container);
    expect(scene.children).toHaveLength(2);
  });

  it('renders one desk graphic and one caption text per worker, positioned at the worker coordinates', () => {
    const floor: OfficeFloorView = {
      desks: [{ sessionKey: 'claude-code:s1', x: 760, y: 540, width: 160, height: 160 }],
      workers: [
        {
          sessionKey: 'claude-code:s1',
          x: 760,
          y: 540,
          lane: 'root',
          badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' },
          caption: 'my-session',
          tooltip: TEST_TOOLTIP,
        },
      ],
      overflowCount: 0,
      archiveCount: 0,
    };

    const scene = renderOfficeScene(floor);

    // Index 0 is now the office background (floor/wall/archive cabinet) — desk groups follow it.
    const deskGroups = scene.children.slice(1, 1 + floor.desks.length) as Container[];
    expect(deskGroups).toHaveLength(1);
    const [deskGroup] = deskGroups;
    expect(deskGroup!.x).toBe(760);
    expect(deskGroup!.y).toBe(540);

    const graphics = deskGroup!.children.find((child) => child instanceof Graphics);
    expect(graphics).toBeDefined();

    const captionText = deskGroup!.children.find((child): child is Text => child instanceof Text);
    expect(captionText?.text).toBe('my-session');
  });

  it('renders a separate desk group per worker, with no shared state between them', () => {
    const floor: OfficeFloorView = {
      desks: [
        { sessionKey: 'claude-code:s1', x: 100, y: 100, width: 160, height: 160 },
        { sessionKey: 'claude-code:s2', x: 300, y: 100, width: 160, height: 160 },
      ],
      workers: [
        { sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' }, caption: 'one', tooltip: TEST_TOOLTIP },
        { sessionKey: 'claude-code:s2', x: 300, y: 100, lane: 'root', badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' }, caption: 'two', tooltip: TEST_TOOLTIP },
      ],
      overflowCount: 0,
      archiveCount: 0,
    };

    const scene = renderOfficeScene(floor);

    const deskGroups = scene.children.slice(1, 1 + floor.desks.length) as Container[];
    expect(deskGroups).toHaveLength(2);
    const captions = deskGroups.map((group) => group.children.find((c): c is Text => c instanceof Text)?.text);
    expect(captions).toEqual(['one', 'two']);
  });

  // Blocker B.2 (tasks.md 21.2): "a document indicator appears" while a worker carries a
  // memory_write trip to the archive.
  describe('archive-trip document indicator', () => {
    function floorWithOneWorker(archiveTrip?: { carryCount: number; highlight: boolean }): OfficeFloorView {
      return {
        desks: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, width: 160, height: 160 }],
        workers: [
          {
            sessionKey: 'claude-code:s1',
            x: 100,
            y: 100,
            lane: 'root',
            badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' },
            caption: 'one',
            tooltip: TEST_TOOLTIP,
            ...(archiveTrip ? { archiveTrip } : {}),
          },
        ],
        overflowCount: 0,
        archiveCount: 0,
      };
    }

    it('draws an extra graphic for a worker carrying an archive trip', () => {
      const withoutTrip = renderOfficeScene(floorWithOneWorker());
      const withTrip = renderOfficeScene(floorWithOneWorker({ carryCount: 1, highlight: false }));

      const baselineGraphicsCount = (withoutTrip.children[1] as Container).children.filter((c) => c instanceof Graphics).length;
      const withTripGraphicsCount = (withTrip.children[1] as Container).children.filter((c) => c instanceof Graphics).length;

      expect(withTripGraphicsCount).toBe(baselineGraphicsCount + 1);
    });

    // Adversarial twin: no archiveTrip means no extra graphic at all.
    it('draws no document indicator for a worker with no archive trip', () => {
      const withoutTrip = renderOfficeScene(floorWithOneWorker());
      const withTrip = renderOfficeScene(floorWithOneWorker({ carryCount: 1, highlight: false }));

      const baselineGraphicsCount = (withoutTrip.children[1] as Container).children.filter((c) => c instanceof Graphics).length;
      const withTripGraphicsCount = (withTrip.children[1] as Container).children.filter((c) => c instanceof Graphics).length;

      expect(baselineGraphicsCount).toBeLessThan(withTripGraphicsCount);
    });

    // "a brief highlight fires": a highlighted trip draws one more graphic (a highlight ring)
    // than a non-highlighted one carrying the exact same document.
    it('draws an additional highlight graphic while the trip is dwelling at the archive', () => {
      const notHighlighted = renderOfficeScene(floorWithOneWorker({ carryCount: 1, highlight: false }));
      const highlighted = renderOfficeScene(floorWithOneWorker({ carryCount: 1, highlight: true }));

      const notHighlightedCount = (notHighlighted.children[1] as Container).children.filter((c) => c instanceof Graphics).length;
      const highlightedCount = (highlighted.children[1] as Container).children.filter((c) => c instanceof Graphics).length;

      expect(highlightedCount).toBe(notHighlightedCount + 1);
    });

    it('shows the ×N batch badge only once carryCount is greater than 1', () => {
      const single = renderOfficeScene(floorWithOneWorker({ carryCount: 1, highlight: false }));
      const batch = renderOfficeScene(floorWithOneWorker({ carryCount: 5, highlight: false }));

      const singleTexts = (single.children[1] as Container).children.filter((c): c is Text => c instanceof Text).map((t) => t.text);
      const batchTexts = (batch.children[1] as Container).children.filter((c): c is Text => c instanceof Text).map((t) => t.text);

      expect(singleTexts.some((t) => t.includes('×'))).toBe(false);
      expect(batchTexts.some((t) => t === '×5')).toBe(true);
    });
  });

  // "An office background — floor, a back wall, desks the workers sit at" — always present,
  // regardless of who is in the office, and drawn BEHIND every desk group.
  describe('office background', () => {
    it('renders the background as the very first child, before any desk group', () => {
      const floor: OfficeFloorView = {
        desks: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, width: 160, height: 160 }],
        workers: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' }, caption: 'one', tooltip: TEST_TOOLTIP }],
        overflowCount: 0,
        archiveCount: 0,
      };

      const scene = renderOfficeScene(floor);
      const background = scene.children[0] as Container;

      expect(background).toBeInstanceOf(Container);
      expect(background.children.every((c) => c instanceof Graphics)).toBe(true);
      // Floor + back wall + archive cabinet: at least 3 distinct background shapes.
      expect(background.children.length).toBeGreaterThanOrEqual(3);
    });

    // Adversarial twin: an empty floor still gets the SAME background — it never depends on
    // there being any worker at all.
    it('renders the identical background shape count for an empty floor', () => {
      const populated = renderOfficeScene({
        desks: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, width: 160, height: 160 }],
        workers: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' }, caption: 'one', tooltip: TEST_TOOLTIP }],
        overflowCount: 0,
        archiveCount: 0,
      });
      const empty = renderOfficeScene({ desks: [], workers: [], overflowCount: 0, archiveCount: 0 });

      const populatedBackground = populated.children[0] as Container;
      const emptyBackground = empty.children[0] as Container;

      expect(emptyBackground.children.length).toBe(populatedBackground.children.length);
    });
  });

  // "an orchestrator must look visibly different from a subagent" — the pixel-art character
  // built for each role has a structurally different shape count (character-pose.test.ts covers
  // the pure decision; this proves the pixi wiring actually reaches it end to end).
  describe('character sprite — orchestrator vs subagent', () => {
    function floorWithProfile(agentProfile?: { role: 'orchestrator' | 'subagent' }): OfficeFloorView {
      return {
        desks: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, width: 160, height: 160 }],
        workers: [
          {
            sessionKey: 'claude-code:s1',
            x: 100,
            y: 100,
            lane: 'root',
            badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' },
            caption: 'one',
            tooltip: TEST_TOOLTIP,
            ...(agentProfile ? { agentProfile } : {}),
          },
        ],
        overflowCount: 0,
        archiveCount: 0,
      };
    }

    // The character is drawn as its own nested Container inside the desk group (index 2: after
    // the desk surface + accent strip, before the caption) — see
    // `renderWorkerCharacter`/`renderDeskGroup`.
    function characterGraphicsCount(scene: Container): number {
      const deskGroup = scene.children[1] as Container;
      const characterGroup = deskGroup.children[2] as Container;
      return characterGroup.children.filter((c) => c instanceof Graphics).length;
    }

    it('draws one more graphic for an orchestrator than for a subagent', () => {
      const subagent = renderOfficeScene(floorWithProfile({ role: 'subagent' }));
      const orchestrator = renderOfficeScene(floorWithProfile({ role: 'orchestrator' }));

      expect(characterGraphicsCount(orchestrator)).toBe(characterGraphicsCount(subagent) + 1);
    });

    // Adversarial twin: no agentProfile at all must render like a subagent, not an orchestrator.
    it('renders a worker with no agentProfile the same as an explicit subagent', () => {
      const noProfile = renderOfficeScene(floorWithProfile(undefined));
      const explicitSubagent = renderOfficeScene(floorWithProfile({ role: 'subagent' }));

      expect(characterGraphicsCount(noProfile)).toBe(characterGraphicsCount(explicitSubagent));
    });
  });

  // Defect fix: a fully-saturated harness colour across the whole (now desk-shaped) surface was
  // "the loudest thing on screen", pulling attention away from the character. The bulk of the
  // desk is now a fixed, muted surface colour; only a thin front-edge accent strip carries the
  // harness colour, preserving harness identity without dominating the frame.
  describe('desk colour', () => {
    function floorWithBadgeColor(color: string): OfficeFloorView {
      return {
        desks: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, width: 160, height: 40 }],
        workers: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', name: 'Claude Code', color }, caption: 'one', tooltip: TEST_TOOLTIP }],
        overflowCount: 0,
        archiveCount: 0,
      };
    }

    it('draws the desk surface in a fixed muted colour, not the fully-saturated harness colour', () => {
      const scene = renderOfficeScene(floorWithBadgeColor('#d97757'));
      const deskGroup = scene.children[1] as Container;
      const deskSurface = deskGroup.children[0] as Graphics;

      // 0xd97757 as a number, matching the harness badge colour string above.
      expect(deskSurface.fillStyle.color).not.toBe(0xd97757);
    });

    // Adversarial twin: the harness colour must still appear SOMEWHERE on the desk (the accent
    // strip) — proves this tones the colour down rather than erasing harness identity entirely.
    it('still carries the harness colour on a small accent strip', () => {
      const scene = renderOfficeScene(floorWithBadgeColor('#d97757'));
      const deskGroup = scene.children[1] as Container;
      const deskAccent = deskGroup.children[1] as Graphics;

      expect(deskAccent.fillStyle.color).toBe(0xd97757);
    });

    // Triangulate: a different harness colour must flow through to the SAME accent strip, proving
    // it is read from `worker.badge.color`, not hardcoded to one harness.
    it('reflects a different harness colour on the accent strip for a different harness', () => {
      const scene = renderOfficeScene(floorWithBadgeColor('#10a37f'));
      const deskGroup = scene.children[1] as Container;
      const deskAccent = deskGroup.children[1] as Graphics;

      expect(deskAccent.fillStyle.color).toBe(0x10a37f);
    });
  });

  // Defect fix: the character stood exactly ON the desk's back edge (perched on top of what used
  // to be a tall square). The figure must read as standing BEHIND the desk, with the desktop in
  // front of it — a visible gap between the character's feet and the desk's own back edge.
  describe('character anchor relative to the desk', () => {
    function floorWithDeskSize(width: number, height: number): OfficeFloorView {
      return {
        desks: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, width, height }],
        workers: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' }, caption: 'one', tooltip: TEST_TOOLTIP }],
        overflowCount: 0,
        archiveCount: 0,
      };
    }

    it("anchors the character strictly behind the desk's back edge, not exactly on it", () => {
      const scene = renderOfficeScene(floorWithDeskSize(160, 40));
      const deskGroup = scene.children[1] as Container;
      const characterGroup = deskGroup.children[2] as Container;

      expect(characterGroup.y).toBeLessThan(-40 / 2);
    });

    // Adversarial twin: a TALLER desk must push the anchor further back too — proves the offset
    // is actually derived from desk.height, not a hardcoded constant that happens to clear a
    // 40-unit desk.
    it('moves the anchor further back for a taller desk', () => {
      const shortDeskScene = renderOfficeScene(floorWithDeskSize(160, 40));
      const tallDeskScene = renderOfficeScene(floorWithDeskSize(160, 80));

      const shortAnchorY = ((shortDeskScene.children[1] as Container).children[2] as Container).y;
      const tallAnchorY = ((tallDeskScene.children[1] as Container).children[2] as Container).y;

      expect(tallAnchorY).toBeLessThan(shortAnchorY);
    });
  });

  // Project sets COLOUR: every worker under the same project shares one torso colour
  // (`resolveProjectCharacterColor`), proving the pixi wiring actually reaches it end to end
  // (character-pose.test.ts covers the pure colour decision itself).
  describe('character sprite — project colour', () => {
    function floorWithProject(projectPath?: string): OfficeFloorView {
      return {
        desks: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, width: 160, height: 160 }],
        workers: [
          {
            sessionKey: 'claude-code:s1',
            x: 100,
            y: 100,
            lane: 'root',
            badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' },
            caption: 'one',
            tooltip: TEST_TOOLTIP,
            agentProfile: { role: 'subagent' },
            ...(projectPath !== undefined ? { projectPath } : {}),
          },
        ],
        overflowCount: 0,
        archiveCount: 0,
      };
    }

    // No cape for a subagent, so the torso is the THIRD shape drawn (after both legs) — index 2
    // in the character group's own children, matching buildCharacterPose's draw order.
    function torsoGraphics(scene: Container): Graphics {
      const deskGroup = scene.children[1] as Container;
      const characterGroup = deskGroup.children[2] as Container;
      return characterGroup.children[2] as Graphics;
    }

    it("paints the character's torso with the project's resolved colour", () => {
      const scene = renderOfficeScene(floorWithProject('/Users/andresalvarez/Documents/pixel-agents'));

      // 0x4fd1c5 is resolveProjectCharacterColor('/Users/andresalvarez/Documents/pixel-agents').
      expect(torsoGraphics(scene).fillStyle.color).toBe(0x4fd1c5);
    });

    // Adversarial twin: a different project must paint a different torso colour.
    it('reflects a different project with a different torso colour', () => {
      const sceneA = renderOfficeScene(floorWithProject('/Users/andresalvarez/Documents/pixel-agents'));
      const sceneB = renderOfficeScene(floorWithProject('/Users/andresalvarez/Documents/other-project'));

      expect(torsoGraphics(sceneA).fillStyle.color).not.toBe(torsoGraphics(sceneB).fillStyle.color);
    });

    it('paints the fixed neutral colour when the worker has no projectPath', () => {
      const scene = renderOfficeScene(floorWithProject(undefined));

      // 0x6b7280 is resolveProjectCharacterColor(undefined) — the fixed neutral.
      expect(torsoGraphics(scene).fillStyle.color).toBe(0x6b7280);
    });
  });

  // Desk props (monitor/keyboard/mouse/mug, `scenery/office-scenery.ts`'s `buildDeskProps`) must
  // draw AFTER the character so the monitor occludes the figure standing behind the desk.
  describe('desk props (monitor, keyboard, mouse, mug)', () => {
    function floorWithOneDesk(): OfficeFloorView {
      return {
        desks: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, width: 160, height: 40 }],
        workers: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' }, caption: 'one', tooltip: TEST_TOOLTIP }],
        overflowCount: 0,
        archiveCount: 0,
      };
    }

    it('keeps the character container at index 2 and adds desk-prop graphics at index 3 or later', () => {
      const scene = renderOfficeScene(floorWithOneDesk());
      const deskGroup = scene.children[1] as Container;

      expect(deskGroup.children[2]).toBeInstanceOf(Container); // the character, unchanged

      const propsChild = deskGroup.children[3];
      expect(propsChild).toBeDefined();
      expect(propsChild).toBeInstanceOf(Graphics);
    });

    // Adversarial twin: an empty floor draws no desk group at all, so it must not draw any desk
    // props either — proves the props are per-desk, not some always-present global fixture.
    it('draws no desk-prop graphics at all for an empty floor', () => {
      const scene = renderOfficeScene({ desks: [], workers: [], overflowCount: 0, archiveCount: 0 });
      expect(scene.children).toHaveLength(2); // background + archive counter only
    });
  });

  // Performance: the scenery is static and takes no input, yet `updateStage` rebuilds the whole
  // scene graph every animation frame. Rebuilding it inline costs 560 rect draw-ops per frame to
  // redraw pixels identical to the last frame's. A caller that renders repeatedly passes ONE
  // background Container back in on every frame instead.
  describe('reusable static background', () => {
    it('attaches the caller-provided background instance instead of building a new one', () => {
      const background = renderOfficeBackground();
      const floor: OfficeFloorView = { desks: [], workers: [], overflowCount: 0, archiveCount: 0 };

      const scene = renderOfficeScene(floor, 0, { background });

      expect(scene.children[0]).toBe(background);
    });

    // PixiJS gotcha this pins deliberately: a Container has exactly ONE parent, so re-rendering
    // REPARENTS the shared background into the newest scene and detaches it from the previous one.
    // That is exactly what production wants — `updateStage` discards the old scene every frame and
    // only the newest one is ever on the stage — but it means the previous scene must NOT be
    // expected to still hold it.
    it('reuses the SAME instance across repeated renders, rebuilding nothing', () => {
      const background = renderOfficeBackground();
      const floor: OfficeFloorView = { desks: [], workers: [], overflowCount: 0, archiveCount: 0 };

      const first = renderOfficeScene(floor, 0, { background });
      const second = renderOfficeScene(floor, 16, { background });

      expect(second.children[0]).toBe(background);
      expect(first.children).not.toContain(background);
    });

    // Adversarial twin: with no background passed, each scene must still own a DISTINCT one — the
    // existing tests build two scenes in one test and read both backgrounds, which a shared
    // instance would break (a Container can only have one parent).
    it('builds a separate background per scene when none is provided', () => {
      const floor: OfficeFloorView = { desks: [], workers: [], overflowCount: 0, archiveCount: 0 };

      const first = renderOfficeScene(floor);
      const second = renderOfficeScene(floor);

      expect(second.children[0]).not.toBe(first.children[0]);
    });
  });

  // Blocker B.2: "a per-archive counter increments".
  describe('archive counter', () => {
    it('renders the current archiveCount as text', () => {
      const floor: OfficeFloorView = { desks: [], workers: [], overflowCount: 0, archiveCount: 3 };

      const scene = renderOfficeScene(floor);

      const counterGroup = scene.children[scene.children.length - 1] as Container;
      const counterText = counterGroup.children.find((c): c is Text => c instanceof Text);
      expect(counterText?.text).toContain('3');
    });

    // Adversarial twin: a different count must produce different text, proving the value is
    // actually read from `floor.archiveCount` and not hardcoded.
    it('reflects a different archiveCount with different text', () => {
      const floor: OfficeFloorView = { desks: [], workers: [], overflowCount: 0, archiveCount: 7 };

      const scene = renderOfficeScene(floor);

      const counterGroup = scene.children[scene.children.length - 1] as Container;
      const counterText = counterGroup.children.find((c): c is Text => c instanceof Text);
      expect(counterText?.text).toContain('7');
      expect(counterText?.text).not.toContain('3');
    });
  });
});

describe('renderOfficeScene scene ordering and worker state', () => {
  function worker(sessionKey: string, x: number, y: number, extra: Record<string, unknown> = {}) {
    return {
      sessionKey,
      x,
      y,
      lane: 'root' as const,
      badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' },
      caption: sessionKey,
      tooltip: TEST_TOOLTIP,
      ...extra,
    };
  }

  function floorOf(workers: ReturnType<typeof worker>[], deskPositions?: Array<{ x: number; y: number }>): OfficeFloorView {
    return {
      desks: workers.map((w, i) => ({
        sessionKey: w.sessionKey,
        x: deskPositions?.[i]?.x ?? w.x,
        y: deskPositions?.[i]?.y ?? w.y,
        width: 160,
        height: 40,
      })),
      workers: workers as unknown as OfficeFloorView['workers'],
      overflowCount: 0,
      archiveCount: 0,
    };
  }

  /** Character pack guide section 18: a workstation lower on the plan draws in front of one further back. */
  it('draws workers back-to-front by their y position, regardless of input order', () => {
    const scene = renderOfficeScene(floorOf([worker('far', 100, 800), worker('near', 300, 200)]));

    const groups = scene.children.slice(1, 3) as Container[];
    const captions = groups.map((g) => g.children.find((c): c is Text => c instanceof Text)?.text);
    expect(captions).toEqual(['near', 'far']);
  });

  /**
   * Regression: the desk used to be drawn at the WORKER's animated position, so a memory_write
   * sent the whole workstation walking to the archive cabinet.
   */
  it('leaves the desk at its own position while the character walks away from it', () => {
    const scene = renderOfficeScene(
      floorOf([worker('s1', 900, 150, { archiveTrip: { carryCount: 1, highlight: false } })], [{ x: 200, y: 700 }]),
    );

    const group = scene.children[1] as Container;
    expect({ x: group.x, y: group.y }).toEqual({ x: 200, y: 700 });
  });

  it('carries the archive document with the character, not with the desk it left behind', () => {
    const scene = renderOfficeScene(
      floorOf([worker('s1', 900, 150, { archiveTrip: { carryCount: 1, highlight: false } })], [{ x: 200, y: 700 }]),
    );

    const group = scene.children[1] as Container;
    const documents = group.children.filter((c) => c instanceof Graphics && c.x === 700);
    expect(documents).toHaveLength(1);
  });

  /** design.md "Session discovery and aging out": idle means "worker dims, stays on stage". */
  it('dims a worker whose session has gone quiet', () => {
    const working = renderOfficeScene(floorOf([worker('s1', 100, 100, { activity: 'working' })]));
    const idle = renderOfficeScene(floorOf([worker('s1', 100, 100, { activity: 'idle' })]));

    const alphaOf = (scene: Container): number => {
      const group = scene.children[1] as Container;
      return (group.children.find((c) => c instanceof Container && c.alpha < 1)?.alpha ?? 1) as number;
    };

    expect(alphaOf(working)).toBe(1);
    expect(alphaOf(idle)).toBeLessThan(1);
  });
});

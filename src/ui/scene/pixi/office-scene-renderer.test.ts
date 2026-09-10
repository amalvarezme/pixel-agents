import { Container, Graphics, Text } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { renderOfficeScene } from './office-scene-renderer';
import type { OfficeFloorView } from '../../components/organisms/office-floor';

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
          badge: { text: 'Claude', color: '#d97757' },
          caption: 'my-session',
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
        { sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', color: '#d97757' }, caption: 'one' },
        { sessionKey: 'claude-code:s2', x: 300, y: 100, lane: 'root', badge: { text: 'Claude', color: '#d97757' }, caption: 'two' },
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
            badge: { text: 'Claude', color: '#d97757' },
            caption: 'one',
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
        workers: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', color: '#d97757' }, caption: 'one' }],
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
        workers: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', color: '#d97757' }, caption: 'one' }],
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
            badge: { text: 'Claude', color: '#d97757' },
            caption: 'one',
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
        workers: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', color }, caption: 'one' }],
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
        workers: [{ sessionKey: 'claude-code:s1', x: 100, y: 100, lane: 'root', badge: { text: 'Claude', color: '#d97757' }, caption: 'one' }],
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

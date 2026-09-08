import { Container, Graphics, Text } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { renderOfficeScene } from './office-scene-renderer';
import type { OfficeFloorView } from '../../components/organisms/office-floor';

describe('renderOfficeScene (tasks.md 10.3) — the only module that imports PixiJS', () => {
  it('renders one child (the archive counter) for an empty floor', () => {
    const floor: OfficeFloorView = { desks: [], workers: [], overflowCount: 0, archiveCount: 0 };

    const scene = renderOfficeScene(floor);

    expect(scene).toBeInstanceOf(Container);
    expect(scene.children).toHaveLength(1);
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

    const deskGroups = scene.children.slice(0, floor.desks.length) as Container[];
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

    const deskGroups = scene.children.slice(0, floor.desks.length) as Container[];
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

      const baselineGraphicsCount = (withoutTrip.children[0] as Container).children.filter((c) => c instanceof Graphics).length;
      const withTripGraphicsCount = (withTrip.children[0] as Container).children.filter((c) => c instanceof Graphics).length;

      expect(withTripGraphicsCount).toBe(baselineGraphicsCount + 1);
    });

    // Adversarial twin: no archiveTrip means no extra graphic at all.
    it('draws no document indicator for a worker with no archive trip', () => {
      const withoutTrip = renderOfficeScene(floorWithOneWorker());
      const withTrip = renderOfficeScene(floorWithOneWorker({ carryCount: 1, highlight: false }));

      const baselineGraphicsCount = (withoutTrip.children[0] as Container).children.filter((c) => c instanceof Graphics).length;
      const withTripGraphicsCount = (withTrip.children[0] as Container).children.filter((c) => c instanceof Graphics).length;

      expect(baselineGraphicsCount).toBeLessThan(withTripGraphicsCount);
    });

    // "a brief highlight fires": a highlighted trip draws one more graphic (a highlight ring)
    // than a non-highlighted one carrying the exact same document.
    it('draws an additional highlight graphic while the trip is dwelling at the archive', () => {
      const notHighlighted = renderOfficeScene(floorWithOneWorker({ carryCount: 1, highlight: false }));
      const highlighted = renderOfficeScene(floorWithOneWorker({ carryCount: 1, highlight: true }));

      const notHighlightedCount = (notHighlighted.children[0] as Container).children.filter((c) => c instanceof Graphics).length;
      const highlightedCount = (highlighted.children[0] as Container).children.filter((c) => c instanceof Graphics).length;

      expect(highlightedCount).toBe(notHighlightedCount + 1);
    });

    it('shows the ×N batch badge only once carryCount is greater than 1', () => {
      const single = renderOfficeScene(floorWithOneWorker({ carryCount: 1, highlight: false }));
      const batch = renderOfficeScene(floorWithOneWorker({ carryCount: 5, highlight: false }));

      const singleTexts = (single.children[0] as Container).children.filter((c): c is Text => c instanceof Text).map((t) => t.text);
      const batchTexts = (batch.children[0] as Container).children.filter((c): c is Text => c instanceof Text).map((t) => t.text);

      expect(singleTexts.some((t) => t.includes('×'))).toBe(false);
      expect(batchTexts.some((t) => t === '×5')).toBe(true);
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

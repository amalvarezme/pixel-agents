import { Container, Graphics, Text } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { renderOfficeScene } from './office-scene-renderer';
import type { OfficeFloorView } from '../../components/organisms/office-floor';

describe('renderOfficeScene (tasks.md 10.3) — the only module that imports PixiJS', () => {
  it('renders no desks for an empty floor', () => {
    const floor: OfficeFloorView = { desks: [], workers: [], overflowCount: 0 };

    const scene = renderOfficeScene(floor);

    expect(scene).toBeInstanceOf(Container);
    expect(scene.children).toHaveLength(0);
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
    };

    const scene = renderOfficeScene(floor);

    expect(scene.children).toHaveLength(1);
    const [deskGroup] = scene.children as Container[];
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
    };

    const scene = renderOfficeScene(floor);

    expect(scene.children).toHaveLength(2);
    const captions = (scene.children as Container[]).map(
      (group) => group.children.find((c): c is Text => c instanceof Text)?.text,
    );
    expect(captions).toEqual(['one', 'two']);
  });
});

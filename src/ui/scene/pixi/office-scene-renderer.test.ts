import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { renderOfficeBackground, renderOfficeScene } from './office-scene-renderer';
import type { OfficeFloorView } from '../../components/organisms/office-floor';
import type { WorkerView } from '../../components/molecules/worker';
import type { AgentTooltipView } from '../../components/atoms/agent-tooltip';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../world/office-map';

// This file only exercises the PixiJS DRAWING of a worker, never tooltip CONTENT (that is
// `agent-tooltip.test.ts`'s job) — a fixed placeholder is enough to satisfy `WorkerView.tooltip`.
const TEST_TOOLTIP: AgentTooltipView = {
  portraitUrl: '/characters/alex/alex_portrait_v2.png',
  rows: [
    { label: 'Agent', value: 'Claude Code' },
    { label: 'Role', value: 'Unknown' },
    { label: 'Model', value: 'Unknown' },
    { label: 'Task', value: 'one' },
  ],
};

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    sessionKey: 'claude-code:s1',
    x: 660,
    y: 695,
    scale: 3,
    behindForeground: false,
    badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' },
    caption: 'my-session',
    tooltip: TEST_TOOLTIP,
    ...overrides,
  };
}

function floorOf(workers: WorkerView[], archiveCount = 0): OfficeFloorView {
  return { workers, overflowCount: 0, archiveCount };
}

/** The worker groups: everything between the background and the archive counter that is not one
 * of the artwork layers (a PixiJS `Sprite` is itself a `Container`, so identity is not enough). */
function workerGroups(scene: Container): Container[] {
  return scene.children.slice(1, scene.children.length - 1).filter((child) => !(child instanceof Sprite)) as Container[];
}

/** A worker group's caption text, which lives inside its own plated label container. */
function captionOf(group: Container): string | undefined {
  for (const child of group.children) {
    if (!(child instanceof Container)) continue;
    const text = child.children.find((c): c is Text => c instanceof Text);
    if (text) return text.text;
  }
  return undefined;
}

describe('renderOfficeScene — the room, its people, and the layer order between them', () => {
  it('renders the background plus the archive counter for an empty office', () => {
    const scene = renderOfficeScene(floorOf([]));

    expect(scene).toBeInstanceOf(Container);
    expect(scene.children).toHaveLength(2);
  });

  it('puts each character exactly where the layout says it stands', () => {
    const scene = renderOfficeScene(floorOf([worker({ x: 660, y: 695 })]));

    const [group] = workerGroups(scene);
    expect({ x: group!.x, y: group!.y }).toEqual({ x: 660, y: 695 });
    expect(captionOf(group!)).toBe('my-session');
  });

  it('gives every worker its own group, with no shared state between them', () => {
    const scene = renderOfficeScene(
      floorOf([
        worker({ sessionKey: 'claude-code:s1', x: 225, y: 612, caption: 'one' }),
        worker({ sessionKey: 'claude-code:s2', x: 325, y: 612, caption: 'two' }),
      ]),
    );

    const groups = workerGroups(scene);
    expect(groups).toHaveLength(2);
    expect(groups.map(captionOf)).toEqual(['one', 'two']);
  });

  /**
   * Guide section 12: sort by the FEET, never by the sprite centre or its top-left corner. A
   * character nearer the viewer draws in front of everyone behind it.
   */
  it('draws workers back-to-front by the y of their feet, regardless of input order', () => {
    const scene = renderOfficeScene(
      floorOf([worker({ sessionKey: 'far', x: 100, y: 500, caption: 'far' }), worker({ sessionKey: 'near', x: 300, y: 880, caption: 'near' })]),
    );

    expect(workerGroups(scene).map(captionOf)).toEqual(['far', 'near']);
  });

  /**
   * Guide section 4: the foreground layer lets furniture occlude the people BEHIND it. The split
   * around that layer is what makes an agent sit AT its workstation instead of hiding behind it —
   * a workstation anchor is the floor in front of the desk, so its occupant belongs on top of the
   * desk's art.
   */
  it('draws a character the furniture stands in front of BELOW the foreground', () => {
    const scene = renderOfficeScene(floorOf([worker({ behindForeground: true })]), 0, { foreground: Texture.EMPTY });

    const foregroundIndex = scene.children.findIndex((child) => child instanceof Sprite);
    const workerIndex = scene.children.indexOf(workerGroups(scene)[0]!);
    expect(workerIndex).toBeLessThan(foregroundIndex);
  });

  it('draws a character seated at its own workstation ABOVE the foreground', () => {
    const scene = renderOfficeScene(floorOf([worker({ behindForeground: false })]), 0, { foreground: Texture.EMPTY });

    const foregroundIndex = scene.children.findIndex((child) => child instanceof Sprite);
    const workerIndex = scene.children.indexOf(workerGroups(scene)[0]!);
    expect(workerIndex).toBeGreaterThan(foregroundIndex);
  });

  it('keeps the foreground between the two groups, and both below the UI', () => {
    const scene = renderOfficeScene(
      floorOf([
        worker({ sessionKey: 'behind', caption: 'behind', behindForeground: true }),
        worker({ sessionKey: 'front', caption: 'front', behindForeground: false }),
      ]),
      0,
      { foreground: Texture.EMPTY },
    );

    const foregroundIndex = scene.children.findIndex((child) => child instanceof Sprite);
    expect(workerGroups(scene).map(captionOf)).toEqual(['behind', 'front']);
    expect(foregroundIndex).toBe(2); // background, the occluded worker, then the artwork
    expect(foregroundIndex).toBeLessThan(scene.children.length - 2);
  });

  // Both groups keep their own depth order, so the split never reorders people within a side.
  it('sorts each side of the foreground by the y of their feet', () => {
    const scene = renderOfficeScene(
      floorOf([
        worker({ sessionKey: 'front-near', caption: 'front-near', y: 880, behindForeground: false }),
        worker({ sessionKey: 'front-far', caption: 'front-far', y: 500, behindForeground: false }),
      ]),
      0,
      { foreground: Texture.EMPTY },
    );

    expect(workerGroups(scene).map(captionOf)).toEqual(['front-far', 'front-near']);
  });

  it('draws no foreground layer at all when the artwork has not loaded', () => {
    const scene = renderOfficeScene(floorOf([worker()]));

    expect(scene.children.some((child) => child instanceof Sprite)).toBe(false);
  });

  /**
   * Guide section 11: the Sentinel is OUTSIDE. It is drawn before the agents and clipped to the
   * window mask, so it can never appear to be in the room or to be one of them.
   */
  describe('the exterior Sentinel', () => {
    const sentinelLayer = (marker: Container) => ({
      asset: { render: () => marker },
      windowMask: Texture.EMPTY,
    });

    it('draws it between the room and its occupants', () => {
      const marker = new Container();
      const scene = renderOfficeScene(floorOf([worker()]), 0, { sentinel: sentinelLayer(marker) });

      expect(scene.children.indexOf(marker)).toBe(1);
      expect(scene.children.indexOf(marker)).toBeLessThan(scene.children.length - 2);
    });

    it('draws nothing at all when its asset has not loaded', () => {
      const scene = renderOfficeScene(floorOf([worker()]));

      expect(scene.children).toHaveLength(3); // background + one worker + the archive counter
    });

    it('draws nothing when the asset declines to render this frame', () => {
      const scene = renderOfficeScene(floorOf([worker()]), 0, {
        sentinel: { asset: { render: () => null }, windowMask: Texture.EMPTY },
      });

      expect(scene.children).toHaveLength(3);
    });
  });
});

describe('renderOfficeBackground', () => {
  it('draws the room from the shipped artwork when it has loaded', () => {
    const background = renderOfficeBackground(Texture.EMPTY);

    expect(background.children[0]).toBeInstanceOf(Sprite);
  });

  /**
   * The room is bright. A fallback that kept the old dark slab would render every caption and
   * character against the wrong contrast for as long as a 2 MB PNG takes to arrive — and forever
   * if it never does.
   */
  it('falls back to a flat floor covering the whole room, never to an empty void', () => {
    const background = renderOfficeBackground();
    const floor = background.children[0] as Graphics;

    expect(floor).toBeInstanceOf(Graphics);
    expect(floor.getLocalBounds().width).toBe(WORLD_WIDTH);
    expect(floor.getLocalBounds().height).toBe(WORLD_HEIGHT);
  });

  // Performance: `updateStage` rebuilds the whole scene graph every animation frame, so a caller
  // that renders repeatedly passes ONE background container back in on every frame.
  it('attaches the caller-provided background instance instead of building a new one', () => {
    const background = renderOfficeBackground();

    expect(renderOfficeScene(floorOf([]), 0, { background }).children[0]).toBe(background);
  });

  // PixiJS gotcha this pins deliberately: a Container has exactly ONE parent, so re-rendering
  // REPARENTS the shared background into the newest scene and detaches it from the previous one.
  // That is exactly what production wants — only the newest scene is ever on the stage.
  it('reuses the SAME instance across repeated renders, rebuilding nothing', () => {
    const background = renderOfficeBackground();

    const first = renderOfficeScene(floorOf([]), 0, { background });
    const second = renderOfficeScene(floorOf([]), 16, { background });

    expect(second.children[0]).toBe(background);
    expect(first.children).not.toContain(background);
  });

  it('builds a separate background per scene when none is provided', () => {
    const first = renderOfficeScene(floorOf([]));
    const second = renderOfficeScene(floorOf([]));

    expect(second.children[0]).not.toBe(first.children[0]);
  });
});

// Blocker B.2 (tasks.md 21.2): "a document indicator appears" while a worker carries a
// memory_write trip to the archive.
describe('archive-trip document indicator', () => {
  function sceneWithTrip(archiveTrip?: WorkerView['archiveTrip']): Container {
    return renderOfficeScene(floorOf([worker(archiveTrip ? { archiveTrip } : {})]));
  }

  /** Graphics sitting directly on the worker group: the document and its highlight ring. The
   * character and the caption are both nested containers, so they never count here. */
  function indicatorCount(scene: Container): number {
    return (workerGroups(scene)[0] as Container).children.filter((c) => c instanceof Graphics).length;
  }

  it('draws a document for a worker carrying an archive trip', () => {
    expect(indicatorCount(sceneWithTrip({ carryCount: 1, highlight: false }))).toBe(1);
  });

  // Adversarial twin: no archiveTrip means no indicator at all.
  it('draws nothing for a worker with no archive trip', () => {
    expect(indicatorCount(sceneWithTrip())).toBe(0);
  });

  // "a brief highlight fires": dwelling at the archive adds the ring on top of the document.
  it('adds a highlight ring while the trip is dwelling at the archive', () => {
    expect(indicatorCount(sceneWithTrip({ carryCount: 1, highlight: true }))).toBe(2);
  });

  it('shows the ×N batch badge only once carryCount is greater than 1', () => {
    const textsOf = (scene: Container): string[] =>
      (workerGroups(scene)[0] as Container).children.filter((c): c is Text => c instanceof Text).map((t) => t.text);

    expect(textsOf(sceneWithTrip({ carryCount: 1, highlight: false })).some((t) => t.includes('×'))).toBe(false);
    expect(textsOf(sceneWithTrip({ carryCount: 5, highlight: false }))).toContain('×5');
  });

  /**
   * Regression, in its v2 form: the whole worker group now sits at the character's animated
   * position, so the document travels with the person by construction — and the desk it left
   * behind cannot follow, because the desk is painted into the background.
   */
  it('carries the document with the character, wherever the trip has walked it', () => {
    const scene = renderOfficeScene(
      floorOf([worker({ x: 1010, y: 455, archiveTrip: { carryCount: 1, highlight: true } })]),
    );

    const group = workerGroups(scene)[0] as Container;
    expect({ x: group.x, y: group.y }).toEqual({ x: 1010, y: 455 });
  });
});

// The procedural figure (`character-pose.ts`) is what every Node test draws: loading real sprite
// textures needs a browser. These pin the wiring from view model to drawn character end to end.
describe('character — role, project colour and idle dimming', () => {
  function characterGroup(scene: Container): Container {
    return (workerGroups(scene)[0] as Container).children[0] as Container;
  }

  it('draws one more graphic for an orchestrator than for a subagent', () => {
    const subagent = renderOfficeScene(floorOf([worker({ agentProfile: { role: 'subagent' } })]));
    const orchestrator = renderOfficeScene(floorOf([worker({ agentProfile: { role: 'orchestrator' } })]));

    const count = (scene: Container): number => characterGroup(scene).children.filter((c) => c instanceof Graphics).length;
    expect(count(orchestrator)).toBe(count(subagent) + 1);
  });

  // Adversarial twin: no agentProfile at all must render like a subagent, not an orchestrator.
  it('renders a worker with no agentProfile the same as an explicit subagent', () => {
    const noProfile = renderOfficeScene(floorOf([worker()]));
    const explicitSubagent = renderOfficeScene(floorOf([worker({ agentProfile: { role: 'subagent' } })]));

    const count = (scene: Container): number => characterGroup(scene).children.filter((c) => c instanceof Graphics).length;
    expect(count(noProfile)).toBe(count(explicitSubagent));
  });

  // No cape for a subagent, so the torso is the THIRD shape drawn (after both legs), matching
  // buildCharacterPose's own draw order.
  function torsoColor(scene: Container): number {
    return (characterGroup(scene).children[2] as Graphics).fillStyle.color;
  }

  it("paints the character's torso with the project's resolved colour", () => {
    const scene = renderOfficeScene(
      floorOf([worker({ agentProfile: { role: 'subagent' }, projectPath: '/Users/andresalvarez/Documents/pixel-agents' })]),
    );

    // 0x4fd1c5 is resolveProjectCharacterColor('/Users/andresalvarez/Documents/pixel-agents').
    expect(torsoColor(scene)).toBe(0x4fd1c5);
  });

  it('reflects a different project with a different torso colour', () => {
    const a = renderOfficeScene(floorOf([worker({ agentProfile: { role: 'subagent' }, projectPath: '/a/pixel-agents' })]));
    const b = renderOfficeScene(floorOf([worker({ agentProfile: { role: 'subagent' }, projectPath: '/a/other-project' })]));

    expect(torsoColor(a)).not.toBe(torsoColor(b));
  });

  it('paints the fixed neutral colour when the worker has no projectPath', () => {
    const scene = renderOfficeScene(floorOf([worker({ agentProfile: { role: 'subagent' } })]));

    // 0x6b7280 is resolveProjectCharacterColor(undefined) — the fixed neutral.
    expect(torsoColor(scene)).toBe(0x6b7280);
  });

  /** design.md "Session discovery and aging out": idle means "worker dims, stays on stage". */
  it('dims a worker whose session has gone quiet', () => {
    const working = renderOfficeScene(floorOf([worker({ activity: 'working' })]));
    const idle = renderOfficeScene(floorOf([worker({ activity: 'idle' })]));

    expect(characterGroup(working).alpha).toBe(1);
    expect(characterGroup(idle).alpha).toBeLessThan(1);
  });
});

// Blocker B.2: "a per-archive counter increments".
describe('archive counter', () => {
  function counterText(scene: Container): string | undefined {
    const counter = scene.children[scene.children.length - 1] as Container;
    return counter.children.find((c): c is Text => c instanceof Text)?.text;
  }

  it('renders the current archiveCount as text', () => {
    expect(counterText(renderOfficeScene(floorOf([], 3)))).toContain('3');
  });

  // Adversarial twin: a different count must produce different text, proving the value is read
  // from `floor.archiveCount` and not hardcoded.
  it('reflects a different archiveCount with different text', () => {
    const text = counterText(renderOfficeScene(floorOf([], 7)));
    expect(text).toContain('7');
    expect(text).not.toContain('3');
  });
});

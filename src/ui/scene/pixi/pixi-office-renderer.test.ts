import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { fitToViewport, resolveHoverTooltip, shouldEmitHoverChange, updateStage, type StageLike } from './pixi-office-renderer';
import type { OfficeViewModel } from '../../state/office-view-model';
import type { OfficeFloorView } from '../../components/organisms/office-floor';
import { buildAgentTooltip } from '../../components/atoms/agent-tooltip';
import { renderOfficeBackground } from './office-scene-renderer';

// browser-entrypoint work unit: `updateStage` is the testable core of `PixiOfficeRenderer` — the
// part that decides WHAT the stage should contain on every update. Mounting a real `Application`
// to a real `<canvas>` (`PixiOfficeRenderer.mount`) needs a browser and stays outside Vitest's
// `node` environment reach; this function is exercised instead with a fake `StageLike`, proving
// the real logic — clearing the previous frame and adding a freshly rendered one — without a
// canvas. `renderOfficeScene` itself (already unit-tested in office-scene-renderer.test.ts) is
// real pixi.js production code here, unmocked.
class RecordingStage implements StageLike {
  removedCalls = 0;
  addedChildren: Container[] = [];

  removeChildren(): unknown[] {
    this.removedCalls++;
    return [];
  }

  addChild(child: Container): void {
    this.addedChildren.push(child);
  }
}

describe('updateStage (tasks.md 10.3 extension) — the testable core of PixiOfficeRenderer', () => {
  // `renderOfficeScene` always appends one archive-counter child (blocker B.2, tasks.md 21.2), so
  // an "empty" frame still has exactly that one child, not zero.
  // "an empty frame" now has 2 children: the office background (floor/wall/archive cabinet) plus
  // the archive counter — renderOfficeScene always draws both regardless of workers.
  it('adds one Container to an empty stage for an empty view model', () => {
    const stage = new RecordingStage();
    const viewModel: OfficeViewModel = { workers: [], overflowCount: 0 };

    updateStage(stage, viewModel);

    expect(stage.removedCalls).toBe(1);
    expect(stage.addedChildren).toHaveLength(1);
    expect(stage.addedChildren[0]).toBeInstanceOf(Container);
    expect(stage.addedChildren[0]!.children).toHaveLength(2);
  });

  it('forwards a caller-provided background so repeated frames reuse one instance', () => {
    const background = renderOfficeBackground();
    const stage = new RecordingStage();
    const viewModel: OfficeViewModel = { workers: [], overflowCount: 0 };

    updateStage(stage, viewModel, { background });
    updateStage(stage, viewModel, { background });

    // The newest frame owns it; PixiJS reparented it out of the previous frame's scene (a
    // Container has exactly one parent), which is precisely what the per-frame teardown wants.
    expect(stage.addedChildren[1]!.children[0]).toBe(background);
    expect(stage.addedChildren[0]!.children).not.toContain(background);
  });

  // Adversarial twin: omitting it must still produce a working background, per frame.
  it('still builds its own background when the caller provides none', () => {
    const stage = new RecordingStage();
    const viewModel: OfficeViewModel = { workers: [], overflowCount: 0 };

    updateStage(stage, viewModel);
    updateStage(stage, viewModel);

    const [first, second] = stage.addedChildren;
    expect(first!.children[0]).toBeInstanceOf(Container);
    expect(second!.children[0]).not.toBe(first!.children[0]);
  });

  it('renders one desk group per worker in the view model, plus the background and archive counter', () => {
    const stage = new RecordingStage();
    const viewModel: OfficeViewModel = {
      workers: [{ sessionKey: 'claude-code:s1', harness: 'claude-code', label: 'my-session', x: 760, y: 540, lane: 'root' }],
      overflowCount: 0,
    };

    updateStage(stage, viewModel);

    expect(stage.addedChildren[0]!.children).toHaveLength(3);
  });

  it('clears the PREVIOUS frame before adding the new one, on every call', () => {
    const stage = new RecordingStage();
    const first: OfficeViewModel = {
      workers: [{ sessionKey: 'claude-code:s1', harness: 'claude-code', label: 'one', x: 100, y: 100, lane: 'root' }],
      overflowCount: 0,
    };
    const second: OfficeViewModel = { workers: [], overflowCount: 0 };

    updateStage(stage, first);
    updateStage(stage, second);

    expect(stage.removedCalls).toBe(2);
    expect(stage.addedChildren).toHaveLength(2); // one per call — the stage itself owns removal
    expect(stage.addedChildren[1]!.children).toHaveLength(2); // the SECOND frame: background + counter
  });

  // Wiring check: `updateStage` must accept and forward `viewModel.now` (character animation
  // frames key off it, `ui/scene/character/animation-clock.ts`) without it breaking the rest of
  // the frame. The actual frame-selection DECISION is unit-tested directly, on a fake clock, in
  // `animation-clock.test.ts` — this only proves the value reaches that far without crashing.
  it("accepts the view model's `now` and still renders the full frame", () => {
    const stage = new RecordingStage();
    const viewModel: OfficeViewModel = {
      workers: [{ sessionKey: 'claude-code:s1', harness: 'claude-code', label: 'one', x: 100, y: 100, lane: 'root', activity: 'working' }],
      overflowCount: 0,
      now: 220,
    };

    updateStage(stage, viewModel);

    expect(stage.addedChildren[0]!.children).toHaveLength(3);
  });
});

// browser-entrypoint work unit, follow-up: the layout math (`office-layout.ts`) emits scene units
// in a FIXED 1920x1080 floor plan, but a real browser viewport is almost never exactly that. Before
// this, `PixiOfficeRenderer.mount` passed `resizeTo: container` and never reconciled the two, so
// the floor was drawn 1:1 in CSS pixels: on a smaller window the desks landed off-centre and most
// of the floor was clipped (observed in Chrome against a live SSE stream). `fitToViewport` is the
// pure "contain-fit" math that reconciles them, so the part that decides WHERE the floor sits is
// tested even though mounting a real canvas is not.
describe('fitToViewport — fits the fixed 1920x1080 floor plan into a real viewport', () => {
  it('scales 1:1 and centres nothing when the viewport already matches the floor plan', () => {
    expect(fitToViewport(1920, 1080)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('scales down to fit and letterboxes when the viewport is NARROWER than the floor plan', () => {
    // 1000x1080: width is the binding constraint (1000/1920 < 1080/1080), so the slack is vertical.
    const fit = fitToViewport(1000, 1080);

    expect(fit.scale).toBeCloseTo(1000 / 1920);
    expect(fit.x).toBeCloseTo(0); // width binds, so no horizontal slack (bar float rounding)
    expect(fit.y).toBeCloseTo((1080 - 1080 * (1000 / 1920)) / 2);
  });

  it('letterboxes when the viewport is TALLER than the floor plan aspect ratio', () => {
    // 1920x2160: width binds at 1, so the scaled floor is 1920x1080 inside 2160 of height.
    const fit = fitToViewport(1920, 2160);

    expect(fit.scale).toBe(1);
    expect(fit.x).toBe(0);
    expect(fit.y).toBe((2160 - 1080) / 2);
  });

  it('never returns a non-positive scale for a degenerate (zero-sized) viewport', () => {
    expect(fitToViewport(0, 0).scale).toBeGreaterThan(0);
  });
});

// Hover tooltip wiring: PixiJS interactivity is destroyed by `updateStage`'s full scene-graph
// rebuild every frame (file header above), so hover is driven by `pointermove`/`pointerleave`
// DOM listeners on the canvas (untestable-in-vitest, attached inside `mount`) that call these
// pure decision helpers — mirroring the `updateStage`/`mount` split for the same reason.
describe('shouldEmitHoverChange — decides whether a pointermove should fire onHoverChange', () => {
  it('emits when the hovered session changes from null to a worker', () => {
    expect(shouldEmitHoverChange(null, 'claude-code:s1')).toBe(true);
  });

  it('emits when the hovered session changes from one worker to another', () => {
    expect(shouldEmitHoverChange('claude-code:s1', 'claude-code:s2')).toBe(true);
  });

  it('emits when the hovered session changes from a worker back to null', () => {
    expect(shouldEmitHoverChange('claude-code:s1', null)).toBe(true);
  });

  // The pointer following behaviour: even with the SAME worker hovered, a pointermove event
  // means the pointer moved, so the tooltip must keep following the cursor.
  it('emits when the same worker stays hovered (so the tooltip follows the cursor)', () => {
    expect(shouldEmitHoverChange('claude-code:s1', 'claude-code:s1')).toBe(true);
  });

  // The whole point of this gate: do not fire on every identical frame while hovering nothing.
  it('does NOT emit when nothing was hovered before and nothing is hovered now', () => {
    expect(shouldEmitHoverChange(null, null)).toBe(false);
  });
});

describe('resolveHoverTooltip — looks up the hovered worker\'s tooltip from the last rendered floor', () => {
  const tooltip = buildAgentTooltip({ harnessName: 'Claude Code' });
  const floor: OfficeFloorView = {
    desks: [{ sessionKey: 'claude-code:s1', x: 760, y: 540, width: 160, height: 40 }],
    workers: [
      {
        sessionKey: 'claude-code:s1',
        x: 760,
        y: 540,
        lane: 'root',
        badge: { text: 'Claude', name: 'Claude Code', color: '#d97757' },
        caption: 'my-session',
        tooltip,
      },
    ],
    overflowCount: 0,
    archiveCount: 0,
  };

  it('returns null when no session is hovered', () => {
    expect(resolveHoverTooltip(floor, null)).toBeNull();
  });

  it("returns the hovered worker's own tooltip view", () => {
    expect(resolveHoverTooltip(floor, 'claude-code:s1')).toEqual(tooltip);
  });

  it('returns null for a sessionKey not present in the floor view (e.g. it left mid-frame)', () => {
    expect(resolveHoverTooltip(floor, 'claude-code:missing')).toBeNull();
  });
});

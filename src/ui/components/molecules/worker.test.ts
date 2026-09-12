import { describe, expect, it } from 'vitest';
import { buildWorkerView } from './worker';
import type { WorkerViewModel } from '../../state/office-view-model';

function workerViewModel(overrides: Partial<WorkerViewModel> = {}): WorkerViewModel {
  return {
    sessionKey: 'claude-code:s1',
    harness: 'claude-code',
    label: 'my-session',
    x: 960,
    y: 540,
    lane: 'root',
    ...overrides,
  };
}

describe('buildWorkerView (molecule) — combines badge + caption + position into one drawable descriptor', () => {
  it('combines the harness badge, caption text, and desk position for a root worker', () => {
    const view = buildWorkerView(workerViewModel());

    expect(view.sessionKey).toBe('claude-code:s1');
    expect(view.x).toBe(960);
    expect(view.y).toBe(540);
    expect(view.badge).toEqual({ text: 'Claude', name: 'Claude Code', color: '#d97757' });
    expect(view.caption).toBe('my-session');
    expect(view.lane).toBe('root');
  });

  it('falls back to the empty-label placeholder caption when the label is blank', () => {
    const view = buildWorkerView(workerViewModel({ label: '' }));

    expect(view.caption).toBe('(unnamed worker)');
  });

  // Task 21.5: renders the normalized toolLabel/toolDetail caption when present, in preference
  // to the plain label — same assertion regardless of `harness`, proving this molecule does not
  // branch on it either.
  it.each(['claude-code', 'codex', 'opencode', 'antigravity'] as const)(
    'renders the normalized tool caption over the plain label for harness=%s',
    (harness) => {
      const view = buildWorkerView(
        workerViewModel({ harness, label: 'my-session', toolLabel: 'Read', toolDetail: 'design.md' }),
      );

      expect(view.caption).toBe('Read: design.md');
    },
  );

  // Agent profile tracking: renders the profile caption when no live tool caption is active —
  // "at minimum the agent type and model on/near the worker, and the task as the caption detail".
  it('renders the agent profile caption when no tool caption is active', () => {
    const view = buildWorkerView(workerViewModel({ agentProfile: { role: 'subagent', agentType: 'sdd-apply' } }));
    expect(view.caption).toBe('sdd-apply');
  });

  // The live tool caption still wins over the profile — proves this molecule keeps buildCaption's
  // own priority order rather than reimplementing it.
  it('prefers the live tool caption over the agent profile when both are present', () => {
    const view = buildWorkerView(
      workerViewModel({ toolLabel: 'Read', toolDetail: 'design.md', agentProfile: { role: 'subagent', agentType: 'sdd-apply' } }),
    );
    expect(view.caption).toBe('Read: design.md');
  });

  // Blocker B.2 (tasks.md 21.2): carries the archive-trip drawing data through unchanged, so
  // `ui/scene/pixi/` can draw a carried-document indicator.
  it('carries archiveTrip (carryCount, highlight) through when the worker has one', () => {
    const view = buildWorkerView(workerViewModel({ archiveTrip: { path: [], carryCount: 3, highlight: true } }));

    expect(view.archiveTrip).toEqual({ carryCount: 3, highlight: true });
  });

  it('defaults highlight to false when the view model omits it', () => {
    const view = buildWorkerView(workerViewModel({ archiveTrip: { path: [], carryCount: 1 } }));

    expect(view.archiveTrip).toEqual({ carryCount: 1, highlight: false });
  });

  // Adversarial twin: a worker with no archiveTrip must not gain one out of nowhere.
  it('has no archiveTrip when the worker has none', () => {
    const view = buildWorkerView(workerViewModel());

    expect(view.archiveTrip).toBeUndefined();
  });

  // Character rendering (ui/scene/pixi/office-scene-renderer.ts) needs the raw activity and
  // agentProfile alongside the badge/caption already built here, to pick the drawn animation
  // state and the orchestrator/subagent/model accent.
  it('carries activity through when present', () => {
    const view = buildWorkerView(workerViewModel({ activity: 'working' }));

    expect(view.activity).toBe('working');
  });

  it('carries agentProfile through when present', () => {
    const view = buildWorkerView(workerViewModel({ agentProfile: { role: 'orchestrator' } }));

    expect(view.agentProfile).toEqual({ role: 'orchestrator' });
  });

  // Adversarial twin: a worker with neither must not gain either out of nowhere.
  it('has no activity or agentProfile when the worker has neither', () => {
    const view = buildWorkerView(workerViewModel());

    expect(view.activity).toBeUndefined();
    expect(view.agentProfile).toBeUndefined();
  });

  // Project colour (ui/scene/character/project-accent.ts) needs the associated project's working
  // directory to resolve a colour — carried through onto WorkerView, not just into the tooltip.
  it('carries projectPath through onto the view for the pixi renderer to resolve a colour from', () => {
    const view = buildWorkerView(workerViewModel({ projectPath: '/Users/andresalvarez/Documents/pixel-agents' }));

    expect(view.projectPath).toBe('/Users/andresalvarez/Documents/pixel-agents');
  });

  // Adversarial twin: a worker with no projectPath must not gain one out of nowhere.
  it('has no projectPath when the worker has none', () => {
    const view = buildWorkerView(workerViewModel());

    expect(view.projectPath).toBeUndefined();
  });

  // Movement animations: the render half resolves which way a walking worker is heading
  // (`applyTripOverlay`) — this molecule must carry it through unchanged, like highlight.
  it('carries archiveTrip.direction through when the render half has resolved it', () => {
    const view = buildWorkerView(workerViewModel({ archiveTrip: { path: [], carryCount: 1, highlight: false, direction: 'left' } }));

    expect(view.archiveTrip?.direction).toBe('left');
  });

  // Adversarial twin: a structural-only view model (no render-half overlay yet) must not gain a
  // direction out of nowhere — proves this is carried through, not defaulted here.
  it('has no archiveTrip.direction when the render half has not resolved one yet', () => {
    const view = buildWorkerView(workerViewModel({ archiveTrip: { path: [], carryCount: 1 } }));

    expect(view.archiveTrip).toEqual({ carryCount: 1, highlight: false });
    expect(view.archiveTrip?.direction).toBeUndefined();
  });

  // Hover tooltip: the DOM overlay (ui/scene/layout/hover-hit-test.ts + agent-tooltip.ts) needs
  // more than the pre-truncated `caption` — this molecule is where harness, label, tool pair, and
  // agentProfile are all available at once to build the untruncated four-row tooltip content.
  describe('tooltip', () => {
    it('always builds exactly five rows: Project, Agent, Role, Model, Task', () => {
      const view = buildWorkerView(workerViewModel());

      expect(view.tooltip.rows.map((r) => r.label)).toEqual(['Project', 'Agent', 'Role', 'Model', 'Task']);
    });

    // The associated project (Worker.projectPath -> WorkerViewModel.projectPath) must reach the
    // tooltip through this molecule, rendered as just its final path segment.
    it('reflects the projectPath in the tooltip Project row, as just its final segment', () => {
      const view = buildWorkerView(workerViewModel({ projectPath: '/Users/andresalvarez/Documents/pixel-agents' }));

      expect(view.tooltip.rows.find((r) => r.label === 'Project')?.value).toBe('pixel-agents');
    });

    it('shows "Unknown" for Project when the worker has no projectPath', () => {
      const view = buildWorkerView(workerViewModel());

      expect(view.tooltip.rows.find((r) => r.label === 'Project')?.value).toBe('Unknown');
    });

    it("uses the harness badge's FULL product name for the Agent row, not the short badge text", () => {
      const view = buildWorkerView(workerViewModel({ harness: 'claude-code' }));

      expect(view.tooltip.rows.find((r) => r.label === 'Agent')?.value).toBe('Claude Code');
    });

    it('reflects the agentProfile role/agentType/model/task in the tooltip', () => {
      const view = buildWorkerView(
        workerViewModel({
          agentProfile: { role: 'subagent', agentType: 'sdd-apply', model: 'claude-sonnet-5', task: 'Implement the hover tooltip' },
        }),
      );
      const rows = Object.fromEntries(view.tooltip.rows.map((r) => [r.label, r.value]));

      expect(rows.Role).toBe('Subagent (sdd-apply)');
      expect(rows.Model).toBe('claude-sonnet-5');
      expect(rows.Task).toBe('Implement the hover tooltip');
    });

    it('falls back to the live tool caption for the Task row when no agentProfile task is set', () => {
      const withTool = buildWorkerView(workerViewModel({ toolLabel: 'Read', toolDetail: 'design.md' }));
      expect(withTool.tooltip.rows.find((r) => r.label === 'Task')?.value).toBe('Read: design.md');
    });

    // Defect fix: the Task row used to fall back to the worker's `label`, but `office.ts` resolves
    // `label` to the SESSION KEY when a harness reports none — so this printed a raw
    // `claude-code:<uuid>` as if it were the agent's task. A session identity is not a task.
    it('never shows the session label as the Task when no task and no tool caption exist', () => {
      const withLabelOnly = buildWorkerView(workerViewModel({ label: 'claude-code:b0b92d0a-dd22' }));

      expect(withLabelOnly.tooltip.rows.find((r) => r.label === 'Task')?.value).toBe('No task reported');
    });

    it('shows "Unknown" for Role and Model when the worker has no agentProfile', () => {
      const view = buildWorkerView(workerViewModel());
      const rows = Object.fromEntries(view.tooltip.rows.map((r) => [r.label, r.value]));

      expect(rows.Role).toBe('Unknown');
      expect(rows.Model).toBe('Unknown');
    });

    // Adversarial twin: requestedModel alone must render as an explicit request, never as if it
    // were the resolved running model, all the way through this molecule.
    it('marks a requestedModel-only profile as a request, never as the running model', () => {
      const view = buildWorkerView(workerViewModel({ agentProfile: { role: 'subagent', requestedModel: 'opus' } }));

      expect(view.tooltip.rows.find((r) => r.label === 'Model')?.value).toBe('unknown (requested: opus)');
    });
  });
});

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
    expect(view.badge).toEqual({ text: 'Claude', color: '#d97757' });
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
});

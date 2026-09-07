import { describe, expect, it } from 'vitest';
import { OfficeStage } from './OfficeStage';
import type { OfficeViewModel } from '../state/office-view-model';
import type { OfficeRenderer } from './OfficeStage';

class RecordingRenderer implements OfficeRenderer {
  received: OfficeViewModel[] = [];
  render(viewModel: OfficeViewModel): void {
    this.received.push(viewModel);
  }
}

describe('OfficeStage (tasks.md 10.4) — presentational: receives an OfficeViewModel, renders it, owns no transport', () => {
  it('forwards the exact view model it receives to the injected renderer, unmodified', () => {
    const renderer = new RecordingRenderer();
    const stage = new OfficeStage(renderer);
    const viewModel: OfficeViewModel = {
      workers: [{ sessionKey: 'claude-code:s1', harness: 'claude-code', label: 'l', x: 1, y: 2, lane: 'root' }],
      overflowCount: 0,
    };

    stage.update(viewModel);

    expect(renderer.received).toEqual([viewModel]);
  });

  it('renders every update it receives, in order, without dropping any', () => {
    const renderer = new RecordingRenderer();
    const stage = new OfficeStage(renderer);
    const first: OfficeViewModel = { workers: [], overflowCount: 0 };
    const second: OfficeViewModel = { workers: [], overflowCount: 3 };

    stage.update(first);
    stage.update(second);

    expect(renderer.received).toEqual([first, second]);
  });
});

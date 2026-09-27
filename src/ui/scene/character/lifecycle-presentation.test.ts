import { describe, expect, it } from 'vitest';
import { SESSION_LIFECYCLES, type SessionLifecycle } from '../../../domain/events/types';
import { resolveLifecyclePresentation } from './lifecycle-presentation';

// Requirement: Lifecycle-Distinct Worker Presentation (spec: office-scene-renderer).
describe('resolveLifecyclePresentation', () => {
  it('renders a worker with no reported lifecycle exactly as before lifecycle existed', () => {
    expect(resolveLifecyclePresentation(undefined)).toEqual({ seated: true, indicator: 'none', canWork: true });
  });

  it('keeps a queued worker off a desk and not working', () => {
    const presentation = resolveLifecyclePresentation('queued');

    expect(presentation.seated).toBe(false);
    expect(presentation.canWork).toBe(false);
  });

  it('seats a blocked worker but flags it, and never lets it look busy', () => {
    expect(resolveLifecyclePresentation('waiting')).toEqual({ seated: true, indicator: 'blocked', canWork: false });
  });

  it('flags a failure and a timeout, which are the two ways work ends badly', () => {
    expect(resolveLifecyclePresentation('failed').indicator).toBe('failed');
    expect(resolveLifecyclePresentation('timed_out').indicator).toBe('failed');
  });

  it('ends a cancelled worker without a failure flag (triangulation: a quiet ending)', () => {
    expect(resolveLifecyclePresentation('cancelled').indicator).toBe('none');
    expect(resolveLifecyclePresentation('completed').indicator).toBe('none');
  });

  it('lets a running worker work, like a worker with no lifecycle at all', () => {
    expect(resolveLifecyclePresentation('running')).toEqual(resolveLifecyclePresentation(undefined));
  });

  /**
   * Totality, not a spot check: the union is closed at compile time, so every member must already
   * have a decision. A new eighth member would fail to compile in the resolver's own switch, and
   * this test proves none is silently answered by a fallback.
   */
  it('decides every member of the closed lifecycle set', () => {
    for (const lifecycle of SESSION_LIFECYCLES satisfies readonly SessionLifecycle[]) {
      const presentation = resolveLifecyclePresentation(lifecycle);
      expect(typeof presentation.seated).toBe('boolean');
      expect(['none', 'blocked', 'failed']).toContain(presentation.indicator);
    }
  });
});

/**
 * `launchAgentSession` (tasks.md 26.1, design.md module structure: `application/launch-agent-session/`).
 * Deliberately thin: the port's own `SessionLauncher.launch(spec)` already returns the complete
 * `LaunchResult` and owns all self-originated event emission (design.md "The Launcher" — the
 * launcher's OWN process state must be the source of `launch_requested`/`launch_started`, which
 * only the adapter that actually resolves the binary and spawns can know at the right moment).
 * This use case exists purely so the driving HTTP adapter depends on `application/` -> `ports/`,
 * never directly on a concrete adapter (the hexagonal dependency rule enforced elsewhere by
 * `.dependency-cruiser.cjs`).
 */
import { describe, expect, it } from 'vitest';
import { launchAgentSession } from './launch-agent-session';
import type { LaunchResult, LaunchSpec, SessionLauncher } from '../../ports/session-launcher.port';

describe('launchAgentSession', () => {
  it('delegates to the injected SessionLauncher and returns its result unchanged', async () => {
    const expected: LaunchResult = { outcome: 'started', launchId: 'x', pid: 1, startedAt: 0 };
    let receivedSpec: LaunchSpec | null = null;
    const launcher: SessionLauncher = {
      launch: async (spec) => {
        receivedSpec = spec;
        return expected;
      },
      shutdown: async () => {},
    };
    const spec: LaunchSpec = { harness: 'claude-code', cwd: '/tmp', args: [] };

    const result = await launchAgentSession(launcher, spec);

    expect(result).toBe(expected);
    expect(receivedSpec).toBe(spec);
  });
});

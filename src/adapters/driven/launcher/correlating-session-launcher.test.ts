/**
 * `CorrelatingSessionLauncher` wires a real launch's `t0`/spawn-time/`cwd` into the launch
 * correlator (design.md "Launch <-> log correlation": "Record t0 = now() ... before spawn ...
 * pid and t1"). It is a thin decorator around any `SessionLauncher` — never a subclass of
 * `ChildProcessSessionLauncher` — so the launcher's spawn mechanism and its correlation wiring
 * stay two independently testable concerns (tasks.md 26.4's existing invariant: touching one
 * never requires touching the other).
 *
 * A claim is requested ONLY for a launch that actually started a process: `failed` and
 * `unavailable_interactive` outcomes never produce a session to correlate against, so opening a
 * claim window for them would only leak a claim that can never bind.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchResult, LaunchSpec, SessionLauncher } from '../../../ports/session-launcher.port';
import { CorrelatingSessionLauncher, type LaunchClaimRequester } from './correlating-session-launcher';

function fakeInner(result: LaunchResult): { launcher: SessionLauncher; shutdownCalls: number } {
  const state = { shutdownCalls: 0 };
  const launcher: SessionLauncher = {
    async launch() {
      return result;
    },
    async shutdown() {
      state.shutdownCalls += 1;
    },
  };
  return { launcher, shutdownCalls: state.shutdownCalls };
}

function fakeRequester(): { requester: LaunchClaimRequester; calls: Array<{ launchId: string; harness: string; cwd: string; t0: number; t1: number }> } {
  const calls: Array<{ launchId: string; harness: string; cwd: string; t0: number; t1: number }> = [];
  return {
    requester: {
      requestClaim: (launchId, harness, cwd, t0, t1) => {
        calls.push({ launchId, harness, cwd, t0, t1 });
      },
    },
    calls,
  };
}

const SPEC: LaunchSpec = { harness: 'claude-code', cwd: '/Users/dev/my-project', args: [] };

describe('CorrelatingSessionLauncher', () => {
  it('a started launch requests a claim window scoped to (harness, cwd) spanning t0..spawn time', async () => {
    const { launcher } = fakeInner({ outcome: 'started', launchId: 'launch-1', pid: 42, startedAt: 5_000 });
    const { requester, calls } = fakeRequester();
    const correlating = new CorrelatingSessionLauncher(launcher, requester, { now: () => 4_990 });

    const result = await correlating.launch(SPEC);

    expect(result).toEqual({ outcome: 'started', launchId: 'launch-1', pid: 42, startedAt: 5_000 });
    expect(calls).toEqual([{ launchId: 'launch-1', harness: 'claude-code', cwd: '/Users/dev/my-project', t0: 4_990, t1: 5_000 }]);
  });

  it('adversarial near-miss: a FAILED launch (binary not found) never requests a claim — nothing was spawned to correlate against', async () => {
    const { launcher } = fakeInner({ outcome: 'failed', launchId: 'launch-2', reason: 'binary not found on PATH: claude' });
    const { requester, calls } = fakeRequester();
    const correlating = new CorrelatingSessionLauncher(launcher, requester, { now: () => 4_990 });

    const result = await correlating.launch(SPEC);

    expect(result.outcome).toBe('failed');
    expect(calls).toEqual([]);
  });

  it('adversarial near-miss: an unavailable_interactive outcome never requests a claim either', async () => {
    const { launcher } = fakeInner({ outcome: 'unavailable_interactive', launchId: 'launch-3', commandLine: '(cd /x && claude)', reason: 'no PTY backend' });
    const { requester, calls } = fakeRequester();
    const correlating = new CorrelatingSessionLauncher(launcher, requester, { now: () => 4_990 });

    await correlating.launch(SPEC);

    expect(calls).toEqual([]);
  });

  it('shutdown() delegates to the wrapped launcher', async () => {
    let shutdownCalled = false;
    const launcher: SessionLauncher = {
      async launch() {
        return { outcome: 'failed', launchId: 'x', reason: 'n/a' };
      },
      async shutdown() {
        shutdownCalled = true;
      },
    };
    const { requester } = fakeRequester();
    const correlating = new CorrelatingSessionLauncher(launcher, requester, { now: () => 0 });

    await correlating.shutdown();

    expect(shutdownCalled).toBe(true);
  });
});

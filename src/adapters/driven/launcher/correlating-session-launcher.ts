/**
 * Wires a launch's `t0`/spawn-time/`cwd` into the launch correlator's claim window (design.md
 * "Launch <-> log correlation": "Record t0 = now() ... before spawn ... pid and t1"), as a thin
 * decorator around any `SessionLauncher` — this deliberately does NOT subclass
 * `ChildProcessSessionLauncher`, keeping the spawn mechanism and the correlation wiring two
 * independently testable concerns (tasks.md 26.4's existing invariant).
 *
 * `LaunchClaimRequester` is the minimal slice of `LaunchCorrelationCoordinator` this class needs
 * — declared locally so this file can be unit-tested without constructing a real coordinator, and
 * so this decorator has no dependency on the coordinator's own publishing/expiry concerns.
 *
 * A claim is requested ONLY for `outcome: 'started'`: `failed` and `unavailable_interactive` never
 * produce a session to correlate against, so opening a claim window for them would only leak a
 * claim that can never bind and would eventually time out for nothing.
 */
import type { HarnessId } from '../../../domain/events/types';
import type { Clock } from '../../../ports/clock.port';
import type { LaunchResult, LaunchSpec, SessionLauncher } from '../../../ports/session-launcher.port';

export interface LaunchClaimRequester {
  requestClaim(launchId: string, harness: HarnessId, cwd: string, t0: number, t1: number): void;
}

export class CorrelatingSessionLauncher implements SessionLauncher {
  constructor(
    private readonly inner: SessionLauncher,
    private readonly requester: LaunchClaimRequester,
    private readonly clock: Clock,
  ) {}

  async launch(spec: LaunchSpec): Promise<LaunchResult> {
    const t0 = this.clock.now();
    const result = await this.inner.launch(spec);
    if (result.outcome === 'started') {
      this.requester.requestClaim(result.launchId, spec.harness, spec.cwd, t0, result.startedAt);
    }
    return result;
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }
}

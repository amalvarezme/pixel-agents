/**
 * Wires the pure `launch-correlator.ts` state machine into the launcher subsystem's live event
 * bus (tasks.md Phase 25 follow-up: "the module is NOT yet wired into the four adapters' real
 * discover() output" — the recorded blocker this class closes).
 *
 * Stateful, but every timing decision still flows through an injected `Clock` (never
 * `Date.now()` directly), matching this codebase's domain/pure-function convention even though
 * this class itself lives in the adapters layer.
 *
 * Publishes a `status` event for every `CorrelationOutcome`:
 *   - `bound`     -> `reason: 'launch_bound'`, `sessionKey` = the bound session's own key, so the
 *                    scene can attribute that session to its launch.
 *   - `ambiguous` / `timed_out` -> `reason: 'launch_correlation_ambiguous' |
 *     'launch_correlation_timeout'`, `sessionKey: launch:<launchId>` (same convention
 *     `ChildProcessSessionLauncher` already uses for its own failure status events) — there is no
 *     bound session to attribute.
 *
 * A failed bind (ambiguous or timed out) NEVER throws and touches nothing beyond publishing its
 * own status event: this coordinator has no reference to any ingestion adapter or checkpoint
 * store, so it cannot disturb ingestion even in principle (design.md "A failed bind degrades
 * attribution only. It never affects ingestion.").
 */
import type { HarnessId } from '../../../domain/events/types';
import type { Clock } from '../../../ports/clock.port';
import type { EventPublisher } from '../../../ports/event-publisher.port';
import {
  createLaunchCorrelatorState,
  expireTimedOutClaims,
  offerCandidate,
  requestClaim,
  type CandidateSession,
  type CorrelationOutcome,
  type LaunchCorrelatorState,
} from './launch-correlator';

export interface LaunchCorrelationCoordinatorOptions {
  publisher: EventPublisher;
  clock: Clock;
  /** Injectable monotonic id allocator. Defaults to an in-process counter starting at 1. */
  allocateId?: () => number;
}

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

export class LaunchCorrelationCoordinator {
  private readonly publisher: EventPublisher;
  private readonly clock: Clock;
  private readonly allocateId: () => number;
  private state: LaunchCorrelatorState = createLaunchCorrelatorState();

  constructor(options: LaunchCorrelationCoordinatorOptions) {
    this.publisher = options.publisher;
    this.clock = options.clock;
    this.allocateId = options.allocateId ?? defaultAllocateId();
  }

  /** Opens (or queues, per the serialization guard) a claim window for a just-spawned launch. */
  requestClaim(launchId: string, harness: HarnessId, cwd: string, t0: number, t1: number): void {
    this.state = requestClaim(this.state, launchId, harness, cwd, t0, t1).state;
  }

  /** Offers one newly discovered session to every open claim. */
  offerCandidate(candidate: CandidateSession): void {
    const result = offerCandidate(this.state, candidate);
    this.state = result.state;
    this.publishOutcomes(result.outcomes);
  }

  /** Expires any claim whose window has fully closed with no bind, using the injected clock. */
  expireTimedOutClaims(): void {
    const result = expireTimedOutClaims(this.state, this.clock.now());
    this.state = result.state;
    this.publishOutcomes(result.outcomes);
  }

  private publishOutcomes(outcomes: CorrelationOutcome[]): void {
    for (const outcome of outcomes) {
      const claim = this.state.claims.find((c) => c.launchId === outcome.launchId);
      if (!claim) continue; // defensive: every outcome names a launchId this coordinator just processed
      this.publisher.publish({
        id: this.allocateId(),
        kind: 'status',
        harness: claim.harness,
        sessionKey: outcome.kind === 'bound' ? outcome.sessionKey : `launch:${outcome.launchId}`,
        at: this.clock.now(),
        launchId: outcome.launchId,
        reason: reasonFor(outcome),
      });
    }
  }
}

/** design.md "Launch <-> log correlation": the exact three reason strings the spec names. */
function reasonFor(outcome: CorrelationOutcome): string {
  switch (outcome.kind) {
    case 'bound':
      return 'launch_bound';
    case 'ambiguous':
      return 'launch_correlation_ambiguous';
    case 'timed_out':
      return 'launch_correlation_timeout';
  }
}

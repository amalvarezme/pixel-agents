/**
 * Wires the pure `correlate.ts`/`agent-tree.ts` functions into the live event bus (matching how
 * `adapters/driven/launcher/launch-correlation-coordinator.ts` wires `launch-correlator.ts`).
 * Both correlation edges land here:
 *
 * 1. `offerSession` — the `<parent-session-id>/subagents/` directory-name edge, fed once per
 *    discovered session (composition root: `onSessionDiscovered`).
 * 2. `offerParentRecord` — the `toolUseResult.agentId` edge (spec: harness-log-ingestion "the
 *    system MUST correlate parent and child sessions using toolUseResult.agentId"), fed once per
 *    parsed record from a PARENT (non-subagent) session's own transcript.
 *
 * Either edge may resolve first; `agent-tree.ts`'s pending-claim mechanism already handles
 * out-of-order arrival, so this class only needs to flush any newly-resolved link after each
 * offer and publish exactly one `parent` event per child, ever — `emitted` guards against a
 * child whose parent is already known being re-published on a later, redundant offer.
 */
import { createAgentTree, type AgentTree } from '../../../domain/agents/agent-tree';
import type { AgentEvent } from '../../../domain/events/types';
import type { Clock } from '../../../ports/clock.port';
import type { EventPublisher } from '../../../ports/event-publisher.port';
import {
  correlateClaudeCodeSession,
  correlateFromParentRecord,
  resolveAgentLaunchFromRecord,
  trackAgentLaunches,
} from './correlate';
import type { ClaudeCodeSessionRef } from './discover';
import type { AgentLaunchClaim, ClaudeCodeRecord } from './parse';

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

export class ClaudeCodeSubagentCorrelationCoordinator {
  private readonly tree: AgentTree = createAgentTree();
  private readonly emitted = new Set<string>();
  /** Agent profile tracking: `Agent` tool_use claims staged from this parent's transcript,
   * awaiting their matching tool_result (`correlate.ts`'s `trackAgentLaunches`/
   * `resolveAgentLaunchFromRecord`), keyed by tool_use id. */
  private readonly pendingLaunches = new Map<string, AgentLaunchClaim>();
  /** Guards profile publication independently of `emitted` (the correlation-edge guard): the
   * real live-stream ordering resolves the directory-name edge, and thus `emitted`, LONG before a
   * launch's tool_result ever arrives — a profile must still get its own publish afterward. */
  private readonly emittedProfileFor = new Set<string>();
  private readonly allocateId: () => number;

  constructor(
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    allocateId?: () => number,
  ) {
    this.allocateId = allocateId ?? defaultAllocateId();
  }

  /** Applies the directory-name edge for one discovered session (tasks.md 7.5, edge 1). */
  offerSession(ref: ClaudeCodeSessionRef): void {
    correlateClaudeCodeSession(this.tree, ref, this.clock.now());
    this.flushResolvedLinks();
  }

  /**
   * Applies the `toolUseResult.agentId` edge from one parsed parent-transcript record (edge 2),
   * alongside (never instead of) agent profile tracking: this record may ALSO stage a new `Agent`
   * launch claim, or resolve an earlier one into a subagent profile, from the SAME parent
   * transcript.
   */
  offerParentRecord(parentSessionKey: string, record: ClaudeCodeRecord): void {
    correlateFromParentRecord(this.tree, parentSessionKey, record, this.clock.now());
    trackAgentLaunches(this.pendingLaunches, record);
    const resolved = resolveAgentLaunchFromRecord(this.pendingLaunches, record);
    this.flushResolvedLinks();
    if (resolved) this.publishProfile(resolved.childSessionKey, resolved.claim);
  }

  /**
   * Agent profile tracking, historical path (fix: "profiles under DEFAULT settings"): applies
   * profiles recovered by a one-time discovery-time scan of a parent's already-written history
   * (`agent-profile-scan.ts`) — the join for a launch whose `Agent` tool_use and resolving
   * `tool_result` both sit before the EOF bootstrap offset, so the live `offerParentRecord` path
   * never reads them. Reuses `publishProfile`, so it is idempotent with the live path via the same
   * `emittedProfileFor` guard: whichever path resolves a given child first wins, the other is a
   * no-op.
   */
  offerScannedProfiles(resolved: Array<{ childSessionKey: string; claim: AgentLaunchClaim }>): void {
    for (const { childSessionKey, claim } of resolved) this.publishProfile(childSessionKey, claim);
  }

  private flushResolvedLinks(): void {
    for (const node of this.tree.nodes.values()) {
      if (!node.parentSessionKey || this.emitted.has(node.sessionKey)) continue;
      this.emitted.add(node.sessionKey);
      this.publisher.publish(this.buildParentEvent(node.sessionKey, node.parentSessionKey));
    }
  }

  /**
   * Publishes the resolved subagent profile as its own `parent` event, independently of whether
   * the plain correlation edge for this child was already emitted (see `emittedProfileFor`'s
   * doc). Carries `correlationId` too when the tree already knows this child's parent, so a
   * client that only ever sees this one event still gets both pieces of state.
   */
  private publishProfile(childSessionKey: string, claim: AgentLaunchClaim): void {
    if (this.emittedProfileFor.has(childSessionKey)) return;
    this.emittedProfileFor.add(childSessionKey);
    const correlationId = this.tree.nodes.get(childSessionKey)?.parentSessionKey ?? undefined;
    this.publisher.publish({
      id: this.allocateId(),
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: childSessionKey,
      at: this.clock.now(),
      ...(correlationId ? { correlationId } : {}),
      agentProfile: {
        role: 'subagent',
        ...(claim.agentType ? { agentType: claim.agentType } : {}),
        // The launch's REQUESTED model (an alias, or absent meaning "the default") — never the
        // resolved live model, which the subagent's own transcript reports separately (`model`,
        // set independently via `mapClaudeCodeRecordToEvents`'s own live message.model wiring).
        ...(claim.model ? { requestedModel: claim.model } : {}),
        ...(claim.task ? { task: claim.task } : {}),
      },
    });
  }

  private buildParentEvent(sessionKey: string, correlationId: string): AgentEvent {
    return {
      id: this.allocateId(),
      kind: 'parent',
      harness: 'claude-code',
      sessionKey,
      at: this.clock.now(),
      correlationId,
    };
  }
}

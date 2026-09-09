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
import { correlateClaudeCodeSession, correlateFromParentRecord } from './correlate';
import type { ClaudeCodeSessionRef } from './discover';
import type { ClaudeCodeRecord } from './parse';

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

export class ClaudeCodeSubagentCorrelationCoordinator {
  private readonly tree: AgentTree = createAgentTree();
  private readonly emitted = new Set<string>();
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

  /** Applies the `toolUseResult.agentId` edge from one parsed parent-transcript record (edge 2). */
  offerParentRecord(parentSessionKey: string, record: ClaudeCodeRecord): void {
    correlateFromParentRecord(this.tree, parentSessionKey, record, this.clock.now());
    this.flushResolvedLinks();
  }

  private flushResolvedLinks(): void {
    for (const node of this.tree.nodes.values()) {
      if (!node.parentSessionKey || this.emitted.has(node.sessionKey)) continue;
      this.emitted.add(node.sessionKey);
      this.publisher.publish(this.buildParentEvent(node.sessionKey, node.parentSessionKey));
    }
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

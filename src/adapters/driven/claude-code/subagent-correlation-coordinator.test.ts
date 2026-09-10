import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../domain/events/types';
import type { ClaudeCodeSessionRef } from './discover';
import type { ClaudeCodeRecord } from './parse';
import { ClaudeCodeSubagentCorrelationCoordinator } from './subagent-correlation-coordinator';

function sessionRef(overrides: Partial<ClaudeCodeSessionRef> = {}): ClaudeCodeSessionRef {
  return {
    harness: 'claude-code',
    sessionKey: 'claude-code:parent-1',
    filePath: '/tmp/parent-1.jsonl',
    isSubagent: false,
    parentSessionKey: null,
    cwd: null,
    discoveredAt: 0,
    ...overrides,
  };
}

function subagentRef(overrides: Partial<ClaudeCodeSessionRef> = {}): ClaudeCodeSessionRef {
  return sessionRef({
    sessionKey: 'claude-code:child-1',
    filePath: '/tmp/parent-1/subagents/agent-child-1.jsonl',
    isSubagent: true,
    parentSessionKey: 'claude-code:parent-1',
    ...overrides,
  });
}

function makeCoordinator(): { coordinator: ClaudeCodeSubagentCorrelationCoordinator; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn<(event: AgentEvent) => void>();
  const coordinator = new ClaudeCodeSubagentCorrelationCoordinator(
    { publish },
    { now: () => 1000 },
    (() => {
      let next = 1;
      return () => next++;
    })(),
  );
  return { coordinator, publish };
}

describe('ClaudeCodeSubagentCorrelationCoordinator (directory-name edge)', () => {
  it('publishes a parent event with the correct child/parent sessionKey PAIR once both sides are known', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef());
    coordinator.offerSession(subagentRef());

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.kind).toBe('parent');
    expect(event.sessionKey).toBe('claude-code:child-1');
    expect(event.correlationId).toBe('claude-code:parent-1');
  });

  it('does NOT bind a subagent to the wrong parent when several parents are known', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef({ sessionKey: 'claude-code:other-parent' }));
    coordinator.offerSession(sessionRef());
    coordinator.offerSession(subagentRef());

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.correlationId).toBe('claude-code:parent-1');
    expect(event.correlationId).not.toBe('claude-code:other-parent');
  });

  it('publishes no parent event for a non-subagent (root) session', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef());

    expect(publish).not.toHaveBeenCalled();
  });

  it('resolves and publishes once the parent arrives, even when the subagent was offered first', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(subagentRef());
    expect(publish).not.toHaveBeenCalled();

    coordinator.offerSession(sessionRef());

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.sessionKey).toBe('claude-code:child-1');
    expect(event.correlationId).toBe('claude-code:parent-1');
  });

  it('never publishes twice for the same already-resolved subagent', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef());
    coordinator.offerSession(subagentRef());
    coordinator.offerSession(subagentRef());

    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCodeSubagentCorrelationCoordinator (agentId edge)', () => {
  it('publishes a parent event using toolUseResult.agentId from a parent transcript record', () => {
    const { coordinator, publish } = makeCoordinator();
    const record: ClaudeCodeRecord = { type: 'user', toolUseResult: { agentId: 'agent-xyz' } };

    coordinator.offerSession(sessionRef());
    coordinator.offerParentRecord('claude-code:parent-1', record);

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.sessionKey).toBe('claude-code:agent-xyz');
    expect(event.correlationId).toBe('claude-code:parent-1');
  });

  it('publishes nothing when the record carries no toolUseResult.agentId', () => {
    const { coordinator, publish } = makeCoordinator();
    const record: ClaudeCodeRecord = { type: 'user' };

    coordinator.offerSession(sessionRef());
    coordinator.offerParentRecord('claude-code:parent-1', record);

    expect(publish).not.toHaveBeenCalled();
  });
});

// Agent profile tracking: a launch (Agent tool_use) tracked earlier in the SAME parent transcript,
// resolved once the matching tool_result carries the child's agentId. Uses THREE concurrent
// launches with distinct subagent_type/model/description — a single-launch test could pass even
// if the coordinator always attached the first or last tracked claim.
describe('ClaudeCodeSubagentCorrelationCoordinator (agent profile tracking)', () => {
  function launchRecord(toolUseId: string, input: Record<string, unknown>): ClaudeCodeRecord {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }] },
    };
  }

  function resultRecord(toolUseId: string, agentId: string): ClaudeCodeRecord {
    return {
      type: 'user',
      toolUseResult: { agentId },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
    };
  }

  it('attaches each of three concurrent launches to its OWN correct subagent, with distinct type/model/task', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerParentRecord('claude-code:parent-1', launchRecord('toolu_1', { subagent_type: 'sdd-apply', model: 'sonnet', description: 'Apply slice 2' }));
    coordinator.offerParentRecord('claude-code:parent-1', launchRecord('toolu_2', { subagent_type: 'jd-judge-a', model: 'opus', description: 'Judge A' }));
    coordinator.offerParentRecord('claude-code:parent-1', launchRecord('toolu_3', { subagent_type: 'jd-judge-b', model: 'haiku', description: 'Judge B' }));
    publish.mockClear();

    // Resolved out of launch order, proving the join is by id, not position.
    coordinator.offerParentRecord('claude-code:parent-1', resultRecord('toolu_2', 'agent-two'));
    coordinator.offerParentRecord('claude-code:parent-1', resultRecord('toolu_1', 'agent-one'));
    coordinator.offerParentRecord('claude-code:parent-1', resultRecord('toolu_3', 'agent-three'));

    expect(publish).toHaveBeenCalledTimes(3);
    const events = publish.mock.calls.map((call) => call[0]);
    expect(events.find((e) => e.sessionKey === 'claude-code:agent-two')).toMatchObject({
      kind: 'parent',
      agentProfile: { role: 'subagent', agentType: 'jd-judge-a', requestedModel: 'opus', task: 'Judge A' },
    });
    expect(events.find((e) => e.sessionKey === 'claude-code:agent-one')).toMatchObject({
      kind: 'parent',
      agentProfile: { role: 'subagent', agentType: 'sdd-apply', requestedModel: 'sonnet', task: 'Apply slice 2' },
    });
    expect(events.find((e) => e.sessionKey === 'claude-code:agent-three')).toMatchObject({
      kind: 'parent',
      agentProfile: { role: 'subagent', agentType: 'jd-judge-b', requestedModel: 'haiku', task: 'Judge B' },
    });
  });

  it('carries the resolved correlationId alongside the profile when the parent edge is already known', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef());
    coordinator.offerParentRecord('claude-code:parent-1', launchRecord('toolu_1', { subagent_type: 'sdd-apply', model: 'sonnet', description: 'Apply' }));
    coordinator.offerParentRecord('claude-code:parent-1', resultRecord('toolu_1', 'agent-one'));

    const event = publish.mock.calls.map((call) => call[0]).find((e) => e.sessionKey === 'claude-code:agent-one' && e.agentProfile);
    expect(event).toMatchObject({ correlationId: 'claude-code:parent-1', agentProfile: { role: 'subagent', agentType: 'sdd-apply' } });
  });

  // The real ordering risk: the directory-name edge resolves the plain `parent` correlation FIRST
  // (before the subagent finishes and its tool_result/profile ever arrives) — `emitted` already
  // blocks a second correlation-only publish for that child, but the profile must still get
  // through as its own event once the launch resolves, or it would be silently lost forever.
  it('still publishes the profile once resolved, even after the correlation edge for that child was already emitted', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef());
    coordinator.offerSession(subagentRef({ sessionKey: 'claude-code:agent-one', filePath: '/tmp/parent-1/subagents/agent-agent-one.jsonl' }));
    expect(publish).toHaveBeenCalledTimes(1); // the plain correlation edge, no profile yet
    publish.mockClear();

    coordinator.offerParentRecord('claude-code:parent-1', launchRecord('toolu_1', { subagent_type: 'sdd-apply', model: 'sonnet', description: 'Apply' }));
    coordinator.offerParentRecord('claude-code:parent-1', resultRecord('toolu_1', 'agent-one'));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      sessionKey: 'claude-code:agent-one',
      agentProfile: { role: 'subagent', agentType: 'sdd-apply', requestedModel: 'sonnet', task: 'Apply' },
    });
  });

  it('never publishes a profile twice for the same already-resolved launch', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerParentRecord('claude-code:parent-1', launchRecord('toolu_1', { subagent_type: 'sdd-apply' }));
    coordinator.offerParentRecord('claude-code:parent-1', resultRecord('toolu_1', 'agent-one'));
    publish.mockClear();

    // A redundant re-offer of the same already-resolved record must not republish.
    coordinator.offerParentRecord('claude-code:parent-1', resultRecord('toolu_1', 'agent-one'));

    expect(publish).not.toHaveBeenCalled();
  });
});

// Agent profile tracking, historical path (fix: "profiles under DEFAULT settings" — a discovery-
// time scan of a parent's already-written history feeds resolved profiles in here directly,
// bypassing the live tail entirely).
describe('ClaudeCodeSubagentCorrelationCoordinator (scanned/historical profiles)', () => {
  it('publishes a profile event for a resolved historical claim, same shape as the live path', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerScannedProfiles([
      { childSessionKey: 'claude-code:agent-one', claim: { toolUseId: 'toolu_1', agentType: 'sdd-apply', model: 'sonnet', task: 'Apply' } },
    ]);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      kind: 'parent',
      sessionKey: 'claude-code:agent-one',
      agentProfile: { role: 'subagent', agentType: 'sdd-apply', requestedModel: 'sonnet', task: 'Apply' },
    });
  });

  it('never publishes twice for a child already resolved by the live path', () => {
    const { coordinator, publish } = makeCoordinator();
    const launch: ClaudeCodeRecord = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'sdd-apply' } }] },
    };
    const result: ClaudeCodeRecord = {
      type: 'user',
      toolUseResult: { agentId: 'agent-one' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
    };
    coordinator.offerParentRecord('claude-code:parent-1', launch);
    coordinator.offerParentRecord('claude-code:parent-1', result);
    publish.mockClear();

    coordinator.offerScannedProfiles([{ childSessionKey: 'claude-code:agent-one', claim: { toolUseId: 'toolu_1', agentType: 'sdd-apply' } }]);

    expect(publish).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { createAgentTree, registerSession } from '../../../domain/agents/agent-tree';
import type { ClaudeCodeSessionRef } from './discover';
import type { AgentLaunchClaim, ClaudeCodeRecord } from './parse';
import { correlateClaudeCodeSession, correlateFromParentRecord, resolveAgentLaunchFromRecord, trackAgentLaunches } from './correlate';

function subagentRef(overrides: Partial<ClaudeCodeSessionRef> = {}): ClaudeCodeSessionRef {
  return {
    harness: 'claude-code',
    sessionKey: 'claude-code:abc123',
    filePath: '/tmp/subagents/agent-abc123.jsonl',
    isSubagent: true,
    parentSessionKey: 'claude-code:parent-session-1',
    cwd: null,
    discoveredAt: 0,
    ...overrides,
  };
}

describe('correlateClaudeCodeSession (directory-name edge)', () => {
  it('links a subagent session to its already-known parent using the path-derived parentSessionKey', () => {
    const tree = createAgentTree();
    correlateClaudeCodeSession(tree, subagentRef({ sessionKey: 'claude-code:parent-session-1', isSubagent: false, parentSessionKey: null }), 0);
    correlateClaudeCodeSession(tree, subagentRef(), 0);

    expect(tree.nodes.get('claude-code:abc123')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });

  it('resolves the link once the parent registers, even when the subagent was discovered first', () => {
    const tree = createAgentTree();
    correlateClaudeCodeSession(tree, subagentRef(), 0);
    expect(tree.nodes.get('claude-code:abc123')?.parentSessionKey).toBeNull();

    correlateClaudeCodeSession(tree, subagentRef({ sessionKey: 'claude-code:parent-session-1', isSubagent: false, parentSessionKey: null }), 0);

    expect(tree.nodes.get('claude-code:abc123')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });

  it('registers a top-level (non-subagent) session as a root node', () => {
    const tree = createAgentTree();
    correlateClaudeCodeSession(
      tree,
      subagentRef({ sessionKey: 'claude-code:session-abc', isSubagent: false, parentSessionKey: null }),
      0,
    );

    expect(tree.nodes.get('claude-code:session-abc')?.parentSessionKey).toBeNull();
  });
});

describe('correlateFromParentRecord (agentId edge)', () => {
  it('links a subagent to its parent using toolUseResult.agentId ALONE, with no attributionAgent field present', () => {
    const tree = createAgentTree();
    registerSession(tree, 'claude-code:parent-session-1');
    const record: ClaudeCodeRecord = {
      type: 'user',
      toolUseResult: { agentId: 'abc123', description: 'Auditar rutas' },
    };
    // No `attributionAgent` field anywhere on this record.
    expect('attributionAgent' in record).toBe(false);

    correlateFromParentRecord(tree, 'claude-code:parent-session-1', record, 0);

    expect(tree.nodes.get('claude-code:abc123')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });

  it('resolves the same correlation even when attributionAgent is present with an unrelated value', () => {
    const tree = createAgentTree();
    registerSession(tree, 'claude-code:parent-session-1');
    const record: ClaudeCodeRecord = {
      type: 'user',
      attributionAgent: 'totally-unrelated-label',
      toolUseResult: { agentId: 'xyz789' },
    };

    correlateFromParentRecord(tree, 'claude-code:parent-session-1', record, 0);

    expect(tree.nodes.get('claude-code:xyz789')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });

  it('does nothing when the record carries no toolUseResult.agentId', () => {
    const tree = createAgentTree();
    const record: ClaudeCodeRecord = { type: 'user' };

    correlateFromParentRecord(tree, 'claude-code:parent-session-1', record, 0);

    expect(tree.nodes.size).toBe(0);
  });

  it('correlation succeeds via agentId even when attributionAgent is absent, proving label absence never blocks it', () => {
    const tree = createAgentTree();
    registerSession(tree, 'claude-code:parent-session-1');
    const record: ClaudeCodeRecord = {
      type: 'assistant',
      isSidechain: true,
      agentId: 'a50ed6015d52cbd51',
      toolUseResult: { agentId: 'a50ed6015d52cbd51' },
    };
    expect(record.attributionAgent).toBeUndefined();

    correlateFromParentRecord(tree, 'claude-code:parent-session-1', record, 0);

    expect(tree.nodes.get('claude-code:a50ed6015d52cbd51')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });
});

// Agent profile tracking: the tool_use.id <-> tool_result.tool_use_id join, staged across records
// by `trackAgentLaunches`/resolved by `resolveAgentLaunchFromRecord`. Uses THREE launches with
// distinct subagent_type/model/description on purpose — a test with only one launch cannot prove
// the join reads the matching id rather than always picking the first or last pending claim.
describe('trackAgentLaunches / resolveAgentLaunchFromRecord (agent profile tracking: launch join)', () => {
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

  it('joins each of three concurrent launches to its OWN correct agentId, not the first or last pending claim', () => {
    const pending = new Map<string, AgentLaunchClaim>();
    trackAgentLaunches(pending, launchRecord('toolu_1', { subagent_type: 'sdd-apply', model: 'sonnet', description: 'Apply' }));
    trackAgentLaunches(pending, launchRecord('toolu_2', { subagent_type: 'jd-judge-a', model: 'opus', description: 'Judge A' }));
    trackAgentLaunches(pending, launchRecord('toolu_3', { subagent_type: 'jd-judge-b', model: 'haiku', description: 'Judge B' }));
    expect(pending.size).toBe(3);

    // Resolved out of launch order (2nd tool_use_id first) — proves the match is by id, not order.
    const second = resolveAgentLaunchFromRecord(pending, resultRecord('toolu_2', 'agent-two'));
    const first = resolveAgentLaunchFromRecord(pending, resultRecord('toolu_1', 'agent-one'));
    const third = resolveAgentLaunchFromRecord(pending, resultRecord('toolu_3', 'agent-three'));

    expect(second).toEqual({ childSessionKey: 'claude-code:agent-two', claim: { toolUseId: 'toolu_2', agentType: 'jd-judge-a', model: 'opus', task: 'Judge A' } });
    expect(first).toEqual({ childSessionKey: 'claude-code:agent-one', claim: { toolUseId: 'toolu_1', agentType: 'sdd-apply', model: 'sonnet', task: 'Apply' } });
    expect(third).toEqual({ childSessionKey: 'claude-code:agent-three', claim: { toolUseId: 'toolu_3', agentType: 'jd-judge-b', model: 'haiku', task: 'Judge B' } });
  });

  it('resolving a launch removes it from the pending map (never double-consumed)', () => {
    const pending = new Map<string, AgentLaunchClaim>();
    trackAgentLaunches(pending, launchRecord('toolu_1', { subagent_type: 'sdd-apply' }));

    resolveAgentLaunchFromRecord(pending, resultRecord('toolu_1', 'agent-one'));
    expect(pending.size).toBe(0);

    // A second tool_result reusing the same tool_use_id (should never happen, but must not
    // resurrect a stale claim) finds nothing left to join.
    const again = resolveAgentLaunchFromRecord(pending, resultRecord('toolu_1', 'agent-one-again'));
    expect(again).toBeNull();
  });

  // Adversarial near-miss: a tool_result whose tool_use_id matches NO pending launch must resolve
  // to nothing, even though other unrelated launches are pending.
  it('returns null when the tool_result tool_use_id matches no pending launch', () => {
    const pending = new Map<string, AgentLaunchClaim>();
    trackAgentLaunches(pending, launchRecord('toolu_1', { subagent_type: 'sdd-apply' }));

    const resolved = resolveAgentLaunchFromRecord(pending, resultRecord('toolu_unrelated', 'agent-x'));

    expect(resolved).toBeNull();
    expect(pending.size).toBe(1);
  });

  it('returns null when the record carries no toolUseResult.agentId at all, even if tool_use_id matches', () => {
    const pending = new Map<string, AgentLaunchClaim>();
    trackAgentLaunches(pending, launchRecord('toolu_1', { subagent_type: 'sdd-apply' }));
    const record: ClaudeCodeRecord = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
    };

    expect(resolveAgentLaunchFromRecord(pending, record)).toBeNull();
    expect(pending.size).toBe(1);
  });

  it('a record with a non-Agent tool_use is never tracked as a pending launch', () => {
    const pending = new Map<string, AgentLaunchClaim>();
    trackAgentLaunches(pending, {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }] },
    });

    expect(pending.size).toBe(0);
  });
});

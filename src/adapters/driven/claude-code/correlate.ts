/**
 * Claude Code parent/child correlation (tasks.md 7.5, design.md "Correlation and the Agent
 * Tree"). Two independent edges feed the shared `domain/agents/agent-tree.ts`:
 *
 * 1. `correlateClaudeCodeSession` — the `<parent-session-id>/subagents/` directory-name edge,
 *    already extracted by `discover.ts`'s path classifier.
 * 2. `correlateFromParentRecord` — the load-bearing `toolUseResult.agentId` edge, extracted from
 *    a parsed PARENT transcript record and matched against the `agent-<agentId>.jsonl` filename.
 *
 * Neither function ever reads `attributionAgent` (spec: "Subagent correlates to its parent" /
 * "attributionAgent absent does not block correlation") — that field is handled exclusively by
 * `parse.ts`'s `resolveWorkerLabel`, a display hint with no path into this module.
 */
import { claimParentChild, registerSession, type AgentTree } from '../../../domain/agents/agent-tree';
import type { ClaudeCodeSessionRef } from './discover';
import type { ClaudeCodeRecord } from './parse';
import { extractAgentIdFromToolUseResult } from './parse';

const HARNESS_PREFIX = 'claude-code:';

/** Applies the directory-name edge for a discovered session (root sessions register with no parent). */
export function correlateClaudeCodeSession(tree: AgentTree, sessionRef: ClaudeCodeSessionRef, now: number): void {
  if (!sessionRef.isSubagent || !sessionRef.parentSessionKey) {
    registerSession(tree, sessionRef.sessionKey);
    return;
  }
  claimParentChild(tree, sessionRef.parentSessionKey, sessionRef.sessionKey, now);
}

/**
 * Applies the agentId edge from a parent transcript record. No-op if the record carries no
 * `toolUseResult.agentId` (most parent records do not represent a subagent launch).
 */
export function correlateFromParentRecord(
  tree: AgentTree,
  parentSessionKey: string,
  record: ClaudeCodeRecord,
  now: number,
): void {
  const agentId = extractAgentIdFromToolUseResult(record);
  if (!agentId) return;
  const childSessionKey = `${HARNESS_PREFIX}${agentId}`;
  claimParentChild(tree, parentSessionKey, childSessionKey, now);
}

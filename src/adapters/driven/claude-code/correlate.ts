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
import type { AgentLaunchClaim, ClaudeCodeRecord } from './parse';
import { extractAgentIdFromToolUseResult, extractAgentLaunchClaims, extractToolResultBlocks } from './parse';

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

/**
 * Agent profile tracking, join step 1: stages every `Agent` tool_use claim on this PARENT record
 * into `pendingLaunches`, keyed by the launch's own tool_use id — mutated in place, mirroring
 * `agent-tree.ts`'s own mutate-the-passed-structure style. A record with no `Agent` launch is a
 * no-op (most parent records are not one).
 */
export function trackAgentLaunches(pendingLaunches: Map<string, AgentLaunchClaim>, record: ClaudeCodeRecord): void {
  for (const claim of extractAgentLaunchClaims(record)) {
    pendingLaunches.set(claim.toolUseId, claim);
  }
}

/**
 * Agent profile tracking, join step 2: the load-bearing join itself — `tool_use.id` <->
 * `toolUseResult.agentId` on the matching `tool_result` record (spec: "the join to the spawned
 * subagent is tool_use.id <-> the toolUseResult.agentId on the matching tool_result record").
 * Matches this record's `tool_result` block(s) by `tool_use_id` against `pendingLaunches`; on a
 * match, consumes (deletes) that claim so it can never be joined twice. Returns `null` — and
 * leaves `pendingLaunches` untouched — when this record carries no `toolUseResult.agentId`, or
 * when no `tool_result` block's `tool_use_id` matches any pending claim.
 */
export function resolveAgentLaunchFromRecord(
  pendingLaunches: Map<string, AgentLaunchClaim>,
  record: ClaudeCodeRecord,
): { childSessionKey: string; claim: AgentLaunchClaim } | null {
  const agentId = extractAgentIdFromToolUseResult(record);
  if (!agentId) return null;
  for (const block of extractToolResultBlocks(record)) {
    const toolUseId = block.tool_use_id;
    if (typeof toolUseId !== 'string') continue;
    const claim = pendingLaunches.get(toolUseId);
    if (!claim) continue;
    pendingLaunches.delete(toolUseId);
    return { childSessionKey: `${HARNESS_PREFIX}${agentId}`, claim };
  }
  return null;
}

/**
 * Agent profile tracking, discovery-time recovery (fix: "profiles under DEFAULT settings").
 * `subagent-correlation-coordinator.ts`'s join only ever sees records the LIVE tail actually
 * reads — and under the (default) EOF bootstrap, that tail never reads anything written before
 * process start. A subagent's `Agent` launch and its resolving `tool_result` both live in its
 * PARENT's transcript and are typically both already-historical by the time this process starts,
 * so the live path alone never resolves that subagent's profile.
 *
 * Profiles are STATE, not history: this module re-derives that state with a one-time, read-only
 * scan of the parent's already-written transcript, run once per discovered parent session,
 * entirely separate from the tail/event pipeline it must never perturb. `scanParentTranscriptFor-
 * AgentProfiles` takes no publisher and touches no queue — it only returns facts; `scanAndApply-
 * AgentProfiles` is the thin, fire-and-forget composition-root glue that applies them.
 */
import { trackAgentLaunches, resolveAgentLaunchFromRecord } from './correlate';
import type { ClaudeCodeSessionRef } from './discover';
import type { AgentLaunchClaim, ClaudeCodeRecord } from './parse';
import { parseClaudeCodeLine } from './parse';
import type { ClaudeCodeSubagentCorrelationCoordinator } from './subagent-correlation-coordinator';
import { scanFileLines } from './tail';

export interface ResolvedAgentProfile {
  childSessionKey: string;
  claim: AgentLaunchClaim;
}

export interface AgentProfileScanOptions {
  maxChunkBytes?: number;
}

/**
 * A line cannot carry an `Agent` launch unless it contains `"name":"Agent"`, and cannot resolve
 * one unless it contains `"agentId"` (the `toolUseResult.agentId` field on the matching
 * `tool_result` record) — the cheap pre-filter that lets `scanFileLines` skip `JSON.parse` for
 * the vast majority of a large transcript's lines.
 */
function couldCarryAgentProfileFact(line: string): boolean {
  return line.includes('"name":"Agent"') || line.includes('"agentId"');
}

/**
 * Read-only scan of ONE parent transcript for historical `Agent` launches, joined by the same
 * `tool_use.id` <-> `toolUseResult.agentId` rule the live path uses (`correlate.ts`). Both halves
 * of a launch may sit anywhere from 4% to 98% through the file, so the whole file is scanned —
 * `scanFileLines`'s substring pre-filter is what keeps that affordable. Never publishes anything;
 * the resolved facts are the caller's to apply.
 */
export async function scanParentTranscriptForAgentProfiles(
  filePath: string,
  options: AgentProfileScanOptions = {},
): Promise<ResolvedAgentProfile[]> {
  const candidateLines = await scanFileLines(filePath, couldCarryAgentProfileFact, options.maxChunkBytes);
  const pendingLaunches = new Map<string, AgentLaunchClaim>();
  const resolved: ResolvedAgentProfile[] = [];
  for (const line of candidateLines) {
    const record: ClaudeCodeRecord | null = parseClaudeCodeLine(line);
    if (!record) continue;
    trackAgentLaunches(pendingLaunches, record);
    const match = resolveAgentLaunchFromRecord(pendingLaunches, record);
    if (match) resolved.push(match);
  }
  return resolved;
}

/**
 * Fire-and-forget discovery-time hook: scans a PARENT session's transcript and applies whatever
 * resolves onto `coordinator` (which itself guards against double-publishing via its own
 * `emittedProfileFor`, so this is safe to run alongside the live path without ever double-firing).
 * A no-op for a subagent's own session — its profile lives in its PARENT's transcript, never its
 * own. Never throws: a slow or failing scan must degrade profiles only, mirroring the precedent
 * already applied to `ingestAgentActivity`'s `onSessionDiscovered` hook. Returns its promise (never
 * awaited by the composition root) purely so tests can observe completion deterministically.
 */
export async function scanAndApplyAgentProfiles(
  coordinator: ClaudeCodeSubagentCorrelationCoordinator,
  session: ClaudeCodeSessionRef,
  options: AgentProfileScanOptions = {},
): Promise<void> {
  if (session.isSubagent) return;
  try {
    const resolved = await scanParentTranscriptForAgentProfiles(session.filePath, options);
    coordinator.offerScannedProfiles(resolved);
  } catch {
    // A failing scan degrades profiles only — discovery/ingestion must keep flowing.
  }
}

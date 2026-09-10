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
import { extractRecordModel, parseClaudeCodeLine } from './parse';
import type { ClaudeCodeSubagentCorrelationCoordinator } from './subagent-correlation-coordinator';
import { scanFileLines, scanLatestFromEnd } from './tail';

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
 * A real, non-sentinel `message.model` value cannot appear on a line lacking either literal
 * substring — the cheap pre-filter that lets `scanLatestFromEnd` skip `JSON.parse` on the vast
 * majority of a large transcript's lines while walking backward from EOF.
 */
function couldCarryModelFact(line: string): boolean {
  return line.includes('"type":"assistant"') && line.includes('"model"');
}

/**
 * Agent profile tracking, live-model recovery (fix: "the resolved model is 1 of 21" — EOF
 * bootstrap means the live tail never reads a session's pre-existing history for its OWN
 * `message.model`, exactly the same gap `scanParentTranscriptForAgentProfiles` fixes for `Agent`
 * launches). Unlike a launch, the resolved model is by definition the LAST real occurrence in the
 * file, so this walks `filePath` BACKWARD from EOF via `scanLatestFromEnd`, bounded per read, and
 * stops at the first real value — never a whole-file scan. Reuses `extractRecordModel` unchanged,
 * so the `<synthetic>` sentinel filter keeps applying: a record with no model, or with the
 * sentinel, is skipped in favor of the real value before it.
 */
export async function scanLatestModelForSession(
  filePath: string,
  options: AgentProfileScanOptions = {},
): Promise<string | undefined> {
  return await scanLatestFromEnd(
    filePath,
    (line) => {
      if (!couldCarryModelFact(line)) return undefined;
      const record = parseClaudeCodeLine(line);
      return record ? extractRecordModel(record) : undefined;
    },
    options.maxChunkBytes,
  );
}

/**
 * Fire-and-forget discovery-time hook: for EVERY discovered session (orchestrator or subagent
 * alike), reads that session's OWN transcript for its latest resolved model and seeds it onto
 * `coordinator`. Additionally, for a PARENT (non-subagent) session only, scans its transcript for
 * historical `Agent` launches and applies whatever resolves — a no-op for a subagent's own
 * session, since a launch's agentType/requestedModel/task live in its PARENT's transcript, never
 * its own. Both halves independently degrade on failure (never throw): a slow or failing scan
 * must never break discovery/ingestion, mirroring the precedent already applied to
 * `ingestAgentActivity`'s `onSessionDiscovered` hook. Returns its promise (never awaited by the
 * composition root) purely so tests can observe completion deterministically.
 */
export async function scanAndApplyAgentProfiles(
  coordinator: ClaudeCodeSubagentCorrelationCoordinator,
  session: ClaudeCodeSessionRef,
  options: AgentProfileScanOptions = {},
): Promise<void> {
  try {
    const model = await scanLatestModelForSession(session.filePath, options);
    if (model) coordinator.offerScannedModel(session.sessionKey, session.isSubagent ? 'subagent' : 'orchestrator', model);
  } catch {
    // A failing scan degrades profiles only — discovery/ingestion must keep flowing.
  }

  if (session.isSubagent) return;
  try {
    const resolved = await scanParentTranscriptForAgentProfiles(session.filePath, options);
    coordinator.offerScannedProfiles(resolved);
  } catch {
    // A failing scan degrades profiles only — discovery/ingestion must keep flowing.
  }
}

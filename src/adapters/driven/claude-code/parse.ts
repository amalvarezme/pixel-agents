/**
 * Claude Code JSONL record parsing (tasks.md 7.4). Parses raw `assistant`/`user`/`system` top-
 * level records, extracts nested `tool_use`/`tool_result` content blocks, and maps a record to
 * normalized `AgentEvent`s. Also extracts the two fields the rest of the adapter depends on:
 *
 * - `toolUseResult.agentId` (spec: "Claude Code Session Discovery" — the load-bearing parent/
 *   child correlation edge; see `correlate.ts`).
 * - the worker-label fallback chain `attributionAgent` -> `toolUseResult.description` ->
 *   `agent-<shortId>` (spec: "attributionAgent absent does not block correlation" — the label is
 *   a DISPLAY HINT ONLY, resolved here independently of correlation, never on a correctness path).
 *
 * `tool_use`/`tool_result` are not top-level record types in Claude Code's JSONL — they are
 * content blocks nested inside an `assistant`/`user` record's `message.content[]` array
 * (research-local-evidence.md Q4). `extractToolUseBlocks`/`extractToolResultBlocks` walk that
 * nesting.
 *
 * `parseClaudeCodeLine` never throws: malformed JSON returns `null` (design.md: "Malformed JSON
 * increments a counter and emits `status(parse_error)`; it never throws").
 */
import { createEventFromLogRecord, createMemoryWriteEvent } from '../../../domain/events/factories';
import type { AgentEventBase } from '../../../domain/events/types';
import type { AgentProfile } from '../../../domain/agents/agent-profile';
import { ClaudeCodeMemoryWriteDetector } from './memory-write-detector';

export interface ClaudeCodeContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  [key: string]: unknown;
}

export interface ClaudeCodeToolUseResult {
  agentId?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ClaudeCodeRecord {
  type?: string;
  uuid?: string;
  isSidechain?: boolean;
  agentId?: string;
  attributionAgent?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: ClaudeCodeContentBlock[] | string;
    /** Agent profile tracking: the model running THIS record's turn (spec: "the orchestrator's
     * own model is on its assistant records as message.model"). */
    model?: string;
  };
  toolUseResult?: ClaudeCodeToolUseResult;
  [key: string]: unknown;
}

/** Parses one JSONL line. Returns `null` for empty input or malformed JSON — never throws. */
export function parseClaudeCodeLine(rawLine: string): ClaudeCodeRecord | null {
  if (rawLine.trim().length === 0) return null;
  try {
    return JSON.parse(rawLine) as ClaudeCodeRecord;
  } catch {
    return null;
  }
}

/** Returns every `tool_use` content block nested in this record's `message.content[]`, if any. */
export function extractToolUseBlocks(record: ClaudeCodeRecord): ClaudeCodeContentBlock[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block.type === 'tool_use');
}

/** Returns every `tool_result` content block nested in this record's `message.content[]`, if any. */
export function extractToolResultBlocks(record: ClaudeCodeRecord): ClaudeCodeContentBlock[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block.type === 'tool_result');
}

/** The load-bearing correlation field: never depends on `attributionAgent` (spec requirement). */
export function extractAgentIdFromToolUseResult(record: ClaudeCodeRecord): string | null {
  return record.toolUseResult?.agentId ?? null;
}

const AGENT_LAUNCH_TOOL_NAME = 'Agent';

/**
 * Agent profile tracking: a claim staged from one `Agent` tool_use block, keyed by that block's
 * own `id` — the join key `correlate.ts` later matches against the corresponding tool_result's
 * `tool_use_id` (spec: "the join to the spawned subagent is tool_use.id <-> toolUseResult.agentId
 * on the matching tool_result record"). `agentType`/`model`/`task` are all optional and never
 * defaulted — a launch that omits any of them stays absent on the claim, exactly as received.
 *
 * `model` here is the launch's REQUESTED model — an alias (`sonnet`/`opus`/`haiku`), or absent
 * meaning "the default". It is NOT the resolved running model: the subagent's own transcript
 * records the resolved id (e.g. `claude-sonnet-5`) on its own `message.model`, exactly like the
 * orchestrator's (`extractRecordModel` below) — the two are surfaced as distinct `AgentProfile`
 * fields (`requestedModel` vs `model`) by whatever assembles the final profile, never conflated.
 */
export interface AgentLaunchClaim {
  toolUseId: string;
  agentType?: string;
  model?: string;
  task?: string;
}

/**
 * Extracts one claim per `Agent` tool_use block on this record (most records have none or one; a
 * parent that launches several subagents in parallel emits several `tool_use` blocks on the SAME
 * record). `task` is sourced from the launch's own `description` — the short 3-5 word summary the
 * `Agent` tool contract requires — never the full `prompt`, which is far too long for a caption.
 */
export function extractAgentLaunchClaims(record: ClaudeCodeRecord): AgentLaunchClaim[] {
  const claims: AgentLaunchClaim[] = [];
  for (const block of extractToolUseBlocks(record)) {
    if (block.name !== AGENT_LAUNCH_TOOL_NAME || typeof block.id !== 'string') continue;
    const input = block.input ?? {};
    const claim: AgentLaunchClaim = { toolUseId: block.id };
    if (typeof input.subagent_type === 'string') claim.agentType = input.subagent_type;
    if (typeof input.model === 'string') claim.model = input.model;
    if (typeof input.description === 'string') claim.task = input.description;
    claims.push(claim);
  }
  return claims;
}

/**
 * A real, non-sentinel `message.model` value: Claude Code emits `<synthetic>` on some system-
 * generated records, interleaved with real values (observed in live transcripts, e.g.
 * `claude-opus-5 -> <synthetic> -> claude-opus-5`). Never a real model — must never be tracked as
 * one, or a worker's displayed model would flip to this string.
 */
const SYNTHETIC_MODEL_SENTINEL = '<synthetic>';

/**
 * The RESOLVED, LIVE running model of whichever session's own transcript this record belongs to
 * (spec correction: model is observed and time-varying, never fixed once at launch — this applies
 * identically to the orchestrator's own transcript and to a subagent's own transcript; only the
 * `role` tag differs, decided by the caller via `ctx.isSubagent`). Filters the `<synthetic>`
 * sentinel: a record that carries it (or no model at all) yields `undefined`, so the caller's
 * merge leaves whatever model was already tracked untouched rather than clearing or corrupting it.
 */
export function extractRecordModel(record: ClaudeCodeRecord): string | undefined {
  if (record.type !== 'assistant') return undefined;
  const model = record.message?.model;
  if (typeof model !== 'string' || model.length === 0 || model === SYNTHETIC_MODEL_SENTINEL) return undefined;
  return model;
}

const FALLBACK_LABEL_ID_LENGTH = 8;

/**
 * Worker label fallback chain: `attributionAgent` -> `toolUseResult.description` ->
 * `agent-<shortId>` -> `agent-unknown`. `agentId` is accepted as a plain parameter, never read
 * from the record itself here, so this function can never be mistaken for a correlation source.
 */
export function resolveWorkerLabel(record: ClaudeCodeRecord, agentId: string | null): string {
  if (typeof record.attributionAgent === 'string' && record.attributionAgent.length > 0) {
    return record.attributionAgent;
  }
  const description = record.toolUseResult?.description;
  if (typeof description === 'string' && description.length > 0) {
    return description;
  }
  if (agentId) {
    return `agent-${agentId.slice(0, FALLBACK_LABEL_ID_LENGTH)}`;
  }
  return 'agent-unknown';
}

export interface ClaudeCodeEventMappingContext {
  sessionKey: string;
  allocateId: () => number;
  /**
   * True when this record belongs to a SUBAGENT's own transcript, never the orchestrator's.
   * Decides only the `role` tag on the `agentProfile` this module attaches from the session's OWN
   * live `message.model` (`extractRecordModel` below) — the model-extraction logic itself is
   * identical for both roles. Optional and defaults to "not a subagent" so every existing caller
   * (which never dealt with profiles) keeps working unchanged.
   */
  isSubagent?: boolean;
}

export interface ToolCaption {
  toolLabel: string;
  toolDetail?: string;
}

const TOOL_INPUT_DIGEST_KEYS = ['file_path', 'file', 'path', 'command', 'pattern', 'query'] as const;

/**
 * Blocker B.1 (tasks.md): stateless and adapter-private (spec: "Detector Interface Isolation"),
 * so one shared instance is safe to reuse across every record this module maps.
 */
const memoryWriteDetector = new ClaudeCodeMemoryWriteDetector();

/**
 * Normalized {toolLabel, toolDetail} caption pair (design.md "Captions": "tool_use.name + short
 * input digest, e.g. Read: design.md"). `toolDetail` is the first recognized, non-empty string
 * value among the tool's own input fields — never a harness-agnostic guess.
 */
export function resolveClaudeCodeToolCaption(block: ClaudeCodeContentBlock): ToolCaption {
  const toolLabel = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool';
  const input = block.input ?? {};
  for (const key of TOOL_INPUT_DIGEST_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return { toolLabel, toolDetail: value };
  }
  return { toolLabel };
}

/**
 * Maps one parsed record to zero or more normalized `AgentEvent`s (tasks.md 7.4). Only ever
 * produces LOG_SOURCED event kinds via `createEventFromLogRecord` — never `launch_requested`/
 * `launch_started` (Event Origination Provenance, enforced by the factory itself, not repeated
 * here). A record with `tool_use` blocks yields one `tool_start` per block; a record with
 * `tool_result` blocks yields one `tool_end` per block; a plain assistant/user record with
 * neither yields one `message`; any other record (e.g. `system`) yields nothing at this layer.
 */
export function mapClaudeCodeRecordToEvents(
  record: ClaudeCodeRecord,
  ctx: ClaudeCodeEventMappingContext,
): AgentEventBase[] {
  const at = record.timestamp ? Date.parse(record.timestamp) : Date.now();
  const agentId = extractAgentIdFromToolUseResult(record) ?? record.agentId ?? null;
  const label = resolveWorkerLabel(record, agentId);
  const events: AgentEventBase[] = [];

  // Agent profile tracking: the LIVE running model from this session's own transcript — a
  // time-varying observation, never a value fixed once at launch — tagged with this session's own
  // role. Absent (rather than defaulted) whenever this record carries no real model.
  const recordModel = extractRecordModel(record);
  const agentProfile: AgentProfile | undefined = recordModel
    ? { role: ctx.isSubagent ? 'subagent' : 'orchestrator', model: recordModel }
    : undefined;

  const toolUseBlocks = extractToolUseBlocks(record);
  for (const block of toolUseBlocks) {
    const caption = resolveClaudeCodeToolCaption(block);
    events.push(
      createEventFromLogRecord(ctx.allocateId(), {
        kind: 'tool_start',
        harness: 'claude-code',
        sessionKey: ctx.sessionKey,
        at,
        label,
        toolLabel: caption.toolLabel,
        toolDetail: caption.toolDetail,
        ...(agentProfile ? { agentProfile } : {}),
      }),
    );

    // Blocker B.1: a matching mem_save call additionally emits a `memory_write` event, alongside
    // (never instead of) its `tool_start` — the archive-animation trigger the carry queue, dock
    // slots and path math (slice 4) were built to consume but that runtime never produced.
    const signal = memoryWriteDetector.detect(block);
    if (signal) {
      events.push(
        createMemoryWriteEvent(ctx.allocateId(), {
          harness: 'claude-code',
          sessionKey: ctx.sessionKey,
          at,
          label,
          title: signal.title,
          topicKey: signal.topicKey,
          observationType: signal.observationType,
          toolLabel: signal.toolLabel,
          toolDetail: signal.toolDetail,
        }),
      );
    }
  }

  const toolResultBlocks = extractToolResultBlocks(record);
  for (const _block of toolResultBlocks) {
    events.push(
      createEventFromLogRecord(ctx.allocateId(), {
        kind: 'tool_end',
        harness: 'claude-code',
        sessionKey: ctx.sessionKey,
        at,
        label,
      }),
    );
  }

  const isTextTurn = (record.type === 'assistant' || record.type === 'user') && toolUseBlocks.length === 0 && toolResultBlocks.length === 0;
  if (isTextTurn) {
    events.push(
      createEventFromLogRecord(ctx.allocateId(), {
        kind: 'message',
        harness: 'claude-code',
        sessionKey: ctx.sessionKey,
        at,
        label,
        ...(agentProfile ? { agentProfile } : {}),
      }),
    );
  }

  return events;
}

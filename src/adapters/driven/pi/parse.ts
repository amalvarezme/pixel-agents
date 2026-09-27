/**
 * Pi transcript record parsing (spec: "Pi Transcript Record Families").
 *
 * Pi's orchestrator transcripts carry five top-level record families, discriminated by `type`:
 * `session`, `model_change`, `thinking_level_change`, `custom`, `message`. Verified against real
 * files under `~/.pi/agent/sessions/**` (session version 3).
 *
 * A `message` record wraps `message.role` of `system` / `user` / `assistant` / `toolResult`. An
 * assistant message's `message.content` is an array of parts typed `text`, `thinking`, or
 * `toolCall`; a `toolResult` message carries `toolCallId` and `toolName` at the message level.
 *
 * Because `toolResult` names its own `toolName`, Pi's `tool_end` can carry a real `toolLabel`
 * without the mapper holding any per-session state — the stateless property every other adapter's
 * mapper has, and the reason no open-call map appears here.
 *
 * `parsePiLine` never throws: malformed JSON returns `null`, matching every other adapter's tailer
 * contract (design.md: "Malformed JSON increments a counter ... it never throws").
 */
import { createEventFromLogRecord, createMemoryWriteEvent } from '../../../domain/events/factories';
import type { AgentEventBase } from '../../../domain/events/types';
import type { AgentProfile } from '../../../domain/agents/agent-profile';
import { PiMemoryWriteDetector } from './memory-write-detector';

export const PI_RECORD_FAMILIES = [
  'session',
  'model_change',
  'thinking_level_change',
  'custom',
  'message',
] as const;

export type PiRecordFamily = (typeof PI_RECORD_FAMILIES)[number];

export interface PiToolCallPart {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export type PiContentPart =
  | PiToolCallPart
  | { type: 'text'; text?: string }
  | { type: 'thinking'; text?: string };

export interface PiMessage {
  role?: string;
  model?: string;
  provider?: string;
  /** Present only on a `toolResult` message; Pi names the tool its result belongs to. */
  toolCallId?: string;
  toolName?: string;
  content?: unknown[];
  [key: string]: unknown;
}

export interface PiRecord {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  /** `session` record only — the transcript's own working directory. */
  cwd?: string;
  /** `model_change` record only. */
  modelId?: string;
  provider?: string;
  /** `custom` record only. */
  customType?: string;
  data?: unknown;
  message?: PiMessage;
  [key: string]: unknown;
}

/** Parses one JSONL line. Returns `null` for empty input or malformed JSON — never throws. */
export function parsePiLine(rawLine: string): PiRecord | null {
  if (rawLine.trim().length === 0) return null;
  try {
    return JSON.parse(rawLine) as PiRecord;
  } catch {
    return null;
  }
}

/** Pure table-driven classifier over the five known Pi record families. No I/O. */
export function classifyPiRecordFamily(record: PiRecord): PiRecordFamily | null {
  const type = record.type;
  if (typeof type !== 'string') return null;
  return (PI_RECORD_FAMILIES as readonly string[]).includes(type) ? (type as PiRecordFamily) : null;
}

/**
 * The LIVE running model, from a `model_change` record or an assistant message's own `model`.
 * Returns `undefined` — never a default — when the record carries neither, because a Pi session
 * can switch model mid-run and an invented value would render as fact (spec: "Live model comes
 * from the transcript, never a default").
 */
export function extractPiRecordModel(record: PiRecord): string | undefined {
  if (record.type === 'model_change' && typeof record.modelId === 'string') return record.modelId;
  const model = record.message?.model;
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

export interface PiToolCaption {
  toolLabel: string;
  toolDetail?: string;
}

const DETAIL_MAX_LENGTH = 60;

/**
 * Argument keys that carry the one human-meaningful detail of a Pi tool call, in priority order.
 * A key not listed here yields a label with no detail rather than a serialized argument blob.
 */
const DETAIL_ARGUMENT_KEYS = ['command', 'path', 'pattern', 'query', 'title', 'url'] as const;

function boundedDetail(value: unknown): string | undefined {
  const text = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : undefined;
  if (!text || text.length === 0) return undefined;
  return text.length > DETAIL_MAX_LENGTH ? `${text.slice(0, DETAIL_MAX_LENGTH)}…` : text;
}

/**
 * Normalized `{toolLabel, toolDetail}` caption pair (design.md "Captions"), so the renderer
 * consumes one shared shape and never branches on `harness`. Pi names its tools bare (`bash`,
 * `read`, `mem_save`), so the label needs no unwrapping.
 */
export function resolvePiToolCaption(part: PiContentPart): PiToolCaption | null {
  if (part.type !== 'toolCall') return null;
  if (typeof part.name !== 'string' || part.name.length === 0) return null;

  const args = part.arguments ?? {};
  for (const key of DETAIL_ARGUMENT_KEYS) {
    const detail = boundedDetail(args[key]);
    if (detail) return { toolLabel: part.name, toolDetail: detail };
  }
  return { toolLabel: part.name };
}

export interface PiEventMappingContext {
  sessionKey: string;
  allocateId: () => number;
  /**
   * Whether this session IS a subagent. Pi decides this structurally, by which root the session
   * was found under (design.md D3), so the mapper is told rather than guessing.
   */
  isSubagent: boolean;
}

/** Stateless and adapter-private, so one shared instance is safe across every mapped record. */
const piMemoryWriteDetector = new PiMemoryWriteDetector();

function toolCallParts(record: PiRecord): PiToolCallPart[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is PiToolCallPart =>
      !!part && typeof part === 'object' && (part as PiContentPart).type === 'toolCall',
  );
}

/**
 * Maps one parsed record to zero or more normalized `AgentEvent`s. An assistant turn yields one
 * `tool_start` per `toolCall` part (plus `memory_write` for a matching `mem_save`), a `toolResult`
 * message yields one `tool_end`, a text/thinking-only assistant turn yields one `message`, and
 * every other family — `session`, `model_change`, `thinking_level_change`, `custom`, and `system`
 * messages — yields nothing at this layer.
 *
 * `session_start` is deliberately NOT produced here: the source synthesizes it once in `open()`,
 * from the `SessionRef`, exactly as the Claude Code and Codex adapters do.
 */
export function mapPiRecordToEvents(record: PiRecord, ctx: PiEventMappingContext): AgentEventBase[] {
  if (record.type !== 'message') return [];
  const role = record.message?.role;
  if (role !== 'assistant' && role !== 'toolResult' && role !== 'user') return [];

  const at = record.timestamp ? Date.parse(record.timestamp) : Date.now();
  const model = extractPiRecordModel(record);
  const agentProfile: AgentProfile | undefined = model
    ? { role: ctx.isSubagent ? 'subagent' : 'orchestrator', model }
    : undefined;
  const events: AgentEventBase[] = [];

  if (role === 'toolResult') {
    const toolName = record.message?.toolName;
    events.push(
      createEventFromLogRecord(ctx.allocateId(), {
        kind: 'tool_end',
        harness: 'pi',
        sessionKey: ctx.sessionKey,
        at,
        ...(typeof toolName === 'string' && toolName.length > 0 ? { toolLabel: toolName } : {}),
      }),
    );
    return events;
  }

  const calls = toolCallParts(record);
  for (const part of calls) {
    const caption = resolvePiToolCaption(part);
    if (!caption) continue;
    events.push(
      createEventFromLogRecord(ctx.allocateId(), {
        kind: 'tool_start',
        harness: 'pi',
        sessionKey: ctx.sessionKey,
        at,
        toolLabel: caption.toolLabel,
        ...(caption.toolDetail !== undefined ? { toolDetail: caption.toolDetail } : {}),
        ...(agentProfile ? { agentProfile } : {}),
      }),
    );

    // A matching mem_save ADDITIONALLY emits `memory_write`, never instead of its `tool_start` —
    // the archive-trip trigger (spec: "mem_save produces both events").
    const signal = piMemoryWriteDetector.detect(part);
    if (signal) {
      events.push(
        createMemoryWriteEvent(ctx.allocateId(), {
          harness: 'pi',
          sessionKey: ctx.sessionKey,
          at,
          title: signal.title,
          topicKey: signal.topicKey,
          observationType: signal.observationType,
          toolLabel: signal.toolLabel,
          toolDetail: signal.toolDetail,
        }),
      );
    }
  }

  if (calls.length === 0) {
    events.push(
      createEventFromLogRecord(ctx.allocateId(), {
        kind: 'message',
        harness: 'pi',
        sessionKey: ctx.sessionKey,
        at,
        ...(agentProfile ? { agentProfile } : {}),
      }),
    );
  }

  return events;
}

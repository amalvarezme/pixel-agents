/**
 * Codex JSONL record parsing (tasks.md 12.2, spec: "Codex Session Discovery and Record
 * Families"). Codex's rollout files carry six top-level record families, discriminated by a
 * `type` field: `session_meta`, `event_msg`, `response_item`, `turn_context`, `world_state`,
 * `compacted` (research-local-evidence.md Q1).
 *
 * MCP tool calls (the shape the `memory_write` detector needs, tasks.md 12.8) live nested under
 * `event_msg` / `item_completed` records, as `payload.item` with `item.type: "McpToolCall"`.
 * Codex names the server and tool as SEPARATE fields (`server`, `tool`) — unlike Claude Code's
 * single `mcp__<server>__<tool>` string.
 *
 * A second, unrelated tool-call family — `response_item` / `custom_tool_call` (`name: "exec"`,
 * free-text `input`/`output`) — represents sandboxed code execution, never an MCP call.
 * `extractMcpToolCallItem` excludes it by construction (it only ever looks inside `event_msg`
 * records); `isCodexCustomToolCall` names the exclusion explicitly, for detectors that want to
 * document why they never match this family (research-local-evidence.md: "must be explicitly
 * excluded from `tool_start`/`tool_end`/`memory_write` detection logic").
 *
 * `parseCodexLine` never throws: malformed JSON returns `null`, matching every other adapter's
 * tailer contract (design.md: "Malformed JSON increments a counter ... it never throws").
 *
 * `mapCodexRecordToEvents` (blocker B.1) is the record->events mapper the runtime pipeline was
 * missing entirely: it emits `tool_start` for any `event_msg`/`item_completed` record with a
 * resolvable caption (McpToolCall or CommandExecution — the same family `resolveCodexToolCaption`
 * already recognizes), and, for a matching `McpToolCall`, additionally (never instead of) a
 * `memory_write` event via `CodexMemoryWriteDetector` (spec: "Codex memory_write Detection").
 */
import { createEventFromLogRecord, createMemoryWriteEvent } from '../../../domain/events/factories';
import type { AgentEventBase } from '../../../domain/events/types';
import { CodexMemoryWriteDetector } from './memory-write-detector';

export const CODEX_RECORD_FAMILIES = [
  'session_meta',
  'event_msg',
  'response_item',
  'turn_context',
  'world_state',
  'compacted',
] as const;

export type CodexRecordFamily = (typeof CODEX_RECORD_FAMILIES)[number];

export interface CodexMcpToolCallItem {
  type: 'McpToolCall';
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  readOnlyHint?: boolean;
  [key: string]: unknown;
}

export interface CodexEventMsgPayload {
  type?: string;
  item?: { type?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface CodexRecord {
  type?: string;
  timestamp?: string;
  ordinal?: number;
  payload?: CodexEventMsgPayload | Record<string, unknown>;
  [key: string]: unknown;
}

/** Parses one JSONL line. Returns `null` for empty input or malformed JSON — never throws. */
export function parseCodexLine(rawLine: string): CodexRecord | null {
  if (rawLine.trim().length === 0) return null;
  try {
    return JSON.parse(rawLine) as CodexRecord;
  } catch {
    return null;
  }
}

/** Pure table-driven classifier over the six known Codex record families. No I/O. */
export function classifyCodexRecordFamily(record: CodexRecord): CodexRecordFamily | null {
  const type = record.type;
  if (typeof type !== 'string') return null;
  return (CODEX_RECORD_FAMILIES as readonly string[]).includes(type) ? (type as CodexRecordFamily) : null;
}

export interface CodexMcpToolCallSignal {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

/**
 * Extracts `{server, tool, arguments}` from an `event_msg`/`item_completed`/`McpToolCall` record.
 * Returns `null` for every other shape, including `response_item`/`custom_tool_call` — this
 * function only ever inspects `event_msg` records, so the exec-sandbox family can never reach it.
 */
export function extractMcpToolCallItem(record: CodexRecord): CodexMcpToolCallSignal | null {
  if (record.type !== 'event_msg') return null;
  const payload = record.payload as CodexEventMsgPayload | undefined;
  if (!payload || payload.type !== 'item_completed') return null;
  const item = payload.item as CodexMcpToolCallItem | undefined;
  if (!item || item.type !== 'McpToolCall') return null;
  if (typeof item.server !== 'string' || typeof item.tool !== 'string') return null;
  return { server: item.server, tool: item.tool, arguments: item.arguments };
}

/**
 * Names the `response_item`/`custom_tool_call` (`name: "exec"`) family explicitly, so a detector
 * can assert its exclusion rather than relying only on `extractMcpToolCallItem` returning `null`
 * for the right reason (spec: "custom_tool_call exec record does not false-positive").
 */
export function isCodexCustomToolCall(record: CodexRecord): boolean {
  if (record.type !== 'response_item') return false;
  const payload = record.payload as CodexEventMsgPayload | undefined;
  return payload?.type === 'custom_tool_call';
}

export interface CodexToolCaption {
  toolLabel: string;
  toolDetail?: string;
}

const COMMAND_HEAD_MAX_LENGTH = 60;

function commandHead(command: unknown): string | undefined {
  const text = Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : undefined;
  if (!text || text.length === 0) return undefined;
  return text.length > COMMAND_HEAD_MAX_LENGTH ? `${text.slice(0, COMMAND_HEAD_MAX_LENGTH)}…` : text;
}

/**
 * Normalized {toolLabel, toolDetail} caption pair (design.md "Captions": "payload.item.type;
 * server/tool for McpToolCall, command head for CommandExecution"). Sourced only from
 * `event_msg`/`item_completed` records — the same family `extractMcpToolCallItem` reads — so a
 * `response_item`/`custom_tool_call` record (sandboxed exec) never reaches this function either.
 */
export function resolveCodexToolCaption(record: CodexRecord): CodexToolCaption | null {
  if (record.type !== 'event_msg') return null;
  const payload = record.payload as CodexEventMsgPayload | undefined;
  if (!payload || payload.type !== 'item_completed') return null;
  const item = payload.item as { type?: string; server?: string; tool?: string; command?: unknown } | undefined;
  if (!item || typeof item.type !== 'string') return null;

  if (item.type === 'McpToolCall' && typeof item.server === 'string' && typeof item.tool === 'string') {
    return { toolLabel: item.type, toolDetail: `${item.server}/${item.tool}` };
  }
  if (item.type === 'CommandExecution') {
    return { toolLabel: item.type, toolDetail: commandHead(item.command) };
  }
  return { toolLabel: item.type };
}

export interface CodexEventMappingContext {
  sessionKey: string;
  allocateId: () => number;
}

/**
 * Stateless and adapter-private (spec: "Detector Interface Isolation"), so one shared instance is
 * safe to reuse across every record this module maps.
 */
const codexMemoryWriteDetector = new CodexMemoryWriteDetector();

/**
 * Maps one parsed record to zero or more normalized `AgentEvent`s (blocker B.1). A record with no
 * resolvable tool caption — anything other than an `event_msg`/`item_completed` McpToolCall or
 * CommandExecution — yields nothing at this layer, including the `response_item`/`custom_tool_call`
 * exec family (`resolveCodexToolCaption` already excludes it by construction).
 */
export function mapCodexRecordToEvents(record: CodexRecord, ctx: CodexEventMappingContext): AgentEventBase[] {
  const caption = resolveCodexToolCaption(record);
  if (!caption) return [];

  const at = record.timestamp ? Date.parse(record.timestamp) : Date.now();
  const events: AgentEventBase[] = [
    createEventFromLogRecord(ctx.allocateId(), {
      kind: 'tool_start',
      harness: 'codex',
      sessionKey: ctx.sessionKey,
      at,
      toolLabel: caption.toolLabel,
      toolDetail: caption.toolDetail,
    }),
  ];

  // Blocker B.1: a matching mem_save McpToolCall additionally emits `memory_write`, alongside
  // (never instead of) its `tool_start`.
  const signal = codexMemoryWriteDetector.detect(record);
  if (signal) {
    events.push(
      createMemoryWriteEvent(ctx.allocateId(), {
        harness: 'codex',
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

  return events;
}

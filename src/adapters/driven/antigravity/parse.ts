/**
 * Antigravity JSONL record parsing (tasks.md 13.9-13.11, research-local-evidence.md Addendum:
 * "Antigravity `mem_save` record shape").
 *
 * Every MCP tool call is funnelled through one tool named `call_mcp_tool`; the actual server and
 * tool identity live in `args.ServerName`/`args.ToolName`, NOT in `tool_calls[].name`. Those two
 * fields — plus `args.toolAction`/`args.toolSummary` — are DOUBLE-ENCODED JSON strings: the raw
 * value of `ServerName` is the 8-character string `"engram"`, quote characters included, not the
 * bare 6-character word `engram`. `dequoteOnce` strips exactly one layer of literal surrounding
 * quote characters; a comparison against the raw value (`args.ServerName === "engram"`) is
 * therefore always false, which is itself the proof de-quoting is mandatory (see
 * `parse.test.ts`'s "proves the double-decode is mandatory" suite — that test is intentionally
 * kept, not a throwaway).
 *
 * `args.Arguments` is a JSON-encoded STRING, not a nested object, and needs its own second
 * `JSON.parse` (`parseCallMcpToolArguments`).
 *
 * `parseAntigravityLine` never throws: malformed JSON returns `null`, matching every other
 * adapter's tailer contract.
 */

export interface AntigravityToolCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface AntigravityRecord {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  thinking?: string;
  tool_calls?: AntigravityToolCall[];
  [key: string]: unknown;
}

/** Parses one JSONL line. Returns `null` for empty input or malformed JSON — never throws. */
export function parseAntigravityLine(rawLine: string): AntigravityRecord | null {
  if (rawLine.trim().length === 0) return null;
  try {
    return JSON.parse(rawLine) as AntigravityRecord;
  } catch {
    return null;
  }
}

/** Returns this record's `tool_calls[]`, or an empty array when absent. */
export function extractToolCalls(record: AntigravityRecord): AntigravityToolCall[] {
  return record.tool_calls ?? [];
}

/**
 * Strips exactly one layer of literal surrounding double-quote characters from a
 * double-encoded string value. Returns the value unchanged if it has no surrounding quotes, and
 * `undefined` for a non-string input (e.g. a field that is simply absent).
 */
export function dequoteOnce(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

export interface CallMcpToolSignal {
  server?: string;
  tool?: string;
  argumentsRaw?: string;
  toolAction?: string;
  toolSummary?: string;
}

/**
 * Extracts the de-quoted server/tool identity plus the raw `Arguments` string from a
 * `call_mcp_tool` tool call. Returns `null` for every other tool name (e.g. IDE-native editor
 * actions like `list_dir`), since only `call_mcp_tool` carries an MCP server/tool pair at all.
 */
export function extractCallMcpToolSignal(toolCall: AntigravityToolCall): CallMcpToolSignal | null {
  if (toolCall.name !== 'call_mcp_tool') return null;
  const args = toolCall.args ?? {};
  return {
    server: dequoteOnce(args.ServerName),
    tool: dequoteOnce(args.ToolName),
    argumentsRaw: typeof args.Arguments === 'string' ? args.Arguments : undefined,
    toolAction: dequoteOnce(args.toolAction),
    toolSummary: dequoteOnce(args.toolSummary),
  };
}

/** Second JSON.parse of the `Arguments` string field. Returns `null` on malformed JSON — never throws. */
export function parseCallMcpToolArguments(argumentsRaw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argumentsRaw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const DEFAULT_ANTIGRAVITY_WORKER_LABEL = 'antigravity-agent';

export interface AntigravityWorkerLabelSignal {
  label: string;
  detail?: string;
}

/**
 * Resolves a worker's display label from a tool call's de-quoted `toolAction`/`toolSummary`
 * pair (office-scene-renderer spec: "Worker Label Resolution" — Antigravity is one of the two
 * harnesses with a first-class label field, preferred over any inferred/undocumented field).
 * Applies to any tool call, not only `call_mcp_tool`: every observed Antigravity tool call
 * carries this pair, including IDE-native editor actions (research-local-evidence.md: "Populated
 * `tool_calls` example (IDE)"). Falls back to a deterministic default when `toolAction` is
 * absent, never a blank or error label.
 */
export function resolveAntigravityWorkerLabel(toolCall: AntigravityToolCall): AntigravityWorkerLabelSignal {
  const args = toolCall.args ?? {};
  const label = dequoteOnce(args.toolAction) ?? DEFAULT_ANTIGRAVITY_WORKER_LABEL;
  const detail = dequoteOnce(args.toolSummary);
  return { label, detail };
}

export interface AntigravityToolCaption {
  toolLabel: string;
  toolDetail?: string;
}

/**
 * Normalized {toolLabel, toolDetail} caption pair (design.md "Captions": de-quoted
 * `args.toolAction`/`args.toolSummary`) — the exact same underlying fields Worker Label
 * Resolution already reads, exposed here under the shared tool_start caption contract so the
 * renderer consumes one normalized shape regardless of harness.
 */
export function resolveAntigravityToolCaption(toolCall: AntigravityToolCall): AntigravityToolCaption {
  const { label, detail } = resolveAntigravityWorkerLabel(toolCall);
  return { toolLabel: label, toolDetail: detail };
}

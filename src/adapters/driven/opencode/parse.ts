/**
 * OpenCode row parsing and event mapping (tasks.md 18.5, 18.6; research-local-evidence.md Q3:
 * confirmed `part`/`session` shapes; design.md "Correlation and the Agent Tree" — OpenCode's
 * `session.parent_id` is a first-class column, "none needed" as a fallback).
 *
 * `part.data` is a JSON blob discriminated by `type`; among `type: "tool"` parts, `tool` is the
 * bare `<mcp-server-name>_<tool-name>` string with NO `mcp__` prefix (research Q3) — this is the
 * shape `memory-write-detector.ts` matches against.
 *
 * `session.parent_id` needs no fallback (unlike Claude Code's `agentId`/`attributionAgent`
 * split): it is populated directly at read time, so `mapOpenCodeSessionToEvents` can emit both
 * the `session_start` and (when present) the `parent` event synchronously from one row.
 */
import { createEventFromLogRecord } from '../../../domain/events/factories';
import type { AgentEventBase } from '../../../domain/events/types';

export interface OpenCodePartRow {
  id: string;
  message_id: string;
  session_id: string;
  data: string;
}

export interface OpenCodePartData {
  type?: string;
  tool?: string;
  state?: { input?: Record<string, unknown>; title?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Parses `part.data`. Returns `null` for malformed JSON — never throws. */
export function parseOpenCodePartData(raw: string): OpenCodePartData | null {
  try {
    return JSON.parse(raw) as OpenCodePartData;
  } catch {
    return null;
  }
}

export interface OpenCodeToolCaption {
  toolLabel: string;
  toolDetail?: string;
}

/**
 * Normalized {toolLabel, toolDetail} caption pair (design.md "Captions": "part.data.tool +
 * state.title when non-empty"). Returns `null` for a non-`tool` part.
 */
export function resolveOpenCodeToolCaption(data: OpenCodePartData): OpenCodeToolCaption | null {
  if (data.type !== 'tool' || typeof data.tool !== 'string' || data.tool.length === 0) return null;
  const title = data.state?.title;
  return { toolLabel: data.tool, toolDetail: typeof title === 'string' && title.length > 0 ? title : undefined };
}

export interface OpenCodeSessionRow {
  id: string;
  parent_id: string | null;
  title: string;
  agent: string | null;
}

const SESSION_KEY_PREFIX = 'opencode:';
const FALLBACK_LABEL_ID_LENGTH = 8;

export function openCodeSessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

/**
 * Worker label resolution (spec: "OpenCode uses first-class agent column as label"):
 * `session.agent` -> `session.title` -> a deterministic `session-<shortId>` fallback.
 */
export function resolveOpenCodeWorkerLabel(session: Pick<OpenCodeSessionRow, 'agent' | 'title' | 'id'>): string {
  if (typeof session.agent === 'string' && session.agent.length > 0) return session.agent;
  if (typeof session.title === 'string' && session.title.length > 0) return session.title;
  return `session-${session.id.slice(0, FALLBACK_LABEL_ID_LENGTH)}`;
}

export interface OpenCodeSessionMappingContext {
  allocateId: () => number;
  at?: number;
}

/**
 * Maps one `session` row to its `session_start` event, plus a `parent` event when `parent_id` is
 * populated (Parent/Child Lane Layout, OpenCode). `correlationId` on the `parent` event carries
 * the PARENT's session key; the event's own `sessionKey` is the CHILD (matches
 * `domain/office/office.ts`'s contract, proven generically by `office.test.ts`).
 */
export function mapOpenCodeSessionToEvents(session: OpenCodeSessionRow, ctx: OpenCodeSessionMappingContext): AgentEventBase[] {
  const at = ctx.at ?? Date.now();
  const sessionKey = openCodeSessionKey(session.id);
  const label = resolveOpenCodeWorkerLabel(session);

  const events: AgentEventBase[] = [
    createEventFromLogRecord(ctx.allocateId(), {
      kind: 'session_start',
      harness: 'opencode',
      sessionKey,
      at,
      label,
    }),
  ];

  if (session.parent_id) {
    events.push(
      createEventFromLogRecord(ctx.allocateId(), {
        kind: 'parent',
        harness: 'opencode',
        sessionKey,
        at,
        correlationId: openCodeSessionKey(session.parent_id),
      }),
    );
  }

  return events;
}

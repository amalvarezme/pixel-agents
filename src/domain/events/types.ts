/**
 * Normalized event model (spec: normalized-event-model).
 * Exactly eleven canonical event kinds: the prior art's eight, plus three of ours.
 * `EventKind` is DERIVED from `EVENT_KINDS` so the type and the runtime guard can never drift apart.
 */

import type { AgentProfile } from '../agents/agent-profile';

export const HARNESS_IDS = ['claude-code', 'codex', 'opencode', 'antigravity'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

const LOG_SOURCED_EVENT_KINDS = [
  'session_start',
  'tool_start',
  'tool_end',
  'message',
  'stats',
  'status',
  'parent',
  'session_end',
  'memory_write',
] as const;

const SELF_ORIGINATED_EVENT_KINDS = ['launch_requested', 'launch_started'] as const;

const EVENT_KINDS = [...LOG_SOURCED_EVENT_KINDS, ...SELF_ORIGINATED_EVENT_KINDS] as const;

export type LogSourcedEventKind = (typeof LOG_SOURCED_EVENT_KINDS)[number];
export type SelfOriginatedEventKind = (typeof SELF_ORIGINATED_EVENT_KINDS)[number];
export type EventKind = (typeof EVENT_KINDS)[number];

export function isLogSourcedEventKind(kind: string): kind is LogSourcedEventKind {
  return (LOG_SOURCED_EVENT_KINDS as readonly string[]).includes(kind);
}

export function isEventKind(kind: string): kind is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(kind);
}

/** Common envelope fields every normalized event carries, regardless of source harness. */
export interface AgentEventBase {
  id: number;
  kind: EventKind;
  harness: HarnessId;
  sessionKey: string;
  at: number;
  label?: string;
  /** Stable harness-agnostic correlation field (spec: Parent/Child Correlation Field Contract). */
  correlationId?: string;
  /**
   * Normalized caption pair on `tool_start`, sourced per-harness by each adapter's own resolver
   * (design.md "Captions") so the renderer consumes one shared shape and never branches on
   * `harness`.
   */
  toolLabel?: string;
  toolDetail?: string;
  /**
   * Launcher-only fields (design.md "The Launcher"). Populated exclusively by
   * `createSelfOriginatedEvent` for `launch_requested`/`launch_started`, and by the launcher
   * adapter's own `status(launch_failed)` construction — never by any ingestion adapter.
   */
  launchId?: string;
  binaryPath?: string;
  argv?: string[];
  cwd?: string;
  pid?: number;
  startedAt?: number;
  reason?: string;
  /**
   * Agent profile tracking: what this worker IS (role/agentType), what MODEL it runs, and what
   * TASK it was given — optional and harness-agnostic, sourced per-harness by each adapter's own
   * resolver, exactly like `toolLabel`/`toolDetail` above. A harness that reports none of it
   * simply never sets this field.
   */
  agentProfile?: AgentProfile;
}

export interface MemoryWriteEvent extends AgentEventBase {
  kind: 'memory_write';
  title?: string;
  topicKey?: string;
  observationType?: string;
  toolLabel: string;
  toolDetail?: string;
}

export type AgentEvent = AgentEventBase | MemoryWriteEvent;

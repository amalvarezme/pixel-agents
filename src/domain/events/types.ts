/**
 * Normalized event model (spec: normalized-event-model).
 * Exactly eleven canonical event kinds: the prior art's eight, plus three of ours.
 * `EventKind` is DERIVED from `EVENT_KINDS` so the type and the runtime guard can never drift apart.
 */

import type { AgentProfile } from '../agents/agent-profile';

export const HARNESS_IDS = ['claude-code', 'codex', 'opencode', 'antigravity'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * Whether a session is currently DOING work, or has gone quiet without ending. Canonical here
 * (rather than in `domain/office/office.ts`, which aliases it as `WorkerActivity`) because it
 * travels on the wire: `adapters/driven/sessions/session-lifecycle-coordinator.ts` announces a
 * crossing of the idle threshold as a `status` event carrying this field, which is the ONLY way
 * the office projection — and therefore the renderer — can ever learn that a worker went quiet.
 */
export type SessionActivity = 'working' | 'idle';

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
   * Liveness projection, carried only by the synthetic `status` events
   * `SessionLifecycleCoordinator` publishes when a session crosses the idle threshold in either
   * direction (design.md "Session discovery and aging out": idle means "worker dims, stays on
   * stage"). Never set by an ingestion adapter — a transcript line says what a session DID, never
   * that it has since gone quiet, which is knowable only by watching a clock run out.
   */
  activity?: SessionActivity;
  /**
   * Launcher-only fields (design.md "The Launcher"). Populated exclusively by
   * `createSelfOriginatedEvent` for `launch_requested`/`launch_started`, and by the launcher
   * adapter's own `status(launch_failed)` construction — never by any ingestion adapter.
   * See `projectPath` below for the distinct, ingestion-adapter-populated equivalent — the two
   * must never be merged or treated as interchangeable.
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
  /**
   * The absolute working directory an INGESTION adapter observed for this session, sourced
   * per-harness by each adapter's own resolver (Claude Code/Codex: a `cwd` field read off the
   * session's own log; OpenCode: the `session.directory` column) — exactly like `agentProfile`
   * above, never a harness special case. Antigravity's transcript carries no cwd signal at all,
   * so it simply never sets this field.
   *
   * DISTINCT from `cwd` above: `cwd` is launcher-only (populated exclusively by
   * `createSelfOriginatedEvent` for `launch_requested`/`launch_started`, never by an ingestion
   * adapter — see that field's own doc comment). `projectPath` is the mirror-image field for
   * ingestion adapters and must never be conflated with, or merged into, `cwd`.
   */
  projectPath?: string;
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

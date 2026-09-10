import {
  isLogSourcedEventKind,
  type AgentEventBase,
  type HarnessId,
  type LogSourcedEventKind,
  type MemoryWriteEvent,
  type SelfOriginatedEventKind,
} from './types';
import type { AgentProfile } from '../agents/agent-profile';

export interface CreateLogSourcedEventInput {
  kind: LogSourcedEventKind;
  harness: HarnessId;
  sessionKey: string;
  at: number;
  label?: string;
  correlationId?: string;
  toolLabel?: string;
  toolDetail?: string;
  agentProfile?: AgentProfile;
}

/**
 * The ONLY factory ingestion adapters may call. Requirement: Event Origination Provenance —
 * `launch_requested`/`launch_started` must never come from a log parse, so this factory rejects
 * them at the runtime boundary even if a caller bypasses the `LogSourcedEventKind` type with `as any`.
 */
export function createEventFromLogRecord(id: number, input: CreateLogSourcedEventInput): AgentEventBase {
  if (!isLogSourcedEventKind(input.kind)) {
    throw new Error(`createEventFromLogRecord cannot construct self-originated kind: "${input.kind}"`);
  }
  return { id, ...input };
}

export function createMemoryWriteEvent(
  id: number,
  input: Omit<MemoryWriteEvent, 'id' | 'kind'>,
): MemoryWriteEvent {
  return { id, kind: 'memory_write', ...input };
}

export interface CreateSelfOriginatedEventInput {
  kind: SelfOriginatedEventKind;
  harness: HarnessId;
  sessionKey: string;
  at: number;
  label?: string;
  launchId?: string;
  binaryPath?: string;
  argv?: string[];
  cwd?: string;
  pid?: number;
  startedAt?: number;
}

/** Only the launcher subsystem calls this — never an ingestion adapter. */
export function createSelfOriginatedEvent(id: number, input: CreateSelfOriginatedEventInput): AgentEventBase {
  return { id, ...input };
}

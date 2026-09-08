/**
 * Publishing port for the normalized event bus. Both ingestion adapters and the launcher
 * publish onto the same bus through this port — they share the bus but no code path
 * (design.md: "The Launcher", "Subsystem Separation from Ingestion").
 */
import type { AgentEvent } from '../domain/events/types';

export interface EventPublisher {
  publish(event: AgentEvent): void;
}

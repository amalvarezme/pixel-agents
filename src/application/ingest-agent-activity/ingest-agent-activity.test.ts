import { describe, expect, it } from 'vitest';
import { FakeActivitySource } from '../../adapters/driven/fake/fake-activity-source';
import { InMemoryCheckpointStore } from '../../adapters/driven/checkpoint/in-memory-checkpoint-store';
import type { AgentEvent } from '../../domain/events/types';
import { ingestAgentActivity } from './ingest-agent-activity';

function event(id: number, sessionKey: string): AgentEvent {
  return { id, kind: 'tool_start', harness: 'claude-code', sessionKey, at: id * 1000 };
}

// Requirement (tasks.md 5.2): wires an ActivitySource to the event bus (EventPublisher),
// persisting a checkpoint per published event so a restart resumes rather than replays
// (design.md: Bootstrap). Proves the port -> application -> bus seam with the fake source.
describe('ingestAgentActivity', () => {
  it('publishes every discovered session\'s events onto the bus in order', async () => {
    const sessionRef = { harness: 'claude-code' as const, sessionKey: 'claude-code:s1', discoveredAt: 0 };
    const source = new FakeActivitySource('claude-code', [
      { session: sessionRef, events: [event(1, 'claude-code:s1'), event(2, 'claude-code:s1')] },
    ]);
    const published: AgentEvent[] = [];
    const checkpointStore = new InMemoryCheckpointStore();

    await ingestAgentActivity({
      source,
      publisher: { publish: (e) => published.push(e) },
      checkpointStore,
    });

    expect(published.map((e) => e.id)).toEqual([1, 2]);
  });

  it('persists a checkpoint after each published event, resumable on a later run', async () => {
    const sessionRef = { harness: 'claude-code' as const, sessionKey: 'claude-code:s1', discoveredAt: 0 };
    const events = [event(1, 'claude-code:s1'), event(2, 'claude-code:s1'), event(3, 'claude-code:s1')];
    const checkpointStore = new InMemoryCheckpointStore();

    // First run: only the fake source's own generator matters, not real I/O.
    await ingestAgentActivity({
      source: new FakeActivitySource('claude-code', [{ session: sessionRef, events }]),
      publisher: { publish: () => {} },
      checkpointStore,
    });

    const checkpoint = await checkpointStore.load('claude-code:s1');
    expect(checkpoint).toEqual({ kind: 'seq', bySession: { 'claude-code:s1': 3 } });

    // Second run against a source with the SAME three events: resuming from the saved
    // checkpoint must publish nothing new.
    const publishedSecondRun: AgentEvent[] = [];
    await ingestAgentActivity({
      source: new FakeActivitySource('claude-code', [{ session: sessionRef, events }]),
      publisher: { publish: (e) => publishedSecondRun.push(e) },
      checkpointStore,
    });

    expect(publishedSecondRun).toEqual([]);
  });
});

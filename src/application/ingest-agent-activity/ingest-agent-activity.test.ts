import { describe, expect, it } from 'vitest';
import { FakeActivitySource } from '../../adapters/driven/fake/fake-activity-source';
import { InMemoryCheckpointStore } from '../../adapters/driven/checkpoint/in-memory-checkpoint-store';
import type { AgentEvent } from '../../domain/events/types';
import type { ActivitySource } from '../../ports/activity-source.port';
import { ingestAgentActivity } from './ingest-agent-activity';

function event(id: number, sessionKey: string): AgentEvent {
  return { id, kind: 'tool_start', harness: 'claude-code', sessionKey, at: id * 1000 };
}

// Requirement (tasks.md 5.2): wires an ActivitySource to the event bus (EventPublisher),
// persisting a checkpoint per published event so a restart resumes rather than replays
// (design.md: Bootstrap). Proves the port -> application -> bus seam with the fake source.
describe('ingestAgentActivity', () => {
  it('publishes every discovered session\'s events onto the bus in order', async () => {
    const sessionRef = { harness: 'claude-code' as const, sessionKey: 'claude-code:s1', cwd: null, discoveredAt: 0 };
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
    const sessionRef = { harness: 'claude-code' as const, sessionKey: 'claude-code:s1', cwd: null, discoveredAt: 0 };
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

  // Wiring the launch<->log correlator (composition-root follow-up): the correlator needs to
  // see every newly discovered session, harness-agnostically, without this generic use case
  // knowing anything about the launcher subsystem it feeds — this optional hook is the seam.
  it('calls the optional onSessionDiscovered hook once per discovered session, generically, with no launcher awareness', async () => {
    const sessionA = { harness: 'claude-code' as const, sessionKey: 'claude-code:a', cwd: '/Users/dev/project', discoveredAt: 5 };
    const sessionB = { harness: 'codex' as const, sessionKey: 'codex:b', cwd: null, discoveredAt: 9 };
    const source = new FakeActivitySource('claude-code', [
      { session: sessionA, events: [] },
      { session: sessionB, events: [] },
    ]);
    const discovered: Array<{ sessionKey: string; cwd: string | null; discoveredAt: number }> = [];

    await ingestAgentActivity({
      source,
      publisher: { publish: () => {} },
      checkpointStore: new InMemoryCheckpointStore(),
      onSessionDiscovered: (session) => discovered.push({ sessionKey: session.sessionKey, cwd: session.cwd, discoveredAt: session.discoveredAt }),
    });

    expect(discovered).toEqual([
      { sessionKey: 'claude-code:a', cwd: '/Users/dev/project', discoveredAt: 5 },
      { sessionKey: 'codex:b', cwd: null, discoveredAt: 9 },
    ]);
  });

  // Hard invariant (task spec): "A failed bind must degrade attribution only — ingestion must
  // never be affected." A throwing onSessionDiscovered hook is the sharpest version of "failed
  // bind": if this use case let it propagate, one bad correlation call would abort ingestion for
  // EVERY session discovered afterward, not just degrade one launch's attribution.
  it('a throwing onSessionDiscovered hook never aborts ingestion of that session or any other', async () => {
    const sessionA = { harness: 'claude-code' as const, sessionKey: 'claude-code:a', cwd: null, discoveredAt: 0 };
    const sessionB = { harness: 'claude-code' as const, sessionKey: 'claude-code:b', cwd: null, discoveredAt: 1 };
    const source = new FakeActivitySource('claude-code', [
      { session: sessionA, events: [event(1, 'claude-code:a')] },
      { session: sessionB, events: [event(2, 'claude-code:b')] },
    ]);
    const published: AgentEvent[] = [];

    await ingestAgentActivity({
      source,
      publisher: { publish: (e) => published.push(e) },
      checkpointStore: new InMemoryCheckpointStore(),
      onSessionDiscovered: () => {
        throw new Error('simulated correlator failure');
      },
    });

    expect(published.map((e) => e.id)).toEqual([1, 2]);
  });

  // browser-entrypoint work unit: a real live tailer's stream never completes on its own (it
  // stays open waiting for the next file write), so the original sequential `for await` loop
  // would block forever on the FIRST discovered session and never even open() a second one. A
  // real multi-session composition root needs every discovered session ingested concurrently.
  it('starts ingesting a later-discovered session without waiting for an earlier session\'s stream to complete', async () => {
    const sessionA = { harness: 'claude-code' as const, sessionKey: 'claude-code:a', cwd: null, discoveredAt: 0 };
    const sessionB = { harness: 'claude-code' as const, sessionKey: 'claude-code:b', cwd: null, discoveredAt: 1 };
    const published: AgentEvent[] = [];
    const checkpointStore = new InMemoryCheckpointStore();

    const source: ActivitySource = {
      harness: 'claude-code',
      async probe() {
        return { status: 'ready' };
      },
      async *discover() {
        yield sessionA;
        yield sessionB;
      },
      open(session) {
        if (session.sessionKey === 'claude-code:a') {
          return {
            // Session A's stream deliberately never completes, simulating a live tail that is
            // still waiting for the next file write.
            events: (async function* () {
              yield { event: event(1, 'claude-code:a'), checkpoint: { kind: 'seq', bySession: {} } };
              await new Promise<void>(() => {});
            })(),
            stop(): void {},
          };
        }
        return {
          events: (async function* () {
            yield { event: event(2, 'claude-code:b'), checkpoint: { kind: 'seq', bySession: {} } };
          })(),
          stop(): void {},
        };
      },
      async close() {},
    };

    // Deliberately not awaited: with a live session A stream open forever, awaiting the full
    // call would hang this test. The assertion instead proves session B was reached anyway.
    void ingestAgentActivity({ source, publisher: { publish: (e) => published.push(e) }, checkpointStore });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(published.map((e) => e.sessionKey)).toEqual(
      expect.arrayContaining(['claude-code:a', 'claude-code:b']),
    );
  });
});

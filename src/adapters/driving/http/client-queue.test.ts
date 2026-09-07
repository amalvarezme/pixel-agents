import { describe, expect, it } from 'vitest';
import { CLIENT_QUEUE_LIMIT, acknowledgeDesync, createClientQueueState, enqueueForClient } from './client-queue';
import type { AgentEvent } from '../../../domain/events/types';

function transientEvent(id: number, sessionKey = 'claude-code:s1'): AgentEvent {
  return { id, kind: 'message', harness: 'claude-code', sessionKey, at: id };
}

function statusEvent(id: number, sessionKey = 'claude-code:s1'): AgentEvent {
  return { id, kind: 'status', harness: 'claude-code', sessionKey, at: id };
}

function sessionStart(id: number, sessionKey: string): AgentEvent {
  return { id, kind: 'session_start', harness: 'claude-code', sessionKey, at: id };
}

describe('bounded per-client queue (tasks.md 9.3)', () => {
  it('accepts events under the limit without dropping anything', () => {
    let state = createClientQueueState();
    state = enqueueForClient(state, transientEvent(1));
    state = enqueueForClient(state, sessionStart(2, 'claude-code:s2'));

    expect(state.queue.map((e) => e.id)).toEqual([1, 2]);
    expect(state.desynced).toBe(false);
  });

  it('under pressure, coalesces stats/status events, keeping only the latest per session', () => {
    let state = createClientQueueState();
    // Fill the queue right up to the limit with unique state-defining filler events.
    for (let id = 1; id < CLIENT_QUEUE_LIMIT; id++) {
      state = enqueueForClient(state, sessionStart(id, `claude-code:filler${id}`));
    }
    // Two status updates for the same session already sitting in a full queue: the second
    // push crosses the limit, which is exactly the "under pressure" trigger for coalescing.
    state = enqueueForClient(state, statusEvent(CLIENT_QUEUE_LIMIT));
    state = enqueueForClient(state, statusEvent(CLIENT_QUEUE_LIMIT + 1));

    expect(state.queue.length).toBe(CLIENT_QUEUE_LIMIT);
    expect(state.queue.filter((e) => e.kind === 'status')).toHaveLength(1);
    expect(state.queue.find((e) => e.kind === 'status')?.id).toBe(CLIENT_QUEUE_LIMIT + 1);
    expect(state.desynced).toBe(false);
  });

  it('drops the oldest transient events first under pressure, keeping state-defining events', () => {
    let state = createClientQueueState();
    // Fill the queue to its limit with transient events, then one state-defining event.
    for (let id = 1; id <= CLIENT_QUEUE_LIMIT; id++) {
      state = enqueueForClient(state, transientEvent(id, `claude-code:s${id}`));
    }
    state = enqueueForClient(state, sessionStart(CLIENT_QUEUE_LIMIT + 1, 'claude-code:new'));

    expect(state.queue.length).toBeLessThanOrEqual(CLIENT_QUEUE_LIMIT);
    expect(state.desynced).toBe(false);
    // the state-defining event must have survived
    expect(state.queue.some((e) => e.id === CLIENT_QUEUE_LIMIT + 1)).toBe(true);
    // the oldest transient event must be the one dropped
    expect(state.queue.some((e) => e.id === 1)).toBe(false);
  });

  it('never drops a state-defining event: overflow of state-defining events alone marks the client desynced', () => {
    let state = createClientQueueState();
    for (let id = 1; id <= CLIENT_QUEUE_LIMIT + 5; id++) {
      state = enqueueForClient(state, sessionStart(id, `claude-code:s${id}`));
    }

    expect(state.desynced).toBe(true);
  });

  it('acknowledging a desync resets the client to an empty, non-desynced queue', () => {
    let state = createClientQueueState();
    for (let id = 1; id <= CLIENT_QUEUE_LIMIT + 1; id++) {
      state = enqueueForClient(state, sessionStart(id, `claude-code:s${id}`));
    }
    expect(state.desynced).toBe(true);

    state = acknowledgeDesync(state);

    expect(state).toEqual({ queue: [], desynced: false });
    state = enqueueForClient(state, transientEvent(9999));
    expect(state.queue.map((e) => e.id)).toEqual([9999]);
  });
});

import { describe, expect, it, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { FakeActivitySource } from '../../driven/fake/fake-activity-source';
import type { AgentEvent } from '../../../domain/events/types';
import { createStubStreamServer } from './stub-stream';

function event(id: number, sessionKey: string): AgentEvent {
  return { id, kind: 'tool_start', harness: 'claude-code', sessionKey, at: id * 1000 };
}

// Requirement (tasks.md 5.3): a stub HTTP endpoint (no real SSE yet) proving the
// port -> application -> bus seam compiles and RUNS — over an actual TCP/HTTP connection,
// not just an in-process function call. The real SSE server supersedes this in phase 9
// (slice 1b).
describe('stub stream HTTP endpoint (seam validation)', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('serves every scripted event as one ndjson line over a real HTTP GET /stream', async () => {
    const sessionRef = { harness: 'claude-code' as const, sessionKey: 'claude-code:s1', cwd: null, discoveredAt: 0 };
    const source = new FakeActivitySource('claude-code', [
      { session: sessionRef, events: [event(1, 'claude-code:s1'), event(2, 'claude-code:s1')] },
    ]);

    server = createStubStreamServer(source);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    const body = await response.text();
    const lines = body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as AgentEvent);

    expect(response.status).toBe(200);
    expect(lines.map((e) => e.id)).toEqual([1, 2]);
  });
});

import { describe, expect, it, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { AgentEvent } from '../../../domain/events/types';
import { createStreamServer, SseEventHub } from './stream';

function event(id: number, sessionKey = 'claude-code:s1'): AgentEvent {
  return { id, kind: 'tool_start', harness: 'claude-code', sessionKey, at: id * 1000 };
}

/** Incrementally reads SSE frames (blocks of text separated by a blank line) off one response body. */
class SseFrameReader {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  async readFrames(count: number, timeoutMs = 2000): Promise<string[]> {
    const frames: string[] = [];
    const deadline = Date.now() + timeoutMs;
    while (frames.length < count && Date.now() < deadline) {
      const { value, done } = await this.reader.read();
      if (done) break;
      this.buffer += this.decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
        frames.push(this.buffer.slice(0, idx));
        this.buffer = this.buffer.slice(idx + 2);
      }
    }
    return frames;
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

function parseFrame(frame: string): { id?: string; event?: string; data?: string; comment?: string } {
  const result: { id?: string; event?: string; data?: string; comment?: string } = {};
  for (const rawLine of frame.split('\n')) {
    if (rawLine.startsWith('id: ')) result.id = rawLine.slice(4);
    else if (rawLine.startsWith('event: ')) result.event = rawLine.slice(7);
    else if (rawLine.startsWith('data: ')) result.data = rawLine.slice(6);
    else if (rawLine.startsWith(':')) result.comment = rawLine.slice(1).trim();
  }
  return result;
}

describe('SSE stream server (tasks.md 9.1, 9.2, 9.4)', () => {
  let server: Server | null = null;
  let readers: SseFrameReader[] = [];

  afterEach(async () => {
    for (const reader of readers) await reader.close();
    readers = [];
    server?.close();
    server = null;
  });

  async function startServer(hub: SseEventHub): Promise<string> {
    server = createStreamServer(hub);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('serves GET /stream as text/event-stream and sends a snapshot frame on first connect', async () => {
    const hub = new SseEventHub();
    const baseUrl = await startServer(hub);

    const response = await fetch(`${baseUrl}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = new SseFrameReader(response);
    readers.push(reader);
    const [frame] = await reader.readFrames(1);
    expect(frame).toBeDefined();
    expect(parseFrame(frame!).event).toBe('snapshot');
  });

  it('delivers live events published after connecting, each carrying a monotonic id: field', async () => {
    const hub = new SseEventHub();
    const baseUrl = await startServer(hub);

    const response = await fetch(`${baseUrl}/stream`);
    const reader = new SseFrameReader(response);
    readers.push(reader);
    await reader.readFrames(1); // consume the initial snapshot frame

    hub.publish(event(1));
    hub.publish(event(2));

    const frames = (await reader.readFrames(2)).map(parseFrame);
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
    expect(JSON.parse(frames[0]!.data!).sessionKey).toBe('claude-code:s1');
  });

  it('reconnecting with a Last-Event-ID still inside the ring replays only events strictly after it', async () => {
    const hub = new SseEventHub();
    for (let id = 1; id <= 5; id++) hub.publish(event(id));
    const baseUrl = await startServer(hub);

    const response = await fetch(`${baseUrl}/stream`, { headers: { 'Last-Event-ID': '3' } });
    const reader = new SseFrameReader(response);
    readers.push(reader);

    const frames = (await reader.readFrames(2)).map(parseFrame);
    expect(frames.map((f) => f.id)).toEqual(['4', '5']);
    expect(frames.some((f) => f.event === 'snapshot')).toBe(false);
  });

  it('reconnecting with a Last-Event-ID evicted from the ring receives a snapshot frame instead', async () => {
    const hub = new SseEventHub({ ringCapacity: 2 });
    for (let id = 1; id <= 5; id++) hub.publish(event(id));
    const baseUrl = await startServer(hub);
    // capacity 2 retains ids [4,5]; id=1 was evicted long ago (a gap exists).

    const response = await fetch(`${baseUrl}/stream`, { headers: { 'Last-Event-ID': '1' } });
    const reader = new SseFrameReader(response);
    readers.push(reader);

    const [frame] = await reader.readFrames(1);
    expect(parseFrame(frame!).event).toBe('snapshot');
  });

  it('reconnecting with lastEventId as a QUERY PARAMETER (not a header) still resumes correctly', async () => {
    // browser-entrypoint work unit: a manually re-created browser `EventSource` cannot set the
    // `Last-Event-ID` header itself (that header is only sent by the browser's OWN automatic
    // retry) — our client-side reconnect adapter resumes via `?lastEventId=` instead.
    const hub = new SseEventHub();
    for (let id = 1; id <= 5; id++) hub.publish(event(id));
    const baseUrl = await startServer(hub);

    const response = await fetch(`${baseUrl}/stream?lastEventId=3`);
    const reader = new SseFrameReader(response);
    readers.push(reader);

    const frames = (await reader.readFrames(2)).map(parseFrame);
    expect(frames.map((f) => f.id)).toEqual(['4', '5']);
    expect(frames.some((f) => f.event === 'snapshot')).toBe(false);
  });

  it('a Last-Event-ID header takes precedence over a lastEventId query parameter when both are present', async () => {
    const hub = new SseEventHub();
    for (let id = 1; id <= 5; id++) hub.publish(event(id));
    const baseUrl = await startServer(hub);

    const response = await fetch(`${baseUrl}/stream?lastEventId=1`, { headers: { 'Last-Event-ID': '3' } });
    const reader = new SseFrameReader(response);
    readers.push(reader);

    const frames = (await reader.readFrames(2)).map(parseFrame);
    expect(frames.map((f) => f.id)).toEqual(['4', '5']);
  });

  it('emits a heartbeat comment on the configured interval so idle connections stay alive', async () => {
    const hub = new SseEventHub({ heartbeatIntervalMs: 15 });
    const baseUrl = await startServer(hub);

    const response = await fetch(`${baseUrl}/stream`);
    const reader = new SseFrameReader(response);
    readers.push(reader);
    await reader.readFrames(1); // snapshot frame first

    const [heartbeatFrame] = await reader.readFrames(1, 500);
    expect(parseFrame(heartbeatFrame!).comment).toBe('heartbeat');
  });

  // tasks.md 26.1: POST /launch is routed on the SAME server as GET /stream (design.md D2).
  it('routes POST /launch to the injected launcher when one is supplied', async () => {
    const hub = new SseEventHub();
    const launcher = { launch: async () => ({ outcome: 'started' as const, launchId: 'l1', pid: 1, startedAt: 0 }), shutdown: async () => {} };
    server = createStreamServer(hub, launcher);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness: 'claude-code', cwd: '/tmp', args: [] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'started', launchId: 'l1', pid: 1, startedAt: 0 });
  });

  it('still 404s /launch when no launcher was supplied (adversarial near-miss: backward compatibility)', async () => {
    const hub = new SseEventHub();
    const baseUrl = await startServer(hub);

    const response = await fetch(`${baseUrl}/launch`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(404);
  });
});

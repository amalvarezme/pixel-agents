import { describe, expect, it, afterEach } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AgentEvent } from '../../../domain/events/types';
import { createStreamServer, SseEventHub } from './stream';

function event(id: number, sessionKey = 'claude-code:s1'): AgentEvent {
  return { id, kind: 'tool_start', harness: 'claude-code', sessionKey, at: id * 1000 };
}

function sessionStart(id: number, sessionKey: string): AgentEvent {
  return { id, kind: 'session_start', harness: 'claude-code', sessionKey, at: id };
}

function memoryWrite(id: number, sessionKey: string): AgentEvent {
  return { id, kind: 'memory_write', harness: 'claude-code', sessionKey, at: id, toolLabel: 'mem_save' };
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
  let tempRoots: string[] = [];

  afterEach(async () => {
    for (const reader of readers) await reader.close();
    readers = [];
    server?.close();
    server = null;
    for (const root of tempRoots) await rm(root, { recursive: true, force: true });
    tempRoots = [];
  });

  async function startServer(hub: SseEventHub): Promise<string> {
    server = createStreamServer(hub);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function startStaticServer(hub: SseEventHub, staticRoot: string): Promise<string> {
    server = createStreamServer(hub, undefined, { staticRoot });
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

  // G.1: "A client connecting AFTER memory_write events have been ingested sees the workers but
  // Archived: 0." The snapshot frame must carry archive state, not just workers.
  it('a client connecting AFTER memory_write events were ingested receives a NON-ZERO archive count in the snapshot', async () => {
    const hub = new SseEventHub();
    hub.publish(sessionStart(1, 'claude-code:s1'));
    hub.publish(sessionStart(2, 'claude-code:s2'));
    hub.publish(sessionStart(3, 'claude-code:s3'));
    hub.publish(memoryWrite(4, 'claude-code:s1'));
    hub.publish(memoryWrite(5, 'claude-code:s2'));
    hub.publish(memoryWrite(6, 'claude-code:s3'));

    const baseUrl = await startServer(hub);
    const response = await fetch(`${baseUrl}/stream`);
    const reader = new SseFrameReader(response);
    readers.push(reader);

    const [frame] = await reader.readFrames(1);
    const parsed = parseFrame(frame!);
    expect(parsed.event).toBe('snapshot');
    const snapshot = JSON.parse(parsed.data!);

    const dockedCount = snapshot.archive.slots.filter((s: { occupiedBySessionKey: string | null }) => s.occupiedBySessionKey !== null).length;
    expect(dockedCount).toBe(3); // deliberately not 0, not 1 — cannot pass by accident
    expect(snapshot.carryQueues.find((entry: { sessionKey: string }) => entry.sessionKey === 'claude-code:s1')?.queue.held).toMatchObject({
      count: 1,
    });
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

  /**
   * Slice 1 (odd/tasks/office-mcp.md "one process, one command"): the Node server must serve the
   * built UI from the SAME ORIGIN as `/stream`, so the office no longer needs a second Vite
   * process. Pure `node:fs` + `node:http` — no static-file dependency.
   */
  describe('static UI serving (slice 1)', () => {
    const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const WOFF2_BYTES = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);

    interface StaticFixture {
      /** The vite `dist/` equivalent: what the server is told its static root is. */
      root: string;
      /** The temp dir CONTAINING the root — anything here is "outside the static root". */
      outside: string;
    }

    async function makeStaticFixture(): Promise<StaticFixture> {
      const outside = await mkdtemp(join(tmpdir(), 'office-static-'));
      tempRoots.push(outside);
      const root = join(outside, 'dist');
      await mkdir(join(root, 'assets'), { recursive: true });
      await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>office</title></head><body></body></html>');
      await writeFile(join(root, 'assets', 'app-abc123.js'), "console.log('office');\n");
      await writeFile(join(root, 'assets', 'app-abc123.css'), 'body{color:red}\n');
      await writeFile(join(root, 'assets', 'logo.png'), PNG_BYTES);
      await writeFile(join(root, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      await writeFile(join(root, 'assets', 'font.woff2'), WOFF2_BYTES);
      await writeFile(join(root, 'data.json'), '{"ok":true}');
      // The traversal guard's canary, deliberately OUTSIDE the static root.
      await writeFile(join(outside, 'package.json'), '{"secret":"do-not-serve"}');
      return { root, outside };
    }

    /**
     * Sends a request line BYTE-FOR-BYTE over a raw socket. `fetch()` (undici) normalises `..`
     * client-side before the bytes ever leave the process, so it cannot exercise the bytes the
     * handler actually receives. This helper is the only way to test the traversal guard on the
     * real input.
     */
    function rawHttpGet(baseUrl: string, rawTarget: string): Promise<{ status: number; contentType: string; body: string }> {
      const port = Number(new URL(baseUrl).port);
      return new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(`GET ${rawTarget} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        let raw = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => (raw += chunk));
        socket.on('error', reject);
        socket.on('end', () => {
          const [head = '', ...bodyParts] = raw.split('\r\n\r\n');
          const lines = head.split('\r\n');
          const status = Number(lines[0]?.split(' ')[1] ?? 0);
          const contentType = lines.find((l) => l.toLowerCase().startsWith('content-type:'))?.slice(13).trim() ?? '';
          resolve({ status, contentType, body: bodyParts.join('\r\n\r\n') });
        });
      });
    }

    it('serves GET / as index.html with text/html', async () => {
      const { root } = await makeStaticFixture();
      const baseUrl = await startStaticServer(new SseEventHub(), root);

      const response = await fetch(`${baseUrl}/`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      await expect(response.text()).resolves.toContain('<title>office</title>');
    });

    it('serves a real built asset with its correct content type', async () => {
      const { root } = await makeStaticFixture();
      const baseUrl = await startStaticServer(new SseEventHub(), root);

      const js = await fetch(`${baseUrl}/assets/app-abc123.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toContain('javascript');
      await expect(js.text()).resolves.toBe("console.log('office');\n");

      const css = await fetch(`${baseUrl}/assets/app-abc123.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get('content-type')).toContain('text/css');

      const json = await fetch(`${baseUrl}/data.json`);
      expect(json.status).toBe(200);
      expect(json.headers.get('content-type')).toContain('application/json');

      const svg = await fetch(`${baseUrl}/assets/icon.svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-type')).toContain('image/svg+xml');

      const png = await fetch(`${baseUrl}/assets/logo.png`);
      expect(png.status).toBe(200);
      expect(png.headers.get('content-type')).toContain('image/png');
      expect(Buffer.from(await png.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

      const woff2 = await fetch(`${baseUrl}/assets/font.woff2`);
      expect(woff2.status).toBe(200);
      expect(woff2.headers.get('content-type')).toContain('font/woff2');
    });

    it('falls back to index.html for an unknown NON-asset path so a client-side route still loads', async () => {
      const { root } = await makeStaticFixture();
      const baseUrl = await startStaticServer(new SseEventHub(), root);

      const response = await fetch(`${baseUrl}/office/session/abc`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      await expect(response.text()).resolves.toContain('<title>office</title>');
    });

    it('404s a MISSING asset instead of answering it with index.html (a <script src> must not receive HTML)', async () => {
      const { root } = await makeStaticFixture();
      const baseUrl = await startStaticServer(new SseEventHub(), root);

      const response = await fetch(`${baseUrl}/assets/missing-xyz.js`);

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.not.toContain('<title>office</title>');
    });

    // The one security requirement of the slice. Node's http layer hands the handler the RAW
    // request-target (`/..%2fpackage.json` arrives verbatim), and `new URL(...).pathname` collapses
    // a literal `../` but NOT `%2f`, so the guard must decode and then re-check containment against
    // the root. Removing the guard serves `<root>/../package.json` — this test is the pin.
    it('refuses a URL-encoded traversal attempt that would escape the static root', async () => {
      const { root } = await makeStaticFixture();
      const baseUrl = await startStaticServer(new SseEventHub(), root);

      const response = await rawHttpGet(baseUrl, '/..%2fpackage.json');

      expect(response.body).not.toContain('do-not-serve');
      expect(response.status).toBe(404);
      expect(response.status).not.toBe(200);
    });

    it('refuses a literal /../ traversal too (Node normalises it before the handler; pin the bytes actually received)', async () => {
      const { root } = await makeStaticFixture();
      const baseUrl = await startStaticServer(new SseEventHub(), root);

      // The raw bytes are '/../package.json'. `new URL(...).pathname` collapses the dot-segment to
      // '/package.json', which resolves INSIDE the root and does not exist -> 404. Either way the
      // canary outside the root is never read.
      const response = await rawHttpGet(baseUrl, '/../package.json');

      expect(response.status).toBe(404);
      expect(response.body).not.toContain('do-not-serve');
    });

    it('does not fall back to index.html for a traversal attempt (the SPA fallback must not absorb it)', async () => {
      const { root } = await makeStaticFixture();
      const baseUrl = await startStaticServer(new SseEventHub(), root);

      const response = await rawHttpGet(baseUrl, '/..%2fpackage.json');

      expect(response.status).toBe(404);
      expect(response.body).not.toContain('<title>office</title>');
    });

    it('degrades to the previous 404 behaviour when the static root does not exist', async () => {
      const { outside } = await makeStaticFixture();
      const baseUrl = await startStaticServer(new SseEventHub(), join(outside, 'dist-does-not-exist'));

      const response = await fetch(`${baseUrl}/`);

      expect(response.status).toBe(404);
    });

    it('serves no static files at all when no static root is configured (previous behaviour preserved)', async () => {
      const { root } = await makeStaticFixture();
      const hub = new SseEventHub();
      const baseUrl = await startServer(hub);

      const response = await fetch(`${baseUrl}/`);

      expect(response.status).toBe(404);
      expect(root).toBeDefined(); // fixture built; the server simply was not told about it
    });

    it('does not shadow or pre-empt /stream or /launch when a static root is configured', async () => {
      const { root } = await makeStaticFixture();
      const hub = new SseEventHub();
      const launcher = { launch: async () => ({ outcome: 'started' as const, launchId: 'l1', pid: 1, startedAt: 0 }), shutdown: async () => {} };
      server = createStreamServer(hub, launcher, { staticRoot: root });
      await new Promise<void>((resolve) => server!.listen(0, resolve));
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      // /stream is still the SSE route.
      const stream = await fetch(`${baseUrl}/stream`);
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const reader = new SseFrameReader(stream);
      readers.push(reader);
      const [frame] = await reader.readFrames(1);
      expect(parseFrame(frame!).event).toBe('snapshot');

      // POST /launch still reaches the launcher (and does not get index.html).
      const launch = await fetch(`${baseUrl}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'claude-code', cwd: '/tmp', args: [] }),
      });
      expect(launch.status).toBe(200);
      await expect(launch.json()).resolves.toEqual({ outcome: 'started', launchId: 'l1', pid: 1, startedAt: 0 });

      // GET /launch is not an SPA route either: it stays a 404, never index.html.
      const wrongMethod = await fetch(`${baseUrl}/launch`);
      expect(wrongMethod.status).toBe(404);
      await expect(wrongMethod.text()).resolves.not.toContain('<title>office</title>');
    });
  });
});

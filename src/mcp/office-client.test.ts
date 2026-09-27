/**
 * Slice 2 (odd/tasks/office-mcp.md): the localhost HTTP client used by the office tools. It is the
 * ONLY way this server talks to the visualizer, which is deliberate — `office_launch` must reach
 * `POST /launch` so the Zero-Injection denylist and its validation are reused verbatim rather than
 * re-implemented, and `office_snapshot` must read the real `event: snapshot` frame.
 *
 * The port probe is the load-bearing piece: `src/server.ts` has no `EADDRINUSE` handling, so a
 * second start on a busy port would crash. `probe` must tell "free" from "ours" from "foreign"
 * BEFORE anything is spawned.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOfficeHttpClient } from './office-client';

const HOST = '127.0.0.1';
const servers: Server[] = [];

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ baseUrl: string; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, HOST, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://${HOST}:${port}`, port });
    });
  });
}

async function findFreePortForTest(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, HOST, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // A probe/reader test may leave a connection half-open deliberately; close it so the
          // suite does not wait on a socket that will never end on its own.
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('office HTTP client (slice 2)', () => {
  it('probe reports "free" for a port nothing is listening on', async () => {
    const client = createOfficeHttpClient();
    const freePort = await findFreePortForTest();

    await expect(client.probe(freePort, 1000)).resolves.toBe('free');
  });

  it('probe reports "ours" when the port answers /stream with text/event-stream', async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: snapshot\ndata: {"generatedAt":1,"workers":[],"archive":{"slots":[]},"carryQueues":[]}\n\n');
    });
    const client = createOfficeHttpClient();

    await expect(client.probe(port, 1000)).resolves.toBe('ours');
  });

  it('probe reports "foreign" when the port answers HTTP with a different content type', async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"hello":"world"}');
    });
    const client = createOfficeHttpClient();

    await expect(client.probe(port, 1000)).resolves.toBe('foreign');
  });

  it('probe reports "foreign" when the port accepts the request but never answers (unknown peer)', async () => {
    // A listener that accepts the socket but never speaks HTTP: a timeout must degrade to
    // "foreign", never hang the caller forever.
    const { port } = await startServer(() => {
      // Deliberately never write a response.
    });
    const client = createOfficeHttpClient();

    await expect(client.probe(port, 300)).resolves.toBe('foreign');
  });

  it('readSnapshot reads the FIRST snapshot frame, parses it, and does not wait for more', async () => {
    const snapshot = {
      generatedAt: 42,
      workers: [{ sessionKey: 'claude-code:s1', harness: 'claude-code', label: 's1', activity: 'working', parentSessionKey: null }],
      archive: { slots: [], waitQueue: [], nextSlotCursor: 0 },
      carryQueues: [],
    };
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      // Deliberately keep the connection open afterwards: the client must resolve on the frame,
      // not on the stream closing.
    });
    const client = createOfficeHttpClient();

    const result = await client.readSnapshot(baseUrl, 2000);
    expect(result.generatedAt).toBe(42);
    expect(result.workers[0]!.sessionKey).toBe('claude-code:s1');
  });

  it('readSnapshot rejects within the timeout when no snapshot frame ever arrives', async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
    });
    const client = createOfficeHttpClient();

    await expect(client.readSnapshot(baseUrl, 250)).rejects.toThrow(/timed out|timeout/i);
  });

  it('readSnapshot rejects when the port answers a non-200 status', async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const client = createOfficeHttpClient();

    await expect(client.readSnapshot(baseUrl, 1000)).rejects.toThrow(/404/);
  });

  it('postLaunch proxies POST /launch verbatim and returns the status and parsed body', async () => {
    let received = '';
    const { baseUrl } = await startServer((req, res) => {
      req.on('data', (chunk: Buffer) => (received += chunk.toString('utf8')));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outcome: 'started', launchId: 'l1' }));
      });
    });
    const client = createOfficeHttpClient();

    const result = await client.postLaunch(baseUrl, { harness: 'claude-code', cwd: '/tmp/work', args: ['-p', 'hi'] }, 1000);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ outcome: 'started', launchId: 'l1' });
    expect(JSON.parse(received)).toEqual({ harness: 'claude-code', cwd: '/tmp/work', args: ['-p', 'hi'] });
  });

  it('findFreePort returns a port that can then actually be bound', async () => {
    const client = createOfficeHttpClient();
    const port = await client.findFreePort();
    expect(port).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.on('error', reject);
      probe.listen(port, HOST, () => probe.close(() => resolve()));
    });
  });
});

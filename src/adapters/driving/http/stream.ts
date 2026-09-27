/**
 * The real SSE server (tasks.md Phase 9, design.md D2: "SSE with snapshot-or-replay resume, not
 * WebSocket"). Supersedes the Phase 5 seam-validation stub (`stub-stream.ts`).
 *
 * `GET /stream` as `text/event-stream`, one monotonic `id:` per event (ids are allocated
 * upstream by the ingestion adapters/application, never here — this hub is a multiplexer, not an
 * id source), and a 15s heartbeat comment so idle proxies don't time the connection out.
 *
 * Resume semantics on `Last-Event-ID`: replay `(k, now]` when `k` is still resolvable inside the
 * ring buffer (`ring-buffer.ts`), otherwise send one `snapshot` frame — the current
 * `OfficeSnapshot` projection (`domain/office/office.ts`'s `applyEventToOfficeState`), not
 * history. Backpressure per client is delegated to `client-queue.ts`; a desynced client receives
 * one `snapshot_required` frame instead of a silently-corrupted partial backlog.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { AgentEvent } from '../../../domain/events/types';
import type { EventPublisher } from '../../../ports/event-publisher.port';
import type { SessionLauncher } from '../../../ports/session-launcher.port';
import {
  applyEventToOfficeState,
  createOfficeState,
  serializeOfficeState,
  type OfficeSnapshotState,
  type OfficeState,
} from '../../../domain/office/office';
import { appendToRing, createRingBuffer, planReplay, RING_CAPACITY, type RingBuffer } from './ring-buffer';
import { acknowledgeDesync, createClientQueueState, enqueueForClient, type ClientQueueState } from './client-queue';
import { handleLaunchRequest } from './launch';

export const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_COMMENT = ': heartbeat\n\n';

/**
 * G.1 fix: a resume `snapshot` must let a late-connecting or evicted client reconstruct FULL
 * office state, not just workers — Phase 9.2 built this frame precisely so archive count and
 * in-flight carries survive a reconnect. `OfficeSnapshotState` (domain/office/office.ts) is
 * already the JSON-safe wire shape (its `carryQueues` is an array of entries, not a `Map`, since
 * `JSON.stringify` on a `Map` silently produces `{}`), so this frame only adds `generatedAt`.
 */
export interface OfficeSnapshot extends OfficeSnapshotState {
  generatedAt: number;
}

function buildSnapshot(state: OfficeState): OfficeSnapshot {
  return { generatedAt: Date.now(), ...serializeOfficeState(state) };
}

function formatEventFrame(event: AgentEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function formatNamedFrame(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Owns one client's bounded queue and its underlying `ServerResponse` writability. */
class SseClient {
  private queueState: ClientQueueState = createClientQueueState();
  private writable = true;

  constructor(private readonly res: ServerResponse) {
    res.on('drain', () => {
      this.writable = true;
      this.flush();
    });
  }

  sendSnapshot(snapshot: OfficeSnapshot): void {
    this.res.write(formatNamedFrame('snapshot', snapshot));
  }

  deliver(event: AgentEvent): void {
    this.queueState = enqueueForClient(this.queueState, event);
    this.flush();
  }

  heartbeat(): void {
    this.res.write(HEARTBEAT_COMMENT);
  }

  private flush(): void {
    if (this.queueState.desynced) {
      this.res.write(formatNamedFrame('snapshot_required', {}));
      this.queueState = acknowledgeDesync(this.queueState);
      return;
    }
    while (this.writable && this.queueState.queue.length > 0) {
      const [next, ...rest] = this.queueState.queue;
      this.queueState = { ...this.queueState, queue: rest };
      if (next) this.writable = this.res.write(formatEventFrame(next));
    }
  }
}

export interface SseEventHubOptions {
  ringCapacity?: number;
  heartbeatIntervalMs?: number;
}

/**
 * Multiplexes one `EventPublisher.publish` stream to every connected SSE client, each with its
 * own bounded delivery queue, backed by one shared ring buffer for resume.
 */
export class SseEventHub implements EventPublisher {
  private ring: RingBuffer;
  private officeState: OfficeState = createOfficeState();
  private readonly clients = new Set<SseClient>();
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: SseEventHubOptions = {}) {
    this.ring = createRingBuffer(options.ringCapacity ?? RING_CAPACITY);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  publish(event: AgentEvent): void {
    this.ring = appendToRing(this.ring, event);
    this.officeState = applyEventToOfficeState(this.officeState, event);
    for (const client of this.clients) client.deliver(event);
  }

  handleStreamRequest(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const client = new SseClient(res);
    this.clients.add(client);
    this.ensureHeartbeat();

    const lastEventId = parseLastEventId(req);
    const plan = planReplay(this.ring, lastEventId);
    if (plan.status === 'snapshot') {
      client.sendSnapshot(buildSnapshot(this.officeState));
    } else {
      for (const event of plan.events) client.deliver(event);
    }

    req.on('close', () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stopHeartbeat();
    });
  }

  clientCount(): number {
    return this.clients.size;
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) client.heartbeat();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

/**
 * Resolves the resume id from either the standard `Last-Event-ID` header (sent automatically by
 * the browser's own native retry) or a `?lastEventId=` query parameter (browser-entrypoint work
 * unit: a manually re-created `EventSource` — used for our own backoff-controlled reconnect,
 * `adapters/driving/browser/event-source-stream-connection.ts` — cannot set that header itself).
 * The header wins when both are present.
 */
function parseLastEventId(req: IncomingMessage): number | null {
  const header = req.headers['last-event-id'];
  const rawHeader = Array.isArray(header) ? header[0] : header;
  if (rawHeader) {
    const parsed = Number(rawHeader);
    if (Number.isFinite(parsed)) return parsed;
  }

  const rawQuery = new URL(req.url ?? '/', 'http://localhost').searchParams.get('lastEventId');
  if (!rawQuery) return null;
  const parsed = Number(rawQuery);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * MIME types for the built UI. Extension keyed because Vite fingerprints asset filenames
 * (`assets/index-<hash>.js`), so the extension is the only stable thing to dispatch on. Covers
 * every extension `vite build` emits for this project plus the common font/image formats; anything
 * unknown is served as `application/octet-stream` rather than guessed.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StreamServerOptions {
  /**
   * Absolute path to the built UI root (Vite's `dist/`). Omitted, or pointing at a directory that
   * does not exist, means NO static branch at all: every unknown path 404s exactly as it did before
   * this option existed (a missing build degrades to the previous behaviour instead of crashing).
   */
  staticRoot?: string;
}

/**
 * Maps a request pathname onto a real path under `root`, or `null` when the path must NOT be
 * resolved at all (escapes the root, malformed percent-encoding, or an embedded NUL).
 *
 * This containment check is the one security requirement of the static branch. Node's HTTP layer
 * hands the handler the RAW request-target — a raw-socket `GET /..%2fpackage.json` arrives verbatim
 * — and `new URL(...).pathname` collapses a literal `../` but leaves `%2f` alone. So the path is
 * decoded first and the RESOLVED ABSOLUTE path is then re-checked against the root: without that
 * check, `%2f`-encoded dot-segments would read any file the process can reach.
 */
function resolveWithinRoot(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

/** Reads a file, treating EVERY failure (missing, a directory, permissions) as "not this file". */
async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

function respondWithFile(res: ServerResponse, filePath: string, body: Buffer): void {
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
  });
  res.end(body);
}

function respondNotFound(res: ServerResponse): void {
  res.writeHead(404);
  res.end();
}

/**
 * Serves one GET from the built UI. Policy, pinned by `stream.test.ts`'s "static UI serving":
 *
 *  1. The exact file wins (`/` -> `index.html`).
 *  2. A path that does not exist and HAS a file extension (`.js`, `.json`, ...) is a 404, never
 *     `index.html` — handing HTML to a `<script src>` would surface as a MIME error instead of an
 *     honest missing-asset 404.
 *  3. A path that does not exist and has NO extension falls back to `index.html`, so a client-side
 *     route (`/office/session/abc`) still loads.
 *  4. A traversal attempt is refused with a 404 and NEVER falls back: the fallback would otherwise
 *     absorb the attempt into a 200, hiding it.
 */
async function serveStatic(res: ServerResponse, root: string, pathname: string): Promise<void> {
  const candidate = resolveWithinRoot(root, pathname);
  if (candidate === null) {
    respondNotFound(res);
    return;
  }

  const target = pathname.endsWith('/') ? join(candidate, 'index.html') : candidate;
  const body = await readFileOrNull(target);
  if (body) {
    respondWithFile(res, target, body);
    return;
  }

  if (extname(candidate) !== '') {
    respondNotFound(res);
    return;
  }

  const index = await readFileOrNull(join(root, 'index.html'));
  if (index) {
    respondWithFile(res, join(root, 'index.html'), index);
    return;
  }

  respondNotFound(res);
}

/**
 * `launcher` is optional (tasks.md 26.1, design.md D2: "Launch is `POST /launch`, not a socket
 * frame") — every existing caller that never wires a launcher keeps getting a 404 on `/launch`,
 * exactly as before this route existed.
 *
 * `options.staticRoot` adds slice 1 (odd/tasks/office-mcp.md) WITHOUT touching either API route:
 * `/stream` and `/launch` are matched first and return before the static branch, and `/launch`
 * keeps its previous 404 for every shape that is not an accepted `POST`.
 */
export function createStreamServer(hub: SseEventHub, launcher?: SessionLauncher, options: StreamServerOptions = {}): Server {
  const staticRoot = options.staticRoot ? resolve(options.staticRoot) : null;
  return createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/stream') {
      hub.handleStreamRequest(req, res);
      return;
    }
    if (pathname === '/launch') {
      if (req.method === 'POST' && launcher) {
        void handleLaunchRequest(req, res, launcher);
        return;
      }
      respondNotFound(res);
      return;
    }
    if (staticRoot && req.method === 'GET') {
      // `void` + catch for the same reason the launch route has one: an unhandled rejection here
      // would take the whole process down, and this route is reachable by any local client.
      void serveStatic(res, staticRoot, pathname).catch(() => {
        if (!res.headersSent) respondNotFound(res);
        else res.end();
      });
      return;
    }
    respondNotFound(res);
  });
}

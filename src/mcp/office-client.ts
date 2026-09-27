/**
 * Slice 2 (odd/tasks/office-mcp.md): the localhost HTTP client the office tools use to reach the
 * running visualizer. Everything the MCP server knows about the office comes through here, which
 * is what keeps the protocol layer free of `node:http` and — more importantly — what makes
 * `office_launch` a genuine proxy: it hits `POST /launch` and lets the server's own Zero-Injection
 * denylist and validation run, rather than re-implementing either.
 *
 * Nothing in this module ever imports another adapter. The SSE frame shape and the launch route
 * contract are consumed as wire bytes, so the slice-1 changes to `stream.ts`/`launch.ts` remain
 * the single source of truth for both.
 */
import { get as httpGet, request as httpRequest } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import type { OfficeSnapshotState } from '../domain/office/office';
import type { LaunchSpec } from '../ports/session-launcher.port';

/** The visualizer binds loopback only. The MCP server reaches the office the same way a browser does. */
export const OFFICE_HOST = '127.0.0.1';

/**
 * What a port probe can conclude:
 *  - `free`    — nothing is listening (a start may spawn there);
 *  - `ours`    — the office visualizer is already answering (an idempotent start returns it);
 *  - `foreign` — something ELSE holds the port (choose a free port; never spawn into a crash).
 */
export type PortProbe = 'free' | 'ours' | 'foreign';

/** The `event: snapshot` frame's `data` payload, exactly as `stream.ts` builds it. */
export interface OfficeSnapshot extends OfficeSnapshotState {
  generatedAt: number;
}

export interface LaunchProxyResult {
  status: number;
  body: unknown;
}

export interface OfficeHttpClient {
  probe(port: number, timeoutMs?: number): Promise<PortProbe>;
  findFreePort(): Promise<number>;
  readSnapshot(baseUrl: string, timeoutMs?: number): Promise<OfficeSnapshot>;
  postLaunch(baseUrl: string, spec: LaunchSpec, timeoutMs?: number): Promise<LaunchProxyResult>;
}

function parseSseFrame(frame: string): { event?: string; data?: string } {
  const result: { event?: string; data?: string } = {};
  for (const rawLine of frame.split('\n')) {
    if (rawLine.startsWith('event:')) result.event = rawLine.slice(6).trim();
    else if (rawLine.startsWith('data:')) {
      const value = rawLine.slice(5).replace(/^ /, '');
      result.data = result.data === undefined ? value : `${result.data}\n${value}`;
    }
  }
  return result;
}

export function createOfficeHttpClient(): OfficeHttpClient {
  return {
    probe(port: number, timeoutMs = 1000): Promise<PortProbe> {
      return new Promise<PortProbe>((resolve) => {
        let settled = false;
        const settle = (value: PortProbe): void => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const req = httpGet(
          { host: OFFICE_HOST, port, path: '/stream', headers: { accept: 'text/event-stream' } },
          (res) => {
            const contentType = String(res.headers['content-type'] ?? '');
            // Headers are all the probe needs: never hold the event stream open.
            res.destroy();
            settle(contentType.includes('text/event-stream') ? 'ours' : 'foreign');
          },
        );
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          settle('foreign');
        });
        req.on('error', (error) => {
          settle((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'free' : 'foreign');
        });
      });
    },

    findFreePort(): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const server = createNetServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, OFFICE_HOST, () => {
          const { port } = server.address() as AddressInfo;
          server.close(() => resolve(port));
        });
      });
    },

    readSnapshot(baseUrl: string, timeoutMs = 4000): Promise<OfficeSnapshot> {
      return new Promise<OfficeSnapshot>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const settle = (action: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          req.destroy();
          action();
        };
        const req = httpGet(`${baseUrl}/stream`, { headers: { accept: 'text/event-stream' } }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            settle(() => reject(new Error(`office /stream responded ${res.statusCode}`)));
            return;
          }
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let index: number;
            while ((index = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const parsedFrame = parseSseFrame(frame);
              if (parsedFrame.event !== 'snapshot') continue;
              try {
                const snapshot = JSON.parse(parsedFrame.data ?? '') as OfficeSnapshot;
                settle(() => resolve(snapshot));
              } catch (error) {
                settle(() => reject(new Error(`office snapshot frame was not valid JSON: ${String(error)}`)));
              }
              return;
            }
          });
          res.on('error', (error) => settle(() => reject(error)));
        });
        timer = setTimeout(() => settle(() => reject(new Error(`office /stream timed out after ${timeoutMs}ms`))), timeoutMs);
        req.on('error', (error) => settle(() => reject(error)));
      });
    },

    postLaunch(baseUrl: string, spec: LaunchSpec, timeoutMs = 5000): Promise<LaunchProxyResult> {
      return new Promise<LaunchProxyResult>((resolve, reject) => {
        const payload = JSON.stringify(spec);
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const settle = (action: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          action();
        };
        const req = httpRequest(
          `${baseUrl}/launch`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (text += chunk));
            res.on('end', () => {
              let body: unknown = text;
              try {
                body = JSON.parse(text);
              } catch {
                // Keep the raw body: an honest proxy reports exactly what the server said.
              }
              settle(() => resolve({ status: res.statusCode ?? 0, body }));
            });
            res.on('error', (error) => settle(() => reject(error)));
          },
        );
        timer = setTimeout(() => settle(() => reject(new Error(`office /launch timed out after ${timeoutMs}ms`))), timeoutMs);
        req.on('error', (error) => settle(() => reject(error)));
        req.write(payload);
        req.end();
      });
    },
  };
}

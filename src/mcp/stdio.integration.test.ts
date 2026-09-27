/**
 * Slice 2 (odd/tasks/office-mcp.md): the real end-to-end handshake, driven EXACTLY as an MCP
 * client drives it — the stdio server is launched as a child process, `initialize` is written to
 * its stdin and the response read from its stdout, then `tools/list`, `tools/call office_status`,
 * `office_start` and `office_snapshot` against a FREE port.
 *
 * Three traps are proven here rather than argued:
 *  1. stdout IS the protocol — every raw stdout line must be JSON, and the visualizer's startup
 *     banner must land in the log file instead (asserted by reading the log file).
 *  2. a stdio MCP dies with its client — closing stdin stops the managed office (asserted by
 *     watching the visualizer's port go free).
 *  3. nothing is left holding the port.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfficeHttpClient } from './office-client';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VITE_NODE = join(PROJECT_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');
const HOST = '127.0.0.1';

function findFreePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, HOST, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForPortFree(port: number, timeoutMs = 8000): Promise<boolean> {
  const client = createOfficeHttpClient();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await client.probe(port, 500)) === 'free') return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  return false;
}

interface Pending {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/** A minimal newline-delimited JSON-RPC client, exactly the shape a real MCP client speaks. */
class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutLines: string[] = [];
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private nextId = 1;
  stderr = '';

  constructor(options: { officePort: number; logPath: string }) {
    this.child = spawn(process.execPath, [VITE_NODE, 'src/mcp/stdio.ts'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        OFFICE_PORT: String(options.officePort),
        OFFICE_MCP_LOG: options.logPath,
        CLAUDE_CODE_ENABLED: 'false',
        CODEX_ENABLED: 'false',
        OPENCODE_ENABLED: 'false',
        ANTIGRAVITY_ENABLED: 'false',
        PI_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => (this.stderr += chunk));
    this.child.on('exit', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('mcp process exited'));
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim() === '') continue;
      this.stdoutLines.push(line);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // A non-JSON line is recorded in `stdoutLines` and fails the purity assertion.
      }
      const id = message.id;
      if (typeof id === 'number') {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.resolve(message);
        }
      }
    }
  }

  request(method: string, params?: unknown, timeoutMs = 30000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return Promise.race([
      promise,
      new Promise<Record<string, unknown>>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs),
      ),
    ]);
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  rawStdoutLines(): string[] {
    return this.stdoutLines;
  }

  async closeStdin(): Promise<void> {
    this.child.stdin.end();
    await Promise.race([once(this.child, 'exit'), new Promise((resolveDelay) => setTimeout(resolveDelay, 8000))]);
  }

  kill(): void {
    if (!this.child.killed) this.child.kill('SIGKILL');
  }
}

function payloadOf(response: Record<string, unknown>): unknown {
  const result = response.result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

const clients: McpStdioClient[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.kill();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('office MCP end-to-end handshake (slice 2)', () => {
  it(
    'initializes, lists tools, starts the office on a free port, snapshots it, and stops it — with a clean protocol stream',
    async () => {
      const officePort = await findFreePort();
      const logDir = await mkdtemp(join(tmpdir(), 'office-mcp-e2e-'));
      tempDirs.push(logDir);
      const logPath = join(logDir, 'visualizer.log');
      const client = new McpStdioClient({ officePort, logPath });
      clients.push(client);

      // 1. initialize
      const initialize = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0' },
      });
      const initResult = initialize.result as { protocolVersion: string; serverInfo: { name: string } };
      expect(initResult.protocolVersion).toBe('2024-11-05');
      expect(initResult.serverInfo.name).toBe('office-agent-visualizer-mcp');

      // 2. notifications/initialized (no response expected)
      client.notify('notifications/initialized');

      // 3. tools/list
      const list = await client.request('tools/list');
      const toolNames = (list.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
      expect(toolNames).toEqual(['office_launch', 'office_snapshot', 'office_start', 'office_status', 'office_stop']);

      // 4. office_status before anything is running
      const statusBefore = payloadOf(await client.request('tools/call', { name: 'office_status', arguments: {} })) as {
        up: boolean;
        sessionCount: number | null;
      };
      expect(statusBefore.up).toBe(false);
      expect(statusBefore.sessionCount).toBeNull();

      // 5. office_start against a FREE port
      const started = payloadOf(await client.request('tools/call', { name: 'office_start', arguments: {} }, 30000)) as {
        url: string;
        port: number;
        harnesses: string[];
        sessionCount: number;
        alreadyRunning: boolean;
      };
      expect(started.port).toBe(officePort);
      expect(started.url).toBe(`http://127.0.0.1:${officePort}`);
      expect(started.alreadyRunning).toBe(false);
      expect(started.harnesses).toEqual([]);
      expect(started.sessionCount).toBe(0);

      // 6. office_snapshot against the running office
      const snapshot = payloadOf(await client.request('tools/call', { name: 'office_snapshot', arguments: {} }, 30000)) as {
        generatedAt: number;
        workers: unknown[];
      };
      expect(typeof snapshot.generatedAt).toBe('number');
      expect(snapshot.workers).toEqual([]);

      // 7. office_status reflects a running, empty office (zero is legitimate, not a fault)
      const statusAfter = payloadOf(await client.request('tools/call', { name: 'office_status', arguments: {} })) as {
        up: boolean;
        url: string | null;
        sessionCount: number | null;
      };
      expect(statusAfter.up).toBe(true);
      expect(statusAfter.url).toBe(`http://127.0.0.1:${officePort}`);
      expect(statusAfter.sessionCount).toBe(0);

      // TRAP 1: every raw stdout line is JSON, and the visualizer's banner is NOT among them.
      const lines = client.rawStdoutLines();
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect(lines.some((line) => line.includes('[office-agent-visualizer]'))).toBe(false);

      // ...the banner went to the log file instead.
      const log = await readFile(logPath, 'utf8');
      expect(log).toContain('[office-agent-visualizer] SSE stream ready');

      // 8. office_stop stops the process this server spawned
      const stopped = payloadOf(await client.request('tools/call', { name: 'office_stop', arguments: {} }, 15000)) as {
        stopped: boolean;
      };
      expect(stopped.stopped).toBe(true);
      expect(await waitForPortFree(officePort)).toBe(true);
    },
    60_000,
  );

  it(
    'stops the managed office when the client closes stdin (a stdio MCP dies with its client)',
    async () => {
      const officePort = await findFreePort();
      const logDir = await mkdtemp(join(tmpdir(), 'office-mcp-e2e-'));
      tempDirs.push(logDir);
      const client = new McpStdioClient({ officePort, logPath: join(logDir, 'visualizer.log') });
      clients.push(client);

      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      client.notify('notifications/initialized');
      await client.request('tools/call', { name: 'office_start', arguments: {} }, 30000);

      await client.closeStdin();

      expect(await waitForPortFree(officePort)).toBe(true);
    },
    60_000,
  );
});

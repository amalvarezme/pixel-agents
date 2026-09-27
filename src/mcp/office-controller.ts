/**
 * Slice 2 (odd/tasks/office-mcp.md): the idempotent lifecycle manager over the office visualizer.
 *
 * Its whole reason to exist is that `src/server.ts` does NOT handle `EADDRINUSE`: a second start
 * on a busy port would crash. So the default port is probed BEFORE anything is spawned, and only
 * a genuinely free port is ever handed to a child. A process that is not ours is left alone — this
 * class only ever kills a child it spawned itself, and it kills that child when the MCP server
 * exits so nothing is left holding the port.
 *
 * The transport (spawning, probing, snapshot reading, launch proxying) is injected, which is what
 * lets the lifecycle be tested without a real process and keeps this module free of `node:http`.
 */
import { HARNESS_IDS, type HarnessId } from '../domain/events/types';
import type { LaunchSpec } from '../ports/session-launcher.port';
import type { LaunchProxyResult, OfficeHttpClient, OfficeSnapshot, PortProbe } from './office-client';

/** The visualizer's own default (`src/server.ts`: `PORT ?? 4317`). */
export const DEFAULT_OFFICE_PORT = 4317;
/** Loopback only, matching `src/server.ts`'s hardcoded bind. */
export const OFFICE_HOST = '127.0.0.1';

const HARNESS_ENV_VAR: Record<HarnessId, string> = {
  'claude-code': 'CLAUDE_CODE_ENABLED',
  codex: 'CODEX_ENABLED',
  opencode: 'OPENCODE_ENABLED',
  antigravity: 'ANTIGRAVITY_ENABLED',
  pi: 'PI_ENABLED',
};

/** A spawned visualizer, narrowed to exactly the operations the manager needs. */
export interface VisualizerHandle {
  readonly pid: number | undefined;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface VisualizerSpawnContext {
  projectRoot: string;
  port: number;
  env: NodeJS.ProcessEnv;
  /** The file the child's stdout/stderr are redirected to — never the MCP protocol stream. */
  logPath: string;
}

export type VisualizerSpawner = (context: VisualizerSpawnContext) => VisualizerHandle;

export interface OfficeControllerOptions {
  projectRoot: string;
  client: OfficeHttpClient;
  spawnVisualizer: VisualizerSpawner;
  defaultPort?: number;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  probeTimeoutMs?: number;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  snapshotTimeoutMs?: number;
  launchTimeoutMs?: number;
  shutdownGraceMs?: number;
  log?: (line: string) => void;
}

export interface OfficeStartResult {
  url: string;
  port: number;
  harnesses: HarnessId[];
  sessionCount: number;
  alreadyRunning: boolean;
}

export interface OfficeStatusResult {
  up: boolean;
  url: string | null;
  port: number | null;
  harnesses: HarnessId[];
  /** `null` while the office is down (unknowable), `0` for a running office with no sessions. */
  sessionCount: number | null;
  note: string;
}

export interface OfficeStopResult {
  stopped: boolean;
  note: string;
}

interface ManagedProcess {
  handle: VisualizerHandle;
  port: number;
  /** Resolves when the child exits. Used to make `stop`/`dispose` wait for a real exit. */
  exited: Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveHarnesses(env: NodeJS.ProcessEnv): HarnessId[] {
  return HARNESS_IDS.filter((harness) => env[HARNESS_ENV_VAR[harness]] !== 'false');
}

export class OfficeController {
  private readonly projectRoot: string;
  private readonly client: OfficeHttpClient;
  private readonly spawnVisualizer: VisualizerSpawner;
  private readonly defaultPort: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logPath: string;
  private readonly probeTimeoutMs: number;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollMs: number;
  private readonly snapshotTimeoutMs: number;
  private readonly launchTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly log: (line: string) => void;

  private managed: ManagedProcess | null = null;
  private starting: Promise<OfficeStartResult> | null = null;

  constructor(options: OfficeControllerOptions) {
    this.projectRoot = options.projectRoot;
    this.client = options.client;
    this.spawnVisualizer = options.spawnVisualizer;
    this.defaultPort = options.defaultPort ?? DEFAULT_OFFICE_PORT;
    this.env = options.env ?? process.env;
    this.logPath = options.logPath ?? '';
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1000;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000;
    this.readinessPollMs = options.readinessPollMs ?? 100;
    this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? 4000;
    this.launchTimeoutMs = options.launchTimeoutMs ?? 5000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 3000;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Lifts the office and returns its URL. Idempotent by construction:
   *  - a process this server already manages is returned as-is;
   *  - an office already answering on the default port (whoever started it) is returned, not
   *    duplicated;
   *  - a FOREIGN process on the default port yields a free port for the child, never a crash.
   */
  async start(): Promise<OfficeStartResult> {
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<OfficeStartResult> {
    if (this.managed) {
      if ((await this.client.probe(this.managed.port, this.probeTimeoutMs)) === 'ours') {
        return this.describe(this.managed.port, true);
      }
      // A tracked child that no longer answers is terminated before a new one starts, so the port
      // is never leaked to an unresponsive process.
      await this.terminateManaged();
    }

    let port = this.defaultPort;
    const initialProbe = await this.client.probe(port, this.probeTimeoutMs);
    if (initialProbe === 'ours') return this.describe(port, true);
    if (initialProbe === 'foreign') {
      port = await this.client.findFreePort();
      this.log(`office: ${this.defaultPort} is busy with a process that is not ours; using ${port}`);
    }

    const handle = this.spawnVisualizer({ projectRoot: this.projectRoot, port, env: this.env, logPath: this.logPath });
    let resolveExit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    handle.onExit((code, signal) => {
      this.log(`office: visualizer on port ${port} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      if (this.managed?.handle === handle) this.managed = null;
      resolveExit();
    });
    handle.onError((error) => this.log(`office: visualizer process error: ${error.message}`));
    this.managed = { handle, port, exited };

    try {
      await this.waitForReady(port);
    } catch (error) {
      await this.terminateManaged();
      throw error;
    }
    return this.describe(port, false);
  }

  private async waitForReady(port: number): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if ((await this.client.probe(port, this.probeTimeoutMs)) === 'ours') return;
      await delay(this.readinessPollMs);
    }
    throw new Error(`office visualizer did not become ready on port ${port} within ${this.readinessTimeoutMs}ms`);
  }

  private async describe(port: number, alreadyRunning: boolean): Promise<OfficeStartResult> {
    const url = this.urlFor(port);
    const snapshot = await this.client.readSnapshot(url, this.snapshotTimeoutMs);
    return { url, port, harnesses: this.harnesses(), sessionCount: snapshot.workers.length, alreadyRunning };
  }

  async status(): Promise<OfficeStatusResult> {
    const harnesses = this.harnesses();
    const port = this.managed?.port ?? this.defaultPort;

    let probe: PortProbe;
    try {
      probe = await this.client.probe(port, this.probeTimeoutMs);
    } catch {
      probe = 'foreign';
    }

    if (probe !== 'ours') {
      const note = this.managed
        ? `the managed visualizer on port ${this.managed.port} is not answering; office_stop will terminate it`
        : probe === 'foreign'
          ? `port ${this.defaultPort} is held by a process that is not our office visualizer`
          : 'office visualizer is not running';
      return {
        up: false,
        url: null,
        port: this.defaultPort,
        harnesses,
        sessionCount: null,
        note,
      };
    }

    const url = this.urlFor(port);
    let sessionCount: number | null = null;
    try {
      sessionCount = (await this.client.readSnapshot(url, this.snapshotTimeoutMs)).workers.length;
    } catch (error) {
      this.log(`office: could not read a snapshot from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      up: true,
      url,
      port,
      harnesses,
      sessionCount,
      note: this.managed
        ? 'running (this MCP server started it; office_stop will stop it)'
        : 'running but NOT started by this MCP server; office_stop will not stop it',
    };
  }

  async snapshot(): Promise<OfficeSnapshot> {
    return this.client.readSnapshot(await this.resolveRunningUrl(), this.snapshotTimeoutMs);
  }

  async launch(spec: unknown): Promise<LaunchProxyResult> {
    return this.client.postLaunch(await this.resolveRunningUrl(), spec as LaunchSpec, this.launchTimeoutMs);
  }

  /**
   * Stops the visualizer THIS server spawned, and only that one. A process it did not spawn is
   * never signalled — the office may have been lifted by `npm run office` or another client, and
   * this server has no authority over it.
   */
  async stop(): Promise<OfficeStopResult> {
    if (!this.managed) {
      return { stopped: false, note: 'this MCP server is not managing any visualizer process; nothing was stopped' };
    }
    const port = this.managed.port;
    await this.terminateManaged();
    return { stopped: true, note: `stopped the visualizer on port ${port}` };
  }

  /**
   * Called on MCP shutdown. A stdio MCP server dies with its client, so the child goes with it —
   * deliberately NOT detached — which is what keeps an orphan from squatting on the port.
   */
  async dispose(): Promise<void> {
    await this.terminateManaged();
  }

  /**
   * Signals the managed child and waits for a REAL exit, escalating to SIGKILL. Idempotent, and it
   * only ever touches a process this server spawned (`this.managed`).
   */
  private async terminateManaged(): Promise<void> {
    const entry = this.managed;
    if (!entry) return;
    this.managed = null;
    entry.handle.kill('SIGTERM');
    const exited = await Promise.race([entry.exited.then(() => true), delay(this.shutdownGraceMs).then(() => false)]);
    if (!exited) {
      this.log(`office: visualizer on port ${entry.port} did not exit within ${this.shutdownGraceMs}ms; sending SIGKILL`);
      entry.handle.kill('SIGKILL');
    }
  }

  private async resolveRunningUrl(): Promise<string> {
    if (this.managed && (await this.client.probe(this.managed.port, this.probeTimeoutMs)) === 'ours') {
      return this.urlFor(this.managed.port);
    }
    if ((await this.client.probe(this.defaultPort, this.probeTimeoutMs)) === 'ours') {
      return this.urlFor(this.defaultPort);
    }
    throw new Error('office visualizer is not running: call office_start first');
  }

  private harnesses(): HarnessId[] {
    return resolveHarnesses(this.env);
  }

  private urlFor(port: number): string {
    return `http://${OFFICE_HOST}:${port}`;
  }
}

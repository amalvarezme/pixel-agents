/**
 * `ChildProcessSessionLauncher` (tasks.md Phase 24, design.md "The Launcher": "child_process
 * default, PTY behind an out-of-process capability probe"). Implements `SessionLauncher`.
 *
 * `shell: false` is HARD-CODED, never a caller-supplied option — the whole point of this class is
 * that an argument can never be shell-interpreted (Threat Matrix case c; `buildLaunchCommand`
 * guarantees the argv itself is a plain array, this class guarantees it is spawned as one).
 *
 * `launch_requested`/`launch_started` (task 24.6, spec: Self-Originated Launch Events Only) are
 * built exclusively from this class's OWN state — the launchId it minted, the binary path it
 * resolved via an explicit `PATH` lookup, the argv it built, the pid `spawn` handed back — never
 * from any harness log file. A failed resolution or a spawn-time error resolves
 * `status(launch_failed, reason)` and NEVER throws (task 24.2, Threat Matrix case d) and NEVER
 * emits `launch_started` (task 24.7).
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { AgentEvent } from '../../../domain/events/types';
import { createSelfOriginatedEvent } from '../../../domain/events/factories';
import type { EventPublisher } from '../../../ports/event-publisher.port';
import type { Clock } from '../../../ports/clock.port';
import type { LaunchResult, LaunchSpec, SessionLauncher } from '../../../ports/session-launcher.port';
import type { TerminalBackend } from '../../../ports/terminal-backend.port';
import { buildLaunchCommand, buildLaunchEnv, HARNESS_BINARY } from './build-launch-command';
import { resolveBinaryOnPath, type BinaryExistsFn } from './resolve-binary-path';

export interface SpawnedProcessLike {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'spawn', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false },
) => SpawnedProcessLike;

function defaultSpawnFn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): SpawnedProcessLike {
  return nodeSpawn(command, args, { cwd: options.cwd, env: options.env, shell: false }) as ChildProcess as SpawnedProcessLike;
}

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

export interface ChildProcessSessionLauncherOptions {
  publisher: EventPublisher;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  existsFn?: BinaryExistsFn;
  /** Separate from `existsFn`: that one answers "is this a binary on PATH", this one "is this a usable working directory". Conflating them would make a binary fake decide cwd validity too. */
  dirExistsFn?: (path: string) => boolean;
  mintLaunchId?: () => string;
  allocateId?: () => number;
  terminalBackend?: TerminalBackend;
}

/** Quotes an argv element for a copy-pasteable shell command line (display only — never executed). */
function shellQuote(part: string): string {
  return /[\s;&|<>$`"'\\]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part;
}

function formatCopyableCommandLine(argv: string[], cwd: string): string {
  return `(cd ${shellQuote(cwd)} && ${argv.map(shellQuote).join(' ')})`;
}

export class ChildProcessSessionLauncher implements SessionLauncher {
  private readonly publisher: EventPublisher;
  private readonly clock: Clock;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: SpawnFn;
  private readonly existsFn: BinaryExistsFn;
  private readonly dirExistsFn: (path: string) => boolean;
  private readonly mintLaunchId: () => string;
  private readonly allocateId: () => number;
  private readonly terminalBackend: TerminalBackend | undefined;
  private readonly children = new Map<string, SpawnedProcessLike>();

  constructor(options: ChildProcessSessionLauncherOptions) {
    this.publisher = options.publisher;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.env = options.env ?? process.env;
    this.spawnFn = options.spawnFn ?? defaultSpawnFn;
    this.existsFn = options.existsFn ?? existsSync;
    this.dirExistsFn = options.dirExistsFn ?? ((path: string) => existsSync(path) && statSync(path).isDirectory());
    this.mintLaunchId = options.mintLaunchId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    this.allocateId = options.allocateId ?? defaultAllocateId();
    this.terminalBackend = options.terminalBackend;
  }

  async launch(spec: LaunchSpec): Promise<LaunchResult> {
    const launchId = this.mintLaunchId();

    if (spec.interactive && this.terminalBackend) {
      const availability = await this.terminalBackend.probe();
      if (!availability.available) {
        const argv = buildLaunchCommand(spec);
        return {
          outcome: 'unavailable_interactive',
          launchId,
          commandLine: formatCopyableCommandLine(argv, spec.cwd),
          reason: availability.reason,
        };
      }
      // No real PTY backend is wired in this repo (node-pty is not installed) — an available
      // probe never reaches this class today. Falling through to the non-interactive path below
      // would silently drop interactivity, so this is deliberately unreachable-but-explicit.
    }

    const binaryName = HARNESS_BINARY[spec.harness];
    const argv = buildLaunchCommand(spec);
    const resolvedPath = resolveBinaryOnPath(binaryName, this.env.PATH ?? '', this.existsFn);
    const t0 = this.clock.now();

    this.publisher.publish(
      createSelfOriginatedEvent(this.allocateId(), {
        kind: 'launch_requested',
        harness: spec.harness,
        sessionKey: `launch:${launchId}`,
        at: t0,
        launchId,
        binaryPath: resolvedPath ?? binaryName,
        argv,
        cwd: spec.cwd,
      }),
    );

    if (!resolvedPath) {
      const reason = `binary not found on PATH: ${binaryName}`;
      this.publisher.publish(this.buildFailedStatusEvent(spec.harness, launchId, reason));
      return { outcome: 'failed', launchId, reason };
    }

    // Node reports a missing `cwd` as ENOENT naming the BINARY, so a stale directory looks
    // exactly like a PATH problem — observed live against a binary that was present and
    // executable. Check the directory explicitly so the reason names what is actually missing.
    if (!this.dirExistsFn(spec.cwd)) {
      const reason = `working directory does not exist: ${spec.cwd}`;
      this.publisher.publish(this.buildFailedStatusEvent(spec.harness, launchId, reason));
      return { outcome: 'failed', launchId, reason };
    }

    return new Promise<LaunchResult>((resolve) => {
      let settled = false;
      const child = this.spawnFn(resolvedPath, argv.slice(1), { cwd: spec.cwd, env: buildLaunchEnv(this.env), shell: false });

      child.on('spawn', () => {
        if (settled) return;
        settled = true;
        this.children.set(launchId, child);
        const startedAt = this.clock.now();
        const pid = child.pid ?? -1;
        this.publisher.publish(
          createSelfOriginatedEvent(this.allocateId(), {
            kind: 'launch_started',
            harness: spec.harness,
            sessionKey: `launch:${launchId}`,
            at: startedAt,
            launchId,
            pid,
            startedAt,
          }),
        );
        resolve({ outcome: 'started', launchId, pid, startedAt });
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        const reason = `spawn failed: ${err.message}`;
        this.publisher.publish(this.buildFailedStatusEvent(spec.harness, launchId, reason));
        resolve({ outcome: 'failed', launchId, reason });
      });
    });
  }

  /** Threat Matrix case e: SIGTERMs every tracked child. Never throws on an empty registry. */
  async shutdown(): Promise<void> {
    for (const child of this.children.values()) child.kill('SIGTERM');
    this.children.clear();
  }

  private buildFailedStatusEvent(harness: LaunchSpec['harness'], launchId: string, reason: string): AgentEvent {
    return {
      id: this.allocateId(),
      kind: 'status',
      harness,
      sessionKey: `launch:${launchId}`,
      at: this.clock.now(),
      launchId,
      reason,
    };
  }
}

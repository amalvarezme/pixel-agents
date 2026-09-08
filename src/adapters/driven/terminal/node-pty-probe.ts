/**
 * node-pty capability probe (design.md D5, tasks.md 4.1/4.2).
 *
 * MUST run the actual pty-open attempt in a SHORT-LIVED CHILD PROCESS. A native segfault in
 * node-pty cannot be caught in-process with try/catch — it takes the whole process down. By
 * running the check in a child process instead, the same crash becomes a readable exit code
 * or termination signal that this class interprets, and the parent (the visualizer process)
 * never even flinches.
 *
 * This class is the testable orchestration layer: it owns spawning, timing out, and
 * interpreting the child's outcome. It never throws — every failure mode resolves
 * `{available:false, reason}`. The actual pty-opening logic lives in the throwaway child
 * script `pty-probe-child.mjs`, which is NOT unit-tested directly (native process behavior;
 * see design.md "Deliberately NOT automated") — this class's tests inject a fake child process
 * to prove the orchestration survives every way that child can die.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TerminalBackend, TerminalBackendAvailability } from '../../../ports/terminal-backend.port';

export type SpawnFn = (command: string, args: readonly string[]) => ChildProcess;

export interface NodePtyProbeOptions {
  /** Injectable for tests; defaults to a real `child_process.spawn`. */
  spawnFn?: SpawnFn;
  probeScriptPath: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class NodePtyProbe implements TerminalBackend {
  private readonly spawnFn: SpawnFn;
  private readonly probeScriptPath: string;
  private readonly timeoutMs: number;

  constructor(options: NodePtyProbeOptions) {
    this.spawnFn =
      options.spawnFn ?? ((cmd, args) => nodeSpawn(cmd, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] }));
    this.probeScriptPath = options.probeScriptPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async probe(): Promise<TerminalBackendAvailability> {
    return new Promise<TerminalBackendAvailability>((resolve) => {
      let settled = false;
      const settle = (result: TerminalBackendAvailability): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = this.spawnFn(process.execPath, [this.probeScriptPath]);
      } catch (err) {
        settle({ available: false, reason: `spawn failed: ${(err as Error).message}` });
        return;
      }

      const timer = setTimeout(() => {
        child.kill();
        settle({ available: false, reason: 'probe timed out' });
      }, this.timeoutMs);

      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.on('error', (err: Error) => {
        settle({ available: false, reason: `child process error: ${err.message}` });
      });

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (signal) {
          settle({ available: false, reason: `probe process terminated by signal ${signal}` });
          return;
        }
        if (code !== 0) {
          settle({ available: false, reason: `probe process exited with code ${code}` });
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as TerminalBackendAvailability;
          settle(parsed);
        } catch {
          settle({ available: false, reason: 'probe process produced unparsable output' });
        }
      });
    });
  }
}

/** Resolves the real, non-test path to the sibling throwaway child script. */
export function createNodePtyProbe(): NodePtyProbe {
  const probeScriptPath = fileURLToPath(new URL('./pty-probe-child.mjs', import.meta.url));
  return new NodePtyProbe({ probeScriptPath });
}

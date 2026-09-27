/**
 * Slice 2 (odd/tasks/office-mcp.md) TRAP 1: `stdout` IS the MCP protocol.
 *
 * The visualizer prints startup lines such as `[office-agent-visualizer] SSE stream ready at ...`.
 * If the child inherited this process's stdout, those bytes would interleave with JSON-RPC and
 * corrupt the stream. So the child's stdout and stderr are redirected to a FILE, and the parent
 * never reads them — there is no pipe to drain and no backpressure to manage.
 *
 * The child is deliberately NOT detached: a stdio MCP server dies with its client, and the office
 * goes with it rather than being left as an orphan holding the port. `OfficeController.dispose`
 * signals it on shutdown, and this module only builds the process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VisualizerHandle, VisualizerSpawner } from './office-controller';

/** Where the visualizer's own console output lands. Under `.data/` (gitignored), like checkpoints. */
export function visualizerLogPath(projectRoot: string): string {
  return join(projectRoot, '.data', 'office-mcp-visualizer.log');
}

function wrapChild(child: ChildProcess, logFd: number): VisualizerHandle {
  // The child owns its duplicated descriptors; the parent closes its copy as soon as spawn has
  // handed them over, so no descriptor is leaked for the lifetime of the MCP server.
  let closed = false;
  const closeLog = (): void => {
    if (closed) return;
    closed = true;
    try {
      closeSync(logFd);
    } catch {
      // Already closed / never opened: nothing to clean up.
    }
  };
  child.once('spawn', closeLog);
  child.once('error', closeLog);
  return {
    pid: child.pid,
    onExit: (listener) => {
      child.on('exit', (code, signal) => listener(code, signal));
    },
    onError: (listener) => {
      child.on('error', (error) => listener(error));
    },
    kill: (signal = 'SIGTERM') => child.kill(signal),
  };
}

/**
 * Spawns the visualizer the same way `npm run office` does (its second half): the project's OWN
 * `vite-node` runner, resolved from `node_modules`, on `src/server.ts`. `PORT` is always passed
 * explicitly so the port the controller probed is the port the child binds.
 */
export function createVisualizerSpawner(): VisualizerSpawner {
  return ({ projectRoot, port, env, logPath }) => {
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, 'a');
    const viteNode = join(projectRoot, 'node_modules', 'vite-node', 'vite-node.mjs');
    const child = spawn(process.execPath, [viteNode, 'src/server.ts'], {
      cwd: projectRoot,
      env: { ...env, PORT: String(port) },
      // stdout IS the protocol — the child's stdout AND stderr go to the log file, never here.
      stdio: ['ignore', logFd, logFd],
    });
    return wrapChild(child, logFd);
  };
}

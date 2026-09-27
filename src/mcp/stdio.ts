#!/usr/bin/env -S vite-node
/**
 * Slice 2 (odd/tasks/office-mcp.md): the stdio entrypoint. Newline-delimited JSON-RPC 2.0 in on
 * stdin, one response line out per request on stdout.
 *
 * Why `vite-node` and not `node`: this project's source is TypeScript and ships NO compiled `bin`.
 * `npm run office` already runs `vite-node src/server.ts`, so the MCP server uses the same
 * in-repo TypeScript runtime — `node node_modules/vite-node/vite-node.mjs src/mcp/stdio.ts`.
 * That resolves the project's `tsconfig`/ESM setup with zero new dependencies and zero build step,
 * which is exactly the constraint the maintainer set.
 *
 * TRAP 1 / TRAP 2 / TRAP 3, all handled here:
 *  - every diagnostic goes to `process.stderr`; `process.stdout` carries ONLY protocol lines;
 *  - closing stdin (the client died) shuts the server down and takes the managed child with it;
 *  - `dispose()` signals the managed visualizer so nothing is left holding the port.
 */
import { createOfficeMcp } from './office-mcp';

export async function runStdioServer(): Promise<void> {
  const { server, controller, log } = createOfficeMcp();

  let buffer = '';
  process.stdin.setEncoding('utf8');

  const handleLine = async (line: string): Promise<void> => {
    let response: string | null;
    try {
      response = await server.handleLine(line);
    } catch (error) {
      log(`office-mcp: unhandled error while handling a line: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // stdout IS the protocol: one JSON-RPC line per write, nothing else, ever.
    if (response !== null) process.stdout.write(`${response}\n`);
  };

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim() === '') continue;
      void handleLine(line);
    }
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await controller.dispose();
    process.exit(0);
  };

  process.stdin.on('end', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.resume();
  log('office-mcp: stdio server ready (newline-delimited JSON-RPC 2.0)');
}

void runStdioServer();

/**
 * Slice 2 (odd/tasks/office-mcp.md): the composition root for the MCP server. Mirrors
 * `src/server.ts`'s role for the HTTP server — the ONE place where the protocol layer, the tool
 * catalog, the lifecycle controller, the HTTP client and the process spawner are wired together.
 *
 * It lives apart from `stdio.ts` so the wiring can be exercised without a real stdin/stdout loop.
 */
import { fileURLToPath } from 'node:url';
import { createOfficeHttpClient } from './office-client';
import { DEFAULT_OFFICE_PORT, OfficeController } from './office-controller';
import { McpServer } from './mcp-server';
import { createToolDispatcher, type OfficeTools } from './tools';
import { createVisualizerSpawner, visualizerLogPath } from './visualizer-spawner';

export interface OfficeMcpOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Diagnostic sink. MUST be stderr in the real entry — stdout is the protocol. */
  log?: (line: string) => void;
}

export interface OfficeMcp {
  server: McpServer;
  controller: OfficeController;
  log: (line: string) => void;
}

/**
 * The repository root, derived from THIS module's location rather than the working directory.
 *
 * The committed `.mcp.json` used to pin an absolute `cwd`, so `process.cwd()` happened to be the
 * repo. That pin made the entry machine-specific; once it is gone, the server must find its own
 * root no matter where the MCP client launched it from. `src/mcp/office-mcp.ts` sits two levels
 * under the root, so `../..` is exact and needs no runtime probing.
 */
export function resolveProjectRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

/**
 * `OFFICE_PORT` (falling back to `PORT`, then 4317) selects the visualizer port this server will
 * probe and pass to the child. It never selects a port this process itself listens on — the MCP
 * transport is stdio, so nothing here binds.
 */
export function resolveOfficePort(env: NodeJS.ProcessEnv): number {
  const raw = env.OFFICE_PORT ?? env.PORT;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_OFFICE_PORT;
}

export function createOfficeMcp(options: OfficeMcpOptions = {}): OfficeMcp {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? resolveProjectRoot();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const controller = new OfficeController({
    projectRoot,
    client: createOfficeHttpClient(),
    spawnVisualizer: createVisualizerSpawner(),
    defaultPort: resolveOfficePort(env),
    env,
    logPath: env.OFFICE_MCP_LOG ?? visualizerLogPath(projectRoot),
    log,
  });

  const tools: OfficeTools = {
    officeStart: () => controller.start(),
    officeStop: () => controller.stop(),
    officeStatus: () => controller.status(),
    officeSnapshot: () => controller.snapshot(),
    officeLaunch: (args) => controller.launch(args),
  };

  const server = new McpServer({ dispatch: createToolDispatcher(tools), log });
  return { server, controller, log };
}

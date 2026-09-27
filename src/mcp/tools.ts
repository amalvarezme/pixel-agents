/**
 * Slice 2 (odd/tasks/office-mcp.md): the office tool catalog. Every tool an MCP client can see is
 * declared ONCE here — the JSON-RPC layer reads `TOOL_DEFINITIONS` to answer `tools/list` and this
 * module owns the name -> use-case dispatch for `tools/call`, so the wire contract and the
 * behaviour can never drift apart.
 *
 * The tools are split by whether they mutate, because that split is exactly what an approval
 * policy (Pi's `approveTools`) maps onto: `office_start`, `office_stop` and `office_launch` change
 * machine state; `office_status` and `office_snapshot` only look.
 */
import { HARNESS_IDS } from '../domain/events/types';

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/**
 * The use cases the tools call. Kept as a narrow interface (rather than typed against the
 * concrete controller) so `mcp-server.ts` never depends on how the office is actually managed.
 */
export interface OfficeTools {
  officeStart(): Promise<unknown>;
  officeStop(): Promise<unknown>;
  officeStatus(): Promise<unknown>;
  officeSnapshot(): Promise<unknown>;
  officeLaunch(args: Record<string, unknown>): Promise<unknown>;
}

export type ToolDispatcher = (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;

const NO_ARGS_SCHEMA: McpToolDefinition['inputSchema'] = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export const TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: 'office_start',
    description:
      'MUTATING. Lift the office visualizer and return its URL. Idempotent: probes the port first, so an already-running office is returned rather than started twice, and a port busy with an unrelated process results in a free port being chosen instead of a crash.',
    inputSchema: NO_ARGS_SCHEMA,
  },
  {
    name: 'office_stop',
    description:
      'MUTATING. Stop the office visualizer that THIS server started. A visualizer this server did not spawn is never killed.',
    inputSchema: NO_ARGS_SCHEMA,
  },
  {
    name: 'office_status',
    description:
      'READ-ONLY. Whether the office is up, its URL and port, which harnesses are enabled, and how many sessions it can currently see (zero with no harness logs is a legitimate state, not a fault).',
    inputSchema: NO_ARGS_SCHEMA,
  },
  {
    name: 'office_snapshot',
    description:
      'READ-ONLY. The office as text: the current snapshot frame (workers, archive and carry queues) read from the running office, with a timeout. The human-facing floor is the URL from office_status.',
    inputSchema: NO_ARGS_SCHEMA,
  },
  {
    name: 'office_launch',
    description:
      'MUTATING. Proxy a launch request to the office POST /launch endpoint so its existing validation (including the Zero-Injection denylist) applies unchanged. Nothing is spawned by this server.',
    inputSchema: {
      type: 'object',
      properties: {
        harness: { type: 'string', enum: [...HARNESS_IDS], description: 'Which agent harness to launch.' },
        cwd: { type: 'string', description: 'Working directory the session is launched in.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra harness arguments.' },
        interactive: { type: 'boolean', description: 'Request a PTY-backed interactive session.' },
      },
      required: ['harness', 'cwd'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * Maps a validated tool name onto its use case and serialises the outcome as MCP `text` content.
 * A thrown use-case error becomes an `isError` tool result (never a thrown protocol error): a
 * tool that failed at runtime is a legitimate tool answer, not a malformed JSON-RPC request.
 */
export function createToolDispatcher(tools: OfficeTools): ToolDispatcher {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    office_start: () => tools.officeStart(),
    office_stop: () => tools.officeStop(),
    office_status: () => tools.officeStatus(),
    office_snapshot: () => tools.officeSnapshot(),
    office_launch: (args) => tools.officeLaunch(args),
  };

  return async (name, args) => {
    const handler = handlers[name];
    if (!handler) return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    try {
      const payload = await handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `office tool "${name}" failed: ${message}` }], isError: true };
    }
  };
}

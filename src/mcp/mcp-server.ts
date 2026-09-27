/**
 * Slice 2 (odd/tasks/office-mcp.md): the hand-rolled JSON-RPC 2.0 core. One line in, at most one
 * line out — the transport (stdin/stdout) lives in `stdio.ts`, so everything here is pure and
 * testable without a process.
 *
 * The surface is deliberately the smallest a client needs: `initialize`, `ping`, `tools/list`,
 * `tools/call`, plus the `notifications/initialized` notification. Two failure modes are pinned
 * because they decide whether a careless client can kill the server:
 *
 *  - an unknown METHOD answers a JSON-RPC `-32601` error (never a crash);
 *  - a line that is not JSON answers `-32700` with `id: null` (never a crash), so the stream keeps
 *    serving after a malformed line.
 *
 * Note what is NOT implemented here on purpose: resources, prompts and progress notifications.
 * The maintainer chose to hand-roll the protocol, so if those are ever needed they get built by
 * hand as well rather than pulled in as a dependency.
 */
import { TOOL_DEFINITIONS, type McpToolDefinition, type ToolDispatcher } from './tools';

export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface McpServerOptions {
  dispatch: ToolDispatcher;
  /** Defaults to the vendored catalog; injectable so the JSON-RPC layer can be tested alone. */
  tools?: readonly McpToolDefinition[];
  protocolVersion?: string;
  serverName?: string;
  version?: string;
  /** Diagnostic sink. MUST be stderr in the real entry — stdout is the protocol. */
  log?: (line: string) => void;
}

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_SERVER_NAME = 'office-agent-visualizer-mcp';
const DEFAULT_SERVER_VERSION = '0.1.0';

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(record: Record<string, unknown>): JsonRpcId {
  return typeof record.id === 'string' || typeof record.id === 'number' ? record.id : null;
}

export class McpServer {
  private readonly dispatch: ToolDispatcher;
  private readonly tools: readonly McpToolDefinition[];
  private readonly toolNames: Set<string>;
  private readonly protocolVersion: string;
  private readonly serverName: string;
  private readonly version: string;
  private readonly log: (line: string) => void;

  constructor(options: McpServerOptions) {
    this.dispatch = options.dispatch;
    this.tools = options.tools ?? TOOL_DEFINITIONS;
    this.toolNames = new Set(this.tools.map((tool) => tool.name));
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.serverName = options.serverName ?? DEFAULT_SERVER_NAME;
    this.version = options.version ?? DEFAULT_SERVER_VERSION;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Handles exactly one line of input. Returns the serialised response line, or `null` when there
   * is nothing to write (a valid notification, or an empty line). NEVER throws.
   */
  async handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (trimmed === '') return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return this.errorResponse(null, JSON_RPC_ERROR_CODES.parseError, 'Parse error: invalid JSON');
    }

    if (!isRecord(parsed) || typeof parsed.method !== 'string') {
      return this.errorResponse(
        isRecord(parsed) ? idOf(parsed) : null,
        JSON_RPC_ERROR_CODES.invalidRequest,
        'Invalid Request: "method" must be a string',
      );
    }

    const method = parsed.method;
    const params = isRecord(parsed.params) ? parsed.params : {};

    // JSON-RPC distinguishes a notification from a request solely by the ABSENCE of an `id`
    // member, so a notification must never produce a response — not even for an unknown method.
    if (!('id' in parsed)) {
      this.log(`mcp: ignoring notification ${method}`);
      return null;
    }

    try {
      const result = await this.dispatchMethod(method, params);
      return this.resultResponse(idOf(parsed), result);
    } catch (error) {
      if (error instanceof RpcError) return this.errorResponse(idOf(parsed), error.code, error.message);
      const message = error instanceof Error ? error.message : String(error);
      this.log(`mcp: internal error handling ${method}: ${message}`);
      return this.errorResponse(idOf(parsed), JSON_RPC_ERROR_CODES.internalError, `Internal error: ${message}`);
    }
  }

  private async dispatchMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          // Echo the client's requested version when it sent one, so a client that pins a newer
          // revision is not forced to disconnect over a version string we do not otherwise use.
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : this.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.serverName, version: this.version },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string') throw new RpcError(JSON_RPC_ERROR_CODES.invalidParams, 'Invalid params: "name" must be a string');
        if (!this.toolNames.has(name)) throw new RpcError(JSON_RPC_ERROR_CODES.invalidParams, `Unknown tool: ${name}`);
        const args = isRecord(params.arguments) ? params.arguments : {};
        return this.dispatch(name, args);
      }
      default:
        throw new RpcError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${method}`);
    }
  }

  private resultResponse(id: JsonRpcId, result: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }

  private errorResponse(id: JsonRpcId, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

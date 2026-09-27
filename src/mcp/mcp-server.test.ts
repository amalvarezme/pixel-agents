/**
 * Slice 2 (odd/tasks/office-mcp.md): the hand-rolled JSON-RPC 2.0 surface. The maintainer chose a
 * hand-written protocol over the official SDK and accepted the cost up front, so these tests pin
 * the SMALLEST correct surface a client needs: `initialize`, the `notifications/initialized`
 * notification, `tools/list`, `tools/call` and `ping` — plus the two failure modes that decide
 * whether an unknown method or a malformed line can take the whole process down (they must not).
 */
import { describe, expect, it, vi } from 'vitest';
import { JSON_RPC_ERROR_CODES, McpServer } from './mcp-server';
import type { McpToolResult, OfficeTools, ToolDispatcher } from './tools';

function textResult(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function makeFakeTools(): OfficeTools {
  return {
    officeStart: vi.fn(async () => ({ up: true, url: 'http://127.0.0.1:4317' })),
    officeStop: vi.fn(async () => ({ stopped: true })),
    officeStatus: vi.fn(async () => ({ up: true, sessionCount: 0 })),
    officeSnapshot: vi.fn(async () => ({ generatedAt: 1, workers: [] })),
    officeLaunch: vi.fn(async () => ({ status: 200, body: { outcome: 'started' } })),
  };
}

interface Harness {
  server: McpServer;
  tools: OfficeTools;
  dispatch: ToolDispatcher;
  lines: string[];
  send(line: string): Promise<unknown | null | 'no-response'>;
}

function makeHarness(): Harness {
  const tools = makeFakeTools();
  const dispatch = vi.fn(async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    switch (name) {
      case 'office_start':
        return textResult(await tools.officeStart());
      case 'office_stop':
        return textResult(await tools.officeStop());
      case 'office_status':
        return textResult(await tools.officeStatus());
      case 'office_snapshot':
        return textResult(await tools.officeSnapshot());
      case 'office_launch':
        return textResult(await tools.officeLaunch(args));
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    }
  }) as unknown as ToolDispatcher;
  const lines: string[] = [];
  const server = new McpServer({ dispatch, log: (line) => lines.push(line) });
  return {
    server,
    tools,
    dispatch,
    lines,
    async send(line: string) {
      const raw = await server.handleLine(line);
      return raw === null ? 'no-response' : JSON.parse(raw);
    },
  };
}

describe('MCP JSON-RPC protocol (slice 2)', () => {
  it('answers initialize with a protocolVersion, tools capability and serverInfo', async () => {
    const { send } = makeHarness();
    const response = (await send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
    )) as { result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string; version: string } } };

    expect(response.result.protocolVersion).toBe('2024-11-05');
    expect(response.result.capabilities.tools).toBeDefined();
    expect(response.result.serverInfo.name).toBe('office-agent-visualizer-mcp');
    expect(typeof response.result.serverInfo.version).toBe('string');
  });

  it('does not answer the id-less notifications/initialized notification', async () => {
    const { send, dispatch, tools } = makeHarness();
    const response = await send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    expect(response).toBe('no-response');
    expect(dispatch).not.toHaveBeenCalled();
    expect(tools.officeStatus).not.toHaveBeenCalled();
  });

  it('answers ping with an empty result object', async () => {
    const { send } = makeHarness();
    const response = (await send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }))) as { result: unknown };

    expect(response.result).toEqual({});
  });

  it('lists exactly the five office tools, each with a name, description and object input schema', async () => {
    const { send } = makeHarness();
    const response = (await send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> };
    };

    const names = response.result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['office_launch', 'office_snapshot', 'office_start', 'office_status', 'office_stop']);
    for (const tool of response.result.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('routes tools/call office_status to the controller and wraps the payload as text content', async () => {
    const { send, tools } = makeHarness();
    const response = (await send(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'office_status', arguments: {} } }),
    )) as { result: McpToolResult };

    expect(tools.officeStatus).toHaveBeenCalledTimes(1);
    expect(response.result.isError).toBeUndefined();
    expect(response.result.content).toHaveLength(1);
    expect(JSON.parse(response.result.content[0]!.text)).toEqual({ up: true, sessionCount: 0 });
  });

  it('answers a method it does not implement with -32601 instead of crashing', async () => {
    const { send } = makeHarness();
    const response = (await send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'resources/list' }))) as {
      error: { code: number; message: string };
    };

    expect(response.error.code).toBe(JSON_RPC_ERROR_CODES.methodNotFound);
    expect(response.error.message).toContain('resources/list');
  });

  it('answers a malformed JSON line with a -32700 parse error (id null) instead of crashing', async () => {
    const { send } = makeHarness();
    const response = (await send('{ this is not json')) as { id: null; error: { code: number } };

    expect(response.id).toBeNull();
    expect(response.error.code).toBe(JSON_RPC_ERROR_CODES.parseError);
  });

  it('keeps serving after a malformed line: the next tools/call still succeeds', async () => {
    const { send } = makeHarness();
    await send('not json at all');
    const response = (await send(
      JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'office_status', arguments: {} } }),
    )) as { result: McpToolResult };

    expect(JSON.parse(response.result.content[0]!.text)).toEqual({ up: true, sessionCount: 0 });
  });

  it('answers tools/call for an unknown tool name with -32602 and never calls the dispatcher', async () => {
    const { send, dispatch } = makeHarness();
    const response = (await send(
      JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'office_destroy', arguments: {} } }),
    )) as { error: { code: number; message: string } };

    expect(response.error.code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
    expect(response.error.message).toContain('office_destroy');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('answers a request with a missing method with -32600 invalid request', async () => {
    const { send } = makeHarness();
    const response = (await send(JSON.stringify({ jsonrpc: '2.0', id: 13 }))) as { error: { code: number } };

    expect(response.error.code).toBe(JSON_RPC_ERROR_CODES.invalidRequest);
  });
});

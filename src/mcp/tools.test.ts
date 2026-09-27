/**
 * Slice 2 (odd/tasks/office-mcp.md): the real tool dispatcher (`mcp-server.test.ts` exercises the
 * protocol with a fake dispatcher; this pins the mapping from tool name to use case).
 *
 * NOTE (TDD honesty): this file was written AFTER `tools.ts` existed, because the protocol test
 * needed the module first. The two guards it protects were still mutation-checked by hand
 * (removing the unknown-tool guard and removing the try/catch each turn a named test red).
 */
import { describe, expect, it, vi } from 'vitest';
import { createToolDispatcher, type McpToolResult, type OfficeTools } from './tools';

function makeTools(overrides: Partial<OfficeTools> = {}): OfficeTools {
  return {
    officeStart: vi.fn(async () => ({ url: 'http://127.0.0.1:4317' })),
    officeStop: vi.fn(async () => ({ stopped: true })),
    officeStatus: vi.fn(async () => ({ up: true, sessionCount: 0 })),
    officeSnapshot: vi.fn(async () => ({ generatedAt: 1, workers: [] })),
    officeLaunch: vi.fn(async () => ({ status: 200, body: { outcome: 'started' } })),
    ...overrides,
  };
}

function textOf(result: McpToolResult): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe('office tool dispatcher (slice 2)', () => {
  it('routes each tool name to its use case and serialises the payload as text', async () => {
    const tools = makeTools();
    const dispatch = createToolDispatcher(tools);

    expect(textOf(await dispatch('office_start', {}))).toEqual({ url: 'http://127.0.0.1:4317' });
    expect(textOf(await dispatch('office_stop', {}))).toEqual({ stopped: true });
    expect(textOf(await dispatch('office_status', {}))).toEqual({ up: true, sessionCount: 0 });
    expect(textOf(await dispatch('office_snapshot', {}))).toEqual({ generatedAt: 1, workers: [] });
    expect(tools.officeStart).toHaveBeenCalledTimes(1);
    expect(tools.officeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('forwards office_launch arguments unchanged so the server validates them, not this layer', async () => {
    const tools = makeTools();
    const dispatch = createToolDispatcher(tools);
    const args = { harness: 'claude-code', cwd: '/tmp/x', args: ['--dangerously-skip-permissions'] };

    await dispatch('office_launch', args);

    expect(tools.officeLaunch).toHaveBeenCalledWith(args);
  });

  it('turns a thrown use-case error into an isError result rather than a rejected promise', async () => {
    const tools = makeTools({
      officeSnapshot: vi.fn(async () => {
        throw new Error('office visualizer is not running: call office_start first');
      }),
    });
    const dispatch = createToolDispatcher(tools);

    const result = await dispatch('office_snapshot', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not running');
  });

  it('returns an isError result for an unknown tool name (defence in depth)', async () => {
    const dispatch = createToolDispatcher(makeTools());

    const result = await dispatch('office_obliterate', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unknown tool: office_obliterate');
  });
});

/**
 * Antigravity MCP config reader (tasks.md 13.4/13.5, research-local-evidence.md Addendum: "Root
 * cause of the gap" — `~/.gemini/antigravity-cli/mcp_config.json` is STALE and UNUSED; the live
 * configuration is `~/.gemini/config/mcp_config.json`, or a workspace `.agents/mcp_config.json`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAntigravityMcpConfig } from './config';

const readFileCalls: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (path: unknown, ...rest: unknown[]) => {
      readFileCalls.push(String(path));
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

describe('readAntigravityMcpConfig', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('reads the global config at <root>/config/mcp_config.json', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-config-'));
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'mcp_config.json'), '{"mcpServers":{"engram":{"command":"engram"}}}');

    const config = await readAntigravityMcpConfig(root);

    expect(config).toEqual({ mcpServers: { engram: { command: 'engram' } } });
  });

  it('prefers a workspace .agents/mcp_config.json over the global config when both are given', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-config-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'antigravity-workspace-'));
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'mcp_config.json'), '{"mcpServers":{"engram":{"command":"global"}}}');
    await mkdir(join(workspaceRoot, '.agents'), { recursive: true });
    await writeFile(join(workspaceRoot, '.agents', 'mcp_config.json'), '{"mcpServers":{"engram":{"command":"workspace"}}}');

    const config = await readAntigravityMcpConfig(root, workspaceRoot);

    expect(config).toEqual({ mcpServers: { engram: { command: 'workspace' } } });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('returns null when neither config file exists', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-config-'));
    expect(await readAntigravityMcpConfig(root)).toBeNull();
  });

  it('NEVER reads the stale antigravity-cli/mcp_config.json even when present alongside a valid workspace config (tasks.md 13.5)', async () => {
    root = await mkdtemp(join(tmpdir(), 'antigravity-config-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'antigravity-workspace-'));
    await mkdir(join(root, 'antigravity-cli'), { recursive: true });
    await writeFile(join(root, 'antigravity-cli', 'mcp_config.json'), '{"mcpServers":{"engram":{"command":"STALE"}}}');
    await mkdir(join(workspaceRoot, '.agents'), { recursive: true });
    await writeFile(join(workspaceRoot, '.agents', 'mcp_config.json'), '{"mcpServers":{"engram":{"command":"live"}}}');

    readFileCalls.length = 0;

    const config = await readAntigravityMcpConfig(root, workspaceRoot);

    expect(config).toEqual({ mcpServers: { engram: { command: 'live' } } });
    const staleCallAttempted = readFileCalls.some((path) => path.includes(join('antigravity-cli', 'mcp_config.json')));
    expect(staleCallAttempted).toBe(false);

    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

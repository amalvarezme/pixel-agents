/**
 * Antigravity MCP config reader (tasks.md 13.4, research-local-evidence.md Addendum: "Root cause
 * of the gap"). `~/.gemini/antigravity-cli/mcp_config.json` is a STALE, UNUSED file — the live
 * configuration `agy` actually reads is `~/.gemini/config/mcp_config.json` (global), or a
 * workspace `.agents/mcp_config.json` when one is given. This module NEVER reads the stale path
 * (tasks.md 13.5): it is not named anywhere in this file, so there is no code path that could
 * open it, by construction rather than by a runtime guard.
 *
 * Read-only: `readAntigravityMcpConfig` never writes to either config file.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readJsonFileOrNull(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

/**
 * Resolves the live Antigravity MCP config: a workspace `.agents/mcp_config.json` takes priority
 * over the global `<geminiRoot>/config/mcp_config.json` when `workspaceRoot` is given and the
 * workspace file exists. Returns `null` when neither is found.
 */
export async function readAntigravityMcpConfig(geminiRoot: string, workspaceRoot?: string): Promise<unknown | null> {
  if (workspaceRoot) {
    const workspaceConfig = await readJsonFileOrNull(join(workspaceRoot, '.agents', 'mcp_config.json'));
    if (workspaceConfig !== null) return workspaceConfig;
  }
  return await readJsonFileOrNull(join(geminiRoot, 'config', 'mcp_config.json'));
}

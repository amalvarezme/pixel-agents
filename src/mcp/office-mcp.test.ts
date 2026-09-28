/**
 * Installability: a third-party clone must be able to run the `office` MCP server without a
 * machine-specific absolute path in `.mcp.json`.
 *
 * `createOfficeMcp` used to default `projectRoot` to `process.cwd()`, which only worked by accident
 * because the committed `.mcp.json` pinned `cwd` to one machine. Removing that pin moves the burden
 * onto the server: it must locate the repository from its OWN module location, independent of where
 * the MCP client happened to launch it from.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfficeMcp, resolveProjectRoot, type OfficeMcp } from './office-mcp';

/**
 * `projectRoot` is a compile-time-private field on `OfficeController` with no public accessor, and
 * the composition root exposes it only through the controller it constructs. Reading that runtime
 * property is the smallest observable surface that proves the wiring without spawning a real
 * visualizer (which would bind a port and run a child process — out of scope for this file).
 */
function controllerProjectRoot(mcp: OfficeMcp): string {
  return (mcp.controller as unknown as { projectRoot: string }).projectRoot;
}

describe('office MCP project root resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives the repository root from the module location', () => {
    const root = resolveProjectRoot();
    expect(isAbsolute(root)).toBe(true);
    expect(existsSync(join(root, 'src', 'mcp', 'stdio.ts'))).toBe(true);
    expect(existsSync(join(root, 'package.json'))).toBe(true);
  });

  it('is independent of process.cwd()', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpdir());

    const root = resolveProjectRoot();

    expect(process.cwd()).toBe(tmpdir());
    expect(root).not.toBe(process.cwd());
    expect(existsSync(join(root, 'src', 'mcp', 'stdio.ts'))).toBe(true);

    cwdSpy.mockRestore();
  });

  it('uses resolveProjectRoot() as the default projectRoot for createOfficeMcp', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tmpdir());

    const mcp = createOfficeMcp({ env: {} });

    expect(controllerProjectRoot(mcp)).toBe(resolveProjectRoot());
    expect(controllerProjectRoot(mcp)).not.toBe(process.cwd());
  });

  it('lets an explicit projectRoot win', () => {
    const explicitRoot = tmpdir();

    const mcp = createOfficeMcp({ projectRoot: explicitRoot, env: {} });

    expect(controllerProjectRoot(mcp)).toBe(explicitRoot);
  });
});

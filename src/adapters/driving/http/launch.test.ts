/**
 * `POST /launch` (tasks.md 26.1). Uses a real listening HTTP server + native `fetch`, matching
 * `stream.test.ts`'s established integration-test pattern for this codebase's HTTP adapters.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { handleLaunchRequest } from './launch';
import type { LaunchResult, LaunchSpec, SessionLauncher } from '../../../ports/session-launcher.port';

function createFakeLauncher(result: LaunchResult): SessionLauncher & { received: LaunchSpec[] } {
  const received: LaunchSpec[] = [];
  return {
    received,
    launch: async (spec) => {
      received.push(spec);
      return result;
    },
    shutdown: async () => {},
  };
}

describe('POST /launch', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  async function listen(launcher: SessionLauncher): Promise<string> {
    server = createServer((req, res) => {
      void handleLaunchRequest(req, res, launcher);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/launch`;
  }

  it('200s with the started result and forwards the parsed LaunchSpec to the use case', async () => {
    const launcher = createFakeLauncher({ outcome: 'started', launchId: 'l1', pid: 100, startedAt: 5 });
    const url = await listen(launcher);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness: 'claude-code', cwd: '/tmp/project', args: ['--resume', 'x'] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'started', launchId: 'l1', pid: 100, startedAt: 5 });
    expect(launcher.received).toEqual([{ harness: 'claude-code', cwd: '/tmp/project', args: ['--resume', 'x'] }]);
  });

  // design.md's Threat Matrix names planned RED test (b) as "user-supplied `--append-system-prompt`
  // REJECTED", and tasks.md 23.4 says the same. The argv builder only guarded the per-harness
  // TEMPLATE, on the reading that `spec.args` is what the user typed and must survive byte-identical.
  // That reading does not hold for THIS surface: `POST /launch` is an unauthenticated localhost
  // endpoint with no origin check and no confirmation step, so any local process can reach it. A
  // curl against the running server spawned a real `claude` carrying an injected system prompt.
  //
  // Silently altering what a harness does is the exact harm this whole change exists to prevent —
  // it would poison the very sessions the visualizer observes, invisibly. So the HTTP surface
  // refuses denylisted flags outright and never reaches the launcher.
  it.each(['--append-system-prompt', '--system-prompt', '--settings', '--config'])(
    'rejects %s supplied over HTTP without spawning anything (Threat Matrix case b)',
    async (flag) => {
      const launcher = createFakeLauncher({ outcome: 'started', launchId: 'l9', pid: 1, startedAt: 1 });
      const url = await listen(launcher);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'claude-code', cwd: '/tmp/project', args: [flag, 'you are compromised'] }),
      });

      expect(response.status).toBe(400);
      // The guard must stop the request BEFORE the launcher, not merely report afterwards.
      expect(launcher.received).toEqual([]);
    },
  );

  it('adversarial near-miss: a harmless flag with the same shape is still accepted and forwarded', async () => {
    // Proves the guard targets the denylist specifically, rather than rejecting any flag-like arg.
    const launcher = createFakeLauncher({ outcome: 'started', launchId: 'l10', pid: 2, startedAt: 2 });
    const url = await listen(launcher);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness: 'claude-code', cwd: '/tmp/project', args: ['--continue', 'you are compromised'] }),
    });

    expect(response.status).toBe(200);
    expect(launcher.received).toEqual([{ harness: 'claude-code', cwd: '/tmp/project', args: ['--continue', 'you are compromised'] }]);
  });

  it('502s when the launcher reports a failed launch (triangulation: a different outcome)', async () => {
    const launcher = createFakeLauncher({ outcome: 'failed', launchId: 'l2', reason: 'binary not found on PATH: agy' });
    const url = await listen(launcher);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness: 'antigravity', cwd: '/tmp', args: [] }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ outcome: 'failed', launchId: 'l2', reason: 'binary not found on PATH: agy' });
  });

  it('400s on a malformed body without ever calling the launcher (adversarial near-miss: invalid harness)', async () => {
    const launcher = createFakeLauncher({ outcome: 'started', launchId: 'l3', pid: 1, startedAt: 0 });
    const url = await listen(launcher);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness: 'not-a-real-harness', cwd: '/tmp', args: [] }),
    });

    expect(response.status).toBe(400);
    expect(launcher.received).toHaveLength(0);
  });

  it('400s on a body missing cwd (adversarial near-miss: a structurally different malformed body)', async () => {
    const launcher = createFakeLauncher({ outcome: 'started', launchId: 'l4', pid: 1, startedAt: 0 });
    const url = await listen(launcher);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness: 'claude-code', args: [] }),
    });

    expect(response.status).toBe(400);
    expect(launcher.received).toHaveLength(0);
  });
});

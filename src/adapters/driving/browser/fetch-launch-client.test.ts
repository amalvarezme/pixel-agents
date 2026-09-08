/**
 * `FetchLaunchClient` (tasks.md 26.2). The browser-side counterpart of `POST /launch`: a thin
 * `fetch` wrapper, injectable so it is testable without a real network call, matching this
 * codebase's established seam pattern (`EventSourceStreamConnection`'s injectable `EventSourceLike`).
 */
import { describe, expect, it } from 'vitest';
import { FetchLaunchClient } from './fetch-launch-client';
import type { LaunchResult, LaunchSpec } from '../../../ports/session-launcher.port';

describe('FetchLaunchClient', () => {
  it('POSTs the LaunchSpec as JSON to the configured base URL and returns the parsed LaunchResult', async () => {
    const expected: LaunchResult = { outcome: 'started', launchId: 'l1', pid: 1, startedAt: 0 };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { json: async () => expected } as Response;
    };
    const client = new FetchLaunchClient({ fetchFn, baseUrl: '/launch' });
    const spec: LaunchSpec = { harness: 'claude-code', cwd: '/tmp', args: [] };

    const result = await client.requestLaunch(spec);

    expect(result).toEqual(expected);
    expect(calls).toEqual([
      { url: '/launch', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) } },
    ]);
  });
});

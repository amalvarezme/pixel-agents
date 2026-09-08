/**
 * Browser-side `POST /launch` client (tasks.md 26.2). `fetchFn` is injectable — production wiring
 * (`ui/main.ts`) passes the real `window.fetch`; tests never touch the network.
 */
import type { LaunchResult, LaunchSpec } from '../../../ports/session-launcher.port';
import type { LaunchClient } from '../../../ui/containers/OfficeContainer';

export type FetchFn = (url: string, init: RequestInit) => Promise<Pick<Response, 'json'>>;

export interface FetchLaunchClientOptions {
  fetchFn: FetchFn;
  baseUrl: string;
}

export class FetchLaunchClient implements LaunchClient {
  constructor(private readonly options: FetchLaunchClientOptions) {}

  async requestLaunch(spec: LaunchSpec): Promise<LaunchResult> {
    const response = await this.options.fetchFn(this.options.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
    return (await response.json()) as LaunchResult;
  }
}

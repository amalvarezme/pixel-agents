/**
 * Browser entry point (browser-entrypoint work unit). The composition root for the CLIENT half of
 * the app — mirrors `src/server.ts` on the server side. Wires:
 *
 *   `EventSourceStreamConnection` (real `window.EventSource`) -> `OfficeContainer` -> `OfficeStage`
 *   -> `PixiOfficeRenderer` (real PixiJS `Application`, mounted to `#office`)
 *
 * This file is intentionally thin, untested glue — every piece it wires together already has its
 * own unit/integration tests (`event-source-stream-connection.test.ts`, `OfficeContainer.test.ts`,
 * `pixi-office-renderer.test.ts`). It is verified only by actually loading the page in a browser
 * (README "Running it").
 */
import { OfficeContainer } from './containers/OfficeContainer';
import { OfficeStage } from './scene/OfficeStage';
import { PixiOfficeRenderer } from './scene/pixi/pixi-office-renderer';
import { EventSourceStreamConnection } from '../adapters/driving/browser/event-source-stream-connection';

async function main(): Promise<void> {
  const mountPoint = document.getElementById('office');
  if (!mountPoint) throw new Error('main.ts: missing #office mount point in index.html');

  const renderer = await PixiOfficeRenderer.mount(mountPoint);
  const stage = new OfficeStage(renderer);

  const connectionFactory = new EventSourceStreamConnection({
    createEventSource: (url) => new EventSource(url),
    baseUrl: '/stream',
  });

  const container = new OfficeContainer(connectionFactory, stage);
  container.connect();
}

void main();

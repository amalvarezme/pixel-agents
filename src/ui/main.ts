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
import { FetchLaunchClient } from '../adapters/driving/browser/fetch-launch-client';
import { buildLaunchControlView } from './components/organisms/launch-control';

/**
 * tasks.md 26.2: renders one button per supported launch target and wires it to
 * `OfficeContainer.requestLaunch`. Thin, untested glue — `buildLaunchControlView` (pure) and
 * `FetchLaunchClient`/`OfficeContainer.requestLaunch` (both unit-tested) already cover the logic;
 * this function only creates DOM nodes, verified by loading the page (README).
 */
function renderLaunchControl(container: OfficeContainer): void {
  const mountPoint = document.getElementById('launch-control');
  if (!mountPoint) return;
  for (const target of buildLaunchControlView().targets) {
    const button = document.createElement('button');
    button.textContent = `Launch ${target.label}`;
    button.addEventListener('click', () => {
      void container.requestLaunch({ harness: target.harness, cwd: '.', args: [] });
    });
    mountPoint.appendChild(button);
  }
}

async function main(): Promise<void> {
  const mountPoint = document.getElementById('office');
  if (!mountPoint) throw new Error('main.ts: missing #office mount point in index.html');

  const renderer = await PixiOfficeRenderer.mount(mountPoint);
  const stage = new OfficeStage(renderer);

  const connectionFactory = new EventSourceStreamConnection({
    createEventSource: (url) => new EventSource(url),
    baseUrl: '/stream',
  });

  const launchClient = new FetchLaunchClient({ fetchFn: (url, init) => fetch(url, init), baseUrl: '/launch' });
  const container = new OfficeContainer(connectionFactory, stage, launchClient);
  container.connect();
  renderLaunchControl(container);

  // Drives the archive-trip animation (blocker B.2, tasks.md 21.2) from the browser's own frame
  // clock — deliberately never from `container`'s own SSE message handling, so ingestion speed
  // and animation playback speed stay decoupled (`OfficeContainer.test.ts` pins this).
  const animate = (now: number): void => {
    container.tick(now);
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

void main();

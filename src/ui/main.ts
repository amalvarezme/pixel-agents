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
import { computeTooltipPlacement, type ScreenPoint } from './scene/layout/hover-hit-test';
import type { AgentTooltipView } from './components/atoms/agent-tooltip';
import { buildProjectRoster } from './components/organisms/project-roster';
import { characterPortraitUrl } from './scene/character/character-sprite';
import type { OfficeViewModel } from './state/office-view-model';
import type { OfficeRenderer } from './scene/OfficeStage';

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

/**
 * tasks.md hover tooltip: thin, untested DOM glue — `buildAgentTooltip`/`buildWorkerView` (pure)
 * already decided the tooltip CONTENT, and `computeTooltipPlacement` (pure, `hover-hit-test.ts`)
 * already decided WHERE it goes; this function only fills and positions the `#agent-tooltip`
 * element, verified by loading the page (README), same as `renderLaunchControl` above.
 */
function renderAgentTooltip(): (tooltip: AgentTooltipView | null, pointer: ScreenPoint) => void {
  const element = document.getElementById('agent-tooltip');
  if (!element) return () => {};

  return (tooltip, pointer) => {
    if (!tooltip) {
      element.hidden = true;
      return;
    }

    const portrait = document.createElement('img');
    portrait.className = 'agent-tooltip-portrait';
    portrait.src = tooltip.portraitUrl;
    portrait.alt = '';

    element.replaceChildren(
      portrait,
      ...tooltip.rows.map((row) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'agent-tooltip-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'agent-tooltip-label';
        labelEl.textContent = row.label;

        const valueEl = document.createElement('span');
        valueEl.className = 'agent-tooltip-value';
        valueEl.textContent = row.value;

        rowEl.append(labelEl, valueEl);
        return rowEl;
      }),
    );
    element.hidden = false;

    const panel = element.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const placement = computeTooltipPlacement(pointer, { width: panel.width, height: panel.height }, viewport);
    element.style.left = `${placement.x}px`;
    element.style.top = `${placement.y}px`;
  };
}

/**
 * Active-project roster (`components/organisms/project-roster.ts`): thin, untested DOM glue in the
 * same bucket as `renderLaunchControl` and `renderAgentTooltip` above — the grouping, counting and
 * ordering are all decided by the pure builder, which has its own tests.
 */
function renderProjectRoster(): (viewModel: OfficeViewModel) => void {
  const element = document.getElementById('project-roster');
  if (!element) return () => {};

  return (viewModel) => {
    // `roster`, never `workers`: the floor draws at most 8 desks and reports the rest only as a
    // count, so a panel fed from the drawn workers would claim 8 agents on a machine running 17.
    const roster = buildProjectRoster(viewModel.roster ?? []);
    if (roster.rows.length === 0) {
      element.hidden = true;
      return;
    }

    const title = document.createElement('div');
    title.className = 'roster-title';
    const onFloor = viewModel.overflowCount > 0 ? ` · ${viewModel.workers.length} on the floor` : '';
    title.textContent = `${roster.totalProjects} project${roster.totalProjects === 1 ? '' : 's'} · ${roster.totalAgents} agent${roster.totalAgents === 1 ? '' : 's'}${onFloor}`;

    element.replaceChildren(
      title,
      ...roster.rows.map((row) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'roster-row';

        const face = document.createElement('img');
        face.className = 'roster-face';
        face.src = characterPortraitUrl(row.character);
        face.alt = '';

        const name = document.createElement('span');
        name.className = 'roster-name';
        name.textContent = row.project;

        const counts = document.createElement('span');
        counts.className = 'roster-counts';
        const working = document.createElement('span');
        working.className = 'roster-working';
        working.textContent = String(row.working);
        counts.append(working, document.createTextNode(` working · ${row.idle} idle`));

        rowEl.append(face, name, counts);
        return rowEl;
      }),
    );
    element.hidden = false;
  };
}

async function main(): Promise<void> {
  const mountPoint = document.getElementById('office');
  if (!mountPoint) throw new Error('main.ts: missing #office mount point in index.html');

  const renderer = await PixiOfficeRenderer.mount(mountPoint, { onHoverChange: renderAgentTooltip() });
  // One stage, two presentations of the SAME view model: the PixiJS floor and the DOM roster
  // beside it. Composed here, in the composition root, so neither `OfficeStage` nor the PixiJS
  // renderer has to learn about the other.
  const updateRoster = renderProjectRoster();
  const sceneAndRoster: OfficeRenderer = {
    render: (viewModel) => {
      renderer.render(viewModel);
      updateRoster(viewModel);
    },
  };
  const stage = new OfficeStage(sceneAndRoster);

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

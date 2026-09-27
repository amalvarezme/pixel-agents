/**
 * Slice 2 (odd/tasks/office-mcp.md): the idempotent lifecycle manager over the visualizer.
 *
 * The load-bearing properties, each pinned below:
 *  - the port is probed BEFORE anything is spawned (the visualizer has no `EADDRINUSE` handling);
 *  - a start is idempotent, and a foreign process on the default port yields a free port instead
 *    of a crash;
 *  - `office_stop` stops the process THIS server manages and never one it did not spawn;
 *  - an exited child stops being reported as up.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OfficeHttpClient, OfficeSnapshot, PortProbe } from './office-client';
import { OfficeController, type VisualizerHandle, type VisualizerSpawnContext } from './office-controller';

interface FakeHandle extends VisualizerHandle {
  emitExit(code?: number | null, signal?: NodeJS.Signals | null): void;
  emitError(error: Error): void;
}

function makeHandle(pid = 4242): FakeHandle {
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  return {
    pid,
    onExit: (listener) => void exitListeners.push(listener),
    onError: (listener) => void errorListeners.push(listener),
    kill: vi.fn(() => true),
    emitExit: (code = 0, signal = null) => {
      for (const listener of exitListeners) listener(code, signal);
    },
    emitError: (error) => {
      for (const listener of errorListeners) listener(error);
    },
  };
}

function emptySnapshot(workerCount = 0): OfficeSnapshot {
  return {
    generatedAt: 1,
    workers: Array.from({ length: workerCount }, (_unused, index) => ({
      sessionKey: `claude-code:s${index}`,
      harness: 'claude-code' as const,
      label: `s${index}`,
      activity: 'working' as const,
      parentSessionKey: null,
    })),
    archive: { slots: [], waitQueue: [], nextSlotCursor: 0 },
    carryQueues: [],
  };
}

interface FakeClient extends OfficeHttpClient {
  probe: ReturnType<typeof vi.fn<(port: number, timeoutMs?: number) => Promise<PortProbe>>>;
  findFreePort: ReturnType<typeof vi.fn<() => Promise<number>>>;
  readSnapshot: ReturnType<typeof vi.fn<(baseUrl: string, timeoutMs?: number) => Promise<OfficeSnapshot>>>;
  postLaunch: ReturnType<typeof vi.fn>;
}

/** A probe that reports "free" once (so a start spawns), then "ours" (so readiness resolves). */
function freeThenOurs(): FakeClient['probe'] {
  let first = true;
  return vi.fn(async () => {
    const value: PortProbe = first ? 'free' : 'ours';
    first = false;
    return value;
  });
}

function makeClient(overrides: Partial<OfficeHttpClient> = {}): FakeClient {
  return {
    probe: vi.fn(async () => 'free' as PortProbe),
    findFreePort: vi.fn(async () => 5555),
    readSnapshot: vi.fn(async () => emptySnapshot()),
    postLaunch: vi.fn(async () => ({ status: 200, body: { outcome: 'started' } })),
    ...overrides,
  } as FakeClient;
}

function makeController(options: {
  client: FakeClient;
  spawnVisualizer: (context: VisualizerSpawnContext) => VisualizerHandle;
  env?: NodeJS.ProcessEnv;
  defaultPort?: number;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  shutdownGraceMs?: number;
}) {
  return new OfficeController({
    projectRoot: '/repo',
    client: options.client,
    spawnVisualizer: options.spawnVisualizer,
    env: options.env ?? {},
    defaultPort: options.defaultPort ?? 4317,
    readinessTimeoutMs: options.readinessTimeoutMs ?? 500,
    readinessPollMs: options.readinessPollMs ?? 5,
    shutdownGraceMs: options.shutdownGraceMs ?? 200,
  });
}

describe('office lifecycle controller (slice 2)', () => {
  it('probes the default port BEFORE spawning and spawns on it when free', async () => {
    const handle = makeHandle();
    const order: string[] = [];
    let probed = false;
    const client = makeClient({
      probe: vi.fn(async () => {
        order.push('probe');
        const value: PortProbe = probed ? 'ours' : 'free';
        probed = true;
        return value;
      }),
    });
    const spawnVisualizer = vi.fn((context: VisualizerSpawnContext) => {
      order.push('spawn');
      expect(context.port).toBe(4317);
      return handle;
    });
    const controller = makeController({ client, spawnVisualizer });

    const result = await controller.start();

    expect(order[0]).toBe('probe');
    expect(order[1]).toBe('spawn');
    expect(result.url).toBe('http://127.0.0.1:4317');
    expect(result.port).toBe(4317);
    expect(result.alreadyRunning).toBe(false);
  });

  it('is idempotent: an office already answering on the default port is returned without spawning', async () => {
    const client = makeClient({ probe: vi.fn(async () => 'ours' as PortProbe) });
    const spawnVisualizer = vi.fn(() => makeHandle());
    const controller = makeController({ client, spawnVisualizer });

    const result = await controller.start();

    expect(spawnVisualizer).not.toHaveBeenCalled();
    expect(result.url).toBe('http://127.0.0.1:4317');
    expect(result.alreadyRunning).toBe(true);
  });

  it('picks a free port when the default port is held by a FOREIGN process', async () => {
    const client = makeClient({
      findFreePort: vi.fn(async () => 6123),
    });
    // First probe (before spawning) sees a foreign process; after spawning, readiness sees ours.
    client.probe.mockImplementation(async () => 'ours' as PortProbe);
    client.probe.mockResolvedValueOnce('foreign' as PortProbe);
    const spawnVisualizer = vi.fn((context: VisualizerSpawnContext) => {
      expect(context.port).toBe(6123);
      return makeHandle();
    });
    const controller = makeController({ client, spawnVisualizer });

    const result = await controller.start();

    expect(client.findFreePort).toHaveBeenCalledTimes(1);
    expect(result.port).toBe(6123);
    expect(result.url).toBe('http://127.0.0.1:6123');
  });

  it('never spawns a second process while one is already managed', async () => {
    const client = makeClient({ probe: freeThenOurs() });
    const spawnVisualizer = vi.fn(() => makeHandle());
    const controller = makeController({ client, spawnVisualizer });

    const first = await controller.start();
    const second = await controller.start();

    expect(spawnVisualizer).toHaveBeenCalledTimes(1);
    expect(second.url).toBe(first.url);
  });

  it('reports up:false with a null session count when nothing answers', async () => {
    const client = makeClient({ probe: vi.fn(async () => 'free' as PortProbe) });
    const controller = makeController({ client, spawnVisualizer: vi.fn(() => makeHandle()) });

    const status = await controller.status();

    expect(status.up).toBe(false);
    expect(status.url).toBeNull();
    expect(status.sessionCount).toBeNull();
  });

  it('reports a running but EMPTY office as up:true with sessionCount 0 (not a fault)', async () => {
    const client = makeClient({
      probe: vi.fn(async () => 'ours' as PortProbe),
      readSnapshot: vi.fn(async () => emptySnapshot(0)),
    });
    const controller = makeController({ client, spawnVisualizer: vi.fn(() => makeHandle()) });

    const status = await controller.status();

    expect(status.up).toBe(true);
    expect(status.sessionCount).toBe(0);
    expect(status.url).toBe('http://127.0.0.1:4317');
  });

  it('reports the harnesses enabled in the child environment, honouring the kill switches', async () => {
    const client = makeClient({ probe: vi.fn(async () => 'ours' as PortProbe) });
    const allOn = makeController({ client, spawnVisualizer: vi.fn(() => makeHandle()) });
    expect((await allOn.status()).harnesses).toEqual(['claude-code', 'codex', 'opencode', 'antigravity', 'pi']);

    const someOff = makeController({
      client,
      spawnVisualizer: vi.fn(() => makeHandle()),
      env: { CODEX_ENABLED: 'false', PI_ENABLED: 'false' },
    });
    expect((await someOff.status()).harnesses).toEqual(['claude-code', 'opencode', 'antigravity']);
  });

  it('stop kills ONLY the process this server spawned and reports stopped:true', async () => {
    let spawned: FakeHandle | null = null;
    const client = makeClient({ probe: freeThenOurs() });
    const controller = makeController({
      client,
      spawnVisualizer: () => {
        spawned = makeHandle();
        return spawned;
      },
    });
    await controller.start();

    const stopping = controller.stop();
    // The OS reports the process gone, which is what lets `stop` resolve instead of timing out.
    spawned!.emitExit(0, 'SIGTERM');
    const result = await stopping;

    expect(result.stopped).toBe(true);
    expect(spawned!.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop reports stopped:false and kills NOTHING when this server manages no process', async () => {
    const client = makeClient({ probe: vi.fn(async () => 'ours' as PortProbe) });
    const controller = makeController({ client, spawnVisualizer: vi.fn(() => makeHandle()) });

    const result = await controller.stop();

    expect(result.stopped).toBe(false);
    expect(result.note).toMatch(/manag|not spawn|did not/i);
  });

  it('a managed child that exits on its own stops being reported as up', async () => {
    const handle = makeHandle();
    let probeCalls = 0;
    let probeValue: PortProbe = 'ours';
    const client = makeClient({ probe: vi.fn(async () => (probeCalls++ === 0 ? 'free' : probeValue)) });
    const controller = makeController({ client, spawnVisualizer: () => handle });

    await controller.start();
    probeValue = 'ours';
    expect((await controller.status()).up).toBe(true);

    probeValue = 'free';
    handle.emitExit(1, null);
    expect((await controller.status()).up).toBe(false);
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it('does not orphan a spawned child that stops answering: status stays up:false but office_stop still kills it', async () => {
    const handle = makeHandle();
    let probeCalls = 0;
    let probeValue: PortProbe = 'ours';
    const client = makeClient({ probe: vi.fn(async () => (probeCalls++ === 0 ? 'free' : probeValue)) });
    const controller = makeController({ client, spawnVisualizer: () => handle });
    await controller.start();

    // The child stops answering but has NOT emitted exit yet (a hung process, not a dead one).
    probeValue = 'free';
    const status = await controller.status();
    expect(status.up).toBe(false);
    expect(status.note).toMatch(/not answering|terminate/i);

    const stopping = controller.stop();
    handle.emitExit(0, 'SIGTERM');
    const result = await stopping;
    expect(result.stopped).toBe(true);
    expect(handle.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('snapshot returns the running office snapshot and rejects with a clear message when down', async () => {
    const snapshot = emptySnapshot(2);
    const client = makeClient({
      probe: vi.fn(async () => 'ours' as PortProbe),
      readSnapshot: vi.fn(async () => snapshot),
    });
    const controller = makeController({ client, spawnVisualizer: vi.fn(() => makeHandle()) });

    await expect(controller.snapshot()).resolves.toEqual(snapshot);

    const downClient = makeClient({ probe: vi.fn(async () => 'free' as PortProbe) });
    const downController = makeController({ client: downClient, spawnVisualizer: vi.fn(() => makeHandle()) });
    await expect(downController.snapshot()).rejects.toThrow(/not running|office_start/i);
  });

  it('launch proxies the spec to the office endpoint verbatim', async () => {
    const client = makeClient({ probe: vi.fn(async () => 'ours' as PortProbe) });
    const controller = makeController({ client, spawnVisualizer: vi.fn(() => makeHandle()) });

    const result = await controller.launch({ harness: 'claude-code', cwd: '/tmp', args: [] });

    expect(result).toEqual({ status: 200, body: { outcome: 'started' } });
    expect(client.postLaunch).toHaveBeenCalledWith('http://127.0.0.1:4317', { harness: 'claude-code', cwd: '/tmp', args: [] }, expect.any(Number));
  });

  it('kills the child it spawned when the office never becomes ready, and reports the failure', async () => {
    const handle = makeHandle();
    const client = makeClient({ probe: vi.fn(async () => 'free' as PortProbe) });
    const controller = makeController({
      client,
      spawnVisualizer: () => handle,
      readinessTimeoutMs: 40,
      readinessPollMs: 5,
    });

    await expect(controller.start()).rejects.toThrow(/ready/i);
    expect(handle.kill).toHaveBeenCalledWith('SIGTERM');
    expect((await controller.status()).up).toBe(false);
  });

  it('dispose stops the managed process so the child never outlives the MCP server', async () => {
    const handle = makeHandle();
    const client = makeClient({ probe: freeThenOurs() });
    const controller = makeController({ client, spawnVisualizer: () => handle });
    await controller.start();

    const dispose = controller.dispose();
    handle.emitExit(0, 'SIGTERM');
    await dispose;

    expect(handle.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

/**
 * `ChildProcessSessionLauncher` (tasks.md Phase 24, design.md "The Launcher"). Every test drives
 * the launcher through an INJECTED fake spawn function (a bare `EventEmitter`, matching this
 * codebase's established fake-child-process pattern in `node-pty-probe.test.ts`) — no real
 * process is ever spawned by this suite, and `shell: false` is asserted explicitly wherever the
 * real spawn call is inspected.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ChildProcessSessionLauncher } from './child-process-session-launcher';
import type { AgentEvent } from '../../../domain/events/types';
import type { EventPublisher } from '../../../ports/event-publisher.port';
import type { TerminalBackend } from '../../../ports/terminal-backend.port';

function createFakeChild(pid = 4242) {
  const fake = new EventEmitter() as EventEmitter & { pid: number; kill: (signal?: string) => boolean; killedWith: string[] };
  fake.pid = pid;
  fake.killedWith = [];
  fake.kill = (signal?: string) => {
    fake.killedWith.push(signal ?? 'SIGTERM');
    return true;
  };
  return fake;
}

function createRecordingPublisher(): EventPublisher & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return { events, publish: (event) => events.push(event) };
}

describe('ChildProcessSessionLauncher — successful launch', () => {
  it('spawns with shell:false, the resolved absolute binary path, and emits launch_requested then launch_started (task 24.6)', async () => {
    const child = createFakeChild(1234);
    const spawnCalls: Array<{ command: string; args: string[]; options: { cwd: string; shell: boolean } }> = [];
    const publisher = createRecordingPublisher();
    let now = 1000;

    const launcher = new ChildProcessSessionLauncher({
      dirExistsFn: () => true,
      publisher,
      clock: { now: () => now },
      env: { PATH: '/usr/local/bin' },
      existsFn: (p) => p === '/usr/local/bin/claude',
      spawnFn: (command, args, options) => {
        spawnCalls.push({ command, args, options: { cwd: options.cwd, shell: options.shell } });
        return child as never;
      },
      mintLaunchId: () => 'launch-1',
    });

    const resultPromise = launcher.launch({ harness: 'claude-code', cwd: '/Users/dev/project', args: ['--resume', 'x'] });
    now = 1005;
    child.emit('spawn');
    const result = await resultPromise;

    expect(result).toEqual({ outcome: 'started', launchId: 'launch-1', pid: 1234, startedAt: 1005 });
    expect(spawnCalls).toEqual([
      { command: '/usr/local/bin/claude', args: ['--resume', 'x'], options: { cwd: '/Users/dev/project', shell: false } },
    ]);

    // launch_requested precedes launch_started, and BOTH carry only the launcher's own process
    // state — never anything derived from a log parse.
    expect(publisher.events.map((e) => e.kind)).toEqual(['launch_requested', 'launch_started']);
    expect(publisher.events[0]).toMatchObject({
      kind: 'launch_requested',
      launchId: 'launch-1',
      binaryPath: '/usr/local/bin/claude',
      argv: ['claude', '--resume', 'x'],
      cwd: '/Users/dev/project',
      at: 1000,
    });
    expect(publisher.events[1]).toMatchObject({ kind: 'launch_started', launchId: 'launch-1', pid: 1234, startedAt: 1005 });
  });
});

describe('ChildProcessSessionLauncher — missing binary (Threat Matrix case d, task 24.2)', () => {
  it('resolves status(launch_failed), never throws, when the binary is not on PATH', async () => {
    const publisher = createRecordingPublisher();
    const launcher = new ChildProcessSessionLauncher({
      dirExistsFn: () => true,
      publisher,
      clock: { now: () => 2000 },
      env: { PATH: '/usr/bin' },
      existsFn: () => false,
      spawnFn: () => {
        throw new Error('spawnFn must never be called when the binary cannot be resolved');
      },
      mintLaunchId: () => 'launch-2',
    });

    const result = await launcher.launch({ harness: 'claude-code', cwd: '.', args: [] });

    expect(result.outcome).toBe('failed');
    expect(publisher.events.map((e) => e.kind)).toEqual(['launch_requested', 'status']);
    expect(publisher.events[1]).toMatchObject({ kind: 'status', reason: expect.stringContaining('claude') });
  });

  // Node's spawn reports a MISSING CWD as `ENOENT` naming the BINARY, not the directory. Observed
  // live: launching into a stale path returned "spawn failed: spawn /.../claude ENOENT" while the
  // binary was present and executable. That sends whoever reads it hunting for a PATH problem that
  // does not exist. Check the directory explicitly so the reason names the real cause.
  it('resolves status(launch_failed) naming the CWD, not the binary, when the cwd does not exist', async () => {
    const publisher = createRecordingPublisher();
    const launcher = new ChildProcessSessionLauncher({
      publisher,
      clock: { now: () => 4000 },
      env: { PATH: '/usr/bin' },
      // The binary resolves fine; only the working directory is missing.
      existsFn: () => true,
      dirExistsFn: (path: string) => path !== '/gone/missing-dir',
      spawnFn: () => {
        throw new Error('spawnFn must never be called when the cwd cannot exist');
      },
      mintLaunchId: () => 'launch-cwd',
    });

    const result = await launcher.launch({ harness: 'claude-code', cwd: '/gone/missing-dir', args: [] });

    expect(result).toMatchObject({ outcome: 'failed', launchId: 'launch-cwd' });
    expect(result.outcome === 'failed' ? result.reason : '').toContain('/gone/missing-dir');
    // The old message blamed the binary; assert it does NOT, or the fix is cosmetic only.
    expect(result.outcome === 'failed' ? result.reason : '').not.toContain('not found on PATH');
    expect(publisher.events.some((e) => e.kind === 'launch_started')).toBe(false);
  });

  it('adversarial near-miss: an EXISTING cwd still reaches spawn (the guard targets the directory, not every launch)', async () => {
    const publisher = createRecordingPublisher();
    let spawned = false;
    const launcher = new ChildProcessSessionLauncher({
      publisher,
      clock: { now: () => 4100 },
      env: { PATH: '/usr/bin' },
      existsFn: () => true,
      dirExistsFn: () => true,
      spawnFn: () => {
        spawned = true;
        return createFakeChild() as never;
      },
      mintLaunchId: () => 'launch-cwd-ok',
    });

    // Deliberately not awaited: the fake child never emits `spawn`, so the launch promise never
    // settles. Reaching spawnFn at all is the whole point of this near-miss, and that happens
    // before any awaiting.
    void launcher.launch({ harness: 'claude-code', cwd: '/exists', args: [] });

    expect(spawned).toBe(true);
  });

  it('agy missing from PATH: launch_requested then a failure signal, launch_started NEVER emitted (task 24.7)', async () => {
    const publisher = createRecordingPublisher();
    const launcher = new ChildProcessSessionLauncher({
      dirExistsFn: () => true,
      publisher,
      clock: { now: () => 3000 },
      env: { PATH: '/usr/bin' },
      existsFn: () => false,
      mintLaunchId: () => 'launch-3',
    });

    const result = await launcher.launch({ harness: 'antigravity', cwd: '.', args: [] });

    expect(result).toMatchObject({ outcome: 'failed', launchId: 'launch-3' });
    expect(publisher.events.some((e) => e.kind === 'launch_started')).toBe(false);
    expect(publisher.events.map((e) => e.kind)).toEqual(['launch_requested', 'status']);
  });
});

describe('ChildProcessSessionLauncher — spawn-time error (adversarial near-miss to 24.2: binary WAS resolved, but spawn itself still fails)', () => {
  it('resolves status(launch_failed), never throws, when spawn emits an error after being resolved on PATH', async () => {
    const child = createFakeChild();
    const publisher = createRecordingPublisher();
    const launcher = new ChildProcessSessionLauncher({
      dirExistsFn: () => true,
      publisher,
      clock: { now: () => 4000 },
      env: { PATH: '/usr/local/bin' },
      existsFn: () => true,
      spawnFn: () => child as never,
      mintLaunchId: () => 'launch-4',
    });

    const resultPromise = launcher.launch({ harness: 'codex', cwd: '.', args: [] });
    child.emit('error', new Error('EACCES: permission denied'));
    const result = await resultPromise;

    expect(result).toMatchObject({ outcome: 'failed', launchId: 'launch-4' });
    expect(publisher.events.map((e) => e.kind)).toEqual(['launch_requested', 'status']);
  });
});

describe('ChildProcessSessionLauncher — tracked-child registry + shutdown (Threat Matrix case e, tasks 24.4/24.5)', () => {
  it('SIGTERMs every tracked child on shutdown', async () => {
    const childA = createFakeChild(101);
    const childB = createFakeChild(102);
    const spawnedChildren = [childA, childB];
    const publisher = createRecordingPublisher();
    const launcher = new ChildProcessSessionLauncher({
      dirExistsFn: () => true,
      publisher,
      clock: { now: () => 5000 },
      env: { PATH: '/usr/local/bin' },
      existsFn: () => true,
      spawnFn: () => spawnedChildren.shift() as never,
      mintLaunchId: (() => {
        let n = 0;
        return () => `launch-${++n}`;
      })(),
    });

    const p1 = launcher.launch({ harness: 'claude-code', cwd: '.', args: [] });
    childA.emit('spawn');
    await p1;
    const p2 = launcher.launch({ harness: 'codex', cwd: '.', args: [] });
    childB.emit('spawn');
    await p2;

    await launcher.shutdown();

    expect(childA.killedWith).toEqual(['SIGTERM']);
    expect(childB.killedWith).toEqual(['SIGTERM']);
  });

  it('adversarial near-miss: a child whose launch FAILED (never tracked) is never SIGTERMed on shutdown', async () => {
    const publisher = createRecordingPublisher();
    const launcher = new ChildProcessSessionLauncher({
      dirExistsFn: () => true,
      publisher,
      clock: { now: () => 6000 },
      env: { PATH: '/usr/bin' },
      existsFn: () => false,
      mintLaunchId: () => 'launch-5',
    });

    await launcher.launch({ harness: 'claude-code', cwd: '.', args: [] });

    // No tracked child exists for a failed launch; shutdown must simply do nothing, never throw.
    await expect(launcher.shutdown()).resolves.toBeUndefined();
  });
});

describe('ChildProcessSessionLauncher — PTY backend gate (task 24.3)', () => {
  it('surfaces a copyable command line and spawns nothing when the terminal backend probe reports unavailable', async () => {
    const publisher = createRecordingPublisher();
    const terminalBackend: TerminalBackend = { probe: async () => ({ available: false, reason: 'node-pty beta segfault risk' }) };
    let spawnCalled = false;
    const launcher = new ChildProcessSessionLauncher({
      dirExistsFn: () => true,
      publisher,
      clock: { now: () => 7000 },
      env: { PATH: '/usr/local/bin' },
      existsFn: () => true,
      terminalBackend,
      spawnFn: () => {
        spawnCalled = true;
        return createFakeChild() as never;
      },
      mintLaunchId: () => 'launch-6',
    });

    const result = await launcher.launch({ harness: 'claude-code', cwd: '/Users/dev/project', args: [], interactive: true });

    expect(result).toMatchObject({ outcome: 'unavailable_interactive', launchId: 'launch-6' });
    expect(result.outcome === 'unavailable_interactive' && result.commandLine).toContain('claude');
    expect(spawnCalled).toBe(false);
  });

  it('adversarial near-miss: a NON-interactive launch never consults the terminal backend probe, even when it would report unavailable', async () => {
    const child = createFakeChild();
    const publisher = createRecordingPublisher();
    let probeCalled = false;
    const terminalBackend: TerminalBackend = {
      probe: async () => {
        probeCalled = true;
        return { available: false, reason: 'unused' };
      },
    };
    const launcher = new ChildProcessSessionLauncher({
      dirExistsFn: () => true,
      publisher,
      clock: { now: () => 7100 },
      env: { PATH: '/usr/local/bin' },
      existsFn: () => true,
      terminalBackend,
      spawnFn: () => child as never,
      mintLaunchId: () => 'launch-7',
    });

    const resultPromise = launcher.launch({ harness: 'claude-code', cwd: '.', args: [] });
    child.emit('spawn');
    const result = await resultPromise;

    expect(probeCalled).toBe(false);
    expect(result.outcome).toBe('started');
  });
});

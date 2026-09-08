import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NodePtyProbe } from './node-pty-probe';

/**
 * Fake child process: a bare EventEmitter with a `stdout` PassThrough and a no-op `kill`. It
 * stands in for `child_process.ChildProcess` well enough to drive `NodePtyProbe`'s event
 * listeners (`data`, `exit`, `error`) without spawning a real process.
 */
function createFakeChild() {
  const fake = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void };
  fake.stdout = new PassThrough();
  fake.kill = () => {};
  return fake;
}

// Requirement (tasks.md 4.2 / design.md D5): the probe runs the node-pty capability check in a
// SHORT-LIVED CHILD PROCESS specifically because a native segfault cannot be caught in-process.
// These tests simulate that child crashing in every way a native module can fail, and assert
// `probe()` resolves `{available:false, reason}` in each case — it NEVER throws, and the parent
// test process (standing in for the real visualizer process) is still alive to make the
// assertion afterwards.
describe('NodePtyProbe (out-of-process capability probe)', () => {
  it('resolves available:true when the child process reports success on stdout', async () => {
    const child = createFakeChild();
    const probe = new NodePtyProbe({ spawnFn: () => child as never, probeScriptPath: '/fake/probe-child.mjs' });

    const resultPromise = probe.probe();
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ available: true })}\n`));
    child.emit('exit', 0, null);

    await expect(resultPromise).resolves.toEqual({ available: true });
  });

  it('resolves available:false, never throws, when the child is killed by a segfault signal', async () => {
    const child = createFakeChild();
    const probe = new NodePtyProbe({ spawnFn: () => child as never, probeScriptPath: '/fake/probe-child.mjs' });

    const resultPromise = probe.probe();
    child.emit('exit', null, 'SIGSEGV');
    const result = await resultPromise;

    expect(result).toEqual({ available: false, reason: 'probe process terminated by signal SIGSEGV' });
    // The parent process (this test process) is demonstrably still alive: we reached this
    // assertion instead of the test runner crashing.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('resolves available:false, never throws, when the child exits non-zero without a signal', async () => {
    const child = createFakeChild();
    const probe = new NodePtyProbe({ spawnFn: () => child as never, probeScriptPath: '/fake/probe-child.mjs' });

    const resultPromise = probe.probe();
    child.emit('exit', 134, null);
    const result = await resultPromise;

    expect(result).toEqual({ available: false, reason: 'probe process exited with code 134' });
  });

  it('resolves available:false when the spawn itself fails to launch the child', async () => {
    const child = createFakeChild();
    const probe = new NodePtyProbe({ spawnFn: () => child as never, probeScriptPath: '/fake/probe-child.mjs' });

    const resultPromise = probe.probe();
    child.emit('error', new Error('ENOENT: probe script not found'));
    const result = await resultPromise;

    expect(result).toEqual({ available: false, reason: 'child process error: ENOENT: probe script not found' });
  });
});

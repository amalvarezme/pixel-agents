import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../domain/events/types';
import { PiSessionHashIndex } from './correlate';
import { presenceActivityFileName, presenceHeaderFileName, type PresenceTaskStatus } from './presence-read';
import { PiPresenceSource } from './presence-source';

const PARENT_SESSION_ID = '01a0e06e-d6eb-7018-81fe-cc81a7736e52';
const SESSION_HASH = createHash('sha256').update(PARENT_SESSION_ID).digest('hex');
const INCARNATION = '5f6ea6c5-4745-45b1-b5bc-c9e442172deb';

interface TaskSpec {
  id?: string;
  agent?: string;
  label?: string;
  status?: PresenceTaskStatus;
  model?: string;
  startedAt?: number | null;
  endedAt?: number | null;
  lastActivityAt?: number;
  items?: unknown[];
  threadVersion?: number;
}

const task = (spec: TaskSpec = {}) => ({
  summary: {
    id: spec.id ?? 't1',
    agent: spec.agent ?? 'sdd-apply',
    label: spec.label ?? 'apply work unit 2',
    status: spec.status ?? 'running',
    model: spec.model ?? 'claude-sonnet-5',
    createdAt: 1_000,
    startedAt: spec.startedAt === undefined ? 1_100 : spec.startedAt,
    endedAt: spec.endedAt === undefined ? null : spec.endedAt,
    lastActivityAt: spec.lastActivityAt ?? 1_200,
  },
  thread: { version: spec.threadVersion ?? 1, dropped: 0, items: spec.items ?? [] },
});

describe('PiPresenceSource', () => {
  let piHome: string;
  let presenceRoot: string;
  let generation = 0;

  async function publish(tasks: unknown[], over: Record<string, unknown> = {}): Promise<void> {
    generation += 1;
    const body = JSON.stringify({
      schema: 1,
      sessionHash: SESSION_HASH,
      incarnation: INCARNATION,
      generation,
      activity: { tasks },
    });
    await writeFile(join(presenceRoot, presenceActivityFileName(SESSION_HASH, INCARNATION)), body);
    await writeFile(
      join(presenceRoot, presenceHeaderFileName(SESSION_HASH, INCARNATION)),
      JSON.stringify({
        schema: 1,
        sessionHash: SESSION_HASH,
        incarnation: INCARNATION,
        label: 'pixel-agents',
        heartbeat: 1_200,
        generation,
        counts: { running: 1, queued: 0, waiting: 0, finished: 0 },
        digest: createHash('sha256').update(body).digest('hex'),
        unavailable: null,
        ...over,
      }),
    );
  }

  async function makeHome(): Promise<void> {
    piHome = await mkdtemp(join(tmpdir(), 'pi-presence-source-'));
    presenceRoot = join(piHome, 'gentle-agents', 'presence');
    await mkdir(presenceRoot, { recursive: true });
    generation = 0;
  }

  function indexWithParent(): PiSessionHashIndex {
    const index = new PiSessionHashIndex();
    index.register(PARENT_SESSION_ID);
    return index;
  }

  /** Drains a task's stream until `count` events arrive, or gives up after a bounded wait. */
  async function drain(source: PiPresenceSource, sessionKey: string, count: number): Promise<AgentEvent[]> {
    const iterator = source.discover()[Symbol.asyncIterator]();
    let ref = (await iterator.next()).value;
    while (ref && ref.sessionKey !== sessionKey) ref = (await iterator.next()).value;
    const stream = source.open(ref!, null);
    const events: AgentEvent[] = [];
    const streamIterator = stream.events[Symbol.asyncIterator]();
    while (events.length < count) {
      const next = await Promise.race([
        streamIterator.next().then((r) => r.value),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_500)),
      ]);
      if (!next) break;
      events.push(next.event);
    }
    stream.stop();
    return events;
  }

  afterEach(async () => {
    if (piHome) await rm(piHome, { recursive: true, force: true });
  });

  it('reports the pi harness id', async () => {
    await makeHome();
    const source = new PiPresenceSource(piHome, indexWithParent());

    expect(source.harness).toBe('pi');
    await source.close();
  });

  it('probe() reports ready even when the presence directory has never been created', async () => {
    piHome = await mkdtemp(join(tmpdir(), 'pi-presence-source-cold-'));
    const source = new PiPresenceSource(piHome, new PiSessionHashIndex());

    expect(await source.probe()).toEqual({ status: 'ready' });
    await source.close();
  });

  it('discovers nothing and creates nothing when the presence directory is absent', async () => {
    piHome = await mkdtemp(join(tmpdir(), 'pi-presence-source-nodir-'));
    const source = new PiPresenceSource(piHome, new PiSessionHashIndex(), { cadenceMs: 20 });

    const first = await Promise.race([
      source.discover()[Symbol.asyncIterator]().next().then((r) => r.value?.sessionKey ?? 'none'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 300)),
    ]);

    expect(first).toBe('timed-out');
    await source.close();
  });

  it('discovers one session per task, keyed pi:task:<id>', async () => {
    await makeHome();
    await publish([task({ id: 't1' }), task({ id: 't2', label: 'verify' })]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const first = (await iterator.next()).value;
    const second = (await iterator.next()).value;

    expect([first?.sessionKey, second?.sessionKey]).toEqual(['pi:task:t1', 'pi:task:t2']);
    await source.close();
  });

  it('emits session_start and parent for a first-seen task, linking it to its orchestrator', async () => {
    await makeHome();
    await publish([task()]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 2);

    expect(events[0]).toMatchObject({
      kind: 'session_start',
      harness: 'pi',
      sessionKey: 'pi:task:t1',
      label: 'apply work unit 2',
      agentProfile: { role: 'subagent', agentType: 'sdd-apply', model: 'claude-sonnet-5', task: 'apply work unit 2' },
    });
    expect(events[1]).toMatchObject({
      kind: 'parent',
      sessionKey: 'pi:task:t1',
      correlationId: `pi:${PARENT_SESSION_ID}`,
    });
    await source.close();
  });

  it("publishes a task whose parent is unknown, inventing no parent (agent tree's orphan grace owns it)", async () => {
    await makeHome();
    await publish([task()]);
    const source = new PiPresenceSource(piHome, new PiSessionHashIndex(), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 2);

    expect(events[0]?.kind).toBe('session_start');
    expect(events.some((event) => event.kind === 'parent')).toBe(false);
    await source.close();
  });

  it("uses the task's own lastActivityAt as the event time, never the scan time", async () => {
    await makeHome();
    await publish([task({ lastActivityAt: 7_777 })]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20, now: () => 9_999_999 });

    const events = await drain(source, 'pi:task:t1', 1);

    expect(events[0]?.at).toBe(7_777);
    await source.close();
  });

  /**
   * Regression, caught live: the office projection uses `label` as the worker's NAME, so a status
   * event carrying the task's status there renamed the worker to "running" and threw away the task
   * label its own `session_start` had just published.
   */
  it('never lets a status event overwrite the worker label with the status value', async () => {
    await makeHome();
    await publish([task({ label: 'apply work unit 2' })]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 3);
    const status = events.find((event) => event.kind === 'status');

    expect(events[0]?.label).toBe('apply work unit 2');
    expect(status).toBeDefined();
    expect(status?.label).toBeUndefined();
    await source.close();
  });

  it('never claims liveness on a status event — `activity` belongs to the lifecycle coordinator', async () => {
    await makeHome();
    await publish([task({ status: 'queued', startedAt: null })]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 3);
    const status = events.find((event) => event.kind === 'status');

    expect(status).toBeDefined();
    expect(status?.activity).toBeUndefined();
    await source.close();
  });

  it('omits an agentProfile field the registry reported as an empty string', async () => {
    await makeHome();
    await publish([task({ model: '' })]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 1);

    expect(events[0]?.agentProfile?.model).toBeUndefined();
    expect(events[0]?.agentProfile?.agentType).toBe('sdd-apply');
    await source.close();
  });

  it('emits tool_start for a running thread item and tool_end when it stops running', async () => {
    await makeHome();
    await publish([
      task({ items: [{ kind: 'tool', callId: 'c1', name: 'bash', output: '', running: true, isError: false }] }),
    ]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const ref = (await iterator.next()).value;
    const stream = source.open(ref!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();

    const seen: AgentEvent[] = [];
    for (let i = 0; i < 4; i++) seen.push((await streamIterator.next()).value!.event);
    // The first read of a task establishes everything at once: it exists, whose child it is, what
    // state it is in, and what it is currently doing.
    expect(seen.map((e) => e.kind)).toEqual(['session_start', 'parent', 'status', 'tool_start']);
    expect(seen[3]).toMatchObject({ toolLabel: 'bash' });

    await publish([
      task({
        threadVersion: 2,
        items: [{ kind: 'tool', callId: 'c1', name: 'bash', output: 'ok', running: false, isError: false }],
      }),
    ]);

    const ended = (await streamIterator.next()).value!.event;
    expect(ended).toMatchObject({ kind: 'tool_end', toolLabel: 'bash' });
    expect(ended.reason).toBeUndefined();

    stream.stop();
    await source.close();
  });

  it('carries a reason on tool_end when the tool reported an error', async () => {
    await makeHome();
    await publish([
      task({ items: [{ kind: 'tool', callId: 'c1', name: 'bash', output: '', running: true, isError: false }] }),
    ]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const ref = (await iterator.next()).value;
    const stream = source.open(ref!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();
    for (let i = 0; i < 4; i++) await streamIterator.next();

    await publish([
      task({
        threadVersion: 2,
        items: [{ kind: 'tool', callId: 'c1', name: 'bash', output: 'boom', running: false, isError: true }],
      }),
    ]);

    const ended = (await streamIterator.next()).value!.event;
    expect(ended).toMatchObject({ kind: 'tool_end', toolLabel: 'bash' });
    expect(ended.reason).toBeDefined();

    stream.stop();
    await source.close();
  });

  it('emits session_end when a task reaches a terminal status', async () => {
    await makeHome();
    await publish([task()]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const ref = (await iterator.next()).value;
    const stream = source.open(ref!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();
    // session_start, parent, and the initial `running` status.
    for (let i = 0; i < 3; i++) await streamIterator.next();

    await publish([task({ status: 'failed', endedAt: 1_300, lastActivityAt: 1_300, threadVersion: 2 })]);

    expect((await streamIterator.next()).value!.event).toMatchObject({ kind: 'status' });
    expect((await streamIterator.next()).value!.event).toMatchObject({ kind: 'session_end', at: 1_300 });

    stream.stop();
    await source.close();
  });

  it('publishes the header counts as a stats event when the activity is too large to read', async () => {
    await makeHome();
    await publish([task()], { digest: null, unavailable: 'activity-too-large' });
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const stats = await new Promise<AgentEvent | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 1_000);
      const unsubscribe = source.onRegistryStats((event) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
      void source.discover()[Symbol.asyncIterator]().next();
    });

    expect(stats).toMatchObject({ kind: 'stats', harness: 'pi' });
    await source.close();
  });

  it('advances a generation checkpoint so the same activity is never republished', async () => {
    await makeHome();
    await publish([task()]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const ref = (await iterator.next()).value;
    const stream = source.open(ref!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();
    const first = (await streamIterator.next()).value!;

    expect(first.checkpoint).toMatchObject({
      kind: 'generation',
      byActivation: { [`${SESSION_HASH}.${INCARNATION}`]: 1 },
    });

    // No new publication: the pump must go quiet rather than re-emit the same task.
    await streamIterator.next(); // parent
    await streamIterator.next(); // the initial status
    const quiet = await Promise.race([
      streamIterator.next().then(() => 'emitted'),
      new Promise<string>((resolve) => setTimeout(() => resolve('quiet'), 500)),
    ]);
    expect(quiet).toBe('quiet');

    stream.stop();
    await source.close();
  });

  it('resumes from a supplied checkpoint without replaying the task it already published', async () => {
    await makeHome();
    await publish([task()]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const ref = (await iterator.next()).value;
    const stream = source.open(ref!, {
      kind: 'generation',
      byActivation: { [`${SESSION_HASH}.${INCARNATION}`]: 1 },
      threadByTask: { [`${SESSION_HASH}.${INCARNATION}.t1`]: 1 },
      statusByTask: { [`${SESSION_HASH}.${INCARNATION}.t1`]: 'running' },
    });

    const quiet = await Promise.race([
      stream.events[Symbol.asyncIterator]()
        .next()
        .then((r) => r.value?.event.kind ?? 'none'),
      new Promise<string>((resolve) => setTimeout(() => resolve('quiet'), 500)),
    ]);

    expect(quiet).toBe('quiet');
    stream.stop();
    await source.close();
  });
});

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, MemoryWriteEvent } from '../../../domain/events/types';
import { applyEventToOfficeState, createOfficeState } from '../../../domain/office/office';
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

  function indexWithParent(parentCwd: string | null = null): PiSessionHashIndex {
    const index = new PiSessionHashIndex();
    index.register(PARENT_SESSION_ID, parentCwd);
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

  /** Opens a task's stream and keeps its iterator, for tests that must act BETWEEN two events. */
  async function openTaskStream(source: PiPresenceSource, sessionKey: string) {
    const iterator = source.discover()[Symbol.asyncIterator]();
    let ref = (await iterator.next()).value;
    while (ref && ref.sessionKey !== sessionKey) ref = (await iterator.next()).value;
    const stream = source.open(ref!, null);
    return { stream, events: stream.events[Symbol.asyncIterator]() };
  }

  /** The next event, or `undefined` if none arrives within `timeoutMs`. */
  async function nextEvent(
    events: AsyncIterator<{ event: AgentEvent }>,
    timeoutMs = 1_500,
  ): Promise<AgentEvent | undefined> {
    return Promise.race([
      events.next().then((result) => result.value?.event),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
  }

  /** Reads past events this test does not care about until `predicate` matches, or the bound elapses. */
  async function nextEventWhere(
    events: AsyncIterator<{ event: AgentEvent }>,
    predicate: (event: AgentEvent) => boolean,
    timeoutMs = 2_000,
  ): Promise<AgentEvent | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const event = await nextEvent(events, remaining);
      if (!event) return undefined;
      if (predicate(event)) return event;
    }
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

  /**
   * F2 (phantom second project). A Pi subagent's registry header carries a project NAME, never a
   * path, so the subagent's own events cannot state a project. But the PARENT orchestrator's
   * transcript DOES carry the real `cwd`, and the parent is already identified by the hash join —
   * so inheriting that known path is a lookup, not a guess. Without it the subagent renders as
   * `Unknown` and the roster reports a phantom second project.
   */
  it("inherits the resolved parent's real project path onto the subagent's session_start", async () => {
    await makeHome();
    await publish([task()]);
    const source = new PiPresenceSource(piHome, indexWithParent('/Users/dev/pixel-agents'), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 1);

    expect(events[0]).toMatchObject({
      kind: 'session_start',
      sessionKey: 'pi:task:t1',
      projectPath: '/Users/dev/pixel-agents',
    });
    await source.close();
  });

  it('invents no project path when the parent hash does not resolve (adversarial twin)', async () => {
    await makeHome();
    await publish([task()]);
    const source = new PiPresenceSource(piHome, new PiSessionHashIndex(), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 1);

    expect(events[0]?.kind).toBe('session_start');
    expect(events[0]?.projectPath).toBeUndefined();
    await source.close();
  });

  it('invents no project path when the parent resolved but its transcript yielded no cwd (adversarial twin)', async () => {
    await makeHome();
    await publish([task()]);
    const source = new PiPresenceSource(piHome, indexWithParent(null), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 1);

    expect(events[0]?.kind).toBe('session_start');
    expect(events[0]?.projectPath).toBeUndefined();
    await source.close();
  });

  /**
   * 11.6 seam. The roster reads `OfficeState`, so the RED has to live where the real events meet
   * that fold: once the subagent's `session_start` carries the parent's path, `applyEventToOfficeState`
   * attributes BOTH workers to the same project. Before the fix `events[0].projectPath` is absent,
   * the subagent lands under `Unknown`, and the roster reports a phantom second project for one
   * real one (`2 PROJECTS` for a single checkout). The office fold itself never changes — the path
   * crosses the boundary as an ordinary event field.
   */
  it('attributes the subagent to the orchestrator project once folded into OfficeState (11.6 seam)', async () => {
    await makeHome();
    await publish([task()]);
    const source = new PiPresenceSource(piHome, indexWithParent('/Users/dev/pixel-agents'), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 1);

    let state = createOfficeState();
    // The orchestrator's OWN session_start (PiActivitySource) already carries the real cwd.
    state = applyEventToOfficeState(state, {
      id: 1,
      kind: 'session_start',
      harness: 'pi',
      sessionKey: `pi:${PARENT_SESSION_ID}`,
      at: 1_000,
      projectPath: '/Users/dev/pixel-agents',
      agentProfile: { role: 'orchestrator' },
    });
    state = applyEventToOfficeState(state, events[0]!);

    expect(state.workers.get(`pi:${PARENT_SESSION_ID}`)?.projectPath).toBe('/Users/dev/pixel-agents');
    expect(state.workers.get('pi:task:t1')?.projectPath).toBe('/Users/dev/pixel-agents');
    await source.close();
  });

  /**
   * Ordering hazard (src/server.ts:135-137): the presence source can drain a subagent BEFORE its
   * parent transcript has been registered. The inherited path is a LOOKUP that may resolve late,
   * so the source must not cache the earlier absence forever. The re-announced `session_start`
   * carries the full identity (label/profile + projectPath), because the lifecycle coordinator
   * replaces its retained SessionIdentity from that event.
   */
  it('inherits the parent project path when the parent is registered only AFTER the subagent is drained', async () => {
    await makeHome();
    await publish([task()]);
    const index = new PiSessionHashIndex();
    const source = new PiPresenceSource(piHome, index, { cadenceMs: 20 });
    const { stream, events } = await openTaskStream(source, 'pi:task:t1');

    const first = await nextEvent(events);
    expect(first?.kind).toBe('session_start');
    expect(first?.projectPath).toBeUndefined();

    // The parent becomes resolvable now — after the subagent's first session_start already went out.
    index.register(PARENT_SESSION_ID, '/Users/dev/pixel-agents');

    const inherited = await nextEventWhere(
      events,
      (event) => event.kind === 'session_start' && event.projectPath !== undefined,
    );

    expect(inherited?.projectPath).toBe('/Users/dev/pixel-agents');
    expect(inherited?.label).toBe('apply work unit 2');
    stream.stop();
    await source.close();
  });

  /**
   * Triangulation on the same late-resolution path: the re-announcement must happen AT MOST once
   * per newly resolved value. Because the pump re-reads the registry on every cadence, a cursor
   * that forgot the value it already announced would re-emit the FULL identity on every poll — a
   * stream of duplicate `session_start`s that resets the office worker's identity each time. The
   * value never changes here, so the pump must go quiet after the one re-announcement.
   */
  it('re-announces the inherited path at most once, never on every poll', async () => {
    await makeHome();
    await publish([task()]);
    const index = new PiSessionHashIndex();
    const source = new PiPresenceSource(piHome, index, { cadenceMs: 20 });
    const { stream, events } = await openTaskStream(source, 'pi:task:t1');

    await nextEvent(events); // the first session_start, before the parent resolves
    index.register(PARENT_SESSION_ID, '/Users/dev/pixel-agents');

    const inherited = await nextEventWhere(
      events,
      (event) => event.kind === 'session_start' && event.projectPath !== undefined,
    );
    expect(inherited?.projectPath).toBe('/Users/dev/pixel-agents');

    // A second identical announcement would mean the cursor never remembered the value.
    const duplicate = await nextEventWhere(
      events,
      (event) => event.kind === 'session_start' && event.projectPath !== undefined,
      500,
    );
    expect(duplicate).toBeUndefined();
    stream.stop();
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
    // The status value travels here instead.
    expect(status?.lifecycle).toBe('running');
    await source.close();
  });

  it('carries every reported status through as a lifecycle, and never claims liveness', async () => {
    await makeHome();
    await publish([task({ status: 'queued', startedAt: null })]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 3);
    const status = events.find((event) => event.kind === 'status');

    expect(status?.lifecycle).toBe('queued');
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

  /** One registry thread item, matching the presence-read shape `{kind,callId,name,output,running,isError}`. */
  function toolItem(callId: string, name: string, running: boolean): unknown {
    return { kind: 'tool', callId, name, output: '', running, isError: false };
  }

  /**
   * F3 (13.1). A Pi subagent's activity exists ONLY in the presence registry, never in the
   * orchestrator transcript, so `walkPiTranscript` can never see a subagent's `mem_save`. The
   * presence source therefore emits the `memory_write` itself, IN ADDITION to the `tool_start`
   * (spec: "mem_save produces both events"). The cursor's `runningCalls` gate is what makes it fire
   * exactly once per call: republishing the SAME running call under a new thread version re-runs the
   * diff, and a cursor that forgot the open call would emit a second `memory_write` on every poll.
   */
  it('emits memory_write in addition to tool_start for a subagent mem_save, exactly once per call (13.1)', async () => {
    await makeHome();
    await publish([task({ items: [toolItem('c1', 'mem_save', true)] })]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });
    const { stream, events } = await openTaskStream(source, 'pi:task:t1');

    const toolStart = await nextEventWhere(events, (event) => event.kind === 'tool_start');
    const write = await nextEventWhere(events, (event) => event.kind === 'memory_write');

    expect(toolStart).toMatchObject({ kind: 'tool_start', toolLabel: 'mem_save' });
    expect(write).toMatchObject({ kind: 'memory_write', toolLabel: 'mem_save' });
    // The registry item carries no tool arguments, so nothing may be synthesized. (`AgentEvent`'s
    // union collapses to `AgentEventBase` because `MemoryWriteEvent` extends it, so the narrowed
    // value needs one local cast to reach its extra fields.)
    const memoryWrite = write?.kind === 'memory_write' ? (write as MemoryWriteEvent) : undefined;
    expect(memoryWrite).toBeDefined();
    expect(memoryWrite?.title).toBeUndefined();
    expect(memoryWrite?.topicKey).toBeUndefined();
    expect(memoryWrite?.observationType).toBeUndefined();

    // Same running call, new thread version: the diff re-runs, the cursor must not re-open it.
    await publish([task({ threadVersion: 2, items: [toolItem('c1', 'mem_save', true)] })]);
    const duplicate = await nextEventWhere(events, (event) => event.kind === 'memory_write', 500);
    expect(duplicate).toBeUndefined();

    stream.stop();
    await source.close();
  });

  /** 13.2 adversarial twin: every other tool opens a call and never docks a file. */
  it('never emits memory_write for a thread item that is not a mem_save (13.2)', async () => {
    await makeHome();
    await publish([
      task({
        items: [toolItem('c1', 'bash', true), toolItem('c2', 'read', true), toolItem('c3', 'edit', true)],
      }),
    ]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });
    const { stream, events } = await openTaskStream(source, 'pi:task:t1');

    const opens: AgentEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const next = await nextEventWhere(events, (event) => event.kind === 'tool_start');
      if (next) opens.push(next);
    }
    expect(opens.map((event) => event.toolLabel)).toEqual(['bash', 'read', 'edit']);

    const write = await nextEventWhere(events, (event) => event.kind === 'memory_write', 500);
    expect(write).toBeUndefined();

    stream.stop();
    await source.close();
  });

  /** 13.3 the MCP-gateway spelling is accepted by the SAME predicate, and the label is normalized. */
  it('matches the MCP-prefixed mem_save spelling and normalizes the label to mem_save (13.3)', async () => {
    await makeHome();
    await publish([task({ items: [toolItem('c1', 'mcp__engram__mem_save', true)] })]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });
    const { stream, events } = await openTaskStream(source, 'pi:task:t1');

    const write = await nextEventWhere(events, (event) => event.kind === 'memory_write');

    expect(write).toMatchObject({ kind: 'memory_write', toolLabel: 'mem_save' });

    stream.stop();
    await source.close();
  });

  /**
   * 13.6 seam, mirroring the 11.6 fold test: an event that never reaches the office would be no fix
   * at all. The subagent's `mem_save` has to occupy a real archive docking slot once folded.
   */
  it('docks an archive slot when the subagent memory_write is folded into OfficeState (13.6 seam)', async () => {
    await makeHome();
    await publish([task({ items: [toolItem('c1', 'mem_save', true)] })]);
    const source = new PiPresenceSource(piHome, indexWithParent('/Users/dev/pixel-agents'), { cadenceMs: 20 });

    const events = await drain(source, 'pi:task:t1', 5);

    let state = createOfficeState();
    for (const event of events) state = applyEventToOfficeState(state, event);

    expect(state.archive.slots.some((slot) => slot.occupiedBySessionKey === 'pi:task:t1')).toBe(true);
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

    expect((await streamIterator.next()).value!.event).toMatchObject({ kind: 'status', lifecycle: 'failed' });
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

  /**
   * Caught by live verification, after a server restart: a checkpoint is NOT evidence that this
   * task's worker still exists on the floor. The office lives in memory, so a restart empties it
   * while the checkpoint file survives — and a task suppressed here stayed invisible for as long as
   * it kept running, which is exactly the stale/missing-agent class this project has been burned by
   * before.
   *
   * The presence registry is a SNAPSHOT store, so "resuming" it means re-reading current state, not
   * replaying a log. `PiActivitySource.open()` has always re-announced its session for the same
   * reason; this source now matches it.
   */
  it('re-announces a task on a fresh open even when the checkpoint already names it', async () => {
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

    const first = await Promise.race([
      stream.events[Symbol.asyncIterator]()
        .next()
        .then((r) => r.value?.event.kind ?? 'none'),
      new Promise<string>((resolve) => setTimeout(() => resolve('quiet'), 800)),
    ]);

    expect(first).toBe('session_start');
    stream.stop();
    await source.close();
  });

  it('re-announces the task\'s current lifecycle on that fresh open, not just its existence', async () => {
    await makeHome();
    await publish([task({ status: 'waiting' })]);
    const source = new PiPresenceSource(piHome, indexWithParent(), { cadenceMs: 20 });

    const iterator = source.discover()[Symbol.asyncIterator]();
    const ref = (await iterator.next()).value;
    const stream = source.open(ref!, {
      kind: 'generation',
      byActivation: { [`${SESSION_HASH}.${INCARNATION}`]: 1 },
      threadByTask: { [`${SESSION_HASH}.${INCARNATION}.t1`]: 1 },
      statusByTask: { [`${SESSION_HASH}.${INCARNATION}.t1`]: 'waiting' },
    });

    const events: AgentEvent[] = [];
    const streamIterator = stream.events[Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) events.push((await streamIterator.next()).value!.event);

    expect(events.find((event) => event.kind === 'status')?.lifecycle).toBe('waiting');
    stream.stop();
    await source.close();
  });
});

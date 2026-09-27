/**
 * `ActivitySource` implementation for Pi SUBAGENTS, over the presence registry (spec: "Pi Subagent
 * Lifecycle Events", design.md D1/D6).
 *
 * Pi is the only harness whose root holds two stores. `PiActivitySource` owns the orchestrator
 * transcripts under `<root>/sessions`; this source owns the subagent registry under
 * `<root>/gentle-agents/presence`. Their key spaces are disjoint by construction (`pi:<sessionId>`
 * vs `pi:task:<taskId>`), which is what makes a duplicate worker impossible rather than merely
 * unlikely.
 *
 * Shape follows `opencode/activity-source.ts`, the other snapshot-polling source: `discover()`
 * yields newly seen tasks on a cadence, and `open()` runs a per-task pump on the same cadence. Each
 * pump re-reads the registry, which is one `readdir` plus two bounded file reads — cheap enough at
 * realistic subagent counts (single digits) to be worth the structural symmetry with the existing
 * poller, instead of a bespoke shared-subscription mechanism.
 *
 * Read-only: every path goes through `presence-read.ts`, which never writes and never creates the
 * presence directory (spec: "Pi Zero-Write Guarantee").
 */
import type {
  ActivitySource,
  ActivityStream,
  ActivityStreamItem,
  Checkpoint,
  GenerationCheckpoint,
  SessionRef,
  SourceHealth,
} from '../../../ports/activity-source.port';
import type { AgentEventBase, HarnessId } from '../../../domain/events/types';
import type { AgentProfile } from '../../../domain/agents/agent-profile';
import { createEventFromLogRecord } from '../../../domain/events/factories';
import { createAsyncQueue } from '../../../shared/async-queue';
import type { PiSessionHashIndex } from './correlate';
import {
  presenceRootFor,
  readPresenceActivity,
  readPresenceHeaders,
  type PresenceEntry,
  type PresenceTask,
  type PresenceTaskStatus,
  type PresenceThreadItem,
} from './presence-read';

/** Statuses after which a task will never run again — each produces one `session_end`. */
const TERMINAL_STATUSES: readonly PresenceTaskStatus[] = ['completed', 'failed', 'cancelled', 'timed_out'];

export const DEFAULT_PRESENCE_CADENCE_MS = 1000;

export interface PiPresenceSourceOptions {
  /** Injectable monotonic id allocator. Defaults to an in-process counter starting at 1. */
  allocateId?: () => number;
  /** Injectable clock. Used only as a last-resort fallback; task events carry `lastActivityAt`. */
  now?: () => number;
  /** How often the registry is re-read. */
  cadenceMs?: number;
}

/** A task SessionRef. `cwd` stays `null` unless the header's label resolves to a real path. */
export interface PiTaskSessionRef extends SessionRef {
  harness: 'pi';
  taskId: string;
  activationKey: string;
  sessionHash: string;
  incarnation: string;
}

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

const activationKeyOf = (entry: { sessionHash: string; incarnation: string }): string =>
  `${entry.sessionHash}.${entry.incarnation}`;

const taskKeyOf = (activationKey: string, taskId: string): string => `${activationKey}.${taskId}`;

/**
 * Only fields the registry actually reported. An empty string is Pi's "not set" for these columns
 * (they are schema-required strings), so it must become an ABSENT field rather than an empty row in
 * the tooltip (spec: "A field the registry omitted is absent from the tooltip").
 */
function profileFor(task: PresenceTask): AgentProfile {
  const { agent, model, label } = task.summary;
  return {
    role: 'subagent',
    ...(agent.length > 0 ? { agentType: agent } : {}),
    ...(model.length > 0 ? { model } : {}),
    ...(label.length > 0 ? { task: label } : {}),
  };
}

interface PumpState {
  stopped: boolean;
}

/** Per-task cursor, mirrored into the published `GenerationCheckpoint`. */
interface TaskCursor {
  threadVersion: number;
  status: string | null;
  started: boolean;
  runningCalls: Set<string>;
}

export class PiPresenceSource implements ActivitySource {
  readonly harness: HarnessId = 'pi';
  private readonly presenceRoot: string;
  private readonly allocateId: () => number;
  private readonly now: () => number;
  private readonly cadenceMs: number;
  private readonly statsListeners = new Set<(event: AgentEventBase) => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    piHome: string,
    private readonly sessionIndex: PiSessionHashIndex,
    options: PiPresenceSourceOptions = {},
  ) {
    this.presenceRoot = presenceRootFor(piHome);
    this.allocateId = options.allocateId ?? defaultAllocateId();
    this.now = options.now ?? Date.now;
    this.cadenceMs = options.cadenceMs ?? DEFAULT_PRESENCE_CADENCE_MS;
  }

  /**
   * Always `ready`. Pi creates the presence directory lazily on the first `subagent_run`, so its
   * absence means "no subagent has ever run", not a fault (spec: "Registry absent yields no
   * sessions and stays healthy").
   */
  async probe(): Promise<SourceHealth> {
    return { status: 'ready' };
  }

  /**
   * Registry-level `stats` events, for an activation whose activity is too large to read. They
   * belong to no single task, so they cannot travel on a task's `open()` stream; the composition
   * root subscribes and publishes them directly.
   */
  onRegistryStats(listener: (event: AgentEventBase) => void): () => void {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  /** One read-only pass: every activation's readable tasks, plus its entry. */
  private async readActivations(): Promise<Array<{ entry: PresenceEntry; tasks: PresenceTask[] }>> {
    const page = await readPresenceHeaders(this.presenceRoot, this.now());
    const activations: Array<{ entry: PresenceEntry; tasks: PresenceTask[] }> = [];
    for (const entry of page.entries) {
      const result = await readPresenceActivity(this.presenceRoot, entry);
      if (!result.activity) {
        if (result.unavailable === 'activity-too-large') this.publishCounts(entry);
        continue;
      }
      activations.push({ entry, tasks: result.activity.tasks });
    }
    return activations;
  }

  /**
   * Header-only degradation (spec: "Oversized activity degrades to header counts"): the counts are
   * the only thing still knowable, and reporting them beats reporting nothing.
   */
  private publishCounts(entry: PresenceEntry): void {
    const { running, queued, waiting, finished } = entry.counts;
    const event = createEventFromLogRecord(this.allocateId(), {
      kind: 'stats',
      harness: 'pi',
      sessionKey: this.sessionIndex.resolveSessionKey(entry.sessionHash) ?? `pi:activation:${entry.sessionHash}`,
      at: entry.heartbeat,
      label: `subagents ${running} running, ${queued} queued, ${waiting} waiting, ${finished} finished`,
    });
    for (const listener of this.statsListeners) listener(event);
  }

  async *discover(): AsyncIterable<SessionRef> {
    const seen = new Set<string>();
    while (!this.closed) {
      for (const { entry, tasks } of await this.readActivations()) {
        const activationKey = activationKeyOf(entry);
        for (const task of tasks) {
          const sessionKey = `pi:task:${task.summary.id}`;
          if (seen.has(sessionKey)) continue;
          seen.add(sessionKey);
          const ref: PiTaskSessionRef = {
            harness: 'pi',
            sessionKey,
            taskId: task.summary.id,
            activationKey,
            sessionHash: entry.sessionHash,
            incarnation: entry.incarnation,
            // A header `label` is a project NAME (`pixel-agents`), not a path. Publishing it as a
            // cwd would render a guess as fact, so it stays absent; the orchestrator's own
            // transcript already carries the real project path.
            cwd: null,
            discoveredAt: this.now(),
            lastActivityAt: task.summary.lastActivityAt,
          };
          yield ref;
        }
      }
      if (this.closed) return;
      await this.sleep(this.cadenceMs);
    }
  }

  open(session: SessionRef, from: Checkpoint | null): ActivityStream {
    const taskSession = session as PiTaskSessionRef;
    const initial: GenerationCheckpoint =
      from && from.kind === 'generation' ? from : { kind: 'generation', byActivation: {} };
    const queue = createAsyncQueue<ActivityStreamItem>();
    const state: PumpState = { stopped: false };

    void this.pumpTask(taskSession, initial, queue, state);

    return {
      events: queue,
      stop: (): void => {
        state.stopped = true;
      },
    };
  }

  /**
   * Drives one task's diff loop. The cursor is seeded FROM the checkpoint, never from zero, so a
   * resumed task does not republish its whole thread (the same rule `SeqCheckpoint.partsBySession`
   * documents for OpenCode).
   */
  private async pumpTask(
    session: PiTaskSessionRef,
    initial: GenerationCheckpoint,
    queue: ReturnType<typeof createAsyncQueue<ActivityStreamItem>>,
    state: PumpState,
  ): Promise<void> {
    const taskKey = taskKeyOf(session.activationKey, session.taskId);
    const resumedThreadVersion = initial.threadByTask?.[taskKey];
    const resumedStatus = initial.statusByTask?.[taskKey] ?? null;
    const cursor: TaskCursor = {
      threadVersion: resumedThreadVersion ?? -1,
      status: resumedStatus,
      // A checkpoint that already names this task means its `session_start` was published before.
      started: resumedThreadVersion !== undefined,
      runningCalls: new Set(),
    };
    let checkpoint: GenerationCheckpoint = initial;

    while (!state.stopped && !this.closed) {
      for (const { entry, tasks } of await this.readActivations()) {
        if (activationKeyOf(entry) !== session.activationKey) continue;
        const task = tasks.find((candidate) => candidate.summary.id === session.taskId);
        if (!task) continue;

        checkpoint = {
          kind: 'generation',
          byActivation: { ...checkpoint.byActivation, [session.activationKey]: entry.generation },
          threadByTask: { ...checkpoint.threadByTask, [taskKey]: task.thread.version },
          statusByTask: { ...checkpoint.statusByTask, [taskKey]: task.summary.status },
        };

        for (const event of this.diffTask(session, entry, task, cursor)) {
          queue.push({ event, checkpoint });
        }
      }
      if (state.stopped || this.closed) return;
      await this.sleep(this.cadenceMs);
    }
  }

  /** Every event this read newly justifies, in publication order. Mutates `cursor`. */
  private diffTask(
    session: PiTaskSessionRef,
    entry: PresenceEntry,
    task: PresenceTask,
    cursor: TaskCursor,
  ): AgentEventBase[] {
    const events: AgentEventBase[] = [];
    const { sessionKey } = session;
    // Pi's own activity clock, never the moment this scan ran (spec: "Event time is the task's
    // activity clock").
    const at = task.summary.lastActivityAt;

    if (!cursor.started) {
      cursor.started = true;
      events.push(
        createEventFromLogRecord(this.allocateId(), {
          kind: 'session_start',
          harness: 'pi',
          sessionKey,
          at,
          ...(task.summary.label.length > 0 ? { label: task.summary.label } : {}),
          agentProfile: profileFor(task),
        }),
      );

      // Exact correlation, by hash (design.md D2). An unresolved hash publishes NO parent event:
      // the agent tree's own orphan grace promotes the child, and no parent is invented.
      const parentSessionKey = this.sessionIndex.resolveSessionKey(entry.sessionHash);
      if (parentSessionKey) {
        events.push(
          createEventFromLogRecord(this.allocateId(), {
            kind: 'parent',
            harness: 'pi',
            sessionKey,
            at,
            correlationId: parentSessionKey,
          }),
        );
      }
    }

    // Status BEFORE the thread diff: the office should learn what this worker IS (queued, running,
    // blocked) before it learns which tool it happens to be holding. The very first observation
    // counts as a change, because until it lands nothing downstream knows the task's state at all.
    if (task.summary.status !== cursor.status) {
      cursor.status = task.summary.status;
      // Deliberately NO `label`: the office projection uses `label` as the worker's NAME, so
      // carrying the status there overwrites the task label this same task published on its
      // `session_start` — a worker called "running" instead of "apply work unit 2" (caught live,
      // pinned by a regression test below). The status value gets a field of its own (`lifecycle`)
      // in the session-lifecycle-states work unit; until then this event marks activity without
      // claiming to rename the worker.
      events.push(
        createEventFromLogRecord(this.allocateId(), {
          kind: 'status',
          harness: 'pi',
          sessionKey,
          at,
        }),
      );
      if (TERMINAL_STATUSES.includes(task.summary.status)) {
        events.push(
          createEventFromLogRecord(this.allocateId(), {
            kind: 'session_end',
            harness: 'pi',
            sessionKey,
            at: task.summary.endedAt ?? at,
          }),
        );
      }
    }

    if (task.thread.version !== cursor.threadVersion) {
      cursor.threadVersion = task.thread.version;
      events.push(...this.diffThread(sessionKey, at, task.thread.items, cursor));
    }

    return events;
  }

  /**
   * Thread diff: a `tool` item with `running: true` opens a call, and the same `callId` seen with
   * `running: false` closes it. `text`/`thinking` items are deliberately ignored here — reading
   * them is what a future inspect panel would do, and emitting a `message` per thread revision
   * would flood the scene on every poll.
   */
  private diffThread(
    sessionKey: string,
    at: number,
    items: readonly PresenceThreadItem[],
    cursor: TaskCursor,
  ): AgentEventBase[] {
    const events: AgentEventBase[] = [];
    for (const item of items) {
      if (item.kind !== 'tool') continue;
      const open = cursor.runningCalls.has(item.callId);

      if (item.running && !open) {
        cursor.runningCalls.add(item.callId);
        events.push(
          createEventFromLogRecord(this.allocateId(), {
            kind: 'tool_start',
            harness: 'pi',
            sessionKey,
            at,
            toolLabel: item.name,
          }),
        );
        continue;
      }
      if (!item.running && open) {
        cursor.runningCalls.delete(item.callId);
        events.push(
          createEventFromLogRecord(this.allocateId(), {
            kind: 'tool_end',
            harness: 'pi',
            sessionKey,
            at,
            toolLabel: item.name,
            // The registry reports only that the call errored, never why — so the reason names the
            // fact, and never paraphrases an output it did not carry.
            ...(item.isError ? { reason: `${item.name} reported an error` } : {}),
          }),
        );
      }
    }
    return events;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.statsListeners.clear();
  }
}

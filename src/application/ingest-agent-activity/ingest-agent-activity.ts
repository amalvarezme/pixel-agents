/**
 * Use case: ingest-agent-activity (tasks.md 5.2, design.md module structure).
 *
 * For every session an `ActivitySource` discovers, opens a stream from its last saved
 * checkpoint (or from scratch), publishes each event onto the bus, and persists the returned
 * checkpoint immediately after — so a process restart resumes tailing/polling instead of
 * replaying (design.md: "Session discovery and aging out", Bootstrap).
 *
 * Each discovered session is ingested CONCURRENTLY (browser-entrypoint work unit), not
 * sequentially: a real, live `ActivityStream` (an active tail) never completes on its own — it
 * stays open waiting for the next file write. Blocking the `discover()` loop on one session's
 * stream, as a naive `for await` would, means a second session is never even `open()`ed. Starting
 * every session's ingestion loop as soon as it is discovered, without awaiting its completion, is
 * what lets a real composition root observe more than one live session at a time.
 *
 * This is the harness-agnostic seam: it depends only on ports (`ActivitySource`,
 * `EventPublisher`, `CheckpointStore`), never on any concrete adapter.
 */
import type { ActivitySource, SessionRef } from '../../ports/activity-source.port';
import type { CheckpointStore } from '../../ports/checkpoint-store.port';
import type { EventPublisher } from '../../ports/event-publisher.port';

export interface IngestAgentActivityDeps {
  source: ActivitySource;
  publisher: EventPublisher;
  checkpointStore: CheckpointStore;
  /**
   * Optional generic discovery hook, called once per session as it is discovered (composition-
   * root follow-up: wiring the launch<->log correlator). Deliberately untyped beyond `SessionRef`
   * — this use case has no knowledge of the launcher subsystem it may be feeding; the composition
   * root is the only place that connects the two (design.md "Subsystem Separation from
   * Ingestion").
   */
  onSessionDiscovered?: (session: SessionRef) => void;
}

async function ingestSession(
  session: SessionRef,
  { source, publisher, checkpointStore }: IngestAgentActivityDeps,
): Promise<void> {
  const checkpoint = await checkpointStore.load(session.sessionKey);
  const stream = source.open(session, checkpoint);
  for await (const { event, checkpoint: nextCheckpoint } of stream.events) {
    publisher.publish(event);
    await checkpointStore.save(session.sessionKey, nextCheckpoint);
  }
}

export async function ingestAgentActivity(deps: IngestAgentActivityDeps): Promise<void> {
  const sessionTasks: Promise<void>[] = [];
  for await (const session of deps.source.discover()) {
    // A failed bind degrades attribution only — it must never affect ingestion (design.md
    // "Launch <-> log correlation"). This hook is generic and untrusted by this use case, so a
    // throw here is swallowed rather than aborting the discover() loop for every session after it.
    try {
      deps.onSessionDiscovered?.(session);
    } catch {
      // intentionally ignored — see comment above
    }
    sessionTasks.push(ingestSession(session, deps));
  }
  await Promise.all(sessionTasks);
}

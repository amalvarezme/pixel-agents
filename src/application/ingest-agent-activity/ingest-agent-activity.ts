/**
 * Use case: ingest-agent-activity (tasks.md 5.2, design.md module structure).
 *
 * For every session an `ActivitySource` discovers, opens a stream from its last saved
 * checkpoint (or from scratch), publishes each event onto the bus, and persists the returned
 * checkpoint immediately after — so a process restart resumes tailing/polling instead of
 * replaying (design.md: "Session discovery and aging out", Bootstrap).
 *
 * This is the harness-agnostic seam: it depends only on ports (`ActivitySource`,
 * `EventPublisher`, `CheckpointStore`), never on any concrete adapter.
 */
import type { ActivitySource } from '../../ports/activity-source.port';
import type { CheckpointStore } from '../../ports/checkpoint-store.port';
import type { EventPublisher } from '../../ports/event-publisher.port';

export interface IngestAgentActivityDeps {
  source: ActivitySource;
  publisher: EventPublisher;
  checkpointStore: CheckpointStore;
}

export async function ingestAgentActivity({ source, publisher, checkpointStore }: IngestAgentActivityDeps): Promise<void> {
  for await (const session of source.discover()) {
    const checkpoint = await checkpointStore.load(session.sessionKey);
    const stream = source.open(session, checkpoint);
    for await (const { event, checkpoint: nextCheckpoint } of stream.events) {
      publisher.publish(event);
      await checkpointStore.save(session.sessionKey, nextCheckpoint);
    }
  }
}

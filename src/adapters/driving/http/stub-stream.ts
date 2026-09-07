/**
 * PHASE 5 SEAM-VALIDATION STUB (tasks.md 5.3) — proves port -> application -> bus compiles and
 * runs end to end over a real HTTP connection. This is deliberately NOT the real SSE server
 * (design.md D2): no `text/event-stream` framing, no monotonic `id:`, no ring buffer, no
 * reconnect/replay. That lands in Phase 9 (slice 1b) at `stream.ts` and supersedes this file.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { InMemoryCheckpointStore } from '../../driven/checkpoint/in-memory-checkpoint-store';
import type { AgentEvent } from '../../../domain/events/types';
import type { ActivitySource } from '../../../ports/activity-source.port';
import { ingestAgentActivity } from '../../../application/ingest-agent-activity/ingest-agent-activity';

export function createStubStreamServer(source: ActivitySource): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/stream') {
      res.writeHead(404);
      res.end();
      return;
    }

    const publishedEvents: AgentEvent[] = [];
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });

    ingestAgentActivity({
      source,
      publisher: { publish: (event) => publishedEvents.push(event) },
      checkpointStore: new InMemoryCheckpointStore(),
    })
      .then(() => {
        for (const event of publishedEvents) {
          res.write(`${JSON.stringify(event)}\n`);
        }
        res.end();
      })
      .catch((err: Error) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });
  });
}

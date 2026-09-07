/**
 * Server composition root (browser-entrypoint work unit). The ONLY file that constructs and
 * connects concrete adapters directly (design.md module structure: everything else — `domain/`,
 * `application/`, individual adapters — stays unaware of this wiring):
 *
 *   `ClaudeCodeActivitySource` -> `ingestAgentActivity` -> `SseEventHub` -> `createStreamServer`
 *
 * Binds to `127.0.0.1` ONLY (never `0.0.0.0`): this stream carries the content of the user's
 * private agent sessions and must never be reachable from another machine on the network.
 *
 * Reads `CLAUDE_HOME` (default `~/.claude`) READ-ONLY through `ClaudeCodeActivitySource`; the
 * only path this process ever writes to is its OWN checkpoint file under `.data/`, entirely
 * outside the watched tree.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeActivitySource } from './adapters/driven/claude-code/activity-source';
import { FileCheckpointStore } from './adapters/driven/checkpoint/file-checkpoint-store';
import { createStreamServer, SseEventHub } from './adapters/driving/http/stream';
import { ingestAgentActivity } from './application/ingest-agent-activity/ingest-agent-activity';

const PORT = Number(process.env.PORT ?? 4317);
const HOST = '127.0.0.1';
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? join(homedir(), '.claude');
const CHECKPOINT_FILE = join(process.cwd(), '.data', 'checkpoints.json');

async function main(): Promise<void> {
  const hub = new SseEventHub();
  const source = new ClaudeCodeActivitySource(CLAUDE_HOME);
  const checkpointStore = new FileCheckpointStore(CHECKPOINT_FILE);

  void ingestAgentActivity({ source, publisher: hub, checkpointStore }).catch((error: unknown) => {
    console.error('[office-agent-visualizer] ingestion stopped unexpectedly:', error);
  });

  const server = createStreamServer(hub);
  server.listen(PORT, HOST, () => {
    console.log(`[office-agent-visualizer] SSE stream ready at http://${HOST}:${PORT}/stream`);
    console.log(`[office-agent-visualizer] watching ${join(CLAUDE_HOME, 'projects')} (read-only)`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await source.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();

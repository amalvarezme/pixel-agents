/**
 * `POST /launch` (tasks.md 26.1, design.md D2: "Launch is `POST /launch`, not a socket frame").
 * Parses a JSON `LaunchSpec` body, delegates to `launchAgentSession`, and reports the outcome as
 * an HTTP status: `started`/`unavailable_interactive` -> 200 (the request was handled, whether or
 * not a process ended up running), `failed` -> 502 (the launcher itself reports failure), a
 * malformed body -> 400 without ever reaching the use case.
 *
 * This route also refuses `spec.args` carrying an injection-denylisted flag (design.md Threat
 * Matrix case b, tasks.md 23.4). `buildLaunchCommand` guards only the per-harness TEMPLATE, on the
 * reading that `spec.args` is what the user typed and must survive byte-identical. That reading
 * does not hold HERE: this is an unauthenticated localhost endpoint with no origin check and no
 * confirmation step, so "arrived in an HTTP body" is not evidence a human typed it — any local
 * process can reach it. Silently altering what a harness does would poison the very sessions this
 * project exists to observe, so the refusal happens before the use case and nothing is spawned.
 *
 * A future UI affordance that makes the user confirm such a flag explicitly can pass it through a
 * separate, deliberate path; until one exists, this surface refuses.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { INJECTION_DENYLIST } from '../../driven/launcher/build-launch-command';
import { launchAgentSession } from '../../../application/launch-agent-session/launch-agent-session';
import { HARNESS_IDS } from '../../../domain/events/types';
import type { LaunchSpec, SessionLauncher } from '../../../ports/session-launcher.port';

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseLaunchSpec(rawBody: string): LaunchSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { harness, cwd, args, interactive } = parsed as Record<string, unknown>;
  if (typeof harness !== 'string' || !(HARNESS_IDS as readonly string[]).includes(harness)) return null;
  if (typeof cwd !== 'string') return null;
  if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))) return null;
  if (interactive !== undefined && typeof interactive !== 'boolean') return null;
  return { harness: harness as LaunchSpec['harness'], cwd, args: (args as string[] | undefined) ?? [], interactive };
}

function respondJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleLaunchRequest(req: IncomingMessage, res: ServerResponse, launcher: SessionLauncher): Promise<void> {
  const rawBody = await readRequestBody(req);
  const spec = parseLaunchSpec(rawBody);
  if (!spec) {
    respondJson(res, 400, { error: 'invalid launch request body' });
    return;
  }

  const denylisted = spec.args.find((arg) => (INJECTION_DENYLIST as readonly string[]).includes(arg));
  if (denylisted) {
    respondJson(res, 400, {
      error: `refusing to launch: "${denylisted}" cannot be supplied over HTTP (Zero-Injection Spawn Invariant)`,
    });
    return;
  }

  const result = await launchAgentSession(launcher, spec);
  respondJson(res, result.outcome === 'failed' ? 502 : 200, result);
}

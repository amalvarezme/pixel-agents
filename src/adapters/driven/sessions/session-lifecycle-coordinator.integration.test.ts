/**
 * Integration-level proof (design.md "Session discovery and aging out") that a fake-clock-driven
 * eviction reaches a REAL connected SSE client as a wire frame — the same `SseEventHub` +
 * `createStreamServer` the composition root uses, wired the same way `src/server.ts` wires them
 * (a thin `EventPublisher` wrapper feeding `SessionLifecycleCoordinator.observe`, and a periodic
 * `tick()` — here called directly instead of through a real timer, since the whole point is
 * proving this without waiting 10/60 real minutes).
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../domain/events/types';
import type { Clock } from '../../../ports/clock.port';
import type { EventPublisher } from '../../../ports/event-publisher.port';
import { EVICT_TIMEOUT_MS } from '../../../domain/sessions/session-lifecycle';
import { createStreamServer, SseEventHub } from '../../driving/http/stream';
import { SessionLifecycleCoordinator } from './session-lifecycle-coordinator';

function makeFakeClock(initial = 0): Clock & { set(t: number): void } {
  let current = initial;
  return { now: () => current, set: (t: number) => { current = t; } };
}

/** Minimal SSE frame reader — mirrors `stream.test.ts`'s own, kept local to avoid a cross-test-file export. */
class SseFrameReader {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  async readFrames(count: number, timeoutMs = 2000): Promise<string[]> {
    const frames: string[] = [];
    const deadline = Date.now() + timeoutMs;
    while (frames.length < count && Date.now() < deadline) {
      const { value, done } = await this.reader.read();
      if (done) break;
      this.buffer += this.decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
        frames.push(this.buffer.slice(0, idx));
        this.buffer = this.buffer.slice(idx + 2);
      }
    }
    return frames;
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

describe('Session idle-out and eviction (integration, real SseEventHub + HTTP server)', () => {
  let server: Server | null = null;
  let reader: SseFrameReader | null = null;

  afterEach(async () => {
    if (reader) await reader.close();
    reader = null;
    server?.close();
    server = null;
  });

  it('a fake-clock-driven eviction reaches a connected client as a real session_end SSE frame', async () => {
    const hub = new SseEventHub();
    const clock = makeFakeClock(0);
    const lifecycle = new SessionLifecycleCoordinator(hub, clock);
    const trackedPublisher: EventPublisher = {
      publish: (event: AgentEvent) => {
        lifecycle.observe(event);
        hub.publish(event);
      },
    };

    server = createStreamServer(hub);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    reader = new SseFrameReader(response);

    const [snapshot] = await reader.readFrames(1);
    expect(snapshot).toContain('event: snapshot');

    trackedPublisher.publish({ id: 1, kind: 'session_start', harness: 'claude-code', sessionKey: 'claude-code:idle-me', at: 0 });
    const [startFrame] = await reader.readFrames(1);
    expect(startFrame).toContain('"kind":"session_start"');

    // No real waiting: the fake clock jumps straight to the eviction boundary, then `tick()` is
    // invoked directly (standing in for the composition root's periodic timer).
    clock.set(EVICT_TIMEOUT_MS);
    lifecycle.tick();

    const [endFrame] = await reader.readFrames(1);
    expect(endFrame).toContain('"kind":"session_end"');
    expect(endFrame).toContain('"sessionKey":"claude-code:idle-me"');
    expect(endFrame).toContain('"reason":"timeout"');
  });
});

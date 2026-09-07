/**
 * Clock port for adapters that need wall-clock time (e.g. stamping `discoveredAt`, driving
 * poll-interval backoff). `domain/` itself never reads a clock — every domain function takes
 * an explicit `now: number` parameter instead (see agent-tree.ts, session-lifecycle.ts) — so
 * this port exists purely for the adapters/application layers that sit above it.
 */
export interface Clock {
  now(): number;
}

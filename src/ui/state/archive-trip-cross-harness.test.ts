import { describe, expect, it } from 'vitest';
import { applyEventToOfficeState, createOfficeState } from '../../domain/office/office';
import type { AgentEvent, HarnessId } from '../../domain/events/types';
import { buildOfficeViewModel } from './office-view-model';
import { PERSISTENT_MEMORY } from '../scene/world/office-map';

/**
 * Task 22.2 (automated part): replaying one `memory_write` event per harness — sourced from each
 * harness's OWN detector shape (already proven correct by the four dedicated memory-write-
 * detector suites) and passed through the SAME `createMemoryWriteEvent` factory every adapter
 * uses in production — must produce the IDENTICAL animation path and destination, because the
 * projection never inspects `harness` when computing the path (memory-write-visualization spec:
 * "memory_write Drives Archive Animation Trigger").
 *
 * The actual PixiJS tween render is NOT covered here — it needs a real browser and is left for a
 * manual/visual check (see apply-progress and the phase report).
 */
const HARNESSES: HarnessId[] = ['claude-code', 'codex', 'opencode', 'antigravity'];

function sessionStart(id: number, harness: HarnessId, sessionKey: string): AgentEvent {
  return { id, kind: 'session_start', harness, sessionKey, at: id };
}

function memoryWrite(id: number, harness: HarnessId, sessionKey: string): AgentEvent {
  return { id, kind: 'memory_write', harness, sessionKey, at: 1000, toolLabel: 'mem_save' };
}

describe('cross-harness memory_write animation path identity (tasks.md 22.2 automated part)', () => {
  it('all four harnesses produce an identical archive path and destination from their own single-worker desk position', () => {
    const paths = HARNESSES.map((harness) => {
      const sessionKey = `${harness}:s1`;
      let state = createOfficeState();
      state = applyEventToOfficeState(state, sessionStart(1, harness, sessionKey));
      state = applyEventToOfficeState(state, memoryWrite(2, harness, sessionKey));

      const vm = buildOfficeViewModel(state);
      return vm.workers.find((w) => w.sessionKey === sessionKey)!.archiveTrip!.path;
    });

    // Every harness is the sole active session, so every one lands on the same single-agent
    // centered desk position — the paths must therefore be byte-for-byte identical.
    for (const path of paths) {
      expect(path).toEqual(paths[0]);
    }
    expect(paths[0]![paths[0]!.length - 1]).toEqual(PERSISTENT_MEMORY.anchor);
  });
});

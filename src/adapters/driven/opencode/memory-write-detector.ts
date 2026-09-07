/**
 * OpenCode `memory_write` detector (tasks.md 18.5, spec: "OpenCode memory_write Detection").
 * Matches a `part` row whose `data->>'$.type' == "tool"` and `data->>'$.tool' ==
 * "engram_mem_save"` — OpenCode's bare `<server>_<tool>` naming, no `mcp__` prefix
 * (research-local-evidence.md Q3). Adapter-private and typed on `OpenCodePartRow` — no shared
 * cross-harness pattern match exists (spec: "Detector Interface Isolation").
 */
import type { MemoryWriteDetector, MemoryWriteSignal } from '../../../ports/activity-source.port';
import { parseOpenCodePartData, type OpenCodePartRow } from './parse';

const ENGRAM_MEM_SAVE_TOOL = 'engram_mem_save';

export class OpenCodeMemoryWriteDetector implements MemoryWriteDetector<OpenCodePartRow> {
  readonly harness = 'opencode' as const;

  detect(record: OpenCodePartRow): MemoryWriteSignal | null {
    const data = parseOpenCodePartData(record.data);
    if (!data || data.type !== 'tool' || data.tool !== ENGRAM_MEM_SAVE_TOOL) return null;

    const input = data.state?.input ?? {};
    const title = typeof input.title === 'string' ? input.title : undefined;
    return {
      title,
      topicKey: typeof input.topic_key === 'string' ? input.topic_key : undefined,
      observationType: typeof input.type === 'string' ? input.type : undefined,
      toolLabel: ENGRAM_MEM_SAVE_TOOL,
      toolDetail: title,
    };
  }
}

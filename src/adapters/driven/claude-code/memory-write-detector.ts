/**
 * Claude Code `memory_write` detector (tasks.md 8.6, spec: "Claude Code memory_write Detection").
 * Matches `tool_use` content blocks whose `name` matches `mcp__*engram*__mem_save`, covering both
 * observed spellings `mcp__engram__mem_save` and `mcp__plugin_engram_engram__mem_save`
 * (research-local-evidence.md Q4). This detector is adapter-private and typed on
 * `ClaudeCodeContentBlock` — no shared cross-harness pattern match exists (spec: "Detector
 * Interface Isolation").
 */
import type { MemoryWriteDetector, MemoryWriteSignal } from '../../../ports/activity-source.port';
import type { ClaudeCodeContentBlock } from './parse';

const MEM_SAVE_TOOL_NAME_PATTERN = /^mcp__.*engram.*__mem_save$/;

export class ClaudeCodeMemoryWriteDetector implements MemoryWriteDetector<ClaudeCodeContentBlock> {
  readonly harness = 'claude-code' as const;

  detect(record: ClaudeCodeContentBlock): MemoryWriteSignal | null {
    if (record.type !== 'tool_use') return null;
    if (typeof record.name !== 'string' || !MEM_SAVE_TOOL_NAME_PATTERN.test(record.name)) return null;

    const input = record.input ?? {};
    const title = typeof input.title === 'string' ? input.title : undefined;
    return {
      title,
      topicKey: typeof input.topic_key === 'string' ? input.topic_key : undefined,
      observationType: typeof input.type === 'string' ? input.type : undefined,
      toolLabel: 'mem_save',
      toolDetail: title,
    };
  }
}

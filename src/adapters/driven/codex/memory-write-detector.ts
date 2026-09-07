/**
 * Codex `memory_write` detector (tasks.md 12.8, spec: "Codex memory_write Detection"). Matches
 * `event_msg`/`item_completed` records whose `payload.item` is an `McpToolCall` with
 * `server: "engram"` and `tool: "mem_save"`. Explicitly excludes the entire `custom_tool_call`
 * family from detection: `extractMcpToolCallItem` only ever inspects `event_msg` records, so a
 * `response_item`/`custom_tool_call` (`name: "exec"`) record — even one whose free-text
 * input/output contains the literal string `mem_save` — can never reach a match here (spec:
 * "custom_tool_call exec record does not false-positive"). This detector is adapter-private and
 * typed on `CodexRecord` — no shared cross-harness pattern match exists (spec: "Detector
 * Interface Isolation").
 */
import type { MemoryWriteDetector, MemoryWriteSignal } from '../../../ports/activity-source.port';
import { extractMcpToolCallItem, type CodexRecord } from './parse';

const ENGRAM_SERVER = 'engram';
const MEM_SAVE_TOOL = 'mem_save';

export class CodexMemoryWriteDetector implements MemoryWriteDetector<CodexRecord> {
  readonly harness = 'codex' as const;

  detect(record: CodexRecord): MemoryWriteSignal | null {
    const mcpCall = extractMcpToolCallItem(record);
    if (!mcpCall) return null;
    if (mcpCall.server !== ENGRAM_SERVER || mcpCall.tool !== MEM_SAVE_TOOL) return null;

    const args = mcpCall.arguments ?? {};
    const title = typeof args.title === 'string' ? args.title : undefined;
    return {
      title,
      topicKey: typeof args.topic_key === 'string' ? args.topic_key : undefined,
      observationType: typeof args.type === 'string' ? args.type : undefined,
      toolLabel: MEM_SAVE_TOOL,
      toolDetail: title,
    };
  }
}

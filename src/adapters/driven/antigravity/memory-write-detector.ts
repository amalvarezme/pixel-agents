/**
 * Antigravity `memory_write` detector (tasks.md 13.11, spec: "Antigravity memory_write
 * Detection"). Matches a `call_mcp_tool` tool call whose de-quoted `ServerName`/`ToolName` equal
 * `engram`/`mem_save` — de-quoting via `dequoteOnce` is mandatory, proven by
 * `memory-write-detector.test.ts`'s naive-equality test (tasks.md 13.9), which stays in the suite
 * as living documentation of why this detector cannot compare the raw values directly.
 *
 * `args.Arguments` is parsed a second time via `parseCallMcpToolArguments` to reach `title`/
 * `topic_key`/`type`. The de-quoted `toolAction`/`toolSummary` pair is human-readable and used
 * directly as the scene caption (design.md: "Antigravity | de-quoted `args.toolAction` (line 1),
 * de-quoted `args.toolSummary` (line 2)"). This detector is adapter-private and typed on
 * `AntigravityToolCall` — no shared cross-harness pattern match exists (spec: "Detector Interface
 * Isolation").
 */
import type { MemoryWriteDetector, MemoryWriteSignal } from '../../../ports/activity-source.port';
import { extractCallMcpToolSignal, parseCallMcpToolArguments, type AntigravityToolCall } from './parse';

const ENGRAM_SERVER = 'engram';
const MEM_SAVE_TOOL = 'mem_save';

export class AntigravityMemoryWriteDetector implements MemoryWriteDetector<AntigravityToolCall> {
  readonly harness = 'antigravity' as const;

  detect(toolCall: AntigravityToolCall): MemoryWriteSignal | null {
    const signal = extractCallMcpToolSignal(toolCall);
    if (!signal) return null;
    if (signal.server !== ENGRAM_SERVER || signal.tool !== MEM_SAVE_TOOL) return null;

    const args = signal.argumentsRaw ? (parseCallMcpToolArguments(signal.argumentsRaw) ?? {}) : {};
    const title = typeof args.title === 'string' ? args.title : undefined;
    return {
      title,
      topicKey: typeof args.topic_key === 'string' ? args.topic_key : undefined,
      observationType: typeof args.type === 'string' ? args.type : undefined,
      toolLabel: signal.toolAction ?? MEM_SAVE_TOOL,
      toolDetail: signal.toolSummary,
    };
  }
}

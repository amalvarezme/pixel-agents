/**
 * Pi `memory_write` detector (spec: "Pi memory_write Detection").
 *
 * Pi records Engram's tool as a BARE `mem_save`, with no `mcp__<server>__` wrapper — verified
 * against 51 real `toolCall` records under `~/.pi/agent/sessions/**`. That is a genuine difference
 * from Claude Code, which writes `mcp__engram__mem_save` / `mcp__plugin_engram_engram__mem_save`.
 * The prefixed spelling is still accepted, because Pi can also surface Engram through its MCP
 * gateway, and a prefix there would otherwise silently stop producing archive trips.
 *
 * Adapter-private and typed on Pi's OWN `PiToolCallPart` (spec: "Detector Interface Isolation") —
 * there is deliberately no shared cross-harness record shape.
 */
import type { MemoryWriteDetector, MemoryWriteSignal } from '../../../ports/activity-source.port';
import type { PiToolCallPart } from './parse';

const MEM_SAVE_TOOL_NAME_PATTERN = /^(?:mcp__.*__)?mem_save$/;

/**
 * The SINGLE tool-name predicate for a Pi memory write. The orchestrator path (`parse.ts`, via
 * `PiMemoryWriteDetector`) and the subagent path (`presence-source.ts`'s `diffThread`) share it so
 * the two spellings can never drift apart. The registry thread item carries only a NAME, no
 * arguments, which is why the presence source can reuse this predicate but not the detector itself.
 */
export function isMemoryWriteToolName(name: string): boolean {
  return MEM_SAVE_TOOL_NAME_PATTERN.test(name);
}

export class PiMemoryWriteDetector implements MemoryWriteDetector<PiToolCallPart> {
  readonly harness = 'pi' as const;

  detect(record: PiToolCallPart): MemoryWriteSignal | null {
    if (record.type !== 'toolCall') return null;
    if (typeof record.name !== 'string' || !isMemoryWriteToolName(record.name)) return null;

    const args = record.arguments ?? {};
    const title = typeof args.title === 'string' ? args.title : undefined;
    return {
      title,
      topicKey: typeof args.topic_key === 'string' ? args.topic_key : undefined,
      observationType: typeof args.type === 'string' ? args.type : undefined,
      toolLabel: 'mem_save',
      toolDetail: title,
    };
  }
}

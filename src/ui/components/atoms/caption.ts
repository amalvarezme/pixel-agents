/**
 * Caption atom (tasks.md 10.3, 10.5, 21.5). Shows the worker's resolved label by default; when a
 * normalized `{toolLabel, toolDetail}` pair is supplied (design.md "Captions") it takes priority.
 *
 * This function takes NO `harness` parameter at all — every harness's own resolver (one per
 * adapter, e.g. `resolveClaudeCodeToolCaption`) has already reduced its harness-specific record
 * shape down to this one normalized pair before it ever reaches here, so this atom structurally
 * cannot branch on harness (memory-write-visualization spec's isolation principle, reused here
 * for the same reason: no shared or harness-aware logic at the shared boundary).
 */
const EMPTY_LABEL_PLACEHOLDER = '(unnamed worker)';

export interface ToolCaptionSource {
  toolLabel: string;
  toolDetail?: string;
}

export function buildCaption(label: string, tool?: ToolCaptionSource): string {
  if (tool && tool.toolLabel.length > 0) {
    return tool.toolDetail ? `${tool.toolLabel}: ${tool.toolDetail}` : tool.toolLabel;
  }
  return label.length > 0 ? label : EMPTY_LABEL_PLACEHOLDER;
}

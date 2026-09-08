/**
 * Caption atom (tasks.md 10.3, 10.5). The minimal slice-1b scene shows the worker's resolved
 * label as its caption strip text; per-tool caption normalization ({toolLabel, toolDetail}) is
 * slice 4 scope (design.md task 21.5) and not implemented here.
 */
const EMPTY_LABEL_PLACEHOLDER = '(unnamed worker)';

export function buildCaption(label: string): string {
  return label.length > 0 ? label : EMPTY_LABEL_PLACEHOLDER;
}

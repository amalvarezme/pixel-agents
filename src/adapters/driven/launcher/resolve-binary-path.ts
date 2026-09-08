/**
 * Explicit `PATH` lookup (tasks.md 24.1). Pure function — the `existsFn` check is injected so the
 * real implementation (backed by `node:fs`'s `existsSync` against `${dir}/${binary}`) is
 * testable without touching the filesystem, and so this module never shells out to
 * `which`/`command -v`, keeping the whole launcher subsystem shell-free (`shell: false` always).
 */
import { delimiter, join } from 'node:path';

export type BinaryExistsFn = (path: string) => boolean;

export function resolveBinaryOnPath(binary: string, pathEnv: string, existsFn: BinaryExistsFn): string | null {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsFn(candidate)) return candidate;
  }
  return null;
}

/**
 * `resolveBinaryOnPath` (tasks.md 24.1: "absolute-path binary resolution via explicit `PATH`
 * lookup"). Pure function: given a binary name, a `PATH` string, and an injectable existence
 * check, walks `PATH` entries left to right and returns the first absolute path where the binary
 * exists — never a shell `which`/`command -v` call (this whole subsystem never touches a shell).
 */
import { describe, expect, it } from 'vitest';
import { resolveBinaryOnPath } from './resolve-binary-path';

describe('resolveBinaryOnPath', () => {
  it('returns the absolute path of the first PATH entry where the binary exists', () => {
    const exists = (path: string): boolean => path === '/usr/local/bin/claude';

    const resolved = resolveBinaryOnPath('claude', '/usr/bin:/usr/local/bin', exists);

    expect(resolved).toBe('/usr/local/bin/claude');
  });

  it('returns null when the binary exists in none of the PATH entries (triangulation: not-found path)', () => {
    const exists = (): boolean => false;

    const resolved = resolveBinaryOnPath('agy', '/usr/bin:/usr/local/bin', exists);

    expect(resolved).toBeNull();
  });

  it('stops at the FIRST matching entry, left to right, even if a later entry also matches', () => {
    const exists = (path: string): boolean => path === '/opt/a/codex' || path === '/opt/b/codex';

    const resolved = resolveBinaryOnPath('codex', '/opt/a:/opt/b', exists);

    expect(resolved).toBe('/opt/a/codex');
  });

  it('returns null for an empty PATH', () => {
    expect(resolveBinaryOnPath('claude', '', () => true)).toBeNull();
  });
});

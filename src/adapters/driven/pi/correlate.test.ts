import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PiSessionHashIndex } from './correlate';

const SESSION_ID = '01a0e06e-d6eb-7018-81fe-cc81a7736e52';
const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

describe('PiSessionHashIndex', () => {
  it('resolves a sessionHash to the session id whose hash it is', () => {
    const index = new PiSessionHashIndex();
    index.register(SESSION_ID);

    expect(index.resolve(hashOf(SESSION_ID))).toBe(SESSION_ID);
  });

  it('hashes the BARE session id, never the prefixed session key', () => {
    const index = new PiSessionHashIndex();
    index.register(SESSION_ID);

    // The registry publishes sha256 of Pi's own session id; hashing `pi:<id>` would never match.
    expect(index.resolve(hashOf(`pi:${SESSION_ID}`))).toBeNull();
  });

  it('returns null for a hash belonging to no known session, rather than guessing', () => {
    const index = new PiSessionHashIndex();
    index.register(SESSION_ID);

    expect(index.resolve(hashOf('01a0d10c-2a59-72e5-8ad7-67185b421de5'))).toBeNull();
  });

  it('returns null for an empty index', () => {
    expect(new PiSessionHashIndex().resolve(hashOf(SESSION_ID))).toBeNull();
  });

  it('registers idempotently, so a re-discovered session does not duplicate', () => {
    const index = new PiSessionHashIndex();
    index.register(SESSION_ID);
    index.register(SESSION_ID);

    expect(index.size).toBe(1);
    expect(index.resolve(hashOf(SESSION_ID))).toBe(SESSION_ID);
  });

  it('resolves each of several registered sessions to its own id', () => {
    const other = '01a0d10c-2a59-72e5-8ad7-67185b421de5';
    const index = new PiSessionHashIndex();
    index.register(SESSION_ID);
    index.register(other);

    expect(index.resolve(hashOf(SESSION_ID))).toBe(SESSION_ID);
    expect(index.resolve(hashOf(other))).toBe(other);
  });

  it('exposes the parent session KEY for a resolved hash, ready for a parent event', () => {
    const index = new PiSessionHashIndex();
    index.register(SESSION_ID);

    expect(index.resolveSessionKey(hashOf(SESSION_ID))).toBe(`pi:${SESSION_ID}`);
    expect(index.resolveSessionKey(hashOf('unknown'))).toBeNull();
  });

  it("exposes the resolved parent's own KNOWN project path, never a guess", () => {
    const index = new PiSessionHashIndex();
    index.register(SESSION_ID, '/Users/dev/pixel-agents');

    expect(index.resolveProjectPath(hashOf(SESSION_ID))).toBe('/Users/dev/pixel-agents');
    // A hash belonging to no known session, and a session whose cwd the transcript never yielded,
    // both resolve to `null` — absence, never a fabricated path.
    expect(index.resolveProjectPath(hashOf('unknown'))).toBeNull();
    index.register('01a0d10c-2a59-72e5-8ad7-67185b421de5');
    expect(index.resolveProjectPath(hashOf('01a0d10c-2a59-72e5-8ad7-67185b421de5'))).toBeNull();
  });

  it('lets a later KNOWN cwd replace an earlier absence, but never lets an absent cwd erase a known one', () => {
    const index = new PiSessionHashIndex();
    index.register(SESSION_ID);
    index.register(SESSION_ID, '/Users/dev/pixel-agents');
    expect(index.resolveProjectPath(hashOf(SESSION_ID))).toBe('/Users/dev/pixel-agents');

    // A later registration that carries no cwd (an absent signal) must not erase the known path.
    index.register(SESSION_ID);
    expect(index.resolveProjectPath(hashOf(SESSION_ID))).toBe('/Users/dev/pixel-agents');

    // A later concrete reading wins, mirroring the domain's merge-not-erase discipline.
    index.register(SESSION_ID, '/Users/dev/moved-project');
    expect(index.resolveProjectPath(hashOf(SESSION_ID))).toBe('/Users/dev/moved-project');
  });
});
